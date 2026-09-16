//! Differential checks for the read-only legacy archive retirement status.

use hepta_paper_service::retirement_status::inspect_retirement_status_v1;
use serde_json::Value;
use std::{
    fs,
    io::Write,
    process::{Command, Stdio},
};

fn fixture(name: &str) -> std::path::PathBuf {
    let root = std::env::temp_dir().join(format!(
        "hepta-retirement-status-{}-{name}",
        std::process::id()
    ));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(&root).expect("fixture root");
    root
}

fn oracle(requests: &Value) -> Value {
    let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let script = root.join("rust/oracle/retirement-status-v1.mjs");
    let mut child = Command::new("node")
        .arg(script)
        .current_dir(&root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .expect("Node oracle");
    child
        .stdin
        .take()
        .expect("stdin")
        .write_all(requests.to_string().as_bytes())
        .expect("request");
    let output = child.wait_with_output().expect("oracle output");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let value: Value = serde_json::from_slice(&output.stdout).expect("oracle JSON");
    assert_eq!(value["profile"]["node"], "v22.23.1");
    value
}

#[test]
fn retirement_status_matches_node_for_missing_and_archive_states() {
    let root = fixture("missing");
    let legacy = root.join("legacy");
    let runtime = root.join("runtime");
    let assets = root.join("assets");
    fs::create_dir_all(&legacy).expect("legacy");
    fs::create_dir_all(&runtime).expect("runtime");
    fs::create_dir_all(&assets).expect("assets");
    let mut request = serde_json::json!({
        "legacyRoot": legacy,
        "runtimeRoot": runtime,
        "assetRoot": assets,
        "version": "0.21.0"
    });
    let expected = oracle(&serde_json::json!([request.clone()]));
    let actual = inspect_retirement_status_v1(&request).expect("Rust report");
    assert_eq!(actual, expected["results"][0]["value"]);

    let archive_root = root.join("hepta-paper-legacy-reference/0.21.0");
    fs::create_dir_all(&archive_root).expect("archive root");
    fs::write(
        archive_root.join("paper-factory-control-plane-reference.tar.gz"),
        b"archive",
    )
    .expect("archive");
    request["legacyRoot"] = serde_json::json!(legacy);
    let expected = oracle(&serde_json::json!([request.clone()]));
    let actual = inspect_retirement_status_v1(&request).expect("Rust report");
    assert_eq!(actual, expected["results"][0]["value"]);
    let _ = fs::remove_dir_all(root);
}
