//! Bounded Rust inspection of the dispatcher challenge exchange.
//!
//! This module ports the local, read-only challenge part of
//! `autonomous-submission-dispatcher-challenge`.  It deliberately does not
//! treat a challenge as a signed dispatcher cycle, a portal canary, or a
//! handoff cutover. Those authority-bearing stages remain explicit blockers.

#![forbid(unsafe_code)]

use hepta_legacy_compatibility::production_hash_record_v1;
use serde_json::{Value, json};
use std::{
    fs::{self, OpenOptions},
    io::Read,
    os::unix::{fs::MetadataExt, fs::OpenOptionsExt},
    path::{Path, PathBuf},
};

const MAX_DOCUMENT_BYTES: u64 = 1024 * 1024;
const CHALLENGE_KEYS: [&str; 11] = [
    "challengedAt",
    "challengeHash",
    "expiresAt",
    "idempotencyKey",
    "kind",
    "planHash",
    "portalConfigurationHash",
    "portalDescriptorHash",
    "portalId",
    "status",
    "version",
];

#[derive(Debug, Clone, Copy, Eq, PartialEq)]
pub enum ChallengeInspectionError {
    InvalidArguments,
    UnsafeExchange,
    Hash,
}
impl std::fmt::Display for ChallengeInspectionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::InvalidArguments => {
                "autonomous_submission_dispatcher_challenge_arguments_invalid"
            }
            Self::UnsafeExchange => "autonomous_submission_dispatcher_exchange_directory_unsafe",
            Self::Hash => "autonomous_submission_dispatcher_challenge_hash_failed",
        })
    }
}
impl std::error::Error for ChallengeInspectionError {}

fn hash(value: &Value) -> Result<String, ChallengeInspectionError> {
    production_hash_record_v1("AutonomousSubmissionDispatcherChallenge", value)
        .map(|value| value.as_str().to_owned())
        .map_err(|_| ChallengeInspectionError::Hash)
}

fn sha(value: Option<&Value>) -> bool {
    value.and_then(Value::as_str).is_some_and(|value| {
        value.len() == 71
            && value.starts_with("sha256:")
            && value[7..]
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    })
}

fn identifier(value: Option<&Value>) -> bool {
    let Some(value) = value.and_then(Value::as_str) else {
        return false;
    };
    (3..=192).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._:@/-".contains(&byte))
        && value
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphanumeric)
}

fn instant(value: Option<&Value>) -> Option<i64> {
    crate::journal_connector_coverage::qualification::canonical_instant_millis(value?.as_str()?)
}

fn read_document(path: &Path) -> Result<Value, ChallengeInspectionError> {
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(nix::libc::O_NOFOLLOW | nix::libc::O_NONBLOCK | nix::libc::O_CLOEXEC)
        .open(path)
        .map_err(|_| ChallengeInspectionError::UnsafeExchange)?;
    let before = file
        .metadata()
        .map_err(|_| ChallengeInspectionError::UnsafeExchange)?;
    if !before.is_file()
        || before.nlink() != 1
        || before.len() < 2
        || before.len() > MAX_DOCUMENT_BYTES
    {
        return Err(ChallengeInspectionError::UnsafeExchange);
    }
    let mut bytes = Vec::new();
    (&file)
        .take(MAX_DOCUMENT_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| ChallengeInspectionError::UnsafeExchange)?;
    let after = file
        .metadata()
        .map_err(|_| ChallengeInspectionError::UnsafeExchange)?;
    if bytes.len() as u64 != before.len()
        || before.dev() != after.dev()
        || before.ino() != after.ino()
        || before.mode() != after.mode()
        || before.mtime() != after.mtime()
        || before.mtime_nsec() != after.mtime_nsec()
    {
        return Err(ChallengeInspectionError::UnsafeExchange);
    }
    let value: Value =
        serde_json::from_slice(&bytes).map_err(|_| ChallengeInspectionError::UnsafeExchange)?;
    if !value.is_object() {
        return Err(ChallengeInspectionError::UnsafeExchange);
    }
    Ok(value)
}

