fn candidate_for_request(
    module_version: &str,
    request: &PlanningRequestV1,
    binding: &LegacyCapabilityBindingV1,
    binding_hash: Sha256Digest,
) -> Result<ActionCandidateV1, LegacyAdapterError> {
    let identity = LegacyCandidateIdentityBodyV1 {
        version: 1,
        module_version,
        capability_id: &binding.capability_id,
        snapshot_hash: &request.state_snapshot_hash,
        binding_hash: &binding_hash,
    };
    Ok(ActionCandidateV1 {
        version: 1,
        candidate_id: derived_identifier("legacy", &canonical_hash(&identity)?),
        decision_group: binding.decision_group.clone(),
        module_id: NODE_LEGACY_ADAPTER_MODULE_ID_V1.to_owned(),
        module_version: module_version.to_owned(),
        capability_id: binding.capability_id.clone(),
        snapshot_hash: request.state_snapshot_hash.clone(),
        dependency_candidate_ids: Vec::new(),
        resources: binding.resources,
        utility_micros: binding.utility_micros,
        cost_microusd: binding.cost_microusd,
        uncertainty_ppm: binding.uncertainty_ppm,
        evidence_tier: binding.evidence_tier,
        payload_hash: binding_hash,
    })
}

fn validate_candidate_against_binding(
    candidate: &ActionCandidateV1,
    module_version: &str,
    binding: &LegacyCapabilityBindingV1,
) -> Result<(), LegacyAdapterError> {
    let binding_hash = binding.binding_hash()?;
    let identity = LegacyCandidateIdentityBodyV1 {
        version: 1,
        module_version,
        capability_id: &binding.capability_id,
        snapshot_hash: &candidate.snapshot_hash,
        binding_hash: &binding_hash,
    };
    let expected_id = derived_identifier("legacy", &canonical_hash(&identity)?);
    if candidate.version != 1
        || candidate.candidate_id != expected_id
        || candidate.decision_group != binding.decision_group
        || candidate.module_id != NODE_LEGACY_ADAPTER_MODULE_ID_V1
        || candidate.module_version != module_version
        || candidate.capability_id != binding.capability_id
        || !candidate.dependency_candidate_ids.is_empty()
        || candidate.resources != binding.resources
        || candidate.utility_micros != binding.utility_micros
        || candidate.cost_microusd != binding.cost_microusd
        || candidate.uncertainty_ppm != binding.uncertainty_ppm
        || candidate.evidence_tier != binding.evidence_tier
        || candidate.payload_hash != binding_hash
    {
        return Err(LegacyAdapterError::BindingInvalid);
    }
    Ok(())
}

