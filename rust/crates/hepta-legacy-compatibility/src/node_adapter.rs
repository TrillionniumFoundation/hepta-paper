use std::collections::{BTreeMap, BTreeSet};
use std::str::FromStr;

use hepta_codex_protocol::Sha256Digest;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;

/// Current source contract version for the bounded Node observation adapter.
pub const NODE_LEGACY_ADAPTER_VERSION_V1: u16 = 1;
/// Hard ceiling for one observed output. Deployments may configure a lower limit.
pub const MAXIMUM_NODE_OBSERVATION_BYTES_V1: usize = 16 * 1024 * 1024;
/// Hard ceiling for content-addressed artifacts in one observation.
pub const MAXIMUM_NODE_OBSERVATION_ARTIFACTS_V1: usize = 1_024;
/// Maximum accepted lifetime for one frozen observation.
pub const MAXIMUM_NODE_OBSERVATION_LIFETIME_MS_V1: u64 = 24 * 60 * 60 * 1_000;

/// Declared compatibility class for one frozen Node observation.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum NodeLegacyParityClassV1 {
    /// Byte-identical output and identity semantics.
    Exact,
    /// Semantically equivalent output under an independently versioned policy.
    Semantic,
    /// Equivalence is decided by a separately owned evaluation record.
    EvaluationBased,
}

/// Authority facts observed at the legacy boundary.
///
/// Every field must remain false. The adapter is deliberately incapable of
/// converting a writer/provider/external-effect observation into a prepared
/// result.
#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NodeLegacyAuthorityObservationV1 {
    /// A central campaign-state writer was reachable.
    pub central_writer_reachable: bool,
    /// A provider credential or dispatch handle was reachable.
    pub provider_dispatch_reachable: bool,
    /// A release or submission handle was reachable.
    pub external_effect_reachable: bool,
    /// An irreversible action may already have started.
    pub external_action_may_have_started: bool,
}

impl NodeLegacyAuthorityObservationV1 {
    fn is_empty(self) -> bool {
        !self.central_writer_reachable
            && !self.provider_dispatch_reachable
            && !self.external_effect_reachable
            && !self.external_action_may_have_started
    }
}

/// Frozen, already-produced Node result presented to the Rust migration boundary.
///
/// This type is data only. The adapter never starts Node, reads credentials,
/// opens a writer, or performs an external action.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NodeLegacyObservationV1 {
    /// Contract version.
    pub version: u16,
    /// Stable idempotency identity for the logical operation.
    pub operation_id: String,
    /// Exact attempt identity.
    pub attempt_id: String,
    /// Campaign/read-model identity.
    pub campaign_id: String,
    /// Capability exposed through Module Protocol V1.
    pub capability_id: String,
    /// Registered legacy module identity.
    pub module_id: String,
    /// Exact legacy module version.
    pub module_version: String,
    /// Frozen Node runtime binary/profile hash.
    pub node_runtime_hash: Sha256Digest,
    /// Frozen Node entrypoint/source hash.
    pub node_entrypoint_hash: Sha256Digest,
    /// Legacy authoritative state revision observed by the caller.
    pub legacy_state_revision: u64,
    /// Immutable planning snapshot identity.
    pub snapshot_hash: Sha256Digest,
    /// Exact planning request identity.
    pub planning_request_hash: Sha256Digest,
    /// Exact selected plan identity.
    pub plan_hash: Sha256Digest,
    /// Exact source candidate identity.
    pub candidate_hash: Sha256Digest,
    /// Exact canonical input identity.
    pub input_hash: Sha256Digest,
    /// Frozen output bytes. These are hashed and are not interpreted as code.
    pub output_bytes: Vec<u8>,
    /// Caller-declared hash of the frozen output bytes.
    pub output_hash: Sha256Digest,
    /// Sorted, unique content-addressed artifact identities.
    pub artifact_hashes: Vec<Sha256Digest>,
    /// Compatibility class requested for this result.
    pub parity_class: NodeLegacyParityClassV1,
    /// Independently produced evidence/policy identity for the parity claim.
    pub parity_evidence_hash: Sha256Digest,
    /// Explicit observation time supplied by the caller.
    pub observed_at_unix_ms: u64,
    /// Hard expiry for this exact observation.
    pub expires_at_unix_ms: u64,
    /// Authority facts. All must be false.
    pub authority: NodeLegacyAuthorityObservationV1,
}

