//! Retained file identity for the existing offline SQLite migration owner.
//! The database descriptor must outlive its SQLite connection: closing any
//! descriptor for the inode can release process-wide POSIX SQLite locks.
use super::{MAX_DATABASE_BYTES, NodeMigrationError, canonical_private_database};
use nix::fcntl::OFlag;
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, Metadata, OpenOptions},
    os::unix::fs::{FileExt, MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
};

pub(super) struct MigrationSource {
    file: File,
    path: PathBuf,
    identity: Metadata,
    parent: PathBuf,
    parent_identity: Metadata,
}
fn same_identity(left: &Metadata, right: &Metadata) -> bool {
    left.dev() == right.dev()
        && left.ino() == right.ino()
        && left.uid() == right.uid()
        && left.gid() == right.gid()
        && left.mode() == right.mode()
        && left.nlink() == right.nlink()
}
impl MigrationSource {
    pub(super) fn open(path: &Path) -> Result<Self, NodeMigrationError> {
        let (path, identity) = canonical_private_database(path)?;
        let parent = path.parent().ok_or(NodeMigrationError::Path)?.to_path_buf();
        let parent_identity = fs::symlink_metadata(&parent)?;
        if !parent_identity.is_dir()
            || parent_identity.uid() != identity.uid()
            || parent_identity.mode() & 0o077 != 0
        {
            return Err(NodeMigrationError::Identity);
        }
        let file = OpenOptions::new()
            .read(true)
            .custom_flags((OFlag::O_NOFOLLOW | OFlag::O_NONBLOCK).bits())
            .open(&path)?;
        let source = Self {
            file,
            path,
            identity,
            parent,
            parent_identity,
        };
        source.assert_current()?;
        let mut header = [0_u8; 100];
        source.file.read_exact_at(&mut header, 0)?;
        if &header[..16] != b"SQLite format 3\0" {
            return Err(NodeMigrationError::History);
        }
        // A WAL-mode header without sidecars is not an offline DELETE source.
        // Opening it with SQLite could recreate sidecars before admission.
        if header[18] != 1 || header[19] != 1 {
            return Err(NodeMigrationError::Sidecar);
        }
        Ok(source)
    }
    pub(super) fn assert_current(&self) -> Result<(), NodeMigrationError> {
        let (path, named) = canonical_private_database(&self.path)?;
        let held = self.file.metadata()?;
        let parent = fs::symlink_metadata(&self.parent)?;
        if path != self.path
            || !same_identity(&self.identity, &named)
            || !same_identity(&self.identity, &held)
            || !same_identity(&self.parent_identity, &parent)
        {
            return Err(NodeMigrationError::Identity);
        }
        Ok(())
    }
    pub(super) fn hash_with_check(
        &self,
        check: &mut dyn FnMut() -> Result<(), NodeMigrationError>,
    ) -> Result<String, NodeMigrationError> {
        check()?;
        self.assert_current()?;
        let before = self.file.metadata()?;
        if before.len() > MAX_DATABASE_BYTES {
            return Err(NodeMigrationError::Identity);
        }
        let mut digest = Sha256::new();
        let mut buffer = [0_u8; 64 * 1024];
        let mut offset = 0;
        while offset < before.len() {
            check()?;
            let remaining = (before.len() - offset).min(buffer.len() as u64) as usize;
            let count = self.file.read_at(&mut buffer[..remaining], offset)?;
            if count == 0 {
                return Err(NodeMigrationError::Identity);
            }
            digest.update(&buffer[..count]);
            offset += count as u64;
        }
        check()?;
        let after = self.file.metadata()?;
        self.assert_current()?;
        if before.len() != after.len()
            || before.mtime() != after.mtime()
            || before.mtime_nsec() != after.mtime_nsec()
            || before.ctime() != after.ctime()
            || before.ctime_nsec() != after.ctime_nsec()
        {
            return Err(NodeMigrationError::Identity);
        }
        Ok(format!("sha256:{}", hex::encode(digest.finalize())))
    }
}
