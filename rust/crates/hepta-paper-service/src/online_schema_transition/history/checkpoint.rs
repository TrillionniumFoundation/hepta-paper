//! Load an exact retained schema-finalization inventory and its original raw
//! database/WAL bytes. Current files may have advanced in place; authenticating
//! their business state requires a separate finalized-history replay proof.
//!
//! The fixed directory contains POST_INVENTORY.json and databases/000.sqlite,
//! databases/001.sqlite, ... in the original inventory order, plus precisely
//! those .sqlite-wal files present in that inventory. No bytes or historical
//! file identities are synthesized, and no live SQLite connection is opened.
use crate::{
    online_runtime_activation::inventory::assert_closed_activation_inventory_v1,
    online_schema_transition::{audit::verify_audit, files::AuditSnapshot},
    sqlite_mutation_coordinator::{
        Result, SqliteMutationCoordinatorError,
        authority::{MutationAuthorityTransportV1, PinnedMutationAuthorityV1, files::parse},
        error, hash, hash_bytes,
        manifest::writer_manifest_hash_v1,
        sha, text,
    },
    state_database_inventory::{
        NativeStoreTransactionInventoryGuardV1, ObservedStateDatabaseInventoryV1,
    },
};
use nix::{
    fcntl::{OFlag, open, openat},
    sys::stat::Mode,
};
use serde_json::{Value, json};
use std::{
    collections::BTreeSet,
    fs::{self, File, Metadata},
    io::Read,
    os::{fd::AsRawFd, unix::fs::MetadataExt},
    path::{Component, Path, PathBuf},
};