/// Non-authorizing prepared observation emitted by the adapter.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NodeLegacyPreparedObservationV1 {
    /// Contract version.
    pub version: u16,
    /// Stable operation identity.
    pub operation_id: String,
    /// Exact attempt identity.
    pub attempt_id: String,
    /// Campaign/read-model identity.
    pub campaign_id: String,
    /// Exposed capability.
    pub capability_id: String,
    /// Producing legacy module.
    pub module_id: String,
    /// Producing legacy version.
    pub module_version: String,
    /// Frozen runtime identity.
    pub node_runtime_hash: Sha256Digest,
    /// Frozen entrypoint identity.
    pub node_entrypoint_hash: Sha256Digest,
    /// Exact legacy state revision.
    pub legacy_state_revision: u64,
    /// Immutable planning snapshot identity.
    pub snapshot_hash: Sha256Digest,
    /// Exact planning request identity.
    pub planning_request_hash: Sha256Digest,
    /// Exact selected plan identity.
    pub plan_hash: Sha256Digest,
    /// Exact source candidate identity.
    pub candidate_hash: Sha256Digest,
    /// Exact canonical input identity.
    pub input_hash: Sha256Digest,
    /// Hash of the frozen output bytes.
    pub output_hash: Sha256Digest,
    /// Output byte count.
    pub output_bytes: usize,
    /// Sorted content-addressed artifacts.
    pub artifact_hashes: Vec<Sha256Digest>,
    /// Declared compatibility class.
    pub parity_class: NodeLegacyParityClassV1,
    /// Independently owned parity evidence/policy identity.
    pub parity_evidence_hash: Sha256Digest,
    /// Original observation time.
    pub observed_at_unix_ms: u64,
    /// Original expiry.
    pub expires_at_unix_ms: u64,
    /// This adapter never grants campaign-state authority.
    pub central_writer_authorized: bool,
    /// This adapter never grants provider dispatch.
    pub provider_dispatch_authorized: bool,
    /// This adapter never grants release/submission effects.
    pub external_effect_authorized: bool,
    /// Canonical receipt hash over all preceding fields.
    pub receipt_hash: Sha256Digest,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct RecordedObservationV1 {
    input_fingerprint: Sha256Digest,
    result: NodeLegacyPreparedObservationV1,
}

/// Bounded idempotent adapter for already-produced Node observations.
#[derive(Clone, Debug)]
pub struct NodeLegacyAdapterV1 {
    maximum_output_bytes: usize,
    maximum_artifacts: usize,
    records: BTreeMap<String, RecordedObservationV1>,
}

impl NodeLegacyAdapterV1 {
    /// Creates an adapter with deployment limits no wider than the protocol ceilings.
    pub fn new(
        maximum_output_bytes: usize,
        maximum_artifacts: usize,
    ) -> Result<Self, NodeLegacyAdapterError> {
        if maximum_output_bytes == 0
            || maximum_output_bytes > MAXIMUM_NODE_OBSERVATION_BYTES_V1
            || maximum_artifacts == 0
            || maximum_artifacts > MAXIMUM_NODE_OBSERVATION_ARTIFACTS_V1
        {
            return Err(NodeLegacyAdapterError::PolicyInvalid);
        }
        Ok(Self {
            maximum_output_bytes,
            maximum_artifacts,
            records: BTreeMap::new(),
        })
    }

