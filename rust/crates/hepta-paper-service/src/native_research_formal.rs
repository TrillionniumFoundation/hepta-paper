//! Actual formal manuscript universe from held original source bytes.
use crate::{
    native_business::local_submission_preflight::local_submission_values_budget_v1 as budget,
    native_latex_theorem_syntax::{
        LatexSyntaxControlV1, STANDARD_THEOREM_ENVIRONMENTS,
        analyze_theorem_environment_macro_definitions_with_control_v1,
        parse_new_theorem_declarations_with_control_v1,
    },
    native_research_manuscript::{
        LiteralInclude, Universe, literal_includes, safe_path, trim_range,
    },
    runtime_source_cas::observation::SourceObservation,
};
use hepta_legacy_compatibility::{ProductionCollationV1, production_hash_record_v1};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
    time::Instant,
};
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeFormalClaimUniverseRequestV1 {
    pub version: u16,
    pub source_root: PathBuf,
    pub manuscript_path: String,
    pub maximum_files: usize,
}
pub struct NativeFormalClaimUniverseObservationV1<'a> {
    source: SourceObservation<'a>,
    observed: Value,
}
impl NativeFormalClaimUniverseObservationV1<'_> {
    pub fn observed(&self) -> &Value {
        &self.observed
    }
    pub fn verify_unchanged(&self) -> Result<(), String> {
        self.source.assert_current()
    }
}
fn refused() -> String {
    "native_formal_claim_universe_data_domain_v1_refused".into()
}
fn check(c: &AtomicBool, deadline: Instant) -> Result<(), String> {
    if c.load(Ordering::SeqCst) {
        Err("native_formal_claim_universe_cancelled".into())
    } else if Instant::now() >= deadline {
        Err("native_formal_claim_universe_deadline_exceeded".into())
    } else {
        Ok(())
    }
}
fn hash(kind: &str, v: &Value) -> Result<String, String> {
    production_hash_record_v1(kind, v)
        .map(|v| v.as_str().to_owned())
        .map_err(|_| refused())
}
fn bytes_hash(v: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(v))
}
fn latin1(v: &[u8]) -> String {
    v.iter().map(|v| char::from(*v)).collect()
}
fn dedup(v: Vec<String>) -> Vec<String> {
    let mut seen = BTreeSet::new();
    v.into_iter().filter(|x| seen.insert(x.clone())).collect()
}
#[derive(Default)]
struct Blockers {
    values: Vec<String>,
    bytes: usize,
}
impl Blockers {
    fn push(&mut self, value: String) -> Result<(), String> {
        let bytes = self
            .bytes
            .checked_add(value.len())
            .filter(|v| *v <= 1024 * 1024)
            .ok_or_else(refused)?;
        if self.values.len() >= 4096 {
            return Err(refused());
        }
        self.bytes = bytes;
        self.values.push(value);
        Ok(())
    }
    fn extend(&mut self, values: impl IntoIterator<Item = String>) -> Result<(), String> {
        for value in values {
            self.push(value)?;
        }
        Ok(())
    }
}
struct Read {
    relative: String,
    content: Vec<u8>,
    hash: String,
    includes: Vec<LiteralInclude>,
}
struct Reader<'a, 'b> {
    source: &'a mut SourceObservation<'b>,
    cancelled: &'b AtomicBool,
    maximum_files: usize,
    visited: BTreeSet<String>,
    reads: Vec<Read>,
    blockers: Blockers,
    bytes: u64,
    paths: usize,
    include_bytes: usize,
    work: &'a LatexSyntaxControlV1<'b>,
    deadline: Instant,
}
impl Reader<'_, '_> {
    fn visit(&mut self, relative: &str, depth: usize) -> Result<(), String> {
        check(self.cancelled, self.deadline)?;
        if relative.is_empty() || self.visited.contains(relative) {
            return Ok(());
        }
        if self.visited.len() >= self.maximum_files || depth > 32 {
            self.blockers
                .push("formal_claim_universe_include_limit_exceeded".into())?;
            return Ok(());
        }
        if relative.len() > 4096
            || relative.contains('\\')
            || Path::new(relative)
                .components()
                .any(|c| !matches!(c, std::path::Component::Normal(_)))
        {
            return Err(refused());
        }
        self.paths = self
            .paths
            .checked_add(relative.len())
            .filter(|v| *v <= 65536)
            .ok_or_else(refused)?;
        self.visited.insert(relative.into());
        let path = Path::new(relative);
        let Some(metadata) = self.source.inventory_probe(path)? else {
            self.blockers.push(format!(
                "formal_claim_universe_manuscript_unreadable:{relative}"
            ))?;
            return Ok(());
        };
        if metadata.directory {
            self.blockers.push(format!(
                "formal_claim_universe_manuscript_unreadable:{relative}"
            ))?;
            return Ok(());
        }
        if metadata.link_count != 1 || metadata.size > 1024 * 1024 {
            return Err(refused());
        }
        self.bytes = self
            .bytes
            .checked_add(metadata.size)
            .filter(|v| *v <= 4 * 1024 * 1024)
            .ok_or_else(refused)?;
        let content = self.source.inventory_document(path, 1024 * 1024)?;
        check(self.cancelled, self.deadline)?;
        let hash = bytes_hash(&content);
        check(self.cancelled, self.deadline)?;
        let syntax = analyze_theorem_environment_macro_definitions_with_control_v1(
            &latin1(&content),
            &STANDARD_THEOREM_ENVIRONMENTS
                .iter()
                .map(|v| (*v).into())
                .collect::<Vec<_>>(),
            self.work,
        )?;
        let includes = literal_includes(
            &syntax.masked_source.encode_utf16().collect::<Vec<_>>(),
            relative,
            Universe::Formal,
            self.cancelled,
            self.deadline,
        )?;
        self.include_bytes =
            includes
                .includes
                .iter()
                .try_fold(self.include_bytes, |total, item| {
                    total
                        .checked_add(item.path.len() + 32)
                        .filter(|v| *v <= 1024 * 1024)
                        .ok_or_else(refused)
                })?;
        self.blockers.extend(includes.blockers)?;
        let paths = includes
            .includes
            .iter()
            .map(|v| v.path.clone())
            .collect::<Vec<_>>();
        self.reads.push(Read {
            relative: relative.into(),
            content,
            hash,
            includes: includes.includes,
        });
        for path in paths {
            self.visit(&path, depth + 1)?;
        }
        Ok(())
    }
}
#[derive(Clone)]
struct Token {
    begin: bool,
    environment: String,
    start: usize,
    end: usize,
}
fn ws(v: u16) -> bool {
    matches!(v,0x0009..=0x000d|0x0020|0x00a0|0x1680|0x2000..=0x200a|0x2028|0x2029|0x202f|0x205f|0x3000|0xfeff)
}
fn tokens(
    s: &[u16],
    environments: &BTreeSet<String>,
    c: &AtomicBool,
    deadline: Instant,
) -> Result<Vec<Token>, String> {
    let mut tokens = Vec::new();
    let mut i = 0;
    while i < s.len() {
        check(c, deadline)?;
        let (begin, len) = if s[i..].starts_with(&[92, 98, 101, 103, 105, 110]) {
            (true, 6)
        } else if s[i..].starts_with(&[92, 101, 110, 100]) {
            (false, 4)
        } else {
            i += 1;
            continue;
        };
        let start = i;
        let mut cursor = i + len;
        while cursor < s.len() && ws(s[cursor]) {
            check(c, deadline)?;
            cursor += 1;
        }
        if s.get(cursor) != Some(&123) {
            i += 1;
            continue;
        }
        let body = cursor + 1;
        cursor = body;
        while cursor < s.len() && !matches!(s[cursor], 123 | 125 | 10 | 13) {
            check(c, deadline)?;
            cursor += 1;
        }
        if cursor == body || s.get(cursor) != Some(&125) {
            i += 1;
            continue;
        }
        let range = trim_range(s, body, cursor, c, deadline)?;
        let environment =
            String::from_utf16(&s[range.byte_start..range.byte_end]).map_err(|_| refused())?;
        let mut end = cursor + 1;
        let mut open = end;
        while open < s.len() && ws(s[open]) {
            check(c, deadline)?;
            open += 1;
        }
        if s.get(open) == Some(&91) {
            let mut close = open + 1;
            while close < s.len() && !matches!(s[close], 93 | 10 | 13) {
                check(c, deadline)?;
                close += 1;
            }
            if s.get(close) == Some(&93) {
                end = close + 1;
            }
        }
        i = end;
        if environment == "proof" || environments.contains(&environment) {
            if tokens.len() >= 4096 || environment.len() > 256 {
                return Err(refused());
            }
            tokens.push(Token {
                begin,
                environment,
                start,
                end,
            });
        }
    }
    Ok(tokens)
}
fn next_token(
    tokens: &[Token],
    start: usize,
    end: usize,
    c: &AtomicBool,
    deadline: Instant,
    predicate: impl Fn(&Token) -> bool,
) -> Result<Option<usize>, String> {
    for (index, token) in tokens.iter().enumerate().take(end).skip(start) {
        check(c, deadline)?;
        if predicate(token) {
            return Ok(Some(index));
        }
    }
    Ok(None)
}
fn extract(
    read: &Read,
    environments: &BTreeSet<String>,
    c: &AtomicBool,
    work: &LatexSyntaxControlV1<'_>,
    deadline: Instant,
) -> Result<(Vec<Value>, Vec<String>), String> {
    check(c, deadline)?;
    let macro_syntax = analyze_theorem_environment_macro_definitions_with_control_v1(
        &latin1(&read.content),
        &environments.iter().cloned().collect::<Vec<_>>(),
        work,
    )?;
    let masked = macro_syntax
        .masked_source
        .encode_utf16()
        .collect::<Vec<_>>();
    if masked.len() != read.content.len() {
        return Err(refused());
    }
    let mut blockers = Blockers::default();
    blockers.extend(macro_syntax.blockers.iter().map(|b| {
        format!(
            "formal_claim_universe_{}:{}:{}",
            b.code, read.relative, b.offset
        )
    }))?;
    let ts = tokens(&masked, environments, c, deadline)?;
    let mut used = BTreeSet::new();
    let mut theorems = Vec::new();
    let mut index = 0;
    while index < ts.len() {
        check(c, deadline)?;
        let begin = &ts[index];
        if !begin.begin || !environments.contains(&begin.environment) {
            index += 1;
            continue;
        }
        let next = next_token(&ts, index + 1, ts.len(), c, deadline, |token| {
            (!token.begin && token.environment == begin.environment)
                || (token.begin && environments.contains(&token.environment))
        })?;
        let Some(n) = next else {
            blockers.push(format!(
                "formal_claim_universe_theorem_unterminated:{}:{}",
                read.relative, begin.start
            ))?;
            index += 1;
            continue;
        };
        let end = &ts[n];
        if end.begin || end.environment != begin.environment {
            blockers.push(format!(
                "formal_claim_universe_theorem_nested_or_malformed:{}:{}",
                read.relative, begin.start
            ))?;
            index += 1;
            continue;
        }
        let body = trim_range(&masked, begin.end, end.start, c, deadline)?;
        let bytes = &read.content[body.byte_start..body.byte_end];
        if bytes.len() > 64 * 1024 {
            return Err(refused());
        }
        let text = String::from_utf8_lossy(bytes).into_owned();
        if bytes.is_empty()
            || std::str::from_utf8(bytes).is_err()
            || text
                .chars()
                .all(|c| ws(u16::try_from(u32::from(c)).unwrap_or(0)))
        {
            blockers.push(format!(
                "formal_claim_universe_theorem_body_invalid:{}:{}",
                read.relative, begin.start
            ))?;
        }
        let mut proof = Value::Null;
        if let Some(next) = ts.get(n + 1)
            && next.begin
            && next.environment == "proof"
            && masked[end.end..next.start].iter().all(|v| ws(*v))
            && let Some(p) = next_token(&ts, n + 2, ts.len(), c, deadline, |token| {
                !token.begin && token.environment == "proof"
            })?
            && next_token(&ts, n + 2, p, c, deadline, |token| {
                token.environment == "proof"
            })?
            .is_none()
        {
            let range = trim_range(&masked, next.end, ts[p].start, c, deadline)?;
            proof = json!({"byteStart":range.byte_start,"byteEnd":range.byte_end,"contentHash":bytes_hash(&read.content[range.byte_start..range.byte_end])});
            used.insert(next.start);
        }
        if proof.is_null() {
            blockers.push(format!(
                "formal_claim_universe_proof_missing_or_not_adjacent:{}:{}",
                read.relative, begin.start
            ))?;
        }
        let ordinal = theorems.len() + 1;
        let mut payload = json!({"version":1,"kind":"FormalClaimUniverseEntry","theoremId":format!("{}#formal-theorem={ordinal}",read.relative),"ordinal":ordinal,"environment":begin.environment,"manuscriptPath":read.relative,"manuscriptFileHash":read.hash,"environmentByteStart":begin.start,"environmentByteEnd":end.end,"manuscriptByteStart":body.byte_start,"manuscriptByteEnd":body.byte_end,"manuscriptContentHash":if bytes.is_empty(){None}else{Some(bytes_hash(bytes))},"text":text,"proof":proof});
        budget(theorems.iter().chain([&payload]))?;
        check(c, deadline)?;
        let h = hash("FormalClaimUniverseEntry", &payload)?;
        check(c, deadline)?;
        payload["formalClaimUniverseEntryHash"] = json!(h);
        theorems.push(payload);
        index = n + 1;
    }
    for token in ts {
        if token.begin && token.environment == "proof" && !used.contains(&token.start) {
            blockers.push(format!(
                "formal_claim_universe_unpaired_proof:{}:{}",
                read.relative, token.start
            ))?;
        }
    }
    Ok((theorems, dedup(blockers.values)))
}
fn ordered(
    relative: &str,
    reads: &BTreeMap<String, &Read>,
    extracted: &mut BTreeMap<String, Vec<Value>>,
    seen: &mut BTreeSet<String>,
    out: &mut Vec<Value>,
    c: &AtomicBool,
    deadline: Instant,
) -> Result<(), String> {
    check(c, deadline)?;
    if !seen.insert(relative.into()) {
        return Ok(());
    }
    let Some(read) = reads.get(relative) else {
        return Ok(());
    };
    let Some(theorems) = extracted.remove(relative) else {
        return Ok(());
    };
    let mut include = 0;
    let mut entries = theorems.into_iter().peekable();
    while entries.peek().is_some() || include < read.includes.len() {
        check(c, deadline)?;
        if entries.peek().is_some_and(|v| {
            include >= read.includes.len()
                || v["environmentByteStart"]
                    .as_u64()
                    .is_some_and(|v| v < (read.includes[include].byte_start as u64))
        }) {
            let entry = entries.next().ok_or_else(refused)?;
            budget(out.iter().chain([&entry]))?;
            out.push(entry);
        } else {
            ordered(
                &read.includes[include].path,
                reads,
                extracted,
                seen,
                out,
                c,
                deadline,
            )?;
            include += 1;
        }
    }
    Ok(())
}
/// Pure computation and held observation, without scientific or external authority.
pub fn inspect_native_formal_claim_universe_v1<'a>(
    request: NativeFormalClaimUniverseRequestV1,
    c: &'a AtomicBool,
    deadline: Instant,
) -> Result<NativeFormalClaimUniverseObservationV1<'a>, String> {
    check(c, deadline)?;
    if request.version != 1
        || !request.source_root.is_absolute()
        || request.source_root.as_os_str().len() > 4096
        || request.manuscript_path.len() > 4096
        || request.maximum_files > 128
    {
        return Err(refused());
    }
    let manuscript = safe_path(&request.manuscript_path);
    let mut source = SourceObservation::new_with_deadline(&request.source_root, c, deadline)?;
    if source.root() != request.source_root {
        return Err(refused());
    }
    let work = LatexSyntaxControlV1::new(c, deadline);
    let mut r = Reader {
        source: &mut source,
        cancelled: c,
        maximum_files: request.maximum_files,
        visited: BTreeSet::new(),
        reads: Vec::new(),
        blockers: Blockers::default(),
        bytes: 0,
        paths: 0,
        include_bytes: 0,
        work: &work,
        deadline,
    };
    if let Some(path) = &manuscript {
        r.visit(path, 0)?;
    } else {
        r.blockers
            .push("formal_claim_universe_manuscript_path_invalid".into())?;
    }
    let mut declarations = Vec::new();
    let mut by_environment: BTreeMap<String, usize> = BTreeMap::new();
    for read in &r.reads {
        check(c, deadline)?;
        let parsed = parse_new_theorem_declarations_with_control_v1(&latin1(&read.content), &work)?;
        r.blockers.extend(parsed.blockers.iter().map(|b| {
            format!(
                "formal_claim_universe_{}:{}:{}",
                b.code, read.relative, b.offset
            )
        }))?;
        for d in parsed.declarations {
            if d.offset_start > d.offset_end || d.offset_end > read.content.len() {
                return Err(refused());
            }
            let mut entry = json!({"version":1,"kind":"FormalTheoremEnvironmentDeclaration","environment":d.environment,"starred":d.starred,"aliasOf":d.alias_of,"within":d.within,"manuscriptPath":read.relative,"byteStart":d.offset_start,"byteEnd":d.offset_end,"declarationContentHash":bytes_hash(&read.content[d.offset_start..d.offset_end])});
            budget(declarations.iter().chain([&entry]))?;
            check(c, deadline)?;
            let h = hash("FormalTheoremEnvironmentDeclaration", &entry)?;
            check(c, deadline)?;
            entry["formalTheoremEnvironmentDeclarationHash"] = json!(h);
            if d.environment == "proof" {
                r.blockers.push(format!(
                    "formal_claim_universe_theorem_environment_reserved:{}:{}",
                    read.relative, d.offset_start
                ))?;
            } else if let std::collections::btree_map::Entry::Vacant(slot) =
                by_environment.entry(d.environment.clone())
            {
                slot.insert(declarations.len());
            } else {
                r.blockers.push(format!(
                    "formal_claim_universe_theorem_environment_duplicate:{}",
                    d.environment
                ))?;
            }
            declarations.push(entry);
        }
    }
    let standard = STANDARD_THEOREM_ENVIRONMENTS
        .iter()
        .map(|v| (*v).to_owned())
        .collect::<BTreeSet<_>>();
    for (index, declaration) in declarations.iter().enumerate() {
        let environment = declaration["environment"].as_str().ok_or_else(refused)?;
        if by_environment.get(environment) != Some(&index) {
            continue;
        }
        check(c, deadline)?;
        let Some(alias) = declaration["aliasOf"].as_str() else {
            continue;
        };
        if alias.is_empty() {
            continue;
        }
        let target = by_environment.get(alias).copied();
        if target.is_none() && !standard.contains(alias) {
            r.blockers.push(format!(
                "formal_claim_universe_theorem_environment_alias_unknown:{environment}:{alias}"
            ))?;
            continue;
        }
        if target.is_some_and(|i| declarations[i]["starred"] == true) {
            r.blockers.push(format!(
                "formal_claim_universe_theorem_environment_alias_unnumbered:{environment}:{alias}"
            ))?;
        }
        let mut seen = BTreeSet::from([environment.to_owned()]);
        let mut cursor = target;
        while let Some(i) = cursor {
            check(c, deadline)?;
            let name = declarations[i]["environment"]
                .as_str()
                .ok_or_else(refused)?;
            let Some(next) = declarations[i]["aliasOf"]
                .as_str()
                .and_then(|a| by_environment.get(a).copied())
            else {
                break;
            };
            if !seen.insert(name.into()) {
                r.blockers.push(format!(
                    "formal_claim_universe_theorem_environment_alias_cycle:{environment}"
                ))?;
                break;
            }
            cursor = Some(next);
        }
        if cursor.is_some_and(|i| {
            declarations[i]["aliasOf"]
                .as_str()
                .is_some_and(|a| seen.contains(a))
        }) {
            r.blockers.push(format!(
                "formal_claim_universe_theorem_environment_alias_cycle:{environment}"
            ))?;
        }
    }
    let environments = standard
        .into_iter()
        .chain(by_environment.keys().cloned())
        .collect::<BTreeSet<_>>();
    let mut extracted = BTreeMap::new();
    for read in &r.reads {
        let (values, blockers) = extract(read, &environments, c, &work, deadline)?;
        budget(
            extracted
                .values()
                .flat_map(|values: &Vec<Value>| values.iter())
                .chain(&values),
        )?;
        r.blockers.extend(blockers)?;
        extracted.insert(read.relative.clone(), values);
    }
    let by_path = r
        .reads
        .iter()
        .map(|r| (r.relative.clone(), r))
        .collect::<BTreeMap<_, _>>();
    let mut theorems = Vec::new();
    if let Some(path) = &manuscript {
        ordered(
            path,
            &by_path,
            &mut extracted,
            &mut BTreeSet::new(),
            &mut theorems,
            c,
            deadline,
        )?;
    }
    let collator = ProductionCollationV1::load().map_err(|_| refused())?;
    let mut files = r
        .reads
        .iter()
        .map(|r| json!({"path":r.relative,"hash":r.hash,"bytes":r.content.len()}))
        .collect::<Vec<_>>();
    let mut sorting_error = None;
    files.sort_by(|a, b| {
        if let Err(error) = check(c, deadline) {
            sorting_error = Some(error);
            return std::cmp::Ordering::Equal;
        }
        collator.compare(
            a["path"].as_str().unwrap_or_default(),
            b["path"].as_str().unwrap_or_default(),
        )
    });
    if let Some(error) = sorting_error.take() {
        return Err(error);
    }
    declarations.sort_by(|a, b| {
        if let Err(error) = check(c, deadline) {
            sorting_error = Some(error);
            return std::cmp::Ordering::Equal;
        }
        collator
            .compare(
                a["manuscriptPath"].as_str().unwrap_or_default(),
                b["manuscriptPath"].as_str().unwrap_or_default(),
            )
            .then_with(|| a["byteStart"].as_u64().cmp(&b["byteStart"].as_u64()))
    });
    if let Some(error) = sorting_error.take() {
        return Err(error);
    }
    check(c, deadline)?;
    budget(files.iter().chain(&declarations).chain(&theorems))?;
    let corpus = hash("FormalManuscriptCorpus", &json!(files))?;
    check(c, deadline)?;
    let blockers = dedup(r.blockers.values)
        .into_iter()
        .map(Value::String)
        .collect::<Vec<_>>();
    budget(
        files
            .iter()
            .chain(&declarations)
            .chain(&theorems)
            .chain(&blockers),
    )?;
    let mut observed = json!({"version":1,"kind":"FormalClaimUniverse","status":if blockers.is_empty(){"formal_claim_universe_verified"}else{"formal_claim_universe_blocked"},"manuscriptPath":manuscript,"manuscriptHash":corpus,"files":files,"environmentDeclarations":declarations,"theorems":theorems,"blockers":blockers});
    budget([&observed])?;
    observed["formalClaimUniverseHash"] = json!(hash("FormalClaimUniverse", &observed)?);
    drop(r.reads);
    source.assert_current()?;
    check(c, deadline)?;
    Ok(NativeFormalClaimUniverseObservationV1 { source, observed })
}
#[cfg(test)]
mod tests;
