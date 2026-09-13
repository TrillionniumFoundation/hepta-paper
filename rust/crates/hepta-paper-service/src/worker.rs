use crate::{
    ObjectStoreV1, ServiceError,
    native_business::{
        NativeBusinessJobV1, execute_native_business_for_capability_v1,
        native_business_implementation_hash_v1,
    },
};
use base64ct::{Base64, Encoding};
use hepta_codex_protocol::Sha256Digest;
use hepta_codex_runtime::{
    BoundedProcessRequestV1, EnvironmentPolicyV1, ProcessLimitsV1, ProcessTerminationReason,
    run_bounded_process,
};
use hepta_control_plane::{
    ControlPlaneError, ExecutionRequestV1, ModuleExecutorV1, canonical_hash_v1,
};
use hepta_module_platform::{PreparedResultStatusV1, PreparedResultV1};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    ffi::OsString,
    fs,
    io::Read,
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::PathBuf,
};

/// Explicit backend: native Rust or a pinned process, never a silent fallback.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum WorkerBindingV1 {
    /// Linked Rust artifact inventory / native SQLite inspection implementation.
    Native,
    /// Operator-selected executable. This is process supervision, not a sandbox.
    Process {
        /// Canonical executable path and content identity.
        executable: PathBuf,
        /// Hash of exact executable bytes.
        executable_hash: Sha256Digest,
        /// Fixed arguments bound in the registry configuration hash.
        arguments: Vec<String>,
        /// Exact script/source closure, checked before and after execution.
        /// Required for interpreted backends; JSON arguments alone do not pin code.
        code_files: BTreeMap<PathBuf, Sha256Digest>,
        /// Private canonical workspace. No inherited credential environment.
        working_directory: PathBuf,
        /// Declared runtime; Node bridges are reported as Node, never Rust parity.
        implementation_language: String,
        /// Bounded wall-clock execution.
        timeout_ms: u64,
        /// Network declaration; this local runner does not enforce network isolation.
        network_declared: bool,
    },
}

/// Content-addressed command payload. Commands cannot choose an executable.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum NativeJobV1 {
    /// Verify every input object's bytes and produce a deterministic inventory.
    ArtifactInventory {
        /// Exact content hashes; output preserves declared ordering.
        artifacts: Vec<Sha256Digest>,
    },
    /// Inspect a real Node migration-ledger database with strict schema validation.
    InspectNodeDatabase {
        /// Canonical immutable database copy, without WAL/SHM/journal sidecars.
        path: PathBuf,
        /// SHA256 of the exact immutable SQLite bytes. Prepared replay refers to
        /// this historical input, even if the original path later disappears.
        expected_database_hash: Sha256Digest,
    },
    /// Execute one bounded first-party Rust business capability in-process.
    Business {
        /// Closed capability-specific job. It has prepared-result authority only.
        job: NativeBusinessJobV1,
    },
    /// A closed JSON request to the registered process backend.
    Process {
        /// Worker-specific bounded JSON; does not grant any production capability.
        input: Value,
    },
}

/// Closed worker output envelope, completely captured before CAS insertion.
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkerResponseV1 {
    /// Exactly one.
    pub version: u16,
    /// Base64-encoded artifacts (binary-safe), at most 256 objects.
    pub artifacts: Vec<String>,
    /// Evidence retained as bytes; not automatically scientific acceptance.
    pub evidence: Value,
    /// Any ambiguous external action prevents authoritative result integration.
    pub external_action_may_have_started: bool,
}

/// Executor with fsynced dispatch intent and prepared-result replay cache.
#[derive(Debug)]
pub struct ServiceExecutorV1 {
    objects: ObjectStoreV1,
    workers: BTreeMap<String, WorkerBindingV1>,
}

impl ServiceExecutorV1 {
    /// Build from the exact registry-bound worker table.
    pub fn new(
        objects: ObjectStoreV1,
        workers: BTreeMap<String, WorkerBindingV1>,
    ) -> Result<Self, ServiceError> {
        if workers.len() > 256 {
            return Err(ServiceError::Configuration);
        }
        Ok(Self { objects, workers })
    }

