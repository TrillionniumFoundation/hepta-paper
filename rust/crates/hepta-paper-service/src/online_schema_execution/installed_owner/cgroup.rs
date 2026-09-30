//! Retained observations of the actual manager-selected cgroup-v2 subtree.
//! No synthetic hierarchy, caller readiness JSON, process killing or database IO.
use crate::sqlite_mutation_coordinator::{Result, error};
use nix::{
    fcntl::{OFlag, open, openat},
    sys::{
        stat::Mode,
        statfs::{CGROUP2_SUPER_MAGIC, fstatfs},
    },
};
use serde_json::{Value, json};
use std::{
    fs::{self, File},
    io::Read,
    os::{fd::AsFd, unix::fs::MetadataExt},
    path::{Component, Path, PathBuf},
};

const CODE: &str = "autonomous_research_installed_schema_cgroup_not_quiescent_or_changed";
const FLAGS: OFlag = OFlag::O_RDONLY
    .union(OFlag::O_DIRECTORY)
    .union(OFlag::O_NOFOLLOW)
    .union(OFlag::O_CLOEXEC);
fn invalid() -> crate::sqlite_mutation_coordinator::SqliteMutationCoordinatorError {
    error(CODE)
}
fn inode(file: &File) -> Result<(u64, u64)> {
    let metadata = file.metadata().map_err(|_| invalid())?;
    Ok((metadata.dev(), metadata.ino()))
}
fn actual(file: &File) -> Result<()> {
    if fstatfs(file).map_err(|_| invalid())?.filesystem_type() != CGROUP2_SUPER_MAGIC {
        return Err(invalid());
    }
    Ok(())
}
pub(super) struct ObservedCgroup {
    ancestors: Vec<(PathBuf, File, (u64, u64))>,
    root: File,
    root_identity: (u64, u64),
    path: PathBuf,
    held: Option<File>,
    identity: Option<(u64, u64)>,
}
impl ObservedCgroup {
    pub(super) fn capture(manager_path: &str, unit: &str) -> Result<Self> {
        let absent = manager_path.is_empty();
        let selected = if absent {
            format!("/system.slice/{unit}")
        } else {
            manager_path.to_owned()
        };
        let relative = selected.strip_prefix('/').ok_or_else(invalid)?;
        let relative = Path::new(relative);
        if relative
            .components()
            .any(|c| !matches!(c, Component::Normal(_)))
            || relative.file_name().and_then(|n| n.to_str()) != Some(unit)
            || relative.parent() != Some(Path::new("system.slice"))
        {
            return Err(invalid());
        }
        let sys = File::from(open(Path::new("/sys"), FLAGS, Mode::empty()).map_err(|_| invalid())?);
        let fs = File::from(
            openat(sys.as_fd(), Path::new("fs"), FLAGS, Mode::empty()).map_err(|_| invalid())?,
        );
        let root = File::from(
            openat(fs.as_fd(), Path::new("cgroup"), FLAGS, Mode::empty()).map_err(|_| invalid())?,
        );
        actual(&root)?;
        let slice = File::from(
            openat(
                root.as_fd(),
                Path::new("system.slice"),
                FLAGS,
                Mode::empty(),
            )
            .map_err(|_| invalid())?,
        );
        actual(&slice)?;
        let held = match openat(slice.as_fd(), Path::new(unit), FLAGS, Mode::empty()) {
            Ok(fd) if !absent => Some(File::from(fd)),
            Err(nix::errno::Errno::ENOENT) if absent => None,
            _ => return Err(invalid()),
        };
        let identity = held.as_ref().map(inode).transpose()?;
        if let Some(file) = &held {
            actual(file)?;
        }
        let ancestors = vec![
            (
                PathBuf::from("/sys"),
                sys.try_clone().map_err(|_| invalid())?,
                inode(&sys)?,
            ),
            (
                PathBuf::from("/sys/fs"),
                fs.try_clone().map_err(|_| invalid())?,
                inode(&fs)?,
            ),
            (
                PathBuf::from("/sys/fs/cgroup/system.slice"),
                slice.try_clone().map_err(|_| invalid())?,
                inode(&slice)?,
            ),
        ];
        let result = Self {
            ancestors,
            root_identity: inode(&root)?,
            root,
            path: PathBuf::from("/sys/fs/cgroup").join(relative),
            identity,
            held,
        };
        result.assert_namespace_current()?;
        Ok(result)
    }
    fn assert_namespace_current(&self) -> Result<()> {
        for (path, file, identity) in &self.ancestors {
            let named = fs::symlink_metadata(path).map_err(|_| invalid())?;
            if !named.is_dir()
                || named.is_symlink()
                || (named.dev(), named.ino()) != *identity
                || inode(file)? != *identity
            {
                return Err(invalid());
            }
        }
        actual(&self.root)?;
        let root = fs::symlink_metadata("/sys/fs/cgroup").map_err(|_| invalid())?;
        if !root.is_dir()
            || root.is_symlink()
            || (root.dev(), root.ino()) != self.root_identity
            || inode(&self.root)? != self.root_identity
        {
            return Err(invalid());
        }
        if let Some(file) = &self.held {
            actual(file)?;
            if Some(inode(file)?) != self.identity {
                return Err(invalid());
            }
        }
        match fs::symlink_metadata(&self.path) {
            Ok(named)
                if named.is_dir()
                    && !named.is_symlink()
                    && Some((named.dev(), named.ino())) == self.identity =>
            {
                Ok(())
            }
            Err(e)
                if e.kind() == std::io::ErrorKind::NotFound
                    && self
                        .held
                        .as_ref()
                        .map(|f| f.metadata().map(|m| m.nlink() == 0))
                        .transpose()
                        .map_err(|_| invalid())?
                        .unwrap_or(true) =>
            {
                Ok(())
            }
            _ => Err(invalid()),
        }
    }
    pub(super) fn assert_empty(&self) -> Result<()> {
        self.assert_namespace_current()?;
        let Some(held) = &self.held else {
            return Ok(());
        };
        // A removed original kernfs inode cannot be replaced by a fresh group.
        if held.metadata().map_err(|_| invalid())?.nlink() == 0 {
            return self.assert_namespace_current();
        }
        let mut events = File::from(
            openat(
                held.as_fd(),
                Path::new("cgroup.events"),
                OFlag::O_RDONLY | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC | OFlag::O_NONBLOCK,
                Mode::empty(),
            )
            .map_err(|_| invalid())?,
        );
        actual(&events)?;
        let mut bytes = Vec::new();
        (&mut events)
            .take(4097)
            .read_to_end(&mut bytes)
            .map_err(|_| invalid())?;
        if bytes.len() > 4096 || !empty_events(&bytes)? {
            return Err(invalid());
        }
        self.assert_namespace_current()
    }
    pub(super) fn diagnostics(&self) -> Value {
        json!({"path":self.path,"identity":self.identity,"initiallyAbsent":self.held.is_none(),
            "filesystem":"actual-cgroup-v2","recursivePopulationEmpty":true,
            "removedOriginalInode":self.held.as_ref().is_some_and(|f|f.metadata().is_ok_and(|m| m.nlink() == 0))})
    }
}
fn empty_events(bytes: &[u8]) -> Result<bool> {
    let text = std::str::from_utf8(bytes).map_err(|_| invalid())?;
    let mut populated = None;
    let mut keys = std::collections::BTreeSet::new();
    for line in text.lines() {
        let mut words = line.split_whitespace();
        let key = words.next().ok_or_else(invalid)?;
        let value = words.next().ok_or_else(invalid)?;
        if words.next().is_some() || !keys.insert(key) || !value.bytes().all(|b| b.is_ascii_digit())
        {
            return Err(invalid());
        }
        if key == "populated" {
            populated = Some(match value {
                "0" => false,
                "1" => true,
                _ => return Err(invalid()),
            });
        }
    }
    Ok(!populated.ok_or_else(invalid)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn population_parser_and_manager_path_profile_refuse_ambiguous_observations() {
        assert!(empty_events(b"populated 0\nfrozen 0\n").unwrap());
        assert!(!empty_events(b"populated 1\nfrozen 0\n").unwrap());
        for invalid in [
            b"".as_slice(),
            b"frozen 0\n",
            b"populated 0\npopulated 0\n",
            b"populated 2\n",
            b"populated 0 extra\n",
        ] {
            assert!(empty_events(invalid).is_err());
        }
        // Ordinary filesystem fixtures cannot construct a production witness.
        assert!(ObservedCgroup::capture("/tmp/fake", "fake.service").is_err());
        assert!(ObservedCgroup::capture("/", "fake.service").is_err());
    }
}
