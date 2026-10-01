//! Business-request composition. Broker dispatch, recovery, billing, commit and
//! ACK remain owned by the existing service/workflow, never this adapter.
use super::{AutonomousResearchOptions, local};
use crate::broker_prepared::{
    BrokerPreparedInputV1, BrokerPreparedSourceV1, broker_execution_implementation_hash_v1,
};
use crate::workflow::{
    ArtifactBindingV1, ArtifactEncodingV1, LocalWorkflowV1, WorkflowActionV1, WorkflowAmendmentV1,
    WorkflowError, WorkflowGateV1, WorkflowProgressV1, WorkflowStepV1, operate_local_workflow_v1,
    read_current_local_workflow_v1,
};
use crate::{ResearchWorkflowProfileV1, ServiceRunV1, WorkerBindingV1};
use hepta_campaign_writer::WriterLeaseV1;
use hepta_codex_protocol::{AgentRole, Sha256Digest, TaskKind};
use hepta_control_plane::{
    ControlPlaneSnapshotV1, HardPolicyV1, PlannerPolicyV1, PlanningFrontierV1, canonical_hash_v1,
};
use hepta_module_platform::{
    ActivationStateV1, AuthorityClassV1, ModuleExecutionV1, ModuleGrantV1, ModuleKindV1,
    ModuleManifestV1, ModuleRegistryV1, QualificationTierV1, RegistryPolicyV1, ResourceVectorV1,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    os::unix::fs::MetadataExt,
    path::Path,
    sync::{Arc, atomic::AtomicBool},
};

const AUTHOR: &str = "module.research-author";
const REVIEWER: &str = "module.research-reviewer";
const REQUEST_FILE: &str = "autonomous-research-request.v1.json";

/// Installed role endpoint, output contract and admitted per-attempt bounds.
/// Private provider credentials and completed results are never request inputs.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AutonomousResearchRoleV1 {
    pub source: BrokerPreparedSourceV1,
    pub resources: ResourceVectorV1,
    pub maximum_cost_microusd: u64,
    pub prompt_envelope_hash: Sha256Digest,
    pub output_schema_hash: Sha256Digest,
    pub workspace_identity_hash: Sha256Digest,
    pub mutation_policy_hash: Sha256Digest,
}

/// Ordinary business request, independent of planner/workflow representation.
/// The profile is a non-authorizing expected qualification, never a permit.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AutonomousResearchCampaignRequestV1 {
    pub version: u16,
    pub kind: String,
    pub objective: String,
    pub author: AutonomousResearchRoleV1,
    pub reviewer: AutonomousResearchRoleV1,
    pub review_rubric: String,
    pub revision_instructions: String,
    pub revision_rounds: usize,
    pub budget_microusd: u64,
    pub maximum_wall_ms: u64,
    /// Optional configured lifecycle ceiling. None retains oldV1 typed bytes;
    /// new ordinary local-run requests bind their effective default48 in CAS.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_agent_calls: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub research_profile: Option<ResearchWorkflowProfileV1>,
}

