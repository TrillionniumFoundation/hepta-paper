use std::{
    collections::BTreeMap,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    str::FromStr,
    sync::atomic::{AtomicU64, Ordering},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use base64ct::{Base64UrlUnpadded, Encoding};
use hepta_codex_protocol::Sha256Digest;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;

use super::{
    types::{
        BoundedProcessError, BoundedProcessRequestV1, BoundedProcessResultV1, ProcessLimitsV1,
    },
    unix::{
        cleanup_after_error, resolve_kill_utility, send_group_signal, supervise_spawned_group,
        validate_request,
    },
};

const PROTOCOL_VERSION: u16 = 1;
const MAXIMUM_GATE_STOP_TIMEOUT_MS: u64 = 30_000;
const MAXIMUM_GATE_ENVELOPE_BYTES: u64 = 96 * 1024 * 1024;
const MAXIMUM_EXECUTABLE_BYTES: u64 = 512 * 1024 * 1024;
const BOOT_ID_PATH: &str = "/proc/sys/kernel/random/boot_id";
static NEXT_ENVELOPE_ID: AtomicU64 = AtomicU64::new(0);

/// Ownership mode for the gate executable. Local fixtures may use the broker UID,
/// while production requires an independently owned, non-replaceable gate path.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum GateAuthorityModeV1 {
    LocalFixtureSameOwner,
    SeparateOwnerProduction,
}

/// Policy for the broker-owned process that blocks before any target executable can start.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DurableGatePolicyV1 {
    pub version: u16,
    pub gate_executable: PathBuf,
    pub state_directory: PathBuf,
    /// Owner of the private mutable state directory and broker process.
    pub owner_uid: u32,
    /// Independent owner expected for the immutable gate executable.
    pub gate_owner_uid: u32,
    pub authority_mode: GateAuthorityModeV1,
    pub stop_timeout_ms: u64,
    pub maximum_envelope_bytes: u64,
}

impl DurableGatePolicyV1 {
    /// Local fixture policy. This mode is intentionally not production eligible.
    #[must_use]
    pub fn strict(gate_executable: PathBuf, state_directory: PathBuf, owner_uid: u32) -> Self {
        Self {
            version: PROTOCOL_VERSION,
            gate_executable,
            state_directory,
            owner_uid,
            gate_owner_uid: owner_uid,
            authority_mode: GateAuthorityModeV1::LocalFixtureSameOwner,
            stop_timeout_ms: 5_000,
            maximum_envelope_bytes: 16 * 1024 * 1024,
        }
    }

    /// Production policy with a gate executable owned outside the broker principal.
    #[must_use]
    pub fn separate_gate_authority(
        gate_executable: PathBuf,
        state_directory: PathBuf,
        owner_uid: u32,
        gate_owner_uid: u32,
    ) -> Self {
        Self {
            version: PROTOCOL_VERSION,
            gate_executable,
            state_directory,
            owner_uid,
            gate_owner_uid,
            authority_mode: GateAuthorityModeV1::SeparateOwnerProduction,
            stop_timeout_ms: 5_000,
            maximum_envelope_bytes: 16 * 1024 * 1024,
        }
    }

    #[must_use]
    pub const fn production_eligible(&self) -> bool {
        matches!(
            self.authority_mode,
            GateAuthorityModeV1::SeparateOwnerProduction
        ) && self.owner_uid != self.gate_owner_uid
    }

    fn validate(&self) -> Result<(), DurableGateError> {
        if self.version != PROTOCOL_VERSION {
            return Err(DurableGateError::UnsupportedPolicyVersion(self.version));
        }
        if self.stop_timeout_ms == 0
            || self.stop_timeout_ms > MAXIMUM_GATE_STOP_TIMEOUT_MS
            || self.maximum_envelope_bytes == 0
            || self.maximum_envelope_bytes > MAXIMUM_GATE_ENVELOPE_BYTES
        {
            return Err(DurableGateError::InvalidPolicyLimits);
        }
        inspect_private_state_directory(&self.state_directory, self.owner_uid)?;
        match self.authority_mode {
            GateAuthorityModeV1::LocalFixtureSameOwner => {
                if self.gate_owner_uid != self.owner_uid {
                    return Err(DurableGateError::GateAuthorityModeMismatch);
                }
            }
            GateAuthorityModeV1::SeparateOwnerProduction => {
                if self.gate_owner_uid == self.owner_uid {
                    return Err(DurableGateError::GateOwnerMustDiffer);
                }
                inspect_production_gate_path(&self.gate_executable, self.owner_uid)?;
            }
        }
        let gate = inspect_executable(&self.gate_executable, Some(self.gate_owner_uid), "gate")?;
        if gate.mode & 0o022 != 0 || gate.mode & 0o7000 != 0 || gate.mode & 0o100 == 0 {
            return Err(DurableGateError::GateExecutablePermissionsInvalid(
                gate.mode,
            ));
        }
        Ok(())
    }
}

/// Exact file object and content identity captured before target execution.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GateExecutableIdentityV1 {
    pub canonical_path: String,
    pub device: u64,
    pub inode: u64,
    pub mode: u32,
    pub uid: u32,
    pub gid: u32,
    pub link_count: u64,
    pub size: u64,
    pub content_hash: Sha256Digest,
}

/// Exact private control-file identity for the serialized launch envelope.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GateEnvelopeIdentityV1 {
    pub canonical_path: String,
    pub device: u64,
    pub inode: u64,
    pub mode: u32,
    pub uid: u32,
    pub gid: u32,
    pub link_count: u64,
    pub size: u64,
    pub content_hash: Sha256Digest,
}

