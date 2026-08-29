//! Descriptor-anchored copy-on-write workspaces and authoritative mutation evidence.

#[cfg(not(target_os = "linux"))]
compile_error!("hepta-workspace-authority requires Linux /proc descriptor paths");

use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, File, OpenOptions},
    io::Read,
    os::{
        fd::AsRawFd,
        unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
    },
    path::{Component, Path, PathBuf},
};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;

const MAXIMUM_FILE_BYTES: u64 = 1024 * 1024 * 1024;

/// Stable root identity retained with an open directory descriptor.
pub struct WorkspaceRootV1 {
    path: PathBuf,
    descriptor: File,
    device: u64,
    inode: u64,
    uid: u32,
}

impl WorkspaceRootV1 {
    /// Opens an absolute canonical root and binds later resolution to its descriptor.
    pub fn open(path: &Path, expected_uid: Option<u32>) -> Result<Self, WorkspaceError> {
        if !path.is_absolute() {
            return Err(WorkspaceError::InvalidRoot);
        }
        let canonical = fs::canonicalize(path).map_err(|_| WorkspaceError::InvalidRoot)?;
        if canonical != path {
            return Err(WorkspaceError::InvalidRoot);
        }
        let path_metadata = fs::symlink_metadata(path).map_err(|_| WorkspaceError::InvalidRoot)?;
        if path_metadata.file_type().is_symlink()
            || !path_metadata.is_dir()
            || path_metadata.mode() & 0o022 != 0
            || expected_uid.is_some_and(|uid| path_metadata.uid() != uid)
        {
            return Err(WorkspaceError::InvalidRoot);
        }
        let descriptor = File::open(path)?;
        let opened = descriptor.metadata()?;
        if opened.dev() != path_metadata.dev() || opened.ino() != path_metadata.ino() {
            return Err(WorkspaceError::RootChanged);
        }
        Ok(Self {
            path: path.to_path_buf(),
            descriptor,
            device: opened.dev(),
            inode: opened.ino(),
            uid: opened.uid(),
        })
    }

    /// Resolves a validated relative path through `/proc/self/fd/<root-fd>`.
    pub fn anchored_path(&self, relative: &Path) -> Result<PathBuf, WorkspaceError> {
        validate_relative(relative)?;
        self.verify_identity()?;
        Ok(PathBuf::from(format!("/proc/self/fd/{}", self.descriptor.as_raw_fd())).join(relative))
    }

    /// Produces a deterministic inventory without following links.
    pub fn inventory(&self) -> Result<WorkspaceInventoryV1, WorkspaceError> {
        self.verify_identity()?;
        let anchor = self.anchored_path(Path::new(""))?;
        let mut entries = Vec::new();
        walk_inventory(&anchor, Path::new(""), &mut entries)?;
        entries.sort_by(|left, right| left.path.cmp(&right.path));
        let hash = hash_entries(&entries)?;
        self.verify_identity()?;
        Ok(WorkspaceInventoryV1 { entries, hash })
    }

    fn verify_identity(&self) -> Result<(), WorkspaceError> {
        let descriptor = self.descriptor.metadata()?;
        if descriptor.dev() != self.device
            || descriptor.ino() != self.inode
            || descriptor.uid() != self.uid
            || !descriptor.is_dir()
        {
            return Err(WorkspaceError::RootChanged);
        }
        let path = fs::symlink_metadata(&self.path).map_err(|_| WorkspaceError::RootChanged)?;
        if path.dev() != self.device || path.ino() != self.inode {
            return Err(WorkspaceError::RootChanged);
        }
        Ok(())
    }
}

/// One deterministic filesystem object.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceEntryV1 {
    /// Slash-separated path relative to the root.
    pub path: String,
    /// `file` or `directory`.
    pub kind: String,
    /// POSIX mode.
    pub mode: u32,
    /// Byte count for regular files.
    pub size: u64,
    /// Exact file hash, absent for directories.
    pub content_hash: Option<String>,
}

