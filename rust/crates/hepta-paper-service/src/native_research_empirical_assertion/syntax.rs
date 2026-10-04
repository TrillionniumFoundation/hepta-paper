//! Fixed original marker and null-authority prose syntax.
use super::*;
#[derive(Clone, Copy)]
pub(super) enum Marker {
    Assertion,
    Presentation,
}
impl Marker {
    pub(super) fn prefix(self) -> &'static str {
        match self {
            Self::Assertion => "empirical_assertion_universe",
            Self::Presentation => "empirical_presentation",
        }
    }
    pub(super) fn token(self) -> &'static str {
        match self {
            Self::Assertion => "HEPTA_EMPIRICAL_ASSERTION",
            Self::Presentation => "HEPTA_EMPIRICAL_PRESENTATION",
        }
    }
    pub(super) fn id(self) -> &'static str {
        match self {
            Self::Assertion => "assertionId",
            Self::Presentation => "surfaceId",
        }
    }
    pub(super) fn patterns(self) -> Result<&'static (Regex, Regex), String> {
        static ASSERTION: OnceLock<Result<(Regex, Regex), String>> = OnceLock::new();
        static PRESENTATION: OnceLock<Result<(Regex, Regex), String>> = OnceLock::new();
        let slot = match self {
            Self::Assertion => &ASSERTION,
            Self::Presentation => &PRESENTATION,
        };
        slot.get_or_init(||{
            let token=self.token();
            Ok((Regex::new(&format!(r"^[\t\x0b\x0c\r \u{{a0}}]*%[\t\x0b\x0c\r \u{{a0}}]*{token}_BEGIN[\t\x0b\x0c\r \u{{a0}}]+(\{{[^\r\n]*\}})[\t\x0b\x0c\r \u{{a0}}]*$")).map_err(|_|refused())?,Regex::new(&format!(r"^[\t\x0b\x0c\r \u{{a0}}]*%[\t\x0b\x0c\r \u{{a0}}]*{token}_END[\t\x0b\x0c\r \u{{a0}}]+([A-Za-z0-9][A-Za-z0-9_.:-]{{0,191}})[\t\x0b\x0c\r \u{{a0}}]*$")).map_err(|_|refused())?))
        }).as_ref().map_err(Clone::clone)
    }
    pub(super) fn valid(
        self,
        value: &Value,
        c: &AtomicBool,
        deadline: Instant,
    ) -> Result<bool, String> {
        match self {
            Self::Assertion => assertion_marker_declaration_valid_v1(value, c, deadline),
            Self::Presentation => {
                empirical_presentation_marker_declaration_valid_v1(value, c, deadline)
            }
        }
    }
}
pub(super) struct ProsePatterns {
    pub(super) legacy: Regex,
    pub(super) section: Regex,
    pub(super) unsupported: Regex,
    pub(super) environment: Regex,
    pub(super) class: Regex,
    pub(super) package: Regex,
    pub(super) theorem: Regex,
    pub(super) metadata: Regex,
    pub(super) standalone: Regex,
    pub(super) label: Regex,
    pub(super) remove_label: Regex,
    pub(super) section_command: Regex,
}
pub(super) fn prose_patterns() -> Result<&'static ProsePatterns, String> {
    static PATTERNS: OnceLock<Result<ProsePatterns, String>> = OnceLock::new();
    PATTERNS.get_or_init(||{
        let p=|s|Regex::new(s).map_err(|_|refused());
        Ok(ProsePatterns{
            legacy:p(r"(?i)^[\t\x0b\x0c\r \u{a0}]*%[\t\x0b\x0c\r \u{a0}]*HEPTA_RESULT(?-u:\b)")?,
            section:p(r"(?i)^[\t\x0b\x0c\r \u{a0}]*\\section\*?[\t\x0b\x0c\r \u{a0}]*\{([^{}]*)\}[\t\x0b\x0c\r \u{a0}]*(?:\\label[\t\x0b\x0c\r \u{a0}]*\{[^{}]+\}[\t\x0b\x0c\r \u{a0}]*)?$")?,
            unsupported:p(r"(?i)\\(?:subsection|subsubsection|paragraph|subparagraph)\*?[\t\x0b\x0c\r \u{a0}]*\{|\\caption\*?[\t\x0b\x0c\r \u{a0}]*\{|\\begin[\t\x0b\x0c\r \u{a0}]*\{(?:table\*?|figure\*?)\}")?,
            environment:p(r"(?i)^[\t\x0b\x0c\r \u{a0}]*\\(begin|end)[\t\x0b\x0c\r \u{a0}]*\{([A-Za-z][A-Za-z0-9:_-]*\*?)\}[\t\x0b\x0c\r \u{a0}]*(?:\[[^\]\r\n]*\][\t\x0b\x0c\r \u{a0}]*)?$")?,
            class:p(r"^[\t\x0b\x0c\r \u{a0}]*\\documentclass\[11pt\]\{article\}[\t\x0b\x0c\r \u{a0}]*$")?,
            package:p(r"^[\t\x0b\x0c\r \u{a0}]*\\usepackage\{amsmath,amssymb,amsthm(?:,graphicx)?\}[\t\x0b\x0c\r \u{a0}]*$")?,
            theorem:p(r"^[\t\x0b\x0c\r \u{a0}]*\\newtheorem[\t\x0b\x0c\r \u{a0}]*\{(?:theorem|lemma|proposition|corollary|definition|assumption)\}[\t\x0b\x0c\r \u{a0}]*\{(?:Theorem|Lemma|Proposition|Corollary|Definition|Assumption)\}[\t\x0b\x0c\r \u{a0}]*$")?,
            metadata:p(r"^[\t\x0b\x0c\r \u{a0}]*\\(?:author\{\}|date\{\})[\t\x0b\x0c\r \u{a0}]*$")?,
            standalone:p(r"(?i)^[\t\x0b\x0c\r \u{a0}]*\\(?:begin[\t\x0b\x0c\r \u{a0}]*\{document\}|end[\t\x0b\x0c\r \u{a0}]*\{document\}|maketitle|appendix|clearpage|newpage|pagebreak|noindent)[\t\x0b\x0c\r \u{a0}]*$")?,
            label:p(r"^[\t\x0b\x0c\r \u{a0}]*\\label[\t\x0b\x0c\r \u{a0}]*\{[A-Za-z0-9_.:-]+\}[\t\x0b\x0c\r \u{a0}]*$")?,
            remove_label:p(r"\\label[\t\x0b\x0c\r \u{a0}]*\{[^{}]+\}")?,
            section_command:p(r"\\[A-Za-z@]+[\t\x0b\x0c\r \u{a0}]*")?,
        })
    }).as_ref().map_err(Clone::clone)
}
pub(super) fn strip_comment(line: &str) -> &str {
    for (index, ch) in line.char_indices() {
        if ch == '%'
            && line[..index]
                .bytes()
                .rev()
                .take_while(|b| *b == b'\\')
                .count()
                % 2
                == 0
        {
            return &line[..index];
        }
    }
    line
}

