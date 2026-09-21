//! Bounded, fail-closed preflight for machine-intake authority rotation.
//!
//! This route deliberately stops at immutable target and workspace identity
//! inspection. It never opens SQLite, writes the authority bundle, invokes a
//! signer/provider, or claims that a rotation was applied.

#![forbid(unsafe_code)]

use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    fs::{self, OpenOptions},
    io::Read,
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::{Component, Path, PathBuf},
};

const MAX_REFERENCE_BYTES: u64 = 16 * 1024 * 1024;
const SHA256_PREFIX: &str = "sha256:";
const AUTHORITY_ROTATION_ROOT: &str = "/etc/hepta-paper/authority-rotation";

fn absolute_path(path: PathBuf) -> PathBuf {
    let candidate = if path.is_absolute() {
        path
    } else {
        std::env::current_dir().map_or(path.clone(), |cwd| cwd.join(path))
    };
    let mut normalized = PathBuf::new();
    for component in candidate.components() {
        match component {
            Component::RootDir => normalized.push(Path::new("/")),
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            Component::Normal(value) => normalized.push(value),
            Component::Prefix(value) => normalized.push(value.as_os_str()),
        }
    }
    normalized
}

pub const AUTONOMOUS_INTAKE_AUTHORITY_ROTATION_USAGE: &str = r#"{
  "version": 1,
  "kind": "AutonomousIntakeAuthorityRotationUsage",
  "usage": "autonomous-intake-authority-rotation --action plan|apply --runtime-root PATH --next-machine-intake-config PATH --topic-producer-profile PATH [--rotation-intent PATH --expected-authority-generation N --plan-hash sha256:... --execute]",
  "localObservationEffects": "bounded read-only file and identity inspection",
  "externalAction": "never",
  "mutation": "never; apply remains fail-closed until independently reviewed authority adapter exists",
  "semanticNotReadyExitCode": 2
}"#;

#[derive(Clone, Debug, Default)]
pub struct AutonomousIntakeAuthorityRotationOptions {
    pub help: bool,
    pub action: String,
    pub runtime_root: Option<PathBuf>,
    pub next_machine_intake_config: Option<PathBuf>,
    pub topic_producer_profile: Option<PathBuf>,
    pub rotation_intent: Option<PathBuf>,
    pub expected_authority_generation: Option<u64>,
    pub plan_hash: Option<String>,
    pub execute: bool,
}

