//! Differential checks for immutable legacy retirement-source verification.

use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Write,
    process::{Command, Stdio},
};

fn fixture(name: &str) -> std::path::PathBuf {
    let root = std::env::temp_dir().join(format!(
        "hepta-retirement-reference-{}-{}",
        std::process::id(),
        name
    ));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(&root).expect("fixture root");
    let data = b"retirement archive fixture";
    let digest = format!("sha256:{:x}", Sha256::digest(data));
    fs::write(root.join("legacy.tar.zst"), data).expect("archive");
    fs::write(
        root.join("RETIREMENT_SOURCE_SNAPSHOT_RECEIPT.json"),
        format!(
            r#"{{"archives":[{{"name":"legacy.tar.zst","bytes":{},"sha256":"{}"}}]}}"#,
            data.len(),
            digest
        ),
    )
    .expect("receipt");
    fs::write(root.join("IMMUTABILITY_RECEIPT.json"), r#"{"files":[]}"#)
        .expect("immutability receipt");
    root
}

fn oracle(requests: Value) -> Value {
    let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let script = root.join("rust/oracle/retirement-reference-v1.mjs");
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

fn rust_result(root: &std::path::Path) -> (bool, Value) {
    let output = Command::new(env!("CARGO_BIN_EXE_hepta-paper-rust"))
        .arg("retirement-reference")
        .arg(root)
        .output()
        .expect("Rust command");
    let stdout: Value = serde_json::from_slice(&output.stdout).expect("Rust report");
    (output.status.success(), stdout)
}

#[test]
fn retirement_reference_matches_node_for_verified_and_blocked_receipts() {
    let verified = fixture("verified");
    let blocked = fixture("blocked");
    fs::write(blocked.join("legacy.tar.zst"), b"tampered").expect("tamper archive");
    let requests = serde_json::json!([{"root": verified}, {"root": blocked}]);
    let expected = oracle(requests);
    let (verified_status, verified_result) = rust_result(&verified);
    let (blocked_status, blocked_result) = rust_result(&blocked);
    assert!(verified_status);
    assert!(!blocked_status);
    assert_eq!(verified_result, expected["results"][0]["value"]);
    assert_eq!(blocked_result, expected["results"][1]["value"]);
    let _ = fs::remove_dir_all(verified);
    let _ = fs::remove_dir_all(blocked);
}