/// Linux process identity bound to a durable `process_spawned` transition.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreExecGateIdentityV1 {
    pub version: u16,
    pub pid: u32,
    pub process_group_id: u32,
    pub session_id: u32,
    pub start_time_ticks: u64,
    pub uid: u32,
    pub boot_id_hash: Sha256Digest,
    pub gate_executable: GateExecutableIdentityV1,
    pub target_executable: GateExecutableIdentityV1,
    pub launch_envelope: GateEnvelopeIdentityV1,
    pub identity_hash: Sha256Digest,
}

impl PreExecGateIdentityV1 {
    fn build(
        process: ObservedProcessIdentity,
        gate_executable: GateExecutableIdentityV1,
        target_executable: GateExecutableIdentityV1,
        launch_envelope: GateEnvelopeIdentityV1,
    ) -> Result<Self, DurableGateError> {
        let mut value = Self {
            version: PROTOCOL_VERSION,
            pid: process.pid,
            process_group_id: process.process_group_id,
            session_id: process.session_id,
            start_time_ticks: process.start_time_ticks,
            uid: process.uid,
            boot_id_hash: process.boot_id_hash,
            gate_executable,
            target_executable,
            launch_envelope,
            identity_hash: zero_digest()?,
        };
        value.identity_hash =
            hash_serialized("HeptaPreExecGateIdentityV1", &IdentityHashView(&value))?;
        Ok(value)
    }

    /// Recomputes the identity hash after deserialization or journal loading.
    pub fn validate_hash(&self) -> Result<(), DurableGateError> {
        if self.version != PROTOCOL_VERSION {
            return Err(DurableGateError::UnsupportedIdentityVersion(self.version));
        }
        let observed = hash_serialized("HeptaPreExecGateIdentityV1", &IdentityHashView(self))?;
        if observed != self.identity_hash {
            return Err(DurableGateError::IdentityHashMismatch);
        }
        Ok(())
    }
}

struct IdentityHashView<'a>(&'a PreExecGateIdentityV1);

impl Serialize for IdentityHashView<'_> {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct View<'a> {
            version: u16,
            pid: u32,
            process_group_id: u32,
            session_id: u32,
            start_time_ticks: u64,
            uid: u32,
            boot_id_hash: &'a Sha256Digest,
            gate_executable: &'a GateExecutableIdentityV1,
            target_executable: &'a GateExecutableIdentityV1,
            launch_envelope: &'a GateEnvelopeIdentityV1,
        }
        View {
            version: self.0.version,
            pid: self.0.pid,
            process_group_id: self.0.process_group_id,
            session_id: self.0.session_id,
            start_time_ticks: self.0.start_time_ticks,
            uid: self.0.uid,
            boot_id_hash: &self.0.boot_id_hash,
            gate_executable: &self.0.gate_executable,
            target_executable: &self.0.target_executable,
            launch_envelope: &self.0.launch_envelope,
        }
        .serialize(serializer)
    }
}

/// A stopped gate whose target has not started. Dropping it kills and reaps the process group.
pub struct BlockedPreExecGateV1 {
    child: Option<Child>,
    process_id: u32,
    request: BoundedProcessRequestV1,
    limits: ProcessLimitsV1,
    kill_utility: PathBuf,
    envelope_path: PathBuf,
    identity: PreExecGateIdentityV1,
}

impl BlockedPreExecGateV1 {
    #[must_use]
    pub fn identity(&self) -> &PreExecGateIdentityV1 {
        &self.identity
    }

    /// Releases the OS stop only after the caller has durably linked and authorized `identity()`.
    pub fn release(mut self) -> Result<ReleasedPreExecGateV1, DurableGateError> {
        send_group_signal(&self.kill_utility, self.process_id, "CONT")?;
        let child = self
            .child
            .take()
            .ok_or(DurableGateError::GateChildMissing)?;
        let envelope_path = std::mem::take(&mut self.envelope_path);
        Ok(ReleasedPreExecGateV1 {
            child: Some(child),
            process_id: self.process_id,
            request: self.request.clone(),
            limits: self.limits,
            kill_utility: self.kill_utility.clone(),
            envelope_path,
            identity: self.identity.clone(),
            released_at: Instant::now(),
        })
    }

    /// Releases and immediately supervises the gate process group.
    pub fn release_and_supervise(
        self,
    ) -> Result<(PreExecGateIdentityV1, BoundedProcessResultV1), DurableGateError> {
        self.release()?.supervise()
    }

    /// Explicitly terminates a still-blocked gate. The target executable has not started.
    pub fn terminate_blocked(mut self) -> Result<PreExecGateIdentityV1, DurableGateError> {
        if let Some(mut child) = self.child.take() {
            cleanup_after_error(&mut child, &self.kill_utility, self.process_id, self.limits);
        }
        remove_bound_envelope(&self.envelope_path);
        Ok(self.identity.clone())
    }
}

/// A released gate whose target may have started and therefore requires conservative recovery.
pub struct ReleasedPreExecGateV1 {
    child: Option<Child>,
    process_id: u32,
    request: BoundedProcessRequestV1,
    limits: ProcessLimitsV1,
    kill_utility: PathBuf,
    envelope_path: PathBuf,
    identity: PreExecGateIdentityV1,
    released_at: Instant,
}

impl ReleasedPreExecGateV1 {
    #[must_use]
    pub fn identity(&self) -> &PreExecGateIdentityV1 {
        &self.identity
    }

