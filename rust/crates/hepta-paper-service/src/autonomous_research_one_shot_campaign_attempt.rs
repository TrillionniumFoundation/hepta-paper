//! Bounded, read-only Rust boundary for the Node one-shot campaign attempt route.
//!
//! This route owns argument validation and immutable local input inspection. It
//! never opens the campaign journal, invokes a provider, uses the network, or
//! mutates a runtime/control root. Execution and status therefore remain
//! fail-closed until their external authority contracts are independently
//! implemented and accepted.

#![forbid(unsafe_code)]

use hepta_legacy_compatibility::production_hash_record_v1;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    fs::{self, OpenOptions},
    io::Read,
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
};

const MAX_DATASET_FILE_BYTES: u64 = 8 * 1024 * 1024;
const SHA256_PREFIX: &str = "sha256:";
pub const AUTONOMOUS_RESEARCH_ONE_SHOT_TARGET_CAMPAIGN_ID: &str =
    "autonomous-research:local-auto-20260730-57";
pub const AUTONOMOUS_RESEARCH_ONE_SHOT_TARGET_PAPER_ID: &str = "local-auto-20260730-57";
pub const AUTONOMOUS_RESEARCH_ONE_SHOT_PROTECTED_CAMPAIGN_ID: &str =
    "autonomous-research:local-auto-20260730-51";
pub const AUTONOMOUS_RESEARCH_ONE_SHOT_TARGET_DATASET_MOUNTS_HASH: &str =
    "sha256:586dd4d1edb5ca3efee48d02726a1c7cf2044a6afe81b34bc5821c1e97d9c520";

pub const AUTONOMOUS_RESEARCH_ONE_SHOT_CAMPAIGN_ATTEMPT_USAGE: &str = r#"{
  "version": 1,
  "kind": "AutonomousResearchOneShotCampaignAttemptUsage",
  "usage": "autonomous-research-one-shot-campaign-attempt --action plan|preflight|execute|status [options]",
  "fixedCampaignId": "autonomous-research:local-auto-20260730-57",
  "protectedCampaignId": "autonomous-research:local-auto-20260730-51",
  "options": {
    "--dataset-mount-file": "JSON dataset mount array; required by plan, preflight, and execute",
    "--attempt-id": "exact attempt identity; required by status",
    "--root": "absolute paper asset root",
    "--runtime-root": "absolute native runtime root",
    "--control-root": "absolute dedicated one-shot control root"
  },
  "safety": {
    "providerInvocationPerformed": false,
    "networkAccessPerformed": false,
    "journalWritePerformed": false,
    "nativeDatabaseWritePerformed": false,
    "executionAuthorized": false,
    "rustBoundary": "bounded no-follow/hash preflight; execute and status are fail-closed"
  }
}"#;

#[derive(Clone, Debug, Default)]
pub struct AutonomousResearchOneShotCampaignAttemptOptions {
    pub action: String,
    pub dataset_mount_file: Option<PathBuf>,
    pub attempt_id: Option<String>,
    pub root: Option<PathBuf>,
    pub runtime_root: Option<PathBuf>,
    pub control_root: Option<PathBuf>,
    pub help: bool,
}

fn option_value(args: &[String], index: &mut usize, name: &str) -> Result<String, String> {
    if *index + 1 >= args.len() || args[*index + 1].starts_with("--") {
        return Err(format!(
            "autonomous_research_one_shot_{name}_value_required"
        ));
    }
    let value = args[*index + 1].clone();
    *index += 2;
    Ok(value)
}

