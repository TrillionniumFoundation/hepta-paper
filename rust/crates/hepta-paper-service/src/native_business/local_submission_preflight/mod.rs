//! Native calculations for the non-authorizing local submission preflight.
//! Pure record calculations accept no external authority receipts. The CAS
//! composition reads actual verified objects for local preparation; persistence
//! and live submission authority remain with their existing separate owners.
mod cas;
mod delivery;
pub use cas::{
    CasLocalSubmissionArtifactRoleV1, CasLocalSubmissionArtifactV1,
    CasLocalSubmissionPreparationRequestV1, prepare_local_submission_from_cas_v1,
};
mod lifecycle;
mod records;
mod semantic;
mod workflow;
pub use lifecycle::{LocalSubmissionLifecycleInputV1, build_local_submission_lifecycle_v1};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeSet;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LocalSubmissionPreflightInputV1 {
    pub version: u16,
    pub kind: String,
    pub paper_task: Value,
    pub venue: Option<Value>,
    pub mode: String,
    pub reviewed_submit: bool,
}

fn local_submission_error() -> String {
    "native_local_submission_preflight_contract_refused".into()
}
pub(crate) fn local_submission_value_budget(value: &Value) -> Result<(), String> {
    local_submission_values_budget_v1(std::iter::once(value))
}
pub(crate) fn local_submission_values_budget_v1<'a>(
    values: impl IntoIterator<Item = &'a Value>,
) -> Result<(), String> {
    local_submission_projected_values_budget_v1(values, 0, 0)
}
/// Charge derived nodes and keys against the same record policy before projection.
pub(crate) fn local_submission_projected_values_budget_v1<'a>(
    values: impl IntoIterator<Item = &'a Value>,
    additional_items: usize,
    additional_bytes: usize,
) -> Result<(), String> {
    if additional_items > 20_000 || additional_bytes > 1024 * 1024 {
        return Err(local_submission_error());
    }
    let mut stack = values
        .into_iter()
        .map(|value| (value, 0_usize))
        .collect::<Vec<_>>();
    let (mut items, mut bytes) = (additional_items, additional_bytes);
    while let Some((node, depth)) = stack.pop() {
        items += 1;
        if items > 20_000 || depth > 64 {
            return Err(local_submission_error());
        }
        match node {
            Value::String(s) => {
                if s.len() > 64 * 1024 || s.contains('\0') {
                    return Err(local_submission_error());
                }
                bytes = bytes
                    .checked_add(s.len())
                    .ok_or_else(local_submission_error)?;
            }
            Value::Array(a) => {
                if a.len() > 1024 {
                    return Err(local_submission_error());
                }
                stack.extend(a.iter().map(|v| (v, depth + 1)));
            }
            Value::Object(o) => {
                if o.len() > 128 {
                    return Err(local_submission_error());
                }
                for (key, v) in o {
                    if key.len() > 256 || key.contains('\0') {
                        return Err(local_submission_error());
                    }
                    bytes = bytes
                        .checked_add(key.len())
                        .ok_or_else(local_submission_error)?;
                    stack.push((v, depth + 1));
                }
            }
            _ => (),
        }
        if bytes > 1024 * 1024 {
            return Err(local_submission_error());
        }
    }
    Ok(())
}
pub(crate) fn local_submission_truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(v) => *v,
        Value::Number(v) => v.as_f64().is_some_and(|n| n != 0.0),
        Value::String(v) => !v.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}
