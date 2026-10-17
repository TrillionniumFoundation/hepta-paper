//! Native port of the Node campaign decision and resource-estimation functions.
//!
//! Decisions are pure projections over a closed, bounded record view. They never
//! cancel a process, change a lease, dispatch work, mutate campaign state or grant
//! authority. Number coercion from strings/booleans and malformed records are not
//! in this supported compatibility domain. The original Node oracle is test-only.
use hepta_legacy_compatibility::ProductionCollationV1;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet, VecDeque};
use thiserror::Error;

/// Incumbent node completion semantics; cancellation is not completion.
pub const CAMPAIGN_NODE_DONE_STATUSES_V1: [&str; 2] = ["completed", "skipped"];
/// Terminal campaigns cannot be reopened by a normal resume command.
pub const CAMPAIGN_TERMINAL_STATUSES_V1: [&str; 3] = ["completed", "failed", "cancelled"];
/// Stopped is settled for observation, but is separately resumable by policy.
pub const CAMPAIGN_SETTLED_STATUSES_V1: [&str; 4] = ["completed", "failed", "cancelled", "stopped"];

const MAX_NODES: usize = 4096;
const MAX_EDGES: usize = 32768;
const MAX_SAFE: u64 = 9_007_199_254_740_991;

/// Minimal record view; callers must explicitly project fuller legacy records.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CampaignNodeViewV1 {
    pub node_id: String,
    pub kind: String,
    pub status: String,
    #[serde(default)]
    pub priority: Option<i64>,
    #[serde(default)]
    pub created_at: Option<String>,
    #[serde(default)]
    pub round_index: Option<u64>,
    #[serde(default)]
    pub dependencies: Vec<String>,
    #[serde(default)]
    pub attempt_count: Option<u64>,
    #[serde(default)]
    pub max_attempts: Option<u64>,
    #[serde(default)]
    pub prepared_integration_status: Option<String>,
    #[serde(default)]
    pub requires_gpu: bool,
}

/// Benchmark selector projection, not data-access authorization.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BenchmarkBudgetViewV1 {
    pub selector_type: String,
    pub seed_count: u64,
    pub minimum_repetitions: u64,
}

/// Closed request envelope shared by the native CLI and library.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum CampaignPolicyRequestV1 {
    Constants {},
    Slo {
        request: super::campaign_slo::CampaignSloRequestV1,
    },
    Projection {
        nodes: Vec<CampaignNodeViewV1>,
    },
    Ready {
        nodes: Vec<CampaignNodeViewV1>,
        limit: u32,
    },
    Failure {
        node: CampaignNodeViewV1,
        retryable: bool,
    },
    Descendants {
        nodes: Vec<CampaignNodeViewV1>,
        root_node_id: String,
    },
    FutureRound {
        nodes: Vec<CampaignNodeViewV1>,
        after_round: u64,
    },
    Command {
        campaign_status: String,
        command: String,
    },
    ManualRetry {
        node: CampaignNodeViewV1,
    },
    ResourceBudget {
        nodes: Vec<CampaignNodeViewV1>,
        selector: Option<BenchmarkBudgetViewV1>,
    },
    EmpiricalProfiles {
        languages: Vec<String>,
        requires_gpu: bool,
        exclude_lean: bool,
    },
}

#[derive(Clone, Debug, Eq, Error, PartialEq)]
pub enum CampaignPolicyError {
    #[error("campaign decision input is outside the bounded record contract")]
    Contract,
    #[error("campaign decision numeric bound exceeded")]
    Overflow,
    #[error("qualified production collation is unavailable")]
    Collation,
}

