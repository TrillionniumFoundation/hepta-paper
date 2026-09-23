//! Byte-independent structural parity for the read-only Node `hepta-store status`
//! projection. The fixture is created by the real Node migration entrypoint;
//! Rust only opens the two resulting databases immutably.

use hepta_paper_service::store_status::{
    inspect_store_status_v1, inspect_store_status_with_options_v1,
};
use serde_json::Value;
use std::{
    fs,
    path::PathBuf,
    process::Command,
    sync::atomic::{AtomicU64, Ordering},
};

static NEXT: AtomicU64 = AtomicU64::new(1);

struct Fixture {
    root: PathBuf,
    runtime: PathBuf,
    database: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "hepta-rust-store-status-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        let workspace = root.join("workspace");
        let assets = root.join("assets");
        let runtime = root.join("runtime");
        let legacy = root.join("legacy");
        for path in [&workspace, &assets, &runtime, &legacy] {
            fs::create_dir(path).unwrap();
        }
        let repository = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
        let output = Command::new("node")
            .current_dir(&repository)
            .args(["paper-core/bin/hepta-store.mjs", "migrate"])
            .env("HEPTA_PAPER_WORKSPACE_ROOT", &workspace)
            .env("HEPTA_PAPER_ASSET_ROOT", &assets)
            .env("HEPTA_PAPER_RUNTIME_ROOT", &runtime)
            .env("PAPER_FACTORY_LEGACY_ROOT", &legacy)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "node migrate failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        Self {
            database: runtime.join("hepta-paper.sqlite"),
            root,
            runtime,
        }
    }

    fn node_status(&self) -> Value {
        let repository = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
        let workspace = self.root.join("workspace");
        let assets = self.root.join("assets");
        let legacy = self.root.join("legacy");
        let output = Command::new("node")
            .current_dir(&repository)
            .args(["paper-core/bin/hepta-store.mjs", "status"])
            .env("HEPTA_PAPER_WORKSPACE_ROOT", &workspace)
            .env("HEPTA_PAPER_ASSET_ROOT", &assets)
            .env("HEPTA_PAPER_RUNTIME_ROOT", &self.runtime)
            .env("PAPER_FACTORY_LEGACY_ROOT", &legacy)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "node status failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        serde_json::from_slice(&output.stdout).unwrap()
    }

    fn node_status_allow_isolated_verification_evidence(&self) -> Value {
        let repository = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
        let workspace = self.root.join("workspace");
        let assets = self.root.join("assets");
        let legacy = self.root.join("legacy");
        let output = Command::new("node")
            .current_dir(&repository)
            .args([
                "paper-core/bin/hepta-store.mjs",
                "status",
                "--allow-isolated-verification-evidence",
            ])
            .env("HEPTA_PAPER_WORKSPACE_ROOT", &workspace)
            .env("HEPTA_PAPER_ASSET_ROOT", &assets)
            .env("HEPTA_PAPER_RUNTIME_ROOT", &self.runtime)
            .env("PAPER_FACTORY_LEGACY_ROOT", &legacy)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "node status allow-isolated failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        serde_json::from_slice(&output.stdout).unwrap()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

#[test]
fn immutable_status_matches_node_with_metadata_and_handoff() {
    let fixture = Fixture::new();
    let node = fixture.node_status();
    assert!(!node["metadata"].as_array().unwrap().is_empty());
    assert_eq!(node["status"], "hepta_native_store_ready");
    let native = inspect_store_status_v1(&fixture.database, Some(&fixture.runtime)).unwrap();
    assert_eq!(native, node);
    let cli = Command::new(env!("CARGO_BIN_EXE_hepta-paper-rust"))
        .args([
            "store-status",
            fixture.database.to_str().unwrap(),
            fixture.runtime.to_str().unwrap(),
        ])
        .output()
        .unwrap();
    assert!(
        cli.status.success(),
        "rust store-status failed: {}",
        String::from_utf8_lossy(&cli.stderr)
    );
    assert_eq!(serde_json::from_slice::<Value>(&cli.stdout).unwrap(), node);

    // The incumbent `hepta-store status` discovers the database from the
    // runtime-root environment when no positional path is supplied. Keep the
    // unified Rust command surface compatible with that read-only default.
    let discovered = Command::new(env!("CARGO_BIN_EXE_hepta-paper-rust"))
        .arg("store-status")
        .env("HEPTA_PAPER_RUNTIME_ROOT", &fixture.runtime)
        .output()
        .unwrap();
    assert!(
        discovered.status.success(),
        "rust discovered store-status failed: {}",
        String::from_utf8_lossy(&discovered.stderr)
    );
    assert_eq!(
        serde_json::from_slice::<Value>(&discovered.stdout).unwrap(),
        node
    );

    let node_allowed = fixture.node_status_allow_isolated_verification_evidence();
    let allowed = Command::new(env!("CARGO_BIN_EXE_hepta-paper-rust"))
        .args([
            "store-status",
            fixture.database.to_str().unwrap(),
            fixture.runtime.to_str().unwrap(),
            "--allow-isolated-verification-evidence",
        ])
        .output()
        .unwrap();
    assert!(
        allowed.status.success(),
        "rust store-status allow-isolated failed: {}",
        String::from_utf8_lossy(&allowed.stderr)
    );
    assert_eq!(
        serde_json::from_slice::<Value>(&allowed.stdout).unwrap(),
        node_allowed
    );
}

#[test]
fn immutable_status_matches_node_when_handoff_is_missing() {
    let fixture = Fixture::new();
    let handoff = fixture
        .runtime
        .join("autonomous-research/submission-handoff/submission-handoff.sqlite");
    let moved = handoff.with_extension("sqlite.offline");
    fs::rename(&handoff, &moved).unwrap();
    let node = fixture.node_status();
    assert_eq!(node["status"], "hepta_native_store_blocked");
    assert_eq!(node["autonomousSubmissionHandoff"]["ready"], false);
    let native = inspect_store_status_v1(&fixture.database, Some(&fixture.runtime)).unwrap();
    assert_eq!(native, node);
    fs::rename(moved, handoff).unwrap();
}

#[test]
fn isolated_verification_option_preserves_production_contamination_blockers() {
    let fixture = Fixture::new();
    // Synthetic rows exercise only the passive classification projection.
    // They are not trusted receipts and cannot authorize any production action.
    let connection = rusqlite::Connection::open(&fixture.database).unwrap();
    connection
        .execute(
            "INSERT INTO receipt_ledger(receipt_id,stream,kind,status,receipt_json,
             receipt_sha256,created_at,environment,evidence_class)
             VALUES('test-isolated','test','FixtureReceipt','observed','{}',
             'sha256:fixture','2026-09-21T00:00:00.000Z','verification','technical_conformance')",
            [],
        )
        .unwrap();
    drop(connection);
    let normal = fixture.node_status();
    let allowed = fixture.node_status_allow_isolated_verification_evidence();
    assert_eq!(
        normal["receiptQualifications"]["unresolvedContaminatedReceiptCount"],
        1
    );
    assert_eq!(
        allowed["receiptQualifications"]["unresolvedContaminatedReceiptCount"],
        0
    );
    assert_eq!(normal["ready"], false);
    assert_eq!(allowed["ready"], true);
    assert_eq!(
        inspect_store_status_v1(&fixture.database, Some(&fixture.runtime)).unwrap(),
        normal
    );
    assert_eq!(
        inspect_store_status_with_options_v1(&fixture.database, Some(&fixture.runtime), true)
            .unwrap(),
        allowed
    );

    let connection = rusqlite::Connection::open(&fixture.database).unwrap();
    connection
        .execute(
            "INSERT INTO receipt_ledger(receipt_id,stream,kind,status,receipt_json,
             receipt_sha256,created_at,environment,evidence_class)
             VALUES('test-production','test','FixtureReceipt','observed','{}',
             'sha256:fixture','2026-09-21T00:00:00.000Z','production','runtime_unclassified')",
            [],
        )
        .unwrap();
    drop(connection);
    let blocked = fixture.node_status_allow_isolated_verification_evidence();
    assert_eq!(
        blocked["receiptQualifications"]["unresolvedContaminatedReceiptCount"],
        1
    );
    assert_eq!(blocked["ready"], false);
    assert_eq!(
        inspect_store_status_with_options_v1(&fixture.database, Some(&fixture.runtime), true)
            .unwrap(),
        blocked
    );
}