fn verify_challenge(value: &Value, now_millis: i64, expected: [&str; 5]) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };
    if object.len() != CHALLENGE_KEYS.len()
        || !CHALLENGE_KEYS.iter().all(|key| object.contains_key(*key))
        || value["version"] != 1
        || value["kind"] != "AutonomousSubmissionDispatcherChallenge"
        || value["status"] != "autonomous_submission_dispatcher_challenge_pending"
        || !sha(value.get("planHash"))
        || !sha(value.get("idempotencyKey"))
        || !identifier(value.get("portalId"))
        || !sha(value.get("portalConfigurationHash"))
        || !sha(value.get("portalDescriptorHash"))
    {
        return false;
    }
    let challenged = instant(value.get("challengedAt"));
    let expires = instant(value.get("expiresAt"));
    if challenged.is_none()
        || expires.is_none()
        || expires <= challenged
        || challenged > Some(now_millis)
        || expires <= Some(now_millis)
    {
        return false;
    }
    if expected
        .iter()
        .zip([
            "planHash",
            "idempotencyKey",
            "portalId",
            "portalConfigurationHash",
            "portalDescriptorHash",
        ])
        .any(|(expected, key)| !expected.is_empty() && value[key].as_str() != Some(*expected))
    {
        return false;
    }
    let mut payload = value.clone();
    let Some(payload_object) = payload.as_object_mut() else {
        return false;
    };
    payload_object.remove("challengeHash");
    hash(&payload).ok() == value["challengeHash"].as_str().map(str::to_owned)
}

fn exchange_dir(runtime_root: &Path) -> Result<PathBuf, ChallengeInspectionError> {
    if let Ok(metadata) = fs::symlink_metadata(runtime_root)
        && (!metadata.is_dir()
            || metadata.file_type().is_symlink()
            || fs::canonicalize(runtime_root)
                .map_err(|_| ChallengeInspectionError::UnsafeExchange)?
                != runtime_root)
    {
        return Err(ChallengeInspectionError::UnsafeExchange);
    }
    let base = runtime_root.join("autonomous-research/submission-handoff");
    let metadata = match fs::symlink_metadata(&base) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(base.join("dispatcher-challenges"));
        }
        Err(_) => return Err(ChallengeInspectionError::UnsafeExchange),
    };
    if !metadata.is_dir()
        || metadata.file_type().is_symlink()
        || metadata.mode() & 0o002 != 0
        || fs::canonicalize(&base).map_err(|_| ChallengeInspectionError::UnsafeExchange)? != base
    {
        return Err(ChallengeInspectionError::UnsafeExchange);
    }
    let directory = base.join("dispatcher-challenges");
    let metadata = fs::symlink_metadata(&directory);
    if let Ok(metadata) = metadata
        && (!metadata.is_dir() || metadata.file_type().is_symlink())
    {
        return Err(ChallengeInspectionError::UnsafeExchange);
    }
    if directory.exists()
        && fs::canonicalize(&directory).map_err(|_| ChallengeInspectionError::UnsafeExchange)?
            != directory
    {
        return Err(ChallengeInspectionError::UnsafeExchange);
    }
    Ok(directory)
}

fn challenge_from_exchange(
    runtime_root: &Path,
    now_millis: i64,
    expected: [&str; 5],
) -> Result<Option<Value>, ChallengeInspectionError> {
    let directory = exchange_dir(runtime_root)?;
    if !directory.exists() {
        return Ok(None);
    }
    let mut best: Option<(i64, Value)> = None;
    for entry in fs::read_dir(directory).map_err(|_| ChallengeInspectionError::UnsafeExchange)? {
        let entry = entry.map_err(|_| ChallengeInspectionError::UnsafeExchange)?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.len() != 69
            || !name.ends_with(".json")
            || !name[..64]
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        {
            continue;
        }
        let value = match read_document(&entry.path()) {
            Ok(value) => value,
            Err(_) => continue,
        };
        if !verify_challenge(&value, now_millis, expected) {
            continue;
        }
        let challenged = instant(value.get("challengedAt")).unwrap_or(i64::MIN);
        if best.as_ref().is_none_or(|(at, _)| challenged > *at) {
            best = Some((challenged, value));
        }
    }
    Ok(best.map(|(_, value)| value))
}

