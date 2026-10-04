//! Evidence intake derived from an actual held artifact observation. A ready
//! integrity/consumption record is not academic or scientific authority.
use super::*;
fn check_control(c: &AtomicBool, deadline: Instant) -> Result<(), String> {
    check(c)?;
    if Instant::now() >= deadline {
        Err(refused())
    } else {
        Ok(())
    }
}
// Conservative allocation projection only. The existing raw_string owner
// performs all actual ECMAScript conversion; this adds no numerical parser.
fn string_projection(value: &Value, c: &AtomicBool, deadline: Instant) -> Result<usize, String> {
    let mut pending = vec![value];
    let mut bytes = 0usize;
    while let Some(value) = pending.pop() {
        check_control(c, deadline)?;
        let extra = match value {
            Value::String(s) => s.len(),
            Value::Array(values) => {
                pending.extend(values);
                values.len()
            }
            Value::Object(_) => 15,
            _ => 32,
        };
        bytes = bytes
            .checked_add(extra)
            .filter(|n| *n <= 65536)
            .ok_or_else(refused)?;
    }
    Ok(bytes)
}
fn first<'a>(value: &'a Value, keys: &[&str]) -> &'a Value {
    keys.iter()
        .map(|k| &value[*k])
        .find(|v| truthy(v))
        .unwrap_or(&Value::Null)
}
fn primitive_id(value: &Value) -> Result<(), String> {
    if matches!(
        value,
        Value::Null | Value::Bool(_) | Value::String(_) | Value::Number(_)
    ) {
        Ok(())
    } else {
        Err(refused())
    }
}
/// This surface accepts the non-attested branch only. The verified observation
/// is opaque and owns actual file/absence witnesses; a caller receipt is never
/// promoted to academic evidence or substituted for that observation.
pub fn build_native_research_evidence_intake_v1(
    paper_task: &Value,
    structured: &Value,
    verification: &NativeEvidenceArtifactVerificationObservationV1<'_>,
    now_millis: i64,
    c: &AtomicBool,
    deadline: Instant,
) -> Result<Value, String> {
    verification.verify_unchanged()?;
    let result = build_from_verified_receipts(
        paper_task,
        structured,
        verification.receipts(),
        (
            "EvidenceArtifactVerificationReceipt",
            "evidence_artifact_verified",
        ),
        now_millis,
        c,
        deadline,
    )?;
    verification.verify_unchanged()?;
    Ok(result)
}
pub(crate) fn build_native_research_cas_evidence_intake_v1(
    paper_task: &Value,
    structured: &Value,
    verification: &crate::native_research_assessment::cas::NativeCasArtifactObservationV1<'_>,
    now_millis: i64,
    c: &AtomicBool,
    deadline: Instant,
) -> Result<Value, String> {
    verification.verify_unchanged()?;
    let result = build_from_verified_receipts(
        paper_task,
        structured,
        verification.receipts(),
        (
            "NativeCasArtifactIntegrityReceipt",
            "cas_artifact_integrity_verified",
        ),
        now_millis,
        c,
        deadline,
    )?;
    verification.verify_unchanged()?;
    Ok(result)
}
fn build_from_verified_receipts(
    paper_task: &Value,
    structured: &Value,
    receipts: &[Value],
    domain: (&'static str, &'static str),
    now_millis: i64,
    c: &AtomicBool,
    deadline: Instant,
) -> Result<Value, String> {
    let (receipt_kind, verified_status) = domain;
    check_control(c, deadline)?;
    crate::sqlite_mutation_coordinator::clock::iso(now_millis).map_err(|_| refused())?;
    values_budget([paper_task, structured].into_iter().chain(receipts))?;
    let normalized = json_boundary(structured);
    let structured = &normalized;
    let evidence = structured["evidenceItems"].as_array().ok_or_else(refused)?;
    if evidence.len() > 128 {
        return Err(refused());
    }
    let mut items = Vec::new();
    let mut blockers = Vec::new();
    for (index, item) in evidence.iter().enumerate() {
        check_control(c, deadline)?;
        let object = item.as_object().ok_or_else(refused)?;
        if let Some(id) = object.get("id") {
            primitive_id(id)?;
        }
        let receipt = if let Some(id) = object.get("id") {
            receipts.iter().rev().find(|r| &r["evidenceId"] == id)
        } else {
            None
        };
        let receipt = receipt.unwrap_or(&Value::Null);
        let claim_ids = first(item, &["claimIds", "claim_ids"]);
        let refs = match &item["evidenceRefs"] {
            Value::Null => &[][..],
            Value::Array(v) => v.as_slice(),
            _ => return Err(refused()),
        };
        if refs.iter().any(Value::is_null) {
            return Err(refused());
        }
        let path = if truthy(&item["sourceLocator"]) {
            &item["sourceLocator"]
        } else {
            refs.first().map(|r| &r["ref"]).unwrap_or(&Value::Null)
        };
        let hash = refs
            .iter()
            .map(|r| &r["hash"])
            .find(|v| truthy(v))
            .unwrap_or(&Value::Null);
        projected_budget(
            items
                .iter()
                .chain(blockers.iter())
                .chain([item, receipt, path, hash, claim_ids]),
            64,
            4096,
        )?;
        let status = if truthy(&receipt["status"]) {
            &receipt["status"]
        } else {
            &Value::Null
        };
        let status = if status.is_null() {
            json!("unverified")
        } else {
            status.clone()
        };
        let verified_hash = if truthy(&receipt["verifiedHash"]) {
            &receipt["verifiedHash"]
        } else {
            &Value::Null
        };
        let provenance_hash = if truthy(&receipt["provenanceReceiptHash"]) {
            &receipt["provenanceReceiptHash"]
        } else {
            &Value::Null
        };
        let default_accepted = json!(["positive", "verified"]);
        let default_list = json!([]);
        let accepted = if truthy(&item["acceptedResultClasses"]) {
            &item["acceptedResultClasses"]
        } else {
            &default_accepted
        };
        let list = |keys: &[&str]| {
            let v = first(item, keys);
            if truthy(v) { v } else { &default_list }
        };
        let fallback = json!({"kind":receipt_kind,"status":status,"hash":provenance_hash,"createdAt":receipt["createdAt"],"claimIds":claim_ids,"path":path});
        // Reserve the complete borrowed original and every selected value
        // before the derived consumption argument copies or output clones.
        projected_budget(
            items.iter().chain(blockers.iter()).chain([
                item,
                receipt,
                path,
                hash,
                claim_ids,
                provenance_hash,
                verified_hash,
            ]),
            64,
            4096,
        )?;
        let consumption =
            crate::native_evidence_consumption::evaluate_native_evidence_consumption_v1(
                &json!({"reference":if receipt.is_null(){&fallback}else{receipt},"expected":{"kind":receipt_kind,"acceptedStatuses":[verified_status],"hash":provenance_hash},"nowMs":now_millis,"maximumAgeMs":null,"requiredOutputs":list(&["requiredOutputs"]),"availableOutputs":list(&["availableOutputs","outputs"]),"claimId":first(item,&["claimId"]),"sourceLocator":path,"resultClass":first(item,&["resultClass"]),"acceptedResultClasses":accepted,"forbiddenSideEffects":list(&["forbiddenSideEffects"]),"observedSideEffects":list(&["observedSideEffects"]),"dependencyNodes":list(&["dependencyNodes","dependencyChain"])}),
                c,
                deadline,
            )?;
        let id = if truthy(&item["id"]) {
            crate::native_research_claims::raw_string(&item["id"])?
        } else {
            format!("evidence-{}", index + 1)
        };
        let claim_string_bytes = if let Some(a) = claim_ids.as_array() {
            a.iter().try_fold(0usize, |total, v| {
                total
                    .checked_add(string_projection(v, c, deadline)?)
                    .ok_or_else(refused)
            })?
        } else {
            0
        };
        projected_budget(
            items
                .iter()
                .chain(blockers.iter())
                .chain([item, receipt, &consumption]),
            claim_ids.as_array().map_or(0, Vec::len),
            claim_string_bytes,
        )?;
        let mut claims = if let Some(a) = claim_ids.as_array() {
            a.iter()
                .map(crate::native_research_claims::raw_string)
                .collect::<Result<Vec<_>, _>>()?
        } else {
            Vec::new()
        };
        claims.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
        let provenance = first(item, &["provenance", "kind"]);
        let default_provenance = json!("candidate");
        let provenance = if truthy(provenance) {
            provenance
        } else {
            &default_provenance
        };
        projected_budget(
            items.iter().chain(blockers.iter()).chain([
                &consumption,
                path,
                hash,
                provenance,
                verified_hash,
                provenance_hash,
            ]),
            claims.len() + 16,
            id.len() + claims.iter().map(String::len).sum::<usize>(),
        )?;
        let record = json!({"evidenceId":id,"claimIds":claims,"path":path,"hash":hash,"provenance":provenance,"verificationStatus":status,"verifiedHash":verified_hash,"provenanceReceiptHash":provenance_hash,"consumptionPolicy":consumption});
        let reasons = [
            (!truthy(path), "path_required"),
            (!truthy(hash), "hash_required"),
            (status != verified_status, "verification_required"),
            (verified_hash != hash, "verified_hash_mismatch"),
            (!truthy(provenance_hash), "provenance_receipt_required"),
        ];
        for (blocked, reason) in reasons {
            if blocked {
                if id
                    .len()
                    .checked_add(reason.len())
                    .and_then(|n| n.checked_add(1))
                    .is_none_or(|n| n > 65536)
                {
                    return Err(refused());
                }
                let text = format!("{id}:{reason}");
                projected_budget(
                    items.iter().chain(blockers.iter()).chain([&record]),
                    1,
                    text.len(),
                )?;
                blockers.push(json!(text));
            }
        }
        if record["consumptionPolicy"]["status"] != "evidence_consumption_ready" {
            for reason in record["consumptionPolicy"]["blockers"]
                .as_array()
                .ok_or_else(refused)?
            {
                let reason = reason.as_str().ok_or_else(refused)?;
                if id
                    .len()
                    .checked_add(reason.len())
                    .and_then(|n| n.checked_add(1))
                    .is_none_or(|n| n > 65536)
                {
                    return Err(refused());
                }
                projected_budget(
                    items.iter().chain(blockers.iter()).chain([&record]),
                    1,
                    id.len() + reason.len() + 1,
                )?;
                blockers.push(json!(format!("{id}:{reason}")));
            }
        }
        items.push(record);
    }
    if items.is_empty() {
        blockers.push(json!("evidence_intake_empty"));
    }
    projected_budget(
        items.iter().chain(blockers.iter()).chain([paper_task]),
        16,
        512,
    )?;
    let mut payload = json!({"version":2,"kind":"EvidenceIntake","paperId":if truthy(&paper_task["paperId"]){json_boundary(&paper_task["paperId"])}else{Value::Null},"status":if blockers.is_empty(){"evidence_intake_ready"}else{"evidence_intake_blocked"},"items":items,"blockers":blockers});
    payload["evidenceIntakeHash"] = json!(hash("EvidenceIntake", &payload)?);
    check_control(c, deadline)?;
    Ok(payload)
}
