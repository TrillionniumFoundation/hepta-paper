//! Native SLO report computation over explicit, bounded timestamp/counter views.
//! It neither reads a live database nor manufactures qualified measurements.
//! The oracle converts these UTC millisecond timestamps into actual Node events
//! and calls buildCampaignSloReport; date parsing is deliberately outside this API.
use super::campaign_policy::CampaignPolicyError;
use hepta_legacy_compatibility::production_hash_record_v1;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};
const MAX_SAFE: u64 = 9_007_199_254_740_991;
const PHASES: [&str; 5] = ["dispatch", "lockAcquire", "command", "lockRelease", "total"];
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SloCampaignViewV1 {
    pub status: String,
    pub cost_known: bool,
    pub agent_call_count: u64,
    pub cpu_job_count: u64,
    pub gpu_job_count: u64,
    pub token_count: u64,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SloNodeViewV1 {
    pub node_id: String,
    pub status: String,
    pub created_at_unix_ms: Option<u64>,
    pub dependencies: Vec<String>,
    pub child_session_id: Option<String>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SloEventViewV1 {
    pub node_id: Option<String>,
    pub kind: String,
    pub at_unix_ms: Option<u64>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SloTelemetryViewV1 {
    pub phases: BTreeMap<String, f64>,
    pub lock_wait_ms: Option<f64>,
    pub queue_contention_count: Option<f64>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields, default)]
pub struct CampaignSloTargetsV1 {
    pub minimum_terminal_node_success_rate: f64,
    pub maximum_queue_wait_p95_ms: u64,
    pub maximum_recovery_p95_ms: u64,
    pub maximum_runtime_bytes: u64,
}
impl Default for CampaignSloTargetsV1 {
    fn default() -> Self {
        Self {
            minimum_terminal_node_success_rate: 0.95,
            maximum_queue_wait_p95_ms: 900_000,
            maximum_recovery_p95_ms: 300_000,
            maximum_runtime_bytes: 10 * 1024 * 1024 * 1024,
        }
    }
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CampaignSloRequestV1 {
    pub version: u16,
    pub campaigns: Vec<SloCampaignViewV1>,
    pub nodes: Vec<SloNodeViewV1>,
    pub events: Vec<SloEventViewV1>,
    pub telemetry_samples: Vec<SloTelemetryViewV1>,
    pub runtime_bytes: u64,
    #[serde(default)]
    pub targets: CampaignSloTargetsV1,
}
fn text(s: &str) -> bool {
    !s.is_empty() && s.len() <= 256 && !s.chars().any(char::is_control)
}
fn timestamp(t: Option<u64>) -> bool {
    t.is_none_or(|n| n <= 253_402_300_799_999)
}
fn count(values: impl Iterator<Item = String>) -> Value {
    let mut counts = BTreeMap::<String, u64>::new();
    for v in values {
        *counts.entry(v).or_default() += 1;
    }
    json!(counts)
}
fn percentile(values: &[f64], percent: usize) -> Option<f64> {
    if values.is_empty() {
        return None;
    }
    let mut sorted = values.to_vec();
    sorted.sort_by(f64::total_cmp);
    sorted
        .get(
            (sorted.len() * percent)
                .div_ceil(100)
                .saturating_sub(1)
                .min(sorted.len() - 1),
        )
        .copied()
}
fn histogram(values: &[f64], bounds: &[u64]) -> Value {
    let mut out: Vec<_> = bounds
        .iter()
        .map(|&b| json!({"le":b,"count":values.iter().filter(|&&n|n<=b as f64).count()}))
        .collect();
    out.push(json!({"le":"+Inf","count":values.len()}));
    json!(out)
}
fn sum(mut values: impl Iterator<Item = u64>) -> Result<u64, CampaignPolicyError> {
    values.try_fold(0u64, |a, b| {
        a.checked_add(b)
            .filter(|n| *n <= MAX_SAFE)
            .ok_or(CampaignPolicyError::Overflow)
    })
}
fn retry(kind: &str) -> bool {
    matches!(
        kind,
        "campaign_node_retry_queued"
            | "campaign_node_manually_retried"
            | "campaign_node_lease_recovered"
    )
}
impl CampaignSloRequestV1 {
    pub fn validate(&self) -> Result<(), CampaignPolicyError> {
        if self.version != 1
            || self.campaigns.len() > 4096
            || self.nodes.len() > 4096
            || self.events.len() > 32768
            || self.telemetry_samples.len() > 16384
            || self.runtime_bytes > MAX_SAFE
            || !self.targets.minimum_terminal_node_success_rate.is_finite()
            || !(0.0..=1.0).contains(&self.targets.minimum_terminal_node_success_rate)
            || [
                self.targets.maximum_queue_wait_p95_ms,
                self.targets.maximum_recovery_p95_ms,
                self.targets.maximum_runtime_bytes,
            ]
            .iter()
            .any(|&v| v > MAX_SAFE)
        {
            return Err(CampaignPolicyError::Contract);
        }
        for c in &self.campaigns {
            if !text(&c.status)
                || !c.status.is_ascii()
                || [
                    c.agent_call_count,
                    c.cpu_job_count,
                    c.gpu_job_count,
                    c.token_count,
                ]
                .iter()
                .any(|&n| n > MAX_SAFE)
            {
                return Err(CampaignPolicyError::Contract);
            }
        }
        let mut ids = BTreeSet::new();
        let mut edges = 0usize;
        for n in &self.nodes {
            edges = edges
                .checked_add(n.dependencies.len())
                .ok_or(CampaignPolicyError::Overflow)?;
            if !text(&n.node_id)
                || !ids.insert(&n.node_id)
                || !text(&n.status)
                || !n.status.is_ascii()
                || !timestamp(n.created_at_unix_ms)
                || edges > 32768
                || n.dependencies.iter().any(|id| !text(id))
                || n.child_session_id.as_ref().is_some_and(|id| !text(id))
            {
                return Err(CampaignPolicyError::Contract);
            }
        }
        for e in &self.events {
            if !text(&e.kind)
                || !timestamp(e.at_unix_ms)
                || e.node_id.as_ref().is_some_and(|id| !text(id))
            {
                return Err(CampaignPolicyError::Contract);
            }
        }
        for t in &self.telemetry_samples {
            if t.phases.keys().any(|k| !PHASES.contains(&k.as_str()))
                || t.phases
                    .values()
                    .copied()
                    .chain(t.lock_wait_ms)
                    .chain(t.queue_contention_count)
                    .any(|v| !v.is_finite() || v < 0.0 || v > MAX_SAFE as f64)
            {
                return Err(CampaignPolicyError::Contract);
            }
        }
        Ok(())
    }
}
/// Return the incumbent report structure and production-compatible report hash.
/// Missing time samples remain insufficient data, never fabricated zero latency.
pub fn build_campaign_slo_report_v1(
    r: &CampaignSloRequestV1,
) -> Result<Value, CampaignPolicyError> {
    r.validate()?;
    let mut events = BTreeMap::<&str, Vec<&SloEventViewV1>>::new();
    let mut completed = BTreeMap::<&str, Option<u64>>::new();
    for e in &r.events {
        if let Some(id) = e.node_id.as_deref() {
            events.entry(id).or_default().push(e);
            // Preserve incumbent LAST INPUT occurrence, not maximum completion time.
            if e.kind == "campaign_node_completed" {
                completed.insert(id, e.at_unix_ms);
            }
        }
    }
    let (mut waits, mut recovery) = (Vec::new(), Vec::new());
    for n in &r.nodes {
        let mut timeline: Vec<_> = events
            .get(n.node_id.as_str())
            .into_iter()
            .flatten()
            .copied()
            .filter(|e| e.at_unix_ms.is_some())
            .collect();
        timeline.sort_by_key(|e| e.at_unix_ms);
        let dep_times: Vec<_> = n
            .dependencies
            .iter()
            .filter_map(|d| completed.get(d.as_str()).copied().flatten())
            .collect();
        let ready = if !dep_times.is_empty() && dep_times.len() == n.dependencies.len() {
            dep_times.into_iter().max()
        } else {
            n.created_at_unix_ms
        };
        if let Some(started) = timeline
            .iter()
            .find(|e| e.kind == "campaign_node_started")
            .and_then(|e| e.at_unix_ms)
            && let Some(ready) = ready
            && started >= ready
        {
            waits.push((started - ready) as f64);
        }
        // Reverse scan finds the first following start for every retry in O(E).
        let mut next_start = None;
        for e in timeline.into_iter().rev() {
            if retry(&e.kind)
                && let (Some(started), Some(at)) = (next_start, e.at_unix_ms)
            {
                recovery.push((started - at) as f64);
            }
            if e.kind == "campaign_node_started" {
                next_start = e.at_unix_ms;
            }
        }
    }
    let terminals = r
        .nodes
        .iter()
        .filter(|n| matches!(n.status.as_str(), "completed" | "failed_terminal"))
        .count();
    let successes = r.nodes.iter().filter(|n| n.status == "completed").count();
    let success_rate = (terminals > 0).then(|| successes as f64 / terminals as f64);
    let lock: Vec<_> = r
        .telemetry_samples
        .iter()
        .filter_map(|t| t.lock_wait_ms)
        .collect();
    let contention: Vec<_> = r
        .telemetry_samples
        .iter()
        .filter_map(|t| t.queue_contention_count)
        .collect();
    let mut phases = BTreeMap::new();
    for phase in PHASES {
        let values: Vec<_> = r
            .telemetry_samples
            .iter()
            .filter_map(|t| t.phases.get(phase).copied())
            .collect();
        phases.insert(phase, percentile(&values, 95));
    }
    let unknown_cost = r.campaigns.iter().filter(|c| !c.cost_known).count();
    let wait95 = percentile(&waits, 95);
    let recovery95 = percentile(&recovery, 95);
    let observed = json!({"campaignCounts":count(r.campaigns.iter().map(|c|c.status.clone())),"nodeCounts":count(r.nodes.iter().map(|n|n.status.clone())),
        "terminalNodeSuccessRate":success_rate,"queueWaitP50Ms":percentile(&waits,50),"queueWaitP95Ms":wait95,"recoveryP50Ms":percentile(&recovery,50),"recoveryP95Ms":recovery95,
        "sampleCounts":{"queueWait":waits.len(),"recovery":recovery.len(),"telemetry":r.telemetry_samples.len(),"lockWait":lock.len(),"queueContention":contention.len()},
        "phaseTimingP95Ms":phases,"lockWaitP95Ms":percentile(&lock,95),"lockWaitHistogram":histogram(&lock,&[0,1,5,10,50,100,500,1000]),
        "queueContentionHistogram":histogram(&contention,&[0,1,2,5,10]),
        "retryEventCount":r.events.iter().filter(|e|matches!(e.kind.as_str(),"campaign_node_retry_queued"|"campaign_node_manually_retried")).count(),
        "uniqueChildSessionCount":r.nodes.iter().filter_map(|n|n.child_session_id.as_ref()).collect::<BTreeSet<_>>().len(),
        "totalAgentCalls":sum(r.campaigns.iter().map(|c|c.agent_call_count))?,"totalCpuJobs":sum(r.campaigns.iter().map(|c|c.cpu_job_count))?,
        "totalGpuJobs":sum(r.campaigns.iter().map(|c|c.gpu_job_count))?,"totalTokens":sum(r.campaigns.iter().map(|c|c.token_count))?,
        "unknownCostCampaignCount":unknown_cost,"runtimeBytes":r.runtime_bytes});
    let objectives = BTreeMap::from([
        (
            "terminalNodeSuccessRate",
            success_rate.is_some_and(|v| v >= r.targets.minimum_terminal_node_success_rate),
        ),
        (
            "queueWaitP95",
            wait95.is_some_and(|v| v <= r.targets.maximum_queue_wait_p95_ms as f64),
        ),
        (
            "recoveryP95",
            recovery95.is_some_and(|v| v <= r.targets.maximum_recovery_p95_ms as f64),
        ),
        (
            "runtimeQuota",
            r.runtime_bytes <= r.targets.maximum_runtime_bytes,
        ),
        ("costsAuditable", unknown_cost == 0),
    ]);
    let states: BTreeMap<_, _> = objectives
        .iter()
        .map(|(&key, &met)| {
            let absent = match key {
                "terminalNodeSuccessRate" => success_rate.is_none(),
                "queueWaitP95" => wait95.is_none(),
                "recoveryP95" => recovery95.is_none(),
                _ => false,
            };
            (
                key,
                if absent {
                    "insufficient_data"
                } else if met {
                    "met"
                } else {
                    "not_met"
                },
            )
        })
        .collect();
    let mut report = json!({"version":2,"kind":"CampaignSloReport","status":if objectives.values().all(|v|*v){"campaign_slos_met"}else{"campaign_slos_not_met"},
        "targets":r.targets,"observed":observed,"objectives":objectives,"objectiveStates":states});
    let hash = production_hash_record_v1("CampaignSloReport", &report)
        .map_err(|_| CampaignPolicyError::Collation)?;
    report["campaignSloReportHash"] = json!(hash.as_str());
    Ok(report)
}
