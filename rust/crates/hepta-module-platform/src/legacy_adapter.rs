//! Bounded strangler adapter for incumbent Node capabilities.
//!
//! The adapter emits immutable Node invocation descriptions and accepts bounded
//! observations. It never launches Node, receives a central writer, or grants
//! irreversible external-effect authority.

use std::collections::BTreeMap;

use hepta_codex_protocol::Sha256Digest;
use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::{
    ActionCandidateV1, CancellationAcknowledgementV1, CancellationDispositionV1,
    CancellationRequestV1, ExecutionCommandV1, MAXIMUM_PROTOCOL_ARTIFACTS_V1,
    ModulePlatformError, PlanningRequestV1, PlanningResponseV1, PreparedResultStatusV1,
    PreparedResultV1, ProtocolEnvelopeV1, ProtocolObjectKindV1, QualificationTierV1,
    ResourceVectorV1, SideEffectClassV1,
    hash::canonical_hash,
    types::{
        duplicate_digests, is_strictly_sorted, valid_capability_id, valid_identifier,
        valid_semver,
    },
};

/// Stable module identity used by the strangler adapter.
pub const NODE_LEGACY_ADAPTER_MODULE_ID_V1: &str = "module.node-legacy-adapter";
/// Maximum independently declared Node capability bindings.
pub const MAXIMUM_LEGACY_CAPABILITY_BINDINGS_V1: usize = 256;
/// Maximum retained execution identities before an operator checkpoint.
pub const MAXIMUM_LEGACY_EXECUTIONS_V1: usize = 4_096;

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

impl NodeLegacyAdapterV1 {
    /// Builds an adapter from a closed, capability-unique binding set.
    pub fn new(
        module_version: String,
        bindings: Vec<LegacyCapabilityBindingV1>,
    ) -> Result<Self, LegacyAdapterError> {
        if !valid_semver(&module_version)
            || bindings.is_empty()
            || bindings.len() > MAXIMUM_LEGACY_CAPABILITY_BINDINGS_V1
        {
            return Err(LegacyAdapterError::BindingInvalid);
        }
        let mut by_capability = BTreeMap::new();
        for binding in bindings {
            binding.validate()?;
            if by_capability
                .insert(binding.capability_id.clone(), binding)
                .is_some()
            {
                return Err(LegacyAdapterError::DuplicateCapability);
            }
        }
        Ok(Self {
            module_version,
            bindings: by_capability,
            executions: BTreeMap::new(),
            execution_index: BTreeMap::new(),
        })
    }

    /// Produces one deterministic, prepared-result-only legacy candidate.
    pub fn plan(
        &self,
        request: &PlanningRequestV1,
        now_unix_ms: u64,
    ) -> Result<(PlanningResponseV1, LegacyPlanningReceiptV1), LegacyAdapterError> {
        request.validate(now_unix_ms)?;
        self.validate_request_module(request)?;
        if request.allowed_side_effect_classes.iter().any(|class| {
            matches!(
                class,
                SideEffectClassV1::ExternalReversible
                    | SideEffectClassV1::ExternalIrreversible
                    | SideEffectClassV1::CentralStateCommit
            )
        }) || !request
            .allowed_side_effect_classes
            .contains(&SideEffectClassV1::PreparedResult)
        {
            return Err(LegacyAdapterError::AuthorityEscalation);
        }
        let binding = self
            .bindings
            .get(&request.capability_id)
            .ok_or(LegacyAdapterError::CapabilityMissing)?;
        let binding_hash = binding.binding_hash()?;
        let planning_request_hash = request.request_hash()?;
        let candidate = candidate_for_request(
            &self.module_version,
            request,
            binding,
            binding_hash.clone(),
        )?;
        let candidate_hash = candidate.candidate_hash()?;
        let response = PlanningResponseV1 {
            envelope: ProtocolEnvelopeV1 {
                version: 1,
                kind: ProtocolObjectKindV1::PlanningResponse,
                request_id: derived_identifier("legacy-plan", &planning_request_hash),
                created_at_unix_ms: now_unix_ms,
                expires_at_unix_ms: request.envelope.expires_at_unix_ms,
                module_id: NODE_LEGACY_ADAPTER_MODULE_ID_V1.to_owned(),
                module_version: self.module_version.clone(),
                protocol_version: 1,
                trace_id: request.envelope.trace_id.clone(),
                payload_hash: candidate_hash.clone(),
            },
            planning_request_hash: planning_request_hash.clone(),
            candidates: vec![candidate],
            singleton_reason: Some(binding.singleton_reason.clone()),
        };
        let response_hash = response.response_hash()?;
        let body = LegacyPlanningReceiptBodyV1 {
            version: 1,
            planning_request_hash: planning_request_hash.clone(),
            binding_hash: binding_hash.clone(),
            candidate_hash: candidate_hash.clone(),
            response_hash: response_hash.clone(),
            grants_authority: false,
        };
        Ok((
            response,
            LegacyPlanningReceiptV1 {
                version: body.version,
                planning_request_hash,
                binding_hash,
                candidate_hash,
                response_hash,
                grants_authority: false,
                receipt_hash: canonical_hash(&body)?,
            },
        ))
    }

