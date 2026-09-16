//! Private staging and no-replace publication. Finalized staging is retained on
//! failure; filesystem snapshots do not exclude later same-user modifications.
use super::*;
use nix::{
    fcntl::{Flock, FlockArg, OFlag, RenameFlags, openat, renameat2},
    sys::stat::{Mode, mkdirat},
};
use std::{
    fs::{self, File},
    io::Write,
    os::{fd::AsFd, unix::fs::MetadataExt},
    path::{Component, Path, PathBuf},
};
fn failure() -> crate::sqlite_mutation_coordinator::SqliteMutationCoordinatorError {
    error("autonomous_research_state_backup_publication_path_changed_or_unsafe")
}
fn valid_name(name: &str) -> bool {
    !name.is_empty() && name != "." && name != ".." && !name.contains(['/', '\\', '\0'])
}
fn same(a: &fs::Metadata, b: &fs::Metadata) -> bool {
    a.dev() == b.dev()
        && a.ino() == b.ino()
        && a.uid() == b.uid()
        && a.mode() == b.mode()
        && a.nlink() == b.nlink()
}
pub(super) struct Directory {
    pub path: PathBuf,
    pub held: File,
    parents: Vec<(PathBuf, File)>,
}
impl Directory {
    pub fn open_or_create(path: &Path, create: bool) -> Result<Self> {
        ensure(
            path.is_absolute()
                && path
                    .components()
                    .all(|c| matches!(c, Component::RootDir | Component::Normal(_))),
            "autonomous_research_state_backup_publication_path_invalid",
        )?;
        let mut cursor = PathBuf::from("/");
        let mut current = File::open("/").map_err(|_| failure())?;
        let mut parents = Vec::new();
        for component in path.components() {
            let Component::Normal(name) = component else {
                continue;
            };
            let opened = openat(
                current.as_fd(),
                Path::new(name),
                OFlag::O_RDONLY | OFlag::O_DIRECTORY | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC,
                Mode::empty(),
            );
            let child = match opened {
                Ok(fd) => File::from(fd),
                Err(nix::errno::Errno::ENOENT) if create => {
                    mkdirat(
                        current.as_fd(),
                        Path::new(name),
                        Mode::from_bits_truncate(0o700),
                    )
                    .map_err(|_| failure())?;
                    File::from(
                        openat(
                            current.as_fd(),
                            Path::new(name),
                            OFlag::O_RDONLY
                                | OFlag::O_DIRECTORY
                                | OFlag::O_NOFOLLOW
                                | OFlag::O_CLOEXEC,
                            Mode::empty(),
                        )
                        .map_err(|_| failure())?,
                    )
                }
                Err(_) => return Err(failure()),
            };
            parents.push((cursor.clone(), current));
            cursor.push(name);
            current = child;
        }
        let dir = Self {
            path: cursor,
            held: current,
            parents,
        };
        dir.assert_current()?;
        Ok(dir)
    }
    pub fn assert_current(&self) -> Result<()> {
        for (path, held) in self
            .parents
            .iter()
            .map(|(p, f)| (p, f))
            .chain(std::iter::once((&self.path, &self.held)))
        {
            let m = fs::symlink_metadata(path).map_err(|_| failure())?;
            let h = held.metadata().map_err(|_| failure())?;
            if !m.is_dir() || m.is_symlink() || !same(&m, &h) {
                return Err(failure());
            }
        }
        let metadata = self.held.metadata().map_err(|_| failure())?;
        ensure(
            metadata.mode() & 0o022 == 0 && metadata.uid() == nix::unistd::getuid().as_raw(),
            "autonomous_research_state_backup_publication_path_changed_or_unsafe",
        )
    }
    pub fn child(&self, name: &str) -> Result<Self> {
        self.assert_current()?;
        ensure(
            valid_name(name),
            "autonomous_research_state_backup_publication_name_invalid",
        )?;
        mkdirat(self.held.as_fd(), name, Mode::from_bits_truncate(0o700)).map_err(|_| failure())?;
        let child = Self::open_or_create(&self.path.join(name), false)?;
        self.assert_current()?;
        Ok(child)
    }
    pub fn write_new(&self, name: &str, bytes: &[u8]) -> Result<()> {
        self.assert_current()?;
        ensure(
            valid_name(name),
            "autonomous_research_state_backup_publication_name_invalid",
        )?;
        let mut file = File::from(
            openat(
                self.held.as_fd(),
                name,
                OFlag::O_WRONLY
                    | OFlag::O_CREAT
                    | OFlag::O_EXCL
                    | OFlag::O_NOFOLLOW
                    | OFlag::O_CLOEXEC,
                Mode::from_bits_truncate(0o600),
            )
            .map_err(|_| failure())?,
        );
        file.write_all(bytes).map_err(|_| failure())?;
        file.sync_all().map_err(|_| failure())?;
        self.assert_current()?;
        self.held.sync_all().map_err(|_| failure())
    }
    pub fn publish_new(&self, staging: &Directory, name: &str) -> Result<PathBuf> {
        self.assert_current()?;
        staging.assert_current()?;
        ensure(
            valid_name(name) && staging.path.parent() == Some(self.path.as_path()),
            "autonomous_research_state_backup_publication_name_invalid",
        )?;
        let stage_name = staging.path.file_name().ok_or_else(failure)?;
        renameat2(
            self.held.as_fd(),
            stage_name,
            self.held.as_fd(),
            name,
            RenameFlags::RENAME_NOREPLACE,
        )
        .map_err(|e| {
            if e == nix::errno::Errno::EEXIST {
                error("autonomous_research_state_backup_bundle_already_exists")
            } else {
                failure()
            }
        })?;
        self.held.sync_all().map_err(|_| failure())?;
        self.assert_current()?;
        let final_path = self.path.join(name);
        let actual = fs::symlink_metadata(&final_path).map_err(|_| failure())?;
        ensure(
            same(&actual, &staging.held.metadata().map_err(|_| failure())?),
            "autonomous_research_state_backup_publication_path_changed_or_unsafe",
        )?;
        Ok(final_path)
    }
}
pub(super) fn nonce() -> Result<String> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes)
        .map_err(|_| error("autonomous_research_state_backup_randomness_unavailable"))?;
    Ok(hex::encode(bytes))
}
/// Compare-and-exchange an expected receipt, retaining any displaced competing
/// bytes on conflict. Cooperating writers serialize with a private exclusive
/// kernel lock. The lock pathname is persistent; process death releases the
/// kernel lock, so a crash cannot strand an empty ownership marker.
pub(super) fn publish_receipt(
    directory: &Directory,
    name: &str,
    receipt: &Value,
    expected: Option<&str>,
) -> Result<()> {
    directory.assert_current()?;
    ensure(
        valid_name(name),
        "autonomous_research_state_backup_publication_name_invalid",
    )?;
    let lock_name = format!(".publication-lock-{name}");
    let lock = File::from(
        openat(
            directory.held.as_fd(),
            lock_name.as_str(),
            OFlag::O_RDWR
                | OFlag::O_CREAT
                | OFlag::O_NOFOLLOW
                | OFlag::O_CLOEXEC
                | OFlag::O_NONBLOCK,
            Mode::from_bits_truncate(0o600),
        )
        .map_err(|_| error("autonomous_research_state_backup_receipt_publication_busy"))?,
    );
    let lock = Flock::lock(lock, FlockArg::LockExclusiveNonblock)
        .map_err(|_| error("autonomous_research_state_backup_receipt_publication_busy"))?;
    let check_lock = || -> Result<()> {
        let held = lock.metadata().map_err(|_| failure())?;
        let named = fs::symlink_metadata(directory.path.join(&lock_name)).map_err(|_| failure())?;
        ensure(
            held.is_file()
                && held.nlink() == 1
                && held.len() == 0
                && held.uid() == nix::unistd::getuid().as_raw()
                && held.mode() & 0o077 == 0
                && same(&held, &named),
            "autonomous_research_state_backup_receipt_publication_lock_changed",
        )?;
        directory.assert_current()
    };
    check_lock()?;
    let result = publish_locked(directory, name, receipt, expected);
    check_lock()?;
    // Do not unlink: doing so permits two writers to lock different inodes.
    result
}

