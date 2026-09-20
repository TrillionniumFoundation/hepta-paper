//! Bounded, read-only Rust preflight for the Node submission-handoff exporter.
//!
//! This route deliberately stops before release-authority consumption or bundle
//! publication. It verifies the operator request and filesystem boundary so the
//! remaining external authority and publication gap is explicit.

#![forbid(unsafe_code)]

use hepta_legacy_compatibility::production_hash_record_v1;
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
    if before.dev() != after.dev()
        || before.ino() != after.ino()
        || before.mode() != after.mode()
        || before.len() != after.len()
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
    for (name, field) in [
        ("manifest", "manifestHash"),
        ("handoff", "envelopeHash"),
        ("replayGuard", "submissionReplayGuardHash"),
        (
            "reviewedSubmitPreflightPacket",
            "reviewedSubmitPreflightPacketHash",
        ),
        (
            "submissionDecisionPacket",
            "reviewedSubmissionDecisionPacketHash",
        ),
        (
            "dispatchAuthorization",
            "submissionDispatchAuthorizationHash",
        ),
    ] {
        let value = &value[field_name(name)];
        if !value.is_object() {
            blockers.push(format!("submission_handoff_export_{name}_required"));
        } else if !sha256(&value[field]) {
            blockers.push(format!("submission_handoff_export_{name}_hash_invalid"));
        }
    }
    blockers.push("submission_handoff_export_verified_release_required".to_owned());
    blockers.push("submission_handoff_export_persisted_authority_required".to_owned());
    blockers
}

fn field_name(name: &str) -> &str {
    name
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
    if let Ok(meta) = fs::symlink_metadata(bundle_root)
        && (!meta.is_dir() || meta.nlink() == 0)
    {
        blockers.push("submission_handoff_export_existing_bundle_root_invalid".to_owned());
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
    let (request, request_content_hash) = match read_request(&options.request_path) {
        Ok(value) => value,
        Err(error) => {
            blockers.push(error);
            (Value::Null, String::new())
        }
    };
    if !request.is_null() {
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
