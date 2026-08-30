//! Immutable, side-effect-free SQLite inspection for schema versions 1 through 25.

#[cfg(not(unix))]
compile_error!("hepta-readonly-control requires Unix file identity semantics");

use std::{
    fs::{self, File},
    io::Read,
    os::unix::fs::MetadataExt,
    path::{Path, PathBuf},
};

use rusqlite::{Connection, OpenFlags, types::ValueRef};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;

const MAXIMUM_DATABASE_BYTES: u64 = 16 * 1024 * 1024 * 1024;

/// Exact immutable database identity observed before and after inspection.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadOnlyDatabaseIdentityV1 {
    /// Canonical absolute path.
    pub canonical_path: String,
    /// Filesystem device.
    pub device: u64,
    /// Filesystem inode.
    pub inode: u64,
    /// POSIX mode.
    pub mode: u32,
    /// Owning UID.
    pub uid: u32,
    /// Owning GID.
    pub gid: u32,
    /// Link count.
    pub link_count: u64,
    /// Byte length.
    pub size: u64,
    /// Exact SQLite file hash.
    pub content_hash: String,
}

/// Deterministic normalized snapshot of one supported database.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReadOnlyStoreSnapshotV1 {
    /// SQLite user version in the supported 1..=25 range.
    pub schema_version: u32,
    /// Number of user tables.
    pub table_count: u64,
    /// Number of rows included in the normalized snapshot.
    pub row_count: u64,
    /// Logical schema-and-row hash.
    pub logical_hash: String,
    /// Exact database identity.
    pub identity: ReadOnlyDatabaseIdentityV1,
}

/// Opens and verifies a database without permitting WAL, SHM, DDL, or writes.
pub fn inspect_read_only_store(path: &Path) -> Result<ReadOnlyStoreSnapshotV1, ReadOnlyStoreError> {
    let before = inspect_identity(path)?;
    reject_sidecars(path)?;
    let uri = format!("file:{}?mode=ro&immutable=1", percent_encode_path(path)?);
    let flags = OpenFlags::SQLITE_OPEN_READ_ONLY
        | OpenFlags::SQLITE_OPEN_URI
        | OpenFlags::SQLITE_OPEN_NO_MUTEX
        | OpenFlags::SQLITE_OPEN_NOFOLLOW;
    let connection = Connection::open_with_flags(uri, flags)?;
    connection.execute_batch(
        "PRAGMA query_only = ON;
         PRAGMA trusted_schema = OFF;
         PRAGMA temp_store = MEMORY;",
    )?;
    let version_i64: i64 = connection.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    let schema_version =
        u32::try_from(version_i64).map_err(|_| ReadOnlyStoreError::SchemaVersion)?;
    if !(1..=25).contains(&schema_version) {
        return Err(ReadOnlyStoreError::SchemaVersion);
    }
    let (table_count, row_count, logical_hash) = logical_snapshot(&connection, schema_version)?;
    drop(connection);
    reject_sidecars(path)?;
    let after = inspect_identity(path)?;
    if before != after {
        return Err(ReadOnlyStoreError::DatabaseChanged);
    }
    Ok(ReadOnlyStoreSnapshotV1 {
        schema_version,
        table_count,
        row_count,
        logical_hash,
        identity: after,
    })
}

