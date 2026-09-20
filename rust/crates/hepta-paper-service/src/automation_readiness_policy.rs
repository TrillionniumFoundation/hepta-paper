//! Pure Rust projection of the incumbent automation-readiness policy.
//!
//! This module deliberately accepts already-observed JSON values.  It does not
//! inspect a store, probe a runtime, contact a provider or release attestor,
//! read deployment configuration, or grant production authority.  The
//! composition layer that obtains those observations remains a separate
//! migration boundary.  Keeping this evaluator pure lets the Rust policy be
//! differentially tested without making a synthetic report look like a live
//! automation-status result.

#![forbid(unsafe_code)]

use serde_json::{Map, Value, json};

const SHA256_PREFIX: &str = "sha256:";

fn object(value: &Value) -> Option<&Map<String, Value>> {
    value.as_object()
}

fn field<'a>(value: &'a Value, key: &str) -> &'a Value {
    object(value)
        .and_then(|value| value.get(key))
        .unwrap_or(&Value::Null)
}

fn is_true(value: &Value) -> bool {
    value == &Value::Bool(true)
}

/// JavaScript truthiness for JSON values.  The incumbent policy uses
/// `value || fallback` and `filter(Boolean)` in its result construction.
fn js_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::Number(value) => value.as_f64().is_some_and(|value| value != 0.0),
        Value::String(value) => !value.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// The string conversion used by JavaScript's regular-expression `test`.
