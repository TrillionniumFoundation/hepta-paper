//! Three independent implementations evaluate the same deterministic bytes.
//! P0 coverage is deliberately distinct from P1, signing and publication.
use hepta_paper_service::release_replay::{
    PRODUCTION_REPLAY_CORPUS_V1, evaluate_production_replay_corpus_v1, production_core,
};
use serde_json::{Value, json};
use std::{
    io::Write,
    path::PathBuf,
    process::{Command, Stdio},
};

#[test]
fn production_replay_matches_actual_node_and_immutable_archived_python_on_same_inputs() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let script = format!(
        "{}\n{}",
        include_str!("../src/release_replay/oracle-input-guard.mjs"),
        include_str!("../src/release_replay/production-oracle.mjs")
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
        .write_all(PRODUCTION_REPLAY_CORPUS_V1.as_bytes())
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
    assert_eq!(
        oracle["archiveReference"]["archiveSha256"],
        "sha256:fcf7027a0f9f7f49556314546257a9c252949b46c847fb34471db1bf1a92de3a"
    );
    let actual =
        evaluate_production_replay_corpus_v1(PRODUCTION_REPLAY_CORPUS_V1.as_bytes()).unwrap();
    for field in [
        "base",
        "extended",
        "artifactCases",
        "frontierCases",
        "shardCases",
    ] {
        if actual[field] != oracle["actual"][field] {
            if let (Some(left), Some(right)) =
                (actual[field].as_array(), oracle["actual"][field].as_array())
            {
                for (index, (left, right)) in left.iter().zip(right).enumerate() {
                    assert_eq!(left, right, "{field} case {index}");
                }
            }
            if field == "extended" {
                let left = actual[field]["evaluations"].as_array().unwrap();
                let right = oracle["actual"][field]["evaluations"].as_array().unwrap();
                for (index, (left, right)) in left.iter().zip(right).enumerate() {
                    assert_eq!(left, right, "extended evaluation {index}");
                }
            }
            assert_eq!(actual[field], oracle["actual"][field], "{field}");
        }
    }
    assert_eq!(actual["base"], oracle["archivedPython"]["base"]);
    assert_eq!(
        &actual["artifactCases"].as_array().unwrap()[..4],
        oracle["archivedPython"]["artifactCases"]
            .as_array()
            .unwrap()
    );
}

#[test]
fn every_production_replay_entry_refuses_oversized_deep_and_malformed_inputs() {
    let huge = json!({"padding":"x".repeat(4*1024*1024+1)});
    let mut deep = json!(0);
    for _ in 0..34 {
        deep = json!({"nested":deep});
    }
    for bad in [huge, deep, json!(false)] {
        assert!(production_core::evaluate_snapshot_v1(&bad).is_err());
        assert!(production_core::summarize_v1(std::slice::from_ref(&bad)).is_err());
        assert!(
            production_core::audit_v1(std::slice::from_ref(&bad), "test", "fixed-time", &[])
                .is_err()
        );
        assert!(production_core::frontier_v1(&bad).is_err());
        assert!(production_core::shard_v1(&bad, &json!(1)).is_err());
        assert!(production_core::resolve_artifact_v1(&bad).is_err());
    }
    for bad in [
        json!({"papers":"bad"}),
        json!({"papers":[null]}),
        json!({"summary":[]}),
        json!({"summary":{"state_counts":[]}}),
    ] {
        assert!(production_core::frontier_v1(&bad).is_err());
    }
    assert!(production_core::shard_v1(&json!({"slugs":"bad"}), &json!(1)).is_err());
    assert!(
        production_core::evaluate_snapshot_v1(
            &json!({"proof_readiness":{"failed_report_ids":"bad"}})
        )
        .is_err()
    );
    assert!(production_core::summarize_v1(&vec![json!({}); 1025]).is_err());
    assert!(
        production_core::resolve_artifact_v1(&json!({"requestedPackageCount":"9007199254740992"}))
            .is_err()
    );
    assert!(
        production_core::summarize_v1(&[
            json!({"proof_blocker_count":9007199254740991u64}),
            json!({"proof_blocker_count":1})
        ])
        .is_err()
    );
    let mut envelope: Value = serde_json::from_str(PRODUCTION_REPLAY_CORPUS_V1).unwrap();
    envelope["callerAcceptanceCount"] = json!(999);
    assert!(evaluate_production_replay_corpus_v1(&serde_json::to_vec(&envelope).unwrap()).is_err());
}
