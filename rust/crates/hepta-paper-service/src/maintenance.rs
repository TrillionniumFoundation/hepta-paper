//! Local byte-preserving maintenance under cooperative service exclusion.
//!
//! A verified backup proves file identities, not semantic recovery, scientific
//! acceptance, writer authority or permission to retire Node. This module never
//! deletes CAS data, restores over state, refreshes leases or starts a worker.
use crate::{ServiceError, state_access::{LOCK_NAME, StateAccessGuardV1, private_root}};
use hepta_codex_protocol::Sha256Digest;
use nix::fcntl::{Flock, FlockArg, OFlag};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    fs::{self, File, Metadata, OpenOptions},
    io::{Read, Write},
    os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
};

const MAX_FILES: usize = 4096;
const MAX_FILE_BYTES: u64 = 256 * 1024 * 1024;
const MAX_TOTAL_BYTES: u64 = 1024 * 1024 * 1024;
const MAX_MANIFEST_BYTES: u64 = 1024 * 1024;
const FORMAT: &str = "HeptaLocalByteBackupV1";

/// File names are closed relative paths, never arbitrary extraction destinations.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LocalBackupFileV1 {
    pub path: String,
    pub bytes: u64,
    pub sha256: Sha256Digest,
}

/// Bound to exact bytes. All authority and semantic acceptance fields stay false.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LocalBackupManifestV1 {
    pub version: u16,
    pub kind: String,
    pub source_directory: PathBuf,
    pub files: Vec<LocalBackupFileV1>,
    pub total_bytes: u64,
    pub semantic_recovery_verified: bool,
    pub production_activation: bool,
    pub node_retirement_verified: bool,
}

/// Contains no worker output, credentials or current writer capability.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalBackupReceiptV1 {
    pub version: u16,
    pub manifest_hash: Sha256Digest,
    pub file_count: usize,
    pub total_bytes: u64,
    pub bytes_verified: bool,
    pub semantic_recovery_verified: bool,
    pub production_activation: bool,
    pub node_retirement_verified: bool,
}

/// Opaque RAII lease: every ObjectStore clone must be dropped before acquisition.
/// Acquiring this lease neither grants a database writer nor accepts a backup.
pub struct LocalMaintenanceSessionV1 {
    state: PathBuf,
    owner: u32,
    access: StateAccessGuardV1,
    workflow_lock: Flock<File>,
}

fn digest(bytes: &[u8]) -> Result<Sha256Digest, ServiceError> {
    format!("sha256:{}", hex::encode(Sha256::digest(bytes)))
        .parse()
        .map_err(|_| ServiceError::Artifact)
}

fn unchanged(a: &Metadata, b: &Metadata) -> bool {
    a.dev() == b.dev() && a.ino() == b.ino() && a.uid() == b.uid()
        && a.mode() == b.mode() && a.nlink() == b.nlink() && a.len() == b.len()
        && a.mtime() == b.mtime() && a.mtime_nsec() == b.mtime_nsec()
        && a.ctime() == b.ctime() && a.ctime_nsec() == b.ctime_nsec()
}

fn read_private(path: &Path, owner: u32, maximum: u64) -> Result<Vec<u8>, ServiceError> {
    let named_before = fs::symlink_metadata(path).map_err(|_| ServiceError::Filesystem)?;
    let mut file = OpenOptions::new().read(true)
        .custom_flags((OFlag::O_NOFOLLOW | OFlag::O_NONBLOCK).bits())
        .open(path).map_err(|_| ServiceError::Filesystem)?;
    let before = file.metadata().map_err(|_| ServiceError::Filesystem)?;
    if !before.is_file() || before.uid() != owner || before.nlink() != 1
        || before.mode() & 0o077 != 0 || before.len() > maximum
        || !unchanged(&named_before, &before)
    {
        return Err(ServiceError::Artifact);
    }
    let mut data = Vec::new();
    Read::by_ref(&mut file).take(maximum + 1).read_to_end(&mut data)
        .map_err(|_| ServiceError::Filesystem)?;
    let after = file.metadata().map_err(|_| ServiceError::Filesystem)?;
    let named_after = fs::symlink_metadata(path).map_err(|_| ServiceError::Filesystem)?;
    if data.len() as u64 != before.len() || !unchanged(&before, &after)
        || !unchanged(&before, &named_after)
    {
        return Err(ServiceError::Artifact);
    }
    Ok(data)
}

