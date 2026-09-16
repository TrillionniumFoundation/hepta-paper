use hepta_paper_service::node_migration::{NodeMigrationError, migrate_node_store_v1};
use rusqlite::Connection;
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
};

static NEXT: AtomicU64 = AtomicU64::new(1);

struct Temp(PathBuf);

impl Temp {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "hepta-rust-node-migration-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        Self(root)
    }

    fn database(&self) -> PathBuf {
        let path = self.0.join("paper.sqlite");
        let connection = Connection::open(&path).unwrap();
        connection.execute_batch("PRAGMA user_version=1;").unwrap();
        drop(connection);
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        path
    }
}

impl Drop for Temp {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn applies_embedded_node_migrations_with_idempotent_receipt() {
    let temp = Temp::new();
    let path = temp.database();
    let receipt = migrate_node_store_v1(&path, Some(2)).expect("migration");
    assert_eq!(receipt.before_version, 0);
    assert_eq!(receipt.target_version, 2);
    assert_eq!(receipt.applied_versions, [1, 2]);
    assert!(!receipt.production_activation);
    assert!(!receipt.node_retirement_verified);

    let second = migrate_node_store_v1(&path, Some(2)).expect("idempotent migration");
    assert_eq!(second.before_version, 2);
    assert!(second.applied_versions.is_empty());
    assert_eq!(second.database_sha256, receipt.database_sha256);
}

#[test]
fn rejects_sidecars_before_mutating_the_database() {
    let temp = Temp::new();
    let path = temp.database();
    fs::write(format!("{}-wal", path.display()), b"active").unwrap();
    assert!(matches!(
        migrate_node_store_v1(&path, Some(1)),
        Err(NodeMigrationError::Sidecar)
    ));
}

#[test]
fn rejects_target_behind_applied_history() {
    let temp = Temp::new();
    let path = temp.database();
    migrate_node_store_v1(&path, Some(2)).expect("migration");
    assert!(matches!(
        migrate_node_store_v1(&path, Some(1)),
        Err(NodeMigrationError::Target)
    ));
}

#[test]
fn applies_the_complete_embedded_migration_catalog() {
    let temp = Temp::new();
    let path = temp.database();
    let receipt = migrate_node_store_v1(&path, None).expect("complete migration catalog");
    assert_eq!(receipt.before_version, 0);
    assert_eq!(receipt.target_version, 25);
    assert_eq!(receipt.applied_versions.len(), 25);
    assert_eq!(receipt.applied_versions.first(), Some(&1));
    assert_eq!(receipt.applied_versions.last(), Some(&25));
}

#[test]
fn rejects_migration_when_a_live_job_lease_is_present() {
    let temp = Temp::new();
    let path = temp.database();
    migrate_node_store_v1(&path, Some(2)).expect("initial migrations");
    let connection = Connection::open(&path).unwrap();
    connection
        .execute(
            "INSERT INTO jobs(job_id,deduplication_key,kind,status,spec_json,created_at,updated_at)
             VALUES ('job-1','dedupe-1','test','running','{}','now','now')",
            [],
        )
        .unwrap();
    drop(connection);
    assert!(matches!(
        migrate_node_store_v1(&path, Some(3)),
        Err(NodeMigrationError::ActiveLease)
    ));
}