fn value(args: &[String], index: &mut usize, name: &str) -> Result<String, String> {
    if *index + 1 >= args.len() || args[*index + 1].starts_with("--") {
        return Err(format!(
            "autonomous_intake_authority_rotation_{name}_value_required"
        ));
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

/// Parse the incumbent route's strict option boundary without interpreting
/// target content or performing a mutation.
pub fn parse_autonomous_intake_authority_rotation_arguments(
    args: &[String],
) -> Result<AutonomousIntakeAuthorityRotationOptions, String> {
    let mut options = AutonomousIntakeAuthorityRotationOptions {
        action: "plan".to_owned(),
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
            "--help" => options.help = true,
            "--execute" => options.execute = true,
            "--action" => options.action = value(args, &mut index, "action")?,
            "--runtime-root" => {
                options.runtime_root = Some(PathBuf::from(value(args, &mut index, "runtime_root")?))
            }
            "--next-machine-intake-config" => {
                options.next_machine_intake_config = Some(PathBuf::from(value(
                    args,
                    &mut index,
                    "next_machine_intake_config",
                )?))
            }
            "--topic-producer-profile" => {
                options.topic_producer_profile = Some(PathBuf::from(value(
                    args,
                    &mut index,
                    "topic_producer_profile",
                )?))
            }
            "--rotation-intent" => {
                options.rotation_intent =
                    Some(PathBuf::from(value(args, &mut index, "rotation_intent")?))
            }
            "--expected-authority-generation" => {
                let raw = value(args, &mut index, "expected_authority_generation")?;
                let generation = raw.parse::<u64>().map_err(|_| {
                    "autonomous_intake_authority_rotation_expected_authority_generation_invalid"
                        .to_owned()
                })?;
                if generation == 0 {
                    return Err(
                        "autonomous_intake_authority_rotation_expected_authority_generation_invalid"
                            .to_owned(),
                    );
                }
                options.expected_authority_generation = Some(generation);
            }
            "--plan-hash" => options.plan_hash = Some(value(args, &mut index, "plan_hash")?),
            _ => {
                return Err(format!(
                    "unsupported_autonomous_intake_authority_rotation_argument:{flag}"
                ));
            }
        }
        if matches!(flag, "--help" | "--execute") {
            index += 1;
        }
    }
    if options.help {
        return Ok(options);
    }
    if !matches!(options.action.as_str(), "plan" | "apply") {
        return Err(format!(
            "autonomous_intake_authority_rotation_action_invalid:{}",
            options.action
        ));
    }
    if options.next_machine_intake_config.is_none() || options.topic_producer_profile.is_none() {
        return Err("autonomous_intake_authority_rotation_target_files_required".to_owned());
    }
    if options.action == "plan"
        && (options.execute
            || options.plan_hash.is_some()
            || options.rotation_intent.is_some()
            || options.expected_authority_generation.is_some())
    {
        return Err(
            "autonomous_intake_authority_rotation_apply_options_forbidden_for_plan".to_owned(),
        );
    }
    if options.action == "apply"
        && (!options.execute
            || options.rotation_intent.is_none()
            || options.expected_authority_generation.is_none())
    {
        // The explicit checks below keep diagnostics stable while making the
        // double confirmation boundary visible to callers.
        if !options.execute {
            return Err("autonomous_intake_authority_rotation_execute_required".to_owned());
        }
        if options.rotation_intent.is_none() {
            return Err("autonomous_intake_authority_rotation_rotation_intent_required".to_owned());
        }
        if options.expected_authority_generation.is_none() {
            return Err(
                "autonomous_intake_authority_rotation_expected_authority_generation_required"
                    .to_owned(),
            );
        }
    }
    if options.action == "apply" && !options.plan_hash.as_deref().is_some_and(valid_sha256) {
        return Err("autonomous_intake_authority_rotation_plan_hash_required".to_owned());
    }
    if options.runtime_root.is_none() {
        options.runtime_root = Some(absolute_path(
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../../../../hepta-paper-runtime/native-runtime"),
        ));
    }
    options.runtime_root = options.runtime_root.map(absolute_path);
    options.next_machine_intake_config = options.next_machine_intake_config.map(absolute_path);
    options.topic_producer_profile = options.topic_producer_profile.map(absolute_path);
    options.rotation_intent = options.rotation_intent.map(absolute_path);
    Ok(options)
}

fn digest(bytes: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(bytes))
}

fn identity(metadata: &fs::Metadata) -> Value {
    json!({
        "device": metadata.dev(),
        "inode": metadata.ino(),
        "mode": metadata.mode(),
        "nlink": metadata.nlink(),
        "uid": metadata.uid(),
        "gid": metadata.gid(),
        "size": metadata.len(),
        "mtime": metadata.mtime(),
        "mtimeNsec": metadata.mtime_nsec(),
    })
}

fn inspect_directory(path: &Path) -> Value {
    let path_text = path.to_string_lossy().into_owned();
    let metadata = fs::symlink_metadata(path).ok();
    let is_symlink = metadata
        .as_ref()
        .is_some_and(|value| value.file_type().is_symlink());
    let is_directory = metadata.as_ref().is_some_and(fs::Metadata::is_dir);
    let canonical = fs::canonicalize(path).ok();
    let canonical_matches = canonical.as_deref() == Some(path);
    json!({
        "path": path_text,
        "exists": metadata.is_some(),
        "isDirectory": is_directory,
        "isSymlink": is_symlink,
        "canonicalMatches": canonical_matches,
        "identity": metadata.as_ref().map(identity),
        "valid": is_directory && !is_symlink && canonical_matches,
    })
}

