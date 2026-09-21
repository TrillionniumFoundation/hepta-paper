//! The incumbent offline transaction, deliberately not a public writer API.
//!
//! Its caller must own the native-store foundation scope: schema admission,
//! cutover writer epoch, and the retained package-deletion writer boundary.
//! The sibling scoped execution module provides the admitted local entrypoint.
//! A raw connection is not such authority.
//! Tests exercise this business operation on real schema-25 copies only.
#[cfg(test)]
use super::plan_on_connection;
use super::{
    AutomationRuntimeReconciliationError as Error, plan_on_connection_at, verify_campaign_scope,
};
use hepta_legacy_compatibility::production_hash_record_v1;
use rusqlite::{Connection, Transaction, TransactionBehavior, params_from_iter};
use serde_json::{Value, json};

pub(super) mod online;

type Result<T> = std::result::Result<T, Error>;

// serde_json::Map sorts keys. The incumbent persists JSON.stringify bytes, so
// retain construction order separately for receipt_json/event_json/failure_json.
struct Record {
    value: Value,
    fields: Vec<(String, String)>,
}
impl Record {
    fn new() -> Self {
        Self {
            value: json!({}),
            fields: Vec::new(),
        }
    }
    fn field(mut self, key: &str, value: Value) -> Self {
        self.fields.push((key.into(), wire(&value)));
        self.value[key] = value;
        self
    }
    fn nested(mut self, key: &str, value: &Self) -> Self {
        self.fields.push((key.into(), value.wire()));
        self.value[key] = value.value.clone();
        self
    }
    fn wire(&self) -> String {
        format!(
            "{{{}}}",
            self.fields
                .iter()
                .map(|(k, v)| format!("{}:{v}", wire(&json!(k))))
                .collect::<Vec<_>>()
                .join(",")
        )
    }
}
fn wire(v: &Value) -> String {
    match v {
        Value::Number(n) => {
            let n = n.as_f64().expect("JSON number");
            ryu_js::Buffer::new().format(n).into()
        }
        Value::Array(a) => format!("[{}]", a.iter().map(wire).collect::<Vec<_>>().join(",")),
        _ => serde_json::to_string(v).expect("representable JSON"),
    }
}
fn hash(kind: &str, value: &Value) -> Result<String> {
    production_hash_record_v1(kind, value)
        .map(|v| v.as_str().to_owned())
        .map_err(|_| Error::Hash)
}
fn array<'a>(plan: &'a Value, key: &str) -> Result<&'a [Value]> {
    plan[key].as_array().map(Vec::as_slice).ok_or(Error::Row)
}
fn truthy_or_null(value: &Value) -> Value {
    if value.is_null() || value == false || value == 0 || value == "" {
        Value::Null
    } else {
        value.clone()
    }
}
fn number_or_zero(value: &Value) -> Value {
    super::sqlite_number::number(value)
}
struct Event {
    id: String,
    campaign: Value,
    node: Value,
    kind: &'static str,
    payload: Record,
    hash: String,
}
fn event(
    kind: &'static str,
    campaign: &Value,
    node: &Value,
    detail: &Record,
    at: &str,
) -> Result<Event> {
    let payload = Record::new()
        .field("version", json!(1))
        .field("kind", json!(kind))
        .field("campaignId", campaign.clone())
        .field("nodeId", node.clone())
        .nested("detail", detail)
        .field("createdAt", json!(at));
    let hash = hash("PaperCampaignEvent", &payload.value)?;
    let id = format!(
        "{}:{at}:{}",
        campaign.as_str().ok_or(Error::Row)?,
        &hash[hash.len() - 16..]
    );
    Ok(Event {
        id,
        campaign: campaign.clone(),
        node: node.clone(),
        kind,
        payload,
        hash,
    })
}
fn sql_value(value: Value) -> Result<rusqlite::types::Value> {
    use rusqlite::types::Value as S;
    Ok(match value {
        Value::Null => S::Null,
        Value::String(s) => S::Text(s),
        Value::Bool(b) => S::Integer(i64::from(b)),
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                S::Integer(i)
            } else {
                S::Real(n.as_f64().ok_or(Error::Row)?)
            }
        }
        _ => return Err(Error::Row),
    })
}
fn exactly_one(tx: &Transaction<'_>, sql: &str, values: Vec<Value>) -> Result<()> {
    let values = values
        .into_iter()
        .map(sql_value)
        .collect::<Result<Vec<_>>>()?;
    if tx.execute(sql, params_from_iter(values))? != 1 {
        return Err(Error::Precondition(
            "automation_runtime_reconciliation_exactly_one_precondition_failed",
        ));
    }
    Ok(())
}
fn insert_event(tx: &Transaction<'_>, e: Event, at: &str) -> Result<()> {
    exactly_one(
        tx,
        "INSERT INTO campaign_events(event_id,campaign_id,node_id,kind,event_json,event_sha256,created_at) VALUES(?,?,?,?,?,?,?)",
        vec![
            json!(e.id),
            e.campaign,
            e.node,
            json!(e.kind),
            json!(e.payload.wire()),
            json!(e.hash),
            json!(at),
        ],
    )
}
struct PreparedReceipt {
    payload: Record,
    ledger: Value,
    parameters: Vec<Value>,
}
// Fixed, private, least-privilege issuer. Neither trust flags nor caller-supplied
// issuer policy hashes are accepted. This matches Node's in-process broker
// policy, not external or production authorization.
#[cfg(test)]
fn prepare_receipt(
    plan: &Value,
    at: &str,
    ledger_at: &str,
    release_commit: Option<&str>,
) -> Result<PreparedReceipt> {
    prepare_receipt_from_payload(receipt_payload(plan, at)?, ledger_at, release_commit)
}
fn receipt_payload(plan: &Value, at: &str) -> Result<Record> {
    let mut payload = Record::new()
        .field("version", json!(2))
        .field("kind", json!("AutomationRuntimeReconciliationReceipt"))
        .field("status", json!("automation_runtime_reconciled"));
    if let Some(campaign) = plan.get("campaignId") {
        payload = payload.field("campaignId", campaign.clone());
    }
    payload = payload.field(
        "reconciliationPlanHash",
        plan["reconciliationPlanHash"].clone(),
    );
    for (out, input) in [
        ("recoveredNodeCount", "expiredNodes"),
        ("removedResourceLeaseCount", "expiredResourceLeases"),
        ("removedWaiterCount", "expiredWaiters"),
        ("pausedNoProgressCampaignCount", "noProgressCampaigns"),
        (
            "closedTerminalCampaignQueuedNodeCount",
            "terminalCampaignQueuedNodes",
        ),
        (
            "closedTerminalCampaignActiveNodeCount",
            "terminalCampaignActiveNodes",
        ),
        (
            "preservedLegacyTerminalNodeCount",
            "preservedLegacyTerminalNodes",
        ),
    ] {
        payload = payload.field(out, json!(array(plan, input)?.len()));
    }
    for (out, input, key) in [
        ("recoveredNodeIds", "expiredNodes", "node_id"),
        (
            "pausedNoProgressCampaignIds",
            "noProgressCampaigns",
            "campaign_id",
        ),
        (
            "closedTerminalCampaignQueuedNodeIds",
            "terminalCampaignQueuedNodes",
            "node_id",
        ),
        (
            "closedTerminalCampaignActiveNodeIds",
            "terminalCampaignActiveNodes",
            "node_id",
        ),
        (
            "preservedLegacyTerminalNodeIds",
            "preservedLegacyTerminalNodes",
            "node_id",
        ),
    ] {
        payload = payload.field(
            out,
            json!(
                array(plan, input)?
                    .iter()
                    .map(|r| r[key].clone())
                    .collect::<Vec<_>>()
            ),
        );
    }
    payload = payload
        .field("reconciledAt", json!(at))
        .field("workersStarted", json!(false))
        .field("externalActionPerformed", json!(false));
    let receipt_hash = hash("AutomationRuntimeReconciliationReceipt", &payload.value)?;
    Ok(payload.field("receiptHash", json!(receipt_hash)))
}
fn prepare_receipt_from_payload(
    payload: Record,
    ledger_at: &str,
    release_commit: Option<&str>,
) -> Result<PreparedReceipt> {
    let receipt_hash = payload.value["receiptHash"].as_str().ok_or(Error::Row)?;
    let receipt_id = format!("automation-reconciliation:{receipt_hash}");
    let policy = json!({"version":1,"policyId":"automation-reconciler","writerId":"automation-runtime-reconciler","writerKind":"automation-state-reconciler","assurance":"in_process_registered_administrator","allowedKinds":["AutomationRuntimeReconciliationReceipt"],"allowedStreams":["automation-reconciliation"]});
    let policy_hash = hash("ReceiptIssuerPolicy", &policy)?;
    let release_commit = release_commit.filter(|v| !v.is_empty());
    let ledger = json!({"receiptId":receipt_id,"receiptHash":receipt_hash,"stream":"automation-reconciliation","paperId":null,"createdAt":ledger_at,"environment":"administrative","evidenceClass":"runtime_reconciliation","releaseCommit":release_commit,"writerId":"automation-runtime-reconciler","writerKind":"automation-state-reconciler","writerTrusted":true,"issuerPolicyId":"automation-reconciler","issuerPolicyHash":policy_hash,"issuerAssurance":"in_process_registered_administrator"});
    let parameters = vec![
        json!(receipt_id),
        json!("automation-reconciliation"),
        Value::Null,
        json!("AutomationRuntimeReconciliationReceipt"),
        json!("automation_runtime_reconciled"),
        json!(payload.wire()),
        json!(receipt_hash),
        json!(ledger_at),
        json!("administrative"),
        json!("runtime_reconciliation"),
        json!(release_commit),
        json!("automation-runtime-reconciler"),
        json!("automation-state-reconciler"),
        json!(1),
        json!("automation-reconciler"),
        json!(policy_hash),
        json!("in_process_registered_administrator"),
    ];
    Ok(PreparedReceipt {
        payload,
        ledger,
        parameters,
    })
}
fn apply(tx: &Transaction<'_>, plan: &Value, prepared: &PreparedReceipt, at: &str) -> Result<()> {
    for node in array(plan, "expiredNodes")? {
        exactly_one(
            tx,
            "UPDATE campaign_nodes SET status='queued',lease_owner=NULL,lease_expires_at=NULL,attempt_id=NULL,node_revision=node_revision+1,failure_class='lease_expired_recovered',updated_at=? WHERE node_id=? AND campaign_id=? AND status=? AND lease_owner IS ? AND attempt_id IS ? AND lease_generation=? AND node_revision=? AND lease_expires_at=? AND julianday(lease_expires_at)<=julianday(?) AND EXISTS(SELECT 1 FROM paper_campaigns c WHERE c.campaign_id=campaign_nodes.campaign_id AND c.status='running' AND c.revision=?)",
            vec![
                json!(at),
                node["node_id"].clone(),
                node["campaign_id"].clone(),
                node["status"].clone(),
                truthy_or_null(&node["lease_owner"]),
                truthy_or_null(&node["attempt_id"]),
                number_or_zero(&node["lease_generation"]),
                number_or_zero(&node["node_revision"]),
                node["lease_expires_at"].clone(),
                json!(at),
                node["campaign_revision"].clone(),
            ],
        )?;
        let detail = Record::new()
            .field("previousStatus", node["status"].clone())
            .field("previousLeaseOwner", node["lease_owner"].clone())
            .field("previousLeaseExpiresAt", node["lease_expires_at"].clone())
            .field(
                "reconciliationPlanHash",
                plan["reconciliationPlanHash"].clone(),
            );
        insert_event(
            tx,
            event(
                "campaign_node_lease_recovered",
                &node["campaign_id"],
                &node["node_id"],
                &detail,
                at,
            )?,
            at,
        )?;
    }
    for campaign in array(plan, "noProgressCampaigns")? {
        exactly_one(
            tx,
            "UPDATE paper_campaigns SET status='paused',current_phase='paused',stop_reason='reconciliation_no_progress_timeout',accumulated_run_ms=accumulated_run_ms+CASE WHEN last_resumed_at IS NULL THEN 0 ELSE max(0,CAST((julianday(?)-julianday(last_resumed_at))*86400000 AS INTEGER)) END,last_resumed_at=NULL,revision=revision+1,updated_at=? WHERE campaign_id=? AND paper_id=? AND status='running' AND revision=? AND updated_at=? AND current_phase IS ? AND updated_at<=? AND (SELECT count(*) FROM campaign_nodes queued WHERE queued.campaign_id=paper_campaigns.campaign_id AND queued.status='queued')=? AND NOT EXISTS(SELECT 1 FROM campaign_nodes active WHERE active.campaign_id=paper_campaigns.campaign_id AND active.status IN ('leased','running'))",
            vec![
                json!(at),
                json!(at),
                campaign["campaign_id"].clone(),
                campaign["paper_id"].clone(),
                campaign["revision"].clone(),
                campaign["updated_at"].clone(),
                campaign["current_phase"].clone(),
                plan["noProgressCutoff"].clone(),
                number_or_zero(&campaign["queued_node_count"]),
            ],
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
        insert_event(
            tx,
            event(
                "campaign_no_progress_paused",
                &campaign["campaign_id"],
                &Value::Null,
                &detail,
                at,
            )?,
            at,
        )?;
    }
    for node in array(plan, "terminalCampaignActiveNodes")? {
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
        let failure_hash = hash("PaperCampaignNodeFailure", &failure.value)?;
        exactly_one(
            tx,
            "UPDATE campaign_nodes SET status=?,failure_class=?,failure_json=?,failure_sha256=?,lease_owner=NULL,lease_expires_at=NULL,attempt_id=NULL,node_revision=node_revision+1,updated_at=? WHERE node_id=? AND campaign_id=? AND status=? AND lease_owner IS ? AND attempt_id IS ? AND lease_expires_at IS ? AND lease_generation=? AND node_revision=? AND prepared_integration_status=? AND EXISTS(SELECT 1 FROM paper_campaigns c WHERE c.campaign_id=campaign_nodes.campaign_id AND c.status=? AND c.revision=? AND c.stop_reason IS ? AND CAST(coalesce(json_extract(c.spec_json,'$.terminalSiblingSettlementPolicyVersion'),0) AS INTEGER)=1)",
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
                truthy_or_null(&node["attempt_id"]),
                node["lease_expires_at"].clone(),
                number_or_zero(&node["lease_generation"]),
                number_or_zero(&node["node_revision"]),
                json!(integration),
                node["campaign_status"].clone(),
                node["campaign_revision"].clone(),
                node["stop_reason"].clone(),
            ],
        )?;
        let mut detail = Record::new()
            .field("status", json!(status))
            .field("failureClass", json!(class))
            .field("failureHash", json!(failure_hash));
        for (key, encoded) in failure.fields {
            detail.fields.push((key.clone(), encoded));
            detail.value[&key] = failure.value[&key].clone();
        }
        insert_event(
            tx,
            event(
                "campaign_terminal_active_child_settled",
                &node["campaign_id"],
                &node["node_id"],
                &detail,
                at,
            )?,
            at,
        )?;
    }
    for node in array(plan, "terminalCampaignQueuedNodes")? {
        exactly_one(
            tx,
            "UPDATE campaign_nodes SET status='skipped',failure_class='terminal_campaign_reconciled',failure_json=NULL,failure_sha256=NULL,lease_owner=NULL,lease_expires_at=NULL,attempt_id=NULL,node_revision=node_revision+1,updated_at=? WHERE node_id=? AND campaign_id=? AND status='queued' AND node_revision=? AND EXISTS(SELECT 1 FROM paper_campaigns c WHERE c.campaign_id=campaign_nodes.campaign_id AND c.status=? AND c.revision=? AND c.stop_reason IS ? AND CAST(coalesce(json_extract(c.spec_json,'$.terminalSiblingSettlementPolicyVersion'),0) AS INTEGER)=1)",
            vec![
                json!(at),
                node["node_id"].clone(),
                node["campaign_id"].clone(),
                number_or_zero(&node["node_revision"]),
                node["campaign_status"].clone(),
                node["campaign_revision"].clone(),
                node["stop_reason"].clone(),
            ],
        )?;
        let detail = Record::new()
            .field("campaignStatus", node["campaign_status"].clone())
            .field("campaignStopReason", truthy_or_null(&node["stop_reason"]))
            .field(
                "reconciliationPlanHash",
                plan["reconciliationPlanHash"].clone(),
            );
        insert_event(
            tx,
            event(
                "campaign_terminal_child_closed",
                &node["campaign_id"],
                &node["node_id"],
                &detail,
                at,
            )?,
            at,
        )?;
    }
    for (key, table, id, time) in [
        (
            "expiredResourceLeases",
            "automation_resource_leases",
            "lease_id",
            "acquired_at",
        ),
        (
            "expiredWaiters",
            "automation_resource_waiters",
            "waiter_id",
            "requested_at",
        ),
    ] {
        for row in array(plan, key)? {
            let sql = format!(
                "DELETE FROM {table} WHERE {id}=? AND scope=? AND owner_id=? AND campaign_id IS ? AND node_id IS ? AND agent=? AND cpu=? AND gpu=? AND memory_mib=? AND {time}=? AND renewed_at=? AND expires_at=? AND expires_at<=?"
            );
            let mut values = [
                id,
                "scope",
                "owner_id",
                "campaign_id",
                "node_id",
                "agent",
                "cpu",
                "gpu",
                "memory_mib",
                time,
                "renewed_at",
                "expires_at",
            ]
            .iter()
            .map(|k| row[*k].clone())
            .collect::<Vec<_>>();
            values.push(json!(at));
            exactly_one(tx, &sql, values)?;
        }
    }
    exactly_one(
        tx,
        "INSERT INTO receipt_ledger(receipt_id,stream,paper_id,kind,status,receipt_json,receipt_sha256,created_at,environment,evidence_class,release_commit,writer_id,writer_kind,writer_trusted,issuer_policy_id,issuer_policy_hash,issuer_assurance) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        prepared.parameters.clone(),
    )
}

