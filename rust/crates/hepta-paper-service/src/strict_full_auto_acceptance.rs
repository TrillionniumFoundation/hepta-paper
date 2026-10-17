//! Bounded, read-only boundary for the Node strict full-auto acceptance route.
//!
//! The native route owns the argument and configuration reference boundary. It
//! deliberately does not create a plan lease, execute steps, adopt a runtime,
//! persist checkpoints, or consume external authority.

#![forbid(unsafe_code)]

use hepta_legacy_compatibility::production_hash_record_v1;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, OpenOptions},
    io::Read,
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
};

const MAX_CONFIGURATION_BYTES: u64 = 16 * 1024 * 1024;
const SHA256_PREFIX: &str = "sha256:";

pub const STRICT_FULL_AUTO_ACCEPTANCE_USAGE: &str = r#"{
  "version": 1,
  "kind": "StrictFullAutoAcceptanceUsage",
  "usage": "hepta-paper operator strict-full-auto-acceptance -- --action plan|inspect-runtime-adoption-candidate|adoption-status|adopt-runtime|status|execute|converge --configuration PATH [--plan-hash sha256:... --execute]",
  "rustBoundary": "strict argument and configuration preflight only; no lease, checkpoint, runtime adoption, external authority, provider, or acceptance action"
}"#;

#[derive(Clone, Debug, Default)]
pub struct StrictFullAutoAcceptanceOptions {
    pub help: bool,
    pub action: String,
    pub configuration: Option<PathBuf>,
    pub expected_plan_hash: Option<String>,
    pub execute: bool,
    pub require_accepted: bool,
    pub require_adopted: bool,
}

fn value(args: &[String], index: &mut usize, name: &str) -> Result<String, String> {
    if *index + 1 >= args.len() || args[*index + 1].starts_with("--") {
        return Err(format!("strict_full_auto_acceptance_{name}_value_required"));
    }
    let result = args[*index + 1].clone();
    *index += 2;
    Ok(result)
}

fn valid_sha256(value: &str) -> bool {
    value.strip_prefix(SHA256_PREFIX).is_some_and(|hex| {
        hex.len() == 64
            && hex
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    })
}

pub fn parse_strict_full_auto_acceptance_arguments(
    args: &[String],
) -> Result<StrictFullAutoAcceptanceOptions, String> {
    let mut options = StrictFullAutoAcceptanceOptions {
        action: "plan".to_owned(),
        ..Default::default()
    };
    let mut seen = std::collections::BTreeSet::new();
    let mut index = 0;
    while index < args.len() {
        let flag = args[index].as_str();
        if !seen.insert(flag.to_owned()) {
            return Err(format!("duplicate_cli_option:{flag}"));
        }
        match flag {
            "--help" => options.help = true,
            "--execute" => options.execute = true,
            "--require-accepted" => options.require_accepted = true,
            "--require-adopted" => options.require_adopted = true,
            "--action" => options.action = value(args, &mut index, "action")?,
            "--configuration" => {
                options.configuration =
                    Some(PathBuf::from(value(args, &mut index, "configuration")?));
            }
            "--plan-hash" => {
                options.expected_plan_hash = Some(value(args, &mut index, "plan_hash")?);
            }
            _ => {
                return Err(format!(
                    "unsupported_strict_full_auto_acceptance_argument:{flag}"
                ));
            }
        }
        if matches!(
            flag,
            "--help" | "--execute" | "--require-accepted" | "--require-adopted"
        ) {
            index += 1;
        }
    }
    if options.help {
        return Ok(options);
    }
    let valid_actions = [
        "plan",
        "inspect-runtime-adoption-candidate",
        "adoption-status",
        "adopt-runtime",
        "status",
        "execute",
        "converge",
    ];
    if !valid_actions.contains(&options.action.as_str()) {
        return Err(format!(
            "strict_full_auto_acceptance_action_invalid:{}",
            options.action
        ));
    }
    let configuration = options
        .configuration
        .as_mut()
        .ok_or_else(|| "strict_full_auto_acceptance_configuration_required".to_owned())?;
    if !configuration.is_absolute() {
        return Err("strict_full_auto_acceptance_configuration_must_be_absolute".to_owned());
    }
    if !matches!(
        options.action.as_str(),
        "execute" | "converge" | "adopt-runtime"
    ) && (options.execute || options.expected_plan_hash.is_some())
    {
        return Err("strict_full_auto_acceptance_execute_options_forbidden".to_owned());
    }
    if options.action == "execute"
        && (!options.execute
            || !options
                .expected_plan_hash
                .as_deref()
                .is_some_and(valid_sha256))
    {
        return Err(
            "strict_full_auto_acceptance_execute_confirmation_and_plan_hash_required".to_owned(),
        );
    }
    if options.action == "converge" && (!options.execute || options.expected_plan_hash.is_some()) {
        return Err("strict_full_auto_acceptance_converge_confirmation_required".to_owned());
    }
    if options.action == "adopt-runtime"
        && (!options.execute
            || !options
                .expected_plan_hash
                .as_deref()
                .is_some_and(valid_sha256))
    {
        return Err(
            "strict_full_auto_acceptance_runtime_adoption_confirmation_required".to_owned(),
        );
    }
    if options.action != "adoption-status" && options.require_adopted {
        return Err("strict_full_auto_acceptance_require_adopted_forbidden".to_owned());
    }
    Ok(options)
}

