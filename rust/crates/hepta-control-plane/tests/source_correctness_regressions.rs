use hepta_codex_protocol::Sha256Digest;
use hepta_control_plane::{
    CalibrationObservationV1, CalibrationPolicyV1, HardPolicyV1, OptimizerWorkBudgetV2,
    PerformanceBudgetV1, PerformanceSampleV1, PlanModeV1, PlannerEvaluationV1, PlannerPolicyV1,
    PlannerPromotionPolicyV1, PlannerSelectionReasonV1, SnapshotBuildRequestV1,
    assess_calibration_v1, assess_performance_v1, build_snapshot_v1, contextual_pareto_frontier_v1,
    optimize_v2, route_candidates_v1, select_planner_champion_v1,
};
use hepta_module_platform::{
    ActionCandidateV1, ActivationStateV1, AuthorityClassV1, ModuleExecutionV1, ModuleGrantV1,
    ModuleKindV1, ModuleManifestV1, ModuleRegistryArtifactV1, ModuleRegistryV1,
    QualificationTierV1, RegistryPolicyV1, ResourceVectorV1,
};
use std::collections::{BTreeMap, BTreeSet};

fn digest(byte: char) -> Sha256Digest {
    format!("sha256:{}", byte.to_string().repeat(64))
        .parse()
        .expect("digest")
}

fn resources(cpu_millis: u64) -> ResourceVectorV1 {
    ResourceVectorV1 {
        cpu_millis,
        memory_bytes: cpu_millis.saturating_mul(1024),
        ..ResourceVectorV1::default()
    }
}

fn candidate_registry() -> ModuleRegistryArtifactV1 {
    let capability_ids = BTreeSet::from(["CAP-MOD-CANDIDATES".to_owned()]);
    let mut registry = ModuleRegistryV1::new(RegistryPolicyV1 {
        version: 1,
        protocol_version: 1,
        central_writer_module_id: "module.commit-sequencer".to_owned(),
        grants: BTreeMap::from([(
            "module.candidate-router".to_owned(),
            ModuleGrantV1 {
                module_version: "1.0.0".to_owned(),
                authority: AuthorityClassV1::Pure,
                minimum_qualification: QualificationTierV1::Source,
                activation: ActivationStateV1::Shadow,
                capability_ids: capability_ids.clone(),
            },
        )]),
    })
    .expect("registry policy");
    registry
        .register(ModuleManifestV1 {
            version: 1,
            module_id: "module.candidate-router".to_owned(),
            module_version: "1.0.0".to_owned(),
            protocol_min: 1,
            protocol_max: 1,
            module_kind: ModuleKindV1::TrustedInProcess,
            requested_authority: AuthorityClassV1::Pure,
            qualification: QualificationTierV1::Source,
            requested_activation: ActivationStateV1::Shadow,
            capability_ids: capability_ids.into_iter().collect(),
            dependencies: vec![],
            primary_owner: "TEAM-KERNEL".to_owned(),
            secondary_owner: "TEAM-SCHEDULER".to_owned(),
            independent_reviewer: "TEAM-EVIDENCE".to_owned(),
            rollback_version: "0.9.0".to_owned(),
            execution: ModuleExecutionV1::InProcess {
                implementation_hash: digest('a'),
            },
        })
        .expect("register candidate router");
    registry.finish().expect("registry artifact")
}

fn policy(limit: u32) -> CalibrationPolicyV1 {
    CalibrationPolicyV1 {
        version: 1,
        minimum_samples: 1,
        maximum_p95_duration_error_ppm: limit,
        maximum_p95_cost_error_ppm: limit,
    }
}

fn observation(predicted: u64, actual: u64) -> CalibrationObservationV1 {
    CalibrationObservationV1 {
        observation_id: "sample-1".into(),
        predicted_duration_micros: predicted,
        actual_duration_micros: actual,
        predicted_cost_microusd: predicted,
        actual_cost_microusd: actual,
    }
}

#[test]
fn calibration_must_not_clip_large_errors_to_an_acceptable_threshold() {
    let report = assess_calibration_v1(&policy(1_000_000), &[observation(1_000, 1)])
        .expect("bounded calibration");
    assert!(!report.accepted);
    assert!(report.p95_duration_error_ppm > 1_000_000);
}

