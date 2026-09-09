//! Bounded, non-authorizing adapter for observations produced by the incumbent Node runtime.
//!
//! The adapter never launches Node, receives credentials, commits campaign state, or performs an
//! external effect. It validates one already-produced observation against an exact request and
//! converts the observation into a hash-bound prepared result suitable for independent comparison.

use std::{collections::BTreeMap, str::FromStr};

use sha2::{Digest, Sha256};
use thiserror::Error;

use crate::{CompatibilityError, LegacyRecordHash, parse_and_hash_production_record_v1};

/// Canonical module identity used by the migration registry.
pub const NODE_LEGACY_ADAPTER_MODULE_ID_V1: &str = "module.node-legacy-adapter";
/// Maximum accepted identifier or record-kind bytes.
pub const MAXIMUM_NODE_ADAPTER_IDENTIFIER_BYTES_V1: usize = 256;
/// Absolute output-byte ceiling, independent of the request's tighter ceiling.
pub const MAXIMUM_NODE_ADAPTER_OUTPUT_BYTES_V1: usize = 16 * 1024 * 1024;
/// Absolute artifact-count ceiling, independent of the request's tighter ceiling.
pub const MAXIMUM_NODE_ADAPTER_ARTIFACTS_V1: usize = 256;

/// Exact bounded request for adapting one incumbent Node observation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NodeLegacyObservationRequestV1 {
    /// Contract version. Must be one.
    pub version: u16,
    /// Idempotency identity for this observation attempt.
    pub attempt_id: String,
    /// Must equal [`NODE_LEGACY_ADAPTER_MODULE_ID_V1`].
    pub module_id: String,
    /// Exact incumbent module identity.
    pub legacy_module_id: String,
    /// Exact incumbent module version or source identity.
    pub legacy_module_version: String,
    /// Capability being observed.
    pub capability_id: String,
    /// Admitted candidate identity.
    pub candidate_hash: String,
    /// Exact frozen input identity.
    pub input_hash: String,
    /// Exact Node entrypoint/source closure identity.
    pub node_entrypoint_hash: String,
    /// Incumbent state revision against which the observation was produced.
    pub expected_state_revision: u64,
    /// Production Node record-hash kind for the observed JSON value.
    pub output_record_kind: String,
    /// Request-specific output ceiling.
    pub maximum_output_bytes: usize,
    /// Request-specific artifact ceiling.
    pub maximum_artifacts: usize,
}

/// Already-produced incumbent observation presented to the adapter.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NodeLegacyObservationV1 {
    /// Contract version. Must be one.
    pub version: u16,
    pub attempt_id: String,
    pub legacy_module_id: String,
    pub legacy_module_version: String,
    pub capability_id: String,
    pub candidate_hash: String,
    pub input_hash: String,
    pub node_entrypoint_hash: String,
    pub state_revision: u64,
    /// Original UTF-8 JSON bytes. Original bytes are required for exact Node number/key behavior.
    pub output_json: Vec<u8>,
    /// Sorted unique canonical SHA-256 artifact identities.
    pub artifact_hashes: Vec<String>,
    /// Any possible external effect makes the observation ineligible for this adapter.
    pub external_action_may_have_started: bool,
}

/// Hash-bound prepared result emitted by the adapter.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NodeLegacyPreparedResultV1 {
    pub version: u16,
    pub attempt_id: String,
    pub module_id: String,
    pub legacy_module_id: String,
    pub legacy_module_version: String,
    pub capability_id: String,
    pub candidate_hash: String,
    pub input_hash: String,
    pub node_entrypoint_hash: String,
    pub state_revision: u64,
    pub output_record_hash: String,
    pub artifact_hashes: Vec<String>,
    pub observation_hash: String,
    /// Always false. The adapter cannot grant authority.
    pub authority_granted: bool,
    /// Always false. Only the commit sequencer may commit authoritative campaign state.
    pub central_state_committed: bool,
    /// Always false for an accepted observation.
    pub external_action_may_have_started: bool,
}

