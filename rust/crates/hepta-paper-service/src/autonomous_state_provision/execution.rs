//! The public command uses one plan, constructor and publication owner.
use super::{
    AutonomousStateProvisioningOptions, Result, error, input_hash,
    inputs::{Inputs, now},
    publication::{self, Target},
    schema,
};
use serde_json::{Value, json};
fn planned(inputs: &Inputs, target: &Target) -> Result<Value> {
    let mut roles = inputs.manifest["databases"]
        .as_array()
        .ok_or_else(|| error("autonomous_state_provisioning_manifest_invalid"))?
        .iter()
        .map(|d| {
            d["role"]
                .as_str()
                .map(str::to_owned)
                .ok_or_else(|| error("autonomous_state_provisioning_manifest_invalid"))
        })
        .collect::<Result<Vec<_>>>()?;
    roles.sort();
    let mut payload = json!({"version":1,"kind":"AutonomousResearchStateBusinessSchemaProvisioningPlan",
        "status":"autonomous_research_state_business_schema_provisioning_plan_ready","ready":true,
        "runtimeRoot":target.path,"parentIdentity":target.observation()?,
        "stateDatabaseManifestHash":input_hash("AutonomousResearchStateDatabaseManifest",&inputs.manifest)?,
        "databaseRoles":roles,"provisioningIdentity":inputs.identity()?,
        "nativeExecutionProfile":"pinned-external-genesis-v1","inputBindings":inputs.binding,
        "freshRuntimeRequired":true,"stagedAtomicInstallationRequired":true,
        "onlineSchemaTransitionRequired":true,"productionActivation":false,"nodeRetirement":false});
    payload["provisioningPlanId"] = json!(input_hash(
        "AutonomousResearchStateBusinessSchemaProvisioningPlan",
        &payload
    )?);
    Ok(payload)
}
pub(super) fn plan(options: &AutonomousStateProvisioningOptions) -> Result<Value> {
    let target = Target::open(&options.runtime_root)?;
    let inputs = Inputs::load(options)?;
    let plan = planned(&inputs, &target)?;
    inputs.assert_current()?;
    target.assert_current()?;
    Ok(plan)
}
pub(super) fn execute(options: &AutonomousStateProvisioningOptions) -> Result<Value> {
    if options.action != "execute" || !options.execute {
        return Err(error(
            "autonomous_state_provisioning_execute_confirmation_required",
        ));
    }
    let target = Target::open(&options.runtime_root)?;
    let inputs = Inputs::load(options)?;
    let plan = planned(&inputs, &target)?;
    if options.expected_plan_id.as_deref() != plan["provisioningPlanId"].as_str() {
        return Err(error("autonomous_state_provisioning_plan_mismatch"));
    }
    let images = schema::build(&inputs, &now()?)?;
    inputs.assert_current()?;
    let mut receipt = json!({"version":1,"kind":"AutonomousResearchStateBusinessSchemaProvisioningReceipt",
        "status":"autonomous_research_state_business_schemas_prepared","ready":false,
        "runtimeRoot":target.path,"provisioningPlanId":plan["provisioningPlanId"],
        "stateDatabaseManifestHash":plan["stateDatabaseManifestHash"],"databaseRoles":plan["databaseRoles"],
        "provisioningIdentity":plan["provisioningIdentity"],"databaseInstances":images.iter().map(schema::Image::observation).collect::<Vec<_>>(),
        "nativeExecutionProfile":"pinned-external-genesis-v1","schemaBundleHash":schema::bundle_hash()?,
        "nativeExecution":true,"freshRuntimeInstalled":false,"publicationState":"prepared",
        "externalAuthoritySelfSigned":false,
        "providerInvocationPerformed":false,"networkAccessPerformed":false,
        "onlineSchemaTransitionRequired":true,"productionActivation":false,"nodeRetirement":false,
        "recoveryPolicy":"retain_staging_or_published_target_never_automatically_retry"});
    receipt["provisioningReceiptHash"] = json!(input_hash(
        "AutonomousResearchStateBusinessSchemaProvisioningReceipt",
        &receipt
    )?);
    publication::publish(&target, &images, &receipt, &|| inputs.assert_current())
}
