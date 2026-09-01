use std::collections::{BTreeMap, BTreeSet};

use hepta_codex_protocol::Sha256Digest;
use hepta_module_platform::{ActionCandidateV1, ResourceVectorV1};
use serde::{Deserialize, Serialize};

use crate::{
    ControlPlaneError, ControlPlaneSnapshotV1, HardPolicyV1, PlanningFrontierV1, canonical_hash_v1,
};

/// Planner execution mode recorded in a plan certificate.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PlanModeV1 {
    /// Every feasible subset was evaluated within the configured exact bound.
    ExactOptimum,
    /// A deterministic fail-closed fallback was used after the exact bound.
    DeterministicFallback,
}

/// Versioned integer objective and bounded-solver policy.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlannerPolicyV1 {
    /// Contract version.
    pub version: u16,
    /// Maximum candidate count for exact enumeration.
    pub maximum_exact_candidates: usize,
    /// Cost penalty multiplier in parts per million.
    pub cost_weight_ppm: u32,
    /// Uncertainty penalty multiplier in integer micro-units per PPM.
    pub uncertainty_weight_micros_per_ppm: u64,
    /// Maximum selected candidate count.
    pub maximum_selected_candidates: usize,
}

impl PlannerPolicyV1 {
    /// Validates bounded solver and integer objective settings.
    pub fn validate(&self) -> Result<(), ControlPlaneError> {
        if self.version != 1
            || self.maximum_exact_candidates == 0
            || self.maximum_exact_candidates > 20
            || self.cost_weight_ppm > 1_000_000
            || self.maximum_selected_candidates == 0
            || self.maximum_selected_candidates > 1_024
        {
            return Err(ControlPlaneError::PlannerPolicyInvalid);
        }
        Ok(())
    }
}

/// Recomputable proof of one selected bounded plan.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlanCertificateV1 {
    /// Contract version.
    pub version: u16,
    /// Exact immutable snapshot hash.
    pub snapshot_hash: Sha256Digest,
    /// Exact sorted candidate-frontier hash.
    pub frontier_hash: Sha256Digest,
    /// Exact hard-policy hash.
    pub hard_policy_hash: Sha256Digest,
    /// Exact planner-policy hash.
    pub planner_policy_hash: Sha256Digest,
    /// Objective version copied from the snapshot.
    pub objective_version: String,
    /// Sorted selected candidate IDs.
    pub selected_candidate_ids: Vec<String>,
    /// Aggregate declared resources.
    pub total_resources: ResourceVectorV1,
    /// Aggregate hard cost.
    pub total_cost_microusd: u64,
    /// Integer objective value.
    pub objective_micros: i64,
    /// Proven objective upper bound in exact mode; absent for fallback.
    pub upper_bound_micros: Option<i64>,
    /// Proven optimality gap in exact mode; absent for fallback.
    pub optimality_gap_micros: Option<u64>,
    /// Exact or deterministic fallback mode.
    pub mode: PlanModeV1,
    /// Stable reason when exact enumeration was not used.
    pub fallback_reason: Option<String>,
    /// Canonical plan hash over every preceding field.
    pub plan_hash: Sha256Digest,
}

impl PlanCertificateV1 {
    /// Recomputes the plan from exact inputs and requires semantic equality.
    pub fn validate(
        &self,
        snapshot: &ControlPlaneSnapshotV1,
        frontier: &PlanningFrontierV1,
        hard_policy: &HardPolicyV1,
        planner_policy: &PlannerPolicyV1,
    ) -> Result<(), ControlPlaneError> {
        let recomputed = select_plan_v1(snapshot, frontier, hard_policy, planner_policy)?;
        if self != &recomputed {
            return Err(ControlPlaneError::PlanInvalid);
        }
        Ok(())
    }
}

#[derive(Clone, Debug)]
struct FeasiblePlanV1 {
    selected_candidate_ids: Vec<String>,
    total_resources: ResourceVectorV1,
    total_cost_microusd: u64,
    objective_micros: i64,
}

