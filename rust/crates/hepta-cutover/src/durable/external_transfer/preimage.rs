//! Private exact preimage held until the owning journal connection closes.
use super::*;
use hepta_campaign_writer::{WriterDatabasePreimageV1, WriterDatabaseStateV1};
use hepta_codex_protocol::Sha256Digest;
use nix::libc;
use std::{fs::Metadata, os::unix::fs::FileExt, path::Component};

struct Directory {
    path: PathBuf,
    held: File,
    initial: Metadata,
}
impl Directory {
    fn observe(path: PathBuf) -> Result<Self, DurableCutoverError> {
        let held = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_DIRECTORY)
            .open(&path)?;
        let result = Self {
            path,
            initial: held.metadata()?,
            held,
        };
        result.assert_current()?;
        Ok(result)
    }
    fn assert_current(&self) -> Result<(), DurableCutoverError> {
        for observed in [self.held.metadata()?, fs::symlink_metadata(&self.path)?] {
            if !observed.is_dir() || !same_inode(&self.initial, &observed) {
                return Err(DurableCutoverError::IdentityChanged);
            }
        }
        Ok(())
    }
}
fn same_inode(left: &Metadata, right: &Metadata) -> bool {
    left.dev() == right.dev()
        && left.ino() == right.ino()
        && left.mode() == right.mode()
        && left.uid() == right.uid()
        && left.gid() == right.gid()
}
fn same_file(left: &Metadata, right: &Metadata) -> bool {
    same_inode(left, right)
        && left.nlink() == right.nlink()
        && left.len() == right.len()
        && left.mtime() == right.mtime()
        && left.mtime_nsec() == right.mtime_nsec()
        && left.ctime() == right.ctime()
        && left.ctime_nsec() == right.ctime_nsec()
}
fn no_sidecars(path: &Path) -> Result<(), DurableCutoverError> {
    for suffix in ["-wal", "-shm", "-journal"] {
        let mut name = path.as_os_str().to_owned();
        name.push(suffix);
        match fs::symlink_metadata(PathBuf::from(name)) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
            Ok(_) => return Err(DurableCutoverError::DatabasePreimageChanged),
        }
    }
    Ok(())
}

// No Clone/Deserialize and no public constructor/getter. A caller can never
// substitute a reported hash for this actual strict and retained observation.
pub(super) struct ObservedExternalCutoverPreimageV2 {
    path: PathBuf,
    directories: Vec<Directory>,
    source: File,
    initial: Metadata,
    observed: WriterDatabasePreimageV1,
    policy: CampaignWriterPolicyV1,
}
impl ObservedExternalCutoverPreimageV2 {
    pub(super) fn observe(
        path: &Path,
        policy: CampaignWriterPolicyV1,
    ) -> Result<Self, DurableCutoverError> {
        // Validates the incumbent path/policy/owner/mode/size/sidecar contract.
        // Its temporary raw FD closes before any journal connection is opened.
        let observed = inspect_writer_database_preimage_v1(path, policy)?;
        if observed.state != WriterDatabaseStateV1::Existing {
            return Err(DurableCutoverError::DatabasePreimageChanged);
        }
        let parent = path.parent().ok_or(DurableCutoverError::InvalidInput)?;
        let mut selected = PathBuf::from("/");
        let mut directories = vec![Directory::observe(selected.clone())?];
        for component in parent.components() {
            match component {
                Component::RootDir => {}
                Component::Normal(name) => {
                    selected.push(name);
                    directories.push(Directory::observe(selected.clone())?);
                }
                _ => return Err(DurableCutoverError::InvalidInput),
            }
        }
        let immediate = directories
            .last()
            .ok_or(DurableCutoverError::InvalidInput)?;
        if immediate.initial.uid() != policy.owner_uid || immediate.initial.mode() & 0o7777 != 0o700
        {
            return Err(DurableCutoverError::IdentityChanged);
        }
        let source = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK)
            .open(path)?;
        let result = Self {
            path: path.into(),
            directories,
            initial: source.metadata()?,
            source,
            observed,
            policy,
        };
        result.assert_current()?;
        Ok(result)
    }
    pub(super) fn path(&self) -> &Path {
        &self.path
    }
    pub(super) fn hash(&self) -> Result<Sha256Digest, DurableCutoverError> {
        Ok(writer_database_preimage_hash_v1(&self.observed)?)
    }
    pub(super) fn assert_current(&self) -> Result<(), DurableCutoverError> {
        for directory in &self.directories {
            directory.assert_current()?;
        }
        no_sidecars(&self.path)?;
        let validate = |observed: Metadata| -> Result<(), DurableCutoverError> {
            if !observed.is_file()
                || observed.nlink() != 1
                || observed.uid() != self.policy.owner_uid
                || observed.mode() & 0o7777 != 0o600
                || observed.len() == 0
                || observed.len() > self.policy.maximum_database_bytes
                || !same_file(&self.initial, &observed)
            {
                return Err(DurableCutoverError::DatabasePreimageChanged);
            }
            Ok(())
        };
        validate(self.source.metadata()?)?;
        validate(fs::symlink_metadata(&self.path)?)?;
        let mut hasher = Sha256::new();
        let mut offset = 0u64;
        let mut bytes = [0; 64 * 1024];
        loop {
            let count = self.source.read_at(&mut bytes, offset)?;
            if count == 0 {
                break;
            }
            offset = offset
                .checked_add(count as u64)
                .ok_or(DurableCutoverError::NumericOverflow)?;
            if offset > self.policy.maximum_database_bytes {
                return Err(DurableCutoverError::DatabasePreimageChanged);
            }
            hasher.update(&bytes[..count]);
        }
        let hash = format!("sha256:{}", hex::encode(hasher.finalize()));
        if self.observed.byte_count != Some(offset)
            || self
                .observed
                .content_hash
                .as_ref()
                .map(Sha256Digest::as_str)
                != Some(hash.as_str())
        {
            return Err(DurableCutoverError::DatabasePreimageChanged);
        }
        validate(self.source.metadata()?)?;
        validate(fs::symlink_metadata(&self.path)?)?;
        no_sidecars(&self.path)?;
        for directory in &self.directories {
            directory.assert_current()?;
        }
        Ok(())
    }
}
