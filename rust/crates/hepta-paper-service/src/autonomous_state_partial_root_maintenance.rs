//! Native historical 5+5 partial-runtime repair.
//!
//! Planning is read-only and binds exact SQLite/schema/business state, retained
//! configuration/profile/dataset observations, writer quiescence and the rescue
//! destination. Execute requires the exact plan identity, locks all five existing
//! databases, creates and restore-verifies a rescue bundle, constructs the five
//! missing business databases, repairs only the historical supervisor journal
//! gap, and publishes without clobbering. Crash recovery distinguishes rolled
//! back pre-commit attempts from committed repair and persists an exact terminal
//! receipt. It never invokes a provider, activates the online writer, or retires
//! Node; the independently authorized online schema transition remains separate.

#![forbid(unsafe_code)]

mod execution;
mod plan;

use crate::{
    autonomous_state_provision::files::Snapshot,
    journal_connector_coverage::qualification::canonical_instant_millis,
    sqlite_mutation_coordinator::manifest::writer_manifest_hash_v1,
    state_recoverability::cli::state_backup_writer_manifest_v1,
};
use hepta_legacy_compatibility::production_hash_record_v1;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    os::unix::fs::MetadataExt,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
use thiserror::Error;

const SHA256_PREFIX: &str = "sha256:";
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
impl From<std::io::Error> for AutonomousStatePartialRootMaintenanceError {
    fn from(value: std::io::Error) -> Self {
        Self(format!("autonomous_state_partial_root_io:{value}"))
    }
}
impl From<rusqlite::Error> for AutonomousStatePartialRootMaintenanceError {
    fn from(value: rusqlite::Error) -> Self {
        Self(format!("autonomous_state_partial_root_sqlite:{value}"))
    }
}
impl From<serde_json::Error> for AutonomousStatePartialRootMaintenanceError {
    fn from(value: serde_json::Error) -> Self {
        Self(format!("autonomous_state_partial_root_json:{value}"))
    }
}

pub const AUTONOMOUS_STATE_PARTIAL_ROOT_MAINTENANCE_USAGE: &str = r#"Usage: autonomous-state-partial-root-maintenance --action plan|execute [options]

Required: --rescue-root PATH --writer-quiescence-receipt PATH
          --machine-intake-config PATH --topic-producer-profile PATH
          --dataset-root PATH
          --runtime-reproducibility-maximum-attempts-per-epoch N
          --runtime-reproducibility-maximum-cost-usd-per-epoch N
Optional: --runtime-root PATH --action plan|execute --execute
          --maintenance-plan-id sha256:...

Plan performs read-only SQLite/schema/business-state and input identity checks
and returns a stable executable plan for the exact historical 5+5 closure.
Execute requires the exact plan ID, locks all five existing databases, creates
and restore-verifies a rescue bundle, constructs the five missing business
databases from the same native schema owner used by fresh provisioning, repairs
only the historical supervisor journal gap and publishes without clobbering.
It does not invoke providers, activate the online writer or retire Node."#;

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
    let required = |key: &str| {
        values.get(key).map(String::as_str).ok_or_else(|| {
            error(format!(
                "autonomous_state_partial_root_input_paths_required:{key}"
            ))
        })
    };
    let rescue_root = required("rescue-root")?;
    let writer_quiescence_receipt = required("writer-quiescence-receipt")?;
    let machine_intake_config = required("machine-intake-config")?;
    let topic_producer_profile = required("topic-producer-profile")?;
    let dataset_root = required("dataset-root")?;
    let maximum_attempts = required("runtime-reproducibility-maximum-attempts-per-epoch")?;
    let maximum_cost = required("runtime-reproducibility-maximum-cost-usd-per-epoch")?;
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
        rescue_root: absolute_path(rescue_root)?,
        writer_quiescence_receipt: absolute_path(writer_quiescence_receipt)?,
        machine_intake_config: absolute_path(machine_intake_config)?,
        topic_producer_profile: absolute_path(topic_producer_profile)?,
        dataset_root: absolute_path(dataset_root)?,
        maximum_attempts_per_epoch: positive_u64(maximum_attempts, "maximum_attempts_per_epoch")?,
        maximum_cost_usd_per_epoch: nonnegative_f64(maximum_cost, "maximum_cost_usd_per_epoch")?,
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
    let first = crate::autonomous_state_provision::files::Snapshot::read(path).map_err(|_| {
        error(format!(
            "autonomous_state_partial_root_{key}_identity_invalid"
        ))
    })?;
    first.assert_current().map_err(|_| {
        error(format!(
            "autonomous_state_partial_root_{key}_changed_during_read"
        ))
    })?;
    let second = crate::autonomous_state_provision::files::Snapshot::read(path).map_err(|_| {
        error(format!(
            "autonomous_state_partial_root_{key}_changed_during_read"
        ))
    })?;
    if first.observation() != second.observation() || first.bytes != second.bytes {
        return Err(error(format!(
            "autonomous_state_partial_root_{key}_changed_during_read"
        )));
    }
    Ok(first.bytes)
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

