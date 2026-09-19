use hepta_paper_service::research_capability_matrix::build_research_capability_matrix_v2;
use serde_json::{Value, json};
use std::{fs, path::Path, process::Command};

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

#[test]
fn research_capability_matrix_cli_matches_node_oracle_and_fails_closed_gate() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let output = Command::new("node")
        .arg(root.join("rust/oracle/research-capability-matrix-v2.mjs"))
        .current_dir(&root)
        .output()
        .expect("pinned Node oracle");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let cases: Vec<Value> = serde_json::from_slice(&output.stdout).expect("corpus");
    let all_ready = cases
        .iter()
        .find(|case| case["name"] == "all-ready")
        .expect("all-ready oracle case");
    let empty = cases
        .iter()
        .find(|case| case["name"] == "empty")
        .expect("empty oracle case");
    let request = std::env::temp_dir().join(format!(
        "hepta-research-capability-matrix-{}-{}.json",
        std::process::id(),
        std::thread::current().name().unwrap_or("test")
    ));

    fs::write(&request, serde_json::to_vec(&all_ready["input"]).unwrap()).unwrap();
    let production = Command::new(env!("CARGO_BIN_EXE_hepta-paper-rust"))
        .args([
            "research-capability-matrix",
            "--request",
            request.to_str().unwrap(),
            "--require-production-ready",
        ])
        .output()
        .unwrap();
    assert!(
        production.status.success(),
        "{}",
        String::from_utf8_lossy(&production.stderr)
    );
    let observed: Value = serde_json::from_slice(&production.stdout).unwrap();
    assert_eq!(observed, all_ready["result"]["ok"]);

    fs::write(&request, serde_json::to_vec(&empty["input"]).unwrap()).unwrap();
    let blocked = Command::new(env!("CARGO_BIN_EXE_hepta-paper-rust"))
        .args([
            "research-capability-matrix",
            "--request",
            request.to_str().unwrap(),
            "--require-production-ready",
        ])
        .output()
        .unwrap();
    assert_eq!(blocked.status.code(), Some(1));
    assert!(
        String::from_utf8_lossy(&blocked.stderr)
            .contains("research capability matrix is descriptive and not production ready")
    );
    let blocked_report: Value = serde_json::from_slice(&blocked.stdout).unwrap();
    assert_eq!(blocked_report, empty["result"]["ok"]);
    let _ = fs::remove_file(request);
}
