//! Bounded native preflight for the historical partial-runtime-root repair.
//!
//! The incumbent route can acquire SQLite locks, create a rescue bundle and
//! publish five missing databases.  Those writes and their external authority
//! boundary are intentionally not represented here.  This module only reads
//! bounded local inputs, checks their identity and lease/quiescence envelope,
//! and emits a stable plan.  `execute` verifies the plan id and then remains
//! fail-closed without touching the runtime or rescue roots.

#![forbid(unsafe_code)]

use hepta_legacy_compatibility::production_hash_record_v1;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, OpenOptions},
    io::Read,
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
use thiserror::Error;

const MAX_INPUT_BYTES: u64 = 16 * 1024 * 1024;
const SHA256_PREFIX: &str = "sha256:";
const EXECUTE_BLOCKER: &str = "rust_autonomous_state_partial_root_maintenance_execute_not_ported";
const EXISTING_ROLES: &[&str] = &[
    "external-qualification",
    "native-store",
    "resident-instance",
    "submission-handoff",
    "supervisor-state",
];
const MISSING_ROLES: &[&str] = &[
    "full-research-qualification-publication",
    "machine-intake",
    "runtime-reproducibility-publication",
    "runtime-reproducibility-refresh",
    "topic-producer",
];
const REQUIRED_SERVICES: &[&str] = &[
    "autonomous-research-state-backup-renew.service",
    "autonomous-research-supervisor.service",
    "autonomous-submission-dispatcher.service",
    "strict-full-auto-acceptance.service",
];

#[derive(Debug, Error)]
#[error("{0}")]
pub struct AutonomousStatePartialRootMaintenanceError(pub String);
pub type Result<T> = std::result::Result<T, AutonomousStatePartialRootMaintenanceError>;

fn error(code: impl Into<String>) -> AutonomousStatePartialRootMaintenanceError {
    AutonomousStatePartialRootMaintenanceError(code.into())
}

pub const AUTONOMOUS_STATE_PARTIAL_ROOT_MAINTENANCE_USAGE: &str = r#"Usage: autonomous-state-partial-root-maintenance --action plan|execute [options]

Required: --rescue-root PATH --writer-quiescence-receipt PATH
          --machine-intake-config PATH --topic-producer-profile PATH
          --dataset-root PATH
          --runtime-reproducibility-maximum-attempts-per-epoch N
          --runtime-reproducibility-maximum-cost-usd-per-epoch N
Optional: --runtime-root PATH --action plan|execute --execute
          --maintenance-plan-id sha256:...

Plan is a read-only bounded identity/quiescence preflight. Execute is
deliberately fail-closed until rescue, lock, schema-repair, rollback and
external-authority contracts have a reviewed native implementation."#;

#[derive(Clone, Debug)]
pub struct AutonomousStatePartialRootMaintenanceOptions {
    pub action: String,
    pub execute: bool,
    pub expected_maintenance_plan_id: Option<String>,
    pub runtime_root: PathBuf,
    pub rescue_root: PathBuf,
    pub writer_quiescence_receipt: PathBuf,
    pub machine_intake_config: PathBuf,
    pub topic_producer_profile: PathBuf,
    pub dataset_root: PathBuf,
    pub maximum_attempts_per_epoch: u64,
    pub maximum_cost_usd_per_epoch: f64,
}

