//! Bounded, read-only Rust preflight for the Node submission-handoff exporter.
//!
//! This route deliberately stops before release-authority consumption or bundle
//! publication. It verifies the operator request and filesystem boundary so the
//! remaining external authority and publication gap is explicit.

#![forbid(unsafe_code)]

use crate::journal_connector_coverage::qualification::canonical_instant_millis;
use hepta_legacy_compatibility::{production_digest_v1, production_hash_record_v1};
use serde_json::{Value, json};
use sha2::Digest;
use std::{
    collections::BTreeSet,
    fs::{self, OpenOptions},
    io::Read,
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
};

const REQUEST_MAX_BYTES: u64 = 8 * 1024 * 1024;
const SHA256_PREFIX: &str = "sha256:";
const REQUEST_KEYS: [&str; 10] = [
    "campaignId",
    "dispatchAuthorization",
    "handoff",
    "kind",
    "manifest",
    "replayGuard",
    "reviewedSubmitPreflightPacket",
    "submissionDecisionPacket",
    "submissionHandoffExportRequestHash",
    "version",
];

pub const SUBMISSION_HANDOFF_EXPORT_USAGE: &str = "submission-handoff-export --campaign-id ID --bundle-root ABSOLUTE_PATH --request ABSOLUTE_JSON_PATH [--root ABSOLUTE_PATH] [--runtime-root ABSOLUTE_PATH]\n  Performs a bounded read-only request/layout preflight. Bundle publication requires the external release and submission authorities and is not performed by this Rust route.";

#[derive(Clone, Debug)]
pub struct SubmissionHandoffExportOptions {
    pub campaign_id: String,
    pub bundle_root: PathBuf,
    pub request_path: PathBuf,
    pub root: Option<PathBuf>,
    pub runtime_root: Option<PathBuf>,
    pub action: String,
    pub help: bool,
}

fn absolute(value: &str, name: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(value);
    if !path.is_absolute() {
        return Err(format!(
            "submission_handoff_export_{name}_absolute_path_required"
        ));
    }
    Ok(path)
}

pub fn parse_submission_handoff_export_arguments(
    args: &[String],
) -> Result<SubmissionHandoffExportOptions, String> {
    let mut campaign_id = None;
    let mut bundle_root = None;
    let mut request_path = None;
    let mut root = None;
    let mut runtime_root = None;
    let mut action = "inspect".to_owned();
    let mut help = false;
    let mut index = 0;
    while index < args.len() {
        let token = args[index].as_str();
        match token {
            "--help" if !help => {
                help = true;
                index += 1;
            }
            "--campaign-id" if index + 1 < args.len() && campaign_id.is_none() => {
                campaign_id = Some(args[index + 1].clone());
                index += 2;
            }
            "--bundle-root" if index + 1 < args.len() && bundle_root.is_none() => {
                bundle_root = Some(PathBuf::from(&args[index + 1]));
                index += 2;
            }
            "--request" if index + 1 < args.len() && request_path.is_none() => {
                request_path = Some(PathBuf::from(&args[index + 1]));
                index += 2;
            }
            "--root" if index + 1 < args.len() && root.is_none() => {
                root = Some(PathBuf::from(&args[index + 1]));
                index += 2;
            }
            "--runtime-root" if index + 1 < args.len() && runtime_root.is_none() => {
                runtime_root = Some(PathBuf::from(&args[index + 1]));
                index += 2;
            }
            "--action" if index + 1 < args.len() && action == "inspect" => {
                action = args[index + 1].clone();
                index += 2;
            }
            _ => {
                return Err(format!(
                    "unsupported_submission_handoff_export_argument:{token}"
                ));
            }
        }
    }
    if help {
        return Ok(SubmissionHandoffExportOptions {
            campaign_id: String::new(),
            bundle_root: PathBuf::new(),
            request_path: PathBuf::new(),
            root,
            runtime_root,
            action,
            help,
        });
    }
    if action != "inspect" && action != "export" {
        return Err(format!("submission_handoff_export_action_invalid:{action}"));
    }
    let campaign_id = campaign_id
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "submission_handoff_export_campaign_id_required".to_owned())?;
    let bundle_root = absolute(
        bundle_root
            .as_deref()
            .ok_or_else(|| "submission_handoff_export_bundle_root_required".to_owned())?
            .to_str()
            .ok_or_else(|| "submission_handoff_export_bundle_root_utf8_required".to_owned())?,
        "bundle_root",
    )?;
    let request_path = absolute(
        request_path
            .as_deref()
            .ok_or_else(|| "submission_handoff_export_request_path_required".to_owned())?
            .to_str()
            .ok_or_else(|| "submission_handoff_export_request_path_utf8_required".to_owned())?,
        "request_path",
    )?;
    for (name, path) in [("root", &root), ("runtime_root", &runtime_root)] {
        if let Some(path) = path
            && !path.is_absolute()
        {
            return Err(format!(
                "submission_handoff_export_{name}_absolute_path_required"
            ));
        }
    }
    Ok(SubmissionHandoffExportOptions {
        campaign_id,
        bundle_root,
        request_path,
        root,
        runtime_root,
        action,
        help,
    })
}

