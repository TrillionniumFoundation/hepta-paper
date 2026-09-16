use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use thiserror::Error;
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CampaignSloCampaignV1 {
    pub status: String,
    pub cost_known: bool,
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
    pub phases: std::collections::BTreeMap<String, f64>,
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
}
fn pct(v: &mut Vec<f64>, p: f64) -> Option<f64> {
    if v.is_empty() {
        None
    } else {
        v.sort_by(|a, b| a.partial_cmp(b).unwrap());
        Some(
            v[((v.len() as f64 * p).ceil() as usize)
                .saturating_sub(1)
                .min(v.len() - 1)],
        )
    }
}
pub fn build_campaign_slo_report_v1(r: &CampaignSloRequestV1) -> Result<Value, CampaignSloError> {
    if r.nodes.len() > 4096 || r.campaigns.len() > 4096 {
        return Err(CampaignSloError::Invalid);
    }
    let mut q = Vec::new();
    let mut rec: Vec<f64> = Vec::new();
    let mut started = std::collections::HashMap::new();
    for e in &r.events {
        if let (Some(id), Some(t)) = (&e.node_id, e.at_unix_ms) {
            if e.kind == "campaign_node_started" {
                started.insert(id.clone(), t);
            }
            if e.kind == "campaign_node_retry_queued" || e.kind == "campaign_node_manually_retried"
            {
                if let Some(s) = r.events.iter().find(|x| {
                    x.node_id.as_ref() == Some(id)
                        && x.kind == "campaign_node_started"
                        && x.at_unix_ms.unwrap_or(0) >= t
                }) {
                    rec.push((s.at_unix_ms.unwrap() - t) as f64);
                }
            }
        }
    }
    for n in &r.nodes {
        if let (Some(s), Some(c)) = (started.get(&n.node_id), n.created_at_unix_ms) {
            q.push((*s).saturating_sub(c) as f64)
        }
    }
    let terminal = r
        .nodes
        .iter()
        .filter(|n| n.status == "completed" || n.status == "failed_terminal")
        .count();
    let completed = r.nodes.iter().filter(|n| n.status == "completed").count();
    let success = if terminal == 0 {
        None
    } else {
        Some(completed as f64 / terminal as f64)
    };
    let mut qp = q.clone();
    let mut rp = rec.clone();
    let q95 = pct(&mut qp, 0.95);
    let r95 = pct(&mut rp, 0.95);
    let min = r.targets.minimum_terminal_node_success_rate.unwrap_or(0.95);
    let maxq = r.targets.maximum_queue_wait_p95_ms.unwrap_or(900000.00);
    let maxr = r.targets.maximum_recovery_p95_ms.unwrap_or(300000.00);
    let maxb = r
        .targets
        .maximum_runtime_bytes
        .unwrap_or(10 * 1024 * 1024 * 1024);
    let observed = json!({"terminalNodeSuccessRate":success,"queueWaitP95Ms":q95,"recoveryP95Ms":r95,"runtimeBytes":r.runtime_bytes,"sampleCounts":{"queueWait":q.len(),"recovery":rec.len(),"telemetry":r.telemetry_samples.len()}});
    let objectives = json!({"terminalNodeSuccessRate":success.is_some_and(|x|x>=min),"queueWaitP95":q95.is_some_and(|x|x<=maxq),"recoveryP95":r95.is_some_and(|x|x<=maxr),"runtimeQuota":r.runtime_bytes<=maxb,"costsAuditable":r.campaigns.iter().all(|x|x.cost_known)});
    Ok(
        json!({"version":2,"kind":"CampaignSloReport","status":"campaign_slos_not_met","targets":{"minimumTerminalNodeSuccessRate":min,"maximumQueueWaitP95Ms":maxq,"maximumRecoveryP95Ms":maxr,"maximumRuntimeBytes":maxb},"observed":observed,"objectives":objectives}),
    )
}
