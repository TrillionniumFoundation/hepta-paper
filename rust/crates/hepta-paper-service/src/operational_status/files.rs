use super::{Result, error};
use serde_json::Value;
use std::{
    fs::{self, Metadata, OpenOptions},
    io::Read,
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::{Component, Path, PathBuf},
};

pub(super) struct Snapshot {
    pub document: Value,
    pub ordered: super::ordered::Ordered,
    path: PathBuf,
    identity: Metadata,
    parents: Vec<(PathBuf, Metadata)>,
}
fn same_inode(a: &Metadata, b: &Metadata) -> bool {
    a.dev() == b.dev() && a.ino() == b.ino() && a.file_type() == b.file_type()
}
pub(super) fn same(a: &Metadata, b: &Metadata) -> bool {
    same_inode(a, b)
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
fn regular(meta: &Metadata) -> bool {
    meta.is_file()
        && meta.nlink() == 1
        && meta.mode() & 0o022 == 0
        && (1..=16 * 1024 * 1024).contains(&meta.len())
}
fn io_error(_: std::io::Error) -> super::OperationalStatusError {
    error("capability_proof_file_read_failed")
}
impl Snapshot {
    pub fn assert_current(&self) -> Result<()> {
        for (path, expected) in &self.parents {
            if !same_inode(expected, &fs::symlink_metadata(path).map_err(io_error)?) {
                return Err(error("capability_proof_path_changed_after_read"));
            }
        }
        let current = fs::symlink_metadata(&self.path).map_err(io_error)?;
        if !regular(&current) || !same(&self.identity, &current) {
            return Err(error("capability_proof_file_changed_after_read"));
        }
        Ok(())
    }
}
pub(super) fn read(root: &Path, path: &Path) -> Result<Snapshot> {
    let root = std::path::absolute(root).map_err(io_error)?;
    let path = std::path::absolute(path).map_err(io_error)?;
    let relative = path
        .strip_prefix(&root)
        .map_err(|_| error("capability_proof_path_outside_runtime_root"))?;
    if relative.as_os_str().is_empty()
        || relative
            .components()
            .any(|c| !matches!(c, Component::Normal(_)))
    {
        return Err(error("capability_proof_path_outside_runtime_root"));
    }
    let mut parents = Vec::new();
    let mut cursor = root;
    let root_meta = fs::symlink_metadata(&cursor).map_err(io_error)?;
    if !root_meta.is_dir() {
        return Err(error("capability_proof_runtime_root_invalid"));
    }
    parents.push((cursor.clone(), root_meta));
    let components = relative.components().collect::<Vec<_>>();
    for (index, component) in components.iter().enumerate() {
        cursor.push(component);
        let meta = fs::symlink_metadata(&cursor).map_err(io_error)?;
        if meta.is_symlink()
            || (index + 1 < components.len() && !meta.is_dir())
            || (index + 1 == components.len() && !regular(&meta))
        {
            return Err(error("capability_proof_file_identity_invalid"));
        }
        parents.push((cursor.clone(), meta));
    }
    let mut descriptor = OpenOptions::new()
        .read(true)
        .custom_flags(nix::libc::O_NOFOLLOW | nix::libc::O_NONBLOCK)
        .open(&path)
        .map_err(io_error)?;
    let before = descriptor.metadata().map_err(io_error)?;
    if !regular(&before)
        || !same(
            &before,
            &parents
                .last()
                .ok_or_else(|| error("capability_proof_snapshot_invalid"))?
                .1,
        )
    {
        return Err(error("capability_proof_file_identity_invalid"));
    }
    let mut bytes = Vec::new();
    (&mut descriptor)
        .take(16 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(io_error)?;
    if !same(&before, &descriptor.metadata().map_err(io_error)?)
        || bytes.len() as u64 != before.len()
    {
        return Err(error("capability_proof_file_changed_during_read"));
    }
    let ordered: super::ordered::Ordered =
        serde_json::from_slice(&bytes).map_err(|_| error("capability_proof_json_invalid"))?;
    let snapshot = Snapshot {
        document: ordered.value(),
        ordered,
        path,
        identity: before,
        parents,
    };
    snapshot.assert_current()?;
    Ok(snapshot)
}
