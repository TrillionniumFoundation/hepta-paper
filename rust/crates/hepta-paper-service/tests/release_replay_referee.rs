use hepta_paper_service::release_replay::{
    REFEREE_REPLAY_CORPUS_V1, evaluate_referee_replay_corpus_v1, referee::evaluate_referee_case_v1,
};
use serde_json::{Value, json};
use std::{
    io::Write,
    path::PathBuf,
    process::{Command, Stdio},
};

#[test]
fn referee_replay_matches_actual_node_and_archived_python_with_explicit_safe_command_migration() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let script = format!(
        "{}\n{}",
        include_str!("../src/release_replay/oracle-input-guard.mjs"),
        include_str!("../src/release_replay/referee-oracle.mjs")
    );
    let mut child = Command::new("node")
        .args(["--input-type=module", "--eval", &script])
        .arg(&root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env_remove("NODE_OPTIONS")
        .env_remove("PYTHONPATH")
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(REFEREE_REPLAY_CORPUS_V1.as_bytes())
        .unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let oracle: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(
        oracle["profile"],
        json!({"node":"v22.23.1","icu":"78.2","cldr":"48.0"})
    );
    assert_eq!(
        oracle["archiveReference"]["status"],
        "legacy_differential_reference_verified"
    );
    let corpus: Value = serde_json::from_str(REFEREE_REPLAY_CORPUS_V1).unwrap();
    let cases = corpus["cases"].as_array().unwrap();
    let expected = oracle["actual"].as_array().unwrap();
    assert_eq!(cases.len(), expected.len());
    for (index, (case, expected)) in cases.iter().zip(expected).enumerate() {
        assert_eq!(
            evaluate_referee_case_v1(case).unwrap(),
            *expected,
            "case {index}: {}",
            case["name"]
        );
    }
    let native_corpus =
        evaluate_referee_replay_corpus_v1(REFEREE_REPLAY_CORPUS_V1.as_bytes()).unwrap();
    assert_eq!(native_corpus["actual"], oracle["actual"]);
    let base = corpus["baseCaseCount"].as_u64().unwrap() as usize;
    assert_eq!(
        &expected[..base],
        oracle["archivedPython"].as_array().unwrap()
    );
    assert!(
        expected
            .iter()
            .any(|v| v["consumption_state"] == "PLAN_ONLY_CONSUMABLE")
    );
    assert!(
        expected
            .iter()
            .any(|v| v["consumption_state"] == "EXTERNAL_ACTION_FORBIDDEN")
    );
    assert!(
        expected
            .iter()
            .any(|v| v["consumption_state"] == "HUMAN_REVIEW_REQUIRED")
    );
}

#[test]
fn referee_replay_refuses_unknown_operation_oversized_and_malformed_requests_before_calculation() {
    for case in [
        json!({}),
        json!({"name":"caller.execute","args":[]}),
        json!({"name":"evidence_resync_decision_plan","args":[],"callerPassCount":1000}),
        json!({"name":"evidence_resync_decision_plan","args":[[],{"selected_slug":{"callerIdentity":true}}]}),
        json!({"name":"evidence_resync_decision_plan","args":[[{"slugs":[{"compound":true}]}]]}),
        json!({"name":"evidence_resync_decision_plan","args":["bad"]}),
        json!({"name":"ready_merge_boundary_decision_plan","args":[vec![json!({});1025]]}),
        json!({"name":"evidence_resync_decision_plan","args":[],"padding":"x".repeat(4*1024*1024+1)}),
    ] {
        assert!(evaluate_referee_case_v1(&case).is_err())
    }
    let mut deep = json!(null);
    for _ in 0..34 {
        deep = json!({"nested":deep})
    }
    assert!(
        evaluate_referee_case_v1(&json!({"name":"evidence_resync_decision_plan","args":[[],deep]}))
            .is_err()
    );
}

#[test]
fn referee_corpus_refuses_claimed_result_fields_unknown_keys_and_invalid_base_count() {
    for input in [
        json!({"version":1,"baseCaseCount":0,"cases":[],"callerPassCount":1000}),
        json!({"version":2,"baseCaseCount":0,"cases":[]}),
        json!({"version":1,"baseCaseCount":1,"cases":[]}),
        json!({"version":1,"baseCaseCount":0,"cases":[{"name":"caller.execute","args":[]}]}),
    ] {
        assert!(evaluate_referee_replay_corpus_v1(&serde_json::to_vec(&input).unwrap()).is_err());
    }
    assert!(
        evaluate_referee_replay_corpus_v1(
            b"{\"version\":1,\"version\":1,\"baseCaseCount\":0,\"cases\":[]}"
        )
        .is_err()
    );
}