fn valid_hash(value: &str) -> bool {
    value.len() == 71
        && value.starts_with(SHA256_PREFIX)
        && value[7..]
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn value_at(args: &[String], index: &mut usize, key: &str) -> Result<String> {
    let value = args
        .get(*index + 1)
        .filter(|value| !value.is_empty() && !value.starts_with("--"))
        .ok_or_else(|| {
            error(format!(
                "autonomous_state_partial_root_{key}_value_required"
            ))
        })?
        .clone();
    *index += 2;
    Ok(value)
}

fn positive_u64(value: &str, key: &str) -> Result<u64> {
    let parsed = value
        .parse::<u64>()
        .map_err(|_| error(format!("autonomous_state_partial_root_{key}_invalid")))?;
    if parsed == 0 {
        return Err(error(format!(
            "autonomous_state_partial_root_{key}_invalid"
        )));
    }
    Ok(parsed)
}

fn nonnegative_f64(value: &str, key: &str) -> Result<f64> {
    let parsed = value
        .parse::<f64>()
        .map_err(|_| error(format!("autonomous_state_partial_root_{key}_invalid")))?;
    if !parsed.is_finite() || parsed < 0.0 {
        return Err(error(format!(
            "autonomous_state_partial_root_{key}_invalid"
        )));
    }
    Ok(parsed)
}

fn absolute_path(value: &str) -> Result<PathBuf> {
    let path = PathBuf::from(value);
    if path.is_absolute() {
        Ok(path)
    } else {
        std::env::current_dir()
            .map(|root| root.join(path))
            .map_err(|_| error("autonomous_state_partial_root_cwd_invalid"))
    }
}

/// Parse the Node option surface with strict duplicate/unknown rejection.
pub fn parse_autonomous_state_partial_root_maintenance_arguments(
    args: &[String],
) -> Result<Option<AutonomousStatePartialRootMaintenanceOptions>> {
    let value_flags = BTreeSet::from([
        "action",
        "maintenance-plan-id",
        "runtime-root",
        "rescue-root",
        "writer-quiescence-receipt",
        "machine-intake-config",
        "topic-producer-profile",
        "dataset-root",
        "runtime-reproducibility-maximum-attempts-per-epoch",
        "runtime-reproducibility-maximum-cost-usd-per-epoch",
    ]);
    let mut values = BTreeMap::new();
    let mut execute = false;
    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "--help" => {
                if index + 1 != args.len() {
                    return Err(error("autonomous_state_partial_root_arguments_invalid"));
                }
                return Ok(None);
            }
            "--execute" => {
                if execute {
                    return Err(error("autonomous_state_partial_root_arguments_invalid"));
                }
                execute = true;
                index += 1;
            }
            token => {
                let name = token
                    .strip_prefix("--")
                    .ok_or_else(|| error("autonomous_state_partial_root_arguments_invalid"))?;
                if !value_flags.contains(name) || values.contains_key(name) {
                    return Err(error("autonomous_state_partial_root_arguments_invalid"));
                }
                values.insert(name.to_owned(), value_at(args, &mut index, name)?);
            }
        }
    }
    let action = values
        .get("action")
        .cloned()
        .unwrap_or_else(|| "plan".into());
    if !matches!(action.as_str(), "plan" | "execute") {
        return Err(error(format!(
            "autonomous_state_partial_root_action_invalid:{action}"
        )));
    }
    for key in [
        "rescue-root",
        "writer-quiescence-receipt",
        "machine-intake-config",
        "topic-producer-profile",
        "dataset-root",
        "runtime-reproducibility-maximum-attempts-per-epoch",
        "runtime-reproducibility-maximum-cost-usd-per-epoch",
    ] {
        if !values.contains_key(key) {
            return Err(error(format!(
                "autonomous_state_partial_root_input_paths_required:{key}"
            )));
        }
    }
    if action == "plan" && (execute || values.contains_key("maintenance-plan-id")) {
        return Err(error(
            "autonomous_state_partial_root_execute_options_forbidden",
        ));
    }
    if action == "execute" && !execute {
        return Err(error(
            "autonomous_state_partial_root_execute_confirmation_required",
        ));
    }
    if action == "execute"
        && !values
            .get("maintenance-plan-id")
            .is_some_and(|value| valid_hash(value))
    {
        return Err(error("autonomous_state_partial_root_plan_id_required"));
    }
    let default_runtime = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .join("runtime");
    Ok(Some(AutonomousStatePartialRootMaintenanceOptions {
        action,
        execute,
        expected_maintenance_plan_id: values.get("maintenance-plan-id").cloned(),
        runtime_root: values
            .get("runtime-root")
            .map(|value| absolute_path(value))
            .transpose()?
            .unwrap_or_else(|| {
                if default_runtime.is_absolute() {
                    default_runtime.clone()
                } else {
                    std::env::current_dir()
                        .map(|root| root.join(&default_runtime))
                        .unwrap_or(default_runtime)
                }
            }),
        rescue_root: absolute_path(values.get("rescue-root").expect("validated"))?,
        writer_quiescence_receipt: absolute_path(
            values.get("writer-quiescence-receipt").expect("validated"),
        )?,
        machine_intake_config: absolute_path(
            values.get("machine-intake-config").expect("validated"),
        )?,
        topic_producer_profile: absolute_path(
            values.get("topic-producer-profile").expect("validated"),
        )?,
        dataset_root: absolute_path(values.get("dataset-root").expect("validated"))?,
        maximum_attempts_per_epoch: positive_u64(
            values
                .get("runtime-reproducibility-maximum-attempts-per-epoch")
                .expect("validated"),
            "maximum_attempts_per_epoch",
        )?,
        maximum_cost_usd_per_epoch: nonnegative_f64(
            values
                .get("runtime-reproducibility-maximum-cost-usd-per-epoch")
                .expect("validated"),
            "maximum_cost_usd_per_epoch",
        )?,
    }))
}

