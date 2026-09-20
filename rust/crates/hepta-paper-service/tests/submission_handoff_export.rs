use serde_json::Value;
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::PathBuf,
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};

fn root() -> PathBuf {
    let root = std::env::temp_dir().join(format!(
        "hepta-submission-export-route-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(&root).unwrap();
    fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
    root
}

#[test]
fn help_is_explicitly_read_only_and_missing_request_fails_closed() {
    let root = root();
    let help = Command::new(env!("CARGO_BIN_EXE_hepta-paper-rust"))
        .args(["submission-handoff-export", "--help"])
        .output()
        .unwrap();
    assert_eq!(help.status.code(), Some(0));
    assert!(
        String::from_utf8_lossy(&help.stdout)
            .contains("bounded read-only request/layout preflight")
    );

    let output = Command::new(env!("CARGO_BIN_EXE_hepta-paper-rust"))
        .args([
            "submission-handoff-export",
            "--campaign-id",
            "campaign-1",
            "--bundle-root",
        ])
        .arg(root.join("bundle"))
        .args(["--request"])
        .arg(root.join("missing.json"))
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(2));
    let report: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(
        report["status"],
        "submission_handoff_export_preflight_blocked"
    );
    assert_eq!(report["localFilesystemMutationPerformed"], false);
    assert_eq!(report["externalActionPerformed"], false);
    assert!(report["blockers"].as_array().unwrap().iter().any(|v| {
        v.as_str()
            .unwrap_or("")
            .starts_with("submission_handoff_export_request_open_blocked:")
    }));
    assert_eq!(fs::read_dir(&root).unwrap().count(), 0);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn export_action_is_never_reported_as_completed() {
    let root = root();
    let request = root.join("request.json");
    fs::write(&request, "{}").unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_hepta-paper-rust"))
        .args([
            "submission-handoff-export",
            "--action",
            "export",
            "--campaign-id",
            "campaign-1",
            "--bundle-root",
        ])
        .arg(root.join("bundle"))
        .args(["--request"])
        .arg(&request)
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(2));
    let report: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(report["status"], "submission_handoff_export_blocked");
    assert_eq!(
        report["blockers"][0],
        "rust_submission_handoff_export_publication_not_ported"
    );
    assert_eq!(report["localFilesystemMutationPerformed"], false);
    assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
    fs::remove_dir_all(root).unwrap();
}
