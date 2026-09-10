//! Quiesced journal + durable execution-evidence backup. No process adoption on restore.
use crate::codex_dispatch::hash_bytes;
use crate::dispatch_containment::{durable_create, validate_private_state};
use crate::{
    BrokerBackupPolicyV1, BrokerBackupReceiptV1, BrokerJournalPolicyV1, BrokerJournalStoreV1,
    CodexDispatchError, restore_broker_backup,
};
use hepta_codex_protocol::Sha256Digest;
use nix::fcntl::{Flock, FlockArg};
use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File, OpenOptions},
    io::Read,
    os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
};

const MAX_SIDECAR_BYTES: u64 = 64 * 1024 * 1024;
const MAX_MANIFEST_BYTES: u64 = 4 * 1024 * 1024;

/// Content identity of one private durable result artifact.
#[derive(Clone, Debug, Serialize, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CodexDispatchBackupEntryV1 {
    pub name: String,
    pub content_hash: Sha256Digest,
    pub bytes: u64,
}

/// Immutable complete bundle manifest; its hash must be retained outside the bundle.
#[derive(Clone, Debug, Serialize, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CodexDispatchBackupManifestV1 {
    pub version: u16,
    pub created_at_unix_ms: u64,
    pub journal: BrokerBackupReceiptV1,
    pub source_journal_fingerprint: Sha256Digest,
    pub sidecars: Vec<CodexDispatchBackupEntryV1>,
    pub total_bytes: u64,
    pub requires_requalification: bool,
}

/// Successfully published bundle/restore. This receipt grants no execution authority.
#[derive(Clone, Debug, Serialize, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CodexDispatchBackupBundleReceiptV1 {
    pub version: u16,
    pub directory: PathBuf,
    pub manifest_hash: Sha256Digest,
    pub journal_fingerprint: Sha256Digest,
    pub sidecar_count: usize,
    pub requires_requalification: bool,
}

pub(crate) fn acquire_dispatch_lock(
    state: &Path,
    owner: u32,
    exclusive: bool,
) -> Result<Flock<File>, CodexDispatchError> {
    validate_private_state(state, owner)?;
    let file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .mode(0o600)
        .custom_flags(nix::libc::O_NOFOLLOW)
        .open(state.join("codex-dispatch.lock"))?;
    let metadata = file.metadata()?;
    if !metadata.is_file()
        || metadata.uid() != owner
        || metadata.nlink() != 1
        || metadata.mode() & 0o7777 != 0o600
    {
        return Err(CodexDispatchError::InvalidBinding("dispatch_lock_identity"));
    }
    Flock::lock(
        file,
        if exclusive {
            FlockArg::LockExclusiveNonblock
        } else {
            FlockArg::LockSharedNonblock
        },
    )
    .map_err(|_| CodexDispatchError::InvalidBinding("dispatch_not_quiescent"))
}