#[test]
fn calibration_must_round_up_just_over_the_hard_limit() {
    let report =
        assess_calibration_v1(&policy(333_333), &[observation(4, 3)]).expect("bounded calibration");
    assert!(!report.accepted);
    assert_eq!(report.p95_duration_error_ppm, 333_334);
}

#[test]
fn zero_actual_cost_with_positive_prediction_is_not_a_finite_relative_error() {
    let mut sample = observation(1, 1);
    sample.actual_cost_microusd = 0;
    let report = assess_calibration_v1(&policy(1_000_000), &[sample])
        .expect("calibration with rejected cost");
    assert!(!report.accepted);
    assert!(report.p95_cost_error_ppm > 1_000_000);
}

#[test]
fn duplicate_observation_ids_cannot_satisfy_minimum_sample_count() {
    let mut required = policy(1_000_000);
    required.minimum_samples = 2;
    assert!(assess_calibration_v1(&required, &[observation(1, 1), observation(1, 1)]).is_err());
}

#[test]
fn hard_failure_rate_matches_exact_rational_comparison() {
    // Exhaust every numerator through 64 operations, including 1/3 and zero/full failure.
    for operations in 1u64..=64 {
        for failures in 0..=operations {
            let numerator = failures * 1_000_000;
            let threshold = u32::try_from(numerator / operations).expect("bounded rate");
            let budget = PerformanceBudgetV1 {
                version: 1,
                workload_id: "workload-boundary".into(),
                maximum_p95_latency_micros: 10,
                maximum_p99_latency_micros: 10,
                maximum_peak_memory_bytes: 10,
                maximum_queue_age_micros: 10,
                maximum_failure_ppm: threshold,
            };
            let sample = PerformanceSampleV1 {
                workload_id: budget.workload_id.clone(),
                latency_micros: 1,
                operations,
                failures,
                peak_memory_bytes: 1,
                queue_age_micros: 1,
            };
            let result = assess_performance_v1(&budget, &[sample]).expect("rate assessment");
            assert_eq!(
                result.accepted,
                numerator <= u64::from(threshold) * operations,
                "failures={failures}, operations={operations}"
            );
        }
    }
}

#[test]
fn singleton_exact_search_does_not_exceed_a_one_evaluation_budget() {
    let registry = candidate_registry();
    let hard = HardPolicyV1 {
        version: 1,
        policy_id: "budget-policy".into(),
        registry_policy_hash: registry.policy_hash().clone(),
        forbidden_module_ids: BTreeSet::new(),
        minimum_evidence_by_capability: BTreeMap::new(),
        external_actions_authorized: false,
        maximum_central_writer_turns: 0,
        maximum_candidates_per_decision_group: 8,
    };
    let snapshot = build_snapshot_v1(
        SnapshotBuildRequestV1 {
            campaign_id: "campaign-budget".into(),
            campaign_revision: 1,
            state_hash: digest('b'),
            objective_version: "objective-v1".into(),
            constraint_set_hash: hard.policy_hash().expect("policy hash"),
            resource_limit: resources(100),
            budget_microusd: 100,
            required_capability_ids: BTreeSet::from(["CAP-MOD-CANDIDATES".to_owned()]),
            random_seed: None,
        },
        &registry,
    )
    .expect("snapshot");
    let candidate = ActionCandidateV1 {
        version: 1,
        candidate_id: "candidate-a".into(),
        decision_group: "decision-a".into(),
        module_id: "module.candidate-router".into(),
        module_version: "1.0.0".into(),
        capability_id: "CAP-MOD-CANDIDATES".into(),
        snapshot_hash: snapshot.snapshot_hash().expect("snapshot hash"),
        dependency_candidate_ids: vec![],
        resources: resources(1),
        utility_micros: 10,
        cost_microusd: 1,
        uncertainty_ppm: 0,
        evidence_tier: QualificationTierV1::Source,
        payload_hash: digest('d'),
    };
    let frontier =
        route_candidates_v1(&snapshot, &registry, &hard, vec![candidate]).expect("frontier");
    let planner = PlannerPolicyV1 {
        version: 1,
        maximum_exact_candidates: 20,
        cost_weight_ppm: 0,
        uncertainty_weight_micros_per_ppm: 0,
        maximum_selected_candidates: 16,
    };
    for budget in 1..=8 {
        let work = OptimizerWorkBudgetV2 {
            version: 2,
            maximum_frontier_candidates: 8,
            maximum_exact_subset_evaluations: budget,
        };
        let result = optimize_v2(
            &snapshot, &registry, &frontier, &hard, &planner, &work, None,
        )
        .expect("bounded optimizer");
        assert_eq!(
            result.plan.mode,
            if budget == 1 {
                PlanModeV1::DeterministicFallback
            } else {
                PlanModeV1::ExactOptimum
            }
        );
        assert_eq!(result.plan.selected_candidate_ids, vec!["candidate-a"]);
    }
}