fn publish_locked(
    directory: &Directory,
    name: &str,
    receipt: &Value,
    expected: Option<&str>,
) -> Result<()> {
    let conflict = || error("autonomous_research_state_backup_receipt_publication_conflict");
    let old = match super::files::ObservedFile::open(&directory.path.join(name), 256 * 1024 * 1024)
    {
        Ok(v) => Some(v),
        Err(_) if matches!(fs::symlink_metadata(directory.path.join(name)),Err(e) if e.kind()==std::io::ErrorKind::NotFound) => {
            None
        }
        Err(e) => return Err(e),
    };
    let old_bytes = old
        .as_ref()
        .map(|file| file.bytes(256 * 1024 * 1024))
        .transpose()?;
    if old_bytes.as_ref().map(|b| hash_bytes(b)).as_deref() != expected {
        return Err(conflict());
    }
    let temporary = format!(".pending-{}", nonce()?);
    let bytes = serde_json::to_vec(receipt).map_err(|e| error(e.to_string()))?;
    directory.write_new(&temporary, &bytes)?;
    let new =
        super::files::ObservedFile::open(&directory.path.join(&temporary), 256 * 1024 * 1024)?;
    directory.assert_current()?;
    if let Some(old) = old {
        old.assert_current()?;
        renameat2(
            directory.held.as_fd(),
            temporary.as_str(),
            directory.held.as_fd(),
            name,
            RenameFlags::RENAME_EXCHANGE,
        )
        .map_err(|_| failure())?;
        let displaced =
            super::files::ObservedFile::open(&directory.path.join(&temporary), 256 * 1024 * 1024);
        let current = fs::symlink_metadata(directory.path.join(name)).map_err(|_| failure())?;
        let owns_new = same(&current, &new.file.metadata().map_err(|_| failure())?);
        let displaced_matches = displaced.as_ref().is_ok_and(|f| {
            f.file
                .metadata()
                .is_ok_and(|m| old.file.metadata().is_ok_and(|before| same(&m, &before)))
                && f.bytes(256 * 1024 * 1024).ok().as_ref() == old_bytes.as_ref()
        });
        if !owns_new || !displaced_matches {
            if owns_new {
                let _ = renameat2(
                    directory.held.as_fd(),
                    temporary.as_str(),
                    directory.held.as_fd(),
                    name,
                    RenameFlags::RENAME_EXCHANGE,
                );
                let _ = directory.held.sync_all();
            }
            return Err(conflict());
        }
        // The validated previous receipt remains as crash evidence. It is private,
        // hidden from bundle ranking, and never treated as the current receipt.
    } else {
        renameat2(
            directory.held.as_fd(),
            temporary.as_str(),
            directory.held.as_fd(),
            name,
            RenameFlags::RENAME_NOREPLACE,
        )
        .map_err(|_| conflict())?;
    }
    directory.held.sync_all().map_err(|_| failure())?;
    directory.assert_current()
}

#[cfg(test)]
mod tests;
