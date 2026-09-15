//! Replay the existing workflow history at a distinct physical snapshot path.
//! Logical configuration hashes always retain the original directory binding.
use super::*;
use hepta_campaign_writer::LocalRecoverySeedV1;

pub(crate) struct RecoveryFacts {
    pub definition: LocalWorkflowV1,
    pub all_definitions: Vec<LocalWorkflowV1>,
    pub definition_hash: Sha256Digest,
    pub campaign: CampaignSnapshotV1,
    pub committed_steps: usize,
    pub event_count: usize,
    pub clock_floor: u64,
    pub rejected: bool,
    pub result_hashes: BTreeSet<Sha256Digest>,
    pub pending: Option<PendingPreparedFacts>,
    pub receipts: Vec<CommitReceiptV1>,
}

pub(crate) struct PendingPreparedFacts {
    pub config: ServiceRunV1,
    pub result: PreparedResultV1,
}

pub(crate) fn prepared_recovery_facts_at(
    physical: &Path,
    logical: &Path,
    owner: u32,
    objects: &ObjectStoreV1,
    expected_definition: &Sha256Digest,
) -> Result<RecoveryFacts, WorkflowError> {
    recovery_facts_impl(physical, logical, owner, objects, expected_definition, true)
}

pub(crate) fn recovery_facts_at(
    physical: &Path,
    logical: &Path,
    owner: u32,
    objects: &ObjectStoreV1,
    expected_definition: &Sha256Digest,
) -> Result<RecoveryFacts, WorkflowError> {
    recovery_facts_impl(
        physical,
        logical,
        owner,
        objects,
        expected_definition,
        false,
    )
}