/// Normal production reports contain strings; the extra cases preserve the
/// incumbent coercion for malformed diagnostic values before the policy
/// rejects them through its boolean gates.
fn js_string(value: &Value) -> String {
    match value {
        Value::Null => "null".to_owned(),
        Value::Bool(value) => value.to_string(),
        Value::Number(value) => value.to_string(),
        Value::String(value) => value.clone(),
        Value::Array(values) => values
            .iter()
            .map(|value| {
                if value.is_null() {
                    String::new()
                } else {
                    js_string(value)
                }
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".to_owned(),
    }
}

fn sha256(value: &Value) -> bool {
    let value = js_string(value);
    let Some((prefix, hex)) = value.split_once(':') else {
        return false;
    };
    prefix.eq_ignore_ascii_case(SHA256_PREFIX.trim_end_matches(':'))
        && hex.len() == 64
        && hex.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn array(value: &Value) -> Option<&[Value]> {
    value.as_array().map(Vec::as_slice)
}

fn usable(value: &Value) -> bool {
    is_true(field(value, "usable"))
}

fn hashes_ready(value: &Value, key: &str) -> bool {
    let Some(values) = array(field(value, key)) else {
        return false;
    };
    !values.is_empty() && values.iter().all(sha256)
}

fn reason(value: &Value) -> Value {
    let candidate = field(value, "academicEmpiricalReadinessReason");
    if js_truthy(candidate) {
        candidate.clone()
    } else {
        json!("academic_empirical_readiness_not_reported")
    }
}

/// The Node helper keeps first occurrence order while filtering JavaScript
/// falsy values.  Blockers in the production protocol are strings; retaining
/// JSON values here also preserves the incumbent diagnostic behavior for
/// malformed inputs instead of silently rewriting them.
fn unique_truthy(values: impl IntoIterator<Item = Value>) -> Vec<Value> {
    let mut result = Vec::new();
    for value in values {
        if !js_truthy(&value) {
            continue;
        }
        // JSON reports use string blockers.  For scalar values, this is the
        // same equality relation as Set; object/array blockers are malformed
        // inputs and are retained by Node because each parsed value is a
        // distinct object identity.
        let duplicate = match &value {
            Value::Null => false,
            Value::Bool(_) | Value::Number(_) | Value::String(_) => {
                result.iter().any(|existing| existing == &value)
            }
            Value::Array(_) | Value::Object(_) => false,
        };
        if !duplicate {
            result.push(value);
        }
    }
    result
}

fn spread_values(value: &Value) -> Vec<Value> {
    match value {
        Value::Array(values) => values.clone(),
        // JavaScript's string iterator yields Unicode scalar values.  This is
        // only a malformed-input compatibility path; valid reports use arrays.
        Value::String(value) => value
            .chars()
            .map(|character| Value::String(character.to_string()))
            .collect(),
        _ => Vec::new(),
    }
}

/// Port of `evaluateAutomationReadiness` from
/// `paper-application/automation/automation-readiness-policy.mjs`.
///
/// The result is descriptive only.  It must not be interpreted as an
/// observation until a composition boundary has populated the input from
/// trusted local or external evidence.
#[must_use]
pub fn evaluate_automation_readiness_v1(input: &Value) -> Value {
    let runtimes = field(input, "runtimes");
    let agent = field(runtimes, "agent");
    let sandbox = field(runtimes, "sandbox");
    let images = field(runtimes, "images");

    let automation_runtime_ready = usable(agent)
        && usable(field(runtimes, "python"))
        && usable(field(runtimes, "latex"))
        && usable(sandbox);
    let academic_empirical_ready = is_true(field(sandbox, "academicEmpiricalReady"));
    let academic_empirical_readiness_reason = reason(sandbox);
    let gpu_scientific_runtime_ready = usable(field(runtimes, "gpu"))
        && usable(field(runtimes, "gpuContainer"))
        && usable(field(images, "pythonGpu"));
    let gpu_proofs = field(input, "gpuScientificCapabilityProofInspection");
    let capabilities = field(gpu_proofs, "capabilities");
    let pde = field(capabilities, "pde");
    let deep_learning = field(capabilities, "deepLearning");
    let gpu_pde_operational_proof_ready = is_true(field(pde, "operationalProofReady"))
        && hashes_ready(pde, "operationalReceiptHashes");
    let gpu_pde_production_qualification_ready =
        is_true(field(pde, "productionQualificationReady"))
            && hashes_ready(pde, "conformanceReceiptHashes");
    let gpu_deep_learning_operational_proof_ready =
        is_true(field(deep_learning, "operationalProofReady"))
            && hashes_ready(deep_learning, "operationalReceiptHashes");
    let gpu_deep_learning_production_qualification_ready =
        is_true(field(deep_learning, "productionQualificationReady"))
            && hashes_ready(deep_learning, "conformanceReceiptHashes");
    let gpu_scientific_capability_proofs_ready = gpu_pde_operational_proof_ready
        && gpu_pde_production_qualification_ready
        && gpu_deep_learning_operational_proof_ready
        && gpu_deep_learning_production_qualification_ready;

    let campaign_schema = field(input, "campaignStoreSchema");
    let campaign_blockers = field(input, "campaignStoreSchemaBlockers");
    let operational_integrity = field(input, "operationalIntegrity");
    let campaign_store_ready = is_true(field(input, "campaignQueryReady"))
        && is_true(field(input, "nodeQueryReady"))
        && field(campaign_schema, "status") == &json!("scoped_schema_version_verified")
        && array(campaign_blockers).is_some_and(|values| values.is_empty())
        && is_true(field(operational_integrity, "queryReady"));
    let full_research = field(input, "fullResearchQualification");
    let release_attestor = field(input, "researchExecutionReleaseAttestor");
    let runtime_reproducibility = field(input, "runtimeImageReproducibility");
    let full_automatic_research_writing_runtime_preflight_ready = automation_runtime_ready
        && is_true(field(agent, "researchAuthorConfigurationPreflightReady"))
        && is_true(field(
            agent,
            "formalReviewConfigurationIndependentPrincipalReady",
        ))
        && academic_empirical_ready
        && is_true(field(release_attestor, "ready"))
        && is_true(field(release_attestor, "productionReady"))
        && is_true(field(release_attestor, "fullProductionReady"))
        && is_true(field(runtime_reproducibility, "ready"))
        && gpu_scientific_runtime_ready
        && gpu_scientific_capability_proofs_ready
        && usable(field(runtimes, "lean"));
    let independent_hypothesis_prior_art_qualification_ready = is_true(field(
        full_research,
        "independentHypothesisPriorArtReviewVerified",
    )) && sha256(field(
        full_research,
        "independentHypothesisPriorArtReceiptHash",
    ));
    let full_research_qualification_ready = is_true(field(full_research, "ready"))
        && independent_hypothesis_prior_art_qualification_ready;
    let bounded_golden_infrastructure_qualification_ready = full_research_qualification_ready
        && field(full_research, "qualificationScope") == &json!("bounded-capability-only-v1")
        && is_true(field(full_research, "genericContentCanaryVerified"));
    let production_generic_research_qualification_ready = full_research_qualification_ready
        && field(full_research, "qualificationScope") == &json!("production-agent-authored-v1");
    let autonomous_qualification_authority_ready = bounded_golden_infrastructure_qualification_ready
        || production_generic_research_qualification_ready;
    let live_provider_canary_ready = is_true(field(agent, "researchAuthorProviderAvailable"))
        && is_true(field(agent, "formalReviewProviderAvailable"));
    let live_provider_canary_required = is_true(field(input, "liveProviderCanaryRequired"));
    let providers_ready = if live_provider_canary_required {
        live_provider_canary_ready
    } else {
        live_provider_canary_ready || is_true(field(full_research, "ready"))
    };
    let operational_integrity_ready = field(operational_integrity, "degraded") == &json!(false);
    let full_automatic_research_writing_ready =
        full_automatic_research_writing_runtime_preflight_ready
            && providers_ready
            && campaign_store_ready
            && operational_integrity_ready
            && autonomous_qualification_authority_ready;
    let campaign_fully_qualified =
        full_automatic_research_writing_ready && production_generic_research_qualification_ready;

    let mut blockers = Vec::new();
    if !automation_runtime_ready {
        blockers.push(json!("automation_runtime_not_ready"));
    }
    if !campaign_store_ready {
        blockers.push(json!("campaign_store_not_ready"));
    }
    if !operational_integrity_ready && field(operational_integrity, "degraded") == &json!(true) {
        blockers.push(json!("automation_operational_integrity_degraded"));
    }
    if !is_true(field(agent, "researchAuthorConfigurationPreflightReady")) {
        blockers.push(json!("research_author_configuration_not_ready"));
    }
    if !is_true(field(
        agent,
        "formalReviewConfigurationIndependentPrincipalReady",
    )) {
        blockers.push(json!("formal_review_independent_principal_not_ready"));
    }
    if !academic_empirical_ready {
        blockers.push(academic_empirical_readiness_reason.clone());
    }
    if !is_true(field(release_attestor, "ready")) {
        blockers.push(json!("research_execution_release_attestor_not_ready"));
    }
    if !is_true(field(release_attestor, "productionReady"))
        || !is_true(field(release_attestor, "fullProductionReady"))
    {
        blockers.push(json!(
            "research_execution_release_attestor_production_backend_not_ready"
        ));
    }
    if !is_true(field(runtime_reproducibility, "ready")) {
        blockers.push(json!("runtime_image_reproducibility_not_ready"));
    }
    blockers.extend(spread_values(field(runtime_reproducibility, "blockers")));
    if !gpu_scientific_runtime_ready {
        blockers.push(json!("gpu_scientific_runtime_not_ready"));
    }
    if !gpu_pde_operational_proof_ready {
        blockers.push(json!("gpu_pde_operational_proof_not_ready"));
    }
    if !gpu_pde_production_qualification_ready {
        blockers.push(json!("gpu_pde_production_qualification_not_ready"));
    }
    if !gpu_deep_learning_operational_proof_ready {
        blockers.push(json!("gpu_deep_learning_operational_proof_not_ready"));
    }
    if !gpu_deep_learning_production_qualification_ready {
        blockers.push(json!(
            "gpu_deep_learning_production_qualification_not_ready"
        ));
    }
    if !usable(field(runtimes, "lean")) {
        blockers.push(json!("lean_runtime_not_ready"));
    }
    if !providers_ready {
        blockers.push(json!("qualified_provider_canaries_not_ready"));
    }
    if !independent_hypothesis_prior_art_qualification_ready {
        blockers.push(json!(
            "independent_hypothesis_prior_art_qualification_not_ready"
        ));
    }
    if !autonomous_qualification_authority_ready {
        blockers.push(json!("generic_content_qualification_authority_not_ready"));
    }
    blockers.extend(spread_values(field(full_research, "blockers")));
    let blockers = unique_truthy(blockers);
    let status = if !automation_runtime_ready {
        "automation_plane_runtime_blocked"
    } else if !campaign_store_ready {
        "automation_plane_store_blocked"
    } else if !operational_integrity_ready {
        "automation_plane_runtime_degraded"
    } else {
        "automation_plane_runtime_ready"
    };
    json!({
        "version": 1,
        "kind": "AutomationReadinessEvaluation",
        "status": status,
        "automationRuntimeReady": automation_runtime_ready,
        "automationOperationalReady": automation_runtime_ready && campaign_store_ready && operational_integrity_ready,
        "academicEmpiricalReady": academic_empirical_ready,
        "academicEmpiricalReadinessReason": academic_empirical_readiness_reason,
        "gpuScientificRuntimeReady": gpu_scientific_runtime_ready,
        "gpuPdeOperationalProofReady": gpu_pde_operational_proof_ready,
        "gpuPdeProductionQualificationReady": gpu_pde_production_qualification_ready,
        "gpuDeepLearningOperationalProofReady": gpu_deep_learning_operational_proof_ready,
        "gpuDeepLearningProductionQualificationReady": gpu_deep_learning_production_qualification_ready,
        "gpuScientificCapabilityProofsReady": gpu_scientific_capability_proofs_ready,
        "campaignStoreReady": campaign_store_ready,
        "fullAutomaticResearchWritingRuntimePreflightReady": full_automatic_research_writing_runtime_preflight_ready,
        "independentHypothesisPriorArtQualificationReady": independent_hypothesis_prior_art_qualification_ready,
        "fullResearchQualificationReady": full_research_qualification_ready,
        "boundedGoldenInfrastructureQualificationReady": bounded_golden_infrastructure_qualification_ready,
        "productionGenericResearchQualificationReady": production_generic_research_qualification_ready,
        "liveProviderCanaryRequired": live_provider_canary_required,
        "liveProviderCanaryReady": live_provider_canary_ready,
        "campaignFullyQualified": campaign_fully_qualified,
        "fullAutomaticResearchWritingReady": full_automatic_research_writing_ready,
        "fullAutomaticResearchWritingStatus": if full_automatic_research_writing_ready {
            "full_automatic_research_writing_runtime_ready"
        } else if full_automatic_research_writing_runtime_preflight_ready
            && providers_ready
            && campaign_store_ready
            && operational_integrity_ready
        {
            "full_automatic_research_writing_qualification_blocked"
        } else {
            "full_automatic_research_writing_runtime_blocked"
        },
        "blockers": blockers,
    })
}

/// Port of `evaluateAutomationReadinessLevels` from the incumbent Node policy.
#[must_use]
pub fn evaluate_automation_readiness_levels_v1(input: &Value) -> Value {
    let runtime_ready = is_true(field(input, "runtimeReady"));
    let bounded_profile_ready = runtime_ready && is_true(field(input, "boundedProfileReady"));
    let configured_scope_ready =
        bounded_profile_ready && is_true(field(input, "configuredScopeReady"));
    let generic_research_ready = bounded_profile_ready
        && configured_scope_ready
        && is_true(field(input, "genericCapabilityReady"))
        && is_true(field(input, "formalSandboxRuntimeReady"))
        && is_true(field(input, "dynamicFormalProjectClosureReady"));
    let production_ready = generic_research_ready
        && is_true(field(input, "autonomousSystemReady"))
        && is_true(field(input, "submissionDispatcherReady"));
    let runtime_status = field(input, "runtimeStatus");
    let blocked_runtime_status = if js_truthy(runtime_status)
        && runtime_status != &json!("automation_plane_runtime_ready")
    {
        runtime_status.clone()
    } else {
        json!("automation_plane_runtime_blocked")
    };
    let status = if !runtime_ready {
        blocked_runtime_status
    } else if !bounded_profile_ready {
        json!("automation_plane_bounded_profile_blocked")
    } else if !generic_research_ready {
        json!("automation_plane_generic_research_blocked")
    } else if !production_ready {
        json!("automation_plane_production_blocked")
    } else {
        json!("automation_plane_production_ready")
    };
    json!({
        "version": 1,
        "kind": "AutomationReadinessLevels",
        "status": status,
        "runtimeReady": runtime_ready,
        "boundedProfileReady": bounded_profile_ready,
        "configuredScopeReady": configured_scope_ready,
        "genericResearchReady": generic_research_ready,
        "productionReady": production_ready,
    })
}

/// Port of `automationReadinessExitCode` from the incumbent Node policy.
#[must_use]
pub fn automation_readiness_exit_code_v1(evaluation: &Value, options: &Value) -> i32 {
    if !is_true(field(evaluation, "automationRuntimeReady"))
        || !is_true(field(evaluation, "campaignStoreReady"))
    {
        return 1;
    }
    if !is_true(field(evaluation, "automationOperationalReady")) {
        return 2;
    }
    if is_true(field(options, "requireFullResearch"))
        && !is_true(field(evaluation, "fullAutomaticResearchWritingReady"))
    {
        return 3;
    }
    if is_true(field(options, "requireFullyAutonomous"))
        && !is_true(field(options, "fullyAutonomousResearchSystemReady"))
    {
        return 4;
    }
    0
}

#[cfg(test)]
#[path = "automation_readiness_policy_tests.rs"]
mod tests;
