use std::collections::BTreeSet;

use hepta_codex_protocol::Sha256Digest;
use serde::{Deserialize, Serialize, de::DeserializeOwned};

use crate::{
    ActionCandidateV1, MAXIMUM_CANDIDATES_V1, MODULE_PROTOCOL_VERSION_V1, ModulePlatformError,
    ModuleRegistryArtifactV1, PreparedResultV1, ResourceVectorV1,
    hash::canonical_hash,
    types::{
        duplicate_digests, is_strictly_sorted, valid_capability_id, valid_identifier,
        valid_module_id, valid_semver,
    },
};

/// Maximum accepted canonical JSON message size.
pub const MAXIMUM_PROTOCOL_OBJECT_BYTES_V1: usize = 1_048_576;
/// Maximum lifetime of one online module protocol object.
pub const MAXIMUM_PROTOCOL_LIFETIME_MS_V1: u64 = 86_400_000;
/// Maximum immutable artifact references in one protocol object.
pub const MAXIMUM_PROTOCOL_ARTIFACTS_V1: usize = 1_024;

/// Semantic kind carried by every protocol envelope.
#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProtocolObjectKindV1 {
    /// Candidate-generation request.
    PlanningRequest,
    /// Bounded candidate response.
    PlanningResponse,
    /// Exact admitted execution command.
    ExecutionCommand,
    /// Identity-bound cancellation request.
    CancellationRequest,
    /// Conservative cancellation acknowledgement.
    CancellationAcknowledgement,
    /// Bounded module-health observation.
    HealthReport,
}

/// Side-effect classes admitted by a planning request.
#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SideEffectClassV1 {
    /// Pure or read-only work.
    NoSideEffect,
    /// Mutation confined to an attempt workspace.
    WorkspaceLocal,
    /// Creation of an immutable prepared result.
    PreparedResult,
    /// Reversible external effect with an authoritative reconciliation path.
    ExternalReversible,
    /// Irreversible external effect.
    ExternalIrreversible,
    /// Authoritative central-state commit.
    CentralStateCommit,
}

/// Common bounded identity envelope for transport-independent protocol objects.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProtocolEnvelopeV1 {
    /// Contract version.
    pub version: u16,
    /// Semantic object kind.
    pub kind: ProtocolObjectKindV1,
    /// Stable request/message identity.
    pub request_id: String,
    /// Creation time observed by the trusted caller.
    pub created_at_unix_ms: u64,
    /// Expiry time after which the object is unusable.
    pub expires_at_unix_ms: u64,
    /// Exact module identity.
    pub module_id: String,
    /// Exact module semantic version.
    pub module_version: String,
    /// Active module protocol version.
    pub protocol_version: u16,
    /// Cross-plane trace identity.
    pub trace_id: String,
    /// Hash of the object-specific payload or referenced immutable subject.
    pub payload_hash: Sha256Digest,
}

impl ProtocolEnvelopeV1 {
    /// Validates identity, time, kind, and protocol bounds.
    pub fn validate(
        &self,
        expected_kind: ProtocolObjectKindV1,
        now_unix_ms: u64,
    ) -> Result<(), ModulePlatformError> {
        let lifetime = self
            .expires_at_unix_ms
            .checked_sub(self.created_at_unix_ms)
            .ok_or(ModulePlatformError::ProtocolInvalid)?;
        if self.version != MODULE_PROTOCOL_VERSION_V1
            || self.kind != expected_kind
            || !valid_identifier(&self.request_id)
            || !valid_module_id(&self.module_id)
            || !valid_semver(&self.module_version)
            || self.protocol_version != MODULE_PROTOCOL_VERSION_V1
            || !valid_identifier(&self.trace_id)
            || self.created_at_unix_ms > now_unix_ms
            || now_unix_ms >= self.expires_at_unix_ms
            || lifetime == 0
            || lifetime > MAXIMUM_PROTOCOL_LIFETIME_MS_V1
        {
            return Err(ModulePlatformError::ProtocolInvalid);
        }
        Ok(())
    }
}

