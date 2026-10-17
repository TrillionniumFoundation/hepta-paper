//! Original research gap planning over bounded observed records.
//! Job persistence, worker evidence and execution authority remain with their owners.
use crate::native_business::local_submission_preflight::{
    local_submission_projected_values_budget_v1 as reserve, local_submission_truthy as truthy,
    local_submission_values_budget_v1 as budget,
};
use crate::native_research_claims::{json_boundary, number, number_value, raw_string};
use hepta_legacy_compatibility::{ProductionCollationV1, production_hash_record_v1};
use serde_json::{Value, json};
use std::{
    cmp::Ordering,
    sync::atomic::{AtomicBool, Ordering as AtomicOrdering},
    time::Instant,
};
fn refused() -> String {
    "native_research_gap_plan_data_domain_v1_refused".into()
}
fn check(c: &AtomicBool, deadline: Instant) -> Result<(), String> {
    if c.load(AtomicOrdering::SeqCst) {
        Err("native_research_gap_plan_cancelled".into())
    } else if Instant::now() >= deadline {
        Err("native_research_gap_plan_deadline_exceeded".into())
    } else {
        Ok(())
    }
}
fn field<'a>(v: &'a Value, k: &str) -> Option<&'a Value> {
    v.get(k)
}
fn or<'a>(v: &'a Value, keys: &[&str]) -> Option<&'a Value> {
    keys.iter().filter_map(|k| field(v, k)).find(|v| truthy(v))
}
fn string_bound(v: Option<&Value>) -> Result<usize, String> {
    let n = match v {
        None => 9,
        Some(Value::Null) => 4,
        Some(Value::Bool(_)) => 5,
        Some(Value::Number(_)) => 32,
        Some(Value::String(s)) => s.len(),
        Some(Value::Object(_)) => 15,
        Some(Value::Array(a)) => a.iter().try_fold(a.len().saturating_sub(1), |n, v| {
            n.checked_add(if v.is_null() {
                0
            } else {
                string_bound(Some(v))?
            })
            .ok_or_else(refused)
        })?,
    };
    if n > 65536 { Err(refused()) } else { Ok(n) }
}
fn text(v: Option<&Value>) -> Result<String, String> {
    string_bound(v)?;
    v.map(raw_string).unwrap_or_else(|| Ok("undefined".into()))
}
fn array_default(v: Option<&Value>, falsy_default: bool) -> Result<&[Value], String> {
    match v {
        None => Ok(&[]),
        Some(v) if falsy_default && !truthy(v) => Ok(&[]),
        Some(Value::Array(a)) => Ok(a),
        _ => Err(refused()),
    }
}
fn same_key(a: Option<&Value>, b: Option<&Value>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(Value::Null), Some(Value::Null)) => true,
        (Some(Value::Bool(a)), Some(Value::Bool(b))) => a == b,
        (Some(Value::String(a)), Some(Value::String(b))) => a == b,
        (Some(Value::Number(a)), Some(Value::Number(b))) => a.as_f64() == b.as_f64(),
        _ => false,
    }
}
fn kind(v: Option<&Value>) -> Result<&'static str, String> {
    let risk = if v.is_none() { String::new() } else { text(v)? }.to_ascii_lowercase();
    Ok(match risk.as_str() {
        "theorem_readiness" | "proof" | "formal_verification" => "proof",
        "experiment" | "empirical" | "benchmark" => "experiment",
        "reproducibility" | "reproduction" => "reproducibility",
        "artifact" | "package" | "evidence_artifact" => "artifact",
        _ => "claim_evidence",
    })
}
fn contract(kind: &str) -> Value {
    let (action, cpu, memory, timeout, outputs, criteria, forbidden, negative) = match kind {
        "proof" => (
            "verify_or_complete_formal_proof",
            2,
            4096,
            120000,
            vec!["source_bound_theorem", "formal_verification_receipt"],
            vec!["lake_build_verified", "all_proof_obligations_covered"],
            vec![
                "direct_source_mutation",
                "caller_supplied_verification_flags",
            ],
            "block_promotion_and_return_revision",
        ),
        "experiment" => (
            "run_declared_experiment_contract",
            4,
            8192,
            3600000,
            vec!["experiment_manifest", "metrics", "execution_receipt"],
            vec!["declared_metric_evaluated", "result_policy_recorded"],
            vec!["arbitrary_operator_command", "undeclared_dataset"],
            "preserve_negative_or_inconclusive_result_without_promotion",
        ),
        "reproducibility" => (
            "reproduce_bound_research_result",
            4,
            8192,
            3600000,
            vec!["replay_manifest", "replay_receipt", "hash_comparison"],
            vec!["replay_inputs_hash_bound", "replay_outcome_classified"],
            vec!["source_mutation", "unbound_environment"],
            "record_reproduction_failure_without_promotion",
        ),
        "artifact" => (
            "produce_or_bind_research_artifact",
            1,
            2048,
            300000,
            vec!["content_addressed_artifact", "provenance_receipt"],
            vec!["artifact_hash_verified", "source_locator_bound"],
            vec!["path_escape", "untracked_side_effect"],
            "block_promotion",
        ),
        _ => (
            "produce_or_bind_research_evidence",
            1,
            2048,
            300000,
            vec!["claim_bound_evidence", "provenance_receipt"],
            vec!["claim_coverage_verified"],
            vec!["arbitrary_operator_command", "direct_source_mutation"],
            "allow_negative_evidence_only_with_explicit_non_promotion",
        ),
    };
    json!({"gapKind":kind,"action":action,"resourceProfile":{"cpu":cpu,"memoryMb":memory,"timeoutMs":timeout},"requiredOutputs":outputs,"successCriteria":criteria,"forbiddenActions":forbidden,"negativeResultPolicy":negative})
}
fn null_boundary(v: Option<&Value>) -> Value {
    v.filter(|v| truthy(v))
        .map(json_boundary)
        .unwrap_or(Value::Null)
}
fn priority_number(v: &Value) -> Result<f64, String> {
    // Validate the bounded String projection and coercion overrides before
    // using the existing Number owner; never allocate an unbounded joined array.
    string_bound(Some(v))?;
    raw_string(v)?;
    number(v)
}
struct Job {
    record: Value,
    priority: f64,
}
/// Calculate fixed gap contracts and their original hash. No jobs are persisted.
pub fn build_native_research_gap_plan_v1(
    request: &Value,
    c: &AtomicBool,
    deadline: Instant,
) -> Result<Value, String> {
    check(c, deadline)?;
    budget([request])?;
    if request.is_null() {
        return Err(refused());
    }
    let empty = json!({});
    let paper = field(request, "paperTask").unwrap_or(&Value::Null);
    let registry = field(request, "claimRegistry").unwrap_or(&Value::Null);
    let quality = field(request, "evidenceQualityGate").unwrap_or(&Value::Null);
    let claims = array_default(field(registry, "claims"), true)?;
    let prior = array_default(field(request, "priorJobs"), false)?;
    if prior.iter().any(Value::is_null) {
        return Err(refused());
    }
    let revisions = array_default(field(request, "revisionRequests"), false)?;
    let priorities = field(request, "priorities").unwrap_or(&empty);
    // Prototype lookup and exotic index receivers are outside the versioned
    // observed-record domain; never reinterpret them as ordinary priorities.
    if !priorities.is_object() {
        return Err(refused());
    }
    let covered = field(quality, "coveredClaimIds").filter(|v| truthy(v));
    if covered.is_some_and(|v| !v.is_array() && !v.is_string()) {
        return Err(refused());
    }
    let paper_id = or(paper, &["paperId"]);
    let paper_fallback = json!("paper");
    let paper_text = text(paper_id.or(Some(&paper_fallback)))?;
    let mut jobs = Vec::<Job>::new();
    for claim in claims {
        check(c, deadline)?;
        if claim.is_null() {
            return Err(refused());
        }
        let id = field(claim, "claimId");
        let is_covered = match covered {
            Some(Value::Array(a)) => a.iter().any(|v| same_key(id, Some(v))),
            Some(Value::String(s)) => id.and_then(Value::as_str).is_some_and(|id| {
                s.chars().any(|ch| {
                    let mut b = [0; 4];
                    id == ch.encode_utf8(&mut b)
                })
            }),
            _ => false,
        };
        if is_covered {
            continue;
        }
        let key = text(id)?;
        let priority = field(priorities, &key);
        let priority = if priority.is_none()
            && matches!(
                key.as_str(),
                "__proto__"
                    | "constructor"
                    | "toString"
                    | "valueOf"
                    | "hasOwnProperty"
                    | "isPrototypeOf"
                    | "propertyIsEnumerable"
                    | "toLocaleString"
                    | "__defineGetter__"
                    | "__defineSetter__"
                    | "__lookupGetter__"
                    | "__lookupSetter__"
            ) {
            f64::NAN
        } else {
            priority
                .filter(|v| !v.is_null())
                .map(priority_number)
                .transpose()?
                .unwrap_or(100.0)
        };
        let previous = prior
            .iter()
            .rev()
            .find(|v| same_key(field(v, "claimId"), id));
        let receipt = previous.and_then(|v| or(v, &["receiptHash"]));
        let risk = or(claim, &["riskClass", "kind"]);
        let k = kind(risk)?;
        let status = text(field(claim, "status"))?;
        let bytes = paper_text
            .len()
            .checked_mul(2)
            .and_then(|n| n.checked_add(key.len() * 2 + status.len() + 1100))
            .ok_or_else(refused)?;
        reserve(
            std::iter::once(request)
                .chain(jobs.iter().map(|v| &v.record))
                .chain(id)
                .chain(receipt),
            80,
            bytes,
        )?;
        let mut job = contract(k);
        let object = job.as_object_mut().ok_or_else(refused)?;
        object.insert(
            "jobId".into(),
            json!(format!("research-gap:{paper_text}:{key}")),
        );
        if let Some(id) = id {
            object.insert("claimId".into(), json_boundary(id));
        }
        object.insert("priority".into(), number_value(priority));
        object.insert(
            "deduplicationKey".into(),
            json!(format!("{paper_text}:{key}:{status}")),
        );
        object.insert("priorReceiptHash".into(), null_boundary(receipt));
        object.insert("arbitraryCommandAllowed".into(), json!(false));
        object.insert("source".into(), json!("claim_registry"));
        budget([&job])?;
        if jobs.len() >= 1024 {
            return Err(refused());
        }
        jobs.push(Job {
            record: job,
            priority,
        });
    }
    for revision in revisions {
        check(c, deadline)?;
        if revision.is_null() {
            return Err(refused());
        }
        if matches!(revision["status"].as_str(), Some("resolved" | "closed")) {
            continue;
        }
        let k = kind(or(revision, &["risk_class", "riskClass"]))?;
        let source_key = or(revision, &["request_key", "requestKey", "request_id"]);
        let fallback = json!("revision");
        let key = text(source_key.or(Some(&fallback)))?;
        let key = key
            .encode_utf16()
            .map(|u| {
                if u <= 127 && (u as u8).is_ascii_alphanumeric() || matches!(u, 45 | 46 | 58 | 95) {
                    char::from_u32(u as u32).unwrap_or('_')
                } else {
                    '_'
                }
            })
            .collect::<String>();
        let claim_id = or(revision, &["claim_id", "claimId"]);
        let rev_id = or(revision, &["request_id", "requestId"]);
        let rev_key = or(revision, &["request_key", "requestKey"]);
        let rank = field(revision, "matrix_rank")
            .filter(|v| !v.is_null())
            .or_else(|| field(revision, "matrixRank").filter(|v| !v.is_null()));
        let priority = rank.map(priority_number).transpose()?.unwrap_or(50.0);
        let stamp = or(revision, &["updated_at", "updatedAt", "status"]);
        let stamp_fallback = json!("requested");
        let stamp = text(stamp.or(Some(&stamp_fallback)))?;
        let locator = or(revision, &["source_locator", "sourceLocator"]);
        let needed = or(revision, &["evidence_needed", "evidenceNeeded"]);
        let verification = or(revision, &["verification"]);
        let bytes = paper_text
            .len()
            .checked_mul(2)
            .and_then(|n| n.checked_add(key.len() * 5 + stamp.len() + 1200))
            .ok_or_else(refused)?;
        reserve(
            std::iter::once(request)
                .chain(jobs.iter().map(|v| &v.record))
                .chain(claim_id)
                .chain(rev_id)
                .chain(rev_key)
                .chain(locator)
                .chain(needed)
                .chain(verification),
            95,
            bytes,
        )?;
        let mut job = contract(k);
        let object = job.as_object_mut().ok_or_else(refused)?;
        object.insert(
            "jobId".into(),
            json!(format!("research-gap:{paper_text}:revision:{key}")),
        );
        object.insert(
            "claimId".into(),
            claim_id
                .map(json_boundary)
                .unwrap_or_else(|| json!(format!("revision:{key}"))),
        );
        object.insert("revisionRequestId".into(), null_boundary(rev_id));
        object.insert(
            "revisionRequestKey".into(),
            rev_key.map(json_boundary).unwrap_or_else(|| json!(key)),
        );
        object.insert("priority".into(), number_value(priority));
        object.insert(
            "deduplicationKey".into(),
            json!(format!("{paper_text}:revision:{key}:{stamp}")),
        );
        object.insert("priorReceiptHash".into(), Value::Null);
        object.insert("arbitraryCommandAllowed".into(), json!(false));
        object.insert("source".into(), json!("referee_revision_requests"));
        object.insert("sourceLocator".into(), null_boundary(locator));
        object.insert("evidenceNeeded".into(), null_boundary(needed));
        object.insert("verificationPlan".into(), null_boundary(verification));
        budget([&job])?;
        if jobs.len() >= 1024 {
            return Err(refused());
        }
        jobs.push(Job {
            record: job,
            priority,
        });
    }
    // Nonfinite mixed-priority sorting is comparator-order dependent in the
    // original V8 TimSort. The v1 domain refuses it rather than inventing order.
    if jobs.len() > 1 && jobs.iter().any(|v| !v.priority.is_finite()) {
        return Err(refused());
    }
    let collator = ProductionCollationV1::load().map_err(|_| refused())?;
    // JavaScript compares lazily: equal/nonfinite differences require a string
    // receiver for localeCompare. Refuse that original TypeError domain first.
    for (i, left) in jobs.iter().enumerate() {
        check(c, deadline)?;
        for right in &jobs[i + 1..] {
            let difference = left.priority - right.priority;
            if (difference == 0.0 || difference.is_nan())
                && (!left.record["claimId"].is_string() || !right.record["claimId"].is_string())
            {
                return Err(refused());
            }
        }
    }
    jobs.sort_by(|left, right| {
        let difference = left.priority - right.priority;
        if difference < 0.0 {
            Ordering::Less
        } else if difference > 0.0 {
            Ordering::Greater
        } else {
            collator.compare(
                left.record["claimId"].as_str().unwrap_or_default(),
                right.record["claimId"].as_str().unwrap_or_default(),
            )
        }
    });
    check(c, deadline)?;
    reserve(
        std::iter::once(request)
            .chain(jobs.iter().map(|v| &v.record))
            .chain(paper_id),
        15,
        250,
    )?;
    let mut record = json!({"version":3,"kind":"ResearchGapPlan","paperId":null_boundary(paper_id),"jobs":jobs.into_iter().map(|v|v.record).collect::<Vec<_>>()});
    budget([&record])?;
    let hash = production_hash_record_v1("ResearchGapPlan", &record).map_err(|_| refused())?;
    record
        .as_object_mut()
        .ok_or_else(refused)?
        .insert("researchGapPlanHash".into(), json!(hash.as_str()));
    budget([&record])?;
    check(c, deadline)?;
    Ok(record)
}
#[cfg(test)]
mod tests;
