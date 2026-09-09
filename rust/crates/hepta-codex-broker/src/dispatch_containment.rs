use crate::{BrokerJournalStoreV1, CodexDispatchError};
use hepta_codex_protocol::Sha256Digest;
use hepta_codex_runtime::{CgroupV2OperationV1, CgroupV2PolicyV1};
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
};

const PREFIX: &str = "codex-containment-";

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ContainmentRecord {
    version: u16,
    operation_id: String,
    request_hash: Sha256Digest,
    delegated_root: PathBuf,
    root_device: u64,
    root_inode: u64,
    operation_device: u64,
    operation_inode: u64,
    operation_changed_seconds: i64,
    operation_changed_nanoseconds: i64,
}

pub(crate) fn bind_containment(
    store: &BrokerJournalStoreV1,
    operation_id: &str,
    state_directory: &Path,
    policy: &CgroupV2PolicyV1,
    operation: &CgroupV2OperationV1,
) -> Result<PathBuf, CodexDispatchError> {
    let journal = store.load_journal(operation_id)?;
    let metadata = fs::symlink_metadata(&policy.delegated_root)?;
    let (
        operation_device,
        operation_inode,
        operation_changed_seconds,
        operation_changed_nanoseconds,
    ) = operation.directory_identity()?;
    let record = ContainmentRecord {
        version: 1,
        operation_id: operation_id.to_owned(),
        request_hash: journal.request_hash,
        delegated_root: policy.delegated_root.clone(),
        root_device: metadata.dev(),
        root_inode: metadata.ino(),
        operation_device,
        operation_inode,
        operation_changed_seconds,
        operation_changed_nanoseconds,
    };
    let path = state_directory.join(format!("{PREFIX}{operation_id}.json"));
    durable_create(&path, &serde_json::to_vec(&record)?)?;
    Ok(path)
}

pub(crate) fn durable_create(path: &Path, bytes: &[u8]) -> Result<(), CodexDispatchError> {
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .mode(0o600)
        .open(path)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    File::open(
        path.parent()
            .ok_or(CodexDispatchError::InvalidBinding("artifact_parent"))?,
    )?
    .sync_all()?;
    Ok(())
}

pub(crate) fn clear_containment_record(path: &Path) -> Result<(), CodexDispatchError> {
    fs::remove_file(path)?;
    File::open(
        path.parent()
            .ok_or(CodexDispatchError::InvalidBinding("containment_parent"))?,
    )?
    .sync_all()?;
    Ok(())
}

/// Kills only exact cgroup directory identities durably bound to this journal.
/// Call before process reconciliation and before opening an execution listener.
/// A replaced subtree or operation directory blocks recovery instead of adopting its PIDs.
pub fn recover_codex_dispatch_containment(
    store: &BrokerJournalStoreV1,
    state_directory: &Path,
    policy: &CgroupV2PolicyV1,
) -> Result<usize, CodexDispatchError> {
    let _quiescence =
        crate::dispatch_backup::acquire_dispatch_lock(state_directory, policy.owner_uid, true)?;
    let root = fs::symlink_metadata(&policy.delegated_root)?;
    let mut recovered = 0;
    let mut scanned = 0;
    for entry in fs::read_dir(state_directory)? {
        scanned += 1;
        if scanned > 100_000 {
            return Err(CodexDispatchError::InvalidBinding("containment_scan_limit"));
        }
        let entry = entry?;
        if !entry.file_name().to_string_lossy().starts_with(PREFIX) {
            continue;
        }
        let metadata = fs::symlink_metadata(entry.path())?;
        if !metadata.is_file()
            || metadata.file_type().is_symlink()
            || metadata.uid() != policy.owner_uid
            || metadata.mode() & 0o7777 != 0o600
            || metadata.nlink() != 1
            || metadata.size() > 8192
        {
            return Err(CodexDispatchError::InvalidBinding("containment_record"));
        }
        let mut bytes = Vec::new();
        File::open(entry.path())?
            .take(8193)
            .read_to_end(&mut bytes)?;
        if bytes.len() > 8192 {
            return Err(CodexDispatchError::InvalidBinding(
                "containment_record_size",
            ));
        }
        let record: ContainmentRecord = serde_json::from_slice(&bytes)?;
        let journal = store.load_journal(&record.operation_id)?;
        if record.version != 1
            || record.request_hash != journal.request_hash
            || record.delegated_root != policy.delegated_root
            || record.root_device != root.dev()
            || record.root_inode != root.ino()
            || entry.file_name()
                != std::ffi::OsString::from(format!("{PREFIX}{}.json", record.operation_id))
        {
            return Err(CodexDispatchError::InvalidBinding(
                "containment_recovery_identity",
            ));
        }
        if let Some(operation) = CgroupV2OperationV1::recover_existing(
            policy.clone(),
            &record.operation_id,
            record.operation_device,
            record.operation_inode,
            record.operation_changed_seconds,
            record.operation_changed_nanoseconds,
        )? {
            operation.kill_and_cleanup()?;
        }
        clear_containment_record(&entry.path())?;
        recovered += 1;
    }
    Ok(recovered)
}

pub(crate) fn validate_private_state(
    path: &Path,
    owner_uid: u32,
) -> Result<(), CodexDispatchError> {
    let metadata = fs::symlink_metadata(path)?;
    if !path.is_absolute()
        || fs::canonicalize(path)? != path
        || !metadata.is_dir()
        || metadata.file_type().is_symlink()
        || metadata.uid() != owner_uid
        || metadata.mode() & 0o7777 != 0o700
    {
        return Err(CodexDispatchError::InvalidBinding(
            "private_state_directory",
        ));
    }
    Ok(())
}