fn safe_root(path: &Path, key: &str) -> Result<fs::Metadata> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|_| error(format!("autonomous_state_partial_root_{key}_missing")))?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() || metadata.mode() & 0o022 != 0 {
        return Err(error(format!("autonomous_state_partial_root_{key}_unsafe")));
    }
    let canonical = fs::canonicalize(path)
        .map_err(|_| error(format!("autonomous_state_partial_root_{key}_unsafe")))?;
    if canonical != path {
        return Err(error(format!("autonomous_state_partial_root_{key}_unsafe")));
    }
    Ok(metadata)
}

fn read_regular(path: &Path, key: &str) -> Result<Vec<u8>> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|_| error(format!("autonomous_state_partial_root_{key}_missing")))?;
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || metadata.nlink() != 1
        || metadata.mode() & 0o022 != 0
    {
        return Err(error(format!(
            "autonomous_state_partial_root_{key}_identity_invalid"
        )));
    }
    if metadata.len() > MAX_INPUT_BYTES {
        return Err(error(format!(
            "autonomous_state_partial_root_{key}_too_large"
        )));
    }
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(nix::libc::O_NOFOLLOW | nix::libc::O_CLOEXEC)
        .open(path)
        .map_err(|_| error(format!("autonomous_state_partial_root_{key}_unreadable")))?;
    let opened = file.metadata().map_err(|_| {
        error(format!(
            "autonomous_state_partial_root_{key}_identity_invalid"
        ))
    })?;
    if opened.dev() != metadata.dev() || opened.ino() != metadata.ino() || opened.nlink() != 1 {
        return Err(error(format!(
            "autonomous_state_partial_root_{key}_identity_changed"
        )));
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.by_ref()
        .take(MAX_INPUT_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| error(format!("autonomous_state_partial_root_{key}_unreadable")))?;
    if bytes.len() as u64 > MAX_INPUT_BYTES {
        return Err(error(format!(
            "autonomous_state_partial_root_{key}_too_large"
        )));
    }
    Ok(bytes)
}

fn read_json(path: &Path, key: &str) -> Result<Value> {
    serde_json::from_slice(&read_regular(path, key)?)
        .map_err(|_| error(format!("autonomous_state_partial_root_{key}_json_invalid")))
}

fn hash_bytes(bytes: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(bytes))
}

fn record_hash(kind: &str, value: &Value) -> Result<String> {
    production_hash_record_v1(kind, value)
        .map(|hash| hash.as_str().to_owned())
        .map_err(|_| error(format!("autonomous_state_partial_root_{kind}_hash_failed")))
}

fn metadata(path: &Path, key: &str) -> Result<Value> {
    let value = fs::symlink_metadata(path)
        .map_err(|_| error(format!("autonomous_state_partial_root_{key}_missing")))?;
    if !value.is_file() || value.file_type().is_symlink() || value.nlink() != 1 {
        return Err(error(format!(
            "autonomous_state_partial_root_{key}_identity_invalid"
        )));
    }
    Ok(
        json!({"device": value.dev(), "inode": value.ino(), "mode": value.mode() & 0o7777, "links": value.nlink(), "bytes": value.len()}),
    )
}

fn manifest(root: &Path) -> Result<Value> {
    let path = root.join("paper-core/config/autonomous-research-state-databases.v1.json");
    let value = read_json(&path, "state_database_manifest")?;
    if value["version"] != 1
        || value["kind"] != "AutonomousResearchStateDatabaseManifest"
        || value["databases"]
            .as_array()
            .is_none_or(|rows| rows.len() != 10)
    {
        return Err(error("autonomous_state_partial_root_manifest_invalid"));
    }
    Ok(value)
}

