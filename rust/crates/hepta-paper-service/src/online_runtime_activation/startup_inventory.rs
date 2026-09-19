//! All-ten-database startup reconciliation bound to one observed inventory.
//!
//! This is the missing local composition step between the per-database startup
//! reconciler and runtime activation. It performs no business DML, does not
//! mint an active coordinator, and retains the per-database opaque
//! confirmations so callers cannot replace them with JSON claims.
use super::database::StartupDatabaseSnapshotV1;
use super::database::open_live_activation_database_v1;
use crate::sqlite_mutation_coordinator::authority;
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
    post_inventory: crate::state_database_inventory::ObservedStateDatabaseInventoryV1,
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
        self.post_inventory.assert_current()?;
        if inventory.runtime_root() != self.runtime_root
            || inventory.value()["inventoryHash"] != self.inventory_hash
            || authority.configuration_hash() != self.authority_configuration_hash
        {
            return Err(fail("subject_changed"));
        }
        for (role, instance, proof) in &self.entries {
            proof.assert_confirmation_current(authority, before)?;
            let observed_role = inventory.value()["instances"]
                .as_array()
                .and_then(|instances| {
                    instances
                        .iter()
                        .find(|entry| entry["instanceId"].as_str() == Some(instance))
                })
                .ok_or_else(|| fail("database_binding_changed"))?;
            if role != text(observed_role, "role")? {
                return Err(fail("database_binding_changed"));
            }
        }
        let completed = clock.now_millis()?;
        for (_, _, proof) in &self.entries {
            proof.assert_confirmation_valid_at(authority.trust(), completed)?;
        }
        Ok(())
    }
}