fn local_submission_or_null(v: &Value) -> Value {
    if local_submission_truthy(v) {
        v.clone()
    } else {
        Value::Null
    }
}
pub(crate) fn local_submission_normalize(value: &str) -> String {
    // Original text-utils removes CR, collapses ASCII space/tab runs and only
    // runs of at least three LF, then uses the fixed ECMAScript trim domain.
    let mut out = String::with_capacity(value.len());
    let (mut spaces, mut newlines) = (false, 0_usize);
    for c in value.chars().filter(|c| *c != '\r') {
        if matches!(c, ' ' | '\t') {
            newlines = 0;
            if !spaces {
                out.push(' ');
            }
            spaces = true;
        } else {
            spaces = false;
            if c == '\n' {
                newlines += 1;
                if newlines <= 2 {
                    out.push(c);
                }
            } else {
                newlines = 0;
                out.push(c);
            }
        }
    }
    out.trim_matches(|c: char| matches!(c, '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')).to_owned()
}
pub(crate) fn local_submission_unique(
    values: impl IntoIterator<Item = String>,
    limit: usize,
) -> Vec<String> {
    let mut out = Vec::new();
    let mut seen = BTreeSet::new();
    for v in values {
        let v = local_submission_normalize(&v);
        if !v.is_empty() && seen.insert(v.clone()) {
            out.push(v);
        }
        if out.len() == limit {
            break;
        }
    }
    out
}
fn local_submission_paper_hash(kind: &str, value: &Value) -> Result<String, String> {
    hepta_legacy_compatibility::production_digest_v1(
        &json!({"version":1,"kind":kind,"payload":value}),
    )
    .map(|v| v.as_str().to_owned())
    .map_err(|_| local_submission_error())
}
fn local_submission_kernel_hash(kind: &str, value: &Value) -> Result<String, String> {
    hepta_legacy_compatibility::production_hash_record_v1(kind, value)
        .map(|v| v.as_str().to_owned())
        .map_err(|_| local_submission_error())
}
pub(crate) fn local_submission_hashed(
    mut value: Value,
    field: &str,
    paper: bool,
) -> Result<Value, String> {
    let kind = value["kind"].as_str().ok_or_else(local_submission_error)?;
    let h = if paper {
        local_submission_paper_hash(kind, &value)?
    } else {
        local_submission_kernel_hash(kind, &value)?
    };
    value
        .as_object_mut()
        .ok_or_else(local_submission_error)?
        .insert(field.into(), json!(h));
    Ok(value)
}

/// Compute actual local preflight records. It cannot accept, synthesize or
/// promote a live authorization, independent review or verified artifact.
pub fn build_local_submission_preflight_v1(
    input: LocalSubmissionPreflightInputV1,
) -> Result<Value, String> {
    if input.version != 1
        || input.kind != "NativeLocalSubmissionPreflightInput"
        || !matches!(input.mode.as_str(), "local-dry-run" | "reviewed-submit")
    {
        return Err(local_submission_error());
    }
    if input.venue.as_ref().is_some_and(|v| !v.is_object()) {
        return Err(local_submission_error());
    }
    local_submission_value_budget(&input.paper_task)?;
    local_submission_value_budget(input.venue.as_ref().unwrap_or(&Value::Null))?;
    let task = input
        .paper_task
        .as_object()
        .ok_or_else(local_submission_error)?;
    if !task
        .get("taskKey")
        .and_then(Value::as_str)
        .is_some_and(|s| !s.is_empty() && s.len() <= 256)
        || !task
            .get("paperId")
            .and_then(Value::as_str)
            .is_some_and(|s| !s.is_empty() && s.len() <= 256)
    {
        return Err(local_submission_error());
    }
    let plan = records::venue_plan(&input)?;
    let lock = semantic::promotion_lock(&input.paper_task, &plan)?;
    let approval = records::approval(&input, &plan, &lock)?;
    let fresh = records::fresh(&input, &plan, &lock)?;
    Ok(
        json!({"version":1,"kind":"NativeLocalSubmissionPreflightCalculations","venuePlan":plan,"semanticPromotionLock":lock,"approvalPacket":approval,"freshVenueEvidenceBundle":fresh,"externalActionPerformed":false,"fullOriginalLifecycleComputed":false,"persistencePerformed":false}),
    )
}

#[cfg(test)]
mod tests;
