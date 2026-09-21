//! Private bounded file observations. No descriptors escape the configuration owner.
use nix::{
    fcntl::{OFlag, open, openat},
    sys::stat::Mode,
};
use std::{
    fs::{self, File, Metadata},
    io::Read,
    os::{fd::AsFd, unix::fs::MetadataExt},
    path::{Component, Path, PathBuf},
};

#[cfg(test)]
#[path = "configuration_file_tests.rs"]
mod tests;

const MAXIMUM_BYTES: u64 = 1024 * 1024;
fn invalid() -> String {
    "autonomous_research_machine_intake_file_invalid_or_changed".into()
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
pub(super) fn resolve(path: &Path, cwd: &Path) -> Result<PathBuf, String> {
    if !cwd.is_absolute() {
        return Err(invalid());
    }
    let joined = if path.is_absolute() {
        path.to_owned()
    } else {
        cwd.join(path)
    };
    let mut out = PathBuf::from("/");
    for component in joined.components() {
        match component {
            Component::Normal(value) => out.push(value),
            Component::ParentDir => {
                out.pop();
            }
            Component::RootDir | Component::CurDir => (),
            _ => return Err(invalid()),
        }
    }
    Ok(out)
}
pub(super) struct ObservedJsonFile {
    pub(super) bytes: Vec<u8>,
    file: File,
    path: PathBuf,
    before: Metadata,
    parents: Vec<(PathBuf, File)>,
}
impl ObservedJsonFile {
    pub(super) fn read(path: &Path, cwd: &Path) -> Result<Self, String> {
        let path = resolve(path, cwd)?;
        let directory_flags =
            OFlag::O_PATH | OFlag::O_DIRECTORY | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC;
        let mut directory = File::from(
            open(Path::new("/"), directory_flags, Mode::empty()).map_err(|_| invalid())?,
        );
        let mut cursor = PathBuf::from("/");
        let mut parents = Vec::new();
        let mut parts = path
            .components()
            .filter_map(|p| {
                if let Component::Normal(p) = p {
                    Some(p)
                } else {
                    None
                }
            })
            .peekable();
        let mut selected = None;
        while let Some(part) = parts.next() {
            let last = parts.peek().is_none();
            let flags = if last {
                OFlag::O_RDONLY | OFlag::O_NOFOLLOW | OFlag::O_NONBLOCK | OFlag::O_CLOEXEC
            } else {
                directory_flags
            };
            let file = File::from(
                openat(directory.as_fd(), Path::new(part), flags, Mode::empty())
                    .map_err(|_| invalid())?,
            );
            parents.push((cursor.clone(), directory));
            cursor.push(part);
            if last {
                selected = Some(file);
                break;
            }
            directory = file;
        }
        let mut file = selected.ok_or_else(invalid)?;
        let before = file.metadata().map_err(|_| invalid())?;
        if !before.is_file()
            || before.mode() & 0o022 != 0
            || !(2..=MAXIMUM_BYTES).contains(&before.len())
        {
            return Err(invalid());
        }
        let mut bytes = Vec::new();
        file.by_ref()
            .take(MAXIMUM_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| invalid())?;
        if bytes.len() as u64 != before.len() || bytes.len() as u64 > MAXIMUM_BYTES {
            return Err(invalid());
        }
        let value = Self {
            bytes,
            file,
            path,
            before,
            parents,
        };
        value.assert_current()?;
        Ok(value)
    }
    pub(super) fn assert_current(&self) -> Result<(), String> {
        for (path, held) in &self.parents {
            let named = fs::symlink_metadata(path).map_err(|_| invalid())?;
            let opened = held.metadata().map_err(|_| invalid())?;
            if !named.is_dir()
                || named.is_symlink()
                || named.dev() != opened.dev()
                || named.ino() != opened.ino()
            {
                return Err(invalid());
            }
        }
        if !same(&self.before, &self.file.metadata().map_err(|_| invalid())?)
            || !same(
                &self.before,
                &fs::symlink_metadata(&self.path).map_err(|_| invalid())?,
            )
        {
            return Err(invalid());
        }
        Ok(())
    }
}
