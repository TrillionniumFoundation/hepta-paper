use hepta_codex_protocol::Sha256Digest;
use serde::{Deserialize, Serialize};

use crate::{
    ActivationStateV1, AuthorityClassV1, MAXIMUM_CANDIDATES_V1, MODULE_PROTOCOL_VERSION_V1,
    ModulePlatformError, ModuleRegistryArtifactV1, QualificationTierV1, ResourceVectorV1,
    hash::canonical_hash,
    types::{duplicate_digests, duplicate_strings, is_strictly_sorted, valid_identifier},
};

/// One bounded feasible alternative returned by a module.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ActionCandidateV1 {
    /// Contract version.
    pub version: u16,
    /// Stable candidate ID.
    pub candidate_id: String,
    /// Mutually exclusive decision group.
    pub decision_group: String,
    /// Producing module ID.
    pub module_id: String,
    /// Producing module version.
    pub module_version: String,
    /// Capability implemented by the candidate.
    pub capability_id: String,
    /// Immutable control-plane snapshot hash.
    pub snapshot_hash: Sha256Digest,
    /// Candidate IDs that must also be selected.
    pub dependency_candidate_ids: Vec<String>,
    /// Declared resource maximum.
    pub resources: ResourceVectorV1,
    /// Recomputed objective utility in integer micro-units.
    pub utility_micros: i64,
    /// Hard budget cost in micro-US dollars.
    pub cost_microusd: u64,
    /// Bounded uncertainty in parts per million.
    pub uncertainty_ppm: u32,
    /// Evidence tier attached to this candidate.
    pub evidence_tier: QualificationTierV1,
    /// Exact opaque candidate payload hash.
    pub payload_hash: Sha256Digest,
}

impl ActionCandidateV1 {
    /// Validates exact module, snapshot, capability and authority bindings.
    pub fn validate(
        &self,
        registry: &ModuleRegistryArtifactV1,
        expected_snapshot_hash: &Sha256Digest,
    ) -> Result<(), ModulePlatformError> {
        if self.version != MODULE_PROTOCOL_VERSION_V1
            || !valid_identifier(&self.candidate_id)
            || !valid_identifier(&self.decision_group)
            || self.snapshot_hash != *expected_snapshot_hash
            || self.uncertainty_ppm > 1_000_000
            || self.dependency_candidate_ids.len() > MAXIMUM_CANDIDATES_V1
            || duplicate_strings(&self.dependency_candidate_ids)
            || !is_strictly_sorted(&self.dependency_candidate_ids)
            || self
                .dependency_candidate_ids
                .iter()
                .any(|dependency| dependency == &self.candidate_id || !valid_identifier(dependency))
        {
            return Err(ModulePlatformError::CandidateInvalid);
        }
        let module = registry.module(&self.module_id)?;
        if module.manifest.module_version != self.module_version
            || !module.manifest.capability_ids.contains(&self.capability_id)
            || matches!(
                module.manifest.requested_activation,
                ActivationStateV1::Disabled | ActivationStateV1::Retired
            )
            || self.evidence_tier > module.manifest.qualification
        {
            return Err(ModulePlatformError::CandidateBindingInvalid);
        }
        if self.resources.external_actions > 0
            && module.manifest.requested_authority != AuthorityClassV1::ExternalEffect
        {
            return Err(ModulePlatformError::AuthorityEscalation);
        }
        if self.resources.central_writer_turns > 0
            && module.manifest.requested_authority != AuthorityClassV1::CentralStateWrite
        {
            return Err(ModulePlatformError::AuthorityEscalation);
        }
        Ok(())
    }

    /// Returns the canonical candidate hash.
    pub fn candidate_hash(&self) -> Result<Sha256Digest, ModulePlatformError> {
        canonical_hash(self)
    }
}

/// Terminal status of a prepared result.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PreparedResultStatusV1 {
    /// Result eligible for independent verification.
    Prepared,
    /// Execution failed without accepted external effect.
    Failed,
}

/// Module output before authoritative integration.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreparedResultV1 {
    /// Contract version.
    pub version: u16,
    /// Exact execution attempt ID.
    pub attempt_id: String,
    /// Immutable snapshot hash.
    pub snapshot_hash: Sha256Digest,
    /// Exact selected plan hash.
    pub plan_hash: Sha256Digest,
    /// Exact source candidate hash.
    pub candidate_hash: Sha256Digest,
    /// Producing module ID.
    pub module_id: String,
    /// Producing module version.
    pub module_version: String,
    /// Terminal prepared-result status.
    pub status: PreparedResultStatusV1,
    /// Content-addressed output artifacts.
    pub artifact_hashes: Vec<Sha256Digest>,
    /// Independently measurable resource use.
    pub actual_resources: ResourceVectorV1,
    /// Actual charged cost.
    pub actual_cost_microusd: u64,
    /// Evidence bundle hash.
    pub evidence_hash: Sha256Digest,
    /// Whether an irreversible external action may have started.
    pub external_action_may_have_started: bool,
}

impl PreparedResultV1 {
    /// Checks exact plan/candidate/module bindings and resource ceilings.
    pub fn validate(
        &self,
        candidate: &ActionCandidateV1,
        expected_plan_hash: &Sha256Digest,
    ) -> Result<(), ModulePlatformError> {
        if self.version != MODULE_PROTOCOL_VERSION_V1
            || !valid_identifier(&self.attempt_id)
            || self.snapshot_hash != candidate.snapshot_hash
            || self.plan_hash != *expected_plan_hash
            || self.candidate_hash != candidate.candidate_hash()?
            || self.module_id != candidate.module_id
            || self.module_version != candidate.module_version
            || self.artifact_hashes.is_empty()
            || self.artifact_hashes.len() > 1_024
            || duplicate_digests(&self.artifact_hashes)
            || !is_strictly_sorted(&self.artifact_hashes)
            || !self.actual_resources.fits_within(candidate.resources)
            || self.actual_cost_microusd > candidate.cost_microusd
            || (self.external_action_may_have_started && candidate.resources.external_actions == 0)
        {
            return Err(ModulePlatformError::PreparedResultInvalid);
        }
        Ok(())
    }

    /// Returns the canonical prepared-result hash.
    pub fn result_hash(&self) -> Result<Sha256Digest, ModulePlatformError> {
        canonical_hash(self)
    }
}
