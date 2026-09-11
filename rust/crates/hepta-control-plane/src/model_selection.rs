use hepta_codex_protocol::Sha256Digest;
use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::{CalibrationReportV1, canonical_hash_v1};

/// Hard promotion policy for global planner champion/challenger evaluation.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlannerPromotionPolicyV1 {
    /// Contract version, exactly one.
    pub version: u16,
    /// Minimum completed-value improvement required to promote a challenger when
    /// all preceding lexicographic dimensions tie.
    pub minimum_completed_value_improvement_micros: u64,
    /// Maximum accepted recovery-risk estimate for either selectable planner.
    pub maximum_recovery_risk_micros: u64,
    /// Maximum accepted deterministic fallback count in the evaluation window.
    pub maximum_fallback_count: u64,
    /// Maximum p95 calibration error in either duration or cost.
    pub maximum_calibration_error_ppm: u32,
}

impl PlannerPromotionPolicyV1 {
    fn validate(&self) -> Result<(), PlannerSelectionError> {
        if self.version != 1 || self.maximum_calibration_error_ppm > 1_000_000 {
            return Err(PlannerSelectionError::PolicyInvalid);
        }
        Ok(())
    }
}

/// Exact bounded evaluation summary for one planner implementation.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlannerEvaluationV1 {
    /// Stable implementation/version identity.
    pub planner_id: String,
    /// Calibration report used for this exact evaluation.
    pub calibration_report_hash: Sha256Digest,
    /// Hard-constraint violations. Any non-zero value makes the planner ineligible.
    pub hard_violation_count: u64,
    /// Independently recomputed completed value.
    pub completed_value_micros: u64,
    /// Independently recomputed deadline loss.
    pub deadline_loss_micros: u64,
    /// Actual bounded cost in micro-US dollars.
    pub cost_microusd: u64,
    /// Independently assessed recovery risk.
    pub recovery_risk_micros: u64,
    /// Number of deterministic fallback plans selected in the evaluation window.
    pub fallback_count: u64,
}

/// Closed reason for the selected planner.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PlannerSelectionReasonV1 {
    /// Challenger violated a hard gate and cannot be selected.
    ChallengerSafetyRejected,
    /// Current champion violated a hard gate while the challenger remained safe.
    UnsafeChampionReplaced,
    /// Challenger produced strictly higher completed value by the required margin.
    CompletedValueImproved,
    /// Completed value tied and challenger reduced deadline loss.
    DeadlineLossImproved,
    /// Earlier dimensions tied and challenger reduced actual cost.
    CostImproved,
    /// Earlier dimensions tied and challenger reduced recovery risk.
    RecoveryRiskImproved,
    /// Earlier dimensions tied and challenger reduced fallback use.
    FallbackRateImproved,
    /// Earlier dimensions tied and challenger improved calibration error.
    CalibrationImproved,
    /// No strict policy-qualified improvement; incumbent remains champion.
    StableIncumbent,
}

/// Recomputable planner promotion decision. This selects source behavior only;
/// it never activates a deployment or grants writer/external authority.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlannerSelectionDecisionV1 {
    pub version: u16,
    pub champion_planner_id: String,
    pub challenger_planner_id: String,
    pub selected_planner_id: String,
    pub challenger_promoted: bool,
    pub reason: PlannerSelectionReasonV1,
    pub production_authority_granted: bool,
    pub decision_hash: Sha256Digest,
}

/// Select one planner with independent hard safety/calibration gates followed by
/// deterministic lexicographic comparison. Exact ties keep the incumbent.
pub fn select_planner_champion_v1(
    champion: &PlannerEvaluationV1,
    challenger: &PlannerEvaluationV1,
    champion_calibration: &CalibrationReportV1,
    challenger_calibration: &CalibrationReportV1,
    policy: &PlannerPromotionPolicyV1,
) -> Result<PlannerSelectionDecisionV1, PlannerSelectionError> {
    policy.validate()?;
    validate_evaluation(champion, champion_calibration)?;
    validate_evaluation(challenger, challenger_calibration)?;
    if champion.planner_id == challenger.planner_id {
        return Err(PlannerSelectionError::EvaluationInvalid);
    }

    let champion_safe = evaluation_safe(champion, champion_calibration, policy);
    let challenger_safe = evaluation_safe(challenger, challenger_calibration, policy);
    let (challenger_promoted, reason) = match (champion_safe, challenger_safe) {
        (true, false) => (false, PlannerSelectionReasonV1::ChallengerSafetyRejected),
        (false, true) => (true, PlannerSelectionReasonV1::UnsafeChampionReplaced),
        (false, false) => return Err(PlannerSelectionError::NoSafePlanner),
        (true, true) => compare_safe_planners(
            champion,
            challenger,
            champion_calibration,
            challenger_calibration,
            policy,
        ),
    };
    let selected_planner_id = if challenger_promoted {
        challenger.planner_id.clone()
    } else {
        champion.planner_id.clone()
    };
    let body = PlannerSelectionDecisionBodyV1 {
        version: 1,
        champion_planner_id: &champion.planner_id,
        challenger_planner_id: &challenger.planner_id,
        selected_planner_id: &selected_planner_id,
        challenger_promoted,
        reason,
        production_authority_granted: false,
    };
    let decision_hash = canonical_hash_v1(&body).map_err(|_| PlannerSelectionError::Encoding)?;
    Ok(PlannerSelectionDecisionV1 {
        version: 1,
        champion_planner_id: champion.planner_id.clone(),
        challenger_planner_id: challenger.planner_id.clone(),
        selected_planner_id,
        challenger_promoted,
        reason,
        production_authority_granted: false,
        decision_hash,
    })
}

