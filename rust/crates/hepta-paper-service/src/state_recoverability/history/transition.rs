//! A first bounded refresh route accepts only the actual fixed heartbeat
//! UPDATE. Every byte is still replayed; this check never skips a mutation.
use super::*;
use base64ct::{Base64, Encoding};
use rusqlite::{
    Error as SqlError, fallible_streaming_iterator::FallibleStreamingIterator, hooks::Action,
    session::ChangesetIter, types::ValueRef,
};
use std::io::{Cursor, Read};
pub(super) const OPERATION: &str =
    "resident-instance.supervisor-instance-repository.heartbeatInstanceLease.v1";
pub(super) const TABLE: &str = "autonomous_research_supervisor_instance";
const SCOPE: &str = "resident-autonomous-research-supervisor";
pub(super) const COLUMNS: [&str; 27] = [
    "scope_id",
    "status",
    "owner_id",
    "lease_token",
    "lease_generation",
    "lease_duration_ms",
    "heartbeat_interval_ms",
    "started_at",
    "last_heartbeat_at",
    "lease_expires_at",
    "startup_reconciled_at",
    "startup_reconciliation_receipt_hash",
    "fully_autonomous_required",
    "fully_autonomous_prerequisite_identity_hash",
    "machine_intake_reconciled_at",
    "machine_intake_reconciliation_receipt_hash",
    "machine_intake_configuration_hash",
    "machine_intake_dataset_snapshot_hash",
    "machine_intake_reconciliation_failed_at",
    "machine_intake_reconciliation_failure",
    "last_cycle_at",
    "last_cycle_receipt_hash",
    "stopped_at",
    "stop_reason",
    "recovered_lease_count",
    "created_at",
    "updated_at",
];
fn unsupported() -> crate::sqlite_mutation_coordinator::SqliteMutationCoordinatorError {
    error("autonomous_research_state_heartbeat_journal_transition_unsupported")
}
fn value(value: rusqlite::Result<ValueRef<'_>>) -> Result<Option<ValueRef<'_>>> {
    match value {
        Ok(value) => Ok(Some(value)),
        Err(SqlError::InvalidColumnIndex(_)) => Ok(None),
        Err(_) => Err(unsupported()),
    }
}
fn text_value(value: ValueRef<'_>) -> Result<&str> {
    let ValueRef::Text(bytes) = value else {
        return Err(unsupported());
    };
    ensure(
        bytes.len() <= 4096,
        "autonomous_research_state_heartbeat_resource_limit",
    )?;
    std::str::from_utf8(bytes).map_err(|_| unsupported())
}
pub(super) fn assert_heartbeat_changeset(bytes: &[u8]) -> Result<()> {
    // First validate all wire boundaries and the absence of indirect changes;
    // the native iterator below is used only for typed, column-level semantics.
    let effects = crate::sqlite_changeset::inspect_sqlite_changeset_effects_v1(bytes)
        .map_err(|_| unsupported())?;
    ensure(
        effects.len() == 1 && effects[0].table == TABLE && effects[0].operation == "UPDATE",
        "autonomous_research_state_heartbeat_journal_transition_unsupported",
    )?;
    let mut cursor = Cursor::new(bytes);
    let reader: &mut dyn Read = &mut cursor;
    let mut changes = ChangesetIter::start_strm(&reader)?;
    let change = changes.next()?.ok_or_else(unsupported)?;
    let operation = change.op()?;
    ensure(
        operation.table_name() == TABLE
            && operation.number_of_columns() == COLUMNS.len() as i32
            && operation.code() == Action::SQLITE_UPDATE
            && !operation.indirect()
            && change.pk()?
                == [1]
                    .into_iter()
                    .chain(std::iter::repeat_n(0, COLUMNS.len() - 1))
                    .collect::<Vec<_>>(),
        "autonomous_research_state_heartbeat_journal_transition_unsupported",
    )?;
    ensure(
        value(change.old_value(0))?.is_some_and(|v| text_value(v).ok() == Some(SCOPE))
            && value(change.new_value(0))?.is_none(),
        "autonomous_research_state_heartbeat_journal_transition_unsupported",
    )?;
    for (index, name) in COLUMNS.iter().enumerate().skip(1) {
        let old = value(change.old_value(index))?;
        let new = value(change.new_value(index))?;
        if !matches!(
            *name,
            "last_heartbeat_at"
                | "lease_expires_at"
                | "last_cycle_at"
                | "last_cycle_receipt_hash"
                | "updated_at"
        ) {
            ensure(
                old.is_none() && new.is_none(),
                "autonomous_research_state_heartbeat_journal_transition_unsupported",
            )?;
            continue;
        }
        ensure(
            old.is_some() == new.is_some(),
            "autonomous_research_state_heartbeat_journal_transition_unsupported",
        )?;
        if let Some(new) = new {
            let text = text_value(new)?;
            if *name == "last_cycle_receipt_hash" {
                ensure(
                    crate::sqlite_mutation_coordinator::sha(&json!(text)),
                    "autonomous_research_state_heartbeat_journal_transition_unsupported",
                )?;
            } else {
                let next = timestamp(&json!(text)).ok_or_else(unsupported)?;
                if let Some(old) = old.filter(|value| !matches!(value, ValueRef::Null)) {
                    let previous = timestamp(&json!(text_value(old)?)).ok_or_else(unsupported)?;
                    ensure(
                        next >= previous,
                        "autonomous_research_state_heartbeat_clock_rollback",
                    )?;
                }
            }
        }
    }
    ensure(
        changes.next()?.is_none(),
        "autonomous_research_state_heartbeat_journal_transition_unsupported",
    )
}
pub(super) fn assert_heartbeat_range(
    range: &crate::state_backup_authority::VerifiedFinalizedJournalEvidenceV1,
) -> Result<()> {
    let entries = range.value()["entries"]
        .as_array()
        .ok_or_else(unsupported)?;
    ensure(
        !entries.is_empty() && entries.len() <= 4096,
        "autonomous_research_state_heartbeat_journal_transition_unsupported",
    )?;
    for entry in entries {
        let reservation = &entry["reservationReceipt"];
        ensure(
            reservation["databaseRole"] == "resident-instance"
                && reservation["databaseInstanceId"] == "resident-instance"
                && reservation["schemaContractId"] == "resident-instance-schema-v1"
                && reservation["writerId"]
                    == "writer:resident-instance:supervisor-instance-repository:v1"
                && reservation["operationId"] == OPERATION
                && reservation["authorizationReceiptHashes"]
                    .as_array()
                    .is_some_and(Vec::is_empty)
                && reservation["sideEffectReservationHashes"]
                    .as_array()
                    .is_some_and(Vec::is_empty),
            "autonomous_research_state_heartbeat_journal_transition_unsupported",
        )?;
        let bytes =
            Base64::decode_vec(text(reservation, "changesetBase64")?).map_err(|_| unsupported())?;
        assert_heartbeat_changeset(&bytes)?;
    }
    Ok(())
}
