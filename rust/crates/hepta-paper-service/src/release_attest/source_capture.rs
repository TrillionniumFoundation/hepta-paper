//! Actual source observations. No caller projection or count is accepted as
//! source evidence. This owner never reads a key or writes runtime evidence.
pub(crate) mod git_binding;
mod snapshot;

use crate::operational_status::{
    OperationalStatusError, ProvenanceObservationV1, current_bounded_code_provenance_v1,
};
use hepta_codex_runtime::{
    BoundedProcessRequestV1, EnvironmentPolicyV1, ProcessLimitsV1, ProcessTerminationReason,
    RestrictedEnvironmentV1, run_bounded_process_capturing_stdout_with_cancellation,
};
use hepta_control_plane::canonical_hash_v1;
use nix::{
    fcntl::{OFlag, open, openat},
    sys::stat::Mode,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    ffi::OsString,
    fs::{self, File, Metadata},
    io::Read,
    os::{fd::AsFd, unix::fs::MetadataExt},
    path::{Component, Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
    time::Instant,
};

const MAX_FILE_BYTES: u64 = 32 * 1024 * 1024;
const MAX_OPERATION_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const MAX_ENTRIES: usize = 200_000;
const MAX_DIRECTORIES: usize = 4096;
type Result<T> = std::result::Result<T, OperationalStatusError>;
fn error(code: &str) -> OperationalStatusError {
    OperationalStatusError(format!("release_attestation_source_{code}"))
}
fn hash(bytes: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(bytes))
}
fn hex(value: &str, size: usize) -> bool {
    value.len() == size
        && value
            .bytes()
            .all(|v| v.is_ascii_digit() || (b'a'..=b'f').contains(&v))
}
fn digest(value: &str) -> bool {
    value.strip_prefix("sha256:").is_some_and(|v| hex(v, 64))
}
fn same(a: &Metadata, b: &Metadata) -> bool {
    a.dev() == b.dev()
        && a.ino() == b.ino()
        && a.mode() == b.mode()
        && a.uid() == b.uid()
        && a.gid() == b.gid()
        && a.nlink() == b.nlink()
        && a.len() == b.len()
        && a.mtime() == b.mtime()
        && a.mtime_nsec() == b.mtime_nsec()
        && a.ctime() == b.ctime()
        && a.ctime_nsec() == b.ctime_nsec()
}
fn same_directory(a: &Metadata, b: &Metadata) -> bool {
    a.is_dir()
        && b.is_dir()
        && a.dev() == b.dev()
        && a.ino() == b.ino()
        && a.mode() == b.mode()
        && a.uid() == b.uid()
        && a.gid() == b.gid()
}

/// Assertions select the subject; actual observations must independently match.
/// Only fixed Git queries run, with filters, replace refs and optional locks
/// disabled. The pinned Git file must be a root-owned executable named `git`.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReleaseAttestationSourceRequestV2 {
    pub version: u16,
    pub kind: String,
    pub workspace_root: PathBuf,
    pub git_executable: PathBuf,
    pub git_executable_sha256: String,
    pub expected_commit: String,
    pub expected_tree: String,
    pub expected_release_state_snapshot_hash: String,
    pub timeout_ms: u64,
}

