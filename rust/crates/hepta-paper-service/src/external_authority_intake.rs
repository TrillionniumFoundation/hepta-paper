//! Bounded, read-only external-authority intake surface.
//!
//! The incumbent Node command is the first gate before any live provider or
//! release-attestor action. Rust exposes the same passive command shape. The
//! configured author document and V3 external-KMS hardware evidence are verified
//! offline with the incumbent pinned evidence verifier. Readiness describes
//! passive inputs; live author binding, probe and signer challenge stay deferred.
//! No branch invokes a provider, signer process, private key, or state mutation.

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
mod cli;
mod release_v3;
pub use cli::{
    EXTERNAL_AUTHORITY_INTAKE_ENVIRONMENT_KEYS, ExternalAuthorityIntakeOutputV1,
    external_authority_intake_cli_v1,
};
pub use release_v3::PASSIVE_RELEASE_ATTESTOR_ENVIRONMENT_KEYS;
use std::{
    sync::atomic::{AtomicBool, Ordering},
    time::Instant,
};
pub(super) struct Control<'a> {
    cancelled: &'a AtomicBool,
    deadline: Instant,
}
impl Control<'_> {
    fn check(&self) -> Result<(), ExternalAuthorityIntakeError> {
        if self.cancelled.load(Ordering::Acquire) {
            Err(ExternalAuthorityIntakeError::Cancelled)
        } else if Instant::now() >= self.deadline {
            Err(ExternalAuthorityIntakeError::Expired)
        } else {
            Ok(())
        }
    }
}
fn check_control(control: Option<&Control<'_>>) -> Result<(), ExternalAuthorityIntakeError> {
    if let Some(control) = control {
        control.check()?;
    }
    Ok(())
}

const RELEASE_PATH_MISSING: &str = "research_execution_release_attestor_config_path_missing";
const RELEASE_FILE_INVALID: &str =
    "research_execution_release_attestor_config_not_private_regular_file";

