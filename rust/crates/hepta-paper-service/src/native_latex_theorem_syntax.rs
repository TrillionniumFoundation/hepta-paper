//! Literal theorem syntax over UTF-16 positions, matching the existing Node reader.
use regex::bytes::Regex;
use serde::Serialize;
use std::{
    cell::Cell,
    collections::BTreeSet,
    sync::{
        LazyLock,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};
pub const MAX_SOURCE_UTF16_UNITS_V1: usize = 4 * 1024 * 1024;
pub const MAX_SOURCE_UTF8_BYTES_V1: usize = 8 * 1024 * 1024;
pub const MAX_SYNTAX_WORK_V1: usize = 256 * 1024 * 1024;
pub const MAX_SYNTAX_MATCHES_V1: usize = 16384;
pub const MAX_EXTRA_ENVIRONMENTS_V1: usize = 256;
pub const MAX_EXTRA_ENVIRONMENT_BYTES_V1: usize = 256;
pub const DEFAULT_SYNTAX_TIMEOUT_MS_V1: u64 = 30000;
/// One borrowed control may cover every file and syntax phase in an intake.
/// A refusal is sticky and every public controlled entry returns it instead of
/// the internal partial parse accumulated before cancellation or exhaustion.
pub struct LatexSyntaxControlV1<'a> {
    cancelled: &'a AtomicBool,
    deadline: Instant,
    remaining_work: Cell<usize>,
    remaining_matches: Cell<usize>,
    refusal: Cell<Option<&'static str>>,
    #[cfg(test)]
    checkpoint: Cell<Option<fn(&LatexSyntaxControlV1<'_>)>>,
}
impl<'a> LatexSyntaxControlV1<'a> {
    pub fn new(cancelled: &'a AtomicBool, deadline: Instant) -> Self {
        Self {
            cancelled,
            deadline,
            remaining_work: Cell::new(MAX_SYNTAX_WORK_V1),
            remaining_matches: Cell::new(MAX_SYNTAX_MATCHES_V1),
            refusal: Cell::new(None),
            #[cfg(test)]
            checkpoint: Cell::new(None),
        }
    }
    fn charge(&self, amount: usize) -> bool {
        if self.refusal.get().is_some() {
            return false;
        }
        #[cfg(test)]
        if let Some(checkpoint) = self.checkpoint.get() {
            checkpoint(self);
        }
        let refusal = if self.cancelled.load(Ordering::Acquire) {
            Some("native_latex_theorem_syntax_cancelled")
        } else if Instant::now() >= self.deadline {
            Some("native_latex_theorem_syntax_deadline_exceeded")
        } else if amount > self.remaining_work.get() {
            Some("native_latex_theorem_syntax_work_budget_exceeded")
        } else {
            None
        };
        if let Some(refusal) = refusal {
            self.refusal.set(Some(refusal));
            return false;
        }
        self.remaining_work.set(self.remaining_work.get() - amount);
        true
    }
    fn matched(&self) -> bool {
        if !self.charge(1) {
            return false;
        }
        let remaining = self.remaining_matches.get();
        if remaining == 0 {
            self.refusal
                .set(Some("native_latex_theorem_syntax_match_budget_exceeded"));
            return false;
        }
        self.remaining_matches.set(remaining - 1);
        true
    }
    fn finish<T>(&self, value: T) -> Result<T, String> {
        self.charge(0);
        match self.refusal.get() {
            Some(code) => Err(code.into()),
            None => Ok(value),
        }
    }
}
pub const STANDARD_THEOREM_ENVIRONMENTS: &[&str] = &[
    "theorem",
    "lemma",
    "proposition",
    "corollary",
    "inputcondition",
];
const PATTERNS: &[&str] = &[
    r"\\(newcommand|renewcommand|providecommand|DeclareRobustCommand)",
    r"\\(def|gdef|edef|xdef)",
    r"\\(?:csname|endcsname|expandafter|let)",
    r"\\(?:New|Renew|Provide|Declare)(?:Expandable)?Document(?:Command|Environment)",
    r"\\(?:ExplSyntax(?:On|Off)|[A-Za-z]+(?:_[A-Za-z]+)+:[A-Za-z]*|(?:use|exp_args):[A-Za-z]+)",
    r"\\(?:newenvironment|renewenvironment)",
    r"(?i:\\([A-Za-z@]*(?:input|include|import|subfile)[A-Za-z@]*))",
    r"\\(begin|end)",
    r"\\([A-Za-z@]+)",
    r"\\(?:input|include)",
    r"\\newtheorem",
    r"\\(?:declaretheorem|spnewtheorem|newshadetheorem)",
    r"\\(begin|end)\s*\{([^{}\r\n]+)\}(?:\s*\[[^\]\r\n]*\])?",
];
static REGEXES: LazyLock<Vec<Result<Regex, regex::Error>>> = LazyLock::new(|| {
    PATTERNS
        .iter()
        .map(|p| Regex::new(&format!("(?-u:{p})")))
        .collect()
});
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct SyntaxBlocker {
    pub code: String,
    pub offset: usize,
}
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MacroDefinition {
    pub command: String,
    pub macro_name: String,
    pub offset_start: usize,
    pub offset_end: usize,
    pub body_start: usize,
    pub body_end: usize,
}
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MacroAnalysis {
    pub definitions: Vec<MacroDefinition>,
    pub blockers: Vec<SyntaxBlocker>,
    pub masked_source: String,
}
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TheoremDeclaration {
    pub environment: String,
    pub starred: bool,
    pub alias_of: Option<String>,
    pub within: Option<String>,
    pub offset_start: usize,
    pub offset_end: usize,
}
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct DeclarationAnalysis {
    pub declarations: Vec<TheoremDeclaration>,
    pub blockers: Vec<SyntaxBlocker>,
}
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TheoremAnalysis {
    pub theorem_environments: Vec<String>,
    pub declarations: Vec<TheoremDeclaration>,
    pub macro_definitions: Vec<MacroDefinition>,
    pub blockers: Vec<SyntaxBlocker>,
    pub theorem_statement_count: usize,
    pub proof_environment_count: usize,
    pub theorem_proof_pairing_blockers: Vec<SyntaxBlocker>,
}
#[derive(Clone)]
struct Token {
    start: usize,
    end: usize,
    groups: Vec<Option<(usize, usize)>>,
}
fn alpha(c: u16) -> bool {
    matches!(c, 65..=90 | 97..=122 | 64)
}
fn whitespace(c: u16) -> bool {
    matches!(c, 0x0009..=0x000d | 0x0020 | 0x00a0 | 0x1680 | 0x2000..=0x200a | 0x2028 | 0x2029 | 0x202f | 0x205f | 0x3000 | 0xfeff)
}
fn text(s: &[u16]) -> String {
    String::from_utf16_lossy(s)
}
fn trim(s: &[u16]) -> &[u16] {
    let start = s.iter().position(|c| !whitespace(*c)).unwrap_or(s.len());
    let end = s
        .iter()
        .rposition(|c| !whitespace(*c))
        .map_or(start, |p| p + 1);
    &s[start..end]
}
fn escaped(s: &[u16], offset: usize) -> bool {
    s[..offset].iter().rev().take_while(|c| **c == 92).count() % 2 == 1
}
fn ws(s: &[u16], mut p: usize) -> usize {
    while p < s.len() && whitespace(s[p]) {
        p += 1;
    }
    p
}
fn tokens(s: &[u16], kind: usize, work: &LatexSyntaxControlV1<'_>) -> Vec<Token> {
    if !work.charge(s.len()) {
        return Vec::new();
    }
    // One projected byte per UTF-16 unit preserves JavaScript offsets. Only
    // ASCII command grammar and the exact ECMAScript whitespace class match.
    let b: Vec<_> = s
        .iter()
        .map(|c| {
            if *c <= 127 {
                *c as u8
            } else if whitespace(*c) {
                b' '
            } else {
                0x80
            }
        })
        .collect();
    let Ok(regex) = &REGEXES[kind] else {
        work.refusal
            .set(Some("native_latex_theorem_syntax_fixed_pattern_invalid"));
        return Vec::new();
    };
    let mut result = Vec::new();
    for c in regex.captures_iter(&b) {
        if !work.matched() {
            break;
        }
        let Some(m) = c.get(0) else {
            continue;
        };
        if kind != 12 && s.get(m.end()).is_some_and(|v| alpha(*v)) {
            continue;
        }
        result.push(Token {
            start: m.start(),
            end: m.end(),
            groups: c
                .iter()
                .skip(1)
                .map(|g| g.map(|v| (v.start(), v.end())))
                .collect(),
        });
    }
    result
}
fn group(s: &[u16], t: &Token, n: usize) -> String {
    t.groups
        .get(n)
        .and_then(|v| *v)
        .map_or_else(String::new, |(a, b)| text(&s[a..b]))
}
fn blocker(code: &str, offset: usize) -> SyntaxBlocker {
    SyntaxBlocker {
        code: code.into(),
        offset,
    }
}
fn delimited(
    s: &[u16],
    start: usize,
    open: u16,
    close: u16,
    work: &LatexSyntaxControlV1<'_>,
) -> Option<(usize, usize)> {
    if s.get(start) != Some(&open) {
        return None;
    }
    let mut depth = 0usize;
    for p in start..s.len() {
        if (p - start).is_multiple_of(256) && !work.charge((s.len() - p).min(256)) {
            return None;
        }
        if s[p] != open && s[p] != close {
            continue;
        }
        if escaped(s, p) {
            continue;
        }
        if s[p] == open {
            depth += 1;
        }
        if s[p] != close {
            continue;
        }
        depth = depth.checked_sub(1)?;
        if depth == 0 {
            return Some((start, p + 1));
        }
    }
    None
}
fn safe_environment(s: &str) -> bool {
    let b = s.as_bytes();
    b.first().is_some_and(u8::is_ascii_alphabetic)
        && b.iter().enumerate().skip(1).all(|(i, c)| {
            c.is_ascii_alphanumeric() || b":_-".contains(c) || (*c == b'*' && i == b.len() - 1)
        })
}
fn safe_counter(s: &str) -> bool {
    let b = s.as_bytes();
    b.first().is_some_and(u8::is_ascii_alphabetic)
        && b.iter()
            .skip(1)
            .all(|c| c.is_ascii_alphanumeric() || b":@_-".contains(c))
}
fn safe_macro(s: &str) -> bool {
    s.as_bytes().first() == Some(&b'\\')
        && s.len() > 1
        && s.as_bytes()[1..]
            .iter()
            .all(|c| c.is_ascii_alphabetic() || *c == b'@')
}
fn control(s: &[u16], start: usize) -> Option<usize> {
    if s.get(start) != Some(&92) || start + 1 >= s.len() {
        return None;
    }
    let mut end = start + 1;
    if alpha(s[end]) {
        while end < s.len() && alpha(s[end]) {
            end += 1;
        }
    } else {
        end += 1;
    }
    Some(end)
}
fn mask_comments(source: &str, work: &LatexSyntaxControlV1<'_>) -> String {
    if !work.charge(source.len()) {
        return String::new();
    }
    let mut s: Vec<_> = source.encode_utf16().collect();
    let mut comment = false;
    for p in 0..s.len() {
        if p.is_multiple_of(256) && !work.charge((s.len() - p).min(256)) {
            return String::new();
        }
        if matches!(s[p], 10 | 13) {
            comment = false;
            continue;
        }
        if !comment && s[p] == 37 && !escaped(&s, p) {
            comment = true;
        }
        if comment {
            s[p] = 32;
        }
    }
    text(&s)
}
fn macro_definition(
    s: &[u16],
    t: &Token,
    tex: bool,
    work: &LatexSyntaxControlV1<'_>,
) -> Option<MacroDefinition> {
    if !work.charge(0) {
        return None;
    }
    let mut p = ws(s, t.end);
    let name;
    if tex {
        let end = control(s, p)?;
        name = text(&s[p..end]);
        p = end;
        while p < s.len() && s[p] != 123 {
            if p.is_multiple_of(256) && !work.charge((s.len() - p).min(256)) {
                return None;
            }
            p += 1;
        }
        let mut q = ws(s, end);
        while q < p {
            if s[q] != 35 || q + 1 >= p || !matches!(s[q + 1], 49..=57) {
                return None;
            }
            q = ws(s, q + 2);
        }
    } else {
        if s.get(p) == Some(&42) {
            p = ws(s, p + 1);
        }
        if s.get(p) == Some(&123) {
            let (a, b) = delimited(s, p, 123, 125, work)?;
            name = text(trim(&s[a + 1..b - 1]));
            p = ws(s, b);
        } else {
            let b = control(s, p)?;
            name = text(&s[p..b]);
            p = ws(s, b);
        }
        for _ in 0..2 {
            if s.get(p) != Some(&91) {
                break;
            }
            let (_, b) = delimited(s, p, 91, 93, work)?;
            p = ws(s, b);
        }
    }
    let (a, b) = delimited(s, p, 123, 125, work)?;
    if !safe_macro(&name) {
        return None;
    }
    Some(MacroDefinition {
        command: group(s, t, 0),
        macro_name: name,
        offset_start: t.start,
        offset_end: b,
        body_start: a + 1,
        body_end: b - 1,
    })
}
fn non_source(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "includegraphics" | "includeonly" | "inputencoding"
    )
}
fn direct(name: &str, environments: &BTreeSet<String>) -> bool {
    name == "proof"
        || environments.contains(name)
        || name
            .strip_prefix("end")
            .is_some_and(|n| n == "proof" || environments.contains(n))
}
fn construction(s: &[u16], env: &BTreeSet<String>, work: &LatexSyntaxControlV1<'_>) -> bool {
    if !work.charge(0) {
        return false;
    }
    for kind in [10, 11, 9, 2, 3, 4, 5] {
        if tokens(s, kind, work).iter().any(|t| !escaped(s, t.start)) {
            return true;
        }
    }
    if tokens(s, 6, work)
        .iter()
        .any(|t| !escaped(s, t.start) && !non_source(&group(s, t, 0)))
    {
        return true;
    }
    for t in tokens(s, 7, work) {
        if escaped(s, t.start) {
            continue;
        }
        let Some((a, b)) = delimited(s, ws(s, t.end), 123, 125, work) else {
            return true;
        };
        let name = text(trim(&s[a + 1..b - 1]));
        if !safe_environment(&name) || name == "proof" || env.contains(&name) {
            return true;
        }
    }
    tokens(s, 8, work)
        .iter()
        .any(|t| !escaped(s, t.start) && direct(&group(s, t, 0), env))
}
fn analyze_macros(
    source: &str,
    extra: &[String],
    work: &LatexSyntaxControlV1<'_>,
) -> MacroAnalysis {
    let comments: Vec<_> = mask_comments(source, work).encode_utf16().collect();
    let mut definitions = Vec::new();
    let mut blockers = Vec::new();
    for kind in [0, 1] {
        for t in tokens(&comments, kind, work) {
            match macro_definition(&comments, &t, kind == 1, work) {
                Some(d) => definitions.push(d),
                None => blockers.push(blocker(
                    "theorem_environment_macro_definition_unparseable",
                    t.start,
                )),
            }
        }
    }
    definitions.sort_by_key(|d| d.offset_start);
    let env: BTreeSet<_> = STANDARD_THEOREM_ENVIRONMENTS
        .iter()
        .map(|v| (*v).to_owned())
        .chain(extra.iter().cloned())
        .collect();
    let mut masked = comments.clone();
    for d in &definitions {
        if !work.charge(d.body_end - d.body_start) {
            break;
        }
        for c in &mut masked[d.body_start..d.body_end] {
            if !matches!(*c, 10 | 13) {
                *c = 32;
            }
        }
    }
    for (kind, code) in [
        (
            2,
            "theorem_environment_dynamic_control_sequence_unsupported",
        ),
        (
            3,
            "theorem_environment_extended_macro_definition_unsupported",
        ),
        (4, "theorem_environment_expl3_dynamic_syntax_unsupported"),
        (5, "theorem_environment_definition_command_unsupported"),
        (6, "theorem_environment_include_command_unsupported"),
    ] {
        for t in tokens(&comments, kind, work) {
            if !escaped(&comments, t.start)
                && (kind != 6 || {
                    let name = group(&comments, &t, 0).to_ascii_lowercase();
                    name != "input" && name != "include" && !non_source(&name)
                })
            {
                blockers.push(blocker(code, t.start));
            }
        }
    }
    for t in tokens(&masked, 7, work) {
        if escaped(&masked, t.start) {
            continue;
        }
        if delimited(&masked, ws(&masked, t.end), 123, 125, work)
            .is_none_or(|(a, b)| !safe_environment(&text(trim(&masked[a + 1..b - 1]))))
        {
            blockers.push(blocker(
                "theorem_environment_dynamic_invocation_unsupported",
                t.start,
            ));
        }
    }
    for t in tokens(&masked, 8, work) {
        if !escaped(&masked, t.start) && direct(&group(&masked, &t, 0), &env) {
            blockers.push(blocker(
                "theorem_environment_direct_invocation_unsupported",
                t.start,
            ));
        }
    }
    let mut until = 0;
    for t in tokens(&masked, 9, work) {
        if t.start < until || escaped(&masked, t.start) {
            continue;
        }
        let p = ws(&masked, t.end);
        let end = masked
            .get(p + 1..)
            .and_then(|s| s.iter().position(|c| *c == 125))
            .map(|n| p + 1 + n);
        let valid = masked.get(p) == Some(&123)
            && end.is_some_and(|b| {
                let value = trim(&masked[p + 1..b]);
                !value.is_empty()
                    && value
                        .iter()
                        .all(|c| matches!(*c,65..=90|97..=122|48..=57|46|95|47|45))
            });
        if let Some(end) = end.filter(|_| valid) {
            until = end + 1;
        } else {
            blockers.push(blocker(
                "theorem_environment_dynamic_include_unsupported",
                t.start,
            ));
        }
    }
    for d in &definitions {
        if construction(&comments[d.body_start..d.body_end], &env, work) {
            blockers.push(blocker(
                "theorem_environment_macro_construction_unsupported",
                d.offset_start,
            ));
        }
    }
    MacroAnalysis {
        definitions,
        blockers,
        masked_source: text(&masked),
    }
}
fn declaration(
    s: &[u16],
    start: usize,
    work: &LatexSyntaxControlV1<'_>,
) -> (Option<TheoremDeclaration>, Option<SyntaxBlocker>, usize) {
    let bad = |code: &str, end: usize| (None, Some(blocker(code, start)), end);
    let mut p = ws(s, start + 11);
    let starred = s.get(p) == Some(&42);
    if starred {
        p = ws(s, p + 1);
    }
    let Some((a, b)) = delimited(s, p, 123, 125, work) else {
        return bad("theorem_environment_declaration_unparseable", start + 11);
    };
    let environment = text(trim(&s[a + 1..b - 1]));
    if !safe_environment(&environment) {
        return bad("theorem_environment_name_unsafe", b);
    }
    p = ws(s, b);
    let mut alias_of = None;
    if s.get(p) == Some(&91) {
        let Some((a, b)) = delimited(s, p, 91, 93, work) else {
            return bad("theorem_environment_declaration_unparseable", start + 11);
        };
        let name = text(trim(&s[a + 1..b - 1]));
        if !safe_counter(&name) {
            return bad("theorem_environment_alias_unsafe", b);
        }
        alias_of = Some(name);
        p = ws(s, b);
    }
    let Some((a, b)) = delimited(s, p, 123, 125, work) else {
        return bad("theorem_environment_declaration_unparseable", start + 11);
    };
    if trim(&s[a + 1..b - 1]).is_empty() {
        return bad("theorem_environment_caption_missing", b);
    }
    p = ws(s, b);
    let mut within = None;
    if s.get(p) == Some(&91) {
        let Some((a, b)) = delimited(s, p, 91, 93, work) else {
            return bad("theorem_environment_declaration_unparseable", start + 11);
        };
        let name = text(trim(&s[a + 1..b - 1]));
        if !safe_counter(&name) {
            return bad("theorem_environment_parent_counter_unsafe", b);
        }
        within = Some(name);
        p = b;
    }
    if starred && (alias_of.is_some() || within.is_some()) {
        return bad(
            "theorem_environment_starred_counter_configuration_invalid",
            p,
        );
    }
    if alias_of.is_some() && within.is_some() {
        return bad("theorem_environment_alias_and_parent_counter_conflict", p);
    }
    (
        Some(TheoremDeclaration {
            environment,
            starred,
            alias_of,
            within,
            offset_start: start,
            offset_end: p,
        }),
        None,
        p,
    )
}
fn declarations(source: &str, work: &LatexSyntaxControlV1<'_>) -> DeclarationAnalysis {
    let macro_syntax = analyze_macros(source, &[], work);
    let s: Vec<_> = macro_syntax.masked_source.encode_utf16().collect();
    let mut declarations = Vec::new();
    let mut blockers = Vec::new();
    let mut until = 0;
    for t in tokens(&s, 10, work) {
        if t.start < until {
            continue;
        }
        let (d, b, end) = declaration(&s, t.start, work);
        if let Some(d) = d {
            declarations.push(d);
        }
        if let Some(b) = b {
            blockers.push(b);
        }
        until = t.end.max(end);
    }
    for t in tokens(&s, 11, work) {
        blockers.push(blocker(
            "theorem_environment_declaration_unsupported",
            t.start,
        ));
    }
    DeclarationAnalysis {
        declarations,
        blockers,
    }
}
fn complete(source: &str, work: &LatexSyntaxControlV1<'_>) -> TheoremAnalysis {
    let parsed = declarations(source, work);
    let env: BTreeSet<_> = STANDARD_THEOREM_ENVIRONMENTS
        .iter()
        .map(|v| (*v).to_owned())
        .chain(parsed.declarations.iter().map(|d| d.environment.clone()))
        .collect();
    let macros = analyze_macros(source, &env.iter().cloned().collect::<Vec<_>>(), work);
    let s: Vec<_> = macros.masked_source.encode_utf16().collect();
    let mut pair = Vec::new();
    let mut theorem_count = 0;
    let mut proof_count = 0;
    let mut open_theorem: Option<(String, usize)> = None;
    let mut awaiting: Option<(String, usize)> = None;
    let mut open_proof: Option<usize> = None;
    for t in tokens(&s, 12, work) {
        let Some((a, b)) = t.groups.get(1).and_then(|v| *v) else {
            continue;
        };
        let name = text(trim(&s[a..b]));
        let theorem = env.contains(&name);
        if !theorem && name != "proof" {
            continue;
        }
        if group(&s, &t, 0) == "begin" {
            if theorem {
                theorem_count += 1;
                if open_theorem.is_some() || open_proof.is_some() || awaiting.is_some() {
                    pair.push(blocker(
                        "theorem_proof_pairing_theorem_before_prior_proof",
                        t.start,
                    ));
                }
                open_theorem = Some((name, t.start));
            } else {
                proof_count += 1;
                if open_theorem.is_some() || open_proof.is_some() || awaiting.is_none() {
                    pair.push(blocker("theorem_proof_pairing_orphan_proof", t.start));
                }
                open_proof = Some(t.start);
            }
            continue;
        }
        if theorem {
            if open_theorem.as_ref().is_none_or(|(n, _)| *n != name) {
                pair.push(blocker(
                    "theorem_proof_pairing_unmatched_theorem_end",
                    t.start,
                ));
            } else {
                awaiting = open_theorem.take();
            }
        } else if open_proof.is_none() {
            pair.push(blocker(
                "theorem_proof_pairing_unmatched_proof_end",
                t.start,
            ));
        } else {
            open_proof = None;
            awaiting = None;
        }
    }
    if let Some((_, offset)) = open_theorem.or(awaiting) {
        pair.push(blocker("theorem_proof_pairing_missing_proof", offset));
    }
    if let Some(offset) = open_proof {
        pair.push(blocker("theorem_proof_pairing_unclosed_proof", offset));
    }
    let mut blockers = parsed.blockers;
    blockers.extend(macros.blockers);
    TheoremAnalysis {
        theorem_environments: env.into_iter().collect(),
        declarations: parsed.declarations,
        macro_definitions: macros.definitions,
        blockers,
        theorem_statement_count: theorem_count,
        proof_environment_count: proof_count,
        theorem_proof_pairing_blockers: pair,
    }
}
fn bounded(source: &str, extra: &[String]) -> Result<(), String> {
    if source.len() > MAX_SOURCE_UTF8_BYTES_V1
        || source.encode_utf16().count() > MAX_SOURCE_UTF16_UNITS_V1
        || extra.len() > MAX_EXTRA_ENVIRONMENTS_V1
        || extra
            .iter()
            .any(|s| s.len() > MAX_EXTRA_ENVIRONMENT_BYTES_V1)
    {
        return Err("native_latex_theorem_syntax_input_budget_exceeded".into());
    }
    Ok(())
}
pub fn mask_latex_comments_with_control_v1(
    source: &str,
    work: &LatexSyntaxControlV1<'_>,
) -> Result<String, String> {
    if !work.charge(0) {
        return work.finish(String::new());
    }
    bounded(source, &[])?;
    let value = mask_comments(source, work);
    work.finish(value)
}
pub fn analyze_theorem_environment_macro_definitions_with_control_v1(
    source: &str,
    extra: &[String],
    work: &LatexSyntaxControlV1<'_>,
) -> Result<MacroAnalysis, String> {
    if !work.charge(0) {
        return Err(work
            .refusal
            .get()
            .unwrap_or("native_latex_theorem_syntax_control_invalid")
            .into());
    }
    bounded(source, extra)?;
    let value = analyze_macros(source, extra, work);
    work.finish(value)
}
pub fn parse_new_theorem_declarations_with_control_v1(
    source: &str,
    work: &LatexSyntaxControlV1<'_>,
) -> Result<DeclarationAnalysis, String> {
    if !work.charge(0) {
        return Err(work
            .refusal
            .get()
            .unwrap_or("native_latex_theorem_syntax_control_invalid")
            .into());
    }
    bounded(source, &[])?;
    let value = declarations(source, work);
    work.finish(value)
}
pub fn analyze_latex_theorem_environments_with_control_v1(
    source: &str,
    work: &LatexSyntaxControlV1<'_>,
) -> Result<TheoremAnalysis, String> {
    if !work.charge(0) {
        return Err(work
            .refusal
            .get()
            .unwrap_or("native_latex_theorem_syntax_control_invalid")
            .into());
    }
    bounded(source, &[])?;
    let value = complete(source, work);
    work.finish(value)
}
pub fn mask_latex_comments(source: &str) -> Result<String, String> {
    let cancelled = AtomicBool::new(false);
    let work = LatexSyntaxControlV1::new(
        &cancelled,
        Instant::now() + Duration::from_millis(DEFAULT_SYNTAX_TIMEOUT_MS_V1),
    );
    mask_latex_comments_with_control_v1(source, &work)
}
pub fn analyze_theorem_environment_macro_definitions(
    source: &str,
    extra: &[String],
) -> Result<MacroAnalysis, String> {
    let cancelled = AtomicBool::new(false);
    let work = LatexSyntaxControlV1::new(
        &cancelled,
        Instant::now() + Duration::from_millis(DEFAULT_SYNTAX_TIMEOUT_MS_V1),
    );
    analyze_theorem_environment_macro_definitions_with_control_v1(source, extra, &work)
}
pub fn parse_new_theorem_declarations(source: &str) -> Result<DeclarationAnalysis, String> {
    let cancelled = AtomicBool::new(false);
    let work = LatexSyntaxControlV1::new(
        &cancelled,
        Instant::now() + Duration::from_millis(DEFAULT_SYNTAX_TIMEOUT_MS_V1),
    );
    parse_new_theorem_declarations_with_control_v1(source, &work)
}
pub fn analyze_latex_theorem_environments(source: &str) -> Result<TheoremAnalysis, String> {
    let cancelled = AtomicBool::new(false);
    let work = LatexSyntaxControlV1::new(
        &cancelled,
        Instant::now() + Duration::from_millis(DEFAULT_SYNTAX_TIMEOUT_MS_V1),
    );
    analyze_latex_theorem_environments_with_control_v1(source, &work)
}

#[cfg(test)]
mod tests;