    /// Reserves one exact execution without permitting the Node call yet.
    pub fn reserve_execution(
        &mut self,
        candidate: &ActionCandidateV1,
        command: &ExecutionCommandV1,
        expected_plan_hash: &Sha256Digest,
        now_unix_ms: u64,
    ) -> Result<LegacyReservationOutcomeV1, LegacyAdapterError> {
        command.validate(candidate, expected_plan_hash, now_unix_ms)?;
        self.validate_candidate(candidate)?;
        let binding = self
            .bindings
            .get(&candidate.capability_id)
            .ok_or(LegacyAdapterError::CapabilityMissing)?
            .clone();
        validate_candidate_against_binding(candidate, &self.module_version, &binding)?;
        let command_hash = command.command_hash()?;
        if let Some(existing) = self.executions.get(&command.idempotency_key) {
            if existing.command.command_hash()? != command_hash
                || existing.candidate.candidate_hash()? != candidate.candidate_hash()?
            {
                return Err(LegacyAdapterError::IdempotencyConflict);
            }
            return Ok(reservation_outcome(existing));
        }
        if self.executions.len() >= MAXIMUM_LEGACY_EXECUTIONS_V1 {
            return Err(LegacyAdapterError::ExecutionLimit);
        }
        if self.execution_index.contains_key(&command.execution_id) {
            return Err(LegacyAdapterError::ExecutionConflict);
        }
        let invocation = build_invocation(
            &self.module_version,
            &binding,
            candidate,
            command,
            command_hash,
        )?;
        self.execution_index
            .insert(command.execution_id.clone(), command.idempotency_key.clone());
        self.executions.insert(
            command.idempotency_key.clone(),
            LegacyExecutionRecordV1 {
                binding,
                candidate: candidate.clone(),
                command: command.clone(),
                invocation: invocation.clone(),
                state: LegacyExecutionStateV1::Reserved,
            },
        );
        Ok(LegacyReservationOutcomeV1::Reserved(Box::new(invocation)))
    }

    /// Atomically marks one reserved invocation as handed to Node.
    pub fn begin_execution(
        &mut self,
        idempotency_key: &str,
        expected_invocation_hash: &Sha256Digest,
    ) -> Result<LegacyBeginOutcomeV1, LegacyAdapterError> {
        let record = self
            .executions
            .get_mut(idempotency_key)
            .ok_or(LegacyAdapterError::ExecutionMissing)?;
        if &record.invocation.invocation_hash != expected_invocation_hash {
            return Err(LegacyAdapterError::ExecutionConflict);
        }
        match record.state.clone() {
            LegacyExecutionStateV1::Reserved => {
                record.state = LegacyExecutionStateV1::Running;
                Ok(LegacyBeginOutcomeV1::Execute(Box::new(
                    record.invocation.clone(),
                )))
            }
            LegacyExecutionStateV1::Running => Ok(
                LegacyBeginOutcomeV1::RunningRequiresReconciliation(Box::new(
                    record.invocation.clone(),
                )),
            ),
            LegacyExecutionStateV1::Prepared {
                result, receipt, ..
            } => Ok(LegacyBeginOutcomeV1::Prepared { result, receipt }),
            LegacyExecutionStateV1::Cancelled => Ok(LegacyBeginOutcomeV1::Cancelled),
        }
    }