fn text(value: &str) -> bool {
    !value.is_empty() && value.len() <= 256 && !value.chars().any(char::is_control)
}
fn validate(nodes: &[CampaignNodeViewV1]) -> Result<(), CampaignPolicyError> {
    if nodes.len() > MAX_NODES {
        return Err(CampaignPolicyError::Contract);
    }
    let mut ids = BTreeSet::new();
    let mut edges = 0usize;
    for node in nodes {
        edges = edges
            .checked_add(node.dependencies.len())
            .ok_or(CampaignPolicyError::Overflow)?;
        if !text(&node.node_id)
            || !text(&node.kind)
            || !text(&node.status)
            || !ids.insert(node.node_id.as_str())
            || edges > MAX_EDGES
            || node.dependencies.iter().any(|id| !text(id))
            || node
                .created_at
                .as_ref()
                .is_some_and(|s| s.len() > 256 || s.chars().any(char::is_control))
            || node
                .prepared_integration_status
                .as_ref()
                .is_some_and(|s| !text(s))
            || node.priority.is_some_and(|p| p.unsigned_abs() > MAX_SAFE)
            || [node.round_index, node.attempt_count, node.max_attempts]
                .into_iter()
                .flatten()
                .any(|n| n > MAX_SAFE)
        {
            return Err(CampaignPolicyError::Contract);
        }
    }
    Ok(())
}
fn done(status: &str) -> bool {
    CAMPAIGN_NODE_DONE_STATUSES_V1.contains(&status)
}
fn terminal(status: &str) -> bool {
    CAMPAIGN_TERMINAL_STATUSES_V1.contains(&status)
}
fn terminal_kind(kind: &str) -> bool {
    matches!(
        kind,
        "final-compile" | "research-verify" | "package" | "release-package"
    )
}
fn ordered(nodes: &[CampaignNodeViewV1]) -> Result<Vec<&CampaignNodeViewV1>, CampaignPolicyError> {
    validate(nodes)?;
    let profile = ProductionCollationV1::load().map_err(|_| CampaignPolicyError::Collation)?;
    let mut out: Vec<_> = nodes.iter().collect();
    // Node uses `priority || 100`, so explicit zero means 100, not first priority.
    let priority = |n: &CampaignNodeViewV1| n.priority.filter(|p| *p != 0).unwrap_or(100);
    out.sort_by(|a, b| {
        priority(a)
            .cmp(&priority(b))
            .then_with(|| {
                profile.compare(
                    a.created_at.as_deref().unwrap_or(""),
                    b.created_at.as_deref().unwrap_or(""),
                )
            })
            .then_with(|| profile.compare(&a.node_id, &b.node_id))
    });
    Ok(out)
}
fn safe_mul(a: u64, b: u64) -> Result<u64, CampaignPolicyError> {
    a.checked_mul(b)
        .filter(|v| *v <= MAX_SAFE)
        .ok_or(CampaignPolicyError::Overflow)
}
fn safe_add(a: u64, b: u64) -> Result<u64, CampaignPolicyError> {
    a.checked_add(b)
        .filter(|v| *v <= MAX_SAFE)
        .ok_or(CampaignPolicyError::Overflow)
}
fn digits(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|c| c.is_ascii_digit())
}
fn agent_kind(kind: &str) -> bool {
    matches!(
        kind,
        "research-plan" | "writer" | "theorem-spec" | "manuscript-integrate" | "revise" | "coder"
    ) || kind.starts_with("coder-")
        || kind.strip_prefix("referee-").is_some_and(digits)
        || kind.strip_prefix("revision-referee-").is_some_and(digits)
}
fn empirical_kind(kind: &str) -> bool {
    let s = kind.strip_prefix("revalidate-").unwrap_or(kind);
    s == "empirical" || s.starts_with("empirical-")
}