    /// Runs bounded supervision after the durable release record has committed.
    pub fn supervise(
        mut self,
    ) -> Result<(PreExecGateIdentityV1, BoundedProcessResultV1), DurableGateError> {
        let mut child = self
            .child
            .take()
            .ok_or(DurableGateError::GateChildMissing)?;
        let mut supervisor_request = self.request.clone();
        supervisor_request.stdin = None;
        let result = supervise_spawned_group(
            &mut child,
            self.process_id,
            &supervisor_request,
            self.limits,
            &self.kill_utility,
            self.released_at,
        );
        if result.is_err() {
            cleanup_after_error(&mut child, &self.kill_utility, self.process_id, self.limits);
        }
        remove_bound_envelope(&self.envelope_path);
        Ok((self.identity.clone(), result?))
    }

    /// Reaps a child that startup reconciliation already terminated.
    pub fn reap_after_external_termination(mut self) -> Result<(), DurableGateError> {
        let mut child = self
            .child
            .take()
            .ok_or(DurableGateError::GateChildMissing)?;
        child
            .wait()
            .map_err(|error| DurableGateError::GateWait(error.kind()))?;
        remove_bound_envelope(&self.envelope_path);
        Ok(())
    }
}

impl Drop for ReleasedPreExecGateV1 {
    fn drop(&mut self) {
        if let Some(child) = self.child.as_mut() {
            cleanup_after_error(child, &self.kill_utility, self.process_id, self.limits);
        }
        remove_bound_envelope(&self.envelope_path);
    }
}

impl Drop for BlockedPreExecGateV1 {
    fn drop(&mut self) {
        if let Some(child) = self.child.as_mut() {
            cleanup_after_error(child, &self.kill_utility, self.process_id, self.limits);
        }
        remove_bound_envelope(&self.envelope_path);
    }
}

/// Spawns only the trusted gate, waits until Linux reports it stopped in a new session,
/// and returns before the requested target process exists.
pub fn spawn_blocked_preexec_gate(
    request: &BoundedProcessRequestV1,
    limits: ProcessLimitsV1,
    policy: &DurableGatePolicyV1,
) -> Result<BlockedPreExecGateV1, DurableGateError> {
    let limits = limits.validate()?;
    validate_request(request, limits)?;
    policy.validate()?;
    let target_identity = inspect_executable(&request.executable, None, "target")?;
    let gate_identity =
        inspect_executable(&policy.gate_executable, Some(policy.gate_owner_uid), "gate")?;
    let (envelope_path, envelope_identity) =
        materialize_envelope(request, &target_identity, policy)?;
    let kill_utility = resolve_kill_utility()?;

    let mut command = Command::new(&policy.gate_executable);
    command
        .arg("--envelope")
        .arg(&envelope_path)
        .arg("--expected-hash")
        .arg(envelope_identity.content_hash.as_str())
        .current_dir(&policy.state_directory)
        .env_clear()
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = command
        .spawn()
        .map_err(|error| DurableGateError::GateSpawn(error.kind()))?;
    let process_id = child.id();
    if process_id == 0 || process_id > i32::MAX as u32 {
        let _ = child.kill();
        let _ = child.wait();
        remove_bound_envelope(&envelope_path);
        return Err(DurableGateError::InvalidGateProcessId(process_id));
    }

    let stopped = wait_for_stopped_gate(
        &mut child,
        process_id,
        &policy.gate_executable,
        Duration::from_millis(policy.stop_timeout_ms),
        Duration::from_millis(limits.poll_interval_ms),
    );
    let process = match stopped {
        Ok(value) => value,
        Err(error) => {
            let _ = child.kill();
            let _ = child.wait();
            remove_bound_envelope(&envelope_path);
            return Err(error);
        }
    };
    if process.process_group_id != process_id || process.session_id != process_id {
        cleanup_after_error(&mut child, &kill_utility, process_id, limits);
        remove_bound_envelope(&envelope_path);
        return Err(DurableGateError::GateIsolationMismatch {
            pid: process_id,
            process_group_id: process.process_group_id,
            session_id: process.session_id,
        });
    }
    let identity =
        PreExecGateIdentityV1::build(process, gate_identity, target_identity, envelope_identity)?;
    Ok(BlockedPreExecGateV1 {
        child: Some(child),
        process_id,
        request: request.clone(),
        limits,
        kill_utility,
        envelope_path,
        identity,
    })
}

/// Re-observes a journaled process identity without signaling it.
pub fn observe_preexec_gate_process(
    identity: &PreExecGateIdentityV1,
) -> Result<GateProcessObservationV1, DurableGateError> {
    identity.validate_hash()?;
    let gate_path = PathBuf::from(&identity.gate_executable.canonical_path);
    match inspect_process(identity.pid, &gate_path) {
        Ok(observed) => {
            if !observed_matches_identity(&observed, identity) {
                return Ok(GateProcessObservationV1::IdentityMismatch);
            }
            if observed.stopped {
                Ok(GateProcessObservationV1::Blocked)
            } else {
                Ok(GateProcessObservationV1::ReleasedOrRunning)
            }
        }
        Err(DurableGateError::ProcessExecutableMismatch) => {
            let target_path = PathBuf::from(&identity.target_executable.canonical_path);
            match inspect_process(identity.pid, &target_path) {
                Ok(observed) if observed_matches_identity(&observed, identity) => {
                    Ok(GateProcessObservationV1::ReleasedOrRunning)
                }
                Ok(_) | Err(DurableGateError::ProcessExecutableMismatch) => {
                    Ok(GateProcessObservationV1::IdentityMismatch)
                }
                Err(DurableGateError::ProcessAbsent(_)) => observe_orphaned_target_group(identity),
                Err(error) => Err(error),
            }
        }
        Err(DurableGateError::ProcessAbsent(_)) => observe_orphaned_target_group(identity),
        Err(error) => Err(error),
    }
}

