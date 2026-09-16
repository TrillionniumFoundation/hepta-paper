use super::authority::{
    MutationAuthorityTransportV1, PinnedMutationAuthorityV1, VerifiedMutationReceiptV1,
};
use super::*;
use rusqlite::Connection;
fn checked_marker<T: MutationAuthorityTransportV1>(
    row: &Value,
    metadata: &Value,
    authority: &PinnedMutationAuthorityV1<T>,
) -> Result<(VerifiedMutationReceiptV1, Value)> {
    let reservation: Value =
        serde_json::from_str(row["reservation_receipt_json"].as_str().unwrap_or(""))
            .map_err(|_| error("externally_fenced_sqlite_mutation_recovery_reservation_invalid"))?;
    let reserve: Value =
        serde_json::from_str(row["reserve_request_json"].as_str().unwrap_or(""))
            .map_err(|_| error("externally_fenced_sqlite_mutation_recovery_request_invalid"))?;
    let request_hash = hash("AutonomousResearchOnlineMutationReserveRequest", &reserve)?;
    let receipt_hash = contracts::online_mutation_receipt_hash_v1(&reservation)?;
    let exact = row["reserve_request_hash"] == request_hash
        && row["reservation_receipt_hash"] == receipt_hash
        && reservation["requestHash"] == request_hash
        && [
            ("reservation_id", "reservationId"),
            ("database_role", "databaseRole"),
            ("database_instance_id", "databaseInstanceId"),
            ("writer_id", "writerId"),
            ("operation_id", "operationId"),
            ("global_sequence", "globalSequence"),
            ("global_hash", "globalHash"),
            ("database_sequence", "databaseSequence"),
            ("database_hash", "databaseHash"),
            ("schema_hash", "schemaHash"),
            ("pre_state_hash", "preStateHash"),
            ("post_state_hash", "postStateHash"),
            ("changeset_hash", "changesetHash"),
        ]
        .iter()
        .all(|(local, remote)| row.get(*local) == reservation.get(*remote))
        && [
            ("database_role", "databaseRole"),
            ("database_instance_id", "databaseInstanceId"),
            ("schema_contract_id", "schemaContractId"),
        ]
        .iter()
        .all(|(local, remote)| metadata.get(*local) == reservation.get(*remote));
    if !exact {
        return Err(error(
            "externally_fenced_sqlite_mutation_recovery_reservation_invalid",
        ));
    }
    let verified = authority
        .verify_stored_reservation(&reservation, &reserve)
        .map_err(|cause| {
            if cause.state_recoverability_fatal {
                cause
            } else {
                error("externally_fenced_sqlite_mutation_recovery_reservation_invalid")
            }
        })?;
    let request = contracts::build_finalize_request_v1(&reservation, &row["committed_at"])?;
    if request["localMarkerHash"] != row["local_marker_hash"] {
        return Err(error(
            "externally_fenced_sqlite_mutation_recovery_marker_mismatch",
        ));
    }
    Ok((verified, request))
}
pub fn recover_sqlite_mutations_v1<T: MutationAuthorityTransportV1>(
    database: &mut Connection,
    authority: &mut PinnedMutationAuthorityV1<T>,
    clock: &mut dyn clock::MutationClockV1,
) -> Result<Value> {
    if !database.is_autocommit() {
        return Err(error(
            "externally_fenced_sqlite_mutation_recovery_database_invalid",
        ));
    }
    let meta = storage::metadata(database)?;
    let schema = storage::exact_schema_hash_v1(database)?;
    let trust = authority.trust();
    if meta["protocol"] != ONLINE_MUTATION_PROTOCOL
        || meta["database_scope_hash"] != trust["databaseScopeHash"]
        || meta["writer_manifest_hash"] != trust["writerManifestHash"]
        || meta["schema_hash"] != schema
    {
        return Err(error(
            "externally_fenced_sqlite_mutation_recovery_metadata_mismatch",
        ));
    }
    let pending = storage::rows(
        database,
        "SELECT marker.* FROM autonomous_research_online_mutation_authority_marker marker LEFT JOIN autonomous_research_online_mutation_finalization_receipt finalized ON finalized.reservation_id=marker.reservation_id WHERE finalized.reservation_id IS NULL ORDER BY marker.database_sequence;",
        &[],
    )?;
    let mut recovered = Vec::new();
    let mut heads = Vec::new();
    for row in pending {
        let (reservation, request) = checked_marker(&row, &meta, authority)?;
        let receipt =
            authority.finalize_mutation(&request, &reservation, clock::observe(clock)?.0)?;
        storage::record_finalization(database, receipt.value(), &clock::observe(clock)?.1)?;
        recovered.push(reservation.value()["reservationId"].clone());
        heads.push(json!({"reservationId":reservation.value()["reservationId"],"globalSequence":receipt.value()["globalSequence"],"globalHash":receipt.value()["globalHash"]}));
    }
    Ok(
        json!({"version":1,"kind":"ExternallyFencedSqliteMutationRecoveryReceipt","status":"externally_fenced_sqlite_mutation_recovery_complete","recoveredReservationIds":recovered,"finalizedHeads":heads}),
    )
}
