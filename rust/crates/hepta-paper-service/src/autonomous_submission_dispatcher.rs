//! Bounded, read-only Rust preflight for the resident submission dispatcher.
//!
//! The incumbent Node route owns credentialed portal delivery, handoff-store
//! mutation and signed cycle publication.  Rust only observes the local
//! challenge exchange here and reports those authority-bearing stages as
//! explicit blockers.  In particular, this module never opens a portal,
//! executes a resident loop, or writes the handoff store.

#![forbid(unsafe_code)]

use serde_json::{Value, json};
use std::{
    collections::BTreeSet,
    fs::{self, OpenOptions},
    os::unix::fs::MetadataExt,
    path::{Path, PathBuf},
};

pub const AUTONOMOUS_SUBMISSION_DISPATCHER_USAGE: &str = r#"{
  "version": 1,
  "kind": "AutonomousSubmissionDispatcherUsage",
  "usage": "hepta-paper operator autonomous-submission-dispatcher -- [--resident] [--campaign-id ID]",
  "securityBoundary": "Rust performs only a bounded read-only preflight; the Node resident route is the credentialed portal delivery owner",
  "externalAction": false,
  "serviceStateChanged": false,
  "semanticNotReadyExitCode": 2
}"#;

#[derive(Clone, Debug)]
pub struct AutonomousSubmissionDispatcherOptions {
    pub help: bool,
    pub resident: bool,
    pub campaign_id: Option<String>,
    pub limit: u32,
    pub poll_ms: u32,
    pub root: Option<PathBuf>,
    pub runtime_root: Option<PathBuf>,
}

impl Default for AutonomousSubmissionDispatcherOptions {
    fn default() -> Self {
        Self {
            help: false,
            resident: false,
            campaign_id: None,
            limit: 100,
            poll_ms: 30_000,
            root: None,
            runtime_root: None,
        }
    }
}

fn value(args: &[String], index: &mut usize, key: &str) -> Result<String, String> {
    if *index + 1 >= args.len() || args[*index + 1].starts_with("--") {
        return Err(format!("autonomous_submission_dispatcher_{key}_required"));
    }
    let value = args[*index + 1].clone();
    if value.is_empty() {
        return Err(format!("autonomous_submission_dispatcher_{key}_invalid"));
    }
    *index += 2;
    Ok(value)
}

fn integer(value: &str, key: &str, minimum: u32, maximum: u32) -> Result<u32, String> {
    value
        .parse::<u32>()
        .ok()
        .filter(|value| (*value >= minimum) && (*value <= maximum))
        .ok_or_else(|| format!("autonomous_submission_dispatcher_{key}_invalid"))
}

fn identifier(value: &str) -> bool {
    (1..=192).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._:@/-".contains(&byte))
        && value
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphanumeric)
}

/// Parse the incumbent option surface with duplicate and unknown-option
/// rejection.  `--key=value` is accepted by the Node strict parser as well.
pub fn parse_autonomous_submission_dispatcher_arguments(
    args: &[String],
) -> Result<AutonomousSubmissionDispatcherOptions, String> {
    let mut options = AutonomousSubmissionDispatcherOptions::default();
    let mut seen = BTreeSet::new();
    let mut index = 0;
    while index < args.len() {
        let token = args[index].as_str();
        let raw = token
            .strip_prefix("--")
            .ok_or_else(|| "unexpected_cli_positional".to_owned())?;
        let (key, inline) = raw
            .split_once('=')
            .map_or((raw, None), |(key, value)| (key, Some(value)));
        if !seen.insert(key.to_owned()) {
            return Err(format!("duplicate_cli_option:--{key}"));
        }
        match key {
            "help" => {
                if inline.is_some() {
                    return Err("boolean_cli_option_does_not_take_value:--help".into());
                }
                options.help = true;
                index += 1;
            }
            "resident" => {
                if inline.is_some() {
                    return Err("boolean_cli_option_does_not_take_value:--resident".into());
                }
                options.resident = true;
                index += 1;
            }
            "campaign-id" | "limit" | "poll-ms" | "root" | "runtime-root" => {
                let text = match inline {
                    Some(value) if !value.is_empty() => value.to_owned(),
                    Some(_) => {
                        return Err(format!("empty_cli_option_value:--{key}"));
                    }
                    None => value(args, &mut index, key)?,
                };
                match key {
                    "campaign-id" => {
                        if !identifier(&text) {
                            return Err(
                                "autonomous_submission_dispatcher_campaign_id_invalid".into()
                            );
                        }
                        options.campaign_id = Some(text);
                    }
                    "limit" => options.limit = integer(&text, "limit", 1, 1000)?,
                    "poll-ms" => options.poll_ms = integer(&text, "poll_ms", 1000, 300_000)?,
                    "root" => options.root = Some(PathBuf::from(text)),
                    "runtime-root" => options.runtime_root = Some(PathBuf::from(text)),
                    _ => unreachable!(),
                }
                if inline.is_some() {
                    index += 1;
                }
            }
            _ => return Err(format!("unknown_cli_option:--{key}")),
        }
    }
    Ok(options)
}

