//! All-ten-database reconciliation invokes the real pinned mutation authority.
//! Business DML is never replayed during pending-finalization reconciliation.
use super::*;
use crate::online_runtime_activation::database::open_live_activation_database_v1;
use crate::sqlite_mutation_coordinator::{
    authority::{MutationAuthorityTransportV1, PinnedMutationAuthorityV1},
    manifest::writer_manifest_hash_v1,
};
use crate::state_database_inventory::{
    ObservedStateDatabaseInventoryV1, observe_state_database_inventory_v1,
};
use std::path::Path;
pub struct PendingStateReconciliationV1 {
    value: Value,
    pub(super) inventory: ObservedStateDatabaseInventoryV1,
    pub(super) initial_inventory_hash: Value,
}
impl PendingStateReconciliationV1 {
    pub fn value(&self) -> &Value {
        &self.value
    }
}
fn exact_inventory(v: &Value) -> Result<()> {
    let instances = v["instances"]
        .as_array()
        .ok_or_else(|| error("autonomous_research_state_reconcile_and_renew_inventory_invalid"))?;
    let roles = instances
        .iter()
        .filter_map(|v| v["role"].as_str())
        .collect::<std::collections::BTreeSet<_>>();
    let ids = instances
        .iter()
        .filter_map(|v| v["instanceId"].as_str())
        .collect::<std::collections::BTreeSet<_>>();
    ensure(
        instances.len() == 10
            && ids.len() == 10
            && roles
                == crate::sqlite_mutation_coordinator::DATABASE_ROLES
                    .iter()
                    .copied()
                    .collect(),
        "autonomous_research_state_reconcile_and_renew_inventory_invalid",
    )
}
fn stable(a: &Value, b: &Value) -> bool {
    let project = |v: &Value| {
        let mut rows=v["instances"].as_array().into_iter().flatten().map(|r|json!({"role":r["role"],"instanceId":r["instanceId"],"sourceRelativePath":r["sourceRelativePath"],"schemaContractId":r["schemaContractId"],"schemaHash":r["schemaHash"]})).collect::<Vec<_>>();
        rows.sort_by(|a, b| a["instanceId"].as_str().cmp(&b["instanceId"].as_str()));
        rows
    };
    ["manifestId", "manifestHash", "databaseScopeHash"]
        .iter()
        .all(|k| a[k] == b[k])
        && project(a) == project(b)
}
pub(super) fn reconcile<T: MutationAuthorityTransportV1>(
    runtime: &Path,
    database_manifest: &Value,
    writer_manifest: &Value,
    authority: &mut PinnedMutationAuthorityV1<T>,
    backup_trust: &Value,
    clock: &mut dyn MutationClockV1,
) -> Result<PendingStateReconciliationV1> {
    let initial = observe_state_database_inventory_v1(runtime, database_manifest)
        .map_err(|e| error(e.to_string()))?;
    exact_inventory(initial.value())?;
    let writer_hash = writer_manifest_hash_v1(writer_manifest)?;
    ensure(
        authority.trust()["databaseScopeHash"] == initial.value()["databaseScopeHash"]
            && authority.trust()["writerManifestHash"] == writer_hash,
        "autonomous_research_state_reconcile_and_renew_authority_scope_mismatch",
    )?;
    for key in [
        "authorityId",
        "keyId",
        "scopeId",
        "databaseScopeHash",
        "writerManifestHash",
    ] {
        ensure(
            authority.trust()[key] == backup_trust[key],
            "autonomous_research_state_reconcile_and_renew_backup_online_authority_mismatch",
        )?;
    }
    initial.assert_current().map_err(|e| error(e.to_string()))?;
    let mut summaries = Vec::new();
    for instance in initial.value()["instances"]
        .as_array()
        .ok_or_else(|| error("autonomous_research_state_reconcile_and_renew_inventory_invalid"))?
    {
        let mut db = open_live_activation_database_v1(&initial, text(instance, "instanceId")?)
            .map_err(|e| error(e.to_string()))?;
        let receipt = db.reconcile_startup(
            authority,
            writer_manifest,
            clock,
            text(instance, "role")?,
            text(instance, "instanceId")?,
        )?;
        ensure(
            receipt.authority_configuration_hash() == authority.configuration_hash(),
            "autonomous_research_state_reconcile_and_renew_authority_changed",
        )?;
        let r = receipt.value();
        let mut summary = json!({"databaseRole":instance["role"],"databaseInstanceId":instance["instanceId"],"reconciliationReceiptHash":hash("AutonomousResearchOnlineMutationUnresolvedReservationReconciliationReceipt",r)?});
        for key in [
            "recoveredReservationIds",
            "finalizedHeads",
            "abortedRemoteOnlyReservationIds",
            "abortedRemoteOnlyAbortReceiptHashes",
            "abortedRemoteOnlyAbortReceipts",
        ] {
            summary[key] = r[key].clone();
        }
        summaries.push(summary);
    }
    let inventory = observe_state_database_inventory_v1(runtime, database_manifest)
        .map_err(|e| error(e.to_string()))?;
    exact_inventory(inventory.value())?;
    ensure(
        stable(initial.value(), inventory.value()),
        "autonomous_research_state_reconcile_and_renew_inventory_scope_changed",
    )?;
    let mut inspections = Vec::new();
    for instance in inventory.value()["instances"]
        .as_array()
        .ok_or_else(|| error("autonomous_research_state_reconcile_and_renew_inventory_invalid"))?
    {
        let inspection =
            inventory.inspect_pending_finalizations_v1(text(instance, "instanceId")?)?;
        ensure(
            inspection["pendingFinalizationCount"] == 0,
            "autonomous_research_state_reconcile_and_renew_pending_finalization_required",
        )?;
        inspections.push(inspection);
    }
    inventory
        .assert_current()
        .map_err(|e| error(e.to_string()))?;
    let mut recovery = json!({});
    for key in [
        "finalizedHeads",
        "abortedRemoteOnlyReservationIds",
        "abortedRemoteOnlyAbortReceiptHashes",
        "abortedRemoteOnlyAbortReceipts",
    ] {
        recovery[key] = summaries
            .iter()
            .flat_map(|v| v[key].as_array().into_iter().flatten().cloned())
            .collect::<Vec<_>>()
            .into();
    }
    let (_, completed) = clock_now(clock)?;
    let mut value = json!({"version":1,"kind":"AutonomousResearchStatePendingReconciliationReceipt","status":"autonomous_research_state_pending_reconciliation_complete","businessDmlReplayed":false,"databaseScopeHash":inventory.value()["databaseScopeHash"],"reconciledDatabaseCount":summaries.len(),"recoveredFinalizationCount":recovery["finalizedHeads"].as_array().map_or(0,Vec::len),"abortedRemoteOnlyReservationCount":recovery["abortedRemoteOnlyReservationIds"].as_array().map_or(0,Vec::len),"reconciliationAttempted":true,"recovery":recovery,"reconciliations":summaries,"pendingInspections":inspections,"completedAt":completed,"blockers":[]});
    value["pendingReconciliationReceiptHash"] = hash(
        "AutonomousResearchStatePendingReconciliationReceipt",
        &value,
    )?
    .into();
    Ok(PendingStateReconciliationV1 {
        value,
        inventory,
        initial_inventory_hash: initial.value()["inventoryHash"].clone(),
    })
}
