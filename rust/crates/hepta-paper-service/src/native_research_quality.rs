//! Quality coverage of internally observed, non-attested evidence. Trusted
//! worker/formal/experiment authority is deliberately outside this typed domain.
use crate::{
    native_business::local_submission_preflight::{
        local_submission_projected_values_budget_v1 as reserve, local_submission_truthy as truthy,
    },
    native_research_claims::{
        evaluate_native_claim_contract_readiness_v1, json_boundary, raw_string,
    },
    native_research_evidence::NativeResearchObservedInputsObservationV1,
};
use serde_json::{Value, json};
use std::{
    collections::BTreeSet,
    sync::atomic::{AtomicBool, Ordering},
    time::Instant,
};

fn refused() -> String {
    "native_research_nonattested_quality_data_domain_v1_refused".into()
}
fn check(c: &AtomicBool, deadline: Instant) -> Result<(), String> {
    if c.load(Ordering::SeqCst) {
        Err("native_research_quality_cancelled".into())
    } else if Instant::now() >= deadline {
        Err("native_research_quality_deadline_exceeded".into())
    } else {
        Ok(())
    }
}
fn nullable(v: &Value) -> Value {
    if truthy(v) {
        json_boundary(v)
    } else {
        Value::Null
    }
}
fn list(v: &Value) -> Result<&[Value], String> {
    if !truthy(v) {
        Ok(&[])
    } else {
        v.as_array().map(Vec::as_slice).ok_or_else(refused)
    }
}
fn or<'a>(v: &'a Value, names: &[&str]) -> &'a Value {
    names
        .iter()
        .map(|name| &v[*name])
        .find(|v| truthy(v))
        .unwrap_or(&Value::Null)
}
/// Caller Values cannot supply verified evidence or authority. The intake is
/// derived only from the opaque, held observation and rechecked at both ends.
pub(crate) fn build_native_nonattested_evidence_quality_gate_v1(
    paper_task: &Value,
    registry: &Value,
    observed: &NativeResearchObservedInputsObservationV1<'_>,
    c: &AtomicBool,
    deadline: Instant,
) -> Result<Value, String> {
    check(c, deadline)?;
    observed.verify_unchanged()?;
    if observed.paper_task_binding_v1()
        != &NativeResearchObservedInputsObservationV1::derive_paper_task_binding_v1(paper_task)?
    {
        return Err(refused());
    }
    let output = quality_from_observed_intake(
        paper_task,
        registry,
        &observed.observed()["evidenceIntake"],
        c,
        deadline,
    )?;
    observed.verify_unchanged()?;
    check(c, deadline)?;
    Ok(output)
}
fn quality_from_observed_intake(
    task: &Value,
    registry: &Value,
    intake: &Value,
    c: &AtomicBool,
    deadline: Instant,
) -> Result<Value, String> {
    quality_from_integrity_intake(
        task,
        registry,
        intake,
        "evidence_artifact_verified",
        c,
        deadline,
    )
}
pub(crate) fn quality_from_cas_intake(
    task: &Value,
    registry: &Value,
    intake: &Value,
    verification: &crate::native_research_assessment::cas::NativeCasArtifactObservationV1<'_>,
    c: &AtomicBool,
    deadline: Instant,
) -> Result<Value, String> {
    verification.verify_unchanged()?;
    let result = quality_from_integrity_intake(
        task,
        registry,
        intake,
        "cas_artifact_integrity_verified",
        c,
        deadline,
    )?;
    verification.verify_unchanged()?;
    Ok(result)
}
fn quality_from_integrity_intake(
    task: &Value,
    registry: &Value,
    intake: &Value,
    verified_status: &'static str,
    c: &AtomicBool,
    deadline: Instant,
) -> Result<Value, String> {
    check(c, deadline)?;
    reserve([task, registry, intake], 0, 0)?;
    let readiness = evaluate_native_claim_contract_readiness_v1(registry, c, deadline)?;
    let claims = list(&registry["claims"])?;
    // The normal no-authority preview has no current formal closure. These are
    // the original structural rejection reasons, not forged verification flags.
    let closure = json!({"valid":false,"status":"native_formal_research_closure_binding_blocked","binding":null,"receipt":null,"blockers":[
      "native_formal_execution_report_invalid","native_formal_current_closure_context_invalid",
      "native_formal_execution_receipt_invalid","native_formal_replay_invalid",
      "native_formal_claim_binding_report_invalid","native_formal_closure_binding_invalid"]});
    let mut evidence_claims = Vec::new();
    let mut seen_evidence = BTreeSet::new();
    for item in list(&intake["items"])? {
        check(c, deadline)?;
        if item["verificationStatus"] == verified_status
            && item["verifiedHash"] == item["hash"]
            && truthy(&item["provenanceReceiptHash"])
            && item["consumptionPolicy"]["status"] == "evidence_consumption_ready"
        {
            for id in list(&item["claimIds"])? {
                check(c, deadline)?;
                let id = id.as_str().ok_or_else(refused)?;
                if seen_evidence.insert(id) {
                    evidence_claims.push(id);
                }
            }
        }
    }
    let mut coverage = Vec::new();
    let mut covered = Vec::new();
    let mut missing = Vec::new();
    let mut registered = BTreeSet::new();
    for claim in claims {
        check(c, deadline)?;
        let id = claim["claimId"].as_str().ok_or_else(refused)?;
        registered.insert(id);
        let kind = or(&claim["verificationPlan"], &["kind", "type"]);
        let kind = if truthy(kind) {
            kind
        } else {
            or(claim, &["claimKind", "riskClass"])
        };
        // Exact legacy lowercase outside ASCII is not asserted by this v1
        // composition. Reject before conversion rather than returning drift.
        let kind_bytes = match kind {
            Value::String(s) => s.len(),
            Value::Null => 0,
            Value::Bool(_) | Value::Number(_) => 32,
            _ => return Err(refused()),
        };
        reserve(
            [task, registry, intake, &readiness, &closure]
                .into_iter()
                .chain(&coverage)
                .chain(&covered)
                .chain(&missing),
            24,
            id.len()
                .saturating_mul(3)
                .saturating_add(kind_bytes)
                .saturating_add(256),
        )?;
        let kind = if kind.is_null() {
            String::new()
        } else {
            raw_string(kind)?
        };
        if !kind.is_ascii() {
            return Err(refused());
        }
        let kind = kind.to_ascii_lowercase();
        let formal = ["formal", "proof", "theorem"]
            .iter()
            .any(|word| kind.contains(word));
        let experiment = ["experiment", "empirical", "reproduc"]
            .iter()
            .any(|word| kind.contains(word));
        let worker = claim["verificationPlan"]["requiresWorker"] == true || formal;
        let evidence = claim["verificationPlan"]["requiresEvidence"] != false;
        let verified = evidence_claims.contains(&id);
        let is_covered = !worker && !formal && !experiment && (!evidence || verified);
        coverage.push(json!({"claimId":id,"verificationKind":if kind.is_empty(){"evidence"}else{&kind},"workerRequired":worker,"evidenceRequired":evidence,"workerVerified":false,"evidenceVerified":verified,"formalCertificateRequired":formal,"experimentBindingRequired":experiment,"formalCertificateVerified":false,"experimentBindingVerified":false,"covered":is_covered}));
        if is_covered {
            covered.push(json!(id));
        } else {
            missing.push(json!(id));
        }
    }
    let unregistered = evidence_claims
        .into_iter()
        .filter(|id| !registered.contains(id))
        .collect::<Vec<_>>();
    let required = claims
        .iter()
        .any(|v| v["verificationPlan"]["requiresEvidence"] != false);
    let mut blockers = Vec::new();
    let add = |blockers: &mut Vec<Value>, text: &str| -> Result<(), String> {
        check(c, deadline)?;
        reserve(
            [task, registry, intake, &readiness, &closure]
                .into_iter()
                .chain(&coverage)
                .chain(&covered)
                .chain(&missing)
                .chain(blockers.iter()),
            1,
            text.len(),
        )?;
        if !blockers.iter().any(|v| v.as_str() == Some(text)) {
            blockers.push(json!(text));
        }
        Ok(())
    };
    if registry["status"] != "claim_graph_valid" {
        add(&mut blockers, "claim_graph_not_valid")?;
    }
    if readiness["status"] != "claim_contract_readiness_ready" {
        for text in list(&readiness["blockers"])? {
            add(&mut blockers, text.as_str().ok_or_else(refused)?)?;
        }
    }
    if required && intake["status"] != "evidence_intake_ready" {
        add(&mut blockers, "evidence_intake_not_verified")?;
    }
    for (prefix, id) in missing
        .iter()
        .map(|id| ("claim_evidence_coverage_missing:", id.as_str()))
        .chain(
            unregistered
                .iter()
                .map(|id| ("evidence_claim_not_registered_in_manuscript:", Some(*id))),
        )
    {
        check(c, deadline)?;
        let id = id.ok_or_else(refused)?;
        let bytes = prefix
            .len()
            .checked_add(id.len())
            .filter(|v| *v <= 65536)
            .ok_or_else(refused)?;
        reserve(
            [task, registry, intake, &readiness, &closure]
                .into_iter()
                .chain(&coverage)
                .chain(&covered)
                .chain(&missing)
                .chain(blockers.iter()),
            1,
            bytes,
        )?;
        add(&mut blockers, &format!("{prefix}{id}"))?;
    }
    reserve(
        [task, registry, intake, &readiness, &closure]
            .into_iter()
            .chain(&coverage)
            .chain(&covered)
            .chain(&missing)
            .chain(blockers.iter()),
        unregistered.len() + 64,
        2048,
    )?;
    let mut record = json!({"version":7,"kind":"EvidenceQualityGate","paperId":nullable(&task["paperId"]),"campaignId":null,"researchSourceSnapshotHash":null,"status":if blockers.is_empty(){"evidence_quality_ready"}else{"evidence_quality_blocked"},"evidenceIntakeRequired":required,"claimContractReadiness":readiness,"claimCoverageResults":coverage,"coveredClaimIds":covered,"missingClaimIds":missing,"unregisteredWorkerClaimIds":[],"unregisteredExperimentClaimIds":[],"unregisteredEvidenceClaimIds":unregistered,"workerLedgerVerifications":[],"nativeFormalClosureVerification":closure,"formalCertificateIntakeClosureVerifications":[],"verifiedNativeFormalClaimIds":[],"verifiedFormalClaimIds":[],"verifiedFormalCertificateIntakeHashes":[],"verifiedExperimentClaimIds":[],"blockers":blockers});
    let hash =
        hepta_legacy_compatibility::production_hash_record_v1("EvidenceQualityGate", &record)
            .map_err(|_| refused())?;
    record["evidenceQualityGateHash"] = json!(hash.as_str());
    check(c, deadline)?;
    Ok(record)
}
#[cfg(test)]
pub(crate) mod tests;
