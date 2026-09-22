use super::{Result, collect::Observation, qualification, value::*};
use serde_json::{Value, json};
use std::collections::BTreeSet;

pub(super) fn evaluate(observation: &Observation, now: i64) -> Result<Value> {
    let null = Value::Null;
    let configuration = observation
        .configuration
        .as_ref()
        .map_or(&null, |value| &value.identity);
    let inspection = &observation.configuration_inspection;
    let pointer = observation.pointer.as_ref().unwrap_or(&null);
    let receipt = &pointer["receipt"];
    let state = observation.state.as_ref().unwrap_or(&null);
    let runtime = observation.runtime.as_ref().unwrap_or(&null);
    let code = observation.code.as_ref().unwrap_or(&null);
    let recovery = &observation.recovery;
    let mut infrastructure = observation.infrastructure_input_blockers.clone();
    let mut global = observation.global_input_blockers.clone();
    if !qualification::configuration_matches(observation.configuration.as_ref(), inspection)? {
        infrastructure.push(
            "autonomous_research_external_qualification_v3_configuration_not_ready".to_owned(),
        );
    }
    if !qualification::receipt_valid_from_pointer(observation.pointer.as_ref())? {
        global.push("autonomous_research_full_qualification_pointer_not_ready".to_owned());
    }
    if !qualification::state_matches(state, pointer, configuration)? {
        global.push("autonomous_research_full_qualification_state_configuration_drift".to_owned());
    }
    if !qualification::receipt_current(receipt, now) {
        global.push("autonomous_research_full_qualification_receipt_not_current".to_owned());
    }
    if !qualification::code_matches(&receipt["codeProvenance"], code) {
        global.push("autonomous_research_full_qualification_code_identity_mismatch".to_owned());
    }
    if !qualification::signer_matches(configuration, receipt, now)
        || !qualification::signature_valid(observation.configuration.as_ref(), receipt)?
    {
        global
            .push("autonomous_research_full_qualification_signature_or_trust_mismatch".to_owned());
    }
    let runtime_inspection = &runtime["inspection"];
    let runtime_configuration = &runtime["configuration"];
    if runtime_configuration["ready"] != true
        || !sha(&runtime_configuration["configurationIdentityHash"])
        || !sha(&runtime_configuration["trustIdentityHash"])
        || !number(&runtime_configuration["maximumVerificationCostUsd"])
            .is_some_and(|value| value.is_finite() && value >= 0.0)
        || !runtime_configuration["verificationCostAuthority"]
            .as_str()
            .is_some_and(|value| !value.is_empty())
    {
        infrastructure
            .push("autonomous_research_runtime_reproducibility_configuration_not_ready".to_owned());
    }
    if runtime["ready"] != true
        || runtime_inspection["ready"] != true
        || runtime_inspection["receiptAccepted"] != true
        || !sha(&runtime_inspection["receiptHash"])
        || !strict_equal(
            &runtime_inspection["receiptHash"],
            &receipt["runtimeImageReproducibilityReceiptHash"],
        )
        || !canonical(&runtime_inspection["expiresAt"]).is_some_and(|expiry| now < expiry)
    {
        global.push("autonomous_research_runtime_reproducibility_receipt_not_current".to_owned());
    }
    if code["version"].as_f64() != Some(2.0) || !sha(&code["worktreeStateHash"]) {
        infrastructure.push("autonomous_research_current_code_identity_unavailable".to_owned());
    }
    if recovery["ready"] != true
        || recovery["signedCapabilityVerified"] != true
        || !sha(&recovery["configurationIdentityHash"])
    {
        // Actual recovery producer emits only string/null blockers. Original
        // final string filtering would discard an exotic nonstring blocker.
        let blocker = if truthy(&recovery["blocker"]) {
            recovery["blocker"].clone()
        } else {
            json!("autonomous_research_supervisor_external_action_recovery_required")
        };
        if let Some(blocker) = blocker.as_str().filter(|value| !value.is_empty()) {
            infrastructure.push(blocker.to_owned());
        }
    }
    let infrastructure = unique(infrastructure);
    let global = unique(global);
    let blockers = unique(
        infrastructure
            .iter()
            .chain(global.iter())
            .cloned()
            .collect(),
    );
    let prerequisite_identity = json!({
        "externalQualificationConfigurationInspectionHash":or_null(&inspection["externalResearchQualificationProcessConfigurationInspectionHash"]),
        "externalQualificationConfigurationIdentityHash":or_null(&inspection["configurationIdentityHash"]),
        "externalQualificationTrustIdentityHash":or_null(&inspection["trustIdentityHash"]),
        "externalQualificationMaximumCostUsd":inspection["maximumQualificationCostUsd"],
        "externalQualificationCostAuthority":or_null(&inspection["qualificationCostAuthority"]),
        "runtimeImageReproducibilityConfigurationIdentityHash":or_null(&runtime_configuration["configurationIdentityHash"]),
        "runtimeImageReproducibilityTrustIdentityHash":or_null(&runtime_configuration["trustIdentityHash"]),
        "externalActionRecoveryConfigurationIdentityHash":or_null(&recovery["configurationIdentityHash"]),
        "codeWorktreeStateHash":or_null(&code["worktreeStateHash"]),
    });
    let infrastructure_ready = infrastructure.is_empty();
    let global_ready = global.is_empty();
    let mut payload = prerequisite_identity.clone();
    let Some(object) = payload.as_object_mut() else {
        return Err(super::Error::new(
            "autonomous_research_resident_json_profile_unsupported",
        ));
    };
    let report = json!({
        "version":1,"kind":"AutonomousResearchResidentPrerequisiteReceipt",
        "status":if !infrastructure_ready { "autonomous_research_resident_infrastructure_blocked" }
            else if global_ready { "autonomous_research_resident_prerequisites_ready" }
            else { "autonomous_research_resident_bootstrap_only" },
        "ready":infrastructure_ready && global_ready,"infrastructureReady":infrastructure_ready,"globalQualificationReady":global_ready,
        "operationMode":if !infrastructure_ready { "blocked" } else if global_ready { "full" } else { "bootstrap-only" },
        "inspectedAt":observation.inspected_at,
        "autonomousResearchResidentPrerequisiteIdentityHash":hash("AutonomousResearchResidentPrerequisiteIdentity", &prerequisite_identity)?,
        "zeroCostAuthorityEvidenceScope":if inspection["qualificationCostAuthority"] == "externally_operated_zero_cost" {
            json!("trusted_operator_assertion_not_external_billing_proof") } else { Value::Null },
        "fullResearchQualificationExpiresAt":if canonical(&receipt["expiresAt"]).is_some() { receipt["expiresAt"].clone() } else { Value::Null },
        "runtimeImageReproducibilityExpiresAt":if canonical(&runtime_inspection["expiresAt"]).is_some() { runtime_inspection["expiresAt"].clone() } else { Value::Null },
        "externalActionPerformed":false,"networkActionPerformed":false,"providerCanaryPerformed":false,"releaseSignerChallengePerformed":false,
        "infrastructureBlockers":infrastructure,"globalQualificationBlockers":global,"blockers":blockers,
    });
    if let Some(report) = report.as_object() {
        object.extend(report.clone());
    }
    let digest = hash("AutonomousResearchResidentPrerequisiteReceipt", &payload)?;
    payload["autonomousResearchResidentPrerequisiteReceiptHash"] = json!(digest);
    Ok(payload)
}
fn unique(values: Vec<String>) -> Vec<String> {
    let mut seen = BTreeSet::new();
    values
        .into_iter()
        .filter(|value| !value.is_empty() && seen.insert(value.clone()))
        .collect()
}