fn read_configuration(path: &Path) -> Value {
    let invalid = |reason: &str| {
        json!({
            "path": path,
            "valid": false,
            "reason": reason,
            "observedSha256": Value::Null,
        })
    };
    let Some(parent) = path.parent() else {
        return invalid("parent_missing");
    };
    let Ok(parent_before) = fs::symlink_metadata(parent) else {
        return invalid("parent_unreadable");
    };
    if !parent_before.is_dir() || fs::canonicalize(parent).ok().as_deref() != Some(parent) {
        return invalid("parent_identity_invalid");
    }
    let mut options = OpenOptions::new();
    options
        .read(true)
        .custom_flags(nix::libc::O_NOFOLLOW | nix::libc::O_NONBLOCK | nix::libc::O_CLOEXEC);
    let Ok(mut file) = options.open(path) else {
        return invalid("open_failed");
    };
    let Ok(before) = file.metadata() else {
        return invalid("metadata_failed");
    };
    if !before.is_file() || before.nlink() != 1 || before.len() > MAX_CONFIGURATION_BYTES {
        return invalid("file_identity_invalid");
    }
    let mut bytes = Vec::with_capacity(before.len() as usize);
    if file
        .by_ref()
        .take(MAX_CONFIGURATION_BYTES + 1)
        .read_to_end(&mut bytes)
        .is_err()
    {
        return invalid("read_failed");
    }
    let Ok(after) = file.metadata() else {
        return invalid("metadata_failed");
    };
    let Ok(parent_after) = fs::symlink_metadata(parent) else {
        return invalid("parent_unreadable");
    };
    let stable = before.dev() == after.dev()
        && before.ino() == after.ino()
        && before.mode() == after.mode()
        && before.nlink() == after.nlink()
        && before.len() == after.len()
        && before.mtime() == after.mtime()
        && before.mtime_nsec() == after.mtime_nsec()
        && parent_before.dev() == parent_after.dev()
        && parent_before.ino() == parent_after.ino()
        && parent_before.mode() == parent_after.mode()
        && parent_before.nlink() == parent_after.nlink()
        && bytes.len() as u64 <= MAX_CONFIGURATION_BYTES
        && fs::canonicalize(parent).ok().as_deref() == Some(parent);
    if !stable {
        return invalid("changed_during_read");
    }
    let observed = format!("sha256:{:x}", Sha256::digest(&bytes));
    let parsed = serde_json::from_slice::<Value>(&bytes).ok();
    json!({
        "path": path,
        "valid": stable && parsed.as_ref().is_some_and(Value::is_object),
        "jsonObject": parsed.as_ref().is_some_and(Value::is_object),
        "observedSha256": observed,
    })
}

