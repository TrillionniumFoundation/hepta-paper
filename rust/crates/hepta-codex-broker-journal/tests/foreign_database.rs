use std::{
    fs,
    os::unix::fs::{MetadataExt, PermissionsExt},
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

use hepta_codex_broker_journal::{
    BrokerJournalPolicyV1, BrokerJournalV1, JournalStoreError,
};
use rusqlite::Connection;

static NEXT_TEMP_ID: AtomicU64 = AtomicU64::new(0);

struct TempDirectory(PathBuf);

impl TempDirectory {
    fn new() -> Self {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock after epoch")
            .as_nanos();
        let sequence = NEXT_TEMP_ID.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "hepta-broker-foreign-db-{}-{nonce}-{sequence}",
            std::process::id(),
        ));
        fs::create_dir(&path).expect("create temp directory");
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700))
            .expect("private temp directory");
        Self(path)
    }

    fn policy(&self) -> BrokerJournalPolicyV1 {
        BrokerJournalPolicyV1::strict(
            fs::metadata(&self.0)
                .expect("directory metadata")
                .uid(),
        )
    }
}

impl Drop for TempDirectory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn empty_foreign_sqlite_file_is_rejected_without_byte_mutation() {
    let directory = TempDirectory::new();
    let path = directory.0.join("empty-foreign.sqlite");
    {
        let connection = Connection::open(&path).expect("create foreign database");
        connection
            .execute_batch("PRAGMA user_version = 0;")
            .expect("materialize SQLite header");
    }
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600))
        .expect("private foreign database");
    let before = fs::read(&path).expect("bytes before");
    assert!(matches!(
        BrokerJournalV1::open(&path, directory.policy()),
        Err(JournalStoreError::ApplicationIdMismatch(0)),
    ));
    assert_eq!(fs::read(&path).expect("bytes after"), before);
    assert!(!PathBuf::from(format!("{}-wal", path.display())).exists());
    assert!(!PathBuf::from(format!("{}-shm", path.display())).exists());
}

#[test]
fn qualified_database_with_unexpected_schema_object_is_rejected() {
    let directory = TempDirectory::new();
    let path = directory.0.join("broker.sqlite");
    {
        let journal = BrokerJournalV1::open(&path, directory.policy())
            .expect("create qualified database");
        journal.checkpoint().expect("checkpoint");
    }
    {
        let connection = Connection::open(&path).expect("open raw database");
        connection
            .execute_batch("CREATE TABLE unexpected_object(value TEXT NOT NULL);")
            .expect("tamper schema");
    }
    assert!(matches!(
        BrokerJournalV1::open(&path, directory.policy()),
        Err(JournalStoreError::SchemaFingerprintMismatch { .. }),
    ));
}

#[test]
fn qualified_database_with_replaced_trigger_is_rejected() {
    let directory = TempDirectory::new();
    let path = directory.0.join("broker.sqlite");
    {
        let journal = BrokerJournalV1::open(&path, directory.policy())
            .expect("create qualified database");
        journal.checkpoint().expect("checkpoint");
    }
    {
        let connection = Connection::open(&path).expect("open raw database");
        connection
            .execute_batch(
                "DROP TRIGGER operations_no_delete;\n\
                 CREATE TRIGGER operations_no_delete\n\
                 BEFORE DELETE ON operations\n\
                 BEGIN SELECT RAISE(ABORT, 'different_trigger'); END;",
            )
            .expect("replace trigger");
    }
    assert!(matches!(
        BrokerJournalV1::open(&path, directory.policy()),
        Err(JournalStoreError::SchemaFingerprintMismatch { .. }),
    ));
}
