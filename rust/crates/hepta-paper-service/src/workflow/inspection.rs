//! Local operational read models over the existing workflow history and event chain.
use super::*;
use hepta_campaign_writer::{LocalEventCursorV1, LocalEventPageV1};

/// Closed query envelope. No query accepts SQL, filesystem globs or raw log paths.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
pub enum WorkflowInspectionRequestV1 {
    Events {
        cursor: Option<LocalEventCursorV1>,
        limit: u16,
    },
    Logs {
        offset: usize,
        limit: u16,
    },
    Slo {},
}

/// Log projection of an actual committed result, not worker stdout or model text.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowCommitLogV1 {
    pub step_index: usize,
    pub step_id: String,
    pub result_hash: Sha256Digest,
    pub committed_state_hash: Sha256Digest,
    pub artifact_hashes: Vec<Sha256Digest>,
    pub actual_cost_microusd: u64,
}

/// Source-level operational counters, not measured production latency/availability.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowCountersV1 {
    pub committed_steps: usize,
    pub remaining_steps: usize,
    pub spent_microusd: u64,
    pub budget_remaining_microusd: u64,
    pub pending_step: bool,
    pub gate_rejected: bool,
    pub amendment_count: usize,
    pub production_slo_qualified: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum WorkflowInspectionDataV1 {
    Events {
        page: LocalEventPageV1,
    },
    Logs {
        entries: Vec<WorkflowCommitLogV1>,
        next_offset: Option<usize>,
    },
    Slo {
        counters: WorkflowCountersV1,
    },
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowInspectionV1 {
    pub version: u16,
    pub definition_hash: Sha256Digest,
    pub campaign_id: String,
    pub campaign_revision: u64,
    pub campaign_state: CampaignStateV1,
    pub data: WorkflowInspectionDataV1,
    pub production_activation: bool,
    pub node_retirement_verified: bool,
}

/// Only caller-selected roots; never walk a host looking for workflows.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowReferenceV1 {
    pub state_directory: PathBuf,
    pub definition_hash: Sha256Digest,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowListRequestV1 {
    pub version: u16,
    pub workflows: Vec<WorkflowReferenceV1>,
}

/// Entries preserve request order and omit host paths and writer tokens. Each
/// store is consistent separately; there is no cross-database snapshot claim.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowListV1 {
    pub version: u16,
    pub entries: Vec<WorkflowInspectionV1>,
    pub atomic_across_workflows: bool,
}

/// Validate original definition, every amendment, result and actual CAS byte
/// before returning read models. This acquires no writer lease and writes no
/// campaign state; SQLite may coordinate existing WAL readers.
pub fn inspect_local_workflow_v1(
    root: &Path,
    expected_definition: &Sha256Digest,
    request: WorkflowInspectionRequestV1,
) -> Result<WorkflowInspectionV1, WorkflowError> {
    match &request {
        WorkflowInspectionRequestV1::Events { limit, .. }
        | WorkflowInspectionRequestV1::Logs { limit, .. }
            if !(1..=256).contains(limit) =>
        {
            return Err(WorkflowError::Definition);
        }
        WorkflowInspectionRequestV1::Logs { offset, .. } if *offset > MAX_STEPS => {
            return Err(WorkflowError::Definition);
        }
        _ => (),
    }
    let owner = private_root(root)?;
    let _guard = lock(root, owner)?;
    let original: LocalWorkflowV1 =
        serde_json::from_slice(&read_record(&root.join("workflow.json"), owner)?)
            .map_err(|_| WorkflowError::Definition)?;
    original.validate()?;
    if original.template.state_directory != root {
        return Err(WorkflowError::Definition);
    }
    private_root(&root.join("objects"))?;
    private_root(&root.join("attempts"))?;
    let objects = ObjectStoreV1::open(root)?;
    let observed = history(&original, owner, &objects)?;
    let definition = &observed.active_definition;
    if &hash(definition)? != expected_definition {
        return Err(WorkflowError::Definition);
    }
    let data = match request {
        WorkflowInspectionRequestV1::Events { cursor, limit } => WorkflowInspectionDataV1::Events {
            page: CampaignWriterStoreV1::read_local_event_page(
                root.join("campaign.sqlite"),
                CampaignWriterPolicyV1::strict(owner),
                &observed.campaign.campaign_id,
                cursor.as_ref(),
                limit,
            )
            .map_err(|_| WorkflowError::History)?,
        },
        WorkflowInspectionRequestV1::Logs { offset, limit } => {
            if offset > observed.results.len() {
                return Err(WorkflowError::Definition);
            }
            let end = offset
                .saturating_add(usize::from(limit))
                .min(observed.results.len());
            let entries = (offset..end)
                .map(|index| {
                    let result = &observed.results[index];
                    let receipt = &observed.receipts[index];
                    Ok(WorkflowCommitLogV1 {
                        step_index: index,
                        step_id: definition.steps[index].id.clone(),
                        result_hash: receipt.result_hash.clone(),
                        committed_state_hash: receipt.committed_state_hash.clone(),
                        artifact_hashes: result.artifact_hashes.clone(),
                        actual_cost_microusd: result.actual_cost_microusd,
                    })
                })
                .collect::<Result<Vec<_>, WorkflowError>>()?;
            WorkflowInspectionDataV1::Logs {
                entries,
                next_offset: (end < observed.results.len()).then_some(end),
            }
        }
        WorkflowInspectionRequestV1::Slo {} => {
            let progress = progress(definition, expected_definition.clone(), &observed);
            let spent = observed
                .results
                .iter()
                .try_fold(0u64, |sum, result| {
                    sum.checked_add(result.actual_cost_microusd)
                })
                .ok_or(WorkflowError::History)?;
            WorkflowInspectionDataV1::Slo {
                counters: WorkflowCountersV1 {
                    committed_steps: progress.committed_steps,
                    remaining_steps: progress.total_steps - progress.committed_steps,
                    spent_microusd: spent,
                    budget_remaining_microusd: progress.budget_remaining_microusd,
                    pending_step: progress.pending_step,
                    gate_rejected: progress.gate_rejected,
                    amendment_count: progress.amendment_count,
                    production_slo_qualified: false,
                },
            }
        }
    };
    Ok(WorkflowInspectionV1 {
        version: 1,
        definition_hash: expected_definition.clone(),
        campaign_id: observed.campaign.campaign_id,
        campaign_revision: observed.campaign.revision,
        campaign_state: observed.campaign.state,
        data,
        production_activation: false,
        node_retirement_verified: false,
    })
}

/// A bounded inventory over explicit roots, without another persistent registry.
/// A bad, busy, duplicated or stale entry rejects the entire response.
pub fn list_local_workflows_v1(
    request: WorkflowListRequestV1,
) -> Result<WorkflowListV1, WorkflowError> {
    if request.version != 1 || request.workflows.is_empty() || request.workflows.len() > 128 {
        return Err(WorkflowError::Definition);
    }
    let mut seen = BTreeSet::new();
    for reference in &request.workflows {
        if !seen.insert(&reference.state_directory) {
            return Err(WorkflowError::Definition);
        }
    }
    let entries = request
        .workflows
        .iter()
        .map(|reference| {
            inspect_local_workflow_v1(
                &reference.state_directory,
                &reference.definition_hash,
                WorkflowInspectionRequestV1::Slo {},
            )
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(WorkflowListV1 {
        version: 1,
        entries,
        atomic_across_workflows: false,
    })
}
