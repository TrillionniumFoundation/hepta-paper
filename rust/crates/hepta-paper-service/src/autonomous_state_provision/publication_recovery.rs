//! Reconcile a completed fresh publication whose terminal receipt was lost.
//! Selected prepared-record and byte identities are verified; business databases
//! are never opened, repaired, rewritten or accepted as production authority.
use super::{
    Result, error, files, input_hash,
    publication::{self, Target},
    recovery::inventory::Snapshot,
    schema, valid_hash,
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    collections::BTreeSet,
    os::unix::fs::MetadataExt,
    path::{Path, PathBuf},
};
const INVALID: &str = "autonomous_state_provisioning_publication_recovery_invalid";
const PREPARED: &str = "native-provisioning-receipt.json";
const TERMINAL: &str = "native-provisioning-publication.json";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
    version: u32,
    kind: String,
    action: String,
    runtime_root: PathBuf,
    expected_prepared_receipt_hash: String,
    execute: bool,
    expected_plan_hash: Option<String>,
}
impl Request {
    fn validate(&self) -> Result<()> {
        if self.version != 1
            || self.kind != "NativeStatePublicationRecoveryRequestV1"
            || !self.runtime_root.is_absolute()
            || !valid_hash(&self.expected_prepared_receipt_hash)
        {
            return Err(error(INVALID));
        }
        match self.action.as_str() {
            "inspect" if !self.execute && self.expected_plan_hash.is_none() => Ok(()),
            "finalize"
                if self.execute && self.expected_plan_hash.as_deref().is_some_and(valid_hash) =>
            {
                Ok(())
            }
            _ => Err(error(INVALID)),
        }
    }
}
fn keys(value: &Value, expected: &[&str]) -> Result<()> {
    let actual = value
        .as_object()
        .ok_or_else(|| error(INVALID))?
        .keys()
        .map(String::as_str)
        .collect::<BTreeSet<_>>();
    if actual != expected.iter().copied().collect::<BTreeSet<_>>() {
        return Err(error(INVALID));
    }
    Ok(())
}
fn verify_prepared(
    prepared: &Value,
    request: &Request,
    snapshot: &Snapshot,
    target: &Target,
) -> Result<()> {
    keys(
        prepared,
        &[
            "version",
            "kind",
            "status",
            "ready",
            "runtimeRoot",
            "provisioningPlanId",
            "stateDatabaseManifestHash",
            "databaseRoles",
            "provisioningIdentity",
            "databaseInstances",
            "nativeExecutionProfile",
            "schemaBundleHash",
            "nativeExecution",
            "freshRuntimeInstalled",
            "publicationState",
            "externalAuthoritySelfSigned",
            "providerInvocationPerformed",
            "networkAccessPerformed",
            "onlineSchemaTransitionRequired",
            "productionActivation",
            "nodeRetirement",
            "recoveryPolicy",
            "provisioningReceiptHash",
        ],
    )?;
    let manifest: Value = serde_json::from_slice(include_bytes!(
        "../../../../../paper-core/config/autonomous-research-state-databases.v1.json"
    ))?;
    if prepared["version"] != 1
        || prepared["kind"] != "AutonomousResearchStateBusinessSchemaProvisioningReceipt"
        || prepared["status"] != "autonomous_research_state_business_schemas_prepared"
        || prepared["publicationState"] != "prepared"
        || prepared["nativeExecutionProfile"] != "pinned-external-genesis-v1"
        || prepared["nativeExecution"] != true
        || prepared["onlineSchemaTransitionRequired"] != true
        || prepared["recoveryPolicy"]
            != "retain_staging_or_published_target_never_automatically_retry"
        || prepared["runtimeRoot"] != json!(target.path)
        || prepared["schemaBundleHash"] != schema::bundle_hash()?
        || prepared["stateDatabaseManifestHash"]
            != input_hash("AutonomousResearchStateDatabaseManifest", &manifest)?
        || !prepared["provisioningPlanId"]
            .as_str()
            .is_some_and(valid_hash)
    {
        return Err(error(INVALID));
    }
    for flag in [
        "ready",
        "freshRuntimeInstalled",
        "externalAuthoritySelfSigned",
        "providerInvocationPerformed",
        "networkAccessPerformed",
        "productionActivation",
        "nodeRetirement",
    ] {
        if prepared[flag] != false {
            return Err(error(INVALID));
        }
    }
    let mut hash_body = prepared.clone();
    hash_body
        .as_object_mut()
        .ok_or_else(|| error(INVALID))?
        .remove("provisioningReceiptHash");
    let actual_hash = input_hash(
        "AutonomousResearchStateBusinessSchemaProvisioningReceipt",
        &hash_body,
    )?;
    if prepared["provisioningReceiptHash"] != actual_hash
        || actual_hash != request.expected_prepared_receipt_hash
    {
        return Err(error(
            "autonomous_state_provisioning_prepared_receipt_pin_mismatch",
        ));
    }
    let identity = &prepared["provisioningIdentity"];
    keys(
        identity,
        &[
            "machineIntakeConfigurationHash",
            "machineIntakeGenesisAuthorityMode",
            "providerCanaryPairMaximumCostUsd",
            "providerConfigurationHash",
            "runtimeReproducibilityRefreshPolicyHash",
            "topicProducerProfileHash",
            "writerManifestHash",
        ],
    )?;
    if identity["machineIntakeGenesisAuthorityMode"] != "external"
        || !identity["providerCanaryPairMaximumCostUsd"]
            .as_f64()
            .is_some_and(|n| n.is_finite() && n > 0.0)
    {
        return Err(error(INVALID));
    }
    for name in [
        "machineIntakeConfigurationHash",
        "providerConfigurationHash",
        "runtimeReproducibilityRefreshPolicyHash",
        "topicProducerProfileHash",
        "writerManifestHash",
    ] {
        if !identity[name].as_str().is_some_and(valid_hash) {
            return Err(error(INVALID));
        }
    }
    let definitions = manifest["databases"]
        .as_array()
        .ok_or_else(|| error(INVALID))?;
    let instances = prepared["databaseInstances"]
        .as_array()
        .ok_or_else(|| error(INVALID))?;
    let inventory = snapshot.publication_observation();
    let observed = inventory["files"]
        .as_array()
        .ok_or_else(|| error(INVALID))?;
    if definitions.len() != 10 || instances.len() != 10 || observed.len() != 11 {
        return Err(error(INVALID));
    }
    let mut roles = Vec::new();
    let mut paths = BTreeSet::new();
    for row in instances {
        keys(
            row,
            &[
                "role",
                "sourceRelativePath",
                "bytes",
                "sourceSha256",
                "businessSchemaHash",
            ],
        )?;
        let role = row["role"].as_str().ok_or_else(|| error(INVALID))?;
        let path = row["sourceRelativePath"]
            .as_str()
            .ok_or_else(|| error(INVALID))?;
        if !paths.insert(path)
            || !row["businessSchemaHash"].as_str().is_some_and(valid_hash)
            || !row["bytes"]
                .as_u64()
                .is_some_and(|n| n > 0 && n <= 32 * 1024 * 1024)
            || !definitions
                .iter()
                .any(|d| d["role"] == role && d["relativePath"] == path)
        {
            return Err(error(INVALID));
        }
        let bytes = observed
            .iter()
            .find(|f| f["path"] == path)
            .ok_or_else(|| error(INVALID))?;
        if bytes["sha256"] != row["sourceSha256"] || bytes["identity"]["bytes"] != row["bytes"] {
            return Err(error(
                "autonomous_state_provisioning_published_database_changed",
            ));
        }
        roles.push(role);
    }
    roles.sort_unstable();
    if prepared["databaseRoles"] != json!(roles) {
        return Err(error(INVALID));
    }
    Ok(())
}
fn recovery_plan_hash(plan: &Value) -> Result<String> {
    hepta_control_plane::canonical_hash_v1(plan)
        .map(|digest| digest.to_string())
        .map_err(|_| error(INVALID))
}
fn reconcile(
    request: &Request,
    revalidate_request: &impl Fn() -> Result<()>,
    hook: &mut impl FnMut(&str) -> Result<()>,
) -> Result<Value> {
    request.validate()?;
    let target = Target::open_parent(&request.runtime_root)?;
    let _lock = target.lock()?;
    let mut snapshot = Snapshot::capture_published(&target.path, target.parent.metadata()?.dev())?;
    let prepared = snapshot
        .read_document(PREPARED)?
        .ok_or_else(|| error(INVALID))?;
    verify_prepared(&prepared, request, &snapshot, &target)?;
    let expected_terminal = publication::terminal_receipt(&prepared)?;
    let terminal = snapshot.read_document(TERMINAL)?;
    if terminal.as_ref().is_some_and(|t| t != &expected_terminal) {
        return Err(error(
            "autonomous_state_provisioning_terminal_receipt_conflict",
        ));
    }
    let mut plan = json!({"version":1,"kind":"NativeStatePublicationRecoveryPlanV1",
        "runtimeRoot":target.path,"parentIdentity":target.observation()?,
        "preparedReceiptHash":request.expected_prepared_receipt_hash,
        "inventory":snapshot.publication_observation(),"databaseWritesAllowed":false,
        "productionActivation":false,"nodeRetirement":false});
    // This new native-only plan preserves complete u64 inode/device identities.
    // Node-compatible numeric hashing is appropriate for the historical receipt,
    // not for this kernel-object snapshot (integers above 2^53 must not collide).
    plan["recoveryPlanHash"] = json!(recovery_plan_hash(&plan)?);
    snapshot.verify(&target.path)?;
    target.assert_current()?;
    revalidate_request()?;
    if request.action == "inspect" {
        return Ok(
            json!({"version":1,"kind":"NativeStatePublicationRecoveryInspectionV1",
            "state":if terminal.is_some(){"terminal_present"}else{"published_without_terminal"},
            "plan":plan,"mutationPerformed":false}),
        );
    }
    if request.expected_plan_hash.as_deref() != plan["recoveryPlanHash"].as_str() {
        return Err(error(
            "autonomous_state_provisioning_publication_recovery_plan_mismatch",
        ));
    }
    let mut terminal_attempted = false;
    let outcome = (|| {
        hook("before_terminal")?;
        snapshot.verify(&target.path)?;
        target.assert_current()?;
        revalidate_request()?;
        snapshot.flush()?;
        target.parent.sync_all()?;
        if terminal.is_none() {
            terminal_attempted = true;
            publication::write_terminal(
                snapshot.root_directory()?,
                &target.path,
                &expected_terminal,
            )?;
        }
        hook("after_terminal")?;
        // Adding the terminal file changes the allowed inventory. Re-observe and
        // compare the original held database and root identities, not just bytes.
        let mut completed =
            Snapshot::capture_published(&target.path, target.parent.metadata()?.dev())?;
        if completed.publication_observation() != snapshot.publication_observation()
            || completed.read_document(TERMINAL)?.as_ref() != Some(&expected_terminal)
        {
            return Err(error(INVALID));
        }
        completed.verify(&target.path)?;
        target.assert_current()?;
        revalidate_request()?;
        hook("after_terminal_verified")?;
        Ok(expected_terminal)
    })();
    outcome.map_err(|failure|error(format!("{}; publicationState=published; terminalWriteAttempted={}; runtimeRoot={}; databaseWritesPerformed=false; automaticRetryAllowed=false",
        failure.0,terminal_attempted,target.path.display())))
}
/// Existing provisioning CLI's published-root recovery profile. Requires a
/// separately selected prepared-receipt hash; recovering that historical result
/// never revalidates or grants current genesis, writer or provider permission.
pub fn reconcile_publication_cli_v1(argv: &[String]) -> Result<Value> {
    if argv.len() != 2 || argv[0] != "--recover-publication" || !Path::new(&argv[1]).is_absolute() {
        return Err(error(INVALID));
    }
    let request_file = files::Snapshot::read(Path::new(&argv[1]))?;
    if request_file.bytes.len() > 65_536 {
        return Err(error(INVALID));
    }
    let raw =
        crate::sqlite_mutation_coordinator::authority::files::parse(&request_file.bytes, INVALID)
            .map_err(|_| error(INVALID))?;
    let request: Request = serde_json::from_value(raw)?;
    reconcile(
        &request,
        &|| request_file.assert_current().map_err(Into::into),
        &mut |_| Ok(()),
    )
}
#[cfg(test)]
mod tests;
