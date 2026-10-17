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

#[test]
fn retirement_reference_refuses_escape_alias_nonregular_and_unbounded_inputs() {
    use std::os::unix::fs::symlink;
    let root = fixture("unsafe");
    let receipt = root.join("RETIREMENT_SOURCE_SNAPSHOT_RECEIPT.json");
    let digest = format!("sha256:{:x}", Sha256::digest(b"retirement archive fixture"));
    for name in ["../outside", "/etc/passwd", "", ".", "control\nname"] {
        fs::write(
            &receipt,
            serde_json::json!({"archives":[{"name":name,"bytes":26,"sha256":digest}]}).to_string(),
        )
        .unwrap();
        let output = Command::new(env!("CARGO_BIN_EXE_hepta-paper-rust"))
            .arg("retirement-reference")
            .arg(&root)
            .output()
            .unwrap();
        assert!(!output.status.success());
        assert!(output.stdout.is_empty());
    }
    fs::write(
        &receipt,
        serde_json::json!({"archives":[{"name":"alias","bytes":26,"sha256":digest}]}).to_string(),
    )
    .unwrap();
    symlink(root.join("legacy.tar.zst"), root.join("alias")).unwrap();
    let check = || {
        let output = Command::new(env!("CARGO_BIN_EXE_hepta-paper-rust"))
            .arg("retirement-reference")
            .arg(&root)
            .output()
            .unwrap();
        assert!(!output.status.success());
        assert!(output.stdout.is_empty());
    };
    check();
    fs::remove_file(root.join("alias")).unwrap();
    fs::hard_link(root.join("legacy.tar.zst"), root.join("alias")).unwrap();
    check();
    fs::remove_file(root.join("alias")).unwrap();
    fs::create_dir(root.join("alias")).unwrap();
    check();
    fs::remove_dir(root.join("alias")).unwrap();
    let file = fs::File::create(root.join("alias")).unwrap();
    file.set_len(1024 * 1024 * 1024 + 1).unwrap();
    check();
    fs::write(&receipt, vec![b' '; 4 * 1024 * 1024 + 1]).unwrap();
    check();
    fs::write(&receipt, r#"{"archives":[],"archives":[]}"#).unwrap();
    let (status, report) = rust_result(&root);
    assert!(!status);
    assert_eq!(
        report["blockers"],
        serde_json::json!(["retirement_snapshot_receipt_missing_or_invalid"])
    );
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn retirement_reference_uses_fixed_attribute_tool_despite_ambient_path() {
    use std::os::unix::fs::PermissionsExt;
    let root = fixture("attributes");
    let bin = root.join("fake-bin");
    fs::create_dir(&bin).unwrap();
    let marker = root.join("fake-tool-ran");
    fs::write(
        bin.join("lsattr"),
        format!("#!/bin/sh\ntouch '{}'\necho i\n", marker.display()),
    )
    .unwrap();
    fs::set_permissions(bin.join("lsattr"), fs::Permissions::from_mode(0o755)).unwrap();
    fs::write(
        root.join("IMMUTABILITY_RECEIPT.json"),
        r#"{"files":[{"name":"legacy.tar.zst"}]}"#,
    )
    .unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_hepta-paper-rust"))
        .arg("retirement-reference")
        .arg(&root)
        .env("PATH", &bin)
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(!marker.exists());
    let report: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert!(
        report["blockers"]
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v == "archive_not_immutable:legacy.tar.zst"
                || v == "archive_immutability_unverifiable:legacy.tar.zst")
    );
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn retirement_reference_sigterm_cancels_an_actual_open_archive_without_results() {
    use std::{
        path::PathBuf,
        time::{Duration, Instant},
    };
    let root = fixture("cancel");
    let archive = root.join("legacy.tar.zst");
    fs::OpenOptions::new()
        .write(true)
        .open(&archive)
        .unwrap()
        .set_len(1024 * 1024 * 1024)
        .unwrap();
    fs::write(root.join("RETIREMENT_SOURCE_SNAPSHOT_RECEIPT.json"),serde_json::json!({"archives":[{"name":"legacy.tar.zst","bytes":1024u64*1024*1024,"sha256":format!("sha256:{}","0".repeat(64))}]}).to_string()).unwrap();
    let before = fs::metadata(&archive).unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_hepta-paper-rust"))
        .arg("retirement-reference")
        .arg(&root)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(30);
    let mut observed = false;
    while Instant::now() < deadline {
        let descriptors = fs::read_dir(format!("/proc/{}/fd", child.id())).unwrap();
        if descriptors
            .filter_map(Result::ok)
            .any(|entry| fs::read_link(entry.path()).is_ok_and(|p| p == archive))
        {
            observed = true;
            break;
        }
        assert!(
            child.try_wait().unwrap().is_none(),
            "archive stream ended before actual observation"
        );
        std::thread::sleep(Duration::from_millis(1));
    }
    assert!(observed, "archive descriptor was never actually opened");
    nix::sys::signal::kill(
        nix::unistd::Pid::from_raw(child.id() as i32),
        nix::sys::signal::Signal::SIGTERM,
    )
    .unwrap();
    let id = child.id();
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if child.try_wait().unwrap().is_some() {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "cancelled archive process survived"
        );
        std::thread::sleep(Duration::from_millis(5));
    }
    let output = child.wait_with_output().unwrap();
    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
    assert!(String::from_utf8_lossy(&output.stderr).contains("cancelled"));
    assert!(!PathBuf::from(format!("/proc/{id}")).exists());
    use std::os::unix::fs::MetadataExt;
    let after = fs::metadata(&archive).unwrap();
    assert_eq!(
        (
            before.dev(),
            before.ino(),
            before.len(),
            before.mtime(),
            before.ctime()
        ),
        (
            after.dev(),
            after.ino(),
            after.len(),
            after.mtime(),
            after.ctime()
        )
    );
    fs::remove_dir_all(root).unwrap();
}
