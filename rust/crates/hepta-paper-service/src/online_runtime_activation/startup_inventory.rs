//! All-ten-database startup reconciliation bound to one observed inventory.
//!
//! This is the missing local composition step between the per-database startup
//! reconciler and runtime activation. It performs no business DML, does not
//! mint an active coordinator, and retains the per-database opaque
//! confirmations so callers cannot replace them with JSON claims.
use super::database::open_live_activation_database_v1;
use crate::{
    online_runtime_activation::inventory::assert_closed_activation_inventory_v1,
    sqlite_mutation_coordinator::{
        Result,
        authority::{MutationAuthorityTransportV1, PinnedMutationAuthorityV1},
        clock::MutationClockV1,
        manifest::{assert_writer_manifest_v1, writer_manifest_hash_v1},
        startup::StartupMutationReconciliationV1,
        text,
    },
    state_database_inventory::ObservedStateDatabaseInventoryV1,
};
use serde_json::{Value, json};
use std::{cell::Cell, path::PathBuf};

fn fail(suffix: &str) -> crate::sqlite_mutation_coordinator::SqliteMutationCoordinatorError {
    crate::sqlite_mutation_coordinator::error(format!(
        "autonomous_research_online_runtime_activation_startup_{suffix}"
    ))
}

struct MonotonicClock<'a> {
    inner: &'a mut dyn MutationClockV1,
    high_water: &'a Cell<i64>,
}
impl MutationClockV1 for MonotonicClock<'_> {
    fn now_millis(&mut self) -> Result<i64> {
        let now = self.inner.now_millis()?;
        if now < self.high_water.get() {
            return Err(fail("clock_invalid"));
        }
        crate::sqlite_mutation_coordinator::clock::iso(now).map_err(|_| fail("clock_invalid"))?;
        self.high_water.set(now);
        Ok(now)
    }
}

/// The complete startup proof for all required databases. Its constructor is
/// private to this module's real reconciliation path; serialized reports cannot
/// recreate it or satisfy an activation boundary.
///
/// ```compile_fail
/// use hepta_paper_service::online_runtime_activation::startup_inventory::VerifiedStartupReconciliationSetV1;
/// let proof: VerifiedStartupReconciliationSetV1 = serde_json::from_str("{}").unwrap();
/// ```
pub struct VerifiedStartupReconciliationSetV1 {
    report: Value,
    entries: Vec<(String, String, StartupMutationReconciliationV1)>,
    runtime_root: PathBuf,
    inventory_hash: String,
    authority_configuration_hash: String,
    checked_at: Cell<i64>,
}

impl VerifiedStartupReconciliationSetV1 {
    pub fn value(&self) -> &Value {
        &self.report
    }

    pub fn database_reconciliations(&self) -> &[(String, String, StartupMutationReconciliationV1)] {
        &self.entries
    }

    /// Rechecks every held database identity and every confirmation signature.
    /// It intentionally does not call an authority mutation or construct an
    /// active coordinator.
    pub fn assert_current<T: MutationAuthorityTransportV1>(
        &self,
        inventory: &ObservedStateDatabaseInventoryV1,
        authority: &PinnedMutationAuthorityV1<T>,
        clock: &mut dyn MutationClockV1,
    ) -> Result<()> {
        let mut clock = MonotonicClock {
            inner: clock,
            high_water: &self.checked_at,
        };
        let before = clock.now_millis()?;
        inventory.assert_current()?;
        if inventory.runtime_root() != self.runtime_root
            || inventory.value()["inventoryHash"] != self.inventory_hash
            || authority.configuration_hash() != self.authority_configuration_hash
        {
            return Err(fail("subject_changed"));
        }
        for (role, instance, proof) in &self.entries {
            proof.assert_confirmation_current(authority, before)?;
            if role != text(inventory.current_database_instance(instance)?, "role")? {
                return Err(fail("database_binding_changed"));
            }
        }
        inventory.assert_current()?;
        let completed = clock.now_millis()?;
        for (_, _, proof) in &self.entries {
            proof.assert_confirmation_valid_at(authority.trust(), completed)?;
        }
        Ok(())
    }
}

