use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    str::FromStr,
    time::Duration,
};

use hepta_codex_journal::{OperationState, RecoveryDisposition};
use hepta_codex_protocol::Sha256Digest;
use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::{
    codec::{from_i64, state_from_db},
    path::{inspect_database_envelope, verify_database_contract},
    store::{BrokerJournalError, BrokerJournalPolicyV1, BrokerJournalStoreV1},
};

const HARD_MAXIMUM_RECOVERY_ROWS: usize = 10_000;
const HARD_MAXIMUM_BACKUP_BYTES: u64 = 1024 * 1024 * 1024;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BrokerRecoveryCandidateV1 {
    pub operation_id: String,
    pub request_hash: Sha256Digest,
    pub current_state: OperationState,
    pub recovery_disposition: RecoveryDisposition,
    pub prepared_receipt_hash: Option<Sha256Digest>,
    pub updated_at_unix_ms: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct BrokerBackupPolicyV1 {
    pub version: u16,
    pub owner_uid: u32,
    pub owner_gid: Option<u32>,
    pub maximum_backup_bytes: u64,
}

impl BrokerBackupPolicyV1 {
    #[must_use]
    pub const fn strict(owner_uid: u32) -> Self {
        Self {
            version: 1,
            owner_uid,
            owner_gid: None,
            maximum_backup_bytes: 512 * 1024 * 1024,
        }
    }

    fn validate(self) -> Result<Self, BrokerJournalError> {
        if self.version != 1
            || self.maximum_backup_bytes == 0
            || self.maximum_backup_bytes > HARD_MAXIMUM_BACKUP_BYTES
        {
            return Err(BrokerJournalError::InvalidPolicy);
        }
        Ok(self)
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BrokerBackupReceiptV1 {
    pub version: u16,
    pub created_at_unix_ms: u64,
    pub source_path_hash: Sha256Digest,
    pub backup_path_hash: Sha256Digest,
    pub backup_content_hash: Sha256Digest,
    pub backup_bytes: u64,
    pub operation_count: u64,
}

pub fn list_recovery_candidates(
    store: &BrokerJournalStoreV1,
    maximum_rows: usize,
) -> Result<Vec<BrokerRecoveryCandidateV1>, BrokerJournalError> {
    if maximum_rows == 0 || maximum_rows > HARD_MAXIMUM_RECOVERY_ROWS {
        return Err(BrokerJournalError::InvalidPolicy);
    }
    store.validate_integrity()?;
    let connection = open_read_only(store.path())?;
    let limit = i64::try_from(maximum_rows).map_err(|_| BrokerJournalError::NumericOverflow)?;
    let mut statement = connection.prepare(
        "SELECT operation_id, request_hash, current_state, prepared_receipt_hash,
                updated_at_unix_ms
         FROM operations
         WHERE current_state != 'acknowledged'
         ORDER BY updated_at_unix_ms, operation_id
         LIMIT ?1",
    )?;
    let rows = statement.query_map([limit], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, Option<String>>(3)?,
            row.get::<_, i64>(4)?,
        ))
    })?;
    let mut candidates = Vec::new();
    for row in rows {
        let (operation_id, request_hash, state, prepared, updated) = row?;
        let journal = store.load_journal(&operation_id)?;
        let current_state = state_from_db(&state)?;
        if journal.current_state != current_state {
            return Err(BrokerJournalError::OperationRecordMismatch);
        }
        candidates.push(BrokerRecoveryCandidateV1 {
            operation_id,
            request_hash: Sha256Digest::from_str(&request_hash)
                .map_err(|_| BrokerJournalError::CorruptDatabaseValue("request_hash"))?,
            current_state,
            recovery_disposition: journal.recovery_disposition(),
            prepared_receipt_hash: prepared
                .map(|value| {
                    Sha256Digest::from_str(&value).map_err(|_| {
                        BrokerJournalError::CorruptDatabaseValue("prepared_receipt_hash")
                    })
                })
                .transpose()?,
            updated_at_unix_ms: from_i64(updated)?,
        });
    }
    Ok(candidates)
}

