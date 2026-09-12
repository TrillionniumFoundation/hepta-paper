//! Explicit local amendments, including a bounded structural review/revision
//! round. No model invocation or independent scientific acceptance is implied.
use super::*;
use hepta_campaign_writer::WriterLeaseV1;
/// Storage contract; the service additionally checks the typed definition,
/// unchanged committed prefix, registry, pending dispatch and repair policy.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LocalWorkflowChangeV1 {
    pub operation_id: String,
    pub request_hash: Sha256Digest,
    pub previous_definition_hash: Sha256Digest,
    pub definition_hash: Sha256Digest,
    pub definition_json: String,
    pub expected_revision: u64,
    pub committed_steps: u64,
    pub additional_budget_microusd: u64,
    pub previous_lease: WriterLeaseV1,
    pub next_lease: WriterLeaseV1,
    pub repair_rejected_review: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AppliedLocalWorkflowChangeV1 {
    pub version: u16,
    pub campaign_id: String,
    pub ordinal: u64,
    pub applied_revision: u64,
    pub recorded_at_unix_ms: u64,
    pub change: LocalWorkflowChangeV1,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowAmendmentV1 {
    pub version: u16,
    pub operation_id: String,
    pub expected_revision: u64,
    /// Ordinary changes append. Repair replaces ONLY the uncommitted suffix.
    pub steps: Vec<WorkflowStepV1>,
    pub additional_budget_microusd: u64,
    /// Absolute expiry; generation and token cannot be changed here.
    pub lease_expires_at_unix_ms: u64,
    pub repair_rejected_review: bool,
}

/// Bounded public response. Never expose private workflow JSON or lease tokens.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowAmendmentReceiptV1 {
    pub version: u16,
    pub operation_id: String,
    pub request_hash: Sha256Digest,
    pub previous_definition_hash: Sha256Digest,
    pub definition_hash: Sha256Digest,
    pub applied_revision: u64,
    pub committed_steps: u64,
    pub recorded_at_unix_ms: u64,
    pub production_activation: bool,
    pub scientific_acceptance: bool,
    pub node_retirement_verified: bool,
}
fn receipt(record: &AppliedLocalWorkflowChangeV1) -> WorkflowAmendmentReceiptV1 {
    WorkflowAmendmentReceiptV1 {
        version: 1,
        operation_id: record.change.operation_id.clone(),
        request_hash: record.change.request_hash.clone(),
        previous_definition_hash: record.change.previous_definition_hash.clone(),
        definition_hash: record.change.definition_hash.clone(),
        applied_revision: record.applied_revision,
        committed_steps: record.change.committed_steps,
        recorded_at_unix_ms: record.recorded_at_unix_ms,
        production_activation: false,
        scientific_acceptance: false,
        node_retirement_verified: false,
    }
}

fn repair_contract(
    old: &LocalWorkflowV1,
    next: &LocalWorkflowV1,
    committed: usize,
) -> Result<(), WorkflowError> {
    if committed == 0 || next.steps.len() < committed + 2 {
        return Err(WorkflowError::Definition);
    }
    let rejected = &old.steps[committed - 1];
    let author = &next.steps[committed];
    let reviewer = &next.steps[committed + 1];
    let original_gate = rejected.gate.as_ref().ok_or(WorkflowError::Definition)?;
    let review_gate = reviewer.gate.as_ref().ok_or(WorkflowError::Definition)?;
    // This V1 repair contract is deliberately limited to the known native
    // structural reviewer. A general process/model reviewer needs a new contract.
    if !matches!(
        old.template.workers.get(&rejected.module_id),
        Some(WorkerBindingV1::Native)
    ) || !matches!(
        old.template.workers.get(&author.module_id),
        Some(WorkerBindingV1::Native)
    ) || reviewer.module_id != rejected.module_id
        || rejected.capability_id != "CAP-REVIEW"
        || reviewer.capability_id != "CAP-REVIEW"
        || author.capability_id != "CAP-AUTHOR"
        || author.gate.is_some()
        || author.job_template.pointer("/kind").and_then(Value::as_str) != Some("business")
        || author
            .job_template
            .pointer("/job/kind")
            .and_then(Value::as_str)
            != Some("author_draft")
        || rejected
            .job_template
            .pointer("/job/kind")
            .and_then(Value::as_str)
            != Some("reviewer_assessment")
        || reviewer
            .job_template
            .pointer("/job/kind")
            .and_then(Value::as_str)
            != Some("reviewer_assessment")
        || reviewer.job_template.pointer("/job/policy")
            != rejected.job_template.pointer("/job/policy")
        || original_gate.accepted_pointer != "/accepted"
        || original_gate.subject_hash_pointer != "/manuscriptHash"
        || review_gate.accepted_pointer != "/accepted"
        || review_gate.subject_hash_pointer != "/manuscriptHash"
        || review_gate.subject_step != author.id
        || review_gate.subject_artifact_index != 0
        || reviewer.bindings.len() != 1
    {
        return Err(WorkflowError::Definition);
    }
    let binding = &reviewer.bindings[0];
    if binding.from_step != author.id
        || binding.artifact_index != 0
        || binding.target_pointer != "/job/manuscript"
        || !matches!(binding.encoding, ArtifactEncodingV1::Utf8)
    {
        return Err(WorkflowError::Definition);
    }
    // Remaining actions may reference historical scientific results, but cannot
    // reuse the rejected author/reviewer products in a later delivery package.
    for step in &next.steps[committed + 2..] {
        if step
            .bindings
            .iter()
            .any(|b| b.from_step == original_gate.subject_step || b.from_step == rejected.id)
        {
            return Err(WorkflowError::Definition);
        }
    }
    Ok(())
}

