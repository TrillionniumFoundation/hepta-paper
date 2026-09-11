use std::collections::{BTreeMap, BTreeSet, btree_map::Entry};

use hepta_codex_protocol::Sha256Digest;
use hepta_module_platform::{
    ActionCandidateV1, ModuleRegistryArtifactV1, QualificationTierV1, ResourceVectorV1,
};
use serde::{Deserialize, Serialize};

use crate::{
    ControlPlaneError, ControlPlaneSnapshotV1, HardPolicyV1, PlanningFrontierV1,
    canonical_hash_v1,
};

/// Bounded source input for constructing one immutable planning snapshot.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SnapshotBuildRequestV1 {
    /// Stable campaign identity.
    pub campaign_id: String,
    /// Monotonic campaign revision observed by the read-only projection.
    pub campaign_revision: u64,
    /// Canonical read-model state hash.
    pub state_hash: Sha256Digest,
    /// Objective contract version.
    pub objective_version: String,
    /// Canonical hard-constraint set hash.
    pub constraint_set_hash: Sha256Digest,
    /// Resource ceiling for the next plan.
    pub resource_limit: ResourceVectorV1,
    /// Cost ceiling in micro-US dollars.
    pub budget_microusd: u64,
    /// Required capabilities for the next plan.
    pub required_capability_ids: BTreeSet<String>,
    /// Explicit deterministic seed when stochastic workers are admitted.
    pub random_seed: Option<u64>,
}

/// Builds and validates an immutable planning snapshot from an exact registry.
pub fn build_snapshot_v1(
    request: SnapshotBuildRequestV1,
    registry: &ModuleRegistryArtifactV1,
) -> Result<ControlPlaneSnapshotV1, ControlPlaneError> {
    let snapshot = ControlPlaneSnapshotV1 {
        version: 1,
        campaign_id: request.campaign_id,
        campaign_revision: request.campaign_revision,
        state_hash: request.state_hash,
        registry_hash: registry.registry_hash().clone(),
        registry_policy_hash: registry.policy_hash().clone(),
        objective_version: request.objective_version,
        constraint_set_hash: request.constraint_set_hash,
        resource_limit: request.resource_limit,
        budget_microusd: request.budget_microusd,
        required_capability_ids: request.required_capability_ids,
        random_seed: request.random_seed,
    };
    snapshot.validate(registry)?;
    Ok(snapshot)
}

/// Deterministically validates, deduplicates, and canonicalizes one candidate frontier.
pub fn route_candidates_v1(
    snapshot: &ControlPlaneSnapshotV1,
    registry: &ModuleRegistryArtifactV1,
    hard_policy: &HardPolicyV1,
    candidates: Vec<ActionCandidateV1>,
) -> Result<PlanningFrontierV1, ControlPlaneError> {
    snapshot.validate(registry)?;
    hard_policy.validate()?;
    let snapshot_hash = snapshot.snapshot_hash()?;
    let mut by_id = BTreeMap::<String, ActionCandidateV1>::new();
    for candidate in candidates {
        candidate
            .validate(registry, &snapshot_hash)
            .map_err(|_| ControlPlaneError::ModulePlatformRejected)?;
        match by_id.entry(candidate.candidate_id.clone()) {
            Entry::Vacant(entry) => {
                entry.insert(candidate);
            }
            Entry::Occupied(entry) => {
                if entry.get().candidate_hash().map_err(|_| ControlPlaneError::EncodingInvalid)?
                    != candidate
                        .candidate_hash()
                        .map_err(|_| ControlPlaneError::EncodingInvalid)?
                {
                    return Err(ControlPlaneError::FrontierInvalid);
                }
            }
        }
    }
    let frontier = PlanningFrontierV1 {
        version: 1,
        snapshot_hash,
        candidates: by_id.into_values().collect(),
    };
    frontier.validate(snapshot, registry, hard_policy)?;
    Ok(frontier)
}

/// Context signature used to ensure Pareto removal never crosses hard semantic boundaries.
#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
struct ParetoContextV1 {
    decision_group: String,
    module_id: String,
    module_version: String,
    capability_id: String,
    dependency_candidate_ids: Vec<String>,
    evidence_tier: QualificationTierV1,
}

