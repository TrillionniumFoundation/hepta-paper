use super::*;
use nix::{
    fcntl::{OFlag, open, openat},
    sys::stat::Mode,
};
use std::{
    fs::{self, File, Metadata},
    io::Read,
    os::{fd::AsFd, unix::fs::MetadataExt},
    path::{Component, PathBuf},
};
const MAX: u64 = 1024 * 1024;
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
pub(super) struct PrivateEnvironmentFile {
    pub bytes: Vec<u8>,
    pub path: PathBuf,
    file: File,
    metadata: Metadata,
    parents: Vec<(PathBuf, File)>,
}
impl PrivateEnvironmentFile {
    pub fn read(path: &Path) -> Result<Self> {
        let mut normalized = PathBuf::from("/");
        if !path.is_absolute() {
            return Err(error("deployment_environment_file_absolute_path_required"));
        }
        for part in path.components() {
            match part {
                Component::Normal(s) => normalized.push(s),
                Component::RootDir => (),
                _ => return Err(error("deployment_environment_file_absolute_path_required")),
            }
        }
        if normalized.as_os_str() != path.as_os_str() {
            return Err(error("deployment_environment_file_absolute_path_required"));
        }
        let flags = OFlag::O_RDONLY | OFlag::O_NOFOLLOW | OFlag::O_NONBLOCK | OFlag::O_CLOEXEC;
        let mut directory = File::from(
            open(Path::new("/"), flags | OFlag::O_DIRECTORY, Mode::empty())
                .map_err(|_| error("deployment_environment_file_open_failed"))?,
        );
        let mut cursor = PathBuf::from("/");
        let mut parents = Vec::new();
        let mut parts = path
            .components()
            .filter_map(|p| {
                if let Component::Normal(s) = p {
                    Some(s)
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
                .map_err(|_| error("deployment_environment_file_open_failed"))?,
            );
            parents.push((cursor.clone(), directory));
            cursor.push(part);
            if last {
                selected = Some(file);
                break;
            } else {
                directory = file
            }
        }
        let mut file =
            selected.ok_or_else(|| error("deployment_environment_file_regular_file_required"))?;
        let metadata = file
            .metadata()
            .map_err(|_| error("deployment_environment_file_open_failed"))?;
        if !metadata.is_file() || metadata.nlink() != 1 {
            return Err(error("deployment_environment_file_regular_file_required"));
        }
        if metadata.mode() & 0o077 != 0 {
            return Err(error("deployment_environment_file_permissions_too_broad"));
        }
        let uid = nix::unistd::getuid().as_raw();
        if metadata.uid() != 0 && metadata.uid() != uid {
            return Err(error("deployment_environment_file_owner_invalid"));
        }
        if metadata.len() > MAX {
            return Err(error("deployment_environment_file_size_limit"));
        }
        let mut bytes = Vec::new();
        file.by_ref()
            .take(MAX + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| error("deployment_environment_file_read_failed"))?;
        if bytes.len() as u64 != metadata.len() || bytes.len() as u64 > MAX {
            return Err(error("deployment_environment_file_changed"));
        }
        let observed = Self {
            bytes,
            path: path.to_owned(),
            file,
            metadata,
            parents,
        };
        observed.assert_current()?;
        Ok(observed)
    }
    pub fn assert_current(&self) -> Result<()> {
        let changed = || error("deployment_environment_file_changed");
        for (path, held) in &self.parents {
            let named = fs::symlink_metadata(path).map_err(|_| changed())?;
            let descriptor = held.metadata().map_err(|_| changed())?;
            if !named.is_dir()
                || named.is_symlink()
                || named.dev() != descriptor.dev()
                || named.ino() != descriptor.ino()
            {
                return Err(changed());
            }
        }
        if !same(
            &self.metadata,
            &self.file.metadata().map_err(|_| changed())?,
        ) || !same(
            &self.metadata,
            &fs::symlink_metadata(&self.path).map_err(|_| changed())?,
        ) {
            return Err(changed());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn retained_private_file_rejects_leaf_content_and_parent_rebinding() {
        let mut nonce = [0_u8; 16];
        getrandom::fill(&mut nonce).unwrap();
        let root =
            std::env::temp_dir().join(format!("hepta-environment-snapshot-{}", hex::encode(nonce)));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        let parent = root.join("parent");
        fs::create_dir(&parent).unwrap();
        let path = parent.join("source.env");
        let write = |path: &Path, value: &str| {
            fs::write(path, value).unwrap();
            fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
        };
        write(&path, "ELAN_HOME=one");
        let first = PrivateEnvironmentFile::read(&path).unwrap();
        write(&path, "ELAN_HOME=two");
        assert!(first.assert_current().is_err());
        let second = PrivateEnvironmentFile::read(&path).unwrap();
        let replacement = parent.join("replacement.env");
        write(&replacement, "ELAN_HOME=two");
        fs::rename(replacement, &path).unwrap();
        assert!(second.assert_current().is_err());
        let third = PrivateEnvironmentFile::read(&path).unwrap();
        let saved = root.join("saved");
        fs::rename(&parent, &saved).unwrap();
        fs::create_dir(&parent).unwrap();
        write(&path, "ELAN_HOME=two");
        assert!(third.assert_current().is_err());
        fs::remove_dir_all(root).unwrap();
    }
}