const MAX_REPORT: u64 = 16 * 1024 * 1024;
const MAX_FILE: u64 = 256 * 1024 * 1024;
const MAX_TOTAL: u64 = 1024 * 1024 * 1024;
fn fail(suffix: &str) -> SqliteMutationCoordinatorError {
    error(format!(
        "autonomous_research_online_schema_checkpoint_{suffix}"
    ))
}
fn require(valid: bool, suffix: &str) -> Result<()> {
    if valid { Ok(()) } else { Err(fail(suffix)) }
}
fn stable(a: &Metadata, b: &Metadata) -> bool {
    a.dev() == b.dev()
        && a.ino() == b.ino()
        && a.mode() == b.mode()
        && a.uid() == b.uid()
        && a.gid() == b.gid()
}
fn exact(a: &Metadata, b: &Metadata) -> bool {
    stable(a, b)
        && a.nlink() == b.nlink()
        && a.len() == b.len()
        && a.mtime() == b.mtime()
        && a.mtime_nsec() == b.mtime_nsec()
        && a.ctime() == b.ctime()
        && a.ctime_nsec() == b.ctime_nsec()
}
struct Directory {
    path: PathBuf,
    held: File,
    metadata: Metadata,
}
impl Directory {
    fn current(&self) -> Result<()> {
        let named = fs::symlink_metadata(&self.path).map_err(|_| fail("files_changed"))?;
        let held = self.held.metadata().map_err(|_| fail("files_changed"))?;
        require(
            named.is_dir()
                && !named.is_symlink()
                && stable(&named, &self.metadata)
                && stable(&held, &self.metadata),
            "files_changed",
        )
    }
    fn child(&self, name: &std::ffi::OsStr) -> Result<Self> {
        self.current()?;
        let held = File::from(
            openat(
                &self.held,
                Path::new(name),
                OFlag::O_RDONLY | OFlag::O_DIRECTORY | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC,
                Mode::empty(),
            )
            .map_err(|_| fail("path_invalid"))?,
        );
        let next = Self {
            path: self.path.join(name),
            metadata: held.metadata().map_err(|_| fail("path_invalid"))?,
            held,
        };
        next.current()?;
        Ok(next)
    }
    fn names(&self) -> Result<BTreeSet<String>> {
        self.current()?;
        let result = fs::read_dir(format!("/proc/self/fd/{}", self.held.as_raw_fd()))
            .map_err(|_| fail("files_changed"))?
            .take(23)
            .map(|entry| {
                entry
                    .map_err(|_| fail("files_changed"))?
                    .file_name()
                    .into_string()
                    .map_err(|_| fail("path_invalid"))
            })
            .collect::<Result<BTreeSet<_>>>()?;
        self.current()?;
        Ok(result)
    }
    fn safe(&self) -> Result<()> {
        let uid = nix::unistd::getuid().as_raw();
        require(
            self.metadata.mode() & 0o022 == 0
                && (self.metadata.uid() == 0 || self.metadata.uid() == uid),
            "path_invalid",
        )
    }
}
fn directories(path: &Path) -> Result<Vec<Directory>> {
    require(
        path.is_absolute()
            && path.to_str().is_some()
            && path
                .components()
                .all(|p| matches!(p, Component::RootDir | Component::Normal(_)))
            && fs::canonicalize(path).ok().as_deref() == Some(path),
        "path_invalid",
    )?;
    let held = File::from(
        open(
            Path::new("/"),
            OFlag::O_RDONLY | OFlag::O_DIRECTORY | OFlag::O_CLOEXEC,
            Mode::empty(),
        )
        .map_err(|_| fail("path_invalid"))?,
    );
    let first = Directory {
        path: PathBuf::from("/"),
        metadata: held.metadata().map_err(|_| fail("path_invalid"))?,
        held,
    };
    let mut result = vec![first];
    for part in path.components() {
        if let Component::Normal(name) = part {
            let next = result
                .last()
                .ok_or_else(|| fail("path_invalid"))?
                .child(name)?;
            result.push(next);
        }
    }
    result.last().ok_or_else(|| fail("path_invalid"))?.safe()?;
    Ok(result)
}
struct RetainedFile {
    name: String,
    file: File,
    metadata: Metadata,
    bytes: Vec<u8>,
}
impl RetainedFile {
    fn load(directory: &Directory, name: &str, limit: u64) -> Result<Self> {
        directory.current()?;
        let mut file = File::from(
            openat(
                &directory.held,
                Path::new(name),
                OFlag::O_RDONLY | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC | OFlag::O_NONBLOCK,
                Mode::empty(),
            )
            .map_err(|_| fail("snapshot_missing_or_unsafe"))?,
        );
        let metadata = file
            .metadata()
            .map_err(|_| fail("snapshot_missing_or_unsafe"))?;
        let uid = nix::unistd::getuid().as_raw();
        require(
            metadata.is_file()
                && metadata.nlink() == 1
                && metadata.mode() & 0o022 == 0
                && (metadata.uid() == 0 || metadata.uid() == uid),
            "snapshot_missing_or_unsafe",
        )?;
        require(metadata.len() <= limit, "resource_limit")?;
        let mut bytes = Vec::new();
        (&mut file)
            .take(limit + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| fail("files_changed"))?;
        require(bytes.len() as u64 == metadata.len(), "files_changed")?;
        let result = Self {
            name: name.into(),
            file,
            metadata,
            bytes,
        };
        result.current(directory)?;
        Ok(result)
    }
    fn current(&self, directory: &Directory) -> Result<()> {
        directory.current()?;
        let held = self.file.metadata().map_err(|_| fail("files_changed"))?;
        let named = fs::symlink_metadata(format!(
            "/proc/self/fd/{}/{}",
            directory.held.as_raw_fd(),
            self.name
        ))
        .map_err(|_| fail("files_changed"))?;
        require(
            named.is_file()
                && !named.is_symlink()
                && exact(&named, &self.metadata)
                && exact(&held, &self.metadata),
            "files_changed",
        )
    }
}
struct DatabaseBytes {
    main: RetainedFile,
    wal: Option<RetainedFile>,
}
fn identity(value: &Value) -> Result<Value> {
    let map = value.as_object().ok_or_else(|| fail("inventory_invalid"))?;
    const KEYS: [&str; 7] = [
        "device",
        "inode",
        "mode",
        "links",
        "bytes",
        "modifiedNs",
        "changedNs",
    ];
    require(
        map.len() == KEYS.len()
            && KEYS.iter().all(|key| {
                map.get(*key)
                    .and_then(Value::as_str)
                    .is_some_and(|s| !s.is_empty() && s.parse::<i128>().is_ok())
            }),
        "inventory_invalid",
    )?;
    require(
        value["links"] == "1" && text(value, "bytes")?.parse::<u64>().is_ok(),
        "inventory_invalid",
    )?;
    Ok(
        json!({"device":value["device"],"inode":value["inode"],"mode":value["mode"],"links":value["links"]}),
    )
}