fn database_observations(
    runtime: &Path,
    manifest: &Value,
) -> Result<(Vec<Value>, Vec<String>, Vec<String>)> {
    let rows = manifest["databases"]
        .as_array()
        .ok_or_else(|| error("autonomous_state_partial_root_manifest_invalid"))?;
    let mut instances = Vec::new();
    let mut existing = Vec::new();
    let mut missing = Vec::new();
    for row in rows {
        let role = row["role"]
            .as_str()
            .ok_or_else(|| error("autonomous_state_partial_root_manifest_invalid"))?;
        let relative = row["relativePath"]
            .as_str()
            .ok_or_else(|| error("autonomous_state_partial_root_manifest_invalid"))?;
        let path = runtime.join(relative);
        if path
            .components()
            .any(|component| matches!(component, std::path::Component::ParentDir))
        {
            return Err(error("autonomous_state_partial_root_database_path_invalid"));
        }
        match (fs::symlink_metadata(&path), role) {
            (Ok(_), _) => {
                let file_meta = metadata(&path, "database")?;
                let bytes = read_regular(&path, "database")?;
                let source_sha256 = hash_bytes(&bytes);
                instances.push(json!({"role":role,"sourceRelativePath":relative,"sourceSha256":source_sha256,"sourceFileIdentity":file_meta}));
                existing.push(role.to_owned());
            }
            (Err(cause), _) if cause.kind() == std::io::ErrorKind::NotFound => {
                missing.push(role.to_owned())
            }
            (Err(_), _) => {
                return Err(error(format!(
                    "autonomous_state_partial_root_database_missing:{role}"
                )));
            }
        }
    }
    existing.sort();
    missing.sort();
    instances.sort_by(|left, right| left["role"].as_str().cmp(&right["role"].as_str()));
    Ok((instances, existing, missing))
}

fn observed_at_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn receipt(root: &Path, path: &Path) -> Result<Value> {
    let value = read_json(path, "writer_quiescence_receipt")?;
    if value["version"] != 1
        || value["kind"] != "AutonomousResearchStatePartialRootWriterQuiescenceReceipt"
        || value["runtimeRoot"].as_str() != root.to_str()
        || value["status"] != "autonomous_research_state_partial_root_writers_quiesced"
        || value["serviceInspectionComplete"] != true
        || value["processInspectionComplete"] != true
        || value["observedAt"].as_str().is_none_or(str::is_empty)
        || value["expiresAt"].as_str().is_none_or(str::is_empty)
        || value["activeWriterProcessIds"]
            .as_array()
            .is_none_or(|rows| !rows.is_empty())
        || value["quiescedWriterServices"]
            .as_array()
            .is_none_or(|rows| {
                let mut selected = rows.iter().filter_map(Value::as_str).collect::<Vec<_>>();
                selected.sort_unstable();
                selected != REQUIRED_SERVICES
            })
    {
        return Err(error("autonomous_state_partial_root_quiescence_invalid"));
    }
    let expires_at = value["expiresAt"]
        .as_str()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(u64::MAX);
    if expires_at != u64::MAX && expires_at <= observed_at_millis() {
        return Err(error("autonomous_state_partial_root_quiescence_expired"));
    }
    if value["receiptHash"]
        .as_str()
        .is_none_or(|hash| !valid_hash(hash))
    {
        return Err(error(
            "autonomous_state_partial_root_quiescence_hash_invalid",
        ));
    }
    Ok(value)
}

