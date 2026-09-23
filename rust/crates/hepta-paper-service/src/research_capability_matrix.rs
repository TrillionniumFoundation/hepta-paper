//! Native research capability reporting over an already-observed readiness report.
//!
//! This is a pure projection, not a readiness observer or authority verifier. Its
//! JSON result never grants activation, submission, qualification, or retirement.
//! The incumbent command's environment composition and live readiness query must
//! be migrated separately before this function constitutes the complete route.

use hepta_legacy_compatibility::production_hash_record_v1;
use serde_json::{Value, json};

#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct ResearchCapabilityMatrixError(String);
type Result<T> = std::result::Result<T, ResearchCapabilityMatrixError>;

const LEVELS: [&str; 4] = [
    "contract_fixture",
    "real_runtime_fixture",
    "live_model",
    "external_trust",
];
fn err(message: impl Into<String>) -> ResearchCapabilityMatrixError {
    ResearchCapabilityMatrixError(message.into())
}
fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(v) => *v,
        Value::Number(v) => v.as_f64().is_some_and(|n| n != 0.0),
        Value::String(v) => !v.is_empty(),
        _ => true,
    }
}
fn array(value: &Value) -> &[Value] {
    value.as_array().map(Vec::as_slice).unwrap_or_default()
}
fn strings(value: &Value) -> Result<Vec<String>> {
    if !truthy(value) {
        return Ok(Vec::new());
    }
    let values = value
        .as_array()
        .ok_or_else(|| err("research_capability_blockers_array_required"))?;
    values
        .iter()
        .filter(|v| truthy(v))
        .map(|v| {
            v.as_str()
                .map(str::to_owned)
                .ok_or_else(|| err("research_capability_blocker_string_required"))
        })
        .collect()
}
fn sorted(mut values: Vec<String>) -> Vec<String> {
    // ECMAScript Array.sort() compares UTF-16 code units, not UTF-8 or locale.
    values.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    values.dedup();
    values
}
fn js_string(value: &Value) -> String {
    match value {
        Value::String(v) => v.clone(),
        Value::Null => "null".into(),
        Value::Array(v) => v
            .iter()
            .map(|v| {
                if v.is_null() {
                    String::new()
                } else {
                    js_string(v)
                }
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".into(),
        _ => value.to_string(),
    }
}

struct Definition<'a> {
    id: &'a str,
    qualified: bool,
    production: bool,
    scope: Value,
    blockers: Vec<String>,
    limitations: &'a [&'a str],
    default_level: Option<&'a str>,
}
fn capability(readiness: &Value, definition: Definition<'_>) -> Result<Value> {
    let live = array(&readiness["liveModelEvidenceCapabilityIds"])
        .iter()
        .any(|v| v == definition.id);
    let inferred = if definition.production {
        3
    } else if live {
        2
    } else if definition.qualified {
        1
    } else {
        0
    };
    let supplied = &readiness["explicitCapabilityEvidenceLevels"][definition.id];
    let explicit = if truthy(supplied) {
        Some(supplied.clone())
    } else {
        definition.default_level.map(Value::from)
    };
    let level = match explicit {
        None => LEVELS[inferred],
        Some(value) => {
            let index = LEVELS.iter().position(|s| value == *s).ok_or_else(|| {
                err(format!(
                    "research_capability_evidence_level_invalid:{}",
                    js_string(&value)
                ))
            })?;
            if index > inferred {
                return Err(err(format!(
                    "research_capability_evidence_level_exceeds_readiness:{}",
                    LEVELS[index]
                )));
            }
            LEVELS[index]
        }
    };
    Ok(
        json!({"id":definition.id,"implemented":true,"qualified":definition.qualified,"productionReady":definition.production,
        "strongestEvidenceLevel":level,"scope":definition.scope,"blockers":sorted(definition.blockers),"limitations":definition.limitations}),
    )
}

