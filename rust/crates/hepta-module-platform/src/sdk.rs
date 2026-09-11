use std::collections::{BTreeMap, BTreeSet};

use hepta_codex_protocol::Sha256Digest;
use serde::{Deserialize, Serialize};

use crate::{
    ActionCandidateV1, CancellationAcknowledgementV1, CancellationRequestV1, ExecutionCommandV1,
    ModuleHealthReportV1, ModuleLifecycleProfileV1, ModuleManifestV1, ModulePlatformError,
    ModuleRegistryArtifactV1, PlanningRequestV1, PlanningResponseV1, PreparedResultV1,
    hash::canonical_hash,
};

/// Language-neutral module SDK boundary.
///
/// Implementations receive no central-state writer, release signer, or implicit
/// credential handle from this trait. Authority remains in the request and the
/// independently selected registry policy.
pub trait ModuleSdkV1 {
    /// Returns the exact self-description proposed by this module version.
    fn manifest(&self) -> &ModuleManifestV1;

    /// Returns the lifecycle/resource/SLO profile for the same version.
    fn lifecycle_profile(&self) -> &ModuleLifecycleProfileV1;

    /// Produces a bounded feasible candidate response.
    fn plan(
        &mut self,
        request: &PlanningRequestV1,
    ) -> Result<PlanningResponseV1, ModulePlatformError>;

    /// Executes one exact admitted command and returns only a prepared result.
    fn execute(
        &mut self,
        command: &ExecutionCommandV1,
    ) -> Result<PreparedResultV1, ModulePlatformError>;

    /// Cancels or classifies one exact execution without inferring success from absence.
    fn cancel(
        &mut self,
        request: &CancellationRequestV1,
    ) -> Result<CancellationAcknowledgementV1, ModulePlatformError>;

    /// Returns a bounded, expiring non-authority health observation.
    fn health(&self, now_unix_ms: u64) -> Result<ModuleHealthReportV1, ModulePlatformError>;
}

/// Deterministic candidate collection and Pareto-reduction receipt.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CandidateCollectionV1 {
    /// Contract version.
    pub version: u16,
    /// Exact request hash.
    pub planning_request_hash: Sha256Digest,
    /// Module response hashes keyed by module ID.
    pub response_hashes: BTreeMap<String, Sha256Digest>,
    /// Deterministically retained candidates.
    pub candidates: Vec<ActionCandidateV1>,
    /// Candidate IDs removed as strictly dominated.
    pub dominated_candidate_ids: Vec<String>,
    /// Canonical collection hash.
    pub collection_hash: Sha256Digest,
}

impl CandidateCollectionV1 {
    /// Collects and validates one response per module, then applies safe Pareto reduction.
    pub fn collect(
        request: &PlanningRequestV1,
        registry: &ModuleRegistryArtifactV1,
        responses: Vec<PlanningResponseV1>,
        now_unix_ms: u64,
    ) -> Result<Self, ModulePlatformError> {
        request.validate(now_unix_ms)?;
        if responses.is_empty() {
            return Err(ModulePlatformError::CandidateInvalid);
        }
        let mut response_hashes = BTreeMap::new();
        let mut candidates = Vec::new();
        for response in responses {
            response.validate(request, registry, now_unix_ms)?;
            let module_id = response.envelope.module_id.clone();
            if response_hashes
                .insert(module_id, response.response_hash()?)
                .is_some()
            {
                return Err(ModulePlatformError::CandidateInvalid);
            }
            candidates.extend(response.candidates);
        }
        let (candidates, dominated_candidate_ids) = pareto_reduce_candidates_v1(candidates)?;
        let body = CandidateCollectionBodyV1 {
            version: 1,
            planning_request_hash: request.request_hash()?,
            response_hashes: response_hashes.clone(),
            candidates: candidates.clone(),
            dominated_candidate_ids: dominated_candidate_ids.clone(),
        };
        let collection_hash = canonical_hash(&body)?;
        Ok(Self {
            version: body.version,
            planning_request_hash: body.planning_request_hash,
            response_hashes: body.response_hashes,
            candidates: body.candidates,
            dominated_candidate_ids: body.dominated_candidate_ids,
            collection_hash,
        })
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CandidateCollectionBodyV1 {
    version: u16,
    planning_request_hash: Sha256Digest,
    response_hashes: BTreeMap<String, Sha256Digest>,
    candidates: Vec<ActionCandidateV1>,
    dominated_candidate_ids: Vec<String>,
}

/// Removes only strictly dominated, unreferenced candidates in comparable decision groups.
pub fn pareto_reduce_candidates_v1(
    mut candidates: Vec<ActionCandidateV1>,
) -> Result<(Vec<ActionCandidateV1>, Vec<String>), ModulePlatformError> {
    if candidates.is_empty() {
        return Err(ModulePlatformError::CandidateInvalid);
    }
    candidates.sort_by(|left, right| left.candidate_id.cmp(&right.candidate_id));
    if candidates
        .windows(2)
        .any(|window| window[0].candidate_id == window[1].candidate_id)
    {
        return Err(ModulePlatformError::CandidateInvalid);
    }
    let referenced = candidates
        .iter()
        .flat_map(|candidate| candidate.dependency_candidate_ids.iter().cloned())
        .collect::<BTreeSet<_>>();
    let mut dominated = BTreeSet::new();
    for (right_index, right) in candidates.iter().enumerate() {
        if referenced.contains(&right.candidate_id) {
            continue;
        }
        for (left_index, left) in candidates.iter().enumerate() {
            if left_index == right_index || dominated.contains(&left.candidate_id) {
                continue;
            }
            if comparable(left, right) && strictly_dominates(left, right) {
                dominated.insert(right.candidate_id.clone());
                break;
            }
        }
    }
    let retained = candidates
        .into_iter()
        .filter(|candidate| !dominated.contains(&candidate.candidate_id))
        .collect::<Vec<_>>();
    if retained.is_empty() {
        return Err(ModulePlatformError::CandidateInvalid);
    }
    Ok((retained, dominated.into_iter().collect()))
}

fn comparable(left: &ActionCandidateV1, right: &ActionCandidateV1) -> bool {
    left.decision_group == right.decision_group
        && left.capability_id == right.capability_id
        && left.snapshot_hash == right.snapshot_hash
        && left.dependency_candidate_ids == right.dependency_candidate_ids
}

fn strictly_dominates(left: &ActionCandidateV1, right: &ActionCandidateV1) -> bool {
    let resources_no_worse = left.resources.cpu_millis <= right.resources.cpu_millis
        && left.resources.gpu_millis <= right.resources.gpu_millis
        && left.resources.memory_bytes <= right.resources.memory_bytes
        && left.resources.storage_bytes <= right.resources.storage_bytes
        && left.resources.tokens <= right.resources.tokens
        && left.resources.provider_calls <= right.resources.provider_calls
        && left.resources.external_actions <= right.resources.external_actions
        && left.resources.central_writer_turns <= right.resources.central_writer_turns;
    let no_worse = left.utility_micros >= right.utility_micros
        && left.cost_microusd <= right.cost_microusd
        && left.uncertainty_ppm <= right.uncertainty_ppm
        && left.evidence_tier >= right.evidence_tier
        && resources_no_worse;
    let strict = left.utility_micros > right.utility_micros
        || left.cost_microusd < right.cost_microusd
        || left.uncertainty_ppm < right.uncertainty_ppm
        || left.evidence_tier > right.evidence_tier
        || left.resources != right.resources;
    no_worse && strict
}