fn manifest(root: &Path) -> Result<Value> {
    let path = root.join("paper-core/config/autonomous-research-state-databases.v1.json");
    let snapshot =
        crate::autonomous_state_provision::files::Snapshot::read(&path).map_err(|_| {
            error("autonomous_state_partial_root_state_database_manifest_identity_invalid")
        })?;
    let value: Value = serde_json::from_slice(&snapshot.bytes)
        .map_err(|_| error("autonomous_state_partial_root_state_database_manifest_json_invalid"))?;
    if value["version"] != 1
        || value["kind"] != "AutonomousResearchStateDatabaseManifest"
        || value["databases"]
            .as_array()
            .is_none_or(|rows| rows.len() != 10)
        || value["databases"].as_array().is_none_or(|rows| {
            rows.iter().any(|row| {
                row["role"].as_str().is_none_or(str::is_empty)
                    || row["relativePath"].as_str().is_none_or(str::is_empty)
            })
        })
    {
        return Err(error("autonomous_state_partial_root_manifest_invalid"));
    }
    Ok(value)
}

fn observed_at_millis() -> Result<i64> {
    let value = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| error("autonomous_state_partial_root_clock_invalid"))?
        .as_millis();
    i64::try_from(value).map_err(|_| error("autonomous_state_partial_root_clock_invalid"))
}

fn receipt(root: &Path, path: &Path, scope: &str, writer_hash: &str) -> Result<Value> {
    let value = read_json(path, "writer_quiescence_receipt")?;
    if value["version"] != 1
        || value["kind"] != "AutonomousResearchStatePartialRootWriterQuiescenceReceipt"
        || value["runtimeRoot"].as_str() != root.to_str()
        || value["status"] != "autonomous_research_state_partial_root_writers_quiesced"
        || value["serviceInspectionComplete"] != true
        || value["processInspectionComplete"] != true
        || value["activeWriterProcessIds"]
            .as_array()
            .is_none_or(|rows| !rows.is_empty())
        || value["quiescedWriterServices"]
            .as_array()
            .is_none_or(|rows| {
                if rows.len() != REQUIRED_SERVICES.len() {
                    return true;
                }
                let mut selected = rows.iter().filter_map(Value::as_str).collect::<Vec<_>>();
                selected.sort_unstable();
                selected != REQUIRED_SERVICES
            })
    {
        return Err(error("autonomous_state_partial_root_quiescence_invalid"));
    }
    let instant = |key: &str| {
        value[key]
            .as_str()
            .and_then(canonical_instant_millis)
            .ok_or_else(|| error("autonomous_state_partial_root_quiescence_timestamp_invalid"))
    };
    let observed = instant("observedAt")?;
    let expires = instant("expiresAt")?;
    let now = observed_at_millis()?;
    if observed > now || expires <= now || expires <= observed {
        return Err(error(
            "autonomous_state_partial_root_quiescence_expired_or_future",
        ));
    }
    if value["databaseScopeHash"] != scope || value["writerManifestHash"] != writer_hash {
        return Err(error(
            "autonomous_state_partial_root_quiescence_scope_mismatch",
        ));
    }
    // Node hashes this normalized payload; the input receiptHash and any extra
    // fields are excluded. Opaque claims are never promoted to external authority.
    let mut payload = serde_json::Map::new();
    for key in [
        "version",
        "kind",
        "status",
        "runtimeRoot",
        "databaseScopeHash",
        "writerManifestHash",
        "activeWriterProcessIds",
        "serviceInspectionComplete",
        "processInspectionComplete",
        "observedAt",
        "expiresAt",
    ] {
        payload.insert(key.to_owned(), value[key].clone());
    }
    payload.insert(
        "quiescedWriterServices".to_owned(),
        json!(REQUIRED_SERVICES),
    );
    let expected = record_hash(
        "AutonomousResearchStatePartialRootWriterQuiescenceReceipt",
        &Value::Object(payload),
    )?;
    if value["receiptHash"] != expected {
        return Err(error(
            "autonomous_state_partial_root_quiescence_hash_invalid",
        ));
    }
    Ok(value)
}

pub fn inspect_autonomous_state_partial_root_maintenance_v1(
    options: &AutonomousStatePartialRootMaintenanceOptions,
) -> Result<Value> {
    Ok(plan::build(options)?.plan)
}

pub fn execute_autonomous_state_partial_root_maintenance_v1(
    options: &AutonomousStatePartialRootMaintenanceOptions,
) -> Result<Value> {
    if options.action != "execute" || !options.execute {
        return Err(error(
            "autonomous_state_partial_root_execute_confirmation_required",
        ));
    }
    let expected = options
        .expected_maintenance_plan_id
        .as_deref()
        .ok_or_else(|| error("autonomous_state_partial_root_plan_id_required"))?;
    if let Some(receipt) = execution::recover_or_replay(options, expected)? {
        return Ok(receipt);
    }
    let state = plan::build(options)?;
    if state.plan["maintenancePlanId"].as_str() != Some(expected) {
        return Err(error("autonomous_state_partial_root_plan_mismatch"));
    }
    execution::execute(options, state)
}
