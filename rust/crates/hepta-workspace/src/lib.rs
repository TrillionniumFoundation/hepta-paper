//! Descriptor-bound attempt workspace, deterministic inventory, and mutation policy.

#![forbid(unsafe_code)]

/// Additive diagnostic compatibility for a preserved earlier Rust wire format.
pub mod workspace_wire_compat_v1;

use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, File, OpenOptions},
    io::Read,
    os::{
        fd::AsRawFd,
        unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
    },
    path::{Component, Path, PathBuf},
    str::FromStr,
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

use hepta_codex_protocol::Sha256Digest;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;

const MAXIMUM_FILE_BYTES: u64 = 512 * 1024 * 1024;
const MAXIMUM_TREE_ENTRIES: usize = 100_000;
const MAXIMUM_MUTATION_BYTES: u64 = 1024 * 1024 * 1024;
static NEXT_ATTEMPT_NONCE: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Copy)]
struct WorkspaceLimits {
    tree_entries: usize,
    file_bytes: u64,
}

impl WorkspaceLimits {
    const PRODUCTION: Self = Self {
        tree_entries: MAXIMUM_TREE_ENTRIES,
        file_bytes: MAXIMUM_FILE_BYTES,
    };
}

struct TreeEntryBudget {
    remaining: usize,
}

impl TreeEntryBudget {
    fn new(maximum: usize) -> Self {
        Self { remaining: maximum }
    }