pub fn parse_autonomous_research_one_shot_campaign_attempt_arguments(
    args: &[String],
) -> Result<AutonomousResearchOneShotCampaignAttemptOptions, String> {
    let mut options = AutonomousResearchOneShotCampaignAttemptOptions {
        action: "status".to_owned(),
        ..Default::default()
    };
    let mut seen = BTreeSet::new();
    let mut index = 0;
    while index < args.len() {
        let flag = args[index].as_str();
        if !seen.insert(flag.to_owned()) {
            return Err(format!("duplicate_cli_option:{flag}"));
        }
        match flag {
            "--help" => {
                options.help = true;
                index += 1;
            }
            "--action" => options.action = option_value(args, &mut index, "action")?,
            "--dataset-mount-file" => {
                options.dataset_mount_file = Some(PathBuf::from(option_value(
                    args,
                    &mut index,
                    "dataset_mount_file",
                )?));
            }
            "--attempt-id" => {
                options.attempt_id = Some(option_value(args, &mut index, "attempt_id")?);
            }
            "--root" => {
                options.root = Some(PathBuf::from(option_value(args, &mut index, "root")?));
            }
            "--runtime-root" => {
                options.runtime_root = Some(PathBuf::from(option_value(
                    args,
                    &mut index,
                    "runtime_root",
                )?));
            }
            "--control-root" => {
                options.control_root = Some(PathBuf::from(option_value(
                    args,
                    &mut index,
                    "control_root",
                )?));
            }
            _ => {
                return Err(format!(
                    "unsupported_autonomous_research_one_shot_argument:{flag}"
                ));
            }
        }
    }
    if options.help {
        return Ok(options);
    }
    if !matches!(
        options.action.as_str(),
        "plan" | "preflight" | "execute" | "status"
    ) {
        return Err(format!(
            "autonomous_research_one_shot_action_invalid:{}",
            options.action
        ));
    }
    if options.action == "status"
        && options
            .attempt_id
            .as_deref()
            .unwrap_or("")
            .trim()
            .is_empty()
    {
        return Err("autonomous_research_one_shot_attempt_id_required".to_owned());
    }
    if let Some(attempt_id) = &options.attempt_id
        && (attempt_id.len() > 256
            || !attempt_id
                .bytes()
                .next()
                .is_some_and(|byte| byte.is_ascii_alphanumeric())
            || !attempt_id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"_.:@/-".contains(&byte)))
    {
        return Err("autonomous_research_one_shot_attempt_id_invalid".to_owned());
    }
    if options.action != "status" && options.dataset_mount_file.is_none() {
        return Err("autonomous_research_one_shot_dataset_mount_file_required".to_owned());
    }
    for (name, path) in [
        ("root", options.root.as_ref()),
        ("runtime_root", options.runtime_root.as_ref()),
        ("control_root", options.control_root.as_ref()),
    ] {
        if path.is_some_and(|path| !path.is_absolute()) {
            return Err(format!(
                "autonomous_research_one_shot_{name}_absolute_path_required"
            ));
        }
    }
    Ok(options)
}

pub fn autonomous_research_one_shot_campaign_attempt_help_json_v1() -> Value {
    json!({
        "version": 1,
        "kind": "AutonomousResearchOneShotCampaignAttemptUsage",
        "usage": "autonomous-research-one-shot-campaign-attempt --action plan|preflight|execute|status [options]",
        "fixedCampaignId": "autonomous-research:local-auto-20260730-57",
        "protectedCampaignId": "autonomous-research:local-auto-20260730-51",
        "options": {
            "--dataset-mount-file": "JSON dataset mount array; required by plan, preflight, and execute",
            "--attempt-id": "exact attempt identity; required by status",
            "--root": "absolute paper asset root",
            "--runtime-root": "absolute native runtime root",
            "--control-root": "absolute dedicated one-shot control root"
        },
        "safety": {
            "providerInvocationPerformed": false,
            "networkAccessPerformed": false,
            "journalWritePerformed": false,
            "nativeDatabaseWritePerformed": false,
            "executionAuthorized": false,
            "rustBoundary": "bounded no-follow/hash preflight; execute and status are fail-closed"
        }
    })
}

fn digest(bytes: &[u8]) -> String {
    format!("{SHA256_PREFIX}{:x}", Sha256::digest(bytes))
}

fn valid_sha256(value: &str) -> bool {
    value.strip_prefix(SHA256_PREFIX).is_some_and(|hex| {
        hex.len() == 64
            && hex
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    })
}