/// Synchronous clock observations only. This private boundary carries no
/// writer identity, admission, or production authority. Separate methods retain
/// the incumbent's nowIso()/now() sampling order; no monotonicity is imposed.
pub(super) trait ReconciliationClockV1 {
    fn now_iso(&mut self) -> Result<String>;
    fn now_millis(&mut self) -> Result<i64>;
}

pub(super) struct SystemReconciliationClockV1;
impl ReconciliationClockV1 for SystemReconciliationClockV1 {
    fn now_iso(&mut self) -> Result<String> {
        iso(self.now_millis()?)
    }
    fn now_millis(&mut self) -> Result<i64> {
        use std::time::{SystemTime, UNIX_EPOCH};
        let millis = match SystemTime::now().duration_since(UNIX_EPOCH) {
            Ok(duration) => i128::try_from(duration.as_millis()).map_err(|_| Error::Input)?,
            // Match the integral millisecond clock boundary by truncating
            // sub-millisecond precision toward zero on either side of epoch.
            Err(error) => {
                -i128::try_from(error.duration().as_millis()).map_err(|_| Error::Input)?
            }
        };
        let millis = i64::try_from(millis).map_err(|_| Error::Input)?;
        if !(-8_640_000_000_000_000..=8_640_000_000_000_000).contains(&millis) {
            return Err(Error::Input);
        }
        Ok(millis)
    }
}
fn iso(millis: i64) -> Result<String> {
    crate::sqlite_mutation_coordinator::clock::iso(millis).map_err(|_| Error::Input)
}
struct FixedReconciliationClockV1<'a> {
    now: &'a str,
    millis: i64,
}
impl<'a> FixedReconciliationClockV1<'a> {
    fn new(now: &'a str) -> Result<Self> {
        let millis =
            crate::journal_connector_coverage::qualification::canonical_instant_millis(now)
                .ok_or(Error::Input)?;
        Ok(Self { now, millis })
    }
}
impl ReconciliationClockV1 for FixedReconciliationClockV1<'_> {
    fn now_iso(&mut self) -> Result<String> {
        Ok(self.now.to_owned())
    }
    fn now_millis(&mut self) -> Result<i64> {
        Ok(self.millis)
    }
}
pub(super) fn plan_with_clock(
    connection: &Connection,
    clock: &mut dyn ReconciliationClockV1,
    no_progress_seconds: f64,
    campaign_id: Option<&str>,
) -> Result<Value> {
    // The incumbent resolves campaign scope before either clock observation.
    verify_campaign_scope(connection, campaign_id)?;
    let now = clock.now_iso()?;
    let cutoff_now_millis = clock.now_millis()?;
    plan_on_connection_at(
        connection,
        &now,
        cutoff_now_millis,
        no_progress_seconds,
        campaign_id,
    )
}