fn storage_observation(runtime_root: &Path) -> Value {
    let native_path = runtime_root.join("hepta-paper.sqlite");
    let handoff_path =
        runtime_root.join("autonomous-research/submission-handoff/submission-handoff.sqlite");
    fn observe(path: &Path) -> Value {
        let metadata = fs::symlink_metadata(path).ok();
        let symlink = metadata
            .as_ref()
            .is_some_and(|metadata| metadata.file_type().is_symlink());
        let regular = metadata.as_ref().is_some_and(|metadata| metadata.is_file());
        let nlink = metadata.as_ref().map(MetadataExt::nlink);
        let readable = if regular && !symlink && nlink == Some(1) {
            OpenOptions::new().read(true).open(path).is_ok()
        } else {
            false
        };
        json!({
            "path": path,
            "regular": regular,
            "symlink": symlink,
            "singleLink": nlink == Some(1),
            "readable": readable,
            "mode": metadata.as_ref().map(|metadata| metadata.mode()),
            "size": metadata.as_ref().map(|metadata| metadata.len()),
        })
    }
    json!({
        "nativeStore": observe(&native_path),
        "handoffStore": observe(&handoff_path),
        "writeVerified": false,
        "nativeStoreInaccessibleOrReadOnlyVerified": false,
    })
}

/// Observe local challenge state and return a deliberately blocked report.
pub fn inspect_autonomous_submission_dispatcher_v1(
    options: &AutonomousSubmissionDispatcherOptions,
    workspace_root: &Path,
    now_millis: i64,
) -> Result<Value, String> {
    let root = options
        .root
        .clone()
        .unwrap_or_else(|| workspace_root.to_path_buf());
    let runtime_root = options
        .runtime_root
        .clone()
        .unwrap_or_else(|| workspace_root.join("runtime"));
    if !root.is_absolute() || !runtime_root.is_absolute() || !workspace_root.is_absolute() {
        return Err("autonomous_submission_dispatcher_root_paths_must_be_absolute".into());
    }
    let challenge = crate::autonomous_submission_dispatcher_challenge::inspect_autonomous_submission_dispatcher_challenge_v1(
        &crate::autonomous_submission_dispatcher_challenge::AutonomousSubmissionDispatcherChallengeOptions {
            runtime_root: runtime_root.clone(),
            now_millis,
            plan_hash: None,
            idempotency_key: None,
            portal_id: None,
            portal_configuration_hash: None,
            portal_descriptor_hash: None,
        },
    )
    .map_err(|error| error.to_string())?;
    let mut blockers = vec![
        "rust_autonomous_submission_dispatcher_identity_signature_verification_not_ported",
        "rust_autonomous_submission_dispatcher_portal_binding_not_ported",
        "rust_autonomous_submission_dispatcher_portal_canary_not_ported",
        "rust_autonomous_submission_dispatcher_handoff_state_not_ported",
        "rust_autonomous_submission_dispatcher_delivery_not_ported",
        "rust_autonomous_submission_dispatcher_network_effect_not_ported",
        "rust_autonomous_submission_dispatcher_resident_loop_not_ported",
    ];
    if challenge["challengeHash"].is_null() {
        blockers.push("autonomous_submission_dispatcher_challenge_missing");
    }
    blockers.sort_unstable();
    blockers.dedup();
    Ok(json!({
        "version": 1,
        "kind": "AutonomousSubmissionDispatcherReport",
        "status": "autonomous_submission_dispatcher_blocked",
        "ready": false,
        "root": root,
        "runtimeRoot": runtime_root,
        "campaignId": options.campaign_id,
        "limit": options.limit,
        "pollMs": options.poll_ms,
        "residentRequested": options.resident,
        "portalFullProductionReady": false,
        "livePortalCanaryGateReady": false,
        "inspectedCampaignCount": 0,
        "inspectedHandoffCount": 0,
        "networkActionPerformed": false,
        "externalActionPerformed": false,
        "serviceStateChanged": false,
        "cycleReceipts": [],
        "results": [],
        "challengeInspection": challenge,
        "storagePreflight": storage_observation(&runtime_root),
        "blockers": blockers,
        "rustBoundary": "read-only-bounded-dispatcher-preflight",
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parser_rejects_unknown_duplicate_and_out_of_range_values() {
        assert!(
            parse_autonomous_submission_dispatcher_arguments(&["--limit".into(), "0".into()])
                .is_err()
        );
        assert!(
            parse_autonomous_submission_dispatcher_arguments(&[
                "--resident".into(),
                "--resident".into()
            ])
            .is_err()
        );
        assert!(parse_autonomous_submission_dispatcher_arguments(&["--unknown".into()]).is_err());
    }

    #[test]
    fn inspection_is_blocked_without_external_effects() {
        let root =
            std::env::temp_dir().join(format!("hepta-dispatcher-preflight-{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        let options = AutonomousSubmissionDispatcherOptions {
            runtime_root: Some(root.clone()),
            ..Default::default()
        };
        let report =
            inspect_autonomous_submission_dispatcher_v1(&options, &root, 1_800_000_000_000)
                .unwrap();
        assert_eq!(report["ready"], false);
        assert_eq!(report["networkActionPerformed"], false);
        assert_eq!(report["serviceStateChanged"], false);
        assert!(report["blockers"].as_array().unwrap().len() >= 6);
        fs::remove_dir_all(root).unwrap();
    }
}