struct PinnedDirectory {
    path: PathBuf,
    file: File,
    metadata: Metadata,
}
struct PinnedBytes {
    path: PathBuf,
    file: File,
    metadata: Metadata,
    bytes: Vec<u8>,
}
impl PinnedBytes {
    fn assert_current(&self) -> Result<()> {
        let named = fs::symlink_metadata(&self.path).map_err(|_| error("file_changed"))?;
        let held = self.file.metadata().map_err(|_| error("file_changed"))?;
        if !named.is_file() || !same(&named, &self.metadata) || !same(&held, &self.metadata) {
            return Err(error("file_changed"));
        }
        Ok(())
    }
}
struct Owner<'a> {
    request: &'a ReleaseAttestationSourceRequestV2,
    cancelled: &'a AtomicBool,
    started: Instant,
    environment: RestrictedEnvironmentV1,
    directories: BTreeMap<PathBuf, PinnedDirectory>,
    source_bytes: u64,
    source_entries: usize,
    tree: BTreeMap<String, git_binding::TreeEntry>,
    observed: BTreeMap<String, (u32, Option<String>)>,
    gitlink_references: BTreeMap<String, git_binding::GitlinkReference>,
    tool: PinnedBytes,
}
impl Owner<'_> {
    fn checkpoint(&self) -> Result<()> {
        if self.cancelled.load(Ordering::Acquire) {
            return Err(error("cancelled"));
        }
        if self.started.elapsed().as_millis() >= u128::from(self.request.timeout_ms) {
            return Err(error("deadline_exceeded"));
        }
        Ok(())
    }
    fn consume(&mut self, count: usize) -> Result<()> {
        self.checkpoint()?;
        self.source_bytes = self
            .source_bytes
            .checked_add(count as u64)
            .filter(|v| *v <= MAX_OPERATION_BYTES)
            .ok_or_else(|| error("read_budget_exceeded"))?;
        Ok(())
    }
    fn read_capacity(&self, requested: usize) -> Result<usize> {
        self.checkpoint()?;
        let remaining = MAX_OPERATION_BYTES.saturating_sub(self.source_bytes);
        let capacity = remaining.min(requested as u64) as usize;
        if capacity == 0 {
            return Err(error("read_budget_exceeded"));
        }
        Ok(capacity)
    }
    fn directory(&mut self, path: &Path) -> Result<File> {
        self.checkpoint()?;
        if !path.is_absolute()
            || path
                .components()
                .any(|v| !matches!(v, Component::RootDir | Component::Normal(_)))
        {
            return Err(error("path_invalid"));
        }
        let mut cursor = PathBuf::from("/");
        let mut held = File::from(
            open(
                Path::new("/"),
                OFlag::O_RDONLY | OFlag::O_DIRECTORY | OFlag::O_CLOEXEC,
                Mode::empty(),
            )
            .map_err(|_| error("directory_unreadable"))?,
        );
        for component in std::iter::once(None).chain(path.components().filter_map(|v| match v {
            Component::Normal(v) => Some(Some(v)),
            _ => None,
        })) {
            if let Some(name) = component {
                held = File::from(
                    openat(
                        held.as_fd(),
                        Path::new(name),
                        OFlag::O_RDONLY | OFlag::O_DIRECTORY | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC,
                        Mode::empty(),
                    )
                    .map_err(|_| error("directory_symlink_or_invalid"))?,
                );
                cursor.push(name);
            }
            let metadata = held.metadata().map_err(|_| error("directory_unreadable"))?;
            let named = fs::symlink_metadata(&cursor).map_err(|_| error("directory_changed"))?;
            if !same_directory(&metadata, &named) {
                return Err(error("directory_changed"));
            }
            if let Some(prior) = self.directories.get(&cursor) {
                if !same_directory(&prior.metadata, &metadata) {
                    return Err(error("directory_changed"));
                }
            } else {
                if self.directories.len() >= MAX_DIRECTORIES {
                    return Err(error("directory_budget_exceeded"));
                }
                self.directories.insert(
                    cursor.clone(),
                    PinnedDirectory {
                        path: cursor.clone(),
                        file: held
                            .try_clone()
                            .map_err(|_| error("directory_unreadable"))?,
                        metadata,
                    },
                );
            }
        }
        Ok(held)
    }
    fn open_file(&mut self, path: &Path) -> Result<File> {
        let parent = self.directory(path.parent().ok_or_else(|| error("path_invalid"))?)?;
        let leaf = path.file_name().ok_or_else(|| error("path_invalid"))?;
        let file = File::from(
            openat(
                parent.as_fd(),
                Path::new(leaf),
                OFlag::O_RDONLY | OFlag::O_NOFOLLOW | OFlag::O_NONBLOCK | OFlag::O_CLOEXEC,
                Mode::empty(),
            )
            .map_err(|_| error("file_symlink_or_unreadable"))?,
        );
        if !file
            .metadata()
            .map_err(|_| error("file_unreadable"))?
            .is_file()
        {
            return Err(error("file_not_regular"));
        }
        Ok(file)
    }
    fn read_file(&mut self, path: &Path, limit: u64) -> Result<PinnedBytes> {
        let mut file = self.open_file(path)?;
        let metadata = file.metadata().map_err(|_| error("file_unreadable"))?;
        if metadata.len() == 0 || metadata.len() > limit {
            return Err(error("file_budget_exceeded"));
        }
        let mut bytes = Vec::new();
        let mut buffer = [0; 64 * 1024];
        loop {
            self.checkpoint()?;
            let remaining = metadata.len().saturating_sub(bytes.len() as u64);
            if remaining == 0 {
                break;
            }
            let requested = self.read_capacity(remaining.min(buffer.len() as u64) as usize)?;
            let read = file
                .read(&mut buffer[..requested])
                .map_err(|_| error("file_unreadable"))?;
            if read == 0 {
                break;
            }
            if bytes.len() as u64 + read as u64 > limit {
                return Err(error("file_budget_exceeded"));
            }
            self.consume(read)?;
            bytes.extend_from_slice(&buffer[..read]);
        }
        let selected = PinnedBytes {
            path: path.into(),
            file,
            metadata,
            bytes,
        };
        selected.assert_current()?;
        if selected.bytes.len() as u64 != selected.metadata.len() {
            return Err(error("file_changed"));
        }
        Ok(selected)
    }
    fn assert_current(&self) -> Result<()> {
        self.checkpoint()?;
        self.tool.assert_current()?;
        for reference in self.gitlink_references.values() {
            reference.assert_current()?;
        }
        for prior in self.directories.values() {
            let named =
                fs::symlink_metadata(&prior.path).map_err(|_| error("directory_changed"))?;
            let held = prior
                .file
                .metadata()
                .map_err(|_| error("directory_changed"))?;
            if !same_directory(&prior.metadata, &named) || !same_directory(&prior.metadata, &held) {
                return Err(error("directory_changed"));
            }
        }
        Ok(())
    }
    fn query(&self, root: &Path, args: &[&str], stdin: Option<Vec<u8>>) -> Result<Vec<u8>> {
        self.assert_current()?;
        let remaining = self.request.timeout_ms.saturating_sub(
            self.started
                .elapsed()
                .as_millis()
                .try_into()
                .unwrap_or(u64::MAX),
        );
        if remaining == 0 {
            return Err(error("deadline_exceeded"));
        }
        let mut arguments: Vec<OsString> = [
            "--no-replace-objects",
            "-c",
            "core.fsmonitor=false",
            "-c",
            "core.ignoreStat=false",
            "-c",
            "core.filemode=true",
            "-c",
            "credential.helper=",
        ]
        .iter()
        .map(OsString::from)
        .collect();
        arguments.extend(args.iter().map(OsString::from));
        let result = run_bounded_process_capturing_stdout_with_cancellation(
            &BoundedProcessRequestV1 {
                executable: self.request.git_executable.clone(),
                arguments,
                working_directory: root.into(),
                environment: self.environment.clone(),
                stdin,
            },
            ProcessLimitsV1 {
                timeout_ms: remaining,
                termination_grace_ms: 100,
                cleanup_timeout_ms: 2000,
                maximum_stdin_bytes: 16 * 1024 * 1024,
                maximum_stdout_bytes: 64 * 1024 * 1024,
                maximum_stderr_bytes: 1024 * 1024,
                maximum_tail_bytes: 4096,
                ..ProcessLimitsV1::default()
            },
            self.cancelled,
        )
        .map_err(|_| error("git_execution_failed"))?;
        self.assert_current()?;
        if result.process.exit_code != Some(0)
            || result.process.signal.is_some()
            || result.process.termination_reason != ProcessTerminationReason::Exited
            || !result.process.process_group_cleanup_verified
        {
            return Err(error(match result.process.termination_reason {
                ProcessTerminationReason::Cancelled => "cancelled",
                ProcessTerminationReason::TimedOut => "deadline_exceeded",
                _ => "git_observation_failed",
            }));
        }
        Ok(result.stdout)
    }
}
impl git_binding::GitTreeObservationV1 for Owner<'_> {
    fn workspace_root(&self) -> &Path {
        &self.request.workspace_root
    }
    fn expected_commit(&self) -> &str {
        &self.request.expected_commit
    }
    fn expected_tree(&self) -> &str {
        &self.request.expected_tree
    }
    fn query(&self, root: &Path, args: &[&str], stdin: Option<Vec<u8>>) -> Result<Vec<u8>> {
        Owner::query(self, root, args, stdin)
    }
    fn consume(&mut self, bytes: usize) -> Result<()> {
        Owner::consume(self, bytes)
    }
}
impl ProvenanceObservationV1 for Owner<'_> {
    fn git(&mut self, root: &Path, _: &str, args: &[&str], empty: bool) -> Result<Vec<u8>> {
        let bytes = self.query(root, args, None)?;
        if !empty && bytes.is_empty() {
            return Err(error("git_output_required"));
        }
        Ok(bytes)
    }
    fn checkpoint(&mut self) -> Result<()> {
        Owner::checkpoint(self)
    }
    fn source_entry(&mut self, root: &Path, relative: &str) -> Result<()> {
        self.source_entries += 1;
        if self.source_entries > MAX_ENTRIES {
            return Err(error("entry_budget_exceeded"));
        }
        if !self.tree.contains_key(relative) {
            return Err(error("untracked_source"));
        }
        self.directory(
            root.join(relative)
                .parent()
                .ok_or_else(|| error("path_invalid"))?,
        )?;
        Ok(())
    }
    fn file_size(&mut self, size: u64) -> Result<()> {
        self.checkpoint()?;
        if size > MAX_FILE_BYTES {
            Err(error("file_budget_exceeded"))
        } else {
            Ok(())
        }
    }
    fn consume(&mut self, bytes: usize) -> Result<()> {
        Owner::consume(self, bytes)
    }
    fn read_capacity(&mut self, requested: usize) -> Result<usize> {
        Owner::read_capacity(self, requested)
    }
    fn open_regular(&mut self, root: &Path, relative: &str) -> Result<File> {
        self.open_file(&root.join(relative))
    }
    fn payload(&mut self, relative: &str, mode: Option<u32>, bytes: Option<&[u8]>) -> Result<()> {
        self.checkpoint()?;
        let expected = self
            .tree
            .get(relative)
            .ok_or_else(|| error("tree_binding_invalid"))?;
        if expected.mode == 0o160000 {
            if mode.is_none() {
                return Err(error("tracked_source_missing"));
            }
            if bytes.is_some() || mode != Some(0o40000) {
                return Err(error("tracked_mode_mismatch"));
            }
            if let Some(prior) = self.gitlink_references.get(relative) {
                prior.assert_current()?;
            } else {
                let reference = git_binding::GitlinkReference::capture(
                    &self.request.workspace_root,
                    relative,
                    expected,
                )?;
                self.gitlink_references.insert(relative.into(), reference);
            }
            self.observed.insert(relative.into(), (0o160000, None));
            return Ok(());
        }
        let mode = mode.ok_or_else(|| error("tracked_source_missing"))?;
        if mode != expected.mode {
            return Err(error("tracked_mode_mismatch"));
        }
        self.observed
            .insert(relative.into(), (mode, bytes.map(hash)));
        Ok(())
    }
}

