//! Differential coverage for the read-only automation reconciliation plan.
//!
//! The fixture is created through the real Node migration/store path and the
//! same SQLite bytes are then inspected by the native binary.  Mutation,
//! receipt publication and external workers are intentionally out of scope.

use serde_json::Value;
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::atomic::{AtomicU64, Ordering},
};

const NOW: &str = "2026-07-13T08:00:00.000Z";
static NEXT: AtomicU64 = AtomicU64::new(0);

fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..")
}

fn run_node(
    database: &Path,
    prepare: bool,
    campaign_id: Option<&str>,
    no_progress_seconds: Option<&str>,
) -> Value {
    let mut command = Command::new("node");
    command.current_dir(root()).args([
        "rust/oracle/automation-runtime-reconciliation-v1.mjs",
        "--database",
        database.to_str().unwrap(),
        "--at",
        NOW,
    ]);
    if prepare {
        command.arg("--prepare");
    }
    if let Some(campaign_id) = campaign_id {
        command.args(["--campaign-id", campaign_id]);
    }
    if let Some(seconds) = no_progress_seconds {
        command.args(["--no-progress-seconds", seconds]);
    }
    let output = command.output().unwrap();
    assert!(
        output.status.success(),
        "node oracle failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap()
}

fn run_rust(
    database: &Path,
    campaign_id: Option<&str>,
    no_progress_seconds: Option<&str>,
) -> Value {
    let mut command = Command::new(env!("CARGO_BIN_EXE_hepta-automation-reconcile"));
    command.args(["--database", database.to_str().unwrap(), "--at", NOW]);
    if let Some(campaign_id) = campaign_id {
        command.args(["--campaign-id", campaign_id]);
    }
    if let Some(seconds) = no_progress_seconds {
        command.args(["--no-progress-seconds", seconds]);
    }
    let output = command.output().unwrap();
    assert!(
        output.status.success(),
        "rust reconciliation failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap()
}

fn database(label: &str) -> (PathBuf, PathBuf) {
    let directory = std::env::temp_dir().join(format!(
        "hepta-automation-reconciliation-{label}-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    fs::create_dir(&directory).unwrap();
    let path = directory.join("reconciliation.sqlite");
    (directory, path)
}

#[test]
fn clean_and_required_plans_match_node() {
    let (clean_root, clean_database) = database("clean");
    let node_clean = run_node(&clean_database, false, None, None);
    let rust_clean = run_rust(&clean_database, None, None);
    assert_eq!(rust_clean, node_clean);
    assert_eq!(
        rust_clean["status"],
        "automation_runtime_reconciliation_clean"
    );
    fs::remove_dir_all(clean_root).unwrap();

    let (required_root, required_database) = database("required");
    let node_required = run_node(&required_database, true, None, None);
    let before_native = fs::read(&required_database).unwrap();
    let rust_required = run_rust(&required_database, None, None);
    assert_eq!(fs::read(&required_database).unwrap(), before_native);
    assert_eq!(rust_required, node_required);
    assert_eq!(
        rust_required["status"],
        "automation_runtime_reconciliation_required"
    );
    assert_eq!(rust_required["expiredNodes"][0]["node_id"], "node-1");
    assert_eq!(
        rust_required["terminalCampaignActiveNodes"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert_eq!(
        rust_required["preservedLegacyTerminalNodes"][0]["node_id"],
        "node-6"
    );
    let node_zero = run_node(&required_database, false, None, Some("0"));
    let rust_zero = run_rust(&required_database, None, Some("0"));
    assert_eq!(rust_zero, node_zero);
    let node_negative = run_node(&required_database, false, None, Some("-1"));
    let rust_negative = run_rust(&required_database, None, Some("-1"));
    assert_eq!(rust_negative, node_negative);
    fs::remove_dir_all(required_root).unwrap();
}

#[test]
fn campaign_scope_and_errors_match_node_boundary() {
    let (directory, database) = database("scope");
    let _ = run_node(&database, true, None, None);
    let node = run_node(&database, false, Some("campaign-3"), None);
    let rust = run_rust(&database, Some("campaign-3"), None);
    assert_eq!(rust, node);
    assert_eq!(rust["campaignId"], "campaign-3");
    assert_eq!(rust["terminalCampaignQueuedNodes"][0]["node_id"], "node-3");
    assert!(rust["expiredNodes"].as_array().unwrap().is_empty());

    let output = Command::new(env!("CARGO_BIN_EXE_hepta-automation-reconcile"))
        .args([
            "--database",
            database.to_str().unwrap(),
            "--at",
            NOW,
            "--campaign-id",
            "bad id",
        ])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&output.stderr).contains("invalid"));
    fs::remove_dir_all(directory).unwrap();
}

#[test]
fn help_is_explicitly_read_only_and_mutation_free() {
    let output = Command::new(env!("CARGO_BIN_EXE_hepta-automation-reconcile"))
        .arg("--help")
        .output()
        .unwrap();
    assert!(output.status.success());
    let help: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(help["kind"], "AutomationRuntimeReconciliationUsage");
    assert_eq!(help["readOnly"], true);
    assert_eq!(help["externalActionPerformed"], false);
    assert_eq!(help["mutationSupported"], false);
}
