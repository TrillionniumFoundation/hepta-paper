//! Startup recovery reconciles signed remote reservations with local commit
//! markers. It never replays business DML and never establishes runtime readiness.
use super::authority::{
    MutationAuthorityTransportV1, PinnedMutationAuthorityV1, VerifiedMutationReceiptV1,
};
use super::*;
use rusqlite::{Connection, TransactionBehavior, types::Value as SqlValue};

/// Proven recovery observations, created only by the live reconciliation chain.
/// This is not a fresh finalized-head challenge or a runtime activation permit.
pub struct StartupMutationReconciliationV1 {
    value: Value,
    authority_configuration_hash: String,
    confirmation: VerifiedMutationReceiptV1,
}
impl StartupMutationReconciliationV1 {
    pub fn value(&self) -> &Value {
        &self.value
    }
    pub fn authority_configuration_hash(&self) -> &str {
        &self.authority_configuration_hash
    }
    /// Recheck the original signed confirmation against the same currently pinned
    /// authority. This does not re-observe database state or grant activation.
    pub fn assert_confirmation_current<T: MutationAuthorityTransportV1>(
        &self,
        authority: &PinnedMutationAuthorityV1<T>,
        now_millis: i64,
    ) -> Result<()> {
        if authority.configuration_hash() != self.authority_configuration_hash {
            return Err(error(
                "autonomous_research_online_mutation_startup_authority_changed",
            ));
        }
        let receipt = self.confirmation.value();
        let request = build_unresolved_reservation_list_request_v1(
            authority.trust(),
            text(receipt, "databaseRole")?,
            text(receipt, "databaseInstanceId")?,
            text(receipt, "nonce")?,
            text(receipt, "requestedAt")?,
        );
        authority.verify_unresolved_list_receipt(receipt, &request, now_millis)?;
        Ok(())
    }
}

struct StartupClock<'a> {
    inner: &'a mut dyn clock::MutationClockV1,
    previous: Option<i64>,
}
impl clock::MutationClockV1 for StartupClock<'_> {
    fn now_millis(&mut self) -> Result<i64> {
        let current = self.inner.now_millis()?;
        if self.previous.is_some_and(|previous| current < previous) {
            return Err(error(
                "autonomous_research_online_mutation_startup_clock_invalid",
            ));
        }
        self.previous = Some(current);
        Ok(current)
    }
}

