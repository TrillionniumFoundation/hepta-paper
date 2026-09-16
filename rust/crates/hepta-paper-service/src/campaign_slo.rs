use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap};
use thiserror::Error;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CampaignSloCampaignV1 {
    pub status: String,
    pub cost_known: bool,
    #[serde(default)]
    pub cost_usd: Option<f64>,
    pub agent_call_count: u64,
    pub cpu_job_count: u64,
    pub gpu_job_count: u64,
    pub token_count: u64,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CampaignSloNodeV1 {
    pub node_id: String,
    pub status: String,
    pub created_at_unix_ms: Option<u64>,
    pub dependencies: Vec<String>,
    pub child_session_id: Option<String>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CampaignSloEventV1 {
    pub node_id: Option<String>,
    pub kind: String,
    pub at_unix_ms: Option<u64>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CampaignSloTelemetryV1 {
    pub phases: BTreeMap<String, f64>,
    pub lock_wait_ms: Option<f64>,
    pub queue_contention_count: Option<f64>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CampaignSloTargetsV1 {
    pub minimum_terminal_node_success_rate: Option<f64>,
    pub maximum_queue_wait_p95_ms: Option<f64>,
    pub maximum_recovery_p95_ms: Option<f64>,
    pub maximum_runtime_bytes: Option<u64>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CampaignSloRequestV1 {
    #[serde(default)]
    pub version: u16,
    pub campaigns: Vec<CampaignSloCampaignV1>,
    pub nodes: Vec<CampaignSloNodeV1>,
    pub events: Vec<CampaignSloEventV1>,
    pub telemetry_samples: Vec<CampaignSloTelemetryV1>,
    pub runtime_bytes: u64,
    pub targets: CampaignSloTargetsV1,
}
#[derive(Debug, Error)]
pub enum CampaignSloError {
    #[error("invalid SLO request")]
    Invalid,
    #[error("production Node collation profile unavailable")]
    Collation,
}

fn percentile(values: &mut [f64], fraction: f64) -> Option<f64> {
    if values.is_empty() {
        return None;
    }
    values.sort_by(|a, b| a.partial_cmp(b).unwrap());
    Some(
        values[((values.len() as f64 * fraction).ceil() as usize)
            .saturating_sub(1)
            .min(values.len() - 1)],
    )
}
fn counts(items: impl IntoIterator<Item = String>) -> Value {
    let mut out = BTreeMap::new();
    for item in items {
        *out.entry(item).or_insert(0_u64) += 1;
    }
    serde_json::to_value(out).unwrap()
}
fn finite(values: impl IntoIterator<Item = Option<f64>>) -> Vec<f64> {
    values
        .into_iter()
        .flatten()
        .filter(|v| v.is_finite())
        .collect()
}
fn histogram(values: &[f64], bounds: &[f64]) -> Value {
    let mut s = values.to_vec();
    s.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let mut out = bounds
        .iter()
        .map(|b| json!({"le":b,"count":s.iter().filter(|v|**v<=*b).count()}))
        .collect::<Vec<_>>();
    out.push(json!({"le":"+Inf","count":s.len()}));
    Value::Array(out)
}
fn canonical_string(
    v: &Value,
    collator: &hepta_legacy_compatibility::ProductionCollationV1,
) -> String {
    match v {
        Value::Array(a) => format!(
            "[{}]",
            a.iter()
                .map(|value| canonical_string(value, collator))
                .collect::<Vec<_>>()
                .join(",")
        ),
        Value::Object(o) => {
            let mut keys = o.keys().collect::<Vec<_>>();
            keys.sort_by(|left, right| collator.compare(left, right));
            format!(
                "{{{}}}",
                keys.into_iter()
                    .map(|key| format!(
                        "{}:{}",
                        serde_json::to_string(key).unwrap(),
                        canonical_string(&o[key], collator)
                    ))
                    .collect::<Vec<_>>()
                    .join(",")
            )
        }
        Value::Number(number) => {
            // JSON.stringify emits integral IEEE-754 values without `.0`.
            if let Some(value) = number.as_f64()
                && value.is_finite()
                && value.fract() == 0.0
                && value.abs() <= i64::MAX as f64
            {
                return (value as i64).to_string();
            }
            number.to_string()
        }
        Value::String(value) => serde_json::to_string(value).unwrap(),
        Value::Bool(value) => value.to_string(),
        Value::Null => "null".to_owned(),
    }
}
fn hash_report(v: &Value) -> Result<String, CampaignSloError> {
    let collator = hepta_legacy_compatibility::ProductionCollationV1::load()
        .map_err(|_| CampaignSloError::Collation)?;
    let envelope = json!({"kind":"CampaignSloReport","value":v});
    let bytes = canonical_string(&envelope, &collator).into_bytes();
    let mut h = Sha256::new();
    h.update(bytes);
    Ok(format!("sha256:{}", hex::encode(h.finalize())))
}

/// `JSON.stringify` writes integral IEEE-754 values without a trailing `.0`.
/// Rust's `json!(f64)` preserves that distinction in `serde_json::Value`, so
/// normalize the report tree before returning it.  The distinction is visible
/// to byte-level Node/Rust differential tests even though the numeric values
/// compare mathematically equal.
fn normalize_json_numbers(value: Value) -> Value {
    match value {
        Value::Array(values) => {
            Value::Array(values.into_iter().map(normalize_json_numbers).collect())
        }
        Value::Object(values) => Value::Object(
            values
                .into_iter()
                .map(|(key, value)| (key, normalize_json_numbers(value)))
                .collect(),
        ),
        Value::Number(number) => {
            let Some(value) = number.as_f64() else {
                return Value::Number(number);
            };
            if value.is_finite() && value.fract() == 0.0 && value.abs() <= i64::MAX as f64 {
                Value::Number((value as i64).into())
            } else {
                Value::Number(number)
            }
        }
        other => other,
    }
}

pub fn build_campaign_slo_report_v1(r: &CampaignSloRequestV1) -> Result<Value, CampaignSloError> {
    if (r.version != 0 && r.version != 1)
        || r.nodes.len() > 4096
        || r.campaigns.len() > 4096
        || r.events.len() > 32768
        || r.telemetry_samples.len() > 32768
    {
        return Err(CampaignSloError::Invalid);
    }
    let targets = json!({"minimumTerminalNodeSuccessRate":r.targets.minimum_terminal_node_success_rate.unwrap_or(0.95),"maximumQueueWaitP95Ms":r.targets.maximum_queue_wait_p95_ms.unwrap_or(900000.0),"maximumRecoveryP95Ms":r.targets.maximum_recovery_p95_ms.unwrap_or(300000.0),"maximumRuntimeBytes":r.targets.maximum_runtime_bytes.unwrap_or(10*1024*1024*1024)});
    let mut by_node: HashMap<String, Vec<(String, u64)>> = HashMap::new();
    let mut completed = HashMap::new();
    for e in &r.events {
        if let (Some(id), Some(at)) = (&e.node_id, e.at_unix_ms) {
            by_node
                .entry(id.clone())
                .or_default()
                .push((e.kind.clone(), at));
            if e.kind == "campaign_node_completed" {
                completed.insert(id.clone(), at);
            }
        }
    }
    let mut queue = Vec::new();
    let mut recovery = Vec::new();
    for n in &r.nodes {
        let mut timeline = by_node.get(&n.node_id).cloned().unwrap_or_default();
        timeline.sort_by_key(|(_, at)| *at);
        let started = timeline.iter().find(|(k, _)| k == "campaign_node_started");
        let deps = n
            .dependencies
            .iter()
            .filter_map(|d| completed.get(d).copied())
            .collect::<Vec<_>>();
        let ready = if deps.len() == n.dependencies.len() && !deps.is_empty() {
            deps.into_iter().max().unwrap()
        } else {
            n.created_at_unix_ms.unwrap_or(0)
        };
        if let Some((_, at)) = started
            && *at >= ready
        {
            queue.push((*at - ready) as f64);
        }
        for (i, (kind, at)) in timeline.iter().enumerate() {
            if !matches!(
                kind.as_str(),
                "campaign_node_retry_queued"
                    | "campaign_node_manually_retried"
                    | "campaign_node_lease_recovered"
            ) {
                continue;
            }
            if let Some((_, resumed)) = timeline[i + 1..]
                .iter()
                .find(|(k, _)| k == "campaign_node_started")
            {
                recovery.push(resumed.saturating_sub(*at) as f64);
            }
        }
    }
    let terminal = r
        .nodes
        .iter()
        .filter(|n| matches!(n.status.as_str(), "completed" | "failed_terminal"))
        .count();
    let success = (terminal > 0).then_some(
        r.nodes.iter().filter(|n| n.status == "completed").count() as f64 / terminal as f64,
    );
    // The oracle adapter derives costUsd from costKnown, so a known campaign
    // remains auditable even when the normalized request omitted costUsd.
    let unknown = r.campaigns.iter().filter(|c| !c.cost_known).count();
    let phases = ["dispatch", "lockAcquire", "command", "lockRelease", "total"];
    let phase_values = phases
        .iter()
        .map(|p| {
            (
                *p,
                finite(
                    r.telemetry_samples
                        .iter()
                        .map(|s| s.phases.get(*p).copied()),
                ),
            )
        })
        .collect::<BTreeMap<_, _>>();
    let locks = finite(r.telemetry_samples.iter().map(|s| s.lock_wait_ms));
    let contention = finite(r.telemetry_samples.iter().map(|s| s.queue_contention_count));
    let mut q50 = queue.clone();
    let mut q95 = queue.clone();
    let mut r50 = recovery.clone();
    let mut r95 = recovery.clone();
    let phase_p95 = phases
        .iter()
        .map(|p| {
            let mut values = phase_values[*p].clone();
            ((*p).to_owned(), percentile(&mut values, 0.95))
        })
        .collect::<BTreeMap<_, _>>();
    let lock_p95 = percentile(&mut locks.clone(), 0.95);
    let retry_count = r
        .events
        .iter()
        .filter(|e| {
            matches!(
                e.kind.as_str(),
                "campaign_node_retry_queued" | "campaign_node_manually_retried"
            )
        })
        .count();
    let unique_sessions = r
        .nodes
        .iter()
        .filter_map(|n| n.child_session_id.as_ref())
        .collect::<std::collections::BTreeSet<_>>()
        .len();
    let observed = json!({"campaignCounts":counts(r.campaigns.iter().map(|x|x.status.clone())),"nodeCounts":counts(r.nodes.iter().map(|x|x.status.clone())),"terminalNodeSuccessRate":success,"queueWaitP50Ms":percentile(&mut q50,0.5),"queueWaitP95Ms":percentile(&mut q95,0.95),"recoveryP50Ms":percentile(&mut r50,0.5),"recoveryP95Ms":percentile(&mut r95,0.95),"sampleCounts":{"queueWait":queue.len(),"recovery":recovery.len(),"telemetry":r.telemetry_samples.len(),"lockWait":locks.len(),"queueContention":contention.len()},"phaseTimingP95Ms":phase_p95,"lockWaitP95Ms":lock_p95,"lockWaitHistogram":histogram(&locks,&[0.0,1.0,5.0,10.0,50.0,100.0,500.0,1000.0]),"queueContentionHistogram":histogram(&contention,&[0.0,1.0,2.0,5.0,10.0]),"retryEventCount":retry_count,"uniqueChildSessionCount":unique_sessions,"totalAgentCalls":r.campaigns.iter().map(|x|x.agent_call_count).sum::<u64>(),"totalCpuJobs":r.campaigns.iter().map(|x|x.cpu_job_count).sum::<u64>(),"totalGpuJobs":r.campaigns.iter().map(|x|x.gpu_job_count).sum::<u64>(),"totalTokens":r.campaigns.iter().map(|x|x.token_count).sum::<u64>(),"unknownCostCampaignCount":unknown,"runtimeBytes":r.runtime_bytes});
    let q = observed["queueWaitP95Ms"].as_f64();
    let rec = observed["recoveryP95Ms"].as_f64();
    let obj = json!({"terminalNodeSuccessRate":success.is_some_and(|x|x>=targets["minimumTerminalNodeSuccessRate"].as_f64().unwrap()),"queueWaitP95":q.is_some_and(|x|x<=targets["maximumQueueWaitP95Ms"].as_f64().unwrap()),"recoveryP95":rec.is_some_and(|x|x<=targets["maximumRecoveryP95Ms"].as_f64().unwrap()),"runtimeQuota":r.runtime_bytes<=targets["maximumRuntimeBytes"].as_u64().unwrap(),"costsAuditable":unknown==0});
    let states = json!({"terminalNodeSuccessRate":if success.is_none(){"insufficient_data"}else if obj["terminalNodeSuccessRate"].as_bool().unwrap(){"met"}else{"not_met"},"queueWaitP95":if q.is_none(){"insufficient_data"}else if obj["queueWaitP95"].as_bool().unwrap(){"met"}else{"not_met"},"recoveryP95":if rec.is_none(){"insufficient_data"}else if obj["recoveryP95"].as_bool().unwrap(){"met"}else{"not_met"},"runtimeQuota":if obj["runtimeQuota"].as_bool().unwrap(){"met"}else{"not_met"},"costsAuditable":if obj["costsAuditable"].as_bool().unwrap(){"met"}else{"not_met"}});
    let met = obj
        .as_object()
        .unwrap()
        .values()
        .all(|v| v.as_bool() == Some(true));
    let payload = normalize_json_numbers(
        json!({"version":2,"kind":"CampaignSloReport","status":if met{"campaign_slos_met"}else{"campaign_slos_not_met"},"targets":targets,"observed":observed,"objectives":obj,"objectiveStates":states}),
    );
    Ok(
        json!({"version":2,"kind":"CampaignSloReport","status":payload["status"],"targets":payload["targets"],"observed":payload["observed"],"objectives":payload["objectives"],"objectiveStates":payload["objectiveStates"],"campaignSloReportHash":hash_report(&payload)?}),
    )
}
