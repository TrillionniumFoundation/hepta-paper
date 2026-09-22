//! Cooperative dispatch admission over the existing attempt journal.
//!
//! The directory flock serializes current service executors without adding a
//! second ledger or a new backup file. Old binaries must be drained first.
//! Paired records establish local prepared-cache structure only: the existing
//! request/CAS verifier still decides whether a result can be used or committed.

use super::{ObjectStoreV1, PreparedResultStatusV1, PreparedResultV1, ServiceError};
use crate::state_access::private_root;
use nix::fcntl::{Flock, FlockArg, OFlag};
use std::{
    collections::BTreeSet,
    fs::{self, File, Metadata, OpenOptions},
    io::Read,
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
};

const MAX_RECORDS: usize = 4096;
const MAX_RECORD_BYTES: u64 = 1_048_576;
const MAX_TOTAL_BYTES: usize = 16 * 1024 * 1024;

pub(super) struct DispatchGuardV1 {
    file: Flock<File>,
    path: PathBuf,
    identity: Metadata,
}

fn same_node(left: &Metadata, right: &Metadata) -> bool {
    left.dev() == right.dev()
        && left.ino() == right.ino()
        && left.uid() == right.uid()
        && left.mode() == right.mode()
}

fn same_record(left: &Metadata, right: &Metadata) -> bool {
    same_node(left, right)
        && left.len() == right.len()
        && left.nlink() == right.nlink()
        && left.mtime() == right.mtime()
        && left.mtime_nsec() == right.mtime_nsec()
        && left.ctime() == right.ctime()
        && left.ctime_nsec() == right.ctime_nsec()
}

fn read_record(path: &Path, owner: u32) -> Result<Vec<u8>, ServiceError> {
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags((OFlag::O_NOFOLLOW | OFlag::O_NONBLOCK).bits())
        .open(path)
        .map_err(|_| ServiceError::Execution)?;
    let before = file.metadata().map_err(|_| ServiceError::Execution)?;
    if !before.is_file()
        || before.uid() != owner
        || before.nlink() != 1
        || before.mode() & 0o077 != 0
        || before.len() > MAX_RECORD_BYTES
    {
        return Err(ServiceError::Execution);
    }
    let mut bytes = Vec::new();
    Read::by_ref(&mut file)
        .take(MAX_RECORD_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| ServiceError::Execution)?;
    let after = file.metadata().map_err(|_| ServiceError::Execution)?;
    let named = fs::symlink_metadata(path).map_err(|_| ServiceError::Execution)?;
    if bytes.len() as u64 != before.len()
        || !same_record(&before, &after)
        || !same_record(&after, &named)
    {
        return Err(ServiceError::Execution);
    }
    Ok(bytes)
}

impl DispatchGuardV1 {
    pub(super) fn acquire(objects: &ObjectStoreV1) -> Result<Self, ServiceError> {
        let state = objects.root().parent().ok_or(ServiceError::Artifact)?;
        let owner = private_root(state)?.uid();
        let path = state.join("attempts");
        let identity = private_root(&path)?;
        if identity.uid() != owner {
            return Err(ServiceError::Artifact);
        }
        let file = OpenOptions::new()
            .read(true)
            .custom_flags((OFlag::O_DIRECTORY | OFlag::O_NOFOLLOW).bits())
            .open(&path)
            .map_err(|_| ServiceError::Execution)?;
        let file = Flock::lock(file, FlockArg::LockExclusiveNonblock)
            .map_err(|_| ServiceError::Execution)?;
        let guard = Self {
            file,
            path,
            identity,
        };
        guard.validate()?;
        let mut started = BTreeSet::new();
        let mut prepared = BTreeSet::new();
        let mut total_bytes = 0usize;
        for (index, entry) in fs::read_dir(&guard.path)
            .map_err(|_| ServiceError::Execution)?
            .enumerate()
        {
            if index >= MAX_RECORDS {
                return Err(ServiceError::Execution);
            }
            let entry = entry.map_err(|_| ServiceError::Execution)?;
            let name = entry
                .file_name()
                .into_string()
                .map_err(|_| ServiceError::Execution)?;
            let (identity, suffix) = name.rsplit_once('.').ok_or(ServiceError::Execution)?;
            if identity.len() != 64
                || !identity
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
                || !matches!(suffix, "started" | "prepared")
            {
                return Err(ServiceError::Execution);
            }
            let bytes = read_record(&entry.path(), owner)?;
            total_bytes = total_bytes
                .checked_add(bytes.len())
                .ok_or(ServiceError::Execution)?;
            if total_bytes > MAX_TOTAL_BYTES {
                return Err(ServiceError::Execution);
            }
            if suffix == "started" {
                if bytes != format!("sha256:{identity}").as_bytes() {
                    return Err(ServiceError::Execution);
                }
                started.insert(identity.to_owned());
            } else {
                let result: PreparedResultV1 =
                    serde_json::from_slice(&bytes).map_err(|_| ServiceError::Execution)?;
                if result.version != 1
                    || result.status != PreparedResultStatusV1::Prepared
                    || result.external_action_may_have_started
                    || result.artifact_hashes.is_empty()
                    || result.artifact_hashes.len() > 256
                {
                    return Err(ServiceError::Execution);
                }
                prepared.insert(identity.to_owned());
            }
        }
        // A different request/plan/campaign must not evade an earlier ambiguous
        // start. Do not delete records, synthesize results, or silently retry.
        if started != prepared {
            return Err(ServiceError::Execution);
        }
        guard.validate()?;
        Ok(guard)
    }

    pub(super) fn validate(&self) -> Result<(), ServiceError> {
        let named = private_root(&self.path)?;
        let opened = self.file.metadata().map_err(|_| ServiceError::Execution)?;
        if !same_node(&self.identity, &named) || !same_node(&self.identity, &opened) {
            return Err(ServiceError::Execution);
        }
        Ok(())
    }
}
