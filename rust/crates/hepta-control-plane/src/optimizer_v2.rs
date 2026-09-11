use hepta_codex_protocol::Sha256Digest;
use hepta_module_platform::ModuleRegistryArtifactV1;
use serde::{Deserialize, Serialize};

use crate::{
    ControlPlaneError, ControlPlaneSnapshotV1, HardPolicyV1, PlanCertificateV1, PlannerPolicyV1,
    PlanningFrontierV1, canonical_hash_v1, contextual_pareto_frontier_v1, select_plan_v1,
};

/// Reproducible solver work budget. It binds decisions to work units rather than host wall time.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OptimizerWorkBudgetV2 {
    /// Contract version.
    pub version: u16,
    /// Maximum input candidates accepted by this optimizer invocation.
    pub maximum_frontier_candidates: usize,
    /// Maximum exact subset evaluations allowed before deterministic fallback.
    pub maximum_exact_subset_evaluations: u64,
}

impl OptimizerWorkBudgetV2 {
    /// Validates finite deterministic limits.
    pub fn validate(&self) -> Result<(), ControlPlaneError> {
        if self.version != 2
            || self.maximum_frontier_candidates == 0
            || self.maximum_frontier_candidates > 4_096
            || self.maximum_exact_subset_evaluations == 0
        {
            return Err(ControlPlaneError::PlannerPolicyInvalid);
        }
        Ok(())
    }

    fn exact_candidate_bound(&self) -> usize {
        let mut bound = 0usize;
        while bound < 20 {
            let next = bound + 1;
            let subsets = 1_u64 << next;
            if subsets > self.maximum_exact_subset_evaluations {
                break;
            }
            bound = next;
        }
        bound.max(1)
    }
}

/// One bounded observed prediction/actual pair for scheduler calibration.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CalibrationObservationV1 {
    /// Stable observation identity.
    pub observation_id: String,
    /// Predicted execution duration.
    pub predicted_duration_micros: u64,
    /// Observed execution duration.
    pub actual_duration_micros: u64,
    /// Predicted cost.
    pub predicted_cost_microusd: u64,
    /// Observed cost.
    pub actual_cost_microusd: u64,
}

/// Acceptance policy for integer-only scheduler calibration.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CalibrationPolicyV1 {
    /// Contract version.
    pub version: u16,
    /// Minimum observations before calibration can be accepted.
    pub minimum_samples: usize,
    /// Maximum p95 absolute relative duration error in PPM.
    pub maximum_p95_duration_error_ppm: u32,
    /// Maximum p95 absolute relative cost error in PPM.
    pub maximum_p95_cost_error_ppm: u32,
}

/// Deterministic calibration result bound into optimizer evidence.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CalibrationReportV1 {
    /// Contract version.
    pub version: u16,
    /// Number of observations.
    pub sample_count: usize,
    /// Median duration relative error in PPM.
    pub p50_duration_error_ppm: u32,
    /// p95 duration relative error in PPM.
    pub p95_duration_error_ppm: u32,
    /// Median cost relative error in PPM.
    pub p50_cost_error_ppm: u32,
    /// p95 cost relative error in PPM.
    pub p95_cost_error_ppm: u32,
    /// Whether the calibration policy is satisfied.
    pub accepted: bool,
    /// Canonical report identity.
    pub report_hash: Sha256Digest,
}