fn hash(value: &Value, kind: &str) -> Option<String> {
    production_hash_record_v1(kind, value)
        .ok()
        .map(|hash| hash.as_str().to_owned())
}

fn sha256(value: &Value) -> bool {
    value.as_str().is_some_and(|text| {
        let Some(hex) = text.strip_prefix(SHA256_PREFIX) else {
            return false;
        };
        hex.len() == 64
            && hex
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    })
}

fn read_request(path: &Path) -> Result<(Value, String), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "submission_handoff_export_request_parent_missing".to_owned())?;
    let parent_meta = fs::symlink_metadata(parent)
        .map_err(|error| format!("submission_handoff_export_request_parent_unreadable:{error}"))?;
    if !parent_meta.is_dir() {
        return Err("submission_handoff_export_request_parent_not_directory".to_owned());
    }
    if fs::canonicalize(parent).ok().as_deref() != Some(parent) {
        return Err("submission_handoff_export_request_parent_symlinked".to_owned());
    }
    let mut file = OpenOptions::new();
    file.read(true)
        .custom_flags(nix::libc::O_NOFOLLOW | nix::libc::O_NONBLOCK | nix::libc::O_CLOEXEC);
    let mut handle = file
        .open(path)
        .map_err(|error| format!("submission_handoff_export_request_open_blocked:{error}"))?;
    let before = handle
        .metadata()
        .map_err(|error| format!("submission_handoff_export_request_metadata_failed:{error}"))?;
    if !before.is_file() || before.nlink() != 1 || before.len() > REQUEST_MAX_BYTES {
        return Err("submission_handoff_export_request_file_identity_invalid".to_owned());
    }
    let mut bytes = Vec::with_capacity(before.len() as usize);
    handle
        .by_ref()
        .take(REQUEST_MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("submission_handoff_export_request_read_failed:{error}"))?;
    let after = handle
        .metadata()
        .map_err(|error| format!("submission_handoff_export_request_metadata_failed:{error}"))?;
    let parent_after = fs::symlink_metadata(parent)
        .map_err(|error| format!("submission_handoff_export_request_parent_unreadable:{error}"))?;
    if before.dev() != after.dev()
        || before.ino() != after.ino()
        || before.mode() != after.mode()
        || before.nlink() != after.nlink()
        || before.len() != after.len()
        || before.mtime() != after.mtime()
        || before.mtime_nsec() != after.mtime_nsec()
        || parent_after.dev() != parent_meta.dev()
        || parent_after.ino() != parent_meta.ino()
        || parent_after.mode() != parent_meta.mode()
        || parent_after.nlink() != parent_meta.nlink()
        || fs::canonicalize(parent).ok().as_deref() != Some(parent)
        || bytes.len() as u64 > REQUEST_MAX_BYTES
    {
        return Err("submission_handoff_export_request_changed_during_read".to_owned());
    }
    let value: Value = serde_json::from_slice(&bytes)
        .map_err(|_| "submission_handoff_export_request_json_invalid".to_owned())?;
    let content_hash = format!(
        "sha256:{}",
        sha2::Sha256::digest(&bytes)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    );
    Ok((value, content_hash))
}

fn paper_hash(value: &Value, kind: &str, hash_field: &str, aliases: &[&str]) -> Option<String> {
    let mut payload = value.clone();
    let map = payload.as_object_mut()?;
    map.remove(hash_field);
    for alias in aliases {
        map.remove(*alias);
    }
    map.remove("semanticIdentityVersion");
    map.remove("semanticIdentityHash");
    let envelope = serde_json::json!({
        "version": 1,
        "kind": kind,
        "payload": payload,
    });
    production_digest_v1(&envelope)
        .ok()
        .map(|digest| digest.as_str().to_owned())
}

