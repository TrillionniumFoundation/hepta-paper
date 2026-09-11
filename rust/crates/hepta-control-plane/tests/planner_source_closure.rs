use hepta_codex_protocol::Sha256Digest;
use hepta_control_plane::{
    ControlPlaneSnapshotV1, HardPolicyV1, PlanModeV1, PlannerPolicyV1, PlanningFrontierV1,
    select_plan_v1,
};
use hepta_module_platform::{ActionCandidateV1, QualificationTierV1, ResourceVectorV1};
use std::{
    collections::{BTreeMap, BTreeSet},
    str::FromStr,
};

fn digest(marker: char) -> Sha256Digest {
    Sha256Digest::from_str(&format!("sha256:{}", marker.to_string().repeat(64)))
        .expect("test digest")
}

fn snapshot(required: &[&str], cpu_limit: u64) -> ControlPlaneSnapshotV1 {
    ControlPlaneSnapshotV1 {
        version: 1,
        campaign_id: "campaign:planner-source-closure".into(),
        campaign_revision: 1,
        state_hash: digest('1'),
        registry_hash: digest('2'),
        registry_policy_hash: digest('9'),
        objective_version: "objective-v1".into(),
        constraint_set_hash: digest('3'),
        resource_limit: ResourceVectorV1 {
            cpu_millis: cpu_limit,
            ..ResourceVectorV1::default()
        },
        budget_microusd: 1_000,
        required_capability_ids: required.iter().map(|value| (*value).to_owned()).collect(),
        random_seed: Some(1),
    }
}

fn hard_policy() -> HardPolicyV1 {
    HardPolicyV1 {
        version: 1,
        policy_id: "hard-policy-source-closure".into(),
        registry_policy_hash: digest('9'),
        forbidden_module_ids: BTreeSet::new(),
        minimum_evidence_by_capability: BTreeMap::new(),
        external_actions_authorized: false,
        maximum_central_writer_turns: 0,
        maximum_candidates_per_decision_group: 64,
    }
}

fn planner_policy(maximum_exact_candidates: usize) -> PlannerPolicyV1 {
    PlannerPolicyV1 {
        version: 1,
        maximum_exact_candidates,
        cost_weight_ppm: 0,
        uncertainty_weight_micros_per_ppm: 0,
        maximum_selected_candidates: 16,
    }
}

fn candidate(
    candidate_id: &str,
    decision_group: &str,
    capability_id: &str,
    snapshot_hash: Sha256Digest,
    utility_micros: i64,
    cpu_millis: u64,
    dependencies: &[&str],
) -> ActionCandidateV1 {
    ActionCandidateV1 {
        version: 1,
        candidate_id: candidate_id.into(),
        decision_group: decision_group.into(),
        module_id: "module.fixture".into(),
        module_version: "1.0.0".into(),
        capability_id: capability_id.into(),
        snapshot_hash,
        dependency_candidate_ids: dependencies
            .iter()
            .map(|value| (*value).to_owned())
            .collect(),
        resources: ResourceVectorV1 {
            cpu_millis,
            ..ResourceVectorV1::default()
        },
        utility_micros,
        cost_microusd: 0,
        uncertainty_ppm: 0,
        evidence_tier: QualificationTierV1::Source,
        payload_hash: digest('4'),
    }
}

#[test]
fn source_closure_planner_exact_and_fallback_certificates_are_recomputable() {
    let exact_snapshot = snapshot(&["CAP-A", "CAP-B"], 10);
    let exact_hash = exact_snapshot.snapshot_hash().expect("snapshot hash");
    let exact_frontier = PlanningFrontierV1 {
        version: 1,
        snapshot_hash: exact_hash.clone(),
        candidates: vec![
            candidate("a-large", "a", "CAP-A", exact_hash.clone(), 100, 8, &[]),
            candidate("a-small", "a", "CAP-A", exact_hash.clone(), 70, 4, &[]),
            candidate("b", "b", "CAP-B", exact_hash, 60, 6, &[]),
        ],
    };
    let exact_policy = planner_policy(20);
    let exact = select_plan_v1(
        &exact_snapshot,
        &exact_frontier,
        &hard_policy(),
        &exact_policy,
    )
    .expect("exact plan");
    assert_eq!(exact.mode, PlanModeV1::ExactOptimum);
    assert_eq!(
        exact.selected_candidate_ids,
        vec!["a-small".to_owned(), "b".to_owned()]
    );
    assert_eq!(exact.optimality_gap_micros, Some(0));
    exact
        .validate(
            &exact_snapshot,
            &exact_frontier,
            &hard_policy(),
            &exact_policy,
        )
        .expect("exact certificate validates");
    let mut stale_snapshot = exact_snapshot.clone();
    stale_snapshot.campaign_revision = 2;
    assert!(
        exact
            .validate(
                &stale_snapshot,
                &exact_frontier,
                &hard_policy(),
                &exact_policy,
            )
            .is_err()
    );

    let fallback_snapshot = snapshot(&["CAP-A", "CAP-B"], 100);
    let fallback_hash = fallback_snapshot
        .snapshot_hash()
        .expect("fallback snapshot hash");
    let fallback_frontier = PlanningFrontierV1 {
        version: 1,
        snapshot_hash: fallback_hash.clone(),
        candidates: vec![
            candidate("a", "a", "CAP-A", fallback_hash.clone(), 10, 1, &[]),
            candidate("b", "b", "CAP-B", fallback_hash.clone(), 20, 1, &["a"]),
            candidate("c", "c", "CAP-A", fallback_hash.clone(), 1, 1, &[]),
            candidate("d", "d", "CAP-B", fallback_hash, 1, 1, &[]),
        ],
    };
    let fallback_policy = planner_policy(2);
    let left = select_plan_v1(
        &fallback_snapshot,
        &fallback_frontier,
        &hard_policy(),
        &fallback_policy,
    )
    .expect("fallback plan");
    let right = select_plan_v1(
        &fallback_snapshot,
        &fallback_frontier,
        &hard_policy(),
        &fallback_policy,
    )
    .expect("deterministic fallback plan");
    assert_eq!(left, right);
    assert_eq!(left.mode, PlanModeV1::DeterministicFallback);
    assert!(left.selected_candidate_ids.contains(&"a".to_owned()));
    assert!(left.selected_candidate_ids.contains(&"b".to_owned()));
    left.validate(
        &fallback_snapshot,
        &fallback_frontier,
        &hard_policy(),
        &fallback_policy,
    )
    .expect("fallback certificate validates");
}
