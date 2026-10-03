//! Original promotion record calculations, without receipt verification or authority.
use crate::native_business::local_submission_preflight::{
    local_submission_projected_values_budget_v1 as reserve, local_submission_truthy as truthy,
    local_submission_values_budget_v1 as budget,
};
use crate::native_research_claims::{json_boundary, raw_string};
use hepta_legacy_compatibility::{ProductionCollationV1, production_hash_record_v1};
use serde_json::{Value, json};
use std::{
    cmp::Ordering,
    sync::atomic::{AtomicBool, Ordering as AtomicOrdering},
    time::Instant,
};
fn refused() -> String {
    "native_research_promotion_record_domain_v1_refused".into()
}
fn check(c: &AtomicBool, d: Instant) -> Result<(), String> {
    if c.load(AtomicOrdering::SeqCst) {
        Err("native_research_promotion_cancelled".into())
    } else if Instant::now() >= d {
        Err("native_research_promotion_deadline_exceeded".into())
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
fn nullable(v: Option<&Value>) -> Value {
    v.filter(|v| truthy(v))
        .map(json_boundary)
        .unwrap_or(Value::Null)
}
fn same(a: Option<&Value>, b: Option<&Value>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(Value::Null), Some(Value::Null)) => true,
        (Some(Value::Bool(a)), Some(Value::Bool(b))) => a == b,
        (Some(Value::Number(a)), Some(Value::Number(b))) => a.as_f64() == b.as_f64(),
        (Some(Value::String(a)), Some(Value::String(b))) => a == b,
        _ => false,
    }
}
fn array(v: Option<&Value>) -> Result<&[Value], String> {
    match v {
        None => Ok(&[]),
        Some(Value::Array(a)) => Ok(a),
        _ => Err(refused()),
    }
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
fn hashed(
    mut v: Value,
    request: &Value,
    key: &str,
    c: &AtomicBool,
    d: Instant,
) -> Result<Value, String> {
    check(c, d)?;
    reserve([request, &v], 2, 160)?;
    let kind = v["kind"].as_str().ok_or_else(refused)?;
    let h = production_hash_record_v1(kind, &v).map_err(|_| refused())?;
    v.as_object_mut()
        .ok_or_else(refused)?
        .insert(key.into(), json!(h.as_str()));
    budget([request, &v])?;
    check(c, d)?;
    Ok(v)
}
fn start(request: &Value, c: &AtomicBool, d: Instant) -> Result<(), String> {
    check(c, d)?;
    budget([request])?;
    if request.is_null() {
        Err(refused())
    } else {
        Ok(())
    }
}
/// Freeze the original input identity record; the status carries no execution permission.
pub fn build_native_promotion_input_snapshot_v1(
    request: &Value,
    c: &AtomicBool,
    d: Instant,
) -> Result<Value, String> {
    start(request, c, d)?;
    let mut revisions = Vec::new();
    let mut keys = Vec::new();
    let mut keys_bytes = 0_usize;
    for revision in array(field(request, "revisionRequests"))? {
        check(c, d)?;
        if revision.is_null() {
            return Err(refused());
        }
        let bindings = [
            ("requestId", or(revision, &["request_id", "requestId"])),
            ("requestKey", or(revision, &["request_key", "requestKey"])),
            ("claimId", or(revision, &["claim_id", "claimId"])),
            ("status", or(revision, &["status"])),
            ("riskClass", or(revision, &["risk_class", "riskClass"])),
            (
                "updatedAt",
                or(
                    revision,
                    &["updated_at", "updatedAt", "created_at", "createdAt"],
                ),
            ),
        ];
        let empty = json!("");
        let id_value = bindings[0].1.or(Some(&empty));
        let key_value = bindings[1].1.or(Some(&empty));
        let text_bytes = string_bound(id_value)? + string_bound(key_value)?;
        reserve(
            std::iter::once(request)
                .chain(revisions.iter())
                .chain(bindings.iter().filter_map(|(_, v)| *v)),
            15,
            keys_bytes + 2 * text_bytes + 132,
        )?;
        let id = text(id_value)?;
        let key = text(key_value)?;
        keys_bytes += id.len() + key.len() + 1;
        let record = Value::Object(
            bindings
                .into_iter()
                .map(|(k, v)| (k.into(), nullable(v)))
                .collect(),
        );
        budget([&record])?;
        revisions.push(record);
        keys.push(format!("{id}:{key}"));
    }
    let collator = ProductionCollationV1::load().map_err(|_| refused())?;
    let mut order = (0..revisions.len()).collect::<Vec<_>>();
    order.sort_by(|a, b| collator.compare(&keys[*a], &keys[*b]));
    let mut sorted = Vec::new();
    for index in order {
        check(c, d)?;
        sorted.push(std::mem::take(&mut revisions[index]));
    }
    drop(keys);
    let revisions = sorted;
    let empty = json!("");
    let mut open = Vec::new();
    for revision in &revisions {
        check(c, d)?;
        let status_value = or(revision, &["status"]).or(Some(&empty));
        reserve(
            std::iter::once(request)
                .chain(revisions.iter())
                .chain(open.iter()),
            3,
            2 * string_bound(status_value)?,
        )?;
        let status = text(status_value)?.to_ascii_lowercase();
        if !matches!(status.as_str(), "resolved" | "closed") {
            let value = or(revision, &["requestId", "requestKey"]);
            reserve(
                std::iter::once(request)
                    .chain(revisions.iter())
                    .chain(open.iter())
                    .chain(value),
                3,
                20,
            )?;
            open.push(value.map(json_boundary).unwrap_or_else(|| json!("unknown")));
        }
    }
    let paper = &request["paperTask"];
    let registry = &request["claimRegistry"];
    let quality = &request["evidenceQualityGate"];
    let plan = &request["researchGapPlan"];
    let bindings = [
        ("paperId", or(paper, &["paperId"])),
        ("taskHash", or(paper, &["taskHash"])),
        ("paperQualityProfile", or(paper, &["paperQualityProfile"])),
        ("claimRegistryHash", or(registry, &["claimRegistryHash"])),
        (
            "evidenceQualityGateHash",
            or(quality, &["evidenceQualityGateHash"]),
        ),
        ("researchGapPlanHash", or(plan, &["researchGapPlanHash"])),
    ];
    let created = field(request, "createdAt");
    reserve(
        std::iter::once(request)
            .chain(revisions.iter())
            .chain(open.iter())
            .chain(bindings.iter().filter_map(|(_, v)| *v))
            .chain(created),
        35,
        650,
    )?;
    let mut subject = Value::Object(
        bindings
            .into_iter()
            .map(|(k, v)| (k.into(), nullable(v)))
            .collect(),
    );
    subject
        .as_object_mut()
        .ok_or_else(refused)?
        .insert("revisions".into(), json!(revisions));
    let identity =
        production_hash_record_v1("PromotionInputIdentity", &subject).map_err(|_| refused())?;
    check(c, d)?;
    let task_bound = truthy(&paper["taskHash"]);
    let gap_bound = truthy(&plan["researchGapPlanHash"]);
    let mut blockers = Vec::new();
    if !task_bound {
        blockers.push("promotion_input_task_hash_missing");
    }
    if !gap_bound {
        blockers.push("promotion_input_gap_plan_hash_missing");
    }
    let payload = subject.as_object_mut().ok_or_else(refused)?;
    payload.insert("version".into(), json!(1));
    payload.insert("kind".into(), json!("PromotionInputSnapshot"));
    payload.insert(
        "status".into(),
        json!(if task_bound && gap_bound {
            "promotion_input_snapshot_frozen"
        } else {
            "promotion_input_snapshot_blocked"
        }),
    );
    payload.insert("openRevisionCount".into(), json!(open.len()));
    payload.insert("openRevisionIds".into(), json!(open));
    payload.insert(
        "promotionInputIdentityHash".into(),
        json!(identity.as_str()),
    );
    payload.insert(
        "createdAt".into(),
        created.map(json_boundary).unwrap_or(Value::Null),
    );
    payload.insert("blockers".into(), json!(blockers));
    hashed(subject, request, "promotionInputSnapshotHash", c, d)
}
fn sorted_ids(
    values: &mut [Option<&Value>],
    request: &Value,
    blockers: &[Value],
    c: &AtomicBool,
    d: Instant,
) -> Result<(), String> {
    let mut keys = Vec::new();
    let mut key_bytes = 0_usize;
    for value in values.iter() {
        check(c, d)?;
        key_bytes += value
            .map(|v| string_bound(Some(v)))
            .transpose()?
            .unwrap_or(0);
        reserve(
            std::iter::once(request).chain(blockers),
            values.len(),
            key_bytes,
        )?;
        keys.push(value.map(|v| text(Some(v))).transpose()?);
    }
    let mut indices = (0..values.len()).collect::<Vec<_>>();
    indices.sort_by(|a, b| match (&keys[*a], &keys[*b]) {
        (None, None) => Ordering::Equal,
        (None, _) => Ordering::Greater,
        (_, None) => Ordering::Less,
        (Some(a), Some(b)) => a.encode_utf16().cmp(b.encode_utf16()),
    });
    let original = values.to_vec();
    for (i, index) in indices.into_iter().enumerate() {
        values[i] = original[index];
    }
    Ok(())
}
/// Reproduce the original structural closure receipt. Supplied receipts are unverified data.
pub fn build_native_research_gap_closure_receipt_v1(
    request: &Value,
    c: &AtomicBool,
    d: Instant,
) -> Result<Value, String> {
    start(request, c, d)?;
    let plan = &request["researchGapPlan"];
    let snapshot = &request["promotionInputSnapshot"];
    let jobs = plan["jobs"].as_array().map(Vec::as_slice).unwrap_or(&[]);
    if jobs.iter().any(Value::is_null) {
        return Err(refused());
    }
    let mut completed = Vec::new();
    for item in array(field(request, "completedJobReceipts"))? {
        check(c, d)?;
        if item["status"] == "research_gap_job_completed" && truthy(&item["receiptHash"]) {
            let id = field(item, "jobId");
            if !completed.iter().any(|old| same(*old, id)) {
                completed.push(id);
            }
        }
    }
    let unresolved = jobs
        .iter()
        .filter(|job| !completed.iter().any(|id| same(*id, field(job, "jobId"))))
        .collect::<Vec<_>>();
    let mut blockers = Vec::new();
    if snapshot["status"] != "promotion_input_snapshot_frozen" {
        blockers.push(json!("promotion_input_snapshot_not_frozen"));
    }
    if !same(
        field(snapshot, "researchGapPlanHash"),
        field(plan, "researchGapPlanHash"),
    ) {
        blockers.push(json!("promotion_input_gap_plan_binding_mismatch"));
    }
    for job in &unresolved {
        check(c, d)?;
        let key_value = or(job, &["revisionRequestId", "claimId"]).or(field(job, "jobId"));
        reserve(
            std::iter::once(request).chain(blockers.iter()),
            1,
            string_bound(key_value)? + 24,
        )?;
        let key = text(key_value)?;
        blockers.push(json!(format!("research_gap_not_closed:{key}")));
    }
    let mut open = jobs.iter().map(|v| field(v, "jobId")).collect::<Vec<_>>();
    let mut unclosed = unresolved
        .iter()
        .map(|v| field(v, "jobId"))
        .collect::<Vec<_>>();
    sorted_ids(&mut open, request, &blockers, c, d)?;
    sorted_ids(&mut completed, request, &blockers, c, d)?;
    sorted_ids(&mut unclosed, request, &blockers, c, d)?;
    let snapshot_hash = or(snapshot, &["promotionInputSnapshotHash"]);
    let plan_hash = or(plan, &["researchGapPlanHash"]);
    reserve(
        std::iter::once(request)
            .chain(blockers.iter())
            .chain(
                open.iter()
                    .chain(&completed)
                    .chain(&unclosed)
                    .filter_map(|v| *v),
            )
            .chain(snapshot_hash)
            .chain(plan_hash),
        35,
        420,
    )?;
    let ids = |v: Vec<Option<&Value>>| {
        v.into_iter()
            .map(|v| v.map(json_boundary).unwrap_or(Value::Null))
            .collect::<Vec<_>>()
    };
    let payload = json!({"version":1,"kind":"ResearchGapClosureReceipt","status":if blockers.is_empty(){"research_gap_closure_verified"}else{"research_gap_closure_blocked"},"promotionInputSnapshotHash":nullable(snapshot_hash),"researchGapPlanHash":nullable(plan_hash),"openJobIds":ids(open),"completedJobIds":ids(completed),"unresolvedJobIds":ids(unclosed),"blockers":blockers});
    hashed(payload, request, "researchGapClosureReceiptHash", c, d)
}
/// Build a repair-service proposal record, without applying or authorizing a patch.
pub fn build_native_research_change_proposal_v1(
    request: &Value,
    c: &AtomicBool,
    d: Instant,
) -> Result<Value, String> {
    start(request, c, d)?;
    let patches = array(field(request, "patches"))?;
    let mut blockers = Vec::new();
    if request["evidenceQualityGate"]["status"] != "evidence_quality_ready" {
        blockers.push("evidence_quality_gate_not_ready");
    }
    for patch in patches {
        check(c, d)?;
        if patch.is_null() {
            return Err(refused());
        }
        if (!truthy(&patch["preimageHash"]) || !truthy(&patch["patchHash"]))
            && !blockers.contains(&"patch_hash_binding_required")
        {
            blockers.push("patch_hash_binding_required");
        }
    }
    let paper = or(&request["paperTask"], &["paperId"]);
    reserve(
        std::iter::once(request).chain(patches).chain(paper),
        25,
        360,
    )?;
    let payload = json!({"version":1,"kind":"ResearchChangeProposal","paperId":nullable(paper),"status":if blockers.is_empty(){"research_change_proposal_ready"}else{"research_change_proposal_blocked"},"patches":patches.iter().map(json_boundary).collect::<Vec<_>>(),"sourceMutationPerformed":false,"applyAuthority":"repair_service_only","blockers":blockers});
    hashed(payload, request, "researchChangeProposalHash", c, d)
}
#[cfg(test)]
mod tests;