/// Fixed-clock compatibility wrapper. Admission and authority are supplied by
/// the retained private foundation scope, never by the timestamp.
pub(super) fn execute_on_admitted_connection(
    connection: &mut Connection,
    now: &str,
    no_progress_seconds: f64,
    campaign_id: Option<&str>,
    release_commit: Option<&str>,
    before_apply: impl FnOnce(&Connection) -> Result<()>,
    before_commit: impl FnOnce() -> Result<()>,
) -> Result<Value> {
    let mut clock = FixedReconciliationClockV1::new(now)?;
    execute_on_admitted_connection_with_clock(
        connection,
        &mut clock,
        no_progress_seconds,
        campaign_id,
        release_commit,
        before_apply,
        before_commit,
    )
}

/// Preserve the incumbent's six observations: plan ISO, plan Date, reconcile
/// ISO, ledger ISO, then (only after COMMIT) the after-plan ISO and Date.
pub(super) fn execute_on_admitted_connection_with_clock(
    connection: &mut Connection,
    clock: &mut dyn ReconciliationClockV1,
    no_progress_seconds: f64,
    campaign_id: Option<&str>,
    release_commit: Option<&str>,
    before_apply: impl FnOnce(&Connection) -> Result<()>,
    before_commit: impl FnOnce() -> Result<()>,
) -> Result<Value> {
    let plan = plan_with_clock(connection, clock, no_progress_seconds, campaign_id)?;
    let reconciled_at = clock.now_iso()?;
    let payload = receipt_payload(&plan, &reconciled_at)?;
    let ledger_at = clock.now_iso()?;
    let prepared = prepare_receipt_from_payload(payload, &ledger_at, release_commit)?;
    commit_prepared(
        connection,
        &plan,
        &prepared,
        &reconciled_at,
        before_apply,
        before_commit,
    )?;
    let after = plan_with_clock(connection, clock, no_progress_seconds, campaign_id)?;
    Ok(completion(prepared, after))
}