fn read_reference(path: Option<&Path>) -> Value {
    let Some(path) = path else {
        return json!({"path": Value::Null, "valid": false, "reason": "not_supplied", "observedSha256": Value::Null});
    };
    let path_text = path.to_string_lossy().into_owned();
    if !path.is_absolute() {
        return json!({"path": path_text, "valid": false, "reason": "path_not_absolute", "observedSha256": Value::Null});
    }
    let Some(parent) = path.parent() else {
        return json!({"path": path_text, "valid": false, "reason": "parent_missing", "observedSha256": Value::Null});
    };
    let Ok(parent_before) = fs::symlink_metadata(parent) else {
        return json!({"path": path_text, "valid": false, "reason": "parent_unreadable", "observedSha256": Value::Null});
    };
    if !parent_before.is_dir() || fs::canonicalize(parent).ok().as_deref() != Some(parent) {
        return json!({"path": path_text, "valid": false, "reason": "parent_identity_invalid", "observedSha256": Value::Null});
    }
    let Ok(path_before) = fs::symlink_metadata(path) else {
        return json!({"path": path_text, "valid": false, "reason": "file_unreadable", "observedSha256": Value::Null});
    };
    if !path_before.is_file()
        || path_before.file_type().is_symlink()
        || path_before.nlink() != 1
        || path_before.len() > MAX_REFERENCE_BYTES
    {
        return json!({"path": path_text, "valid": false, "reason": "file_identity_invalid", "observedSha256": Value::Null, "identity": identity(&path_before)});
    }
    let mut options = OpenOptions::new();
    options
        .read(true)
        .custom_flags(nix::libc::O_NOFOLLOW | nix::libc::O_NONBLOCK | nix::libc::O_CLOEXEC);
    let Ok(mut file) = options.open(path) else {
        return json!({"path": path_text, "valid": false, "reason": "open_failed", "observedSha256": Value::Null, "identity": identity(&path_before)});
    };
    let Ok(file_before) = file.metadata() else {
        return json!({"path": path_text, "valid": false, "reason": "metadata_failed", "observedSha256": Value::Null, "identity": identity(&path_before)});
    };
    if !file_before.is_file() || file_before.nlink() != 1 || file_before.len() > MAX_REFERENCE_BYTES
    {
        return json!({"path": path_text, "valid": false, "reason": "opened_file_identity_invalid", "observedSha256": Value::Null, "identity": identity(&file_before)});
    }
    let mut bytes = Vec::with_capacity(file_before.len() as usize);
    if file.read_to_end(&mut bytes).is_err() {
        return json!({"path": path_text, "valid": false, "reason": "read_failed", "observedSha256": Value::Null, "identity": identity(&file_before)});
    }
    let file_after = file.metadata().ok();
    let parent_after = fs::symlink_metadata(parent).ok();
    let path_after = fs::symlink_metadata(path).ok();
    let stable = file_after
        .as_ref()
        .is_some_and(|after| identity(after) == identity(&file_before))
        && path_after
            .as_ref()
            .is_some_and(|after| identity(after) == identity(&path_before))
        && parent_after
            .as_ref()
            .is_some_and(|after| identity(after) == identity(&parent_before))
        && fs::canonicalize(parent).ok().as_deref() == Some(parent)
        && bytes.len() as u64 <= MAX_REFERENCE_BYTES;
    if !stable {
        return json!({"path": path_text, "valid": false, "reason": "changed_during_read", "observedSha256": Value::Null, "identity": identity(&path_before)});
    }
    let observed_hash = digest(&bytes);
    let parsed = serde_json::from_slice::<Value>(&bytes).ok();
    let object = parsed.as_ref().is_some_and(Value::is_object);
    json!({
        "path": path_text,
        "valid": object,
        "jsonObject": object,
        "observedSha256": observed_hash,
        "size": bytes.len(),
        "identity": identity(&path_before),
        "declaredVersion": parsed.as_ref().and_then(|value| value.get("version")).cloned().unwrap_or(Value::Null),
        "declaredKind": parsed.as_ref().and_then(|value| value.get("kind")).cloned().unwrap_or(Value::Null),
        "declaredConfigurationHash": parsed.as_ref().and_then(|value| value.get("configurationHash")).cloned().unwrap_or(Value::Null),
        "declaredProducerProfileHash": parsed.as_ref().and_then(|value| value.get("producerProfileHash")).cloned().unwrap_or(Value::Null),
        "machineAppendEnabled": parsed.as_ref().and_then(|value| value.get("machineAppendEnabled")).cloned().unwrap_or(Value::Null),
        "machineProducerProfileHash": parsed.as_ref().and_then(|value| value.get("machineProducerProfileHash")).cloned().unwrap_or(Value::Null),
    })
}

