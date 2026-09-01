use std::collections::{BTreeMap, BTreeSet};

use hepta_codex_protocol::Sha256Digest;
use hepta_module_platform::{
    ActionCandidateV1, MAXIMUM_CANDIDATES_V1, ModulePlatformError, ModuleRegistryArtifactV1,
    QualificationTierV1, ResourceVectorV1,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::ControlPlaneError;

/// Immutable state subject consumed by one control-plane planning run.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ControlPlaneSnapshotV1 {
    /// Contract version.
    pub version: u16,
    /// Stable campaign ID.
    pub campaign_id: String,
    /// Monotonic campaign revision.
    pub campaign_revision: u64,
    /// Hash of the immutable campaign/read-model state.
    pub state_hash: Sha256Digest,
    /// Exact module registry hash.
    pub registry_hash: Sha256Digest,
    /// Exact independently selected module-registry policy hash.
    pub registry_policy_hash: Sha256Digest,
    /// Versioned objective identifier.
    pub objective_version: String,
    /// Hash of the hard policy and authority constraints.
    pub constraint_set_hash: Sha256Digest,
    /// Maximum aggregate resources for the selected plan.
    pub resource_limit: ResourceVectorV1,
    /// Maximum aggregate cost.
    pub budget_microusd: u64,
    /// Capabilities that the selected plan must cover.
    pub required_capability_ids: BTreeSet<String>,
    /// Explicit deterministic random seed when stochastic implementations are used.
    pub random_seed: Option<u64>,
}

impl ControlPlaneSnapshotV1 {
    /// Validates the immutable snapshot against an exact module registry.
    pub fn validate(&self, registry: &ModuleRegistryArtifactV1) -> Result<(), ControlPlaneError> {
        if self.version != 1
            || !valid_identifier(&self.campaign_id)
            || self.campaign_revision == 0
            || !valid_identifier(&self.objective_version)
            || &self.registry_hash != registry.registry_hash()
            || &self.registry_policy_hash != registry.policy_hash()
            || self.required_capability_ids.is_empty()
            || self
                .required_capability_ids
                .iter()
                .any(|capability| !valid_capability_id(capability))
        {
            return Err(ControlPlaneError::SnapshotInvalid);
        }
        registry
            .validate(&self.registry_policy_hash)
            .map_err(map_module_platform_error)?;
        Ok(())
    }

    /// Returns the canonical snapshot hash.
    pub fn snapshot_hash(&self) -> Result<Sha256Digest, ControlPlaneError> {
        canonical_hash_v1(self)
    }
}

/// Hard constraints that may never be converted into optimizer penalties.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HardPolicyV1 {
    /// Contract version.
    pub version: u16,
    /// Exact policy ID.
    pub policy_id: String,
    /// Independently selected module-registry policy hash.
    pub registry_policy_hash: Sha256Digest,
    /// Module IDs forbidden from this plan.
    pub forbidden_module_ids: BTreeSet<String>,
    /// Minimum accepted evidence tier per capability.
    pub minimum_evidence_by_capability: BTreeMap<String, QualificationTierV1>,
    /// Whether irreversible external-action candidates may be considered.
    pub external_actions_authorized: bool,
    /// Maximum central-writer turns in one selected plan.
    pub maximum_central_writer_turns: u64,
    /// Maximum exact candidate count accepted from each decision group.
    pub maximum_candidates_per_decision_group: usize,
}

impl HardPolicyV1 {
    /// Validates hard-policy shape and authority ceilings.
    pub fn validate(&self) -> Result<(), ControlPlaneError> {
        if self.version != 1
            || !valid_identifier(&self.policy_id)
            || self.maximum_central_writer_turns > 1
            || self.maximum_candidates_per_decision_group == 0
            || self.maximum_candidates_per_decision_group > 1_024
            || self
                .forbidden_module_ids
                .iter()
                .any(|module| !valid_module_id(module))
            || self
                .minimum_evidence_by_capability
                .keys()
                .any(|capability| !valid_capability_id(capability))
        {
            return Err(ControlPlaneError::PlannerPolicyInvalid);
        }
        Ok(())
    }

    /// Returns the canonical hard-policy hash.
    pub fn policy_hash(&self) -> Result<Sha256Digest, ControlPlaneError> {
        canonical_hash_v1(self)
    }
}

/// Validated bounded candidate frontier for one immutable snapshot.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlanningFrontierV1 {
    /// Contract version.
    pub version: u16,
    /// Exact snapshot hash.
    pub snapshot_hash: Sha256Digest,
    /// Candidate alternatives.
    pub candidates: Vec<ActionCandidateV1>,
}

