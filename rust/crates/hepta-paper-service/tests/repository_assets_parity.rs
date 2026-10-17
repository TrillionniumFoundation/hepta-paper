//! Differential corpus for the Rust repository-asset verifier.

use hepta_codex_runtime::{
    BoundedProcessRequestV1, EnvironmentPolicyV1, ProcessLimitsV1, ProcessTerminationReason,
    run_bounded_process_capturing_stdout_with_cancellation,
};
use hepta_paper_service::repository_assets::{
    build_repository_asset_externalization_handoff_v1, inspect_repository_asset_externalization_v1,
};
use serde_json::Value;
use std::{collections::BTreeMap, path::PathBuf, sync::atomic::AtomicBool};

fn oracle_requests(root: &str, manifests: Vec<(Value, bool)>) -> Value {
    let requests = Value::Array(manifests.into_iter().map(|(manifest, handoff)| {
        serde_json::json!({"repositoryRoot": root, "manifest": manifest, "handoff": handoff})
    }).collect());
    let oracle = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .join("rust/oracle/repository-assets-v1.mjs");
    let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let selected_node =
        PathBuf::from(std::env::var_os("HEPTA_TEST_NODE").unwrap_or_else(|| "node".into()));
    let node = if selected_node.components().count() == 1 {
        std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default())
            .map(|p| p.join(&selected_node))
            .find(|p| p.is_file())
            .expect("qualified Node oracle")
    } else {
        selected_node
    }
    .canonicalize()
    .unwrap();
    let request = BoundedProcessRequestV1 {
        executable: node,
        arguments: vec![oracle.into_os_string()],
        working_directory: root.canonicalize().unwrap(),
        environment: EnvironmentPolicyV1::new(
            "repository-assets-oracle-v1",
            ["PATH", "TZ"],
            ["PATH"],
        )
        .unwrap()
        .build(std::env::vars_os(), &BTreeMap::new())
        .unwrap(),
        stdin: Some(serde_json::to_vec(&requests).unwrap()),
    };
    let output = run_bounded_process_capturing_stdout_with_cancellation(
        &request,
        ProcessLimitsV1 {
            timeout_ms: 60_000,
            maximum_stdin_bytes: 4 * 1024 * 1024,
            maximum_stdout_bytes: 4 * 1024 * 1024,
            maximum_stderr_bytes: 1024 * 1024,
            maximum_tail_bytes: 64 * 1024,
            ..ProcessLimitsV1::default()
        },
        &AtomicBool::new(false),
    )
    .unwrap();
    assert!(
        output.process.termination_reason == ProcessTerminationReason::Exited
            && output.process.exit_code == Some(0)
            && output.process.signal.is_none()
            && output.process.process_group_cleanup_verified,
        "{:?}",
        output.process
    );
    let response: Value = serde_json::from_slice(&output.stdout).expect("oracle JSON");
    assert_eq!(response["profile"]["node"], "v22.23.1");
    response
}

fn rust_result(root: &std::path::Path, manifest: &Value, handoff: bool) -> Value {
    match if handoff {
        build_repository_asset_externalization_handoff_v1(root, manifest)
    } else {
        inspect_repository_asset_externalization_v1(root, manifest)
    } {
        Ok(value) => serde_json::json!({"ok": true, "value": value}),
        Err(error) => serde_json::json!({"ok": false, "error": error.to_string()}),
    }
}

#[test]
fn repository_asset_inspection_and_handoff_match_node_oracle() {
    let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let root_text = root.to_str().expect("repository root");
    let baseline: Value = serde_json::from_str(include_str!(
        "../../../../paper-core/config/repository-asset-externalization.v1.json"
    ))
    .expect("manifest");
    let mut drift = baseline.clone();
    drift["assets"][0]["expectedIdentitySha256"] =
        Value::String(format!("sha256:{}", "0".repeat(64)));
    let mut incomplete = baseline.clone();
    incomplete["assets"][0]
        .as_object_mut()
        .expect("asset object")
        .remove("externalReference");
    let mut pinned = baseline.clone();
    pinned["assets"][0]["externalReference"]["pinnedCommit"] = Value::String("0".repeat(40));
    pinned["assets"][0]["externalReference"]["location"] = Value::String(format!(
        "https://github.com/TrillionniumFoundation/hepta-paper-r-source-cas.git#{}",
        "0".repeat(40)
    ));
    let mut duplicate = baseline.clone();
    duplicate["assets"][1]["assetId"] = duplicate["assets"][0]["assetId"].clone();
    // Node skips the optional git-submodule binding verifier when transport is
    // omitted. This exercises that guard while retaining the generic
    // external-reference and restore-receipt checks.
    let mut transport_omitted = baseline.clone();
    transport_omitted["assets"][0]["externalReference"]
        .as_object_mut()
        .expect("external reference object")
        .remove("transport");
    let cases = vec![
        (baseline.clone(), false),
        (baseline.clone(), true),
        (drift.clone(), false),
        (drift, true),
        (incomplete, false),
        (pinned, false),
        (duplicate, false),
        (transport_omitted, false),
    ];
    let oracle = oracle_requests(root_text, cases.clone());
    for (index, (manifest, handoff)) in cases.iter().enumerate() {
        assert_eq!(
            rust_result(&root, manifest, *handoff),
            oracle["results"][index],
            "case {index}"
        );
    }
}

#[path = "repository_assets_parity/domains.rs"]
mod domains;
