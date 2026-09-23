use super::*;
use files::{DatabaseObservation, Directory};
use nix::{
    fcntl::{OFlag, openat},
    sys::stat::{Mode, mkdirat},
    unistd::{UnlinkatFlags, unlinkat},
};
use std::{fs::File, os::unix::fs::MetadataExt, path::PathBuf};
struct PrivateSnapshot {
    parent: Directory,
    directory: Directory,
    name: String,
    copies: Vec<files::FileObservation>,
    shared_memory: Option<File>,
    directory_identity: Value,
}
impl PrivateSnapshot {
    fn create(observation: &DatabaseObservation) -> Result<Self> {
        Self::create_with_sidecars(observation, true)
    }
    fn create_main_only(observation: &DatabaseObservation) -> Result<Self> {
        Self::create_with_sidecars(observation, false)
    }
    fn create_with_sidecars(
        observation: &DatabaseObservation,
        include_sidecars: bool,
    ) -> Result<Self> {
        observation.assert_current()?;
        let (_, mut ancestors) = files::open_root(&std::env::temp_dir())?;
        let parent = ancestors.pop().ok_or_else(files::changed)?;
        let mut random = [0u8; 16];
        getrandom::fill(&mut random).map_err(|_| files::changed())?;
        let name = format!(
            "hepta-state-inventory-{}-{}",
            std::process::id(),
            hex::encode(random)
        );
        mkdirat(
            &parent.held,
            Path::new(&name),
            Mode::from_bits_truncate(0o700),
        )
        .map_err(|_| files::changed())?;
        let directory = parent.child_directory(std::ffi::OsStr::new(&name))?;
        let mut result = Self {
            parent,
            directory,
            name,
            copies: Vec::new(),
            shared_memory: None,
            directory_identity: Value::Null,
        };
        for (name, source) in [
            ("candidate.sqlite", Some(&observation.source)),
            (
                "candidate.sqlite-wal",
                if include_sidecars {
                    observation.wal.as_ref()
                } else {
                    None
                },
            ),
        ] {
            if let Some(source) = source {
                let target = File::from(
                    openat(
                        &result.directory.held,
                        Path::new(name),
                        OFlag::O_RDWR
                            | OFlag::O_CREAT
                            | OFlag::O_EXCL
                            | OFlag::O_NOFOLLOW
                            | OFlag::O_CLOEXEC,
                        Mode::from_bits_truncate(0o600),
                    )
                    .map_err(|_| files::changed())?,
                );
                let copy = files::FileObservation {
                    path: result.directory.path.join(name),
                    metadata: files::identity(&target.metadata().map_err(|_| files::changed())?),
                    file: target,
                    sha256: source.sha256.clone(),
                };
                result.copies.push(copy);
                let copy = result.copies.last_mut().ok_or_else(files::changed)?;
                source.copy_to(&copy.file)?;
                copy.metadata =
                    files::identity(&copy.file.metadata().map_err(|_| files::changed())?);
                copy.assert_current()?;
            }
        }
        if include_sidecars && observation.wal.is_some() {
            // Own the SHM inode before SQLite initializes it, so cleanup never
            // has to delete a file merely because its name looks familiar.
            result.shared_memory = Some(File::from(
                openat(
                    &result.directory.held,
                    Path::new("candidate.sqlite-shm"),
                    OFlag::O_RDWR
                        | OFlag::O_CREAT
                        | OFlag::O_EXCL
                        | OFlag::O_NOFOLLOW
                        | OFlag::O_CLOEXEC,
                    Mode::from_bits_truncate(0o600),
                )
                .map_err(|_| files::changed())?,
            ));
        }
        result
            .directory
            .held
            .sync_all()
            .map_err(|_| files::changed())?;
        result.directory_identity = files::identity(
            &result
                .directory
                .held
                .metadata()
                .map_err(|_| files::changed())?,
        );
        observation.assert_current()?;
        Ok(result)
    }
    fn path(&self) -> PathBuf {
        self.directory.path.join("candidate.sqlite")
    }
    fn assert_current(&self) -> Result<()> {
        self.parent.assert_current()?;
        self.directory.assert_current()?;
        ensure(
            files::identity(
                &self
                    .directory
                    .held
                    .metadata()
                    .map_err(|_| files::changed())?,
            ) == self.directory_identity,
            "autonomous_research_state_database_private_snapshot_changed",
        )?;
        for copy in &self.copies {
            copy.assert_current()?;
        }
        if let Some(file) = &self.shared_memory {
            let named = std::fs::symlink_metadata(self.directory.path.join("candidate.sqlite-shm"))
                .map_err(|_| files::changed())?;
            let held = file.metadata().map_err(|_| files::changed())?;
            ensure(
                named.is_file()
                    && !named.file_type().is_symlink()
                    && named.nlink() == 1
                    && named.dev() == held.dev()
                    && named.ino() == held.ino(),
                "autonomous_research_state_database_private_snapshot_changed",
            )?;
        }
        Ok(())
    }
}
pub(super) fn with_main_only_snapshot<R>(
    observation: &DatabaseObservation,
    inspect: impl FnOnce(&Path) -> Result<R>,
) -> Result<R> {
    // The incumbent health command opens the resident database read-only and
    // does not ask SQLite to recover a WAL. Keep all sidecars descriptor-pinned
    // through observation/assert_current, while matching that main-file read
    // for inert or malformed stale sidecars.
    let snapshot = PrivateSnapshot::create_main_only(observation)?;
    snapshot.assert_current()?;
    let result = inspect(&snapshot.path());
    let unchanged = snapshot
        .assert_current()
        .and_then(|()| observation.assert_current());
    drop(snapshot);
    unchanged?;
    result
}
impl Drop for PrivateSnapshot {
    fn drop(&mut self) {
        for (name, file) in self
            .copies
            .iter()
            .filter_map(|copy| copy.path.file_name().map(|name| (name, &copy.file)))
            .chain(
                self.shared_memory
                    .as_ref()
                    .map(|file| (std::ffi::OsStr::new("candidate.sqlite-shm"), file)),
            )
        {
            let named = std::fs::symlink_metadata(self.directory.fd_path().join(name));
            let held = file.metadata();
            if let (Ok(named), Ok(held)) = (named, held)
                && named.is_file()
                && !named.file_type().is_symlink()
                && named.dev() == held.dev()
                && named.ino() == held.ino()
            {
                let _ = unlinkat(
                    &self.directory.held,
                    Path::new(name),
                    UnlinkatFlags::NoRemoveDir,
                );
            }
        }
        let named = std::fs::symlink_metadata(self.parent.path.join(&self.name));
        let held = self.directory.held.metadata();
        if let (Ok(named), Ok(held)) = (named, held)
            && named.is_dir()
            && !named.file_type().is_symlink()
            && named.dev() == held.dev()
            && named.ino() == held.ino()
        {
            let _ = unlinkat(
                &self.parent.held,
                Path::new(&self.name),
                UnlinkatFlags::RemoveDir,
            );
        }
    }
}
pub(super) fn with_snapshot<R>(
    observation: &DatabaseObservation,
    inspect: impl FnOnce(&Path) -> Result<R>,
) -> Result<R> {
    let snapshot = PrivateSnapshot::create(observation)?;
    snapshot.assert_current()?;
    let result = inspect(&snapshot.path());
    // Source/copy drift cannot be hidden by a successful callback. Cleanup is
    // best effort and removes only inodes created by this snapshot.
    let unchanged = snapshot
        .assert_current()
        .and_then(|()| observation.assert_current());
    drop(snapshot);
    unchanged?;
    result
}