fn build_invocation(
    module_version: &str,
    binding: &LegacyCapabilityBindingV1,
    candidate: &ActionCandidateV1,
    command: &ExecutionCommandV1,
    command_hash: Sha256Digest,
) -> Result<LegacyNodeInvocationV1, LegacyAdapterError> {
    let body = LegacyNodeInvocationBodyV1 {
        version: 1,
        module_version,
        capability_id: &binding.capability_id,
        node_entrypoint: &binding.node_entrypoint,
        node_entrypoint_hash: &binding.node_entrypoint_hash,
        node_contract_hash: &binding.node_contract_hash,
        translation_policy_hash: &binding.translation_policy_hash,
        parity_class: binding.parity_class,
        binding_hash: binding.binding_hash()?,
        command_hash,
        candidate_hash: candidate.candidate_hash()?,
        snapshot_hash: command.state_snapshot_hash.clone(),
        plan_hash: command.plan_hash.clone(),
        execution_id: &command.execution_id,
        campaign_id: &command.campaign_id,
        node_id: &command.node_id,
        attempt_id: &command.attempt_id,
        lease_generation: command.lease_generation,
        writer_generation: command.writer_generation,
        resource_reservation_id: &command.resource_reservation_id,
        resource_reservation_hash: command.resource_reservation_hash.clone(),
        resource_envelope: command.resource_envelope,
        deadline_unix_ms: command.deadline_unix_ms,
        cancellation_id: &command.cancellation_id,
        idempotency_key: &command.idempotency_key,
        input_artifact_hashes: &command.input_artifact_hashes,
        central_writer_available: false,
        irreversible_external_effect_available: false,
        grants_authority: false,
    };
    let invocation_hash = canonical_hash(&body)?;
    Ok(LegacyNodeInvocationV1 {
        version: body.version,
        module_version: module_version.to_owned(),
        capability_id: binding.capability_id.clone(),
        node_entrypoint: binding.node_entrypoint.clone(),
        node_entrypoint_hash: binding.node_entrypoint_hash.clone(),
        node_contract_hash: binding.node_contract_hash.clone(),
        translation_policy_hash: binding.translation_policy_hash.clone(),
        parity_class: binding.parity_class,
        binding_hash: body.binding_hash,
        command_hash: body.command_hash,
        candidate_hash: body.candidate_hash,
        snapshot_hash: body.snapshot_hash,
        plan_hash: body.plan_hash,
        execution_id: command.execution_id.clone(),
        campaign_id: command.campaign_id.clone(),
        node_id: command.node_id.clone(),
        attempt_id: command.attempt_id.clone(),
        lease_generation: command.lease_generation,
        writer_generation: command.writer_generation,
        resource_reservation_id: command.resource_reservation_id.clone(),
        resource_reservation_hash: command.resource_reservation_hash.clone(),
        resource_envelope: command.resource_envelope,
        deadline_unix_ms: command.deadline_unix_ms,
        cancellation_id: command.cancellation_id.clone(),
        idempotency_key: command.idempotency_key.clone(),
        input_artifact_hashes: command.input_artifact_hashes.clone(),
        central_writer_available: false,
        irreversible_external_effect_available: false,
        grants_authority: false,
        invocation_hash,
    })
}

fn validate_observation(
    record: &LegacyExecutionRecordV1,
    observation: &LegacyNodeObservationV1,
) -> Result<(), LegacyAdapterError> {
    if observation.version != 1
        || observation.invocation_hash != record.invocation.invocation_hash
        || observation.execution_id != record.command.execution_id
        || observation.attempt_id != record.command.attempt_id
        || observation.idempotency_key != record.command.idempotency_key
        || observation.artifact_hashes.is_empty()
        || observation.artifact_hashes.len() > MAXIMUM_PROTOCOL_ARTIFACTS_V1
        || duplicate_digests(&observation.artifact_hashes)
        || !is_strictly_sorted(&observation.artifact_hashes)
        || !observation
            .actual_resources
            .fits_within(record.candidate.resources)
        || observation.actual_resources.external_actions != 0
        || observation.actual_resources.central_writer_turns != 0
        || observation.actual_cost_microusd > record.candidate.cost_microusd
        || observation.observed_at_unix_ms == 0
        || observation.observed_at_unix_ms > record.command.deadline_unix_ms
        || observation.irreversible_external_action_may_have_started
        || observation.central_state_write_observed
    {
        return Err(LegacyAdapterError::ObservationInvalid);
    }
    Ok(())
}

fn reservation_outcome(record: &LegacyExecutionRecordV1) -> LegacyReservationOutcomeV1 {
    match &record.state {
        LegacyExecutionStateV1::Reserved => {
            LegacyReservationOutcomeV1::ExistingReservation(Box::new(record.invocation.clone()))
        }
        LegacyExecutionStateV1::Running => {
            LegacyReservationOutcomeV1::RunningRequiresReconciliation(Box::new(
                record.invocation.clone(),
            ))
        }
        LegacyExecutionStateV1::Prepared {
            result, receipt, ..
        } => LegacyReservationOutcomeV1::Prepared {
            result: result.clone(),
            receipt: receipt.clone(),
        },
        LegacyExecutionStateV1::Cancelled => LegacyReservationOutcomeV1::Cancelled,
    }
}

fn valid_repository_relative_path(value: &str) -> bool {
    valid_identifier(value)
        && !value.starts_with('/')
        && value
            .split('/')
            .all(|part| !part.is_empty() && part != "." && part != "..")
}