fn hash_name(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn allowed_path(path: &str) -> bool {
    if matches!(path, "campaign.sqlite" | "workflow.json" | "workflow.lock" | LOCK_NAME) {
        return true;
    }
    if let Some(name) = path.strip_prefix("step-").and_then(|s| s.strip_suffix(".json")) {
        return name.len() == 4 && name.bytes().all(|b| b.is_ascii_digit());
    }
    if let Some(name) = path.strip_prefix("objects/") { return hash_name(name); }
    if let Some(name) = path.strip_prefix("attempts/") {
        return name.strip_suffix(".started").or_else(|| name.strip_suffix(".prepared"))
            .is_some_and(hash_name);
    }
    false
}

fn entries(path: &Path) -> Result<Vec<String>, ServiceError> {
    let mut names = Vec::new();
    for entry in fs::read_dir(path).map_err(|_| ServiceError::Filesystem)? {
        let name = entry.map_err(|_| ServiceError::Filesystem)?.file_name()
            .into_string().map_err(|_| ServiceError::Artifact)?;
        if names.len() >= MAX_FILES { return Err(ServiceError::Artifact); }
        names.push(name);
    }
    names.sort();
    Ok(names)
}

fn inventory(root: &Path, owner: u32) -> Result<Vec<LocalBackupFileV1>, ServiceError> {
    let before = private_root(root)?;
    if before.uid() != owner { return Err(ServiceError::Artifact); }
    let top = entries(root)?;
    let mut paths = Vec::new();
    let mut child_directories = Vec::new();
    for name in &top {
        if matches!(name.as_str(), "objects" | "attempts") {
            let directory = root.join(name);
            if private_root(&directory)?.uid() != owner { return Err(ServiceError::Artifact); }
            let directory_identity = private_root(&directory)?;
            let children = entries(&directory)?;
            for child in &children { paths.push(format!("{name}/{child}")); }
            child_directories.push((directory, directory_identity, children));
        } else { paths.push(name.clone()); }
        if paths.len() > MAX_FILES { return Err(ServiceError::Artifact); }
    }
    for required in ["objects", "attempts", "campaign.sqlite", "workflow.json", "workflow.lock", LOCK_NAME] {
        if !top.iter().any(|name| name == required) { return Err(ServiceError::Artifact); }
    }
    paths.sort();
    let mut total = 0u64;
    let mut result = Vec::new();
    for relative in paths {
        if !allowed_path(&relative) { return Err(ServiceError::Artifact); }
        let data = read_private(&root.join(&relative), owner, MAX_FILE_BYTES)?;
        total = total.checked_add(data.len() as u64).ok_or(ServiceError::Artifact)?;
        if total > MAX_TOTAL_BYTES { return Err(ServiceError::Artifact); }
        let sha256 = digest(&data)?;
        if let Some(raw) = relative.strip_prefix("objects/") {
            if sha256.as_str().strip_prefix("sha256:") != Some(raw) { return Err(ServiceError::Artifact); }
        }
        if matches!(relative.as_str(), "workflow.lock" | LOCK_NAME) && !data.is_empty() {
            return Err(ServiceError::Artifact);
        }
        result.push(LocalBackupFileV1 { path: relative, bytes: data.len() as u64, sha256 });
    }
    for (directory, identity, children) in child_directories {
        if entries(&directory)? != children || !unchanged(&identity, &private_root(&directory)?) {
            return Err(ServiceError::Artifact);
        }
    }
    if entries(root)? != top || !unchanged(&before, &private_root(root)?) {
        return Err(ServiceError::Artifact);
    }
    Ok(result)
}

fn sync_dir(root: &Path) -> Result<(), ServiceError> {
    File::open(root).and_then(|f| f.sync_all()).map_err(|_| ServiceError::Filesystem)
}

fn write_new(path: &Path, data: &[u8]) -> Result<(), ServiceError> {
    let mut file = OpenOptions::new().write(true).create_new(true).mode(0o600)
        .custom_flags((OFlag::O_NOFOLLOW | OFlag::O_NONBLOCK).bits())
        .open(path).map_err(|_| ServiceError::Filesystem)?;
    file.write_all(data).and_then(|()| file.sync_all()).map_err(|_| ServiceError::Filesystem)
}

fn create_private(path: &Path) -> Result<(), ServiceError> {
    fs::DirBuilder::new().mode(0o700).create(path).map_err(|_| ServiceError::Filesystem)
}

impl LocalMaintenanceSessionV1 {
    /// Only already enrolled, quiescent workflow roots are admitted. No repair,
    /// new database, missing-directory creation or WAL checkpoint is performed.
    pub fn acquire(state: &Path) -> Result<Self, ServiceError> {
        let owner = private_root(state)?.uid();
        let access = StateAccessGuardV1::exclusive(state)?;
        let path = state.join("workflow.lock");
        if !read_private(&path, owner, 0)?.is_empty() { return Err(ServiceError::Artifact); }
        let file = OpenOptions::new().read(true).write(true)
            .custom_flags((OFlag::O_NOFOLLOW | OFlag::O_NONBLOCK).bits())
            .open(&path).map_err(|_| ServiceError::Filesystem)?;
        let workflow_lock = Flock::lock(file, FlockArg::LockExclusiveNonblock)
            .map_err(|_| ServiceError::Persistence)?;
        let session = Self { state: state.to_path_buf(), owner, access, workflow_lock };
        session.validate()?;
        Ok(session)
    }

    fn validate(&self) -> Result<(), ServiceError> {
        self.access.validate()?;
        let held = self.workflow_lock.metadata().map_err(|_| ServiceError::Filesystem)?;
        let named = fs::symlink_metadata(self.state.join("workflow.lock"))
            .map_err(|_| ServiceError::Filesystem)?;
        if !held.is_file() || held.uid() != self.owner || held.nlink() != 1
            || held.mode() & 0o077 != 0 || held.len() != 0 || !unchanged(&held, &named)
        { return Err(ServiceError::Artifact); }
        Ok(())
    }

    /// A byte-level inventory only. Unknown entries and any SQLite sidecar deny.
    pub fn inspect(&self) -> Result<LocalBackupManifestV1, ServiceError> {
        self.validate()?;
        let files = inventory(&self.state, self.owner)?;
        self.validate()?;
        let total_bytes = files.iter().map(|entry| entry.bytes).sum();
        Ok(LocalBackupManifestV1 {
            version: 1, kind: FORMAT.into(), source_directory: self.state.clone(), files, total_bytes,
            semantic_recovery_verified: false, production_activation: false, node_retirement_verified: false,
        })
    }

    /// Create a new private sibling/outside bundle. Publish the manifest LAST.
    /// A failed partial destination is retained and is never silently adopted.
    pub fn backup(&self, destination: &Path) -> Result<LocalBackupReceiptV1, ServiceError> {
        self.validate()?;
        let parent = destination.parent().ok_or(ServiceError::Configuration)?;
        if !destination.is_absolute() || destination.file_name().is_none()
            || destination.starts_with(&self.state) || self.state.starts_with(destination)
            || private_root(parent)?.uid() != self.owner
            || destination != parent.join(destination.file_name().ok_or(ServiceError::Configuration)?)
        { return Err(ServiceError::Configuration); }
        let manifest = self.inspect()?;
        let encoded = serde_json::to_vec(&manifest).map_err(|_| ServiceError::Artifact)?;
        if encoded.len() as u64 > MAX_MANIFEST_BYTES { return Err(ServiceError::Artifact); }
        create_private(destination)?;
        sync_dir(parent)?;
        let payload = destination.join("payload");
        create_private(&payload)?;
        create_private(&payload.join("objects"))?;
        create_private(&payload.join("attempts"))?;
        for entry in &manifest.files {
            self.validate()?;
            let data = read_private(&self.state.join(&entry.path), self.owner, MAX_FILE_BYTES)?;
            if data.len() as u64 != entry.bytes || digest(&data)? != entry.sha256 {
                return Err(ServiceError::Artifact);
            }
            write_new(&payload.join(&entry.path), &data)?;
        }
        for directory in [&payload.join("objects"), &payload.join("attempts"), &payload] {
            sync_dir(directory)?;
        }
        if self.inspect()? != manifest || inventory(&payload, self.owner)? != manifest.files {
            return Err(ServiceError::Artifact);
        }
        // No committed manifest exists until every copied byte and source rescan agrees.
        write_new(&destination.join("manifest.json"), &encoded)?;
        sync_dir(destination)?;
        self.validate()?;
        verify_local_backup_v1(destination, &digest(&encoded)?)
    }
}

/// Verify exact manifest bytes against a separately retained digest. This does
/// not mutate a source workflow, restore files, interpret a lease or run a job.
pub fn verify_local_backup_v1(
    bundle: &Path, expected_manifest_hash: &Sha256Digest,
) -> Result<LocalBackupReceiptV1, ServiceError> {
    let root_before = private_root(bundle)?;
    let owner = root_before.uid();
    if entries(bundle)? != ["manifest.json".to_string(), "payload".to_string()] {
        return Err(ServiceError::Artifact);
    }
    let encoded = read_private(&bundle.join("manifest.json"), owner, MAX_MANIFEST_BYTES)?;
    if &digest(&encoded)? != expected_manifest_hash { return Err(ServiceError::Artifact); }
    let manifest: LocalBackupManifestV1 = serde_json::from_slice(&encoded)
        .map_err(|_| ServiceError::Artifact)?;
    if manifest.version != 1 || manifest.kind != FORMAT || !manifest.source_directory.is_absolute()
        || manifest.source_directory.components().any(|c| matches!(c, std::path::Component::ParentDir | std::path::Component::CurDir))
        || manifest.semantic_recovery_verified || manifest.production_activation || manifest.node_retirement_verified
        || manifest.files.len() > MAX_FILES || manifest.total_bytes > MAX_TOTAL_BYTES
    { return Err(ServiceError::Artifact); }
    let mut seen = BTreeSet::new();
    let mut previous: Option<&str> = None;
    let mut total = 0u64;
    for entry in &manifest.files {
        if !allowed_path(&entry.path) || !seen.insert(&entry.path) || entry.bytes > MAX_FILE_BYTES
            || previous.is_some_and(|p| p >= entry.path.as_str())
        { return Err(ServiceError::Artifact); }
        previous = Some(&entry.path);
        total = total.checked_add(entry.bytes).ok_or(ServiceError::Artifact)?;
    }
    if total != manifest.total_bytes || inventory(&bundle.join("payload"), owner)? != manifest.files
        || read_private(&bundle.join("manifest.json"), owner, MAX_MANIFEST_BYTES)? != encoded
        || entries(bundle)? != ["manifest.json".to_string(), "payload".to_string()]
        || !unchanged(&root_before, &private_root(bundle)?)
    { return Err(ServiceError::Artifact); }
    Ok(LocalBackupReceiptV1 {
        version: 1, manifest_hash: expected_manifest_hash.clone(), file_count: manifest.files.len(),
        total_bytes: total, bytes_verified: true, semantic_recovery_verified: false,
        production_activation: false, node_retirement_verified: false,
    })
}