/// Evaluates deterministic integer calibration without host-dependent floating point.
pub fn assess_calibration_v1(
    policy: &CalibrationPolicyV1,
    observations: &[CalibrationObservationV1],
) -> Result<CalibrationReportV1, ControlPlaneError> {
    if policy.version != 1
        || policy.minimum_samples == 0
        || policy.minimum_samples > 1_000_000
        || policy.maximum_p95_duration_error_ppm > 1_000_000
        || policy.maximum_p95_cost_error_ppm > 1_000_000
        || observations.len() < policy.minimum_samples
        || observations.len() > 1_000_000
    {
        return Err(ControlPlaneError::PerformanceQualificationInvalid);
    }
    let mut duration_errors = Vec::with_capacity(observations.len());
    let mut cost_errors = Vec::with_capacity(observations.len());
    for observation in observations {
        if !valid_identifier(&observation.observation_id)
            || observation.actual_duration_micros == 0
        {
            return Err(ControlPlaneError::PerformanceQualificationInvalid);
        }
        duration_errors.push(relative_error_ppm(
            observation.predicted_duration_micros,
            observation.actual_duration_micros,
        )?);
        cost_errors.push(relative_error_ppm(
            observation.predicted_cost_microusd,
            observation.actual_cost_microusd,
        )?);
    }
    duration_errors.sort_unstable();
    cost_errors.sort_unstable();
    let p50_duration_error_ppm = percentile(&duration_errors, 50)?;
    let p95_duration_error_ppm = percentile(&duration_errors, 95)?;
    let p50_cost_error_ppm = percentile(&cost_errors, 50)?;
    let p95_cost_error_ppm = percentile(&cost_errors, 95)?;
    let accepted = p95_duration_error_ppm <= policy.maximum_p95_duration_error_ppm
        && p95_cost_error_ppm <= policy.maximum_p95_cost_error_ppm;
    let body = CalibrationReportBodyV1 {
        version: 1,
        sample_count: observations.len(),
        p50_duration_error_ppm,
        p95_duration_error_ppm,
        p50_cost_error_ppm,
        p95_cost_error_ppm,
        accepted,
    };
    let report_hash = canonical_hash_v1(&body)?;
    Ok(CalibrationReportV1 {
        version: body.version,
        sample_count: body.sample_count,
        p50_duration_error_ppm: body.p50_duration_error_ppm,
        p95_duration_error_ppm: body.p95_duration_error_ppm,
        p50_cost_error_ppm: body.p50_cost_error_ppm,
        p95_cost_error_ppm: body.p95_cost_error_ppm,
        accepted: body.accepted,
        report_hash,
    })
}

/// Recomputable global-optimizer result binding Pareto reduction, work budget, calibration and plan.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OptimizerReceiptV2 {
    /// Contract version.
    pub version: u16,
    /// Original candidate frontier identity.
    pub input_frontier_hash: Sha256Digest,
    /// Context-safe Pareto frontier identity.
    pub pareto_frontier_hash: Sha256Digest,
    /// Number of input candidates.
    pub input_candidate_count: usize,
    /// Number of candidates after Pareto reduction.
    pub pareto_candidate_count: usize,
    /// Exact work-budget identity.
    pub work_budget_hash: Sha256Digest,
    /// Optional accepted calibration report identity.
    pub calibration_report_hash: Option<Sha256Digest>,
    /// Deterministic underlying plan certificate.
    pub plan: PlanCertificateV1,
    /// Canonical optimizer receipt identity.
    pub receipt_hash: Sha256Digest,
}