pub fn strict_full_auto_acceptance_help_json_v1() -> Value {
    json!({
        "version": 1,
        "kind": "StrictFullAutoAcceptanceUsage",
        "usage": "hepta-paper operator strict-full-auto-acceptance -- --action plan|inspect-runtime-adoption-candidate|adoption-status|adopt-runtime|status|execute|converge --configuration PATH [--plan-hash sha256:... --execute]",
        "rustBoundary": "strict argument and configuration preflight only; no lease, checkpoint, runtime adoption, external authority, provider, or acceptance action"
    })
}

pub fn inspect_strict_full_auto_acceptance_v1(options: &StrictFullAutoAcceptanceOptions) -> Value {
    let path = options.configuration.as_deref();
    let configuration = path.map(read_configuration);
    let mut blockers = vec![
        "strict_full_auto_acceptance_plan_lease_not_ported".to_owned(),
        "strict_full_auto_acceptance_step_checkpoint_execution_not_ported".to_owned(),
        "strict_full_auto_acceptance_live_external_authority_required".to_owned(),
    ];
    if configuration
        .as_ref()
        .is_none_or(|value| value["valid"] != true)
    {
        blockers.push("strict_full_auto_acceptance_configuration_invalid".to_owned());
    }
    blockers.sort();
    blockers.dedup();
    let payload = json!({
        "version": 1,
        "kind": "StrictFullAutoAcceptanceReport",
        "status": "strict_full_auto_acceptance_blocked",
        "action": options.action,
        "configuration": configuration,
        "planHash": Value::Null,
        "expectedPlanHash": options.expected_plan_hash,
        "ready": false,
        "strictFullAutoAccepted": false,
        "runtimeAdopted": false,
        "externalActionPerformed": false,
        "serviceStateChanged": false,
        "blockers": blockers,
        "rustBoundary": "read-only-configuration-preflight",
    });
    let hash = production_hash_record_v1("StrictFullAutoAcceptanceReport", &payload)
        .ok()
        .map(|value| value.as_str().to_owned());
    let mut report = payload;
    report["reportHash"] = hash.map_or(Value::Null, Value::String);
    report
}

pub fn execute_strict_full_auto_acceptance_v1(options: &StrictFullAutoAcceptanceOptions) -> Value {
    inspect_strict_full_auto_acceptance_v1(options)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parser_matches_confirmation_boundaries() {
        let base = ["--configuration".to_owned(), "/tmp/strict.json".to_owned()];
        assert_eq!(
            parse_strict_full_auto_acceptance_arguments(&base)
                .unwrap()
                .action,
            "plan"
        );
        assert!(
            parse_strict_full_auto_acceptance_arguments(&[
                "--configuration".into(),
                "/tmp/strict.json".into(),
                "--execute".into()
            ])
            .is_err()
        );
        assert!(
            parse_strict_full_auto_acceptance_arguments(&[
                "--configuration".into(),
                "/tmp/strict.json".into(),
                "--action".into(),
                "execute".into(),
                "--execute".into(),
                "--plan-hash".into(),
                format!("sha256:{}", "a".repeat(64))
            ])
            .is_ok()
        );
    }

    #[test]
    fn report_never_claims_acceptance_or_mutation() {
        let options = parse_strict_full_auto_acceptance_arguments(&[
            "--configuration".into(),
            "/tmp/missing-strict.json".into(),
            "--action".into(),
            "converge".into(),
            "--execute".into(),
        ])
        .unwrap();
        let report = inspect_strict_full_auto_acceptance_v1(&options);
        assert_eq!(report["strictFullAutoAccepted"], false);
        assert_eq!(report["externalActionPerformed"], false);
        assert_eq!(report["serviceStateChanged"], false);
    }
}