/// Acquires exclusive dispatch quiescence and copies the journal plus every durable result.
/// Unreconciled gates/cgroups and a concurrently changing journal are rejected. Manifest
/// publication is the final commit marker; an incomplete directory is never a valid bundle.
pub fn create_quiesced_codex_dispatch_backup(
    store: &BrokerJournalStoreV1,
    state_directory: &Path,
    destination: &Path,
    journal_policy: BrokerJournalPolicyV1,
    backup_policy: BrokerBackupPolicyV1,
    now_unix_ms: u64,
) -> Result<CodexDispatchBackupBundleReceiptV1, CodexDispatchError> {
    validate_policies(journal_policy, backup_policy, now_unix_ms)?;
    let _lock = acquire_dispatch_lock(state_directory, backup_policy.owner_uid, true)?;
    let fingerprint = journal_fingerprint(store)?;
    assert_no_active_processes(store)?;
    let names = sidecar_names(state_directory)?;
    ensure_completed_result_files(store, &names)?;
    create_private_destination(destination, backup_policy.owner_uid)?;
    let state_destination = destination.join("state");
    create_private_destination(&state_destination, backup_policy.owner_uid)?;
    let journal = crate::journal::create_broker_backup_for_dispatch_bundle(
        store,
        &destination.join("journal.sqlite"),
        journal_policy,
        backup_policy,
        now_unix_ms,
    )?;
    let backup_store =
        BrokerJournalStoreV1::open(destination.join("journal.sqlite"), journal_policy)?;
    assert_no_active_processes(&backup_store)?;
    if journal_fingerprint(&backup_store)? != fingerprint {
        return Err(CodexDispatchError::InvalidBinding("backup_journal_changed"));
    }
    drop(backup_store);
    let mut total_bytes = journal.backup_bytes;
    let mut sidecars = Vec::new();
    for name in &names {
        let bytes = read_private(
            &state_directory.join(name),
            backup_policy.owner_uid,
            MAX_SIDECAR_BYTES,
        )?;
        validate_result_binding(store, name, &bytes)?;
        total_bytes = total_bytes
            .checked_add(bytes.len() as u64)
            .ok_or(CodexDispatchError::InvalidBinding("backup_size"))?;
        if total_bytes > backup_policy.maximum_backup_bytes {
            return Err(CodexDispatchError::InvalidBinding("backup_size"));
        }
        durable_create(&state_destination.join(name), &bytes)?;
        sidecars.push(CodexDispatchBackupEntryV1 {
            name: name.clone(),
            content_hash: hash_bytes(&bytes)?,
            bytes: bytes.len() as u64,
        });
    }
    if sidecar_names(state_directory)? != names || journal_fingerprint(store)? != fingerprint {
        return Err(CodexDispatchError::InvalidBinding("backup_source_changed"));
    }
    for entry in &sidecars {
        if hash_bytes(&read_private(
            &state_directory.join(&entry.name),
            backup_policy.owner_uid,
            MAX_SIDECAR_BYTES,
        )?)? != entry.content_hash
        {
            return Err(CodexDispatchError::InvalidBinding("backup_sidecar_changed"));
        }
    }
    let manifest = CodexDispatchBackupManifestV1 {
        version: 1,
        created_at_unix_ms: now_unix_ms,
        journal,
        source_journal_fingerprint: fingerprint.clone(),
        sidecars,
        total_bytes,
        requires_requalification: true,
    };
    let bytes = serde_json::to_vec(&manifest)?;
    if bytes.len() as u64 > MAX_MANIFEST_BYTES {
        return Err(CodexDispatchError::InvalidBinding("backup_manifest_size"));
    }
    durable_create(&destination.join("manifest.json"), &bytes)?;
    Ok(CodexDispatchBackupBundleReceiptV1 {
        version: 1,
        directory: destination.to_owned(),
        manifest_hash: hash_bytes(&bytes)?,
        journal_fingerprint: fingerprint,
        sidecar_count: manifest.sidecars.len(),
        requires_requalification: true,
    })
}