    fn execute_one(&self, request: &ExecutionRequestV1) -> Result<PreparedResultV1, ServiceError> {
        let binding = self
            .workers
            .get(&request.candidate.module_id)
            .ok_or(ServiceError::Configuration)?;
        // Admission sequence/hash change when a long-lived allocator reserves
        // the same immutable plan again. They must not create a new execution
        // identity: a retry must reuse the prepared output or stop on an
        // unresolved durable dispatch intent, never repeat provider work.
        let identity = canonical_hash_v1(&(
            "hepta-service-attempt-v1",
            request.version,
            &request.attempt_id,
            &request.snapshot_hash,
            &request.plan_hash,
            &request.candidate,
            &request.reservation.tenant_id,
            request.reservation.reserved,
            binding,
        ))
        .map_err(|_| ServiceError::Configuration)?;
        let prepared = self.objects.attempt_path(&identity, "prepared");
        if prepared.exists() {
            let bytes = read_private_record(&prepared)?;
            let result: PreparedResultV1 =
                serde_json::from_slice(&bytes).map_err(|_| ServiceError::Execution)?;
            result
                .validate(&request.candidate, &request.plan_hash)
                .map_err(|_| ServiceError::Execution)?;
            if result.attempt_id != request.attempt_id
                || result.snapshot_hash != request.snapshot_hash
            {
                return Err(ServiceError::Execution);
            }
            for hash in result
                .artifact_hashes
                .iter()
                .chain(std::iter::once(&result.evidence_hash))
            {
                self.objects.read(hash)?;
            }
            return Ok(result);
        }
        let started = self.objects.attempt_path(&identity, "started");
        if started.exists() {
            return Err(ServiceError::Execution);
        }
        let payload = self.objects.read(&request.candidate.payload_hash)?;
        let job: NativeJobV1 =
            serde_json::from_slice(&payload).map_err(|_| ServiceError::Configuration)?;
        if matches!(
            (binding, &job),
            (WorkerBindingV1::Native, NativeJobV1::Business { job })
                if job.capability_id() != request.candidate.capability_id
        ) {
            return Err(ServiceError::Configuration);
        }
        self.objects
            .record(&started, identity.to_string().as_bytes())?;
        let (mut artifacts, evidence) = match (binding, job) {
            (WorkerBindingV1::Native, NativeJobV1::ArtifactInventory { artifacts }) => {
                if artifacts.is_empty() || artifacts.len() > 256 {
                    return Err(ServiceError::Configuration);
                }
                let mut inventory = Vec::new();
                for hash in artifacts {
                    let bytes = self.objects.read(&hash)?;
                    inventory.push(json!({"hash":hash,"bytes":bytes.len()}));
                }
                let bytes = serde_json::to_vec(&json!({"version":1,"objects":inventory}))
                    .map_err(|_| ServiceError::Artifact)?;
                (
                    vec![self.objects.put(&bytes)?],
                    json!({"version":1,"verifier":"native_artifact_inventory","requestHash":identity}),
                )
            }
            (
                WorkerBindingV1::Native,
                NativeJobV1::InspectNodeDatabase {
                    path,
                    expected_database_hash,
                },
            ) => {
                let store = hepta_readonly_store::ReadOnlyStoreV1::open(&path)
                    .map_err(|_| ServiceError::Artifact)?;
                if store.database_content_hash() != &expected_database_hash {
                    return Err(ServiceError::Artifact);
                }
                let snapshot = store
                    .node_logical_snapshot()
                    .map_err(|_| ServiceError::Artifact)?;
                // The reader rehashes identity/bytes after snapshot extraction;
                // a replaced or changed input cannot become a prepared result.
                store
                    .verify_unchanged()
                    .map_err(|_| ServiceError::Artifact)?;
                let bytes = serde_json::to_vec(&snapshot).map_err(|_| ServiceError::Artifact)?;
                (
                    vec![self.objects.put(&bytes)?],
                    json!({"version":1,"verifier":"native_sqlite_inspector","requestHash":identity,
                    "databaseContentHash":expected_database_hash,"replayScope":"historical_pinned_database_input"}),
                )
            }
            (WorkerBindingV1::Native, NativeJobV1::Business { job }) => {
                let output = execute_native_business_for_capability_v1(
                    job,
                    &request.candidate.capability_id,
                )
                .map_err(|_| ServiceError::Execution)?;
                let mut hashes = Vec::with_capacity(output.artifacts.len());
                for bytes in output.artifacts {
                    hashes.push(self.objects.put(&bytes)?);
                }
                (
                    hashes,
                    json!({
                        "version": 1,
                        "requestHash": identity,
                        "verifier": "native_business_kernel",
                        "nativeBusinessImplementationHash": native_business_implementation_hash_v1(),
                        "workerEvidence": output.evidence,
                        "scope": "prepared_result_only_no_external_authority"
                    }),
                )
            }
            (WorkerBindingV1::Process { .. }, NativeJobV1::Process { input }) => {
                let response = run_process(binding, request, input)?;
                if response.version != 1
                    || response.artifacts.is_empty()
                    || response.artifacts.len() > 256
                    || response.external_action_may_have_started
                {
                    return Err(ServiceError::Execution);
                }
                let mut hashes = Vec::new();
                for encoded in response.artifacts {
                    let bytes = Base64::decode_vec(&encoded).map_err(|_| ServiceError::Artifact)?;
                    hashes.push(self.objects.put(&bytes)?);
                }
                (
                    hashes,
                    json!({"version":1,"requestHash":identity,"workerBinding":binding,"workerEvidence":response.evidence,
                    "scope":"content_integrity_not_scientific_or_production_authority"}),
                )
            }
            _ => return Err(ServiceError::Configuration),
        };
        // PreparedResultV1 is a set of content addresses; worker output order
        // and repeated identical bytes do not change the integrated artifact set.
        artifacts.sort();
        artifacts.dedup();
        let evidence = self
            .objects
            .put(&serde_json::to_vec(&evidence).map_err(|_| ServiceError::Artifact)?)?;
        let result = PreparedResultV1 {
            version: 1,
            attempt_id: request.attempt_id.clone(),
            snapshot_hash: request.snapshot_hash.clone(),
            plan_hash: request.plan_hash.clone(),
            candidate_hash: request
                .candidate
                .candidate_hash()
                .map_err(|_| ServiceError::Configuration)?,
            module_id: request.candidate.module_id.clone(),
            module_version: request.candidate.module_version.clone(),
            status: PreparedResultStatusV1::Prepared,
            artifact_hashes: artifacts,
            // Conservatively charge the admitted upper bound; no invented actual resource metering.
            actual_resources: request.candidate.resources,
            actual_cost_microusd: request.candidate.cost_microusd,
            evidence_hash: evidence,
            external_action_may_have_started: false,
        };
        self.objects.record(
            &prepared,
            &serde_json::to_vec(&result).map_err(|_| ServiceError::Artifact)?,
        )?;
        Ok(result)
    }
}

