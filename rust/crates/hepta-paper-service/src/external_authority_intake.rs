//! Bounded, read-only external-authority intake surface.
//!
//! The incumbent Node command is the first gate before any live provider or
//! release-attestor action.  Rust deliberately exposes the same passive
//! command shape while the full external configuration adapters are being
//! migrated.  Missing inputs are reported exactly; supplied inputs are
//! fail-closed and never treated as authority until the independently
//! provisioned author/KMS verifiers are ported.

#![forbid(unsafe_code)]

use hepta_legacy_compatibility::production_hash_record_v1;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{fs, os::unix::fs::MetadataExt, path::Path};
use thiserror::Error;

const AUTHOR_PATH_MISSING: &str = "autonomous_research_author_identity_configuration_path_missing";
const AUTHOR_FILE_INVALID: &str = "autonomous_research_author_identity_configuration_file_invalid";
const RELEASE_PATH_MISSING: &str = "research_execution_release_attestor_config_path_missing";
const RELEASE_FILE_INVALID: &str =
    "research_execution_release_attestor_config_not_private_regular_file";
const ADAPTER_MISSING: &str = "rust_external_authority_intake_adapter_not_ported";

#[derive(Debug, Error)]
pub enum ExternalAuthorityIntakeError {
    #[error("external authority intake inspection hash could not be encoded")]
    Hash,
    #[error("external authority intake clock is invalid")]
    Clock,
    #[error("external authority intake path is not valid UTF-8")]
    Utf8,
}

fn blocked_author(blocker: &str) -> Value {
    json!({
        "status": "production_external_author_identity_input_blocked",
        "readyForRuntimeBinding": false,
        "configured": false,
        "configurationVersion": null,
        "stablePolicyPinned": false,
        "configurationPinned": false,
        "observedConfigurationHash": null,
        "authoritySubjectHash": null,
        "authorityEnvelopeHash": null,
        "authorityVerificationReceiptHash": null,
        "attestationExpiresAt": null,
        "cryptographicAuthorityReady": false,
        "externalActionPerformed": false,
        "blockers": [blocker]
    })
}

fn blocked_release(blocker: &str) -> Value {
    json!({
        "status": "production_external_release_attestor_input_blocked",
        "readyForLiveVerification": false,
        "configured": false,
        "configurationVersion": null,
        "configurationPinned": false,
        "observedConfigurationFileHash": null,
        "observedConfigurationIdentityHash": null,
        "configurationIdentityProfile": null,
        "backendKind": null,
        "backendDescriptorHash": null,
        "hardwareProtected": false,
        "privateKeyExportable": null,
        "externalSignerProcess": false,
        "kmsHardwareAuthorityReady": false,
        "kmsHardwareAuthorityIndependent": false,
        "kmsHardwareAuthorityBundleHash": null,
        "kmsHardwareAuthorityExpiresAt": null,
        "liveProbeRequired": false,
        "liveSignerChallengeRequired": false,
        "externalActionPerformed": false,
        "blockers": [blocker]
    })
}

fn read_pinned(path: &Path, maximum_bytes: u64) -> Option<Vec<u8>> {
    if !path.is_absolute()
        || path.components().any(|part| {
            matches!(
                part,
                std::path::Component::CurDir | std::path::Component::ParentDir
            )
        })
    {
        return None;
    }
    let canonical = fs::canonicalize(path).ok()?;
    if canonical != path {
        return None;
    }
    let before = fs::symlink_metadata(path).ok()?;
    let uid = nix::unistd::Uid::current().as_raw();
    if !before.is_file()
        || before.file_type().is_symlink()
        || before.nlink() != 1
        || before.len() == 0
        || before.len() > maximum_bytes
        || (before.mode() & 0o022) != 0
        || (before.uid() != 0 && before.uid() != uid)
    {
        return None;
    }
    let bytes = fs::read(path).ok()?;
    let after = fs::metadata(path).ok()?;
    let path_after = fs::symlink_metadata(path).ok()?;
    (bytes.len() as u64 == before.len()
        && after.dev() == before.dev()
        && after.ino() == before.ino()
        && after.size() == before.size()
        && after.mtime() == before.mtime()
        && after.mtime_nsec() == before.mtime_nsec()
        && path_after.dev() == before.dev()
        && path_after.ino() == before.ino()
        && path_after.size() == before.size()
        && path_after.mtime() == before.mtime()
        && path_after.mtime_nsec() == before.mtime_nsec())
    .then_some(bytes)
}

