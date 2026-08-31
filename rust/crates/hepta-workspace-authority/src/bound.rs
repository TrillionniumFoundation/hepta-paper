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

/// Opens one existing entry without following the final component and proves that
/// the pathname resolved to the same object before, during, and after `open(2)`.
pub(crate) fn open_bound_entry(path: &Path) -> Result<BoundEntry, WorkspaceError> {
    let before = fs::symlink_metadata(path)?;
    if before.file_type().is_symlink() {
        return Err(WorkspaceError::SymlinkForbidden);
    }
    let kind = if before.is_dir() {
        BoundKind::Directory
    } else if before.is_file() {
        BoundKind::File
    } else {
        return Err(WorkspaceError::SpecialNodeForbidden);
    };
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(O_NOFOLLOW | O_CLOEXEC)
        .open(path)?;
    let opened = file.metadata()?;
    let after = fs::symlink_metadata(path)?;
    if !same_stable_object(&before, &opened) || !same_stable_object(&opened, &after) {
        return Err(WorkspaceError::EntryChanged);
    }
    if (kind == BoundKind::Directory && !opened.is_dir())
        || (kind == BoundKind::File && !opened.is_file())
    {
        return Err(WorkspaceError::EntryChanged);
    }
    if kind == BoundKind::File && opened.nlink() != 1 {
        return Err(WorkspaceError::HardLinkForbidden);
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

/// Verifies that a public pathname still names the exact object retained by a
/// descriptor. Callers use this only before returning or deleting a pathname.
pub(crate) fn verify_path_binding(
    path: &Path,
    expected: &Metadata,
) -> Result<(), WorkspaceError> {
    let observed = fs::symlink_metadata(path).map_err(|_| WorkspaceError::EntryChanged)?;
    if observed.file_type().is_symlink() || !same_identity(expected, &observed) {
        return Err(WorkspaceError::EntryChanged);
    }
    Ok(())
}

pub(crate) fn same_identity(left: &Metadata, right: &Metadata) -> bool {
    left.dev() == right.dev()
        && left.ino() == right.ino()
        && left.mode() == right.mode()
        && left.uid() == right.uid()
        && left.gid() == right.gid()
        && left.nlink() == right.nlink()
}

/// Stronger identity comparison for an object that is required to remain
/// byte-for-byte stable while it is hashed or copied.
pub(crate) fn same_stable_object(left: &Metadata, right: &Metadata) -> bool {
    same_identity(left, right)
        && left.size() == right.size()
        && left.mtime() == right.mtime()
        && left.mtime_nsec() == right.mtime_nsec()
        && left.ctime() == right.ctime()
        && left.ctime_nsec() == right.ctime_nsec()
}