    /// Translates one bounded Node observation into a common prepared result.
    pub fn complete_execution(
        &mut self,
        observation: &LegacyNodeObservationV1,
    ) -> Result<(PreparedResultV1, LegacyTranslationReceiptV1), LegacyAdapterError> {
        let module_version = self.module_version.clone();
        let record = self
            .executions
            .get_mut(&observation.idempotency_key)
            .ok_or(LegacyAdapterError::ExecutionMissing)?;
        let observation_hash = canonical_hash(observation)?;
        if let LegacyExecutionStateV1::Prepared {
            observation_hash: existing_hash,
            result,
            receipt,
        } = &record.state
        {
            if existing_hash == &observation_hash {
                return Ok(((**result).clone(), (**receipt).clone()));
            }
            return Err(LegacyAdapterError::ObservationConflict);
        }
        if !matches!(record.state, LegacyExecutionStateV1::Running) {
            return Err(LegacyAdapterError::StateTransition);
        }
        validate_observation(record, observation)?;
        let binding_hash = record.binding.binding_hash()?;
        let command_hash = record.command.command_hash()?;
        let candidate_hash = record.candidate.candidate_hash()?;
        let evidence_body = LegacyEvidenceBodyV1 {
            version: 1,
            parity_class: record.binding.parity_class,
            binding_hash: binding_hash.clone(),
            command_hash: command_hash.clone(),
            invocation_hash: record.invocation.invocation_hash.clone(),
            observation_hash: observation_hash.clone(),
            output_projection_hash: observation.output_projection_hash.clone(),
            translation_evidence_hash: observation.translation_evidence_hash.clone(),
            grants_authority: false,
        };
        let evidence_hash = canonical_hash(&evidence_body)?;
        let result = PreparedResultV1 {
            version: 1,
            attempt_id: record.command.attempt_id.clone(),
            snapshot_hash: record.command.state_snapshot_hash.clone(),
            plan_hash: record.command.plan_hash.clone(),
            candidate_hash,
            module_id: NODE_LEGACY_ADAPTER_MODULE_ID_V1.to_owned(),
            module_version,
            status: observation.status,
            artifact_hashes: observation.artifact_hashes.clone(),
            actual_resources: observation.actual_resources,
            actual_cost_microusd: observation.actual_cost_microusd,
            evidence_hash: evidence_hash.clone(),
            external_action_may_have_started: false,
        };
        result.validate(&record.candidate, &record.command.plan_hash)?;
        let prepared_result_hash = result.result_hash()?;
        let receipt_body = LegacyTranslationReceiptBodyV1 {
            version: 1,
            parity_class: record.binding.parity_class,
            binding_hash: binding_hash.clone(),
            command_hash: command_hash.clone(),
            invocation_hash: record.invocation.invocation_hash.clone(),
            observation_hash: observation_hash.clone(),
            output_projection_hash: observation.output_projection_hash.clone(),
            prepared_result_hash: prepared_result_hash.clone(),
            evidence_hash: evidence_hash.clone(),
            central_state_write_observed: false,
            grants_authority: false,
        };
        let receipt = LegacyTranslationReceiptV1 {
            version: receipt_body.version,
            parity_class: receipt_body.parity_class,
            binding_hash,
            command_hash,
            invocation_hash: record.invocation.invocation_hash.clone(),
            observation_hash: observation_hash.clone(),
            output_projection_hash: observation.output_projection_hash.clone(),
            prepared_result_hash,
            evidence_hash,
            central_state_write_observed: false,
            grants_authority: false,
            receipt_hash: canonical_hash(&receipt_body)?,
        };
        record.state = LegacyExecutionStateV1::Prepared {
            observation_hash,
            result: Box::new(result.clone()),
            receipt: Box::new(receipt.clone()),
        };
        Ok((result, receipt))
    }

