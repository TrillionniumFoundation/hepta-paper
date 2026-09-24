//! Native fresh-state construction and bounded diagnostic provisioning preflight.
//!
//! The plan path binds the same source inputs as the incumbent command and
//! proves their local identity without creating a runtime. Native execution
//! requires pinned signed genesis and reuses the existing constructors and
//! authority verifiers; the no-genesis compatibility profile stays read-only.

use hepta_legacy_compatibility::production_hash_record_v1;
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    os::unix::fs::MetadataExt,
    path::{Path, PathBuf},
};
use thiserror::Error;

mod execution;
pub(crate) mod files;
mod inputs;
mod publication;
pub mod publication_recovery;
pub mod recovery;
mod schema;

const PROVISIONING_BLOCKER: &str = "rust_autonomous_state_provision_execute_not_ported";

#[derive(Debug, Error)]
#[error("{0}")]
pub struct AutonomousStateProvisioningError(pub String);
impl From<rusqlite::Error> for AutonomousStateProvisioningError {
    fn from(value: rusqlite::Error) -> Self {
        Self(format!("autonomous_state_provisioning_sqlite:{value}"))
    }
}
impl From<std::io::Error> for AutonomousStateProvisioningError {
    fn from(value: std::io::Error) -> Self {
        Self(format!("autonomous_state_provisioning_io:{value}"))
    }
}
impl From<serde_json::Error> for AutonomousStateProvisioningError {
    fn from(value: serde_json::Error) -> Self {
        Self(format!("autonomous_state_provisioning_json:{value}"))
    }
}
pub type Result<T> = std::result::Result<T, AutonomousStateProvisioningError>;
fn error(code: impl Into<String>) -> AutonomousStateProvisioningError {
    AutonomousStateProvisioningError(code.into())
}

pub const AUTONOMOUS_STATE_PROVISIONING_USAGE: &str = r#"Usage: autonomous-state-provision --action plan|execute [options]

Native ten-database provisioning. Plan is read-only. With independently pinned
--genesis-inputs and --genesis-inputs-sha256, execute constructs all ten business
schemas and publishes a fresh root atomically. Without them execute is blocked.
The native profile requires external signed genesis; it never activates online
authority, invokes a provider or retires Node.

Required: --runtime-root PATH --machine-intake-config PATH
          --topic-producer-profile PATH --dataset-root PATH
Optional: --root WORKSPACE_PATH --machine-intake-genesis-authority external|root-owned-configuration
          --runtime-reproducibility-maximum-attempts-per-epoch N
          --runtime-reproducibility-maximum-cost-usd-per-epoch N
          --plan-id sha256:... --execute

Recovery profile: autonomous-state-provision --recover-staging ABSOLUTE_REQUEST_JSON
NativeStateProvisioningRecoveryRequestV1 selects inspect or explicit quarantine.
It preserves unpublished bytes; it cannot adopt, delete or replace a runtime.
Published recovery: autonomous-state-provision --recover-publication ABSOLUTE_REQUEST_JSON
NativeStatePublicationRecoveryRequestV1 selects inspect or explicit finalize.
A pinned prepared receipt and exact unchanged ten-database bytes are required;
only a missing terminal receipt can be written, not any business database.
"#;

#[derive(Clone, Debug)]
pub struct AutonomousStateProvisioningOptions {
    pub action: String,
    pub execute: bool,
    pub expected_plan_id: Option<String>,
    pub workspace_root: PathBuf,
    pub runtime_root: PathBuf,
    pub machine_intake_config: PathBuf,
    pub topic_producer_profile: PathBuf,
    pub dataset_root: PathBuf,
    pub machine_intake_genesis_authority: String,
    pub maximum_attempts_per_epoch: u64,
    pub maximum_cost_usd_per_epoch: f64,
    pub genesis_inputs: Option<PathBuf>,
    pub genesis_inputs_sha256: Option<String>,
}