pub fn inspect_release_attestation_source_v2(
    request: ReleaseAttestationSourceRequestV2,
) -> Result<Value> {
    inspect_release_attestation_source_with_cancellation_v2(request, &AtomicBool::new(false))
}
/// Cancellation uses the existing bounded process owner. The source budget
/// covers every regular read, including each repeated provenance observation.
pub fn inspect_release_attestation_source_with_cancellation_v2(
    request: ReleaseAttestationSourceRequestV2,
    cancelled: &AtomicBool,
) -> Result<Value> {
    if request.version != 2
        || request.kind != "ReleaseAttestationSourceRequest"
        || !hex(&request.expected_commit, 40)
        || !hex(&request.expected_tree, 40)
        || !digest(&request.expected_release_state_snapshot_hash)
        || !digest(&request.git_executable_sha256)
        || !(1..=600_000).contains(&request.timeout_ms)
        || !request.workspace_root.is_absolute()
        || !request.git_executable.is_absolute()
    {
        return Err(error("request_invalid"));
    }
    // No ambient credentials, release override, Git redirection, hooks or
    // launcher classification reaches the fixed read-only observations.
    let environment = EnvironmentPolicyV1::new(
        "release-source-fixed-git-v2",
        [
            "PATH",
            "LANG",
            "LC_ALL",
            "GIT_OPTIONAL_LOCKS",
            "GIT_NO_REPLACE_OBJECTS",
            "GIT_CONFIG_NOSYSTEM",
            "GIT_CONFIG_GLOBAL",
            "GIT_NO_LAZY_FETCH",
            "GIT_TERMINAL_PROMPT",
        ],
        ["PATH", "LANG", "LC_ALL"],
    )
    .map_err(|_| error("environment_invalid"))?
    .build(
        std::iter::empty::<(OsString, OsString)>(),
        &BTreeMap::from(
            [
                ("PATH", "/usr/bin:/bin"),
                ("LANG", "C.UTF-8"),
                ("LC_ALL", "C.UTF-8"),
                ("GIT_OPTIONAL_LOCKS", "0"),
                ("GIT_NO_REPLACE_OBJECTS", "1"),
                ("GIT_CONFIG_NOSYSTEM", "1"),
                ("GIT_CONFIG_GLOBAL", "/dev/null"),
                ("GIT_NO_LAZY_FETCH", "1"),
                ("GIT_TERMINAL_PROMPT", "0"),
            ]
            .map(|(key, value)| (key.to_owned(), value.to_owned())),
        ),
    )
    .map_err(|_| error("environment_invalid"))?;
    // Bootstrap the root-owned Git observation without reading source first.
    let tool_file = File::from(
        open(
            request.git_executable.as_path(),
            OFlag::O_RDONLY | OFlag::O_NOFOLLOW | OFlag::O_NONBLOCK | OFlag::O_CLOEXEC,
            Mode::empty(),
        )
        .map_err(|_| error("git_executable_invalid"))?,
    );
    let tool_meta = tool_file
        .metadata()
        .map_err(|_| error("git_executable_invalid"))?;
    if !tool_meta.is_file()
        || tool_meta.uid() != 0
        || tool_meta.mode() & 0o111 == 0
        || tool_meta.mode() & 0o022 != 0
        || request
            .git_executable
            .file_name()
            .is_none_or(|v| v != "git")
        || tool_meta.len() > MAX_FILE_BYTES
    {
        return Err(error("git_executable_invalid"));
    }
    let mut owner = Owner {
        request: &request,
        cancelled,
        started: Instant::now(),
        environment,
        directories: BTreeMap::new(),
        source_bytes: 0,
        source_entries: 0,
        tree: BTreeMap::new(),
        observed: BTreeMap::new(),
        gitlink_references: BTreeMap::new(),
        tool: PinnedBytes {
            path: request.git_executable.clone(),
            file: tool_file,
            metadata: tool_meta,
            bytes: Vec::new(),
        },
    };
    owner.directory(&request.workspace_root)?;
    if fs::canonicalize(&request.workspace_root)
        .map_err(|_| error("workspace_invalid"))?
        .as_os_str()
        != request.workspace_root.as_os_str()
    {
        return Err(error("workspace_invalid"));
    }
    if fs::canonicalize(&request.git_executable)
        .map_err(|_| error("git_executable_invalid"))?
        .as_os_str()
        != request.git_executable.as_os_str()
    {
        return Err(error("git_executable_invalid"));
    }
    let actual_tool = owner.read_file(&request.git_executable, MAX_FILE_BYTES)?;
    if hash(&actual_tool.bytes) != request.git_executable_sha256
        || !actual_tool.bytes.starts_with(b"\x7fELF")
    {
        return Err(error("git_executable_pin_mismatch"));
    }
    owner.tool = actual_tool;
    owner.tree = git_binding::capture_tree(&owner)?;
    git_binding::assert_object_integrity(&owner)?;
    let before = current_bounded_code_provenance_v1(&request.workspace_root, &mut owner)?;
    let selected_tree = owner.tree.clone();
    let actual_payloads = owner.observed.clone();
    git_binding::assert_blob_binding(&mut owner, &selected_tree, &actual_payloads)?;
    let snapshot_before = snapshot::capture(&mut owner)?;
    let snapshot_after = snapshot::capture(&mut owner)?;
    let after = current_bounded_code_provenance_v1(&request.workspace_root, &mut owner)?;
    let selected_tree = owner.tree.clone();
    let actual_payloads = owner.observed.clone();
    git_binding::assert_blob_binding(&mut owner, &selected_tree, &actual_payloads)?;
    if before != after || snapshot_before.value != snapshot_after.value {
        return Err(error("changed_during_capture"));
    }
    git_binding::assert_object_integrity(&owner)?;
    snapshot_before.assert_current()?;
    snapshot_after.assert_current()?;
    owner.assert_current()?;
    if after["commit"] != request.expected_commit
        || after["commitTree"] != request.expected_tree
        || after["treeDirty"] != false
    {
        return Err(error("subject_mismatch_or_dirty"));
    }
    if snapshot_after.value["workspaceReleaseStateSnapshotHash"]
        != request.expected_release_state_snapshot_hash
    {
        return Err(error("snapshot_pin_mismatch"));
    }
    let implementation_blockers: Vec<_> = super::implementation_blockers()
        .into_iter()
        .filter(|v| {
            !matches!(
                *v,
                "release_attestation_release_provenance_capture_not_implemented"
                    | "release_attestation_release_snapshot_binding_not_implemented"
            )
        })
        .collect();
    let external = super::external_qualification_blockers();
    let mut blockers: Vec<_> = implementation_blockers
        .iter()
        .chain(external.iter())
        .map(|v| v.to_string())
        .collect();
    if snapshot_after.value["releaseState"]["ok"] != true
        || snapshot_after.value["releaseState"]["state"] != "release_ready"
    {
        blockers.push("release_attestation_release_state_not_ready".into());
    }
    blockers.push("release_attestation_current_signed_capability_evidence_not_observed".into());
    blockers.sort();
    blockers.dedup();
    let mut report = json!({
        "version":2,"kind":"ReleaseAttestationSourceInspection","status":"release_attestation_blocked",
        "sourceBound":true,"nativeSourceCapture":{"verified":true,"releaseSnapshotBindingVerified":true,"codeProvenance":after,"releaseStateSnapshot":snapshot_after.value,"gitExecutable":request.git_executable,"gitExecutableSha256":request.git_executable_sha256,"treeBlobAndModeBindingVerified":true,"gitObjectIntegrityVerified":true,"indexFlagsVerified":true,"replaceRefsAbsent":true},
        "observationScope":"actual_git_and_source_bytes_with_cooperative_before_after_consistency",
        "releaseStateObservationScope":"actual_fixed_workspace_documents_and_git_tags",
        "releaseTrustGateObservationScope":"current_signed_capability_evidence_not_observed",
        "sourceResourceLimits":{"perFileBytes":MAX_FILE_BYTES,"operationBytes":MAX_OPERATION_BYTES,"entries":MAX_ENTRIES,"directories":MAX_DIRECTORIES,"timeoutMs":request.timeout_ms,"gitStdoutBytesPerCommand":64*1024*1024,"gitStderrBytesPerCommand":1024*1024},"sourceReadBytes":owner.source_bytes,"sourceEntryObservations":owner.source_entries,"operationByteBudgetScope":"actual_regular_fd_reads_and_selected_tree_blob_responses_including_repeated_observations",
        "gitlinkReferenceProfile":git_binding::GITLINK_REFERENCE_PROFILE,
        "gitlinkReferences":owner.gitlink_references.values().map(git_binding::GitlinkReference::value).collect::<Vec<_>>(),
        "gitlinkObservationScope":"selected_tree_and_index_commits_with_held_empty_directories_only_without_nested_source_bytes;absent_leaves_remain_dirty_diagnostic_or_refused",
        "implementationBlockers":implementation_blockers,"externalQualificationBlockers":external,"blockers":blockers,
        "technicalLocalChecksReady":false,"releaseEvidenceReady":false,"signingKeyRead":false,"runtimeEvidenceWritten":false,"physicalDeletionAllowed":false,"nodeRetirement":false,"externalActionPerformed":false
    });
    report["reportHash"] = json!(
        canonical_hash_v1(
            &json!({"kind":"ReleaseAttestationSourceInspection","value":report.clone()})
        )
        .map_err(|_| error("report_hash_failed"))?
        .to_string()
    );
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicU64;
    static NEXT: AtomicU64 = AtomicU64::new(0);

    #[test]
    fn bounded_reads_and_retained_descriptors_refuse_budget_and_identical_byte_replacement() {
        let parent = std::env::var_os("HEPTA_RELEASE_SOURCE_TEST_ROOT")
            .map(PathBuf::from)
            .unwrap_or_else(std::env::temp_dir);
        fs::create_dir_all(&parent).unwrap();
        let root = parent.join(format!(
            "hepta-release-held-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(root.join("documents")).unwrap();
        let file = root.join("documents/state.json");
        fs::write(&file, b"{\"state\":\"original\"}").unwrap();
        let request = ReleaseAttestationSourceRequestV2 {
            version: 2,
            kind: "ReleaseAttestationSourceRequest".into(),
            workspace_root: root.clone(),
            git_executable: "/usr/bin/git".into(),
            git_executable_sha256: format!("sha256:{}", "a".repeat(64)),
            expected_commit: "a".repeat(40),
            expected_tree: "b".repeat(40),
            expected_release_state_snapshot_hash: format!("sha256:{}", "c".repeat(64)),
            timeout_ms: 30_000,
        };
        let tool = File::open("/usr/bin/git").unwrap();
        let metadata = tool.metadata().unwrap();
        let cancelled = AtomicBool::new(false);
        let environment =
            EnvironmentPolicyV1::new("private-source-guard-test-v1", ["PATH"], ["PATH"])
                .unwrap()
                .build(
                    std::iter::empty::<(OsString, OsString)>(),
                    &BTreeMap::from([("PATH".into(), "/usr/bin:/bin".into())]),
                )
                .unwrap();
        let mut owner = Owner {
            request: &request,
            cancelled: &cancelled,
            started: Instant::now(),
            environment,
            directories: BTreeMap::new(),
            source_bytes: 0,
            source_entries: 0,
            tree: BTreeMap::new(),
            observed: BTreeMap::new(),
            gitlink_references: BTreeMap::new(),
            tool: PinnedBytes {
                path: "/usr/bin/git".into(),
                file: tool,
                metadata,
                bytes: Vec::new(),
            },
        };
        owner.source_bytes = MAX_OPERATION_BYTES - 1;
        let failure = owner.read_file(&file, 1024).err().unwrap();
        assert!(failure.0.ends_with("read_budget_exceeded"));
        assert_eq!(owner.source_bytes, MAX_OPERATION_BYTES);
        owner.source_bytes = 0;
        let captured = owner.read_file(&file, 1024).unwrap();
        fs::write(root.join("documents/replacement.json"), &captured.bytes).unwrap();
        fs::rename(root.join("documents/replacement.json"), &file).unwrap();
        assert!(captured.assert_current().is_err());
        let captured = owner.read_file(&file, 1024).unwrap();
        fs::rename(root.join("documents"), root.join("old-documents")).unwrap();
        fs::create_dir(root.join("documents")).unwrap();
        fs::write(&file, &captured.bytes).unwrap();
        assert!(captured.assert_current().is_err());
        assert!(owner.assert_current().is_err());
        drop(owner);
        drop(captured);
        fs::remove_dir_all(root).unwrap();
    }
}