    /// Applies conservative cancellation without inferring success from absence.
    pub fn cancel(
        &mut self,
        request: &CancellationRequestV1,
        now_unix_ms: u64,
    ) -> Result<CancellationAcknowledgementV1, LegacyAdapterError> {
        request.validate(now_unix_ms)?;
        if request.envelope.module_id != NODE_LEGACY_ADAPTER_MODULE_ID_V1
            || request.envelope.module_version != self.module_version
        {
            return Err(LegacyAdapterError::BindingInvalid);
        }
        let request_hash = request.request_hash()?;
        let idempotency_key = self.execution_index.get(&request.execution_id).cloned();
        let (disposition, prepared_result) = match idempotency_key {
            None => (
                CancellationDispositionV1::UnknownRequiresReconciliation,
                None,
            ),
            Some(idempotency_key) => {
                let record = self
                    .executions
                    .get_mut(&idempotency_key)
                    .ok_or(LegacyAdapterError::ExecutionMissing)?;
                if record.command.command_hash()? != request.execution_command_hash {
                    return Err(LegacyAdapterError::ExecutionConflict);
                }
                match record.state.clone() {
                    LegacyExecutionStateV1::Reserved => {
                        record.state = LegacyExecutionStateV1::Cancelled;
                        (CancellationDispositionV1::CancelledBeforeExecution, None)
                    }
                    LegacyExecutionStateV1::Running => (
                        CancellationDispositionV1::UnknownRequiresReconciliation,
                        None,
                    ),
                    LegacyExecutionStateV1::Prepared { result, .. } => (
                        CancellationDispositionV1::PreparedResultAlreadyExists,
                        Some(*result),
                    ),
                    LegacyExecutionStateV1::Cancelled => {
                        (CancellationDispositionV1::CancelledBeforeExecution, None)
                    }
                }
            }
        };
        let acknowledgement = CancellationAcknowledgementV1 {
            envelope: ProtocolEnvelopeV1 {
                version: 1,
                kind: ProtocolObjectKindV1::CancellationAcknowledgement,
                request_id: derived_identifier("legacy-cancel", &request_hash),
                created_at_unix_ms: now_unix_ms,
                expires_at_unix_ms: request.envelope.expires_at_unix_ms,
                module_id: NODE_LEGACY_ADAPTER_MODULE_ID_V1.to_owned(),
                module_version: self.module_version.clone(),
                protocol_version: 1,
                trace_id: request.envelope.trace_id.clone(),
                payload_hash: request_hash.clone(),
            },
            cancellation_request_hash: request_hash,
            execution_id: request.execution_id.clone(),
            disposition,
            prepared_result,
        };
        acknowledgement.validate(request, now_unix_ms)?;
        Ok(acknowledgement)
    }

    fn validate_request_module(
        &self,
        request: &PlanningRequestV1,
    ) -> Result<(), LegacyAdapterError> {
        if request.envelope.module_id != NODE_LEGACY_ADAPTER_MODULE_ID_V1
            || request.envelope.module_version != self.module_version
        {
            return Err(LegacyAdapterError::BindingInvalid);
        }
        Ok(())
    }

    fn validate_candidate(&self, candidate: &ActionCandidateV1) -> Result<(), LegacyAdapterError> {
        if candidate.module_id != NODE_LEGACY_ADAPTER_MODULE_ID_V1
            || candidate.module_version != self.module_version
        {
            return Err(LegacyAdapterError::BindingInvalid);
        }
        Ok(())
    }
}

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
        LegacyExecutionStateV1::Reserved => LegacyReservationOutcomeV1::ExistingReservation(
            Box::new(record.invocation.clone()),
        ),
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

#[cfg(test)]
mod tests {
    use std::{collections::BTreeSet, str::FromStr};

    use super::*;
    use crate::{
        ActivationStateV1, AuthorityClassV1, ModuleGrantV1, ModuleRegistryV1,
        RegistryPolicyV1, node_legacy_adapter_manifest_v1,
    };

    fn digest(marker: char) -> Sha256Digest {
        Sha256Digest::from_str(&format!("sha256:{}", marker.to_string().repeat(64)))
            .expect("test digest")
    }

