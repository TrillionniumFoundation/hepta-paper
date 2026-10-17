//! Ordinary package metadata publication. The private recovery files are local
//! write observations, never signed authority or permission to run npm scripts.
use super::{COMMAND_SURFACE_PACKAGE_MAX_BYTES_V1 as MAXIMUM, CommandSurfaceError};
use crate::{
    native_workspace::{NativeWorkspacePackageGuardV1, hold_native_workspace_package_v1},
    state_recoverability::publication::Directory,
};
use nix::{
    fcntl::{Flock, FlockArg, OFlag, RenameFlags, openat, renameat2},
    sys::stat::{Mode, fchmod},
    unistd::{Gid, UnlinkatFlags, fchown, getegid, geteuid, getgroups, getuid, unlinkat},
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, Metadata},
    io::Read,
    os::{fd::AsFd, unix::fs::MetadataExt},
    path::{Path, PathBuf},
};
mod runtime;

const SIDECAR: &str = ".hepta-command-surface-publication-v1";
// The bounded ordinary profile retains incomplete observations instead of
// assigning them invented publication outcomes. Repeated unfinished writes can
// reach this explicit refusal limit; they never confer signed authority.
const MAXIMUM_ENTRIES: usize = 128;
const NEW_PUBLICATION_ENTRY_RESERVE: usize = 6;
const RECORD_LIMIT: u64 = 16 * 1024;
const FLAGS: OFlag = OFlag::O_RDONLY
    .union(OFlag::O_NOFOLLOW)
    .union(OFlag::O_NONBLOCK)
    .union(OFlag::O_CLOEXEC);