/// Selects a hard-feasible plan and emits a deterministic certificate.
pub fn select_plan_v1(
    snapshot: &ControlPlaneSnapshotV1,
    frontier: &PlanningFrontierV1,
    hard_policy: &HardPolicyV1,
    planner_policy: &PlannerPolicyV1,
) -> Result<PlanCertificateV1, ControlPlaneError> {
    planner_policy.validate()?;
    hard_policy.validate()?;
    let snapshot_hash = snapshot.snapshot_hash()?;
    if frontier.snapshot_hash != snapshot_hash {
        return Err(ControlPlaneError::FrontierInvalid);
    }

    let mut candidates = frontier.candidates.iter().collect::<Vec<_>>();
    candidates.sort_by(|left, right| left.candidate_id.cmp(&right.candidate_id));
    let (selected, mode, fallback_reason) =
        if candidates.len() <= planner_policy.maximum_exact_candidates {
            (
                exact_plan(snapshot, hard_policy, planner_policy, &candidates)?,
                PlanModeV1::ExactOptimum,
                None,
            )
        } else {
            (
                fallback_plan(snapshot, hard_policy, planner_policy, &candidates)?,
                PlanModeV1::DeterministicFallback,
                Some("candidate_count_exceeds_exact_bound".to_owned()),
            )
        };

    let (upper_bound_micros, optimality_gap_micros) = match mode {
        PlanModeV1::ExactOptimum => (Some(selected.objective_micros), Some(0)),
        PlanModeV1::DeterministicFallback => (None, None),
    };
    let body = PlanCertificateBodyV1 {
        version: 1,
        snapshot_hash,
        frontier_hash: frontier.frontier_hash()?,
        hard_policy_hash: hard_policy.policy_hash()?,
        planner_policy_hash: canonical_hash_v1(planner_policy)?,
        objective_version: snapshot.objective_version.clone(),
        selected_candidate_ids: selected.selected_candidate_ids,
        total_resources: selected.total_resources,
        total_cost_microusd: selected.total_cost_microusd,
        objective_micros: selected.objective_micros,
        upper_bound_micros,
        optimality_gap_micros,
        mode,
        fallback_reason,
    };
    let plan_hash = canonical_hash_v1(&body)?;
    Ok(PlanCertificateV1 {
        version: body.version,
        snapshot_hash: body.snapshot_hash,
        frontier_hash: body.frontier_hash,
        hard_policy_hash: body.hard_policy_hash,
        planner_policy_hash: body.planner_policy_hash,
        objective_version: body.objective_version,
        selected_candidate_ids: body.selected_candidate_ids,
        total_resources: body.total_resources,
        total_cost_microusd: body.total_cost_microusd,
        objective_micros: body.objective_micros,
        upper_bound_micros: body.upper_bound_micros,
        optimality_gap_micros: body.optimality_gap_micros,
        mode: body.mode,
        fallback_reason: body.fallback_reason,
        plan_hash,
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PlanCertificateBodyV1 {
    version: u16,
    snapshot_hash: Sha256Digest,
    frontier_hash: Sha256Digest,
    hard_policy_hash: Sha256Digest,
    planner_policy_hash: Sha256Digest,
    objective_version: String,
    selected_candidate_ids: Vec<String>,
    total_resources: ResourceVectorV1,
    total_cost_microusd: u64,
    objective_micros: i64,
    upper_bound_micros: Option<i64>,
    optimality_gap_micros: Option<u64>,
    mode: PlanModeV1,
    fallback_reason: Option<String>,
}

fn exact_plan(
    snapshot: &ControlPlaneSnapshotV1,
    hard_policy: &HardPolicyV1,
    planner_policy: &PlannerPolicyV1,
    candidates: &[&ActionCandidateV1],
) -> Result<FeasiblePlanV1, ControlPlaneError> {
    let shift =
        u32::try_from(candidates.len()).map_err(|_| ControlPlaneError::PlannerPolicyInvalid)?;
    let subset_count = 1_u64
        .checked_shl(shift)
        .ok_or(ControlPlaneError::PlannerPolicyInvalid)?;
    let mut best: Option<FeasiblePlanV1> = None;
    for mask in 0..subset_count {
        let selected_count = usize::try_from(mask.count_ones())
            .map_err(|_| ControlPlaneError::PlannerPolicyInvalid)?;
        if selected_count > planner_policy.maximum_selected_candidates {
            continue;
        }
        let selected = candidates
            .iter()
            .enumerate()
            .filter_map(|(index, candidate)| {
                let shift = u32::try_from(index).ok()?;
                let bit = 1_u64.checked_shl(shift)?;
                (mask & bit != 0).then_some(*candidate)
            })
            .collect::<Vec<_>>();
        let Some(feasible) =
            evaluate_selected(snapshot, hard_policy, planner_policy, &selected, true)?
        else {
            continue;
        };
        if better_plan(&feasible, best.as_ref()) {
            best = Some(feasible);
        }
    }
    best.ok_or(ControlPlaneError::NoFeasiblePlan)
}

fn fallback_plan(
    snapshot: &ControlPlaneSnapshotV1,
    hard_policy: &HardPolicyV1,
    planner_policy: &PlannerPolicyV1,
    candidates: &[&ActionCandidateV1],
) -> Result<FeasiblePlanV1, ControlPlaneError> {
    let by_id = candidates
        .iter()
        .map(|candidate| (candidate.candidate_id.as_str(), *candidate))
        .collect::<BTreeMap<_, _>>();
    let mut ranked = candidates
        .iter()
        .map(|candidate| Ok((*candidate, candidate_objective(candidate, planner_policy)?)))
        .collect::<Result<Vec<_>, ControlPlaneError>>()?;
    ranked.sort_by(|(left, left_score), (right, right_score)| {
        right_score
            .cmp(left_score)
            .then_with(|| left.candidate_id.cmp(&right.candidate_id))
    });

    let mut selected = BTreeSet::<String>::new();
    for (candidate, _) in ranked {
        if selected.len() == planner_policy.maximum_selected_candidates {
            break;
        }
        let mut trial = selected.clone();
        trial.extend(dependency_closure(candidate, &by_id)?);
        if trial.len() > planner_policy.maximum_selected_candidates {
            continue;
        }
        let trial_candidates = resolve_selected(&trial, &by_id)?;
        if evaluate_selected(
            snapshot,
            hard_policy,
            planner_policy,
            &trial_candidates,
            false,
        )?
        .is_some()
        {
            selected = trial;
        }
    }
    let selected_candidates = resolve_selected(&selected, &by_id)?;
    evaluate_selected(
        snapshot,
        hard_policy,
        planner_policy,
        &selected_candidates,
        true,
    )?
    .ok_or(ControlPlaneError::NoFeasiblePlan)
}

fn dependency_closure<'a>(
    root: &'a ActionCandidateV1,
    by_id: &BTreeMap<&'a str, &'a ActionCandidateV1>,
) -> Result<BTreeSet<String>, ControlPlaneError> {
    let mut pending = vec![root.candidate_id.as_str()];
    let mut closed = BTreeSet::new();
    while let Some(candidate_id) = pending.pop() {
        if !closed.insert(candidate_id.to_owned()) {
            continue;
        }
        let candidate = by_id
            .get(candidate_id)
            .ok_or(ControlPlaneError::FrontierInvalid)?;
        for dependency in &candidate.dependency_candidate_ids {
            pending.push(dependency.as_str());
        }
    }
    Ok(closed)
}

fn resolve_selected<'a>(
    selected: &BTreeSet<String>,
    by_id: &BTreeMap<&'a str, &'a ActionCandidateV1>,
) -> Result<Vec<&'a ActionCandidateV1>, ControlPlaneError> {
    selected
        .iter()
        .map(|candidate_id| {
            by_id
                .get(candidate_id.as_str())
                .copied()
                .ok_or(ControlPlaneError::FrontierInvalid)
        })
        .collect()
}

