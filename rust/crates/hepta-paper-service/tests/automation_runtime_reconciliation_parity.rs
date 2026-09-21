//! Differential coverage for the plan and guarded local execution command.
//!
//! The fixture is created through the real Node migration/store path and the
//! same SQLite bytes are then consumed by the native binary. Execution requires
//! an explicitly established local cutover; no production or external workers.

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
    run_node_at(database, prepare, campaign_id, no_progress_seconds, NOW)
}

fn run_node_at(
    database: &Path,
    prepare: bool,
    campaign_id: Option<&str>,
    no_progress_seconds: Option<&str>,
    now: &str,
) -> Value {
    let mut command = Command::new("node");
    command.current_dir(root()).args([
        "rust/oracle/automation-runtime-reconciliation-v1.mjs",
        "--database",
        database.to_str().unwrap(),
        "--at",
        now,
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
    run_rust_at(database, campaign_id, no_progress_seconds, NOW)
}

fn run_rust_at(
    database: &Path,
    campaign_id: Option<&str>,
    no_progress_seconds: Option<&str>,
    now: &str,
) -> Value {
    let mut command = Command::new(env!("CARGO_BIN_EXE_hepta-automation-reconcile"));
    command.args(["--database", database.to_str().unwrap(), "--at", now]);
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
fn fractional_no_progress_cutoffs_and_hashes_match_node() {
    let (directory, database) = database("fractional-cutoff");
    let _ = run_node(&database, true, None, None);
    // A campaign exactly on the old rounded boundary must not be selected by
    // the true fractional cutoff. This checks row selection as well as hashes.
    {
        let connection = rusqlite::Connection::open(&database).unwrap();
        connection.execute(
            "UPDATE paper_campaigns SET updated_at='2026-07-13T07:59:00.000Z' WHERE campaign_id='campaign-2'",
            [],
        ).unwrap();
    }
    for now in [NOW, "1970-01-01T00:00:00.000Z", "1970-01-01T00:01:00.000Z"] {
        for seconds in ["60.0001", "60.0005", "60.0009", "1800.0001"] {
            let node = run_node_at(&database, false, None, Some(seconds), now);
            assert!(node["noProgressCampaigns"].as_array().unwrap().is_empty());
            let before = fs::read(&database).unwrap();
            let rust = run_rust_at(&database, None, Some(seconds), now);
            assert_eq!(fs::read(&database).unwrap(), before);
            assert_eq!(rust, node, "now: {now}, no-progress seconds: {seconds}");
        }
    }
    fs::remove_dir_all(directory).unwrap();
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
fn help_is_read_only_and_declares_guarded_local_execution() {
    let output = Command::new(env!("CARGO_BIN_EXE_hepta-automation-reconcile"))
        .arg("--help")
        .output()
        .unwrap();
    assert!(output.status.success());
    let help: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(help["kind"], "AutomationRuntimeReconciliationUsage");
    assert_eq!(help["readOnly"], true);
    assert_eq!(help["externalActionPerformed"], false);
    assert_eq!(help["localMutationSupported"], true);
    assert_eq!(help["productionMutationSupported"], false);
    assert!(
        help["localExecuteUsage"]
            .as_str()
            .unwrap()
            .contains("--execute-local")
    );
}

#[test]
fn local_execute_cli_consumes_existing_epoch_and_matches_node_receipt() {
    use hepta_cutover::{DurableCutoverCoordinatorV1, DurableCutoverModeV1};
    use hepta_paper_service::automation_runtime_reconciliation::{
        LOCAL_RECONCILIATION_WRITER_ID_V1, LocalOfflineReconciliationRequestV1,
        RECONCILIATION_WRITER_SCOPE_V1,
    };
    use std::os::unix::fs::PermissionsExt;
    let (directory, original) = database("local-cli");
    fs::set_permissions(&directory, fs::Permissions::from_mode(0o700)).unwrap();
    let node_plan = run_node(&original, true, None, None);
    for name in ["workspace", "assets", "runtime", "legacy"] {
        fs::create_dir(directory.join(name)).unwrap();
        fs::set_permissions(directory.join(name), fs::Permissions::from_mode(0o700)).unwrap();
    }
    let native = directory.join("runtime/hepta-paper.sqlite");
    fs::copy(&original, &native).unwrap();
    fs::set_permissions(&native, fs::Permissions::from_mode(0o600)).unwrap();
    let rust_plan = run_rust(&native, None, None);
    let mut coordinator = DurableCutoverCoordinatorV1::create(
        &native,
        "cli-reconciliation",
        "node",
        LOCAL_RECONCILIATION_WRITER_ID_V1,
        DurableCutoverModeV1::LocalDrill,
    )
    .unwrap();
    coordinator.quiesce(0).unwrap();
    coordinator
        .backup_restore_drill(
            1,
            &directory.join("backup.sqlite"),
            &directory.join("restore.sqlite"),
        )
        .unwrap();
    coordinator
        .compare_shadow(
            2,
            "measured-plan",
            &serde_json::to_vec(&node_plan).unwrap(),
            &serde_json::to_vec(&rust_plan).unwrap(),
        )
        .unwrap();
    let fence = coordinator
        .start_local_canary(3, vec![RECONCILIATION_WRITER_SCOPE_V1.into()])
        .unwrap()
        .writer_fence()
        .unwrap();
    let request = LocalOfflineReconciliationRequestV1 {
        version: 1,
        workspace_root: directory.join("workspace"),
        asset_root: directory.join("assets"),
        runtime_root: directory.join("runtime"),
        legacy_root: directory.join("legacy"),
        writer_fence: fence,
        now: NOW.into(),
        no_progress_seconds: 1800.0,
        campaign_id: None,
        release_commit: None,
    };
    let request_path = directory.join("request.json");
    fs::write(&request_path, serde_json::to_vec(&request).unwrap()).unwrap();
    let node = Command::new("node")
        .arg(root().join("rust/oracle/automation-runtime-reconciliation-execute-v1.mjs"))
        .args(["--database", original.to_str().unwrap(), "--at", NOW])
        .env_remove("HEPTA_RELEASE_COMMIT")
        .output()
        .unwrap();
    assert!(
        node.status.success(),
        "{}",
        String::from_utf8_lossy(&node.stderr)
    );
    let node: Value = serde_json::from_slice(&node.stdout).unwrap();
    assert_eq!(node["ok"], true);
    let output = Command::new(env!("CARGO_BIN_EXE_hepta-automation-reconcile"))
        .args(["--execute-local", request_path.to_str().unwrap()])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let report: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(report["reconciliation"], node["receipts"][0]);
    assert_eq!(report["productionActivation"], false);
    assert_eq!(report["nodeRetirementVerified"], false);
    coordinator.rollback_local(4).unwrap();
    let before = fs::read(&native).unwrap();
    let rejected = Command::new(env!("CARGO_BIN_EXE_hepta-automation-reconcile"))
        .args(["--execute-local", request_path.to_str().unwrap()])
        .output()
        .unwrap();
    assert_eq!(rejected.status.code(), Some(2));
    assert_eq!(fs::read(&native).unwrap(), before);
    drop(coordinator);
    fs::remove_dir_all(directory).unwrap();
}

#[test]
fn duplicate_campaign_arguments_match_node_before_help_or_store_access() {
    const ERROR: &str = "automation_runtime_reconciliation_campaign_id_duplicate";
    let (directory, absent_database) = database("duplicate-campaign");
    let absent_runtime = directory.join("absent-runtime");
    let absent_assets = directory.join("absent-assets");
    for arguments in [
        vec!["--campaign-id", "campaign-3", "--campaign-id", "campaign-4"],
        vec!["--campaign-id=campaign-3", "--campaign-id=campaign-4"],
        vec!["--campaign-id", "campaign-3", "--campaign-id=campaign-4"],
        vec!["--campaign-id=", "--campaign-id"],
        vec!["--campaign-id", "--campaign-id"],
        vec![
            "--help",
            "--campaign-id=campaign-3",
            "--campaign-id=campaign-4",
        ],
        vec![
            "--unknown",
            "--campaign-id=campaign-3",
            "--campaign-id=campaign-4",
        ],
    ] {
        let node = Command::new("node")
            .arg(root().join("paper-core/bin/automation-reconcile.mjs"))
            .args(&arguments)
            .env("HEPTA_PAPER_RUNTIME_ROOT", &absent_runtime)
            .env("HEPTA_PAPER_ASSET_ROOT", &absent_assets)
            .output()
            .unwrap();
        let native = Command::new(env!("CARGO_BIN_EXE_hepta-automation-reconcile"))
            .args(["--database", absent_database.to_str().unwrap(), "--at", NOW])
            .args(&arguments)
            .output()
            .unwrap();
        assert_eq!(node.status.code(), Some(1), "{arguments:?}");
        assert_eq!(native.status.code(), node.status.code(), "{arguments:?}");
        assert!(
            String::from_utf8_lossy(&node.stderr).contains(ERROR),
            "{arguments:?}"
        );
        assert_eq!(
            String::from_utf8_lossy(&native.stderr).trim(),
            ERROR,
            "{arguments:?}"
        );
        assert!(node.stdout.is_empty(), "{arguments:?}");
        assert!(native.stdout.is_empty(), "{arguments:?}");
        assert!(!absent_database.exists());
        assert!(!absent_runtime.exists());
        assert!(!absent_assets.exists());
    }
    fs::remove_dir_all(directory).unwrap();
}
