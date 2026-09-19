//! Fixed original writer-plan composition. A configured coordinator is not an
//! activated runtime, current recoverability epoch, or deployment qualification.
use crate::{
    online_runtime_activation::inventory::assert_closed_activation_inventory_v1,
    sqlite_mutation_coordinator::{
        Result, SqliteMutationCoordinatorOptionsV1, SqliteMutationCoordinatorV1,
        authority::{MutationAuthorityTransportV1, PinnedMutationAuthorityV1},
        clock::MutationClockV1,
        error,
        manifest::{assert_writer_manifest_v1, writer_manifest_hash_v1},
    },
    sqlite_mutation_plan::{ValidatedPlanRegistryV1, validate_sqlite_mutation_plans_v1},
    state_database_inventory::ObservedStateDatabaseInventoryV1,
};
use serde_json::{Value, json};
/// Fixed source data; callers cannot change the configured coordinator's writer
/// definitions or SQL. Every writer implementation hash is recomputed natively.
pub struct BuiltinOnlineMutationPlansV1 {
    manifest: Value,
    plans: Value,
    checked: ValidatedPlanRegistryV1,
}
impl BuiltinOnlineMutationPlansV1 {
    pub fn load() -> Result<Self> {
        let manifest: Value = serde_json::from_str(include_str!(
            "state_recoverability/cli/writer-manifest.v1.json"
        ))
        .map_err(|_| error("autonomous_research_online_mutation_builtin_manifest_invalid"))?;
        let plans: Value = serde_json::from_str(include_str!(
            "online_mutation_composition/operation-plans.v1.json"
        ))
        .map_err(|_| error("autonomous_research_online_mutation_builtin_plans_invalid"))?;
        assert_writer_manifest_v1(&manifest)?;
        let checked = validate_sqlite_mutation_plans_v1(&manifest, &plans)
            .map_err(|e| error(e.to_string()))?;
        Ok(Self {
            manifest,
            plans,
            checked,
        })
    }
    pub fn writer_manifest(&self) -> &Value {
        &self.manifest
    }
    pub fn operation_plans(&self) -> &Value {
        &self.plans
    }
    pub fn checked_plans(&self) -> &ValidatedPlanRegistryV1 {
        &self.checked
    }
}
/// A configured high-level composition exposes diagnostics only. The inner
/// low-level coordinator cannot be extracted, dereferenced or used for writes.
/// Complete activation must separately establish and retain its actual fence.
///
/// ```compile_fail
/// use hepta_paper_service::online_mutation_composition::ConfiguredOnlineMutationCompositionV1;
/// use hepta_paper_service::sqlite_mutation_coordinator::authority::MutationAuthorityTransportV1;
/// use rusqlite::Connection;
/// use serde_json::Value;
/// fn bypass<T: MutationAuthorityTransportV1>(
///     configured: &mut ConfiguredOnlineMutationCompositionV1<T>,
///     database: &mut Connection,
///     input: &Value,
/// ) {
///     configured.execute_mutation(database, input, |_| Ok(Value::Null));
/// }
/// ```
pub struct ConfiguredOnlineMutationCompositionV1<T: MutationAuthorityTransportV1> {
    coordinator: SqliteMutationCoordinatorV1<T>,
}
impl<T: MutationAuthorityTransportV1> ConfiguredOnlineMutationCompositionV1<T> {
    /// Configuration diagnostics, not a current inventory proof or permission.
    pub fn inspect_status(&self) -> Value {
        self.coordinator.inspect_status()
    }
    /// Recheck public authority verifier trust only. Generic transport process
    /// pins must be independently retained by compositions that consume them.
    pub(crate) fn assert_configuration_current(&self) -> Result<()> {
        self.coordinator.assert_configuration_current()
    }
}
/// Construct only the configured stage from real inventory and the full fixed
/// production statement registry. No authority RPC, startup repair, schema
/// migration, active refresh, backup, or action permit is performed here.
/// Full activation must independently attach the concrete recoverability fence.
pub fn compose_configured_online_mutation_coordinator_v1<T: MutationAuthorityTransportV1>(
    inventory: &ObservedStateDatabaseInventoryV1,
    authority: PinnedMutationAuthorityV1<T>,
    clock: Box<dyn MutationClockV1>,
) -> Result<ConfiguredOnlineMutationCompositionV1<T>> {
    inventory.assert_current()?;
    authority.current()?;
    let builtin = BuiltinOnlineMutationPlansV1::load()?;
    assert_closed_activation_inventory_v1(inventory.value(), &builtin.manifest)
        .map_err(|e| error(e.code))?;
    let manifest_hash = writer_manifest_hash_v1(&builtin.manifest)?;
    if authority.trust()["writerManifestHash"] != manifest_hash
        || authority.trust()["databaseScopeHash"] != inventory.value()["databaseScopeHash"]
    {
        return Err(error(
            "autonomous_research_online_mutation_composition_authority_scope_mismatch",
        ));
    }
    let instances = inventory.value()["instances"].as_array().ok_or_else(|| {
        error("autonomous_research_online_mutation_composition_prerequisites_missing")
    })?;
    let mut instances = instances.iter().map(|entry|json!({"databaseRole":entry["role"],"databaseInstanceId":entry["instanceId"],"schemaHash":entry["schemaHash"]})).collect::<Vec<_>>();
    let collator = hepta_legacy_compatibility::ProductionCollationV1::load()
        .map_err(|e| error(e.to_string()))?;
    instances.sort_by(|a, b| {
        collator.compare(
            a["databaseInstanceId"].as_str().unwrap_or(""),
            b["databaseInstanceId"].as_str().unwrap_or(""),
        )
    });
    let coordinator = SqliteMutationCoordinatorV1::new(
        authority,
        SqliteMutationCoordinatorOptionsV1 {
            manifest: builtin.manifest,
            operation_plans: builtin.plans,
            database_instances: json!(instances),
            requested_lease_ms: None,
            commit_safety_margin_ms: 1000,
        },
        clock,
        None,
    )?;
    inventory.assert_current()?;
    let configured = ConfiguredOnlineMutationCompositionV1 { coordinator };
    configured.assert_configuration_current()?;
    Ok(configured)
}
