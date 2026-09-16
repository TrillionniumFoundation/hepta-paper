use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use thiserror::Error;

pub const CAMPAIGN_NODE_DONE_STATUSES_V1: &[&str] = &["completed", "skipped"];
pub const CAMPAIGN_TERMINAL_STATUSES_V1: &[&str] = &["completed", "failed", "cancelled"];
pub const CAMPAIGN_SETTLED_STATUSES_V1: &[&str] = &["completed", "failed", "cancelled", "stopped"];
const CONVERGENCE: &[&str] = &[
    "final-compile",
    "research-verify",
    "package",
    "release-package",
];

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CampaignNodeViewV1 {
    pub node_id: String,
    pub kind: String,
    pub status: String,
    #[serde(default)]
    pub priority: Option<f64>,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub round_index: u64,
    #[serde(default)]
    pub attempt_count: u64,
    #[serde(default)]
    pub max_attempts: u64,
    #[serde(default)]
    pub prepared_integration_status: Option<String>,
    #[serde(default)]
    pub dependencies: Vec<String>,
    #[serde(default)]
    pub requires_gpu: bool,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BenchmarkSelectorV1 {
    pub selector_type: String,
    pub seed_count: u64,
    pub minimum_repetitions: u64,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum CampaignPolicyRequestV1 {
    Constants,
    Projection {
        nodes: Vec<CampaignNodeViewV1>,
    },
    Ready {
        nodes: Vec<CampaignNodeViewV1>,
        limit: u64,
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
        selector: Option<BenchmarkSelectorV1>,
    },
    EmpiricalProfiles {
        languages: Vec<String>,
        requires_gpu: bool,
        exclude_lean: bool,
    },
    Slo {
        request: crate::campaign_slo::CampaignSloRequestV1,
    },
}
#[derive(Debug, Error)]
pub enum CampaignPolicyError {
    #[error("invalid campaign policy request")]
    Invalid,
}
fn order(n: &CampaignNodeViewV1) -> (u64, String, String) {
    let p = n.priority.filter(|x| *x != 0.0).unwrap_or(100.0).max(0.0) as u64;
    (p, n.created_at.clone(), n.node_id.clone())
}
fn done(s: &str) -> bool {
    CAMPAIGN_NODE_DONE_STATUSES_V1.contains(&s)
}
pub fn evaluate_campaign_policy_v1(
    r: CampaignPolicyRequestV1,
) -> Result<Value, CampaignPolicyError> {
    let out=match r {
  CampaignPolicyRequestV1::Constants=>json!({"CAMPAIGN_NODE_DONE_STATUSES":CAMPAIGN_NODE_DONE_STATUSES_V1,"CAMPAIGN_TERMINAL_STATUSES":CAMPAIGN_TERMINAL_STATUSES_V1,"CAMPAIGN_SETTLED_STATUSES":CAMPAIGN_SETTLED_STATUSES_V1}),
  CampaignPolicyRequestV1::Projection{nodes}=>{ let mut n=nodes; n.sort_by_key(order); let failed=n.iter().any(|x|x.status=="failed_terminal"); let completed=!n.is_empty()&&n.iter().all(|x|done(&x.status)); let active=n.iter().find(|x|x.status=="running"||x.status=="leased"); let pending=n.iter().find(|x|!done(&x.status)&&x.status!="failed_terminal"); let round=n.iter().filter(|x|x.round_index>0&&!matches!(x.kind.as_str(),"package"|"release-package")&&matches!(x.status.as_str(),"leased"|"running"|"completed"|"failed_terminal")).map(|x|x.round_index).max().unwrap_or(0); json!({"version":1,"kind":"CampaignOperationalProjection","status":if failed{"failed"}else if completed{"completed"}else{"running"},"currentPhase":if failed{"failed"}else if completed{"completed"}else{active.map(|x|x.kind.as_str()).or_else(||pending.map(|x|x.kind.as_str())).unwrap_or("running")},"currentReviewRound":round,"terminal":failed||completed}) },
  CampaignPolicyRequestV1::Ready{mut nodes,limit}=>{ let map=nodes.iter().map(|n|(n.node_id.clone(),done(&n.status))).collect::<std::collections::HashMap<_,_>>(); nodes.retain(|n|n.status=="queued"&&n.dependencies.iter().all(|d|map.get(d).copied().unwrap_or(false))); nodes.sort_by_key(order); json!(nodes.into_iter().take(limit.max(1) as usize).map(|n|n.node_id).collect::<Vec<_>>()) },
  CampaignPolicyRequestV1::Failure{node,retryable}=>{let max=if node.max_attempts==0{3}else{node.max_attempts};let lim=if node.prepared_integration_status.as_deref()==Some("integrated"){max+1}else{max};let can=retryable&&node.attempt_count<lim;json!({"status":if can{"queued"}else{"failed_terminal"},"canRetry":can,"eventKind":if can{"campaign_node_retry_queued"}else{"campaign_node_failed_terminal"}})},
  CampaignPolicyRequestV1::Descendants{nodes,root_node_id}=>{let mut set=std::collections::BTreeSet::from([root_node_id]);loop{let mut changed=false;for n in &nodes{if !set.contains(&n.node_id)&&n.dependencies.iter().any(|d|set.contains(d)){set.insert(n.node_id.clone());changed=true}}if !changed{break}}json!(set.into_iter().collect::<Vec<_>>())},
  CampaignPolicyRequestV1::FutureRound{nodes,after_round}=>json!(nodes.into_iter().filter(|n|n.round_index>after_round&&!CONVERGENCE.contains(&n.kind.as_str())&&n.status=="queued").map(|n|n.node_id).collect::<std::collections::BTreeSet<_>>().into_iter().collect::<Vec<_>>()),
  CampaignPolicyRequestV1::Command{campaign_status,command}=>{let (apply,next)=match command.as_str(){"pause"=>(campaign_status=="running","paused"),"resume"=>(matches!(campaign_status.as_str(),"paused"|"stopped"),"running"),"cancel"=>(!CAMPAIGN_TERMINAL_STATUSES_V1.contains(&campaign_status.as_str()),"cancelled"),"fail"=>(!CAMPAIGN_TERMINAL_STATUSES_V1.contains(&campaign_status.as_str()),"failed"),"stop"=>(!CAMPAIGN_SETTLED_STATUSES_V1.contains(&campaign_status.as_str()),"stopped"),_=>return Err(CampaignPolicyError::Invalid)};json!({"apply":apply,"nextStatus":next})},
  CampaignPolicyRequestV1::ManualRetry{node}=>json!({"apply":node.status=="failed_terminal","nextStatus":"queued"}),
  CampaignPolicyRequestV1::ResourceBudget{nodes,selector}=>{let agent=nodes.iter().map(|n|{let planned=["research-plan","writer","theorem-spec","manuscript-integrate","revise"].contains(&n.kind.as_str())||n.kind.starts_with("coder-")||n.kind.starts_with("referee-");(if planned{n.max_attempts.max(1)}else{0})+if n.kind=="formal-verify"{6*n.max_attempts.max(1)}else{0}}).sum::<u64>();let mut cpu=0;let mut gpu=0;if let Some(s)=selector{let processes=if s.selector_type=="authorized_dataset_mount"{s.seed_count*s.minimum_repetitions*3}else{3};for n in nodes{if n.kind.starts_with("empirical")||n.kind.starts_with("revalidate-empirical"){let jobs=processes*n.max_attempts.max(1)*if n.kind.contains("reproduce"){2}else{3};cpu+=jobs;if n.requires_gpu{gpu+=jobs}}}}json!({"agentCalls":agent,"benchmarkJobs":{"cpu":cpu,"gpu":gpu}})},
  CampaignPolicyRequestV1::EmpiricalProfiles{languages,requires_gpu,exclude_lean}=>json!(languages.into_iter().filter(|x|x!="latex"&&(!exclude_lean||x!="lean")).map(|label|json!({"label":label,"language":if label=="gpu"{"python"}else{label.as_str()},"requiresGpu":label=="gpu"||(requires_gpu&&label=="python")})).collect::<Vec<_>>()),
  CampaignPolicyRequestV1::Slo{request}=>serde_json::to_value(crate::campaign_slo::build_campaign_slo_report_v1(&request).map_err(|_|CampaignPolicyError::Invalid)?).map_err(|_|CampaignPolicyError::Invalid)?
 };
    Ok(out)
}
