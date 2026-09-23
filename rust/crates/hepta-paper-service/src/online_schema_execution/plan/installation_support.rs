//! Reconstruct the fixed plan/request binding, never a normalized capability,
//! when some real databases have already committed the target schema.
use super::*;
impl ObservedSchemaTransitionPlanV1 {
    pub(in crate::online_schema_execution) fn installation_manifest(&self) -> &Value {
        &self.manifest
    }
}
pub(in crate::online_schema_execution) fn validate_installation_journal<
    T: MutationAuthorityTransportV1,
>(
    journal: &Value,
    manifest: &Value,
    writer: &Value,
    authority: &PinnedMutationAuthorityV1<T>,
) -> Result<()> {
    let plan = &journal["plan"];
    let mut base = plan.clone();
    let object = base.as_object_mut().ok_or_else(invalid)?;
    object.remove("planHash");
    object.remove("transitionId");
    if plan["kind"] != "AutonomousResearchOnlineSchemaTransitionPlan"
        || plan["planHash"] != hash("AutonomousResearchOnlineSchemaTransitionPlan", &base)?
        || plan["transitionId"] != schema_transition_identity_v1(plan)?
        || plan["transitionInventoryHash"] != schema_transition_inventory_hash_v1(plan)?
    {
        return Err(invalid());
    }
    let data: Value = serde_json::from_str(include_str!(
        "../../online_schema_transition/schema_data.json"
    ))
    .map_err(|e| error(e.to_string()))?;
    let journal_hash = hash(
        "AutonomousResearchOnlineAuthorityJournalSchema",
        &json!({"version":data["version"],"contractId":data["contractId"],"statements":data["journal"]}),
    )?;
    let marker_hash = hash(
        "AutonomousResearchOnlineMutationMarkerSchema",
        &json!({"version":1,"protocol":"external-linearizable-reserve-apply-finalize-v1","statements":data["marker"]}),
    )?;
    if plan["stateDatabaseManifestHash"] != state_database_manifest_hash_v1(manifest)?
        || plan["writerManifestHash"] != writer_manifest_hash_v1(writer)?
        || plan["schemaBundleHash"] != schema_transition_bundle_hash_v1()?
        || plan["authorityJournalSchemaHash"] != journal_hash
        || plan["authorityJournalSchemaContractId"] != data["contractId"]
        || plan["markerSchemaHash"] != marker_hash
        || journal["authorityConfigurationHash"] != authority.configuration_hash()
    {
        return Err(invalid());
    }
    let planned =
        crate::sqlite_mutation_coordinator::timestamp(&plan["plannedAt"]).ok_or_else(invalid)?;
    let requested =
        crate::sqlite_mutation_coordinator::timestamp(&journal["request"]["requestedAt"])
            .ok_or_else(invalid)?;
    if planned > requested {
        return Err(invalid());
    }
    let mut request = plan.clone();
    let map = request.as_object_mut().ok_or_else(invalid)?;
    map.remove("planHash");
    map.remove("plannedAt");
    map.insert(
        "kind".into(),
        json!("AutonomousResearchOnlineSchemaTransitionReserveRequest"),
    );
    map.insert(
        "requestedAt".into(),
        journal["request"]["requestedAt"].clone(),
    );
    if plan["version"].as_f64() == Some(1.) {
        map.remove("prePristineRuntimeStateHash");
    }
    assert_schema_transition_reserve_request_v1(&request, authority.trust())?;
    if request != journal["request"] {
        return Err(invalid());
    }
    Ok(())
}
pub(in crate::online_schema_execution) fn validate_installation_inventory(
    inventory: &Value,
    manifest: &Value,
    plan: &Value,
) -> Result<()> {
    validate_inventory(inventory, manifest)?;
    if inventory["databaseScopeHash"] != plan["databaseScopeHash"] {
        return Err(invalid());
    }
    let actual = inventory["instances"].as_array().ok_or_else(invalid)?;
    let reserved = plan["instances"].as_array().ok_or_else(invalid)?;
    if actual.len() != reserved.len() {
        return Err(invalid());
    }
    for (a, b) in actual.iter().zip(reserved) {
        if [
            ("role", "databaseRole"),
            ("instanceId", "databaseInstanceId"),
            ("schemaContractId", "schemaContractId"),
            ("sourceRelativePath", "sourceRelativePath"),
        ]
        .iter()
        .any(|(x, y)| a[*x] != b[*y])
            || (a["schemaHash"] != b["preSchemaHash"]
                && a["schemaHash"] != b["expectedPostSchemaHash"])
        {
            return Err(invalid());
        }
    }
    Ok(())
}