fn logical_snapshot(
    connection: &Connection,
    schema_version: u32,
) -> Result<(u64, u64, String), ReadOnlyStoreError> {
    let mut hasher = Sha256::new();
    update_field(&mut hasher, b"HeptaReadOnlyLogicalSnapshotV1");
    update_field(&mut hasher, &schema_version.to_be_bytes());
    let mut statement = connection.prepare(
        "SELECT name, type, COALESCE(sql, '') FROM sqlite_schema
         WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
    )?;
    let objects = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let tables = objects
        .iter()
        .filter(|(_, object_type, _)| object_type == "table")
        .map(|(name, _, _)| name.clone())
        .collect::<Vec<_>>();
    for (name, object_type, sql) in &objects {
        update_field(&mut hasher, object_type.as_bytes());
        update_field(&mut hasher, name.as_bytes());
        update_field(&mut hasher, sql.as_bytes());
    }
    let mut row_count = 0_u64;
    for table in &tables {
        let escaped = quote_identifier(table);
        let pragma = format!("PRAGMA table_info({escaped})");
        let mut columns_statement = connection.prepare(&pragma)?;
        let columns = columns_statement
            .query_map([], |row| row.get::<_, String>(1))?
            .collect::<Result<Vec<_>, _>>()?;
        if columns.is_empty() {
            continue;
        }
        let order = columns
            .iter()
            .map(|column| quote_identifier(column))
            .collect::<Vec<_>>()
            .join(", ");
        let query = format!("SELECT * FROM {escaped} ORDER BY {order}");
        let mut rows_statement = connection.prepare(&query)?;
        let column_count = rows_statement.column_count();
        let mut rows = rows_statement.query([])?;
        while let Some(row) = rows.next()? {
            update_field(&mut hasher, table.as_bytes());
            for index in 0..column_count {
                update_value(&mut hasher, row.get_ref(index)?);
            }
            row_count = row_count
                .checked_add(1)
                .ok_or(ReadOnlyStoreError::NumericOverflow)?;
        }
    }
    let table_count =
        u64::try_from(tables.len()).map_err(|_| ReadOnlyStoreError::NumericOverflow)?;
    Ok((
        table_count,
        row_count,
        format!("sha256:{}", hex::encode(hasher.finalize())),
    ))
}

fn update_value(hasher: &mut Sha256, value: ValueRef<'_>) {
    match value {
        ValueRef::Null => update_field(hasher, b"null"),
        ValueRef::Integer(value) => {
            update_field(hasher, b"integer");
            update_field(hasher, &value.to_be_bytes());
        }
        ValueRef::Real(value) => {
            update_field(hasher, b"real");
            update_field(hasher, &value.to_bits().to_be_bytes());
        }
        ValueRef::Text(value) => {
            update_field(hasher, b"text");
            update_field(hasher, value);
        }
        ValueRef::Blob(value) => {
            update_field(hasher, b"blob");
            update_field(hasher, value);
        }
    }
}

fn inspect_identity(path: &Path) -> Result<ReadOnlyDatabaseIdentityV1, ReadOnlyStoreError> {
    if !path.is_absolute() {
        return Err(ReadOnlyStoreError::PathInvalid);
    }
    let canonical = fs::canonicalize(path).map_err(|_| ReadOnlyStoreError::PathInvalid)?;
    if canonical != path {
        return Err(ReadOnlyStoreError::PathInvalid);
    }
    let metadata = fs::symlink_metadata(path).map_err(|_| ReadOnlyStoreError::PathInvalid)?;
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || metadata.nlink() != 1
        || metadata.size() == 0
        || metadata.size() > MAXIMUM_DATABASE_BYTES
    {
        return Err(ReadOnlyStoreError::PathInvalid);
    }
    let canonical_path = canonical
        .to_str()
        .ok_or(ReadOnlyStoreError::PathInvalid)?
        .to_owned();
    Ok(ReadOnlyDatabaseIdentityV1 {
        canonical_path,
        device: metadata.dev(),
        inode: metadata.ino(),
        mode: metadata.mode() & 0o7777,
        uid: metadata.uid(),
        gid: metadata.gid(),
        link_count: metadata.nlink(),
        size: metadata.size(),
        content_hash: hash_file(path)?,
    })
}

fn reject_sidecars(path: &Path) -> Result<(), ReadOnlyStoreError> {
    for suffix in ["-wal", "-shm", "-journal"] {
        let candidate = PathBuf::from(format!("{}{suffix}", path.display()));
        if fs::symlink_metadata(candidate).is_ok() {
            return Err(ReadOnlyStoreError::SidecarPresent);
        }
    }
    Ok(())
}

fn hash_file(path: &Path) -> Result<String, ReadOnlyStoreError> {
    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }
    Ok(format!("sha256:{}", hex::encode(hasher.finalize())))
}