fn bytes_hash(bytes: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(bytes))
}

fn inspect_author(path: Option<&Path>, expected_hash: Option<&str>) -> Value {
    let Some(path) = path else {
        return blocked_author(AUTHOR_PATH_MISSING);
    };
    // This route never follows links or reads private key material.  Full
    // author-envelope verification remains delegated until its Rust adapter
    // is independently reviewed.
    let bytes = match read_pinned(path, 1024 * 1024) {
        Some(bytes) => bytes,
        None => return blocked_author(AUTHOR_FILE_INVALID),
    };
    let value = serde_json::from_slice::<Value>(&bytes).ok();
    let observed = value
        .as_ref()
        .and_then(|v| v.get("configurationHash"))
        .and_then(Value::as_str);
    let mut report = blocked_author(ADAPTER_MISSING);
    if let Some(object) = report.as_object_mut() {
        object.insert("configured".into(), Value::Bool(true));
        object.insert(
            "configurationVersion".into(),
            value
                .as_ref()
                .and_then(|v| v.get("version"))
                .cloned()
                .unwrap_or(Value::Null),
        );
        object.insert(
            "observedConfigurationHash".into(),
            observed.map_or(Value::Null, |v| Value::String(v.to_owned())),
        );
        let blocker = match expected_hash {
            None => "autonomous_research_author_identity_configuration_pin_required",
            Some(expected) if Some(expected) == observed => ADAPTER_MISSING,
            Some(_) => "autonomous_research_author_identity_configuration_pin_mismatch",
        };
        object.insert("blockers".into(), json!([blocker]));
    }
    report
}

fn inspect_release(path: Option<&Path>, expected_hash: Option<&str>) -> Value {
    let Some(path) = path else {
        return blocked_release(RELEASE_PATH_MISSING);
    };
    let bytes = match read_pinned(path, 256 * 1024) {
        Some(bytes) => bytes,
        None => return blocked_release(RELEASE_FILE_INVALID),
    };
    let value = serde_json::from_slice::<Value>(&bytes).ok();
    let mut report = blocked_release(ADAPTER_MISSING);
    if let Some(object) = report.as_object_mut() {
        object.insert("configured".into(), Value::Bool(true));
        object.insert(
            "observedConfigurationFileHash".into(),
            Value::String(bytes_hash(&bytes)),
        );
        object.insert(
            "configurationVersion".into(),
            value
                .as_ref()
                .and_then(|v| v.get("version"))
                .cloned()
                .unwrap_or(Value::Null),
        );
        object.insert(
            "backendKind".into(),
            value
                .as_ref()
                .and_then(|v| v.get("backend"))
                .and_then(|v| v.get("kind"))
                .cloned()
                .or_else(|| {
                    value.as_ref().and_then(|v| {
                        (v.get("version") == Some(&Value::Number(1.into())))
                            .then(|| Value::String("local-file".into()))
                    })
                })
                .unwrap_or(Value::Null),
        );
        let blocker = match expected_hash {
            None => "research_execution_release_attestor_config_pin_required",
            Some(_) => ADAPTER_MISSING,
        };
        object.insert("blockers".into(), json!([blocker]));
    }
    report
}

