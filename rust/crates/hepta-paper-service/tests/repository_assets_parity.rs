//! Differential corpus for the Rust repository-asset verifier.

use hepta_paper_service::repository_assets::{
    build_repository_asset_externalization_handoff_v1, inspect_repository_asset_externalization_v1,
};
use serde_json::Value;
use std::{
    io::Write,
    process::{Command, Stdio},
};

fn oracle_requests(root: &str, manifests: Vec<(Value, bool)>) -> Value {
    let requests = Value::Array(manifests.into_iter().map(|(manifest, handoff)| {
        serde_json::json!({"repositoryRoot": root, "manifest": manifest, "handoff": handoff})
    }).collect());
    let oracle = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .join("rust/oracle/repository-assets-v1.mjs");
    let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let mut child = Command::new("node")
        .arg(oracle)
        .current_dir(root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .expect("Node 22.23.1 oracle runtime is required");
    child
        .stdin
        .take()
        .expect("oracle stdin")
        .write_all(requests.to_string().as_bytes())
        .expect("oracle request");
    let output = child.wait_with_output().expect("oracle process");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
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
    let cases = vec![
        (baseline.clone(), false),
        (baseline.clone(), true),
        (drift, false),
        (incomplete, false),
        (pinned, false),
        (duplicate, false),
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
