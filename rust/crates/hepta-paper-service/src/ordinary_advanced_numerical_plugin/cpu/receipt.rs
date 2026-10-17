//! CPU/bubblewrap receipt values over observations retained by the execution owner.
//! This module reads no files, launches no process and creates no execution permit.
use super::{Json, check, hash, object, text};
use hepta_legacy_compatibility::{
    ProductionCollationV1, ProductionJsonEncodingLimitsV1, production_json_resources_v1,
};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, sync::atomic::AtomicBool, time::Instant};

pub(super) struct Invocation<'a> {
    pub process_invocation_id: &'a str,
    pub executable_target: &'a str,
    pub arguments: &'a [String],
    pub working_directory: &'a str,
    pub source_merkle_hash: &'a str,
    pub source_manifest_hash: &'a str,
    pub standard_input: Option<&'a [u8]>,
}
pub(super) struct ProcessResult<'a> {
    pub launcher_pid: Option<f64>,
    pub exit_code: Option<i32>,
    pub signal: Option<&'a str>,
    pub stdout: &'a str,
    pub stderr: &'a str,
    pub error_message: Option<&'a str>,
    pub errored: bool,
    pub aborted: bool,
    pub timed_out: bool,
}
pub(super) struct SourceSnapshots<'a> {
    pub merkle_before: &'a str,
    pub merkle_after: Option<&'a str>,
    pub manifest_before: &'a str,
    pub manifest_after: Option<&'a str>,
    pub work_merkle: &'a str,
    pub work_manifest: &'a str,
    pub expected_merkle: Option<&'a str>,
    pub expected_manifest: Option<&'a str>,
    pub after_blockers: &'a [String],
}
pub(super) struct Runtime<'a> {
    pub identity_type: Option<&'a str>,
    pub identity_hash: Option<&'a str>,
    pub executable_hash: Option<&'a str>,
    pub executable_hash_after: Option<&'a str>,
    pub invocation_name: Option<&'a str>,
    pub invocation_path: Option<&'a str>,
    pub overlay_target: Option<&'a str>,
}
pub(super) struct Artifact<'a> {
    pub path: &'a str,
    pub sha256: &'a str,
    pub bytes: u64,
}
pub(super) struct Limits {
    pub timeout_ms: u64,
    pub memory_bytes: u64,
    pub cpu_seconds: u64,
    pub maximum_pids: u64,
    pub maximum_output_bytes: u64,
    pub maximum_captured_bytes: u64,
}
// These are actual caller-owned observations, not constants inferred from a hash.
pub(super) struct Isolation<'a> {
    pub network_namespace: bool,
    pub filesystem_namespace: bool,
    pub source_readonly_mount: bool,
    pub ephemeral_work_root: bool,
    pub immutable_work_root: bool,
    pub workspace_execution_snapshot: bool,
    pub readonly_runtime: bool,
    pub memory_limit: bool,
    pub cpu_limit: bool,
    pub process_limit_available: bool,
    pub process_limit_mechanism: &'a str,
}
pub(super) struct CpuObservations<'a> {
    pub invocation: Invocation<'a>,
    pub result: ProcessResult<'a>,
    pub source: SourceSnapshots<'a>,
    pub runtime: Runtime<'a>,
    pub isolation: Isolation<'a>,
    pub limits: Limits,
    pub declared_outputs: &'a [String],
    pub separate_output_root: bool,
    pub artifacts: &'a [Artifact<'a>],
    pub artifact_blockers: &'a [String],
    pub environment_binding_hash: &'a str,
    pub environment_bom: &'a Json,
    pub environment_bom_hash: &'a str,
    pub permitted_environment: &'a [(String, String)],
    pub dataset_authorization_set_hash: &'a str,
    // Exactly the incumbent's testDependencies === null observation. This is
    // runtime provenance only; it grants no scientific/release authority.
    pub production_evidence_eligible: bool,
}
fn optional(s: Option<&str>) -> Json {
    s.map_or(Json::Null, text)
}
fn truthy_optional(s: Option<&str>) -> Json {
    optional(s.filter(|s| !s.is_empty()))
}
fn expected(s: Option<&str>) -> Json {
    s.filter(|s| !s.is_empty())
        .map_or(Json::Null, |s| text(&s.to_lowercase()))
}
fn strings(v: &[String]) -> Json {
    Json::Array(v.iter().map(|s| text(s)).collect())
}
fn append(v: &mut Json, name: &str, item: Json) -> Result<(), String> {
    let Json::Object(fields) = v else {
        return Err("cpu_worker_receipt_object_invalid".into());
    };
    fields.push((name.encode_utf16().collect(), item));
    Ok(())
}
fn digest(kind: &str, v: &Json, c: &AtomicBool, d: Instant) -> Result<Json, String> {
    check(c, d)?;
    let h = hash(kind, v, c)?;
    check(c, d)?;
    Ok(text(&h))
}
// Check borrowed source aggregates before cloning any caller JSON. The actual
// complete wire is measured again including generated field/hash overhead.
fn borrowed_inputs(o: &CpuObservations<'_>, c: &AtomicBool, d: Instant) -> Result<(), String> {
    let bound = 4 * 1024 * 1024;
    let limits = ProductionJsonEncodingLimitsV1 {
        maximum_bytes: bound,
        maximum_values: 200_000,
        maximum_utf16_units: bound,
    };
    let resources =
        production_json_resources_v1(o.environment_bom, limits, c).map_err(|e| e.to_string())?;
    check(c, d)?;
    // Reserve a conservative complete encoded projection before copying any
    // borrowed field. The bound includes generated keys, hashes, scalars and
    // object delimiters; repeated bindings/blockers can appear twice on wire.
    let generated_items = o
        .invocation
        .arguments
        .len()
        .checked_add(o.declared_outputs.len())
        .and_then(|n| n.checked_add(o.artifacts.len().checked_mul(8)?))
        .and_then(|n| n.checked_add(o.permitted_environment.len().checked_mul(4)?))
        .and_then(|n| n.checked_add(o.source.after_blockers.len().checked_mul(2)?))
        .and_then(|n| n.checked_add(o.artifact_blockers.len().checked_mul(2)?))
        .ok_or("cpu_worker_receipt_input_limit_exceeded")?;
    let generated = generated_items
        .checked_mul(128)
        .and_then(|n| n.checked_add(16 * 1024))
        .ok_or("cpu_worker_receipt_input_limit_exceeded")?;
    let mut projected_bytes = resources
        .bytes
        .checked_add(generated)
        .ok_or("cpu_worker_receipt_input_limit_exceeded")?;
    let mut units = resources.utf16_units;
    let mut values = resources.values;
    let mut add = |s: &str| -> Result<(), String> {
        check(c, d)?;
        units = units
            .checked_add(s.encode_utf16().count())
            .ok_or("cpu_worker_receipt_input_limit_exceeded")?;
        values = values
            .checked_add(1)
            .ok_or("cpu_worker_receipt_input_limit_exceeded")?;
        // Every source string has at most two retained occurrences; six
        // encoded bytes per UTF-16 unit bounds JSON escaping before allocation.
        projected_bytes = projected_bytes
            .checked_add(
                s.encode_utf16()
                    .count()
                    .checked_mul(12)
                    .ok_or("cpu_worker_receipt_input_limit_exceeded")?,
            )
            .ok_or("cpu_worker_receipt_input_limit_exceeded")?;
        if units > bound || values > 200_000 || projected_bytes > bound {
            return Err("cpu_worker_receipt_input_limit_exceeded".into());
        }
        Ok(())
    };
    for s in [
        o.invocation.process_invocation_id,
        o.invocation.executable_target,
        o.invocation.working_directory,
        o.invocation.source_merkle_hash,
        o.invocation.source_manifest_hash,
        o.result.stdout,
        o.result.stderr,
        o.source.merkle_before,
        o.source.manifest_before,
        o.source.work_merkle,
        o.source.work_manifest,
        o.isolation.process_limit_mechanism,
        o.environment_binding_hash,
        o.environment_bom_hash,
        o.dataset_authorization_set_hash,
    ] {
        add(s)?;
    }
    for s in [
        o.result.signal,
        o.result.error_message,
        o.source.merkle_after,
        o.source.manifest_after,
        o.source.expected_merkle,
        o.source.expected_manifest,
        o.runtime.identity_type,
        o.runtime.identity_hash,
        o.runtime.executable_hash,
        o.runtime.executable_hash_after,
        o.runtime.invocation_name,
        o.runtime.invocation_path,
        o.runtime.overlay_target,
    ]
    .into_iter()
    .flatten()
    {
        add(s)?;
    }
    for s in o
        .invocation
        .arguments
        .iter()
        .chain(o.declared_outputs)
        .chain(o.source.after_blockers)
        .chain(o.artifact_blockers)
    {
        add(s)?;
    }
    for a in o.artifacts {
        add(a.path)?;
        add(a.sha256)?;
    }
    for (k, v) in o.permitted_environment {
        add(k)?;
        add(v)?;
    }
    if o.invocation.standard_input.is_some_and(|b| b.len() > bound) {
        return Err("cpu_worker_receipt_input_limit_exceeded".into());
    }
    for n in [
        o.limits.timeout_ms,
        o.limits.memory_bytes,
        o.limits.cpu_seconds,
        o.limits.maximum_pids,
        o.limits.maximum_output_bytes,
        o.limits.maximum_captured_bytes,
    ]
    .into_iter()
    .chain(o.artifacts.iter().map(|a| a.bytes))
    {
        if n > 9_007_199_254_740_991 {
            return Err("cpu_worker_receipt_integer_domain_v1_unaccepted".into());
        }
    }
    check(c, d)
}
fn invocation(o: &Invocation<'_>, c: &AtomicBool, d: Instant) -> Result<Json, String> {
    check(c, d)?;
    let stdin_hash = match o.standard_input {
        None => Json::Null,
        Some(bytes) => {
            let mut h = Sha256::new();
            for chunk in bytes.chunks(64 * 1024) {
                check(c, d)?;
                h.update(chunk);
            }
            text(&format!("sha256:{:x}", h.finalize()))
        }
    };
    Ok(object([
        ("version", Json::Number(1.0)),
        ("kind", text("OsSandboxWorkerProcessInvocationBinding")),
        ("processInvocationId", text(o.process_invocation_id)),
        ("executionClass", text("host")),
        ("executableTarget", text(o.executable_target)),
        ("arguments", strings(o.arguments)),
        ("workingDirectory", text(o.working_directory)),
        ("sourceMerkleHash", text(o.source_merkle_hash)),
        ("sourceWorkspaceManifestHash", text(o.source_manifest_hash)),
        (
            "standardInput",
            object([
                ("present", Json::Bool(o.standard_input.is_some())),
                ("sha256", stdin_hash),
                (
                    "byteLength",
                    Json::Number(o.standard_input.map_or(0, <[u8]>::len) as f64),
                ),
            ]),
        ),
    ]))
}
fn empty_dataset_access(c: &AtomicBool, d: Instant) -> Result<Json, String> {
    let mut payload = object([
        ("version", Json::Number(2.0)),
        ("kind", text("DatasetRuntimeAccessReceipt")),
        ("status", text("dataset_runtime_access_not_required")),
        ("tracer", Json::Null),
        ("traceAuthority", Json::Null),
        ("readObservationAssurance", Json::Null),
        ("executionBackend", Json::Null),
        ("traceSha256", Json::Null),
        ("traceBytes", Json::Null),
        ("runtimeIdentityHash", Json::Null),
        ("environmentBindingHash", Json::Null),
        ("containerImageDigest", Json::Null),
        ("supervisor", Json::Null),
        ("datasets", Json::Array(vec![])),
        ("blockers", Json::Array(vec![])),
    ]);
    let h = digest("DatasetRuntimeAccessReceipt", &payload, c, d)?;
    append(&mut payload, "datasetRuntimeAccessReceiptHash", h)?;
    Ok(payload)
}
fn execution_bindings(o: &CpuObservations<'_>, c: &AtomicBool, d: Instant) -> Result<Json, String> {
    let collation = ProductionCollationV1::load().map_err(|e| e.to_string())?;
    let mut entries: Vec<_> = o
        .permitted_environment
        .iter()
        .filter(|(k, _)| {
            k.starts_with("HEPTA_BENCHMARK_")
                || k.starts_with("HEPTA_EXPERIMENT_")
                || [
                    "HEPTA_PRE_DATA_ACCESS_FREEZE_HASH",
                    "HEPTA_HARNESS_CELL_ID",
                    "HEPTA_DATASET_AUTHORIZATION_SET_HASH",
                    "HEPTA_DATASET_RESEARCH_COMPATIBILITY_HASH",
                    "HEPTA_SEED",
                    "PYTHONHASHSEED",
                ]
                .contains(&k.as_str())
        })
        .collect();
    // Stable sorting keeps the incumbent's localeCompare ties. Object.fromEntries
    // replaces the value of repeated keys without changing first insertion order.
    entries.sort_by(|(a, _), (b, _)| collation.compare(a, b));
    check(c, d)?;
    let mut fields: Vec<(Vec<u16>, Json)> = Vec::with_capacity(entries.len());
    let mut positions: BTreeMap<Vec<u16>, usize> = BTreeMap::new();
    for (k, v) in entries {
        check(c, d)?;
        let key: Vec<_> = k.encode_utf16().collect();
        if let Some(position) = positions.get(&key).copied() {
            fields[position].1 = text(v);
        } else {
            positions.insert(key.clone(), fields.len());
            fields.push((key, text(v)));
        }
    }
    Ok(Json::Object(fields))
}
pub(super) fn cpu_worker_receipt_v1(
    o: &CpuObservations<'_>,
    c: &AtomicBool,
    d: Instant,
) -> Result<Json, String> {
    check(c, d)?;
    borrowed_inputs(o, c, d)?;
    let result = &o.result;
    let source_mutated = !o.source.after_blockers.is_empty()
        || o.source.merkle_after != Some(o.source.merkle_before)
        || o.source.manifest_after != Some(o.source.manifest_before);
    let executable_verified = o.runtime.executable_hash.is_none()
        || o.runtime.executable_hash == o.runtime.executable_hash_after;
    let command_passed =
        result.exit_code == Some(0) && !result.errored && !result.aborted && !result.timed_out;
    let passed =
        command_passed && !source_mutated && executable_verified && o.artifact_blockers.is_empty();
    let artifacts = Json::Array(
        o.artifacts
            .iter()
            .map(|a| {
                object([
                    ("path", text(a.path)),
                    ("sha256", text(a.sha256)),
                    ("bytes", Json::Number(a.bytes as f64)),
                ])
            })
            .collect(),
    );
    let artifact_hash = digest("OsSandboxWorkerArtifactManifest", &artifacts, c, d)?;
    let identity = object([
        ("version", Json::Number(1.0)),
        ("kind", text("OsSandboxWorkerProcessIdentity")),
        (
            "processInvocationId",
            text(o.invocation.process_invocation_id),
        ),
        (
            "launcherPid",
            result
                .launcher_pid
                .filter(|n| {
                    n.is_finite() && *n > 0.0 && n.fract() == 0.0 && *n <= 9_007_199_254_740_991.0
                })
                .map_or(Json::Null, Json::Number),
        ),
    ]);
    let identity_hash = digest("OsSandboxWorkerProcessIdentity", &identity, c, d)?;
    let invocation = invocation(&o.invocation, c, d)?;
    let invocation_hash = digest("OsSandboxWorkerProcessInvocationBinding", &invocation, c, d)?;
    let limits = object([
        ("timeoutMs", Json::Number(o.limits.timeout_ms as f64)),
        ("memoryBytes", Json::Number(o.limits.memory_bytes as f64)),
        ("cpuSeconds", Json::Number(o.limits.cpu_seconds as f64)),
        ("maximumPids", Json::Number(o.limits.maximum_pids as f64)),
        (
            "maximumOutputBytes",
            Json::Number(o.limits.maximum_output_bytes as f64),
        ),
        (
            "maximumCapturedBytes",
            Json::Number(o.limits.maximum_captured_bytes as f64),
        ),
    ]);
    let isolation = object([
        (
            "kernelNetworkIsolationVerified",
            Json::Bool(o.isolation.network_namespace),
        ),
        (
            "filesystemNamespaceVerified",
            Json::Bool(o.isolation.filesystem_namespace),
        ),
        ("sourceReadOnlyVerified", Json::Bool(!source_mutated)),
        (
            "sourceReadOnlyMount",
            Json::Bool(o.isolation.source_readonly_mount),
        ),
        (
            "ephemeralWorkRootVerified",
            Json::Bool(o.isolation.ephemeral_work_root),
        ),
        (
            "immutableWorkRootVerified",
            Json::Bool(o.isolation.immutable_work_root),
        ),
        (
            "workspaceExecutionSnapshotVerified",
            Json::Bool(o.isolation.workspace_execution_snapshot),
        ),
        (
            "separateOutputRootVerified",
            Json::Bool(
                !o.separate_output_root
                    || o.declared_outputs
                        .iter()
                        .all(|p| o.artifacts.iter().any(|a| a.path == p)),
            ),
        ),
        ("hostEtcMounted", Json::Bool(false)),
        (
            "readOnlyRuntimeVerified",
            Json::Bool(o.isolation.readonly_runtime),
        ),
        (
            "runtimeExecutableSnapshotVerified",
            Json::Bool(executable_verified),
        ),
        ("immutableContainerImageVerified", Json::Bool(true)),
        ("datasetSnapshotsVerified", Json::Bool(true)),
        ("datasetManifestsVerifiedAfterExecution", Json::Bool(true)),
        ("datasetAccessSupervisorVerified", Json::Bool(true)),
        ("memoryLimitVerified", Json::Bool(o.isolation.memory_limit)),
        (
            "memoryLimitScope",
            text("process-address-space-not-descendant-tree-v1"),
        ),
        ("cpuLimitVerified", Json::Bool(o.isolation.cpu_limit)),
        (
            "cpuLimitScope",
            text("process-thread-group-not-descendant-tree-v1"),
        ),
        (
            "processLimitVerified",
            Json::Bool(o.isolation.process_limit_available),
        ),
        (
            "processLimitMechanism",
            text(o.isolation.process_limit_mechanism),
        ),
        (
            "processLimitScope",
            text("real-uid-concurrent-processes-not-sandbox-local-v1"),
        ),
        (
            "resourceLimitsVerified",
            Json::Bool(o.isolation.process_limit_available),
        ),
        ("gpuAccessRequested", Json::Bool(false)),
        ("gpuSelectorExecutionLeaseVerified", Json::Bool(true)),
        ("gpuDeviceIsolationVerified", Json::Bool(true)),
        ("gpuDeviceSelectionMechanism", text("not-required-v1")),
        ("gpuDeviceIsolationScope", text("not-required-v1")),
        ("gpuMemoryIsolationVerified", Json::Bool(false)),
        ("gpuMigIsolationVerified", Json::Bool(false)),
    ]);
    let payload = object([
        ("version", Json::Number(5.0)),
        ("kind", text("OsSandboxWorkerReceipt")),
        (
            "evidenceClass",
            text(if o.production_evidence_eligible {
                "production-runtime-observation-v1"
            } else {
                "verification-fixture-v1"
            }),
        ),
        (
            "productionEvidenceEligible",
            Json::Bool(o.production_evidence_eligible),
        ),
        ("runnerId", text("bubblewrap-kernel-isolation-worker-v4")),
        ("backend", text("bubblewrap")),
        (
            "status",
            text(if result.aborted {
                "os_sandbox_worker_cancelled"
            } else if passed {
                "os_sandbox_worker_passed"
            } else {
                "os_sandbox_worker_failed"
            }),
        ),
        (
            "exitCode",
            result
                .exit_code
                .map_or(Json::Null, |n| Json::Number(f64::from(n))),
        ),
        ("signal", truthy_optional(result.signal)),
        ("stdout", text(result.stdout)),
        (
            "stderr",
            text(if !result.stderr.is_empty() {
                result.stderr
            } else {
                result.error_message.unwrap_or("")
            }),
        ),
        ("sourceMerkleHashBefore", text(o.source.merkle_before)),
        ("sourceMerkleHashAfter", optional(o.source.merkle_after)),
        (
            "sourceWorkspaceManifestHashBefore",
            text(o.source.manifest_before),
        ),
        (
            "sourceWorkspaceManifestHashAfter",
            optional(o.source.manifest_after),
        ),
        ("workSourceMerkleHash", text(o.source.work_merkle)),
        ("workWorkspaceManifestHash", text(o.source.work_manifest)),
        (
            "expectedSourceMerkleHash",
            expected(o.source.expected_merkle),
        ),
        (
            "expectedSourceWorkspaceManifestHash",
            expected(o.source.expected_manifest),
        ),
        ("sourceMutationDetected", Json::Bool(source_mutated)),
        ("datasetMutationDetected", Json::Bool(false)),
        ("declaredOutputPaths", strings(o.declared_outputs)),
        (
            "declaredOutputsRestrictedToSeparateRoot",
            Json::Bool(o.separate_output_root),
        ),
        ("artifacts", artifacts),
        ("artifactManifestHash", artifact_hash),
        ("limits", limits),
        (
            "runtimeIdentityType",
            text(
                o.runtime
                    .identity_type
                    .filter(|s| !s.is_empty())
                    .unwrap_or("host"),
            ),
        ),
        (
            "runtimeIdentityHash",
            truthy_optional(o.runtime.identity_hash),
        ),
        (
            "runtimeExecutableSnapshotHash",
            truthy_optional(o.runtime.executable_hash),
        ),
        (
            "runtimeExecutableSnapshotHashAfter",
            optional(o.runtime.executable_hash_after),
        ),
        (
            "runtimeExecutableInvocationName",
            truthy_optional(o.runtime.invocation_name),
        ),
        (
            "runtimeExecutableInvocationPath",
            if o.runtime.executable_hash.is_some() {
                optional(o.runtime.invocation_path)
            } else {
                Json::Null
            },
        ),
        (
            "runtimeExecutableOverlayTarget",
            if o.runtime.executable_hash.is_some() {
                optional(o.runtime.overlay_target)
            } else {
                Json::Null
            },
        ),
        ("containerImage", Json::Null),
        ("containerImageDigest", Json::Null),
        ("environmentBindingHash", text(o.environment_binding_hash)),
        ("environmentBom", o.environment_bom.clone()),
        ("environmentBomHash", text(o.environment_bom_hash)),
        (
            "gpuDeviceRequest",
            object([
                ("version", Json::Number(1.0)),
                ("kind", text("GpuDeviceRequest")),
                ("required", Json::Bool(false)),
                ("deviceSelector", Json::Null),
                ("requestedDeviceCount", Json::Number(0.0)),
                ("hostDeviceObserved", Json::Null),
                ("hostDeviceEnumerationMechanism", Json::Null),
            ]),
        ),
        ("gpuSelectorExecutionLeaseBinding", Json::Null),
        ("gpuSelectorExecutionLeaseBindingHash", Json::Null),
        ("dockerWorkerContainerRecoveryReceipt", Json::Null),
        ("executionProcessIdentity", identity),
        ("executionProcessIdentityHash", identity_hash),
        ("executionProcessInvocation", invocation),
        ("executionProcessInvocationHash", invocation_hash),
        ("executionBindings", execution_bindings(o, c, d)?),
        (
            "datasetAuthorizationSetHash",
            text(o.dataset_authorization_set_hash),
        ),
        ("datasetMounts", Json::Array(vec![])),
        ("datasetAccessReceipt", empty_dataset_access(c, d)?),
        ("datasetAccessSupervisorIdentityHash", Json::Null),
        ("isolation", isolation),
        ("externalActionPerformed", Json::Bool(false)),
    ]);
    let receipt_hash = digest("OsSandboxWorkerReceipt", &payload, c, d)?;
    let Json::Object(fields) = payload else {
        return Err("cpu_worker_receipt_object_invalid".into());
    };
    let mut receipt = object([("ok", Json::Bool(passed))]);
    let Json::Object(output) = &mut receipt else {
        return Err("cpu_worker_receipt_object_invalid".into());
    };
    output.extend(fields);
    append(&mut receipt, "receiptHash", receipt_hash)?;
    let mut blockers = Vec::new();
    if result.aborted {
        blockers.push(text("os_sandbox_command_aborted"));
    }
    if result.timed_out {
        blockers.push(text("os_sandbox_command_timed_out"));
    }
    if !command_passed && !result.aborted && !result.timed_out {
        blockers.push(text("os_sandbox_command_failed"));
    }
    if source_mutated {
        blockers.push(text("source_mutation_detected"));
        blockers.extend(o.source.after_blockers.iter().map(|s| text(s)));
    }
    if !executable_verified {
        blockers.push(text(
            "worker_runtime_executable_snapshot_changed_during_execution",
        ));
    }
    blockers.extend(o.artifact_blockers.iter().map(|s| text(s)));
    append(&mut receipt, "blockers", Json::Array(blockers))?;
    production_json_resources_v1(
        &receipt,
        ProductionJsonEncodingLimitsV1 {
            maximum_bytes: 4 * 1024 * 1024,
            maximum_values: 200_000,
            maximum_utf16_units: 4 * 1024 * 1024,
        },
        c,
    )
    .map_err(|e| e.to_string())?;
    check(c, d)?;
    Ok(receipt)
}

#[cfg(test)]
mod tests;
