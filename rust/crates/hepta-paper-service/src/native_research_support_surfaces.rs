//! Complete marker observations in the original explicit-null authority domain.
//! A declaration cannot become a support surface without the verified authority
//! or manuscript IR; these APIs accept neither caller records nor authority.
use crate::native_business::local_submission_preflight::{
    local_submission_projected_values_budget_v1 as reserve,
    local_submission_values_budget_v1 as budget,
};
use regex::bytes::Regex;
use serde_json::{Value, json};
use std::{
    sync::{
        OnceLock,
        atomic::{AtomicBool, Ordering},
    },
    time::Instant,
};

#[derive(Clone, Copy)]
enum Domain {
    Formal,
    EvidenceBound,
}
impl Domain {
    fn marker(self) -> &'static str {
        match self {
            Self::Formal => "HEPTA_FORMAL_SUPPORT",
            Self::EvidenceBound => "HEPTA_EVIDENCE_BOUND_PROSE",
        }
    }
    fn prefix(self) -> &'static str {
        match self {
            Self::Formal => "autonomous_formal_support",
            Self::EvidenceBound => "evidence_bound_manuscript",
        }
    }
    fn key(self) -> &'static str {
        match self {
            Self::Formal => "formalSupports",
            Self::EvidenceBound => "surfaces",
        }
    }
}
fn refused() -> String {
    "native_research_null_support_surface_data_domain_v1_refused".into()
}
fn check(cancelled: &AtomicBool, deadline: Instant) -> Result<(), String> {
    if cancelled.load(Ordering::SeqCst) {
        Err("native_research_null_support_surface_cancelled".into())
    } else if Instant::now() >= deadline {
        Err("native_research_null_support_surface_deadline_exceeded".into())
    } else {
        Ok(())
    }
}
type Patterns = (Regex, Regex, Regex);
fn patterns(domain: Domain) -> Result<&'static Patterns, String> {
    static FORMAL: OnceLock<Result<Patterns, String>> = OnceLock::new();
    static EVIDENCE: OnceLock<Result<Patterns, String>> = OnceLock::new();
    let holder = match domain {
        Domain::Formal => &FORMAL,
        Domain::EvidenceBound => &EVIDENCE,
    };
    holder
        .get_or_init(|| {
            let space = r"[\x09-\x0d\x20\xa0]";
            Ok((
                Regex::new(&format!(
                    r"(?-u)^{space}*%{space}*{}_BEGIN{space}+\{{[^\r\n]*\}}{space}*$",
                    domain.marker()
                ))
                .map_err(|_| refused())?,
                Regex::new(&format!(
                    r"(?-u)^{space}*%{space}*{}_END{space}+([A-Za-z0-9][A-Za-z0-9_.:-]{{0,191}}){space}*$",
                    domain.marker()
                ))
                .map_err(|_| refused())?,
                Regex::new(&format!(r"(?-u){}_((?:BEGIN)|(?:END))", domain.marker()))
                    .map_err(|_| refused())?,
            ))
        })
        .as_ref()
        .map_err(Clone::clone)
}
fn inspect(
    domain: Domain,
    relative: &str,
    content: &[u8],
    cancelled: &AtomicBool,
    deadline: Instant,
) -> Result<Value, String> {
    check(cancelled, deadline)?;
    if relative.is_empty()
        || relative.len() > 4096
        || relative.contains('\0')
        || content.len() > 1024 * 1024
    {
        return Err(refused());
    }
    // The incumbent scans Buffer.toString('latin1'). Its whitespace domain
    // contains only these byte values; matching borrowed bytes avoids decoding
    // or duplicating the manuscript. The fixed patterns use the existing regex
    // dependency, with no caller regular expression or unbounded compilation.
    let (begin, end, token) = patterns(domain)?;
    let mut blockers = Vec::<Value>::new();
    let mut start = 0;
    let mut lines = 0;
    for cursor in 0..=content.len() {
        if cursor % 4096 == 0 {
            check(cancelled, deadline)?;
        }
        if cursor != content.len() && content[cursor] != b'\n' {
            continue;
        }
        lines += 1;
        if lines > 65536 {
            return Err(refused());
        }
        let content_end = if cursor > start && content[cursor - 1] == b'\r' {
            cursor - 1
        } else {
            cursor
        };
        let line = &content[start..content_end];
        let is_begin = begin.is_match(line);
        let is_end = end.is_match(line);
        check(cancelled, deadline)?;
        let suffix = if token.is_match(line) && !is_begin && !is_end {
            Some("marker_malformed")
        } else if is_begin {
            // The original null-authority / null-IR declaration predicate is
            // always false, including syntactically invalid JSON. Thus no open
            // marker or accepted body can be created in this explicit domain.
            Some("declaration_invalid")
        } else if is_end {
            Some("marker_end_unpaired")
        } else {
            None
        };
        if let Some(suffix) = suffix {
            if blockers.len() >= 1024 {
                return Err(refused());
            }
            let maximum = domain.prefix().len() + suffix.len() + relative.len() + 3 + 20;
            reserve(blockers.iter(), 1, maximum)?;
            blockers.push(Value::String(format!(
                "{}_{suffix}:{relative}:{start}",
                domain.prefix()
            )));
        }
        start = cursor + 1;
    }
    check(cancelled, deadline)?;
    reserve(blockers.iter(), 6, domain.key().len() + "blockers".len())?;
    let observed = json!({(domain.key()): [], "blockers": blockers});
    budget([&observed])?;
    check(cancelled, deadline)?;
    Ok(observed)
}

/// The complete original extraction result with trustedAuthority explicitly null.
pub fn extract_formal_support_surfaces_without_authority_v1(
    relative: &str,
    content: &[u8],
    cancelled: &AtomicBool,
    deadline: Instant,
) -> Result<Value, String> {
    inspect(Domain::Formal, relative, content, cancelled, deadline)
}

/// The complete original extraction result with both trusted IR and prior-art
/// receipt explicitly null. Authority-backed surfaces need a separate owner.
pub fn extract_evidence_bound_surfaces_without_ir_v1(
    relative: &str,
    content: &[u8],
    cancelled: &AtomicBool,
    deadline: Instant,
) -> Result<Value, String> {
    inspect(
        Domain::EvidenceBound,
        relative,
        content,
        cancelled,
        deadline,
    )
}

#[cfg(test)]
mod tests;