/// Project the ten registered capabilities and recompute their version-2 hash.
///
/// Input readiness is descriptive, untrusted JSON. A `true` output only describes
/// those input claims; no verified authority type or permission is returned.
/// Malformed non-string blocker entries are rejected instead of being promoted.
pub fn build_research_capability_matrix_v2(readiness: &Value) -> Result<Value> {
    if readiness.is_null() {
        return Err(err("research_capability_readiness_required"));
    }
    let source: Value = serde_json::from_str(include_str!(
        "research_capability_matrix/registry-inputs.v1.json"
    ))
    .map_err(|_| err("research_capability_registry_invalid"))?;
    let ready = |name: &str| readiness[name] == true;
    let generic = ready("genericDomainCapabilityReady");
    let empirical = ready("academicEmpiricalReady");
    let formal = ready("dynamicFormalProjectClosureReady");
    let handoff = ready("autonomousSubmissionHandoffReady");
    let dispatch = ready("autonomousSubmissionDispatcherReady");
    let draft = ready("autonomousSubmissionProviderDraftReady") || dispatch;
    let gpu = ready("gpuScientificRuntimeReady");
    let pde = gpu && ready("gpuPdeOperationalProofReady");
    let dl = gpu && ready("gpuDeepLearningOperationalProofReady");
    let generic_blockers = if readiness["genericDomainCapabilityBlockers"].is_array() {
        if array(&readiness["genericDomainCapabilityBlockers"])
            .iter()
            .any(|v| !v.is_string())
        {
            return Err(err("research_capability_blocker_string_required"));
        }
        strings(&readiness["genericDomainCapabilityBlockers"])?
    } else {
        Vec::new()
    };
    let scientific_blockers: Vec<_> = generic_blockers
        .iter()
        .filter(|s| s.contains("experiment") || s.contains("replay"))
        .cloned()
        .collect();
    let mut formal_blockers = strings(&readiness["dynamicFormalProjectClosure"]["blockers"])?;
    formal_blockers.extend(
        generic_blockers
            .iter()
            .filter(|s| s.contains("formal"))
            .cloned(),
    );
    let submission = &readiness["autonomousSubmissionDispatcherReadiness"];
    let submission_blockers = strings(&submission["blockers"])?;
    let mut pde_blockers = Vec::new();
    let mut dl_blockers = Vec::new();
    if !gpu {
        pde_blockers.push("gpu_scientific_runtime_not_ready".into());
        dl_blockers.push("gpu_scientific_runtime_not_ready".into());
    }
    for (field, blocker) in [
        (
            "gpuPdeOperationalProofReady",
            "gpu_pde_operational_proof_not_ready",
        ),
        (
            "gpuPdeProductionQualificationReady",
            "gpu_pde_production_qualification_not_ready",
        ),
    ] {
        if !ready(field) {
            pde_blockers.push(blocker.into());
        }
    }
    for (field, blocker) in [
        (
            "gpuDeepLearningOperationalProofReady",
            "gpu_deep_learning_operational_proof_not_ready",
        ),
        (
            "gpuDeepLearningProductionQualificationReady",
            "gpu_deep_learning_production_qualification_not_ready",
        ),
    ] {
        if !ready(field) {
            dl_blockers.push(blocker.into());
        }
    }
    let languages: Vec<_> = array(&source["languages"])
        .iter()
        .filter(|language| {
            let Some(name) = language.as_str() else {
                return false;
            };
            array(&readiness["empiricalLanguagesReady"]).contains(language)
                || readiness["runtimes"][name]["usable"] == true
                || readiness["runtimes"]["images"][name]["usable"] == true
        })
        .cloned()
        .collect();
    let mut families: Vec<_> = array(&source["profiles"])
        .iter()
        .filter_map(|p| p["benchmarkFamily"].as_str().map(str::to_owned))
        .collect();
    families.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    let oracles = sorted(
        array(&source["profiles"])
            .iter()
            .flat_map(|p| array(&p["typedOracleKinds"]).iter())
            .filter_map(|v| v.as_str().map(str::to_owned))
            .collect(),
    );
    let strategies: Vec<_> = array(&source["strategies"])
        .iter()
        .map(|s| s["strategy"].clone())
        .collect();
    let definitions = [
        Definition {
            id: "theorem-specification",
            qualified: generic,
            production: ready("genericResearchReady"),
            scope: json!({"claimAuthorityModes":["operator-signed","machine-policy-authorized"],"formalizationTarget":"lean4","registeredFormalTemplateCount":array(&source["formalTemplateIds"]).len()}),
            blockers: generic_blockers,
            limitations: &[
                "natural-language-to-Lean semantic equivalence requires independent review",
                "theorem generation is bounded by authorized claim lineage and registered formal scope",
            ],
            default_level: None,
        },
        Definition {
            id: "formal-proof-search",
            qualified: formal,
            production: generic && formal,
            scope: json!({"strategies":strategies,"strategyCapabilities":source["strategies"],"backends":source["backends"],"kernel":"lean4","freshReplayRequired":true}),
            blockers: formal_blockers,
            limitations: &[
                "machine search applies only when the exact Lean type compiles to the typed theorem DSL",
                "search exhaustion emits a failure certificate and never establishes truth",
                "Coq and Isabelle remain unavailable until separately qualified adapters exist",
            ],
            default_level: None,
        },
        Definition {
            id: "empirical-code-execution",
            qualified: empirical,
            production: empirical && generic,
            scope: json!({"benchmarkFamilies":families,"runtimeLanguages":languages}),
            blockers: scientific_blockers.clone(),
            limitations: &[
                "production evidence is limited to registered and authority-backed experiment families",
                "generated code is evidence only after isolated execution and accepted replay",
            ],
            default_level: None,
        },
        Definition {
            id: "typed-numerical-analysis",
            qualified: empirical,
            production: empirical && generic,
            scope: json!({"benchmarkFamilies":families,"typedOracleKinds":oracles,"independentProcessRecomputationRequired":true}),
            blockers: scientific_blockers,
            limitations: &[
                "arbitrary statistical or numerical procedures outside a registered oracle ABI are unsupported",
                "numeric agreement does not establish scientific validity or external validity",
            ],
            default_level: None,
        },
        Definition {
            id: "gpu-pde-solver",
            qualified: pde,
            production: pde && ready("gpuPdeProductionQualificationReady") && generic,
            scope: json!({"profiles":["pde_poisson_2d_manufactured_solution_v1"],"accelerator":"single-pinned-nvidia-gpu-uuid-v1","precision":"ieee754-binary64","independentCpuOracleRequired":true,"producerDiagnosticsAuthoritative":false}),
            blockers: pde_blockers,
            limitations: &[
                "v1 covers a registered structured-grid Poisson problem, not arbitrary PDEs",
                "GPU memory is observed and bounded by problem size but is not a hard VRAM cgroup limit",
                "production promotion requires a fresh independent CPU recomputation for every solve",
            ],
            default_level: None,
        },
        Definition {
            id: "gpu-deep-learning-training",
            qualified: dl,
            production: dl && ready("gpuDeepLearningProductionQualificationReady") && generic,
            scope: json!({"profiles":["dl-supervised-classification-gpu-deterministic-v1"],"accelerator":"single-pinned-nvidia-gpu-uuid-v1","numericMode":"fp32-tf32-amp-disabled-v1","modelAuthority":"allowlisted-declarative-model-ir-v1","hiddenEvaluationAndFreshReplayRequired":true}),
            blockers: dl_blockers,
            limitations: &[
                "v1 covers bounded single-GPU MLP training, not arbitrary CNNs or foundation models",
                "same-device replay does not establish cross-device or cross-driver bitwise reproducibility",
                "custom CUDA, arbitrary executable models, pickle checkpoints, AMP, DDP, and NCCL are forbidden",
            ],
            default_level: None,
        },
        Definition {
            id: "autonomous-manuscript-release",
            qualified: ready("fullResearchQualificationReady"),
            production: ready("fullAutomaticResearchWritingReady"),
            scope: json!({"evidenceBoundManuscript":true,"independentPdfRebuildRequired":true,"refereeConvergenceRequired":true}),
            blockers: strings(&readiness["fullResearchQualificationBlockers"])?,
            limitations: &[
                "release readiness requires current independent qualification and reproducibility evidence",
            ],
            default_level: None,
        },
        Definition {
            id: "local-submission-handoff",
            qualified: handoff,
            production: handoff,
            scope: json!({"localHandoffReady":handoff,"externalPortalMutation":false}),
            blockers: if handoff {
                Vec::new()
            } else {
                submission_blockers.clone()
            },
            limitations: &["a local release handoff grants no external portal authority"],
            default_level: handoff.then_some("real_runtime_fixture"),
        },
        Definition {
            id: "submission-provider-draft",
            qualified: draft,
            production: draft && dispatch,
            scope: json!({"portalBindingVerified":submission["portalBindingVerified"]==true,"providerDraftReady":draft,"liveCommitAuthorized":false}),
            blockers: if draft {
                Vec::new()
            } else {
                submission_blockers.clone()
            },
            limitations: &[
                "draft creation is a reversible provider action and is not manuscript submission",
            ],
            default_level: None,
        },
        Definition {
            id: "live-submission-commit",
            qualified: dispatch,
            production: dispatch,
            scope: json!({"liveDispatcherReady":dispatch,"portalBindingVerified":submission["portalBindingVerified"]==true,"livePortalCanaryVerified":submission["livePortalCanaryVerified"]==true,"humanReviewedSingleUseAuthorizationRequired":true}),
            blockers: submission_blockers,
            limitations: &[
                "the final live commit requires a human-reviewed hash-bound single-use authorization",
                "portal qualification applies only to the exact provider, account, route, and venue scope",
            ],
            default_level: None,
        },
    ];
    let capabilities: Vec<Value> = definitions
        .into_iter()
        .map(|d| capability(readiness, d))
        .collect::<Result<_>>()?;
    let entries_ready = capabilities.iter().all(|c| c["productionReady"] == true);
    let fully_ready = ready("productionReady")
        && ready("fullyAutonomousResearchSystemReady")
        && ready("fullAutomaticResearchWritingReady")
        && entries_ready;
    let inspection = &readiness["deploymentEnvironmentInspection"];
    let mut payload = json!({"version":2,"kind":"ResearchCapabilityMatrix","status":if fully_ready{"research_capabilities_production_ready"}else{"research_capabilities_bounded_or_blocked"},"capabilityEntriesStatus":if entries_ready{"research_capability_entries_production_ready"}else{"research_capability_entries_bounded_or_blocked"},"universalResearchClaimed":false,
        "evidenceLevelDefinitions":[
            {"id":"contract_fixture","establishes":"typed contracts and deterministic fixture behavior","productionAuthority":false},
            {"id":"real_runtime_fixture","establishes":"the real runtime executes a controlled fixture workload","productionAuthority":false},
            {"id":"live_model","establishes":"a current live model executes a hash-bound campaign workload","productionAuthority":false},
            {"id":"external_trust","establishes":"an independent external authority accepts current production-bound evidence","productionAuthority":true}],
        "fullyAutonomousProductionReady":fully_ready,"deploymentEnvironmentInspection":if truthy(inspection){inspection}else{&Value::Null},"capabilities":capabilities});
    payload["researchCapabilityMatrixHash"] = json!(
        production_hash_record_v1("ResearchCapabilityMatrix", &payload)
            .map_err(|_| err("research_capability_hash_failed"))?
            .as_str()
    );
    Ok(payload)
}