fn compute_plan_hash(payload: &Value) -> Result<String, serde_json::Error> {
    serde_json::to_vec(payload).map(|bytes| digest(&bytes))
}

fn plan_report(options: &AutonomousIntakeAuthorityRotationOptions, apply: bool) -> Value {
    let default_runtime_root = absolute_path(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../../hepta-paper-runtime/native-runtime"),
    );
    let runtime_root = options
        .runtime_root
        .as_deref()
        .unwrap_or(&default_runtime_root);
    let config = read_reference(options.next_machine_intake_config.as_deref());
    let profile = read_reference(options.topic_producer_profile.as_deref());
    let authority_root = inspect_directory(Path::new(AUTHORITY_ROTATION_ROOT));
    let runtime_identity = inspect_directory(runtime_root);
    let config_v2 = config["declaredVersion"] == 2 && config["machineAppendEnabled"] == true;
    let profile_hash_matches = config["machineProducerProfileHash"].is_string()
        && config["machineProducerProfileHash"] == profile["declaredProducerProfileHash"];
    let mut blockers = vec![
        "autonomous_intake_authority_rotation_runtime_state_inspection_not_ported".to_owned(),
        "autonomous_intake_authority_rotation_external_governance_required".to_owned(),
        "autonomous_intake_authority_rotation_native_mutation_adapter_not_implemented".to_owned(),
    ];
    if runtime_identity["valid"] != true {
        blockers
            .push("autonomous_intake_authority_rotation_runtime_root_identity_invalid".to_owned());
    }
    if config["valid"] != true {
        blockers.push(
            "autonomous_intake_authority_rotation_next_machine_intake_config_invalid".to_owned(),
        );
    }
    if profile["valid"] != true {
        blockers
            .push("autonomous_intake_authority_rotation_topic_producer_profile_invalid".to_owned());
    }
    if config_v2 && !profile_hash_matches {
        blockers
            .push("autonomous_intake_authority_rotation_topic_profile_hash_mismatch".to_owned());
    }
    let payload = json!({
        "version": 1,
        "kind": "AutonomousResearchMachineIntakeAuthorityRotationPlan",
        "transition": "v1-to-v2",
        "expectedAuthorityGeneration": 1,
        "nextAuthorityGeneration": 2,
        "runtimeRoot": runtime_identity,
        "authorityRotationRoot": authority_root,
        "nextMachineIntakeConfig": config,
        "topicProducerProfile": profile,
        "targetV2": config_v2,
        "topicProfileHashMatches": profile_hash_matches,
        "externalActionPerformed": false,
    });
    let plan_hash = match compute_plan_hash(&payload) {
        Ok(hash) => Some(hash),
        Err(_) => {
            blockers.push("autonomous_intake_authority_rotation_plan_encoding_failed".to_owned());
            None
        }
    };
    let rotation_intent = if apply {
        if plan_hash
            .as_deref()
            .is_none_or(|hash| options.plan_hash.as_deref() != Some(hash))
        {
            blockers.push("autonomous_intake_authority_rotation_plan_hash_mismatch".to_owned());
        }
        if options.expected_authority_generation != Some(1) {
            blockers.push(
                "autonomous_intake_authority_rotation_expected_authority_generation_mismatch"
                    .to_owned(),
            );
        }
        let intent = options.rotation_intent.as_deref().map(|path| {
            let reference = read_reference(Some(path));
            json!({
                "path": reference["path"], "valid": reference["valid"],
                "observedSha256": reference["observedSha256"],
                "signatureVerificationPerformed": false,
            })
        });
        blockers.push(
            "autonomous_intake_authority_rotation_signed_intent_and_external_authority_required"
                .to_owned(),
        );
        intent
    } else {
        None
    };
    let mut report = json!({
        "version": 1,
        "kind": "AutonomousResearchMachineIntakeAuthorityRotationPlanReport",
        "status": "autonomous_research_machine_intake_authority_rotation_blocked",
        "ready": false,
        "executeRequired": true,
        "plan": {"payload": payload, "planHash": plan_hash},
        "authorizationBundle": {"authorityRoot": AUTHORITY_ROTATION_ROOT, "privateKeyLoaded": false, "externalAuthorityVerified": false},
        "blockers": blockers,
        "externalActionPerformed": false,
        "networkUse": false,
        "providerCostUsd": 0,
    });
    if let Some(intent) = rotation_intent {
        report["rotationIntent"] = intent;
    }
    report
}