fn observed_matches_identity(
    observed: &ObservedProcessIdentity,
    identity: &PreExecGateIdentityV1,
) -> bool {
    observed.start_time_ticks == identity.start_time_ticks
        && observed.process_group_id == identity.process_group_id
        && observed.session_id == identity.session_id
        && observed.uid == identity.uid
        && observed.boot_id_hash == identity.boot_id_hash
}

fn observe_orphaned_target_group(
    identity: &PreExecGateIdentityV1,
) -> Result<GateProcessObservationV1, DurableGateError> {
    let boot_id = fs::read_to_string(BOOT_ID_PATH)
        .map_err(|error| DurableGateError::Filesystem("boot_id", error.kind()))?;
    if hash_bytes(boot_id.trim().as_bytes())? != identity.boot_id_hash {
        return Ok(GateProcessObservationV1::IdentityMismatch);
    }
    let mut live_descendant_found = false;
    for entry in fs::read_dir("/proc")
        .map_err(|error| DurableGateError::Filesystem("proc_scan", error.kind()))?
    {
        let entry =
            entry.map_err(|error| DurableGateError::Filesystem("proc_scan", error.kind()))?;
        let Some(name) = entry.file_name().to_str().map(ToOwned::to_owned) else {
            continue;
        };
        let Ok(pid) = name.parse::<u32>() else {
            continue;
        };
        let proc_root = entry.path();
        let stat = match fs::read_to_string(proc_root.join("stat")) {
            Ok(value) => value,
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::NotFound | std::io::ErrorKind::PermissionDenied
                ) =>
            {
                continue;
            }
            Err(error) => return Err(DurableGateError::Filesystem("proc_stat", error.kind())),
        };
        let close = stat
            .rfind(") ")
            .ok_or(DurableGateError::ProcessStatMalformed)?;
        let fields = stat[close + 2..].split_whitespace().collect::<Vec<_>>();
        if fields.len() <= 19 {
            continue;
        }
        let process_group_id = match fields[2].parse::<u32>() {
            Ok(value) => value,
            Err(_) => continue,
        };
        let session_id = match fields[3].parse::<u32>() {
            Ok(value) => value,
            Err(_) => continue,
        };
        if process_group_id != identity.process_group_id || session_id != identity.session_id {
            continue;
        }
        let start_time_ticks = match fields[19].parse::<u64>() {
            Ok(value) => value,
            Err(_) => continue,
        };
        let state = fields[0];
        let status = match fs::read_to_string(proc_root.join("status")) {
            Ok(value) => value,
            Err(_) => continue,
        };
        let uid = status
            .lines()
            .find_map(|line| line.strip_prefix("Uid:"))
            .and_then(|rest| rest.split_whitespace().next())
            .and_then(|value| value.parse::<u32>().ok());
        if pid == identity.pid
            || start_time_ticks < identity.start_time_ticks
            || uid != Some(identity.uid)
        {
            return Ok(GateProcessObservationV1::IdentityMismatch);
        }
        if !matches!(state, "Z" | "X" | "x") {
            // A fresh Linux session cannot be joined by an unrelated process.
            // Descendants may legitimately exec shells, compilers, or helpers, so
            // executable-path equality is not a safe recovery requirement.
            live_descendant_found = true;
        }
    }
    if live_descendant_found {
        Ok(GateProcessObservationV1::OrphanedProcessGroup)
    } else {
        Ok(GateProcessObservationV1::Absent)
    }
}

/// Terminates a journaled gate or its orphaned process group after exact identity validation.
///
/// An identity mismatch is never signaled: the caller must enter manual recovery rather than
/// risking termination of a PID or process group that has been reused by another workload.
pub fn terminate_journaled_preexec_gate(
    identity: &PreExecGateIdentityV1,
    limits: ProcessLimitsV1,
) -> Result<GateProcessObservationV1, DurableGateError> {
    let limits = limits.validate()?;
    let observation = observe_preexec_gate_process(identity)?;
    match observation {
        GateProcessObservationV1::Absent => return Ok(observation),
        GateProcessObservationV1::IdentityMismatch => {
            return Err(DurableGateError::RefusedIdentityMismatch);
        }
        GateProcessObservationV1::Blocked
        | GateProcessObservationV1::ReleasedOrRunning
        | GateProcessObservationV1::OrphanedProcessGroup => {}
    }
    let kill_utility = resolve_kill_utility()?;
    if journaled_group_has_live_members(identity)? {
        send_group_signal(&kill_utility, identity.process_group_id, "TERM")?;
        let poll = Duration::from_millis(limits.poll_interval_ms);
        let grace_deadline = Instant::now() + Duration::from_millis(limits.termination_grace_ms);
        while Instant::now() < grace_deadline && journaled_group_has_live_members(identity)? {
            thread::sleep(poll);
        }
        if journaled_group_has_live_members(identity)? {
            send_group_signal(&kill_utility, identity.process_group_id, "KILL")?;
        }
        let cleanup_deadline = Instant::now() + Duration::from_millis(limits.cleanup_timeout_ms);
        while Instant::now() < cleanup_deadline && journaled_group_has_live_members(identity)? {
            thread::sleep(poll);
        }
        if journaled_group_has_live_members(identity)? {
            return Err(DurableGateError::ProcessGroupCleanupTimeout(
                identity.process_group_id,
            ));
        }
    }
    remove_journaled_envelope(identity)?;
    Ok(observation)
}