fn percent_encode_path(path: &Path) -> Result<String, ReadOnlyStoreError> {
    let text = path.to_str().ok_or(ReadOnlyStoreError::PathInvalid)?;
    let mut encoded = String::new();
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'/' | b'-' | b'_' | b'.') {
            encoded.push(char::from(byte));
        } else {
            encoded.push('%');
            encoded.push_str(&format!("{byte:02X}"));
        }
    }
    Ok(encoded)
}

fn quote_identifier(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}

fn update_field(hasher: &mut Sha256, value: &[u8]) {
    hasher.update(u64::try_from(value.len()).unwrap_or(u64::MAX).to_be_bytes());
    hasher.update(value);
}

/// Read-only inspection failure.
#[derive(Debug, Error)]
pub enum ReadOnlyStoreError {
    /// Database path or file identity is unsafe.
    #[error("read-only database path is invalid")]
    PathInvalid,
    /// A mutable SQLite sidecar is present.
    #[error("read-only database has an active sidecar")]
    SidecarPresent,
    /// Schema version is outside 1 through 25.
    #[error("unsupported SQLite schema version")]
    SchemaVersion,
    /// Database changed during inspection.
    #[error("database changed during read-only inspection")]
    DatabaseChanged,
    /// Numeric conversion overflowed.
    #[error("read-only snapshot numeric overflow")]
    NumericOverflow,
    /// SQLite rejected the read-only operation.
    #[error(transparent)]
    Sqlite(#[from] rusqlite::Error),
    /// Filesystem I/O failed.
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

#[cfg(test)]
mod tests {
    use std::{
        fs::{self, OpenOptions},
        os::unix::fs::{OpenOptionsExt, PermissionsExt},
        sync::atomic::{AtomicU64, Ordering},
        time::{SystemTime, UNIX_EPOCH},
    };

    use super::*;

    static NEXT: AtomicU64 = AtomicU64::new(0);

    fn fixture(version: u32) -> (PathBuf, PathBuf) {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "hepta-readonly-{}-{nonce}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).expect("root");
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).expect("root mode");
        let path = root.join("store.sqlite");
        let connection = Connection::open(&path).expect("SQLite fixture");
        connection
            .execute_batch(&format!(
                "PRAGMA journal_mode = DELETE;
                 PRAGMA user_version = {version};
                 CREATE TABLE campaigns(id TEXT PRIMARY KEY, revision INTEGER NOT NULL);
                 INSERT INTO campaigns VALUES ('campaign-1', 2);"
            ))
            .expect("fixture schema");
        drop(connection);
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).expect("db mode");
        (root, path)
    }

    #[test]
    fn schema_one_and_twenty_five_are_byte_preserving() {
        for version in [1, 25] {
            let (root, path) = fixture(version);
            let before = fs::read(&path).expect("before bytes");
            let snapshot = inspect_read_only_store(&path).expect("snapshot");
            assert_eq!(snapshot.schema_version, version);
            assert_eq!(snapshot.table_count, 1);
            assert_eq!(snapshot.row_count, 1);
            assert_eq!(before, fs::read(&path).expect("after bytes"));
            fs::remove_dir_all(root).expect("cleanup");
        }
    }

    #[test]
    fn active_sidecar_and_unknown_schema_fail_closed() {
        let (root, path) = fixture(25);
        let wal = PathBuf::from(format!("{}-wal", path.display()));
        let _file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .mode(0o600)
            .open(&wal)
            .expect("sidecar");
        assert!(matches!(
            inspect_read_only_store(&path),
            Err(ReadOnlyStoreError::SidecarPresent)
        ));
        fs::remove_file(wal).expect("remove sidecar");
        fs::remove_dir_all(root).expect("cleanup");

        let (root, path) = fixture(26);
        assert!(matches!(
            inspect_read_only_store(&path),
            Err(ReadOnlyStoreError::SchemaVersion)
        ));
        fs::remove_dir_all(root).expect("cleanup");
    }
}
