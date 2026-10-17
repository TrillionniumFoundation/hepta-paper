//! Differential coverage for the read-only personal self-hosted profile.
//!
//! These cases use the current repository only as a provenance oracle and an
//! empty, owner-only runtime root.  No receipt, database, provider, GPU or
//! external authority is manufactured by the test.

use serde_json::Value;
use std::{
    fs,
    io::Write,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::Command,
    process::Stdio,
    sync::atomic::{AtomicU64, Ordering},
};

static NEXT: AtomicU64 = AtomicU64::new(0);
const NOW: &str = "2026-09-20T00:00:00.000Z";

fn repository_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..")
}

fn runtime_fixture() -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "hepta-personal-readiness-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    fs::create_dir(&path).expect("create runtime fixture");
    fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).expect("private runtime");
    path
}

fn run_rust(runtime: &Path, extra: &[&str]) -> (i32, Value) {
    let root = repository_root();
    let mut args = vec![
        "personal-self-hosted-readiness",
        "--root",
        root.to_str().expect("repo utf8"),
        "--runtime-root",
        runtime.to_str().expect("runtime utf8"),
        "--now",
        NOW,
    ];
    args.extend_from_slice(extra);
    let output = Command::new(env!("CARGO_BIN_EXE_hepta-paper-rust"))
        .args(args)
        .output()
        .expect("run Rust personal readiness");
    let status = output.status.code().unwrap_or(-1);
    let value = serde_json::from_slice(&output.stdout).unwrap_or_else(|error| {
        panic!(
            "Rust personal readiness JSON: {error}; stderr={}",
            String::from_utf8_lossy(&output.stderr)
        )
    });
    (status, value)
}

fn run_node(runtime: &Path, extra: &[&str]) -> (i32, Value) {
    let root = repository_root();
    let mut args = vec![
        "paper-core/bin/personal-self-hosted-readiness.mjs",
        "--root",
        root.to_str().expect("repo utf8"),
        "--runtime-root",
        runtime.to_str().expect("runtime utf8"),
        "--now",
        NOW,
    ];
    args.extend_from_slice(extra);
    let output = Command::new("node")
        .current_dir(repository_root())
        .args(args)
        .output()
        .expect("run Node personal readiness");
    let status = output.status.code().unwrap_or(-1);
    let value = serde_json::from_slice(&output.stdout).unwrap_or_else(|error| {
        panic!(
            "Node personal readiness JSON: {error}; stderr={}",
            String::from_utf8_lossy(&output.stderr)
        )
    });
    (status, value)
}