fn remove_journaled_envelope(identity: &PreExecGateIdentityV1) -> Result<(), DurableGateError> {
    let expected = &identity.launch_envelope;
    let path = Path::new(&expected.canonical_path);
    let metadata = match fs::symlink_metadata(path) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            return Err(DurableGateError::Filesystem(
                "envelope_metadata",
                error.kind(),
            ));
        }
    };
    let canonical = fs::canonicalize(path)
        .map_err(|error| DurableGateError::Filesystem("envelope_canonical", error.kind()))?;
    if canonical != path
        || metadata.file_type().is_symlink()
        || !metadata.is_file()
        || metadata.dev() != expected.device
        || metadata.ino() != expected.inode
        || metadata.mode() & 0o7777 != expected.mode
        || metadata.uid() != expected.uid
        || metadata.gid() != expected.gid
        || metadata.nlink() != expected.link_count
        || metadata.size() != expected.size
        || hash_file(path, MAXIMUM_GATE_ENVELOPE_BYTES)? != expected.content_hash
    {
        return Err(DurableGateError::EnvelopeIdentityMismatch);
    }
    fs::remove_file(path)
        .map_err(|error| DurableGateError::Filesystem("remove_envelope", error.kind()))?;
    if let Some(parent) = path.parent() {
        File::open(parent)
            .and_then(|directory| directory.sync_all())
            .map_err(|error| DurableGateError::Filesystem("sync_envelope_parent", error.kind()))?;
    }
    Ok(())
}

/// Startup reconciliation classification for a previously journaled gate.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GateProcessObservationV1 {
    Blocked,
    ReleasedOrRunning,
    OrphanedProcessGroup,
    Absent,
    IdentityMismatch,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GateLaunchEnvelopeV1 {
    version: u16,
    target_executable: GateExecutableIdentityV1,
    arguments: Vec<String>,
    working_directory: String,
    environment: BTreeMap<String, String>,
    stdin_base64: Option<String>,
}

fn materialize_envelope(
    request: &BoundedProcessRequestV1,
    target_identity: &GateExecutableIdentityV1,
    policy: &DurableGatePolicyV1,
) -> Result<(PathBuf, GateEnvelopeIdentityV1), DurableGateError> {
    let arguments = request
        .arguments
        .iter()
        .map(|value| {
            value
                .to_str()
                .map(ToOwned::to_owned)
                .ok_or(DurableGateError::EnvelopeNonUtf8("argument"))
        })
        .collect::<Result<Vec<_>, _>>()?;
    let working_directory = request
        .working_directory
        .to_str()
        .map(ToOwned::to_owned)
        .ok_or(DurableGateError::EnvelopeNonUtf8("working_directory"))?;
    let environment = request
        .environment
        .iter()
        .map(|(key, value)| (key.to_owned(), value.to_owned()))
        .collect::<BTreeMap<_, _>>();
    let stdin_base64 = request
        .stdin
        .as_ref()
        .map(|value| Base64UrlUnpadded::encode_string(value));
    let envelope = GateLaunchEnvelopeV1 {
        version: PROTOCOL_VERSION,
        target_executable: target_identity.clone(),
        arguments,
        working_directory,
        environment,
        stdin_base64,
    };
    let bytes = serde_json::to_vec(&envelope).map_err(|_| DurableGateError::EnvelopeEncode)?;
    if u64::try_from(bytes.len()).unwrap_or(u64::MAX) > policy.maximum_envelope_bytes {
        return Err(DurableGateError::EnvelopeTooLarge);
    }
    let hash = hash_bytes(&bytes)?;
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| DurableGateError::ClockBeforeEpoch)?
        .as_nanos();
    let sequence = NEXT_ENVELOPE_ID.fetch_add(1, Ordering::Relaxed);
    let path = policy.state_directory.join(format!(
        ".hepta-gate-envelope-{}-{nonce}-{sequence}.json",
        std::process::id(),
    ));
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .mode(0o600)
        .open(&path)
        .map_err(|error| DurableGateError::Filesystem("create_envelope", error.kind()))?;
    file.write_all(&bytes)
        .map_err(|error| DurableGateError::Filesystem("write_envelope", error.kind()))?;
    file.sync_all()
        .map_err(|error| DurableGateError::Filesystem("sync_envelope", error.kind()))?;
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600))
        .map_err(|error| DurableGateError::Filesystem("chmod_envelope", error.kind()))?;
    File::open(&policy.state_directory)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| DurableGateError::Filesystem("sync_envelope_parent", error.kind()))?;
    let metadata = fs::symlink_metadata(&path)
        .map_err(|error| DurableGateError::Filesystem("envelope_metadata", error.kind()))?;
    let canonical = fs::canonicalize(&path)
        .map_err(|error| DurableGateError::Filesystem("envelope_canonical", error.kind()))?;
    if canonical != path
        || metadata.file_type().is_symlink()
        || !metadata.is_file()
        || metadata.nlink() != 1
        || metadata.uid() != policy.owner_uid
        || metadata.mode() & 0o7777 != 0o600
        || metadata.size() != u64::try_from(bytes.len()).unwrap_or(u64::MAX)
    {
        remove_bound_envelope(&path);
        return Err(DurableGateError::EnvelopeIdentityMismatch);
    }
    let canonical_path = canonical
        .to_str()
        .map(ToOwned::to_owned)
        .ok_or(DurableGateError::EnvelopeNonUtf8("envelope"))?;
    Ok((
        path,
        GateEnvelopeIdentityV1 {
            canonical_path,
            device: metadata.dev(),
            inode: metadata.ino(),
            mode: metadata.mode() & 0o7777,
            uid: metadata.uid(),
            gid: metadata.gid(),
            link_count: metadata.nlink(),
            size: metadata.size(),
            content_hash: hash,
        },
    ))
}

