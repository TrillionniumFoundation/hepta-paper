//! Durable ACK selection and confirmation within the existing service owner.
//! Neither file grants authority: the caller verifies subject, commit and current
//! trust before any IPC. A confirmation requires a successful broker response.
//! Atomic no-replace publication preserves crash remnants rather than deleting
//! or adopting them. This is cooperative local integrity, not hostile-UID isolation.
use super::{BrokerCommitAcknowledgementMarkerV2, MAX_REQUEST_BYTES, same_file, same_node};
use crate::ServiceError;
use hepta_codex_broker::CommitBoundPreparedResultAcknowledgementV2;
use hepta_codex_protocol::Sha256Digest;
use nix::{
    fcntl::{OFlag, RenameFlags, openat, renameat2},
    sys::stat::{Mode, mkdirat},
};
use std::{
    fs::{self, File, Metadata, OpenOptions},
    io::{Read, Write},
    os::{
        fd::AsFd,
        unix::fs::{MetadataExt, OpenOptionsExt},
    },
    path::{Path, PathBuf},
};

const DIRECTORY: &str = "commit-acknowledgements-v2";
#[derive(Clone, Copy)]
enum RecordKind {
    Intent,
    Confirmed,
}
impl RecordKind {
    fn filename(self, result: &Sha256Digest) -> String {
        let hash = result.as_str().trim_start_matches("sha256:");
        match self {
            Self::Intent => format!("{hash}.intent.json"),
            Self::Confirmed => format!("{hash}.json"),
        }
    }
}