fn recovery_facts_impl(
    physical: &Path,
    logical: &Path,
    owner: u32,
    objects: &ObjectStoreV1,
    expected_definition: &Sha256Digest,
    allow_prepared: bool,
) -> Result<RecoveryFacts, WorkflowError> {
    let original: LocalWorkflowV1 =
        serde_json::from_slice(&read_record(&physical.join("workflow.json"), owner)?)
            .map_err(|_| WorkflowError::Definition)?;
    original.validate()?;
    let t = &original.template;
    if t.state_directory != logical {
        return Err(WorkflowError::Definition);
    }
    let snapshot = CampaignWriterStoreV1::read_immutable_local_recovery(
        &physical.join("campaign.sqlite"),
        CampaignWriterPolicyV1::strict(owner),
        &LocalRecoverySeedV1 {
            campaign_id: t.snapshot.campaign_id.clone(),
            budget_microusd: t.snapshot.budget_microusd,
            cpu_units: t.snapshot.resource_limit.cpu_millis,
            gpu_units: t.snapshot.resource_limit.gpu_millis,
            created_at_unix_ms: t.observed_at_unix_ms,
            writer_lease: t.writer_lease.clone(),
        },
    )
    .map_err(|_| WorkflowError::History)?;
    let event_count = snapshot.event_count;
    let persisted_lease = snapshot.writer_lease;
    let history = history_from_snapshot(
        &original,
        owner,
        objects,
        physical,
        (
            snapshot.campaign,
            snapshot.log,
            snapshot.clock_floor,
            snapshot.changes,
        ),
    )?;
    let mut all_definitions = vec![original.clone()];
    for change in &history.changes {
        all_definitions.push(
            serde_json::from_str(&change.change.definition_json)
                .map_err(|_| WorkflowError::History)?,
        );
    }
    let active = history.active_definition;
    let definition_hash = hash(&active)?;
    if &definition_hash != expected_definition
        || persisted_lease != active.template.writer_lease
        || (history.campaign.state == CampaignStateV1::Completed
            && (history.results.len() != active.steps.len() || history.rejected))
    {
        return Err(WorkflowError::History);
    }
    let mut expected_plans = BTreeSet::new();
    let mut expected_attempts = BTreeSet::new();
    let mut result_hashes = BTreeSet::new();
    for (index, result) in history.results.iter().enumerate() {
        expected_plans.insert(format!("step-{index:04}.json"));
        let config: ServiceRunV1 =
            serde_json::from_slice(&read_record(&plan_path(physical, index), owner)?)
                .map_err(|_| WorkflowError::History)?;
        let candidate = config
            .frontier
            .candidates
            .first()
            .ok_or(WorkflowError::History)?;
        let binding = config
            .workers
            .get(&candidate.module_id)
            .ok_or(WorkflowError::History)?;
        let identity = canonical_hash_v1(&(
            "hepta-service-attempt-v1",
            1u16,
            &result.attempt_id,
            &result.snapshot_hash,
            &result.plan_hash,
            candidate,
            &config.snapshot.campaign_id,
            candidate.resources,
            binding,
        ))
        .map_err(|_| WorkflowError::History)?;
        let raw = identity
            .as_str()
            .strip_prefix("sha256:")
            .ok_or(WorkflowError::History)?;
        let started = format!("{raw}.started");
        let prepared = format!("{raw}.prepared");
        if read_record(&physical.join("attempts").join(&started), owner)?
            != identity.as_str().as_bytes()
        {
            return Err(WorkflowError::History);
        }
        let saved: PreparedResultV1 = serde_json::from_slice(&read_record(
            &physical.join("attempts").join(&prepared),
            owner,
        )?)
        .map_err(|_| WorkflowError::History)?;
        if &saved != result {
            return Err(WorkflowError::History);
        }
        expected_attempts.insert(started);
        expected_attempts.insert(prepared);
        result_hashes.insert(candidate.payload_hash.clone());
        result_hashes.extend(result.artifact_hashes.iter().cloned());
        result_hashes.insert(result.evidence_hash.clone());
    }
    // Uncommitted plans, unmatched dispatch intent, extra prepared records and
    // cancellation residue are not silently declared recovered or collected.
    let mut plans = BTreeSet::new();
    for entry in fs::read_dir(physical).map_err(|_| WorkflowError::Filesystem)? {
        let name = entry.map_err(|_| WorkflowError::Filesystem)?.file_name();
        if let Some(name) = name.to_str()
            && name.starts_with("step-")
        {
            plans.insert(name.to_owned());
        }
    }
    let attempts = fs::read_dir(physical.join("attempts"))
        .map_err(|_| WorkflowError::Filesystem)?
        .map(|entry| {
            entry
                .map_err(|_| WorkflowError::Filesystem)
                .and_then(|entry| {
                    entry
                        .file_name()
                        .into_string()
                        .map_err(|_| WorkflowError::Filesystem)
                })
        })
        .collect::<Result<BTreeSet<_>, _>>()?;
    let mut pending = None;
    let index = history.results.len();
    if allow_prepared && plans.contains(&format!("step-{index:04}.json")) {
        if index >= active.steps.len()
            || history.campaign.state != CampaignStateV1::Running
            || history.rejected
            || active
                .template
                .workers
                .values()
                .any(|w| !matches!(w, WorkerBindingV1::Native))
        {
            return Err(WorkflowError::Reconciliation);
        }
        let config: ServiceRunV1 =
            serde_json::from_slice(&read_record(&plan_path(physical, index), owner)?)
                .map_err(|_| WorkflowError::History)?;
        let job = payload(&active, index, &history.results, objects)?;
        if !matches!(job, NativeJobV1::Business { .. }) {
            return Err(WorkflowError::Reconciliation);
        }
        let prior = history.receipts.last().map_or_else(
            || t.initial_state_hash.clone(),
            |r| r.committed_state_hash.clone(),
        );
        let expected = configuration(
            &active,
            index,
            job,
            history
                .campaign
                .revision
                .checked_add(1)
                .ok_or(WorkflowError::History)?,
            history.campaign.budget_remaining_microusd,
            prior,
            config.observed_at_unix_ms,
        )?;
        if bytes(&config)? != bytes(&expected)?
            || config.observed_at_unix_ms < history.clock_floor
            || config.observed_at_unix_ms >= active.template.writer_lease.expires_at_unix_ms
        {
            return Err(WorkflowError::Reconciliation);
        }
        let plan = select_plan_v1(
            &config.snapshot,
            &config.frontier,
            &config.hard_policy,
            &config.planner_policy,
        )
        .map_err(|_| WorkflowError::History)?;
        let candidate = config
            .frontier
            .candidates
            .first()
            .ok_or(WorkflowError::History)?;
        let attempt_id = format!("{}:attempt:1", plan.plan_hash.as_str());
        let snapshot_hash = config
            .snapshot
            .snapshot_hash()
            .map_err(|_| WorkflowError::History)?;
        let identity = canonical_hash_v1(&(
            "hepta-service-attempt-v1",
            1u16,
            &attempt_id,
            &snapshot_hash,
            &plan.plan_hash,
            candidate,
            &config.snapshot.campaign_id,
            candidate.resources,
            config
                .workers
                .get(&candidate.module_id)
                .ok_or(WorkflowError::History)?,
        ))
        .map_err(|_| WorkflowError::History)?;
        let raw = identity
            .as_str()
            .strip_prefix("sha256:")
            .ok_or(WorkflowError::History)?;
        let started = format!("{raw}.started");
        let prepared = format!("{raw}.prepared");
        if read_record(&physical.join("attempts").join(&started), owner)?
            != identity.as_str().as_bytes()
        {
            return Err(WorkflowError::Reconciliation);
        }
        let result: PreparedResultV1 = serde_json::from_slice(&read_record(
            &physical.join("attempts").join(&prepared),
            owner,
        )?)
        .map_err(|_| WorkflowError::Reconciliation)?;
        result
            .validate(candidate, &plan.plan_hash)
            .map_err(|_| WorkflowError::Reconciliation)?;
        if result.attempt_id != attempt_id
            || result.snapshot_hash != snapshot_hash
            || result.status != hepta_module_platform::PreparedResultStatusV1::Prepared
            || result.external_action_may_have_started
        {
            return Err(WorkflowError::Reconciliation);
        }
        objects.read(&candidate.payload_hash)?;
        for digest in result
            .artifact_hashes
            .iter()
            .chain(std::iter::once(&result.evidence_hash))
        {
            objects.read(digest)?;
        }
        expected_plans.insert(format!("step-{index:04}.json"));
        expected_attempts.insert(started);
        expected_attempts.insert(prepared);
        pending = Some(PendingPreparedFacts { config, result });
    }
    if plans != expected_plans || attempts != expected_attempts {
        return Err(WorkflowError::Reconciliation);
    }
    Ok(RecoveryFacts {
        definition: active,
        all_definitions,
        definition_hash,
        campaign: history.campaign,
        committed_steps: history.results.len(),
        event_count,
        clock_floor: history.clock_floor,
        rejected: history.rejected,
        result_hashes,
        pending,
        receipts: history.receipts,
    })
}
