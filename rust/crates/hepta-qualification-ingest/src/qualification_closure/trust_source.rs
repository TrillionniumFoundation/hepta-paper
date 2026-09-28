//! Retained authority input, not another trust store or replay ledger.
//! No file is opened or closed during currentness checks: closing an aliased
//! descriptor while SQLite is live could release unrelated POSIX record locks.
use super::{AuthorityFileObservationV1, ClosureError, inspect_ancestors, same_file};
use std::{
    fs::{self, File, OpenOptions},
    os::unix::fs::{FileExt, MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
    sync::Mutex,
};

#[derive(Debug)]
struct DirectoryPin {
    path: PathBuf,
    file: File,
    identity: fs::Metadata,
}

#[derive(Debug)]
struct Currentness {
    invalidated: bool,
    maximum_observed_unix_ms: u64,
}

/// Clones of the request share this owner and its irreversible invalidation.
#[derive(Debug)]
pub(super) struct RetainedResearchTrustSourceV3 {
    path: PathBuf,
    file: File,
    identity: fs::Metadata,
    directories: Vec<DirectoryPin>,
    hash: String,
    issued_at_unix_ms: u64,
    expires_at_unix_ms: u64,
    state: Mutex<Currentness>,
}

fn same_directory(left: &fs::Metadata, right: &fs::Metadata) -> bool {
    left.is_dir()
        && right.is_dir()
        && left.dev() == right.dev()
        && left.ino() == right.ino()
        && left.uid() == right.uid()
        && left.gid() == right.gid()
        && left.mode() == right.mode()
}

impl RetainedResearchTrustSourceV3 {
    pub(super) fn retain(
        path: &Path,
        consumer_uid: u32,
        observation: AuthorityFileObservationV1,
        issued_at_unix_ms: u64,
        expires_at_unix_ms: u64,
        observed_at_unix_ms: u64,
    ) -> Result<Self, ClosureError> {
        inspect_ancestors(path, consumer_uid)?;
        let mut directories = Vec::new();
        for parent in path.ancestors().skip(1) {
            let named = fs::symlink_metadata(parent)?;
            let file = OpenOptions::new()
                .read(true)
                .custom_flags(nix::libc::O_DIRECTORY | nix::libc::O_NOFOLLOW | nix::libc::O_CLOEXEC)
                .open(parent)?;
            let identity = file.metadata()?;
            if !same_directory(&named, &identity) {
                return Err(ClosureError::FileChanged);
            }
            directories.push(DirectoryPin {
                path: parent.to_owned(),
                file,
                identity,
            });
        }
        let source = Self {
            path: path.to_owned(),
            file: observation.file,
            identity: observation.identity,
            directories,
            hash: super::hash_bytes(&observation.bytes),
            issued_at_unix_ms,
            expires_at_unix_ms,
            state: Mutex::new(Currentness {
                invalidated: false,
                maximum_observed_unix_ms: observed_at_unix_ms,
            }),
        };
        source.verify_source()?;
        Ok(source)
    }

    fn verify_identity(&self) -> Result<(), ClosureError> {
        for pin in &self.directories {
            let named = fs::symlink_metadata(&pin.path)?;
            if !same_directory(&pin.identity, &pin.file.metadata()?)
                || !same_directory(&pin.identity, &named)
            {
                return Err(ClosureError::FileChanged);
            }
        }
        if !same_file(&self.identity, &self.file.metadata()?)
            || !same_file(&self.identity, &fs::symlink_metadata(&self.path)?)
        {
            return Err(ClosureError::FileChanged);
        }
        Ok(())
    }

    fn verify_source(&self) -> Result<(), ClosureError> {
        self.verify_identity()?;
        // The original authority read already established the 1 MiB bound.
        // Read through the retained descriptor, never the potentially rebound name.
        let count = usize::try_from(self.identity.len()).map_err(|_| ClosureError::FileChanged)?;
        let mut bytes = vec![0; count];
        self.file.read_exact_at(&mut bytes, 0)?;
        if self.file.read_at(&mut [0; 1], self.identity.len())? != 0
            || super::hash_bytes(&bytes) != self.hash
        {
            return Err(ClosureError::FileChanged);
        }
        self.verify_identity()
    }

    /// Sample time after the last retained-file I/O. A changed source, failed
    /// read, expired trust window or regressing clock permanently closes this
    /// request lifetime, including all clones. Fresh admission is a new owner.
    pub(super) fn observe_current(
        &self,
        minimum_unix_ms: u64,
        clock: impl FnOnce() -> Result<u64, ClosureError>,
    ) -> Result<u64, ClosureError> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| ClosureError::ResearchAuthorityNotCurrent)?;
        if state.invalidated {
            return Err(ClosureError::ResearchAuthorityNotCurrent);
        }
        let result = (|| {
            self.verify_source()?;
            let now = clock()?;
            if now == 0 || i64::try_from(now).is_err() {
                return Err(ClosureError::ClockInvalid);
            }
            if now < minimum_unix_ms || now < state.maximum_observed_unix_ms {
                return Err(ClosureError::ClockRollback);
            }
            if now < self.issued_at_unix_ms || now >= self.expires_at_unix_ms {
                return Err(ClosureError::TrustStoreInvalid);
            }
            state.maximum_observed_unix_ms = now;
            Ok(now)
        })();
        if result.is_err() {
            state.invalidated = true;
        }
        result
    }
}

#[cfg(test)]
mod tests;