pub fn create_broker_backup(
    store: &BrokerJournalStoreV1,
    destination: &Path,
    journal_policy: BrokerJournalPolicyV1,
    backup_policy: BrokerBackupPolicyV1,
    now_unix_ms: u64,
) -> Result<BrokerBackupReceiptV1, BrokerJournalError> {
    let backup_policy = backup_policy.validate()?;
    if now_unix_ms == 0 {
        return Err(BrokerJournalError::InvalidRecordedTime);
    }
    store.validate_integrity()?;
    inspect_destination_parent(destination, backup_policy)?;
    if fs::symlink_metadata(destination).is_ok() {
        return Err(BrokerJournalError::DatabasePathInvalid);
    }

    let source = Connection::open_with_flags(
        store.path(),
        OpenFlags::SQLITE_OPEN_READ_WRITE
            | OpenFlags::SQLITE_OPEN_NO_MUTEX
            | OpenFlags::SQLITE_OPEN_NOFOLLOW,
    )?;
    source.busy_timeout(Duration::from_millis(journal_policy.busy_timeout_ms))?;
    let checkpoint: (i64, i64, i64) = source.query_row(
        "PRAGMA wal_checkpoint(FULL)",
        [],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    )?;
    if checkpoint.0 != 0 || checkpoint.1 != checkpoint.2 {
        return Err(BrokerJournalError::IntegrityCheckFailed(
            "WAL checkpoint did not fully complete".to_owned(),
        ));
    }
    let quoted: String = source.query_row("SELECT quote(?1)", [destination], |row| row.get(0))?;
    source.execute_batch(&format!("VACUUM INTO {quoted};"))?;
    drop(source);

    fs::set_permissions(destination, fs::Permissions::from_mode(0o600))
        .map_err(|error| BrokerJournalError::Filesystem("backup_permissions", error.kind()))?;
    File::open(destination)
        .and_then(|file| file.sync_all())
        .map_err(|error| BrokerJournalError::Filesystem("backup_sync", error.kind()))?;
    sync_parent(destination)?;
    inspect_backup_file(destination, backup_policy)?;
    verify_backup_database(destination, journal_policy, backup_policy)?;

    let (backup_content_hash, backup_bytes) = hash_file(destination, backup_policy.maximum_backup_bytes)?;
    Ok(BrokerBackupReceiptV1 {
        version: 1,
        created_at_unix_ms: now_unix_ms,
        source_path_hash: hash_path(store.path())?,
        backup_path_hash: hash_path(destination)?,
        backup_content_hash,
        backup_bytes,
        operation_count: store.operation_count()?,
    })
}

pub fn restore_broker_backup(
    backup: &Path,
    destination: &Path,
    journal_policy: BrokerJournalPolicyV1,
    backup_policy: BrokerBackupPolicyV1,
    now_unix_ms: u64,
) -> Result<BrokerBackupReceiptV1, BrokerJournalError> {
    let backup_policy = backup_policy.validate()?;
    if now_unix_ms == 0 || backup == destination {
        return Err(BrokerJournalError::InvalidRecordedTime);
    }
    inspect_backup_file(backup, backup_policy)?;
    verify_backup_database(backup, journal_policy, backup_policy)?;
    inspect_destination_parent(destination, backup_policy)?;
    if fs::symlink_metadata(destination).is_ok() {
        return Err(BrokerJournalError::DatabasePathInvalid);
    }

    let temporary = destination.with_extension(format!("restore-{now_unix_ms}.tmp"));
    let mut source = File::open(backup)
        .map_err(|error| BrokerJournalError::Filesystem("backup_open", error.kind()))?;
    let mut target = OpenOptions::new()
        .create_new(true)
        .read(true)
        .write(true)
        .mode(0o600)
        .open(&temporary)
        .map_err(|error| BrokerJournalError::Filesystem("restore_create", error.kind()))?;
    let copied = std::io::copy(&mut source, &mut target)
        .map_err(|error| BrokerJournalError::Filesystem("restore_copy", error.kind()))?;
    if copied == 0 || copied > backup_policy.maximum_backup_bytes {
        return Err(BrokerJournalError::DatabaseFileTooLarge {
            observed: copied,
            maximum: backup_policy.maximum_backup_bytes,
        });
    }
    target
        .flush()
        .and_then(|()| target.sync_all())
        .map_err(|error| BrokerJournalError::Filesystem("restore_sync", error.kind()))?;
    drop(target);
    fs::rename(&temporary, destination)
        .map_err(|error| BrokerJournalError::Filesystem("restore_publish", error.kind()))?;
    sync_parent(destination)?;

    let restored = BrokerJournalStoreV1::open(destination, journal_policy)?;
    restored.validate_integrity()?;
    let (backup_content_hash, backup_bytes) = hash_file(backup, backup_policy.maximum_backup_bytes)?;
    Ok(BrokerBackupReceiptV1 {
        version: 1,
        created_at_unix_ms: now_unix_ms,
        source_path_hash: hash_path(backup)?,
        backup_path_hash: hash_path(destination)?,
        backup_content_hash,
        backup_bytes,
        operation_count: restored.operation_count()?,
    })
}

fn open_read_only(path: &Path) -> Result<Connection, BrokerJournalError> {
    let connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY
            | OpenFlags::SQLITE_OPEN_NO_MUTEX
            | OpenFlags::SQLITE_OPEN_NOFOLLOW,
    )?;
    connection.execute_batch(
        "PRAGMA foreign_keys = ON;
         PRAGMA trusted_schema = OFF;
         PRAGMA temp_store = MEMORY;",
    )?;
    Ok(connection)
}