fn verify_component_record(
    blockers: &mut Vec<String>,
    name: &str,
    record: &Value,
    kind: &str,
    hash_field: &str,
    aliases: &[&str],
) {
    let Some(object) = record.as_object() else {
        blockers.push(format!("submission_handoff_export_{name}_required"));
        return;
    };
    let Some(record_hash) = object.get(hash_field).and_then(Value::as_str) else {
        blockers.push(format!("submission_handoff_export_{name}_hash_invalid"));
        return;
    };
    if !sha256(&Value::String(record_hash.to_owned()))
        || Some(record_hash) != paper_hash(record, kind, hash_field, aliases).as_deref()
    {
        blockers.push(format!("submission_handoff_export_{name}_hash_invalid"));
    }
}

fn hashes_valid(record: &Value, fields: &[&str]) -> bool {
    fields.iter().all(|field| sha256(&record[*field]))
}

fn nonempty(record: &Value, field: &str) -> bool {
    record[field]
        .as_str()
        .is_some_and(|value| !value.is_empty())
}

/// Match the incumbent `requiredFieldsPresent` check for decision metadata.
///
/// The Node verifier only rejects null/undefined, the empty string, and empty
/// arrays here. It intentionally does not impose a schema on the metadata
/// object at this boundary; later authority layers own that validation.
fn required_node_field(record: &Value, field: &str) -> bool {
    let value = &record[field];
    !value.is_null()
        && !value.as_str().is_some_and(str::is_empty)
        && !value.as_array().is_some_and(Vec::is_empty)
}

/// The incumbent uses `Number.isFinite(Date.parse(String(value || '')))`. The
/// records emitted by the submission builders use ISO strings, but Date.parse
/// also accepts the common date-only, second-precision, fractional, offset,
/// and space-separated ISO spellings below. Keep this check side-effect free
/// and bounded while retaining the finite-date gate at the Rust boundary.
fn node_date_parse_finite(value: &str) -> bool {
    if canonical_instant_millis(value).is_some() {
        return true;
    }
    if value.len() == 10 {
        return canonical_instant_millis(&format!("{value}T00:00:00.000Z")).is_some();
    }
    let Some(separator) = value.as_bytes().get(10).copied() else {
        return false;
    };
    if !matches!(separator, b'T' | b' ') || value.len() < 19 {
        return false;
    }
    let mut cursor = 19;
    let mut milliseconds = String::from("000");
    if value.as_bytes().get(cursor) == Some(&b'.') {
        cursor += 1;
        let start = cursor;
        while value
            .as_bytes()
            .get(cursor)
            .is_some_and(|byte| byte.is_ascii_digit())
        {
            cursor += 1;
        }
        let digits = value.get(start..cursor).unwrap_or_default();
        if digits.is_empty() {
            return false;
        }
        milliseconds = format!("{digits:0<3}");
        milliseconds.truncate(3);
    }
    let timezone = value.get(cursor..).unwrap_or_default();
    let offset_minutes = if timezone.is_empty() || timezone == "Z" {
        0_i64
    } else if timezone.len() == 6
        && matches!(timezone.as_bytes().first(), Some(b'+' | b'-'))
        && timezone.as_bytes().get(3) == Some(&b':')
        && timezone[1..3].bytes().all(|byte| byte.is_ascii_digit())
        && timezone[4..].bytes().all(|byte| byte.is_ascii_digit())
    {
        let hours = match timezone[1..3].parse::<i64>() {
            Ok(value) => value,
            Err(_) => return false,
        };
        let minutes = match timezone[4..].parse::<i64>() {
            Ok(value) => value,
            Err(_) => return false,
        };
        if hours > 23 || minutes > 59 {
            return false;
        }
        let signed = hours * 60 + minutes;
        if timezone.starts_with('-') {
            -signed
        } else {
            signed
        }
    } else {
        return false;
    };
    let mut prefix = value[..19].to_owned();
    prefix.replace_range(10..11, "T");
    let normalized = format!("{prefix}.{milliseconds}Z");
    let Some(base) = canonical_instant_millis(&normalized) else {
        return false;
    };
    let Some(offset_millis) = offset_minutes.checked_mul(60_000) else {
        return false;
    };
    base.checked_sub(offset_millis).is_some()
}