/// Removes only candidates that are dominated inside an identical hard semantic context.
///
/// A candidate is removable only when another candidate has no greater resource/cost/
/// uncertainty demand and no lower utility. Dependency, module, capability, decision-group,
/// and evidence-tier identity must be identical, so this function never treats local
/// numeric dominance as proof of cross-context substitutability.
pub fn contextual_pareto_frontier_v1(
    candidates: &[ActionCandidateV1],
) -> Vec<ActionCandidateV1> {
    let mut groups = BTreeMap::<ParetoContextV1, Vec<&ActionCandidateV1>>::new();
    for candidate in candidates {
        let context = ParetoContextV1 {
            decision_group: candidate.decision_group.clone(),
            module_id: candidate.module_id.clone(),
            module_version: candidate.module_version.clone(),
            capability_id: candidate.capability_id.clone(),
            dependency_candidate_ids: candidate.dependency_candidate_ids.clone(),
            evidence_tier: candidate.evidence_tier,
        };
        groups.entry(context).or_default().push(candidate);
    }

    let mut retained = Vec::new();
    for group in groups.into_values() {
        for candidate in &group {
            let dominated = group.iter().any(|other| {
                other.candidate_id != candidate.candidate_id
                    && dominates_v1(other, candidate)
                    && (strictly_better_v1(other, candidate)
                        || other.candidate_id < candidate.candidate_id)
            });
            if !dominated {
                retained.push((*candidate).clone());
            }
        }
    }
    retained.sort_by(|left, right| left.candidate_id.cmp(&right.candidate_id));
    retained
}

fn dominates_v1(left: &ActionCandidateV1, right: &ActionCandidateV1) -> bool {
    left.utility_micros >= right.utility_micros
        && left.cost_microusd <= right.cost_microusd
        && left.uncertainty_ppm <= right.uncertainty_ppm
        && left.resources.fits_within(right.resources)
}

fn strictly_better_v1(left: &ActionCandidateV1, right: &ActionCandidateV1) -> bool {
    left.utility_micros > right.utility_micros
        || left.cost_microusd < right.cost_microusd
        || left.uncertainty_ppm < right.uncertainty_ppm
        || left.resources != right.resources
}

/// One node in a strict resource-entitlement hierarchy.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResourceEntitlementV1 {
    /// Stable scheduling-domain identity.
    pub domain_id: String,
    /// Optional parent domain. Roots have no parent.
    pub parent_domain_id: Option<String>,
    /// Hard resource ceiling for this domain.
    pub hard_limit: ResourceVectorV1,
    /// Positive relative fairness weight.
    pub weight: u32,
}

/// Validated hierarchical entitlement graph.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HierarchicalResourcePolicyV1 {
    /// Contract version.
    pub version: u16,
    /// Exact global capacity.
    pub capacity: ResourceVectorV1,
    /// Scheduling domains keyed by their stable identity.
    pub entitlements: BTreeMap<String, ResourceEntitlementV1>,
    /// Maximum accepted hierarchy depth.
    pub maximum_depth: usize,
    /// Maximum queue age before a request must receive either admission or an explicit denial.
    pub starvation_bound_ms: u64,
}

impl HierarchicalResourcePolicyV1 {
    /// Validates tree shape, capacity monotonicity, cycles, depth, and fairness weights.
    pub fn validate(&self) -> Result<(), ControlPlaneError> {
        if self.version != 1
            || self.capacity.is_zero()
            || self.entitlements.is_empty()
            || self.maximum_depth == 0
            || self.maximum_depth > 64
            || self.starvation_bound_ms == 0
        {
            return Err(ControlPlaneError::ResourcePolicyInvalid);
        }
        for (domain_id, entitlement) in &self.entitlements {
            if domain_id != &entitlement.domain_id
                || !valid_identifier(domain_id)
                || entitlement.weight == 0
                || entitlement.hard_limit.is_zero()
                || !entitlement.hard_limit.fits_within(self.capacity)
                || entitlement.parent_domain_id.as_ref() == Some(domain_id)
            {
                return Err(ControlPlaneError::ResourcePolicyInvalid);
            }
            if let Some(parent_id) = &entitlement.parent_domain_id {
                let parent = self
                    .entitlements
                    .get(parent_id)
                    .ok_or(ControlPlaneError::ResourcePolicyInvalid)?;
                if !entitlement.hard_limit.fits_within(parent.hard_limit) {
                    return Err(ControlPlaneError::ResourcePolicyInvalid);
                }
            }
        }
        for domain_id in self.entitlements.keys() {
            self.validate_chain(domain_id)?;
        }
        Ok(())
    }

    /// Returns a canonical policy hash suitable for reservation/evidence binding.
    pub fn policy_hash(&self) -> Result<Sha256Digest, ControlPlaneError> {
        self.validate()?;
        canonical_hash_v1(self)
    }

    fn validate_chain(&self, domain_id: &str) -> Result<(), ControlPlaneError> {
        let mut seen = BTreeSet::new();
        let mut current = Some(domain_id);
        let mut depth = 0usize;
        while let Some(candidate) = current {
            if !seen.insert(candidate) {
                return Err(ControlPlaneError::ResourcePolicyInvalid);
            }
            depth = depth
                .checked_add(1)
                .ok_or(ControlPlaneError::ResourcePolicyInvalid)?;
            if depth > self.maximum_depth {
                return Err(ControlPlaneError::ResourcePolicyInvalid);
            }
            current = self
                .entitlements
                .get(candidate)
                .ok_or(ControlPlaneError::ResourcePolicyInvalid)?
                .parent_domain_id
                .as_deref();
        }
        Ok(())
    }
}