impl ModuleExecutorV1 for ServiceExecutorV1 {
    fn execute_batch(
        &mut self,
        requests: &[ExecutionRequestV1],
    ) -> Result<Vec<PreparedResultV1>, ControlPlaneError> {
        // Exact reservations remain held for the whole dependency wave. Bounded
        // sequential dispatch is conservative; parallel workers require host admission.
        requests
            .iter()
            .map(|request| {
                self.execute_one(request)
                    .map_err(|_| ControlPlaneError::ExecutionInvalid)
            })
            .collect()
    }
}

fn run_process(
    binding: &WorkerBindingV1,
    request: &ExecutionRequestV1,
    input: Value,
) -> Result<WorkerResponseV1, ServiceError> {
    let WorkerBindingV1::Process {
        executable,
        executable_hash,
        arguments,
        code_files,
        working_directory,
        timeout_ms,
        implementation_language,
        ..
    } = binding
    else {
        return Err(ServiceError::Configuration);
    };
    if *timeout_ms == 0
        || *timeout_ms > 3_600_000
        || !matches!(
            implementation_language.as_str(),
            "rust" | "node_bridge" | "python" | "r" | "lean" | "latex"
        )
    {
        return Err(ServiceError::Configuration);
    }
    if &executable_digest(executable)? != executable_hash {
        return Err(ServiceError::Configuration);
    }
    if code_files.len() > 1024 || (implementation_language != "rust" && code_files.is_empty()) {
        return Err(ServiceError::Configuration);
    }
    for (path, hash) in code_files {
        if &executable_digest(path)? != hash {
            return Err(ServiceError::Configuration);
        }
    }
    let environment = EnvironmentPolicyV1::new("service-worker-v1", ["LANG", "PATH"], ["LANG"])
        .map_err(|_| ServiceError::Configuration)?
        .build(
            std::iter::empty::<(OsString, OsString)>(),
            &BTreeMap::from([
                ("LANG".to_owned(), "C.UTF-8".to_owned()),
                ("PATH".to_owned(), "/usr/bin:/bin".to_owned()),
            ]),
        )
        .map_err(|_| ServiceError::Configuration)?;
    let stdin = serde_json::to_vec(&json!({"version":1,"execution":request,"input":input}))
        .map_err(|_| ServiceError::Configuration)?;
    let limits = ProcessLimitsV1 {
        timeout_ms: *timeout_ms,
        termination_grace_ms: 100,
        cleanup_timeout_ms: 1000,
        maximum_stdin_bytes: 1_048_576,
        maximum_stdout_bytes: 1_048_576,
        maximum_stderr_bytes: 1_048_576,
        maximum_tail_bytes: 1_048_576,
        ..ProcessLimitsV1::default()
    };
    let result = run_bounded_process(
        &BoundedProcessRequestV1 {
            executable: executable.clone(),
            arguments: arguments.iter().map(OsString::from).collect(),
            working_directory: working_directory.clone(),
            environment,
            stdin: Some(stdin),
        },
        limits,
    )
    .map_err(|_| ServiceError::Execution)?;
    if result.termination_reason != ProcessTerminationReason::Exited
        || result.exit_code != Some(0)
        || !result.process_group_cleanup_verified
        || result.stdout_truncated
        || &executable_digest(executable)? != executable_hash
    {
        return Err(ServiceError::Execution);
    }
    for (path, hash) in code_files {
        if &executable_digest(path)? != hash {
            return Err(ServiceError::Execution);
        }
    }
    serde_json::from_slice(&result.stdout_tail).map_err(|_| ServiceError::Execution)
}