#[test]
fn legacy_pareto_entrypoint_must_preserve_incoming_dependency_targets() {
    let mut base = ActionCandidateV1 {
        version: 1,
        candidate_id: "needed".into(),
        decision_group: "choice".into(),
        module_id: "module.candidate-router".into(),
        module_version: "1.0.0".into(),
        capability_id: "CAP-MOD-CANDIDATES".into(),
        snapshot_hash: digest('b'),
        dependency_candidate_ids: vec![],
        resources: resources(2),
        utility_micros: 1,
        cost_microusd: 2,
        uncertainty_ppm: 0,
        evidence_tier: QualificationTierV1::Source,
        payload_hash: digest('c'),
    };
    let needed = base.clone();
    base.candidate_id = "better".into();
    base.resources = resources(1);
    base.cost_microusd = 1;
    let better = base.clone();
    base.candidate_id = "dependent".into();
    base.decision_group = "dependent".into();
    base.dependency_candidate_ids = vec!["needed".into()];
    let result = contextual_pareto_frontier_v1(&[needed, better, base]);
    assert!(
        result
            .iter()
            .any(|candidate| candidate.candidate_id == "needed")
    );
}

fn evaluation(id: &str, hash: Sha256Digest) -> PlannerEvaluationV1 {
    PlannerEvaluationV1 {
        planner_id: id.into(),
        calibration_report_hash: hash,
        hard_violation_count: 0,
        completed_value_micros: u64::MAX - 1,
        deadline_loss_micros: 0,
        cost_microusd: 0,
        recovery_risk_micros: 0,
        fallback_count: 0,
    }
}

fn promotion_policy() -> PlannerPromotionPolicyV1 {
    PlannerPromotionPolicyV1 {
        version: 1,
        minimum_completed_value_improvement_micros: 10,
        maximum_recovery_risk_micros: 1,
        maximum_fallback_count: 1,
        maximum_calibration_error_ppm: 1_000_000,
    }
}

#[test]
fn planner_promotion_margin_is_not_weakened_by_integer_saturation() {
    let calibration = assess_calibration_v1(&policy(0), &[observation(1, 1)]).expect("calibration");
    let champion = evaluation("champion", calibration.report_hash.clone());
    let mut challenger = evaluation("challenger", calibration.report_hash.clone());
    challenger.completed_value_micros = u64::MAX;
    let decision = select_planner_champion_v1(
        &champion,
        &challenger,
        &calibration,
        &calibration,
        &promotion_policy(),
    )
    .expect("selection");
    assert!(!decision.challenger_promoted);
    assert_eq!(decision.reason, PlannerSelectionReasonV1::StableIncumbent);
}

#[test]
fn modified_calibration_body_is_rejected_before_planner_selection() {
    let good =
        assess_calibration_v1(&policy(1_000_000), &[observation(1, 1)]).expect("calibration");
    let mut modified = good.clone();
    modified.p95_cost_error_ppm = 10;
    let champion = evaluation("champion", good.report_hash.clone());
    let challenger = evaluation("challenger", modified.report_hash.clone());
    assert!(
        select_planner_champion_v1(
            &champion,
            &challenger,
            &good,
            &modified,
            &promotion_policy(),
        )
        .is_err()
    );
}