struct Owner {
    root: PathBuf,
    state: File,
    state_metadata: Metadata,
    directory: File,
    directory_metadata: Metadata,
}
impl Owner {
    fn open(root: &Path, create: bool) -> Result<Option<Self>, ServiceError> {
        if !root.is_absolute() || fs::canonicalize(root).ok().as_deref() != Some(root) {
            return Err(ServiceError::Artifact);
        }
        let state = OpenOptions::new()
            .read(true)
            .custom_flags((OFlag::O_DIRECTORY | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC).bits())
            .open(root)
            .map_err(|_| ServiceError::Filesystem)?;
        let state_metadata = state.metadata().map_err(|_| ServiceError::Filesystem)?;
        if !state_metadata.is_dir() || state_metadata.mode() & 0o077 != 0 {
            return Err(ServiceError::Artifact);
        }
        match fs::symlink_metadata(root.join(DIRECTORY)) {
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                if !create {
                    return Ok(None);
                }
                match mkdirat(state.as_fd(), DIRECTORY, Mode::from_bits_truncate(0o700)) {
                    Ok(()) | Err(nix::errno::Errno::EEXIST) => {}
                    Err(_) => return Err(ServiceError::Filesystem),
                }
                state.sync_all().map_err(|_| ServiceError::Filesystem)?;
            }
            Err(_) => return Err(ServiceError::Filesystem),
        }
        let directory = File::from(
            openat(
                state.as_fd(),
                DIRECTORY,
                OFlag::O_RDONLY | OFlag::O_DIRECTORY | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC,
                Mode::empty(),
            )
            .map_err(|_| ServiceError::Artifact)?,
        );
        let directory_metadata = directory.metadata().map_err(|_| ServiceError::Filesystem)?;
        if !directory_metadata.is_dir()
            || directory_metadata.uid() != state_metadata.uid()
            || directory_metadata.gid() != state_metadata.gid()
            || directory_metadata.mode() & 0o7777 != 0o700
        {
            return Err(ServiceError::Artifact);
        }
        let owner = Self {
            root: root.to_path_buf(),
            state,
            state_metadata,
            directory,
            directory_metadata,
        };
        owner.current()?;
        Ok(Some(owner))
    }
    fn current(&self) -> Result<(), ServiceError> {
        let named_state = fs::symlink_metadata(&self.root).map_err(|_| ServiceError::Filesystem)?;
        let directory = self.root.join(DIRECTORY);
        let named_directory =
            fs::symlink_metadata(&directory).map_err(|_| ServiceError::Filesystem)?;
        if !same_node(&self.state_metadata, &named_state)
            || !same_node(
                &self.state_metadata,
                &self
                    .state
                    .metadata()
                    .map_err(|_| ServiceError::Filesystem)?,
            )
            || !same_node(&self.directory_metadata, &named_directory)
            || !same_node(
                &self.directory_metadata,
                &self
                    .directory
                    .metadata()
                    .map_err(|_| ServiceError::Filesystem)?,
            )
            || fs::canonicalize(directory).ok().as_deref()
                != Some(self.root.join(DIRECTORY).as_path())
        {
            return Err(ServiceError::Artifact);
        }
        Ok(())
    }
    fn read(
        &self,
        kind: RecordKind,
        result: &Sha256Digest,
    ) -> Result<Option<BrokerCommitAcknowledgementMarkerV2>, ServiceError> {
        self.current()?;
        let name = kind.filename(result);
        let mut file = match openat(
            self.directory.as_fd(),
            name.as_str(),
            OFlag::O_RDONLY | OFlag::O_NOFOLLOW | OFlag::O_NONBLOCK | OFlag::O_CLOEXEC,
            Mode::empty(),
        ) {
            Ok(file) => File::from(file),
            Err(nix::errno::Errno::ENOENT) => {
                self.current()?;
                return Ok(None);
            }
            Err(_) => return Err(ServiceError::Artifact),
        };
        let before = file.metadata().map_err(|_| ServiceError::Filesystem)?;
        if !before.is_file()
            || before.uid() != self.state_metadata.uid()
            || before.gid() != self.state_metadata.gid()
            || before.nlink() != 1
            || before.mode() & 0o7777 != 0o600
            || before.len() == 0
            || before.len() > MAX_REQUEST_BYTES
        {
            return Err(ServiceError::Artifact);
        }
        let mut bytes = Vec::new();
        Read::by_ref(&mut file)
            .take(MAX_REQUEST_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| ServiceError::Filesystem)?;
        let after = file.metadata().map_err(|_| ServiceError::Filesystem)?;
        let named = fs::symlink_metadata(self.root.join(DIRECTORY).join(name))
            .map_err(|_| ServiceError::Filesystem)?;
        self.current()?;
        let record: BrokerCommitAcknowledgementMarkerV2 =
            serde_json::from_slice(&bytes).map_err(|_| ServiceError::Artifact)?;
        if record.version != 2
            || &record.result_hash != result
            || bytes.len() as u64 != before.len()
            || !same_file(&before, &after)
            || !same_file(&after, &named)
            || serde_json::to_vec(&record).map_err(|_| ServiceError::Artifact)? != bytes
        {
            return Err(ServiceError::Artifact);
        }
        Ok(Some(record))
    }

    fn sync(&self) -> Result<(), ServiceError> {
        self.directory
            .sync_all()
            .and_then(|()| self.state.sync_all())
            .map_err(|_| ServiceError::Filesystem)?;
        self.current()
    }
    fn publish(
        &self,
        kind: RecordKind,
        result: &Sha256Digest,
        acknowledgement: &CommitBoundPreparedResultAcknowledgementV2,
        checkpoint: &mut dyn FnMut(&str) -> Result<(), ServiceError>,
    ) -> Result<(), ServiceError> {
        if let Some(record) = self.read(kind, result)? {
            if record.acknowledgement != *acknowledgement {
                return Err(ServiceError::Artifact);
            }
            return self.sync();
        }
        let record = BrokerCommitAcknowledgementMarkerV2 {
            version: 2,
            result_hash: result.clone(),
            acknowledgement: acknowledgement.clone(),
        };
        let bytes = serde_json::to_vec(&record).map_err(|_| ServiceError::Artifact)?;
        if bytes.is_empty() || bytes.len() as u64 > MAX_REQUEST_BYTES {
            return Err(ServiceError::Artifact);
        }
        let mut nonce = [0u8; 16];
        getrandom::fill(&mut nonce).map_err(|_| ServiceError::Filesystem)?;
        let final_name = kind.filename(result);
        let temporary = format!(".{final_name}.{}.pending", hex::encode(nonce));
        self.current()?;
        let mut file = File::from(
            openat(
                self.directory.as_fd(),
                temporary.as_str(),
                OFlag::O_WRONLY
                    | OFlag::O_CREAT
                    | OFlag::O_EXCL
                    | OFlag::O_NOFOLLOW
                    | OFlag::O_CLOEXEC,
                Mode::from_bits_truncate(0o600),
            )
            .map_err(|_| ServiceError::Filesystem)?,
        );
        // Only this fresh inode is written. Old pending files are never used,
        // removed, repaired or promoted to either an intent or a confirmation.
        checkpoint("created")?;
        let split = bytes.len() / 2;
        file.write_all(&bytes[..split])
            .map_err(|_| ServiceError::Filesystem)?;
        checkpoint("partial")?;
        file.write_all(&bytes[split..])
            .and_then(|()| file.sync_all())
            .map_err(|_| ServiceError::Filesystem)?;
        checkpoint("synced")?;
        let before = file.metadata().map_err(|_| ServiceError::Filesystem)?;
        let named = fs::symlink_metadata(self.root.join(DIRECTORY).join(&temporary))
            .map_err(|_| ServiceError::Filesystem)?;
        if !before.is_file()
            || before.uid() != self.state_metadata.uid()
            || before.gid() != self.state_metadata.gid()
            || before.nlink() != 1
            || before.mode() & 0o7777 != 0o600
            || before.len() != bytes.len() as u64
            || !same_file(&before, &named)
        {
            return Err(ServiceError::Artifact);
        }
        self.current()?;
        renameat2(
            self.directory.as_fd(),
            temporary.as_str(),
            self.directory.as_fd(),
            final_name.as_str(),
            RenameFlags::RENAME_NOREPLACE,
        )
        .map_err(|_| ServiceError::Filesystem)?;
        checkpoint("published")?;
        self.sync()?;
        checkpoint("directory_synced")?;
        let observed = self.read(kind, result)?.ok_or(ServiceError::Artifact)?;
        let named = fs::symlink_metadata(self.root.join(DIRECTORY).join(final_name))
            .map_err(|_| ServiceError::Filesystem)?;
        let after = file.metadata().map_err(|_| ServiceError::Filesystem)?;
        // Rename changes ctime: retain inode identity and compare the final
        // descriptor/named snapshots, not the pre-rename timestamp.
        if !same_node(&before, &after)
            || !same_file(&after, &named)
            || observed.acknowledgement != *acknowledgement
        {
            return Err(ServiceError::Artifact);
        }
        self.current()
    }
}