fn valid_hash(value: &str) -> bool {
    value.len() == 71
        && value.starts_with("sha256:")
        && value[7..]
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn parse_positive_u64(value: &str, key: &str) -> Result<u64> {
    let parsed = value
        .parse::<u64>()
        .map_err(|_| error(format!("autonomous_state_provisioning_{key}_invalid")))?;
    if parsed == 0 {
        return Err(error(format!(
            "autonomous_state_provisioning_{key}_invalid"
        )));
    }
    Ok(parsed)
}

fn parse_positive_f64(value: &str, key: &str) -> Result<f64> {
    let parsed = value
        .parse::<f64>()
        .map_err(|_| error(format!("autonomous_state_provisioning_{key}_invalid")))?;
    if !parsed.is_finite() || parsed <= 0.0 {
        return Err(error(format!(
            "autonomous_state_provisioning_{key}_invalid"
        )));
    }
    Ok(parsed)
}

pub fn parse_autonomous_state_provisioning_arguments(
    argv: &[String],
) -> Result<Option<AutonomousStateProvisioningOptions>> {
    let value_flags = BTreeSet::from([
        "action",
        "plan-id",
        "root",
        "runtime-root",
        "machine-intake-config",
        "topic-producer-profile",
        "dataset-root",
        "machine-intake-genesis-authority",
        "genesis-inputs",
        "genesis-inputs-sha256",
        "runtime-reproducibility-maximum-attempts-per-epoch",
        "runtime-reproducibility-maximum-cost-usd-per-epoch",
    ]);
    let mut values = BTreeMap::new();
    let mut execute = false;
    let mut index = 0;
    while index < argv.len() {
        let token = &argv[index];
        if token == "--help" {
            if index + 1 != argv.len() {
                return Err(error("autonomous_state_provisioning_arguments_invalid"));
            }
            return Ok(None);
        }
        if token == "--execute" {
            if execute {
                return Err(error("autonomous_state_provisioning_arguments_invalid"));
            }
            execute = true;
            index += 1;
            continue;
        }
        let Some(name) = token.strip_prefix("--") else {
            return Err(error("autonomous_state_provisioning_arguments_invalid"));
        };
        if !value_flags.contains(name) || values.contains_key(name) {
            return Err(error("autonomous_state_provisioning_arguments_invalid"));
        }
        let next = argv
            .get(index + 1)
            .filter(|value| !value.starts_with("--") && !value.is_empty())
            .ok_or_else(|| error("autonomous_state_provisioning_arguments_invalid"))?;
        values.insert(name.to_owned(), next.clone());
        index += 2;
    }
    let action = values
        .get("action")
        .cloned()
        .unwrap_or_else(|| "plan".into());
    if !matches!(action.as_str(), "plan" | "execute") {
        return Err(error(format!(
            "autonomous_state_provisioning_action_invalid:{action}"
        )));
    }
    for key in [
        "runtime-root",
        "machine-intake-config",
        "topic-producer-profile",
        "dataset-root",
    ] {
        if !values.contains_key(key) {
            return Err(error(format!(
                "autonomous_state_provisioning_input_required:{key}"
            )));
        }
    }
    if action == "plan" && (execute || values.contains_key("plan-id")) {
        return Err(error(
            "autonomous_state_provisioning_execute_options_forbidden",
        ));
    }
    if action == "execute"
        && (!execute || !values.get("plan-id").is_some_and(|value| valid_hash(value)))
    {
        return Err(error(
            "autonomous_state_provisioning_execute_confirmation_or_plan_id_required",
        ));
    }
    let attempts = values
        .get("runtime-reproducibility-maximum-attempts-per-epoch")
        .map(|value| parse_positive_u64(value, "maximum_attempts_per_epoch"))
        .transpose()?
        .unwrap_or(1);
    let cost = values
        .get("runtime-reproducibility-maximum-cost-usd-per-epoch")
        .map(|value| parse_positive_f64(value, "maximum_cost_usd_per_epoch"))
        .transpose()?
        .unwrap_or(1.0);
    let authority = values
        .get("machine-intake-genesis-authority")
        .cloned()
        .unwrap_or_else(|| "external".into());
    if !matches!(authority.as_str(), "external" | "root-owned-configuration") {
        return Err(error(
            "autonomous_state_provisioning_genesis_authority_invalid",
        ));
    }
    let absolute = |key: &str| {
        values.get(key).map(PathBuf::from).ok_or_else(|| {
            error(format!(
                "autonomous_state_provisioning_input_required:{key}"
            ))
        })
    };
    Ok(Some(AutonomousStateProvisioningOptions {
        action,
        execute,
        expected_plan_id: values.get("plan-id").cloned(),
        workspace_root: values
            .get("root")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..")),
        runtime_root: absolute("runtime-root")?,
        machine_intake_config: absolute("machine-intake-config")?,
        topic_producer_profile: absolute("topic-producer-profile")?,
        dataset_root: absolute("dataset-root")?,
        machine_intake_genesis_authority: authority,
        maximum_attempts_per_epoch: attempts,
        maximum_cost_usd_per_epoch: cost,
        genesis_inputs: values.get("genesis-inputs").map(PathBuf::from),
        genesis_inputs_sha256: values.get("genesis-inputs-sha256").cloned(),
    }))
}

fn read_json(path: &Path) -> Result<Value> {
    let snapshot = files::Snapshot::read(path)
        .map_err(|_| error("autonomous_state_provisioning_input_identity_invalid"))?;
    serde_json::from_slice(&snapshot.bytes)
        .map_err(|_| error("autonomous_state_provisioning_input_json_invalid"))
}

fn input_hash(kind: &str, value: &Value) -> Result<String> {
    production_hash_record_v1(kind, value)
        .map(|hash| hash.as_str().to_owned())
        .map_err(|_| error("autonomous_state_provisioning_input_hash_failed"))
}

fn manifest(workspace_root: &Path) -> Result<Value> {
    let path = workspace_root.join("paper-core/config/autonomous-research-state-databases.v1.json");
    let value = read_json(&path)?;
    if value["version"] != 1
        || value["kind"] != "AutonomousResearchStateDatabaseManifest"
        || value["databases"]
            .as_array()
            .is_none_or(|rows| rows.len() != 10)
    {
        return Err(error("autonomous_state_provisioning_manifest_invalid"));
    }
    Ok(value)
}

fn inspect_input(path: &Path, directory: bool) -> Result<Value> {
    if !directory {
        let snapshot = files::Snapshot::read(path)
            .map_err(|_| error("autonomous_state_provisioning_input_identity_invalid"))?;
        return Ok(snapshot.observation());
    }
    let metadata = fs::symlink_metadata(path)
        .map_err(|_| error("autonomous_state_provisioning_input_missing"))?;
    if metadata.file_type().is_symlink()
        || (directory && !metadata.is_dir())
        || (!directory && !metadata.is_file())
    {
        return Err(error(
            "autonomous_state_provisioning_input_identity_invalid",
        ));
    }
    Ok(
        json!({"path": path.to_string_lossy(), "device": metadata.dev(), "inode": metadata.ino(), "mode": metadata.mode() & 0o7777, "size": metadata.len()}),
    )
}

fn plan_payload(options: &AutonomousStateProvisioningOptions) -> Result<Value> {
    // The semantic inputs and the byte observations must describe the same
    // retained objects. A second read may observe a different file generation.
    let machine_input = files::Snapshot::read(&options.machine_intake_config)
        .map_err(|_| error("autonomous_state_provisioning_input_identity_invalid"))?;
    let topic_input = files::Snapshot::read(&options.topic_producer_profile)
        .map_err(|_| error("autonomous_state_provisioning_input_identity_invalid"))?;
    let machine: Value = serde_json::from_slice(&machine_input.bytes)
        .map_err(|_| error("autonomous_state_provisioning_input_json_invalid"))?;
    let topic: Value = serde_json::from_slice(&topic_input.bytes)
        .map_err(|_| error("autonomous_state_provisioning_input_json_invalid"))?;
    if !machine.is_object() || !topic.is_object() {
        return Err(error("autonomous_state_provisioning_input_shape_invalid"));
    }
    if machine["version"]
        .as_i64()
        .is_some_and(|version| version != 2)
    {
        return Err(error(
            "autonomous_state_provisioning_machine_intake_version_invalid",
        ));
    }
    let manifest = manifest(&options.workspace_root)?;
    // Never trust a caller-supplied hash field. The plan identity is derived
    // from the pinned JSON bytes and separately reports those opaque fields.
    let machine_hash = input_hash("AutonomousResearchMachineIntakeConfiguration", &machine)?;
    let topic_hash = input_hash("AutonomousResearchTopicProducerProfile", &topic)?;
    let provider_hash = input_hash("AutonomousResearchProviderConfiguration", &topic)?;
    let policy = json!({"maximumAttemptsPerEpoch": options.maximum_attempts_per_epoch, "maximumCostUsdPerEpoch": options.maximum_cost_usd_per_epoch});
    let policy_hash = input_hash("RuntimeReproducibilityRefreshPolicy", &policy)?;
    let manifest_hash = input_hash("AutonomousResearchStateDatabaseManifest", &manifest)?;
    let writer_manifest_path = options.workspace_root.join(
        "rust/crates/hepta-paper-service/src/state_recoverability/cli/writer-manifest.v1.json",
    );
    let writer_manifest = read_json(&writer_manifest_path)?;
    let writer_hash = input_hash(
        "AutonomousResearchOnlineWriterOperationManifest",
        &writer_manifest,
    )?;
    let identity = json!({"machineIntakeConfigurationHash": machine_hash, "machineIntakeGenesisAuthorityMode": options.machine_intake_genesis_authority, "providerCanaryPairMaximumCostUsd": options.maximum_cost_usd_per_epoch, "providerConfigurationHash": provider_hash, "runtimeReproducibilityRefreshPolicyHash": policy_hash, "topicProducerProfileHash": topic_hash, "writerManifestHash": writer_hash, "callerDeclaredMachineIntakeConfigurationHash": machine.get("configurationHash"), "callerDeclaredTopicProducerProfileHash": topic.get("producerProfileHash"), "callerDeclaredProviderConfigurationHash": topic.get("providerConfigurationHash")});
    let roles = manifest["databases"]
        .as_array()
        .ok_or_else(|| error("autonomous_state_provisioning_manifest_invalid"))?
        .iter()
        .filter_map(|row| row["role"].as_str())
        .map(str::to_owned)
        .collect::<Vec<_>>();
    let payload = json!({"version": 1, "kind": "AutonomousResearchStateBusinessSchemaProvisioningPlan", "status": "autonomous_research_state_business_schema_provisioning_plan_ready", "ready": true, "runtimeRoot": options.runtime_root, "stateDatabaseManifestHash": manifest_hash, "databaseRoles": roles, "provisioningIdentity": identity, "machineIntakeConfiguration": machine_input.observation(), "topicProducerProfile": topic_input.observation(), "datasetRoot": inspect_input(&options.dataset_root, true)?, "freshRuntimeRequired": true, "stagedAtomicInstallationRequired": true, "onlineSchemaTransitionRequired": true});
    machine_input
        .assert_current()
        .and_then(|()| topic_input.assert_current())
        .map_err(|_| error("autonomous_state_provisioning_input_identity_invalid"))?;
    // The public plan ID is added once by the caller, after root normalization.
    // It must never commit to an earlier, hidden copy of its own ID.
    Ok(payload)
}

pub fn inspect_autonomous_state_provisioning_v1(
    options: &AutonomousStateProvisioningOptions,
) -> Result<Value> {
    if options.genesis_inputs.is_some() || options.genesis_inputs_sha256.is_some() {
        return execution::plan(options);
    }
    let runtime = files::absolute(&options.runtime_root)
        .map_err(|_| error("autonomous_state_provisioning_cwd_invalid"))?;
    if runtime.exists() {
        return Err(error(
            "autonomous_state_provisioning_fresh_runtime_required",
        ));
    }
    let mut payload = plan_payload(options)?;
    payload["runtimeRoot"] = json!(runtime);
    let plan_id = input_hash(
        "AutonomousResearchStateBusinessSchemaProvisioningPlan",
        &payload,
    )?;
    payload["provisioningPlanId"] = json!(plan_id);
    Ok(payload)
}

pub fn execute_autonomous_state_provisioning_v1(
    options: &AutonomousStateProvisioningOptions,
) -> Result<Value> {
    if options.genesis_inputs.is_some() || options.genesis_inputs_sha256.is_some() {
        return execution::execute(options);
    }
    let plan = inspect_autonomous_state_provisioning_v1(options)?;
    if options.expected_plan_id.as_deref() != plan["provisioningPlanId"].as_str() {
        return Err(error("autonomous_state_provisioning_plan_mismatch"));
    }
    Ok(
        json!({"version": 1, "kind": "AutonomousResearchStateBusinessSchemaProvisioningReceipt", "status": "autonomous_research_state_business_schema_provisioning_blocked", "ready": false, "provisioningPlanId": plan["provisioningPlanId"], "stateDatabaseManifestHash": plan["stateDatabaseManifestHash"], "databaseRoles": plan["databaseRoles"], "provisioningIdentity": plan["provisioningIdentity"], "freshRuntimeInstalled": false, "externalAuthorityInvoked": false, "runtimeEvidenceWritten": false, "blockers": [PROVISIONING_BLOCKER]}),
    )
}