#[derive(Clone, Debug)]
pub struct AutonomousSubmissionDispatcherChallengeOptions {
    pub runtime_root: PathBuf,
    pub now_millis: i64,
    pub plan_hash: Option<String>,
    pub idempotency_key: Option<String>,
    pub portal_id: Option<String>,
    pub portal_configuration_hash: Option<String>,
    pub portal_descriptor_hash: Option<String>,
}

/// Inspect the local challenge exchange without signing, publishing, or using
/// a portal. The returned blockers identify the authority-bearing stages that
/// this bounded Rust route does not yet own.
pub fn inspect_autonomous_submission_dispatcher_challenge_v1(
    options: &AutonomousSubmissionDispatcherChallengeOptions,
) -> Result<Value, ChallengeInspectionError> {
    let expected = [
        options.plan_hash.as_deref().unwrap_or(""),
        options.idempotency_key.as_deref().unwrap_or(""),
        options.portal_id.as_deref().unwrap_or(""),
        options.portal_configuration_hash.as_deref().unwrap_or(""),
        options.portal_descriptor_hash.as_deref().unwrap_or(""),
    ];
    let challenge = challenge_from_exchange(&options.runtime_root, options.now_millis, expected)?;
    let mut blockers = Vec::new();
    if options.portal_id.is_none()
        || options.portal_configuration_hash.is_none()
        || options.portal_descriptor_hash.is_none()
    {
        blockers.push("autonomous_submission_dispatcher_portal_binding_not_ready");
    }
    if challenge.is_none() {
        blockers.push("autonomous_submission_dispatcher_challenge_missing");
    }
    blockers.extend([
        "autonomous_submission_dispatcher_identity_not_ready",
        "autonomous_submission_dispatcher_cycle_missing",
        "autonomous_submission_dispatcher_portal_canary_not_independently_verified",
        "autonomous_submission_handoff_not_ready",
    ]);
    let ready = false;
    Ok(json!({
        "version": 1,
        "kind": "AutonomousSubmissionDispatcherReadinessInspection",
        "status": "autonomous_submission_dispatcher_blocked",
        "ready": ready,
        "handoffReady": false,
        "planHash": challenge.as_ref().and_then(|v| v["planHash"].clone().as_str().map(str::to_owned)).or(options.plan_hash.clone()),
        "idempotencyKey": challenge.as_ref().and_then(|v| v["idempotencyKey"].clone().as_str().map(str::to_owned)).or(options.idempotency_key.clone()),
        "challengeHash": challenge.as_ref().and_then(|v| v["challengeHash"].clone().as_str().map(str::to_owned)),
        "cycleReceiptHash": Value::Null,
        "dispatcherPrincipalId": Value::Null,
        "dispatcherIdentityConfigurationHash": Value::Null,
        "signatureVerified": false,
        "portalId": challenge.as_ref().and_then(|v| v["portalId"].clone().as_str().map(str::to_owned)).or(options.portal_id.clone()),
        "portalConfigurationHash": challenge.as_ref().and_then(|v| v["portalConfigurationHash"].clone().as_str().map(str::to_owned)).or(options.portal_configuration_hash.clone()),
        "portalDescriptorHash": challenge.as_ref().and_then(|v| v["portalDescriptorHash"].clone().as_str().map(str::to_owned)).or(options.portal_descriptor_hash.clone()),
        "portalBindingVerified": false,
        "livePortalCanaryVerified": false,
        "portalConfigurationIdentityPinned": false,
        "portalDescriptorPinned": false,
        "portalFullProductionReady": false,
        "livePortalCanaryAuthorityIndependentFromDispatcher": false,
        "livePortalCanaryCycleVerificationReceiptHash": Value::Null,
        "livePortalCanaryIndependentVerificationReceiptHash": Value::Null,
        "signedAt": Value::Null,
        "expiresAt": Value::Null,
        "handoff": Value::Null,
        "blockers": blockers,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, os::unix::fs::PermissionsExt};

    fn hash_payload(payload: &Value) -> String {
        hash(payload).unwrap()
    }
    fn fixture(root: &Path) -> (String, String, String, String, String) {
        let plan =
            "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".to_owned();
        let idem =
            "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb".to_owned();
        let config =
            "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc".to_owned();
        let descriptor =
            "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd".to_owned();
        let challenged = "2026-09-20T00:00:00.000Z";
        let expires = "2026-09-20T01:00:00.000Z";
        let mut payload = json!({"version":1,"kind":"AutonomousSubmissionDispatcherChallenge","status":"autonomous_submission_dispatcher_challenge_pending","planHash":plan,"idempotencyKey":idem,"portalId":"portal:test","portalConfigurationHash":config,"portalDescriptorHash":descriptor,"challengedAt":challenged,"expiresAt":expires});
        let challenge_hash = hash_payload(&payload);
        payload["challengeHash"] = Value::String(challenge_hash.clone());
        let dir = root.join("autonomous-research/submission-handoff/dispatcher-challenges");
        fs::create_dir_all(&dir).unwrap();
        fs::set_permissions(root, fs::Permissions::from_mode(0o700)).unwrap();
        fs::write(
            dir.join(format!("{}.json", &challenge_hash[7..])),
            serde_json::to_vec(&payload).unwrap(),
        )
        .unwrap();
        (plan, idem, "portal:test".into(), config, descriptor)
    }
    #[test]
    fn reads_valid_challenge_and_keeps_authority_blockers() {
        let root =
            std::env::temp_dir().join(format!("hepta-dispatcher-rust-{}", std::process::id()));
        let (plan, idem, portal, config, descriptor) = fixture(&root);
        let now = 1_789_864_200_000i64;
        let report = inspect_autonomous_submission_dispatcher_challenge_v1(
            &AutonomousSubmissionDispatcherChallengeOptions {
                runtime_root: root.clone(),
                now_millis: now,
                plan_hash: Some(plan),
                idempotency_key: Some(idem),
                portal_id: Some(portal),
                portal_configuration_hash: Some(config),
                portal_descriptor_hash: Some(descriptor),
            },
        )
        .unwrap();
        assert_eq!(report["ready"], false);
        assert!(report["challengeHash"].is_string());
        assert!(
            report["blockers"]
                .as_array()
                .unwrap()
                .iter()
                .any(|v| v == "autonomous_submission_dispatcher_identity_not_ready")
        );
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn rejects_expired_or_tampered_challenge() {
        let root = std::env::temp_dir().join(format!(
            "hepta-dispatcher-rust-expired-{}",
            std::process::id()
        ));
        let (plan, idem, portal, config, descriptor) = fixture(&root);
        let report = inspect_autonomous_submission_dispatcher_challenge_v1(
            &AutonomousSubmissionDispatcherChallengeOptions {
                runtime_root: root.clone(),
                now_millis: 1_790_190_000_000,
                plan_hash: Some(plan),
                idempotency_key: Some(idem),
                portal_id: Some(portal),
                portal_configuration_hash: Some(config),
                portal_descriptor_hash: Some(descriptor),
            },
        )
        .unwrap();
        assert_eq!(report["challengeHash"], Value::Null);
        assert!(
            report["blockers"]
                .as_array()
                .unwrap()
                .iter()
                .any(|v| v == "autonomous_submission_dispatcher_challenge_missing")
        );
        fs::remove_dir_all(root).unwrap();
    }
}