pub fn autonomous_intake_authority_rotation_help_json_v1() -> Value {
    json!({
      "version": 1,
      "kind": "AutonomousIntakeAuthorityRotationUsage",
      "usage": "autonomous-intake-authority-rotation --action plan|apply --runtime-root PATH --next-machine-intake-config PATH --topic-producer-profile PATH [--rotation-intent PATH --expected-authority-generation N --plan-hash sha256:... --execute]",
      "localObservationEffects": "bounded read-only file and identity inspection",
      "externalAction": "never",
      "mutation": "never; apply remains fail-closed until independently reviewed authority adapter exists",
      "semanticNotReadyExitCode": 2
    })
}

pub fn inspect_autonomous_intake_authority_rotation_v1(
    options: &AutonomousIntakeAuthorityRotationOptions,
) -> Value {
    plan_report(options, false)
}

pub fn execute_autonomous_intake_authority_rotation_v1(
    options: &AutonomousIntakeAuthorityRotationOptions,
) -> Value {
    plan_report(options, true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn help_matches_published_usage_contract() {
        let published: Value =
            serde_json::from_str(AUTONOMOUS_INTAKE_AUTHORITY_ROTATION_USAGE).unwrap();
        assert_eq!(
            autonomous_intake_authority_rotation_help_json_v1(),
            published
        );
    }

    #[test]
    fn direct_library_calls_report_missing_target_paths() {
        let options = AutonomousIntakeAuthorityRotationOptions::default();
        for report in [
            inspect_autonomous_intake_authority_rotation_v1(&options),
            execute_autonomous_intake_authority_rotation_v1(&options),
        ] {
            assert_eq!(report["ready"], false);
            assert_eq!(report["externalActionPerformed"], false);
            let payload = &report["plan"]["payload"];
            for field in ["nextMachineIntakeConfig", "topicProducerProfile"] {
                assert_eq!(payload[field]["valid"], false);
                assert_eq!(payload[field]["reason"], "not_supplied");
                assert!(payload[field]["path"].is_null());
            }
            let blockers = report["blockers"].as_array().unwrap();
            assert!(blockers.contains(&json!(
                "autonomous_intake_authority_rotation_next_machine_intake_config_invalid"
            )));
            assert!(blockers.contains(&json!(
                "autonomous_intake_authority_rotation_topic_producer_profile_invalid"
            )));
        }
    }
}
