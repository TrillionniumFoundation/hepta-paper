//! Immutable/read-only SQLite inspection and normalized logical hashing.

#![forbid(unsafe_code)]

use std::{
    fs::{self, File},
    io::Read,
    os::unix::fs::MetadataExt,
    path::{Path, PathBuf},
    str::FromStr,
};

use hepta_codex_protocol::Sha256Digest;
use rusqlite::{Connection, OpenFlags, types::ValueRef};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;

const MAXIMUM_DATABASE_BYTES: u64 = 16 * 1024 * 1024 * 1024;
const MAXIMUM_TABLES: usize = 4096;
const MAXIMUM_ROWS_PER_TABLE: usize = 2_000_000;

#[derive(Clone, Debug, Eq, PartialEq)]
struct FileIdentityV1 {
    device: u64,
    inode: u64,
    mode: u32,
    uid: u32,
    gid: u32,
    link_count: u64,
    size: u64,
    content_hash: Sha256Digest,
    wal_exists: bool,
    shm_exists: bool,
}

/// Read-only database handle that never creates or mutates WAL/SHM state.
pub struct ReadOnlyStoreV1 {
    path: PathBuf,
    connection: Connection,
    identity: FileIdentityV1,
    user_version: u32,
}

impl ReadOnlyStoreV1 {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, ReadOnlyStoreError> {
        let path = inspect_path(path.as_ref())?;
        let identity = inspect_file_identity(&path)?;
        let flags = OpenFlags::SQLITE_OPEN_READ_ONLY
            | OpenFlags::SQLITE_OPEN_NO_MUTEX
            | OpenFlags::SQLITE_OPEN_NOFOLLOW;
        let connection = Connection::open_with_flags(&path, flags)?;
        connection.execute_batch(
            "PRAGMA query_only = ON;
             PRAGMA trusted_schema = OFF;
             PRAGMA temp_store = MEMORY;",
        )?;
        let query_only: i64 = connection.query_row("PRAGMA query_only", [], |row| row.get(0))?;
        if query_only != 1 {
            return Err(ReadOnlyStoreError::QueryOnlyUnavailable);
        }
        let raw_version: i64 =
            connection.query_row("PRAGMA user_version", [], |row| row.get(0))?;
        let user_version = u32::try_from(raw_version)
            .map_err(|_| ReadOnlyStoreError::UnsupportedSchemaVersion(raw_version))?;
        if !(1..=25).contains(&user_version) {
            return Err(ReadOnlyStoreError::UnsupportedSchemaVersion(raw_version));
        }
        let store = Self {
            path,
            connection,
            identity,
            user_version,
        };
        store.verify_unchanged()?;
        Ok(store)
    }

    #[must_use]
    pub const fn user_version(&self) -> u32 {
        self.user_version
    }

    /// Normalizes every user table into typed values and hashes the complete logical state.
    pub fn logical_snapshot(&self) -> Result<LogicalDatabaseSnapshotV1, ReadOnlyStoreError> {
        let schema_objects = self.schema_objects()?;
        let tables = schema_objects
            .iter()
            .filter(|item| item.object_type == "table" && !item.name.starts_with("sqlite_"))
            .map(|item| self.read_table(&item.name))
            .collect::<Result<Vec<_>, _>>()?;
        let application_id: i64 =
            self.connection
                .query_row("PRAGMA application_id", [], |row| row.get(0))?;
        let payload = SnapshotHashView {
            application_id,
            user_version: self.user_version,
            schema_objects: &schema_objects,
            tables: &tables,
        };
        let logical_hash = hash_serialized("HeptaReadOnlyLogicalDatabaseV1", &payload)?;
        self.verify_unchanged()?;
        Ok(LogicalDatabaseSnapshotV1 {
            version: 1,
            application_id,
            user_version: self.user_version,
            schema_objects,
            tables,
            logical_hash,
        })
    }

    pub fn verify_unchanged(&self) -> Result<(), ReadOnlyStoreError> {
        let observed = inspect_file_identity(&self.path)?;
        if observed != self.identity {
            return Err(ReadOnlyStoreError::DatabaseChanged);
        }
        Ok(())
    }

