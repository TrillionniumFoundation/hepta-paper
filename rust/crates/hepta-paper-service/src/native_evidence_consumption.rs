//! Pure evidence consumption facts. A ready report grants no authority.
//! V1 reuses existing JSON, String, Number, record and canonical UTC owners.
use crate::native_business::local_submission_preflight::{
    local_submission_projected_values_budget_v1 as projected, local_submission_truthy as truthy,
};
use crate::native_research_claims::{json_boundary, number, raw_string};
use hepta_legacy_compatibility::production_hash_record_v1;
use serde_json::{Value, json};
use std::{
    sync::atomic::{AtomicBool, Ordering},
    time::Instant,
};
mod dependencies;
mod reference;

fn refused() -> String {
    "native_evidence_consumption_data_domain_v1_refused".into()
}
struct Work<'a> {
    input: &'a Value,
    cancelled: &'a AtomicBool,
    deadline: Instant,
    items: usize,
    bytes: usize,
}
impl Work<'_> {
    fn check(&self) -> Result<(), String> {
        if self.cancelled.load(Ordering::SeqCst) {
            Err("native_evidence_consumption_cancelled".into())
        } else if Instant::now() >= self.deadline {
            Err("native_evidence_consumption_deadline_exceeded".into())
        } else {
            Ok(())
        }
    }
    fn reserve(&mut self, items: usize, bytes: usize) -> Result<(), String> {
        self.check()?;
        self.items = self.items.checked_add(items).ok_or_else(refused)?;
        self.bytes = self.bytes.checked_add(bytes).ok_or_else(refused)?;
        projected([self.input], self.items, self.bytes).map_err(|_| refused())
    }
    // This is only a conservative allocation charge. The existing String owner
    // performs conversion, including its custom-coercion refusal.
    fn string(&mut self, value: &Value) -> Result<String, String> {
        let mut pending = vec![value];
        let mut bytes = 0usize;
        while let Some(v) = pending.pop() {
            self.check()?;
            let extra = match v {
                Value::String(v) => v.len(),
                Value::Array(a) => {
                    pending.extend(a);
                    a.len()
                }
                Value::Object(_) => 15,
                _ => 32,
            };
            bytes = bytes
                .checked_add(extra)
                .filter(|n| *n <= 65536)
                .ok_or_else(refused)?;
        }
        self.reserve(1, bytes)?;
        let s = raw_string(value).map_err(|_| refused())?;
        self.check()?;
        Ok(s)
    }
    fn blocker(&mut self, blockers: &mut Vec<String>, value: &str) -> Result<(), String> {
        if value.len() > 65536 {
            return Err(refused());
        }
        self.reserve(1, value.len())?;
        blockers.push(value.to_owned());
        Ok(())
    }
    fn blocker_parts(&mut self, blockers: &mut Vec<String>, parts: &[&str]) -> Result<(), String> {
        let bytes = parts.iter().try_fold(0usize, |total, part| {
            total.checked_add(part.len()).ok_or_else(refused)
        })?;
        if bytes > 65536 {
            return Err(refused());
        }
        self.reserve(1, bytes)?;
        let mut value = String::with_capacity(bytes);
        for part in parts {
            self.check()?;
            value.push_str(part);
        }
        blockers.push(value);
        Ok(())
    }
    fn cycle_blocker(
        &mut self,
        blockers: &mut Vec<String>,
        trail: &[String],
        id: &str,
    ) -> Result<(), String> {
        let prefix = "evidence_dependency_cycle:";
        let mut bytes = prefix.len();
        for item in trail {
            self.check()?;
            bytes = bytes
                .checked_add(item.len())
                .and_then(|n| n.checked_add(1))
                .ok_or_else(refused)?;
        }
        bytes = bytes.checked_add(id.len()).ok_or_else(refused)?;
        if bytes > 65536 {
            return Err(refused());
        }
        self.reserve(1, bytes)?;
        let mut value = String::with_capacity(bytes);
        value.push_str(prefix);
        for item in trail {
            self.check()?;
            value.push_str(item);
            value.push('>');
        }
        value.push_str(id);
        blockers.push(value);
        Ok(())
    }
}
fn get<'a>(input: &'a Value, key: &str, default: &'a Value) -> &'a Value {
    input.get(key).unwrap_or(default)
}
fn first<'a>(value: &'a Value, keys: &[&str]) -> &'a Value {
    keys.iter()
        .filter_map(|key| value.get(*key))
        .find(|v| truthy(v))
        .unwrap_or(&Value::Null)
}
fn strict(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Null, Value::Null) => true,
        (Value::Bool(a), Value::Bool(b)) => a == b,
        (Value::String(a), Value::String(b)) => a == b,
        (Value::Number(a), Value::Number(b)) => a.as_f64() == b.as_f64(),
        _ => false,
    }
}
fn strings(v: &Value, w: &mut Work<'_>) -> Result<Vec<String>, String> {
    let mut out = Vec::new();
    if let Some(a) = v.as_array() {
        for v in a {
            out.push(w.string(v)?);
        }
    }
    Ok(out)
}
fn unique(values: Vec<String>, w: &Work<'_>) -> Result<Vec<String>, String> {
    let mut result = Vec::new();
    for value in values {
        w.check()?;
        if !result.contains(&value) {
            result.push(value);
        }
    }
    Ok(result)
}
fn sorted(mut values: Vec<String>) -> Vec<String> {
    values.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    values
}
fn hashed(kind: &str, mut value: Value, w: &Work<'_>, field: &str) -> Result<Value, String> {
    w.check()?;
    projected([&value, &value], 1, field.len() + 80).map_err(|_| refused())?;
    let digest = production_hash_record_v1(kind, &value).map_err(|_| refused())?;
    w.check()?;
    value[field] = json!(digest.as_str());
    Ok(value)
}
/// Borrowed finite JSON facts. Timestamps are canonical UTC instants or absent.
/// Other Date.parse spellings and non-array dependency iterables refuse.
pub fn evaluate_native_evidence_consumption_v1(
    input: &Value,
    c: &AtomicBool,
    deadline: Instant,
) -> Result<Value, String> {
    let mut w = Work {
        input,
        cancelled: c,
        deadline,
        items: 0,
        bytes: 0,
    };
    w.check()?;
    if !input.is_object() {
        return Err(refused());
    }
    projected([input, input], 0, 0).map_err(|_| refused())?;
    let normalized = json_boundary(input);
    w.input = &normalized;
    w.check()?;
    let empty = json!({});
    let array = json!([]);
    let accepted = json!(["positive", "verified"]);
    let yes = json!(true);
    let reference = get(&normalized, "reference", &empty);
    let expected = get(&normalized, "expected", &empty);
    if !expected.is_object() {
        return Err(refused());
    }
    let now = get(&normalized, "nowMs", &Value::Null);
    let age = get(&normalized, "maximumAgeMs", &Value::Null);
    let validity = reference::validity(reference, expected, now, age, &mut w)?;
    projected([w.input, &validity], w.items + 32, w.bytes + 1024).map_err(|_| refused())?;
    let mut blockers = validity["blockers"]
        .as_array()
        .ok_or_else(refused)?
        .iter()
        .map(|v| v.as_str().map(str::to_owned).ok_or_else(refused))
        .collect::<Result<Vec<_>, _>>()?;
    if truthy(get(&normalized, "requireCreatedAt", &yes))
        && reference::created(reference)?.is_none()
    {
        w.blocker(&mut blockers, "evidence_created_at_missing_or_invalid")?;
    }
    let required = strings(get(&normalized, "requiredOutputs", &array), &mut w)?;
    let available = unique(
        strings(get(&normalized, "availableOutputs", &array), &mut w)?,
        &w,
    )?;
    for item in &required {
        if !available.contains(item) {
            w.blocker_parts(&mut blockers, &["evidence_required_output_missing:", item])?;
        }
    }
    let claim = get(&normalized, "claimId", &Value::Null);
    let locator = get(&normalized, "sourceLocator", &Value::Null);
    let result = get(&normalized, "resultClass", &Value::Null);
    if truthy(claim) {
        let claims = strings(first(reference, &["claimIds", "claim_ids"]), &mut w)?;
        if !claims.contains(&w.string(claim)?) {
            w.blocker(&mut blockers, "evidence_claim_binding_mismatch")?;
        }
    }
    if truthy(locator) {
        let value = first(reference, &["sourceLocator", "source_locator", "path"]);
        let empty = json!("");
        if w.string(if truthy(value) { value } else { &empty })? != w.string(locator)? {
            w.blocker(&mut blockers, "evidence_source_locator_mismatch")?;
        }
    }
    if truthy(result)
        && !strings(get(&normalized, "acceptedResultClasses", &accepted), &mut w)?
            .contains(&w.string(result)?)
    {
        let s = w.string(result)?;
        w.blocker_parts(&mut blockers, &["evidence_result_not_promotable:", &s])?;
    }
    let forbidden = unique(
        strings(get(&normalized, "forbiddenSideEffects", &array), &mut w)?,
        &w,
    )?;
    for effect in strings(get(&normalized, "observedSideEffects", &array), &mut w)? {
        if forbidden.contains(&effect) {
            w.blocker_parts(&mut blockers, &["evidence_forbidden_side_effect:", &effect])?;
        }
    }
    let nodes = get(&normalized, "dependencyNodes", &array)
        .as_array()
        .ok_or_else(refused)?;
    let dependency = if nodes.is_empty() {
        None
    } else {
        Some(dependencies::freshness(nodes, &mut w)?)
    };
    if let Some(dependency) = &dependency {
        for item in dependency["blockers"].as_array().ok_or_else(refused)? {
            w.blocker(&mut blockers, item.as_str().ok_or_else(refused)?)?;
        }
    }
    w.reserve(32, 1024)?;
    projected(
        [w.input, &validity, claim, locator, result],
        w.items,
        w.bytes,
    )
    .map_err(|_| refused())?;
    let blockers = unique(blockers, &w)?;
    let payload = json!({"version":1,"kind":"EvidenceConsumptionPolicyReport","status":if blockers.is_empty(){"evidence_consumption_ready"}else{"evidence_consumption_blocked"},"referenceValidityHash":validity["evidenceReferenceValidityHash"],"evidenceHash":validity["evidenceHash"],"requiredOutputs":sorted(required),"availableOutputs":sorted(available),"claimId":claim,"sourceLocator":locator,"resultClass":result,"forbiddenSideEffects":sorted(forbidden),"dependencyFreshnessHash":dependency.as_ref().map(|v|&v["evidenceDependencyFreshnessHash"]),"blockers":blockers,"warnings":validity["warnings"]});
    hashed(
        "EvidenceConsumptionPolicyReport",
        payload,
        &w,
        "evidenceConsumptionPolicyHash",
    )
}
#[cfg(test)]
mod tests;