    fn reserve(&mut self) -> Result<(), WorkspaceError> {
        if self.remaining == 0 {
            return Err(WorkspaceError::TreeEntryLimitExceeded);
        }
        self.remaining -= 1;
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceObjectIdentityV1 {
    pub canonical_path_hash: Sha256Digest,
    pub device: u64,
    pub inode: u64,
    pub mode: u32,
    pub uid: u32,
    pub gid: u32,
    pub link_count: u64,
}

/// Open descriptor that pins one canonical workspace root object.
#[derive(Debug)]
pub struct WorkspaceRootV1 {
    directory: File,
    canonical_path: PathBuf,
    identity: WorkspaceObjectIdentityV1,
}

impl WorkspaceRootV1 {
    pub fn open(path: impl AsRef<Path>, expected_owner_uid: u32) -> Result<Self, WorkspaceError> {
        let path = path.as_ref();
        if !path.is_absolute() {
            return Err(WorkspaceError::RootInvalid);
        }
        let canonical = fs::canonicalize(path)
            .map_err(|error| WorkspaceError::Filesystem("root_canonical", error.kind()))?;
        if canonical != path {
            return Err(WorkspaceError::RootInvalid);
        }
        let metadata = fs::symlink_metadata(path)
            .map_err(|error| WorkspaceError::Filesystem("root_metadata", error.kind()))?;
        let mode = metadata.mode() & 0o7777;
        if metadata.file_type().is_symlink()
            || !metadata.is_dir()
            || metadata.uid() != expected_owner_uid
            || mode & 0o022 != 0
        {
            return Err(WorkspaceError::RootInvalid);
        }
        let directory = File::open(path)
            .map_err(|error| WorkspaceError::Filesystem("root_open", error.kind()))?;
        let opened = directory
            .metadata()
            .map_err(|error| WorkspaceError::Filesystem("root_open_metadata", error.kind()))?;
        if !same_object(&metadata, &opened) {
            return Err(WorkspaceError::RootChanged);
        }
        Ok(Self {
            identity: WorkspaceObjectIdentityV1 {
                canonical_path_hash: hash_path(&canonical)?,
                device: metadata.dev(),
                inode: metadata.ino(),
                mode,
                uid: metadata.uid(),
                gid: metadata.gid(),
                link_count: metadata.nlink(),
            },
            directory,
            canonical_path: canonical,
        })
    }

    // Private attempt roots use the retained parent's descriptor for every
    // operation. They never escape materialization or outlive that parent.
    // Only inventory/revalidate and identity comparison are used: the public
    // resolve_existing canonical-path contract does not apply to this anchor.
    fn open_attempt_child(
        parent: &RetainedAttemptParent,
        name: &str,
        expected_owner_uid: u32,
    ) -> Result<Self, WorkspaceError> {
        let path = parent.child(name);
        let metadata = fs::symlink_metadata(&path)
            .map_err(|error| WorkspaceError::Filesystem("root_metadata", error.kind()))?;
        let mode = metadata.mode() & 0o7777;
        if !metadata.is_dir()
            || metadata.is_symlink()
            || metadata.uid() != expected_owner_uid
            || mode & 0o022 != 0
        {
            return Err(WorkspaceError::RootInvalid);
        }
        let directory = open_directory(&path, "root_open")?;
        let opened = directory
            .metadata()
            .map_err(|error| WorkspaceError::Filesystem("root_open_metadata", error.kind()))?;
        if !same_object(&metadata, &opened) {
            return Err(WorkspaceError::RootChanged);
        }
        Ok(Self {
            identity: WorkspaceObjectIdentityV1 {
                canonical_path_hash: hash_path(&parent.canonical_path.join(name))?,
                device: metadata.dev(),
                inode: metadata.ino(),
                mode,
                uid: metadata.uid(),
                gid: metadata.gid(),
                link_count: metadata.nlink(),
            },
            directory,
            canonical_path: path,
        })
    }

    #[must_use]
    pub fn identity(&self) -> &WorkspaceObjectIdentityV1 {
        &self.identity
    }

    #[must_use]
    pub fn canonical_path(&self) -> &Path {
        &self.canonical_path
    }

    /// Resolves an existing path through the pinned root descriptor and rejects links.
    pub fn resolve_existing(&self, relative: impl AsRef<Path>) -> Result<PathBuf, WorkspaceError> {
        let relative = relative.as_ref();
        validate_relative(relative)?;
        self.revalidate()?;
        let descriptor_path =
            PathBuf::from(format!("/proc/self/fd/{}", self.directory.as_raw_fd())).join(relative);
        let canonical = fs::canonicalize(&descriptor_path)
            .map_err(|error| WorkspaceError::Filesystem("relative_canonical", error.kind()))?;
        if !canonical.starts_with(&self.canonical_path) {
            return Err(WorkspaceError::PathEscapesRoot);
        }
        reject_link_components(&self.canonical_path, relative)?;
        Ok(canonical)
    }

    pub fn inventory(&self) -> Result<TreeInventoryV1, WorkspaceError> {
        self.inventory_with_limits(WorkspaceLimits::PRODUCTION)
    }

    fn inventory_with_limits(
        &self,
        limits: WorkspaceLimits,
    ) -> Result<TreeInventoryV1, WorkspaceError> {
        self.revalidate()?;
        inventory_tree(&self.canonical_path, limits)
    }

    fn revalidate(&self) -> Result<(), WorkspaceError> {
        let metadata = fs::symlink_metadata(&self.canonical_path)
            .map_err(|error| WorkspaceError::Filesystem("root_revalidate", error.kind()))?;
        let opened = self
            .directory
            .metadata()
            .map_err(|error| WorkspaceError::Filesystem("root_descriptor", error.kind()))?;
        if !same_object(&metadata, &opened)
            || metadata.dev() != self.identity.device
            || metadata.ino() != self.identity.inode
            || metadata.uid() != self.identity.uid
            || metadata.gid() != self.identity.gid
            || metadata.nlink() != self.identity.link_count
            || metadata.mode() & 0o7777 != self.identity.mode
        {
            return Err(WorkspaceError::RootChanged);
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TreeEntryKindV1 {
    Directory,
    File,
}

#[derive(Clone, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TreeEntryV1 {
    pub relative_path: String,
    pub kind: TreeEntryKindV1,
    pub mode: u32,
    pub uid: u32,
    pub gid: u32,
    pub link_count: u64,
    pub byte_count: u64,
    pub content_hash: Option<Sha256Digest>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TreeInventoryV1 {
    pub version: u16,
    pub entries: Vec<TreeEntryV1>,
    pub total_file_bytes: u64,
    pub inventory_hash: Sha256Digest,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MutationKindV1 {
    Added,
    Removed,
    Changed,
}

#[derive(Clone, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MutationRecordV1 {
    pub relative_path: String,
    pub kind: MutationKindV1,
    pub before: Option<TreeEntryV1>,
    pub after: Option<TreeEntryV1>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MutationManifestV1 {
    pub version: u16,
    pub records: Vec<MutationRecordV1>,
    pub changed_file_bytes: u64,
    pub manifest_hash: Sha256Digest,
}

impl MutationManifestV1 {
    pub fn between(
        before: &TreeInventoryV1,
        after: &TreeInventoryV1,
    ) -> Result<Self, WorkspaceError> {
        let before_map = before
            .entries
            .iter()
            .map(|entry| (entry.relative_path.clone(), entry.clone()))
            .collect::<BTreeMap<_, _>>();
        let after_map = after
            .entries
            .iter()
            .map(|entry| (entry.relative_path.clone(), entry.clone()))
            .collect::<BTreeMap<_, _>>();
        let keys = before_map
            .keys()
            .chain(after_map.keys())
            .cloned()
            .collect::<BTreeSet<_>>();
        let mut records = Vec::new();
        let mut changed_file_bytes = 0_u64;
        for key in keys {
            let before_entry = before_map.get(&key);
            let after_entry = after_map.get(&key);
            let kind = match (before_entry, after_entry) {
                (None, Some(_)) => Some(MutationKindV1::Added),
                (Some(_), None) => Some(MutationKindV1::Removed),
                (Some(left), Some(right)) if left != right => Some(MutationKindV1::Changed),
                _ => None,
            };
            if let Some(kind) = kind {
                changed_file_bytes = changed_file_bytes
                    .checked_add(after_entry.map_or(0, |entry| entry.byte_count))
                    .ok_or(WorkspaceError::NumericOverflow)?;
                records.push(MutationRecordV1 {
                    relative_path: key,
                    kind,
                    before: before_entry.cloned(),
                    after: after_entry.cloned(),
                });
            }
        }
        if changed_file_bytes > MAXIMUM_MUTATION_BYTES {
            return Err(WorkspaceError::MutationByteLimitExceeded);
        }
        let manifest_hash = hash_serialized("HeptaMutationManifestV1", &records)?;
        Ok(Self {
            version: 1,
            records,
            changed_file_bytes,
            manifest_hash,
        })
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MutationPolicyV1 {
    pub version: u16,
    pub read_only: bool,
    pub allowed_path_prefixes: Vec<String>,
    pub allowed_extensions: BTreeSet<String>,
    pub maximum_changed_entries: usize,
    pub maximum_changed_file_bytes: u64,
}

impl MutationPolicyV1 {
    #[must_use]
    pub fn reviewer_read_only() -> Self {
        Self {
            version: 1,
            read_only: true,
            allowed_path_prefixes: Vec::new(),
            allowed_extensions: BTreeSet::new(),
            maximum_changed_entries: 0,
            maximum_changed_file_bytes: 0,
        }
    }

    pub fn validate_manifest(&self, manifest: &MutationManifestV1) -> Result<(), WorkspaceError> {
        if self.version != 1
            || manifest.version != 1
            || manifest.records.len() > self.maximum_changed_entries
            || manifest.changed_file_bytes > self.maximum_changed_file_bytes
        {
            return Err(WorkspaceError::MutationPolicyRejected);
        }
        if self.read_only {
            return if manifest.records.is_empty() {
                Ok(())
            } else {
                Err(WorkspaceError::MutationPolicyRejected)
            };
        }
        for record in &manifest.records {
            let path_allowed = self.allowed_path_prefixes.iter().any(|prefix| {
                record.relative_path == *prefix
                    || record
                        .relative_path
                        .strip_prefix(prefix)
                        .is_some_and(|suffix| suffix.starts_with('/'))
            });
            let extension_allowed = Path::new(&record.relative_path)
                .extension()
                .and_then(|value| value.to_str())
                .is_some_and(|extension| self.allowed_extensions.contains(extension));
            if !path_allowed || !extension_allowed {
                return Err(WorkspaceError::MutationPolicyRejected);
            }
        }
        Ok(())
    }
}

pub fn mutation_policy_hash_v1(policy: &MutationPolicyV1) -> Result<Sha256Digest, WorkspaceError> {
    hash_serialized("HeptaMutationPolicyV1", policy)
}

pub fn workspace_identity_hash_v1(root: &WorkspaceRootV1) -> Result<Sha256Digest, WorkspaceError> {
    hash_serialized("HeptaWorkspaceIdentityV1", root.identity())
}

/// Recomputes every workspace-preparation binding from retained source facts.
/// A deserialized prepared record is never authority by itself.
pub fn validate_prepared_workspace_result_v1(
    prepared: &PreparedWorkspaceResultV1,
    attempt: &AttemptWorkspaceV1,
    root: &WorkspaceRootV1,
    after: &TreeInventoryV1,
    mutation: &MutationManifestV1,
    policy: &MutationPolicyV1,
) -> Result<(), WorkspaceError> {
    let expected = PreparedWorkspaceResultV1::new(attempt, root, after, mutation, policy)?;
    if prepared != &expected {
        return Err(WorkspaceError::MutationPolicyRejected);
    }
    Ok(())
}

#[derive(Debug)]
pub struct AttemptWorkspaceV1 {
    pub attempt_id: String,
    pub canonical_path: PathBuf,
    pub initial_inventory: TreeInventoryV1,
}

impl AttemptWorkspaceV1 {
    pub fn open_root(&self, expected_owner_uid: u32) -> Result<WorkspaceRootV1, WorkspaceError> {
        WorkspaceRootV1::open(&self.canonical_path, expected_owner_uid)
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreparedWorkspaceResultV1 {
    pub version: u16,
    pub attempt_id: String,
    pub workspace_identity_hash: Sha256Digest,
    pub before_inventory_hash: Sha256Digest,
    pub after_inventory_hash: Sha256Digest,
    pub mutation_manifest_hash: Sha256Digest,
    pub prepared_result_hash: Sha256Digest,
}

impl PreparedWorkspaceResultV1 {
    pub fn new(
        attempt: &AttemptWorkspaceV1,
        root: &WorkspaceRootV1,
        after: &TreeInventoryV1,
        mutation: &MutationManifestV1,
        policy: &MutationPolicyV1,
    ) -> Result<Self, WorkspaceError> {
        policy.validate_manifest(mutation)?;
        let workspace_identity_hash = hash_serialized("HeptaWorkspaceIdentityV1", root.identity())?;
        let mut value = Self {
            version: 1,
            attempt_id: attempt.attempt_id.clone(),
            workspace_identity_hash,
            before_inventory_hash: attempt.initial_inventory.inventory_hash.clone(),
            after_inventory_hash: after.inventory_hash.clone(),
            mutation_manifest_hash: mutation.manifest_hash.clone(),
            prepared_result_hash: zero_digest()?,
        };
        value.prepared_result_hash = hash_serialized(
            "HeptaPreparedWorkspaceResultV1",
            &PreparedHashView::from(&value),
        )?;
        Ok(value)
    }
}

struct PreparedHashView<'a> {
    version: u16,
    attempt_id: &'a str,
    workspace_identity_hash: &'a Sha256Digest,
    before_inventory_hash: &'a Sha256Digest,
    after_inventory_hash: &'a Sha256Digest,
    mutation_manifest_hash: &'a Sha256Digest,
}

impl<'a> From<&'a PreparedWorkspaceResultV1> for PreparedHashView<'a> {
    fn from(value: &'a PreparedWorkspaceResultV1) -> Self {
        Self {
            version: value.version,
            attempt_id: &value.attempt_id,
            workspace_identity_hash: &value.workspace_identity_hash,
            before_inventory_hash: &value.before_inventory_hash,
            after_inventory_hash: &value.after_inventory_hash,
            mutation_manifest_hash: &value.mutation_manifest_hash,
        }
    }
}

impl Serialize for PreparedHashView<'_> {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct View<'a> {
            version: u16,
            attempt_id: &'a str,
            workspace_identity_hash: &'a Sha256Digest,
            before_inventory_hash: &'a Sha256Digest,
            after_inventory_hash: &'a Sha256Digest,
            mutation_manifest_hash: &'a Sha256Digest,
        }
        View {
            version: self.version,
            attempt_id: self.attempt_id,
            workspace_identity_hash: self.workspace_identity_hash,
            before_inventory_hash: self.before_inventory_hash,
            after_inventory_hash: self.after_inventory_hash,
            mutation_manifest_hash: self.mutation_manifest_hash,
        }
        .serialize(serializer)
    }
}

/// Materializes an isolated attempt through a private staging directory and no-clobber rename.
/// Inventory validation runs before publication and is repeated after it. A
/// `WorkspaceError::PublishedAttemptRequiresInspection` means the rename already
/// succeeded; the final namespace must be inspected before any retry or cleanup.
pub fn materialize_attempt(
    source: &WorkspaceRootV1,
    attempt_parent: impl AsRef<Path>,
    attempt_id: &str,
    expected_owner_uid: u32,
) -> Result<AttemptWorkspaceV1, WorkspaceError> {
    materialize_attempt_with_limits(
        source,
        attempt_parent.as_ref(),
        attempt_id,
        expected_owner_uid,
        WorkspaceLimits::PRODUCTION,
    )
}

fn materialize_attempt_with_limits(
    source: &WorkspaceRootV1,
    attempt_parent: &Path,
    attempt_id: &str,
    expected_owner_uid: u32,
    limits: WorkspaceLimits,
) -> Result<AttemptWorkspaceV1, WorkspaceError> {
    materialize_attempt_with_publication_check(
        source,
        attempt_parent,
        attempt_id,
        expected_owner_uid,
        limits,
        |_, _| Ok(()),
    )
}

// The fixed producer supplies a no-op observer. Private tests can inject a
// failure only after the real no-replace rename, at an actual fallible phase.
fn materialize_attempt_with_publication_check(
    source: &WorkspaceRootV1,
    attempt_parent: &Path,
    attempt_id: &str,
    expected_owner_uid: u32,
    limits: WorkspaceLimits,
    mut publication_check: impl FnMut(AttemptPublicationPhaseV1, &Path) -> Result<(), WorkspaceError>,
) -> Result<AttemptWorkspaceV1, WorkspaceError> {
    materialize_attempt_with_checks(
        source,
        attempt_parent,
        attempt_id,
        expected_owner_uid,
        limits,
        |phase, path| match phase {
            MaterializationPhase::Published(phase) => publication_check(phase, path),
            MaterializationPhase::StagingCreated | MaterializationPhase::BeforePublication => {
                Ok(())
            }
        },
    )
}

#[derive(Clone, Copy)]
enum MaterializationPhase {
    StagingCreated,
    BeforePublication,
    Published(AttemptPublicationPhaseV1),
}

fn materialize_attempt_with_checks(
    source: &WorkspaceRootV1,
    attempt_parent: &Path,
    attempt_id: &str,
    expected_owner_uid: u32,
    limits: WorkspaceLimits,
    mut check: impl FnMut(MaterializationPhase, &Path) -> Result<(), WorkspaceError>,
) -> Result<AttemptWorkspaceV1, WorkspaceError> {
    validate_identifier(attempt_id)?;
    source.revalidate()?;
    let parent = RetainedAttemptParent::open(
        attempt_parent,
        expected_owner_uid,
        AttemptParentLock::Materialize,
    )?;
    let sequence = NEXT_ATTEMPT_NONCE.fetch_add(1, Ordering::Relaxed);
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| WorkspaceError::ClockBeforeEpoch)?
        .as_nanos();
    let staging_name = format!(".attempt-{attempt_id}-{nonce}-{sequence}.creating");
    let final_name = format!("attempt-{attempt_id}");
    let staging = parent.child(&staging_name);
    let final_path = parent.canonical_path.join(&final_name);
    if parent.child(&final_name).exists() {
        return Err(WorkspaceError::AttemptAlreadyExists);
    }
    fs::create_dir(&staging)
        .map_err(|error| WorkspaceError::Filesystem("attempt_staging", error.kind()))?;
    let staging_directory = open_directory(&staging, "attempt_staging_open")?;
    let prepared = (|| {
        staging_directory
            .set_permissions(fs::Permissions::from_mode(0o700))
            .map_err(|error| WorkspaceError::Filesystem("attempt_staging_mode", error.kind()))?;
        check(MaterializationPhase::StagingCreated, &staging)?;
        let mut entries = TreeEntryBudget::new(limits.tree_entries);
        copy_tree(
            &source.canonical_path,
            &staging,
            &mut entries,
            limits.file_bytes,
        )?;
        let root = WorkspaceRootV1::open_attempt_child(&parent, &staging_name, expected_owner_uid)?;
        let held = staging_directory.metadata().map_err(|error| {
            WorkspaceError::Filesystem("attempt_staging_metadata", error.kind())
        })?;
        let observed = root.directory.metadata().map_err(|error| {
            WorkspaceError::Filesystem("attempt_staging_metadata", error.kind())
        })?;
        if !same_object(&held, &observed) {
            return Err(WorkspaceError::RootChanged);
        }
        // Relative inventory entries and their hash do not depend on whether
        // this directory has its private staging name or its published name.
        let inventory = root.inventory_with_limits(limits)?;
        source.revalidate()?;
        root.revalidate()?;
        staging_directory
            .sync_all()
            .map_err(|error| WorkspaceError::Filesystem("sync_directory", error.kind()))?;
        root.revalidate()?;
        check(MaterializationPhase::BeforePublication, &staging)?;
        parent.revalidate()?;
        Ok((root, inventory))
    })();
    let (staged_root, initial_inventory) = match prepared {
        Ok(prepared) => prepared,
        Err(cause) => {
            cleanup_owned_staging(&staging, &staging_directory);
            return Err(cause);
        }
    };
    // Both names resolve from the still-locked actual parent, even if its
    // external pathname changes after the diagnostic revalidation above.
    publish_attempt_no_replace(&staging, &parent.child(&final_name))?;
    let published_error =
        |phase, parent_sync_completed, cause| WorkspaceError::PublishedAttemptRequiresInspection {
            final_path: final_path.clone(),
            phase,
            parent_sync_completed,
            cause: Box::new(cause),
        };
    let sync_phase = AttemptPublicationPhaseV1::ParentDirectorySync;
    check(MaterializationPhase::Published(sync_phase), &final_path)
        .and_then(|()| parent.sync())
        .map_err(|cause| published_error(sync_phase, false, cause))?;
    let open_phase = AttemptPublicationPhaseV1::PublishedRootOpen;
    let root = check(MaterializationPhase::Published(open_phase), &final_path)
        .and_then(|()| parent.revalidate())
        .and_then(|()| {
            WorkspaceRootV1::open_attempt_child(&parent, &final_name, expected_owner_uid)
        })
        .map_err(|cause| published_error(open_phase, true, cause))?;
    let validation_phase = AttemptPublicationPhaseV1::PublishedRootValidation;
    check(
        MaterializationPhase::Published(validation_phase),
        &final_path,
    )
    .and_then(|()| validate_published_root(&staged_root, &root))
    .map_err(|cause| published_error(validation_phase, true, cause))?;
    let inventory_phase = AttemptPublicationPhaseV1::PublishedInventoryValidation;
    check(
        MaterializationPhase::Published(inventory_phase),
        &final_path,
    )
    .and_then(|()| {
        let published_inventory = root.inventory_with_limits(limits)?;
        if published_inventory != initial_inventory {
            return Err(WorkspaceError::InventoryChanged);
        }
        root.revalidate()?;
        parent.revalidate()
    })
    .map_err(|cause| published_error(inventory_phase, true, cause))?;
    parent.release()?;
    Ok(AttemptWorkspaceV1 {
        attempt_id: attempt_id.to_owned(),
        canonical_path: final_path,
        initial_inventory,
    })
}

fn cleanup_owned_staging(path: &Path, directory: &File) {
    if let (Ok(named), Ok(held)) = (fs::symlink_metadata(path), directory.metadata())
        && named.is_dir()
        && !named.is_symlink()
        && same_object(&named, &held)
    {
        let _ = fs::remove_dir_all(path);
    }
}

fn validate_published_root(
    staged: &WorkspaceRootV1,
    published: &WorkspaceRootV1,
) -> Result<(), WorkspaceError> {
    let before = staged.identity();
    let after = published.identity();
    if before.device != after.device
        || before.inode != after.inode
        || before.mode != after.mode
        || before.uid != after.uid
        || before.gid != after.gid
        || before.link_count != after.link_count
    {
        return Err(WorkspaceError::RootChanged);
    }
    published.revalidate()
}

fn publish_attempt_no_replace(staging: &Path, final_path: &Path) -> Result<(), WorkspaceError> {
    use nix::fcntl::{AT_FDCWD, RenameFlags, renameat2};
    renameat2(
        AT_FDCWD,
        staging,
        AT_FDCWD,
        final_path,
        RenameFlags::RENAME_NOREPLACE,
    )
    .map_err(|error| {
        if error == nix::errno::Errno::EEXIST {
            WorkspaceError::AttemptAlreadyExists
        } else {
            WorkspaceError::Filesystem("attempt_publish", std::io::Error::from(error).kind())
        }
    })
}

/// Removes only incomplete staging directories; published attempts are never reclaimed here.
pub fn recover_incomplete_attempts(
    attempt_parent: impl AsRef<Path>,
    expected_owner_uid: u32,
) -> Result<u64, WorkspaceError> {
    recover_incomplete_attempts_with_check(attempt_parent.as_ref(), expected_owner_uid, |_| Ok(()))
}

fn recover_incomplete_attempts_with_check(
    attempt_parent: &Path,
    expected_owner_uid: u32,
    mut before_removal: impl FnMut(&Path) -> Result<(), WorkspaceError>,
) -> Result<u64, WorkspaceError> {
    let parent = RetainedAttemptParent::open(
        attempt_parent,
        expected_owner_uid,
        AttemptParentLock::Recover,
    )?;
    let mut removed = 0_u64;
    for entry in fs::read_dir(parent.descriptor_path())
        .map_err(|error| WorkspaceError::Filesystem("attempt_parent_read", error.kind()))?
    {
        let entry = entry
            .map_err(|error| WorkspaceError::Filesystem("attempt_parent_entry", error.kind()))?;
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            return Err(WorkspaceError::NonUtf8Path);
        };
        if name.starts_with(".attempt-") && name.ends_with(".creating") {
            let metadata = fs::symlink_metadata(entry.path())
                .map_err(|error| WorkspaceError::Filesystem("attempt_recovery", error.kind()))?;
            if !metadata.is_dir() || metadata.is_symlink() || metadata.uid() != expected_owner_uid {
                return Err(WorkspaceError::AttemptRecoveryIdentityMismatch);
            }
            parent.revalidate()?;
            before_removal(&entry.path())?;
            // read_dir was opened through the held descriptor, so entry.path()
            // remains anchored if the caller's parent name is rebound here.
            fs::remove_dir_all(entry.path())
                .map_err(|error| WorkspaceError::Filesystem("attempt_recovery", error.kind()))?;
            removed = removed
                .checked_add(1)
                .ok_or(WorkspaceError::NumericOverflow)?;
        }
    }
    parent.sync()?;
    parent.revalidate()?;
    parent.release()?;
    Ok(removed)
}

fn inventory_tree(root: &Path, limits: WorkspaceLimits) -> Result<TreeInventoryV1, WorkspaceError> {
    let mut entries = Vec::new();
    let mut budget = TreeEntryBudget::new(limits.tree_entries);
    inventory_directory(
        root,
        Path::new(""),
        &mut entries,
        &mut budget,
        limits.file_bytes,
    )?;
    entries.sort();
    let total_file_bytes = entries.iter().try_fold(0_u64, |total, entry| {
        total
            .checked_add(entry.byte_count)
            .ok_or(WorkspaceError::NumericOverflow)
    })?;
    let inventory_hash = hash_serialized("HeptaTreeInventoryV1", &entries)?;
    Ok(TreeInventoryV1 {
        version: 1,
        entries,
        total_file_bytes,
        inventory_hash,
    })
}

fn inventory_directory(
    root: &Path,
    relative: &Path,
    entries: &mut Vec<TreeEntryV1>,
    budget: &mut TreeEntryBudget,
    maximum_file_bytes: u64,
) -> Result<(), WorkspaceError> {
    let current = root.join(relative);
    let children = bounded_children(&current, budget, "inventory_read_dir", "inventory_entry")?;
    for child in children {
        let name = child.file_name();
        let Some(name) = name.to_str() else {
            return Err(WorkspaceError::NonUtf8Path);
        };
        let child_relative = relative.join(name);
        let metadata = fs::symlink_metadata(child.path())
            .map_err(|error| WorkspaceError::Filesystem("inventory_metadata", error.kind()))?;
        let relative_text = child_relative
            .to_str()
            .ok_or(WorkspaceError::NonUtf8Path)?
            .replace('\\', "/");
        if metadata.file_type().is_symlink() {
            return Err(WorkspaceError::SymlinkForbidden(relative_text));
        }
        let kind = if metadata.is_dir() {
            TreeEntryKindV1::Directory
        } else if metadata.is_file() {
            TreeEntryKindV1::File
        } else {
            return Err(WorkspaceError::SpecialFileForbidden(relative_text));
        };
        let (byte_count, content_hash) = if kind == TreeEntryKindV1::File {
            if metadata.size() > maximum_file_bytes {
                return Err(WorkspaceError::FileByteLimitExceeded(relative_text));
            }
            (
                metadata.size(),
                Some(hash_file(&child.path(), maximum_file_bytes)?),
            )
        } else {
            (0, None)
        };
        entries.push(TreeEntryV1 {
            relative_path: relative_text,
            kind,
            mode: metadata.mode() & 0o7777,
            uid: metadata.uid(),
            gid: metadata.gid(),
            link_count: metadata.nlink(),
            byte_count,
            content_hash,
        });
        if kind == TreeEntryKindV1::Directory {
            inventory_directory(root, &child_relative, entries, budget, maximum_file_bytes)?;
        }
    }
    Ok(())
}

fn bounded_children(
    directory: &Path,
    budget: &mut TreeEntryBudget,
    directory_error: &'static str,
    entry_error: &'static str,
) -> Result<Vec<fs::DirEntry>, WorkspaceError> {
    let entries = fs::read_dir(directory)
        .map_err(|error| WorkspaceError::Filesystem(directory_error, error.kind()))?;
    let mut children = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|error| WorkspaceError::Filesystem(entry_error, error.kind()))?;
        // Reserve once when discovered, before collecting, copying or hashing.
        // Pending siblings consume the same budget as recursively found children.
        // The root itself is never enumerated and does not consume an entry.
        budget.reserve()?;
        children.push(entry);
    }
    children.sort_by_key(fs::DirEntry::file_name);
    Ok(children)
}

fn copy_tree(
    source: &Path,
    destination: &Path,
    budget: &mut TreeEntryBudget,
    maximum_file_bytes: u64,
) -> Result<(), WorkspaceError> {
    let children = bounded_children(source, budget, "copy_read_dir", "copy_entry")?;
    for child in children {
        let source_path = child.path();
        let destination_path = destination.join(child.file_name());
        let metadata = fs::symlink_metadata(&source_path)
            .map_err(|error| WorkspaceError::Filesystem("copy_metadata", error.kind()))?;
        if metadata.file_type().is_symlink() {
            return Err(WorkspaceError::SymlinkForbidden(path_text(&source_path)?));
        }
        if metadata.is_dir() {
            fs::create_dir(&destination_path)
                .map_err(|error| WorkspaceError::Filesystem("copy_directory", error.kind()))?;
            fs::set_permissions(
                &destination_path,
                fs::Permissions::from_mode(metadata.mode() & 0o7777),
            )
            .map_err(|error| WorkspaceError::Filesystem("copy_directory_mode", error.kind()))?;
            copy_tree(&source_path, &destination_path, budget, maximum_file_bytes)?;
            sync_directory(&destination_path)?;
        } else if metadata.is_file() {
            if metadata.size() > maximum_file_bytes {
                return Err(WorkspaceError::FileByteLimitExceeded(path_text(
                    &source_path,
                )?));
            }
            let mut source_file = File::open(&source_path)
                .map_err(|error| WorkspaceError::Filesystem("copy_source", error.kind()))?;
            let mut destination_file = OpenOptions::new()
                .create_new(true)
                .write(true)
                .mode(metadata.mode() & 0o7777)
                .open(&destination_path)
                .map_err(|error| WorkspaceError::Filesystem("copy_target", error.kind()))?;
            copy_file_bytes(
                &mut source_file,
                &mut destination_file,
                &source_path,
                maximum_file_bytes,
            )?;
            destination_file
                .sync_all()
                .map_err(|error| WorkspaceError::Filesystem("copy_sync", error.kind()))?;
        } else {
            return Err(WorkspaceError::SpecialFileForbidden(path_text(
                &source_path,
            )?));
        }
    }
    Ok(())
}

fn copy_file_bytes(
    source: &mut impl Read,
    destination: &mut impl std::io::Write,
    source_path: &Path,
    maximum_bytes: u64,
) -> Result<(), WorkspaceError> {
    let read_limit = maximum_bytes
        .checked_add(1)
        .ok_or(WorkspaceError::NumericOverflow)?;
    let copied = std::io::copy(&mut source.take(read_limit), destination)
        .map_err(|error| WorkspaceError::Filesystem("copy_bytes", error.kind()))?;
    if copied > maximum_bytes {
        return Err(WorkspaceError::FileByteLimitExceeded(path_text(
            source_path,
        )?));
    }
    Ok(())
}

#[derive(Clone, Copy)]
enum AttemptParentLock {
    Materialize,
    Recover,
}

// No descriptor duplication or lock conversion: closing this sole File releases
// the flock. Children opened via /proc get separate descriptions and no lock.
struct RetainedAttemptParent {
    directory: File,
    canonical_path: PathBuf,
    initial_metadata: fs::Metadata,
}

impl RetainedAttemptParent {
    fn open(
        parent: &Path,
        expected_owner_uid: u32,
        lock: AttemptParentLock,
    ) -> Result<Self, WorkspaceError> {
        if !parent.is_absolute() {
            return Err(WorkspaceError::AttemptParentInvalid);
        }
        let canonical = fs::canonicalize(parent)
            .map_err(|error| WorkspaceError::Filesystem("attempt_parent", error.kind()))?;
        if canonical != parent {
            return Err(WorkspaceError::AttemptParentInvalid);
        }
        let metadata = fs::symlink_metadata(parent)
            .map_err(|error| WorkspaceError::Filesystem("attempt_parent", error.kind()))?;
        if metadata.is_symlink()
            || !metadata.is_dir()
            || metadata.uid() != expected_owner_uid
            || metadata.mode() & 0o7777 != 0o700
        {
            return Err(WorkspaceError::AttemptParentInvalid);
        }
        let directory = open_directory(parent, "attempt_parent_open")?;
        let opened = directory
            .metadata()
            .map_err(|error| WorkspaceError::Filesystem("attempt_parent_metadata", error.kind()))?;
        if !same_parent_object(&metadata, &opened) {
            return Err(WorkspaceError::AttemptParentChanged);
        }
        match lock {
            AttemptParentLock::Materialize => directory.try_lock_shared(),
            AttemptParentLock::Recover => directory.try_lock(),
        }
        .map_err(|error| match error {
            fs::TryLockError::WouldBlock => WorkspaceError::AttemptParentBusy,
            fs::TryLockError::Error(error) => {
                WorkspaceError::Filesystem("attempt_parent_lock", error.kind())
            }
        })?;
        let retained = Self {
            directory,
            canonical_path: canonical,
            initial_metadata: opened,
        };
        retained.revalidate()?;
        Ok(retained)
    }

    fn descriptor_path(&self) -> PathBuf {
        PathBuf::from(format!("/proc/self/fd/{}", self.directory.as_raw_fd()))
    }

    fn child(&self, name: &str) -> PathBuf {
        self.descriptor_path().join(name)
    }

    fn revalidate(&self) -> Result<(), WorkspaceError> {
        let named = fs::symlink_metadata(&self.canonical_path)
            .map_err(|_| WorkspaceError::AttemptParentChanged)?;
        let held = self
            .directory
            .metadata()
            .map_err(|error| WorkspaceError::Filesystem("attempt_parent_metadata", error.kind()))?;
        if !same_parent_object(&named, &held) || !same_parent_object(&held, &self.initial_metadata)
        {
            return Err(WorkspaceError::AttemptParentChanged);
        }
        Ok(())
    }

    /// Release the cooperative lock before reporting a successful operation.
    /// Closing would also unlock, but an explicit release makes the success
    /// boundary observable and rejects an unlock error instead of returning a
    /// workspace while a duplicate kernel reference could still exclude peers.
    fn release(self) -> Result<(), WorkspaceError> {
        self.directory
            .unlock()
            .map_err(|error| WorkspaceError::Filesystem("attempt_parent_unlock", error.kind()))
    }

    fn sync(&self) -> Result<(), WorkspaceError> {
        self.directory
            .sync_all()
            .map_err(|error| WorkspaceError::Filesystem("sync_directory", error.kind()))
    }
}

fn open_directory(path: &Path, operation: &'static str) -> Result<File, WorkspaceError> {
    OpenOptions::new()
        .read(true)
        .custom_flags(nix::libc::O_DIRECTORY | nix::libc::O_NOFOLLOW | nix::libc::O_CLOEXEC)
        .open(path)
        .map_err(|error| WorkspaceError::Filesystem(operation, error.kind()))
}

fn same_parent_object(left: &fs::Metadata, right: &fs::Metadata) -> bool {
    // Cooperating materializers legitimately change nlink by adding siblings.
    left.dev() == right.dev()
        && left.ino() == right.ino()
        && left.mode() == right.mode()
        && left.uid() == right.uid()
        && left.gid() == right.gid()
}

fn reject_link_components(root: &Path, relative: &Path) -> Result<(), WorkspaceError> {
    let mut current = root.to_path_buf();
    for component in relative.components() {
        let Component::Normal(value) = component else {
            return Err(WorkspaceError::RelativePathInvalid);
        };
        current.push(value);
        let metadata = fs::symlink_metadata(&current)
            .map_err(|error| WorkspaceError::Filesystem("component_metadata", error.kind()))?;
        if metadata.file_type().is_symlink() {
            return Err(WorkspaceError::SymlinkForbidden(path_text(&current)?));
        }
    }
    Ok(())
}

fn validate_relative(path: &Path) -> Result<(), WorkspaceError> {
    if path.as_os_str().is_empty()
        || path.is_absolute()
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(WorkspaceError::RelativePathInvalid);
    }
    Ok(())
}

fn validate_identifier(value: &str) -> Result<(), WorkspaceError> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(WorkspaceError::AttemptIdInvalid);
    }
    Ok(())
}