fn hash<T: Serialize>(value: &T) -> Result<Sha256Digest, WorkflowError> {
    canonical_hash_v1(value).map_err(|_| WorkflowError::Definition)
}
pub(super) fn request_subject<'a>(
    campaign: &'a str,
    request: &'a AutonomousResearchCampaignRequestV1,
    configured_request_hash: &'a Sha256Digest,
) -> (
    &'static str,
    &'a str,
    &'a AutonomousResearchCampaignRequestV1,
    &'a Sha256Digest,
) {
    (
        "autonomous-research-campaign-request-v1",
        campaign,
        request,
        configured_request_hash,
    )
}
fn text_valid(text: &str) -> bool {
    !text.trim().is_empty() && text.len() <= 16 * 1024
}
impl AutonomousResearchCampaignRequestV1 {
    fn validate(&self) -> Result<(), WorkflowError> {
        if self.version != 1
            || self.kind != "AutonomousResearchCampaignRequestV1"
            || !text_valid(&self.objective)
            || !text_valid(&self.review_rubric)
            || !text_valid(&self.revision_instructions)
            || self.revision_rounds > 16
            || self.maximum_wall_ms == 0
            || self.maximum_wall_ms > 24 * 60 * 60 * 1000
            || self.budget_microusd == 0
            || self.max_agent_calls == Some(0)
            || self.author.source.role != AgentRole::Author
            || self.reviewer.source.role != AgentRole::Reviewer
            || self.author.source.socket_path == self.reviewer.source.socket_path
            || self.author.source.request_directory == self.reviewer.source.request_directory
        {
            return Err(WorkflowError::Definition);
        }
        for role in [&self.author, &self.reviewer] {
            role.source
                .validate()
                .map_err(|_| WorkflowError::Definition)?;
            if role.source.request_signer.is_none()
                || role.source.cost_settlement.is_none()
                || role.source.commit_acknowledgement.is_none()
                || role.resources.provider_calls != 1
                || role.resources.external_actions != 0
                || role.resources.central_writer_turns != 0
                || role.maximum_cost_microusd == 0
                // Two prior output strings plus bounded instructions must fit
                // the existing 1 MiB broker manifest limit even after JSON escaping.
                || role.source.request_signer.as_ref().is_some_and(|signer| signer.maximum_output_bytes > 64 * 1024)
            {
                return Err(WorkflowError::Definition);
            }
        }
        let maximum = self
            .author
            .maximum_cost_microusd
            .checked_add(self.reviewer.maximum_cost_microusd)
            .and_then(|cost| cost.checked_mul(self.revision_rounds as u64 + 1))
            .ok_or(WorkflowError::Definition)?;
        if maximum > self.budget_microusd {
            return Err(WorkflowError::Definition);
        }
        if let Some(profile) = &self.research_profile
            && (self.author.source.operation_publisher.is_none()
                || self.reviewer.source.operation_publisher.is_none()
                || !profile.is_well_formed()
                || self.author.source.runtime_identity_hash
                    != profile.qualified_codex_runtime_identity_hash
                || self.reviewer.source.runtime_identity_hash
                    != profile.qualified_codex_runtime_identity_hash
                || self.author.source.broker_uid == self.reviewer.source.broker_uid
                || self.author.source.broker_gid == self.reviewer.source.broker_gid)
        {
            return Err(WorkflowError::Qualification);
        }
        Ok(())
    }
}
fn binding(from: &str, field: &str, encoding: ArtifactEncodingV1) -> ArtifactBindingV1 {
    ArtifactBindingV1 {
        from_step: from.into(),
        artifact_index: 0,
        artifact_name: None,
        target_pointer: format!("/input/inputManifest/{field}"),
        encoding,
    }
}
fn job(
    role: &AutonomousResearchRoleV1,
    task_kind: TaskKind,
    manifest: Value,
) -> Result<Value, WorkflowError> {
    serde_json::to_value(crate::NativeJobV1::BrokerExecute {
        input: BrokerPreparedInputV1 {
            version: 1,
            task_kind,
            input_manifest: manifest,
            prompt_envelope_hash: role.prompt_envelope_hash.clone(),
            workspace_identity_hash: role.workspace_identity_hash.clone(),
            mutation_policy_hash: role.mutation_policy_hash.clone(),
            output_schema_hash: role.output_schema_hash.clone(),
        },
    })
    .map_err(|_| WorkflowError::Definition)
}
fn review(
    request: &AutonomousResearchCampaignRequestV1,
    subject: &str,
    ordinal: usize,
) -> Result<WorkflowStepV1, WorkflowError> {
    Ok(WorkflowStepV1 {
        id: format!("review-{ordinal}"),
        module_id: REVIEWER.into(),
        capability_id: "CAP-REVIEW".into(),
        resources: request.reviewer.resources,
        cost_microusd: request.reviewer.maximum_cost_microusd,
        job_template: job(
            &request.reviewer,
            TaskKind::Review,
            json!({"version":1,"kind":"ManuscriptReviewInputV1","manuscript":"","manuscriptHash": hash(&"unbound")?,"policy":{"version":1,"rubric":request.review_rubric}}),
        )?,
        bindings: vec![
            binding(subject, "manuscript", ArtifactEncodingV1::Utf8),
            binding(subject, "manuscriptHash", ArtifactEncodingV1::Digest),
        ],
        gate: Some(WorkflowGateV1 {
            accepted_pointer: "/accepted".into(),
            subject_step: subject.into(),
            subject_artifact_index: 0,
            subject_hash_pointer: "/manuscriptHash".into(),
        }),
    })
}
fn steps(
    request: &AutonomousResearchCampaignRequestV1,
    campaign: &str,
) -> Result<Vec<WorkflowStepV1>, WorkflowError> {
    Ok(vec![
        WorkflowStepV1 {
            id: "author-1".into(),
            module_id: AUTHOR.into(),
            capability_id: "CAP-AUTHOR".into(),
            resources: request.author.resources,
            cost_microusd: request.author.maximum_cost_microusd,
            job_template: job(
                &request.author,
                TaskKind::Draft,
                json!({"version":1,"kind":"ManuscriptDraftInputV1","campaignId":campaign,"objective":request.objective}),
            )?,
            bindings: vec![],
            gate: None,
        },
        review(request, "author-1", 1)?,
    ])
}
fn assemble(
    request: &AutonomousResearchCampaignRequestV1,
    configured_request_hash: &Sha256Digest,
    campaign: &str,
    root: &Path,
    observed: u64,
    lease: WriterLeaseV1,
) -> Result<LocalWorkflowV1, WorkflowError> {
    request.validate()?;
    let initial_state_hash = hash(&request_subject(campaign, request, configured_request_hash))?;
    let qualification = if request.research_profile.is_some() {
        QualificationTierV1::TargetHost
    } else {
        QualificationTierV1::Source
    };
    let activation = request
        .research_profile
        .as_ref()
        .map_or(ActivationStateV1::Shadow, |profile| {
            profile.stage.module_activation()
        });
    let mut builder = ModuleRegistryV1::new(RegistryPolicyV1 {
        version: 1,
        protocol_version: 1,
        central_writer_module_id: "module.campaign-writer".into(),
        grants: [(AUTHOR, "CAP-AUTHOR"), (REVIEWER, "CAP-REVIEW")]
            .into_iter()
            .map(|(module, capability)| {
                (
                    module.into(),
                    ModuleGrantV1 {
                        module_version: "1.0.0".into(),
                        authority: AuthorityClassV1::PreparedResultOnly,
                        minimum_qualification: qualification,
                        activation,
                        capability_ids: [capability.into()].into(),
                    },
                )
            })
            .collect(),
    })
    .map_err(|_| WorkflowError::Definition)?;
    for (module, capability, role) in [
        (AUTHOR, "CAP-AUTHOR", &request.author),
        (REVIEWER, "CAP-REVIEW", &request.reviewer),
    ] {
        builder
            .register(ModuleManifestV1 {
                version: 1,
                module_id: module.into(),
                module_version: "1.0.0".into(),
                protocol_min: 1,
                protocol_max: 1,
                module_kind: ModuleKindV1::TrustedInProcess,
                requested_authority: AuthorityClassV1::PreparedResultOnly,
                qualification,
                requested_activation: activation,
                capability_ids: vec![capability.into()],
                dependencies: vec![],
                primary_owner: "TEAM-RUNTIME".into(),
                secondary_owner: "TEAM-STATE".into(),
                independent_reviewer: "TEAM-EVIDENCE".into(),
                rollback_version: "0.9.0".into(),
                execution: ModuleExecutionV1::InProcess {
                    implementation_hash: broker_execution_implementation_hash_v1(&role.source)
                        .map_err(|_| WorkflowError::Definition)?,
                },
            })
            .map_err(|_| WorkflowError::Definition)?;
    }
    let registry = builder.finish().map_err(|_| WorkflowError::Definition)?;
    let hard_policy = HardPolicyV1 {
        version: 1,
        policy_id: "research-campaign-policy-v1".into(),
        registry_policy_hash: registry.policy_hash().clone(),
        forbidden_module_ids: BTreeSet::new(),
        minimum_evidence_by_capability: [
            ("CAP-AUTHOR".into(), qualification),
            ("CAP-REVIEW".into(), qualification),
        ]
        .into(),
        external_actions_authorized: false,
        maximum_central_writer_turns: 0,
        maximum_candidates_per_decision_group: 1,
    };
    let pair = request
        .author
        .resources
        .checked_add(request.reviewer.resources)
        .map_err(|_| WorkflowError::Definition)?;
    let mut resource_limit = ResourceVectorV1::default();
    for _ in 0..=request.revision_rounds {
        resource_limit = resource_limit
            .checked_add(pair)
            .map_err(|_| WorkflowError::Definition)?;
    }
    let snapshot = ControlPlaneSnapshotV1 {
        version: 1,
        campaign_id: campaign.into(),
        campaign_revision: 1,
        state_hash: initial_state_hash.clone(),
        registry_hash: registry.registry_hash().clone(),
        registry_policy_hash: registry.policy_hash().clone(),
        objective_version: "research-manuscript-v1".into(),
        constraint_set_hash: hard_policy
            .policy_hash()
            .map_err(|_| WorkflowError::Definition)?,
        resource_limit,
        budget_microusd: request.budget_microusd,
        required_capability_ids: ["CAP-AUTHOR".into(), "CAP-REVIEW".into()].into(),
        random_seed: None,
    };
    let frontier = PlanningFrontierV1 {
        version: 1,
        snapshot_hash: snapshot
            .snapshot_hash()
            .map_err(|_| WorkflowError::Definition)?,
        candidates: vec![],
    };
    let definition = LocalWorkflowV1 {
        version: 1,
        provider_call_budget: request.max_agent_calls.map(|maximum_calls| {
            crate::workflow::WorkflowProviderCallBudgetV1 {
                version: 1,
                maximum_calls,
            }
        }),
        research_profile: request.research_profile.clone(),
        steps: steps(request, campaign)?,
        template: ServiceRunV1 {
            version: 1,
            production_activation: false,
            state_directory: root.into(),
            registry_json: serde_json::to_string(&registry)
                .map_err(|_| WorkflowError::Definition)?,
            hard_policy,
            planner_policy: PlannerPolicyV1 {
                version: 1,
                maximum_exact_candidates: 1,
                cost_weight_ppm: 0,
                uncertainty_weight_micros_per_ppm: 0,
                maximum_selected_candidates: 1,
            },
            snapshot,
            frontier,
            verifier_hash: hash(&(
                "research-manuscript-verifier-v1",
                include_str!("campaign.rs"),
            ))?,
            initial_state_hash,
            writer_lease: lease,
            observed_at_unix_ms: observed,
            workers: BTreeMap::from([
                (
                    AUTHOR.into(),
                    WorkerBindingV1::BrokerExecute {
                        source: request.author.source.clone(),
                    },
                ),
                (
                    REVIEWER.into(),
                    WorkerBindingV1::BrokerExecute {
                        source: request.reviewer.source.clone(),
                    },
                ),
            ]),
        },
    };
    definition.validate()?;
    Ok(definition)
}