/// One integer performance observation. No floating-point values enter qualification truth.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PerformanceSampleV1 {
    /// Canonical workload identity.
    pub workload_id: String,
    /// Latency in microseconds.
    pub latency_micros: u64,
    /// Completed operations represented by this sample.
    pub operations: u64,
    /// Failed operations represented by this sample.
    pub failures: u64,
    /// Peak memory in bytes.
    pub peak_memory_bytes: u64,
    /// Queue age in microseconds.
    pub queue_age_micros: u64,
}

/// Versioned performance/SLO budget evaluated against an exact workload.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PerformanceBudgetV1 {
    /// Contract version.
    pub version: u16,
    /// Canonical workload identity.
    pub workload_id: String,
    /// Maximum p95 latency.
    pub maximum_p95_latency_micros: u64,
    /// Maximum p99 latency.
    pub maximum_p99_latency_micros: u64,
    /// Maximum peak memory.
    pub maximum_peak_memory_bytes: u64,
    /// Maximum queue age.
    pub maximum_queue_age_micros: u64,
    /// Maximum failure rate in parts per million.
    pub maximum_failure_ppm: u32,
}

/// Deterministic performance assessment suitable for exact-head evidence.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PerformanceAssessmentV1 {
    /// Contract version.
    pub version: u16,
    /// Workload identity.
    pub workload_id: String,
    /// Sample count.
    pub sample_count: usize,
    /// p50 latency.
    pub p50_latency_micros: u64,
    /// p95 latency.
    pub p95_latency_micros: u64,
    /// p99 latency.
    pub p99_latency_micros: u64,
    /// Peak memory across all samples.
    pub peak_memory_bytes: u64,
    /// Maximum queue age across all samples.
    pub maximum_queue_age_micros: u64,
    /// Failure rate in parts per million.
    pub failure_ppm: u32,
    /// Whether every declared SLO is satisfied.
    pub accepted: bool,
    /// Canonical assessment hash.
    pub assessment_hash: Sha256Digest,
}