fn same_object(left: &fs::Metadata, right: &fs::Metadata) -> bool {
    left.dev() == right.dev()
        && left.ino() == right.ino()
        && left.mode() == right.mode()
        && left.uid() == right.uid()
        && left.gid() == right.gid()
        && left.nlink() == right.nlink()
}

fn path_text(path: &Path) -> Result<String, WorkspaceError> {
    path.to_str()
        .map(ToOwned::to_owned)
        .ok_or(WorkspaceError::NonUtf8Path)
}

fn hash_path(path: &Path) -> Result<Sha256Digest, WorkspaceError> {
    hash_bytes("HeptaCanonicalWorkspacePathV1", path_text(path)?.as_bytes())
}

fn hash_file(path: &Path, maximum_bytes: u64) -> Result<Sha256Digest, WorkspaceError> {
    let mut file =
        File::open(path).map_err(|error| WorkspaceError::Filesystem("hash_file", error.kind()))?;
    hash_file_bytes(&mut file, path, maximum_bytes)
}

fn hash_file_bytes(
    file: &mut impl Read,
    path: &Path,
    maximum_bytes: u64,
) -> Result<Sha256Digest, WorkspaceError> {
    let read_limit = maximum_bytes
        .checked_add(1)
        .ok_or(WorkspaceError::NumericOverflow)?;
    let mut file = file.take(read_limit);
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
        if total > maximum_bytes {
            return Err(WorkspaceError::FileByteLimitExceeded(path_text(path)?));
        }
        hasher.update(&buffer[..read]);
    }
    digest(hasher)
}