fn now(clock: &mut dyn clock::MutationClockV1) -> Result<(i64, String)> {
    let millis = clock
        .now_millis()
        .map_err(|_| error("autonomous_research_online_mutation_startup_clock_invalid"))?;
    let iso = clock::iso(millis)
        .map_err(|_| error("autonomous_research_online_mutation_startup_clock_invalid"))?;
    Ok((millis, iso))
}
/// Build a descriptive request. The effectful reconciler generates its own
/// cryptographically random nonce; this constructor alone confers no authority.
pub fn build_unresolved_reservation_list_request_v1(
    trust: &Value,
    database_role: &str,
    database_instance_id: &str,
    nonce: &str,
    requested_at: &str,
) -> Value {
    json!({"version":1,"kind":"AutonomousResearchOnlineUnresolvedReservationListRequest","protocol":ONLINE_MUTATION_PROTOCOL,
        "scopeId":trust["scopeId"],"databaseScopeHash":trust["databaseScopeHash"],"writerManifestHash":trust["writerManifestHash"],
        "databaseRole":database_role,"databaseInstanceId":database_instance_id,"nonce":nonce,"requestedAt":requested_at})
}
fn list<T: MutationAuthorityTransportV1>(
    authority: &mut PinnedMutationAuthorityV1<T>,
    role: &str,
    instance: &str,
    clock: &mut dyn clock::MutationClockV1,
) -> Result<VerifiedMutationReceiptV1> {
    let requested_at = now(clock)?.1;
    let request = build_unresolved_reservation_list_request_v1(
        authority.trust(),
        role,
        instance,
        &clock::nonce("unresolved")?,
        &requested_at,
    );
    let receipt = authority.list_unresolved_mutations(&request, now(clock)?.0)?;
    authority.verify_unresolved_list_receipt(receipt.value(), &request, now(clock)?.0)
}
fn manifest_binding(request: &Value, reservation: &Value, manifest: &Value) -> Result<()> {
    let operations = manifest["operations"].as_array().ok_or_else(|| {
        error("autonomous_research_online_mutation_startup_manifest_binding_invalid")
    })?;
    let writers = manifest["writers"].as_array().ok_or_else(|| {
        error("autonomous_research_online_mutation_startup_manifest_binding_invalid")
    })?;
    let operation = operations
        .iter()
        .find(|v| v["operationId"] == reservation["operationId"]);
    let writer = writers.iter().find(|v| {
        v["writerId"] == reservation["writerId"]
            && v["operationIds"]
                .as_array()
                .is_some_and(|a| a.contains(&reservation["operationId"]))
    });
    if !operation.is_some_and(|v| {
        v["coordinatorIntegrated"] == true && v["databaseRole"] == reservation["databaseRole"]
    }) || !writer.is_some_and(|v| v["implementationHash"] == reservation["codeProvenanceHash"])
        || !["mutationAttemptId", "operationId", "writerId"]
            .iter()
            .all(|k| request[*k] == reservation[*k])
    {
        return Err(error(
            "autonomous_research_online_mutation_startup_manifest_binding_invalid",
        ));
    }
    Ok(())
}
#[derive(PartialEq)]
enum MarkerState {
    Absent,
    Pending,
}
fn marker_state(database: &Connection, entry: &Value) -> Result<MarkerState> {
    let reservation = &entry["reservation"];
    let rows = storage::rows(
        database,
        "SELECT marker.reserve_request_hash,marker.reservation_receipt_hash,finalized.reservation_id AS finalized_reservation_id FROM autonomous_research_online_mutation_authority_marker marker LEFT JOIN autonomous_research_online_mutation_finalization_receipt finalized ON finalized.reservation_id=marker.reservation_id WHERE marker.reservation_id=? LIMIT 2;",
        &[SqlValue::Text(text(reservation, "reservationId")?.into())],
    )?;
    let Some(row) = rows.first() else {
        return Ok(MarkerState::Absent);
    };
    if rows.len() != 1 || !row["finalized_reservation_id"].is_null() {
        return Err(error(
            "autonomous_research_online_mutation_startup_broker_local_state_conflict",
        ));
    }
    if row["reserve_request_hash"]
        != hash(
            "AutonomousResearchOnlineMutationReserveRequest",
            &entry["reserveRequest"],
        )?
        || row["reservation_receipt_hash"]
            != contracts::online_mutation_receipt_hash_v1(reservation)?
    {
        return Err(error(
            "autonomous_research_online_mutation_startup_marker_binding_invalid",
        ));
    }
    Ok(MarkerState::Pending)
}
fn parse_stored(value: &Value, code: &str) -> Result<Value> {
    let bytes = value
        .as_str()
        .filter(|v| v.len() <= 32 * 1024 * 1024)
        .ok_or_else(|| error(code))?;
    let value = authority::files::parse(bytes.as_bytes(), code)?;
    if !value.is_object() {
        return Err(error(code));
    }
    Ok(value)
}
fn pending_markers<T: MutationAuthorityTransportV1>(
    database: &Connection,
    authority: &PinnedMutationAuthorityV1<T>,
    manifest: &Value,
) -> Result<()> {
    let snapshot = database.unchecked_transaction()?;
    let rows = storage::pending_markers_bounded(
        &snapshot,
        "autonomous_research_online_mutation_startup_local_journal_limit",
    )?;
    for row in rows {
        let request = parse_stored(
            &row["reserve_request_json"],
            "autonomous_research_online_mutation_startup_local_request_invalid",
        )?;
        let reservation = parse_stored(
            &row["reservation_receipt_json"],
            "autonomous_research_online_mutation_startup_local_reservation_invalid",
        )?;
        authority
            .verify_stored_reservation(&reservation, &request)
            .map_err(|cause| {
                if cause.state_recoverability_fatal {
                    cause
                } else {
                    error("autonomous_research_online_mutation_startup_local_reservation_invalid")
                }
            })?;
        manifest_binding(&request, &reservation, manifest)?;
    }
    snapshot.rollback()?;
    Ok(())
}
fn abort_remote_only<T: MutationAuthorityTransportV1>(
    database: &mut Connection,
    entry: &Value,
    authority: &mut PinnedMutationAuthorityV1<T>,
    clock: &mut dyn clock::MutationClockV1,
) -> Result<Value> {
    let reservation = &entry["reservation"];
    let reserve = &entry["reserveRequest"];
    let transaction = database.transaction_with_behavior(TransactionBehavior::Immediate)?;
    if marker_state(&transaction, entry)? != MarkerState::Absent {
        return Err(error(
            "autonomous_research_online_mutation_startup_remote_only_state_changed",
        ));
    }
    let metadata = storage::metadata(&transaction)?;
    let quick = storage::rows(&transaction, "PRAGMA quick_check;", &[])?;
    let foreign_keys = storage::rows(&transaction, "PRAGMA foreign_key_check;", &[])?;
    let schema = storage::exact_schema_hash_v1(&transaction)?;
    let trust = authority.trust();
    if quick.len() != 1
        || quick[0]["quick_check"] != "ok"
        || !foreign_keys.is_empty()
        || metadata["protocol"] != ONLINE_MUTATION_PROTOCOL
        || metadata["database_role"] != reservation["databaseRole"]
        || metadata["database_instance_id"] != reservation["databaseInstanceId"]
        || metadata["schema_contract_id"] != reserve["schemaContractId"]
        || metadata["schema_hash"] != schema
        || metadata["database_scope_hash"] != trust["databaseScopeHash"]
        || metadata["writer_manifest_hash"] != trust["writerManifestHash"]
        || reserve["schemaHash"] != schema
    {
        return Err(error(
            "autonomous_research_online_mutation_startup_remote_only_metadata_mismatch",
        ));
    }
    let local = storage::latest_local_head(&transaction, text(&metadata, "database_instance_id")?)?;
    if local["sequence"] != reserve["databasePreviousSequence"]
        || local["hash"] != reserve["databasePreviousHash"]
        || local["schemaHash"] != reserve["schemaHash"]
        || local["stateHash"] != reserve["preStateHash"]
    {
        return Err(error(
            "autonomous_research_online_mutation_startup_remote_only_local_head_mismatch",
        ));
    }
    let verified = authority.verify_stored_reservation(reservation, reserve)?;
    let request = contracts::build_abort_request_v1(
        reservation,
        "local-commit-failed",
        &json!(now(clock)?.1),
    )?;
    let receipt = authority.abort_mutation(&request, &verified, now(clock)?.0)?;
    transaction.rollback()?;
    Ok(receipt.value().clone())
}

