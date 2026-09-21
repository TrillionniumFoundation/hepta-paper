//! The registered legacy online callback uses the original count-only scope
//! guard and exact node CAS. Queued-state hashes remain observational.
use super::*;
use crate::automation_runtime_reconciliation::{
    offline_execution::ReconciliationClockV1,
    online_execution::{business_error, one as online_one},
};
use crate::sqlite_mutation_coordinator::Result as OnlineResult;
use crate::sqlite_mutation_plan::RestrictedMutationTransactionV1;

pub(in crate::automation_runtime_reconciliation) struct OnlinePrepared(PreparedOperation);
pub(in crate::automation_runtime_reconciliation) fn prepare_online(
    connection: &Connection,
    campaign: &str,
    release: Option<&str>,
    clock: &mut dyn ReconciliationClockV1,
) -> OnlineResult<OnlinePrepared> {
    prepare_operation(connection, campaign, release, &mut || clock.now_iso())
        .map(OnlinePrepared)
        .map_err(business_error)
}
pub(in crate::automation_runtime_reconciliation) fn apply_online(
    tx: &mut RestrictedMutationTransactionV1<'_>,
    prepared: &OnlinePrepared,
) -> OnlineResult<Value> {
    let PreparedOperation {
        plan,
        settlements,
        receipt,
    } = &prepared.0;
    online_one(
        tx,
        "assert-legacy-terminal-active-residue-scope",
        vec![
            plan["campaignId"].clone(),
            plan["campaignStatus"].clone(),
            plan["campaignRevision"].clone(),
            plan["preservedQueuedNodeCount"].clone(),
            json!(settlements.len()),
            plan["plannedAt"].clone(),
        ],
        "legacy_terminal_active_residue_scope_precondition_failed",
    )?;
    for settlement in settlements {
        let node = &settlement.node;
        online_one(
            tx,
            "close-legacy-terminal-active-residue",
            vec![
                settlement.failure.value["reason"].clone(),
                json!(settlement.failure.wire()),
                json!(settlement.failure_hash),
                plan["plannedAt"].clone(),
                node["nodeId"].clone(),
                plan["campaignId"].clone(),
                node["status"].clone(),
                node["leaseOwner"].clone(),
                node["leaseOwner"].clone(),
                node["leaseExpiresAt"].clone(),
                node["attemptId"].clone(),
                node["attemptId"].clone(),
                node["leaseGeneration"].clone(),
                node["nodeRevision"].clone(),
                node["preparedIntegrationStatus"].clone(),
                plan["plannedAt"].clone(),
                plan["campaignStatus"].clone(),
                plan["campaignRevision"].clone(),
            ],
            "legacy_terminal_active_residue_node_precondition_failed",
        )?;
        online_one(
            tx,
            "insert-campaign-event",
            vec![
                json!(settlement.event_id),
                plan["campaignId"].clone(),
                node["nodeId"].clone(),
                settlement.event.value["kind"].clone(),
                json!(settlement.event.wire()),
                json!(settlement.event_hash),
                plan["plannedAt"].clone(),
            ],
            "legacy_terminal_active_residue_event_insert_ambiguous",
        )?;
    }
    online_one(
        tx,
        "native-store.receipt-ledger.insert.v1",
        receipt.parameters.clone(),
        "legacy_terminal_active_residue_receipt_insert_ambiguous",
    )?;
    Ok(json!({"settledNodeCount":settlements.len(),"ledgerChanges":1}))
}
pub(in crate::automation_runtime_reconciliation) fn count(prepared: &OnlinePrepared) -> usize {
    prepared.0.settlements.len()
}
pub(in crate::automation_runtime_reconciliation) fn finish_online(
    connection: &Connection,
    prepared: OnlinePrepared,
    clock: &mut dyn ReconciliationClockV1,
) -> OnlineResult<Value> {
    let prepared = prepared.0;
    let at = clock.now_iso().map_err(business_error)?;
    let campaign = prepared.plan["campaignId"]
        .as_str()
        .ok_or_else(|| business_error(Error::Row))?;
    let after = plan_on_connection(connection, &at, campaign).map_err(business_error)?;
    let mut receipt = prepared.receipt.payload.value;
    receipt["ledgerReceipt"] = prepared.receipt.ledger;
    receipt["after"] = after;
    Ok(receipt)
}