    fn binding() -> LegacyCapabilityBindingV1 {
        LegacyCapabilityBindingV1 {
            version: 1,
            capability_id: "CAP-CMP-LEGACY".to_owned(),
            decision_group: "legacy-compatibility".to_owned(),
            singleton_reason: "incumbent-node-shadow".to_owned(),
            node_entrypoint: "core/legacy-entrypoint.mjs".to_owned(),
            node_entrypoint_hash: digest('1'),
            node_contract_hash: digest('2'),
            translation_policy_hash: digest('3'),
            parity_class: LegacyParityClassV1::Exact,
            resources: ResourceVectorV1 {
                cpu_millis: 10,
                memory_bytes: 1_024,
                storage_bytes: 2_048,
                provider_calls: 1,
                ..ResourceVectorV1::default()
            },
            utility_micros: 100,
            cost_microusd: 50,
            uncertainty_ppm: 1_000,
            evidence_tier: QualificationTierV1::Source,
        }
    }

    fn planning_request() -> PlanningRequestV1 {
        PlanningRequestV1 {
            envelope: ProtocolEnvelopeV1 {
                version: 1,
                kind: ProtocolObjectKindV1::PlanningRequest,
                request_id: "planning-request-1".to_owned(),
                created_at_unix_ms: 10,
                expires_at_unix_ms: 1_000,
                module_id: NODE_LEGACY_ADAPTER_MODULE_ID_V1.to_owned(),
                module_version: "1.0.0".to_owned(),
                protocol_version: 1,
                trace_id: "trace-1".to_owned(),
                payload_hash: digest('4'),
            },
            planning_request_id: "planning-1".to_owned(),
            state_snapshot_hash: digest('5'),
            capability_id: "CAP-CMP-LEGACY".to_owned(),
            hard_constraint_set_hash: digest('6'),
            objective_version: "objective-1".to_owned(),
            resource_price_snapshot_hash: digest('7'),
            candidate_limit: 1,
            deadline_unix_ms: 900,
            allowed_side_effect_classes: BTreeSet::from([
                SideEffectClassV1::NoSideEffect,
                SideEffectClassV1::WorkspaceLocal,
                SideEffectClassV1::PreparedResult,
            ]),
            input_artifact_hashes: vec![digest('8')],
        }
    }

    fn command(candidate: &ActionCandidateV1) -> ExecutionCommandV1 {
        ExecutionCommandV1 {
            envelope: ProtocolEnvelopeV1 {
                version: 1,
                kind: ProtocolObjectKindV1::ExecutionCommand,
                request_id: "execution-command-1".to_owned(),
                created_at_unix_ms: 20,
                expires_at_unix_ms: 1_000,
                module_id: NODE_LEGACY_ADAPTER_MODULE_ID_V1.to_owned(),
                module_version: "1.0.0".to_owned(),
                protocol_version: 1,
                trace_id: "trace-1".to_owned(),
                payload_hash: candidate.candidate_hash().expect("candidate hash"),
            },
            execution_id: "execution-1".to_owned(),
            plan_hash: digest('9'),
            selected_candidate_hash: candidate.candidate_hash().expect("candidate hash"),
            state_snapshot_hash: candidate.snapshot_hash.clone(),
            campaign_id: "campaign-1".to_owned(),
            node_id: "node-1".to_owned(),
            attempt_id: "attempt-1".to_owned(),
            lease_generation: 1,
            writer_generation: 1,
            resource_reservation_id: "reservation-1".to_owned(),
            resource_reservation_hash: digest('a'),
            resource_envelope: candidate.resources,
            deadline_unix_ms: 900,
            cancellation_id: "cancel-1".to_owned(),
            authority_audience: candidate.capability_id.clone(),
            idempotency_key: "idempotency-1".to_owned(),
            input_artifact_hashes: vec![digest('8')],
        }
    }

