use hepta_readonly_control::{DatabaseFormatV1, inspect_read_only_store};
use hepta_readonly_store::{ReadOnlyStoreError, ReadOnlyStoreV1};
use rusqlite::Connection;
use serde_json::Value;
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::atomic::{AtomicU64, Ordering},
};

static NEXT: AtomicU64 = AtomicU64::new(0);

struct Fixtures(PathBuf);
impl Fixtures {
    fn generate() -> Self {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "hepta-node-parity-{}-{}-{nonce}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        let script = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../tools/create-node-store-compat-fixtures.mjs");
        let result =
            Command::new(std::env::var_os("HEPTA_NODE_BINARY").unwrap_or_else(|| "node".into()))
                .arg(script)
                .arg(&root)
                .output()
                .expect("Node runtime required for production parity");
        assert!(
            result.status.success(),
            "Node fixture generator: {}",
            String::from_utf8_lossy(&result.stderr)
        );
        Self(root)
    }
    fn copy(&self, name: &str, version: u32) -> PathBuf {
        let target = self.0.join(format!("{name}.sqlite"));
        fs::copy(self.0.join(format!("node-v{version}.sqlite")), &target).expect("copy");
        target
    }
}
impl Drop for Fixtures {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn all_twenty_five_actual_node_stores_match_production_integrity_hashes_and_remain_immutable() {
    let fixtures = Fixtures::generate();
    let manifest: Vec<Value> =
        serde_json::from_slice(&fs::read(fixtures.0.join("manifest.json")).expect("manifest"))
            .expect("manifest JSON");
    for fixture in manifest {
        let path = fixtures.0.join(fixture["file"].as_str().expect("file"));
        let version = fixture["version"].as_u64().expect("version");
        let before = fs::read(&path).expect("before bytes");
        let control = inspect_read_only_store(&path).expect("control opens real Node store");
        assert_eq!(u64::from(control.schema_version), version);
        assert_eq!(control.schema.format, DatabaseFormatV1::NodeMigrationLedger);
        assert_eq!(control.schema.user_version, 0);
        assert_eq!(control.schema.application_id, 0);
        let store = ReadOnlyStoreV1::open(&path).expect("store opens real Node store");
        let report = store
            .node_logical_snapshot()
            .expect("Node-compatible logical digest");
        let actual = serde_json::to_value(&report).expect("report JSON");
        for field in [
            "tableCount",
            "totalRowCount",
            "schemaHash",
            "logicalDatabaseHash",
            "tables",
        ] {
            assert_eq!(
                actual[field], fixture["report"][field],
                "version {version}, field {field}"
            );
        }
        store
            .logical_snapshot()
            .expect("typed Rust snapshot accepts real SQL values");
        store.verify_unchanged().expect("unchanged");
        assert_eq!(before, fs::read(&path).expect("after bytes"));
        for suffix in ["-wal", "-shm", "-journal"] {
            assert!(!PathBuf::from(format!("{}{suffix}", path.display())).exists());
        }
    }
}

#[test]
fn inconsistent_history_schema_metadata_and_live_sidecars_fail_closed() {
    let fixtures = Fixtures::generate();
    for (name, sql) in [
        ("gap", "DELETE FROM schema_migrations WHERE version=8"),
        (
            "name",
            "UPDATE schema_migrations SET name='wrong' WHERE version=8",
        ),
        (
            "hash",
            "UPDATE schema_migrations SET migration_sha256='sha256:wrong' WHERE version=8",
        ),
        (
            "future",
            "INSERT INTO schema_migrations(version,name,migration_sha256) VALUES(26,'026_future','sha256:future')",
        ),
        ("header", "PRAGMA user_version=25"),
        ("application", "PRAGMA application_id=42"),
        (
            "metadata",
            "UPDATE store_metadata SET value='24' WHERE key='schema_version'",
        ),
        ("drop_index", "DROP INDEX idx_papers_status"),
        ("extra_table", "CREATE TABLE unqualified_data(value TEXT)"),
        ("hidden_table", "CREATE TABLE sqliteevil(value TEXT)"),
        (
            "column_drift",
            "ALTER TABLE papers ADD COLUMN unqualified TEXT",
        ),
        (
            "missing_trigger",
            "DROP TRIGGER receipt_ledger_forbid_update",
        ),
        (
            "foreign_key",
            "PRAGMA foreign_keys=OFF; INSERT INTO artifacts(slug,kind,path) VALUES('missing','bad','bad')",
        ),
    ] {
        let path = fixtures.copy(name, 25);
        let db = Connection::open(&path).expect("mutation connection");
        db.execute_batch(sql)
            .unwrap_or_else(|error| panic!("{name}: {error}"));
        drop(db);
        assert!(
            inspect_read_only_store(&path).is_err(),
            "control should reject {name}"
        );
        assert!(
            ReadOnlyStoreV1::open(&path).is_err(),
            "store should reject {name}"
        );
    }
    for suffix in ["-wal", "-shm", "-journal"] {
        let path = fixtures.copy(&format!("sidecar{suffix}"), 25);
        fs::write(format!("{}{suffix}", path.display()), b"").expect("sidecar");
        assert!(inspect_read_only_store(&path).is_err());
        assert!(matches!(
            ReadOnlyStoreV1::open(&path),
            Err(ReadOnlyStoreError::SidecarPresent)
        ));
    }
    let dangling_path = fixtures.copy("dangling-sidecar", 25);
    std::os::unix::fs::symlink(
        fixtures.0.join("missing-target"),
        format!("{}-wal", dangling_path.display()),
    )
    .expect("dangling WAL symlink");
    assert!(inspect_read_only_store(&dangling_path).is_err());
    assert!(matches!(
        ReadOnlyStoreV1::open(&dangling_path),
        Err(ReadOnlyStoreError::SidecarPresent)
    ));
    let escaped_path = fixtures.copy("path ?#% 中文", 25);
    let store = ReadOnlyStoreV1::open(&escaped_path).expect("URI-escaped path");
    assert_eq!(store.schema_version(), 25);
    store
        .node_logical_snapshot()
        .expect("escaped-path snapshot");
    inspect_read_only_store(&escaped_path).expect("escaped-path control snapshot");
    let spoofed = fixtures.0.join("pragma-only.sqlite");
    let db = Connection::open(&spoofed).expect("spoofed DB");
    db.execute_batch("PRAGMA user_version=25; CREATE TABLE campaigns(id TEXT PRIMARY KEY)")
        .expect("spoofed schema");
    drop(db);
    assert!(inspect_read_only_store(&spoofed).is_err());
    assert!(ReadOnlyStoreV1::open(&spoofed).is_err());
}

#[test]
fn compatibility_hash_detects_real_data_changes_and_rejects_inexact_node_integers() {
    let fixtures = Fixtures::generate();
    let path = fixtures.copy("logical_change", 25);
    let before = ReadOnlyStoreV1::open(&path)
        .expect("open before")
        .node_logical_snapshot()
        .expect("before");
    let db = Connection::open(&path).expect("writer");
    db.execute_batch("UPDATE papers SET title='changed' WHERE slug='paper-a'")
        .expect("update");
    drop(db);
    let store = ReadOnlyStoreV1::open(&path).expect("open after");
    let after = store.node_logical_snapshot().expect("after");
    assert_eq!(before.schema_hash, after.schema_hash);
    assert_ne!(before.logical_database_hash, after.logical_database_hash);
    drop(store);
    let db = Connection::open(&path).expect("writer");
    db.execute_batch("UPDATE artifacts SET bytes=9223372036854775807 WHERE artifact_id=1")
        .expect("large integer");
    drop(db);
    let store = ReadOnlyStoreV1::open(&path).expect("schema remains valid");
    store
        .logical_snapshot()
        .expect("typed hash preserves i64 exactly");
    assert!(matches!(
        store.node_logical_snapshot(),
        Err(ReadOnlyStoreError::NodeIntegerOutOfRange)
    ));
}
