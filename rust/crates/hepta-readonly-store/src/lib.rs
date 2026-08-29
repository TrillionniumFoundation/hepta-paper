//! Immutable, byte-preserving schema-25 SQLite inspection and logical projection.

use std::{
    fs::{self, File},
    io::Read,
    os::unix::fs::MetadataExt,
    path::{Path, PathBuf},
    str,
};

use rusqlite::{Connection, OpenFlags, types::ValueRef};
use serde::Serialize;
use sha2::{Digest, Sha256};
use thiserror::Error;

const EXPECTED_USER_VERSION: i64 = 25;
const MAXIMUM_DATABASE_BYTES: u64 = 64 * 1024 * 1024 * 1024;

#[derive(Clone, Debug, Eq, PartialEq)]
struct FileIdentityV1 {
    device: u64,
    inode: u64,
    mode: u32,
    uid: u32,
    gid: u32,
    links: u64,
    bytes: u64,
    content_hash: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogicalTableV1 {
    pub name: String,
    pub columns: Vec<String>,
    pub row_count: u64,
    pub row_hashes: Vec<String>,
    pub table_hash: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogicalStoreSnapshotV1 {
    pub version: u16,
    pub schema_version: i64,
    pub application_id: i64,
    pub tables: Vec<LogicalTableV1>,
    pub logical_hash: String,
    pub database_content_hash: String,
}

/// Opened read-only store. Construction and every snapshot prove file bytes and sidecars are stable.
pub struct ReadOnlyStoreV1 {
    connection: Connection,
    path: PathBuf,
    identity: FileIdentityV1,
}

impl ReadOnlyStoreV1 {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, ReadOnlyStoreError> {
        let requested = path.as_ref();
        if !requested.is_absolute() {
            return Err(ReadOnlyStoreError::PathInvalid);
        }
        let canonical = fs::canonicalize(requested)
            .map_err(|error| ReadOnlyStoreError::Filesystem("canonical", error.kind()))?;
        if canonical != requested {
            return Err(ReadOnlyStoreError::PathNonCanonical);
        }
        reject_sidecars(&canonical)?;
        let identity = inspect_file(&canonical)?;
        let flags = OpenFlags::SQLITE_OPEN_READ_ONLY
            | OpenFlags::SQLITE_OPEN_NO_MUTEX
            | OpenFlags::SQLITE_OPEN_NOFOLLOW;
        let connection = Connection::open_with_flags(&canonical, flags)?;
        connection.execute_batch(
            "PRAGMA query_only = ON;
             PRAGMA trusted_schema = OFF;
             PRAGMA temp_store = MEMORY;",
        )?;
        let query_only: i64 = connection.query_row("PRAGMA query_only", [], |row| row.get(0))?;
        if query_only != 1 {
            return Err(ReadOnlyStoreError::QueryOnlyUnavailable);
        }
        let schema_version: i64 =
            connection.query_row("PRAGMA user_version", [], |row| row.get(0))?;
        if schema_version != EXPECTED_USER_VERSION {
            return Err(ReadOnlyStoreError::SchemaVersionMismatch {
                expected: EXPECTED_USER_VERSION,
                observed: schema_version,
            });
        }
        let integrity: String =
            connection.query_row("PRAGMA integrity_check", [], |row| row.get(0))?;
        if integrity != "ok" {
            return Err(ReadOnlyStoreError::IntegrityFailure(integrity));
        }
        if inspect_file(&canonical)? != identity {
            return Err(ReadOnlyStoreError::DatabaseChanged);
        }
        reject_sidecars(&canonical)?;
        Ok(Self {
            connection,
            path: canonical,
            identity,
        })
    }

    #[must_use]
    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn snapshot(&self) -> Result<LogicalStoreSnapshotV1, ReadOnlyStoreError> {
        self.revalidate()?;
        let schema_version: i64 =
            self.connection
                .query_row("PRAGMA user_version", [], |row| row.get(0))?;
        let application_id: i64 =
            self.connection
                .query_row("PRAGMA application_id", [], |row| row.get(0))?;
        let mut names = self
            .connection
            .prepare(
                "SELECT name FROM sqlite_schema
                 WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
                 ORDER BY name COLLATE BINARY",
            )?
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        names.sort_by(|left, right| left.as_bytes().cmp(right.as_bytes()));
        let mut tables = Vec::with_capacity(names.len());
        for name in names {
            tables.push(project_table(&self.connection, &name)?);
        }
        let logical_hash = hash_serialized("HeptaLogicalStoreSnapshotV1", &(
            schema_version,
            application_id,
            &tables,
        ))?;
        self.revalidate()?;
        Ok(LogicalStoreSnapshotV1 {
            version: 1,
            schema_version,
            application_id,
            tables,
            logical_hash,
            database_content_hash: self.identity.content_hash.clone(),
        })
    }

    fn revalidate(&self) -> Result<(), ReadOnlyStoreError> {
        reject_sidecars(&self.path)?;
        if inspect_file(&self.path)? != self.identity {
            return Err(ReadOnlyStoreError::DatabaseChanged);
        }
        Ok(())
    }
}

fn project_table(
    connection: &Connection,
    table_name: &str,
) -> Result<LogicalTableV1, ReadOnlyStoreError> {
    if table_name.is_empty() || table_name.contains('\0') {
        return Err(ReadOnlyStoreError::TableNameInvalid);
    }
    let quoted = format!("\"{}\"", table_name.replace('"', "\"\""));
    let mut statement = connection.prepare(&format!("SELECT * FROM {quoted}"))?;
    let columns = statement
        .column_names()
        .iter()
        .map(|value| (*value).to_owned())
        .collect::<Vec<_>>();
    let column_count = statement.column_count();
    let mut rows = statement.query([])?;
    let mut encoded_rows = Vec::new();
    while let Some(row) = rows.next()? {
        let mut cells = Vec::with_capacity(column_count);
        for index in 0..column_count {
            cells.push(encode_cell(row.get_ref(index)?)?);
        }
        encoded_rows.push(serde_json::to_vec(&cells).map_err(|_| ReadOnlyStoreError::Encode)?);
    }
    encoded_rows.sort();
    let row_hashes = encoded_rows
        .iter()
        .map(|row| hash_bytes("HeptaLogicalStoreRowV1", row))
        .collect::<Result<Vec<_>, _>>()?;
    let table_hash = hash_serialized(
        "HeptaLogicalStoreTableV1",
        &(table_name, &columns, &row_hashes),
    )?;
    Ok(LogicalTableV1 {
        name: table_name.to_owned(),
        columns,
        row_count: u64::try_from(row_hashes.len())
            .map_err(|_| ReadOnlyStoreError::NumericOverflow)?,
        row_hashes,
        table_hash,
    })
}

#[derive(Serialize)]
#[serde(tag = "type", content = "value", rename_all = "snake_case")]
enum CellV1 {
    Null,
    Integer(String),
    RealBits(String),
    Text(String),
    Blob(String),
}

fn encode_cell(value: ValueRef<'_>) -> Result<CellV1, ReadOnlyStoreError> {
    match value {
        ValueRef::Null => Ok(CellV1::Null),
        ValueRef::Integer(value) => Ok(CellV1::Integer(value.to_string())),
        ValueRef::Real(value) => Ok(CellV1::RealBits(format!("{:016x}", value.to_bits()))),
        ValueRef::Text(bytes) => Ok(CellV1::Text(
            str::from_utf8(bytes)
                .map_err(|_| ReadOnlyStoreError::NonUtf8Text)?
                .to_owned(),
        )),
        ValueRef::Blob(bytes) => Ok(CellV1::Blob(hex::encode(bytes))),
    }
}

fn inspect_file(path: &Path) -> Result<FileIdentityV1, ReadOnlyStoreError> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| ReadOnlyStoreError::Filesystem("database", error.kind()))?;
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || metadata.nlink() != 1
        || metadata.size() == 0
        || metadata.size() > MAXIMUM_DATABASE_BYTES
    {
        return Err(ReadOnlyStoreError::DatabaseInvalid);
    }
    Ok(FileIdentityV1 {
        device: metadata.dev(),
        inode: metadata.ino(),
        mode: metadata.mode(),
        uid: metadata.uid(),
        gid: metadata.gid(),
        links: metadata.nlink(),
        bytes: metadata.size(),
        content_hash: hash_file(path, metadata.size())?,
    })
}