/// Complete sorted inventory and its domain-separated hash.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorkspaceInventoryV1 {
    /// Sorted entries.
    pub entries: Vec<WorkspaceEntryV1>,
    /// Inventory digest.
    pub hash: String,
}

/// Authoritative difference between two inventories.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorkspaceMutationV1 {
    /// Added paths.
    pub added: Vec<String>,
    /// Changed paths.
    pub changed: Vec<String>,
    /// Removed paths.
    pub removed: Vec<String>,
    /// Sum of bytes of added and changed files.
    pub changed_bytes: u64,
    /// Digest over exact before/after inventories.
    pub mutation_hash: String,
}

/// Bounded role mutation policy.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MutationPolicyV1 {
    /// Allowed path prefixes.
    pub allowed_prefixes: Vec<String>,
    /// Allowed lowercase file extensions, without dots.
    pub allowed_extensions: BTreeSet<String>,
    /// Maximum number of affected paths.
    pub maximum_changed_paths: usize,
    /// Maximum bytes changed.
    pub maximum_changed_bytes: u64,
    /// Whether deletion is permitted.
    pub allow_deletion: bool,
    /// Whether every mutation is forbidden.
    pub read_only: bool,
}

/// Verified prepared workspace result.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PreparedWorkspaceResultV1 {
    /// Attempt identifier.
    pub attempt_id: String,
    /// Source inventory hash.
    pub before_hash: String,
    /// Result inventory hash.
    pub after_hash: String,
    /// Mutation digest.
    pub mutation_hash: String,
}

/// Copies a source tree into an exclusively created attempt directory.
pub fn materialize_attempt_v1(
    source: &WorkspaceRootV1,
    attempt_parent: &Path,
    attempt_id: &str,
) -> Result<PathBuf, WorkspaceError> {
    if !valid_identifier(attempt_id) {
        return Err(WorkspaceError::InvalidAttemptId);
    }
    let parent = fs::canonicalize(attempt_parent).map_err(|_| WorkspaceError::InvalidRoot)?;
    if parent != attempt_parent {
        return Err(WorkspaceError::InvalidRoot);
    }
    let destination = parent.join(attempt_id);
    fs::create_dir(&destination)?;
    fs::set_permissions(&destination, fs::Permissions::from_mode(0o700))?;
    let anchor = source.anchored_path(Path::new(""))?;
    copy_tree(&anchor, &destination)?;
    File::open(&destination)?.sync_all()?;
    File::open(&parent)?.sync_all()?;
    Ok(destination)
}

/// Computes the exact mutation between two inventories.
pub fn compare_inventories_v1(
    before: &WorkspaceInventoryV1,
    after: &WorkspaceInventoryV1,
) -> Result<WorkspaceMutationV1, WorkspaceError> {
    let before_map = before
        .entries
        .iter()
        .map(|entry| (entry.path.clone(), entry))
        .collect::<BTreeMap<_, _>>();
    let after_map = after
        .entries
        .iter()
        .map(|entry| (entry.path.clone(), entry))
        .collect::<BTreeMap<_, _>>();
    let mut added = Vec::new();
    let mut changed = Vec::new();
    let mut removed = Vec::new();
    let mut changed_bytes = 0_u64;
    for (path, entry) in &after_map {
        match before_map.get(path) {
            None => {
                added.push(path.clone());
                changed_bytes = changed_bytes
                    .checked_add(entry.size)
                    .ok_or(WorkspaceError::NumericOverflow)?;
            }
            Some(previous) if **previous != *entry => {
                changed.push(path.clone());
                changed_bytes = changed_bytes
                    .checked_add(entry.size)
                    .ok_or(WorkspaceError::NumericOverflow)?;
            }
            Some(_) => {}
        }
    }
    for path in before_map.keys() {
        if !after_map.contains_key(path) {
            removed.push(path.clone());
        }
    }
    let mutation_hash = hash_strings(&[
        before.hash.as_str(),
        after.hash.as_str(),
        &added.join("\n"),
        &changed.join("\n"),
        &removed.join("\n"),
    ]);
    Ok(WorkspaceMutationV1 {
        added,
        changed,
        removed,
        changed_bytes,
        mutation_hash,
    })
}

