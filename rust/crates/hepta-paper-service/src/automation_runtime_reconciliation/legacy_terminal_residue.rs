//! Policy-v0 legacy terminal residue maintenance, behind typed writer admission.
//! Queued rows remain untouched. Their framed digest is observational: the
//! incumbent transaction checks queued count, not an equality fence on that hash.
use super::{AutomationRuntimeReconciliationError as Error, rows, valid_campaign_id};
use hepta_legacy_compatibility::production_hash_record_v1;
use rusqlite::{Connection, Transaction, TransactionBehavior, params, params_from_iter};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
type Result<T> = std::result::Result<T, Error>;
fn failure(code: &'static str) -> Error {
    Error::Precondition(code)
}
fn require(ok: bool, code: &'static str) -> Result<()> {
    if ok { Ok(()) } else { Err(failure(code)) }
}

// Retain JSON.stringify insertion order for persisted strings and the queued
// streaming digest; serde_json maps intentionally keep a separate lookup view.
struct Record {
    value: Value,
    fields: Vec<(String, String)>,
}
impl Record {
    fn new() -> Self {
        Self {
            value: json!({}),
            fields: vec![],
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
        Value::Number(n) => ryu_js::Buffer::new()
            .format(n.as_f64().expect("JSON number"))
            .to_owned(),
        Value::Array(a) => format!("[{}]", a.iter().map(wire).collect::<Vec<_>>().join(",")),
        _ => serde_json::to_string(v).expect("representable JSON"),
    }
}
fn hash(kind: &str, value: &Value) -> Result<String> {
    production_hash_record_v1(kind, value)
        .map(|v| v.as_str().to_owned())
        .map_err(|_| Error::Hash)
}
fn or_null(v: &Value) -> Value {
    if v.is_null() || v == false || v == "" || v.as_f64() == Some(0.0) {
        Value::Null
    } else {
        v.clone()
    }
}
fn number(v: &Value) -> Value {
    match v {
        Value::Null => json!(0),
        Value::Bool(v) => json!(i64::from(*v)),
        Value::String(v) if v.trim().is_empty() => json!(0),
        Value::String(v) => v
            .trim()
            .parse::<f64>()
            .ok()
            .map_or(Value::Null, |v| json!(v)),
        _ => v.clone(),
    }
}
fn text_or_none(v: &Value) -> String {
    if or_null(v).is_null() {
        "none".into()
    } else if let Some(s) = v.as_str() {
        s.into()
    } else {
        wire(v)
    }
}
fn millis(value: &str) -> Option<i64> {
    use crate::journal_connector_coverage::qualification::canonical_instant_millis as canonical;
    if let Some(at) = canonical(value) {
        return Some(at);
    }
    // Native/SQLite emit UTC timestamps. Support the incumbent's date-only and
    // explicit ISO offset/fraction spellings without invoking a JS process.
    static ISO: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let pattern=ISO.get_or_init(||regex::Regex::new(r"^([0-9]{4}|[+-][0-9]{6})-([0-9]{2})-([0-9]{2})(?:[Tt ]([0-9]{2}):([0-9]{2})(?::([0-9]{2})(?:\.([0-9]+))?)?([Zz]|[+-][0-9]{2}:?[0-9]{2})?)?$").expect("constant regex"));
    let c = pattern.captures(value)?;
    let day = c[3].parse::<i64>().ok()?;
    if !(1..=31).contains(&day) {
        return None;
    }
    let hour = c
        .get(4)
        .map_or(Some(0), |v| v.as_str().parse::<i64>().ok())?;
    let minute = c
        .get(5)
        .map_or(Some(0), |v| v.as_str().parse::<i64>().ok())?;
    let second = c
        .get(6)
        .map_or(Some(0), |v| v.as_str().parse::<i64>().ok())?;
    let mut fraction = c
        .get(7)
        .map_or("", |v| v.as_str())
        .chars()
        .take(3)
        .collect::<String>();
    while fraction.len() < 3 {
        fraction.push('0');
    }
    let fraction = fraction.parse::<i64>().ok()?;
    if hour > 24 || minute > 59 || second > 59 || (hour == 24 && minute + second + fraction != 0) {
        return None;
    }
    let base = canonical(&format!("{}-{}-01T00:00:00.000Z", &c[1], &c[2]))?;
    if c.get(4).is_some() && c.get(8).is_none() {
        return None;
    }
    let zone = c.get(8).map_or("Z", |v| v.as_str());
    let offset = if zone.eq_ignore_ascii_case("Z") {
        0
    } else {
        let raw = zone[1..].replace(':', "");
        let h = raw[..2].parse::<i64>().ok()?;
        let m = raw[2..].parse::<i64>().ok()?;
        if h > 23 || m > 59 {
            return None;
        }
        (h * 60 + m) * 60_000 * if zone.starts_with('-') { -1 } else { 1 }
    };
    let at = base
        + (day - 1) * 86_400_000
        + hour * 3_600_000
        + minute * 60_000
        + second * 1000
        + fraction
        - offset;
    (at.abs() <= 8_640_000_000_000_000).then_some(at)
}
fn normalize_node(row: &Value) -> Result<Value> {
    let payload = json!({"nodeId":row["node_id"],"campaignId":row["campaign_id"],"status":row["status"],
        "leaseOwner":or_null(&row["lease_owner"]),"leaseExpiresAt":or_null(&row["lease_expires_at"]),
        "attemptId":or_null(&row["attempt_id"]),"leaseGeneration":number(&row["lease_generation"]),
        "nodeRevision":number(&row["node_revision"]),"preparedIntegrationStatus":text_or_none(&row["prepared_integration_status"])});
    let digest = hash("LegacyTerminalActiveResidueNodeState", &payload)?;
    let mut value = payload;
    value["nodeStateHash"] = json!(digest);
    Ok(value)
}
fn queued_record(row: &Value) -> Record {
    Record::new()
        .field("nodeId", row["node_id"].clone())
        .field("status", row["status"].clone())
        .field("nodeRevision", number(&row["node_revision"]))
        .field("leaseOwner", or_null(&row["lease_owner"]))
        .field("leaseExpiresAt", or_null(&row["lease_expires_at"]))
        .field("attemptId", or_null(&row["attempt_id"]))
        .field("leaseGeneration", number(&row["lease_generation"]))
        .field(
            "preparedIntegrationStatus",
            json!(text_or_none(&row["prepared_integration_status"])),
        )
        .field(
            "preparedResultHash",
            or_null(&row["prepared_result_sha256"]),
        )
        .field("resultHash", or_null(&row["result_sha256"]))
        .field("failureClass", or_null(&row["failure_class"]))
        .field("failureHash", or_null(&row["failure_sha256"]))
        .field("updatedAt", row["updated_at"].clone())
}
fn queued_state(db: &Connection, campaign: &str) -> Result<(usize, String)> {
    let mut digest = Sha256::new();
    digest.update(b"LegacyTerminalPreservedQueuedNodeState:v1\0");
    let mut last: Option<String> = None;
    let mut count = 0;
    loop {
        let page = rows(
            db,
            "SELECT node_id,status,node_revision,lease_owner,lease_expires_at,attempt_id,lease_generation,prepared_integration_status,prepared_result_sha256,result_sha256,failure_class,failure_sha256,updated_at FROM campaign_nodes WHERE campaign_id=?1 AND status='queued' AND (?2 IS NULL OR node_id>?2) ORDER BY node_id LIMIT 512",
            params![campaign, last],
        )?;
        for row in &page {
            let encoded = queued_record(row).wire();
            digest.update(format!("{}:", encoded.len()).as_bytes());
            digest.update(encoded.as_bytes());
        }
        count += page.len();
        if page.len() < 512 {
            break;
        }
        last = Some(
            page.last()
                .and_then(|r| r["node_id"].as_str())
                .ok_or(Error::Row)?
                .to_owned(),
        );
    }
    Ok((count, format!("sha256:{}", hex::encode(digest.finalize()))))
}
fn read_campaign(db: &Connection, campaign: &str) -> Result<(Value, &'static str)> {
    require(
        valid_campaign_id(campaign),
        "legacy_terminal_active_residue_campaign_id_invalid",
    )?;
    let parents = rows(
        db,
        "SELECT campaign_id,paper_id,status,revision,stop_reason,spec_json,json_type(spec_json,'$.terminalSiblingSettlementPolicyVersion') AS policy_type,json_extract(spec_json,'$.terminalSiblingSettlementPolicyVersion') AS policy_version FROM paper_campaigns WHERE campaign_id=? LIMIT 2",
        [campaign],
    )?;
    require(
        parents.len() == 1 && parents[0]["campaign_id"] == campaign,
        "legacy_terminal_active_residue_campaign_not_found",
    )?;
    let parent = &parents[0];
    require(
        matches!(
            parent["status"].as_str(),
            Some("failed" | "cancelled" | "stopped" | "completed")
        ),
        "legacy_terminal_active_residue_campaign_not_terminal",
    )?;
    let encoding = if parent["policy_type"].is_null() {
        "missing_legacy_v0"
    } else if parent["policy_type"] == "integer"
        && number(&parent["policy_version"]).as_f64() == Some(0.0)
    {
        "explicit_integer_v0"
    } else {
        return Err(failure("legacy_terminal_active_residue_policy_not_v0"));
    };
    Ok((parent.clone(), encoding))
}
pub(super) fn verify_campaign_scope(db: &Connection, campaign: &str) -> Result<()> {
    read_campaign(db, campaign).map(|_| ())
}
pub(super) fn plan_on_connection(
    db: &Connection,
    planned_at: &str,
    campaign: &str,
) -> Result<Value> {
    let (parent, encoding) = read_campaign(db, campaign)?;
    let raw = rows(
        db,
        "SELECT node_id,campaign_id,status,lease_owner,lease_expires_at,attempt_id,lease_generation,node_revision,prepared_integration_status FROM campaign_nodes WHERE campaign_id=? AND status IN ('leased','running') ORDER BY node_id",
        [campaign],
    )?;
    let now = millis(planned_at)
        .ok_or_else(|| failure("legacy_terminal_active_residue_clock_invalid"))?;
    let mut nodes = Vec::new();
    for row in raw {
        let node = normalize_node(&row)?;
        require(
            matches!(node["status"].as_str(), Some("leased" | "running")),
            "legacy_terminal_active_residue_node_status_invalid",
        )?;
        require(
            node["leaseExpiresAt"]
                .as_str()
                .and_then(millis)
                .is_some_and(|at| at <= now),
            "legacy_terminal_active_residue_lease_not_expired",
        )?;
        require(
            !matches!(
                node["preparedIntegrationStatus"].as_str(),
                Some("integrating" | "integrated")
            ),
            "legacy_terminal_active_residue_integration_outcome_uncertain",
        )?;
        nodes.push(node);
    }
    let (queued_count, queued_hash) = queued_state(db, campaign)?;
    let coordinated = rows(
        db,
        "SELECT 'lease' AS row_kind,lease_id AS row_id FROM automation_resource_leases WHERE campaign_id=?1 OR node_id IN (SELECT node_id FROM campaign_nodes WHERE campaign_id=?1) UNION ALL SELECT 'waiter' AS row_kind,waiter_id AS row_id FROM automation_resource_waiters WHERE campaign_id=?1 OR node_id IN (SELECT node_id FROM campaign_nodes WHERE campaign_id=?1) ORDER BY row_kind,row_id",
        [campaign],
    )?;
    require(
        coordinated.is_empty(),
        "legacy_terminal_active_residue_coordination_rows_present",
    )?;
    let mut payload = json!({"version":1,"kind":"LegacyTerminalActiveResidueSettlementPlan","status":if nodes.is_empty(){"legacy_terminal_active_residue_settlement_clean"}else{"legacy_terminal_active_residue_settlement_required"},"campaignId":campaign,"paperId":parent["paper_id"],"campaignStatus":parent["status"],"campaignRevision":number(&parent["revision"]),"campaignStopReason":or_null(&parent["stop_reason"]),"terminalSiblingSettlementPolicyVersion":0,"terminalSiblingSettlementPolicyEncoding":encoding,"plannedAt":planned_at,"nodes":nodes,"preservedQueuedNodeCount":queued_count,"preservedQueuedNodeStateHash":queued_hash,"workersStarted":false,"externalActionPerformed":false});
    let digest = hash("LegacyTerminalActiveResidueSettlementPlan", &payload)?;
    payload["settlementPlanHash"] = json!(digest);
    Ok(payload)
}

struct Settlement {
    node: Value,
    failure: Record,
    failure_hash: String,
    event: Record,
    event_hash: String,
    event_id: String,
}
fn settlements(plan: &Value) -> Result<Vec<Settlement>> {
    plan["nodes"]
        .as_array()
        .ok_or(Error::Row)?
        .iter()
        .map(|node| {
            let failure = Record::new()
                .field(
                    "reason",
                    json!("legacy_terminal_expired_active_residue_settled"),
                )
                .field("campaignStatus", plan["campaignStatus"].clone())
                .field("campaignStopReason", plan["campaignStopReason"].clone())
                .field("previousStatus", node["status"].clone())
                .field("previousLeaseOwner", node["leaseOwner"].clone())
                .field("previousLeaseExpiresAt", node["leaseExpiresAt"].clone())
                .field("previousAttemptId", node["attemptId"].clone())
                .field("previousLeaseGeneration", node["leaseGeneration"].clone())
                .field("previousNodeRevision", node["nodeRevision"].clone())
                .field(
                    "preparedIntegrationStatus",
                    node["preparedIntegrationStatus"].clone(),
                )
                .field("nodeStateHash", node["nodeStateHash"].clone())
                .field("settlementPlanHash", plan["settlementPlanHash"].clone())
                .field("workersStarted", json!(false))
                .field("externalActionPerformed", json!(false));
            let failure_hash = hash("PaperCampaignNodeFailure", &failure.value)?;
            let mut detail = Record::new()
                .field("status", json!("skipped"))
                .field("failureClass", failure.value["reason"].clone())
                .field("failureHash", json!(failure_hash));
            detail.fields.extend(failure.fields.iter().cloned());
            for (key, value) in failure.value.as_object().ok_or(Error::Row)? {
                detail.value[key] = value.clone();
            }
            let event = Record::new()
                .field("version", json!(1))
                .field(
                    "kind",
                    json!("campaign_legacy_terminal_expired_active_residue_settled"),
                )
                .field("campaignId", plan["campaignId"].clone())
                .field("nodeId", node["nodeId"].clone())
                .nested("detail", &detail)
                .field("createdAt", plan["plannedAt"].clone());
            let event_hash = hash("PaperCampaignEvent", &event.value)?;
            let event_id = format!(
                "{}:{}:{}",
                plan["campaignId"].as_str().ok_or(Error::Row)?,
                node["nodeId"].as_str().ok_or(Error::Row)?,
                &event_hash[event_hash.len() - 24..]
            );
            Ok(Settlement {
                node: node.clone(),
                failure,
                failure_hash,
                event,
                event_hash,
                event_id,
            })
        })
        .collect()
}
struct Prepared {
    payload: Record,
    ledger: Value,
    parameters: Vec<Value>,
}
fn prepare(
    plan: &Value,
    settlements: &[Settlement],
    ledger_at: &str,
    release: Option<&str>,
) -> Result<Prepared> {
    let mut payload = Record::new()
        .field("version", json!(3))
        .field("kind", json!("AutomationRuntimeReconciliationReceipt"))
        .field("status", json!("legacy_terminal_active_residue_settled"));
    for key in [
        "campaignId",
        "campaignStatus",
        "campaignRevision",
        "terminalSiblingSettlementPolicyVersion",
        "terminalSiblingSettlementPolicyEncoding",
        "settlementPlanHash",
        "preservedQueuedNodeCount",
        "preservedQueuedNodeStateHash",
    ] {
        payload = payload.field(key, plan[key].clone());
    }
    payload = payload
        .field("settledNodeCount", json!(settlements.len()))
        .field(
            "settledNodeIds",
            json!(
                settlements
                    .iter()
                    .map(|s| s.node["nodeId"].clone())
                    .collect::<Vec<_>>()
            ),
        )
        .field(
            "settledNodeStateHashes",
            json!(
                settlements
                    .iter()
                    .map(|s| s.node["nodeStateHash"].clone())
                    .collect::<Vec<_>>()
            ),
        )
        .field(
            "settlementEventHashes",
            json!(
                settlements
                    .iter()
                    .map(|s| s.event_hash.clone())
                    .collect::<Vec<_>>()
            ),
        )
        .field("settledAt", plan["plannedAt"].clone())
        .field("workersStarted", json!(false))
        .field("externalActionPerformed", json!(false));
    let digest = hash("AutomationRuntimeReconciliationReceipt", &payload.value)?;
    payload = payload.field("receiptHash", json!(digest));
    let id = format!("automation-reconciliation:{digest}");
    // Source-owned least-privilege broker equivalent, never caller trust JSON.
    let policy = json!({"version":1,"policyId":"automation-reconciler","writerId":"automation-runtime-reconciler","writerKind":"automation-state-reconciler","assurance":"in_process_registered_administrator","allowedKinds":["AutomationRuntimeReconciliationReceipt"],"allowedStreams":["automation-reconciliation"]});
    let policy_hash = hash("ReceiptIssuerPolicy", &policy)?;
    let release = release.filter(|v| !v.is_empty());
    let ledger = json!({"receiptId":id,"receiptHash":digest,"stream":"automation-reconciliation","paperId":null,"createdAt":ledger_at,"environment":"administrative","evidenceClass":"legacy_terminal_active_residue_settlement","releaseCommit":release,"writerId":"automation-runtime-reconciler","writerKind":"automation-state-reconciler","writerTrusted":true,"issuerPolicyId":"automation-reconciler","issuerPolicyHash":policy_hash,"issuerAssurance":"in_process_registered_administrator"});
    let parameters = vec![
        json!(id),
        json!("automation-reconciliation"),
        Value::Null,
        json!("AutomationRuntimeReconciliationReceipt"),
        json!("legacy_terminal_active_residue_settled"),
        json!(payload.wire()),
        json!(digest),
        json!(ledger_at),
        json!("administrative"),
        json!("legacy_terminal_active_residue_settlement"),
        json!(release),
        json!("automation-runtime-reconciler"),
        json!("automation-state-reconciler"),
        json!(1),
        json!("automation-reconciler"),
        json!(policy_hash),
        json!("in_process_registered_administrator"),
    ];
    Ok(Prepared {
        payload,
        ledger,
        parameters,
    })
}
fn one(tx: &Transaction<'_>, sql: &str, values: Vec<Value>) -> Result<()> {
    use rusqlite::types::Value as S;
    let values = values
        .into_iter()
        .map(|v| {
            Ok(match v {
                Value::Null => S::Null,
                Value::String(s) => S::Text(s),
                Value::Number(n) => n
                    .as_i64()
                    .map_or_else(|| S::Real(n.as_f64().expect("number")), S::Integer),
                Value::Bool(b) => S::Integer(i64::from(b)),
                _ => return Err(Error::Row),
            })
        })
        .collect::<Result<Vec<_>>>()?;
    require(
        tx.execute(sql, params_from_iter(values))? == 1,
        "legacy_terminal_active_residue_exactly_one_precondition_failed",
    )
}
fn apply(
    tx: &Transaction<'_>,
    plan: &Value,
    settlements: &[Settlement],
    prepared: &Prepared,
) -> Result<()> {
    one(
        tx,
        "UPDATE paper_campaigns SET revision=revision WHERE campaign_id=?1 AND status=?2 AND revision=?3 AND status IN ('failed','cancelled','stopped','completed') AND (json_type(spec_json,'$.terminalSiblingSettlementPolicyVersion') IS NULL OR (json_type(spec_json,'$.terminalSiblingSettlementPolicyVersion')='integer' AND json_extract(spec_json,'$.terminalSiblingSettlementPolicyVersion')=0)) AND (SELECT count(*) FROM campaign_nodes n WHERE n.campaign_id=paper_campaigns.campaign_id AND n.status='queued')=?4 AND (SELECT count(*) FROM campaign_nodes n WHERE n.campaign_id=paper_campaigns.campaign_id AND n.status IN ('leased','running'))=?5 AND NOT EXISTS(SELECT 1 FROM campaign_nodes n WHERE n.campaign_id=paper_campaigns.campaign_id AND n.status IN ('leased','running') AND (n.lease_expires_at IS NULL OR julianday(n.lease_expires_at)>julianday(?6) OR n.prepared_integration_status IN ('integrating','integrated'))) AND NOT EXISTS(SELECT 1 FROM automation_resource_leases r WHERE r.campaign_id=paper_campaigns.campaign_id OR r.node_id IN (SELECT node_id FROM campaign_nodes WHERE campaign_id=paper_campaigns.campaign_id)) AND NOT EXISTS(SELECT 1 FROM automation_resource_waiters r WHERE r.campaign_id=paper_campaigns.campaign_id OR r.node_id IN (SELECT node_id FROM campaign_nodes WHERE campaign_id=paper_campaigns.campaign_id))",
        vec![
            plan["campaignId"].clone(),
            plan["campaignStatus"].clone(),
            plan["campaignRevision"].clone(),
            plan["preservedQueuedNodeCount"].clone(),
            json!(settlements.len()),
            plan["plannedAt"].clone(),
        ],
    )?;
    for s in settlements {
        let n = &s.node;
        one(
            tx,
            "UPDATE campaign_nodes SET status='skipped',failure_class=?,failure_json=?,failure_sha256=?,lease_owner=NULL,lease_expires_at=NULL,attempt_id=NULL,node_revision=node_revision+1,updated_at=? WHERE node_id=? AND campaign_id=? AND status=? AND lease_owner IS ? AND lease_expires_at=? AND attempt_id IS ? AND lease_generation=? AND node_revision=? AND prepared_integration_status=? AND status IN ('leased','running') AND julianday(lease_expires_at)<=julianday(?) AND prepared_integration_status NOT IN ('integrating','integrated') AND EXISTS(SELECT 1 FROM paper_campaigns c WHERE c.campaign_id=campaign_nodes.campaign_id AND c.status=? AND c.revision=? AND c.status IN ('failed','cancelled','stopped','completed') AND (json_type(c.spec_json,'$.terminalSiblingSettlementPolicyVersion') IS NULL OR (json_type(c.spec_json,'$.terminalSiblingSettlementPolicyVersion')='integer' AND json_extract(c.spec_json,'$.terminalSiblingSettlementPolicyVersion')=0)))",
            vec![
                s.failure.value["reason"].clone(),
                json!(s.failure.wire()),
                json!(s.failure_hash),
                plan["plannedAt"].clone(),
                n["nodeId"].clone(),
                plan["campaignId"].clone(),
                n["status"].clone(),
                n["leaseOwner"].clone(),
                n["leaseExpiresAt"].clone(),
                n["attemptId"].clone(),
                n["leaseGeneration"].clone(),
                n["nodeRevision"].clone(),
                n["preparedIntegrationStatus"].clone(),
                plan["plannedAt"].clone(),
                plan["campaignStatus"].clone(),
                plan["campaignRevision"].clone(),
            ],
        )?;
        one(
            tx,
            "INSERT INTO campaign_events(event_id,campaign_id,node_id,kind,event_json,event_sha256,created_at) VALUES(?,?,?,?,?,?,?)",
            vec![
                json!(s.event_id),
                plan["campaignId"].clone(),
                n["nodeId"].clone(),
                s.event.value["kind"].clone(),
                json!(s.event.wire()),
                json!(s.event_hash),
                plan["plannedAt"].clone(),
            ],
        )?;
    }
    one(
        tx,
        "INSERT INTO receipt_ledger(receipt_id,stream,paper_id,kind,status,receipt_json,receipt_sha256,created_at,environment,evidence_class,release_commit,writer_id,writer_kind,writer_trusted,issuer_policy_id,issuer_policy_hash,issuer_assurance) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        prepared.parameters.clone(),
    )
}
struct PreparedOperation {
    plan: Value,
    settlements: Vec<Settlement>,
    receipt: Prepared,
}
fn prepare_operation(
    connection: &Connection,
    campaign: &str,
    release: Option<&str>,
    now_iso: &mut impl FnMut() -> Result<String>,
) -> Result<PreparedOperation> {
    let plan = plan_on_connection(connection, &now_iso()?, campaign)?;
    let settlements = settlements(&plan)?;
    require(
        !settlements.is_empty(),
        "legacy_terminal_active_residue_nothing_to_settle",
    )?;
    let receipt = prepare(&plan, &settlements, &now_iso()?, release)?;
    Ok(PreparedOperation {
        plan,
        settlements,
        receipt,
    })
}
/// Private operation: caller must retain schema, package and durable cutover admission.
pub(super) fn execute_on_admitted_connection(
    connection: &mut Connection,
    campaign: &str,
    release: Option<&str>,
    now_iso: &mut impl FnMut() -> Result<String>,
    before_apply: impl FnOnce(&Connection) -> Result<()>,
    before_commit: impl FnOnce() -> Result<()>,
) -> Result<Value> {
    let prepared = prepare_operation(connection, campaign, release, now_iso)?;
    execute_prepared(connection, prepared, now_iso, before_apply, before_commit)
}
fn execute_prepared(
    connection: &mut Connection,
    prepared: PreparedOperation,
    now_iso: &mut impl FnMut() -> Result<String>,
    before_apply: impl FnOnce(&Connection) -> Result<()>,
    before_commit: impl FnOnce() -> Result<()>,
) -> Result<Value> {
    let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    before_apply(&tx)?;
    apply(
        &tx,
        &prepared.plan,
        &prepared.settlements,
        &prepared.receipt,
    )?;
    before_commit()?;
    tx.commit()?;
    let after = plan_on_connection(
        connection,
        &now_iso()?,
        prepared.plan["campaignId"].as_str().ok_or(Error::Row)?,
    )?;
    let mut receipt = prepared.receipt.payload.value;
    receipt["ledgerReceipt"] = prepared.receipt.ledger;
    receipt["after"] = after;
    Ok(receipt)
}
#[cfg(test)]
mod tests;
