//! Differential checks for the local command-surface package synchronization.

use serde_json::Value;
use std::{
    fs,
    io::Write,
    process::{Command, Stdio},
};

fn temp_fixture() -> std::path::PathBuf {
    let path = std::env::temp_dir().join(format!("hepta-command-surface-{}", std::process::id()));
    let _ = fs::remove_dir_all(&path);
    fs::create_dir_all(&path).expect("fixture directory");
    fs::write(path.join("package.json"), r#"{"name":"fixture","scripts":{"test":"old","store:status":"old","custom":"echo custom"}}"#).expect("fixture package");
    path
}

fn oracle(requests: Value) -> Value {
    let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let script = root.join("rust/oracle/command-surface-v1.mjs");
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
        .expect("oracle stdin")
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

fn rust_result(root: &std::path::Path, write_package: bool) -> Value {
    let binary = env!("CARGO_BIN_EXE_hepta-paper-rust");
    let mut command = Command::new(binary);
    command.arg("command-surface").arg(root);
    if write_package {
        command.arg("--write-package");
    }
    let output = command.output().expect("Rust command");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).expect("Rust JSON")
}

#[test]
fn package_surface_check_and_write_match_node_oracle() {
    let fixture = temp_fixture();
    let oracle_fixture = fixture.with_file_name(format!(
        "{}-oracle",
        fixture.file_name().unwrap().to_string_lossy()
    ));
    fs::create_dir_all(&oracle_fixture).expect("oracle fixture directory");
    fs::copy(
        fixture.join("package.json"),
        oracle_fixture.join("package.json"),
    )
    .expect("oracle fixture package");
    let requests = serde_json::json!([
        {"root": oracle_fixture, "writePackage": false},
        {"root": oracle_fixture, "writePackage": true},
    ]);
    let expected = oracle(requests);
    assert_eq!(
        rust_result(&fixture, false),
        expected["results"][0]["value"]
    );
    assert_eq!(rust_result(&fixture, true), expected["results"][1]["value"]);
    let _ = fs::remove_dir_all(fixture);
    let _ = fs::remove_dir_all(oracle_fixture);
}