/// Applies an exact role policy to authoritative filesystem evidence.
pub fn validate_mutation_v1(
    mutation: &WorkspaceMutationV1,
    policy: &MutationPolicyV1,
) -> Result<(), WorkspaceError> {
    let total = mutation.added.len() + mutation.changed.len() + mutation.removed.len();
    if policy.read_only && total != 0 {
        return Err(WorkspaceError::ReadOnlyMutation);
    }
    if total > policy.maximum_changed_paths || mutation.changed_bytes > policy.maximum_changed_bytes
    {
        return Err(WorkspaceError::MutationLimit);
    }
    if !policy.allow_deletion && !mutation.removed.is_empty() {
        return Err(WorkspaceError::DeletionForbidden);
    }
    for path in mutation
        .added
        .iter()
        .chain(&mutation.changed)
        .chain(&mutation.removed)
    {
        if !policy
            .allowed_prefixes
            .iter()
            .any(|prefix| path == prefix || path.starts_with(&format!("{prefix}/")))
        {
            return Err(WorkspaceError::PathForbidden(path.clone()));
        }
        if let Some(extension) = Path::new(path).extension().and_then(|value| value.to_str())
            && !policy.allowed_extensions.is_empty()
            && !policy
                .allowed_extensions
                .contains(&extension.to_ascii_lowercase())
        {
            return Err(WorkspaceError::PathForbidden(path.clone()));
        }
    }
    Ok(())
}

/// Builds a prepared result after mutation validation succeeds.
pub fn prepare_workspace_result_v1(
    attempt_id: &str,
    before: &WorkspaceInventoryV1,
    after: &WorkspaceInventoryV1,
    mutation: &WorkspaceMutationV1,
    policy: &MutationPolicyV1,
) -> Result<PreparedWorkspaceResultV1, WorkspaceError> {
    if !valid_identifier(attempt_id) {
        return Err(WorkspaceError::InvalidAttemptId);
    }
    validate_mutation_v1(mutation, policy)?;
    Ok(PreparedWorkspaceResultV1 {
        attempt_id: attempt_id.to_owned(),
        before_hash: before.hash.clone(),
        after_hash: after.hash.clone(),
        mutation_hash: mutation.mutation_hash.clone(),
    })
}

fn copy_tree(source: &Path, destination: &Path) -> Result<(), WorkspaceError> {
    let mut entries = fs::read_dir(source)?.collect::<Result<Vec<_>, _>>()?;
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let name = entry.file_name();
        validate_relative(Path::new(&name))?;
        let source_path = entry.path();
        let destination_path = destination.join(name);
        let metadata = fs::symlink_metadata(&source_path)?;
        if metadata.file_type().is_symlink() {
            return Err(WorkspaceError::SymlinkForbidden);
        }
        if metadata.is_dir() {
            fs::create_dir(&destination_path)?;
            fs::set_permissions(&destination_path, fs::Permissions::from_mode(0o700))?;
            copy_tree(&source_path, &destination_path)?;
            File::open(&destination_path)?.sync_all()?;
        } else if metadata.is_file() {
            if metadata.size() > MAXIMUM_FILE_BYTES {
                return Err(WorkspaceError::FileTooLarge);
            }
            let mut input = File::open(&source_path)?;
            let mut output = OpenOptions::new()
                .create_new(true)
                .write(true)
                .mode(metadata.mode() & 0o777)
                .open(&destination_path)?;
            std::io::copy(&mut input, &mut output)?;
            output.sync_all()?;
        } else {
            return Err(WorkspaceError::SpecialNodeForbidden);
        }
    }
    Ok(())
}