fn verify_nested_contracts(value: &Value, blockers: &mut Vec<String>) {
    let decision = &value["submissionDecisionPacket"];
    let confirmed = decision["humanConfirmedFields"]
        .as_array()
        .map(|items| {
            let mut values = items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect::<Vec<_>>();
            values.sort();
            values.dedup();
            values
        })
        .unwrap_or_default();
    let expected_confirmed = [
        "abstract",
        "anonymity",
        "authors",
        "checklist",
        "conflicts",
        "coverLetter",
        "keywords",
        "subjectAreas",
        "supplements",
        "title",
        "track",
    ]
    .into_iter()
    .map(str::to_owned)
    .collect::<Vec<_>>();
    if decision["version"] != 1
        || !nonempty(decision, "paperId")
        || !required_node_field(decision, "metadata")
        || !nonempty(decision, "reviewedBy")
        || !nonempty(decision, "reviewedAt")
        || decision["reviewActorType"] != "human"
        || decision["machineSuggestionsAreAuthority"] != false
        || decision["localWorksheetGrantsAuthorization"] != false
        || decision["blockers"]
            .as_array()
            .is_none_or(|items| !items.is_empty())
        || confirmed != expected_confirmed
    {
        blockers.push("submission_handoff_export_decision_contract_invalid".to_owned());
    }
    if !decision["venueSubmissionPlanHash"].is_null()
        && !sha256(&decision["venueSubmissionPlanHash"])
    {
        blockers.push("submission_handoff_export_decision_plan_hash_invalid".to_owned());
    }

    let preflight = &value["reviewedSubmitPreflightPacket"];
    const PREFLIGHT_HASHES: [&str; 12] = [
        "approvalHash",
        "artifactPackageHash",
        "freshVenueEvidenceBundleHash",
        "independentRefereeAuthorityReceiptHash",
        "liveSubmissionAuthorizationReceiptHash",
        "manifestHash",
        "manuscriptPromotionGateHash",
        "outboxHash",
        "replayGuardHash",
        "reviewedSubmissionDecisionPacketHash",
        "semanticPromotionLockHash",
        "venueSubmissionPlanHash",
    ];
    if !hashes_valid(preflight, &PREFLIGHT_HASHES)
        || preflight["blockers"]
            .as_array()
            .is_none_or(|items| !items.is_empty())
        || preflight["safety"]["preflightOnly"] != true
        || preflight["safety"]["grantsLiveExecutionInsideOverlay"] != false
        || preflight["safety"]["requiresExternalExecutor"] != true
        || preflight["safety"]["dualControlAuthorizationVerified"] != true
        || preflight["safety"]["externalActionPerformed"] != false
    {
        blockers.push("submission_handoff_export_preflight_contract_invalid".to_owned());
    }

    let dispatch = &value["dispatchAuthorization"];
    const DISPATCH_HASHES: [&str; 13] = [
        "actionScopeKey",
        "artifactPackageHash",
        "controlledExecutorReceiptHash",
        "dispatchCycleHash",
        "executorCapabilitiesHash",
        "executorDescriptorHash",
        "liveAuthorizationHash",
        "outboxHash",
        "preflightHash",
        "providerCapabilityVerificationReceiptHash",
        "replayGuardHash",
        "replayKey",
        "reviewedSubmissionDecisionPacketHash",
    ];
    let expected_artifacts = dispatch["expectedArtifactHashes"].as_array();
    let mut sorted_artifacts = expected_artifacts
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let mut unique_artifacts = sorted_artifacts.clone();
    unique_artifacts.sort();
    unique_artifacts.dedup();
    sorted_artifacts.sort();
    if !hashes_valid(dispatch, &DISPATCH_HASHES)
        || expected_artifacts.is_none()
        || sorted_artifacts.is_empty()
        || sorted_artifacts
            .iter()
            .any(|hash| !sha256(&Value::String(hash.clone())))
        || sorted_artifacts != unique_artifacts
        || dispatch["attempt"]
            .as_i64()
            .is_none_or(|attempt| attempt <= 0)
        || !nonempty(dispatch, "executorId")
        || !nonempty(dispatch, "provider")
        || !nonempty(dispatch, "accountId")
        || !nonempty(dispatch, "nonce")
        || !nonempty(dispatch, "portalRoute")
        || dispatch["responseDueAt"]
            .as_str()
            .is_none_or(|value| !node_date_parse_finite(value))
        || dispatch["blockers"]
            .as_array()
            .is_none_or(|items| !items.is_empty())
    {
        blockers.push("submission_handoff_export_dispatch_contract_invalid".to_owned());
    }
}

