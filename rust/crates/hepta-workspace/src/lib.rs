//! Descriptor-bound copy-on-write attempt workspaces and authoritative mutation evidence.

use std::{
    collections::{BTreeMap, BTreeSet},
    ffi::OsStr,
    fs::{self, File, OpenOptions},
    io::Read,
    os::{
        fd::AsRawFd,
        unix::fs::{MetadataExt, PermissionsExt},
    },
    path::{Component, Path, PathBuf},
    str::FromStr,
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;

const MAXIMUM_FILE_BYTES: u64 = 1024 * 1024 * 1024;
const MAXIMUM_TREE_ENTRIES: usize = 1_000_000;
static NEXT_TEMP: AtomicU64 = AtomicU64::new(0);

/// Canonical lower-case SHA-256 digest.
#[derive(Clone, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(transparent)]
pub struct DigestV1(String);

impl DigestV1 {
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl FromStr for DigestV1 {
    type Err = WorkspaceError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        let Some(hex_value) = value.strip_prefix("sha256:") else {
            return Err(WorkspaceError::InvalidDigest);
        };
        if hex_value.len() != 64
            || !hex_value
                .bytes()
                .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
        {
            return Err(WorkspaceError::InvalidDigest);
        }
        Ok(Self(value.to_owned()))
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct RootIdentity {
    device: u64,
    inode: u64,
    uid: u32,
    gid: u32,
    mode: u32,
}

/// One opened canonical workspace root. All child paths are resolved below the opened directory.
pub struct WorkspaceRoot {
    path: PathBuf,
    directory: File,
    identity: RootIdentity,
}

impl WorkspaceRoot {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, WorkspaceError> {
        let requested = path.as_ref();
        if !requested.is_absolute() {
            return Err(WorkspaceError::RootInvalid);
        }
        let canonical = fs::canonicalize(requested)
            .map_err(|error| WorkspaceError::Filesystem("root_canonical", error.kind()))?;
        if canonical != requested {
            return Err(WorkspaceError::RootNonCanonical);
        }
        let path_metadata = fs::symlink_metadata(requested)
            .map_err(|error| WorkspaceError::Filesystem("root_metadata", error.kind()))?;
        if path_metadata.file_type().is_symlink() || !path_metadata.is_dir() {
            return Err(WorkspaceError::RootInvalid);
        }
        let directory = File::open(requested)
            .map_err(|error| WorkspaceError::Filesystem("root_open", error.kind()))?;
        let opened = directory
            .metadata()
            .map_err(|error| WorkspaceError::Filesystem("root_opened_metadata", error.kind()))?;
        let identity = RootIdentity {
            device: opened.dev(),
            inode: opened.ino(),
            uid: opened.uid(),
            gid: opened.gid(),
            mode: opened.mode(),
        };
        if identity
            != (RootIdentity {
                device: path_metadata.dev(),
                inode: path_metadata.ino(),
                uid: path_metadata.uid(),
                gid: path_metadata.gid(),
                mode: path_metadata.mode(),
            })
        {
            return Err(WorkspaceError::RootIdentityChanged);
        }
        Ok(Self {
            path: canonical,
            directory,
            identity,
        })
    }

    #[must_use]
    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn inventory(&self) -> Result<TreeInventoryV1, WorkspaceError> {
        self.revalidate()?;
        let descriptor_root = self.descriptor_root()?;
        let mut nodes = BTreeMap::new();
        walk_tree(&descriptor_root, Path::new(""), &mut nodes)?;
        self.revalidate()?;
        TreeInventoryV1::new(nodes)
    }

    pub fn write_file(
        &self,
        relative: impl AsRef<Path>,
        bytes: &[u8],
    ) -> Result<(), WorkspaceError> {
        let relative = validate_relative(relative.as_ref())?;
        self.revalidate()?;
        let root = self.descriptor_root()?;
        let target = root.join(&relative);
        let parent = target.parent().ok_or(WorkspaceError::PathInvalid)?;
        verify_existing_ancestors(&root, parent)?;
        let metadata = fs::symlink_metadata(&target).ok();
        if metadata.as_ref().is_some_and(|value| {
            value.file_type().is_symlink() || !value.is_file() || value.nlink() != 1
        }) {
            return Err(WorkspaceError::NodeInvalid(relative));
        }
        let mut options = OpenOptions::new();
        options.write(true).create(true).truncate(true).mode(0o600);
        let mut file = options
            .open(&target)
            .map_err(|error| WorkspaceError::Filesystem("write_file", error.kind()))?;
        use std::io::Write;
        file.write_all(bytes)
            .and_then(|()| file.sync_all())
            .map_err(|error| WorkspaceError::Filesystem("write_file", error.kind()))?;
        File::open(parent)
            .and_then(|directory| directory.sync_all())
            .map_err(|error| WorkspaceError::Filesystem("sync_parent", error.kind()))?;
        self.revalidate()
    }

    fn descriptor_root(&self) -> Result<PathBuf, WorkspaceError> {
        let descriptor = PathBuf::from(format!("/proc/self/fd/{}", self.directory.as_raw_fd()));
        let canonical = fs::canonicalize(&descriptor)
            .map_err(|error| WorkspaceError::Filesystem("descriptor_root", error.kind()))?;
        if canonical != self.path {
            return Err(WorkspaceError::RootIdentityChanged);
        }
        Ok(descriptor)
    }

    fn revalidate(&self) -> Result<(), WorkspaceError> {
        let opened = self
            .directory
            .metadata()
            .map_err(|error| WorkspaceError::Filesystem("root_revalidate", error.kind()))?;
        let current = fs::symlink_metadata(&self.path)
            .map_err(|error| WorkspaceError::Filesystem("root_revalidate", error.kind()))?;
        let observed = RootIdentity {
            device: opened.dev(),
            inode: opened.ino(),
            uid: opened.uid(),
            gid: opened.gid(),
            mode: opened.mode(),
        };
        if observed != self.identity
            || current.dev() != self.identity.device
            || current.ino() != self.identity.inode
            || current.uid() != self.identity.uid
            || current.gid() != self.identity.gid
            || current.mode() != self.identity.mode
        {
            return Err(WorkspaceError::RootIdentityChanged);
        }
        Ok(())
    }
}

/// Creates an isolated attempt copy and proves the source inventory did not change.
pub fn materialize_attempt(
    source: &WorkspaceRoot,
    destination: impl AsRef<Path>,
) -> Result<AttemptWorkspaceV1, WorkspaceError> {
    let before = source.inventory()?;
    let destination = destination.as_ref();
    if destination.exists() || !destination.is_absolute() {
        return Err(WorkspaceError::AttemptDestinationInvalid);
    }
    fs::create_dir(destination)
        .map_err(|error| WorkspaceError::Filesystem("attempt_create", error.kind()))?;
    fs::set_permissions(destination, fs::Permissions::from_mode(0o700))
        .map_err(|error| WorkspaceError::Filesystem("attempt_permissions", error.kind()))?;
    copy_tree(source, destination, &before)?;
    File::open(destination)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| WorkspaceError::Filesystem("attempt_sync", error.kind()))?;
    let after = source.inventory()?;
    if before != after {
        return Err(WorkspaceError::SourceChangedDuringMaterialization);
    }
    let root = WorkspaceRoot::open(destination)?;
    let attempt_inventory = root.inventory()?;
    if before != attempt_inventory {
        return Err(WorkspaceError::AttemptInventoryMismatch);
    }
    Ok(AttemptWorkspaceV1 {
        root,
        source_inventory: before,
    })
}

pub struct AttemptWorkspaceV1 {
    root: WorkspaceRoot,
    source_inventory: TreeInventoryV1,
}

impl AttemptWorkspaceV1 {
    #[must_use]
    pub fn root(&self) -> &WorkspaceRoot {
        &self.root
    }

    pub fn prepare(
        &self,
        policy: &MutationPolicyV1,
    ) -> Result<PreparedWorkspaceResultV1, WorkspaceError> {
        let after = self.root.inventory()?;
        let mutation = MutationManifestV1::between(&self.source_inventory, &after);
        policy.verify(&mutation)?;
        PreparedWorkspaceResultV1::new(
            self.source_inventory.root_hash.clone(),
            after.root_hash,
            mutation,
        )
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum NodeKindV1 {
    Directory,
    File,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TreeNodeV1 {
    pub path: String,
    pub kind: NodeKindV1,
    pub mode: u32,
    pub bytes: u64,
    pub content_hash: Option<DigestV1>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TreeInventoryV1 {
    pub version: u16,
    pub nodes: Vec<TreeNodeV1>,
    pub root_hash: DigestV1,
}

impl TreeInventoryV1 {
    fn new(nodes: BTreeMap<String, TreeNodeV1>) -> Result<Self, WorkspaceError> {
        if nodes.len() > MAXIMUM_TREE_ENTRIES {
            return Err(WorkspaceError::TreeTooLarge);
        }
        let nodes = nodes.into_values().collect::<Vec<_>>();
        let root_hash = hash_serialized("HeptaWorkspaceInventoryV1", &nodes)?;
        Ok(Self {
            version: 1,
            nodes,
            root_hash,
        })
    }

    fn node_map(&self) -> BTreeMap<&str, &TreeNodeV1> {
        self.nodes
            .iter()
            .map(|node| (node.path.as_str(), node))
            .collect()
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MutationKindV1 {
    Added,
    Modified,
    Removed,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MutationEntryV1 {
    pub path: String,
    pub kind: MutationKindV1,
    pub before: Option<TreeNodeV1>,
    pub after: Option<TreeNodeV1>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MutationManifestV1 {
    pub version: u16,
    pub entries: Vec<MutationEntryV1>,
    pub manifest_hash: DigestV1,
}

impl MutationManifestV1 {
    fn between(before: &TreeInventoryV1, after: &TreeInventoryV1) -> Self {
        let left = before.node_map();
        let right = after.node_map();
        let paths = left
            .keys()
            .chain(right.keys())
            .copied()
            .collect::<BTreeSet<_>>();
        let entries = paths
            .into_iter()
            .filter_map(|path| match (left.get(path), right.get(path)) {
                (None, Some(after)) => Some(MutationEntryV1 {
                    path: path.to_owned(),
                    kind: MutationKindV1::Added,
                    before: None,
                    after: Some((*after).clone()),
                }),
                (Some(before), None) => Some(MutationEntryV1 {
                    path: path.to_owned(),
                    kind: MutationKindV1::Removed,
                    before: Some((*before).clone()),
                    after: None,
                }),
                (Some(before), Some(after)) if before != after => Some(MutationEntryV1 {
                    path: path.to_owned(),
                    kind: MutationKindV1::Modified,
                    before: Some((*before).clone()),
                    after: Some((*after).clone()),
                }),
                _ => None,
            })
            .collect::<Vec<_>>();
        let manifest_hash = hash_serialized("HeptaWorkspaceMutationManifestV1", &entries)
            .expect("mutation entries are bounded by a validated inventory");
        Self {
            version: 1,
            entries,
            manifest_hash,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MutationPolicyV1 {
    pub read_only: bool,
    pub allowed_prefixes: Vec<String>,
    pub allowed_extensions: Vec<String>,
    pub maximum_changed_paths: usize,
    pub maximum_total_after_bytes: u64,
}

impl MutationPolicyV1 {
    #[must_use]
    pub fn author() -> Self {
        Self {
            read_only: false,
            allowed_prefixes: vec!["src/".to_owned(), "paper/".to_owned()],
            allowed_extensions: vec!["md".to_owned(), "tex".to_owned(), "bib".to_owned(), "rs".to_owned()],
            maximum_changed_paths: 256,
            maximum_total_after_bytes: 64 * 1024 * 1024,
        }
    }

    #[must_use]
    pub fn reviewer() -> Self {
        Self {
            read_only: true,
            allowed_prefixes: Vec::new(),
            allowed_extensions: Vec::new(),
            maximum_changed_paths: 0,
            maximum_total_after_bytes: 0,
        }
    }

    pub fn verify(&self, manifest: &MutationManifestV1) -> Result<(), WorkspaceError> {
        if self.read_only && !manifest.entries.is_empty() {
            return Err(WorkspaceError::ReadOnlyMutation);
        }
        if manifest.entries.len() > self.maximum_changed_paths {
            return Err(WorkspaceError::MutationPathLimit);
        }
        let mut total = 0_u64;
        for entry in &manifest.entries {
            if !self.allowed_prefixes.is_empty()
                && !self
                    .allowed_prefixes
                    .iter()
                    .any(|prefix| entry.path.starts_with(prefix))
            {
                return Err(WorkspaceError::MutationPathRejected(entry.path.clone()));
            }
            if let Some(after) = &entry.after {
                total = total
                    .checked_add(after.bytes)
                    .ok_or(WorkspaceError::NumericOverflow)?;
                if matches!(after.kind, NodeKindV1::File) {
                    let extension = Path::new(&entry.path)
                        .extension()
                        .and_then(OsStr::to_str)
                        .unwrap_or_default();
                    if !self.allowed_extensions.is_empty()
                        && !self.allowed_extensions.iter().any(|item| item == extension)
                    {
                        return Err(WorkspaceError::MutationExtensionRejected(entry.path.clone()));
                    }
                }
            }
        }
        if total > self.maximum_total_after_bytes {
            return Err(WorkspaceError::MutationByteLimit);
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreparedWorkspaceResultV1 {
    pub version: u16,
    pub source_inventory_hash: DigestV1,
    pub result_inventory_hash: DigestV1,
    pub mutation_manifest: MutationManifestV1,
    pub prepared_result_hash: DigestV1,
}

impl PreparedWorkspaceResultV1 {
    fn new(
        source_inventory_hash: DigestV1,
        result_inventory_hash: DigestV1,
        mutation_manifest: MutationManifestV1,
    ) -> Result<Self, WorkspaceError> {
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct HashView<'a> {
            version: u16,
            source_inventory_hash: &'a DigestV1,
            result_inventory_hash: &'a DigestV1,
            mutation_manifest: &'a MutationManifestV1,
        }
        let prepared_result_hash = hash_serialized(
            "HeptaPreparedWorkspaceResultV1",
            &HashView {
                version: 1,
                source_inventory_hash: &source_inventory_hash,
                result_inventory_hash: &result_inventory_hash,
                mutation_manifest: &mutation_manifest,
            },
        )?;
        Ok(Self {
            version: 1,
            source_inventory_hash,
            result_inventory_hash,
            mutation_manifest,
            prepared_result_hash,
        })
    }
}

fn walk_tree(
    root: &Path,
    relative: &Path,
    nodes: &mut BTreeMap<String, TreeNodeV1>,
) -> Result<(), WorkspaceError> {
    let current = root.join(relative);
    let mut entries = fs::read_dir(&current)
        .map_err(|error| WorkspaceError::Filesystem("tree_read", error.kind()))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| WorkspaceError::Filesystem("tree_read", error.kind()))?;
    entries.sort_by(|left, right| left.file_name().as_encoded_bytes().cmp(right.file_name().as_encoded_bytes()));
    for entry in entries {
        if nodes.len() >= MAXIMUM_TREE_ENTRIES {
            return Err(WorkspaceError::TreeTooLarge);
        }
        let name = entry.file_name();
        let name = name.to_str().ok_or(WorkspaceError::NonUtf8Path)?;
        let child_relative = relative.join(name);
        let child_path = entry.path();
        let metadata = fs::symlink_metadata(&child_path)
            .map_err(|error| WorkspaceError::Filesystem("tree_metadata", error.kind()))?;
        let encoded = child_relative
            .to_str()
            .ok_or(WorkspaceError::NonUtf8Path)?
            .replace('\\', "/");
        if metadata.file_type().is_symlink() {
            return Err(WorkspaceError::NodeInvalid(child_relative));
        }
        if metadata.is_dir() {
            nodes.insert(
                encoded.clone(),
                TreeNodeV1 {
                    path: encoded,
                    kind: NodeKindV1::Directory,
                    mode: metadata.mode() & 0o7777,
                    bytes: 0,
                    content_hash: None,
                },
            );
            walk_tree(root, &child_relative, nodes)?;
        } else if metadata.is_file() {
            if metadata.nlink() != 1 || metadata.size() > MAXIMUM_FILE_BYTES {
                return Err(WorkspaceError::NodeInvalid(child_relative));
            }
            nodes.insert(
                encoded.clone(),
                TreeNodeV1 {
                    path: encoded,
                    kind: NodeKindV1::File,
                    mode: metadata.mode() & 0o7777,
                    bytes: metadata.size(),
                    content_hash: Some(hash_file(&child_path, metadata.size())?),
                },
            );
        } else {
            return Err(WorkspaceError::NodeInvalid(child_relative));
        }
    }
    Ok(())
}

fn copy_tree(
    source: &WorkspaceRoot,
    destination: &Path,
    inventory: &TreeInventoryV1,
) -> Result<(), WorkspaceError> {
    let root = source.descriptor_root()?;
    for node in &inventory.nodes {
        let relative = validate_relative(Path::new(&node.path))?;
        let target = destination.join(&relative);
        match node.kind {
            NodeKindV1::Directory => {
                fs::create_dir(&target)
                    .map_err(|error| WorkspaceError::Filesystem("copy_directory", error.kind()))?;
                fs::set_permissions(&target, fs::Permissions::from_mode(node.mode))
                    .map_err(|error| WorkspaceError::Filesystem("copy_permissions", error.kind()))?;
            }
            NodeKindV1::File => {
                let source_path = root.join(&relative);
                let copied = fs::copy(&source_path, &target)
                    .map_err(|error| WorkspaceError::Filesystem("copy_file", error.kind()))?;
                if copied != node.bytes {
                    return Err(WorkspaceError::AttemptInventoryMismatch);
                }
                fs::set_permissions(&target, fs::Permissions::from_mode(node.mode))
                    .map_err(|error| WorkspaceError::Filesystem("copy_permissions", error.kind()))?;
                File::open(&target)
                    .and_then(|file| file.sync_all())
                    .map_err(|error| WorkspaceError::Filesystem("copy_sync", error.kind()))?;
            }
        }
    }
    Ok(())
}

fn verify_existing_ancestors(root: &Path, parent: &Path) -> Result<(), WorkspaceError> {
    let relative = parent
        .strip_prefix(root)
        .map_err(|_| WorkspaceError::PathEscape)?;
    let mut current = root.to_path_buf();
    for component in relative.components() {
        let Component::Normal(name) = component else {
            return Err(WorkspaceError::PathInvalid);
        };
        current.push(name);
        let metadata = fs::symlink_metadata(&current)
            .map_err(|error| WorkspaceError::Filesystem("ancestor", error.kind()))?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err(WorkspaceError::PathEscape);
        }
    }
    Ok(())
}

fn validate_relative(path: &Path) -> Result<PathBuf, WorkspaceError> {
    if path.as_os_str().is_empty() || path.is_absolute() {
        return Err(WorkspaceError::PathInvalid);
    }
    let mut result = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Normal(name) if name != OsStr::new("") => result.push(name),
            _ => return Err(WorkspaceError::PathInvalid),
        }
    }
    Ok(result)
}

fn hash_file(path: &Path, expected_size: u64) -> Result<DigestV1, WorkspaceError> {
    let mut file = File::open(path)
        .map_err(|error| WorkspaceError::Filesystem("hash_file", error.kind()))?;
    let opened = file
        .metadata()
        .map_err(|error| WorkspaceError::Filesystem("hash_file", error.kind()))?;
    if !opened.is_file() || opened.size() != expected_size || opened.nlink() != 1 {
        return Err(WorkspaceError::NodeChanged);
    }
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    let mut total = 0_u64;
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| WorkspaceError::Filesystem("hash_file", error.kind()))?;
        if read == 0 {
            break;
        }
        total = total
            .checked_add(u64::try_from(read).map_err(|_| WorkspaceError::NumericOverflow)?)
            .ok_or(WorkspaceError::NumericOverflow)?;
        if total > MAXIMUM_FILE_BYTES {
            return Err(WorkspaceError::NodeInvalid(path.to_path_buf()));
        }
        hasher.update(&buffer[..read]);
    }
    let after = file
        .metadata()
        .map_err(|error| WorkspaceError::Filesystem("hash_file", error.kind()))?;
    if total != expected_size
        || after.dev() != opened.dev()
        || after.ino() != opened.ino()
        || after.size() != opened.size()
        || after.mode() != opened.mode()
        || after.uid() != opened.uid()
        || after.gid() != opened.gid()
        || after.nlink() != opened.nlink()
    {
        return Err(WorkspaceError::NodeChanged);
    }
    digest(hasher)
}

fn hash_serialized<T: Serialize>(domain: &str, value: &T) -> Result<DigestV1, WorkspaceError> {
    let bytes = serde_json::to_vec(value).map_err(|_| WorkspaceError::Serialization)?;
    let mut hasher = Sha256::new();
    hasher.update(u64::try_from(domain.len()).map_err(|_| WorkspaceError::NumericOverflow)?.to_be_bytes());
    hasher.update(domain.as_bytes());
    hasher.update(u64::try_from(bytes.len()).map_err(|_| WorkspaceError::NumericOverflow)?.to_be_bytes());
    hasher.update(bytes);
    digest(hasher)
}

fn digest(hasher: Sha256) -> Result<DigestV1, WorkspaceError> {
    DigestV1::from_str(&format!("sha256:{}", hex::encode(hasher.finalize())))
}

#[derive(Debug, Error)]
pub enum WorkspaceError {
    #[error("workspace root is invalid")]
    RootInvalid,
    #[error("workspace root is noncanonical")]
    RootNonCanonical,
    #[error("workspace root identity changed")]
    RootIdentityChanged,
    #[error("workspace path is invalid")]
    PathInvalid,
    #[error("workspace path escaped its opened root")]
    PathEscape,
    #[error("workspace path is not UTF-8")]
    NonUtf8Path,
    #[error("workspace node is invalid: {0}")]
    NodeInvalid(PathBuf),
    #[error("workspace node changed while reading")]
    NodeChanged,
    #[error("workspace tree exceeds its hard entry limit")]
    TreeTooLarge,
    #[error("attempt destination is invalid")]
    AttemptDestinationInvalid,
    #[error("source changed during attempt materialization")]
    SourceChangedDuringMaterialization,
    #[error("attempt inventory does not match source")]
    AttemptInventoryMismatch,
    #[error("read-only role mutated the workspace")]
    ReadOnlyMutation,
    #[error("mutation path count exceeds policy")]
    MutationPathLimit,
    #[error("mutation byte count exceeds policy")]
    MutationByteLimit,
    #[error("mutation path is rejected: {0}")]
    MutationPathRejected(String),
    #[error("mutation extension is rejected: {0}")]
    MutationExtensionRejected(String),
    #[error("workspace serialization failed")]
    Serialization,
    #[error("workspace digest is invalid")]
    InvalidDigest,
    #[error("workspace numeric conversion overflowed")]
    NumericOverflow,
    #[error("workspace filesystem operation failed at {0}: {1:?}")]
    Filesystem(&'static str, std::io::ErrorKind),
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;

    struct TempTree(PathBuf);

    impl TempTree {
        fn new(label: &str) -> Self {
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("clock")
                .as_nanos();
            let sequence = NEXT_TEMP.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "hepta-workspace-{label}-{}-{nonce}-{sequence}",
                std::process::id()
            ));
            fs::create_dir(&path).expect("create temp tree");
            Self(path)
        }
    }

    impl Drop for TempTree {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn attempt_isolated_copy_preserves_source_and_emits_authoritative_mutation() {
        let source = TempTree::new("source");
        fs::create_dir(source.0.join("paper")).expect("paper dir");
        fs::write(source.0.join("paper/main.tex"), b"before").expect("source file");
        let source_root = WorkspaceRoot::open(&source.0).expect("open source");
        let source_before = source_root.inventory().expect("source inventory");
        let attempt_path = source.0.with_extension("attempt");
        let attempt = materialize_attempt(&source_root, &attempt_path).expect("attempt");
        attempt
            .root()
            .write_file("paper/main.tex", b"after")
            .expect("write attempt");
        let prepared = attempt
            .prepare(&MutationPolicyV1::author())
            .expect("prepare");
        assert_eq!(prepared.mutation_manifest.entries.len(), 1);
        assert_eq!(fs::read(source.0.join("paper/main.tex")).expect("read"), b"before");
        assert_eq!(source_root.inventory().expect("after"), source_before);
        fs::remove_dir_all(attempt_path).expect("remove attempt");
    }

    #[test]
    fn reviewer_and_symlink_paths_fail_closed() {
        let source = TempTree::new("review");
        fs::create_dir(source.0.join("paper")).expect("paper dir");
        fs::write(source.0.join("paper/main.tex"), b"before").expect("source file");
        let source_root = WorkspaceRoot::open(&source.0).expect("open source");
        let attempt_path = source.0.with_extension("review-attempt");
        let attempt = materialize_attempt(&source_root, &attempt_path).expect("attempt");
        attempt
            .root()
            .write_file("paper/main.tex", b"changed")
            .expect("write attempt");
        assert!(matches!(
            attempt.prepare(&MutationPolicyV1::reviewer()),
            Err(WorkspaceError::ReadOnlyMutation)
        ));
        fs::remove_dir_all(attempt_path).expect("remove attempt");

        let alias = source.0.join("paper/alias.tex");
        symlink(source.0.join("paper/main.tex"), &alias).expect("symlink");
        assert!(matches!(
            source_root.inventory(),
            Err(WorkspaceError::NodeInvalid(_))
        ));
    }
}