fn walk_inventory(
    anchor: &Path,
    relative: &Path,
    output: &mut Vec<WorkspaceEntryV1>,
) -> Result<(), WorkspaceError> {
    let selected = anchor.join(relative);
    let mut entries = fs::read_dir(&selected)?.collect::<Result<Vec<_>, _>>()?;
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let name = entry
            .file_name()
            .into_string()
            .map_err(|_| WorkspaceError::NonUtf8Path)?;
        let child_relative = relative.join(name);
        validate_relative(&child_relative)?;
        let metadata = fs::symlink_metadata(entry.path())?;
        let path = child_relative
            .to_str()
            .ok_or(WorkspaceError::NonUtf8Path)?
            .replace('\\', "/");
        if metadata.file_type().is_symlink() {
            return Err(WorkspaceError::SymlinkForbidden);
        }
        if metadata.is_dir() {
            output.push(WorkspaceEntryV1 {
                path,
                kind: "directory".to_owned(),
                mode: metadata.mode() & 0o7777,
                size: 0,
                content_hash: None,
            });
            walk_inventory(anchor, &child_relative, output)?;
        } else if metadata.is_file() {
            if metadata.size() > MAXIMUM_FILE_BYTES {
                return Err(WorkspaceError::FileTooLarge);
            }
            output.push(WorkspaceEntryV1 {
                path,
                kind: "file".to_owned(),
                mode: metadata.mode() & 0o7777,
                size: metadata.size(),
                content_hash: Some(hash_file(&entry.path())?),
            });
        } else {
            return Err(WorkspaceError::SpecialNodeForbidden);
        }
    }
    Ok(())
}

fn hash_entries(entries: &[WorkspaceEntryV1]) -> Result<String, WorkspaceError> {
    let bytes = serde_json::to_vec(entries).map_err(|_| WorkspaceError::Encoding)?;
    let mut hasher = Sha256::new();
    hasher.update(b"HeptaWorkspaceInventoryV1");
    hasher.update(u64::try_from(bytes.len()).unwrap_or(u64::MAX).to_be_bytes());
    hasher.update(bytes);
    Ok(format!("sha256:{}", hex::encode(hasher.finalize())))
}

fn hash_strings(values: &[&str]) -> String {
    let mut hasher = Sha256::new();
    for value in values {
        hasher.update(u64::try_from(value.len()).unwrap_or(u64::MAX).to_be_bytes());
        hasher.update(value.as_bytes());
    }
    format!("sha256:{}", hex::encode(hasher.finalize()))
}

fn hash_file(path: &Path) -> Result<String, WorkspaceError> {
    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }
    Ok(format!("sha256:{}", hex::encode(hasher.finalize())))
}

fn validate_relative(path: &Path) -> Result<(), WorkspaceError> {
    if path.is_absolute()
        || (!path.as_os_str().is_empty()
            && path
                .components()
                .any(|component| !matches!(component, Component::Normal(_))))
    {
        return Err(WorkspaceError::InvalidRelativePath);
    }
    Ok(())
}

fn valid_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':'))
}

/// Workspace identity, copy, inventory, or policy failure.
#[derive(Debug, Error)]
pub enum WorkspaceError {
    /// Root is not canonical, absolute, private, or owned as required.
    #[error("workspace root is invalid")]
    InvalidRoot,
    /// Root object changed after opening.
    #[error("workspace root identity changed")]
    RootChanged,
    /// Relative path traversal was attempted.
    #[error("workspace relative path is invalid")]
    InvalidRelativePath,
    /// Attempt ID is malformed.
    #[error("workspace attempt id is invalid")]
    InvalidAttemptId,
    /// Non-UTF-8 paths are outside V1.
    #[error("workspace path is not UTF-8")]
    NonUtf8Path,
    /// Symbolic links are forbidden.
    #[error("workspace symbolic link is forbidden")]
    SymlinkForbidden,
    /// Device, FIFO, or socket nodes are forbidden.
    #[error("workspace special node is forbidden")]
    SpecialNodeForbidden,
    /// File exceeds the hard bound.
    #[error("workspace file is too large")]
    FileTooLarge,
    /// A read-only role changed the tree.
    #[error("read-only workspace was mutated")]
    ReadOnlyMutation,
    /// Mutation count or bytes exceeded policy.
    #[error("workspace mutation limit exceeded")]
    MutationLimit,
    /// Deletion is not permitted.
    #[error("workspace deletion is forbidden")]
    DeletionForbidden,
    /// Path is outside the role allowlist.
    #[error("workspace path is forbidden: {0}")]
    PathForbidden(String),
    /// Numeric accounting overflowed.
    #[error("workspace numeric overflow")]
    NumericOverflow,
    /// Evidence encoding failed.
    #[error("workspace evidence encoding failed")]
    Encoding,
    /// Filesystem operation failed.
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

#[cfg(test)]
mod tests {
    use std::{
        collections::BTreeSet,
        fs,
        os::unix::fs::{PermissionsExt, symlink},
        sync::atomic::{AtomicU64, Ordering},
        time::{SystemTime, UNIX_EPOCH},
    };