/// Authenticated immutable historical bytes, not current business-state parity,
/// runtime readiness, a filesystem lock, or a mutation capability. JSON claims
/// cannot construct this type. The original inventory metadata describes the
/// original live files; the retained copies keep their own independently held
/// identities and are never relabeled as those original files.
///
/// ```compile_fail
/// use hepta_paper_service::online_schema_transition::history::checkpoint::VerifiedSchemaTransitionCheckpointV1;
/// let checkpoint: VerifiedSchemaTransitionCheckpointV1 = serde_json::from_str("{}").unwrap();
/// ```
pub struct VerifiedSchemaTransitionCheckpointV1 {
    inventory: Value,
    manifest_hash: String,
    authority_hash: String,
    audit: AuditSnapshot,
    ancestors: Vec<Directory>,
    databases: Directory,
    report: RetainedFile,
    copies: Vec<DatabaseBytes>,
    expected_names: BTreeSet<String>,
}
/// Borrowed, authenticated original bytes for an in-crate private replay. These
/// are never the writable source paths, and cannot construct a current proof.
pub(crate) struct CheckpointDatabaseBytesV1<'a> {
    pub(crate) instance: &'a Value,
    pub(crate) main: &'a [u8],
    pub(crate) wal: Option<&'a [u8]>,
}
impl VerifiedSchemaTransitionCheckpointV1 {
    pub(crate) fn schema_audit(&self) -> Result<Value> {
        self.audit.assert_current()?;
        self.audit.value()
    }
    pub(crate) fn database_bytes(
        &self,
        instance_id: &str,
    ) -> Result<CheckpointDatabaseBytesV1<'_>> {
        let (index, instance) = self.inventory["instances"]
            .as_array()
            .ok_or_else(|| fail("inventory_invalid"))?
            .iter()
            .enumerate()
            .find(|(_, row)| row["instanceId"].as_str() == Some(instance_id))
            .ok_or_else(|| fail("instance_missing"))?;
        let copy = self
            .copies
            .get(index)
            .ok_or_else(|| fail("instance_missing"))?;
        self.audit.assert_current()?;
        self.report
            .current(self.ancestors.last().ok_or_else(|| fail("files_changed"))?)?;
        copy.main.current(&self.databases)?;
        if let Some(wal) = &copy.wal {
            wal.current(&self.databases)?;
        }
        Ok(CheckpointDatabaseBytesV1 {
            instance,
            main: &copy.main.bytes,
            wal: copy.wal.as_ref().map(|wal| wal.bytes.as_slice()),
        })
    }
    pub fn historical_inventory(&self) -> &Value {
        &self.inventory
    }
    pub fn checkpoint_root(&self) -> &Path {
        // Construction always pins the report's parent and at least root.
        &self.ancestors[self.ancestors.len() - 1].path
    }
    /// Recheck every retained file and the exact original signed audit, plus
    /// current real database membership/schema/stable source identities. This
    /// intentionally does not compare current business bytes with the past.
    pub fn assert_current<T: MutationAuthorityTransportV1>(
        &self,
        current: &ObservedStateDatabaseInventoryV1,
        authority: &PinnedMutationAuthorityV1<T>,
    ) -> Result<()> {
        self.assert_subject(current, authority)?;
        current.assert_current()?;
        self.assert_retained_files(current, authority)?;
        current.assert_current()
    }
    pub(crate) fn assert_retained_for_native_store_transaction<T: MutationAuthorityTransportV1>(
        &self,
        current: &ObservedStateDatabaseInventoryV1,
        authority: &PinnedMutationAuthorityV1<T>,
        guard: &NativeStoreTransactionInventoryGuardV1<'_>,
    ) -> Result<()> {
        self.assert_subject(current, authority)?;
        guard.assert_bound_to(current)?;
        self.assert_retained_files(current, authority)?;
        guard.assert_bound_to(current)
    }
    fn assert_subject<T: MutationAuthorityTransportV1>(
        &self,
        current: &ObservedStateDatabaseInventoryV1,
        authority: &PinnedMutationAuthorityV1<T>,
    ) -> Result<()> {
        require(
            authority.configuration_hash() == self.authority_hash
                && current.runtime_root() == self.audit.runtime_root(),
            "subject_changed",
        )
    }
    /// Every regular file below was opened during checkpoint construction.
    /// Read only held descriptors and directory entries, including on failure.
    fn assert_retained_files<T: MutationAuthorityTransportV1>(
        &self,
        current: &ObservedStateDatabaseInventoryV1,
        authority: &PinnedMutationAuthorityV1<T>,
    ) -> Result<()> {
        for directory in &self.ancestors {
            directory.current()?;
        }
        let directory = self.ancestors.last().ok_or_else(|| fail("files_changed"))?;
        require(
            directory.names()?
                == BTreeSet::from(["POST_INVENTORY.json".into(), "databases".into()])
                && self.databases.names()? == self.expected_names,
            "snapshot_set_changed",
        )?;
        self.report.current(directory)?;
        for copy in &self.copies {
            copy.main.current(&self.databases)?;
            if let Some(wal) = &copy.wal {
                wal.current(&self.databases)?;
            }
        }
        self.audit.assert_current()?;
        let audit = self.audit.value()?;
        verify_audit(
            &audit,
            self.audit.bytes(),
            &self.inventory,
            &self.manifest_hash,
            authority,
        )?;
        bind(&self.inventory, current.value(), &audit)
    }
}
fn bind(historical: &Value, current: &Value, audit: &Value) -> Result<()> {
    require(
        ["manifestId", "manifestHash", "databaseScopeHash"]
            .iter()
            .all(|key| historical[*key] == current[*key])
            && historical["manifestHash"] == audit["reserveRequest"]["stateDatabaseManifestHash"],
        "subject_changed",
    )?;
    let old = historical["instances"]
        .as_array()
        .ok_or_else(|| fail("inventory_invalid"))?;
    let live = current["instances"]
        .as_array()
        .ok_or_else(|| fail("inventory_invalid"))?;
    let reserved = audit["reserveRequest"]["instances"]
        .as_array()
        .ok_or_else(|| fail("inventory_invalid"))?;
    require(
        old.len() == live.len() && old.len() == reserved.len(),
        "subject_changed",
    )?;
    for ((old, live), reserved) in old.iter().zip(live).zip(reserved) {
        require(
            [
                "instanceId",
                "role",
                "paperId",
                "sourceRelativePath",
                "schemaContractId",
                "schemaHash",
                "schemaObjects",
                "userVersion",
                "applicationId",
            ]
            .iter()
            .all(|key| old[*key] == live[*key])
                && identity(&old["sourceFileIdentity"])? == identity(&live["sourceFileIdentity"])?
                && reserved["databaseRole"] == old["role"]
                && reserved["databaseInstanceId"] == old["instanceId"]
                && reserved["sourceRelativePath"] == old["sourceRelativePath"]
                && reserved["schemaContractId"] == old["schemaContractId"]
                && reserved["expectedPostSchemaHash"] == old["schemaHash"]
                && reserved["sourceFileIdentityHash"]
                    == hash(
                        "AutonomousResearchOnlineSchemaTransitionSourceFileIdentity",
                        &identity(&old["sourceFileIdentity"])?,
                    )?,
            "subject_changed",
        )?;
    }
    Ok(())
}

