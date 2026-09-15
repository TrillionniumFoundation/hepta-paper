//! Cooperative service/maintenance exclusion. This is not a production permit.
//!
//! Old binaries and direct database writers do not participate. They must be
//! drained before enrollment; a file lock cannot retroactively fence them.
use crate::ServiceError;
use nix::fcntl::{Flock, FlockArg, OFlag};
use std::{
    fs::{self, File, Metadata, OpenOptions},
    io::ErrorKind,
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
};

pub(crate) const LOCK_NAME: &str = "state-access-v1.lock";

pub(crate) struct StateAccessGuardV1 {
    file: Flock<File>,
    root: PathBuf,
    identity: Metadata,
    exclusive: bool,
}

impl std::fmt::Debug for StateAccessGuardV1 {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("StateAccessGuardV1").finish_non_exhaustive()
    }
}

pub(crate) fn private_root(path: &Path) -> Result<Metadata, ServiceError> {
    let metadata = fs::symlink_metadata(path).map_err(|_| ServiceError::Filesystem)?;
    if !path.is_absolute()
        || !metadata.is_dir()
        || metadata.mode() & 0o077 != 0
        || fs::canonicalize(path).ok().as_deref() != Some(path)
    {
        return Err(ServiceError::Artifact);
    }
    Ok(metadata)
}

fn reject_restore_residue(root: &Path) -> Result<(), ServiceError> {
    match fs::symlink_metadata(root.join("restore-incomplete-v1")) {
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(()),
        _ => Err(ServiceError::Persistence),
    }
}

fn same_node(left: &Metadata, right: &Metadata) -> bool {
    left.dev() == right.dev()
        && left.ino() == right.ino()
        && left.uid() == right.uid()
        && left.mode() == right.mode()
}

fn validate_lock(metadata: &Metadata, owner: u32) -> Result<(), ServiceError> {
    if !metadata.is_file()
        || metadata.uid() != owner
        || metadata.nlink() != 1
        || metadata.mode() & 0o777 != 0o600
        || metadata.len() != 0
    {
        return Err(ServiceError::Artifact);
    }
    Ok(())
}

impl StateAccessGuardV1 {
    /// The caller must retain this guard through its final SQLite/file commit.
    pub(crate) fn shared(root: &Path) -> Result<Self, ServiceError> {
        Self::acquire(root, false, true)
    }

    /// Exclusive access never enrolls a missing lock or repairs damaged state.
    pub(crate) fn exclusive(root: &Path) -> Result<Self, ServiceError> {
        Self::acquire(root, true, false)
    }

    fn acquire(root: &Path, exclusive: bool, enroll: bool) -> Result<Self, ServiceError> {
        let identity = private_root(root)?;
        reject_restore_residue(root)?;
        let path = root.join(LOCK_NAME);
        let flags = (OFlag::O_NOFOLLOW | OFlag::O_NONBLOCK).bits();
        if !exclusive {
            match fs::symlink_metadata(root.join("gc-pending-v1.json")) {
                Err(e) if e.kind() == ErrorKind::NotFound => (),
                _ => return Err(ServiceError::Persistence),
            }
        }
        if enroll {
            match OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .custom_flags(flags)
                .open(&path)
            {
                Ok(file) => {
                    file.sync_all().map_err(|_| ServiceError::Filesystem)?;
                    File::open(root)
                        .and_then(|directory| directory.sync_all())
                        .map_err(|_| ServiceError::Filesystem)?;
                }
                Err(error) if error.kind() == ErrorKind::AlreadyExists => (),
                Err(_) => return Err(ServiceError::Filesystem),
            }
        }
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .custom_flags(flags)
            .open(&path)
            .map_err(|_| ServiceError::Filesystem)?;
        validate_lock(
            &file.metadata().map_err(|_| ServiceError::Filesystem)?,
            identity.uid(),
        )?;
        let mode = if exclusive {
            FlockArg::LockExclusiveNonblock
        } else {
            FlockArg::LockSharedNonblock
        };
        let guard = Self {
            file: Flock::lock(file, mode).map_err(|_| ServiceError::Persistence)?,
            root: root.to_path_buf(),
            identity,
            exclusive,
        };
        guard.validate()?;
        Ok(guard)
    }

    pub(crate) fn validate_for(&self, root: &Path) -> Result<(), ServiceError> {
        if self.root != root {
            return Err(ServiceError::Artifact);
        }
        self.validate()
    }