    fn registry(binding: &LegacyCapabilityBindingV1) -> crate::ModuleRegistryArtifactV1 {
        let manifest = node_legacy_adapter_manifest_v1(
            "1.0.0",
            "0.9.0",
            binding.binding_hash().expect("binding hash"),
            binding.node_contract_hash.clone(),
        );
        let policy = RegistryPolicyV1 {
            version: 1,
            protocol_version: 1,
            central_writer_module_id: "module.commit-sequencer".to_owned(),
            grants: BTreeMap::from([(
                NODE_LEGACY_ADAPTER_MODULE_ID_V1.to_owned(),
                ModuleGrantV1 {
                    module_version: "1.0.0".to_owned(),
                    authority: AuthorityClassV1::PreparedResultOnly,
                    minimum_qualification: QualificationTierV1::Source,
                    activation: ActivationStateV1::Shadow,
                    capability_ids: BTreeSet::from([
                        "CAP-CMP-LEGACY".to_owned(),
                        "CAP-MOD-CANDIDATES".to_owned(),
                        "CAP-MOD-EXECUTION".to_owned(),
                    ]),
                },
            )]),
        };
        let mut registry = ModuleRegistryV1::new(policy).expect("policy");
        registry.register(manifest).expect("manifest");
        registry.finish().expect("registry")
    }

    fn observation(invocation: &LegacyNodeInvocationV1) -> LegacyNodeObservationV1 {
        LegacyNodeObservationV1 {
            version: 1,
            invocation_hash: invocation.invocation_hash.clone(),
            execution_id: invocation.execution_id.clone(),
            attempt_id: invocation.attempt_id.clone(),
            idempotency_key: invocation.idempotency_key.clone(),
            status: PreparedResultStatusV1::Prepared,
            artifact_hashes: vec![digest('b')],
            actual_resources: ResourceVectorV1 {
                cpu_millis: 8,
                memory_bytes: 900,
                storage_bytes: 1_500,
                provider_calls: 1,
                ..ResourceVectorV1::default()
            },
            actual_cost_microusd: 40,
            output_projection_hash: digest('c'),
            translation_evidence_hash: digest('d'),
            observed_at_unix_ms: 100,
            irreversible_external_action_may_have_started: false,
            central_state_write_observed: false,
        }
    }

    fn reserved_invocation(
        adapter: &mut NodeLegacyAdapterV1,
        candidate: &ActionCandidateV1,
        command: &ExecutionCommandV1,
    ) -> LegacyNodeInvocationV1 {
        match adapter
            .reserve_execution(candidate, command, &command.plan_hash, 20)
            .expect("reserve")
        {
            LegacyReservationOutcomeV1::Reserved(value) => *value,
            other => panic!("unexpected reservation: {other:?}"),
        }
    }

    #[test]
    fn plan_builds_a_registry_valid_candidate() {
        let binding = binding();
        let adapter = NodeLegacyAdapterV1::new("1.0.0".to_owned(), vec![binding.clone()])
            .expect("adapter");
        let request = planning_request();
        let (response, receipt) = adapter.plan(&request, 20).expect("plan");
        response
            .validate(&request, &registry(&binding), 20)
            .expect("response");
        assert_eq!(response.candidates.len(), 1);
        assert_eq!(response.candidates[0].resources.external_actions, 0);
        assert_eq!(response.candidates[0].resources.central_writer_turns, 0);
        assert!(!receipt.grants_authority);
    }

    #[test]
    fn execution_and_exact_replay_are_idempotent() {
        let mut adapter =
            NodeLegacyAdapterV1::new("1.0.0".to_owned(), vec![binding()]).expect("adapter");
        let (response, _) = adapter.plan(&planning_request(), 20).expect("plan");
        let candidate = response.candidates[0].clone();
        let command = command(&candidate);
        let invocation = reserved_invocation(&mut adapter, &candidate, &command);
        assert!(matches!(
            adapter
                .reserve_execution(&candidate, &command, &command.plan_hash, 20)
                .expect("duplicate reserve"),
            LegacyReservationOutcomeV1::ExistingReservation(_)
        ));
        assert!(matches!(
            adapter
                .begin_execution(&command.idempotency_key, &invocation.invocation_hash)
                .expect("begin"),
            LegacyBeginOutcomeV1::Execute(_)
        ));
        let observation = observation(&invocation);
        let first = adapter.complete_execution(&observation).expect("complete");
        let replay = adapter.complete_execution(&observation).expect("replay");
        assert_eq!(first, replay);
        assert!(!first.1.grants_authority);
        assert!(!first.1.central_state_write_observed);
    }