pub(super) fn safe_section(title: &str, pattern: &Regex) -> bool {
    let normalized = pattern.replace_all(title, "");
    let lower = trim(&normalized).to_lowercase();
    matches!(
        lower.as_str(),
        "introduction"
            | "background"
            | "related work"
            | "method"
            | "methods"
            | "methodology"
            | "model"
            | "experimental setup"
            | "simulations"
            | "result"
            | "results"
            | "main result"
            | "main results"
            | "empirical result"
            | "empirical results"
            | "discussion"
            | "results and discussion"
            | "conclusion"
            | "limitations"
            | "reproducibility"
            | "preregistered hypothesis"
            | "formal source"
            | "formal protocol invariant"
            | "proof sketch"
            | "references"
            | "appendix"
            | "abstract"
            | "research scope"
            | "related-work boundary"
            | "preregistered claims"
            | "formal assurance"
            | "reproducibility and audit trail"
    )
}
pub(super) fn fixed_prose(text: &str) -> bool {
    matches!(
        text,
        "This report is limited to the registered typed assertions and kernel-verified formal theorem."
            | "This article reports a preregistered, bounded evaluation. All quantitative statements are rendered from verified experiment authority, and the formal result is limited to its kernel-checked statement."
            | "The machine-selected agenda is evaluated only inside its registered benchmark universe. Treatment, baseline, ablation, exclusions, metrics, and replay requirements are fixed before result promotion."
            | "Prior-art qualification is a separate release-bound authority. This source manuscript does not claim that a search is complete, nor does it infer novelty from the absence of a match."
            | "The evaluation uses a predeclared treatment, baseline, and ablation schedule. Agent-generated aggregates are not accepted as statistical authority; accepted statements must bind to repository-recomputed raw evidence and a matching isolated deterministic rerun."
            | "The formal artifact supports a protocol invariant only. It is not used as an axiom for the empirical result and does not establish external validity or scientific novelty."
            | "Interpretation is restricted to the registered population, metrics, comparators, and accepted typed assertions above. No unregistered causal, universal, convergence, or superiority claim is introduced by this section."
            | "The release evidence binds code, dataset authority, runtime identity, analysis protocol, raw events, original execution, isolated deterministic rerun, and the rendered result surfaces by hash."
            | "This report is limited to registered typed assertions and the kernel-verified formal statement. The rerun uses the same hash-bound code, image, data, and harness and is not independent scientific replication. Scientific novelty, universal correctness, natural-language-to-Lean semantic equivalence, and independent external replication are not implied by successful execution."
            | "The evidence package records whether the preregistered claims satisfied their declared acceptance rules. Broader conclusions require separately registered evidence."
    )
}
pub(super) fn inside(line: usize, values: &[Value]) -> bool {
    values.iter().any(|v| {
        v["markerByteStart"]
            .as_u64()
            .is_some_and(|start| start <= line as u64)
            && v["markerByteEnd"]
                .as_u64()
                .is_some_and(|end| (line as u64) < end)
    })
}