fn derived_identifier(prefix: &str, digest: &Sha256Digest) -> String {
    format!("{prefix}:{}", &digest.as_str()[7..39])
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LegacyCandidateIdentityBodyV1<'a> {
    version: u16,
    module_version: &'a str,
    capability_id: &'a str,
    snapshot_hash: &'a Sha256Digest,
    binding_hash: &'a Sha256Digest,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LegacyPlanningReceiptBodyV1 {
    version: u16,
    planning_request_hash: Sha256Digest,
    binding_hash: Sha256Digest,
    candidate_hash: Sha256Digest,
    response_hash: Sha256Digest,
    grants_authority: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LegacyNodeInvocationBodyV1<'a> {
    version: u16,
    module_version: &'a str,
    capability_id: &'a str,
    node_entrypoint: &'a str,
    node_entrypoint_hash: &'a Sha256Digest,
    node_contract_hash: &'a Sha256Digest,
    translation_policy_hash: &'a Sha256Digest,
    parity_class: LegacyParityClassV1,
    binding_hash: Sha256Digest,
    command_hash: Sha256Digest,
    candidate_hash: Sha256Digest,
    snapshot_hash: Sha256Digest,
    plan_hash: Sha256Digest,
    execution_id: &'a str,
    campaign_id: &'a str,
    node_id: &'a str,
    attempt_id: &'a str,
    lease_generation: u64,
    writer_generation: u64,
    resource_reservation_id: &'a str,
    resource_reservation_hash: Sha256Digest,
    resource_envelope: ResourceVectorV1,
    deadline_unix_ms: u64,
    cancellation_id: &'a str,
    idempotency_key: &'a str,
    input_artifact_hashes: &'a [Sha256Digest],
    central_writer_available: bool,
    irreversible_external_effect_available: bool,
    grants_authority: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LegacyEvidenceBodyV1 {
    version: u16,
    parity_class: LegacyParityClassV1,
    binding_hash: Sha256Digest,
    command_hash: Sha256Digest,
    invocation_hash: Sha256Digest,
    observation_hash: Sha256Digest,
    output_projection_hash: Sha256Digest,
    translation_evidence_hash: Sha256Digest,
    grants_authority: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LegacyTranslationReceiptBodyV1 {
    version: u16,
    parity_class: LegacyParityClassV1,
    binding_hash: Sha256Digest,
    command_hash: Sha256Digest,
    invocation_hash: Sha256Digest,
    observation_hash: Sha256Digest,
    output_projection_hash: Sha256Digest,
    prepared_result_hash: Sha256Digest,
    evidence_hash: Sha256Digest,
    central_state_write_observed: bool,
    grants_authority: bool,
}

/// Why the bounded Node adapter rejected a request or observation.
#[derive(Clone, Copy, Debug, Error, Eq, PartialEq)]
pub enum LegacyAdapterError {
    /// Common protocol or prepared-result validation failed.
    #[error("module protocol validation failed: {0}")]
    Platform(#[from] ModulePlatformError),
    /// A capability source binding is malformed or inconsistent.
    #[error("legacy capability binding is invalid")]
    BindingInvalid,
    /// Two bindings claim the same capability.
    #[error("legacy capability binding is duplicated")]
    DuplicateCapability,
    /// No source binding exists for the requested capability.
    #[error("legacy capability binding is missing")]
    CapabilityMissing,
    /// A request attempted to widen writer or irreversible-effect authority.
    #[error("legacy adapter authority escalation rejected")]
    AuthorityEscalation,
    /// The bounded execution ledger is full.
    #[error("legacy adapter execution limit exceeded")]
    ExecutionLimit,
    /// An execution identity conflicts with retained state.
    #[error("legacy adapter execution identity conflicts")]
    ExecutionConflict,
    /// An idempotency key was reused with different input.
    #[error("legacy adapter idempotency conflict")]
    IdempotencyConflict,
    /// The requested execution identity is not retained.
    #[error("legacy adapter execution is missing")]
    ExecutionMissing,
    /// The requested lifecycle transition is unsafe.
    #[error("legacy adapter lifecycle transition is invalid")]
    StateTransition,
    /// A Node observation violates identity, resource, or authority bounds.
    #[error("legacy Node observation is invalid")]
    ObservationInvalid,
    /// A completed execution was replayed with different evidence.
    #[error("legacy Node observation conflicts with the retained result")]
    ObservationConflict,
}