    fn schema_objects(&self) -> Result<Vec<LogicalSchemaObjectV1>, ReadOnlyStoreError> {
        let mut statement = self.connection.prepare(
            "SELECT type, name, tbl_name, coalesce(sql, '')
             FROM sqlite_schema
             WHERE name NOT LIKE 'sqlite_autoindex_%'
             ORDER BY type, name, tbl_name, sql",
        )?;
        let values = statement
            .query_map([], |row| {
                Ok(LogicalSchemaObjectV1 {
                    object_type: row.get(0)?,
                    name: row.get(1)?,
                    table_name: row.get(2)?,
                    sql: row.get(3)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        if values.len() > MAXIMUM_TABLES {
            return Err(ReadOnlyStoreError::SchemaObjectLimitExceeded);
        }
        Ok(values)
    }

    fn read_table(&self, table: &str) -> Result<LogicalTableV1, ReadOnlyStoreError> {
        if table.is_empty() || table.as_bytes().contains(&0) {
            return Err(ReadOnlyStoreError::InvalidTableName);
        }
        let query = format!("SELECT * FROM {}", quote_identifier(table));
        let mut statement = self.connection.prepare(&query)?;
        let columns = statement
            .column_names()
            .iter()
            .map(|value| (*value).to_owned())
            .collect::<Vec<_>>();
        let column_count = statement.column_count();
        let mut rows = statement.query([])?;
        let mut normalized_rows = Vec::new();
        while let Some(row) = rows.next()? {
            if normalized_rows.len() >= MAXIMUM_ROWS_PER_TABLE {
                return Err(ReadOnlyStoreError::RowLimitExceeded(table.to_owned()));
            }
            let values = (0..column_count)
                .map(|index| normalize_value(row.get_ref(index)?))
                .collect::<Result<Vec<_>, _>>()?;
            normalized_rows.push(values);
        }
        normalized_rows.sort_by(|left, right| {
            serde_json::to_vec(left)
                .unwrap_or_default()
                .cmp(&serde_json::to_vec(right).unwrap_or_default())
        });
        let table_hash = hash_serialized(
            "HeptaReadOnlyLogicalTableV1",
            &TableHashView {
                name: table,
                columns: &columns,
                rows: &normalized_rows,
            },
        )?;
        Ok(LogicalTableV1 {
            name: table.to_owned(),
            columns,
            rows: normalized_rows,
            table_hash,
        })
    }
}

#[derive(Clone, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(tag = "type", content = "value", rename_all = "snake_case")]
pub enum LogicalSqlValueV1 {
    Null,
    Integer(i64),
    Real(String),
    Text(String),
    BlobHex(String),
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LogicalSchemaObjectV1 {
    pub object_type: String,
    pub name: String,
    pub table_name: String,
    pub sql: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LogicalTableV1 {
    pub name: String,
    pub columns: Vec<String>,
    pub rows: Vec<Vec<LogicalSqlValueV1>>,
    pub table_hash: Sha256Digest,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LogicalDatabaseSnapshotV1 {
    pub version: u16,
    pub application_id: i64,
    pub user_version: u32,
    pub schema_objects: Vec<LogicalSchemaObjectV1>,
    pub tables: Vec<LogicalTableV1>,
    pub logical_hash: Sha256Digest,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotHashView<'a> {
    application_id: i64,
    user_version: u32,
    schema_objects: &'a [LogicalSchemaObjectV1],
    tables: &'a [LogicalTableV1],
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TableHashView<'a> {
    name: &'a str,
    columns: &'a [String],
    rows: &'a [Vec<LogicalSqlValueV1>],
}

fn normalize_value(value: ValueRef<'_>) -> Result<LogicalSqlValueV1, ReadOnlyStoreError> {
    Ok(match value {
        ValueRef::Null => LogicalSqlValueV1::Null,
        ValueRef::Integer(value) => LogicalSqlValueV1::Integer(value),
        ValueRef::Real(value) => {
            if !value.is_finite() {
                return Err(ReadOnlyStoreError::NonFiniteReal);
            }
            LogicalSqlValueV1::Real(value.to_string())
        }
        ValueRef::Text(value) => LogicalSqlValueV1::Text(
            std::str::from_utf8(value)
                .map_err(|_| ReadOnlyStoreError::NonUtf8Text)?
                .to_owned(),
        ),
        ValueRef::Blob(value) => LogicalSqlValueV1::BlobHex(hex::encode(value)),
    })
}

fn quote_identifier(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}

fn inspect_path(path: &Path) -> Result<PathBuf, ReadOnlyStoreError> {
    if !path.is_absolute() {
        return Err(ReadOnlyStoreError::DatabasePathInvalid);
    }
    let canonical = fs::canonicalize(path)
        .map_err(|error| ReadOnlyStoreError::Filesystem("database_canonical", error.kind()))?;
    if canonical != path {
        return Err(ReadOnlyStoreError::DatabasePathInvalid);
    }
    Ok(canonical)
}

fn inspect_file_identity(path: &Path) -> Result<FileIdentityV1, ReadOnlyStoreError> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| ReadOnlyStoreError::Filesystem("database_metadata", error.kind()))?;
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || metadata.nlink() != 1
        || metadata.size() == 0
        || metadata.size() > MAXIMUM_DATABASE_BYTES
    {
        return Err(ReadOnlyStoreError::DatabasePathInvalid);
    }
    Ok(FileIdentityV1 {
        device: metadata.dev(),
        inode: metadata.ino(),
        mode: metadata.mode(),
        uid: metadata.uid(),
        gid: metadata.gid(),
        link_count: metadata.nlink(),
        size: metadata.size(),
        content_hash: hash_file(path)?,
        wal_exists: sidecar(path, "-wal").exists(),
        shm_exists: sidecar(path, "-shm").exists(),
    })
}

fn sidecar(path: &Path, suffix: &str) -> PathBuf {
    let mut value = path.as_os_str().to_os_string();
    value.push(suffix);
    PathBuf::from(value)
}

fn hash_file(path: &Path) -> Result<Sha256Digest, ReadOnlyStoreError> {
    let mut file = File::open(path)
        .map_err(|error| ReadOnlyStoreError::Filesystem("database_hash", error.kind()))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    let mut total = 0_u64;
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| ReadOnlyStoreError::Filesystem("database_hash", error.kind()))?;
        if read == 0 {
            break;
        }
        total = total
            .checked_add(u64::try_from(read).map_err(|_| ReadOnlyStoreError::NumericOverflow)?)
            .ok_or(ReadOnlyStoreError::NumericOverflow)?;
        if total > MAXIMUM_DATABASE_BYTES {
            return Err(ReadOnlyStoreError::DatabaseTooLarge);
        }
        hasher.update(&buffer[..read]);
    }
    digest(hasher)
}

fn hash_serialized<T: Serialize>(
    domain: &str,
    value: &T,
) -> Result<Sha256Digest, ReadOnlyStoreError> {
    let bytes = serde_json::to_vec(value).map_err(|_| ReadOnlyStoreError::Serialization)?;
    let mut hasher = Sha256::new();
    update_field(&mut hasher, domain.as_bytes());
    update_field(&mut hasher, &bytes);
    digest(hasher)
}

fn update_field(hasher: &mut Sha256, value: &[u8]) {
    hasher.update(u64::try_from(value.len()).unwrap_or(u64::MAX).to_be_bytes());
    hasher.update(value);
}

fn digest(hasher: Sha256) -> Result<Sha256Digest, ReadOnlyStoreError> {
    Sha256Digest::from_str(&format!("sha256:{}", hex::encode(hasher.finalize())))
        .map_err(|_| ReadOnlyStoreError::DigestConstruction)
}

#[derive(Debug, Error)]
pub enum ReadOnlyStoreError {
    #[error("read-only database path is invalid")]
    DatabasePathInvalid,
    #[error("read-only database exceeds the byte limit")]
    DatabaseTooLarge,
    #[error("read-only database changed during inspection")]
    DatabaseChanged,
    #[error("SQLite query_only could not be established")]
    QueryOnlyUnavailable,
    #[error("unsupported schema version: {0}")]
    UnsupportedSchemaVersion(i64),
    #[error("schema object limit exceeded")]
    SchemaObjectLimitExceeded,
    #[error("table row limit exceeded: {0}")]
    RowLimitExceeded(String),
    #[error("table name is invalid")]
    InvalidTableName,
    #[error("SQLite real value is not finite")]
    NonFiniteReal,
    #[error("SQLite text value is not UTF-8")]
    NonUtf8Text,
    #[error("logical snapshot serialization failed")]
    Serialization,
    #[error("logical snapshot digest construction failed")]
    DigestConstruction,
    #[error("numeric conversion overflowed")]
    NumericOverflow,
    #[error("read-only filesystem operation failed for {0}: {1:?}")]
    Filesystem(&'static str, std::io::ErrorKind),
    #[error(transparent)]
    Sqlite(#[from] rusqlite::Error),
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        os::unix::fs::{MetadataExt, PermissionsExt},
        sync::atomic::{AtomicU64, Ordering},
    };

    use super::*;

    static NEXT_TEST: AtomicU64 = AtomicU64::new(0);

    struct Fixture {
        root: PathBuf,
        database: PathBuf,
    }

    impl Fixture {
        fn new(version: u32) -> Self {
            let sequence = NEXT_TEST.fetch_add(1, Ordering::Relaxed);
            let root = std::env::temp_dir().join(format!(
                "hepta-readonly-store-{}-{sequence}",
                std::process::id()
            ));
            fs::create_dir(&root).expect("root");
            fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).expect("mode");
            let database = root.join("store.sqlite");
            let connection = Connection::open(&database).expect("database");
            connection
                .execute_batch(&format!(
                    "PRAGMA journal_mode = DELETE;
                     PRAGMA user_version = {version};
                     CREATE TABLE campaigns (id TEXT PRIMARY KEY, revision INTEGER NOT NULL);
                     INSERT INTO campaigns VALUES ('campaign-b', 2), ('campaign-a', 1);"
                ))
                .expect("fixture schema");
            drop(connection);
            Self { root, database }
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn opens_schema_one_through_twenty_five_without_mutation() {
        for version in [1, 12, 25] {
            let fixture = Fixture::new(version);
            let before = hash_file(&fixture.database).expect("before hash");
            let store = ReadOnlyStoreV1::open(&fixture.database).expect("read-only open");
            assert_eq!(store.user_version(), version);
            let snapshot = store.logical_snapshot().expect("snapshot");
            assert_eq!(snapshot.user_version, version);
            assert_eq!(snapshot.tables.len(), 1);
            store.verify_unchanged().expect("unchanged");
            assert_eq!(hash_file(&fixture.database).expect("after hash"), before);
            assert!(!sidecar(&fixture.database, "-wal").exists());
            assert!(!sidecar(&fixture.database, "-shm").exists());
        }
    }

    #[test]
    fn normalized_hash_ignores_row_insertion_order() {
        let left = Fixture::new(25);
        let right = Fixture::new(25);
        let left_snapshot = ReadOnlyStoreV1::open(&left.database)
            .expect("left")
            .logical_snapshot()
            .expect("left snapshot");
        let right_snapshot = ReadOnlyStoreV1::open(&right.database)
            .expect("right")
            .logical_snapshot()
            .expect("right snapshot");
        assert_eq!(left_snapshot.logical_hash, right_snapshot.logical_hash);
        assert_eq!(fs::metadata(&left.database).expect("metadata").nlink(), 1);
    }

    #[test]
    fn rejects_unqualified_schema_versions() {
        let fixture = Fixture::new(26);
        assert!(matches!(
            ReadOnlyStoreV1::open(&fixture.database),
            Err(ReadOnlyStoreError::UnsupportedSchemaVersion(26))
        ));
    }
}