/// Reconciles every actual database in the closed inventory. Each database is
/// opened through the restricted descriptor-checked path and the original
/// per-database startup state machine. The returned receipt is diagnostic only:
/// `runtimeReady` remains false and no active capability is produced.
pub fn reconcile_online_mutation_startup_set_v1<T: MutationAuthorityTransportV1>(
    inventory: &ObservedStateDatabaseInventoryV1,
    writer_manifest: &Value,
    authority: &mut PinnedMutationAuthorityV1<T>,
    clock: &mut dyn MutationClockV1,
) -> Result<VerifiedStartupReconciliationSetV1> {
    let high_water = Cell::new(i64::MIN);
    let mut clock = MonotonicClock {
        inner: clock,
        high_water: &high_water,
    };
    clock.now_millis()?;
    inventory.assert_current()?;
    assert_writer_manifest_v1(writer_manifest)?;
    assert_closed_activation_inventory_v1(inventory.value(), writer_manifest)
        .map_err(|e| crate::sqlite_mutation_coordinator::error(e.code))?;
    authority.current()?;
    let manifest_hash = writer_manifest_hash_v1(writer_manifest)?;
    if authority.trust()["writerManifestHash"] != manifest_hash
        || authority.trust()["databaseScopeHash"] != inventory.value()["databaseScopeHash"]
    {
        return Err(fail("authority_scope_mismatch"));
    }
    let instances = inventory.value()["instances"]
        .as_array()
        .filter(|rows| rows.len() == crate::sqlite_mutation_coordinator::DATABASE_ROLES.len())
        .ok_or_else(|| fail("inventory_invalid"))?;
    let mut ordered = instances
        .iter()
        .map(|entry| {
            Ok((
                text(entry, "role")?.to_owned(),
                text(entry, "instanceId")?.to_owned(),
            ))
        })
        .collect::<Result<Vec<_>>>()?;
    ordered.sort_by(|a, b| a.1.encode_utf16().cmp(b.1.encode_utf16()));
    let mut entries = Vec::with_capacity(ordered.len());
    for (role, instance) in ordered {
        let mut database = open_live_activation_database_v1(inventory, &instance)
            .map_err(|e| crate::sqlite_mutation_coordinator::error(e.code))?;
        let proof =
            database.reconcile_startup(authority, writer_manifest, &mut clock, &role, &instance)?;
        let value = proof.value();
        if value["status"]
            != "autonomous_research_online_mutation_unresolved_reservations_reconciled"
            || value["runtimeReady"] != false
            || value["businessDmlReplayed"] != false
            || value["databaseRole"] != role
            || value["databaseInstanceId"] != instance
        {
            return Err(fail("receipt_invalid"));
        }
        entries.push((role, instance, proof));
    }
    inventory.assert_current()?;
    let checked = clock.now_millis()?;
    for (_, _, proof) in &entries {
        proof.assert_confirmation_current(authority, checked)?;
    }
    let reconciliations = entries
        .iter()
        .map(|(role, instance, proof)| -> Result<Value> {
            Ok(json!({
                "databaseRole": role,
                "databaseInstanceId": instance,
                "reconciliationReceiptHash": crate::sqlite_mutation_coordinator::contracts::online_mutation_receipt_hash_v1(proof.value())?,
                "receipt": proof.value(),
            }))
        })
        .collect::<Result<Vec<_>>>()?;
    let mut report = json!({
        "version": 1,
        "kind": "AutonomousResearchOnlineMutationStartupReconciliationSetReceipt",
        "status": "autonomous_research_online_mutation_startup_reconciliation_set_reconciled",
        "inventoryHash": inventory.value()["inventoryHash"],
        "databaseScopeHash": inventory.value()["databaseScopeHash"],
        "writerManifestHash": manifest_hash,
        "databaseCount": entries.len(),
        "reconciliations": reconciliations,
        "remainingBlockers": [
            "autonomous_research_online_mutation_finalized_head_reconciliation_required",
            "autonomous_research_online_mutation_active_startup_head_challenge_required"
        ],
        "runtimeReady": false,
        "checkedAt": crate::sqlite_mutation_coordinator::clock::iso(checked)?,
    });
    report["startupReconciliationSetReceiptHash"] = crate::sqlite_mutation_coordinator::hash(
        "AutonomousResearchOnlineMutationStartupReconciliationSetReceipt",
        &report,
    )?
    .into();
    let inventory_hash = text(inventory.value(), "inventoryHash")?.to_owned();
    let completed = clock.now_millis()?;
    for (_, _, proof) in &entries {
        proof.assert_confirmation_valid_at(authority.trust(), completed)?;
    }
    Ok(VerifiedStartupReconciliationSetV1 {
        report,
        entries,
        runtime_root: inventory.runtime_root().to_owned(),
        inventory_hash,
        authority_configuration_hash: authority.configuration_hash().to_owned(),
        checked_at: Cell::new(completed),
    })
}