fn verify_request(value: &Value, expected_campaign: &str) -> Vec<String> {
    let mut blockers = Vec::new();
    let Some(object) = value.as_object() else {
        return vec!["submission_handoff_export_request_object_required".to_owned()];
    };
    let actual = object.keys().map(String::as_str).collect::<BTreeSet<_>>();
    let expected = REQUEST_KEYS.into_iter().collect::<BTreeSet<_>>();
    if actual != expected {
        blockers.push("submission_handoff_export_request_shape_invalid".to_owned());
    }
    if value["version"] != 1 || value["kind"] != "SubmissionHandoffExportRequest" {
        blockers.push("submission_handoff_export_request_contract_invalid".to_owned());
    }
    if value["campaignId"].as_str().unwrap_or("").trim().is_empty() {
        blockers.push("submission_handoff_export_request_campaign_required".to_owned());
    }
    if value["campaignId"] != expected_campaign {
        blockers.push("submission_handoff_export_campaign_mismatch".to_owned());
    }
    let mut payload = value.clone();
    if let Some(map) = payload.as_object_mut() {
        map.remove("submissionHandoffExportRequestHash");
    }
    if value["submissionHandoffExportRequestHash"].as_str()
        != hash(&payload, "SubmissionHandoffExportRequest").as_deref()
    {
        blockers.push("submission_handoff_export_request_hash_invalid".to_owned());
    }

    verify_component_record(
        &mut blockers,
        "manifest",
        &value["manifest"],
        "PaperActionManifest",
        "manifestHash",
        &["hash"],
    );
    if value["manifest"]["kind"] != "PaperActionManifest"
        || value["manifest"]["status"] != "ready_for_adapter"
        || value["manifest"]["readyForAdapter"] != true
        || value["manifest"]["action"] != "reviewed-submit"
    {
        blockers.push("submission_handoff_export_manifest_not_ready".to_owned());
    }
    if value["manifest"]["safety"]["executesExternalAction"] != false {
        blockers.push("submission_handoff_export_manifest_safety_invalid".to_owned());
    }
    if !value["manifest"]["hash"].is_null()
        && value["manifest"]["hash"] != value["manifest"]["manifestHash"]
    {
        blockers.push("submission_handoff_export_manifest_hash_alias_invalid".to_owned());
    }

    verify_component_record(
        &mut blockers,
        "handoff",
        &value["handoff"],
        "PaperHandoffEnvelope",
        "envelopeHash",
        &[],
    );
    if value["handoff"]["kind"] != "PaperHandoffEnvelope"
        || value["handoff"]["status"] != "dry_run_ready"
        || value["handoff"]["readyForExecution"] != false
    {
        blockers.push("submission_handoff_export_handoff_not_ready".to_owned());
    }
    if value["handoff"]["manifestHash"] != value["manifest"]["manifestHash"] {
        blockers.push("submission_handoff_export_handoff_binding_invalid".to_owned());
    }
    if value["handoff"]["safety"]["executesExternalAction"] != false {
        blockers.push("submission_handoff_export_handoff_safety_invalid".to_owned());
    }

    verify_component_record(
        &mut blockers,
        "replay_guard",
        &value["replayGuard"],
        "SubmissionReplayGuard",
        "submissionReplayGuardHash",
        &[],
    );
    if value["replayGuard"]["kind"] != "SubmissionReplayGuard"
        || value["replayGuard"]["status"] != "dry_run_replay_allowed"
        || value["replayGuard"]["manifestHash"] != value["manifest"]["manifestHash"]
    {
        blockers.push("submission_handoff_export_replay_guard_not_ready".to_owned());
    }
    if value["replayGuard"]["safety"]["grantsExecutionPermission"] != false
        || value["replayGuard"]["safety"]["externalActionPerformed"] != false
    {
        blockers.push("submission_handoff_export_replay_guard_safety_invalid".to_owned());
    }

    verify_component_record(
        &mut blockers,
        "preflight",
        &value["reviewedSubmitPreflightPacket"],
        "ReviewedSubmitPreflightPacket",
        "reviewedSubmitPreflightPacketHash",
        &[],
    );
    if value["reviewedSubmitPreflightPacket"]["kind"] != "ReviewedSubmitPreflightPacket"
        || value["reviewedSubmitPreflightPacket"]["status"]
            != "reviewed_submit_preflight_ready_for_external_executor"
        || value["reviewedSubmitPreflightPacket"]["externalExecutorHandoffReady"] != true
        || value["reviewedSubmitPreflightPacket"]["liveExecutorBoundaryBlocked"] != false
    {
        blockers.push("submission_handoff_export_preflight_not_ready".to_owned());
    }
    if value["reviewedSubmitPreflightPacket"]["manifestHash"] != value["manifest"]["manifestHash"]
        || value["reviewedSubmitPreflightPacket"]["replayGuardHash"]
            != value["replayGuard"]["submissionReplayGuardHash"]
        || value["reviewedSubmitPreflightPacket"]["safety"]["externalActionPerformed"] != false
    {
        blockers.push("submission_handoff_export_preflight_binding_invalid".to_owned());
    }

    verify_component_record(
        &mut blockers,
        "decision",
        &value["submissionDecisionPacket"],
        "ReviewedSubmissionDecisionPacket",
        "reviewedSubmissionDecisionPacketHash",
        &[],
    );
    if value["submissionDecisionPacket"]["kind"] != "ReviewedSubmissionDecisionPacket"
        || value["submissionDecisionPacket"]["status"] != "reviewed_submission_decision_verified"
        || value["submissionDecisionPacket"]["externalActionPerformed"] != false
    {
        blockers.push("submission_handoff_export_decision_not_ready".to_owned());
    }

    verify_component_record(
        &mut blockers,
        "dispatch",
        &value["dispatchAuthorization"],
        "SubmissionDispatchAuthorization",
        "submissionDispatchAuthorizationHash",
        &[],
    );
    if value["dispatchAuthorization"]["kind"] != "SubmissionDispatchAuthorization"
        || value["dispatchAuthorization"]["status"] != "submission_dispatch_authorization_ready"
        || value["dispatchAuthorization"]["externalActionPerformed"] != false
    {
        blockers.push("submission_handoff_export_dispatch_not_ready".to_owned());
    }
    if value["dispatchAuthorization"]["preflightHash"]
        != value["reviewedSubmitPreflightPacket"]["reviewedSubmitPreflightPacketHash"]
        || value["dispatchAuthorization"]["replayGuardHash"]
            != value["replayGuard"]["submissionReplayGuardHash"]
        || value["dispatchAuthorization"]["reviewedSubmissionDecisionPacketHash"]
            != value["submissionDecisionPacket"]["reviewedSubmissionDecisionPacketHash"]
    {
        blockers.push("submission_handoff_export_dispatch_binding_invalid".to_owned());
    }

    verify_nested_contracts(value, &mut blockers);

    for (name, record) in [
        ("handoff", &value["handoff"]),
        ("replay_guard", &value["replayGuard"]),
        ("preflight", &value["reviewedSubmitPreflightPacket"]),
        ("decision", &value["submissionDecisionPacket"]),
        ("dispatch", &value["dispatchAuthorization"]),
    ] {
        if record["paperId"] != value["manifest"]["paperId"] {
            blockers.push(format!("submission_handoff_export_{name}_paper_mismatch"));
        }
        if record["taskKey"] != value["manifest"]["taskKey"] {
            blockers.push(format!("submission_handoff_export_{name}_task_mismatch"));
        }
    }

    blockers.push("submission_handoff_export_verified_release_required".to_owned());
    blockers.push("submission_handoff_export_persisted_authority_required".to_owned());
    blockers
}