/// Evaluates a non-empty performance window against an exact workload budget.
pub fn assess_performance_v1(
    budget: &PerformanceBudgetV1,
    samples: &[PerformanceSampleV1],
) -> Result<PerformanceAssessmentV1, ControlPlaneError> {
    if budget.version != 1
        || !valid_identifier(&budget.workload_id)
        || budget.maximum_p95_latency_micros == 0
        || budget.maximum_p99_latency_micros < budget.maximum_p95_latency_micros
        || budget.maximum_peak_memory_bytes == 0
        || budget.maximum_queue_age_micros == 0
        || budget.maximum_failure_ppm > 1_000_000
        || samples.is_empty()
        || samples.len() > 1_000_000
    {
        return Err(ControlPlaneError::PerformanceQualificationInvalid);
    }
    let mut latencies = Vec::with_capacity(samples.len());
    let mut peak_memory_bytes = 0u64;
    let mut maximum_queue_age_micros = 0u64;
    let mut operations = 0u128;
    let mut failures = 0u128;
    for sample in samples {
        if sample.workload_id != budget.workload_id
            || sample.operations == 0
            || sample.failures > sample.operations
        {
            return Err(ControlPlaneError::PerformanceQualificationInvalid);
        }
        latencies.push(sample.latency_micros);
        peak_memory_bytes = peak_memory_bytes.max(sample.peak_memory_bytes);
        maximum_queue_age_micros = maximum_queue_age_micros.max(sample.queue_age_micros);
        operations = operations
            .checked_add(u128::from(sample.operations))
            .ok_or(ControlPlaneError::PerformanceQualificationInvalid)?;
        failures = failures
            .checked_add(u128::from(sample.failures))
            .ok_or(ControlPlaneError::PerformanceQualificationInvalid)?;
    }
    latencies.sort_unstable();
    let p50_latency_micros = percentile_nearest_rank(&latencies, 50)?;
    let p95_latency_micros = percentile_nearest_rank(&latencies, 95)?;
    let p99_latency_micros = percentile_nearest_rank(&latencies, 99)?;
    let failure_ppm_u128 = failures
        .saturating_mul(1_000_000)
        .checked_div(operations)
        .ok_or(ControlPlaneError::PerformanceQualificationInvalid)?;
    let failure_ppm = u32::try_from(failure_ppm_u128)
        .map_err(|_| ControlPlaneError::PerformanceQualificationInvalid)?;
    let accepted = p95_latency_micros <= budget.maximum_p95_latency_micros
        && p99_latency_micros <= budget.maximum_p99_latency_micros
        && peak_memory_bytes <= budget.maximum_peak_memory_bytes
        && maximum_queue_age_micros <= budget.maximum_queue_age_micros
        && failure_ppm <= budget.maximum_failure_ppm;
    let body = PerformanceAssessmentBodyV1 {
        version: 1,
        workload_id: budget.workload_id.clone(),
        sample_count: samples.len(),
        p50_latency_micros,
        p95_latency_micros,
        p99_latency_micros,
        peak_memory_bytes,
        maximum_queue_age_micros,
        failure_ppm,
        accepted,
    };
    let assessment_hash = canonical_hash_v1(&body)?;
    Ok(PerformanceAssessmentV1 {
        version: body.version,
        workload_id: body.workload_id,
        sample_count: body.sample_count,
        p50_latency_micros: body.p50_latency_micros,
        p95_latency_micros: body.p95_latency_micros,
        p99_latency_micros: body.p99_latency_micros,
        peak_memory_bytes: body.peak_memory_bytes,
        maximum_queue_age_micros: body.maximum_queue_age_micros,
        failure_ppm: body.failure_ppm,
        accepted: body.accepted,
        assessment_hash,
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PerformanceAssessmentBodyV1 {
    version: u16,
    workload_id: String,
    sample_count: usize,
    p50_latency_micros: u64,
    p95_latency_micros: u64,
    p99_latency_micros: u64,
    peak_memory_bytes: u64,
    maximum_queue_age_micros: u64,
    failure_ppm: u32,
    accepted: bool,
}

fn percentile_nearest_rank(values: &[u64], percentile: usize) -> Result<u64, ControlPlaneError> {
    if values.is_empty() || percentile == 0 || percentile > 100 {
        return Err(ControlPlaneError::PerformanceQualificationInvalid);
    }
    let numerator = values
        .len()
        .checked_mul(percentile)
        .ok_or(ControlPlaneError::PerformanceQualificationInvalid)?;
    let rank = numerator.div_ceil(100).max(1);
    values
        .get(rank - 1)
        .copied()
        .ok_or(ControlPlaneError::PerformanceQualificationInvalid)
}

fn valid_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-' | b':' | b'/')
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn resources(cpu: u64) -> ResourceVectorV1 {
        ResourceVectorV1 {
            cpu_millis: cpu,
            memory_bytes: cpu.saturating_mul(1024),
            ..ResourceVectorV1::default()
        }
    }

    #[test]
    fn hierarchical_policy_rejects_cycles_and_child_overcommit() {
        let mut entitlements = BTreeMap::new();
        entitlements.insert(
            "root".to_owned(),
            ResourceEntitlementV1 {
                domain_id: "root".to_owned(),
                parent_domain_id: None,
                hard_limit: resources(100),
                weight: 1,
            },
        );
        entitlements.insert(
            "child".to_owned(),
            ResourceEntitlementV1 {
                domain_id: "child".to_owned(),
                parent_domain_id: Some("root".to_owned()),
                hard_limit: resources(50),
                weight: 2,
            },
        );
        let policy = HierarchicalResourcePolicyV1 {
            version: 1,
            capacity: resources(100),
            entitlements,
            maximum_depth: 8,
            starvation_bound_ms: 60_000,
        };
        assert!(policy.validate().is_ok());

        let mut bad = policy.clone();
        bad.entitlements
            .get_mut("root")
            .expect("root")
            .parent_domain_id = Some("child".to_owned());
        assert_eq!(bad.validate(), Err(ControlPlaneError::ResourcePolicyInvalid));
    }

    #[test]
    fn performance_assessment_is_integer_and_fail_closed() {
        let budget = PerformanceBudgetV1 {
            version: 1,
            workload_id: "workload.control".to_owned(),
            maximum_p95_latency_micros: 200,
            maximum_p99_latency_micros: 300,
            maximum_peak_memory_bytes: 4096,
            maximum_queue_age_micros: 500,
            maximum_failure_ppm: 100_000,
        };
        let samples = vec![
            PerformanceSampleV1 {
                workload_id: budget.workload_id.clone(),
                latency_micros: 100,
                operations: 10,
                failures: 0,
                peak_memory_bytes: 1024,
                queue_age_micros: 10,
            },
            PerformanceSampleV1 {
                workload_id: budget.workload_id.clone(),
                latency_micros: 200,
                operations: 10,
                failures: 1,
                peak_memory_bytes: 2048,
                queue_age_micros: 20,
            },
        ];
        let assessment = assess_performance_v1(&budget, &samples).expect("assessment");
        assert_eq!(assessment.failure_ppm, 50_000);
        assert!(assessment.accepted);
    }
}
