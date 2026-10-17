//! Original recovery configuration diagnostics from actual retained files.
//! No lookup/resume/qualifier process executes and no recovery authority is minted.
mod capability;
mod files;
#[cfg(test)]
mod tests;
mod value;

use crate::external_qualification_configuration::read_external_research_qualification_process_configuration_v3;
use serde_json::{Value, json};
use std::{collections::BTreeMap, path::Path};
use value::*;

type Result<T> = std::result::Result<T, String>;
const INVALID: &str =
    "autonomous_research_supervisor_external_action_recovery_configuration_invalid";
const REQUIRED: &str =
    "autonomous_research_supervisor_external_action_recovery_configuration_required";
const NOT_VERIFIED: &str =
    "autonomous_research_supervisor_external_action_recovery_capability_not_verified";
const CONFIG_ENV: &str = "HEPTA_AUTONOMOUS_RESEARCH_EXTERNAL_ACTION_RECOVERY_CONFIG";
const CONFIG_KEYS: &[&str] = &[
    "actionConfigurationIdentityHashes",
    "capabilityReceipt",
    "kind",
    "processCommandRole",
    "processConfigurationIdentityHash",
    "processConfigurationPath",
    "version",
];

/// Observe actual original recovery and V3 process configurations and reproduce
/// their completed diagnostic. Current V3 release-attestor trust remains distinct
/// from recovery-purpose trust. A blocked inspection can contain valid recorded
/// configuration hashes; those hashes never grant permission to recover.
///
/// All regular file owners drop before return. Invoke before caller-owned SQLite
/// connections or database descriptors because V3 argument resources may alias
/// a database. Explicit environment/cwd are captured inputs, not ambient watches.
#[must_use]
pub fn inspect_autonomous_research_supervisor_external_action_recovery_configuration_v1(
    config_path: Option<&Path>,
    environment: &BTreeMap<String, String>,
    cwd: &Path,
    now_millis: i64,
) -> Value {
    match inspect(config_path, environment, cwd, now_millis) {
        Ok(value) => value,
        Err(blocker) => json!({
            "version": 1,
            "kind": "AutonomousResearchSupervisorExternalActionRecoveryConfigurationInspection",
            "ready": false,
            "signedCapabilityVerified": false,
            "configurationIdentityHash": null,
            "processIdentityHash": null,
            "trustIdentityHash": null,
            "capabilityReceiptHash": null,
            "actionConfigurationIdentityHashes": null,
            "blocker": blocker,
            "externalActionPerformed": false,
        }),
    }
}

fn inspect(
    config_path: Option<&Path>,
    environment: &BTreeMap<String, String>,
    cwd: &Path,
    now_millis: i64,
) -> Result<Value> {
    let selected = config_path
        .filter(|path| !path.as_os_str().is_empty())
        .or_else(|| {
            environment
                .get(CONFIG_ENV)
                .filter(|path| !path.is_empty())
                .map(Path::new)
        })
        .ok_or_else(|| REQUIRED.to_owned())?;
    let path = files::absolute(selected, cwd)?;
    let file = files::ObservedConfiguration::capture(&path)?;
    let document = Document::parse(file.bytes())?;
    let config = &document.value;
    ensure(
        exact(config, CONFIG_KEYS)
            && config["version"].as_f64() == Some(1.0)
            && config["kind"] == "AutonomousResearchSupervisorExternalActionRecoveryProcessConfiguration"
            && config["processCommandRole"] == "qualifier"
            && sha(&config["processConfigurationIdentityHash"])
            && action_identities(&config["actionConfigurationIdentityHashes"])
            // Original typeof object accepts arrays here; the capability exact
            // contract subsequently refuses them. Do not turn them into an IO error.
            && (config["capabilityReceipt"].is_object() || config["capabilityReceipt"].is_array()),
        INVALID,
    )?;
    let nested = config["processConfigurationPath"].as_str().ok_or_else(|| {
        "autonomous_research_supervisor_external_action_recovery_path_profile_unsupported"
            .to_owned()
    })?;
    let parent = path.parent().ok_or_else(|| INVALID.to_owned())?;
    let nested = files::absolute(Path::new(nested), parent)?;
    let process = read_external_research_qualification_process_configuration_v3(
        Some(&nested),
        environment,
        cwd,
    )
    .map_err(|error| error.code().to_owned())?;
    let identity = process.identity();
    ensure(
        identity["configurationIdentityHash"] == config["processConfigurationIdentityHash"],
        "autonomous_research_supervisor_external_action_recovery_process_identity_changed",
    )?;
    let receipt = &config["capabilityReceipt"];
    let capability_hash = receipt
        .get("autonomousResearchSupervisorExternalActionRecoveryCapabilityReceiptHash")
        .filter(|value| truthy(value))
        .cloned()
        .unwrap_or(Value::Null);
    let configuration_hash = hash(
        "AutonomousResearchSupervisorExternalActionRecoveryConfigurationIdentity",
        &json!({
            "processConfigurationIdentityHash": identity["configurationIdentityHash"],
            "processCommandIdentityHash": identity["qualifier"]["commandIdentityHash"],
            "recoveryTrustIdentityHash": identity["trustIdentityHash"],
            "capabilityReceiptHash": capability_hash,
            "actionConfigurationIdentityHashes": config["actionConfigurationIdentityHashes"],
        }),
    )?;
    // The real Node V3 reader returns a public KeyObject. Its original recovery
    // adapter passes that object to a contract requiring a string PEM. The native
    // owner exposes PEM for other purposes, but converting it here would change
    // that original trust boundary. None represents this observed non-string
    // input, not a missing/failed public-key read; the V3 owner validated the key.
    let original_public_key_pem: Option<&str> = None;
    let ready = capability::verify(
        receipt,
        &identity["trustedSigner"],
        original_public_key_pem,
        &identity["qualifier"]["commandIdentityHash"],
        &identity["configurationIdentityHash"],
        &identity["trustIdentityHash"],
        now_millis,
    )? && document.action_order_matches()?;
    let result = json!({
        "version": 1,
        "kind": "AutonomousResearchSupervisorExternalActionRecoveryConfigurationInspection",
        "ready": ready,
        "signedCapabilityVerified": ready,
        "configurationIdentityHash": configuration_hash,
        "processIdentityHash": identity["qualifier"]["commandIdentityHash"],
        "trustIdentityHash": identity["trustIdentityHash"],
        "capabilityReceiptHash": capability_hash,
        "actionConfigurationIdentityHashes": config["actionConfigurationIdentityHashes"],
        "blocker": if ready { Value::Null } else { json!(NOT_VERIFIED) },
        "externalActionPerformed": false,
    });
    process
        .assert_current()
        .map_err(|error| error.code().to_owned())?;
    file.assert_current()?;
    // Retained regular V3/config owners must not escape into a later SQL stage.
    drop(process);
    drop(file);
    Ok(result)
}