/// In-memory replay fence for exact observation attempts.
///
/// Durable callers must persist the returned result and enforce the same attempt/fingerprint pair
/// across restart. This source component deliberately owns no campaign-state or provider authority.
#[derive(Debug, Default)]
pub struct NodeLegacyObservationAdapterV1 {
    completed: BTreeMap<String, (String, NodeLegacyPreparedResultV1)>,
}

impl NodeLegacyObservationAdapterV1 {
    /// Validate and adapt one exact incumbent observation.
    pub fn observe(
        &mut self,
        request: &NodeLegacyObservationRequestV1,
        observation: &NodeLegacyObservationV1,
    ) -> Result<NodeLegacyPreparedResultV1, NodeLegacyAdapterError> {
        validate_request(request)?;
        validate_observation_identity(request, observation)?;
        validate_artifact_hashes(request, &observation.artifact_hashes)?;

        if observation.external_action_may_have_started {
            return Err(NodeLegacyAdapterError::ExternalActionMayHaveStarted);
        }
        if observation.output_json.len() > request.maximum_output_bytes
            || observation.output_json.len() > MAXIMUM_NODE_ADAPTER_OUTPUT_BYTES_V1
        {
            return Err(NodeLegacyAdapterError::OutputLimit);
        }

        let output_record_hash = parse_and_hash_production_record_v1(
            &request.output_record_kind,
            &observation.output_json,
        )?
        .as_str()
        .to_owned();
        let observation_hash = observation_hash(request, observation, &output_record_hash)?;

        if let Some((recorded_hash, result)) = self.completed.get(&request.attempt_id) {
            if recorded_hash == &observation_hash {
                return Ok(result.clone());
            }
            return Err(NodeLegacyAdapterError::ReplayConflict);
        }

        let result = NodeLegacyPreparedResultV1 {
            version: 1,
            attempt_id: request.attempt_id.clone(),
            module_id: NODE_LEGACY_ADAPTER_MODULE_ID_V1.to_owned(),
            legacy_module_id: request.legacy_module_id.clone(),
            legacy_module_version: request.legacy_module_version.clone(),
            capability_id: request.capability_id.clone(),
            candidate_hash: request.candidate_hash.clone(),
            input_hash: request.input_hash.clone(),
            node_entrypoint_hash: request.node_entrypoint_hash.clone(),
            state_revision: request.expected_state_revision,
            output_record_hash,
            artifact_hashes: observation.artifact_hashes.clone(),
            observation_hash: observation_hash.clone(),
            authority_granted: false,
            central_state_committed: false,
            external_action_may_have_started: false,
        };
        self.completed.insert(
            request.attempt_id.clone(),
            (observation_hash, result.clone()),
        );
        Ok(result)
    }
}

fn validate_request(request: &NodeLegacyObservationRequestV1) -> Result<(), NodeLegacyAdapterError> {
    if request.version != 1
        || request.module_id != NODE_LEGACY_ADAPTER_MODULE_ID_V1
        || !valid_identifier(&request.attempt_id)
        || !valid_identifier(&request.legacy_module_id)
        || !valid_identifier(&request.legacy_module_version)
        || !valid_identifier(&request.capability_id)
        || !valid_identifier(&request.output_record_kind)
        || request.expected_state_revision == 0
        || request.maximum_output_bytes == 0
        || request.maximum_output_bytes > MAXIMUM_NODE_ADAPTER_OUTPUT_BYTES_V1
        || request.maximum_artifacts > MAXIMUM_NODE_ADAPTER_ARTIFACTS_V1
    {
        return Err(NodeLegacyAdapterError::Contract);
    }
    for digest in [
        &request.candidate_hash,
        &request.input_hash,
        &request.node_entrypoint_hash,
    ] {
        LegacyRecordHash::from_str(digest).map_err(|_| NodeLegacyAdapterError::Contract)?;
    }
    Ok(())
}

