use serde_json::Value;
use std::{env, path::PathBuf, process::Command};

fn workspace_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..")
}

#[test]
fn help_describes_static_fail_closed_boundary() {
    let output = Command::new(env!("CARGO_BIN_EXE_hepta-paper-rust"))
        .args(["verify-full", "--help"])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(0));
    let report: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(report["kind"], "FullSuiteVerificationUsage");
    assert_eq!(report["semanticNotReadyExitCode"], 2);
}

#[test]
fn require_parity_reports_inventory_without_running_node_or_npm() {
    let root = workspace_root();
    let output = Command::new(env!("CARGO_BIN_EXE_hepta-paper-rust"))
        .args([
            "verify-full",
            "--workspace-root",
            root.to_str().unwrap(),
            "--require-parity",
            "--json",
        ])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(2));
    let report: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(report["status"], "verify_full_blocked");
    assert_eq!(report["parityAccepted"], false);
    assert_eq!(report["nodeExecutionPerformed"], false);
    assert_eq!(report["npmExecutionPerformed"], false);
    assert!(
        report["nodeTestManifest"]["testFileCount"]
            .as_u64()
            .unwrap()
            > 0
    );
    assert!(report["rustWorkspace"]["crateCount"].as_u64().unwrap() > 0);
}
