//! CLI coverage for the bounded dispatcher preflight.

use serde_json::Value;
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::PathBuf,
    process::Command,
    sync::atomic::{AtomicU64, Ordering},
};

static NEXT: AtomicU64 = AtomicU64::new(0);

fn root() -> PathBuf {
    let root = std::env::temp_dir().join(format!(
        "hepta-dispatcher-cli-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    fs::create_dir(&root).unwrap();
    fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
    root
}

#[test]
fn help_is_json_and_does_not_require_dispatcher_authority() {
    let output = Command::new(env!("CARGO_BIN_EXE_hepta-paper-rust"))
        .args(["autonomous-submission-dispatcher", "--help"])
        .output()
        .unwrap();
    assert!(output.status.success());
    let report: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(report["kind"], "AutonomousSubmissionDispatcherUsage");
    assert_eq!(report["externalAction"], false);
}

#[test]
fn status_is_fail_closed_on_missing_exchange() {
    let root = root();
    let output = Command::new(env!("CARGO_BIN_EXE_hepta-paper-rust"))
        .args([
            "autonomous-submission-dispatcher",
            "--runtime-root",
            root.to_str().unwrap(),
            "--limit",
            "1",
        ])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(2));
    let report: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(report["ready"], false);
    assert_eq!(report["networkActionPerformed"], false);
    assert!(
        report["blockers"]
            .as_array()
            .unwrap()
            .iter()
            .any(|value| value == "autonomous_submission_dispatcher_challenge_missing")
    );
    fs::remove_dir_all(root).unwrap();
}
