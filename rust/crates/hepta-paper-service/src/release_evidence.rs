//! Ordinary explicit release-evidence execution. The initial native runtime
//! profile persists signed blocked diagnostics; it cannot publish a ready code
//! bundle while policy/runtime qualification remains incomplete.
mod recovery;

use crate::release_attest::{
    ReleaseAttestationSourceRequestV2, inspect_release_attestation_source_with_cancellation_v2,
    source_capture::prepare_release_attestation_source_with_cancellation_v3,
};
use crate::release_integrity_key::{
    ReleaseIntegrityKeyContextV1, load_existing_local_release_integrity_key_v1,
};
use crate::release_replay::{
    ReleaseAttestationMeasuredPolicyReplayRequestV8,
    ReleaseAttestationNativeAstPolicyReplayRequestV9,
    ReleaseAttestationNativeRetirementPolicyReplayRequestV10,
    ReleaseAttestationPolicyReplayRequestV4, ReleaseAttestationReplayRequestV3,
    inspect_release_attestation_native_retirement_policy_replay_with_cancellation_v10,
    local_signature::sign_blocked_replay_diagnostic_v1,
};
use crate::state_recoverability::{
    files::ObservedFile,
    publication::{Directory, publish_receipt_bytes},
};
use serde::Deserialize;
use serde_json::Value;
#[cfg(test)]
use serde_json::json;
use std::{
    collections::{BTreeMap, BTreeSet},
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
    time::Instant,
};