fn plan_payload(options: &AutonomousStatePartialRootMaintenanceOptions) -> Result<Value> {
    let workspace_root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let runtime = fs::canonicalize(&options.runtime_root)
        .map_err(|_| error("autonomous_state_partial_root_runtime_root_invalid"))?;
    let rescue = fs::canonicalize(&options.rescue_root)
        .map_err(|_| error("autonomous_state_partial_root_rescue_root_invalid"))?;
    let runtime_meta = safe_root(&runtime, "runtime_root")?;
    let rescue_meta = safe_root(&rescue, "rescue_root")?;
    if runtime == rescue || runtime_meta.dev() != rescue_meta.dev() {
        return Err(error("autonomous_state_partial_root_rescue_root_invalid"));
    }
    let manifest = manifest(&workspace_root)?;
    let (instances, mut existing, mut missing) = database_observations(&runtime, &manifest)?;
    existing.sort();
    missing.sort();
    if existing != EXISTING_ROLES || missing != MISSING_ROLES {
        return Err(error("autonomous_state_partial_root_role_closure_invalid"));
    }
    let machine = read_json(&options.machine_intake_config, "machine_intake_config")?;
    let topic = read_json(&options.topic_producer_profile, "topic_producer_profile")?;
    if machine["version"] != 2 || !machine.is_object() || !topic.is_object() {
        return Err(error("autonomous_state_partial_root_input_shape_invalid"));
    }
    let dataset_meta = safe_root(&options.dataset_root, "dataset_root")?;
    let quiescence = receipt(&runtime, &options.writer_quiescence_receipt)?;
    let manifest_hash = record_hash("AutonomousResearchStateDatabaseManifest", &manifest)?;
    let machine_hash = record_hash("AutonomousResearchMachineIntakeConfiguration", &machine)?;
    let topic_hash = record_hash("AutonomousResearchTopicProducerProfile", &topic)?;
    let policy = json!({"maximumAttemptsPerEpoch":options.maximum_attempts_per_epoch,"maximumCostUsdPerEpoch":options.maximum_cost_usd_per_epoch});
    let policy_hash = record_hash("RuntimeReproducibilityRefreshPolicy", &policy)?;
    let scope = record_hash(
        "AutonomousResearchStatePartialRootDatabaseScope",
        &json!(instances),
    )?;
    let mut payload = json!({
        "version":1,
        "kind":"AutonomousResearchStatePartialRootMaintenancePlan",
        "status":"autonomous_research_state_partial_root_maintenance_plan_ready",
        "ready":true,
        "protocol":"offline-partial-native-root-pre-transition-business-repair-v1",
        "runtimeRoot":runtime,
        "rescueRoot":rescue,
        "stateDatabaseManifestHash":manifest_hash,
        "databaseScopeHash":scope,
        "existingRoles":EXISTING_ROLES,
        "missingRoles":MISSING_ROLES,
        "instances":instances,
        "machineIntakeConfiguration":{"path":options.machine_intake_config,"hash":machine_hash},
        "topicProducerProfile":{"path":options.topic_producer_profile,"hash":topic_hash},
        "datasetRoot":{"path":options.dataset_root,"device":dataset_meta.dev(),"inode":dataset_meta.ino()},
        "runtimeReproducibilityPolicy":policy,
        "runtimeReproducibilityPolicyHash":policy_hash,
        "writerQuiescenceReceiptHash":quiescence["receiptHash"],
        "rescueBundleAndCopyRestoreVerificationRequired":true,
        "exclusiveDatabaseLocksRequired":true,
        "onlineSchemaTransitionRequired":true,
        "externalAuthorityInvocationAllowed":false,
    });
    let plan_id = record_hash(
        "AutonomousResearchStatePartialRootMaintenancePlan",
        &payload,
    )?;
    payload["maintenancePlanId"] = json!(plan_id);
    Ok(payload)
}

pub fn inspect_autonomous_state_partial_root_maintenance_v1(
    options: &AutonomousStatePartialRootMaintenanceOptions,
) -> Result<Value> {
    plan_payload(options)
}

pub fn execute_autonomous_state_partial_root_maintenance_v1(
    options: &AutonomousStatePartialRootMaintenanceOptions,
) -> Result<Value> {
    let plan = inspect_autonomous_state_partial_root_maintenance_v1(options)?;
    if options.expected_maintenance_plan_id.as_deref() != plan["maintenancePlanId"].as_str() {
        return Err(error(
            "autonomous_state_partial_root_maintenance_plan_mismatch",
        ));
    }
    Ok(json!({
        "version":1,
        "kind":"AutonomousResearchStatePartialRootMaintenanceReceipt",
        "status":"autonomous_research_state_partial_root_maintenance_blocked",
        "ready":false,
        "maintenancePlanId":plan["maintenancePlanId"],
        "existingRoles":plan["existingRoles"],
        "missingRoles":plan["missingRoles"],
        "externalAuthorityInvoked":false,
        "runtimeMutated":false,
        "rescueBundleCreated":false,
        "blockers":[EXECUTE_BLOCKER],
    }))
}
