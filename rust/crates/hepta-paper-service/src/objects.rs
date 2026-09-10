use crate::ServiceError;
use hepta_codex_protocol::Sha256Digest;
use hepta_control_plane::FilesystemPreparedResultVerifierV1;
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::Write,
    os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
};

/// Private content-addressed objects and fsynced attempt records.
#[derive(Clone, Debug)]
pub struct ObjectStoreV1 {
    root: PathBuf,
    attempts: PathBuf,
}

impl ObjectStoreV1 {
    /// Open/create private state subdirectories without following symlinks.
    pub fn open(state: &Path) -> Result<Self, ServiceError> {
        private_directory(state)?;
        let root = state.join("objects");
        let attempts = state.join("attempts");
        private_directory(&root)?;
        private_directory(&attempts)?;
        Ok(Self { root, attempts })
    }
    /// Object root used by the independent verifier.
    #[must_use]
    pub fn root(&self) -> &Path {
        &self.root
    }
    /// Hard per-object bound shared by writer and verifier.
    #[must_use]
    pub const fn maximum_object_bytes(&self) -> u64 {
        16 * 1024 * 1024
    }
    /// Durably insert exact bytes; an existing corrupt object is never replaced.
    pub fn put(&self, bytes: &[u8]) -> Result<Sha256Digest, ServiceError> {
        if bytes.len() as u64 > self.maximum_object_bytes() {
            return Err(ServiceError::Artifact);
        }
        let raw = hex::encode(Sha256::digest(bytes));
        let hash = format!("sha256:{raw}")
            .parse()
            .map_err(|_| ServiceError::Artifact)?;
        let destination = self.root.join(raw);
        if destination.exists() {
            self.read(&hash)?;
            return Ok(hash);
        }
        // create_new: a torn object is rejected on recovery instead of overwritten.
        write_new(&destination, bytes)?;
        sync_directory(&self.root)?;
        self.read(&hash)?;
        Ok(hash)
    }
    /// Recompute the digest rather than trusting a filename or cached worker claim.
    pub fn read(&self, hash: &Sha256Digest) -> Result<Vec<u8>, ServiceError> {
        FilesystemPreparedResultVerifierV1::new(
            &self.root,
            hash.clone(),
            self.maximum_object_bytes(),
        )
        .map_err(|_| ServiceError::Artifact)?
        .read_object(hash)
        .map_err(|_| ServiceError::Artifact)
    }
    pub(crate) fn attempt_path(&self, request_hash: &Sha256Digest, suffix: &str) -> PathBuf {
        self.attempts.join(format!(
            "{}.{}",
            request_hash.to_string().trim_start_matches("sha256:"),
            suffix
        ))
    }
    pub(crate) fn record(&self, path: &Path, bytes: &[u8]) -> Result<(), ServiceError> {
        write_new(path, bytes)?;
        sync_directory(&self.attempts)
    }
}

fn private_directory(path: &Path) -> Result<(), ServiceError> {
    if !path.is_absolute() {
        return Err(ServiceError::Configuration);
    }
    if !path.exists() {
        fs::DirBuilder::new()
            .mode(0o700)
            .create(path)
            .map_err(|_| ServiceError::Filesystem)?;
    }
    let m = fs::symlink_metadata(path).map_err(|_| ServiceError::Filesystem)?;
    if !m.is_dir() || m.mode() & 0o077 != 0 || fs::canonicalize(path).ok().as_deref() != Some(path)
    {
        return Err(ServiceError::Artifact);
    }
    Ok(())
}
fn write_new(path: &Path, bytes: &[u8]) -> Result<(), ServiceError> {
    let mut f = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(nix::fcntl::OFlag::O_NOFOLLOW.bits())
        .open(path)
        .map_err(|_| ServiceError::Filesystem)?;
    f.write_all(bytes)
        .and_then(|()| f.sync_all())
        .map_err(|_| ServiceError::Filesystem)
}
fn sync_directory(path: &Path) -> Result<(), ServiceError> {
    File::open(path)
        .and_then(|f| f.sync_all())
        .map_err(|_| ServiceError::Filesystem)
}
