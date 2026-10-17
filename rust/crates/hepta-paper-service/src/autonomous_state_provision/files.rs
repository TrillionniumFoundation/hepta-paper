//! Retained, bounded observations. These prove byte identity, never authority.
use nix::{
    fcntl::{OFlag, open, openat},
    sys::stat::Mode,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, Metadata},
    io::{self, Read},
    os::{fd::AsFd, unix::fs::MetadataExt},
    path::{Component, Path, PathBuf},
};

const MAX: u64 = 16 * 1024 * 1024;
fn invalid() -> io::Error {
    io::Error::other("preflight_input_identity_invalid_or_changed")
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
pub(crate) fn absolute(path: &Path) -> io::Result<PathBuf> {
    let joined = if path.is_absolute() {
        path.to_owned()
    } else {
        std::env::current_dir()?.join(path)
    };
    let mut result = PathBuf::from("/");
    for part in joined.components() {
        match part {
            Component::Normal(p) => result.push(p),
            Component::ParentDir => {
                result.pop();
            }
            Component::RootDir | Component::CurDir => (),
            _ => return Err(invalid()),
        }
    }
    Ok(result)
}
pub(crate) struct Snapshot {
    pub bytes: Vec<u8>,
    path: PathBuf,
    file: File,
    before: Metadata,
    parents: Vec<(PathBuf, File)>,
}
impl Snapshot {
    pub fn read(path: &Path) -> io::Result<Self> {
        let path = absolute(path)?;
        let flags = OFlag::O_RDONLY | OFlag::O_NOFOLLOW | OFlag::O_NONBLOCK | OFlag::O_CLOEXEC;
        let mut directory = File::from(
            open(Path::new("/"), flags | OFlag::O_DIRECTORY, Mode::empty())
                .map_err(|_| invalid())?,
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
            let file = File::from(
                openat(
                    directory.as_fd(),
                    Path::new(part),
                    flags
                        | if last {
                            OFlag::empty()
                        } else {
                            OFlag::O_DIRECTORY
                        },
                    Mode::empty(),
                )
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
        let before = file.metadata()?;
        if !before.is_file() || before.nlink() != 1 || before.len() > MAX {
            return Err(invalid());
        }
        let mut bytes = Vec::new();
        file.by_ref().take(MAX + 1).read_to_end(&mut bytes)?;
        if bytes.len() as u64 != before.len() || bytes.len() as u64 > MAX {
            return Err(invalid());
        }
        let snapshot = Self {
            bytes,
            path,
            file,
            before,
            parents,
        };
        snapshot.assert_current()?;
        Ok(snapshot)
    }
    pub fn assert_current(&self) -> io::Result<()> {
        for (path, held) in &self.parents {
            let named = fs::symlink_metadata(path)?;
            let opened = held.metadata()?;
            if !named.is_dir()
                || named.file_type().is_symlink()
                || named.dev() != opened.dev()
                || named.ino() != opened.ino()
            {
                return Err(invalid());
            }
        }
        if !same(&self.before, &self.file.metadata()?)
            || !same(&self.before, &fs::symlink_metadata(&self.path)?)
        {
            return Err(invalid());
        }
        Ok(())
    }
    pub fn observation(&self) -> Value {
        json!({"path": self.path, "observedSha256": format!("sha256:{:x}", Sha256::digest(&self.bytes)), "bytes": self.bytes.len(), "device": self.before.dev(), "inode": self.before.ino(), "semanticVerificationPerformed": false})
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn snapshot_rejects_aliases_fifo_oversize_and_substitution() {
        let mut nonce = [0; 16];
        getrandom::fill(&mut nonce).unwrap();
        let root = std::env::temp_dir().join(format!("hepta-preflight-{}", hex::encode(nonce)));
        fs::create_dir(&root).unwrap();
        let path = root.join("input.json");
        fs::write(&path, b"{}").unwrap();
        let original = Snapshot::read(&path).unwrap();
        let linked = root.join("hardlink");
        fs::hard_link(&path, &linked).unwrap();
        assert!(Snapshot::read(&path).is_err());
        assert!(original.assert_current().is_err());
        fs::remove_file(&linked).unwrap();
        let snapshot = Snapshot::read(&path).unwrap();
        fs::rename(&path, root.join("old")).unwrap();
        fs::write(&path, b"{}").unwrap();
        assert!(snapshot.assert_current().is_err());
        let link = root.join("link");
        std::os::unix::fs::symlink(&path, &link).unwrap();
        assert!(Snapshot::read(&link).is_err());
        let fifo = root.join("fifo");
        nix::unistd::mkfifo(&fifo, Mode::S_IRUSR | Mode::S_IWUSR).unwrap();
        assert!(Snapshot::read(&fifo).is_err());
        let huge = root.join("huge");
        File::create(&huge).unwrap().set_len(MAX + 1).unwrap();
        assert!(Snapshot::read(&huge).is_err());
        let parent_link = root.join("parent-link");
        std::os::unix::fs::symlink(&root, &parent_link).unwrap();
        assert!(Snapshot::read(&parent_link.join("input.json")).is_err());
        fs::remove_dir_all(root).unwrap();
    }
}
