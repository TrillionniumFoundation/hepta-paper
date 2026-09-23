use super::*;
use serde_json::{Value, json};
use std::{
    io::Write,
    path::PathBuf,
    process::{Command, Stdio},
};

fn hash(letter: char) -> String {
    format!("sha256:{}", letter.to_string().repeat(64))
}

fn ready_input() -> Value {
    json!({
        "runtimes": {
            "agent": {
                "usable": true,
                "researchAuthorConfigurationPreflightReady": true,
                "formalReviewConfigurationIndependentPrincipalReady": true,
                "researchAuthorProviderAvailable": true,
                "formalReviewProviderAvailable": true
            },
            "python": {"usable": true},
            "latex": {"usable": true},
            "lean": {"usable": true},
            "gpu": {"usable": true},
            "gpuContainer": {"usable": true},
            "images": {"pythonGpu": {"usable": true}},
            "sandbox": {
                "usable": true,
                "academicEmpiricalReady": true,
                "academicEmpiricalReadinessReason": "academic_empirical_dataset_access_ready"
            }
        },
        "campaignQueryReady": true,
        "nodeQueryReady": true,
        "campaignStoreSchema": {"status": "scoped_schema_version_verified"},
        "campaignStoreSchemaBlockers": [],
        "operationalIntegrity": {"queryReady": true, "degraded": false},
        "researchExecutionReleaseAttestor": {
            "ready": true,
            "productionReady": true,
            "fullProductionReady": true
        },
        "runtimeImageReproducibility": {"ready": true, "blockers": []},
        "gpuScientificCapabilityProofInspection": {
            "capabilities": {
                "pde": {
                    "operationalProofReady": true,
                    "operationalReceiptHashes": [hash('b')],
                    "productionQualificationReady": true,
                    "conformanceReceiptHashes": [hash('b')]
                },
                "deepLearning": {
                    "operationalProofReady": true,
                    "operationalReceiptHashes": [hash('b')],
                    "productionQualificationReady": true,
                    "conformanceReceiptHashes": [hash('b')]
                }
            }
        },
        "fullResearchQualification": {
            "ready": true,
            "qualificationScope": "bounded-capability-only-v1",
            "genericContentCanaryVerified": true,
            "independentHypothesisPriorArtReviewVerified": true,
            "independentHypothesisPriorArtReceiptHash": hash('a'),
            "blockers": []
        }
    })
}

