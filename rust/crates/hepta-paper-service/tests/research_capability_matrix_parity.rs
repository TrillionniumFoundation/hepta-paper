use hepta_paper_service::research_capability_matrix::build_research_capability_matrix_v2;
use serde_json::{Value, json};
use std::{path::Path, process::Command};

#[test]
fn actual_research_capability_matrix_projection_and_hash_match_node() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let output = Command::new("node")
        .arg(root.join("rust/oracle/research-capability-matrix-v2.mjs"))
        .output()
        .expect("pinned Node oracle");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let cases: Vec<Value> = serde_json::from_slice(&output.stdout).expect("corpus");
    assert!(cases.len() > 700);
    for case in cases {
        let observed = match build_research_capability_matrix_v2(&case["input"]) {
            Ok(value) => json!({"ok": value}),
            Err(error) => json!({"error": error.to_string()}),
        };
        assert_eq!(observed, case["result"], "{}", case["name"]);
    }
}

#[test]
fn malformed_blocker_shapes_cannot_panic_or_authorize_any_action() {
    for input in [
        json!(null),
        json!({"genericDomainCapabilityBlockers":[null]}),
        json!({"fullResearchQualificationBlockers": {}}),
        json!({"dynamicFormalProjectClosure":{"blockers":[true]}}),
        json!({"autonomousSubmissionDispatcherReadiness":{"blockers":"bad"}}),
    ] {
        assert!(build_research_capability_matrix_v2(&input).is_err());
    }
    let output = build_research_capability_matrix_v2(&json!({"runtimeReady":true,"gpuScientificReady":true,"gpuOperationalProofReady":true,"gpuProductionQualificationReady":true})).unwrap();
    assert_eq!(output["fullyAutonomousProductionReady"], false);
    assert_eq!(output["universalResearchClaimed"], false);
    for capability in output["capabilities"].as_array().unwrap() {
        assert_eq!(capability["productionReady"], false);
    }
}
