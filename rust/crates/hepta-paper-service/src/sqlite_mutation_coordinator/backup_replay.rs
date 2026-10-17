//! Dedicated bridge for isolated backup copies. It does not expose a general
//! journal-write surface or accept caller JSON as verified journal evidence.
use super::authority::{MutationAuthorityTransportV1, PinnedMutationAuthorityV1};
use super::*;
use crate::sqlite_mutation_coordinator::finalized_history::VerifiedFinalizedMutationChainV1;
use base64ct::{Base64, Encoding};
use rusqlite::{Connection, TransactionBehavior, session::ConflictAction};
use std::io::Cursor;
pub(crate) struct VerifiedSnapshotDatabaseHeadV1 {
    value: Value,
}
impl VerifiedSnapshotDatabaseHeadV1 {
    pub(crate) fn value(&self) -> &Value {
        &self.value
    }
}
fn require(valid: bool, code: &str) -> Result<()> {
    if valid { Ok(()) } else { Err(error(code)) }
}
/// The enclosing backup factory owns its snapshot and transaction. This proves
/// the latest local signed finalization, or the pinned zero-state metadata.
pub(crate) fn checked_snapshot_head_v1<T: MutationAuthorityTransportV1>(
    db: &Connection,
    expected: &Value,
    authority: &PinnedMutationAuthorityV1<T>,
) -> Result<VerifiedSnapshotDatabaseHeadV1> {
    let meta = storage::metadata(db)?;
    require(
        meta["protocol"] == ONLINE_MUTATION_PROTOCOL
            && meta["database_role"] == expected["role"]
            && meta["database_instance_id"] == expected["instanceId"]
            && meta["schema_contract_id"] == expected["schemaContractId"]
            && meta["schema_hash"] == expected["schemaHash"]
            && meta["schema_hash"] == storage::exact_schema_hash_v1(db)?
            && meta["database_scope_hash"] == authority.trust()["databaseScopeHash"]
            && meta["writer_manifest_hash"] == authority.trust()["writerManifestHash"],
        "autonomous_research_state_restore_replay_metadata_mismatch",
    )?;
    require(
        storage::pending_count(db)? == 0,
        "autonomous_research_state_restore_snapshot_pending_finalization",
    )?;
    let count:i64=db.query_row("SELECT count(*) FROM autonomous_research_online_mutation_authority_marker WHERE database_instance_id=?",[text(expected,"instanceId")?],|r|r.get(0))?;
    let value = if count == 0 {
        require(
            ["genesis_database_sequence", "genesis_global_sequence"]
                .iter()
                .all(|k| integer(&meta[k], 0))
                && [
                    "genesis_database_hash",
                    "genesis_state_hash",
                    "genesis_global_hash",
                ]
                .iter()
                .all(|k| sha(&meta[k])),
            "autonomous_research_state_restore_replay_metadata_mismatch",
        )?;
        json!({"databaseRole":expected["role"],"databaseInstanceId":expected["instanceId"],"sequence":meta["genesis_database_sequence"],"hash":meta["genesis_database_hash"],"schemaHash":meta["schema_hash"],"stateHash":meta["genesis_state_hash"],"globalSequence":meta["genesis_global_sequence"],"globalHash":meta["genesis_global_hash"]})
    } else {
        let finalization = super::finalized::verify_latest_finalized_mutation(
            db,
            authority,
            text(expected, "instanceId")?,
        )?;
        let v = finalization.value();
        json!({"databaseRole":v["databaseRole"],"databaseInstanceId":v["databaseInstanceId"],"sequence":v["databaseSequence"],"hash":v["databaseHash"],"schemaHash":v["schemaHash"],"stateHash":v["postStateHash"],"globalSequence":v["globalSequence"],"globalHash":v["globalHash"]})
    };
    Ok(VerifiedSnapshotDatabaseHeadV1 { value })
}
fn system_rows(db: &Connection) -> Result<Value> {
    Ok(
        json!({"metadata":storage::rows(db,"SELECT * FROM autonomous_research_online_mutation_authority_metadata ORDER BY singleton",&[])?,"markers":storage::rows(db,"SELECT * FROM autonomous_research_online_mutation_authority_marker ORDER BY database_sequence,reservation_id",&[])?,"finalizations":storage::rows(db,"SELECT * FROM autonomous_research_online_mutation_finalization_receipt ORDER BY reservation_id",&[])?}),
    )
}
fn healthy(db: &Connection, expected: &Value) -> Result<()> {
    let check: Vec<Value> = storage::rows(db, "PRAGMA quick_check", &[])?;
    require(
        check.len() == 1
            && check[0]
                .as_object()
                .is_some_and(|v| v.values().all(|v| v == "ok"))
            && storage::rows(db, "PRAGMA foreign_key_check", &[])?.is_empty()
            && storage::exact_schema_hash_v1(db)? == expected["schemaHash"],
        "autonomous_research_state_restore_replayed_database_invalid",
    )
}
/// Apply only the authenticated range's entries for this exact isolated copy.
/// Each business changeset and its journal records share one IMMEDIATE
/// transaction. SQLite conflicts abort; any attempted system-row changes fail.
pub(crate) fn replay_verified_database_v1<T: MutationAuthorityTransportV1>(
    db: &mut Connection,
    expected: &Value,
    range: &VerifiedFinalizedMutationChainV1,
    authority: &PinnedMutationAuthorityV1<T>,
) -> Result<VerifiedSnapshotDatabaseHeadV1> {
    require(
        db.is_autocommit(),
        "autonomous_research_state_restore_replay_transaction_required",
    )?;
    require(
        range.authority_configuration_hash() == authority.configuration_hash(),
        "autonomous_research_state_restore_replay_authority_mismatch",
    )?;
    db.pragma_update(None, "foreign_keys", true)?;
    let mut head = checked_snapshot_head_v1(db, expected, authority)?;
    let entries = range.value()["entries"]
        .as_array()
        .ok_or_else(|| error("autonomous_research_state_restore_journal_entry_shape_invalid"))?;
    for entry in entries
        .iter()
        .filter(|e| e["reservationReceipt"]["databaseInstanceId"] == expected["instanceId"])
    {
        let reservation = authority
            .verify_stored_reservation(&entry["reservationReceipt"], &entry["reserveRequest"])?;
        let finalization = authority.verify_stored_finalization(
            &entry["finalizationReceipt"],
            &entry["finalizeRequest"],
            &reservation,
        )?;
        let r = reservation.value();
        let h = head.value();
        require(
            r["databaseRole"] == expected["role"]
                && r["databaseInstanceId"] == expected["instanceId"]
                && r["schemaContractId"] == expected["schemaContractId"]
                && r["schemaHash"] == expected["schemaHash"]
                && int(r, "databasePreviousSequence")? == int(h, "sequence")?
                && r["databasePreviousHash"] == h["hash"]
                && r["preStateHash"] == h["stateHash"]
                && int(r, "databaseSequence")?
                    == int(h, "sequence")?.checked_add(1).ok_or_else(|| {
                        error("autonomous_research_state_restore_journal_continuity_invalid")
                    })?,
            "autonomous_research_state_restore_journal_continuity_invalid",
        )?;
        let bytes = Base64::decode_vec(text(r, "changesetBase64")?)
            .map_err(|_| error("autonomous_research_state_restore_business_changeset_invalid"))?;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let before = system_rows(&tx)?;
        tx.apply_strm(&mut Cursor::new(bytes), None::<fn(&str) -> bool>, |_, _| {
            ConflictAction::SQLITE_CHANGESET_ABORT
        })
        .map_err(|_| error("autonomous_research_state_restore_business_changeset_invalid"))?;
        require(
            system_rows(&tx)? == before,
            "autonomous_research_state_restore_business_changeset_invalid",
        )?;
        healthy(&tx, expected)?;
        storage::insert_marker(&tx, r, &entry["finalizeRequest"], &entry["reserveRequest"])?;
        storage::record_finalization_in_transaction(
            &tx,
            finalization.value(),
            text(finalization.value(), "finalizedAt")?,
        )?;
        let verified = checked_snapshot_head_v1(&tx, expected, authority)?;
        require(
            int(verified.value(), "globalSequence")? == int(r, "globalSequence")?
                && verified.value()["globalHash"] == r["globalHash"],
            "autonomous_research_state_restore_journal_target_head_invalid",
        )?;
        tx.commit()?;
        head = verified;
    }
    let expected_head = range.value()["databaseHeads"]
        .as_array()
        .and_then(|a| {
            a.iter()
                .find(|v| v["databaseInstanceId"] == expected["instanceId"])
        })
        .ok_or_else(|| {
            error("autonomous_research_state_restore_recovered_database_heads_invalid")
        })?;
    for key in [
        "databaseRole",
        "databaseInstanceId",
        "sequence",
        "hash",
        "schemaHash",
        "stateHash",
    ] {
        require(
            if key == "sequence" {
                int(head.value(), key)? == int(expected_head, key)?
            } else {
                head.value()[key] == expected_head[key]
            },
            "autonomous_research_state_restore_recovered_database_heads_invalid",
        )?;
    }
    Ok(head)
}