    #[test]
    fn conflicting_replays_fail_closed() {
        let mut adapter =
            NodeLegacyAdapterV1::new("1.0.0".to_owned(), vec![binding()]).expect("adapter");
        let (response, _) = adapter.plan(&planning_request(), 20).expect("plan");
        let candidate = response.candidates[0].clone();
        let command = command(&candidate);
        let invocation = reserved_invocation(&mut adapter, &candidate, &command);
        adapter
            .begin_execution(&command.idempotency_key, &invocation.invocation_hash)
            .expect("begin");
        let observation = observation(&invocation);
        adapter.complete_execution(&observation).expect("complete");
        let mut changed = observation;
        changed.output_projection_hash = digest('e');
        assert_eq!(
            adapter.complete_execution(&changed),
            Err(LegacyAdapterError::ObservationConflict)
        );
        let mut changed_command = command.clone();
        changed_command.resource_reservation_hash = digest('f');
        assert_eq!(
            adapter.reserve_execution(
                &candidate,
                &changed_command,
                &changed_command.plan_hash,
                20,
            ),
            Err(LegacyAdapterError::IdempotencyConflict)
        );
    }

    #[test]
    fn authority_claims_are_rejected() {
        let mut adapter =
            NodeLegacyAdapterV1::new("1.0.0".to_owned(), vec![binding()]).expect("adapter");
        let (response, _) = adapter.plan(&planning_request(), 20).expect("plan");
        let candidate = response.candidates[0].clone();
        let command = command(&candidate);
        let invocation = reserved_invocation(&mut adapter, &candidate, &command);
        adapter
            .begin_execution(&command.idempotency_key, &invocation.invocation_hash)
            .expect("begin");
        let mut observed = observation(&invocation);
        observed.central_state_write_observed = true;
        assert_eq!(
            adapter.complete_execution(&observed),
            Err(LegacyAdapterError::ObservationInvalid)
        );
        let mut request = planning_request();
        request
            .allowed_side_effect_classes
            .insert(SideEffectClassV1::CentralStateCommit);
        assert_eq!(
            adapter.plan(&request, 20),
            Err(LegacyAdapterError::AuthorityEscalation)
        );
    }

    #[test]
    fn cancellation_never_infers_terminal_success() {
        let mut adapter =
            NodeLegacyAdapterV1::new("1.0.0".to_owned(), vec![binding()]).expect("adapter");
        let (response, _) = adapter.plan(&planning_request(), 20).expect("plan");
        let candidate = response.candidates[0].clone();
        let command = command(&candidate);
        let invocation = reserved_invocation(&mut adapter, &candidate, &command);
        let cancellation = |execution_id: &str, command_hash: Sha256Digest| {
            CancellationRequestV1 {
                envelope: ProtocolEnvelopeV1 {
                    version: 1,
                    kind: ProtocolObjectKindV1::CancellationRequest,
                    request_id: format!("cancel-{execution_id}"),
                    created_at_unix_ms: 30,
                    expires_at_unix_ms: 1_000,
                    module_id: NODE_LEGACY_ADAPTER_MODULE_ID_V1.to_owned(),
                    module_version: "1.0.0".to_owned(),
                    protocol_version: 1,
                    trace_id: "trace-1".to_owned(),
                    payload_hash: command_hash.clone(),
                },
                execution_id: execution_id.to_owned(),
                execution_command_hash: command_hash,
                idempotency_key: format!("cancel-key-{execution_id}"),
            }
        };
        let unknown = cancellation("missing", digest('0'));
        assert_eq!(
            adapter.cancel(&unknown, 30).expect("unknown").disposition,
            CancellationDispositionV1::UnknownRequiresReconciliation
        );
        let reserved = cancellation(
            &command.execution_id,
            command.command_hash().expect("command hash"),
        );
        assert_eq!(
            adapter.cancel(&reserved, 30).expect("reserved").disposition,
            CancellationDispositionV1::CancelledBeforeExecution
        );
        assert!(matches!(
            adapter
                .begin_execution(&command.idempotency_key, &invocation.invocation_hash)
                .expect("cancelled begin"),
            LegacyBeginOutcomeV1::Cancelled
        ));
    }
}