fn compare_safe_planners(
    champion: &PlannerEvaluationV1,
    challenger: &PlannerEvaluationV1,
    champion_calibration: &CalibrationReportV1,
    challenger_calibration: &CalibrationReportV1,
    policy: &PlannerPromotionPolicyV1,
) -> (bool, PlannerSelectionReasonV1) {
    let required_value = champion
        .completed_value_micros
        .saturating_add(policy.minimum_completed_value_improvement_micros);
    if challenger.completed_value_micros >= required_value
        && challenger.completed_value_micros > champion.completed_value_micros
    {
        return (true, PlannerSelectionReasonV1::CompletedValueImproved);
    }
    if challenger.completed_value_micros != champion.completed_value_micros {
        return (false, PlannerSelectionReasonV1::StableIncumbent);
    }
    if challenger.deadline_loss_micros != champion.deadline_loss_micros {
        return (
            challenger.deadline_loss_micros < champion.deadline_loss_micros,
            if challenger.deadline_loss_micros < champion.deadline_loss_micros {
                PlannerSelectionReasonV1::DeadlineLossImproved
            } else {
                PlannerSelectionReasonV1::StableIncumbent
            },
        );
    }
    if challenger.cost_microusd != champion.cost_microusd {
        return (
            challenger.cost_microusd < champion.cost_microusd,
            if challenger.cost_microusd < champion.cost_microusd {
                PlannerSelectionReasonV1::CostImproved
            } else {
                PlannerSelectionReasonV1::StableIncumbent
            },
        );
    }
    if challenger.recovery_risk_micros != champion.recovery_risk_micros {
        return (
            challenger.recovery_risk_micros < champion.recovery_risk_micros,
            if challenger.recovery_risk_micros < champion.recovery_risk_micros {
                PlannerSelectionReasonV1::RecoveryRiskImproved
            } else {
                PlannerSelectionReasonV1::StableIncumbent
            },
        );
    }
    if challenger.fallback_count != champion.fallback_count {
        return (
            challenger.fallback_count < champion.fallback_count,
            if challenger.fallback_count < champion.fallback_count {
                PlannerSelectionReasonV1::FallbackRateImproved
            } else {
                PlannerSelectionReasonV1::StableIncumbent
            },
        );
    }
    let champion_error = calibration_error(champion_calibration);
    let challenger_error = calibration_error(challenger_calibration);
    if challenger_error < champion_error {
        return (true, PlannerSelectionReasonV1::CalibrationImproved);
    }
    (false, PlannerSelectionReasonV1::StableIncumbent)
}

fn validate_evaluation(
    evaluation: &PlannerEvaluationV1,
    calibration: &CalibrationReportV1,
) -> Result<(), PlannerSelectionError> {
    if !valid_identifier(&evaluation.planner_id)
        || evaluation.calibration_report_hash != calibration.report_hash
        || calibration.version != 1
        || calibration.sample_count == 0
    {
        return Err(PlannerSelectionError::EvaluationInvalid);
    }
    Ok(())
}

fn evaluation_safe(
    evaluation: &PlannerEvaluationV1,
    calibration: &CalibrationReportV1,
    policy: &PlannerPromotionPolicyV1,
) -> bool {
    evaluation.hard_violation_count == 0
        && calibration.accepted
        && calibration_error(calibration) <= policy.maximum_calibration_error_ppm
        && evaluation.recovery_risk_micros <= policy.maximum_recovery_risk_micros
        && evaluation.fallback_count <= policy.maximum_fallback_count
}

fn calibration_error(report: &CalibrationReportV1) -> u32 {
    report
        .p95_duration_error_ppm
        .max(report.p95_cost_error_ppm)
}