fn evaluate_selected(
    snapshot: &ControlPlaneSnapshotV1,
    hard_policy: &HardPolicyV1,
    planner_policy: &PlannerPolicyV1,
    selected: &[&ActionCandidateV1],
    require_capability_coverage: bool,
) -> Result<Option<FeasiblePlanV1>, ControlPlaneError> {
    let selected_ids = selected
        .iter()
        .map(|candidate| candidate.candidate_id.as_str())
        .collect::<BTreeSet<_>>();
    let mut decision_groups = BTreeSet::new();
    let mut covered_capabilities = BTreeSet::new();
    let mut total_resources = ResourceVectorV1::default();
    let mut total_cost_microusd = 0_u64;
    let mut objective_micros = 0_i64;

    for candidate in selected {
        if !decision_groups.insert(candidate.decision_group.as_str())
            || candidate
                .dependency_candidate_ids
                .iter()
                .any(|dependency| !selected_ids.contains(dependency.as_str()))
            || (candidate.resources.external_actions > 0
                && !hard_policy.external_actions_authorized)
        {
            return Ok(None);
        }
        covered_capabilities.insert(candidate.capability_id.as_str());
        total_resources = total_resources
            .checked_add(candidate.resources)
            .map_err(|_| ControlPlaneError::ObjectiveOverflow)?;
        total_cost_microusd = total_cost_microusd
            .checked_add(candidate.cost_microusd)
            .ok_or(ControlPlaneError::ObjectiveOverflow)?;
        objective_micros = objective_micros
            .checked_add(candidate_objective(candidate, planner_policy)?)
            .ok_or(ControlPlaneError::ObjectiveOverflow)?;
    }

    if (require_capability_coverage
        && !snapshot
            .required_capability_ids
            .iter()
            .all(|capability| covered_capabilities.contains(capability.as_str())))
        || !total_resources.fits_within(snapshot.resource_limit)
        || total_resources.central_writer_turns > hard_policy.maximum_central_writer_turns
        || total_cost_microusd > snapshot.budget_microusd
    {
        return Ok(None);
    }

    let mut selected_candidate_ids = selected
        .iter()
        .map(|candidate| candidate.candidate_id.clone())
        .collect::<Vec<_>>();
    selected_candidate_ids.sort();
    Ok(Some(FeasiblePlanV1 {
        selected_candidate_ids,
        total_resources,
        total_cost_microusd,
        objective_micros,
    }))
}