pub(super) fn validate_transition(
    old: &LocalWorkflowV1,
    record: &AppliedLocalWorkflowChangeV1,
) -> Result<LocalWorkflowV1, WorkflowError> {
    let c = &record.change;
    let next: LocalWorkflowV1 =
        serde_json::from_str(&c.definition_json).map_err(|_| WorkflowError::History)?;
    next.validate()?;
    let count = usize::try_from(c.committed_steps).map_err(|_| WorkflowError::History)?;
    if hash(old)? != c.previous_definition_hash
        || hash(&next)? != c.definition_hash
        || next.template.snapshot.campaign_id != record.campaign_id
        || old.template.writer_lease != c.previous_lease
        || next.template.writer_lease != c.next_lease
        || count > old.steps.len()
        || next.steps.len() < count
        || bytes(&old.steps[..count])? != bytes(&next.steps[..count])?
    {
        return Err(WorkflowError::History);
    }
    let mut expected_template = old.template.clone();
    expected_template.snapshot.budget_microusd = expected_template
        .snapshot
        .budget_microusd
        .checked_add(c.additional_budget_microusd)
        .ok_or(WorkflowError::Definition)?;
    expected_template.writer_lease = c.next_lease.clone();
    expected_template.frontier.snapshot_hash = expected_template
        .snapshot
        .snapshot_hash()
        .map_err(|_| WorkflowError::Definition)?;
    if bytes(&expected_template)? != bytes(&next.template)? {
        return Err(WorkflowError::History);
    }
    if c.repair_rejected_review {
        repair_contract(old, &next, count)?;
    } else if next.steps.len() < old.steps.len()
        || bytes(&next.steps[..old.steps.len()])? != bytes(&old.steps)?
    {
        return Err(WorkflowError::History);
    }
    Ok(next)
}

#[allow(clippy::too_many_arguments)]
pub(super) fn apply_history_change(
    versions: &[LocalWorkflowV1],
    changes: &[AppliedLocalWorkflowChangeV1],
    applied: &mut usize,
    index: usize,
    budget: &mut u64,
    rejected: bool,
    repair_end: &mut Option<usize>,
) -> Result<(), WorkflowError> {
    let record = &changes[*applied];
    if record.change.committed_steps != index as u64 {
        return Err(WorkflowError::History);
    }
    if record.change.repair_rejected_review {
        if !rejected || repair_end.is_some_and(|end| index < end) {
            return Err(WorkflowError::History);
        }
        *repair_end = Some(index + 2);
    } else if rejected {
        return Err(WorkflowError::History);
    }
    *budget = budget
        .checked_add(record.change.additional_budget_microusd)
        .ok_or(WorkflowError::History)?;
    *applied += 1;
    if *applied >= versions.len() {
        return Err(WorkflowError::History);
    }
    Ok(())
}