/// Bounded candidate-generation request.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlanningRequestV1 {
    /// Common request identity.
    pub envelope: ProtocolEnvelopeV1,
    /// Stable planning-request identity used by every returned candidate.
    pub planning_request_id: String,
    /// Immutable control-plane snapshot hash.
    pub state_snapshot_hash: Sha256Digest,
    /// Capability requested from the module.
    pub capability_id: String,
    /// Exact hard-constraint set hash.
    pub hard_constraint_set_hash: Sha256Digest,
    /// Versioned global objective identifier.
    pub objective_version: String,
    /// Exact resource-price snapshot hash.
    pub resource_price_snapshot_hash: Sha256Digest,
    /// Hard maximum number of candidates accepted from this module.
    pub candidate_limit: u32,
    /// Planning deadline, bounded by the envelope expiry.
    pub deadline_unix_ms: u64,
    /// Explicit side-effect classes the caller permits candidates to declare.
    pub allowed_side_effect_classes: BTreeSet<SideEffectClassV1>,
    /// Sorted, unique immutable input artifacts.
    pub input_artifact_hashes: Vec<Sha256Digest>,
}

impl PlanningRequestV1 {
    /// Validates the complete planning request.
    pub fn validate(&self, now_unix_ms: u64) -> Result<(), ModulePlatformError> {
        self.envelope
            .validate(ProtocolObjectKindV1::PlanningRequest, now_unix_ms)?;
        let candidate_limit = usize::try_from(self.candidate_limit)
            .map_err(|_| ModulePlatformError::ProtocolInvalid)?;
        if !valid_identifier(&self.planning_request_id)
            || !valid_capability_id(&self.capability_id)
            || !valid_identifier(&self.objective_version)
            || candidate_limit == 0
            || candidate_limit > MAXIMUM_CANDIDATES_V1
            || self.deadline_unix_ms < now_unix_ms
            || self.deadline_unix_ms > self.envelope.expires_at_unix_ms
            || self.allowed_side_effect_classes.is_empty()
            || self.input_artifact_hashes.len() > MAXIMUM_PROTOCOL_ARTIFACTS_V1
            || duplicate_digests(&self.input_artifact_hashes)
            || !is_strictly_sorted(&self.input_artifact_hashes)
        {
            return Err(ModulePlatformError::ProtocolInvalid);
        }
        Ok(())
    }

    /// Returns the canonical request hash.
    pub fn request_hash(&self) -> Result<Sha256Digest, ModulePlatformError> {
        canonical_hash(self)
    }
}

/// Bounded candidate response from one exact module version.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlanningResponseV1 {
    /// Common response identity.
    pub envelope: ProtocolEnvelopeV1,
    /// Exact hash of the request being answered.
    pub planning_request_hash: Sha256Digest,
    /// Strictly candidate-ID-sorted feasible alternatives.
    pub candidates: Vec<ActionCandidateV1>,
    /// Required reason when a module exposes only one feasible candidate.
    pub singleton_reason: Option<String>,
}

impl PlanningResponseV1 {
    /// Validates the response against the request and qualified registry.
    pub fn validate(
        &self,
        request: &PlanningRequestV1,
        registry: &ModuleRegistryArtifactV1,
        now_unix_ms: u64,
    ) -> Result<(), ModulePlatformError> {
        request.validate(now_unix_ms)?;
        self.envelope
            .validate(ProtocolObjectKindV1::PlanningResponse, now_unix_ms)?;
        let candidate_limit = usize::try_from(request.candidate_limit)
            .map_err(|_| ModulePlatformError::ProtocolInvalid)?;
        if self.planning_request_hash != request.request_hash()?
            || self.envelope.module_id != request.envelope.module_id
            || self.envelope.module_version != request.envelope.module_version
            || self.candidates.is_empty()
            || self.candidates.len() > candidate_limit
            || self.candidates.len() > MAXIMUM_CANDIDATES_V1
            || !self
                .candidates
                .windows(2)
                .all(|window| window[0].candidate_id < window[1].candidate_id)
            || (self.candidates.len() == 1
                && !self
                    .singleton_reason
                    .as_deref()
                    .is_some_and(valid_identifier))
            || (self.candidates.len() != 1 && self.singleton_reason.is_some())
        {
            return Err(ModulePlatformError::ProtocolInvalid);
        }
        for candidate in &self.candidates {
            if candidate.module_id != self.envelope.module_id
                || candidate.module_version != self.envelope.module_version
                || candidate.capability_id != request.capability_id
                || candidate.snapshot_hash != request.state_snapshot_hash
            {
                return Err(ModulePlatformError::CandidateBindingInvalid);
            }
            candidate.validate(registry, &request.state_snapshot_hash)?;
        }
        Ok(())
    }

