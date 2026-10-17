//! Existing contracts and claim registry composed from observed research facts.
//! These records describe an observation; they never qualify its authority.
use crate::{
    native_business::local_submission_preflight::{
        local_submission_normalize, local_submission_truthy as truthy,
        local_submission_values_budget_v1 as budget,
    },
    native_research_claims::{
        NativeResearchClaimRegistryRequestV1, build_native_research_claim_registry_v1, raw_string,
    },
    native_research_contracts::{
        NativeResearchContractBundleRequestV1, build_native_research_contract_bundle_v1,
    },
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::BTreeSet,
    path::PathBuf,
    sync::atomic::{AtomicBool, Ordering},
    time::Instant,
};
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeResearchContractContextRequestV1 {
    pub version: u16,
    pub row: Value,
    pub source_root: Option<PathBuf>,
    pub evidence_records: Vec<Value>,
    pub proposal_seed_evidence: Vec<Value>,
    pub structured: Value,
    pub native_research_worker_execution: Value,
    pub require_native_workers: bool,
}
fn refused() -> String {
    "native_research_contract_context_data_domain_v1_refused".into()
}
fn check(c: &AtomicBool, deadline: Instant) -> Result<(), String> {
    if c.load(Ordering::SeqCst) {
        Err("native_research_contract_context_cancelled".into())
    } else if Instant::now() >= deadline {
        Err("native_research_contract_context_deadline_exceeded".into())
    } else {
        Ok(())
    }
}
fn list(value: &Value) -> Result<&[Value], String> {
    if value.is_null() || !truthy(value) {
        Ok(&[])
    } else {
        value.as_array().map(Vec::as_slice).ok_or_else(refused)
    }
}
fn normalized(value: &Value) -> Result<String, String> {
    Ok(local_submission_normalize(&if value.is_null() {
        String::new()
    } else {
        raw_string(value)?
    }))
}
pub fn build_native_research_contract_context_v1(
    request: NativeResearchContractContextRequestV1,
    c: &AtomicBool,
    deadline: Instant,
) -> Result<Value, String> {
    check(c, deadline)?;
    if request.version != 1
        || request
            .source_root
            .as_ref()
            .is_some_and(|p| !p.is_absolute() || p.as_os_str().len() > 4096)
        || request.evidence_records.len() > 1024
        || request.proposal_seed_evidence.len() > 1024
    {
        return Err(refused());
    }
    budget(
        [
            &request.row,
            &request.structured,
            &request.native_research_worker_execution,
        ]
        .into_iter()
        .chain(request.evidence_records.iter())
        .chain(request.proposal_seed_evidence.iter()),
    )?;
    let structured = &request.structured;
    let paper = &request.row["task"];
    let state_refs = list(&request.row["state"]["evidenceRefs"])?;
    let mut refs = Vec::new();
    let mut seen = BTreeSet::new();
    for value in state_refs
        .iter()
        .map(|v| &v["ref"])
        .chain(request.evidence_records.iter().map(|v| &v["path"]))
    {
        check(c, deadline)?;
        let text = normalized(value)?;
        if !text.is_empty() && seen.insert(text.clone()) {
            refs.push(json!(text));
            if refs.len() == 128 {
                break;
            }
        }
    }
    let mut blockers = Vec::new();
    let mut warnings = Vec::new();
    if request.source_root.is_none() {
        blockers.push(json!("source_workspace_missing"))
    }
    if request.require_native_workers
        && request.native_research_worker_execution["status"] != "native_research_workers_verified"
    {
        blockers.push(json!("native_research_workers_required"))
    }
    for (name, status, blocker) in [
        (
            "canonicalClaimRegistry",
            "canonical_claim_registry_blocked",
            "canonical_claim_registry_required",
        ),
        (
            "canonicalEmpiricalClaimRegistry",
            "canonical_empirical_claim_registry_blocked",
            "canonical_empirical_claim_registry_required",
        ),
        (
            "canonicalEmpiricalAssertionUniverse",
            "canonical_empirical_assertion_universe_blocked",
            "canonical_empirical_assertion_universe_required",
        ),
    ] {
        if structured[name]["status"] == status {
            blockers.push(json!(blocker));
            let extra = list(&structured[name]["blockers"])?;
            budget(blockers.iter().chain(extra))?;
            blockers.extend_from_slice(extra);
        }
    }
    if refs.is_empty() {
        warnings.push(json!("claim_evidence_not_found"))
    }
    if !request.proposal_seed_evidence.is_empty() {
        warnings.push(json!(
            "proposal_seed_contracts_require_real_evidence_followup"
        ))
    }
    let claims = list(&structured["claims"])?;
    let obligations = list(&structured["obligations"])?;
    let evidence = list(&structured["evidenceItems"])?;
    let repro = list(&structured["reproducibilityItems"])?;
    // This admission precedes every clone into the existing owned kernel APIs.
    budget(
        [paper]
            .into_iter()
            .chain(claims)
            .chain(obligations)
            .chain(evidence)
            .chain(repro)
            .chain(&refs)
            .chain(&blockers)
            .chain(&warnings),
    )?;
    let repro_refs = refs
        .iter()
        .filter(|value| {
            value.as_str().is_some_and(|text| {
                let text = text.to_ascii_lowercase();
                [
                    "reproduc", "result", "seed", "checksum", "sha256", "command", "run",
                ]
                .iter()
                .any(|word| text.contains(word))
            })
        })
        .cloned()
        .collect::<Vec<_>>();
    let mut bundle = build_native_research_contract_bundle_v1(
        NativeResearchContractBundleRequestV1 {
            version: 1,
            paper_task: paper.clone(),
            claims: claims.to_vec(),
            obligations: obligations.to_vec(),
            evidence_items: evidence.to_vec(),
            reproducibility_items: repro.to_vec(),
            evidence_refs: refs.clone(),
            reproducibility_evidence_refs: repro_refs,
            claim_scope_blockers: blockers.clone(),
            receipt_blockers: Vec::new(),
            receipt_warnings: Vec::new(),
            created_at: None,
        },
        c,
    )?;
    check(c, deadline)?;
    let registry = build_native_research_claim_registry_v1(
        NativeResearchClaimRegistryRequestV1 {
            version: 1,
            paper_task: paper.clone(),
            claims: claims.to_vec(),
        },
        c,
    )?;
    check(c, deadline)?;
    let object = bundle.as_object_mut().ok_or_else(refused)?;
    object.remove("verifyReceipt");
    budget(
        object
            .values()
            .chain([&registry])
            .chain(refs.iter())
            .chain(blockers.iter())
            .chain(warnings.iter()),
    )?;
    object.insert("evidenceRefs".into(), Value::Array(refs));
    object.insert("blockers".into(), Value::Array(blockers));
    object.insert("warnings".into(), Value::Array(warnings));
    object.insert("claimRegistry".into(), registry);
    check(c, deadline)?;
    Ok(bundle)
}
#[cfg(test)]
mod tests;