fn commit_prepared(
    connection: &mut Connection,
    plan: &Value,
    prepared: &PreparedReceipt,
    at: &str,
    before_apply: impl FnOnce(&Connection) -> Result<()>,
    before_commit: impl FnOnce() -> Result<()>,
) -> Result<()> {
    let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    before_apply(&tx)?;
    apply(&tx, plan, prepared, at)?;
    before_commit()?;
    tx.commit()?;
    Ok(())
}
fn completion(prepared: PreparedReceipt, after: Value) -> Value {
    let mut receipt = prepared.payload.value;
    receipt["ledgerReceipt"] = prepared.ledger;
    receipt["after"] = after;
    receipt
}
#[cfg(test)]
fn execute_prepared(
    connection: &mut Connection,
    plan: &Value,
    prepared: PreparedReceipt,
    context: (&str, f64, Option<&str>),
    before_apply: impl FnOnce(&Connection) -> Result<()>,
    before_commit: impl FnOnce() -> Result<()>,
) -> Result<Value> {
    let (at, no_progress_seconds, campaign_id) = context;
    commit_prepared(connection, plan, &prepared, at, before_apply, before_commit)?;
    let after = plan_on_connection(connection, at, no_progress_seconds, campaign_id)?;
    Ok(completion(prepared, after))
}

#[cfg(test)]
mod tests;