fn validate_recovery_delta(
    before: &StartupDatabaseSnapshotV1,
    after: &StartupDatabaseSnapshotV1,
    receipt: &Value,
) -> Result<()> {
    if before.stable_digest != after.stable_digest {
        return Err(fail("database_state_changed_outside_finalization"));
    }
    let old = &before.finalization_rows;
    let mut consumed = vec![false; old.len()];
    let mut added = Vec::new();
    for row in &after.finalization_rows {
        if let Some(index) = old
            .iter()
            .enumerate()
            .find(|(index, candidate)| !consumed[*index] && *candidate == row)
            .map(|(index, _)| index)
        {
            consumed[index] = true;
        } else {
            added.push(row);
        }
    }
    if consumed.iter().any(|used| !used) {
        return Err(fail("finalization_receipt_removed"));
    }
    let recovered = receipt["recoveredReservationIds"]
        .as_array()
        .ok_or_else(|| fail("recovery_receipt_invalid"))?;
    if added.len() != recovered.len() {
        return Err(fail("finalization_receipt_delta_invalid"));
    }
    for row in added {
        let reservation_id = text(row, "reservation_id")?;
        if !recovered
            .iter()
            .any(|id| id.as_str() == Some(reservation_id))
        {
            return Err(fail("finalization_receipt_unexpected"));
        }
        let receipt_json = row["finalization_receipt_json"]
            .as_str()
            .ok_or_else(|| fail("finalization_receipt_json_invalid"))?;
        let finalization = authority::files::parse(
            receipt_json.as_bytes(),
            "autonomous_research_online_mutation_startup_finalization_receipt_invalid",
        )?;
        if finalization["kind"] != "AutonomousResearchOnlineMutationFinalizationReceipt"
            || finalization["status"] != "autonomous_research_online_mutation_finalized"
            || finalization["reservationId"] != reservation_id
            || row["finalization_receipt_hash"]
                != crate::sqlite_mutation_coordinator::contracts::online_mutation_receipt_hash_v1(
                    &finalization,
                )?
            || row["side_effect_permit_hash"] != finalization["sideEffectPermitHash"]
            || row["finalized_at"] != finalization["finalizedAt"]
        {
            return Err(fail("finalization_receipt_column_mismatch"));
        }
        let head = receipt["finalizedHeads"]
            .as_array()
            .and_then(|heads| {
                heads
                    .iter()
                    .find(|head| head["reservationId"] == reservation_id)
            })
            .ok_or_else(|| fail("finalization_head_missing"))?;
        if finalization["globalSequence"] != head["globalSequence"]
            || finalization["globalHash"] != head["globalHash"]
        {
            return Err(fail("finalization_head_mismatch"));
        }
    }
    Ok(())
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
        let before_state = database.startup_snapshot()?;
        let proof =
            database.reconcile_startup(authority, writer_manifest, &mut clock, &role, &instance)?;
        let after_state = database.startup_snapshot()?;
        validate_recovery_delta(&before_state, &after_state, proof.value())?;
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
    let post_inventory = inventory.reobserve_post_write_v1()?;
    post_inventory.assert_current()?;
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
        "postInventoryHash": post_inventory.value()["inventoryHash"],
        "postDatabaseScopeHash": post_inventory.value()["databaseScopeHash"],
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
        post_inventory,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;
    use serde_json::json;

    fn finalization_row(reservation_id: &str) -> (Value, Value) {
        let finalization = json!({
            "version": 1,
            "kind": "AutonomousResearchOnlineMutationFinalizationReceipt",
            "status": "autonomous_research_online_mutation_finalized",
            "reservationId": reservation_id,
            "globalSequence": 7,
            "globalHash": "sha256:global",
            "sideEffectPermitHash": "sha256:permit",
            "finalizedAt": "2026-07-18T08:00:00.000Z"
        });
        let row = json!({
            "reservation_id": reservation_id,
            "finalization_receipt_hash": crate::sqlite_mutation_coordinator::contracts::online_mutation_receipt_hash_v1(&finalization).unwrap(),
            "finalization_receipt_json": finalization.to_string(),
            "side_effect_permit_hash": finalization["sideEffectPermitHash"],
            "finalized_at": finalization["finalizedAt"],
            "recorded_at": "2026-07-18T08:00:00.001Z"
        });
        (row, finalization)
    }

    #[test]
    fn nonempty_recovery_delta_is_exact_and_business_tamper_is_rejected() {
        let old = json!({
            "reservation_id": "reservation:old",
            "finalization_receipt_hash": "sha256:old",
            "finalization_receipt_json": "{}",
            "side_effect_permit_hash": "sha256:old-permit",
            "finalized_at": "2026-07-18T07:00:00.000Z",
            "recorded_at": "2026-07-18T07:00:00.001Z"
        });
        let (new_row, _) = finalization_row("reservation:recovered");
        let before = StartupDatabaseSnapshotV1 {
            stable_digest: "sha256:stable".into(),
            finalization_rows: vec![old.clone()],
        };
        let after = StartupDatabaseSnapshotV1 {
            stable_digest: "sha256:stable".into(),
            finalization_rows: vec![old, new_row],
        };
        let report = json!({
            "recoveredReservationIds": ["reservation:recovered"],
            "finalizedHeads": [{
                "reservationId": "reservation:recovered",
                "globalSequence": 7,
                "globalHash": "sha256:global"
            }]
        });
        validate_recovery_delta(&before, &after, &report).unwrap();

        let tampered = StartupDatabaseSnapshotV1 {
            stable_digest: "sha256:business-was-updated".into(),
            finalization_rows: after.finalization_rows.clone(),
        };
        assert_eq!(
            validate_recovery_delta(&before, &tampered, &report)
                .unwrap_err()
                .code,
            "autonomous_research_online_runtime_activation_startup_database_state_changed_outside_finalization"
        );
    }

    #[test]
    fn sqlite_pending_marker_recovery_appends_only_the_verified_receipt_row() {
        let database = Connection::open_in_memory().unwrap();
        database
            .execute_batch(
                "CREATE TABLE business(id INTEGER PRIMARY KEY,value TEXT);\
                 INSERT INTO business VALUES(1,'before');\
                 CREATE TABLE autonomous_research_online_mutation_authority_marker(reservation_id TEXT PRIMARY KEY,payload TEXT);\
                 CREATE TABLE autonomous_research_online_mutation_finalization_receipt(reservation_id TEXT PRIMARY KEY,finalization_receipt_hash TEXT,finalization_receipt_json TEXT,side_effect_permit_hash TEXT,finalized_at TEXT,recorded_at TEXT);\
                 INSERT INTO autonomous_research_online_mutation_authority_marker VALUES('reservation:recovered','pending');",
            )
            .unwrap();
        let stable_before = crate::online_schema_execution::maintenance::normalization::installation::digest_excluding_table_v1(
            &database,
            "autonomous_research_online_mutation_finalization_receipt",
        )
        .unwrap();
        let before = StartupDatabaseSnapshotV1 {
            stable_digest: stable_before,
            finalization_rows: crate::sqlite_mutation_coordinator::storage::finalization_rows_v1(
                &database,
            )
            .unwrap(),
        };
        let (row, finalization) = finalization_row("reservation:recovered");
        database
            .execute(
                "INSERT INTO autonomous_research_online_mutation_finalization_receipt VALUES(?1,?2,?3,?4,?5,?6)",
                rusqlite::params![
                    row["reservation_id"].as_str().unwrap(),
                    row["finalization_receipt_hash"].as_str().unwrap(),
                    row["finalization_receipt_json"].as_str().unwrap(),
                    row["side_effect_permit_hash"].as_str().unwrap(),
                    row["finalized_at"].as_str().unwrap(),
                    row["recorded_at"].as_str().unwrap()
                ],
            )
            .unwrap();
        let stable_after = crate::online_schema_execution::maintenance::normalization::installation::digest_excluding_table_v1(
            &database,
            "autonomous_research_online_mutation_finalization_receipt",
        )
        .unwrap();
        let after = StartupDatabaseSnapshotV1 {
            stable_digest: stable_after,
            finalization_rows: crate::sqlite_mutation_coordinator::storage::finalization_rows_v1(
                &database,
            )
            .unwrap(),
        };
        let report = json!({
            "recoveredReservationIds": ["reservation:recovered"],
            "finalizedHeads": [{
                "reservationId": "reservation:recovered",
                "globalSequence": finalization["globalSequence"],
                "globalHash": finalization["globalHash"]
            }]
        });
        validate_recovery_delta(&before, &after, &report).unwrap();
        database
            .execute("UPDATE business SET value='tampered' WHERE id=1", [])
            .unwrap();
        let tampered = StartupDatabaseSnapshotV1 {
            stable_digest: crate::online_schema_execution::maintenance::normalization::installation::digest_excluding_table_v1(
                &database,
                "autonomous_research_online_mutation_finalization_receipt",
            )
            .unwrap(),
            finalization_rows: after.finalization_rows.clone(),
        };
        assert!(validate_recovery_delta(&after, &tampered, &report).is_err());
    }
}
