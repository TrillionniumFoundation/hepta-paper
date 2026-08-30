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
    if !same_object(&before, &opened) || !same_object(&opened, &after) {
        return Err(WorkspaceError::RootChanged);
    }
    if (kind == BoundKind::Directory && !opened.is_dir())
        || (kind == BoundKind::File && !opened.is_file())
    {
        return Err(WorkspaceError::RootChanged);
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

fn same_object(left: &Metadata, right: &Metadata) -> bool {
    left.dev() == right.dev()
        && left.ino() == right.ino()
        && left.mode() == right.mode()
        && left.uid() == right.uid()
        && left.gid() == right.gid()
        && left.nlink() == right.nlink()
        && left.size() == right.size()
}
