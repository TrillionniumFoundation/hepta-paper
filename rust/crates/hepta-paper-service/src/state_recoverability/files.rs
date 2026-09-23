//! Bounded observation of live local files. A locally observed hash does not
//! establish external authority. Every consumer retains/rechecks the inode.
use super::*;
use nix::fcntl::{OFlag, openat};
use nix::sys::stat::Mode;
use std::os::{
    fd::AsFd,
    unix::fs::{FileExt, MetadataExt},
};
use std::{
    fs::{self, File, Metadata},
    path::{Component, Path, PathBuf},
};
fn fail() -> crate::sqlite_mutation_coordinator::SqliteMutationCoordinatorError {
    error("autonomous_research_state_recoverability_file_changed_or_unsafe")
}
fn same(a: &Metadata, b: &Metadata) -> bool {
    a.dev() == b.dev()
        && a.ino() == b.ino()
        && a.mode() == b.mode()
        && a.nlink() == b.nlink()
        && a.uid() == b.uid()
        && a.gid() == b.gid()
        && a.len() == b.len()
        && a.mtime() == b.mtime()
        && a.mtime_nsec() == b.mtime_nsec()
        && a.ctime() == b.ctime()
        && a.ctime_nsec() == b.ctime_nsec()
}
fn safe(m: &Metadata, maximum: u64) -> bool {
    m.is_file()
        && m.nlink() == 1
        && m.mode() & 0o022 == 0
        && m.len() > 0
        && m.len() <= maximum
        && [0, nix::unistd::getuid().as_raw()].contains(&m.uid())
}
pub(super) struct ObservedFile {
    pub file: File,
    pub path: PathBuf,
    metadata: Metadata,
    parents: Vec<(PathBuf, File)>,
}
impl ObservedFile {
    pub fn open(path: &Path, maximum: u64) -> Result<Self> {
        ensure(
            path.is_absolute()
                && path
                    .components()
                    .all(|c| matches!(c, Component::RootDir | Component::Normal(_))),
            "autonomous_research_state_recoverability_file_path_invalid",
        )?;
        let mut directory = File::open("/").map_err(|_| fail())?;
        let mut cursor = PathBuf::from("/");
        let mut parents = Vec::new();
        let mut components = path
            .components()
            .filter_map(|c| {
                if let Component::Normal(n) = c {
                    Some(n)
                } else {
                    None
                }
            })
            .peekable();
        while let Some(name) = components.next() {
            let last = components.peek().is_none();
            let file = File::from(
                openat(
                    directory.as_fd(),
                    Path::new(name),
                    OFlag::O_RDONLY
                        | OFlag::O_NOFOLLOW
                        | OFlag::O_CLOEXEC
                        | OFlag::O_NONBLOCK
                        | if last {
                            OFlag::empty()
                        } else {
                            OFlag::O_DIRECTORY
                        },
                    Mode::empty(),
                )
                .map_err(|_| fail())?,
            );
            parents.push((cursor.clone(), directory));
            cursor.push(name);
            if last {
                let metadata = file.metadata().map_err(|_| fail())?;
                ensure(
                    safe(&metadata, maximum),
                    "autonomous_research_state_recoverability_file_changed_or_unsafe",
                )?;
                let value = Self {
                    file,
                    path: cursor,
                    metadata,
                    parents,
                };
                value.assert_current()?;
                return Ok(value);
            }
            directory = file;
        }
        Err(fail())
    }
    pub fn assert_current(&self) -> Result<()> {
        for (path, held) in &self.parents {
            let named = fs::symlink_metadata(path).map_err(|_| fail())?;
            let before = held.metadata().map_err(|_| fail())?;
            if !named.is_dir()
                || named.is_symlink()
                || named.dev() != before.dev()
                || named.ino() != before.ino()
            {
                return Err(fail());
            }
        }
        let held = self.file.metadata().map_err(|_| fail())?;
        let named = fs::symlink_metadata(&self.path).map_err(|_| fail())?;
        if !same(&held, &self.metadata) || !same(&named, &self.metadata) || named.is_symlink() {
            return Err(fail());
        }
        Ok(())
    }
    pub fn bytes(&self, maximum: u64) -> Result<Vec<u8>> {
        self.assert_current()?;
        if self.metadata.len() > maximum {
            return Err(fail());
        }
        let mut bytes = vec![0; usize::try_from(self.metadata.len()).map_err(|_| fail())?];
        self.file.read_exact_at(&mut bytes, 0).map_err(|_| fail())?;
        if bytes.len() as u64 != self.metadata.len() || bytes.len() as u64 > maximum {
            return Err(fail());
        }
        self.assert_current()?;
        Ok(bytes)
    }
}
pub(super) fn no_sidecars(path: &Path) -> Result<()> {
    for suffix in ["-wal", "-shm", "-journal"] {
        if !matches!(fs::symlink_metadata(format!("{}{suffix}",path.display())),Err(e) if e.kind()==std::io::ErrorKind::NotFound)
        {
            return Err(error(
                "autonomous_research_state_recoverability_unstable_sqlite_sidecar",
            ));
        }
    }
    Ok(())
}
