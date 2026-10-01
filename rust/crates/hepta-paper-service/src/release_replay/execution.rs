//! Actual source-bound replay over the existing process-group owner. The fixed
//! Node/Python archive oracle is an explicit differential dependency, never the
//! implementation of the Rust calculations or a release authority.
mod policy;
mod source_graph;
use super::{
    PRODUCTION_REPLAY_CORPUS_V1, REFEREE_REPLAY_CORPUS_V1, REPLAY_ORACLE_INPUT_GUARD_V1,
    evaluate_production_replay_corpus_v1, evaluate_referee_replay_corpus_v1,
};
use crate::release_attest::{
    ReleaseAttestationSourceRequestV2, inspect_release_attestation_source_with_cancellation_v2,
};
use hepta_codex_runtime::{
    BoundedProcessRequestV1, EnvironmentPolicyV1, ProcessLimitsV1, ProcessTerminationReason,
    RestrictedEnvironmentV1, run_bounded_process_capturing_stdout_with_cancellation,
};
use hepta_control_plane::canonical_hash_v1;
pub use policy::{
    ReleaseAttestationMeasuredPolicyReplayRequestV8,
    ReleaseAttestationNativeAstPolicyReplayRequestV9,
    ReleaseAttestationNativeRetirementPolicyReplayRequestV10,
    ReleaseAttestationPolicyReplayRequestV4,
    inspect_release_attestation_measured_policy_replay_with_cancellation_v8,
    inspect_release_attestation_native_ast_policy_replay_with_cancellation_v9,
    inspect_release_attestation_native_retirement_policy_replay_with_cancellation_v10,
    inspect_release_attestation_policy_replay_v4,
    inspect_release_attestation_policy_replay_with_cancellation_v4,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use source_graph::SourceGraph;
use std::{
    collections::BTreeMap,
    ffi::OsString,
    fs::{self, File, OpenOptions},
    io::{Read, Seek},
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::{Component, Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
    time::Instant,
};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReleaseAttestationReplayRequestV3 {
    pub version: u16,
    pub kind: String,
    pub source: ReleaseAttestationSourceRequestV2,
    pub node_executable: PathBuf,
    pub node_executable_sha256: String,
    pub timeout_ms: u64,
}
fn error(suffix: &str) -> String {
    format!("release_attestation_replay_{suffix}")
}
fn digest(bytes: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(bytes))
}
fn same(a: &fs::Metadata, b: &fs::Metadata) -> bool {
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
struct Tool {
    selected: PathBuf,
    path: PathBuf,
    file: File,
    metadata: fs::Metadata,
    sha256: String,
}
struct Owner<'a> {
    request: &'a ReleaseAttestationReplayRequestV3,
    cancelled: &'a AtomicBool,
    started: Instant,
    environment: RestrictedEnvironmentV1,
    read_bytes: u64,
}
impl Owner<'_> {
    fn remaining(&self) -> Result<u64, String> {
        if self.cancelled.load(Ordering::Acquire) {
            return Err(error("cancelled"));
        }
        let elapsed = u64::try_from(self.started.elapsed().as_millis()).unwrap_or(u64::MAX);
        let remaining = self.request.timeout_ms.saturating_sub(elapsed);
        if remaining == 0 {
            Err(error("deadline_exceeded"))
        } else {
            Ok(remaining)
        }
    }
    fn tool(&mut self, selected: &Path, expected: Option<&str>) -> Result<Tool, String> {
        self.remaining()?;
        if !selected.is_absolute()
            || selected
                .components()
                .any(|v| !matches!(v, Component::RootDir | Component::Normal(_)))
        {
            return Err(error("tool_path_invalid"));
        }
        let path = fs::canonicalize(selected).map_err(|_| error("tool_missing"))?;
        let mut file = OpenOptions::new()
            .read(true)
            .custom_flags(nix::libc::O_NOFOLLOW | nix::libc::O_NONBLOCK | nix::libc::O_CLOEXEC)
            .open(&path)
            .map_err(|_| error("tool_invalid"))?;
        let metadata = file.metadata().map_err(|_| error("tool_invalid"))?;
        if !metadata.is_file()
            || metadata.mode() & 0o111 == 0
            || metadata.mode() & 0o022 != 0
            || metadata.len() > 256 * 1024 * 1024
            || metadata.len() < 4
        {
            return Err(error("tool_invalid"));
        }
        let mut magic = [0; 4];
        let mut filled = 0;
        while filled < magic.len() {
            let n = self.read_tool(&mut file, &mut magic[filled..])?;
            if n == 0 {
                return Err(error("tool_invalid"));
            }
            filled += n;
        }
        if magic != *b"\x7fELF" {
            return Err(error("tool_elf_required"));
        }
        let sha256 = self.hash_file(&mut file, metadata.len())?;
        let named = fs::symlink_metadata(&path).map_err(|_| error("tool_changed"))?;
        let held = file.metadata().map_err(|_| error("tool_changed"))?;
        if fs::canonicalize(selected).map_err(|_| error("tool_changed"))? != path
            || !same(&metadata, &named)
            || !same(&metadata, &held)
            || expected.is_some_and(|v| v != sha256)
        {
            return Err(error("tool_pin_mismatch"));
        }
        Ok(Tool {
            selected: selected.into(),
            path,
            file,
            metadata,
            sha256,
        })
    }
    fn read_tool(&mut self, file: &mut File, bytes: &mut [u8]) -> Result<usize, String> {
        self.remaining()?;
        let remaining = (1024_u64 * 1024 * 1024)
            .checked_sub(self.read_bytes)
            .filter(|v| *v > 0)
            .ok_or_else(|| error("tool_read_budget_exceeded"))?;
        let capacity = bytes
            .len()
            .min(usize::try_from(remaining).unwrap_or(usize::MAX));
        let n = file
            .read(&mut bytes[..capacity])
            .map_err(|_| error("tool_unreadable"))?;
        self.read_bytes += n as u64;
        Ok(n)
    }
    fn hash_file(&mut self, file: &mut File, expected_bytes: u64) -> Result<String, String> {
        file.rewind().map_err(|_| error("tool_unreadable"))?;
        let mut hash = Sha256::new();
        let mut buf = [0; 64 * 1024];
        let mut read = 0;
        while read < expected_bytes {
            let remaining = usize::try_from(expected_bytes - read).unwrap_or(usize::MAX);
            let capacity = remaining.min(buf.len());
            let n = self.read_tool(file, &mut buf[..capacity])?;
            if n == 0 {
                return Err(error("observed_file_short_read"));
            }
            read += n as u64;
            hash.update(&buf[..n]);
        }
        Ok(format!("sha256:{:x}", hash.finalize()))
    }
    fn assert_tool(&mut self, tool: &mut Tool) -> Result<(), String> {
        self.remaining()?;
        let named = fs::symlink_metadata(&tool.path).map_err(|_| error("tool_changed"))?;
        let held = tool.file.metadata().map_err(|_| error("tool_changed"))?;
        if fs::canonicalize(&tool.selected).map_err(|_| error("tool_changed"))? != tool.path
            || !same(&named, &tool.metadata)
            || !same(&held, &tool.metadata)
        {
            return Err(error("tool_changed"));
        }
        if self.hash_file(&mut tool.file, tool.metadata.len())? != tool.sha256 {
            return Err(error("tool_changed"));
        }
        let named_after = fs::symlink_metadata(&tool.path).map_err(|_| error("tool_changed"))?;
        let held_after = tool.file.metadata().map_err(|_| error("tool_changed"))?;
        if fs::canonicalize(&tool.selected).map_err(|_| error("tool_changed"))? != tool.path
            || !same(&named_after, &tool.metadata)
            || !same(&held_after, &tool.metadata)
        {
            return Err(error("tool_changed"));
        }
        Ok(())
    }
    fn source(&self) -> Result<Value, String> {
        let mut source = self.request.source.clone();
        source.timeout_ms = source.timeout_ms.min(self.remaining()?);
        inspect_release_attestation_source_with_cancellation_v2(source, self.cancelled)
            .map_err(|e| e.to_string())
    }
    fn oracle(&self, node: &Tool, script: &str, corpus: &str) -> Result<(Value, Value), String> {
        let limits = ProcessLimitsV1 {
            timeout_ms: self.remaining()?,
            termination_grace_ms: 100,
            cleanup_timeout_ms: 2000,
            maximum_stdout_bytes: 16 * 1024 * 1024,
            maximum_stderr_bytes: 1024 * 1024,
            maximum_tail_bytes: 64 * 1024,
            ..ProcessLimitsV1::default()
        };
        let request = BoundedProcessRequestV1 {
            executable: node.path.clone(),
            arguments: vec![
                "--input-type=module".into(),
                "--eval".into(),
                script.into(),
                self.request.source.workspace_root.as_os_str().to_owned(),
            ],
            working_directory: self.request.source.workspace_root.clone(),
            environment: self.environment.clone(),
            stdin: Some(corpus.as_bytes().to_vec()),
        };
        let result = run_bounded_process_capturing_stdout_with_cancellation(
            &request,
            limits,
            self.cancelled,
        )
        .map_err(|e| format!("{}:{e}", error("oracle_execution_failed")))?;
        let process = &result.process;
        if process.termination_reason != ProcessTerminationReason::Exited
            || process.exit_code != Some(0)
            || process.signal.is_some()
            || !process.process_group_cleanup_verified
            || process.stderr_truncated
            || result.stdout.len() as u64 != process.stdout_bytes
            || digest(&result.stdout) != process.stdout_hash.to_string()
        {
            return Err(format!(
                "{}:{:?}:exit={:?}:signal={:?}:groupCleanup={}:observedStdout={}:capturedStdout={}:stderrTailTruncated={}:{}",
                error("oracle_failed"),
                process.termination_reason,
                process.exit_code,
                process.signal,
                process.process_group_cleanup_verified,
                process.stdout_bytes,
                result.stdout.len(),
                process.stderr_truncated,
                String::from_utf8_lossy(&process.stderr_tail)
            ));
        }
        let parsed: Value =
            serde_json::from_slice(&result.stdout).map_err(|_| error("oracle_json_invalid"))?;
        if parsed["profile"] != json!({"node":"v22.23.1","icu":"78.2","cldr":"48.0"})
            || parsed["archiveReference"]["status"] != "legacy_differential_reference_verified"
            || parsed["archiveReference"]["archiveSha256"]
                != "sha256:fcf7027a0f9f7f49556314546257a9c252949b46c847fb34471db1bf1a92de3a"
        {
            return Err(error("oracle_profile_or_archive_invalid"));
        }
        Ok((
            parsed,
            json!({"executable":node.path,"executableSha256":node.sha256,"scriptSha256":digest(script.as_bytes()),"inputSha256":digest(corpus.as_bytes()),"stdoutSha256":process.stdout_hash.to_string(),"stderrSha256":process.stderr_hash.to_string(),"stdoutBytes":process.stdout_bytes,"capturedStdoutBytes":result.stdout.len(),"stdoutTailTruncated":process.stdout_truncated,"stderrBytes":process.stderr_bytes,"exitCode":process.exit_code,"processGroupCleanupVerified":process.process_group_cleanup_verified}),
        ))
    }
}