/// Restores only a hash-pinned, complete quiesced bundle into a fresh private directory.
/// Returned journal/state paths are `journal.sqlite` and `state`; no listener, process,
/// cgroup membership, runtime identity or deployment capability is activated or trusted.
pub fn restore_quiesced_codex_dispatch_backup(
    bundle: &Path,
    expected_manifest_hash: &Sha256Digest,
    destination: &Path,
    journal_policy: BrokerJournalPolicyV1,
    backup_policy: BrokerBackupPolicyV1,
    now_unix_ms: u64,
) -> Result<CodexDispatchBackupBundleReceiptV1, CodexDispatchError> {
    validate_policies(journal_policy, backup_policy, now_unix_ms)?;
    validate_private_state(bundle, backup_policy.owner_uid)?;
    validate_private_state(&bundle.join("state"), backup_policy.owner_uid)?;
    let bytes = read_private(
        &bundle.join("manifest.json"),
        backup_policy.owner_uid,
        MAX_MANIFEST_BYTES,
    )?;
    if &hash_bytes(&bytes)? != expected_manifest_hash {
        return Err(CodexDispatchError::InvalidBinding("backup_manifest_hash"));
    }
    let manifest: CodexDispatchBackupManifestV1 = serde_json::from_slice(&bytes)?;
    if manifest.version != 1
        || !manifest.requires_requalification
        || manifest.created_at_unix_ms == 0
        || manifest.sidecars.len() > 10_000
        || manifest.total_bytes > backup_policy.maximum_backup_bytes
    {
        return Err(CodexDispatchError::InvalidBinding("backup_manifest"));
    }
    let names = manifest
        .sidecars
        .iter()
        .map(|entry| entry.name.clone())
        .collect::<Vec<_>>();
    if names.windows(2).any(|pair| pair[0] >= pair[1])
        || sidecar_names(&bundle.join("state"))? != names
    {
        return Err(CodexDispatchError::InvalidBinding(
            "backup_sidecar_manifest",
        ));
    }
    let journal_bytes = read_private(
        &bundle.join("journal.sqlite"),
        backup_policy.owner_uid,
        backup_policy.maximum_backup_bytes,
    )?;
    if journal_bytes.len() as u64 != manifest.journal.backup_bytes
        || hash_bytes(&journal_bytes)? != manifest.journal.backup_content_hash
    {
        return Err(CodexDispatchError::InvalidBinding("backup_journal_hash"));
    }
    // Source bundle database verification may create WAL/SHM; content bytes are checked first.
    let source = BrokerJournalStoreV1::open(bundle.join("journal.sqlite"), journal_policy)?;
    assert_no_active_processes(&source)?;
    ensure_completed_result_files(&source, &names)?;
    if journal_fingerprint(&source)? != manifest.source_journal_fingerprint {
        return Err(CodexDispatchError::InvalidBinding(
            "backup_journal_fingerprint",
        ));
    }
    let mut validated = Vec::new();
    let mut total_bytes = manifest.journal.backup_bytes;
    for entry in &manifest.sidecars {
        let content = read_private(
            &bundle.join("state").join(&entry.name),
            backup_policy.owner_uid,
            MAX_SIDECAR_BYTES,
        )?;
        if content.len() as u64 != entry.bytes || hash_bytes(&content)? != entry.content_hash {
            return Err(CodexDispatchError::InvalidBinding("backup_sidecar_hash"));
        }
        validate_result_binding(&source, &entry.name, &content)?;
        total_bytes = total_bytes
            .checked_add(entry.bytes)
            .ok_or(CodexDispatchError::InvalidBinding("backup_size"))?;
        if total_bytes > backup_policy.maximum_backup_bytes {
            return Err(CodexDispatchError::InvalidBinding("backup_size"));
        }
        validated.push((entry.name.clone(), content));
    }
    if total_bytes != manifest.total_bytes {
        return Err(CodexDispatchError::InvalidBinding("backup_total_size"));
    }
    drop(source);
    create_private_destination(destination, backup_policy.owner_uid)?;
    let state = destination.join("state");
    create_private_destination(&state, backup_policy.owner_uid)?;
    let restored_copy = restore_broker_backup(
        &bundle.join("journal.sqlite"),
        &destination.join("journal.sqlite"),
        journal_policy,
        backup_policy,
        now_unix_ms,
    )?;
    if restored_copy.backup_content_hash != manifest.journal.backup_content_hash
        || restored_copy.backup_bytes != manifest.journal.backup_bytes
    {
        return Err(CodexDispatchError::InvalidBinding(
            "backup_changed_during_restore",
        ));
    }
    for (name, content) in validated {
        durable_create(&state.join(name), &content)?;
    }
    let restored = BrokerJournalStoreV1::open(destination.join("journal.sqlite"), journal_policy)?;
    assert_no_active_processes(&restored)?;
    if journal_fingerprint(&restored)? != manifest.source_journal_fingerprint {
        return Err(CodexDispatchError::InvalidBinding(
            "restored_journal_fingerprint",
        ));
    }
    durable_create(&destination.join("manifest.json"), &bytes)?;
    Ok(CodexDispatchBackupBundleReceiptV1 {
        version: 1,
        directory: destination.to_owned(),
        manifest_hash: expected_manifest_hash.clone(),
        journal_fingerprint: manifest.source_journal_fingerprint,
        sidecar_count: manifest.sidecars.len(),
        requires_requalification: true,
    })
}