fn reject_sidecars(path: &Path) -> Result<(), ReadOnlyStoreError> {
    for suffix in ["-wal", "-shm"] {
        let sidecar = PathBuf::from(format!("{}{}", path.display(), suffix));
        match fs::symlink_metadata(&sidecar) {
            Ok(_) => return Err(ReadOnlyStoreError::ActiveSidecar(sidecar)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(ReadOnlyStoreError::Filesystem(
                    "sidecar",
                    error.kind(),
                ));
            }
        }
    }
    Ok(())
}

fn hash_file(path: &Path, expected_size: u64) -> Result<String, ReadOnlyStoreError> {
    let mut file = File::open(path)
        .map_err(|error| ReadOnlyStoreError::Filesystem("database_hash", error.kind()))?;
    let before = file
        .metadata()
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
            return Err(ReadOnlyStoreError::DatabaseInvalid);
        }
        hasher.update(&buffer[..read]);
    }
    let after = file
        .metadata()
        .map_err(|error| ReadOnlyStoreError::Filesystem("database_hash", error.kind()))?;
    if total != expected_size
        || before.dev() != after.dev()
        || before.ino() != after.ino()
        || before.mode() != after.mode()
        || before.uid() != after.uid()
        || before.gid() != after.gid()
        || before.nlink() != after.nlink()
        || before.size() != after.size()
    {
        return Err(ReadOnlyStoreError::DatabaseChanged);
    }
    Ok(format!("sha256:{}", hex::encode(hasher.finalize())))
}

