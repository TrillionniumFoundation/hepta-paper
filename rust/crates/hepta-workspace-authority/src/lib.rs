//! Descriptor-anchored copy-on-write workspaces and authoritative mutation evidence.

#[cfg(not(target_os = "linux"))]
compile_error!("hepta-workspace-authority requires Linux /proc descriptor paths");

use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
    path::{Component, Path, PathBuf},
};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;

mod bound;

use bound::{
    BoundEntry, BoundKind, descriptor_path, open_bound_entry, same_object, same_snapshot,
    verify_path_binding,
};

const MAXIMUM_FILE_BYTES: u64 = 1024 * 1024 * 1024;
const MAXIMUM_TREE_ENTRIES: usize = 100_000;

/// Stable root identity retained with an open directory descriptor.
pub struct WorkspaceRootV1 {
    path: PathBuf,
    descriptor: File,
    device: u64,
    inode: u64,
    mode: u32,
    uid: u32,
    gid: u32,
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
        let opened = open_bound_entry(path).map_err(|error| match error {
            WorkspaceError::Io(_) => WorkspaceError::InvalidRoot,
            other => other,
        })?;
        if opened.kind != BoundKind::Directory
            || opened.metadata.mode() & 0o022 != 0
            || expected_uid.is_some_and(|uid| opened.metadata.uid() != uid)
        {
            return Err(WorkspaceError::InvalidRoot);
        }
        Ok(Self {
            path: path.to_path_buf(),
            device: opened.metadata.dev(),
            inode: opened.metadata.ino(),
            mode: opened.metadata.mode(),
            uid: opened.metadata.uid(),
            gid: opened.metadata.gid(),
            descriptor: opened.file,
        })
    }

    /// Resolves a validated relative path through `/proc/self/fd/<root-fd>`.
    pub fn anchored_path(&self, relative: &Path) -> Result<PathBuf, WorkspaceError> {
        validate_relative(relative)?;
        self.verify_identity()?;
        Ok(descriptor_path(&self.descriptor).join(relative))
    }

    /// Produces a deterministic inventory from descriptor-opened child objects.
    pub fn inventory(&self) -> Result<WorkspaceInventoryV1, WorkspaceError> {
        self.verify_identity()?;
        let mut entries = Vec::new();
        walk_inventory(&self.descriptor, self.device, Path::new(""), &mut entries)?;
        entries.sort_by(|left, right| left.path.cmp(&right.path));
        let hash = hash_entries(&entries)?;
        self.verify_identity()?;
        Ok(WorkspaceInventoryV1 { entries, hash })
    }

    fn verify_identity(&self) -> Result<(), WorkspaceError> {
        let descriptor = self.descriptor.metadata()?;
        if descriptor.dev() != self.device
            || descriptor.ino() != self.inode
            || descriptor.mode() != self.mode
            || descriptor.uid() != self.uid
            || descriptor.gid() != self.gid
            || !descriptor.is_dir()
        {
            return Err(WorkspaceError::RootChanged);
        }
        let path = fs::symlink_metadata(&self.path).map_err(|_| WorkspaceError::RootChanged)?;
        if path.file_type().is_symlink() || !same_object(&descriptor, &path) {
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
    source.verify_identity()?;
    let parent = WorkspaceRootV1::open(attempt_parent, Some(source.uid))?;
    let public_destination = attempt_parent.join(attempt_id);
    let anchored_destination = parent.anchored_path(Path::new(attempt_id))?;
    fs::create_dir(&anchored_destination)?;
    fs::set_permissions(&anchored_destination, fs::Permissions::from_mode(0o700))?;
    let destination = open_bound_entry(&anchored_destination)?;
    if destination.kind != BoundKind::Directory {
        return Err(WorkspaceError::EntryChanged);
    }
    let mut copied_entries = 0_usize;
    copy_tree(
        &source.descriptor,
        source.device,
        &destination.file,
        &mut copied_entries,
    )?;
    destination.file.sync_all()?;
    parent.descriptor.sync_all()?;
    source.verify_identity()?;
    parent.verify_identity()?;
    verify_path_binding(&public_destination, &destination.file)?;
    Ok(public_destination)
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
            Some(previous) if *previous != *entry => {
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
        if !policy.allowed_prefixes.iter().any(|prefix| {
            path == prefix
                || path
                    .strip_prefix(prefix.as_str())
                    .is_some_and(|suffix| suffix.starts_with('/'))
        }) {
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

fn copy_tree(
    source: &File,
    source_device: u64,
    destination: &File,
    copied_entries: &mut usize,
) -> Result<(), WorkspaceError> {
    let source_before = source.metadata()?;
    let source_anchor = descriptor_path(source);
    let destination_anchor = descriptor_path(destination);
    let mut entries = fs::read_dir(&source_anchor)?.collect::<Result<Vec<_>, _>>()?;
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        if *copied_entries >= MAXIMUM_TREE_ENTRIES {
            return Err(WorkspaceError::TreeTooLarge);
        }
        *copied_entries = (*copied_entries)
            .checked_add(1)
            .ok_or(WorkspaceError::NumericOverflow)?;
        let name = entry.file_name();
        validate_relative(Path::new(name.as_os_str()))?;
        let source_path = source_anchor.join(&name);
        let destination_path = destination_anchor.join(&name);
        let mut opened = open_bound_entry(&source_path)?;
        if opened.metadata.dev() != source_device {
            return Err(WorkspaceError::CrossDeviceForbidden);
        }
        match opened.kind {
            BoundKind::Directory => {
                fs::create_dir(&destination_path)?;
                fs::set_permissions(&destination_path, fs::Permissions::from_mode(0o700))?;
                let target = open_bound_entry(&destination_path)?;
                if target.kind != BoundKind::Directory {
                    return Err(WorkspaceError::EntryChanged);
                }
                copy_tree(
                    &opened.file,
                    source_device,
                    &target.file,
                    copied_entries,
                )?;
                target.file.sync_all()?;
                verify_path_binding(&destination_path, &target.file)?;
            }
            BoundKind::File => {
                copy_bound_file(&mut opened, &destination_path)?;
            }
        }
        verify_path_binding(&source_path, &opened.file)?;
    }
    let source_after = source.metadata()?;
    if !same_snapshot(&source_before, &source_after) {
        return Err(WorkspaceError::EntryChanged);
    }
    destination.sync_all()?;
    Ok(())
}

fn copy_bound_file(source: &mut BoundEntry, destination: &Path) -> Result<(), WorkspaceError> {
    copy_bound_file_with_hook(source, destination, || {})
}

fn copy_bound_file_with_hook(
    source: &mut BoundEntry,
    destination: &Path,
    between_copy_and_verify: impl FnOnce(),
) -> Result<(), WorkspaceError> {
    if source.kind != BoundKind::File || source.metadata.size() > MAXIMUM_FILE_BYTES {
        return Err(WorkspaceError::FileTooLarge);
    }
    let source_before = source.file.metadata()?;
    if !same_snapshot(&source.metadata, &source_before) {
        return Err(WorkspaceError::EntryChanged);
    }
    let mut output = OpenOptions::new()
        .create_new(true)
        .read(true)
        .write(true)
        .mode(source_before.mode() & 0o777)
        .open(destination)?;
    let result = (|| {
        source.file.seek(SeekFrom::Start(0))?;
        let (copied_hash, copied_bytes) = copy_and_hash(&mut source.file, &mut output)?;
        output.sync_all()?;
        let after_copy = source.file.metadata()?;
        if !same_snapshot(&source_before, &after_copy) || copied_bytes != source_before.size()
        {
            return Err(WorkspaceError::EntryChanged);
        }
        between_copy_and_verify();
        source.file.seek(SeekFrom::Start(0))?;
        let (verified_hash, verified_bytes) = hash_open_file(&mut source.file)?;
        let after_verify = source.file.metadata()?;
        if !same_snapshot(&source_before, &after_verify)
            || copied_hash != verified_hash
            || copied_bytes != verified_bytes
        {
            return Err(WorkspaceError::EntryChanged);
        }
        output.seek(SeekFrom::Start(0))?;
        let (destination_hash, destination_bytes) = hash_open_file(&mut output)?;
        if destination_hash != copied_hash || destination_bytes != copied_bytes {
            return Err(WorkspaceError::EntryChanged);
        }
        verify_path_binding(destination, &output)?;
        Ok(())
    })();
    if let Err(error) = result {
        let remove_output = verify_path_binding(destination, &output).is_ok();
        drop(output);
        if remove_output {
            let _ = fs::remove_file(destination);
        }
        return Err(error);
    }
    Ok(())
}

fn walk_inventory(
    directory: &File,
    root_device: u64,
    relative: &Path,
    output: &mut Vec<WorkspaceEntryV1>,
) -> Result<(), WorkspaceError> {
    let directory_before = directory.metadata()?;
    let anchor = descriptor_path(directory);
    let mut entries = fs::read_dir(&anchor)?.collect::<Result<Vec<_>, _>>()?;
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        if output.len() >= MAXIMUM_TREE_ENTRIES {
            return Err(WorkspaceError::TreeTooLarge);
        }
        let name = entry
            .file_name()
            .into_string()
            .map_err(|_| WorkspaceError::NonUtf8Path)?;
        let child_relative = relative.join(&name);
        validate_relative(&child_relative)?;
        let child_path = anchor.join(&name);
        let mut opened = open_bound_entry(&child_path)?;
        if opened.metadata.dev() != root_device {
            return Err(WorkspaceError::CrossDeviceForbidden);
        }
        let path = child_relative
            .to_str()
            .ok_or(WorkspaceError::NonUtf8Path)?
            .replace('\\', "/");
        match opened.kind {
            BoundKind::Directory => {
                output.push(WorkspaceEntryV1 {
                    path,
                    kind: "directory".to_owned(),
                    mode: opened.metadata.mode() & 0o7777,
                    size: 0,
                    content_hash: None,
                });
                walk_inventory(&opened.file, root_device, &child_relative, output)?;
            }
            BoundKind::File => {
                if opened.metadata.size() > MAXIMUM_FILE_BYTES {
                    return Err(WorkspaceError::FileTooLarge);
                }
                output.push(WorkspaceEntryV1 {
                    path,
                    kind: "file".to_owned(),
                    mode: opened.metadata.mode() & 0o7777,
                    size: opened.metadata.size(),
                    content_hash: Some(hash_bound_file(&mut opened)?),
                });
            }
        }
        verify_path_binding(&child_path, &opened.file)?;
    }
    let directory_after = directory.metadata()?;
    if !same_snapshot(&directory_before, &directory_after) {
        return Err(WorkspaceError::EntryChanged);
    }
    Ok(())
}

fn hash_bound_file(entry: &mut BoundEntry) -> Result<String, WorkspaceError> {
    hash_bound_file_with_hook(entry, || {})
}

fn hash_bound_file_with_hook(
    entry: &mut BoundEntry,
    between_passes: impl FnOnce(),
) -> Result<String, WorkspaceError> {
    if entry.kind != BoundKind::File || entry.metadata.size() > MAXIMUM_FILE_BYTES {
        return Err(WorkspaceError::FileTooLarge);
    }
    let before = entry.file.metadata()?;
    if !same_snapshot(&entry.metadata, &before) {
        return Err(WorkspaceError::EntryChanged);
    }
    entry.file.seek(SeekFrom::Start(0))?;
    let (first_hash, first_bytes) = hash_open_file(&mut entry.file)?;
    let after_first = entry.file.metadata()?;
    if !same_snapshot(&before, &after_first) || first_bytes != before.size() {
        return Err(WorkspaceError::EntryChanged);
    }
    between_passes();
    entry.file.seek(SeekFrom::Start(0))?;
    let (second_hash, second_bytes) = hash_open_file(&mut entry.file)?;
    let after_second = entry.file.metadata()?;
    if !same_snapshot(&before, &after_second)
        || first_hash != second_hash
        || first_bytes != second_bytes
    {
        return Err(WorkspaceError::EntryChanged);
    }
    Ok(first_hash)
}

fn copy_and_hash(
    source: &mut File,
    destination: &mut File,
) -> Result<(String, u64), WorkspaceError> {
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    let mut total = 0_u64;
    loop {
        let count = source.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        total = total
            .checked_add(u64::try_from(count).map_err(|_| WorkspaceError::NumericOverflow)?)
            .ok_or(WorkspaceError::NumericOverflow)?;
        if total > MAXIMUM_FILE_BYTES {
            return Err(WorkspaceError::FileTooLarge);
        }
        destination.write_all(&buffer[..count])?;
        hasher.update(&buffer[..count]);
    }
    Ok((format!("sha256:{}", hex::encode(hasher.finalize())), total))
}

fn hash_open_file(file: &mut File) -> Result<(String, u64), WorkspaceError> {
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    let mut total = 0_u64;
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        total = total
            .checked_add(u64::try_from(count).map_err(|_| WorkspaceError::NumericOverflow)?)
            .ok_or(WorkspaceError::NumericOverflow)?;
        if total > MAXIMUM_FILE_BYTES {
            return Err(WorkspaceError::FileTooLarge);
        }
        hasher.update(&buffer[..count]);
    }
    Ok((format!("sha256:{}", hex::encode(hasher.finalize())), total))
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
    /// A child object changed while it was opened, hashed, copied, or rebound.
    #[error("workspace entry changed during a bound operation")]
    EntryChanged,
    /// Regular-file hard links can be mutated through an alias outside the root.
    #[error("workspace hard link is forbidden")]
    HardLinkForbidden,
    /// A nested mount would escape the root filesystem authority.
    #[error("workspace cross-device entry is forbidden")]
    CrossDeviceForbidden,
    /// The deterministic inventory exceeded its hard entry bound.
    #[error("workspace tree contains too many entries")]
    TreeTooLarge,
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
    fn hard_linked_source_file_is_rejected() {
        let (root, source, _attempts) = roots();
        let alias = root.join("outside-alias.tex");
        fs::hard_link(source.join("paper/main.tex"), &alias).expect("hard link");
        let source_root = WorkspaceRootV1::open(&source, None).expect("source root");
        assert!(matches!(
            source_root.inventory(),
            Err(WorkspaceError::HardLinkForbidden)
        ));
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn in_place_mutation_between_hash_passes_is_rejected() {
        let (root, source, _attempts) = roots();
        let path = source.join("paper/main.tex");
        let mut opened = open_bound_entry(&path).expect("bound source");
        let result = hash_bound_file_with_hook(&mut opened, || {
            fs::write(&path, b"changed while hashing\n").expect("mutate source");
        });
        assert!(matches!(result, Err(WorkspaceError::EntryChanged)));
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn in_place_mutation_between_copy_and_verify_removes_partial_copy() {
        let (root, source, attempts) = roots();
        let source_path = source.join("paper/main.tex");
        let destination_path = attempts.join("copied.tex");
        let mut opened = open_bound_entry(&source_path).expect("bound source");
        let result = copy_bound_file_with_hook(&mut opened, &destination_path, || {
            fs::write(&source_path, b"changed while copying\n").expect("mutate source");
        });
        assert!(matches!(result, Err(WorkspaceError::EntryChanged)));
        assert!(!destination_path.exists());
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