fn verify_backup_database(
    path: &Path,
    journal_policy: BrokerJournalPolicyV1,
    backup_policy: BrokerBackupPolicyV1,
) -> Result<(), BrokerJournalError> {
    inspect_backup_file(path, backup_policy)?;
    let connection = open_read_only(path)?;
    verify_database_contract(&connection)?;
    let integrity: String = connection.query_row("PRAGMA integrity_check", [], |row| row.get(0))?;
    if integrity != "ok" {
        return Err(BrokerJournalError::IntegrityCheckFailed(integrity));
    }
    let mut foreign_keys = connection.prepare("PRAGMA foreign_key_check")?;
    if foreign_keys.query([])?.next()?.is_some() {
        return Err(BrokerJournalError::ForeignKeyCheckFailed);
    }
    drop(foreign_keys);
    if journal_policy.maximum_database_bytes > backup_policy.maximum_backup_bytes {
        return Err(BrokerJournalError::InvalidPolicy);
    }
    Ok(())
}

fn inspect_destination_parent(
    destination: &Path,
    policy: BrokerBackupPolicyV1,
) -> Result<(), BrokerJournalError> {
    if !destination.is_absolute() || destination.file_name().is_none() {
        return Err(BrokerJournalError::DatabasePathInvalid);
    }
    let parent = destination
        .parent()
        .ok_or(BrokerJournalError::DatabasePathInvalid)?;
    let canonical = fs::canonicalize(parent)
        .map_err(|error| BrokerJournalError::Filesystem("backup_parent", error.kind()))?;
    if canonical != parent {
        return Err(BrokerJournalError::DatabasePathNonCanonical);
    }
    let metadata = fs::symlink_metadata(parent)
        .map_err(|error| BrokerJournalError::Filesystem("backup_parent", error.kind()))?;
    if metadata.file_type().is_symlink()
        || !metadata.is_dir()
        || metadata.uid() != policy.owner_uid
        || policy.owner_gid.is_some_and(|gid| metadata.gid() != gid)
        || metadata.mode() & 0o7777 != 0o700
    {
        return Err(BrokerJournalError::DatabaseParentInvalid);
    }
    Ok(())
}

fn inspect_backup_file(
    path: &Path,
    policy: BrokerBackupPolicyV1,
) -> Result<(), BrokerJournalError> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| BrokerJournalError::Filesystem("backup_file", error.kind()))?;
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || metadata.uid() != policy.owner_uid
        || policy.owner_gid.is_some_and(|gid| metadata.gid() != gid)
        || metadata.mode() & 0o7777 != 0o600
        || metadata.nlink() != 1
        || metadata.size() == 0
        || metadata.size() > policy.maximum_backup_bytes
    {
        return Err(BrokerJournalError::DatabaseFileInvalid);
    }
    Ok(())
}

fn hash_file(
    path: &Path,
    maximum_bytes: u64,
) -> Result<(Sha256Digest, u64), BrokerJournalError> {
    let mut file = File::open(path)
        .map_err(|error| BrokerJournalError::Filesystem("backup_hash", error.kind()))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    let mut total = 0_u64;
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| BrokerJournalError::Filesystem("backup_hash", error.kind()))?;
        if read == 0 {
            break;
        }
        total = total
            .checked_add(u64::try_from(read).map_err(|_| BrokerJournalError::NumericOverflow)?)
            .ok_or(BrokerJournalError::NumericOverflow)?;
        if total > maximum_bytes {
            return Err(BrokerJournalError::DatabaseFileTooLarge {
                observed: total,
                maximum: maximum_bytes,
            });
        }
        hasher.update(&buffer[..read]);
    }
    Ok((digest(hasher)?, total))
}

fn hash_path(path: &Path) -> Result<Sha256Digest, BrokerJournalError> {
    let mut hasher = Sha256::new();
    update_length_prefixed(&mut hasher, b"CanonicalBrokerBackupPathV1");
    update_length_prefixed(&mut hasher, path.as_os_str().as_encoded_bytes());
    digest(hasher)
}

fn update_length_prefixed(hasher: &mut Sha256, bytes: &[u8]) {
    hasher.update(u64::try_from(bytes.len()).unwrap_or(u64::MAX).to_be_bytes());
    hasher.update(bytes);
}

fn digest(hasher: Sha256) -> Result<Sha256Digest, BrokerJournalError> {
    let value = format!("sha256:{}", hex::encode(hasher.finalize()));
    Sha256Digest::from_str(&value).map_err(|_| BrokerJournalError::DigestConstruction)
}

fn sync_parent(path: &Path) -> Result<(), BrokerJournalError> {
    let parent = path
        .parent()
        .ok_or(BrokerJournalError::DatabasePathInvalid)?;
    File::open(parent)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| BrokerJournalError::Filesystem("backup_parent_sync", error.kind()))
}