fn validate_observation_identity(
    request: &NodeLegacyObservationRequestV1,
    observation: &NodeLegacyObservationV1,
) -> Result<(), NodeLegacyAdapterError> {
    if observation.version != 1
        || observation.attempt_id != request.attempt_id
        || observation.legacy_module_id != request.legacy_module_id
        || observation.legacy_module_version != request.legacy_module_version
        || observation.capability_id != request.capability_id
        || observation.candidate_hash != request.candidate_hash
        || observation.input_hash != request.input_hash
        || observation.node_entrypoint_hash != request.node_entrypoint_hash
        || observation.state_revision != request.expected_state_revision
    {
        return Err(NodeLegacyAdapterError::IdentityMismatch);
    }
    Ok(())
}

fn validate_artifact_hashes(
    request: &NodeLegacyObservationRequestV1,
    artifact_hashes: &[String],
) -> Result<(), NodeLegacyAdapterError> {
    if artifact_hashes.len() > request.maximum_artifacts
        || artifact_hashes.len() > MAXIMUM_NODE_ADAPTER_ARTIFACTS_V1
    {
        return Err(NodeLegacyAdapterError::ArtifactLimit);
    }
    if artifact_hashes
        .windows(2)
        .any(|window| window[0] >= window[1])
    {
        return Err(NodeLegacyAdapterError::ArtifactOrder);
    }
    for digest in artifact_hashes {
        LegacyRecordHash::from_str(digest).map_err(|_| NodeLegacyAdapterError::ArtifactHash)?;
    }
    Ok(())
}

fn observation_hash(
    request: &NodeLegacyObservationRequestV1,
    observation: &NodeLegacyObservationV1,
    output_record_hash: &str,
) -> Result<String, NodeLegacyAdapterError> {
    let mut hasher = Sha256::new();
    update_field(&mut hasher, b"HeptaNodeLegacyObservationV1")?;
    update_field(&mut hasher, request.attempt_id.as_bytes())?;
    update_field(&mut hasher, request.module_id.as_bytes())?;
    update_field(&mut hasher, request.legacy_module_id.as_bytes())?;
    update_field(&mut hasher, request.legacy_module_version.as_bytes())?;
    update_field(&mut hasher, request.capability_id.as_bytes())?;
    update_field(&mut hasher, request.candidate_hash.as_bytes())?;
    update_field(&mut hasher, request.input_hash.as_bytes())?;
    update_field(&mut hasher, request.node_entrypoint_hash.as_bytes())?;
    update_field(&mut hasher, &request.expected_state_revision.to_be_bytes())?;
    update_field(&mut hasher, request.output_record_kind.as_bytes())?;
    update_field(&mut hasher, output_record_hash.as_bytes())?;
    update_field(&mut hasher, &observation.output_json)?;
    for artifact_hash in &observation.artifact_hashes {
        update_field(&mut hasher, artifact_hash.as_bytes())?;
    }
    Ok(format!("sha256:{}", hex::encode(hasher.finalize())))
}

fn update_field(hasher: &mut Sha256, value: &[u8]) -> Result<(), NodeLegacyAdapterError> {
    let length = u64::try_from(value.len()).map_err(|_| NodeLegacyAdapterError::Contract)?;
    hasher.update(length.to_be_bytes());
    hasher.update(value);
    Ok(())
}

fn valid_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAXIMUM_NODE_ADAPTER_IDENTIFIER_BYTES_V1
        && value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':' | b'/')
        })
}

/// Fail-closed adapter rejection.
#[derive(Clone, Debug, Error, Eq, PartialEq)]
pub enum NodeLegacyAdapterError {
    #[error("legacy observation request contract is invalid")]
    Contract,
    #[error("legacy observation identity does not match the exact request")]
    IdentityMismatch,
    #[error("legacy observation may already have started an external action")]
    ExternalActionMayHaveStarted,
    #[error("legacy observation output exceeds its byte ceiling")]
    OutputLimit,
    #[error("legacy observation artifact set exceeds its count ceiling")]
    ArtifactLimit,
    #[error("legacy observation artifact hashes must be sorted and unique")]
    ArtifactOrder,
    #[error("legacy observation contains a noncanonical artifact hash")]
    ArtifactHash,
    #[error("legacy observation attempt was reused with conflicting bytes or identity")]
    ReplayConflict,
    #[error(transparent)]
    Compatibility(#[from] CompatibilityError),
}