fn hash_serialized<T: Serialize>(domain: &str, value: &T) -> Result<Sha256Digest, WorkspaceError> {
    let bytes = serde_json::to_vec(value).map_err(|_| WorkspaceError::Serialization)?;
    hash_bytes(domain, &bytes)
}

fn hash_bytes(domain: &str, bytes: &[u8]) -> Result<Sha256Digest, WorkspaceError> {
    let mut hasher = Sha256::new();
    update_field(&mut hasher, domain.as_bytes());
    update_field(&mut hasher, bytes);
    digest(hasher)
}

fn update_field(hasher: &mut Sha256, bytes: &[u8]) {
    hasher.update(u64::try_from(bytes.len()).unwrap_or(u64::MAX).to_be_bytes());
    hasher.update(bytes);
}

fn digest(hasher: Sha256) -> Result<Sha256Digest, WorkspaceError> {
    Sha256Digest::from_str(&format!("sha256:{}", hex::encode(hasher.finalize())))
        .map_err(|_| WorkspaceError::DigestConstruction)
}

fn zero_digest() -> Result<Sha256Digest, WorkspaceError> {
    Sha256Digest::from_str(&format!("sha256:{}", "0".repeat(64)))
        .map_err(|_| WorkspaceError::DigestConstruction)
}