/// Evaluate one pure decision. The return value is not an execution receipt.
pub fn evaluate_campaign_policy_v1(
    request: CampaignPolicyRequestV1,
) -> Result<Value, CampaignPolicyError> {
    Ok(match request {
        CampaignPolicyRequestV1::Constants {} => json!({
            "CAMPAIGN_NODE_DONE_STATUSES": CAMPAIGN_NODE_DONE_STATUSES_V1,
            "CAMPAIGN_TERMINAL_STATUSES": CAMPAIGN_TERMINAL_STATUSES_V1,
            "CAMPAIGN_SETTLED_STATUSES": CAMPAIGN_SETTLED_STATUSES_V1,
        }),
        CampaignPolicyRequestV1::Slo { request } => {
            super::campaign_slo::build_campaign_slo_report_v1(&request)?
        }
        CampaignPolicyRequestV1::Projection { nodes } => {
            let ordered = ordered(&nodes)?;
            let failed = ordered.iter().any(|n| n.status == "failed_terminal");
            let completed = !ordered.is_empty() && ordered.iter().all(|n| done(&n.status));
            let active = ordered
                .iter()
                .find(|n| matches!(n.status.as_str(), "running" | "leased"));
            let pending = ordered
                .iter()
                .find(|n| !done(&n.status) && n.status != "failed_terminal");
            let phase = if failed {
                "failed"
            } else if completed {
                "completed"
            } else {
                active.or(pending).map_or("running", |n| n.kind.as_str())
            };
            let round = ordered
                .iter()
                .filter(|n| {
                    !matches!(n.kind.as_str(), "package" | "release-package")
                        && matches!(
                            n.status.as_str(),
                            "leased" | "running" | "completed" | "failed_terminal"
                        )
                })
                .map(|n| n.round_index.unwrap_or(0))
                .max()
                .unwrap_or(0);
            json!({"version":1,"kind":"CampaignOperationalProjection","status":if failed{"failed"}else if completed{"completed"}else{"running"},
                "currentPhase":phase,"currentReviewRound":round,"terminal":failed||completed})
        }
        CampaignPolicyRequestV1::Ready { nodes, limit } => {
            let order = ordered(&nodes)?;
            let by_id: BTreeMap<_, _> = nodes.iter().map(|n| (n.node_id.as_str(), n)).collect();
            let ready: Vec<_> = order
                .iter()
                .filter(|n| {
                    n.status == "queued"
                        && n.dependencies
                            .iter()
                            .all(|id| by_id.get(id.as_str()).is_some_and(|n| done(&n.status)))
                })
                .take(limit.max(1) as usize)
                .map(|n| &n.node_id)
                .collect();
            json!(ready)
        }
        CampaignPolicyRequestV1::Failure { node, retryable } => {
            validate(std::slice::from_ref(&node))?;
            let max = node.max_attempts.unwrap_or(3);
            let cap = if node.prepared_integration_status.as_deref() == Some("integrated") {
                safe_add(max, 1)?
            } else {
                max
            };
            let retry = retryable && node.attempt_count.unwrap_or(0) < cap;
            json!({"status":if retry{"queued"}else{"failed_terminal"},"canRetry":retry,
                "eventKind":if retry{"campaign_node_retry_queued"}else{"campaign_node_failed_terminal"}})
        }
        CampaignPolicyRequestV1::Descendants {
            nodes,
            root_node_id,
        } => {
            validate(&nodes)?;
            if !text(&root_node_id) {
                return Err(CampaignPolicyError::Contract);
            }
            let mut children: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
            for n in &nodes {
                for p in &n.dependencies {
                    children.entry(p).or_default().push(&n.node_id);
                }
            }
            let mut found = BTreeSet::from([root_node_id.as_str()]);
            let mut queue = VecDeque::from([root_node_id.as_str()]);
            while let Some(p) = queue.pop_front() {
                if let Some(next) = children.get(p) {
                    for &id in next {
                        if found.insert(id) {
                            queue.push_back(id);
                        }
                    }
                }
            }
            // Array.sort() here is UTF-16 lexical, unlike the localeCompare above.
            let mut out: Vec<_> = found.into_iter().collect();
            out.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
            json!(out)
        }
        CampaignPolicyRequestV1::FutureRound { nodes, after_round } => {
            validate(&nodes)?;
            if after_round > MAX_SAFE {
                return Err(CampaignPolicyError::Contract);
            }
            let mut out: Vec<_> = nodes
                .iter()
                .filter(|n| {
                    n.round_index.unwrap_or(0) > after_round
                        && !terminal_kind(&n.kind)
                        && n.status == "queued"
                })
                .map(|n| &n.node_id)
                .collect();
            out.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
            json!(out)
        }
        CampaignPolicyRequestV1::Command {
            campaign_status,
            command,
        } => {
            if !text(&campaign_status) {
                return Err(CampaignPolicyError::Contract);
            }
            let (apply, next) = match command.as_str() {
                "pause" => (campaign_status == "running", "paused"),
                "resume" => (
                    matches!(campaign_status.as_str(), "paused" | "stopped"),
                    "running",
                ),
                "cancel" => (!terminal(&campaign_status), "cancelled"),
                "fail" => (!terminal(&campaign_status), "failed"),
                "stop" => (
                    !terminal(&campaign_status) && campaign_status != "stopped",
                    "stopped",
                ),
                _ => return Err(CampaignPolicyError::Contract),
            };
            json!({"apply":apply,"nextStatus":next})
        }
        CampaignPolicyRequestV1::ManualRetry { node } => {
            validate(std::slice::from_ref(&node))?;
            json!({"apply":node.status=="failed_terminal","nextStatus":"queued"})
        }
        CampaignPolicyRequestV1::ResourceBudget { nodes, selector } => {
            validate(&nodes)?;
            let processes = match selector {
                None => 0,
                Some(s) => {
                    if !text(&s.selector_type)
                        || s.seed_count > MAX_SAFE
                        || s.minimum_repetitions > MAX_SAFE
                    {
                        return Err(CampaignPolicyError::Contract);
                    }
                    if s.selector_type == "authorized_dataset_mount" {
                        safe_mul(safe_mul(s.seed_count, s.minimum_repetitions)?, 3)?
                    } else {
                        3
                    }
                }
            };
            let (mut agent, mut cpu, mut gpu) = (0, 0, 0);
            for n in nodes {
                let attempts = n.max_attempts.unwrap_or(1).max(1);
                if agent_kind(&n.kind) {
                    agent = safe_add(agent, attempts)?;
                }
                if n.kind == "formal-verify" {
                    agent = safe_add(agent, safe_mul(6, attempts)?)?;
                }
                if empirical_kind(&n.kind) {
                    let jobs = safe_mul(
                        safe_mul(processes, attempts)?,
                        if n.kind.contains("reproduce") { 2 } else { 3 },
                    )?;
                    cpu = safe_add(cpu, jobs)?;
                    if n.requires_gpu {
                        gpu = safe_add(gpu, jobs)?;
                    }
                }
            }
            json!({"agentCalls":agent,"benchmarkJobs":{"cpu":cpu,"gpu":gpu}})
        }
        CampaignPolicyRequestV1::EmpiricalProfiles {
            languages,
            requires_gpu,
            exclude_lean,
        } => {
            if languages.len() > 64 || languages.iter().any(|l| !text(l)) {
                return Err(CampaignPolicyError::Contract);
            }
            json!(languages.iter().filter(|l|l.as_str()!="latex"&&(!exclude_lean||l.as_str()!="lean"))
                .map(|l|json!({"label":l,"language":if l=="gpu"{"python"}else{l.as_str()},"requiresGpu":l=="gpu"||(requires_gpu&&l=="python")})).collect::<Vec<_>>())
        }
    })
}