fn provision_ready_local_database(runtime: &Path) {
    let root = repository_root();
    let mut child = Command::new("node")
        .current_dir(&root)
        .args([
            "--input-type=module",
            "-",
            root.to_str().expect("repo utf8"),
            runtime.to_str().expect("runtime utf8"),
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn Node local database fixture");
    child
        .stdin
        .take()
        .expect("Node fixture stdin")
        .write_all(
            br#"
import { createDefaultPaperStore } from './paper-adapters/persistence/store-provider.mjs';
import {
  createPersonalDatabaseBackup,
  recordPersonalDatabaseAntiRollback,
  restoreDrillPersonalDatabase,
} from './paper-adapters/persistence/personal-local-database-readiness.mjs';
const [, runtimeRoot] = process.argv.slice(2);
const dbPath = `${runtimeRoot}/hepta-paper.sqlite`;
const store = createDefaultPaperStore({
  root: process.cwd(), runtimeRoot, dbPath, targetVersion: 25,
});
store.close();
await recordPersonalDatabaseAntiRollback({ runtimeRoot });
const backup = await createPersonalDatabaseBackup({ runtimeRoot });
await restoreDrillPersonalDatabase({ runtimeRoot, backupPath: backup.backupPath });
"#,
        )
        .expect("write Node local database fixture");
    let output = child
        .wait_with_output()
        .expect("wait for Node local database fixture");
    assert!(
        output.status.success(),
        "Node local database fixture failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn help_metadata_matches_node() {
    let rust = Command::new(env!("CARGO_BIN_EXE_hepta-paper-rust"))
        .args(["personal-self-hosted-readiness", "--help"])
        .output()
        .expect("Rust help");
    assert!(rust.status.success());
    let node = Command::new("node")
        .current_dir(repository_root())
        .args([
            "paper-core/bin/personal-self-hosted-readiness.mjs",
            "--help",
        ])
        .output()
        .expect("Node help");
    assert!(node.status.success());
    let rust: Value = serde_json::from_slice(&rust.stdout).expect("Rust help JSON");
    let node: Value = serde_json::from_slice(&node.stdout).expect("Node help JSON");
    assert_eq!(rust, node);
}

#[test]
fn missing_local_evidence_matches_node_exactly() {
    let runtime = runtime_fixture();
    let (rust_status, rust) = run_rust(&runtime, &[]);
    let (node_status, node) = run_node(&runtime, &[]);
    assert_eq!(rust_status, 0);
    assert_eq!(node_status, 0);
    assert_eq!(rust, node);
    assert_eq!(rust["personalSelfHostedProductionReady"], false);
    assert_eq!(rust["externalActionsPerformed"], false);
    fs::remove_dir_all(runtime).expect("remove runtime fixture");
}

#[test]
fn missing_runtime_root_preserves_node_catch_boundary() {
    let runtime = runtime_fixture();
    fs::remove_dir_all(&runtime).expect("remove runtime fixture before inspection");
    let (rust_status, rust) = run_rust(&runtime, &[]);
    let (node_status, node) = run_node(&runtime, &[]);
    assert_eq!(rust_status, 0);
    assert_eq!(node_status, 0);
    assert_eq!(rust, node);
    assert_eq!(
        rust["controlResults"]["database-inventory-and-schema"]["details"]["blockers"],
        serde_json::json!(["personal_database_runtime_root_unsafe"])
    );
}

#[test]
fn gpu_opt_in_missing_evidence_matches_node_and_require_ready_blocks() {
    let runtime = runtime_fixture();
    let (rust_status, rust) = run_rust(&runtime, &["--gpu-enabled"]);
    let (node_status, node) = run_node(&runtime, &["--gpu-enabled"]);
    assert_eq!(rust_status, 0);
    assert_eq!(node_status, 0);
    assert_eq!(rust, node);
    assert_eq!(rust["scientificCapabilities"]["gpu"]["enabled"], true);

    let (status, report) = run_rust(&runtime, &["--require-ready"]);
    assert_eq!(status, 2);
    assert_eq!(report["personalSelfHostedProductionReady"], false);
    fs::remove_dir_all(runtime).expect("remove runtime fixture");
}

#[test]
fn safe_local_database_ledger_backup_and_restore_match_node() {
    let runtime = runtime_fixture();
    provision_ready_local_database(&runtime);
    let (rust_status, rust) = run_rust(&runtime, &[]);
    let (node_status, node) = run_node(&runtime, &[]);
    assert_eq!(rust_status, 0);
    assert_eq!(node_status, 0);
    assert_eq!(rust, node);
    assert_eq!(
        rust["controlResults"]["database-inventory-and-schema"]["status"],
        "verified"
    );
    assert_eq!(
        rust["controlResults"]["online-anti-rollback"]["status"],
        "verified"
    );
    assert_eq!(
        rust["controlResults"]["database-restore-drill"]["status"],
        "verified"
    );
    fs::remove_dir_all(runtime).expect("remove runtime fixture");
}

#[test]
fn personal_readiness_executes_without_a_node_runtime() {
    // The Node executable is a differential *test* oracle, never a runtime
    // dependency or fallback for the private Rust production observer.
    let runtime = runtime_fixture();
    let bin = runtime.join("bin");
    fs::create_dir(&bin).expect("create tripwire directory");
    fs::set_permissions(&bin, fs::Permissions::from_mode(0o700)).expect("private tripwire");
    let marker = runtime.join("node-executed");
    let node = bin.join("node");
    fs::write(
        &node,
        b"#!/bin/sh\nprintf 'invoked\\n' > \"$HEPTA_NODE_TRIPWIRE\"\nexit 93\n",
    )
    .expect("write Node tripwire");
    fs::set_permissions(&node, fs::Permissions::from_mode(0o700)).expect("executable tripwire");

    let path = format!(
        "{}:{}",
        bin.display(),
        std::env::var("PATH").unwrap_or_default()
    );
    for require_ready in [false, true] {
        let root = repository_root();
        let mut args = vec![
            "personal-self-hosted-readiness",
            "--root",
            root.to_str().expect("repository UTF-8"),
            "--runtime-root",
            runtime.to_str().expect("runtime UTF-8"),
            "--now",
            NOW,
        ];
        if require_ready {
            args.push("--require-ready");
        }
        let output = Command::new(env!("CARGO_BIN_EXE_hepta-paper-rust"))
            .args(args)
            .env("PATH", &path)
            .env("HEPTA_TEST_NODE", &node)
            .env("HEPTA_NODE_TRIPWIRE", &marker)
            .output()
            .expect("execute Rust readiness with poisoned Node");
        assert_eq!(
            output.status.code(),
            Some(if require_ready { 2 } else { 0 }),
            "Rust readiness exit: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let report: Value =
            serde_json::from_slice(&output.stdout).expect("native readiness JSON");
        assert_eq!(report["personalSelfHostedProductionReady"], false);
        assert_eq!(report["externalActionsPerformed"], false);
        assert!(!marker.exists(), "Rust readiness invoked a Node runtime");
    }
    fs::remove_dir_all(runtime).expect("remove private tripwire");
}