pub const RELEASE_EVIDENCE_USAGE: &str = "Usage: release-evidence --execute\n\n  --execute  Explicitly attest the deletion drill and publish signed release evidence.\n  --help     Show this help without reading keys or writing runtime evidence.";
const TIMEOUT_MS: u64 = 600_000;
const RECEIPT_BYTES: u64 = 4 * 1024 * 1024;
const PROFILE_PATH: &str = "migration/fixtures/native-release-replay-profile.v1.json";
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ReleaseEvidenceOptionsV1 {
    pub help: bool,
    pub execute: bool,
}
pub fn parse_release_evidence_arguments_v1(
    args: &[String],
) -> Result<ReleaseEvidenceOptionsV1, String> {
    let mut seen = BTreeSet::new();
    for token in args {
        if token == "--" {
            return Err("unexpected_cli_argument_separator".into());
        }
        let raw = token
            .strip_prefix("--")
            .ok_or_else(|| format!("unexpected_cli_positional:{token}"))?;
        let (key, value) = raw
            .split_once('=')
            .map_or((raw, None), |(k, v)| (k, Some(v)));
        if key.is_empty() {
            return Err("empty_cli_option".into());
        }
        if !["execute", "help"].contains(&key) {
            return Err(format!("unknown_cli_option:--{key}"));
        }
        if value.is_some() {
            return Err(format!("boolean_cli_option_does_not_take_value:--{key}"));
        }
        if !seen.insert(key) {
            return Err(format!("duplicate_cli_option:--{key}"));
        }
    }
    if seen.contains("help") {
        return Ok(ReleaseEvidenceOptionsV1 {
            help: true,
            execute: false,
        });
    }
    if !seen.contains("execute") {
        return Err("release_attestation_execute_required".into());
    }
    Ok(ReleaseEvidenceOptionsV1 {
        help: false,
        execute: true,
    })
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReplayProfile {
    version: u16,
    kind: String,
    profile: String,
    node_executable: PathBuf,
    node_executable_sha256: String,
    archive_path: PathBuf,
    archive_sha256: String,
}
fn checkpoint(cancelled: &AtomicBool, started: Instant) -> Result<u64, String> {
    if cancelled.load(Ordering::Acquire) {
        return Err("release_evidence_cancelled_recovery_may_be_required".into());
    }
    TIMEOUT_MS
        .checked_sub(u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX))
        .filter(|v| *v > 0)
        .ok_or_else(|| "release_evidence_deadline_recovery_may_be_required".into())
}
fn profile(root: &Path) -> Result<(ReplayProfile, ObservedFile), String> {
    let held =
        ObservedFile::open(&root.join(PROFILE_PATH), 32 * 1024).map_err(|e| e.to_string())?;
    let bytes = held.bytes(32 * 1024).map_err(|e| e.to_string())?;
    let value = crate::sqlite_mutation_coordinator::authority::files::parse(
        &bytes,
        "release_evidence_profile_invalid",
    )
    .map_err(|e| e.to_string())?;
    let profile: ReplayProfile =
        serde_json::from_value(value).map_err(|_| "release_evidence_profile_invalid".to_owned())?;
    if profile.version != 1
        || profile.kind != "OrdinaryNativeReleaseReplayProfile"
        || profile.profile != "immutable_source_only_blocked_integrity_v1"
        || !profile.node_executable.is_absolute()
        || !profile.archive_path.is_absolute()
        || profile.archive_sha256
            != "sha256:e431c4c7a51a15d64866b17a07c09dd17c15c32c8dddaccf1a769b1a5942cb9d"
    {
        return Err("release_evidence_profile_invalid".into());
    }
    held.assert_current().map_err(|e| e.to_string())?;
    Ok((profile, held))
}
fn replay(
    profile: ReplayProfile,
    source: ReleaseAttestationSourceRequestV2,
    timeout_ms: u64,
) -> ReleaseAttestationNativeRetirementPolicyReplayRequestV10 {
    ReleaseAttestationNativeRetirementPolicyReplayRequestV10 {
        version: 10,
        kind: "ReleaseAttestationNativeRetirementPolicyReplayRequest".into(),
        native_profile: "immutable_referee_venue_retirement_policy_v1".into(),
        policy: ReleaseAttestationNativeAstPolicyReplayRequestV9 {
            version: 9,
            kind: "ReleaseAttestationNativeAstPolicyReplayRequest".into(),
            native_profile: "immutable_245_python_ast_observation_v1".into(),
            policy: ReleaseAttestationMeasuredPolicyReplayRequestV8 {
                version: 8,
                kind: "ReleaseAttestationMeasuredPolicyReplayRequest".into(),
                resource_profile: "immutable_263_source_inspection_v1".into(),
                policy: ReleaseAttestationPolicyReplayRequestV4 {
                    version: 4,
                    kind: "ReleaseAttestationPolicyReplayRequest".into(),
                    archive_path: profile.archive_path,
                    archive_sha256: profile.archive_sha256,
                    replay: ReleaseAttestationReplayRequestV3 {
                        version: 3,
                        kind: "ReleaseAttestationReplayRequest".into(),
                        source,
                        node_executable: profile.node_executable,
                        node_executable_sha256: profile.node_executable_sha256,
                        timeout_ms,
                    },
                },
            },
        },
    }
}
fn recapture(
    source: &ReleaseAttestationSourceRequestV2,
    payload: &Value,
    cancelled: &AtomicBool,
    started: Instant,
) -> Result<(), String> {
    let mut request = source.clone();
    request.timeout_ms = request.timeout_ms.min(checkpoint(cancelled, started)?);
    let observed = inspect_release_attestation_source_with_cancellation_v2(request, cancelled)
        .map_err(|e| e.to_string())?;
    if observed["nativeSourceCapture"] != payload["nativeSourceCapture"] {
        return Err("release_evidence_source_changed_recovery_may_be_required".into());
    }
    checkpoint(cancelled, started)?;
    Ok(())
}
/// Normal route: actual source/replay, existing integrity key, signature and
/// durable no-clobber diagnostic publication precede the bundle readiness gate.
/// This profile remains blocked and never creates keys or a CURRENT pointer.
pub fn execute_release_evidence_with_cancellation_v1(
    args: &[String],
    environment: &BTreeMap<String, String>,
    cancelled: &AtomicBool,
) -> Result<Value, String> {
    let options = parse_release_evidence_arguments_v1(args)?;
    if options.help {
        return Ok(Value::String(RELEASE_EVIDENCE_USAGE.into()));
    }
    if environment
        .get("HEPTA_PAPER_RUNTIME_ISOLATED")
        .is_some_and(|v| v == "1")
    {
        return Err("release_attestation_forbidden_in_isolated_runtime".into());
    }
    let started = Instant::now();
    checkpoint(cancelled, started)?;
    let context = ReleaseIntegrityKeyContextV1::from_environment(None, environment)
        .map_err(|e| e.to_string())?;
    let prepared = prepare_release_attestation_source_with_cancellation_v3(
        &context.workspace_root,
        checkpoint(cancelled, started)?,
        cancelled,
    )
    .map_err(|e| e.to_string())?;
    if prepared.release_state_snapshot["releaseState"]["ok"] != true
        || prepared.release_state_snapshot["releaseState"]["state"] != "release_ready"
    {
        return Err(format!(
            "workspace_release_state_not_ready:{}",
            prepared.release_state_snapshot["releaseState"]["state"]
                .as_str()
                .unwrap_or("invalid")
        ));
    }
    let source = prepared.request;
    let (profile, profile_guard) = profile(&context.workspace_root)?;
    let payload =
        inspect_release_attestation_native_retirement_policy_replay_with_cancellation_v10(
            replay(profile, source.clone(), checkpoint(cancelled, started)?),
            cancelled,
        )?;
    if payload["nativeSourceCapture"]["releaseStateSnapshot"]["releaseState"]["ok"] != true
        || payload["nativeSourceCapture"]["releaseStateSnapshot"]["releaseState"]["state"]
            != "release_ready"
    {
        return Err("workspace_release_state_not_ready".into());
    }
    profile_guard.assert_current().map_err(|e| e.to_string())?;
    recapture(&source, &payload, cancelled, started)?;
    let key =
        load_existing_local_release_integrity_key_v1(&context, true).map_err(|e| e.to_string())?;
    checkpoint(cancelled, started)?;
    let (signature, wire) = sign_blocked_replay_diagnostic_v1(&payload, &key)?;
    recapture(&source, &payload, cancelled, started)?;
    key.assert_current().map_err(|e| e.to_string())?;
    profile_guard.assert_current().map_err(|e| e.to_string())?;
    if wire.len() as u64 > RECEIPT_BYTES {
        return Err("release_evidence_receipt_budget".into());
    }
    let value: Value = serde_json::from_slice(&wire)
        .map_err(|_| "release_evidence_receipt_encoding".to_owned())?;
    let hash = signature
        .payload_hash
        .strip_prefix("sha256:")
        .filter(|v| {
            v.len() == 64
                && v.bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        })
        .ok_or_else(|| "release_evidence_receipt_hash".to_owned())?;
    let name = format!("NATIVE_BLOCKED_DRILL_v1_{hash}.json");
    let directory = Directory::open_or_create(
        &context
            .runtime_root
            .join("legacy-retirement/deletion-drills"),
        true,
    )
    .map_err(|e| e.to_string())?;
    use std::os::unix::fs::MetadataExt;
    if directory.held.metadata().map_err(|e| e.to_string())?.mode() & 0o777 != 0o700 {
        return Err("release_evidence_output_private_mode_required".into());
    }
    checkpoint(cancelled, started)?;
    let recovery = recovery::recover(
        &directory,
        &payload["nativeSourceCapture"],
        &key,
        cancelled,
        started,
    )?;
    if recovery["releaseEvidenceReady"] != false {
        return Err("release_evidence_recovery_authority_boundary_invalid".into());
    }
    recapture(&source, &payload, cancelled, started)?;
    profile_guard.assert_current().map_err(|e| e.to_string())?;
    publish_receipt_bytes(&directory, &name, &value, &wire, None)
        .map_err(|e| format!("release_evidence_publication_recovery_may_be_required:{e}"))?;
    let published = ObservedFile::open(&directory.path.join(&name), RECEIPT_BYTES)
        .map_err(|e| format!("release_evidence_publication_recovery_may_be_required:{e}"))?;
    if published.bytes(RECEIPT_BYTES).map_err(|e| e.to_string())? != wire {
        return Err("release_evidence_published_bytes_changed_recovery_may_be_required".into());
    }
    if let Err(failure) = recapture(&source, &payload, cancelled, started) {
        // Preserve a failed post-publication observation for explicit recovery;
        // never unlink an artifact whose ownership cannot be proved.
        return Err(format!(
            "release_evidence_publication_recovery_required:{failure}"
        ));
    }
    key.assert_current()
        .map_err(|e| format!("release_evidence_publication_recovery_required:{e}"))?;
    profile_guard
        .assert_current()
        .map_err(|e| format!("release_evidence_publication_recovery_required:{e}"))?;
    published.assert_current().map_err(|e| e.to_string())?;
    // Same normal sequencing as the incumbent: a blocked signed drill may have
    // persisted before writeSignedReleaseEvidence refuses the ready bundle.
    Err("release_evidence_bundle_not_ready".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn normal_grammar_help_and_research_boundary_precede_every_io() {
        let arguments = |args: &[&str]| args.iter().map(|v| (*v).to_owned()).collect::<Vec<_>>();
        assert_eq!(
            parse_release_evidence_arguments_v1(&[]).unwrap_err(),
            "release_attestation_execute_required"
        );
        assert_eq!(
            parse_release_evidence_arguments_v1(&arguments(&["--execute", "--help"])).unwrap(),
            ReleaseEvidenceOptionsV1 {
                help: true,
                execute: false
            }
        );
        for args in [
            vec!["--help", "--unknown"],
            vec!["--execute=false"],
            vec!["--help", "--help"],
            vec!["request.json"],
            vec!["--"],
        ] {
            assert!(parse_release_evidence_arguments_v1(&arguments(&args)).is_err());
        }
        let environment = BTreeMap::from([
            ("HEPTA_PAPER_RUNTIME_ISOLATED".into(), "1".into()),
            ("HEPTA_PAPER_WORKSPACE_ROOT".into(), "/not-readable".into()),
        ]);
        let cancelled = AtomicBool::new(true);
        assert_eq!(
            execute_release_evidence_with_cancellation_v1(
                &arguments(&["--help"]),
                &environment,
                &cancelled
            )
            .unwrap(),
            json!(RELEASE_EVIDENCE_USAGE)
        );
        assert_eq!(
            execute_release_evidence_with_cancellation_v1(
                &arguments(&["--execute"]),
                &environment,
                &cancelled
            )
            .unwrap_err(),
            "release_attestation_forbidden_in_isolated_runtime"
        );
    }
}

#[cfg(test)]
#[path = "release_evidence/tests.rs"]
mod ordinary_tests;
