//! Offline Node-store migration executed by the Rust maintenance boundary.
//!
//! This is deliberately a local, fail-closed operation.  It reuses the
//! embedded migration SQL consumed by the compatibility inspector, requires a
//! canonical private database with no SQLite sidecars, and takes one EXCLUSIVE
//! transaction for the requested range. History and leases are checked under
//! that lock. No production authority is granted.

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

mod control;
mod source;
use control::{MigrationControl, RollbackProgressGuard};
use std::sync::{Arc, atomic::AtomicBool};

const MAX_DATABASE_BYTES: u64 = 16 * 1024 * 1024 * 1024;
/// Default ordinary CLI budget; this does not grant writer authority.
pub const NODE_MIGRATION_DEFAULT_TIMEOUT_MS: u64 = 300_000;
/// Largest accepted native migration invocation budget (one hour).
pub const NODE_MIGRATION_MAX_TIMEOUT_MS: u64 = 3_600_000;
const BUSY_TIMEOUT: Duration = Duration::from_millis(100);

#[derive(Debug, Error)]
pub enum NodeMigrationError {
    #[error("node migration control policy is invalid")]
    ControlPolicy,
    #[error("node migration cancelled before commit")]
    Cancelled,
    #[error("node migration deadline exceeded before commit")]
    DeadlineExceeded,
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
    #[error("node migration outcome requires reconciliation with persisted history")]
    OutcomeUnknown,
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
    for suffix in ["-wal", "-shm", "-journal"] {
        let mut name = path.as_os_str().to_os_string();
        name.push(suffix);
        match fs::symlink_metadata(PathBuf::from(name)) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            // Presence includes dangling links and empty journals. This
            // command never recovers or removes a source sidecar.
            _ => return Err(NodeMigrationError::Sidecar),
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

/// Apply embedded Node migrations through the Rust offline maintenance boundary.
///
/// This operation is intentionally limited to local private stores.  It does
/// not enable production activation, Node retirement, submission or release
/// authority, and it rejects a database with active work leases.
pub fn migrate_node_store_v1(
    path: &Path,
    target_version: Option<u32>,
) -> Result<NodeMigrationReceiptV1, NodeMigrationError> {
    migrate(
        path,
        target_version,
        #[cfg(test)]
        &mut |_| {},
    )
}

/// Closed native invocation options, not a persisted authorization record.
pub struct NodeMigrationOptionsV1 {
    pub path: PathBuf,
    pub target_version: Option<u32>,
    pub timeout: Duration,
}

/// Parse `NODE_DB [TARGET_VERSION] [--timeout-ms POSITIVE_MILLIS]`.
/// Missing, repeated, unknown and unbounded options fail before source IO.
pub fn parse_node_migration_arguments_v1(
    args: &[String],
) -> Result<NodeMigrationOptionsV1, NodeMigrationError> {
    let (path, mut tail) = args.split_first().ok_or(NodeMigrationError::Path)?;
    let target_version = if tail.first().is_some_and(|value| !value.starts_with("--")) {
        let target = tail[0]
            .parse::<u32>()
            .map_err(|_| NodeMigrationError::Target)?;
        tail = &tail[1..];
        Some(target)
    } else {
        None
    };
    if target_version.is_some_and(|target| target == 0 || target > NODE_MIGRATIONS_V1.len() as u32)
    {
        return Err(NodeMigrationError::Target);
    }
    let timeout_ms = match tail {
        [] => NODE_MIGRATION_DEFAULT_TIMEOUT_MS,
        [flag, value] if flag == "--timeout-ms" => value
            .parse::<u64>()
            .map_err(|_| NodeMigrationError::ControlPolicy)?,
        _ => return Err(NodeMigrationError::ControlPolicy),
    };
    if timeout_ms == 0 || timeout_ms > NODE_MIGRATION_MAX_TIMEOUT_MS {
        return Err(NodeMigrationError::ControlPolicy);
    }
    Ok(NodeMigrationOptionsV1 {
        path: PathBuf::from(path),
        target_version,
        timeout: Duration::from_millis(timeout_ms),
    })
}

/// Use the original EXCLUSIVE transaction with a signal token and monotonic
/// budget. Post-COMMIT stop is OutcomeUnknown, never a rollback receipt.
/// Synchronous kernel filesystem IO is not preempted by this control.
pub fn migrate_node_store_with_control_v1(
    path: &Path,
    target_version: Option<u32>,
    stopped: Arc<AtomicBool>,
    timeout: Duration,
) -> Result<NodeMigrationReceiptV1, NodeMigrationError> {
    let control = MigrationControl::bounded(stopped, timeout)?;
    migrate_controlled(
        path,
        target_version,
        &control,
        #[cfg(test)]
        &mut |_| {},
    )
}

fn migrate(
    path: &Path,
    target_version: Option<u32>,
    #[cfg(test)] checkpoint: &mut dyn FnMut(&'static str),
) -> Result<NodeMigrationReceiptV1, NodeMigrationError> {
    migrate_controlled(
        path,
        target_version,
        &MigrationControl::unbounded(),
        #[cfg(test)]
        checkpoint,
    )
}

fn migrate_controlled(
    path: &Path,
    target_version: Option<u32>,
    control: &MigrationControl,
    #[cfg(test)] checkpoint: &mut dyn FnMut(&'static str),
) -> Result<NodeMigrationReceiptV1, NodeMigrationError> {
    control.check()?;
    let (canonical, _) = canonical_private_database(path)?;
    reject_sidecars(&canonical)?;
    let target = target_version.unwrap_or(NODE_MIGRATIONS_V1.len() as u32);
    if target == 0 || target > NODE_MIGRATIONS_V1.len() as u32 {
        return Err(NodeMigrationError::Target);
    }
    // Declare the descriptor before SQLite: error paths close SQLite first.
    // Hashing never opens/closes another descriptor for this database inode.
    let source = source::MigrationSource::open(&canonical)?;
    let flags = OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NOFOLLOW;
    control.check()?;
    let mut connection = Connection::open_with_flags(&canonical, flags)
        .map_err(|error| control.translate(error.into()))?;
    let progress = control.install(&connection)?;
    connection.busy_timeout(control.lock_wait(BUSY_TIMEOUT)?)?;
    connection
        .execute_batch(
            "PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF; PRAGMA synchronous=FULL;",
        )
        .map_err(|error| control.translate(error.into()))?;
    let locking: String = connection
        .query_row("PRAGMA locking_mode=EXCLUSIVE", [], |row| row.get(0))
        .map_err(|error| control.translate(error.into()))?;
    if locking != "exclusive" {
        return Err(NodeMigrationError::History);
    }
    #[cfg(test)]
    checkpoint("before_transaction");
    control.check()?;
    source.assert_current()?;
    reject_sidecars(&canonical)?;
    connection.busy_timeout(control.lock_wait(BUSY_TIMEOUT)?)?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Exclusive)
        .map_err(|error| control.translate(error.into()))?;
    let rollback_progress = RollbackProgressGuard(progress);
    let prepared = (|| -> Result<(u32, Vec<u32>), NodeMigrationError> {
        control.check()?;
        source.assert_current()?;
        reject_sidecars(&canonical)?;
        // Admission comes from the locked state, not an earlier ready observation.
        let before = validate_history(&read_history(&transaction)?)?;
        if before > target {
            return Err(NodeMigrationError::Target);
        }
        if active_leases(&transaction)? {
            return Err(NodeMigrationError::ActiveLease);
        }
        #[cfg(test)]
        checkpoint("after_admission");
        let mut applied_versions = Vec::new();
        for descriptor in NODE_MIGRATIONS_V1
            .iter()
            .filter(|migration| migration.version > before && migration.version <= target)
        {
            control.check()?;
            source.assert_current()?;
            transaction.execute_batch(descriptor.sql)?;
            transaction.execute(
                "INSERT INTO schema_migrations(version,name,migration_sha256) VALUES(?1,?2,?3)",
                (
                    descriptor.version,
                    descriptor.name,
                    migration_hash(descriptor.sql),
                ),
            )?;
            applied_versions.push(descriptor.version);
            #[cfg(test)]
            checkpoint("after_migration");
        }
        if validate_history(&read_history(&transaction)?)? != target {
            return Err(NodeMigrationError::History);
        }
        let integrity: String =
            transaction.query_row("PRAGMA quick_check", [], |row| row.get(0))?;
        let foreign_keys = transaction
            .prepare("PRAGMA foreign_key_check")?
            .exists([])?;
        if integrity != "ok" || foreign_keys {
            return Err(NodeMigrationError::History);
        }
        #[cfg(test)]
        checkpoint("before_commit");
        control.check()?;
        source.assert_current()?;
        control.check()?;
        Ok((before, applied_versions))
    })();
    let (before, applied_versions) = match prepared {
        Ok(prepared) => prepared,
        Err(error) => {
            rollback_progress.disarm();
            // SQLite may already have rolled back an interrupted transaction.
            if transaction.is_autocommit() {
                drop(transaction);
            } else {
                transaction
                    .rollback()
                    .map_err(|_| NodeMigrationError::OutcomeUnknown)?;
            }
            return Err(control.translate(error));
        }
    };
    transaction
        .commit()
        .map_err(|_| NodeMigrationError::OutcomeUnknown)?;
    #[cfg(test)]
    checkpoint("after_commit");
    // EXCLUSIVE locking mode retains the database lock through receipt hashing.
    // Observation failure after COMMIT must not claim rollback or no effect.
    let database_sha256 = source
        .hash_with_check(&mut || control.check())
        .map_err(|_| NodeMigrationError::OutcomeUnknown)?;
    #[cfg(test)]
    checkpoint("after_hash");
    source
        .assert_current()
        .map_err(|_| NodeMigrationError::OutcomeUnknown)?;
    control
        .check()
        .map_err(|_| NodeMigrationError::OutcomeUnknown)?;
    drop(connection);
    drop(source);
    Ok(NodeMigrationReceiptV1 {
        version: 1,
        kind: "HeptaRustNodeStoreMigrationReceiptV1",
        database_path: canonical,
        before_version: before,
        target_version: target,
        applied_versions,
        database_sha256,
        production_activation: false,
        node_retirement_verified: false,
    })
}

#[cfg(test)]
mod tests;
