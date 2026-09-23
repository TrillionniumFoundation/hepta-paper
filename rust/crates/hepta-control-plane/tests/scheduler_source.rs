use hepta_control_plane::{
    CalibrationObservationV1, CalibrationPolicyV1, OptimizerWorkBudgetV2, PlannerEvaluationV1,
    PlannerPromotionPolicyV1, PlannerSelectionReasonV1, assess_calibration_v1,
    select_planner_champion_v1,
};

fn calibration(
    observation_prefix: &str,
    predicted: u64,
) -> hepta_control_plane::CalibrationReportV1 {
    let policy = CalibrationPolicyV1 {
        version: 1,
        minimum_samples: 2,
        maximum_p95_duration_error_ppm: 300_000,
        maximum_p95_cost_error_ppm: 300_000,
    };
    let observations = vec![
        CalibrationObservationV1 {
            observation_id: format!("{observation_prefix}-1"),
            predicted_duration_micros: predicted,
            actual_duration_micros: 100,
            predicted_cost_microusd: predicted,
            actual_cost_microusd: 100,
        },
        CalibrationObservationV1 {
            observation_id: format!("{observation_prefix}-2"),
            predicted_duration_micros: predicted,
            actual_duration_micros: 100,
            predicted_cost_microusd: predicted,
            actual_cost_microusd: 100,
        },
    ];
    assess_calibration_v1(&policy, &observations).expect("calibration")
}

fn evaluation(
    planner_id: &str,
    calibration: &hepta_control_plane::CalibrationReportV1,
) -> PlannerEvaluationV1 {
    PlannerEvaluationV1 {
        planner_id: planner_id.to_owned(),
        calibration_report_hash: calibration.report_hash.clone(),
        hard_violation_count: 0,
        completed_value_micros: 1_000,
        deadline_loss_micros: 100,
        cost_microusd: 500,
        recovery_risk_micros: 10,
        fallback_count: 1,
    }
}

fn promotion_policy() -> PlannerPromotionPolicyV1 {
    PlannerPromotionPolicyV1 {
        version: 1,
        minimum_completed_value_improvement_micros: 10,
        maximum_recovery_risk_micros: 100,
        maximum_fallback_count: 10,
        maximum_calibration_error_ppm: 300_000,
    }
}

#[test]
fn planner_promotion_is_hard_gated_and_non_authorizing() {
    let champion_calibration = calibration("champion", 110);
    let challenger_calibration = calibration("challenger", 100);
    let champion = evaluation("planner:champion", &champion_calibration);
    let mut challenger = evaluation("planner:challenger", &challenger_calibration);
    challenger.completed_value_micros = u64::MAX;
    challenger.hard_violation_count = 1;

    let rejected = select_planner_champion_v1(
        &champion,
        &challenger,
        &champion_calibration,
        &challenger_calibration,
        &promotion_policy(),
    )
    .expect("hard-gated decision");
    assert!(!rejected.challenger_promoted);
    assert_eq!(
        rejected.reason,
        PlannerSelectionReasonV1::ChallengerSafetyRejected
    );
    assert!(!rejected.production_authority_granted);

    challenger.hard_violation_count = 0;
    challenger.completed_value_micros = 1_010;
    let promoted = select_planner_champion_v1(
        &champion,
        &challenger,
        &champion_calibration,
        &challenger_calibration,
        &promotion_policy(),
    )
    .expect("safe promotion");
    assert!(promoted.challenger_promoted);
    assert_eq!(promoted.selected_planner_id, "planner:challenger");
    assert!(!promoted.production_authority_granted);
}

#[test]
fn optimizer_work_budget_is_finite_and_replayable() {
    let bounded = OptimizerWorkBudgetV2 {
        version: 2,
        maximum_frontier_candidates: 4_096,
        maximum_exact_subset_evaluations: 1_024,
    };
    bounded.validate().expect("bounded work budget");

    let unbounded_frontier = OptimizerWorkBudgetV2 {
        version: 2,
        maximum_frontier_candidates: 4_097,
        maximum_exact_subset_evaluations: 1_024,
    };
    assert!(unbounded_frontier.validate().is_err());

    let zero_work = OptimizerWorkBudgetV2 {
        version: 2,
        maximum_frontier_candidates: 16,
        maximum_exact_subset_evaluations: 0,
    };
    assert!(zero_work.validate().is_err());
}