fn inspect_private_state_directory(path: &Path, owner_uid: u32) -> Result<(), DurableGateError> {
    if !path.is_absolute() {
        return Err(DurableGateError::StateDirectoryInvalid);
    }
    let canonical = fs::canonicalize(path)
        .map_err(|error| DurableGateError::Filesystem("state_directory", error.kind()))?;
    if canonical != path {
        return Err(DurableGateError::StateDirectoryInvalid);
    }
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| DurableGateError::Filesystem("state_directory", error.kind()))?;
    if metadata.file_type().is_symlink()
        || !metadata.is_dir()
        || metadata.uid() != owner_uid
        || metadata.mode() & 0o7777 != 0o700
    {
        return Err(DurableGateError::StateDirectoryInvalid);
    }
    Ok(())
}

fn inspect_production_gate_path(
    executable: &Path,
    broker_uid: u32,
) -> Result<(), DurableGateError> {
    let Some(mut current) = executable.parent() else {
        return Err(DurableGateError::GatePathAuthorityInvalid);
    };
    loop {
        let metadata = fs::symlink_metadata(current)
            .map_err(|error| DurableGateError::Filesystem("gate_path", error.kind()))?;
        let canonical = fs::canonicalize(current)
            .map_err(|error| DurableGateError::Filesystem("gate_path", error.kind()))?;
        let mode = metadata.mode() & 0o7777;
        if canonical != current
            || metadata.file_type().is_symlink()
            || !metadata.is_dir()
            || mode & 0o022 != 0
            || (metadata.uid() == broker_uid && mode & 0o200 != 0)
        {
            return Err(DurableGateError::GatePathAuthorityInvalid);
        }
        let Some(parent) = current.parent() else {
            break;
        };
        if parent == current {
            break;
        }
        current = parent;
    }
    Ok(())
}

fn inspect_executable(
    path: &Path,
    expected_owner: Option<u32>,
    subject: &'static str,
) -> Result<GateExecutableIdentityV1, DurableGateError> {
    if !path.is_absolute() {
        return Err(DurableGateError::ExecutableInvalid(subject));
    }
    let canonical = fs::canonicalize(path)
        .map_err(|error| DurableGateError::Filesystem(subject, error.kind()))?;
    if canonical != path {
        return Err(DurableGateError::ExecutableInvalid(subject));
    }
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| DurableGateError::Filesystem(subject, error.kind()))?;
    let mode = metadata.mode() & 0o7777;
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || metadata.nlink() != 1
        || mode & 0o7000 != 0
        || mode & 0o022 != 0
        || mode & 0o100 == 0
        || expected_owner.is_some_and(|owner| metadata.uid() != owner)
        || metadata.size() > MAXIMUM_EXECUTABLE_BYTES
    {
        return Err(DurableGateError::ExecutableInvalid(subject));
    }
    let content_hash = hash_file(path, MAXIMUM_EXECUTABLE_BYTES)?;
    let canonical_path = canonical
        .to_str()
        .map(ToOwned::to_owned)
        .ok_or(DurableGateError::EnvelopeNonUtf8(subject))?;
    Ok(GateExecutableIdentityV1 {
        canonical_path,
        device: metadata.dev(),
        inode: metadata.ino(),
        mode,
        uid: metadata.uid(),
        gid: metadata.gid(),
        link_count: metadata.nlink(),
        size: metadata.size(),
        content_hash,
    })
}

fn wait_for_stopped_gate(
    child: &mut Child,
    pid: u32,
    gate_path: &Path,
    timeout: Duration,
    poll: Duration,
) -> Result<ObservedProcessIdentity, DurableGateError> {
    let deadline = Instant::now() + timeout;
    loop {
        if let Some(status) = child
            .try_wait()
            .map_err(|error| DurableGateError::GateWait(error.kind()))?
        {
            return Err(DurableGateError::GateExitedBeforeStop(status.code()));
        }
        match inspect_process(pid, gate_path) {
            Ok(observed) if observed.stopped => return Ok(observed),
            Ok(_) | Err(DurableGateError::ProcessAbsent(_)) if Instant::now() < deadline => {
                thread::sleep(poll);
            }
            Ok(_) | Err(DurableGateError::ProcessAbsent(_)) => {
                return Err(DurableGateError::GateStopTimeout(pid));
            }
            Err(error) => return Err(error),
        }
    }
}

#[derive(Clone, Debug)]
struct ObservedProcessIdentity {
    pid: u32,
    process_group_id: u32,
    session_id: u32,
    start_time_ticks: u64,
    uid: u32,
    boot_id_hash: Sha256Digest,
    stopped: bool,
}

fn inspect_process(
    pid: u32,
    expected_executable: &Path,
) -> Result<ObservedProcessIdentity, DurableGateError> {
    let proc_root = PathBuf::from(format!("/proc/{pid}"));
    if !proc_root.exists() {
        return Err(DurableGateError::ProcessAbsent(pid));
    }
    let executable = match fs::canonicalize(proc_root.join("exe")) {
        Ok(value) => value,
        Err(error)
            if matches!(
                error.kind(),
                std::io::ErrorKind::NotFound | std::io::ErrorKind::PermissionDenied
            ) =>
        {
            return Err(DurableGateError::ProcessAbsent(pid));
        }
        Err(error) => return Err(DurableGateError::Filesystem("proc_exe", error.kind())),
    };
    if executable != expected_executable {
        return Err(DurableGateError::ProcessExecutableMismatch);
    }
    let stat = fs::read_to_string(proc_root.join("stat"))
        .map_err(|error| DurableGateError::Filesystem("proc_stat", error.kind()))?;
    let close = stat
        .rfind(") ")
        .ok_or(DurableGateError::ProcessStatMalformed)?;
    let fields = stat[close + 2..].split_whitespace().collect::<Vec<_>>();
    if fields.len() <= 19 {
        return Err(DurableGateError::ProcessStatMalformed);
    }
    let state = fields[0];
    let process_group_id = parse_proc_u32(fields[2])?;
    let session_id = parse_proc_u32(fields[3])?;
    let start_time_ticks = fields[19]
        .parse::<u64>()
        .map_err(|_| DurableGateError::ProcessStatMalformed)?;
    let status = fs::read_to_string(proc_root.join("status"))
        .map_err(|error| DurableGateError::Filesystem("proc_status", error.kind()))?;
    let uid = status
        .lines()
        .find_map(|line| line.strip_prefix("Uid:"))
        .and_then(|rest| rest.split_whitespace().next())
        .ok_or(DurableGateError::ProcessStatusMalformed)?
        .parse::<u32>()
        .map_err(|_| DurableGateError::ProcessStatusMalformed)?;
    let boot_id = fs::read_to_string(BOOT_ID_PATH)
        .map_err(|error| DurableGateError::Filesystem("boot_id", error.kind()))?;
    Ok(ObservedProcessIdentity {
        pid,
        process_group_id,
        session_id,
        start_time_ticks,
        uid,
        boot_id_hash: hash_bytes(boot_id.trim().as_bytes())?,
        stopped: state == "T" || state == "t",
    })
}