/// Linked native backend identity, bound into the registry rather than chosen by a payload.
pub fn native_implementation_hash_v1() -> Result<Sha256Digest, ServiceError> {
    let mut h = Sha256::new();
    h.update(include_bytes!("worker.rs"));
    h.update(include_bytes!("objects.rs"));
    h.update(native_business_implementation_hash_v1().as_bytes());
    format!("sha256:{}", hex::encode(h.finalize()))
        .parse()
        .map_err(|_| ServiceError::Configuration)
}

fn executable_digest(path: &PathBuf) -> Result<Sha256Digest, ServiceError> {
    if !path.is_absolute() || fs::canonicalize(path).ok().as_ref() != Some(path) {
        return Err(ServiceError::Configuration);
    }
    let m = fs::symlink_metadata(path).map_err(|_| ServiceError::Filesystem)?;
    if !m.is_file() || m.mode() & 0o022 != 0 || m.len() > 256 * 1024 * 1024 {
        return Err(ServiceError::Configuration);
    }
    let mut f = fs::OpenOptions::new()
        .read(true)
        .custom_flags(nix::fcntl::OFlag::O_NOFOLLOW.bits())
        .open(path)
        .map_err(|_| ServiceError::Filesystem)?;
    let mut bytes = Vec::new();
    std::io::Read::by_ref(&mut f)
        .take(256 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| ServiceError::Filesystem)?;
    let after = f.metadata().map_err(|_| ServiceError::Filesystem)?;
    if bytes.len() as u64 != m.len()
        || m.ino() != after.ino()
        || m.dev() != after.dev()
        || m.ctime() != after.ctime()
        || m.ctime_nsec() != after.ctime_nsec()
    {
        return Err(ServiceError::Configuration);
    }
    format!("sha256:{}", hex::encode(Sha256::digest(&bytes)))
        .parse()
        .map_err(|_| ServiceError::Configuration)
}

fn read_private_record(path: &PathBuf) -> Result<Vec<u8>, ServiceError> {
    let f = fs::OpenOptions::new()
        .read(true)
        .custom_flags(nix::fcntl::OFlag::O_NOFOLLOW.bits())
        .open(path)
        .map_err(|_| ServiceError::Filesystem)?;
    let m = f.metadata().map_err(|_| ServiceError::Filesystem)?;
    if !m.is_file() || m.nlink() != 1 || m.mode() & 0o077 != 0 || m.len() > 1_048_576 {
        return Err(ServiceError::Artifact);
    }
    let mut b = Vec::new();
    f.take(1_048_577)
        .read_to_end(&mut b)
        .map_err(|_| ServiceError::Filesystem)?;
    if b.len() as u64 != m.len() {
        return Err(ServiceError::Artifact);
    }
    Ok(b)
}