fn hash_serialized<T: Serialize>(domain: &str, value: &T) -> Result<String, ReadOnlyStoreError> {
    let encoded = serde_json::to_vec(value).map_err(|_| ReadOnlyStoreError::Encode)?;
    hash_bytes(domain, &encoded)
}

fn hash_bytes(domain: &str, bytes: &[u8]) -> Result<String, ReadOnlyStoreError> {
    let mut hasher = Sha256::new();
    hasher.update(
        u64::try_from(domain.len())
            .map_err(|_| ReadOnlyStoreError::NumericOverflow)?
            .to_be_bytes(),
    );
    hasher.update(domain.as_bytes());
    hasher.update(
        u64::try_from(bytes.len())
            .map_err(|_| ReadOnlyStoreError::NumericOverflow)?
            .to_be_bytes(),
    );
    hasher.update(bytes);
    Ok(format!("sha256:{}", hex::encode(hasher.finalize())))
}

#[derive(Debug, Error)]
pub enum ReadOnlyStoreError {
    #[error("read-only store path is invalid")]
    PathInvalid,
    #[error("read-only store path is noncanonical")]
    PathNonCanonical,
    #[error("read-only store database is invalid")]
    DatabaseInvalid,
    #[error("read-only store database changed")]
    DatabaseChanged,
    #[error("read-only store has an active SQLite sidecar: {0}")]
    ActiveSidecar(PathBuf),
    #[error("query-only SQLite mode is unavailable")]
    QueryOnlyUnavailable,
    #[error("schema version differs: expected {expected}, observed {observed}")]
    SchemaVersionMismatch { expected: i64, observed: i64 },
    #[error("SQLite integrity check failed: {0}")]
    IntegrityFailure(String),
    #[error("table name is invalid")]
    TableNameInvalid,
    #[error("SQLite text is not UTF-8")]
    NonUtf8Text,
    #[error("logical projection encoding failed")]
    Encode,
    #[error("numeric conversion overflowed")]
    NumericOverflow,
    #[error("read-only store filesystem operation failed at {0}: {1:?}")]
    Filesystem(&'static str, std::io::ErrorKind),
    #[error(transparent)]
    Sqlite(#[from] rusqlite::Error),
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        sync::atomic::{AtomicU64, Ordering},
        time::{SystemTime, UNIX_EPOCH},
    };

    static NEXT_TEMP: AtomicU64 = AtomicU64::new(0);

    fn fixture_path(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        std::env::temp_dir().join(format!(
            "hepta-readonly-{label}-{}-{nonce}-{}",
            std::process::id(),
            NEXT_TEMP.fetch_add(1, Ordering::Relaxed)
        ))
    }

    fn create_fixture(path: &Path, reverse: bool) {
        let connection = Connection::open(path).expect("create database");
        connection
            .execute_batch(
                "PRAGMA user_version = 25;
                 PRAGMA application_id = 1213224753;
                 CREATE TABLE campaigns (id TEXT PRIMARY KEY, revision INTEGER NOT NULL);
                 CREATE TABLE nodes (id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL, state TEXT NOT NULL);",
            )
            .expect("schema");
        let campaigns = if reverse {
            [("c2", 2_i64), ("c1", 1_i64)]
        } else {
            [("c1", 1_i64), ("c2", 2_i64)]
        };
        for (id, revision) in campaigns {
            connection
                .execute(
                    "INSERT INTO campaigns (id, revision) VALUES (?1, ?2)",
                    (id, revision),
                )
                .expect("campaign");
        }
        connection
            .execute(
                "INSERT INTO nodes (id, campaign_id, state) VALUES ('n1', 'c1', 'ready')",
                [],
            )
            .expect("node");
        connection.execute_batch("VACUUM;").expect("vacuum");
    }

    #[test]
    fn snapshot_is_byte_preserving_and_logically_deterministic() {
        let left = fixture_path("left");
        let right = fixture_path("right");
        create_fixture(&left, false);
        create_fixture(&right, true);
        let left_bytes = fs::read(&left).expect("left bytes");
        let left_store = ReadOnlyStoreV1::open(&left).expect("left open");
        let right_store = ReadOnlyStoreV1::open(&right).expect("right open");
        let left_snapshot = left_store.snapshot().expect("left snapshot");
        let right_snapshot = right_store.snapshot().expect("right snapshot");
        assert_eq!(left_snapshot.logical_hash, right_snapshot.logical_hash);
        assert_eq!(fs::read(&left).expect("left after"), left_bytes);
        assert!(!PathBuf::from(format!("{}-wal", left.display())).exists());
        assert!(!PathBuf::from(format!("{}-shm", left.display())).exists());
        fs::remove_file(left).expect("remove left");
        fs::remove_file(right).expect("remove right");
    }

    #[test]
    fn wrong_schema_and_active_sidecar_fail_closed() {
        let path = fixture_path("invalid");
        let connection = Connection::open(&path).expect("create");
        connection
            .execute_batch("PRAGMA user_version = 24; CREATE TABLE t (id INTEGER);")
            .expect("schema");
        drop(connection);
        assert!(matches!(
            ReadOnlyStoreV1::open(&path),
            Err(ReadOnlyStoreError::SchemaVersionMismatch { .. })
        ));
        fs::remove_file(&path).expect("remove");

        let path = fixture_path("sidecar");
        create_fixture(&path, false);
        fs::write(format!("{}-wal", path.display()), b"foreign").expect("sidecar");
        assert!(matches!(
            ReadOnlyStoreV1::open(&path),
            Err(ReadOnlyStoreError::ActiveSidecar(_))
        ));
        fs::remove_file(format!("{}-wal", path.display())).expect("remove sidecar");
        fs::remove_file(path).expect("remove database");
    }
}