/// Returns whether an exact journaled process group still has a non-zombie member.
///
/// `kill -0` reports a zombie leader as alive until its parent reaps it. Startup recovery does
/// not own that parent handle, so treating zombies as live would convert successful cleanup into
/// a false timeout. This scan remains fail-closed: any member in the journaled session/group that
/// cannot be proven to be the persisted gate or target identity is rejected rather than ignored.
fn journaled_group_has_live_members(
    identity: &PreExecGateIdentityV1,
) -> Result<bool, DurableGateError> {
    identity.validate_hash()?;
    let boot_id = fs::read_to_string(BOOT_ID_PATH)
        .map_err(|error| DurableGateError::Filesystem("boot_id", error.kind()))?;
    if hash_bytes(boot_id.trim().as_bytes())? != identity.boot_id_hash {
        return Err(DurableGateError::RefusedIdentityMismatch);
    }

    let mut live_member_found = false;
    for entry in fs::read_dir("/proc")
        .map_err(|error| DurableGateError::Filesystem("proc_scan", error.kind()))?
    {
        let entry =
            entry.map_err(|error| DurableGateError::Filesystem("proc_scan", error.kind()))?;
        let Some(name) = entry.file_name().to_str().map(ToOwned::to_owned) else {
            continue;
        };
        let Ok(pid) = name.parse::<u32>() else {
            continue;
        };
        let proc_root = entry.path();
        let stat = match fs::read_to_string(proc_root.join("stat")) {
            Ok(value) => value,
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::NotFound | std::io::ErrorKind::PermissionDenied
                ) =>
            {
                continue;
            }
            Err(error) => return Err(DurableGateError::Filesystem("proc_stat", error.kind())),
        };
        let close = stat
            .rfind(") ")
            .ok_or(DurableGateError::ProcessStatMalformed)?;
        let fields = stat[close + 2..].split_whitespace().collect::<Vec<_>>();
        if fields.len() <= 19 {
            continue;
        }
        let state = fields[0];
        let process_group_id = match fields[2].parse::<u32>() {
            Ok(value) => value,
            Err(_) => continue,
        };
        let session_id = match fields[3].parse::<u32>() {
            Ok(value) => value,
            Err(_) => continue,
        };
        if process_group_id != identity.process_group_id || session_id != identity.session_id {
            continue;
        }
        let start_time_ticks = match fields[19].parse::<u64>() {
            Ok(value) => value,
            Err(_) => continue,
        };
        let status = match fs::read_to_string(proc_root.join("status")) {
            Ok(value) => value,
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::NotFound | std::io::ErrorKind::PermissionDenied
                ) =>
            {
                continue;
            }
            Err(error) => return Err(DurableGateError::Filesystem("proc_status", error.kind())),
        };
        let uid = status
            .lines()
            .find_map(|line| line.strip_prefix("Uid:"))
            .and_then(|rest| rest.split_whitespace().next())
            .and_then(|value| value.parse::<u32>().ok());
        if uid != Some(identity.uid) || start_time_ticks < identity.start_time_ticks {
            return Err(DurableGateError::RefusedIdentityMismatch);
        }

        // A zombie/dead member has no executable and cannot perform provider work. It is ignored
        // for cleanup completion, but its group/session/uid/start identity was still checked.
        if matches!(state, "Z" | "X" | "x") {
            continue;
        }
        if pid == identity.pid {
            let executable = match fs::canonicalize(proc_root.join("exe")) {
                Ok(value) => value,
                Err(error)
                    if matches!(
                        error.kind(),
                        std::io::ErrorKind::NotFound | std::io::ErrorKind::PermissionDenied
                    ) =>
                {
                    continue;
                }
                Err(error) => {
                    return Err(DurableGateError::Filesystem("proc_exe", error.kind()));
                }
            };
            if start_time_ticks != identity.start_time_ticks
                || executable != Path::new(&identity.gate_executable.canonical_path)
            {
                return Err(DurableGateError::RefusedIdentityMismatch);
            }
        }
        // The gate creates a fresh Linux session whose SID and PGID both equal
        // the persisted gate PID. Processes outside that session cannot join it.
        // Any non-leader with the exact SID/PGID, UID, and a start time no earlier
        // than the gate is therefore an operation descendant, even after the
        // target shell/toolchain has execed or spawned helper binaries.
        live_member_found = true;
    }
    Ok(live_member_found)
}