    /// Validates and records one frozen observation.
    ///
    /// Exact replays return the original receipt. Reuse of an operation identity
    /// with any different byte or identity is rejected.
    pub fn observe(
        &mut self,
        observation: NodeLegacyObservationV1,
        now_unix_ms: u64,
    ) -> Result<NodeLegacyPreparedObservationV1, NodeLegacyAdapterError> {
        validate_observation(
            &observation,
            now_unix_ms,
            self.maximum_output_bytes,
            self.maximum_artifacts,
        )?;
        let fingerprint = canonical_digest(&observation)?;
        if let Some(recorded) = self.records.get(&observation.operation_id) {
            if recorded.input_fingerprint == fingerprint {
                return Ok(recorded.result.clone());
            }
            return Err(NodeLegacyAdapterError::ReplayConflict);
        }

        let body = NodeLegacyPreparedObservationBodyV1 {
            version: NODE_LEGACY_ADAPTER_VERSION_V1,
            operation_id: observation.operation_id.clone(),
            attempt_id: observation.attempt_id.clone(),
            campaign_id: observation.campaign_id.clone(),
            capability_id: observation.capability_id.clone(),
            module_id: observation.module_id.clone(),
            module_version: observation.module_version.clone(),
            node_runtime_hash: observation.node_runtime_hash.clone(),
            node_entrypoint_hash: observation.node_entrypoint_hash.clone(),
            legacy_state_revision: observation.legacy_state_revision,
            snapshot_hash: observation.snapshot_hash.clone(),
            planning_request_hash: observation.planning_request_hash.clone(),
            plan_hash: observation.plan_hash.clone(),
            candidate_hash: observation.candidate_hash.clone(),
            input_hash: observation.input_hash.clone(),
            output_hash: observation.output_hash.clone(),
            output_bytes: observation.output_bytes.len(),
            artifact_hashes: observation.artifact_hashes.clone(),
            parity_class: observation.parity_class,
            parity_evidence_hash: observation.parity_evidence_hash.clone(),
            observed_at_unix_ms: observation.observed_at_unix_ms,
            expires_at_unix_ms: observation.expires_at_unix_ms,
            central_writer_authorized: false,
            provider_dispatch_authorized: false,
            external_effect_authorized: false,
        };
        let receipt_hash = canonical_digest(&body)?;
        let result = NodeLegacyPreparedObservationV1 {
            version: body.version,
            operation_id: body.operation_id,
            attempt_id: body.attempt_id,
            campaign_id: body.campaign_id,
            capability_id: body.capability_id,
            module_id: body.module_id,
            module_version: body.module_version,
            node_runtime_hash: body.node_runtime_hash,
            node_entrypoint_hash: body.node_entrypoint_hash,
            legacy_state_revision: body.legacy_state_revision,
            snapshot_hash: body.snapshot_hash,
            planning_request_hash: body.planning_request_hash,
            plan_hash: body.plan_hash,
            candidate_hash: body.candidate_hash,
            input_hash: body.input_hash,
            output_hash: body.output_hash,
            output_bytes: body.output_bytes,
            artifact_hashes: body.artifact_hashes,
            parity_class: body.parity_class,
            parity_evidence_hash: body.parity_evidence_hash,
            observed_at_unix_ms: body.observed_at_unix_ms,
            expires_at_unix_ms: body.expires_at_unix_ms,
            central_writer_authorized: body.central_writer_authorized,
            provider_dispatch_authorized: body.provider_dispatch_authorized,
            external_effect_authorized: body.external_effect_authorized,
            receipt_hash,
        };
        self.records.insert(
            observation.operation_id,
            RecordedObservationV1 {
                input_fingerprint: fingerprint,
                result: result.clone(),
            },
        );
        Ok(result)
    }