fn inspect_layout(bundle_root: &Path) -> Vec<String> {
    let mut blockers = Vec::new();
    let Some(parent) = bundle_root.parent() else {
        return vec!["submission_handoff_export_bundle_root_invalid".to_owned()];
    };
    if !bundle_root.is_absolute() {
        blockers.push("submission_handoff_export_absolute_bundle_root_required".to_owned());
    }
    match fs::symlink_metadata(parent) {
        Ok(meta) if !meta.is_dir() => {
            blockers.push("submission_handoff_export_output_parent_not_directory".to_owned())
        }
        Ok(_) => {}
        Err(_) => blockers.push("submission_handoff_export_output_parent_missing".to_owned()),
    }
    match fs::symlink_metadata(bundle_root) {
        Ok(meta) if !meta.is_dir() || meta.nlink() == 0 => {
            blockers.push("submission_handoff_export_existing_bundle_root_invalid".to_owned());
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => {
            blockers.push("submission_handoff_export_existing_bundle_root_invalid".to_owned())
        }
    }
    blockers
}

pub fn inspect_submission_handoff_export_v1(
    options: &SubmissionHandoffExportOptions,
) -> Result<Value, String> {
    if options.help {
        return Ok(json!({
            "version": 1,
            "kind": "SubmissionHandoffExportUsage",
            "usage": SUBMISSION_HANDOFF_EXPORT_USAGE,
            "mutation": "bounded-read-only-preflight",
            "authoritativeInput": "operator-supplied-bound-request",
            "externalAction": "none",
            "networkUse": "none",
            "providerDispatch": "forbidden"
        }));
    }
    let mut blockers = inspect_layout(&options.bundle_root);
    let (request, request_content_hash, request_read_ok) = match read_request(&options.request_path)
    {
        Ok(value) => (value.0, value.1, true),
        Err(error) => {
            blockers.push(error);
            (Value::Null, String::new(), false)
        }
    };
    if request_read_ok {
        blockers.extend(verify_request(&request, &options.campaign_id));
    }
    blockers.sort();
    blockers.dedup();
    let ready = blockers.is_empty();
    Ok(json!({
        "version": 1,
        "kind": "SubmissionHandoffExportPreflightReceipt",
        "status": if ready { "submission_handoff_export_preflight_ready" } else { "submission_handoff_export_preflight_blocked" },
        "campaignId": options.campaign_id,
        "requestPath": options.request_path,
        "requestContentHash": if request_content_hash.is_empty() { Value::Null } else { Value::String(request_content_hash) },
        "bundleRoot": options.bundle_root,
        "root": options.root,
        "runtimeRoot": options.runtime_root,
        "blockers": blockers,
        "localFilesystemMutationPerformed": false,
        "networkActionPerformed": false,
        "providerActionPerformed": false,
        "grantsExecutionPermission": false,
        "externalActionPerformed": false,
        "publicationImplemented": false
    }))
}

pub fn execute_submission_handoff_export_v1(
    options: &SubmissionHandoffExportOptions,
) -> Result<Value, String> {
    if options.action == "export" {
        return Ok(json!({
            "version": 1,
            "kind": "SubmissionHandoffExportCommandReceipt",
            "status": "submission_handoff_export_blocked",
            "blockers": ["rust_submission_handoff_export_publication_not_ported"],
            "localFilesystemMutationPerformed": false,
            "networkActionPerformed": false,
            "providerActionPerformed": false,
            "grantsExecutionPermission": false,
            "externalActionPerformed": false
        }));
    }
    inspect_submission_handoff_export_v1(options)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        time::{SystemTime, UNIX_EPOCH},
    };

    fn temp_path(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "hepta-submission-export-{name}-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    #[test]
    fn parser_requires_absolute_operator_paths() {
        let error = parse_submission_handoff_export_arguments(&[
            "--campaign-id".into(),
            "c".into(),
            "--bundle-root".into(),
            "relative".into(),
            "--request".into(),
            "/tmp/request.json".into(),
        ])
        .unwrap_err();
        assert_eq!(
            error,
            "submission_handoff_export_bundle_root_absolute_path_required"
        );
    }

    #[test]
    fn decision_metadata_presence_matches_node_required_fields_contract() {
        let decision = json!({
            "version": 1,
            "paperId": "paper",
            "reviewedBy": "reviewer",
            "reviewedAt": "2026-08-15T00:00:00.000Z",
            "humanConfirmedFields": [
                "abstract", "anonymity", "authors", "checklist", "conflicts",
                "coverLetter", "keywords", "subjectAreas", "supplements", "title", "track"
            ],
            "reviewActorType": "human",
            "machineSuggestionsAreAuthority": false,
            "localWorksheetGrantsAuthorization": false,
            "blockers": []
        });
        assert!(!required_node_field(&decision, "metadata"));
        assert!(required_node_field(&json!({"metadata": {}}), "metadata"));
        assert!(!required_node_field(&json!({"metadata": []}), "metadata"));
        assert!(!required_node_field(&json!({"metadata": ""}), "metadata"));
        assert!(required_node_field(&json!({"metadata": 0}), "metadata"));

        let mut blockers = Vec::new();
        verify_nested_contracts(
            &json!({"submissionDecisionPacket": decision}),
            &mut blockers,
        );
        assert!(
            blockers
                .iter()
                .any(|blocker| blocker == "submission_handoff_export_decision_contract_invalid")
        );
    }

    #[test]
    fn dispatch_response_due_at_uses_finite_node_date_parse_boundary() {
        assert!(node_date_parse_finite("2026-08-15T02:00:00.000Z"));
        assert!(node_date_parse_finite("2026-08-15"));
        assert!(node_date_parse_finite("2026-08-15T02:00:00+02:30"));
        assert!(node_date_parse_finite("2026-08-15 02:00:00"));
        assert!(!node_date_parse_finite("not-a-date"));
        assert!(!node_date_parse_finite(""));

        let valid_hash = format!("sha256:{}", "a".repeat(64));
        let dispatch = json!({
            "actionScopeKey": valid_hash.clone(),
            "artifactPackageHash": valid_hash.clone(),
            "controlledExecutorReceiptHash": valid_hash.clone(),
            "dispatchCycleHash": valid_hash.clone(),
            "executorCapabilitiesHash": valid_hash.clone(),
            "executorDescriptorHash": valid_hash.clone(),
            "liveAuthorizationHash": valid_hash.clone(),
            "outboxHash": valid_hash.clone(),
            "preflightHash": valid_hash.clone(),
            "providerCapabilityVerificationReceiptHash": valid_hash.clone(),
            "replayGuardHash": valid_hash.clone(),
            "replayKey": valid_hash.clone(),
            "reviewedSubmissionDecisionPacketHash": valid_hash.clone(),
            "expectedArtifactHashes": [valid_hash.clone()],
            "attempt": 1,
            "executorId": "executor",
            "provider": "provider",
            "accountId": "account",
            "nonce": "nonce",
            "portalRoute": "/submit",
            "responseDueAt": "not-a-date",
            "blockers": []
        });
        let mut blockers = Vec::new();
        verify_nested_contracts(&json!({"dispatchAuthorization": dispatch}), &mut blockers);
        assert!(
            blockers
                .iter()
                .any(|blocker| blocker == "submission_handoff_export_dispatch_contract_invalid")
        );
    }

    #[test]
    fn paper_manifest_hash_matches_node_record_hash_and_alias_is_ignored() {
        let payload = json!({
            "version": 1,
            "kind": "PaperActionManifest",
            "paperId": "p",
            "taskKey": "t",
            "action": "reviewed-submit",
            "status": "ready_for_adapter",
            "readyForAdapter": true,
            "payload": {
                "artifactPackageHash": format!("sha256:{}", "a".repeat(64)),
                "manuscriptPromotionGateHash": format!("sha256:{}", "b".repeat(64))
            },
            "blockers": [],
            "safety": {"executesExternalAction": false}
        });
        let mut sealed = payload.clone();
        let expected = "sha256:7f53dcd8f7342d4d4d148cdcdaf13047531873a648b2d1b108d442a1ecc3db46";
        sealed["manifestHash"] = Value::String(expected.to_owned());
        sealed["hash"] = Value::String(expected.to_owned());
        let mut blockers = Vec::new();
        verify_component_record(
            &mut blockers,
            "manifest",
            &sealed,
            "PaperActionManifest",
            "manifestHash",
            &["hash"],
        );
        assert!(blockers.is_empty(), "unexpected blockers: {blockers:?}");
    }

    #[test]
    fn null_request_is_not_treated_as_a_ready_empty_request() {
        let parent = temp_path("null");
        fs::create_dir_all(&parent).unwrap();
        fs::write(parent.join("request.json"), "null").unwrap();
        let options = SubmissionHandoffExportOptions {
            campaign_id: "campaign".into(),
            bundle_root: parent.join("bundle"),
            request_path: parent.join("request.json"),
            root: None,
            runtime_root: None,
            action: "inspect".into(),
            help: false,
        };
        let report = inspect_submission_handoff_export_v1(&options).unwrap();
        assert_eq!(
            report["status"],
            "submission_handoff_export_preflight_blocked"
        );
        assert!(
            report["blockers"]
                .as_array()
                .unwrap()
                .iter()
                .any(|value| value == "submission_handoff_export_request_object_required")
        );
        let _ = fs::remove_dir_all(parent);
    }

    #[test]
    fn missing_request_fails_closed_without_mutation() {
        let bundle_parent = temp_path("parent");
        fs::create_dir_all(&bundle_parent).unwrap();
        let options = SubmissionHandoffExportOptions {
            campaign_id: "campaign".into(),
            bundle_root: bundle_parent.join("bundle"),
            request_path: bundle_parent.join("missing.json"),
            root: None,
            runtime_root: None,
            action: "inspect".into(),
            help: false,
        };
        let report = inspect_submission_handoff_export_v1(&options).unwrap();
        assert_eq!(
            report["status"],
            "submission_handoff_export_preflight_blocked"
        );
        assert_eq!(report["localFilesystemMutationPerformed"], false);
        assert!(report["blockers"].as_array().unwrap().iter().any(|v| {
            v.as_str()
                .unwrap_or("")
                .starts_with("submission_handoff_export_request_open_blocked:")
        }));
        let _ = fs::remove_dir_all(bundle_parent);
    }
}
