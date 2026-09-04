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
        connection
            .execute_batch(&format!(
                "PRAGMA journal_mode = DELETE;
                 PRAGMA user_version = {version};
                 CREATE TABLE state_rows(
                   id TEXT PRIMARY KEY,
                   revision INTEGER NOT NULL,
                   body BLOB,
                   optional TEXT
                 );
                 INSERT INTO state_rows VALUES('row-1', {version}, X'000102', NULL);"
            ))
            .expect("fixture schema");
        drop(connection);
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).expect("database mode");
        let before = fs::read(&path).expect("before bytes");
        let snapshot = inspect_read_only_store(&path).expect("immutable snapshot");
        assert_eq!(snapshot.schema_version, version);
        assert_eq!(snapshot.row_count, 1);
        assert_eq!(before, fs::read(&path).expect("after bytes"));
        for suffix in ["-wal", "-shm", "-journal"] {
            assert!(!PathBuf::from(format!("{}{suffix}", path.display())).exists());
        }
        fs::remove_dir_all(root).expect("cleanup");
    }
}