fn parse_proc_u32(value: &str) -> Result<u32, DurableGateError> {
    value
        .parse::<u32>()
        .map_err(|_| DurableGateError::ProcessStatMalformed)
}

fn hash_file(path: &Path, maximum_bytes: u64) -> Result<Sha256Digest, DurableGateError> {
    let mut file = File::open(path)
        .map_err(|error| DurableGateError::Filesystem("hash_file", error.kind()))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    let mut total = 0_u64;
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| DurableGateError::Filesystem("hash_file", error.kind()))?;
        if read == 0 {
            break;
        }
        total = total
            .checked_add(u64::try_from(read).unwrap_or(u64::MAX))
            .ok_or(DurableGateError::ExecutableTooLarge)?;
        if total > maximum_bytes {
            return Err(DurableGateError::ExecutableTooLarge);
        }
        hasher.update(&buffer[..read]);
    }
    digest_from_hasher(hasher)
}

fn hash_bytes(bytes: &[u8]) -> Result<Sha256Digest, DurableGateError> {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    digest_from_hasher(hasher)
}

fn hash_serialized<T: Serialize>(
    domain: &str,
    value: &T,
) -> Result<Sha256Digest, DurableGateError> {
    let bytes = serde_json::to_vec(value).map_err(|_| DurableGateError::EnvelopeEncode)?;
    let mut hasher = Sha256::new();
    hasher.update(
        u64::try_from(domain.len())
            .unwrap_or(u64::MAX)
            .to_be_bytes(),
    );
    hasher.update(domain.as_bytes());
    hasher.update(u64::try_from(bytes.len()).unwrap_or(u64::MAX).to_be_bytes());
    hasher.update(bytes);
    digest_from_hasher(hasher)
}

fn digest_from_hasher(hasher: Sha256) -> Result<Sha256Digest, DurableGateError> {
    Sha256Digest::from_str(&format!("sha256:{}", hex::encode(hasher.finalize())))
        .map_err(|_| DurableGateError::DigestConstruction)
}

fn zero_digest() -> Result<Sha256Digest, DurableGateError> {
    Sha256Digest::from_str(&format!("sha256:{}", "0".repeat(64)))
        .map_err(|_| DurableGateError::DigestConstruction)
}

fn remove_bound_envelope(path: &Path) {
    let _ = fs::remove_file(path);
    if let Some(parent) = path.parent() {
        let _ = File::open(parent).and_then(|directory| directory.sync_all());
    }
}

/// Gate materialization, process observation, or supervision failure.
#[derive(Debug, Error)]
pub enum DurableGateError {
    #[error("unsupported durable gate policy version: {0}")]
    UnsupportedPolicyVersion(u16),
    #[error("unsupported durable gate identity version: {0}")]
    UnsupportedIdentityVersion(u16),
    #[error("durable gate policy limits are invalid")]
    InvalidPolicyLimits,
    #[error("durable gate state directory is invalid")]
    StateDirectoryInvalid,
    #[error("{0} executable identity is invalid")]
    ExecutableInvalid(&'static str),
    #[error("gate executable permissions are invalid: {0:o}")]
    GateExecutablePermissionsInvalid(u32),
    #[error("gate authority mode and owner configuration are inconsistent")]
    GateAuthorityModeMismatch,
    #[error("production gate executable owner must differ from the broker/state owner")]
    GateOwnerMustDiffer,
    #[error("production gate path is writable or replaceable by the broker principal")]
    GatePathAuthorityInvalid,
    #[error("gate launch envelope contains non-UTF-8 {0}")]
    EnvelopeNonUtf8(&'static str),
    #[error("gate launch envelope encoding failed")]
    EnvelopeEncode,
    #[error("gate launch envelope exceeds its hard limit")]
    EnvelopeTooLarge,
    #[error("gate launch envelope identity changed or is unsafe")]
    EnvelopeIdentityMismatch,
    #[error("system clock predates the Unix epoch")]
    ClockBeforeEpoch,
    #[error("gate filesystem operation {0} failed: {1:?}")]
    Filesystem(&'static str, std::io::ErrorKind),
    #[error("gate process spawn failed: {0:?}")]
    GateSpawn(std::io::ErrorKind),
    #[error("gate process wait failed: {0:?}")]
    GateWait(std::io::ErrorKind),
    #[error("gate process id is invalid: {0}")]
    InvalidGateProcessId(u32),
    #[error("gate process exited before entering the OS stop: {0:?}")]
    GateExitedBeforeStop(Option<i32>),
    #[error("gate process did not enter the OS stop before timeout: {0}")]
    GateStopTimeout(u32),
    #[error(
        "gate process session isolation mismatch: pid={pid}, pgrp={process_group_id}, sid={session_id}"
    )]
    GateIsolationMismatch {
        pid: u32,
        process_group_id: u32,
        session_id: u32,
    },
    #[error("gate child process is missing")]
    GateChildMissing,
    #[error("journaled gate process is absent: {0}")]
    ProcessAbsent(u32),
    #[error("journaled process executable does not match the gate")]
    ProcessExecutableMismatch,
    #[error("/proc process stat is malformed")]
    ProcessStatMalformed,
    #[error("/proc process status is malformed")]
    ProcessStatusMalformed,
    #[error("gate or target executable exceeds the hard size limit")]
    ExecutableTooLarge,
    #[error("durable gate identity hash is invalid")]
    IdentityHashMismatch,
    #[error("refused to signal a process whose persisted identity no longer matches")]
    RefusedIdentityMismatch,
    #[error("journaled process group {0} did not terminate before cleanup deadline")]
    ProcessGroupCleanupTimeout(u32),
    #[error("digest construction failed")]
    DigestConstruction,
    #[error(transparent)]
    Process(#[from] BoundedProcessError),
}
