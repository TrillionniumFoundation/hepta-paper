/// Compatibility class for one bounded Node translation.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LegacyParityClassV1 {
    /// Canonical bytes, statuses, and decisions must match exactly.
    Exact,
    /// Approved normalized invariants and transitions must match.
    Semantic,
    /// Model-generated content requires an independent evaluation protocol.
    Evaluation,
}

/// Closed source binding for one incumbent Node capability.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LegacyCapabilityBindingV1 {
    /// Contract version.
    pub version: u16,
    /// Capability exposed through Module Protocol V1.
    pub capability_id: String,
    /// Mutually exclusive planning decision group.
    pub decision_group: String,
    /// Required explanation for the single legacy alternative.
    pub singleton_reason: String,
    /// Repository-relative incumbent Node entrypoint.
    pub node_entrypoint: String,
    /// Exact incumbent Node entrypoint/source identity.
    pub node_entrypoint_hash: Sha256Digest,
    /// Exact Node input/output and authority-contract identity.
    pub node_contract_hash: Sha256Digest,
    /// Exact translation and comparison-policy identity.
    pub translation_policy_hash: Sha256Digest,
    /// Declared parity class.
    pub parity_class: LegacyParityClassV1,
    /// Hard maximum resource envelope.
    pub resources: ResourceVectorV1,
    /// Deterministic advisory utility.
    pub utility_micros: i64,
    /// Hard maximum cost.
    pub cost_microusd: u64,
    /// Bounded uncertainty.
    pub uncertainty_ppm: u32,
    /// Source-evidence ceiling carried by the candidate.
    pub evidence_tier: QualificationTierV1,
}

impl LegacyCapabilityBindingV1 {
    /// Validates the closed source binding.
    pub fn validate(&self) -> Result<(), LegacyAdapterError> {
        if self.version != 1
            || !valid_capability_id(&self.capability_id)
            || !valid_identifier(&self.decision_group)
            || !valid_identifier(&self.singleton_reason)
            || !valid_repository_relative_path(&self.node_entrypoint)
            || self.resources.is_zero()
            || self.resources.external_actions != 0
            || self.resources.central_writer_turns != 0
            || self.uncertainty_ppm > 1_000_000
            || self.evidence_tier > QualificationTierV1::Source
        {
            return Err(LegacyAdapterError::BindingInvalid);
        }
        Ok(())
    }

    /// Returns the canonical source-binding identity.
    pub fn binding_hash(&self) -> Result<Sha256Digest, LegacyAdapterError> {
        self.validate()?;
        canonical_hash(self).map_err(Into::into)
    }
}

/// Non-authorizing receipt for deterministic legacy candidate construction.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LegacyPlanningReceiptV1 {
    /// Contract version.
    pub version: u16,
    /// Exact planning-request hash.
    pub planning_request_hash: Sha256Digest,
    /// Exact capability-binding hash.
    pub binding_hash: Sha256Digest,
    /// Exact candidate hash.
    pub candidate_hash: Sha256Digest,
    /// Exact response hash.
    pub response_hash: Sha256Digest,
    /// This receipt never grants runtime or production authority.
    pub grants_authority: bool,
    /// Canonical receipt identity.
    pub receipt_hash: Sha256Digest,
}

/// Immutable invocation handed to a separately controlled Node port.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LegacyNodeInvocationV1 {
    /// Contract version.
    pub version: u16,
    /// Adapter module version.
    pub module_version: String,
    /// Exact capability.
    pub capability_id: String,
    /// Exact Node entrypoint path.
    pub node_entrypoint: String,
    /// Exact Node source identity.
    pub node_entrypoint_hash: Sha256Digest,
    /// Exact Node contract identity.
    pub node_contract_hash: Sha256Digest,
    /// Exact translation-policy identity.
    pub translation_policy_hash: Sha256Digest,
    /// Declared parity class.
    pub parity_class: LegacyParityClassV1,
    /// Exact capability-binding hash.
    pub binding_hash: Sha256Digest,
    /// Exact common-command hash.
    pub command_hash: Sha256Digest,
    /// Exact selected-candidate hash.
    pub candidate_hash: Sha256Digest,
    /// Exact snapshot hash.
    pub snapshot_hash: Sha256Digest,
    /// Exact selected-plan hash.
    pub plan_hash: Sha256Digest,
    /// Stable execution identity.
    pub execution_id: String,
    /// Campaign identity.
    pub campaign_id: String,
    /// Node identity.
    pub node_id: String,
    /// Attempt identity.
    pub attempt_id: String,
    /// Attempt lease generation.
    pub lease_generation: u64,
    /// Incumbent writer generation copied for comparison only.
    pub writer_generation: u64,
    /// Exact resource-reservation identity.
    pub resource_reservation_id: String,
    /// Exact resource-reservation hash.
    pub resource_reservation_hash: Sha256Digest,
    /// Hard resource ceiling.
    pub resource_envelope: ResourceVectorV1,
    /// Execution deadline.
    pub deadline_unix_ms: u64,
    /// Identity-bound cancellation channel.
    pub cancellation_id: String,
    /// Stable idempotency identity.
    pub idempotency_key: String,
    /// Sorted immutable input artifacts.
    pub input_artifact_hashes: Vec<Sha256Digest>,
    /// A central writer is deliberately unavailable.
    pub central_writer_available: bool,
    /// Irreversible external-effect authority is deliberately unavailable.
    pub irreversible_external_effect_available: bool,
    /// The invocation cannot grant authority.
    pub grants_authority: bool,
    /// Canonical invocation identity.
    pub invocation_hash: Sha256Digest,
}