fn candidate_objective(
    candidate: &ActionCandidateV1,
    planner_policy: &PlannerPolicyV1,
) -> Result<i64, ControlPlaneError> {
    let cost_penalty = u128::from(candidate.cost_microusd)
        .checked_mul(u128::from(planner_policy.cost_weight_ppm))
        .ok_or(ControlPlaneError::ObjectiveOverflow)?
        / 1_000_000;
    let uncertainty_penalty = u128::from(candidate.uncertainty_ppm)
        .checked_mul(u128::from(planner_policy.uncertainty_weight_micros_per_ppm))
        .ok_or(ControlPlaneError::ObjectiveOverflow)?;
    let total_penalty = cost_penalty
        .checked_add(uncertainty_penalty)
        .ok_or(ControlPlaneError::ObjectiveOverflow)?;
    let penalty =
        i128::try_from(total_penalty).map_err(|_| ControlPlaneError::ObjectiveOverflow)?;
    let value = i128::from(candidate.utility_micros)
        .checked_sub(penalty)
        .ok_or(ControlPlaneError::ObjectiveOverflow)?;
    i64::try_from(value).map_err(|_| ControlPlaneError::ObjectiveOverflow)
}

fn better_plan(candidate: &FeasiblePlanV1, current: Option<&FeasiblePlanV1>) -> bool {
    match current {
        None => true,
        Some(best) => {
            candidate.objective_micros > best.objective_micros
                || (candidate.objective_micros == best.objective_micros
                    && candidate.selected_candidate_ids < best.selected_candidate_ids)
        }
    }
}

#[cfg(test)]
mod tests {
    use std::{collections::BTreeSet, str::FromStr};

    use hepta_codex_protocol::Sha256Digest;
    use hepta_module_platform::{ActionCandidateV1, ResourceVectorV1};

    use super::*;

    fn digest(marker: char) -> Sha256Digest {
        Sha256Digest::from_str(&format!("sha256:{}", marker.to_string().repeat(64)))
            .expect("test digest")
    }

    fn snapshot(required: &[&str], limit: ResourceVectorV1) -> ControlPlaneSnapshotV1 {
        ControlPlaneSnapshotV1 {
            version: 1,
            campaign_id: "campaign".to_owned(),
            campaign_revision: 1,
            state_hash: digest('1'),
            registry_hash: digest('2'),
            registry_policy_hash: digest('9'),
            objective_version: "objective-v1".to_owned(),
            constraint_set_hash: digest('3'),
            resource_limit: limit,
            budget_microusd: 1_000,
            required_capability_ids: required.iter().map(|value| (*value).to_owned()).collect(),
            random_seed: Some(1),
        }
    }

    fn candidate(
        id: &str,
        group: &str,
        capability: &str,
        snapshot_hash: Sha256Digest,
        utility: i64,
        cpu: u64,
        dependencies: &[&str],
    ) -> ActionCandidateV1 {
        ActionCandidateV1 {
            version: 1,
            candidate_id: id.to_owned(),
            decision_group: group.to_owned(),
            module_id: "module.fixture".to_owned(),
            module_version: "1.0.0".to_owned(),
            capability_id: capability.to_owned(),
            snapshot_hash,
            dependency_candidate_ids: dependencies
                .iter()
                .map(|value| (*value).to_owned())
                .collect(),
            resources: ResourceVectorV1 {
                cpu_millis: cpu,
                ..ResourceVectorV1::default()
            },
            utility_micros: utility,
            cost_microusd: 0,
            uncertainty_ppm: 0,
            evidence_tier: hepta_module_platform::QualificationTierV1::Source,
            payload_hash: digest('4'),
        }
    }