/// Modify only explicitly local, quiescent workflow metadata. The original
/// workflow.json stays immutable; authoritative amendments reside in SQLite.
/// Expired leases cannot be revived, terminal campaigns cannot reopen, pending
/// intents cannot be relabelled, and previously committed steps cannot change.
pub fn amend_local_workflow_v1(
    root: &Path,
    expected_definition: &Sha256Digest,
    request: WorkflowAmendmentV1,
    now: u64,
) -> Result<WorkflowAmendmentReceiptV1, WorkflowError> {
    if request.version != 1 || !identifier(&request.operation_id) || request.steps.len() > MAX_STEPS
    {
        return Err(WorkflowError::Definition);
    }
    bytes(&request)?;
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
    let request_hash = hash(&(expected_definition, &request))?;
    if let Some(record) = observed
        .changes
        .iter()
        .find(|r| r.change.operation_id == request.operation_id)
    {
        if record.change.request_hash != request_hash {
            return Err(WorkflowError::Conflict);
        }
        return Ok(receipt(record));
    }
    let active = &observed.active_definition;
    if hash(active)? != *expected_definition
        || request.expected_revision != observed.campaign.revision
        || matches!(
            observed.campaign.state,
            CampaignStateV1::Cancelled | CampaignStateV1::Completed
        )
        || now < observed.clock_floor
        || now >= active.template.writer_lease.expires_at_unix_ms
        || request.lease_expires_at_unix_ms < active.template.writer_lease.expires_at_unix_ms
        || request.lease_expires_at_unix_ms > i64::MAX as u64
    {
        return Err(WorkflowError::Conflict);
    }
    if plan_path(root, observed.results.len()).exists() {
        return Err(WorkflowError::Reconciliation);
    }
    if request.repair_rejected_review != observed.rejected {
        return Err(WorkflowError::GateRejected);
    }
    let mut next = active.clone();
    if request.repair_rejected_review {
        next.steps.truncate(observed.results.len());
    }
    next.steps.extend(request.steps);
    next.template.snapshot.budget_microusd = next
        .template
        .snapshot
        .budget_microusd
        .checked_add(request.additional_budget_microusd)
        .filter(|v| *v <= i64::MAX as u64)
        .ok_or(WorkflowError::Definition)?;
    next.template.frontier.snapshot_hash = next
        .template
        .snapshot
        .snapshot_hash()
        .map_err(|_| WorkflowError::Definition)?;
    next.template.writer_lease.expires_at_unix_ms = request.lease_expires_at_unix_ms;
    next.validate()?;
    let change = LocalWorkflowChangeV1 {
        operation_id: request.operation_id,
        request_hash,
        previous_definition_hash: expected_definition.clone(),
        definition_hash: hash(&next)?,
        definition_json: String::from_utf8(bytes(&next)?).map_err(|_| WorkflowError::Definition)?,
        expected_revision: observed.campaign.revision,
        committed_steps: observed.results.len() as u64,
        additional_budget_microusd: request.additional_budget_microusd,
        previous_lease: active.template.writer_lease.clone(),
        next_lease: next.template.writer_lease.clone(),
        repair_rejected_review: request.repair_rejected_review,
    };
    if change.definition_hash == change.previous_definition_hash {
        return Err(WorkflowError::Definition);
    }
    let proposal = AppliedLocalWorkflowChangeV1 {
        version: 1,
        campaign_id: active.template.snapshot.campaign_id.clone(),
        ordinal: observed.changes.len() as u64 + 1,
        applied_revision: observed
            .campaign
            .revision
            .checked_add(1)
            .ok_or(WorkflowError::History)?,
        recorded_at_unix_ms: now,
        change: change.clone(),
    };
    validate_transition(active, &proposal)?;
    let mut store = CampaignWriterStoreV1::open_local(
        root.join("campaign.sqlite"),
        CampaignWriterPolicyV1::strict(owner),
    )
    .map_err(|_| WorkflowError::History)?;
    let encoded = serde_json::to_string(&change).map_err(|_| WorkflowError::Definition)?;
    let applied = store
        .apply_local_workflow_change(&proposal.campaign_id, &encoded, now)
        .map_err(|_| WorkflowError::Conflict)?;
    let applied: AppliedLocalWorkflowChangeV1 =
        serde_json::from_str(&applied).map_err(|_| WorkflowError::History)?;
    Ok(receipt(&applied))
}