impl PlanningFrontierV1 {
    /// Validates every candidate, dependency, decision group and exact binding.
    pub fn validate(
        &self,
        snapshot: &ControlPlaneSnapshotV1,
        registry: &ModuleRegistryArtifactV1,
        hard_policy: &HardPolicyV1,
    ) -> Result<(), ControlPlaneError> {
        let expected_snapshot_hash = snapshot.snapshot_hash()?;
        if self.version != 1
            || self.snapshot_hash != expected_snapshot_hash
            || self.candidates.is_empty()
            || self.candidates.len() > MAXIMUM_CANDIDATES_V1
        {
            return Err(ControlPlaneError::FrontierInvalid);
        }
        hard_policy.validate()?;
        let mut candidate_ids = BTreeSet::new();
        let mut group_counts = BTreeMap::<&str, usize>::new();
        for candidate in &self.candidates {
            candidate
                .validate(registry, &expected_snapshot_hash)
                .map_err(map_module_platform_error)?;
            if !candidate_ids.insert(candidate.candidate_id.as_str())
                || hard_policy
                    .forbidden_module_ids
                    .contains(&candidate.module_id)
            {
                return Err(ControlPlaneError::FrontierInvalid);
            }
            let count = group_counts.entry(&candidate.decision_group).or_default();
            *count += 1;
            if *count > hard_policy.maximum_candidates_per_decision_group {
                return Err(ControlPlaneError::FrontierInvalid);
            }
            if candidate.resources.external_actions > 0 && !hard_policy.external_actions_authorized
            {
                return Err(ControlPlaneError::FrontierInvalid);
            }
            let minimum = hard_policy
                .minimum_evidence_by_capability
                .get(&candidate.capability_id)
                .copied()
                .unwrap_or(QualificationTierV1::Source);
            if candidate.evidence_tier < minimum {
                return Err(ControlPlaneError::FrontierInvalid);
            }
        }
        for candidate in &self.candidates {
            if candidate
                .dependency_candidate_ids
                .iter()
                .any(|dependency| !candidate_ids.contains(dependency.as_str()))
            {
                return Err(ControlPlaneError::FrontierInvalid);
            }
        }
        validate_candidate_graph(&self.candidates)?;
        Ok(())
    }

    /// Returns the canonical candidate-set hash with candidates sorted by ID.
    pub fn frontier_hash(&self) -> Result<Sha256Digest, ControlPlaneError> {
        let mut canonical = self.clone();
        canonical
            .candidates
            .sort_by(|left, right| left.candidate_id.cmp(&right.candidate_id));
        canonical_hash_v1(&canonical)
    }
}

/// Returns a lowercase SHA-256 digest over canonical compact JSON.
pub fn canonical_hash_v1<T: Serialize + ?Sized>(
    value: &T,
) -> Result<Sha256Digest, ControlPlaneError> {
    let bytes = serde_json::to_vec(value).map_err(|_| ControlPlaneError::EncodingInvalid)?;
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("sha256:{}", hex::encode(hasher.finalize()))
        .parse()
        .map_err(|_| ControlPlaneError::EncodingInvalid)
}

pub(crate) fn map_module_platform_error(_: ModulePlatformError) -> ControlPlaneError {
    ControlPlaneError::ModulePlatformRejected
}

fn validate_candidate_graph(candidates: &[ActionCandidateV1]) -> Result<(), ControlPlaneError> {
    let by_id = candidates
        .iter()
        .map(|candidate| (candidate.candidate_id.as_str(), candidate))
        .collect::<BTreeMap<_, _>>();
    let mut visiting = BTreeSet::new();
    let mut visited = BTreeSet::new();
    for candidate_id in by_id.keys().copied() {
        visit_candidate(candidate_id, &by_id, &mut visiting, &mut visited)?;
    }
    Ok(())
}

fn visit_candidate<'a>(
    candidate_id: &'a str,
    by_id: &BTreeMap<&'a str, &'a ActionCandidateV1>,
    visiting: &mut BTreeSet<&'a str>,
    visited: &mut BTreeSet<&'a str>,
) -> Result<(), ControlPlaneError> {
    if visited.contains(candidate_id) {
        return Ok(());
    }
    if !visiting.insert(candidate_id) {
        return Err(ControlPlaneError::FrontierInvalid);
    }
    let candidate = by_id
        .get(candidate_id)
        .ok_or(ControlPlaneError::FrontierInvalid)?;
    for dependency in &candidate.dependency_candidate_ids {
        visit_candidate(dependency, by_id, visiting, visited)?;
    }
    visiting.remove(candidate_id);
    visited.insert(candidate_id);
    Ok(())
}

fn valid_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-' | b':' | b'/')
        })
}

fn valid_module_id(value: &str) -> bool {
    value.starts_with("module.") && valid_identifier(value)
}

fn valid_capability_id(value: &str) -> bool {
    value.starts_with("CAP-")
        && value.len() <= 96
        && value
            .bytes()
            .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'-')
}