    use super::*;

    static NEXT: AtomicU64 = AtomicU64::new(0);

    fn roots() -> (PathBuf, PathBuf, PathBuf) {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "hepta-workspace-{}-{nonce}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        let source = root.join("source");
        let attempts = root.join("attempts");
        fs::create_dir_all(source.join("paper")).expect("source");
        fs::create_dir(&attempts).expect("attempts");
        for selected in [&root, &source, &attempts, &source.join("paper")] {
            fs::set_permissions(selected, fs::Permissions::from_mode(0o700)).expect("mode");
        }
        fs::write(source.join("paper/main.tex"), b"v1\n").expect("source file");
        (root, source, attempts)
    }

    fn author_policy() -> MutationPolicyV1 {
        MutationPolicyV1 {
            allowed_prefixes: vec!["paper".to_owned()],
            allowed_extensions: BTreeSet::from(["tex".to_owned()]),
            maximum_changed_paths: 4,
            maximum_changed_bytes: 4096,
            allow_deletion: false,
            read_only: false,
        }
    }

    #[test]
    fn attempt_is_isolated_and_mutation_is_authoritative() {
        let (root, source, attempts) = roots();
        let source_root = WorkspaceRootV1::open(&source, None).expect("source root");
        let before = source_root.inventory().expect("before");
        let attempt =
            materialize_attempt_v1(&source_root, &attempts, "attempt-1").expect("attempt");
        fs::write(attempt.join("paper/main.tex"), b"v2\n").expect("mutate attempt");
        let attempt_root = WorkspaceRootV1::open(&attempt, None).expect("attempt root");
        let after = attempt_root.inventory().expect("after");
        let mutation = compare_inventories_v1(&before, &after).expect("mutation");
        validate_mutation_v1(&mutation, &author_policy()).expect("author policy");
        let prepared =
            prepare_workspace_result_v1("attempt-1", &before, &after, &mutation, &author_policy())
                .expect("prepared result");
        assert_ne!(prepared.before_hash, prepared.after_hash);
        assert_eq!(
            fs::read(source.join("paper/main.tex")).expect("source"),
            b"v1\n"
        );
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn reviewer_and_symlink_fail_closed() {
        let (root, source, _attempts) = roots();
        let source_root = WorkspaceRootV1::open(&source, None).expect("source root");
        let before = source_root.inventory().expect("before");
        fs::write(source.join("paper/main.tex"), b"changed\n").expect("change");
        let after = source_root.inventory().expect("after");
        let mutation = compare_inventories_v1(&before, &after).expect("mutation");
        let mut reviewer = author_policy();
        reviewer.read_only = true;
        assert!(matches!(
            validate_mutation_v1(&mutation, &reviewer),
            Err(WorkspaceError::ReadOnlyMutation)
        ));
        symlink("main.tex", source.join("paper/alias.tex")).expect("symlink");
        assert!(matches!(
            source_root.inventory(),
            Err(WorkspaceError::SymlinkForbidden)
        ));
        fs::remove_dir_all(root).expect("cleanup");
    }
}
