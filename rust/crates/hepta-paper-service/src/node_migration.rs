//! Offline Node-store migration executed by the Rust maintenance boundary.
//!
//! This is deliberately a local, fail-closed operation.  It reuses the
//! embedded migration SQL consumed by the compatibility inspector, requires a
//! canonical private database with no SQLite sidecars, takes an IMMEDIATE
//! transaction for each migration, and never grants production authority.

use hepta_readonly_control::node_schema::NODE_MIGRATIONS_V1;
use rusqlite::{Connection, OpenFlags, OptionalExtension, TransactionBehavior};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    fs,
    os::unix::fs::MetadataExt,
    path::{Path, PathBuf},
    time::Duration,
};
use thiserror::Error;

const MAX_DATABASE_BYTES: u64 = 16 * 1024 * 1024 * 1024;
const BUSY_TIMEOUT: Duration = Duration::from_millis(100);

#[derive(Debug, Error)]
pub enum NodeMigrationError {
    #[error("node migration path is invalid")]
    Path,
    #[error("node migration database is not private or canonical")]
    Identity,
    #[error("node migration database has an active SQLite sidecar")]
    Sidecar,
    #[error("node migration target is invalid")]
    Target,
    #[error("node migration history is invalid")]
    History,
    #[error("node migration has active leases")]
    ActiveLease,
    #[error("node migration database operation failed")]
    Database(#[from] rusqlite::Error),
    #[error("node migration filesystem operation failed")]
    Io(#[from] std::io::Error),
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeMigrationReceiptV1 {
    pub version: u16,
    pub kind: &'static str,
    pub database_path: PathBuf,
    pub before_version: u32,
    pub target_version: u32,
    pub applied_versions: Vec<u32>,
    pub database_sha256: String,
    pub production_activation: bool,
    pub node_retirement_verified: bool,
}

fn canonical_private_database(path: &Path) -> Result<(PathBuf, fs::Metadata), NodeMigrationError> {
    if !path.is_absolute()
        || path.components().any(|part| {
            matches!(
                part,
                std::path::Component::CurDir | std::path::Component::ParentDir
            )
        })
    {
        return Err(NodeMigrationError::Path);
    }
    let canonical = fs::canonicalize(path).map_err(|_| NodeMigrationError::Path)?;
    if canonical != path {
        return Err(NodeMigrationError::Path);
    }
    let metadata = fs::symlink_metadata(path).map_err(|_| NodeMigrationError::Path)?;
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || metadata.nlink() != 1
        || metadata.len() == 0
        || metadata.len() > MAX_DATABASE_BYTES
        || metadata.mode() & 0o077 != 0
        || metadata.uid() != fs::metadata("/proc/self")?.uid()
    {
        return Err(NodeMigrationError::Identity);
    }
    Ok((canonical, metadata))
}

fn reject_sidecars(path: &Path) -> Result<(), NodeMigrationError> {
    for suffix in ["-wal", "-shm"] {
        if path
            .with_extension(format!(
                "{}{}",
                path.extension().and_then(|x| x.to_str()).unwrap_or(""),
                suffix
            ))
            .exists()
            || PathBuf::from(format!("{}{}", path.display(), suffix)).exists()
        {
            return Err(NodeMigrationError::Sidecar);
        }
    }
    Ok(())
}

fn migration_hash(sql: &str) -> String {
    format!("sha256:{}", hex::encode(Sha256::digest(sql.as_bytes())))
}

fn table_exists(connection: &Connection, name: &str) -> Result<bool, rusqlite::Error> {
    connection
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1 LIMIT 1",
            [name],
            |_| Ok(()),
        )
        .optional()
        .map(|value| value.is_some())
}

fn count_if_table(
    connection: &Connection,
    table: &str,
    predicates: &[(&str, &str)],
) -> Result<u64, NodeMigrationError> {
    if !table_exists(connection, table)? {
        return Ok(0);
    }
    let mut columns = std::collections::BTreeSet::new();
    let mut statement = connection.prepare(&format!("PRAGMA table_info({table})"))?;
    for column in statement.query_map([], |row| row.get::<_, String>(1))? {
        columns.insert(column?);
    }
    let clauses = predicates
        .iter()
        .filter(|(column, _)| columns.contains(*column))
        .map(|(_, predicate)| *predicate)
        .collect::<Vec<_>>();
    if clauses.is_empty() {
        return Ok(0);
    }
    let query = format!(
        "SELECT count(*) FROM {table} WHERE {}",
        clauses.join(" OR ")
    );
    let count: i64 = connection.query_row(&query, [], |row| row.get(0))?;
    u64::try_from(count).map_err(|_| NodeMigrationError::History)
}

fn active_leases(connection: &Connection) -> Result<bool, NodeMigrationError> {
    let jobs = count_if_table(
        connection,
        "jobs",
        &[
            ("status", "status IN ('leased','running')"),
            ("lease_owner", "lease_owner IS NOT NULL"),
            ("lease_expires_at", "lease_expires_at IS NOT NULL"),
        ],
    )?;
    let campaign_nodes = count_if_table(
        connection,
        "campaign_nodes",
        &[
            ("status", "status IN ('leased','running')"),
            ("lease_owner", "lease_owner IS NOT NULL"),
            ("lease_expires_at", "lease_expires_at IS NOT NULL"),
        ],
    )?;
    let submissions = count_if_table(
        connection,
        "submission_outbox",
        &[
            ("status", "status='in_flight'"),
            ("claimed_by", "claimed_by IS NOT NULL"),
            ("lease_token", "lease_token IS NOT NULL"),
            ("lease_expires_at", "lease_expires_at IS NOT NULL"),
        ],
    )?;
    // Response consumption was introduced by migration 17.  It is a
    // separate lease-bearing state machine from the outbox itself: a worker
    // may have acknowledged a response while the original outbox row is no
    // longer `in_flight`.  The Node preflight rejects this state before the
    // offline cutover migrations (21-25), so omitting it would let migration
    // proceed while a response consumer can still mutate the store.
    let response_consumption = count_if_table(
        connection,
        "submission_response_consumption",
        &[
            ("state", "state='IN_PROGRESS'"),
            ("claimed_by", "claimed_by IS NOT NULL"),
            ("lease_token", "lease_token IS NOT NULL"),
            ("lease_expires_at", "lease_expires_at IS NOT NULL"),
        ],
    )?;
    Ok(jobs > 0 || campaign_nodes > 0 || submissions > 0 || response_consumption > 0)
}

fn read_history(connection: &Connection) -> Result<Vec<(u32, String, String)>, NodeMigrationError> {
    if !table_exists(connection, "schema_migrations")? {
        return Ok(Vec::new());
    }
    let mut statement = connection
        .prepare("SELECT version,name,migration_sha256 FROM schema_migrations ORDER BY version")?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, u32>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

fn validate_history(rows: &[(u32, String, String)]) -> Result<u32, NodeMigrationError> {
    let mut expected_version = 1_u32;
    for (version, name, hash) in rows {
        if *version != expected_version {
            return Err(NodeMigrationError::History);
        }
        let descriptor = NODE_MIGRATIONS_V1
            .get((*version as usize).saturating_sub(1))
            .ok_or(NodeMigrationError::History)?;
        if descriptor.name != name || migration_hash(descriptor.sql) != *hash {
            return Err(NodeMigrationError::History);
        }
        expected_version = expected_version
            .checked_add(1)
            .ok_or(NodeMigrationError::History)?;
    }
    Ok(expected_version.saturating_sub(1))
}

fn database_sha256(path: &Path) -> Result<String, NodeMigrationError> {
    let bytes = fs::read(path)?;
    Ok(format!("sha256:{}", hex::encode(Sha256::digest(bytes))))
}

/// Apply embedded Node migrations through the Rust offline maintenance boundary.
///
/// This operation is intentionally limited to local private stores.  It does
/// not enable production activation, Node retirement, submission or release
/// authority, and it rejects a database with active work leases.
pub fn migrate_node_store_v1(
    path: &Path,
    target_version: Option<u32>,
) -> Result<NodeMigrationReceiptV1, NodeMigrationError> {
    let (canonical, before_identity) = canonical_private_database(path)?;
    reject_sidecars(&canonical)?;
    let target = target_version.unwrap_or(NODE_MIGRATIONS_V1.len() as u32);
    if target == 0 || target > NODE_MIGRATIONS_V1.len() as u32 {
        return Err(NodeMigrationError::Target);
    }
    let flags = OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NOFOLLOW;
    let mut connection = Connection::open_with_flags(&canonical, flags)?;
    connection.busy_timeout(BUSY_TIMEOUT)?;
    connection.execute_batch("PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF;")?;
    let before = validate_history(&read_history(&connection)?)?;
    if before > target {
        return Err(NodeMigrationError::Target);
    }
    if before > 0 && active_leases(&connection)? {
        return Err(NodeMigrationError::ActiveLease);
    }
    let mut applied_versions = Vec::new();
    for descriptor in NODE_MIGRATIONS_V1
        .iter()
        .filter(|migration| migration.version > before && migration.version <= target)
    {
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        transaction.execute_batch(descriptor.sql)?;
        transaction.execute(
            "INSERT INTO schema_migrations(version,name,migration_sha256) VALUES(?1,?2,?3)",
            (
                descriptor.version,
                descriptor.name,
                migration_hash(descriptor.sql),
            ),
        )?;
        transaction.commit()?;
        applied_versions.push(descriptor.version);
    }
    drop(connection);
    reject_sidecars(&canonical)?;
    let after_identity = fs::symlink_metadata(&canonical).map_err(|_| NodeMigrationError::Path)?;
    if after_identity.uid() != before_identity.uid()
        || after_identity.ino() != before_identity.ino()
        || after_identity.dev() != before_identity.dev()
        || after_identity.nlink() != before_identity.nlink()
    {
        return Err(NodeMigrationError::Identity);
    }
    Ok(NodeMigrationReceiptV1 {
        version: 1,
        kind: "HeptaRustNodeStoreMigrationReceiptV1",
        database_path: canonical,
        before_version: before,
        target_version: target,
        applied_versions,
        database_sha256: database_sha256(path)?,
        production_activation: false,
        node_retirement_verified: false,
    })
}