    pub(crate) fn validate(&self) -> Result<(), ServiceError> {
        reject_restore_residue(&self.root)?;
        if !self.exclusive {
            match fs::symlink_metadata(self.root.join("gc-pending-v1.json")) {
                Err(e) if e.kind() == ErrorKind::NotFound => (),
                _ => return Err(ServiceError::Persistence),
            }
        }
        let root = private_root(&self.root)?;
        let opened = self.file.metadata().map_err(|_| ServiceError::Filesystem)?;
        let named = fs::symlink_metadata(self.root.join(LOCK_NAME))
            .map_err(|_| ServiceError::Filesystem)?;
        validate_lock(&opened, root.uid())?;
        validate_lock(&named, root.uid())?;
        if !same_node(&root, &self.identity) || !same_node(&opened, &named) {
            return Err(ServiceError::Artifact);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        os::unix::fs::{DirBuilderExt, PermissionsExt, symlink},
        sync::{
            Arc,
            atomic::{AtomicU64, Ordering},
        },
    };

    static NEXT: AtomicU64 = AtomicU64::new(0);
    struct Scratch(PathBuf);
    impl Scratch {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "hepta-state-access-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::DirBuilder::new()
                .mode(0o700)
                .create(&path)
                .expect("fresh root");
            Self(fs::canonicalize(path).expect("canonical root"))
        }
    }
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn readers_coexist_and_block_maintenance_until_last_clone_drops() {
        let root = Scratch::new();
        let first = Arc::new(StateAccessGuardV1::shared(&root.0).expect("first"));
        let clone = Arc::clone(&first);
        let second = StateAccessGuardV1::shared(&root.0).expect("second");
        assert!(StateAccessGuardV1::exclusive(&root.0).is_err());
        drop(first);
        drop(second);
        assert!(StateAccessGuardV1::exclusive(&root.0).is_err());
        drop(clone);
        let exclusive = StateAccessGuardV1::exclusive(&root.0).expect("exclusive");
        assert!(StateAccessGuardV1::shared(&root.0).is_err());
        assert!(StateAccessGuardV1::exclusive(&root.0).is_err());
        drop(exclusive);
        assert!(StateAccessGuardV1::shared(&root.0).is_ok());
    }

    #[test]
    fn maintenance_never_enrolls_missing_lock() {
        let root = Scratch::new();
        assert!(StateAccessGuardV1::exclusive(&root.0).is_err());
        assert!(!root.0.join(LOCK_NAME).exists());
    }

    #[test]
    fn replaced_lock_invalidates_existing_guard() {
        let root = Scratch::new();
        let guard = StateAccessGuardV1::shared(&root.0).expect("shared");
        fs::rename(root.0.join(LOCK_NAME), root.0.join("old-lock")).expect("rename");
        drop(StateAccessGuardV1::shared(&root.0).expect("replacement"));
        assert!(guard.validate().is_err());
    }

    #[test]
    fn symlink_lock_is_not_followed() {
        let root = Scratch::new();
        let other = Scratch::new();
        drop(StateAccessGuardV1::shared(&other.0).expect("other lock"));
        symlink(other.0.join(LOCK_NAME), root.0.join(LOCK_NAME)).expect("link");
        assert!(StateAccessGuardV1::shared(&root.0).is_err());
        assert!(StateAccessGuardV1::exclusive(&root.0).is_err());
    }

    #[test]
    fn hardlinked_lock_is_rejected() {
        let root = Scratch::new();
        drop(StateAccessGuardV1::shared(&root.0).expect("enroll"));
        fs::hard_link(root.0.join(LOCK_NAME), root.0.join("alias")).expect("link");
        assert!(StateAccessGuardV1::shared(&root.0).is_err());
    }

    #[test]
    fn nonempty_or_public_lock_is_rejected() {
        let root = Scratch::new();
        drop(StateAccessGuardV1::shared(&root.0).expect("enroll"));
        let path = root.0.join(LOCK_NAME);
        fs::write(&path, b"not a lock").expect("write");
        assert!(StateAccessGuardV1::shared(&root.0).is_err());
        fs::write(&path, b"").expect("clear");
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).expect("chmod");
        assert!(StateAccessGuardV1::shared(&root.0).is_err());
    }

    #[test]
    fn public_or_aliased_root_is_rejected() {
        let root = Scratch::new();
        let parent = Scratch::new();
        let alias = parent.0.join("alias");
        symlink(&root.0, &alias).expect("link");
        assert!(StateAccessGuardV1::shared(&alias).is_err());
        fs::set_permissions(&root.0, fs::Permissions::from_mode(0o755)).expect("chmod");
        assert!(StateAccessGuardV1::shared(&root.0).is_err());
    }
}