fn stable_dataset_file(path: &Path) -> Result<(Value, String, Value), String> {
    if !path.is_absolute() {
        return Err(
            "autonomous_research_one_shot_dataset_mount_file_absolute_path_required".into(),
        );
    }
    let parent = path
        .parent()
        .ok_or_else(|| "autonomous_research_one_shot_dataset_mount_parent_missing".to_owned())?;
    let parent_meta = fs::symlink_metadata(parent)
        .map_err(|_| "autonomous_research_one_shot_dataset_mount_parent_unreadable".to_owned())?;
    if !parent_meta.is_dir() || fs::canonicalize(parent).ok().as_deref() != Some(parent) {
        return Err("autonomous_research_one_shot_dataset_mount_parent_unsafe".into());
    }
    let link_meta = fs::symlink_metadata(path)
        .map_err(|_| "autonomous_research_one_shot_dataset_mount_file_unreadable".to_owned())?;
    if link_meta.file_type().is_symlink()
        || !link_meta.is_file()
        || link_meta.nlink() != 1
        || link_meta.len() > MAX_DATASET_FILE_BYTES
    {
        return Err("autonomous_research_one_shot_dataset_mount_file_identity_invalid".into());
    }
    let mut opts = OpenOptions::new();
    opts.read(true)
        .custom_flags(nix::libc::O_NOFOLLOW | nix::libc::O_NONBLOCK | nix::libc::O_CLOEXEC);
    let mut file = opts
        .open(path)
        .map_err(|_| "autonomous_research_one_shot_dataset_mount_open_blocked".to_owned())?;
    let before = file
        .metadata()
        .map_err(|_| "autonomous_research_one_shot_dataset_mount_metadata_failed".to_owned())?;
    if !before.is_file()
        || before.nlink() != 1
        || before.len() > MAX_DATASET_FILE_BYTES
        || before.dev() != link_meta.dev()
        || before.ino() != link_meta.ino()
    {
        return Err("autonomous_research_one_shot_dataset_mount_file_identity_invalid".into());
    }
    let mut bytes = Vec::with_capacity(before.len() as usize);
    file.by_ref()
        .take(MAX_DATASET_FILE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "autonomous_research_one_shot_dataset_mount_read_failed".to_owned())?;
    let after = file
        .metadata()
        .map_err(|_| "autonomous_research_one_shot_dataset_mount_metadata_failed".to_owned())?;
    let path_after = fs::symlink_metadata(path)
        .map_err(|_| "autonomous_research_one_shot_dataset_mount_file_unreadable".to_owned())?;
    let parent_after = fs::symlink_metadata(parent)
        .map_err(|_| "autonomous_research_one_shot_dataset_mount_parent_unreadable".to_owned())?;
    if bytes.len() as u64 > MAX_DATASET_FILE_BYTES
        || path_after.dev() != before.dev()
        || path_after.ino() != before.ino()
        || path_after.mode() != before.mode()
        || path_after.nlink() != before.nlink()
        || path_after.len() != before.len()
        || before.ctime() != after.ctime()
        || before.ctime_nsec() != after.ctime_nsec()
        || before.dev() != after.dev()
        || before.ino() != after.ino()
        || before.mode() != after.mode()
        || before.nlink() != after.nlink()
        || before.len() != after.len()
        || before.mtime() != after.mtime()
        || before.mtime_nsec() != after.mtime_nsec()
        || parent_meta.dev() != parent_after.dev()
        || parent_meta.ino() != parent_after.ino()
        || parent_meta.mode() != parent_after.mode()
        || parent_meta.nlink() != parent_after.nlink()
        || fs::canonicalize(parent).ok().as_deref() != Some(parent)
    {
        return Err("autonomous_research_one_shot_dataset_mount_changed_during_read".into());
    }
    let value: Value = serde_json::from_slice(&bytes)
        .map_err(|_| "autonomous_research_one_shot_dataset_mount_json_invalid".to_owned())?;
    let observed_hash = digest(&bytes);
    let array = value
        .as_array()
        .ok_or_else(|| "autonomous_research_one_shot_dataset_mounts_invalid".to_owned())?;
    if array.len() != 1 {
        return Err("autonomous_research_one_shot_dataset_mounts_invalid".into());
    }
    let mount = array[0]
        .as_object()
        .ok_or_else(|| "autonomous_research_one_shot_dataset_mounts_invalid".to_owned())?;
    let name = mount.get("name").and_then(Value::as_str).unwrap_or("");
    let manifest_hash = mount
        .get("manifestHash")
        .and_then(Value::as_str)
        .unwrap_or("");
    if name.trim().is_empty()
        || !valid_sha256(manifest_hash)
        || mount.get("readOnly") != Some(&Value::Bool(true))
    {
        return Err("autonomous_research_one_shot_dataset_contract_invalid".into());
    }
    let summary = json!({
        "path": path,
        "absolute": true,
        "regular": true,
        "symlink": false,
        "singleLink": true,
        "size": bytes.len(),
        "observedSha256": observed_hash,
        "manifestHash": manifest_hash,
        "readOnly": true,
    });
    let mounts_hash =
        production_hash_record_v1("AutonomousResearchOneShotCampaignDatasetMounts", &value)
            .map_err(|_| "autonomous_research_one_shot_dataset_mounts_invalid".to_owned())?;
    Ok((value, mounts_hash.as_str().to_owned(), summary))
}