    /// Returns the number of idempotency identities retained by this instance.
    #[must_use]
    pub fn record_count(&self) -> usize {
        self.records.len()
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NodeLegacyPreparedObservationBodyV1 {
    version: u16,
    operation_id: String,
    attempt_id: String,
    campaign_id: String,
    capability_id: String,
    module_id: String,
    module_version: String,
    node_runtime_hash: Sha256Digest,
    node_entrypoint_hash: Sha256Digest,
    legacy_state_revision: u64,
    snapshot_hash: Sha256Digest,
    planning_request_hash: Sha256Digest,
    plan_hash: Sha256Digest,
    candidate_hash: Sha256Digest,
    input_hash: Sha256Digest,
    output_hash: Sha256Digest,
    output_bytes: usize,
    artifact_hashes: Vec<Sha256Digest>,
    parity_class: NodeLegacyParityClassV1,
    parity_evidence_hash: Sha256Digest,
    observed_at_unix_ms: u64,
    expires_at_unix_ms: u64,
    central_writer_authorized: bool,
    provider_dispatch_authorized: bool,
    external_effect_authorized: bool,
}

fn validate_observation(
    observation: &NodeLegacyObservationV1,
    now_unix_ms: u64,
    maximum_output_bytes: usize,
    maximum_artifacts: usize,
) -> Result<(), NodeLegacyAdapterError> {
    if observation.version != NODE_LEGACY_ADAPTER_VERSION_V1
        || !valid_identifier(&observation.operation_id)
        || !valid_identifier(&observation.attempt_id)
        || !valid_identifier(&observation.campaign_id)
        || !valid_capability_id(&observation.capability_id)
        || !valid_module_id(&observation.module_id)
        || !valid_version(&observation.module_version)
        || observation.legacy_state_revision == 0
        || observation.output_bytes.is_empty()
        || observation.output_bytes.len() > maximum_output_bytes
        || observation.artifact_hashes.is_empty()
        || observation.artifact_hashes.len() > maximum_artifacts
        || observation.observed_at_unix_ms > now_unix_ms
        || observation.expires_at_unix_ms <= now_unix_ms
        || observation.expires_at_unix_ms <= observation.observed_at_unix_ms
        || observation
            .expires_at_unix_ms
            .saturating_sub(observation.observed_at_unix_ms)
            > MAXIMUM_NODE_OBSERVATION_LIFETIME_MS_V1
    {
        return Err(NodeLegacyAdapterError::ObservationInvalid);
    }
    if !observation.authority.is_empty() {
        return Err(NodeLegacyAdapterError::AuthorityEscalation);
    }
    let artifacts = observation
        .artifact_hashes
        .iter()
        .map(Sha256Digest::as_str)
        .collect::<Vec<_>>();
    if artifacts.windows(2).any(|pair| pair[0] >= pair[1])
        || artifacts.iter().collect::<BTreeSet<_>>().len() != artifacts.len()
    {
        return Err(NodeLegacyAdapterError::ObservationInvalid);
    }
    let actual_output_hash = bytes_digest(&observation.output_bytes)?;
    if actual_output_hash != observation.output_hash {
        return Err(NodeLegacyAdapterError::OutputHashMismatch);
    }
    Ok(())
}

fn canonical_digest<T: Serialize>(value: &T) -> Result<Sha256Digest, NodeLegacyAdapterError> {
    let bytes = serde_json::to_vec(value).map_err(|_| NodeLegacyAdapterError::EncodingInvalid)?;
    bytes_digest(&bytes)
}

fn bytes_digest(bytes: &[u8]) -> Result<Sha256Digest, NodeLegacyAdapterError> {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    Sha256Digest::from_str(&format!("sha256:{}", hex::encode(hasher.finalize())))
        .map_err(|_| NodeLegacyAdapterError::EncodingInvalid)
}

fn valid_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':' | b'/')
        })
}

fn valid_module_id(value: &str) -> bool {
    value.starts_with("module.") && valid_identifier(value)
}

fn valid_capability_id(value: &str) -> bool {
    value.starts_with("CAP-") && valid_identifier(value)
}

fn valid_version(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'+'))
}

/// Node observation adapter rejection class.
#[derive(Clone, Copy, Debug, Error, Eq, PartialEq)]
pub enum NodeLegacyAdapterError {
    /// Deployment bounds are invalid.
    #[error("node legacy adapter policy is invalid")]
    PolicyInvalid,
    /// Observation identity, bounds, time, or artifact ordering is invalid.
    #[error("node legacy observation is invalid")]
    ObservationInvalid,
    /// The caller tried to cross an authority boundary.
    #[error("node legacy observation exposes forbidden authority")]
    AuthorityEscalation,
    /// Output bytes do not match the declared content hash.
    #[error("node legacy observation output hash mismatch")]
    OutputHashMismatch,
    /// The same operation identity was reused for different input or output.
    #[error("node legacy observation replay conflicts with the retained receipt")]
    ReplayConflict,
    /// Canonical encoding or digest construction failed.
    #[error("node legacy observation canonical encoding failed")]
    EncodingInvalid,
}
