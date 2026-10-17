//! Derived paper research contracts. Records themselves confer no authority.
use crate::native_business::local_submission_preflight::{
    local_submission_hashed, local_submission_normalize, local_submission_truthy,
    local_submission_unique, local_submission_values_budget_v1,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::sync::atomic::{AtomicBool, Ordering};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeResearchContractBundleRequestV1 {
    pub version: u16,
    pub paper_task: Value,
    pub claims: Vec<Value>,
    pub obligations: Vec<Value>,
    pub evidence_items: Vec<Value>,
    pub reproducibility_items: Vec<Value>,
    pub evidence_refs: Vec<Value>,
    pub reproducibility_evidence_refs: Vec<Value>,
    pub claim_scope_blockers: Vec<Value>,
    pub receipt_blockers: Vec<Value>,
    pub receipt_warnings: Vec<Value>,
    pub created_at: Option<Value>,
}
fn refused() -> String {
    "native_research_contract_data_domain_v1_refused".into()
}
fn check(cancelled: &AtomicBool) -> Result<(), String> {
    if cancelled.load(Ordering::SeqCst) {
        Err("native_research_contract_cancelled".into())
    } else {
        Ok(())
    }
}
fn or<'a>(value: &'a Value, fields: &[&str]) -> &'a Value {
    fields
        .iter()
        .map(|key| &value[*key])
        .find(|v| local_submission_truthy(v))
        .unwrap_or(&Value::Null)
}
fn text(value: &Value) -> Result<String, String> {
    fn coercion(value: &Value) -> bool {
        match value {
            Value::Object(o) => o.contains_key("toString") || o.contains_key("valueOf"),
            Value::Array(a) => a.iter().any(coercion),
            _ => false,
        }
    }
    if coercion(value) {
        return Err(refused());
    }
    if value.is_null() {
        return Ok(String::new());
    }
    Ok(local_submission_normalize(
        &crate::release_state::javascript_string(value),
    ))
}
fn sequence(value: &Value) -> Result<&[Value], String> {
    match value {
        Value::Null | Value::Bool(false) => Ok(&[]),
        Value::Array(a) => Ok(a),
        _ => Err(refused()),
    }
}
fn refs(values: &[Value], cancelled: &AtomicBool) -> Result<Vec<Value>, String> {
    let mut out = Vec::new();
    for value in values {
        check(cancelled)?;
        let item = if value.is_string() {
            json!({"kind":"path","ref":text(value)?})
        } else {
            let kind = text(or(value, &["kind"]))?;
            let hash = text(or(value, &["hash"]))?;
            let notes = text(or(value, &["notes"]))?;
            json!({"kind":if kind.is_empty(){"path"}else{&kind},"ref":text(or(value,&["ref","path","url","id"]))?,"hash":if hash.is_empty(){Value::Null}else{json!(hash)},"notes":if notes.is_empty(){Value::Null}else{json!(notes)}})
        };
        if item["ref"].as_str().is_some_and(|s| !s.is_empty()) {
            out.push(item);
        }
    }
    Ok(out)
}
fn unique(values: &[Value], maximum: usize) -> Result<Vec<String>, String> {
    Ok(local_submission_unique(
        values.iter().map(text).collect::<Result<Vec<_>, _>>()?,
        maximum,
    ))
}
fn items(
    values: &[Value],
    prefix: &str,
    maximum: usize,
    cancelled: &AtomicBool,
) -> Result<Vec<Value>, String> {
    let mut out = Vec::new();
    for (i, v) in values.iter().take(maximum).enumerate() {
        check(cancelled)?;
        let fallback = format!("{prefix}:{}", i + 1);
        let item = if v.is_string() {
            json!({"id":fallback,"text":text(v)?,"status":"observed","evidenceRefs":[]})
        } else {
            let id = text(or(v, &["id", "key", "claim_id", "obligation_id"]))?;
            let status = text(or(v, &["status", "state"]))?;
            let kind = text(or(v, &["kind", "type"]))?;
            let locator = text(or(v, &["sourceLocator", "source_locator", "locator"]))?;
            json!({"id":if id.is_empty(){&fallback}else{&id},"text":text(or(v,&["text","claim","obligation","description"]))?,"status":if status.is_empty(){"observed"}else{&status},"kind":if kind.is_empty(){Value::Null}else{json!(kind)},"evidenceRefs":refs(sequence(or(v,&["evidenceRefs","evidence_refs","evidence"]))?,cancelled)?,"sourceLocator":if locator.is_empty(){Value::Null}else{json!(locator)}})
        };
        if local_submission_truthy(&item["text"])
            || local_submission_truthy(&item["sourceLocator"])
            || item["evidenceRefs"]
                .as_array()
                .is_some_and(|a| !a.is_empty())
        {
            out.push(item);
        }
    }
    Ok(out)
}
fn contract(
    request: &NativeResearchContractBundleRequestV1,
    index: usize,
    cancelled: &AtomicBool,
) -> Result<Value, String> {
    let (
        kind,
        field,
        count_field,
        hash_field,
        prefix,
        maximum,
        values,
        empty_warning,
        present,
        missing,
        blocked,
    ) = match index {
        0 => (
            "ClaimScopeContract",
            "claims",
            "claimCount",
            "claimScopeContractHash",
            "claim",
            96,
            &request.claims,
            "claim_scope_requires_manual_extraction",
            "claim_scope_detected",
            "manual_claim_scope_needed",
            "blocked_claim_scope",
        ),
        1 => (
            "ProofObligationContract",
            "obligations",
            "proofObligationCount",
            "proofObligationContractHash",
            "proof",
            96,
            &request.obligations,
            "proof_obligations_require_manual_review",
            "proof_obligations_detected",
            "manual_proof_review_needed",
            "blocked_proof_obligations",
        ),
        2 => (
            "EvidenceMatrixContract",
            "evidenceItems",
            "evidenceItemCount",
            "evidenceMatrixContractHash",
            "evidence",
            160,
            &request.evidence_items,
            "evidence_matrix_empty",
            "evidence_matrix_present",
            "manual_evidence_review_needed",
            "blocked_evidence_matrix",
        ),
        3 => (
            "ReproducibilityContract",
            "artifacts",
            "reproducibilityItemCount",
            "reproducibilityContractHash",
            "repro",
            96,
            &request.reproducibility_items,
            "reproducibility_contract_requires_manual_review",
            "reproducibility_evidence_present",
            "manual_reproducibility_review_needed",
            "blocked_reproducibility",
        ),
        _ => return Err(refused()),
    };
    let normalized = items(
        values,
        &format!(
            "{}:{prefix}",
            request.paper_task["paperId"].as_str().ok_or_else(refused)?
        ),
        maximum,
        cancelled,
    )?;
    let has_evidence = index == 2 && !request.evidence_refs.is_empty();
    let warnings = if normalized.is_empty() && !has_evidence {
        vec![empty_warning]
    } else {
        Vec::new()
    };
    let blockers = if index == 0 {
        unique(&request.claim_scope_blockers, 32)?
    } else {
        Vec::new()
    };
    // The original status inspects the original blocker-array length before
    // normalization. Empty and duplicate strings cannot erase that observation.
    let has_blockers = index == 0 && !request.claim_scope_blockers.is_empty();
    let mut value = json!({"version":1,"kind":kind,"taskKey":request.paper_task["taskKey"],"paperId":request.paper_task["paperId"],"status":if has_blockers{blocked}else if !normalized.is_empty()||has_evidence{present}else{missing},count_field:normalized.len(),field:normalized,"evidenceRefs":refs(if index==3{&request.reproducibility_evidence_refs}else{&request.evidence_refs},cancelled)?,"blockers":blockers,"warnings":warnings,"safety":{"readsOnly":true,"sourceMutation":false,"externalActionPerformed":false},"createdAt":request.created_at.as_ref().filter(|v|local_submission_truthy(v))});
    if index == 1 {
        value["safety"]["claimsMachineCheckedProof"] = json!(false);
    }
    local_submission_hashed(value, hash_field, true)
}
/// Build all four original contracts and their receipt from actual derived
/// inputs; callers cannot supply precomputed contract hashes or report counts.
pub fn build_native_research_contract_bundle_v1(
    request: NativeResearchContractBundleRequestV1,
    cancelled: &AtomicBool,
) -> Result<Value, String> {
    check(cancelled)?;
    if request.version != 1
        || ["paperId", "taskKey"].iter().any(|key| {
            request.paper_task[*key]
                .as_str()
                .is_none_or(|s| s.is_empty() || s.len() > 256)
        })
    {
        return Err(refused());
    }
    let lists = [
        &request.claims,
        &request.obligations,
        &request.evidence_items,
        &request.reproducibility_items,
        &request.evidence_refs,
        &request.reproducibility_evidence_refs,
        &request.claim_scope_blockers,
        &request.receipt_blockers,
        &request.receipt_warnings,
    ];
    if lists.iter().any(|values| values.len() > 1024) {
        return Err(refused());
    }
    local_submission_values_budget_v1(
        std::iter::once(&request.paper_task)
            .chain(request.created_at.iter())
            .chain(lists.into_iter().flat_map(|values| values.iter())),
    )?;
    let c = contract(&request, 0, cancelled)?;
    let p = contract(&request, 1, cancelled)?;
    let e = contract(&request, 2, cancelled)?;
    let r = contract(&request, 3, cancelled)?;
    let mut blockers = request.receipt_blockers.clone();
    for record in [&c, &p, &e, &r] {
        blockers.extend(
            record["blockers"]
                .as_array()
                .ok_or_else(refused)?
                .iter()
                .cloned(),
        );
    }
    let mut warnings = request.receipt_warnings.clone();
    for record in [&c, &p, &e, &r] {
        warnings.extend(
            record["warnings"]
                .as_array()
                .ok_or_else(refused)?
                .iter()
                .cloned(),
        );
    }
    let evidence_refs = refs(&request.evidence_refs, cancelled)?;
    let count = evidence_refs.len()
        + e["evidenceItemCount"].as_u64().ok_or_else(refused)? as usize
        + r["reproducibilityItemCount"].as_u64().ok_or_else(refused)? as usize;
    let receipt = json!({"version":1,"kind":"PaperResearchVerifyReceipt","taskKey":request.paper_task["taskKey"],"paperId":request.paper_task["paperId"],"status":if !blockers.is_empty(){"blocked"}else if count>0{"evidence_present"}else{"manual_review_needed"},"typedContracts":{"claimScopeContractHash":c["claimScopeContractHash"],"proofObligationContractHash":p["proofObligationContractHash"],"evidenceMatrixContractHash":e["evidenceMatrixContractHash"],"reproducibilityContractHash":r["reproducibilityContractHash"],"legacyCatalogReferenceHashes":[]},"observedEvidenceCount":count,"evidenceRefs":evidence_refs,"blockers":unique(&blockers,32)?,"warnings":unique(&warnings,64)?,"safety":{"readsOnly":true,"sourceMutation":false,"externalActionPerformed":false,"claimsMachineCheckedProof":false},"createdAt":request.created_at.as_ref().filter(|v|local_submission_truthy(v))});
    let receipt = local_submission_hashed(receipt, "researchVerifyReceiptHash", true)?;
    check(cancelled)?;
    Ok(
        json!({"claimScopeContract":c,"proofObligationContract":p,"evidenceMatrixContract":e,"reproducibilityContract":r,"verifyReceipt":receipt}),
    )
}

#[cfg(test)]
mod tests;