    /// Returns the canonical response hash.
    pub fn response_hash(&self) -> Result<Sha256Digest, ModulePlatformError> {
        canonical_hash(self)
    }
}

/// Exact execution command emitted only after planning and resource admission.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExecutionCommandV1 {
    /// Common command identity.
    pub envelope: ProtocolEnvelopeV1,
    /// Stable execution identity.
    pub execution_id: String,
    /// Exact selected plan hash.
    pub plan_hash: Sha256Digest,
    /// Exact selected candidate hash.
    pub selected_candidate_hash: Sha256Digest,
    /// Exact immutable snapshot hash.
    pub state_snapshot_hash: Sha256Digest,
    /// Campaign identity.
    pub campaign_id: String,
    /// DAG node identity.
    pub node_id: String,
    /// Attempt identity.
    pub attempt_id: String,
    /// Attempt lease generation.
    pub lease_generation: u64,
    /// Current writer generation copied into the command subject.
    pub writer_generation: u64,
    /// Exact resource-reservation identity.
    pub resource_reservation_id: String,
    /// Exact resource-reservation hash.
    pub resource_reservation_hash: Sha256Digest,
    /// Hard execution resource envelope.
    pub resource_envelope: ResourceVectorV1,
    /// Execution deadline.
    pub deadline_unix_ms: u64,
    /// Identity-bound cancellation channel.
    pub cancellation_id: String,
    /// Capability audience granted to the module.
    pub authority_audience: String,
    /// Stable idempotency identity established before execution.
    pub idempotency_key: String,
    /// Sorted immutable input artifact references.
    pub input_artifact_hashes: Vec<Sha256Digest>,
}

impl ExecutionCommandV1 {
    /// Validates exact candidate, module, authority, time, and resource bindings.
    pub fn validate(
        &self,
        candidate: &ActionCandidateV1,
        expected_plan_hash: &Sha256Digest,
        now_unix_ms: u64,
    ) -> Result<(), ModulePlatformError> {
        self.envelope
            .validate(ProtocolObjectKindV1::ExecutionCommand, now_unix_ms)?;
        if !valid_identifier(&self.execution_id)
            || self.plan_hash != *expected_plan_hash
            || self.selected_candidate_hash != candidate.candidate_hash()?
            || self.state_snapshot_hash != candidate.snapshot_hash
            || self.envelope.module_id != candidate.module_id
            || self.envelope.module_version != candidate.module_version
            || !valid_identifier(&self.campaign_id)
            || !valid_identifier(&self.node_id)
            || !valid_identifier(&self.attempt_id)
            || self.lease_generation == 0
            || self.writer_generation == 0
            || !valid_identifier(&self.resource_reservation_id)
            || self.resource_envelope != candidate.resources
            || self.deadline_unix_ms < now_unix_ms
            || self.deadline_unix_ms > self.envelope.expires_at_unix_ms
            || !valid_identifier(&self.cancellation_id)
            || self.authority_audience != candidate.capability_id
            || !valid_identifier(&self.idempotency_key)
            || self.input_artifact_hashes.len() > MAXIMUM_PROTOCOL_ARTIFACTS_V1
            || duplicate_digests(&self.input_artifact_hashes)
            || !is_strictly_sorted(&self.input_artifact_hashes)
        {
            return Err(ModulePlatformError::ProtocolInvalid);
        }
        Ok(())
    }

    /// Returns the canonical execution-command hash.
    pub fn command_hash(&self) -> Result<Sha256Digest, ModulePlatformError> {
        canonical_hash(self)
    }
}

/// Identity-bound cancellation request.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CancellationRequestV1 {
    /// Common request identity.
    pub envelope: ProtocolEnvelopeV1,
    /// Exact execution identity.
    pub execution_id: String,
    /// Original command hash.
    pub execution_command_hash: Sha256Digest,
    /// Stable cancellation idempotency key.
    pub idempotency_key: String,
}