fn valid_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':' | b'/')
        })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PlannerSelectionDecisionBodyV1<'a> {
    version: u16,
    champion_planner_id: &'a str,
    challenger_planner_id: &'a str,
    selected_planner_id: &'a str,
    challenger_promoted: bool,
    reason: PlannerSelectionReasonV1,
    production_authority_granted: bool,
}

/// Promotion policy, calibration/evaluation identity, or encoding failure.
#[derive(Clone, Copy, Debug, Error, Eq, PartialEq)]
pub enum PlannerSelectionError {
    #[error("planner promotion policy is invalid")]
    PolicyInvalid,
    #[error("planner evaluation or calibration binding is invalid")]
    EvaluationInvalid,
    #[error("neither planner satisfies the hard promotion envelope")]
    NoSafePlanner,
    #[error("planner promotion decision encoding failed")]
    Encoding,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn digest(byte: char) -> Sha256Digest {
        format!("sha256:{}", byte.to_string().repeat(64))
            .parse()
            .expect("digest")
    }

    fn calibration(byte: char, error: u32, accepted: bool) -> CalibrationReportV1 {
        CalibrationReportV1 {
            version: 1,
            sample_count: 100,
            p50_duration_error_ppm: error / 2,
            p95_duration_error_ppm: error,
            p50_cost_error_ppm: error / 2,
            p95_cost_error_ppm: error,
            accepted,
            report_hash: digest(byte),
        }
    }

    fn evaluation(id: &str, report_hash: Sha256Digest) -> PlannerEvaluationV1 {
        PlannerEvaluationV1 {
            planner_id: id.to_owned(),
            calibration_report_hash: report_hash,
            hard_violation_count: 0,
            completed_value_micros: 1_000,
            deadline_loss_micros: 100,
            cost_microusd: 500,
            recovery_risk_micros: 10,
            fallback_count: 1,
        }
    }

    fn policy() -> PlannerPromotionPolicyV1 {
        PlannerPromotionPolicyV1 {
            version: 1,
            minimum_completed_value_improvement_micros: 10,
            maximum_recovery_risk_micros: 100,
            maximum_fallback_count: 10,
            maximum_calibration_error_ppm: 200_000,
        }
    }

    #[test]
    fn hard_violation_cannot_be_hidden_by_higher_value() {
        let champion_calibration = calibration('a', 100_000, true);
        let challenger_calibration = calibration('b', 50_000, true);
        let champion = evaluation("planner:champion", champion_calibration.report_hash.clone());
        let mut challenger = evaluation(
            "planner:challenger",
            challenger_calibration.report_hash.clone(),
        );
        challenger.hard_violation_count = 1;
        challenger.completed_value_micros = u64::MAX;
        let decision = select_planner_champion_v1(
            &champion,
            &challenger,
            &champion_calibration,
            &challenger_calibration,
            &policy(),
        )
        .expect("selection");
        assert!(!decision.challenger_promoted);
        assert_eq!(
            decision.reason,
            PlannerSelectionReasonV1::ChallengerSafetyRejected
        );
        assert!(!decision.production_authority_granted);
    }

    #[test]
    fn strictly_better_safe_challenger_is_promoted() {
        let champion_calibration = calibration('a', 100_000, true);
        let challenger_calibration = calibration('b', 50_000, true);
        let champion = evaluation("planner:champion", champion_calibration.report_hash.clone());
        let mut challenger = evaluation(
            "planner:challenger",
            challenger_calibration.report_hash.clone(),
        );
        challenger.completed_value_micros = 1_010;
        let decision = select_planner_champion_v1(
            &champion,
            &challenger,
            &champion_calibration,
            &challenger_calibration,
            &policy(),
        )
        .expect("selection");
        assert!(decision.challenger_promoted);
        assert_eq!(
            decision.reason,
            PlannerSelectionReasonV1::CompletedValueImproved
        );
        assert_eq!(decision.selected_planner_id, "planner:challenger");
    }

    #[test]
    fn exact_tie_keeps_incumbent() {
        let champion_calibration = calibration('a', 100_000, true);
        let challenger_calibration = calibration('b', 100_000, true);
        let champion = evaluation("planner:champion", champion_calibration.report_hash.clone());
        let challenger = evaluation(
            "planner:challenger",
            challenger_calibration.report_hash.clone(),
        );
        let decision = select_planner_champion_v1(
            &champion,
            &challenger,
            &champion_calibration,
            &challenger_calibration,
            &policy(),
        )
        .expect("selection");
        assert!(!decision.challenger_promoted);
        assert_eq!(
            decision.reason,
            PlannerSelectionReasonV1::StableIncumbent
        );
    }
}
