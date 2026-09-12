//! Local/shadow multi-step workflow over the existing single SQLite writer.
//!
//! Immutable step configurations are recovery inputs, never a second result
//! ledger. Progress and lifecycle come from the campaign database. Process
//! workers are trusted local code, not a security sandbox or live-model grant.

use crate::{
    NativeJobV1, ObjectStoreV1, ServiceError, ServiceRunV1, WorkerBindingV1, run_service_v1,
};
use hepta_campaign_writer::{
    CampaignSnapshotV1, CampaignStateV1, CampaignWriterPolicyV1, CampaignWriterStoreV1,
};
use hepta_codex_protocol::Sha256Digest;
use hepta_control_plane::{
    CommitReceiptV1, PlanningFrontierV1, SqliteCommitSequencerV1, canonical_hash_v1,
    replay_control_log_v1, select_plan_v1,
};
use hepta_module_platform::{
    ActionCandidateV1, ModuleRegistryArtifactV1, PreparedResultV1, QualificationTierV1,
    ResourceVectorV1,
};
use nix::fcntl::{Flock, FlockArg, OFlag};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
};
use thiserror::Error;

const MAX_BYTES: usize = 16 * 1024 * 1024;
const MAX_STEPS: usize = 128;

/// A frozen sequential/topologically ordered workflow, not a production permit.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LocalWorkflowV1 {
    pub version: u16,
    /// Initial local service configuration with an empty frontier.
    pub template: ServiceRunV1,
    pub steps: Vec<WorkflowStepV1>,
}

/// Input bindings use artifact order in the canonical PreparedResult, not worker
/// output order. A producer may export a JSON manifest to name multiple outputs.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArtifactBindingV1 {
    pub from_step: String,
    pub artifact_index: usize,
    pub target_pointer: String,
    pub encoding: ArtifactEncodingV1,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ArtifactEncodingV1 {
    Utf8,
    Json,
    Digest,
}