#[derive(Debug, Error)]
pub enum ExternalAuthorityIntakeError {
    #[error("external_authority_intake_cancelled")]
    Cancelled,
    #[error("external_authority_intake_expired")]
    Expired,
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

fn read_pinned(path: &Path, maximum_bytes: u64, control: Option<&Control<'_>>) -> Option<Vec<u8>> {
    check_control(control).ok()?;
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
        || (before.mode() & 0o077) != 0
        || before.uid() != uid
    {
        return None;
    }
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(nix::libc::O_NOFOLLOW | nix::libc::O_NONBLOCK | nix::libc::O_CLOEXEC)
        .open(&candidate)
        .ok()?;
    let opened = file.metadata().ok()?;
    if !same_identity(&before, &opened) {
        return None;
    }
    let mut bytes = Vec::new();
    let mut buffer = [0; 64 * 1024];
    loop {
        check_control(control).ok()?;
        let remaining = maximum_bytes
            .saturating_add(1)
            .saturating_sub(bytes.len() as u64);
        if remaining == 0 {
            return None;
        }
        let capacity = remaining.min(buffer.len() as u64) as usize;
        let count = file.read(&mut buffer[..capacity]).ok()?;
        if count == 0 {
            break;
        }
        bytes.extend_from_slice(&buffer[..count]);
    }
    check_control(control).ok()?;
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

fn inspect_author(
    path: Option<&Path>,
    expected_hash: Option<&str>,
    now: &str,
    control: Option<&Control<'_>>,
) -> Value {
    author::inspect_author(path, expected_hash, now, control)
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

fn inspect_release(
    path: Option<&Path>,
    expected_hash: Option<&str>,
    control: Option<&Control<'_>>,
    environment: &std::collections::BTreeMap<String, String>,
    observed_at: &str,
) -> Value {
    let Some(path) = path else {
        return blocked_release(RELEASE_PATH_MISSING);
    };
    let bytes = match read_pinned(path, 256 * 1024, control) {
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
    let configuration = value
        .as_ref()
        .map(|value| &value["version"])
        .unwrap_or(&Value::Null);
    let number = configuration.as_f64();
    let version = if number
        .is_some_and(|v| v.is_finite() && v.fract() == 0.0 && v.abs() <= 9_007_199_254_740_991.0)
    {
        json!(number.unwrap_or(0.0) as i64)
    } else {
        Value::Null
    };
    let backend = value
        .as_ref()
        .and_then(|v| v["backend"]["kind"].as_str())
        .map(|s| json!(s))
        .unwrap_or_else(|| {
            if configuration.as_f64() == Some(1.0) {
                json!("local-file")
            } else {
                Value::Null
            }
        });
    let is_v3 = version == json!(3) && backend == "external-kms-command";
    if is_v3 {
        let Some(resolved) = resolve_path(path) else {
            return blocked_release(RELEASE_FILE_INVALID);
        };
        return release_v3::inspect_release_v3(
            &bytes,
            &resolved,
            expected_hash,
            environment,
            observed_at,
            control,
        );
    }
    let mut report = blocked_release(
        "research_execution_release_attestor_external_kms_v3_configuration_required",
    );
    report["configured"] = json!(true);
    report["observedConfigurationFileHash"] = json!(bytes_hash(&bytes));
    report["configurationVersion"] = version;
    report["backendKind"] = backend;

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
    inspect_with_control(
        author_path,
        author_expected_hash,
        release_path,
        release_expected_hash,
        observed_at,
        None,
        &std::collections::BTreeMap::new(),
    )
}
/// Passive inspection under the caller's original cancellation and deadline.
pub fn inspect_external_authority_intake_with_cancellation_v1(
    author_path: Option<&Path>,
    author_expected_hash: Option<&str>,
    release_path: Option<&Path>,
    release_expected_hash: Option<&str>,
    observed_at: &str,
    cancelled: &AtomicBool,
    deadline: Instant,
) -> Result<Value, ExternalAuthorityIntakeError> {
    let control = Control {
        cancelled,
        deadline,
    };
    inspect_with_control(
        author_path,
        author_expected_hash,
        release_path,
        release_expected_hash,
        observed_at,
        Some(&control),
        &std::collections::BTreeMap::new(),
    )
}
/// The ordinary descriptor identity retains the incumbent restricted base
/// environment. This passive API never executes either configured command.
pub fn inspect_external_authority_intake_with_environment_v1(
    author_path: Option<&Path>,
    author_expected_hash: Option<&str>,
    release_path: Option<&Path>,
    release_expected_hash: Option<&str>,
    observed_at: &str,
    environment: &std::collections::BTreeMap<String, String>,
    original_control: (&AtomicBool, Instant),
) -> Result<Value, ExternalAuthorityIntakeError> {
    let control = Control {
        cancelled: original_control.0,
        deadline: original_control.1,
    };
    inspect_with_control(
        author_path,
        author_expected_hash,
        release_path,
        release_expected_hash,
        observed_at,
        Some(&control),
        environment,
    )
}

fn inspect_with_control(
    author_path: Option<&Path>,
    author_expected_hash: Option<&str>,
    release_path: Option<&Path>,
    release_expected_hash: Option<&str>,
    observed_at: &str,
    control: Option<&Control<'_>>,
    environment: &std::collections::BTreeMap<String, String>,
) -> Result<Value, ExternalAuthorityIntakeError> {
    check_control(control)?;
    if !author::is_canonical_instant(observed_at) {
        return Err(ExternalAuthorityIntakeError::Clock);
    }
    let author_path = selected_path(author_path);
    let release_path = selected_path(release_path);
    let author_hash = selected_hash(author_expected_hash);
    let release_hash = selected_hash(release_expected_hash);
    let author = inspect_author(
        author_path.as_deref(),
        author_hash.as_deref(),
        observed_at,
        control,
    );
    check_control(control)?;
    let release = inspect_release(
        release_path.as_deref(),
        release_hash.as_deref(),
        control,
        environment,
        observed_at,
    );
    check_control(control)?;
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
    let mut seen = std::collections::BTreeSet::new();
    blockers.retain(|v| seen.insert(v.to_string()));
    let ready = author["readyForRuntimeBinding"] == true
        && release["readyForLiveVerification"] == true
        && blockers.is_empty();
    let payload = json!({
        "version": 1,
        "kind": "ProductionExternalAuthorityIntakeInspection",
        "status": if ready {"production_external_authority_inputs_ready_for_live_verification"} else {"production_external_authority_inputs_required"},
        "ready": ready,
        "readyForLiveVerification": ready,
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
        "nextAction": if ready {"run_single_live_author_and_release_attestor_verification"} else {"supply_or_correct_external_authority_inputs"},
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
    check_control(control)?;
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
