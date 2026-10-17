//! Selected Git commit references without materialized nested source bytes.
//! Every path component is held without following aliases. Empty directories
//! and absent leaves are distinct observations; neither runs Git in the leaf.
use super::*;
use nix::{dir::Dir, errno::Errno, fcntl::AtFlags, sys::stat::fstatat};

pub(crate) const GITLINK_REFERENCE_PROFILE: &str = "unmaterialized_gitlink_reference_v1";

pub(crate) struct GitlinkReference {
    path: PathBuf,
    parents: Vec<PinnedDirectory>,
    leaf: Option<PinnedDirectory>,
    relative: String,
    commit: String,
}
impl GitlinkReference {
    pub(crate) fn capture(root: &Path, relative: &str, entry: &TreeEntry) -> Result<Self> {
        if entry.mode != 0o160000 || !hex(&entry.oid, 40) || path(relative.as_bytes())? != relative
        {
            return Err(error("gitlink_reference_invalid"));
        }
        let path = root.join(relative);
        if !root.is_absolute()
            || path
                .components()
                .any(|v| !matches!(v, Component::RootDir | Component::Normal(_)))
        {
            return Err(error("gitlink_reference_invalid"));
        }
        let flags = OFlag::O_RDONLY
            | OFlag::O_DIRECTORY
            | OFlag::O_NOFOLLOW
            | OFlag::O_NONBLOCK
            | OFlag::O_CLOEXEC;
        let mut held = File::from(
            open(Path::new("/"), flags, Mode::empty())
                .map_err(|_| error("gitlink_path_invalid"))?,
        );
        let mut cursor = PathBuf::from("/");
        let mut parents = Vec::new();
        let parent = path.parent().ok_or_else(|| error("gitlink_path_invalid"))?;
        for component in std::iter::once(None).chain(parent.components().filter_map(|v| match v {
            Component::Normal(v) => Some(Some(v)),
            _ => None,
        })) {
            if let Some(name) = component {
                held = File::from(
                    openat(held.as_fd(), Path::new(name), flags, Mode::empty())
                        .map_err(|_| error("gitlink_path_invalid"))?,
                );
                cursor.push(name);
            }
            let metadata = held.metadata().map_err(|_| error("gitlink_path_invalid"))?;
            let named = fs::symlink_metadata(&cursor).map_err(|_| error("gitlink_path_invalid"))?;
            if !same_directory(&metadata, &named) {
                return Err(error("gitlink_path_invalid"));
            }
            parents.push(PinnedDirectory {
                path: cursor.clone(),
                file: held
                    .try_clone()
                    .map_err(|_| error("gitlink_path_invalid"))?,
                metadata,
            });
            if parents.len() > MAX_DIRECTORIES {
                return Err(error("directory_budget_exceeded"));
            }
        }
        let name = path
            .file_name()
            .ok_or_else(|| error("gitlink_path_invalid"))?;
        let leaf = match openat(held.as_fd(), Path::new(name), flags, Mode::empty()) {
            Ok(fd) => {
                let file = File::from(fd);
                let metadata = file.metadata().map_err(|_| error("gitlink_path_invalid"))?;
                let named =
                    fs::symlink_metadata(&path).map_err(|_| error("gitlink_path_invalid"))?;
                if !metadata.is_dir() || !same(&metadata, &named) {
                    return Err(error("gitlink_path_invalid"));
                }
                Some(PinnedDirectory {
                    path: path.clone(),
                    file,
                    metadata,
                })
            }
            Err(Errno::ENOENT) => None,
            Err(_) => return Err(error("gitlink_path_invalid")),
        };
        let observation = Self {
            path,
            parents,
            leaf,
            relative: relative.into(),
            commit: entry.oid.clone(),
        };
        observation.assert_current()?;
        Ok(observation)
    }
    pub(crate) fn assert_current(&self) -> Result<()> {
        for parent in &self.parents {
            let named = fs::symlink_metadata(&parent.path).map_err(|_| error("gitlink_changed"))?;
            let held = parent
                .file
                .metadata()
                .map_err(|_| error("gitlink_changed"))?;
            if !same_directory(&parent.metadata, &named) || !same_directory(&parent.metadata, &held)
            {
                return Err(error("gitlink_changed"));
            }
        }
        let Some(leaf) = &self.leaf else {
            let parent = self
                .parents
                .last()
                .ok_or_else(|| error("gitlink_reference_invalid"))?;
            return match fstatat(
                parent.file.as_fd(),
                Path::new(
                    self.path
                        .file_name()
                        .ok_or_else(|| error("gitlink_path_invalid"))?,
                ),
                AtFlags::AT_SYMLINK_NOFOLLOW,
            ) {
                Err(Errno::ENOENT) => Ok(()),
                _ => Err(error("gitlink_changed")),
            };
        };
        let check = || -> Result<()> {
            let named = fs::symlink_metadata(&leaf.path).map_err(|_| error("gitlink_changed"))?;
            let held = leaf.file.metadata().map_err(|_| error("gitlink_changed"))?;
            if !named.is_dir() || !same(&leaf.metadata, &named) || !same(&leaf.metadata, &held) {
                return Err(error("gitlink_changed"));
            }
            Ok(())
        };
        check()?;
        let mut directory = Dir::openat(
            leaf.file.as_fd(),
            Path::new("."),
            OFlag::O_RDONLY | OFlag::O_DIRECTORY | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC,
            Mode::empty(),
        )
        .map_err(|_| error("gitlink_changed"))?;
        for entry in directory.iter() {
            let entry = entry.map_err(|_| error("gitlink_changed"))?;
            if !matches!(entry.file_name().to_bytes(), b"." | b"..") {
                return Err(error("gitlink_materialized"));
            }
        }
        check()
    }
    pub(crate) fn value(&self) -> Value {
        json!({"profile": GITLINK_REFERENCE_PROFILE, "path":self.relative,"mode":"160000","commit":self.commit,
            "state":if self.leaf.is_some() {"empty_directory"} else {"absent"},
            "observationScope":"selected_tree_and_index_commit_without_nested_source_bytes"})
    }
    pub(super) fn is_absent(&self) -> bool {
        self.leaf.is_none()
    }
}

#[cfg(test)]
mod tests;
