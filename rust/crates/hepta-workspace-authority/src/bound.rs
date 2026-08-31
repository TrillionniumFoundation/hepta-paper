use std::{
    fs::{self, File, Metadata, OpenOptions},
    os::{
        fd::AsRawFd,
        unix::fs::{MetadataExt, OpenOptionsExt},
    },
    path::{Path, PathBuf},
};

use nix::libc::{O_CLOEXEC, O_NOFOLLOW};

use crate::WorkspaceError;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum BoundKind {
    File,
    Directory,
}

pub(crate) struct BoundEntry {
    pub(crate) file: File,
    pub(crate) metadata: Metadata,
    pub(crate) kind: BoundKind,
}

pub(crate) fn open_bound_entry(path: &Path) -> Result<BoundEntry, WorkspaceError> {
    open_bound_entry_with(path, || {})
}

fn open_bound_entry_with<F>(path: &Path, after_metadata: F) -> Result<BoundEntry, WorkspaceError>
where
    F: FnOnce(),
{
    let before = fs::symlink_metadata(path)?;
    if before.file_type().is_symlink() {
        return Err(WorkspaceError::SymlinkForbidden);
    }
    let kind = if before.is_dir() {
        BoundKind::Directory
    } else if before.is_file() {
        if before.nlink() != 1 {
            return Err(WorkspaceError::HardLinkForbidden);
        }
        BoundKind::File
    } else {
        return Err(WorkspaceError::SpecialNodeForbidden);
    };

    after_metadata();

    let file = OpenOptions::new()
        .read(true)
        .custom_flags(O_NOFOLLOW | O_CLOEXEC)
        .open(path)?;
    let opened = file.metadata()?;
    let after = fs::symlink_metadata(path)?;
    if !same_snapshot(&before, &opened) || !same_snapshot(&opened, &after) {
        return Err(WorkspaceError::EntryChanged);
    }
    if (kind == BoundKind::Directory && !opened.is_dir())
        || (kind == BoundKind::File && !opened.is_file())
    {
        return Err(WorkspaceError::EntryChanged);
    }
    Ok(BoundEntry {
        file,
        metadata: opened,
        kind,
    })
}

pub(crate) fn descriptor_path(file: &File) -> PathBuf {
    PathBuf::from(format!("/proc/self/fd/{}", file.as_raw_fd()))
}

pub(crate) fn verify_path_binding(
    path: &Path,
    descriptor: &File,
) -> Result<(), WorkspaceError> {
    let path_metadata = fs::symlink_metadata(path).map_err(|_| WorkspaceError::EntryChanged)?;
    if path_metadata.file_type().is_symlink() {
        return Err(WorkspaceError::SymlinkForbidden);
    }
    let descriptor_metadata = descriptor.metadata()?;
    if !same_snapshot(&path_metadata, &descriptor_metadata) {
        return Err(WorkspaceError::EntryChanged);
    }
    Ok(())
}

pub(crate) fn same_object(left: &Metadata, right: &Metadata) -> bool {
    left.dev() == right.dev()
        && left.ino() == right.ino()
        && left.mode() == right.mode()
        && left.uid() == right.uid()
        && left.gid() == right.gid()
        && left.rdev() == right.rdev()
        && left.is_file() == right.is_file()
        && left.is_dir() == right.is_dir()
}

pub(crate) fn same_snapshot(left: &Metadata, right: &Metadata) -> bool {
    same_object(left, right)
        && left.nlink() == right.nlink()
        && left.size() == right.size()
        && left.mtime() == right.mtime()
        && left.mtime_nsec() == right.mtime_nsec()
        && left.ctime() == right.ctime()
        && left.ctime_nsec() == right.ctime_nsec()
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        os::unix::fs::{PermissionsExt, symlink},
        sync::atomic::{AtomicU64, Ordering},
        time::{SystemTime, UNIX_EPOCH},
    };

    use super::*;

    static NEXT: AtomicU64 = AtomicU64::new(0);

    fn test_root(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "hepta-bound-{name}-{}-{nonce}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).expect("root");
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).expect("mode");
        root
    }

    #[test]
    fn replacement_between_metadata_and_open_is_rejected() {
        let root = test_root("replace");
        let selected = root.join("selected");
        let displaced = root.join("displaced");
        fs::write(&selected, b"trusted").expect("selected");
        let result = open_bound_entry_with(&selected, || {
            fs::rename(&selected, &displaced).expect("displace");
            fs::write(&selected, b"replacement").expect("replace");
        });
        assert!(matches!(result, Err(WorkspaceError::EntryChanged)));
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn symlink_and_hardlink_entries_are_rejected() {
        let root = test_root("links");
        let selected = root.join("selected");
        let hardlink = root.join("hardlink");
        let symlink_path = root.join("symlink");
        fs::write(&selected, b"trusted").expect("selected");
        fs::hard_link(&selected, &hardlink).expect("hardlink");
        assert!(matches!(
            open_bound_entry(&selected),
            Err(WorkspaceError::HardLinkForbidden)
        ));
        fs::remove_file(&hardlink).expect("remove hardlink");
        symlink(&selected, &symlink_path).expect("symlink");
        assert!(matches!(
            open_bound_entry(&symlink_path),
            Err(WorkspaceError::SymlinkForbidden)
        ));
        fs::remove_dir_all(root).expect("cleanup");
    }
}
