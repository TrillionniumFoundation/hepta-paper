//! Byte-independent structural parity for the read-only Node `hepta-store status`
//! projection. The fixture is created by the real Node migration entrypoint;
//! Rust observes the resulting databases through physical read-only connections.

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

type InventoryEntry = (PathBuf, u64, u64, u32, u32, u32, u64, i128, i128, Vec<u8>);

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
        // These tests assert zero physical effects on a closed DELETE-mode
        // database. Cold/live WAL coordination has its own actual CLI matrix.
        let connection = rusqlite::Connection::open(runtime.join("hepta-paper.sqlite")).unwrap();
        connection
            .execute_batch("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE;")
            .unwrap();
        drop(connection);
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

impl Fixture {
    fn ordinary(&self, native: bool, arguments: &[&str]) -> std::process::Output {
        let repository = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
        let mut command = if native {
            Command::new(env!("CARGO_BIN_EXE_hepta-paper-rust"))
        } else {
            let mut command = Command::new("node");
            command.args([
                "--disable-warning=ExperimentalWarning",
                "paper-core/bin/hepta-paper.mjs",
            ]);
            command
        };
        command
            .current_dir(repository)
            .args(["operator", "store", "--"])
            .args(arguments)
            .env("HEPTA_PAPER_RUNTIME_ROOT", &self.runtime)
            .output()
            .unwrap()
    }
    fn inventory(&self) -> Vec<InventoryEntry> {
        use std::os::unix::fs::MetadataExt;
        fn visit(path: &std::path::Path, root: &std::path::Path, rows: &mut Vec<InventoryEntry>) {
            let metadata = fs::symlink_metadata(path).unwrap();
            let bytes = if metadata.is_file() {
                fs::read(path).unwrap()
            } else {
                Vec::new()
            };
            rows.push((
                path.strip_prefix(root).unwrap().to_path_buf(),
                metadata.dev(),
                metadata.ino(),
                metadata.mode(),
                metadata.uid(),
                metadata.gid(),
                metadata.nlink(),
                i128::from(metadata.mtime()) * 1_000_000_000 + i128::from(metadata.mtime_nsec()),
                i128::from(metadata.ctime()) * 1_000_000_000 + i128::from(metadata.ctime_nsec()),
                bytes,
            ));
            if metadata.is_dir() {
                let mut children = fs::read_dir(path)
                    .unwrap()
                    .map(|e| e.unwrap().path())
                    .collect::<Vec<_>>();
                children.sort();
                for child in children {
                    visit(&child, root, rows);
                }
            }
        }
        let mut rows = Vec::new();
        visit(&self.runtime, &self.runtime, &mut rows);
        rows
    }
}

#[test]
fn ordinary_store_modes_preserve_inputs_and_require_trust_clean_exit() {
    let fixture = Fixture::new();
    let handoff = fixture
        .runtime
        .join("autonomous-research/submission-handoff/submission-handoff.sqlite");
    fs::rename(&handoff, handoff.with_extension("offline")).unwrap();
    let before = fixture.inventory();
    for arguments in [
        vec![],
        vec!["--require-trust-clean"],
        vec!["--allow-isolated-verification-evidence"],
        vec![
            "--allow-isolated-verification-evidence",
            "--require-trust-clean",
        ],
        vec![
            "--require-trust-clean",
            "--allow-isolated-verification-evidence",
        ],
    ] {
        let node = fixture.ordinary(false, &arguments);
        let native = fixture.ordinary(true, &arguments);
        let code = if arguments.contains(&"--require-trust-clean") {
            2
        } else {
            0
        };
        assert_eq!(
            node.status.code(),
            Some(code),
            "{}",
            String::from_utf8_lossy(&node.stderr)
        );
        assert_eq!(
            native.status.code(),
            node.status.code(),
            "{}",
            String::from_utf8_lossy(&native.stderr)
        );
        assert_eq!(
            serde_json::from_slice::<Value>(&native.stdout).unwrap(),
            serde_json::from_slice::<Value>(&node.stdout).unwrap()
        );
        assert!(
            fixture.inventory() == before,
            "physical runtime inventory changed"
        );
    }
}

#[test]
fn ordinary_store_required_schema_is_a_sql_refusal() {
    let fixture = Fixture::new();
    let connection = rusqlite::Connection::open(&fixture.database).unwrap();
    connection.execute_batch("DROP TABLE venues;").unwrap();
    drop(connection);
    let before = fixture.inventory();
    for native in [false, true] {
        let result = fixture.ordinary(native, &[]);
        assert_eq!(result.status.code(), Some(1));
        assert!(result.stdout.is_empty());
        assert!(String::from_utf8_lossy(&result.stderr).contains("no such table: venues"));
        assert!(
            fixture.inventory() == before,
            "physical runtime inventory changed"
        );
    }
}