fn repair_steps(
    request: &AutonomousResearchCampaignRequestV1,
    original: &str,
    rejected: &str,
    round: usize,
) -> Result<Vec<WorkflowStepV1>, WorkflowError> {
    let author = format!("author-{}", round + 1);
    let revision = WorkflowStepV1 {
        id: author.clone(),
        module_id: AUTHOR.into(),
        capability_id: "CAP-AUTHOR".into(),
        resources: request.author.resources,
        cost_microusd: request.author.maximum_cost_microusd,
        job_template: job(
            &request.author,
            TaskKind::Revise,
            json!({"version":1,"kind":"ManuscriptRevisionInputV1","previousManuscript":"","previousManuscriptHash":hash(&"unbound")?,"review":"","reviewHash":hash(&"unbound")?,"instructions":request.revision_instructions}),
        )?,
        bindings: vec![
            binding(original, "previousManuscript", ArtifactEncodingV1::Utf8),
            binding(
                original,
                "previousManuscriptHash",
                ArtifactEncodingV1::Digest,
            ),
            binding(rejected, "review", ArtifactEncodingV1::Utf8),
            binding(rejected, "reviewHash", ArtifactEncodingV1::Digest),
        ],
        gate: None,
    };
    Ok(vec![revision, review(request, &author, round + 1)?])
}

