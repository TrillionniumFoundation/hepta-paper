use std::collections::{BTreeMap, BTreeSet};

use hepta_module_platform::{ActionCandidateV1, QualificationTierV1};

/// Context signature used to ensure Pareto removal never crosses hard semantic boundaries.
#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
struct ParetoContextV2 {
    decision_group: String,
    module_id: String,
    module_version: String,
    capability_id: String,
    dependency_candidate_ids: Vec<String>,
    evidence_tier: QualificationTierV1,
}

/// Removes dominated candidates without breaking the dependency closure of the frontier.
///
/// Any candidate referenced by another candidate is pinned even if a numerically better
/// alternative exists. Rewriting dependency edges is a semantic migration and cannot be
/// inferred from local objective dominance.
pub fn contextual_pareto_frontier_preserving_dependencies_v2(
    candidates: &[ActionCandidateV1],
) -> Vec<ActionCandidateV1> {
    let pinned = candidates
        .iter()
        .flat_map(|candidate| candidate.dependency_candidate_ids.iter().cloned())
        .collect::<BTreeSet<_>>();
    let mut groups = BTreeMap::<ParetoContextV2, Vec<&ActionCandidateV1>>::new();
    for candidate in candidates {
        let context = ParetoContextV2 {
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
            let dominated = !pinned.contains(&candidate.candidate_id)
                && group.iter().any(|other| {
                    other.candidate_id != candidate.candidate_id
                        && dominates_v2(other, candidate)
                        && (strictly_better_v2(other, candidate)
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

fn dominates_v2(left: &ActionCandidateV1, right: &ActionCandidateV1) -> bool {
    left.utility_micros >= right.utility_micros
        && left.cost_microusd <= right.cost_microusd
        && left.uncertainty_ppm <= right.uncertainty_ppm
        && left.resources.fits_within(right.resources)
}

fn strictly_better_v2(left: &ActionCandidateV1, right: &ActionCandidateV1) -> bool {
    left.utility_micros > right.utility_micros
        || left.cost_microusd < right.cost_microusd
        || left.uncertainty_ppm < right.uncertainty_ppm
        || left.resources != right.resources
}