#[test]
fn ordinary_store_handoff_schema_and_file_boundaries_fail_closed() {
    use std::os::unix::fs::PermissionsExt;
    let fixture = Fixture::new();
    let handoff = fixture
        .runtime
        .join("autonomous-research/submission-handoff/submission-handoff.sqlite");
    let original = fs::read(&handoff).unwrap();
    for sql in [
        "UPDATE handoff_schema_migrations SET migration_sha256='changed' WHERE version=2;",
        "DROP TABLE submission_authorization_consumptions;",
        "DROP TRIGGER handoff_instance_no_update; UPDATE handoff_instance SET instance_nonce='invalid';",
    ] {
        fs::write(&handoff, &original).unwrap();
        let connection = rusqlite::Connection::open(&handoff).unwrap();
        connection.execute_batch(sql).unwrap();
        drop(connection);
        let before = fixture.inventory();
        let node = fixture.ordinary(false, &["--require-trust-clean"]);
        let native = fixture.ordinary(true, &["--require-trust-clean"]);
        assert_eq!(node.status.code(), Some(2));
        assert_eq!(native.status.code(), Some(2));
        assert_eq!(
            serde_json::from_slice::<Value>(&native.stdout).unwrap(),
            serde_json::from_slice::<Value>(&node.stdout).unwrap()
        );
        assert!(
            fixture.inventory() == before,
            "physical runtime inventory changed"
        );
    }
    fs::write(&handoff, original).unwrap();
    fs::set_permissions(&handoff, fs::Permissions::from_mode(0o664)).unwrap();
    let node = fixture.ordinary(false, &[]);
    let native = fixture.ordinary(true, &[]);
    assert_eq!(
        serde_json::from_slice::<Value>(&native.stdout).unwrap(),
        serde_json::from_slice::<Value>(&node.stdout).unwrap()
    );
}

#[test]
fn ordinary_store_preserves_blob_utf8_and_safe_large_schema_values() {
    let fixture = Fixture::new();
    let connection = rusqlite::Connection::open(&fixture.database).unwrap();
    connection.execute_batch("INSERT INTO store_metadata(key,value,updated_at) VALUES('bytes',X'0001FF','2026-10-01T00:00:00.000Z'),('utf8',CAST(X'80FF' AS TEXT),'2026-10-01T00:00:00.000Z'); INSERT INTO schema_migrations(version,name,applied_at,migration_sha256) VALUES(4294967296,'fixture','2026-10-01T00:00:00.000Z','sha256:fixture');").unwrap();
    drop(connection);
    let before = fixture.inventory();
    let node = fixture.ordinary(false, &[]);
    let native = fixture.ordinary(true, &[]);
    assert!(
        node.status.success(),
        "{}",
        String::from_utf8_lossy(&node.stderr)
    );
    assert!(
        native.status.success(),
        "{}",
        String::from_utf8_lossy(&native.stderr)
    );
    assert_eq!(
        serde_json::from_slice::<Value>(&native.stdout).unwrap(),
        serde_json::from_slice::<Value>(&node.stdout).unwrap()
    );
    assert!(
        fixture.inventory() == before,
        "physical runtime inventory changed"
    );
}

#[test]
fn ordinary_store_grammar_is_validated_before_missing_input() {
    let root = std::env::temp_dir().join(format!(
        "hepta-store-grammar-missing-{}",
        std::process::id()
    ));
    for argv in [
        vec!["--require-trust-clean=true"],
        vec!["--allow-isolated-verification-evidence=false"],
        vec!["--require-trust-clean", "--require-trust-clean"],
        vec!["unexpected"],
        vec!["--unknown"],
        vec!["--"],
        vec!["--=x"],
    ] {
        let mut node = Command::new("node");
        node.current_dir(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../.."))
            .args([
                "--disable-warning=ExperimentalWarning",
                "paper-core/bin/hepta-paper.mjs",
                "operator",
                "store",
                "--",
            ])
            .args(&argv)
            .env("HEPTA_PAPER_RUNTIME_ROOT", &root);
        let node = node.output().unwrap();
        let native = Command::new(env!("CARGO_BIN_EXE_hepta-paper-rust"))
            .args(["operator", "store", "--"])
            .args(&argv)
            .env("HEPTA_PAPER_RUNTIME_ROOT", &root)
            .output()
            .unwrap();
        assert_eq!(node.status.code(), Some(2));
        assert_eq!(native.status.code(), Some(2));
        assert_eq!(
            serde_json::from_slice::<Value>(&node.stderr).unwrap()["error"],
            serde_json::from_slice::<Value>(&native.stderr).unwrap()["error"]
        );
        assert!(!root.exists());
    }
}