/// Build only the next bounded repair from the committed, rejected assessment.
/// The existing amendment owner authenticates the prefix, artifacts and policy.
pub(super) fn revision(
    request: &AutonomousResearchCampaignRequestV1,
    definition: &LocalWorkflowV1,
    progress: &WorkflowProgressV1,
) -> Result<WorkflowAmendmentV1, WorkflowError> {
    let round = progress
        .amendment_count
        .checked_add(1)
        .ok_or(WorkflowError::Definition)?;
    if !progress.gate_rejected || round > request.revision_rounds || progress.committed_steps == 0 {
        return Err(WorkflowError::GateRejected);
    }
    let rejected = &definition.steps[progress.committed_steps - 1];
    let original = &rejected
        .gate
        .as_ref()
        .ok_or(WorkflowError::Definition)?
        .subject_step;
    Ok(WorkflowAmendmentV1 {
        version: 1,
        operation_id: format!("autonomous-review-repair-{round}"),
        expected_revision: progress.campaign_revision,
        steps: repair_steps(request, original, &rejected.id, round)?,
        additional_budget_microusd: 0,
        lease_expires_at_unix_ms: definition.template.writer_lease.expires_at_unix_ms,
        repair_rejected_review: true,
    })
}

pub(super) fn run(
    options: &AutonomousResearchOptions,
    allow_mutation: bool,
    cancelled: &Arc<AtomicBool>,
) -> Value {
    let result =
        (|| -> Result<(LocalWorkflowV1, AutonomousResearchCampaignRequestV1, Sha256Digest), WorkflowError> {
            let runtime = options
                .runtime_root
                .as_deref()
                .ok_or(WorkflowError::Filesystem)?;
            let metadata = fs::symlink_metadata(runtime).map_err(|_| WorkflowError::Filesystem)?;
            if !runtime.is_absolute()
                || fs::canonicalize(runtime).ok().as_deref() != Some(runtime)
                || !metadata.is_dir()
                || metadata.uid() != nix::unistd::geteuid().as_raw()
                || metadata.mode() & 0o077 != 0
            {
                return Err(WorkflowError::Filesystem);
            }
            let configured_request: AutonomousResearchCampaignRequestV1 =
                local::read_private_request(&runtime.join(REQUEST_FILE))?;
            configured_request.validate()?;
            // Bind configured facts separately from the effective first-request
            // overrides; subsequent invocations need not repeat CLI overrides.
            let configured_request_hash = hash(&configured_request)?;
            let mut request = configured_request.clone();
            if let Some(objective) = &options.objective {
                request.objective = objective.clone();
            }
            if let Some(rounds) = options.revision_rounds {
                request.revision_rounds = rounds;
            }
            if let Some(budget) = options.maximum_cost_microusd {
                request.budget_microusd = request.budget_microusd.min(budget);
            }
            if let Some(wall) = options.maximum_wall_ms {
                request.maximum_wall_ms = request.maximum_wall_ms.min(wall);
            }
            request.max_agent_calls = Some(options.maximum_agent_calls
                .unwrap_or(48)
                .min(configured_request.max_agent_calls.unwrap_or(u64::MAX)));
            let campaign = options
                .campaign_id
                .clone()
                .or_else(|| {
                    options
                        .paper_id
                        .as_ref()
                        .map(|id| format!("autonomous-research:{id}"))
                })
                .ok_or(WorkflowError::Definition)?;
            let identity = hash(&campaign)?;
            let root = runtime.join(format!("campaign-{}", &identity.as_str()[7..]));
            let definition = match fs::symlink_metadata(&root) {
                Ok(_) => {
                    let current = read_current_local_workflow_v1(&root)?;
                    // Authenticate the owner/history before reading its initial
                    // CAS subject. A workflow projection is not the request.
                    operate_local_workflow_v1(
                        &root,
                        &hash(&current)?,
                        WorkflowActionV1::Status,
                        0,
                    )?;
                    let retained_bytes = crate::ObjectStoreV1::open(&root)?
                        .read(&current.template.initial_state_hash)?;
                    let (domain, retained_campaign, retained_request, retained_configured_hash): (
                        String,
                        String,
                        AutonomousResearchCampaignRequestV1,
                        Sha256Digest,
                    ) = serde_json::from_slice(&retained_bytes)
                        .map_err(|_| WorkflowError::Definition)?;
                    if domain != "autonomous-research-campaign-request-v1"
                        || retained_campaign != campaign
                        || retained_configured_hash != configured_request_hash
                        || options.objective.as_ref().is_some_and(|objective| {
                            objective != &retained_request.objective
                        })
                        || options.revision_rounds.is_some_and(|rounds| {
                            rounds != retained_request.revision_rounds
                        })
                        || retained_request.budget_microusd > configured_request.budget_microusd
                        || retained_request.maximum_wall_ms > configured_request.maximum_wall_ms
                        || retained_request.max_agent_calls.unwrap_or(48)
                            > configured_request.max_agent_calls.unwrap_or(u64::MAX)
                        || options.maximum_cost_microusd.is_some_and(|budget| {
                            budget.min(configured_request.budget_microusd)
                                != retained_request.budget_microusd
                        })
                        || options.maximum_wall_ms.is_some_and(|wall| {
                            wall.min(configured_request.maximum_wall_ms)
                                != retained_request.maximum_wall_ms
                        })
                        || options.maximum_agent_calls.is_some_and(|calls| {
                            calls.min(configured_request.max_agent_calls.unwrap_or(u64::MAX))
                                != retained_request.max_agent_calls.unwrap_or(48)
                        })
                    {
                        return Err(WorkflowError::Definition);
                    }
                    // Only the supported business overrides may differ from
                    // current configured facts. No endpoint, policy, profile or
                    // budget can be silently substituted through retained state.
                    request = configured_request;
                    request.objective = retained_request.objective.clone();
                    request.revision_rounds = retained_request.revision_rounds;
                    request.budget_microusd = retained_request.budget_microusd;
                    request.maximum_wall_ms = retained_request.maximum_wall_ms;
                    request.max_agent_calls = retained_request.max_agent_calls;
                    if hash(&request)? != hash(&retained_request)?
                        || hash(&request_subject(&campaign, &request, &configured_request_hash))?
                            != current.template.initial_state_hash
                    {
                        return Err(WorkflowError::Definition);
                    }
                    let expected = assemble(
                        &request,
                        &configured_request_hash,
                        &campaign,
                        &root,
                        current.template.observed_at_unix_ms,
                        current.template.writer_lease.clone(),
                    )?;
                    let rounds = current
                        .steps
                        .len()
                        .checked_sub(2)
                        .ok_or(WorkflowError::Definition)?
                        / 2;
                    let mut expected_steps = expected.steps.clone();
                    for round in 1..=rounds {
                        expected_steps.extend(repair_steps(
                            &request,
                            &format!("author-{round}"),
                            &format!("review-{round}"),
                            round,
                        )?);
                    }
                    if current.steps.len() != 2 + rounds * 2
                        || rounds > request.revision_rounds
                        || current.template.writer_lease.expires_at_unix_ms
                            != current
                                .template
                                .observed_at_unix_ms
                                .checked_add(request.maximum_wall_ms)
                                .ok_or(WorkflowError::Definition)?
                        || hash(&current.steps)? != hash(&expected_steps)?
                        || hash(&current.template)? != hash(&expected.template)?
                        || current.research_profile != expected.research_profile
                        || current.provider_call_budget != expected.provider_call_budget
                    {
                        return Err(WorkflowError::Definition);
                    }
                    current
                }
                Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
                    return Err(WorkflowError::Filesystem);
                }
                Err(_)
                    if options.action == "prepare"
                        || options.action == "launch"
                        || options.action == "converge" =>
                {
                    let observed = local::now()?;
                    let mut token = [0_u8; 32];
                    getrandom::fill(&mut token).map_err(|_| WorkflowError::Filesystem)?;
                    assemble(
                        &request,
                        &configured_request_hash,
                        &campaign,
                        &root,
                        observed,
                        WriterLeaseV1 {
                            generation: 1,
                            token: hex::encode(token),
                            expires_at_unix_ms: observed
                                .checked_add(request.maximum_wall_ms)
                                .ok_or(WorkflowError::Definition)?,
                        },
                    )?
                }
                _ => return Err(WorkflowError::Filesystem),
            };
            Ok((definition, request, configured_request_hash))
        })();
    match result {
        Ok((definition, request, configured_request_hash)) => {
            let mut forwarded = options.clone();
            // Ordinary converge creates a previously absent campaign exactly as
            // launch; existing roots are authenticated and resumed above.
            if forwarded.action == "converge" && !definition.template.state_directory.exists() {
                forwarded.action = "launch".into();
            }
            let mut report = local::run_definition(
                &forwarded,
                allow_mutation,
                cancelled,
                Some(definition),
                Some((&request, &configured_request_hash)),
            );
            report["action"] = json!(options.action);
            report["composition"] = json!("ordinary_campaign_request_v1");
            report["requestHash"] = json!(hash(&request).ok());
            report["configuredRequestHash"] = json!(configured_request_hash);
            report["revisionRounds"] = json!(request.revision_rounds);
            report["budgetMicrousd"] = json!(request.budget_microusd);
            report["maximumWallMs"] = json!(request.maximum_wall_ms);
            report["maxAgentCalls"] = json!(request.max_agent_calls.unwrap_or(48));
            report
        }
        Err(error) => {
            json!({"version":1,"kind":"AutonomousResearchCampaignReport","action":options.action,"paperId":options.paper_id,"campaignId":options.campaign_id,"ready":false,"campaignPersisted":if options.runtime_root.is_some() {Value::Null}else{json!(false)},"providerExecutionPerformed":false,"externalActionPerformed":false,"releaseAuthority":false,"submissionAuthority":false,"error":match error {WorkflowError::Qualification=>"autonomous_research_campaign_qualification_binding_rejected",WorkflowError::Filesystem=>"autonomous_research_campaign_private_request_required",_=>"autonomous_research_campaign_request_rejected"}})
        }
    }
}