    fn hard_policy() -> HardPolicyV1 {
        HardPolicyV1 {
            version: 1,
            policy_id: "hard-policy".to_owned(),
            registry_policy_hash: digest('9'),
            forbidden_module_ids: BTreeSet::new(),
            minimum_evidence_by_capability: BTreeMap::new(),
            external_actions_authorized: false,
            maximum_central_writer_turns: 0,
            maximum_candidates_per_decision_group: 64,
        }
    }

    fn planner_policy(exact: usize) -> PlannerPolicyV1 {
        PlannerPolicyV1 {
            version: 1,
            maximum_exact_candidates: exact,
            cost_weight_ppm: 0,
            uncertainty_weight_micros_per_ppm: 0,
            maximum_selected_candidates: 16,
        }
    }

    #[test]
    fn exact_solver_selects_global_optimum() {
        let snapshot = snapshot(
            &["CAP-A", "CAP-B"],
            ResourceVectorV1 {
                cpu_millis: 10,
                ..ResourceVectorV1::default()
            },
        );
        let snapshot_hash = snapshot.snapshot_hash().expect("snapshot hash");
        let frontier = PlanningFrontierV1 {
            version: 1,
            snapshot_hash: snapshot_hash.clone(),
            candidates: vec![
                candidate("a-large", "a", "CAP-A", snapshot_hash.clone(), 100, 8, &[]),
                candidate("a-small", "a", "CAP-A", snapshot_hash.clone(), 70, 4, &[]),
                candidate("b", "b", "CAP-B", snapshot_hash, 60, 6, &[]),
            ],
        };
        let plan = select_plan_v1(&snapshot, &frontier, &hard_policy(), &planner_policy(20))
            .expect("exact plan");
        assert_eq!(plan.mode, PlanModeV1::ExactOptimum);
        assert_eq!(
            plan.selected_candidate_ids,
            vec!["a-small".to_owned(), "b".to_owned()]
        );
        assert_eq!(plan.objective_micros, 130);
        assert_eq!(plan.upper_bound_micros, Some(130));
        assert_eq!(plan.optimality_gap_micros, Some(0));
        plan.validate(&snapshot, &frontier, &hard_policy(), &planner_policy(20))
            .expect("certificate validates");
    }

    #[test]
    fn hard_capacity_is_never_softened() {
        let snapshot = snapshot(
            &["CAP-A"],
            ResourceVectorV1 {
                cpu_millis: 5,
                ..ResourceVectorV1::default()
            },
        );
        let snapshot_hash = snapshot.snapshot_hash().expect("snapshot hash");
        let frontier = PlanningFrontierV1 {
            version: 1,
            snapshot_hash: snapshot_hash.clone(),
            candidates: vec![candidate(
                "oversized",
                "a",
                "CAP-A",
                snapshot_hash,
                1_000_000,
                6,
                &[],
            )],
        };
        assert_eq!(
            select_plan_v1(&snapshot, &frontier, &hard_policy(), &planner_policy(20)),
            Err(ControlPlaneError::NoFeasiblePlan)
        );
    }

    #[test]
    fn fallback_is_deterministic_and_dependency_closed() {
        let snapshot = snapshot(
            &["CAP-A", "CAP-B"],
            ResourceVectorV1 {
                cpu_millis: 100,
                ..ResourceVectorV1::default()
            },
        );
        let snapshot_hash = snapshot.snapshot_hash().expect("snapshot hash");
        let frontier = PlanningFrontierV1 {
            version: 1,
            snapshot_hash: snapshot_hash.clone(),
            candidates: vec![
                candidate("a", "a", "CAP-A", snapshot_hash.clone(), 10, 1, &[]),
                candidate("b", "b", "CAP-B", snapshot_hash.clone(), 20, 1, &["a"]),
                candidate("c", "c", "CAP-A", snapshot_hash.clone(), 1, 1, &[]),
                candidate("d", "d", "CAP-B", snapshot_hash, 1, 1, &[]),
            ],
        };
        let left = select_plan_v1(&snapshot, &frontier, &hard_policy(), &planner_policy(2))
            .expect("fallback plan");
        let right = select_plan_v1(&snapshot, &frontier, &hard_policy(), &planner_policy(2))
            .expect("fallback plan");
        assert_eq!(left, right);
        assert_eq!(left.mode, PlanModeV1::DeterministicFallback);
        assert_eq!(left.upper_bound_micros, None);
        assert_eq!(left.optimality_gap_micros, None);
        assert!(left.selected_candidate_ids.contains(&"a".to_owned()));
        assert!(left.selected_candidate_ids.contains(&"b".to_owned()));
    }
}