fn refused(code: &'static str) -> CommandSurfaceError {
    CommandSurfaceError::Publication(code)
}
fn changed() -> CommandSurfaceError {
    refused("command_surface_package_publication_changed")
}
fn unknown() -> CommandSurfaceError {
    refused("command_surface_package_publication_outcome_unknown_retained")
}
fn private_error(_: impl std::fmt::Display) -> CommandSurfaceError {
    changed()
}
fn hash(bytes: &[u8]) -> String {
    format!("sha256:{}", hex::encode(Sha256::digest(bytes)))
}
fn nonce() -> Result<String, CommandSurfaceError> {
    let mut bytes = [0; 16];
    getrandom::fill(&mut bytes).map_err(|_| changed())?;
    Ok(hex::encode(bytes))
}
fn id_valid(value: &str) -> bool {
    value.len() == 32
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}
#[derive(Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
struct Witness {
    dev: u64,
    ino: u64,
    uid: u32,
    gid: u32,
    mode: u32,
    nlink: u64,
    size: u64,
    mtime: i64,
    mtime_nsec: i64,
    ctime: i64,
    ctime_nsec: i64,
}
impl Witness {
    fn new(m: &Metadata) -> Self {
        Self {
            dev: m.dev(),
            ino: m.ino(),
            uid: m.uid(),
            gid: m.gid(),
            mode: m.mode(),
            nlink: m.nlink(),
            size: m.len(),
            mtime: m.mtime(),
            mtime_nsec: m.mtime_nsec(),
            ctime: m.ctime(),
            ctime_nsec: m.ctime_nsec(),
        }
    }
    fn renamed(&self, m: &Metadata) -> bool {
        let mut now = Self::new(m);
        now.ctime = self.ctime;
        now.ctime_nsec = self.ctime_nsec;
        now == *self
    }
}
struct Leaf {
    file: File,
    metadata: Metadata,
    bytes: Vec<u8>,
}
impl Leaf {
    fn assert_current(&self, directory: &File, name: &str) -> Result<(), CommandSurfaceError> {
        let current =
            read_leaf(directory, name, self.metadata.len().max(1))?.ok_or_else(changed)?;
        if Witness::new(&self.metadata) != Witness::new(&self.file.metadata()?)
            || Witness::new(&self.metadata) != Witness::new(&current.metadata)
            || self.bytes != current.bytes
        {
            return Err(changed());
        }
        Ok(())
    }
}
fn read_leaf(
    directory: &File,
    name: &str,
    maximum: u64,
) -> Result<Option<Leaf>, CommandSurfaceError> {
    let fd = match openat(directory.as_fd(), name, FLAGS, Mode::empty()) {
        Ok(fd) => fd,
        Err(nix::errno::Errno::ENOENT) => return Ok(None),
        Err(_) => return Err(changed()),
    };
    let mut file = File::from(fd);
    let metadata = file.metadata()?;
    if !metadata.is_file() || metadata.nlink() != 1 || metadata.len() > maximum {
        return Err(changed());
    }
    let mut bytes = Vec::new();
    (&mut file).take(maximum + 1).read_to_end(&mut bytes)?;
    let named =
        File::from(openat(directory.as_fd(), name, FLAGS, Mode::empty()).map_err(|_| changed())?);
    if bytes.len() as u64 != metadata.len()
        || Witness::new(&metadata) != Witness::new(&file.metadata()?)
        || Witness::new(&metadata) != Witness::new(&named.metadata()?)
    {
        return Err(changed());
    }
    Ok(Some(Leaf {
        file,
        metadata,
        bytes,
    }))
}
#[derive(Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
struct Intent {
    version: u8,
    id: String,
    previous: Witness,
    previous_hash: String,
    replacement: Witness,
    replacement_hash: String,
    preimage_copy: Witness,
    replacement_copy: Witness,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Completion {
    version: u8,
    kind: String,
    intent: Intent,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct GarbageProof {
    version: u8,
    id: String,
    source: String,
    witness: Witness,
    sha256: String,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) enum RecoveryClassification {
    IncompleteStageRetained,
    PreparedAbandonmentFinished,
    PublishedPendingFinished,
    CompletedCleanupFinished,
}
pub(super) struct PackagePublication {
    pub(super) input: NativeWorkspacePackageGuardV1,
    directory: Directory,
    held: File,
    path: PathBuf,
    lock: Flock<File>,
    write_access: File,
    pub(super) recovered: Vec<RecoveryClassification>,
    runtime: Option<runtime::Context>,
    binding: Option<Leaf>,
}
impl PackagePublication {
    pub(super) fn open(root: &Path) -> Result<Self, CommandSurfaceError> {
        let input = hold_native_workspace_package_v1(root, MAXIMUM).map_err(|_| changed())?;
        let owner = getuid().as_raw();
        let root_metadata = input.parent().metadata()?;
        if owner != geteuid().as_raw()
            || input.metadata.uid() != owner
            || root_metadata.uid() != owner
            || root_metadata.mode() & 0o002 != 0
            || input.metadata.mode() & 0o7000 != 0
            || (input.metadata.gid() != getegid().as_raw()
                && owner != 0
                && !getgroups()
                    .map_err(|_| changed())?
                    .iter()
                    .any(|group| group.as_raw() == input.metadata.gid()))
        {
            return Err(refused(
                "command_surface_package_publication_owner_or_mode_invalid",
            ));
        }
        // Atomic rename must not circumvent the leaf write access required by
        // the ordinary Node writer. This never truncates or writes the input;
        // the actual OS open also observes ACL and read-only mount permissions.
        let write_access = File::from(
            openat(
                input.parent().as_fd(),
                "package.json",
                OFlag::O_WRONLY | OFlag::O_NOFOLLOW | OFlag::O_NONBLOCK | OFlag::O_CLOEXEC,
                Mode::empty(),
            )
            .map_err(|_| refused("command_surface_package_publication_write_access_denied"))?,
        );
        if Witness::new(&write_access.metadata()?) != Witness::new(&input.metadata) {
            return Err(changed());
        }
        input.assert_current().map_err(|_| changed())?;
        let context = runtime::Context::open(&input)?;
        let legacy = match openat(
            input.parent().as_fd(),
            SIDECAR,
            FLAGS | OFlag::O_DIRECTORY,
            Mode::empty(),
        ) {
            Ok(fd) => {
                drop(File::from(fd));
                true
            }
            Err(nix::errno::Errno::ENOENT) => false,
            Err(_) => return Err(unknown()),
        };
        if legacy && context.target_exists()? {
            return Err(refused(
                "command_surface_publication_runtime_migration_conflict_retained",
            ));
        }
        let path = if legacy {
            input.root().join(SIDECAR)
        } else {
            context.path.clone()
        };
        let directory = Directory::open_or_create(&path, !legacy).map_err(private_error)?;
        let held = directory.held.try_clone()?;
        let lock = File::from(
            openat(
                held.as_fd(),
                "lock",
                OFlag::O_RDWR
                    | OFlag::O_CREAT
                    | OFlag::O_NOFOLLOW
                    | OFlag::O_NONBLOCK
                    | OFlag::O_CLOEXEC,
                Mode::from_bits_truncate(0o600),
            )
            .map_err(|_| changed())?,
        );
        let lock = Flock::lock(lock, FlockArg::LockExclusiveNonblock)
            .map_err(|_| refused("command_surface_package_publication_busy"))?;
        let mut result = Self {
            input,
            directory,
            held,
            path,
            lock,
            write_access,
            recovered: Vec::new(),
            runtime: None,
            binding: None,
        };
        result.check()?;
        result.binding = context.observe_binding(&result.input, &result.held)?;
        if !legacy && result.binding.is_none() {
            if result.collect()? != ["lock"] {
                return Err(unknown());
            }
            result.binding = Some(context.create_binding(&result.input, &result.directory)?);
        }
        result.check()?;
        context.assert_current(&result.input)?;
        // Legacy unknown/foreign entries are rejected by this original owner
        // before any move or RootBinding creation can hide them from source.
        result.reconcile()?;
        context.assert_current(&result.input)?;
        if legacy {
            if result.binding.is_none() {
                if result.collect()?.len() >= MAXIMUM_ENTRIES {
                    return Err(refused("command_surface_package_publication_pending_limit"));
                }
                result.binding = Some(context.create_binding(&result.input, &result.directory)?);
            }
            context.migrate(&mut result)?;
        }
        result.runtime = Some(context);
        result.check()?;
        result.input.assert_current().map_err(|_| changed())?;
        Ok(result)
    }
    fn check(&self) -> Result<(), CommandSurfaceError> {
        self.input.assert_parent_current().map_err(|_| changed())?;
        if let Some(context) = &self.runtime {
            context.assert_current(&self.input)?;
        }
        if let Some(binding) = &self.binding {
            binding.assert_current(&self.held, runtime::BINDING_NAME)?;
        }
        self.directory.assert_current().map_err(private_error)?;
        let held = self.held.metadata()?;
        let named = fs::symlink_metadata(&self.path)?;
        if !held.is_dir()
            || named.is_symlink()
            || held.uid() != getuid().as_raw()
            || held.mode() & 0o7777 != 0o700
            || (held.dev(), held.ino(), held.mode(), held.uid(), held.gid())
                != (
                    named.dev(),
                    named.ino(),
                    named.mode(),
                    named.uid(),
                    named.gid(),
                )
        {
            return Err(changed());
        }
        let held = self.lock.metadata()?;
        let named = read_leaf(&self.held, "lock", 1)?
            .ok_or_else(changed)?
            .metadata;
        if !held.is_file()
            || held.len() != 0
            || held.nlink() != 1
            || held.uid() != getuid().as_raw()
            || held.mode() & 0o7777 != 0o600
            || Witness::new(&held) != Witness::new(&named)
        {
            return Err(changed());
        }
        Ok(())
    }
    fn record<T: Serialize>(&self, name: &str, value: &T) -> Result<(), CommandSurfaceError> {
        self.check()?;
        if self.collect()?.len() >= MAXIMUM_ENTRIES {
            return Err(refused("command_surface_package_publication_pending_limit"));
        }
        let bytes = serde_json::to_vec(value)?;
        if bytes.len() as u64 > RECORD_LIMIT {
            return Err(changed());
        }
        self.directory
            .write_new(name, &bytes)
            .map_err(private_error)?;
        self.check()
    }
    fn private_leaf(&self, name: &str, maximum: u64) -> Result<Option<Leaf>, CommandSurfaceError> {
        self.check()?;
        let leaf = read_leaf(&self.held, name, maximum)?;
        if let Some(leaf) = &leaf
            && (leaf.metadata.uid() != getuid().as_raw()
                || leaf.metadata.mode() & 0o7000 != 0
                || (maximum == RECORD_LIMIT && leaf.metadata.mode() & 0o7777 != 0o600))
        {
            return Err(changed());
        }
        self.check()?;
        Ok(leaf)
    }
    fn collect(&self) -> Result<Vec<String>, CommandSurfaceError> {
        self.check()?;
        let mut names = Vec::new();
        // Reuse the held-directory enumeration used by source and ordinary
        // filesystem owners. No pathname reopening or nested traversal.
        let mut directory = nix::dir::Dir::openat(
            self.held.as_fd(),
            Path::new("."),
            FLAGS | OFlag::O_DIRECTORY,
            Mode::empty(),
        )
        .map_err(|_| changed())?;
        for entry in directory.iter() {
            let entry = entry.map_err(|_| changed())?;
            let bytes = entry.file_name().to_bytes();
            if matches!(bytes, b"." | b"..") {
                continue;
            }
            if names.len() >= MAXIMUM_ENTRIES {
                return Err(refused("command_surface_package_publication_pending_limit"));
            }
            let name = std::str::from_utf8(bytes).map_err(|_| unknown())?;
            let file = File::from(
                openat(self.held.as_fd(), name, FLAGS, Mode::empty()).map_err(|_| unknown())?,
            );
            let metadata = file.metadata()?;
            if !metadata.is_file() || metadata.nlink() != 1 || metadata.len() > MAXIMUM {
                return Err(unknown());
            }
            names.push(name.to_owned());
        }
        names.sort();
        self.check()?;
        Ok(names)
    }
    fn reconcile(&mut self) -> Result<(), CommandSurfaceError> {
        let names = self.collect()?;
        for name in names.iter().filter(|name| name.starts_with("gcproof-")) {
            let leaf = self.private_leaf(name, RECORD_LIMIT)?.ok_or_else(unknown)?;
            let proof: GarbageProof = serde_json::from_slice(&leaf.bytes).map_err(|_| unknown())?;
            if proof.version != 1
                || !hash_valid(&proof.sha256)
                || proof.witness.nlink != 1
                || proof.witness.uid != getuid().as_raw()
                || proof.witness.size > MAXIMUM
                || !id_valid(&proof.id)
                || *name != format!("gcproof-{}.json", proof.id)
                || !artifact_name(&proof.source)
            {
                return Err(unknown());
            }
            self.finish_garbage(&proof, &leaf)?;
        }
        let names = self.collect()?;
        for name in names.iter().filter(|name| name.starts_with("done-")) {
            let done = self.private_leaf(name, RECORD_LIMIT)?.ok_or_else(unknown)?;
            let completion: Completion =
                serde_json::from_slice(&done.bytes).map_err(|_| unknown())?;
            let published = completion.kind == "ordinary_package_publication_complete";
            let intent = completion.intent;
            if completion.version != 1
                || ![
                    "ordinary_package_publication_complete",
                    "ordinary_package_prepared_abandoned",
                ]
                .contains(&completion.kind.as_str())
                || !intent_valid(&intent)
                || *name != format!("done-{}.json", intent.id)
            {
                return Err(unknown());
            }
            let intent_name = format!("intent-{}.json", intent.id);
            if let Some(observed) = self.private_leaf(&intent_name, RECORD_LIMIT)? {
                let parsed: Intent =
                    serde_json::from_slice(&observed.bytes).map_err(|_| unknown())?;
                if parsed != intent {
                    return Err(unknown());
                }
                self.clean_completed_stage(&intent, published)?;
                self.clean_completed_copies(&intent)?;
                self.garbage(&intent_name, &observed)?;
            } else {
                self.clean_completed_stage(&intent, published)?;
                self.clean_completed_copies(&intent)?;
            }
            self.garbage(name, &done)?;
            self.recovered
                .push(RecoveryClassification::CompletedCleanupFinished);
        }
        let names = self.collect()?;
        for name in names.iter().filter(|name| name.starts_with("intent-")) {
            let observed = self.private_leaf(name, RECORD_LIMIT)?.ok_or_else(unknown)?;
            let intent: Intent = serde_json::from_slice(&observed.bytes).map_err(|_| unknown())?;
            if !intent_valid(&intent) || *name != format!("intent-{}.json", intent.id) {
                return Err(unknown());
            }
            self.verify_copies(&intent)?;
            let stage_name = format!("stage-{}.json", intent.id);
            let stage = self
                .private_leaf(&stage_name, MAXIMUM)?
                .ok_or_else(unknown)?;
            if intent.replacement.renamed(&stage.metadata)
                && hash(&stage.bytes) == intent.replacement_hash
            {
                // Prepared is not permission to ignore an external package
                // change. Prove the exact preimage still occupies package.json
                // before marking this owned preparation abandoned.
                let current =
                    read_leaf(self.input.parent(), "package.json", MAXIMUM)?.ok_or_else(unknown)?;
                if Witness::new(&current.metadata) != intent.previous
                    || hash(&current.bytes) != intent.previous_hash
                {
                    return Err(unknown());
                }
                current.assert_current(self.input.parent(), "package.json")?;
                stage.assert_current(&self.held, &stage_name)?;
                self.check()?;
                let done_name = format!("done-{}.json", intent.id);
                self.record(
                    &done_name,
                    &Completion {
                        version: 1,
                        kind: "ordinary_package_prepared_abandoned".into(),
                        intent: intent.clone(),
                    },
                )?;
                phase("prepared_abandonment_durable");
                self.clean_completed_stage(&intent, false)?;
                self.clean_completed_copies(&intent)?;
                self.garbage(name, &observed)?;
                let done = self
                    .private_leaf(&done_name, RECORD_LIMIT)?
                    .ok_or_else(unknown)?;
                self.garbage(&done_name, &done)?;
                self.recovered
                    .push(RecoveryClassification::PreparedAbandonmentFinished);
                continue;
            }
            let current =
                read_leaf(self.input.parent(), "package.json", MAXIMUM)?.ok_or_else(unknown)?;
            if !intent.previous.renamed(&stage.metadata)
                || hash(&stage.bytes) != intent.previous_hash
                || !intent.replacement.renamed(&current.metadata)
                || hash(&current.bytes) != intent.replacement_hash
            {
                return Err(unknown());
            }
            stage.assert_current(&self.held, &stage_name)?;
            current.assert_current(self.input.parent(), "package.json")?;
            self.check()?;
            self.held.sync_all()?;
            self.input.parent().sync_all()?;
            self.record(
                &format!("done-{}.json", intent.id),
                &Completion {
                    version: 1,
                    kind: "ordinary_package_publication_complete".into(),
                    intent: intent.clone(),
                },
            )?;
            self.recovered
                .push(RecoveryClassification::PublishedPendingFinished);
            self.clean_completed_stage(&intent, true)?;
            self.clean_completed_copies(&intent)?;
            self.garbage(name, &observed)?;
            let done_name = format!("done-{}.json", intent.id);
            let done = self
                .private_leaf(&done_name, RECORD_LIMIT)?
                .ok_or_else(unknown)?;
            self.garbage(&done_name, &done)?;
        }
        let names = self.collect()?;
        for name in &names {
            if name == "lock" || (name == runtime::BINDING_NAME && self.binding.is_some()) {
                continue;
            }
            if let Some(id) = ["stage-", "preimage-", "replacement-"]
                .iter()
                .find_map(|prefix| name.strip_prefix(prefix))
                .and_then(|name| name.strip_suffix(".json"))
                && id_valid(id)
            {
                let _stage = self.private_leaf(name, MAXIMUM)?.ok_or_else(unknown)?;
                if !names.contains(&format!("intent-{id}.json")) {
                    self.recovered
                        .push(RecoveryClassification::IncompleteStageRetained);
                }
                continue;
            }
            if let Some(id) = name
                .strip_prefix("intent-")
                .and_then(|name| name.strip_suffix(".json"))
                && id_valid(id)
            {
                continue;
            }
            return Err(unknown());
        }
        Ok(())
    }
    fn clean_completed_stage(
        &self,
        intent: &Intent,
        published: bool,
    ) -> Result<(), CommandSurfaceError> {
        let name = format!("stage-{}.json", intent.id);
        if let Some(stage) = self.private_leaf(&name, MAXIMUM)? {
            let (witness, expected) = if published {
                (&intent.previous, &intent.previous_hash)
            } else {
                (&intent.replacement, &intent.replacement_hash)
            };
            if !witness.renamed(&stage.metadata) || hash(&stage.bytes) != *expected {
                return Err(unknown());
            }
            self.garbage(&name, &stage)?;
        }
        Ok(())
    }
    fn verify_copies(&self, intent: &Intent) -> Result<(), CommandSurfaceError> {
        for (prefix, witness, expected) in [
            ("preimage", &intent.preimage_copy, &intent.previous_hash),
            (
                "replacement",
                &intent.replacement_copy,
                &intent.replacement_hash,
            ),
        ] {
            let name = format!("{prefix}-{}.json", intent.id);
            let copy = self.private_leaf(&name, MAXIMUM)?.ok_or_else(unknown)?;
            if Witness::new(&copy.metadata) != *witness || hash(&copy.bytes) != *expected {
                return Err(unknown());
            }
        }
        Ok(())
    }
    fn clean_completed_copies(&self, intent: &Intent) -> Result<(), CommandSurfaceError> {
        for (prefix, witness, expected) in [
            ("preimage", &intent.preimage_copy, &intent.previous_hash),
            (
                "replacement",
                &intent.replacement_copy,
                &intent.replacement_hash,
            ),
        ] {
            let name = format!("{prefix}-{}.json", intent.id);
            if let Some(copy) = self.private_leaf(&name, MAXIMUM)? {
                if !witness.renamed(&copy.metadata) || hash(&copy.bytes) != *expected {
                    return Err(unknown());
                }
                self.garbage(&name, &copy)?;
            }
        }
        Ok(())
    }
    fn garbage(&self, source: &str, leaf: &Leaf) -> Result<(), CommandSurfaceError> {
        self.check()?;
        leaf.assert_current(&self.held, source)?;
        let proof = GarbageProof {
            version: 1,
            id: nonce()?,
            source: source.into(),
            witness: Witness::new(&leaf.metadata),
            sha256: hash(&leaf.bytes),
        };
        let name = format!("gcproof-{}.json", proof.id);
        self.record(&name, &proof)?;
        phase("cleanup_proof_durable");
        let observed = self
            .private_leaf(&name, RECORD_LIMIT)?
            .ok_or_else(unknown)?;
        self.finish_garbage(&proof, &observed)
    }
    fn finish_garbage(
        &self,
        proof: &GarbageProof,
        proof_leaf: &Leaf,
    ) -> Result<(), CommandSurfaceError> {
        self.check()?;
        let proof_name = format!("gcproof-{}.json", proof.id);
        proof_leaf.assert_current(&self.held, &proof_name)?;
        let target = format!("gc-{}.json", proof.id);
        let moved = match self.private_leaf(&target, MAXIMUM)? {
            Some(moved) => Some(moved),
            None => {
                if let Some(source) = self.private_leaf(&proof.source, MAXIMUM)? {
                    if !proof.witness.renamed(&source.metadata)
                        || hash(&source.bytes) != proof.sha256
                    {
                        return Err(unknown());
                    }
                    source.assert_current(&self.held, &proof.source)?;
                    self.check()?;
                    renameat2(
                        self.held.as_fd(),
                        proof.source.as_str(),
                        self.held.as_fd(),
                        target.as_str(),
                        RenameFlags::RENAME_NOREPLACE,
                    )
                    .map_err(|_| unknown())?;
                    self.held.sync_all()?;
                    phase("cleanup_entry_quarantined");
                    self.private_leaf(&target, MAXIMUM)?
                } else {
                    None
                }
            }
        };
        if let Some(moved) = moved {
            if !proof.witness.renamed(&moved.metadata) || hash(&moved.bytes) != proof.sha256 {
                return Err(unknown());
            }
            moved.assert_current(&self.held, &target)?;
            self.check()?;
            // The moved inode was checked, not merely its old shared name. A
            // mismatching replacement remains intact under the quarantine name.
            unlinkat(
                self.held.as_fd(),
                target.as_str(),
                UnlinkatFlags::NoRemoveDir,
            )
            .map_err(|_| unknown())?;
            self.held.sync_all()?;
            phase("cleanup_entry_removed");
        }
        proof_leaf.assert_current(&self.held, &proof_name)?;
        self.check()?;
        unlinkat(
            self.held.as_fd(),
            proof_name.as_str(),
            UnlinkatFlags::NoRemoveDir,
        )
        .map_err(|_| unknown())?;
        self.held.sync_all()?;
        self.check()
    }
    pub(super) fn commit(&self, bytes: &[u8]) -> Result<(), CommandSurfaceError> {
        if bytes.is_empty() || bytes.len() as u64 > MAXIMUM {
            return Err(changed());
        }
        self.check()?;
        self.input.assert_current().map_err(|_| changed())?;
        if Witness::new(&self.write_access.metadata()?) != Witness::new(&self.input.metadata) {
            return Err(changed());
        }
        if self.collect()?.len() > MAXIMUM_ENTRIES - NEW_PUBLICATION_ENTRY_RESERVE {
            return Err(refused("command_surface_package_publication_pending_limit"));
        }
        phase("source_retained");
        let id = nonce()?;
        let name = format!("stage-{id}.json");
        let preimage_name = format!("preimage-{id}.json");
        self.directory
            .write_new(&preimage_name, &self.input.bytes)
            .map_err(private_error)?;
        phase("preimage_durable");
        let mut file = File::from(
            openat(
                self.held.as_fd(),
                name.as_str(),
                OFlag::O_WRONLY
                    | OFlag::O_CREAT
                    | OFlag::O_EXCL
                    | OFlag::O_NOFOLLOW
                    | OFlag::O_CLOEXEC,
                Mode::from_bits_truncate(0o600),
            )
            .map_err(|_| changed())?,
        );
        phase("stage_created");
        use std::io::Write;
        let middle = bytes.len() / 2;
        file.write_all(&bytes[..middle])?;
        phase("stage_partial_write");
        file.write_all(&bytes[middle..])?;
        fchown(&file, None, Some(Gid::from_raw(self.input.metadata.gid())))
            .map_err(|_| changed())?;
        fchmod(
            &file,
            Mode::from_bits_truncate(self.input.metadata.mode() & 0o777),
        )
        .map_err(|_| changed())?;
        file.sync_all()?;
        self.held.sync_all()?;
        phase("stage_durable");
        let stage = self.private_leaf(&name, MAXIMUM)?.ok_or_else(changed)?;
        if stage.bytes != bytes
            || stage.metadata.uid() != self.input.metadata.uid()
            || stage.metadata.gid() != self.input.metadata.gid()
            || stage.metadata.mode() & 0o777 != self.input.metadata.mode() & 0o777
        {
            return Err(changed());
        }
        let replacement_name = format!("replacement-{id}.json");
        self.directory
            .write_new(&replacement_name, bytes)
            .map_err(private_error)?;
        let preimage_copy = self
            .private_leaf(&preimage_name, MAXIMUM)?
            .ok_or_else(changed)?;
        let replacement_copy = self
            .private_leaf(&replacement_name, MAXIMUM)?
            .ok_or_else(changed)?;
        let intent = Intent {
            version: 1,
            id: id.clone(),
            previous: Witness::new(&self.input.metadata),
            previous_hash: hash(&self.input.bytes),
            replacement: Witness::new(&stage.metadata),
            replacement_hash: hash(bytes),
            preimage_copy: Witness::new(&preimage_copy.metadata),
            replacement_copy: Witness::new(&replacement_copy.metadata),
        };
        self.record(&format!("intent-{id}.json"), &intent)?;
        phase("intent_durable");
        self.input.assert_current().map_err(|_| changed())?;
        if Witness::new(&self.write_access.metadata()?) != Witness::new(&self.input.metadata) {
            return Err(changed());
        }
        let current =
            read_leaf(self.input.parent(), "package.json", MAXIMUM)?.ok_or_else(changed)?;
        if current.bytes != self.input.bytes {
            return Err(changed());
        }
        stage.assert_current(&self.held, &name)?;
        self.check()?;
        phase("before_exchange");
        renameat2(
            self.held.as_fd(),
            name.as_str(),
            self.input.parent().as_fd(),
            "package.json",
            RenameFlags::RENAME_EXCHANGE,
        )
        .map_err(|_| unknown())?;
        phase("after_exchange");
        let published = (|| -> Result<Leaf, CommandSurfaceError> {
            let displaced = self.private_leaf(&name, MAXIMUM)?.ok_or_else(unknown)?;
            let published =
                read_leaf(self.input.parent(), "package.json", MAXIMUM)?.ok_or_else(unknown)?;
            if !intent.previous.renamed(&displaced.metadata)
                || hash(&displaced.bytes) != intent.previous_hash
                || !intent.replacement.renamed(&published.metadata)
                || hash(&published.bytes) != intent.replacement_hash
            {
                return Err(unknown());
            }
            self.check()?;
            displaced.assert_current(&self.held, &name)?;
            published.assert_current(self.input.parent(), "package.json")?;
            self.held.sync_all()?;
            self.input.parent().sync_all()?;
            phase("publication_directories_durable");
            self.record(
                &format!("done-{id}.json"),
                &Completion {
                    version: 1,
                    kind: "ordinary_package_publication_complete".into(),
                    intent: intent.clone(),
                },
            )?;
            Ok(published)
        })()
        .map_err(|_| unknown())?;
        let cleanup = (|| -> Result<(), CommandSurfaceError> {
            phase("completion_durable");
            published
                .assert_current(self.input.parent(), "package.json")
                .map_err(|_| unknown())?;
            self.clean_completed_stage(&intent, true)?;
            self.clean_completed_copies(&intent)?;
            let intent_name = format!("intent-{id}.json");
            let intent_leaf = self
                .private_leaf(&intent_name, RECORD_LIMIT)?
                .ok_or_else(unknown)?;
            self.garbage(&intent_name, &intent_leaf)?;
            let done_name = format!("done-{id}.json");
            let done = self
                .private_leaf(&done_name, RECORD_LIMIT)?
                .ok_or_else(unknown)?;
            self.garbage(&done_name, &done)?;
            self.check()?;
            published.assert_current(self.input.parent(), "package.json")?;
            Ok(())
        })();
        cleanup
            .map_err(|_| refused("command_surface_package_publication_committed_cleanup_pending"))
    }
}
fn artifact_name(name: &str) -> bool {
    ["intent-", "stage-", "done-", "preimage-", "replacement-"]
        .iter()
        .any(|prefix| {
            name.strip_prefix(prefix)
                .and_then(|name| name.strip_suffix(".json"))
                .is_some_and(id_valid)
        })
}
fn hash_valid(hash: &str) -> bool {
    hash.len() == 71
        && hash.starts_with("sha256:")
        && hash[7..]
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}
fn intent_valid(intent: &Intent) -> bool {
    intent.version == 1
        && id_valid(&intent.id)
        && [
            (&intent.previous, &intent.previous_hash),
            (&intent.replacement, &intent.replacement_hash),
        ]
        .iter()
        .all(|(witness, hash)| {
            witness.nlink == 1
                && witness.mode & 0o170000 == 0o100000
                && witness.mode & 0o7000 == 0
                && witness.size > 0
                && witness.size <= MAXIMUM
                && hash_valid(hash)
        })
        && intent.previous.uid == getuid().as_raw()
        && intent.replacement.uid == intent.previous.uid
        && intent.replacement.gid == intent.previous.gid
        && intent.replacement.mode == intent.previous.mode
        && [
            (&intent.preimage_copy, intent.previous.size),
            (&intent.replacement_copy, intent.replacement.size),
        ]
        .iter()
        .all(|(witness, size)| {
            witness.uid == intent.previous.uid
                && witness.mode & 0o177777 == 0o100600
                && witness.nlink == 1
                && witness.size == *size
        })
}
fn phase(_name: &str) {
    #[cfg(test)]
    TEST_HOOK.with(|hook| {
        // A fault callback may invoke the same ordinary owner to verify its
        // real held-lock refusal. Nested calls still execute every production
        // guard; they do not recursively invoke the already active injector.
        if let Ok(mut slot) = hook.try_borrow_mut()
            && let Some(hook) = slot.as_mut()
        {
            hook(_name);
        }
    });
}
#[cfg(test)]
type PhaseHook = Box<dyn FnMut(&str)>;
#[cfg(test)]
thread_local! {static TEST_HOOK:std::cell::RefCell<Option<PhaseHook>> = const {std::cell::RefCell::new(None)};}
#[cfg(test)]
mod tests;