impl CancellationRequestV1 {
    /// Validates a live cancellation request.
    pub fn validate(&self, now_unix_ms: u64) -> Result<(), ModulePlatformError> {
        self.envelope
            .validate(ProtocolObjectKindV1::CancellationRequest, now_unix_ms)?;
        if !valid_identifier(&self.execution_id) || !valid_identifier(&self.idempotency_key) {
            return Err(ModulePlatformError::CancellationInvalid);
        }
        Ok(())
    }

    /// Returns the canonical cancellation-request hash.
    pub fn request_hash(&self) -> Result<Sha256Digest, ModulePlatformError> {
        canonical_hash(self)
    }
}

/// Conservative cancellation outcome.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CancellationDispositionV1 {
    /// Execution never started.
    CancelledBeforeExecution,
    /// Execution started, but no external effect may have started.
    CancelledBeforeExternalEffect,
    /// An external effect may have started and requires reconciliation.
    ExternalEffectMayHaveStarted,
    /// A prepared result already exists.
    PreparedResultAlreadyExists,
    /// The result is already authoritatively committed.
    TerminalAlreadyCommitted,
    /// State cannot be classified without authoritative reconciliation.
    UnknownRequiresReconciliation,
}

/// Cancellation acknowledgement that never infers success from timeout or absence.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CancellationAcknowledgementV1 {
    /// Common response identity.
    pub envelope: ProtocolEnvelopeV1,
    /// Exact cancellation-request hash.
    pub cancellation_request_hash: Sha256Digest,
    /// Exact execution identity.
    pub execution_id: String,
    /// Conservative terminal disposition.
    pub disposition: CancellationDispositionV1,
    /// Exact prepared result when it already exists.
    pub prepared_result: Option<PreparedResultV1>,
}

impl CancellationAcknowledgementV1 {
    /// Validates request binding and disposition-specific evidence.
    pub fn validate(
        &self,
        request: &CancellationRequestV1,
        now_unix_ms: u64,
    ) -> Result<(), ModulePlatformError> {
        request.validate(now_unix_ms)?;
        self.envelope.validate(
            ProtocolObjectKindV1::CancellationAcknowledgement,
            now_unix_ms,
        )?;
        let prepared_required =
            self.disposition == CancellationDispositionV1::PreparedResultAlreadyExists;
        if self.cancellation_request_hash != request.request_hash()?
            || self.execution_id != request.execution_id
            || self.envelope.module_id != request.envelope.module_id
            || self.envelope.module_version != request.envelope.module_version
            || prepared_required != self.prepared_result.is_some()
        {
            return Err(ModulePlatformError::CancellationInvalid);
        }
        Ok(())
    }
}

/// Serializes a protocol object and enforces its hard wire-size ceiling.
pub fn to_canonical_protocol_json_v1<T: Serialize + ?Sized>(
    value: &T,
) -> Result<Vec<u8>, ModulePlatformError> {
    let bytes = serde_json::to_vec(value).map_err(|_| ModulePlatformError::EncodingInvalid)?;
    if bytes.is_empty() || bytes.len() > MAXIMUM_PROTOCOL_OBJECT_BYTES_V1 {
        return Err(ModulePlatformError::ProtocolSizeExceeded);
    }
    Ok(bytes)
}

/// Decodes only exact canonical JSON with strict object shapes.
pub fn decode_canonical_protocol_json_v1<T>(bytes: &[u8]) -> Result<T, ModulePlatformError>
where
    T: DeserializeOwned + Serialize,
{
    if bytes.is_empty() || bytes.len() > MAXIMUM_PROTOCOL_OBJECT_BYTES_V1 {
        return Err(ModulePlatformError::ProtocolSizeExceeded);
    }
    let value =
        serde_json::from_slice::<T>(bytes).map_err(|_| ModulePlatformError::ProtocolInvalid)?;
    if to_canonical_protocol_json_v1(&value)? != bytes {
        return Err(ModulePlatformError::ProtocolInvalid);
    }
    Ok(value)
}

/// Returns a canonical digest for a public protocol object.
pub fn module_protocol_hash_v1<T: Serialize + ?Sized>(
    value: &T,
) -> Result<Sha256Digest, ModulePlatformError> {
    canonical_hash(value)
}
