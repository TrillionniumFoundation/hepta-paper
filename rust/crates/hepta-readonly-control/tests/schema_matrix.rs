use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

use hepta_readonly_control::inspect_read_only_store;
use rusqlite::Connection;

static NEXT: AtomicU64 = AtomicU64::new(0);

#[test]
fn every_supported_schema_version_is_read_without_byte_or_sidecar_mutation() {
    for version in 1_u32..=25 {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "hepta-schema-matrix-{}-{nonce}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).expect("root");
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).expect("root mode");
        let path = root.join("store.sqlite");
        let connection = Connection::open(&path).expect("fixture database");
        for migration in hepta_readonly_control::node_schema::NODE_MIGRATIONS_V1
            .iter()
            .take(version as usize)
        {
            use sha2::{Digest, Sha256};
            connection.execute_batch("BEGIN IMMEDIATE").expect("begin");
            connection
                .execute_batch(migration.sql)
                .expect("production Node migration SQL");
            connection
                .execute(
                    "INSERT INTO schema_migrations(version,name,migration_sha256) VALUES(?1,?2,?3)",
                    rusqlite::params![
                        migration.version,
                        migration.name,
                        format!(
                            "sha256:{}",
                            hex::encode(Sha256::digest(migration.sql.as_bytes()))
                        )
                    ],
                )
                .expect("actual migration descriptor");
            connection.execute_batch("COMMIT").expect("commit");
        }
        drop(connection);
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).expect("database mode");
        let before = fs::read(&path).expect("before bytes");
        let snapshot = inspect_read_only_store(&path).expect("immutable snapshot");
        assert_eq!(snapshot.schema_version, version);
        assert!(snapshot.table_count >= 11);
        assert_eq!(snapshot.schema.user_version, 0);
        assert!(snapshot.row_count >= u64::from(version));
        assert_eq!(before, fs::read(&path).expect("after bytes"));
        for suffix in ["-wal", "-shm", "-journal"] {
            assert!(!PathBuf::from(format!("{}{suffix}", path.display())).exists());
        }
        fs::remove_dir_all(root).expect("cleanup");
    }
}