/// Load a retained full original post-inventory and exact raw main/WAL copies.
/// The directory is input evidence, never a ready flag. Missing historical
/// bytes are an error; a fresh or later backup cannot substitute for them.
/// No files are created, modified, normalized, checkpointed, or opened by SQLite.
pub fn load_schema_transition_checkpoint_v1<T: MutationAuthorityTransportV1>(
    checkpoint_root: &Path,
    current: &ObservedStateDatabaseInventoryV1,
    writer_manifest: &Value,
    authority: &PinnedMutationAuthorityV1<T>,
) -> Result<VerifiedSchemaTransitionCheckpointV1> {
    current.assert_current()?;
    let manifest_hash = writer_manifest_hash_v1(writer_manifest)?;
    require(
        authority.trust()["writerManifestHash"] == manifest_hash
            && authority.trust()["databaseScopeHash"] == current.value()["databaseScopeHash"],
        "subject_changed",
    )?;
    assert_closed_activation_inventory_v1(current.value(), writer_manifest)
        .map_err(|_| fail("inventory_invalid"))?;
    let ancestors = directories(checkpoint_root)?;
    let directory = ancestors.last().ok_or_else(|| fail("path_invalid"))?;
    require(
        directory.names()? == BTreeSet::from(["POST_INVENTORY.json".into(), "databases".into()]),
        "snapshot_missing_or_unsafe",
    )?;
    let report = RetainedFile::load(directory, "POST_INVENTORY.json", MAX_REPORT)?;
    let inventory = parse(
        &report.bytes,
        "autonomous_research_online_schema_checkpoint_inventory_invalid",
    )?;
    assert_closed_activation_inventory_v1(&inventory, writer_manifest)
        .map_err(|_| fail("inventory_invalid"))?;
    let audit = AuditSnapshot::load(current.runtime_root())?;
    let receipt = audit.value()?;
    // This is the original unchanged strict verifier. Its exact equality is
    // checked against the fully hashed historical report, never a synthetic
    // projection containing only the audit's claimed postInventoryHash.
    verify_audit(
        &receipt,
        audit.bytes(),
        &inventory,
        &manifest_hash,
        authority,
    )?;
    bind(&inventory, current.value(), &receipt)?;
    let databases = directory.child(std::ffi::OsStr::new("databases"))?;
    databases.safe()?;
    let mut expected_names = BTreeSet::new();
    let mut copies = Vec::new();
    let mut total = 0_u64;
    for (index, row) in inventory["instances"]
        .as_array()
        .ok_or_else(|| fail("inventory_invalid"))?
        .iter()
        .enumerate()
    {
        let main_name = format!("{index:03}.sqlite");
        let length = text(&row["sourceFileIdentity"], "bytes")?
            .parse::<u64>()
            .map_err(|_| fail("inventory_invalid"))?;
        require(
            length > 0 && length <= MAX_FILE && sha(&row["sourceSha256"]),
            "inventory_invalid",
        )?;
        total = total
            .checked_add(length)
            .ok_or_else(|| fail("resource_limit"))?;
        require(total <= MAX_TOTAL, "resource_limit")?;
        let main = RetainedFile::load(&databases, &main_name, length)?;
        require(
            main.metadata.len() == length && hash_bytes(&main.bytes) == row["sourceSha256"],
            "snapshot_hash_mismatch",
        )?;
        expected_names.insert(main_name.clone());
        let wal = if row["walFileIdentity"].is_null() && row["walSha256"].is_null() {
            None
        } else {
            identity(&row["walFileIdentity"])?;
            let length = text(&row["walFileIdentity"], "bytes")?
                .parse::<u64>()
                .map_err(|_| fail("inventory_invalid"))?;
            require(
                length <= MAX_FILE && sha(&row["walSha256"]),
                "inventory_invalid",
            )?;
            total = total
                .checked_add(length)
                .ok_or_else(|| fail("resource_limit"))?;
            require(total <= MAX_TOTAL, "resource_limit")?;
            let name = format!("{main_name}-wal");
            let wal = RetainedFile::load(&databases, &name, length)?;
            require(
                wal.metadata.len() == length && hash_bytes(&wal.bytes) == row["walSha256"],
                "snapshot_hash_mismatch",
            )?;
            expected_names.insert(name);
            Some(wal)
        };
        copies.push(DatabaseBytes { main, wal });
    }
    let result = VerifiedSchemaTransitionCheckpointV1 {
        inventory,
        manifest_hash,
        authority_hash: authority.configuration_hash().into(),
        audit,
        ancestors,
        databases,
        report,
        copies,
        expected_names,
    };
    result.assert_current(current, authority)?;
    Ok(result)
}

#[cfg(test)]
mod tests;