fn oracle(requests: &[Value]) -> Value {
    let repository = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let mut child = Command::new("node")
        .arg(repository.join("rust/oracle/automation-readiness-policy-v1.mjs"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("Node automation policy oracle");
    child
        .stdin
        .take()
        .expect("oracle stdin")
        .write_all(serde_json::to_vec(requests).unwrap().as_slice())
        .unwrap();
    let output = child.wait_with_output().expect("oracle wait");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let result: Value = serde_json::from_slice(&output.stdout).expect("oracle JSON");
    assert_eq!(result["profile"]["node"], "v22.23.1");
    result
}

fn status_oracle(requests: &[Value]) -> Value {
    let repository = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let mut child = Command::new("node")
        .arg(repository.join("rust/oracle/automation-readiness-system-status-v1.mjs"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("Node automation system-status oracle");
    child
        .stdin
        .take()
        .expect("oracle stdin")
        .write_all(serde_json::to_vec(requests).unwrap().as_slice())
        .unwrap();
    let output = child.wait_with_output().expect("oracle wait");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).expect("oracle JSON")
}

fn expected_result(result: &Value, index: usize) -> &Value {
    &result["results"][index]
}

#[test]
fn evaluator_matches_node_for_runtime_store_degraded_qualification_and_gpu_cases() {
    let mut cases = Vec::new();
    let mut ready = ready_input();
    cases.push(json!({"operation":"evaluate", "input":ready}));

    let mut runtime_blocked = ready_input();
    runtime_blocked["runtimes"]["python"]["usable"] = json!(false);
    cases.push(json!({"operation":"evaluate", "input":runtime_blocked}));

    let mut store_blocked = ready_input();
    store_blocked["campaignQueryReady"] = json!(false);
    cases.push(json!({"operation":"evaluate", "input":store_blocked}));

    let mut degraded = ready_input();
    degraded["operationalIntegrity"]["degraded"] = json!(true);
    cases.push(json!({"operation":"evaluate", "input":degraded}));

    let mut qualification_blocked = ready_input();
    qualification_blocked["fullResearchQualification"] = json!({
        "ready": false,
        "blockers": ["qualification_missing"]
    });
    cases.push(json!({"operation":"evaluate", "input":qualification_blocked}));

    let mut gpu_blocked = ready_input();
    gpu_blocked["runtimes"]["images"]["pythonGpu"]["usable"] = json!(false);
    cases.push(json!({"operation":"evaluate", "input":gpu_blocked}));

    let mut gpu_receipt_blocked = ready_input();
    gpu_receipt_blocked["gpuScientificCapabilityProofInspection"]["capabilities"]["pde"]["operationalReceiptHashes"] =
        json!(["invalid"]);
    cases.push(json!({"operation":"evaluate", "input":gpu_receipt_blocked}));

    let node = oracle(&cases);
    for (index, case) in cases.iter().enumerate() {
        let actual = evaluate_automation_readiness_v1(&case["input"]);
        assert_eq!(
            json!({"ok":true,"value":actual}),
            *expected_result(&node, index),
            "case {index}"
        );
    }

    // Keep one explicit assertion that the fixture exercises the ready path;
    // the full equality above is the Node protocol authority.
    ready = ready_input();
    let report = evaluate_automation_readiness_v1(&ready);
    assert_eq!(report["fullAutomaticResearchWritingReady"], true);
    assert_eq!(report["blockers"], json!([]));
}

#[test]
fn levels_and_exit_codes_match_node_for_each_gate() {
    let level_inputs = [
        json!({"runtimeReady":false,"runtimeStatus":"automation_plane_store_blocked","boundedProfileReady":true,"genericCapabilityReady":true,"formalSandboxRuntimeReady":true,"dynamicFormalProjectClosureReady":true,"submissionDispatcherReady":true}),
        json!({"runtimeReady":true}),
        json!({"runtimeReady":true,"boundedProfileReady":true}),
        json!({"runtimeReady":true,"boundedProfileReady":true,"configuredScopeReady":true,"genericCapabilityReady":true,"formalSandboxRuntimeReady":true,"dynamicFormalProjectClosureReady":true}),
        json!({"runtimeReady":true,"boundedProfileReady":true,"configuredScopeReady":true,"genericCapabilityReady":true,"formalSandboxRuntimeReady":true,"dynamicFormalProjectClosureReady":true,"autonomousSystemReady":true,"submissionDispatcherReady":true}),
    ];
    let level_cases = level_inputs
        .iter()
        .map(|input| json!({"operation":"levels", "input":input}))
        .collect::<Vec<_>>();
    let node_levels = oracle(&level_cases);
    for (index, case) in level_cases.iter().enumerate() {
        let actual = evaluate_automation_readiness_levels_v1(&case["input"]);
        assert_eq!(
            json!({"ok":true,"value":actual}),
            *expected_result(&node_levels, index),
            "level case {index}"
        );
    }

    let ready = evaluate_automation_readiness_v1(&ready_input());
    let mut evaluations = vec![ready.clone()];
    let mut runtime_blocked = ready_input();
    runtime_blocked["runtimes"]["python"]["usable"] = json!(false);
    evaluations.push(evaluate_automation_readiness_v1(&runtime_blocked));
    let mut degraded = ready_input();
    degraded["operationalIntegrity"]["degraded"] = json!(true);
    evaluations.push(evaluate_automation_readiness_v1(&degraded));
    let options = vec![
        json!({}),
        json!({"requireFullResearch":true}),
        json!({"requireFullyAutonomous":true,"fullyAutonomousResearchSystemReady":false}),
    ];
    let mut exit_cases = Vec::new();
    for evaluation in &evaluations {
        for option in &options {
            exit_cases.push(json!({"operation":"exit", "evaluation":evaluation, "options":option}));
        }
    }
    let node_exits = oracle(&exit_cases);
    for (index, case) in exit_cases.iter().enumerate() {
        let actual = automation_readiness_exit_code_v1(&case["evaluation"], &case["options"]);
        assert_eq!(
            json!({"ok":true,"value":actual}),
            *expected_result(&node_exits, index),
            "exit case {index}"
        );
    }
}

#[test]
fn derived_fully_autonomous_status_matches_node_for_ready_blocked_and_malformed_inputs() {
    let cases = vec![
        json!({
            "operation": "derive-status",
            "readinessLevels": {
                "productionReady": true,
                "status": "automation_plane_production_ready"
            },
            "coreStatus": "generic_domain_autonomous_research_system_ready"
        }),
        json!({
            "operation": "derive-status",
            "readinessLevels": {
                "productionReady": true,
                "status": "automation_plane_production_ready"
            },
            "coreStatus": "automation_plane_production_ready"
        }),
        json!({
            "operation": "derive-status",
            "readinessLevels": {
                "productionReady": false,
                "status": "automation_plane_generic_research_blocked"
            },
            "coreStatus": "generic_domain_autonomous_research_system_ready"
        }),
        json!({
            "operation": "derive-status",
            "readinessLevels": {
                "productionReady": false,
                "status": "automation_plane_production_ready"
            },
            "coreStatus": "automation_plane_production_ready"
        }),
        json!({
            "operation": "derive-status",
            "readinessLevels": {
                "productionReady": false,
                "status": 17
            },
            "coreStatus": null
        }),
        json!({"operation": "derive-status", "readinessLevels": null, "coreStatus": null}),
    ];
    let node = status_oracle(&cases);
    for (index, case) in cases.iter().enumerate() {
        let actual = derive_fully_autonomous_research_system_status_v1(
            &case["readinessLevels"],
            &case["coreStatus"],
        );
        assert_eq!(
            json!({"ok":true,"value":actual}),
            *expected_result(&node, index),
            "case {index}"
        );
    }
}
