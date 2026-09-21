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

#[test]
fn retirement_status_uses_node_workspace_defaults_when_fields_are_omitted() {
    let request = serde_json::json!({});
    let expected = oracle(&serde_json::json!([request.clone()]));
    let actual = inspect_retirement_status_v1(&request).expect("Rust default report");
    assert_eq!(actual, expected["results"][0]["value"]);
}

#[test]
fn retirement_status_normalizes_explicit_version_like_node_path_join() {
    let root = fixture("version-path");
    let request_base = serde_json::json!({
        "legacyRoot": root.join("legacy"),
        "runtimeRoot": root.join("runtime"),
        "assetRoot": root.join("assets")
    });
    for version in [
        "", ".", "./", "..", "../", "/abs", "/abs/", "a//b", "a//b/", "a/../b",
    ] {
        let mut request = request_base.clone();
        request["version"] = Value::String(version.to_owned());
        let expected = oracle(&serde_json::json!([request.clone()]));
        let actual = inspect_retirement_status_v1(&request).expect("Rust version report");
        assert_eq!(
            actual, expected["results"][0]["value"],
            "version={version:?}"
        );
        let request_path = root.join("request.json");
        fs::write(
            &request_path,
            serde_json::to_vec(&request).expect("request JSON"),
        )
        .expect("request file");
        let output = std::process::Command::new(env!("CARGO_BIN_EXE_hepta-paper-rust"))
            .args([
                "retirement-status",
                request_path.to_str().expect("UTF-8 path"),
            ])
            .output()
            .expect("Rust retirement-status CLI");
        assert!(
            output.status.success(),
            "version={version:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let cli: Value = serde_json::from_slice(&output.stdout).expect("CLI JSON");
        assert_eq!(cli, expected["results"][0]["value"], "version={version:?}");
    }
    let _ = fs::remove_dir_all(root);
}

#[test]
fn retirement_status_cli_uses_node_defaults_without_a_request_file() {
    let expected = oracle(&serde_json::json!([{}]));
    let output = std::process::Command::new(env!("CARGO_BIN_EXE_hepta-paper-rust"))
        .arg("retirement-status")
        .output()
        .expect("Rust retirement-status CLI");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let actual: Value = serde_json::from_slice(&output.stdout).expect("Rust report JSON");
    assert_eq!(actual, expected["results"][0]["value"]);
}

#[cfg(unix)]
#[test]
fn retirement_status_preserves_node_lexical_paths_for_symlink_roots() {
    let root = fixture("symlink");
    let target = root.join("legacy-target");
    let link = root.join("legacy-link");
    fs::create_dir_all(&target).expect("legacy target");
    std::os::unix::fs::symlink(&target, &link).expect("legacy link");
    let request = serde_json::json!({
        "legacyRoot": link,
        "runtimeRoot": root.join("runtime"),
        "assetRoot": root.join("assets"),
        "version": "0.21.0"
    });
    let expected = oracle(&serde_json::json!([request.clone()]));
    let actual = inspect_retirement_status_v1(&request).expect("Rust symlink report");
    assert_eq!(actual, expected["results"][0]["value"]);
    let _ = fs::remove_dir_all(root);
}

#[cfg(unix)]
#[test]
fn retirement_status_reports_node_physical_overlap_and_workspace_blockers() {
    let root = fixture("overlap");
    let target = root.join("target");
    let link = root.join("legacy-link");
    fs::create_dir_all(&target).expect("target");
    std::os::unix::fs::symlink(&target, &link).expect("legacy link");
    let workspace = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let requests = serde_json::json!([
        {"legacyRoot":link,"runtimeRoot":target,"assetRoot":root.join("assets"),"version":"0.21.0"},
        {"legacyRoot":root.join("legacy"),"runtimeRoot":workspace,"assetRoot":root.join("assets"),"version":"0.21.0"}
    ]);
    let expected = oracle(&requests);
    for (index, request) in requests.as_array().expect("requests").iter().enumerate() {
        let actual = inspect_retirement_status_v1(request).expect("Rust overlap report");
        assert_eq!(actual, expected["results"][index]["value"]);
        assert_eq!(actual["layoutPhysicallyDecoupled"], false);
    }
    let _ = fs::remove_dir_all(root);
}