fn database_binding(
    database: &Connection,
    role: &str,
    instance: &str,
    trust: &Value,
) -> Result<()> {
    let metadata = storage::metadata(database)?;
    if metadata["protocol"] != ONLINE_MUTATION_PROTOCOL
        || metadata["database_role"] != role
        || metadata["database_instance_id"] != instance
        || metadata["schema_hash"] != storage::exact_schema_hash_v1(database)?
        || metadata["database_scope_hash"] != trust["databaseScopeHash"]
        || metadata["writer_manifest_hash"] != trust["writerManifestHash"]
    {
        return Err(error(
            "autonomous_research_online_mutation_startup_database_binding_invalid",
        ));
    }
    Ok(())
}

/// Reconcile actual committed markers and a freshly signed unresolved list.
///
/// Only a reservation proven absent under an IMMEDIATE transaction with matching
/// metadata and previous local head can be aborted. Committed markers are
/// finalized through recovery first; business writes are never re-executed.
/// A second independently nonce-bound list must report no unresolved entries.
/// The returned proof still has `runtimeReady: false`.
pub fn reconcile_online_mutation_database_startup_v1<T: MutationAuthorityTransportV1>(
    database: &mut Connection,
    role: &str,
    instance: &str,
    authority: &mut PinnedMutationAuthorityV1<T>,
    manifest: &Value,
    clock: &mut dyn clock::MutationClockV1,
) -> Result<StartupMutationReconciliationV1> {
    let mut guarded_clock = StartupClock {
        inner: clock,
        previous: None,
    };
    let clock: &mut dyn clock::MutationClockV1 = &mut guarded_clock;
    manifest::assert_writer_manifest_v1(manifest)?;
    if !database.is_autocommit()
        || instance.is_empty()
        || authority.trust()["writerManifestHash"] != manifest::writer_manifest_hash_v1(manifest)?
        || !manifest["requiredDatabaseRoles"]
            .as_array()
            .is_some_and(|a| a.iter().any(|v| v == role))
    {
        return Err(error(
            "autonomous_research_online_mutation_startup_configuration_invalid",
        ));
    }
    database_binding(database, role, instance, authority.trust())?;
    let initial = list(authority, role, instance, clock)?;
    let mut absent = Vec::new();
    for entry in initial.value()["unresolvedReservations"]
        .as_array()
        .ok_or_else(|| {
            error("autonomous_research_online_unresolved_reservation_list_receipt_invalid")
        })?
    {
        manifest_binding(&entry["reserveRequest"], &entry["reservation"], manifest)?;
        if marker_state(database, entry)? == MarkerState::Absent {
            absent.push(entry.clone());
        }
    }
    pending_markers(database, authority, manifest)?;
    let recovery = recovery::recover_sqlite_mutations_v1(database, authority, clock)?;
    let mut aborted = Vec::new();
    for entry in &absent {
        aborted.push(abort_remote_only(database, entry, authority, clock)?);
    }
    let confirmation = list(authority, role, instance, clock)?;
    if confirmation.value()["unresolvedReservationCount"] != 0
        || !confirmation.value()["unresolvedReservations"]
            .as_array()
            .is_some_and(Vec::is_empty)
    {
        return Err(error(
            "autonomous_research_online_mutation_startup_reconciliation_incomplete",
        ));
    }
    database_binding(database, role, instance, authority.trust())?;
    if storage::pending_count(database)? != 0 {
        return Err(error(
            "autonomous_research_online_mutation_startup_local_recovery_incomplete",
        ));
    }
    let hashes: Vec<_> = aborted
        .iter()
        .map(contracts::online_mutation_receipt_hash_v1)
        .collect::<Result<_>>()?;
    let ids: Vec<_> = aborted.iter().map(|r| r["reservationId"].clone()).collect();
    Ok(StartupMutationReconciliationV1 {
        value: json!({"version":1,"kind":"AutonomousResearchOnlineMutationUnresolvedReservationReconciliationReceipt",
        "status":"autonomous_research_online_mutation_unresolved_reservations_reconciled","databaseRole":role,"databaseInstanceId":instance,
        "initialUnresolvedReservationCount":initial.value()["unresolvedReservationCount"],"recoveredReservationIds":recovery["recoveredReservationIds"],"finalizedHeads":recovery["finalizedHeads"],
        "abortedRemoteOnlyReservationIds":ids,"abortedRemoteOnlyAbortReceiptHashes":hashes,"abortedRemoteOnlyAbortReceipts":aborted,
        "initialRemoteOnlyReservationCount":absent.len(),"remoteOnlyReservationCount":0,"businessDmlReplayed":false,
        "confirmationReceiptHash":contracts::online_mutation_receipt_hash_v1(confirmation.value())?,
        "remainingBlockers":["autonomous_research_online_mutation_finalized_head_reconciliation_required","autonomous_research_online_mutation_active_startup_head_challenge_required"],"runtimeReady":false}),
        authority_configuration_hash: authority.configuration_hash().to_owned(),
        confirmation,
    })
}