fn sync_directory(path: &Path) -> Result<(), WorkspaceError> {
    File::open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| WorkspaceError::Filesystem("sync_directory", error.kind()))
}

/// Fallible phases reached only after the attempt's no-replace rename succeeded.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AttemptPublicationPhaseV1 {
    ParentDirectorySync,
    PublishedRootOpen,
    PublishedRootValidation,
    PublishedInventoryValidation,
}

#[derive(Clone, Debug, Error, Eq, PartialEq)]
pub enum WorkspaceError {
    #[error("workspace root is not canonical, private, owned, and link-free")]
    RootInvalid,
    #[error("workspace root object changed")]
    RootChanged,
    #[error("published workspace inventory differs from its staging observation")]
    InventoryChanged,
    #[error("relative workspace path is invalid")]
    RelativePathInvalid,
    #[error("relative workspace path escapes the pinned root")]
    PathEscapesRoot,
    #[error("workspace path is not valid UTF-8")]
    NonUtf8Path,
    #[error("workspace symlink is forbidden: {0}")]
    SymlinkForbidden(String),
    #[error("workspace special file is forbidden: {0}")]
    SpecialFileForbidden(String),
    #[error("workspace file exceeds the byte limit: {0}")]
    FileByteLimitExceeded(String),
    #[error("workspace tree exceeds the entry limit")]
    TreeEntryLimitExceeded,
    #[error("workspace mutation bytes exceed the hard limit")]
    MutationByteLimitExceeded,
    #[error("workspace mutation policy rejected the manifest")]
    MutationPolicyRejected,
    #[error("attempt parent must be a canonical owner-only directory")]
    AttemptParentInvalid,
    #[error("attempt parent is locked by a cooperating materializer or recovery")]
    AttemptParentBusy,
    #[error("attempt parent pathname or retained directory identity changed")]
    AttemptParentChanged,
    #[error("attempt identifier is invalid")]
    AttemptIdInvalid,
    #[error("attempt already exists")]
    AttemptAlreadyExists,
    /// The final name was published and has not been removed by this producer.
    /// Parent sync completion records only that this call returned success;
    /// false means durability is unconfirmed, not that publication was undone.
    #[error(
        "published attempt at {final_path:?} requires inspection after {phase:?} (parent sync completed: {parent_sync_completed}): {cause}"
    )]
    PublishedAttemptRequiresInspection {
        final_path: PathBuf,
        phase: AttemptPublicationPhaseV1,
        parent_sync_completed: bool,
        #[source]
        cause: Box<WorkspaceError>,
    },
    #[error("incomplete attempt recovery found a foreign object")]
    AttemptRecoveryIdentityMismatch,
    #[error("clock is before the Unix epoch")]
    ClockBeforeEpoch,
    #[error("numeric conversion overflowed")]
    NumericOverflow,
    #[error("workspace serialization failed")]
    Serialization,
    #[error("workspace digest construction failed")]
    DigestConstruction,
    #[error("workspace filesystem operation failed for {0}: {1:?}")]
    Filesystem(&'static str, std::io::ErrorKind),
}

#[cfg(test)]
mod tests;