/// A routing gate bound to the exact reviewed bytes. A boolean is NOT scientific
/// acceptance, authenticated reviewer identity, release or submission authority.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowGateV1 {
    pub accepted_pointer: String,
    pub subject_step: String,
    pub subject_artifact_index: usize,
    pub subject_hash_pointer: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowStepV1 {
    pub id: String,
    pub module_id: String,
    pub capability_id: String,
    pub resources: ResourceVectorV1,
    pub cost_microusd: u64,
    /// A NativeJobV1 JSON template; only explicitly bound leaves are replaced.
    pub job_template: Value,
    pub bindings: Vec<ArtifactBindingV1>,
    pub gate: Option<WorkflowGateV1>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
pub enum WorkflowActionV1 {
    /// Read-only database/CAS inspection, including after lease expiry.
    Status,
    /// An absolute end position makes response-loss retries unable to run extra
    /// steps. Raising through_steps is a new explicit operation, not a retry.
    Advance {
        through_steps: usize,
    },
    Pause {
        expected_revision: u64,
    },
    Resume {
        expected_revision: u64,
    },
    Cancel {
        expected_revision: u64,
    },
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowProgressV1 {
    pub definition_hash: Sha256Digest,
    pub campaign_state: CampaignStateV1,
    pub campaign_revision: u64,
    pub committed_steps: usize,
    pub total_steps: usize,
    pub budget_remaining_microusd: u64,
    pub artifacts_by_step: BTreeMap<String, Vec<Sha256Digest>>,
    pub pending_step: bool,
    pub gate_rejected: bool,
    pub production_activation: bool,
    pub scientific_acceptance: bool,
    pub node_retirement_verified: bool,
}

/// Bounded errors deliberately omit prompts, credentials, output and file paths.
#[derive(Debug, Error)]
pub enum WorkflowError {
    #[error("workflow definition or binding invalid")]
    Definition,
    #[error("workflow filesystem integrity rejected")]
    Filesystem,
    #[error("workflow is busy")]
    Busy,
    #[error("workflow persisted history rejected")]
    History,
    #[error("workflow revision or lifecycle conflict")]
    Conflict,
    #[error("workflow pending execution requires reconciliation")]
    Reconciliation,
    #[error("workflow routing gate rejected")]
    GateRejected,
    #[error("workflow service execution failed")]
    Service(#[from] ServiceError),
}

fn bytes<T: Serialize>(value: &T) -> Result<Vec<u8>, WorkflowError> {
    let value = serde_json::to_vec(value).map_err(|_| WorkflowError::Definition)?;
    if value.len() > MAX_BYTES {
        return Err(WorkflowError::Definition);
    }
    Ok(value)
}
fn hash<T: Serialize>(value: &T) -> Result<Sha256Digest, WorkflowError> {
    canonical_hash_v1(value).map_err(|_| WorkflowError::Definition)
}
fn identifier(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 96
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
}
fn pointer(value: &str) -> bool {
    if !value.starts_with('/') || value.len() > 512 {
        return false;
    }
    value.split('/').skip(1).all(|segment| {
        let decoded = segment.replace("~1", "/").replace("~0", "~");
        decoded.replace('~', "~0").replace('/', "~1") == segment
    })
}

impl LocalWorkflowV1 {
    /// Validate all dependency edges, closed authority fields and cumulative
    /// reservations before creating state. Resource sums are conservative: even
    /// memory is summed rather than claiming measured peak reuse.
    pub fn validate(&self) -> Result<(), WorkflowError> {
        let t = &self.template;
        if self.version != 1
            || t.version != 1
            || t.production_activation
            || t.hard_policy.external_actions_authorized
            || self.steps.is_empty()
            || self.steps.len() > MAX_STEPS
            || !t.frontier.candidates.is_empty()
            || t.snapshot.campaign_revision != 1
            || t.snapshot.state_hash != t.initial_state_hash
            || t.observed_at_unix_ms == 0
            || t.writer_lease.expires_at_unix_ms <= t.observed_at_unix_ms
        {
            return Err(WorkflowError::Definition);
        }
        bytes(self)?;
        let registry = ModuleRegistryArtifactV1::decode_json(
            t.registry_json.as_bytes(),
            &t.hard_policy.registry_policy_hash,
        )
        .map_err(|_| WorkflowError::Definition)?;
        if t.snapshot.registry_hash != *registry.registry_hash()
            || t.snapshot.registry_policy_hash != *registry.policy_hash()
            || t.snapshot.constraint_set_hash
                != t.hard_policy
                    .policy_hash()
                    .map_err(|_| WorkflowError::Definition)?
            || t.frontier.snapshot_hash
                != t.snapshot
                    .snapshot_hash()
                    .map_err(|_| WorkflowError::Definition)?
        {
            return Err(WorkflowError::Definition);
        }
        let mut seen = BTreeSet::new();
        let mut resources = ResourceVectorV1::default();
        let mut cost = 0u64;
        for step in &self.steps {
            if !identifier(&step.id)
                || seen.contains(&step.id)
                || step.bindings.len() > 32
                || step.resources.external_actions != 0
                || step.resources.provider_calls != 0
                || step.resources.central_writer_turns != 0
            {
                return Err(WorkflowError::Definition);
            }
            let module = registry
                .module(&step.module_id)
                .map_err(|_| WorkflowError::Definition)?;
            if !module.manifest.capability_ids.contains(&step.capability_id) {
                return Err(WorkflowError::Definition);
            }
            match t.workers.get(&step.module_id) {
                Some(WorkerBindingV1::Native) => (),
                Some(WorkerBindingV1::Process {
                    network_declared: false,
                    ..
                }) => (),
                _ => return Err(WorkflowError::Definition),
            }
            let job: NativeJobV1 = serde_json::from_value(step.job_template.clone())
                .map_err(|_| WorkflowError::Definition)?;
            if let NativeJobV1::Business { job } = job
                && job.capability_id() != step.capability_id
            {
                return Err(WorkflowError::Definition);
            }
            let mut targets = Vec::<&str>::new();
            for binding in &step.bindings {
                let p = &binding.target_pointer;
                if !seen.contains(&binding.from_step)
                    || binding.artifact_index >= 256
                    || !pointer(p)
                    || !(p.starts_with("/job/")
                        || p.starts_with("/input/")
                        || p.starts_with("/artifacts/"))
                    || p == "/job/kind"
                    || step.job_template.pointer(p).is_none()
                    || targets.iter().any(|old| {
                        *old == p
                            || p.starts_with(&format!("{old}/"))
                            || old.starts_with(&format!("{p}/"))
                    })
                {
                    return Err(WorkflowError::Definition);
                }
                targets.push(p);
            }
            if step.gate.as_ref().is_some_and(|gate| {
                !seen.contains(&gate.subject_step)
                    || gate.subject_artifact_index >= 256
                    || !pointer(&gate.accepted_pointer)
                    || !pointer(&gate.subject_hash_pointer)
            }) {
                return Err(WorkflowError::Definition);
            }
            resources = resources
                .checked_add(step.resources)
                .map_err(|_| WorkflowError::Definition)?;
            cost = cost
                .checked_add(step.cost_microusd)
                .ok_or(WorkflowError::Definition)?;
            seen.insert(step.id.clone());
        }
        if !resources.fits_within(t.snapshot.resource_limit) || cost > t.snapshot.budget_microusd {
            return Err(WorkflowError::Definition);
        }
        Ok(())
    }
}

fn private_root(root: &Path) -> Result<u32, WorkflowError> {
    let metadata = fs::symlink_metadata(root).map_err(|_| WorkflowError::Filesystem)?;
    if !root.is_absolute()
        || !metadata.is_dir()
        || metadata.mode() & 0o077 != 0
        || fs::canonicalize(root).ok().as_deref() != Some(root)
    {
        return Err(WorkflowError::Filesystem);
    }
    Ok(metadata.uid())
}
fn read_record(path: &Path, owner: u32) -> Result<Vec<u8>, WorkflowError> {
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags((OFlag::O_NOFOLLOW | OFlag::O_NONBLOCK).bits())
        .open(path)
        .map_err(|_| WorkflowError::Filesystem)?;
    let before = file.metadata().map_err(|_| WorkflowError::Filesystem)?;
    if !before.is_file()
        || before.nlink() != 1
        || before.uid() != owner
        || before.mode() & 0o077 != 0
        || before.len() > MAX_BYTES as u64
    {
        return Err(WorkflowError::Filesystem);
    }
    let mut data = Vec::new();
    Read::by_ref(&mut file)
        .take(MAX_BYTES as u64 + 1)
        .read_to_end(&mut data)
        .map_err(|_| WorkflowError::Filesystem)?;
    let after = file.metadata().map_err(|_| WorkflowError::Filesystem)?;
    let named = fs::symlink_metadata(path).map_err(|_| WorkflowError::Filesystem)?;
    if data.len() as u64 != before.len()
        || before.ino() != named.ino()
        || before.dev() != named.dev()
        || before.ctime() != after.ctime()
        || before.ctime_nsec() != after.ctime_nsec()
        || before.mtime() != after.mtime()
        || before.mtime_nsec() != after.mtime_nsec()
    {
        return Err(WorkflowError::Filesystem);
    }
    Ok(data)
}
fn write_record(path: &Path, data: &[u8]) -> Result<(), WorkflowError> {
    if data.len() > MAX_BYTES {
        return Err(WorkflowError::Definition);
    }
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags((OFlag::O_NOFOLLOW | OFlag::O_NONBLOCK).bits())
        .open(path)
        .map_err(|_| WorkflowError::Filesystem)?;
    file.write_all(data)
        .and_then(|()| file.sync_all())
        .map_err(|_| WorkflowError::Filesystem)?;
    File::open(path.parent().ok_or(WorkflowError::Filesystem)?)
        .and_then(|f| f.sync_all())
        .map_err(|_| WorkflowError::Filesystem)
}
fn lock(root: &Path, owner: u32) -> Result<Flock<File>, WorkflowError> {
    let path = root.join("workflow.lock");
    read_record(&path, owner)?;
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .custom_flags((OFlag::O_NOFOLLOW | OFlag::O_NONBLOCK).bits())
        .open(&path)
        .map_err(|_| WorkflowError::Filesystem)?;
    let guard =
        Flock::lock(file, FlockArg::LockExclusiveNonblock).map_err(|_| WorkflowError::Busy)?;
    let opened = guard.metadata().map_err(|_| WorkflowError::Filesystem)?;
    let named = fs::symlink_metadata(path).map_err(|_| WorkflowError::Filesystem)?;
    if opened.ino() != named.ino()
        || opened.dev() != named.dev()
        || opened.nlink() != 1
        || opened.uid() != owner
        || opened.mode() & 0o077 != 0
    {
        return Err(WorkflowError::Filesystem);
    }
    Ok(guard)
}
fn plan_path(root: &Path, index: usize) -> PathBuf {
    root.join(format!("step-{index:04}.json"))
}

/// Initialize only an absent private directory. A partial initialization is a
/// retained orphan for operator reconciliation, never silently adopted.
pub fn initialize_local_workflow_v1(
    definition: LocalWorkflowV1,
) -> Result<Sha256Digest, WorkflowError> {
    definition.validate()?;
    let t = &definition.template;
    let root = &t.state_directory;
    if !root.is_absolute() || root.exists() {
        return Err(WorkflowError::Filesystem);
    }
    fs::DirBuilder::new()
        .mode(0o700)
        .create(root)
        .map_err(|_| WorkflowError::Filesystem)?;
    let owner = private_root(root)?;
    ObjectStoreV1::open(root)?;
    write_record(&root.join("workflow.lock"), b"")?;
    let mut store = CampaignWriterStoreV1::create_local(
        root.join("campaign.sqlite"),
        CampaignWriterPolicyV1::strict(owner),
    )
    .map_err(|_| WorkflowError::History)?;
    let writer = store
        .acquire_writer(t.writer_lease.clone(), t.observed_at_unix_ms)
        .map_err(|_| WorkflowError::History)?;
    store
        .create_campaign(
            &writer,
            &t.snapshot.campaign_id,
            t.snapshot.budget_microusd,
            t.snapshot.resource_limit.cpu_millis,
            t.snapshot.resource_limit.gpu_millis,
            t.observed_at_unix_ms,
        )
        .map_err(|_| WorkflowError::History)?;
    let sequencer = SqliteCommitSequencerV1::new(
        store,
        writer,
        t.snapshot.campaign_id.clone(),
        t.initial_state_hash.clone(),
        t.verifier_hash.clone(),
        t.observed_at_unix_ms,
    )
    .map_err(|_| WorkflowError::History)?;
    drop(sequencer);
    write_record(&root.join("workflow.json"), &bytes(&definition)?)?;
    hash(&definition)
}

fn payload(
    definition: &LocalWorkflowV1,
    index: usize,
    results: &[PreparedResultV1],
    objects: &ObjectStoreV1,
) -> Result<NativeJobV1, WorkflowError> {
    let step = &definition.steps[index];
    let mut value = step.job_template.clone();
    for binding in &step.bindings {
        let source = definition.steps[..index]
            .iter()
            .position(|s| s.id == binding.from_step)
            .ok_or(WorkflowError::Definition)?;
        let digest = results
            .get(source)
            .and_then(|r| r.artifact_hashes.get(binding.artifact_index))
            .ok_or(WorkflowError::History)?;
        let data = objects.read(digest)?;
        let replacement = match binding.encoding {
            ArtifactEncodingV1::Utf8 => {
                Value::String(String::from_utf8(data).map_err(|_| WorkflowError::Definition)?)
            }
            ArtifactEncodingV1::Json => {
                serde_json::from_slice(&data).map_err(|_| WorkflowError::Definition)?
            }
            ArtifactEncodingV1::Digest => Value::String(digest.to_string()),
        };
        *value
            .pointer_mut(&binding.target_pointer)
            .ok_or(WorkflowError::Definition)? = replacement;
        bytes(&value)?;
    }
    let job: NativeJobV1 = serde_json::from_value(value).map_err(|_| WorkflowError::Definition)?;
    match (&definition.template.workers[&step.module_id], &job) {
        (WorkerBindingV1::Native, NativeJobV1::Business { job })
            if job.capability_id() == step.capability_id =>
        {
            ()
        }
        (
            WorkerBindingV1::Native,
            NativeJobV1::ArtifactInventory { .. } | NativeJobV1::InspectNodeDatabase { .. },
        ) => (),
        (WorkerBindingV1::Process { .. }, NativeJobV1::Process { .. }) => (),
        _ => return Err(WorkflowError::Definition),
    }
    Ok(job)
}

#[allow(clippy::too_many_arguments)]
fn configuration(
    definition: &LocalWorkflowV1,
    index: usize,
    job: NativeJobV1,
    revision: u64,
    budget: u64,
    prior: Sha256Digest,
    now: u64,
) -> Result<ServiceRunV1, WorkflowError> {
    let step = &definition.steps[index];
    let mut config = definition.template.clone();
    config.observed_at_unix_ms = now;
    config.snapshot.campaign_revision = revision;
    config.snapshot.budget_microusd = budget;
    config.snapshot.state_hash = prior;
    config.snapshot.required_capability_ids = BTreeSet::from([step.capability_id.clone()]);
    let registry = ModuleRegistryArtifactV1::decode_json(
        config.registry_json.as_bytes(),
        &config.hard_policy.registry_policy_hash,
    )
    .map_err(|_| WorkflowError::Definition)?;
    let snapshot_hash = config
        .snapshot
        .snapshot_hash()
        .map_err(|_| WorkflowError::Definition)?;
    config.frontier = PlanningFrontierV1 {
        version: 1,
        snapshot_hash: snapshot_hash.clone(),
        candidates: vec![ActionCandidateV1 {
            version: 1,
            candidate_id: step.id.clone(),
            decision_group: step.id.clone(),
            module_id: step.module_id.clone(),
            module_version: registry
                .module(&step.module_id)
                .map_err(|_| WorkflowError::Definition)?
                .manifest
                .module_version
                .clone(),
            capability_id: step.capability_id.clone(),
            snapshot_hash,
            dependency_candidate_ids: vec![],
            resources: step.resources,
            utility_micros: 1,
            cost_microusd: step.cost_microusd,
            uncertainty_ppm: 0,
            evidence_tier: QualificationTierV1::Source,
            payload_hash: format!("sha256:{}", hex::encode(Sha256::digest(bytes(&job)?)))
                .parse()
                .map_err(|_| WorkflowError::Definition)?,
        }],
    };
    Ok(config)
}

fn gate_passes(
    definition: &LocalWorkflowV1,
    index: usize,
    results: &[PreparedResultV1],
    objects: &ObjectStoreV1,
) -> Result<bool, WorkflowError> {
    let Some(gate) = &definition.steps[index].gate else {
        return Ok(true);
    };
    let result = results.get(index).ok_or(WorkflowError::History)?;
    if result.artifact_hashes.len() != 1 {
        return Err(WorkflowError::History);
    }
    let value: Value = serde_json::from_slice(&objects.read(&result.artifact_hashes[0])?)
        .map_err(|_| WorkflowError::History)?;
    let source = definition.steps[..index]
        .iter()
        .position(|s| s.id == gate.subject_step)
        .ok_or(WorkflowError::Definition)?;
    let subject = results
        .get(source)
        .and_then(|r| r.artifact_hashes.get(gate.subject_artifact_index))
        .ok_or(WorkflowError::History)?;
    if value
        .pointer(&gate.subject_hash_pointer)
        .and_then(Value::as_str)
        != Some(subject.as_str())
    {
        return Err(WorkflowError::History);
    }
    value
        .pointer(&gate.accepted_pointer)
        .and_then(Value::as_bool)
        .ok_or(WorkflowError::History)
}

struct History {
    campaign: CampaignSnapshotV1,
    results: Vec<PreparedResultV1>,
    receipts: Vec<CommitReceiptV1>,
    rejected: bool,
    clock_floor: u64,
}
fn history(
    definition: &LocalWorkflowV1,
    owner: u32,
    objects: &ObjectStoreV1,
) -> Result<History, WorkflowError> {
    let t = &definition.template;
    let (campaign, log, clock_floor) = CampaignWriterStoreV1::read_local_control_snapshot(
        t.state_directory.join("campaign.sqlite"),
        CampaignWriterPolicyV1::strict(owner),
        &t.snapshot.campaign_id,
    )
    .map_err(|_| WorkflowError::History)?;
    if log.entries.len() > definition.steps.len()
        || log.initial_state_hash != t.initial_state_hash
        || log.verifier_hash != t.verifier_hash
    {
        return Err(WorkflowError::History);
    }
    let receipts = replay_control_log_v1(&log).map_err(|_| WorkflowError::History)?;
    let mut results = Vec::new();
    let mut prior = t.initial_state_hash.clone();
    let mut budget = t.snapshot.budget_microusd;
    let mut rejected = false;
    for (index, entry) in log.entries.iter().enumerate() {
        if rejected {
            return Err(WorkflowError::History);
        }
        let saved: ServiceRunV1 =
            serde_json::from_slice(&read_record(&plan_path(&t.state_directory, index), owner)?)
                .map_err(|_| WorkflowError::History)?;
        let job = payload(definition, index, &results, objects)?;
        // A missing payload is corruption. Read-only status never recreates it.
        objects.read(
            &saved
                .frontier
                .candidates
                .first()
                .ok_or(WorkflowError::History)?
                .payload_hash,
        )?;
        let expected = configuration(
            definition,
            index,
            job,
            saved.snapshot.campaign_revision,
            budget,
            prior,
            saved.observed_at_unix_ms,
        )?;
        if bytes(&saved)? != bytes(&expected)?
            || saved.snapshot.campaign_revision > campaign.revision
        {
            return Err(WorkflowError::History);
        }
        let plan = select_plan_v1(
            &saved.snapshot,
            &saved.frontier,
            &saved.hard_policy,
            &saved.planner_policy,
        )
        .map_err(|_| WorkflowError::History)?;
        let result: PreparedResultV1 =
            serde_json::from_str(&entry.result_json).map_err(|_| WorkflowError::History)?;
        result
            .validate(&saved.frontier.candidates[0], &plan.plan_hash)
            .map_err(|_| WorkflowError::History)?;
        for digest in result
            .artifact_hashes
            .iter()
            .chain(std::iter::once(&result.evidence_hash))
        {
            objects.read(digest)?;
        }
        budget = budget
            .checked_sub(result.actual_cost_microusd)
            .ok_or(WorkflowError::History)?;
        prior = receipts[index].committed_state_hash.clone();
        results.push(result);
        rejected = !gate_passes(definition, index, &results, objects)?;
    }
    if campaign.budget_remaining_microusd != budget {
        return Err(WorkflowError::History);
    }
    Ok(History {
        campaign,
        results,
        receipts,
        rejected,
        clock_floor,
    })
}

fn progress(
    definition: &LocalWorkflowV1,
    definition_hash: Sha256Digest,
    history: &History,
) -> WorkflowProgressV1 {
    WorkflowProgressV1 {
        definition_hash,
        campaign_state: history.campaign.state,
        campaign_revision: history.campaign.revision,
        committed_steps: history.results.len(),
        total_steps: definition.steps.len(),
        budget_remaining_microusd: history.campaign.budget_remaining_microusd,
        artifacts_by_step: definition
            .steps
            .iter()
            .zip(&history.results)
            .map(|(s, r)| (s.id.clone(), r.artifact_hashes.clone()))
            .collect(),
        pending_step: plan_path(&definition.template.state_directory, history.results.len())
            .exists(),
        gate_rejected: history.rejected,
        production_activation: false,
        scientific_acceptance: false,
        node_retirement_verified: false,
    }
}
fn set_state(
    definition: &LocalWorkflowV1,
    owner: u32,
    expected: u64,
    next: CampaignStateV1,
    now: u64,
) -> Result<(), WorkflowError> {
    let t = &definition.template;
    let mut store = CampaignWriterStoreV1::open_local(
        t.state_directory.join("campaign.sqlite"),
        CampaignWriterPolicyV1::strict(owner),
    )
    .map_err(|_| WorkflowError::History)?;
    let writer = store
        .acquire_writer(t.writer_lease.clone(), now)
        .map_err(|_| WorkflowError::Conflict)?;
    store
        .set_campaign_state(&writer, &t.snapshot.campaign_id, expected, next, now)
        .map_err(|_| WorkflowError::Conflict)?;
    Ok(())
}

/// Execute a bounded local operation. Cooperative callers share a nonblocking
/// lock. Cancellation is between steps; this API never promises in-flight kill.
/// All actual results/lifecycle transitions use the existing fenced writer.
pub fn operate_local_workflow_v1(
    root: &Path,
    expected_definition: &Sha256Digest,
    action: WorkflowActionV1,
    now: u64,
) -> Result<WorkflowProgressV1, WorkflowError> {
    let owner = private_root(root)?;
    let _guard = lock(root, owner)?;
    let definition: LocalWorkflowV1 =
        serde_json::from_slice(&read_record(&root.join("workflow.json"), owner)?)
            .map_err(|_| WorkflowError::Definition)?;
    definition.validate()?;
    if &hash(&definition)? != expected_definition || definition.template.state_directory != root {
        return Err(WorkflowError::Definition);
    }
    // Existing child directories must exist. Status does not initialize/repair them.
    private_root(&root.join("objects"))?;
    private_root(&root.join("attempts"))?;
    let objects = ObjectStoreV1::open(root)?;
    let mut observed = history(&definition, owner, &objects)?;
    if !matches!(action, WorkflowActionV1::Status)
        && (now < observed.clock_floor
            || now >= definition.template.writer_lease.expires_at_unix_ms)
    {
        return Err(WorkflowError::Conflict);
    }
    match action {
        WorkflowActionV1::Status => (),
        WorkflowActionV1::Advance { through_steps } => {
            if through_steps == 0 || through_steps > definition.steps.len() {
                return Err(WorkflowError::Definition);
            }
            if observed.rejected {
                return Err(WorkflowError::GateRejected);
            }
            while observed.results.len() < through_steps {
                if observed.campaign.state != CampaignStateV1::Running {
                    return Err(WorkflowError::Conflict);
                }
                let index = observed.results.len();
                let path = plan_path(root, index);
                let job = payload(&definition, index, &observed.results, &objects)?;
                objects.put(&bytes(&job)?)?;
                let prior = observed.receipts.last().map_or_else(
                    || definition.template.initial_state_hash.clone(),
                    |r| r.committed_state_hash.clone(),
                );
                let mut config = configuration(
                    &definition,
                    index,
                    job,
                    observed
                        .campaign
                        .revision
                        .checked_add(1)
                        .ok_or(WorkflowError::History)?,
                    observed.campaign.budget_remaining_microusd,
                    prior,
                    now,
                )?;
                if path.exists() {
                    let saved: ServiceRunV1 = serde_json::from_slice(&read_record(&path, owner)?)
                        .map_err(|_| WorkflowError::History)?;
                    // Clock observation may advance on retry; the frozen plan,
                    // writer identity, input and resource reservation may not.
                    config.observed_at_unix_ms = saved.observed_at_unix_ms;
                    if bytes(&config)? != bytes(&saved)? {
                        return Err(WorkflowError::Reconciliation);
                    }
                } else {
                    write_record(&path, &bytes(&config)?)?;
                }
                config.observed_at_unix_ms = now;
                run_service_v1(config)?;
                observed = history(&definition, owner, &objects)?;
                if observed.results.len() != index + 1 {
                    return Err(WorkflowError::History);
                }
                if observed.rejected {
                    return Err(WorkflowError::GateRejected);
                }
            }
            if observed.results.len() == definition.steps.len()
                && observed.campaign.state == CampaignStateV1::Running
            {
                set_state(
                    &definition,
                    owner,
                    observed.campaign.revision,
                    CampaignStateV1::Completed,
                    now,
                )?;
            }
        }
        WorkflowActionV1::Pause { expected_revision }
        | WorkflowActionV1::Resume { expected_revision }
        | WorkflowActionV1::Cancel { expected_revision } => {
            let next = match action {
                WorkflowActionV1::Pause { .. } => CampaignStateV1::Paused,
                WorkflowActionV1::Resume { .. } => CampaignStateV1::Running,
                _ => CampaignStateV1::Cancelled,
            };
            let current = observed.campaign.state;
            let duplicate = current == next
                && expected_revision.checked_add(1) == Some(observed.campaign.revision);
            if !duplicate {
                if observed.campaign.revision != expected_revision
                    || matches!(
                        current,
                        CampaignStateV1::Cancelled | CampaignStateV1::Completed
                    )
                    || (next == CampaignStateV1::Running && current != CampaignStateV1::Paused)
                    || (next == CampaignStateV1::Paused && current != CampaignStateV1::Running)
                {
                    return Err(WorkflowError::Conflict);
                }
                if next != CampaignStateV1::Cancelled
                    && plan_path(root, observed.results.len()).exists()
                {
                    return Err(WorkflowError::Reconciliation);
                }
                set_state(&definition, owner, expected_revision, next, now)?;
            }
        }
    }
    let observed = history(&definition, owner, &objects)?;
    Ok(progress(
        &definition,
        expected_definition.clone(),
        &observed,
    ))
}