/// Return the passive intake report.  The function does not open a provider,
/// invoke a child process, read a private key, or write service state.
pub fn inspect_external_authority_intake_v1(
    author_path: Option<&Path>,
    author_expected_hash: Option<&str>,
    release_path: Option<&Path>,
    release_expected_hash: Option<&str>,
    observed_at: &str,
) -> Result<Value, ExternalAuthorityIntakeError> {
    if observed_at.is_empty() {
        return Err(ExternalAuthorityIntakeError::Clock);
    }
    let author = inspect_author(author_path, author_expected_hash);
    let release = inspect_release(release_path, release_expected_hash);
    let author_blockers = author
        .get("blockers")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let release_blockers = release
        .get("blockers")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut blockers = author_blockers;
    blockers.extend(release_blockers);
    let payload = json!({
        "version": 1,
        "kind": "ProductionExternalAuthorityIntakeInspection",
        "status": "production_external_authority_inputs_required",
        "ready": false,
        "readyForLiveVerification": false,
        "fullProductionReady": false,
        "observedAt": observed_at,
        "externalActionPerformed": false,
        "serviceStateChanged": false,
        "requiredEnvironmentVariables": [
            "HEPTA_RESEARCH_AUTHOR_IDENTITY_CONFIG",
            "HEPTA_RESEARCH_AUTHOR_IDENTITY_CONFIG_HASH",
            "HEPTA_RESEARCH_EXECUTION_RELEASE_ATTESTOR_CONFIG",
            "HEPTA_RESEARCH_EXECUTION_RELEASE_ATTESTOR_CONFIG_HASH"
        ],
        "nextAction": "supply_or_correct_external_authority_inputs",
        "author": author,
        "releaseAttestor": release,
        "deferredLiveChecks": [
            "bind_external_author_attestation_to_the_live_author_principal",
            "run_independent_release_attestor_backend_probe",
            "run_active_release_attestor_signing_challenge"
        ],
        "blockers": blockers
    });
    let hash = production_hash_record_v1("ProductionExternalAuthorityIntakeInspection", &payload)
        .map_err(|_| ExternalAuthorityIntakeError::Hash)?
        .as_str()
        .to_owned();
    let mut result = payload;
    result
        .as_object_mut()
        .ok_or(ExternalAuthorityIntakeError::Hash)?
        .insert(
            "productionExternalAuthorityIntakeInspectionHash".into(),
            Value::String(hash),
        );
    Ok(result)
}

/// Deterministic help payload shared by the Rust command and parity tests.
pub fn external_authority_intake_help_json_v1() -> Value {
    json!({
        "version": 1,
        "kind": "ProductionExternalAuthorityIntakeUsage",
        "usage": "production-external-authority-intake [--author-config PATH --author-config-hash sha256:...] [--release-attestor-config PATH --release-attestor-config-hash sha256:...] [--require-ready]",
        "defaults": "the four HEPTA_RESEARCH_*_CONFIG/_HASH environment variables",
        "mutation": "none",
        "externalAction": "none",
        "serviceStateChange": "none"
    })
}

/// Format a Unix millisecond clock as the canonical UTC instant used by Node.
pub fn unix_millis_to_iso_v1(millis: i64) -> Result<String, ExternalAuthorityIntakeError> {
    if millis < 0 {
        return Err(ExternalAuthorityIntakeError::Clock);
    }
    let seconds = millis / 1_000;
    let remainder = millis % 1_000;
    let days = seconds.div_euclid(86_400);
    let day_seconds = seconds.rem_euclid(86_400);
    // Civil-from-days, Gregorian proleptic calendar (Howard Hinnant).
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = mp + if mp < 10 { 3 } else { -9 };
    let year = y + if month <= 2 { 1 } else { 0 };
    let hour = day_seconds / 3_600;
    let minute = (day_seconds % 3_600) / 60;
    let second = day_seconds % 60;
    Ok(format!(
        "{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{remainder:03}Z"
    ))
}
