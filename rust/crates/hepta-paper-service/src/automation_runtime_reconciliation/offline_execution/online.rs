//! Incumbent registered online statements. The parent retains receipt issuance
//! and wire encoding; this module never submits SQL or controls a transaction.
use super::*;
use crate::automation_runtime_reconciliation::online_execution::{business_error, one, run};
use crate::sqlite_mutation_coordinator::Result as OnlineResult;
use crate::sqlite_mutation_plan::RestrictedMutationTransactionV1;

pub(in crate::automation_runtime_reconciliation) struct Prepared {
    plan: Value,
    receipt: PreparedReceipt,
    at: String,
}
pub(in crate::automation_runtime_reconciliation) fn prepare(
    connection: &Connection,
    clock: &mut dyn ReconciliationClockV1,
    seconds: f64,
    campaign: Option<&str>,
    release: Option<&str>,
) -> OnlineResult<Prepared> {
    let plan = plan_with_clock(connection, clock, seconds, campaign).map_err(business_error)?;
    let at = clock.now_iso().map_err(business_error)?;
    let payload = receipt_payload(&plan, &at).map_err(business_error)?;
    let ledger_at = clock.now_iso().map_err(business_error)?;
    let receipt =
        prepare_receipt_from_payload(payload, &ledger_at, release).map_err(business_error)?;
    Ok(Prepared { plan, receipt, at })
}
fn event_insert(
    tx: &mut RestrictedMutationTransactionV1<'_>,
    event: Event,
    at: &str,
) -> OnlineResult<()> {
    one(
        tx,
        "insert-campaign-event",
        vec![
            json!(event.id),
            event.campaign,
            event.node,
            json!(event.kind),
            json!(event.payload.wire()),
            json!(event.hash),
            json!(at),
        ],
        "automation_runtime_reconciliation_event_insert_ambiguous",
    )
}
pub(in crate::automation_runtime_reconciliation) fn apply(
    tx: &mut RestrictedMutationTransactionV1<'_>,
    prepared: &Prepared,
) -> OnlineResult<Value> {
    let Prepared { plan, receipt, at } = prepared;
    let rows = |key| array(plan, key).map_err(business_error);
    for node in rows("expiredNodes")? {
        one(
            tx,
            "recover-node",
            vec![
                json!(at),
                node["node_id"].clone(),
                node["status"].clone(),
                node["lease_owner"].clone(),
                node["lease_owner"].clone(),
                node["attempt_id"].clone(),
                node["attempt_id"].clone(),
                number_or_zero(&node["lease_generation"]),
                number_or_zero(&node["node_revision"]),
                json!(at),
            ],
            "automation_runtime_reconciliation_node_precondition_failed",
        )?;
        let detail = Record::new()
            .field("previousStatus", node["status"].clone())
            .field("previousLeaseOwner", node["lease_owner"].clone())
            .field("previousLeaseExpiresAt", node["lease_expires_at"].clone())
            .field(
                "reconciliationPlanHash",
                plan["reconciliationPlanHash"].clone(),
            );
        event_insert(
            tx,
            event(
                "campaign_node_lease_recovered",
                &node["campaign_id"],
                &node["node_id"],
                &detail,
                at,
            )
            .map_err(business_error)?,
            at,
        )?;
    }
    for campaign in rows("noProgressCampaigns")? {
        one(
            tx,
            "pause-campaign",
            vec![json!(at), json!(at), campaign["campaign_id"].clone()],
            "automation_runtime_reconciliation_campaign_precondition_failed",
        )?;
        let detail = Record::new()
            .field("previousStatus", json!("running"))
            .field("previousPhase", campaign["current_phase"].clone())
            .field("previousUpdatedAt", campaign["updated_at"].clone())
            .field(
                "queuedNodeCount",
                number_or_zero(&campaign["queued_node_count"]),
            )
            .field("noProgressCutoff", plan["noProgressCutoff"].clone())
            .field(
                "reconciliationPlanHash",
                plan["reconciliationPlanHash"].clone(),
            );
        event_insert(
            tx,
            event(
                "campaign_no_progress_paused",
                &campaign["campaign_id"],
                &Value::Null,
                &detail,
                at,
            )
            .map_err(business_error)?,
            at,
        )?;
    }
    for node in rows("terminalCampaignActiveNodes")? {
        let integration = node["prepared_integration_status"]
            .as_str()
            .filter(|v| !v.is_empty())
            .unwrap_or("none");
        let uncertain = matches!(integration, "integrating" | "integrated");
        let status = if uncertain {
            "external_outcome_uncertain"
        } else {
            "skipped"
        };
        let class = if uncertain {
            "campaign_terminal_sibling_outcome_uncertain"
        } else {
            "campaign_terminal_sibling_cancelled"
        };
        let failure = Record::new()
            .field("reason", json!(class))
            .field("campaignStatus", node["campaign_status"].clone())
            .field("campaignStopReason", truthy_or_null(&node["stop_reason"]))
            .field("previousStatus", node["status"].clone())
            .field("previousLeaseOwner", truthy_or_null(&node["lease_owner"]))
            .field(
                "previousLeaseExpiresAt",
                truthy_or_null(&node["lease_expires_at"]),
            )
            .field("previousAttemptId", truthy_or_null(&node["attempt_id"]))
            .field(
                "previousLeaseGeneration",
                number_or_zero(&node["lease_generation"]),
            )
            .field(
                "previousNodeRevision",
                number_or_zero(&node["node_revision"]),
            )
            .field("preparedIntegrationStatus", json!(integration))
            .field(
                "reconciliationPlanHash",
                plan["reconciliationPlanHash"].clone(),
            );
        let failure_hash =
            hash("PaperCampaignNodeFailure", &failure.value).map_err(business_error)?;
        one(
            tx,
            "close-terminal-active-node",
            vec![
                json!(status),
                json!(class),
                json!(failure.wire()),
                json!(failure_hash),
                json!(at),
                node["node_id"].clone(),
                node["campaign_id"].clone(),
                node["status"].clone(),
                truthy_or_null(&node["lease_owner"]),
                truthy_or_null(&node["lease_owner"]),
                truthy_or_null(&node["attempt_id"]),
                truthy_or_null(&node["attempt_id"]),
                number_or_zero(&node["lease_generation"]),
                number_or_zero(&node["node_revision"]),
                json!(integration),
            ],
            "automation_runtime_reconciliation_terminal_active_node_precondition_failed",
        )?;
        let mut detail = Record::new()
            .field("status", json!(status))
            .field("failureClass", json!(class))
            .field("failureHash", json!(failure_hash));
        for (key, encoded) in failure.fields {
            detail.fields.push((key.clone(), encoded));
            detail.value[&key] = failure.value[&key].clone();
        }
        event_insert(
            tx,
            event(
                "campaign_terminal_active_child_settled",
                &node["campaign_id"],
                &node["node_id"],
                &detail,
                at,
            )
            .map_err(business_error)?,
            at,
        )?;
    }
    for node in rows("terminalCampaignQueuedNodes")? {
        one(
            tx,
            "close-terminal-node",
            vec![json!(at), node["node_id"].clone()],
            "automation_runtime_reconciliation_terminal_node_precondition_failed",
        )?;
        let detail = Record::new()
            .field("campaignStatus", node["campaign_status"].clone())
            .field("campaignStopReason", truthy_or_null(&node["stop_reason"]))
            .field(
                "reconciliationPlanHash",
                plan["reconciliationPlanHash"].clone(),
            );
        event_insert(
            tx,
            event(
                "campaign_terminal_child_closed",
                &node["campaign_id"],
                &node["node_id"],
                &detail,
                at,
            )
            .map_err(business_error)?,
            at,
        )?;
    }
    let campaign = plan.get("campaignId");
    let mut parameters = vec![json!(at)];
    if let Some(campaign) = campaign {
        parameters.push(campaign.clone());
    }
    let leases = run(
        tx,
        if campaign.is_some() {
            "delete-resource-leases-for-campaign"
        } else {
            "delete-resource-leases"
        },
        parameters.clone(),
    )?;
    let waiters = run(
        tx,
        if campaign.is_some() {
            "delete-resource-waiters-for-campaign"
        } else {
            "delete-resource-waiters"
        },
        parameters,
    )?;
    if leases != rows("expiredResourceLeases")?.len() as u64
        || waiters != rows("expiredWaiters")?.len() as u64
    {
        return Err(crate::sqlite_mutation_coordinator::error(
            "automation_runtime_reconciliation_resource_precondition_failed",
        ));
    }
    one(
        tx,
        "native-store.receipt-ledger.insert.v1",
        receipt.parameters.clone(),
        "automation_runtime_reconciliation_receipt_insert_ambiguous",
    )?;
    Ok(
        json!({"ledgerChanges":1,"recoveredNodeCount":rows("expiredNodes")?.len(),
        "pausedCampaignCount":rows("noProgressCampaigns")?.len(),"closedTerminalActiveNodeCount":rows("terminalCampaignActiveNodes")?.len(),
        "closedTerminalNodeCount":rows("terminalCampaignQueuedNodes")?.len(),"removedResourceLeaseCount":leases,"removedWaiterCount":waiters}),
    )
}
pub(in crate::automation_runtime_reconciliation) fn finish(
    connection: &Connection,
    prepared: Prepared,
    clock: &mut dyn ReconciliationClockV1,
    seconds: f64,
    campaign: Option<&str>,
) -> OnlineResult<Value> {
    let after = plan_with_clock(connection, clock, seconds, campaign).map_err(business_error)?;
    Ok(completion(prepared.receipt, after))
}
