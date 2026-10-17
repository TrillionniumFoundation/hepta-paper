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
    observed: SnapshotIdentity,
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
fn same_parent(a: &Metadata, b: &Metadata) -> bool {
    if a.is_symlink() || b.is_symlink() {
        // A recreated named asset alias may reuse its immediately freed inode.
        // Its complete existing metadata identity must still match.
        same(a, b)
    } else {
        same_inode(a, b)
    }
}
fn regular_with_limit(meta: &Metadata, minimum: u64, maximum: u64, proof: bool) -> bool {
    meta.is_file()
        && (!proof || (meta.nlink() == 1 && meta.mode() & 0o022 == 0))
        && (minimum..=maximum).contains(&meta.len())
}
fn io_error(_: std::io::Error) -> super::OperationalStatusError {
    error("capability_proof_file_read_failed")
}
#[derive(Clone)]
pub(super) struct SnapshotIdentity {
    path: PathBuf,
    identity: Metadata,
    parents: Vec<(PathBuf, Metadata)>,
    minimum_bytes: u64,
    maximum_bytes: u64,
    imported_proof: bool,
}
impl Snapshot {
    pub fn assert_current(&self) -> Result<()> {
        self.observed.assert_current()
    }
}
impl SnapshotIdentity {
    pub(super) fn path(&self) -> &Path {
        &self.path
    }
    pub(super) fn same_snapshot(&self, other: &Self) -> bool {
        same(&self.identity, &other.identity)
            && self.parents.len() == other.parents.len()
            && self
                .parents
                .iter()
                .zip(&other.parents)
                .all(|((a, am), (b, bm))| a == b && same_parent(am, bm))
    }
    pub(super) fn resources(&self) -> Result<(usize, usize)> {
        let bytes = self
            .parents
            .iter()
            .map(|(path, _)| path.as_os_str().len())
            .chain([self.path.as_os_str().len(), self.path.as_os_str().len()])
            .try_fold(0usize, |sum, next| sum.checked_add(next))
            .ok_or_else(|| error("code_provenance_imported_identity_budget_exceeded"))?;
        Ok((bytes, self.parents.len() + 1))
    }
    pub(super) fn assert_current(&self) -> Result<()> {
        for (path, expected) in &self.parents {
            if !same_parent(expected, &fs::symlink_metadata(path).map_err(io_error)?) {
                return Err(error("capability_proof_path_changed_after_read"));
            }
        }
        let current = fs::symlink_metadata(&self.path).map_err(io_error)?;
        if !regular_with_limit(
            &current,
            self.minimum_bytes,
            self.maximum_bytes,
            self.imported_proof,
        ) || !same(&self.identity, &current)
        {
            return Err(error("capability_proof_file_changed_after_read"));
        }
        Ok(())
    }
}
pub(super) fn read(root: &Path, path: &Path) -> Result<Snapshot> {
    read_inner(root, path, None)
}
pub(super) fn read_with_observation(
    root: &Path,
    path: &Path,
    observation: &mut super::bounded::Observation<'_>,
) -> Result<Snapshot> {
    read_inner(root, path, Some(observation))
}
fn read_inner(
    root: &Path,
    path: &Path,
    observation: Option<&mut super::bounded::Observation<'_>>,
) -> Result<Snapshot> {
    let node_numbers = observation
        .as_ref()
        .is_some_and(|observer| observer.observes_node_imports());
    let (bytes, observed) = read_raw_inner(root, path, observation, 1, 16 * 1024 * 1024, true)?;
    let ordered: super::ordered::Ordered =
        serde_json::from_slice(&bytes).map_err(|_| error("capability_proof_json_invalid"))?;
    Ok(Snapshot {
        document: if node_numbers {
            ordered.node_value()
        } else {
            ordered.value()
        },
        ordered,
        observed,
    })
}
pub(super) fn read_source_hash_with_observation(
    root: &Path,
    path: &Path,
    observation: &mut super::bounded::Observation<'_>,
) -> Result<String> {
    let (bytes, _) = read_raw_inner(
        root,
        path,
        Some(observation),
        0,
        super::bounded::MAX_FILE_BYTES,
        false,
    )?;
    Ok(super::hash(&bytes))
}
fn read_raw_inner(
    root: &Path,
    path: &Path,
    mut observation: Option<&mut super::bounded::Observation<'_>>,
    minimum_bytes: u64,
    maximum_bytes: u64,
    imported_proof: bool,
) -> Result<(Vec<u8>, SnapshotIdentity)> {
    if let Some(observer) = &observation {
        observer.checkpoint()?;
    }
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
            || (index + 1 == components.len()
                && !regular_with_limit(&meta, minimum_bytes, maximum_bytes, imported_proof))
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
    if !regular_with_limit(&before, minimum_bytes, maximum_bytes, imported_proof)
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
    let mut buffer = [0; 64 * 1024];
    loop {
        let remaining = before.len().saturating_sub(bytes.len() as u64);
        if remaining == 0 {
            break;
        }
        let requested = remaining.min(buffer.len() as u64) as usize;
        let capacity = if let Some(observer) = &observation {
            observer.read_capacity(requested)?
        } else {
            requested
        };
        let count = descriptor.read(&mut buffer[..capacity]).map_err(io_error)?;
        if count == 0 {
            break;
        }
        if let Some(observer) = &mut observation {
            observer.consume(count)?;
        }
        bytes.extend_from_slice(&buffer[..count]);
    }
    if !same(&before, &descriptor.metadata().map_err(io_error)?)
        || bytes.len() as u64 != before.len()
    {
        return Err(error("capability_proof_file_changed_during_read"));
    }
    let snapshot = SnapshotIdentity {
        path,
        identity: before,
        parents,
        minimum_bytes,
        maximum_bytes,
        imported_proof,
    };
    snapshot.assert_current()?;
    if let Some(observer) = &mut observation {
        observer.retain_imported_identity(&snapshot)?;
    }
    if let Some(observer) = &observation {
        observer.checkpoint()?;
    }
    Ok((bytes, snapshot))
}

// Reuse the production subject's actual observed named/file/parent identities;
// this constructor has no arbitrary caller or path authority.
pub(super) fn retain_source_identity(
    path: &Path,
    identities: &[(PathBuf, Metadata)],
    observer: &mut super::bounded::Observation<'_>,
) -> Result<()> {
    if !observer.observes_node_imports() {
        return Ok(());
    }
    let identity = identities
        .last()
        .ok_or_else(|| error("capability_proof_snapshot_invalid"))?;
    let snapshot = SnapshotIdentity {
        path: path.to_owned(),
        identity: identity.1.clone(),
        parents: identities.to_vec(),
        minimum_bytes: 1,
        maximum_bytes: super::bounded::MAX_FILE_BYTES,
        imported_proof: false,
    };
    observer.retain_imported_identity(&snapshot)
}