pub(super) fn read_marker(
    root: &Path,
    result: &Sha256Digest,
) -> Result<Option<BrokerCommitAcknowledgementMarkerV2>, ServiceError> {
    let Some(owner) = Owner::open(root, false)? else {
        return Ok(None);
    };
    let confirmed = owner.read(RecordKind::Confirmed, result)?;
    // Old valid V2 confirmations remain readable. If a selected intent also
    // exists, two different signed facts may never describe the same delivery.
    if let Some(record) = &confirmed {
        if let Some(intent) = owner.read(RecordKind::Intent, result)?
            && intent.acknowledgement != record.acknowledgement
        {
            return Err(ServiceError::Artifact);
        }
        owner.sync()?;
    }
    Ok(confirmed)
}

pub(super) fn select_intent(
    root: &Path,
    result: &Sha256Digest,
    acknowledgement: &CommitBoundPreparedResultAcknowledgementV2,
) -> Result<(), ServiceError> {
    let owner = Owner::open(root, true)?.ok_or(ServiceError::Filesystem)?;
    owner.publish(RecordKind::Intent, result, acknowledgement, &mut |_| Ok(()))
}

pub(super) fn store_marker(
    root: &Path,
    result: Sha256Digest,
    acknowledgement: &CommitBoundPreparedResultAcknowledgementV2,
) -> Result<(), ServiceError> {
    let owner = Owner::open(root, false)?.ok_or(ServiceError::Filesystem)?;
    let intent = owner
        .read(RecordKind::Intent, &result)?
        .ok_or(ServiceError::Artifact)?;
    if intent.acknowledgement != *acknowledgement {
        return Err(ServiceError::Artifact);
    }
    owner.publish(RecordKind::Confirmed, &result, acknowledgement, &mut |_| {
        Ok(())
    })
}

#[cfg(test)]
mod tests;
