//! Bounded, read-only external-authority intake surface.
//!
//! The incumbent Node command is the first gate before any live provider or
//! release-attestor action. Rust exposes the same passive command shape. The
//! configured author document is verified offline, while the release-attestor
//! path stops at its bounded configuration header until the external-KMS and
//! hardware authority adapter is independently qualified. No branch invokes a
//! provider, signer process, private key, or service-state mutation.

#![forbid(unsafe_code)]

use hepta_legacy_compatibility::production_hash_record_v1;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, Metadata, OpenOptions},
    io::Read,
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::{Component, Path, PathBuf},
};
use thiserror::Error;

mod author;

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

fn resolve_path(path: &Path) -> Option<PathBuf> {
    let source = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir().ok()?.join(path)
    };
    let mut resolved = PathBuf::new();
    for component in source.components() {
        match component {
            Component::Prefix(_) => return None,
            Component::RootDir => resolved.push("/"),
            Component::CurDir => {}
            Component::ParentDir => {
                if resolved != Path::new("/") && !resolved.pop() {
                    return None;
                }
            }
            Component::Normal(value) => resolved.push(value),
        }
    }
    resolved.is_absolute().then_some(resolved)
}

fn read_pinned(path: &Path, maximum_bytes: u64) -> Option<Vec<u8>> {
    let candidate = resolve_path(path)?;
    let canonical = fs::canonicalize(&candidate).ok()?;
    if canonical != candidate {
        return None;
    }
    let before = fs::symlink_metadata(&candidate).ok()?;
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
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(nix::libc::O_NOFOLLOW | nix::libc::O_CLOEXEC)
        .open(&candidate)
        .ok()?;
    let opened = file.metadata().ok()?;
    if !same_identity(&before, &opened) {
        return None;
    }
    let mut bytes = Vec::new();
    file.by_ref()
        .take(maximum_bytes + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    let after = file.metadata().ok()?;
    let path_after = fs::symlink_metadata(&candidate).ok()?;
    (bytes.len() as u64 == before.len()
        && same_identity(&before, &after)
        && same_identity(&before, &path_after))
    .then_some(bytes)
}

fn same_identity(left: &Metadata, right: &Metadata) -> bool {
    left.dev() == right.dev()
        && left.ino() == right.ino()
        && left.mode() == right.mode()
        && left.nlink() == right.nlink()
        && left.uid() == right.uid()
        && left.gid() == right.gid()
        && left.len() == right.len()
        && left.mtime() == right.mtime()
        && left.mtime_nsec() == right.mtime_nsec()
        && left.ctime() == right.ctime()
        && left.ctime_nsec() == right.ctime_nsec()
}

fn bytes_hash(bytes: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(bytes))
}

fn inspect_author(path: Option<&Path>, expected_hash: Option<&str>, now: &str) -> Value {
    author::inspect_author(path, expected_hash, now)
}

fn selected_path(path: Option<&Path>) -> Option<PathBuf> {
    let value = javascript_trim(path?.to_str()?);
    (!value.is_empty()).then(|| PathBuf::from(value))
}

fn selected_hash(value: Option<&str>) -> Option<String> {
    let value = javascript_trim(value?);
    (!value.is_empty()).then(|| value.to_ascii_lowercase())
}

fn javascript_trim(value: &str) -> &str {
    value.trim_matches(|character| {
        matches!(character,
            '\u{0009}'..='\u{000D}' | '\u{0020}' | '\u{00A0}' | '\u{1680}'
                | '\u{2000}'..='\u{200A}' | '\u{2028}' | '\u{2029}'
                | '\u{202F}' | '\u{205F}' | '\u{3000}' | '\u{FEFF}')
    })
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
    let valid_header = value.as_ref().is_some_and(|value| {
        value.get("kind")
            == Some(&Value::String(
                "ResearchExecutionReleaseAttestorConfiguration".to_owned(),
            ))
    });
    if !valid_header {
        let mut report = blocked_release("research_execution_release_attestor_config_invalid");
        if let Some(object) = report.as_object_mut() {
            object.insert(
                "observedConfigurationFileHash".into(),
                Value::String(bytes_hash(&bytes)),
            );
        }
        return report;
    }
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
    if !author::is_canonical_instant(observed_at) {
        return Err(ExternalAuthorityIntakeError::Clock);
    }
    let author_path = selected_path(author_path);
    let release_path = selected_path(release_path);
    let author_hash = selected_hash(author_expected_hash);
    let release_hash = selected_hash(release_expected_hash);
    let author = inspect_author(author_path.as_deref(), author_hash.as_deref(), observed_at);
    let release = inspect_release(release_path.as_deref(), release_hash.as_deref());
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