fn validate_policies(
    journal: BrokerJournalPolicyV1,
    backup: BrokerBackupPolicyV1,
    now: u64,
) -> Result<(), CodexDispatchError> {
    if journal.owner_uid != backup.owner_uid
        || backup.version != 1
        || now == 0
        || backup.maximum_backup_bytes == 0
        || backup.maximum_backup_bytes > 1024 * 1024 * 1024
    {
        return Err(CodexDispatchError::InvalidBinding("backup_policy"));
    }
    Ok(())
}
fn create_private_destination(path: &Path, owner: u32) -> Result<(), CodexDispatchError> {
    validate_private_state(
        path.parent()
            .ok_or(CodexDispatchError::InvalidBinding("backup_parent"))?,
        owner,
    )?;
    fs::DirBuilder::new().mode(0o700).create(path)?;
    validate_private_state(path, owner)?;
    File::open(
        path.parent()
            .ok_or(CodexDispatchError::InvalidBinding("backup_parent"))?,
    )?
    .sync_all()?;
    Ok(())
}
fn read_private(path: &Path, owner: u32, maximum: u64) -> Result<Vec<u8>, CodexDispatchError> {
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(nix::libc::O_NOFOLLOW)
        .open(path)?;
    let before = file.metadata()?;
    if !before.is_file()
        || before.uid() != owner
        || before.nlink() != 1
        || before.mode() & 0o7777 != 0o600
        || before.len() > maximum
    {
        return Err(CodexDispatchError::InvalidBinding("backup_private_file"));
    }
    let mut bytes = Vec::new();
    (&file)
        .take(maximum.saturating_add(1))
        .read_to_end(&mut bytes)?;
    let after = file.metadata()?;
    if bytes.len() as u64 != before.len()
        || bytes.len() as u64 > maximum
        || before.ctime() != after.ctime()
        || before.ctime_nsec() != after.ctime_nsec()
        || before.mtime() != after.mtime()
        || before.mtime_nsec() != after.mtime_nsec()
    {
        return Err(CodexDispatchError::InvalidBinding("backup_file_changed"));
    }
    Ok(bytes)
}
fn sidecar_names(state: &Path) -> Result<Vec<String>, CodexDispatchError> {
    let mut names = Vec::new();
    for (count, entry) in fs::read_dir(state)?.enumerate() {
        if count > 100_000 {
            return Err(CodexDispatchError::InvalidBinding("backup_directory_limit"));
        }
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with("codex-containment-") || name.starts_with(".hepta-gate-envelope-") {
            return Err(CodexDispatchError::InvalidBinding(
                "backup_unreconciled_execution",
            ));
        }
        if name.starts_with("codex-result-") {
            if !name.ends_with(".json")
                || name.len() > 160
                || !name
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"._-:".contains(&b))
            {
                return Err(CodexDispatchError::InvalidBinding("backup_sidecar_name"));
            }
            names.push(name);
        }
    }
    if names.len() > 10_000 {
        return Err(CodexDispatchError::InvalidBinding("backup_sidecar_count"));
    }
    names.sort();
    Ok(names)
}
fn validate_result_binding(
    store: &BrokerJournalStoreV1,
    name: &str,
    bytes: &[u8],
) -> Result<(), CodexDispatchError> {
    let value: serde_json::Value = serde_json::from_slice(bytes)?;
    let id = value
        .get("operationId")
        .and_then(serde_json::Value::as_str)
        .ok_or(CodexDispatchError::InvalidBinding(
            "backup_result_operation",
        ))?;
    let journal = store.load_journal(id)?;
    if name != format!("codex-result-{id}.json")
        || value.get("requestHash").and_then(serde_json::Value::as_str)
            != Some(journal.request_hash.as_str())
    {
        return Err(CodexDispatchError::InvalidBinding("backup_result_binding"));
    }
    Ok(())
}
fn readonly(store: &BrokerJournalStoreV1) -> Result<Connection, CodexDispatchError> {
    Connection::open_with_flags(
        store.path(),
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NOFOLLOW,
    )
    .map_err(crate::BrokerJournalError::from)
    .map_err(CodexDispatchError::from)
}
fn ensure_completed_result_files(
    store: &BrokerJournalStoreV1,
    names: &[String],
) -> Result<(), CodexDispatchError> {
    let connection = readonly(store)?;
    let mut statement = connection.prepare("SELECT operation_id FROM operation_processes WHERE reconciliation_disposition = 'codex_process_completed'").map_err(crate::BrokerJournalError::from)?;
    let rows = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(crate::BrokerJournalError::from)?;
    for row in rows {
        let name = format!(
            "codex-result-{}.json",
            row.map_err(crate::BrokerJournalError::from)?
        );
        if names.binary_search(&name).is_err() {
            return Err(CodexDispatchError::InvalidBinding(
                "backup_missing_execution_evidence",
            ));
        }
    }
    Ok(())
}

fn assert_no_active_processes(store: &BrokerJournalStoreV1) -> Result<(), CodexDispatchError> {
    let connection = readonly(store)?;
    let active: i64 = connection
        .query_row(
            "SELECT count(*) FROM operation_processes WHERE release_state != 'terminated'",
            [],
            |row| row.get(0),
        )
        .map_err(crate::BrokerJournalError::from)?;
    if active != 0 {
        return Err(CodexDispatchError::InvalidBinding("backup_active_process"));
    }
    Ok(())
}
fn journal_fingerprint(store: &BrokerJournalStoreV1) -> Result<Sha256Digest, CodexDispatchError> {
    store.validate_integrity()?;
    if store.operation_count()? > 10_000 {
        return Err(CodexDispatchError::InvalidBinding("backup_operation_count"));
    }
    let connection = readonly(store)?;
    let mut statement = connection
        .prepare("SELECT operation_id FROM operations ORDER BY operation_id")
        .map_err(crate::BrokerJournalError::from)?;
    let ids = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(crate::BrokerJournalError::from)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(crate::BrokerJournalError::from)?;
    let journals = ids
        .iter()
        .map(|id| store.load_journal(id))
        .collect::<Result<Vec<_>, _>>()?;
    hash_bytes(&serde_json::to_vec(&journals)?)
}