/// Terminal bounded observation returned by the Node port.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LegacyNodeObservationV1 {
    /// Contract version.
    pub version: u16,
    /// Exact invocation identity.
    pub invocation_hash: Sha256Digest,
    /// Exact execution identity.
    pub execution_id: String,
    /// Exact attempt identity.
    pub attempt_id: String,
    /// Exact idempotency identity.
    pub idempotency_key: String,
    /// Terminal prepared-result status.
    pub status: PreparedResultStatusV1,
    /// Sorted immutable output artifacts.
    pub artifact_hashes: Vec<Sha256Digest>,
    /// Measured resource use.
    pub actual_resources: ResourceVectorV1,
    /// Measured charged cost.
    pub actual_cost_microusd: u64,
    /// Hash of the normalized legacy output projection.
    pub output_projection_hash: Sha256Digest,
    /// Hash of Node-side translation/parity evidence.
    pub translation_evidence_hash: Sha256Digest,
    /// Observation time supplied by the trusted caller.
    pub observed_at_unix_ms: u64,
    /// Conservative irreversible-action declaration.
    pub irreversible_external_action_may_have_started: bool,
    /// Whether a central-state write was observed.
    pub central_state_write_observed: bool,
}

/// Differential evidence connecting a Node observation to a common result.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LegacyTranslationReceiptV1 {
    /// Contract version.
    pub version: u16,
    /// Declared parity class.
    pub parity_class: LegacyParityClassV1,
    /// Exact capability-binding hash.
    pub binding_hash: Sha256Digest,
    /// Exact command hash.
    pub command_hash: Sha256Digest,
    /// Exact invocation hash.
    pub invocation_hash: Sha256Digest,
    /// Exact observation hash.
    pub observation_hash: Sha256Digest,
    /// Exact normalized output-projection hash.
    pub output_projection_hash: Sha256Digest,
    /// Exact prepared-result hash.
    pub prepared_result_hash: Sha256Digest,
    /// Exact evidence hash carried by the prepared result.
    pub evidence_hash: Sha256Digest,
    /// The adapter observed no central-state write.
    pub central_state_write_observed: bool,
    /// The adapter cannot grant authority.
    pub grants_authority: bool,
    /// Canonical receipt identity.
    pub receipt_hash: Sha256Digest,
}

/// Result of reserving an exact execution identity.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum LegacyReservationOutcomeV1 {
    /// New invocation is reserved but not handed to Node.
    Reserved(Box<LegacyNodeInvocationV1>),
    /// The same invocation is already reserved.
    ExistingReservation(Box<LegacyNodeInvocationV1>),
    /// Node may already be running; reconcile instead of retrying.
    RunningRequiresReconciliation(Box<LegacyNodeInvocationV1>),
    /// An exact prepared result already exists.
    Prepared {
        /// Previously accepted prepared result.
        result: Box<PreparedResultV1>,
        /// Previously accepted differential receipt.
        receipt: Box<LegacyTranslationReceiptV1>,
    },
    /// The reservation was cancelled before execution.
    Cancelled,
}

/// Result of attempting to hand a reserved invocation to Node.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum LegacyBeginOutcomeV1 {
    /// The caller may perform exactly one Node invocation.
    Execute(Box<LegacyNodeInvocationV1>),
    /// Node may already be running; do not invoke it again.
    RunningRequiresReconciliation(Box<LegacyNodeInvocationV1>),
    /// An exact prepared result already exists.
    Prepared {
        /// Previously accepted prepared result.
        result: Box<PreparedResultV1>,
        /// Previously accepted differential receipt.
        receipt: Box<LegacyTranslationReceiptV1>,
    },
    /// Execution was cancelled before handoff.
    Cancelled,
}

#[derive(Clone, Debug)]
enum LegacyExecutionStateV1 {
    Reserved,
    Running,
    Prepared {
        observation_hash: Sha256Digest,
        result: Box<PreparedResultV1>,
        receipt: Box<LegacyTranslationReceiptV1>,
    },
    Cancelled,
}

#[derive(Clone, Debug)]
struct LegacyExecutionRecordV1 {
    binding: LegacyCapabilityBindingV1,
    candidate: ActionCandidateV1,
    command: ExecutionCommandV1,
    invocation: LegacyNodeInvocationV1,
    state: LegacyExecutionStateV1,
}

/// In-memory bounded adapter state. Durable ownership remains with the caller.
#[derive(Clone, Debug)]
pub struct NodeLegacyAdapterV1 {
    module_version: String,
    bindings: BTreeMap<String, LegacyCapabilityBindingV1>,
    executions: BTreeMap<String, LegacyExecutionRecordV1>,
    execution_index: BTreeMap<String, String>,
}