fn root_summary(path: Option<&Path>, name: &str) -> (Value, Option<String>) {
    let Some(path) = path else {
        return (
            json!({"path": null, "absolute": false, "present": false}),
            Some(format!("autonomous_research_one_shot_{name}_required")),
        );
    };
    let absolute = path.is_absolute();
    let metadata = fs::symlink_metadata(path).ok();
    let symlink = metadata
        .as_ref()
        .is_some_and(|meta| meta.file_type().is_symlink());
    let directory = metadata.as_ref().is_some_and(|meta| meta.is_dir());
    let canonical = directory && fs::canonicalize(path).ok().as_deref() == Some(path);
    let safe = absolute && !symlink && directory && canonical;
    let blocker = (!safe).then(|| format!("autonomous_research_one_shot_{name}_root_unsafe"));
    (
        json!({"path": path, "absolute": absolute, "present": metadata.is_some(), "directory": directory, "symlink": symlink, "canonical": canonical, "safe": safe}),
        blocker,
    )
}

pub fn inspect_autonomous_research_one_shot_campaign_attempt_v1(
    options: &AutonomousResearchOneShotCampaignAttemptOptions,
    workspace_root: &Path,
) -> Value {
    let root = options.root.as_deref();
    let runtime_root = options.runtime_root.as_deref();
    let control_root = options.control_root.as_deref();
    let (root_report, root_blocker) = root_summary(root, "asset");
    let (runtime_report, runtime_blocker) = root_summary(runtime_root, "runtime");
    let (control_report, control_blocker) = root_summary(control_root, "control");
    let mut blockers: Vec<String> = [root_blocker, runtime_blocker, control_blocker]
        .into_iter()
        .flatten()
        .collect();
    if !workspace_root.is_absolute() {
        blockers.push("autonomous_research_one_shot_workspace_root_absolute_path_required".into());
    }
    let mut dataset_report = json!({"required": options.action != "status", "inspected": false});
    if options.action != "status" {
        match options
            .dataset_mount_file
            .as_deref()
            .ok_or_else(|| "autonomous_research_one_shot_dataset_mount_file_required".to_owned())
            .and_then(stable_dataset_file)
        {
            Ok((_value, mounts_hash, summary)) => {
                let target_match =
                    mounts_hash == AUTONOMOUS_RESEARCH_ONE_SHOT_TARGET_DATASET_MOUNTS_HASH;
                if !target_match {
                    blockers.push("autonomous_research_one_shot_dataset_binding_mismatch".into());
                }
                dataset_report = json!({"required": true, "inspected": true, "mountsHash": mounts_hash, "targetMountsHash": AUTONOMOUS_RESEARCH_ONE_SHOT_TARGET_DATASET_MOUNTS_HASH, "targetHashMatches": target_match, "mount": summary});
            }
            Err(error) => {
                blockers.push(error);
                dataset_report = json!({"required": true, "inspected": false, "path": options.dataset_mount_file});
            }
        }
    }
    if let (Some(runtime), Some(control)) = (runtime_root, control_root)
        && (control.starts_with(runtime) || runtime.starts_with(control))
    {
        blockers.push("autonomous_research_one_shot_control_runtime_roots_overlap".into());
    }
    blockers.extend([
        "rust_autonomous_research_one_shot_dataset_authority_not_ported".to_owned(),
        "rust_autonomous_research_one_shot_protected_campaign_and_journal_inspection_not_ported"
            .to_owned(),
        "rust_autonomous_research_one_shot_source_execution_binding_not_ported".to_owned(),
    ]);
    if options.action == "status" {
        blockers.push("rust_autonomous_research_one_shot_status_inspection_not_ported".into());
    } else if options.action == "execute" {
        blockers.push("rust_autonomous_research_one_shot_execute_not_ported".into());
    }
    blockers.push("autonomous_research_one_shot_provider_runtime_not_proven".into());
    blockers.push("autonomous_research_one_shot_reviewer_independence_not_proven".into());
    blockers.sort();
    blockers.dedup();
    json!({
        "version": 1,
        "kind": "AutonomousResearchOneShotCampaignAttemptPreflightReport",
        "status": "autonomous_research_one_shot_campaign_preflight_blocked",
        "action": options.action,
        "campaignId": AUTONOMOUS_RESEARCH_ONE_SHOT_TARGET_CAMPAIGN_ID,
        "paperId": AUTONOMOUS_RESEARCH_ONE_SHOT_TARGET_PAPER_ID,
        "protectedCampaignId": AUTONOMOUS_RESEARCH_ONE_SHOT_PROTECTED_CAMPAIGN_ID,
        "attemptId": options.attempt_id,
        "roots": {"asset": root_report, "runtime": runtime_report, "control": control_report},
        "dataset": dataset_report,
        "readyForReservation": false,
        "executionAuthorized": false,
        "campaignPreparationVerified": false,
        "providerCanaryVerified": false,
        "launchReadinessVerified": false,
        "sideEffects": {
            "reservationCreated": false,
            "journalWritePerformed": false,
            "nativeDatabaseWritePerformed": false,
            "providerInvocationPerformed": false,
            "networkAccessPerformed": false,
            "campaignLaunchPerformed": false,
        },
        "blockers": blockers,
        "rustBoundary": "read-only bounded preflight; execute and status fail closed",
    })
}

pub fn execute_autonomous_research_one_shot_campaign_attempt_v1(
    options: &AutonomousResearchOneShotCampaignAttemptOptions,
    workspace_root: &Path,
) -> Value {
    inspect_autonomous_research_one_shot_campaign_attempt_v1(options, workspace_root)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parser_requires_mount_for_preflight_and_attempt_for_status() {
        assert!(
            parse_autonomous_research_one_shot_campaign_attempt_arguments(&[
                "--action".into(),
                "plan".into()
            ])
            .is_err()
        );
        assert!(
            parse_autonomous_research_one_shot_campaign_attempt_arguments(&[
                "--action".into(),
                "status".into()
            ])
            .is_err()
        );
    }
    #[test]
    fn report_is_always_fail_closed() {
        let options = parse_autonomous_research_one_shot_campaign_attempt_arguments(&[
            "--action".into(),
            "status".into(),
            "--attempt-id".into(),
            "a".into(),
        ])
        .unwrap();
        let report =
            inspect_autonomous_research_one_shot_campaign_attempt_v1(&options, Path::new("/tmp"));
        assert_eq!(report["executionAuthorized"], false);
        assert_eq!(report["sideEffects"]["journalWritePerformed"], false);
    }
}