/// Runs context-safe Pareto reduction and bounded planning under a reproducible work budget.
pub fn optimize_v2(
    snapshot: &ControlPlaneSnapshotV1,
    registry: &ModuleRegistryArtifactV1,
    frontier: &PlanningFrontierV1,
    hard_policy: &HardPolicyV1,
    planner_policy: &PlannerPolicyV1,
    work_budget: &OptimizerWorkBudgetV2,
    calibration: Option<&CalibrationReportV1>,
) -> Result<OptimizerReceiptV2, ControlPlaneError> {
    work_budget.validate()?;
    frontier.validate(snapshot, registry, hard_policy)?;
    if frontier.candidates.is_empty()
        || frontier.candidates.len() > work_budget.maximum_frontier_candidates
        || calibration.is_some_and(|report| !report.accepted)
    {
        return Err(ControlPlaneError::PlannerPolicyInvalid);
    }
    let pareto_candidates = contextual_pareto_frontier_v1(&frontier.candidates);
    let pareto_frontier = PlanningFrontierV1 {
        version: frontier.version,
        snapshot_hash: frontier.snapshot_hash.clone(),
        candidates: pareto_candidates,
    };
    pareto_frontier.validate(snapshot, registry, hard_policy)?;

    let mut effective_policy = planner_policy.clone();
    effective_policy.maximum_exact_candidates = effective_policy
        .maximum_exact_candidates
        .min(work_budget.exact_candidate_bound());
    effective_policy.validate()?;
    let plan = select_plan_v1(snapshot, &pareto_frontier, hard_policy, &effective_policy)?;
    let body = OptimizerReceiptBodyV2 {
        version: 2,
        input_frontier_hash: frontier.frontier_hash()?,
        pareto_frontier_hash: pareto_frontier.frontier_hash()?,
        input_candidate_count: frontier.candidates.len(),
        pareto_candidate_count: pareto_frontier.candidates.len(),
        work_budget_hash: canonical_hash_v1(work_budget)?,
        calibration_report_hash: calibration.map(|report| report.report_hash.clone()),
        plan: plan.clone(),
    };
    let receipt_hash = canonical_hash_v1(&body)?;
    Ok(OptimizerReceiptV2 {
        version: body.version,
        input_frontier_hash: body.input_frontier_hash,
        pareto_frontier_hash: body.pareto_frontier_hash,
        input_candidate_count: body.input_candidate_count,
        pareto_candidate_count: body.pareto_candidate_count,
        work_budget_hash: body.work_budget_hash,
        calibration_report_hash: body.calibration_report_hash,
        plan: body.plan,
        receipt_hash,
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CalibrationReportBodyV1 {
    version: u16,
    sample_count: usize,
    p50_duration_error_ppm: u32,
    p95_duration_error_ppm: u32,
    p50_cost_error_ppm: u32,
    p95_cost_error_ppm: u32,
    accepted: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OptimizerReceiptBodyV2 {
    version: u16,
    input_frontier_hash: Sha256Digest,
    pareto_frontier_hash: Sha256Digest,
    input_candidate_count: usize,
    pareto_candidate_count: usize,
    work_budget_hash: Sha256Digest,
    calibration_report_hash: Option<Sha256Digest>,
    plan: PlanCertificateV1,
}

fn relative_error_ppm(predicted: u64, actual: u64) -> Result<u32, ControlPlaneError> {
    let denominator = actual.max(1);
    let delta = predicted.abs_diff(actual);
    let ppm = u128::from(delta)
        .saturating_mul(1_000_000)
        .checked_div(u128::from(denominator))
        .ok_or(ControlPlaneError::PerformanceQualificationInvalid)?;
    u32::try_from(ppm.min(1_000_000))
        .map_err(|_| ControlPlaneError::PerformanceQualificationInvalid)
}

fn percentile(values: &[u32], percentile: usize) -> Result<u32, ControlPlaneError> {
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

    #[test]
    fn calibration_uses_integer_relative_error_and_thresholds() {
        let policy = CalibrationPolicyV1 {
            version: 1,
            minimum_samples: 2,
            maximum_p95_duration_error_ppm: 200_000,
            maximum_p95_cost_error_ppm: 200_000,
        };
        let observations = vec![
            CalibrationObservationV1 {
                observation_id: "obs-1".to_owned(),
                predicted_duration_micros: 100,
                actual_duration_micros: 100,
                predicted_cost_microusd: 100,
                actual_cost_microusd: 100,
            },
            CalibrationObservationV1 {
                observation_id: "obs-2".to_owned(),
                predicted_duration_micros: 110,
                actual_duration_micros: 100,
                predicted_cost_microusd: 90,
                actual_cost_microusd: 100,
            },
        ];
        let report = assess_calibration_v1(&policy, &observations).expect("calibration");
        assert_eq!(report.p95_duration_error_ppm, 100_000);
        assert_eq!(report.p95_cost_error_ppm, 100_000);
        assert!(report.accepted);
    }

    #[test]
    fn work_budget_derives_replayable_exact_bound() {
        let budget = OptimizerWorkBudgetV2 {
            version: 2,
            maximum_frontier_candidates: 100,
            maximum_exact_subset_evaluations: 1_024,
        };
        assert_eq!(budget.exact_candidate_bound(), 10);
    }
}