pub fn inspect_release_attestation_replay_v3(
    request: ReleaseAttestationReplayRequestV3,
) -> Result<Value, String> {
    inspect_release_attestation_replay_with_cancellation_v3(request, &AtomicBool::new(false))
}
pub fn inspect_release_attestation_replay_with_cancellation_v3(
    request: ReleaseAttestationReplayRequestV3,
    cancelled: &AtomicBool,
) -> Result<Value, String> {
    if request.version != 3
        || request.kind != "ReleaseAttestationReplayRequest"
        || request.timeout_ms == 0
        || request.timeout_ms > 600_000
        || request
            .node_executable
            .file_name()
            .is_none_or(|v| v != "node")
        || !request
            .node_executable_sha256
            .strip_prefix("sha256:")
            .is_some_and(|v| {
                v.len() == 64
                    && v.bytes()
                        .all(|v| v.is_ascii_digit() || (b'a'..=b'f').contains(&v))
            })
    {
        return Err(error("request_invalid"));
    }
    let environment = EnvironmentPolicyV1::new(
        "release-fixed-replay-v3",
        ["PATH", "LANG", "LC_ALL", "PYTHONDONTWRITEBYTECODE"],
        ["PATH", "LANG", "LC_ALL"],
    )
    .map_err(|_| error("environment_invalid"))?
    .build(
        std::iter::empty::<(OsString, OsString)>(),
        &BTreeMap::from([
            ("PATH".into(), "/usr/bin:/bin".into()),
            ("LANG".into(), "C.UTF-8".into()),
            ("LC_ALL".into(), "C.UTF-8".into()),
            ("PYTHONDONTWRITEBYTECODE".into(), "1".into()),
        ]),
    )
    .map_err(|_| error("environment_invalid"))?;
    let mut owner = Owner {
        request: &request,
        cancelled,
        started: Instant::now(),
        environment,
        read_bytes: 0,
    };
    let before = owner.source()?;
    let mut node = owner.tool(
        &request.node_executable,
        Some(&request.node_executable_sha256),
    )?;
    let mut python = owner.tool(Path::new("/usr/bin/python3"), None)?;
    let mut tar = owner.tool(Path::new("/usr/bin/tar"), None)?;
    let mut source_graph = SourceGraph::capture(&mut owner)?;
    let native_p0 = evaluate_production_replay_corpus_v1(PRODUCTION_REPLAY_CORPUS_V1.as_bytes())?;
    owner.remaining()?;
    let production_script = format!(
        "{REPLAY_ORACLE_INPUT_GUARD_V1}\n{}",
        include_str!("production-oracle.mjs")
    );
    let (p0, p0_process) = owner.oracle(&node, &production_script, PRODUCTION_REPLAY_CORPUS_V1)?;
    let native_artifact = native_p0["artifactCases"]
        .as_array()
        .filter(|v| v.len() >= 4)
        .ok_or_else(|| error("compiled_corpus_invalid"))?;
    if native_p0 != p0["actual"]
        || native_p0["base"] != p0["archivedPython"]["base"]
        || json!(native_artifact[..4]) != p0["archivedPython"]["artifactCases"]
    {
        return Err(error("production_differential_mismatch"));
    }
    let native_p1 = evaluate_referee_replay_corpus_v1(REFEREE_REPLAY_CORPUS_V1.as_bytes())?;
    let cases = native_p1["actual"]
        .as_array()
        .ok_or_else(|| error("compiled_corpus_invalid"))?;
    owner.remaining()?;
    let referee_script = format!(
        "{REPLAY_ORACLE_INPUT_GUARD_V1}\n{}",
        include_str!("referee-oracle.mjs")
    );
    let (p1, p1_process) = owner.oracle(&node, &referee_script, REFEREE_REPLAY_CORPUS_V1)?;
    let base = native_p1["baseCaseCount"]
        .as_u64()
        .and_then(|v| usize::try_from(v).ok())
        .filter(|v| *v <= cases.len())
        .ok_or_else(|| error("compiled_corpus_invalid"))?;
    if native_p1["actual"] != p1["actual"] || json!(cases[..base]) != p1["archivedPython"] {
        return Err(error("referee_differential_mismatch"));
    }
    let after = owner.source()?;
    if before["nativeSourceCapture"] != after["nativeSourceCapture"] {
        return Err(error("source_changed"));
    }
    owner.assert_tool(&mut node)?;
    owner.assert_tool(&mut python)?;
    owner.assert_tool(&mut tar)?;
    source_graph.assert_current(&mut owner)?;
    let mut report = json!({"version":3,"kind":"ReleaseAttestationReplayInspection","status":"release_attestation_blocked","sourceBound":true,"nativeSourceCapture":after["nativeSourceCapture"],"nativeDifferentialReplay":{"status":"native_p0_p1_differential_replay_passed","scope":"immutable_minimal_legacy_reference_and_fixed_parameter_corpus","productionInputSha256":digest(PRODUCTION_REPLAY_CORPUS_V1.as_bytes()),"refereeInputSha256":digest(REFEREE_REPLAY_CORPUS_V1.as_bytes()),"refereeCaseCount":cases.len(),"originalArchiveRefereeCaseCount":base,"productionProcess":p0_process,"refereeProcess":p1_process,"archiveReference":p1["archiveReference"],"pythonExecutable":python.path,"pythonExecutableSha256":python.sha256,"tarExecutable":tar.path,"tarExecutableSha256":tar.sha256,"nodeProfile":p1["profile"],"sameInputRustNodeVerified":true,"archivedPythonBaselineVerified":true,"safeApplyCommandContractMigration":"legacy_merge_queue_to_hepta_safe_apply_plan","fullRestoredArchiveAndRuntimeReplayComplete":false,"policyReplayComplete":false},"implementationBlockers":after["implementationBlockers"],"externalQualificationBlockers":after["externalQualificationBlockers"],"blockers":after["blockers"],"technicalLocalChecksReady":false,"releaseEvidenceReady":false,"signingKeyRead":false,"runtimeEvidenceWritten":false,"physicalDeletionAllowed":false,"nodeRetirement":false,"externalActionPerformed":false,"sourceGraph":source_graph.report(),"resourceLimits":{"maximumToolFileBytes":256*1024*1024,"maximumSourceInputFileBytes":4*1024*1024,"aggregateObservedReadBytes":1024*1024*1024,"sourceCaptureCount":2,"perCaptureMaximumSourceBytes":2_u64*1024*1024*1024,"oracleStdoutBytes":16*1024*1024,"timeoutMs":request.timeout_ms},"observedReadBytes":owner.read_bytes,"toolReadBytes":owner.read_bytes-source_graph.read_bytes()});
    report["reportHash"] = json!(
        canonical_hash_v1(
            &json!({"kind":"ReleaseAttestationReplayInspection","value":report.clone()})
        )
        .map_err(|_| error("report_hash_failed"))?
        .to_string()
    );
    Ok(report)
}
