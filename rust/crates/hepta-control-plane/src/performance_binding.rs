use hepta_codex_protocol::Sha256Digest;
use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::{
    PerformanceBudgetV1, PerformanceObservationV1, PerformanceQualificationReportV1,
    canonical_hash_v1, evaluate_performance_v1,
};

const PPM: u64 = 1_000_000;

/// Exact immutable subject for a performance claim.
///
/// A source report can bind these identities but cannot prove that a target host
/// actually possesses them; target-host qualification remains a separate evidence tier.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PerformanceSubjectV1 {
    pub version: u16,
    pub workload_id: String,
    pub source_tree_hash: Sha256Digest,
    pub binary_hash: Sha256Digest,
    pub configuration_hash: Sha256Digest,
    pub host_identity_hash: Sha256Digest,
    pub workload_definition_hash: Sha256Digest,
    pub measurement_method_hash: Sha256Digest,
    pub threshold_version: String,
}

impl PerformanceSubjectV1 {
    fn validate(&self) -> Result<(), PerformanceBindingError> {
        if self.version != 1
            || !valid_identifier(&self.workload_id)
            || !valid_identifier(&self.threshold_version)
        {
            return Err(PerformanceBindingError::SubjectInvalid);
        }
        Ok(())
    }
}

/// Source-level performance report cryptographically bound to the exact subject.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BoundPerformanceQualificationReportV1 {
    pub version: u16,
    pub subject: PerformanceSubjectV1,
    pub subject_hash: Sha256Digest,
    pub source_report: PerformanceQualificationReportV1,
    pub report_hash: Sha256Digest,
}

/// Produces a deterministic source report tied to exact source/binary/config/host/
/// workload/method/threshold identities. It does not elevate the host identity to
/// independently verified target-host evidence.
pub fn evaluate_bound_performance_v1(
    subject: PerformanceSubjectV1,
    observations: &[PerformanceObservationV1],
    budget: &PerformanceBudgetV1,
    now_unix_ms: u64,
) -> Result<BoundPerformanceQualificationReportV1, PerformanceBindingError> {
    subject.validate()?;
    if subject.workload_id != budget.workload_id {
        return Err(PerformanceBindingError::SubjectMismatch);
    }
    let source_report = evaluate_performance_v1(observations, budget, now_unix_ms)
        .map_err(|_| PerformanceBindingError::EvaluationRejected)?;
    let subject_hash = canonical_hash_v1(&subject).map_err(|_| PerformanceBindingError::Encoding)?;
    let body = BoundPerformanceBodyV1 {
        version: 1,
        subject_hash: &subject_hash,
        source_report_hash: &source_report.report_hash,
    };
    let report_hash = canonical_hash_v1(&body).map_err(|_| PerformanceBindingError::Encoding)?;
    Ok(BoundPerformanceQualificationReportV1 {
        version: body.version,
        subject,
        subject_hash,
        source_report,
        report_hash,
    })
}

/// Allowed source-level regression budget. Safety counters remain absolute and
/// are not converted into an average performance score.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PerformanceRegressionBudgetV1 {
    pub version: u16,
    pub maximum_p95_latency_regression_ppm: u32,
    pub maximum_p99_queue_age_regression_ppm: u32,
    pub maximum_failure_rate_increase_ppm: u32,
    pub maximum_zero_tolerance_violations: u64,
}

impl PerformanceRegressionBudgetV1 {
    fn validate(&self) -> Result<(), PerformanceBindingError> {
        if self.version != 1
            || self.maximum_p95_latency_regression_ppm > PPM as u32
            || self.maximum_p99_queue_age_regression_ppm > PPM as u32
            || self.maximum_failure_rate_increase_ppm > PPM as u32
        {
            return Err(PerformanceBindingError::BudgetInvalid);
        }
        Ok(())
    }
}

/// Deterministic baseline-versus-candidate regression result.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PerformanceRegressionReportV1 {
    pub version: u16,
    pub baseline_report_hash: Sha256Digest,
    pub candidate_report_hash: Sha256Digest,
    pub p95_latency_regression_ppm: u64,
    pub p99_queue_age_regression_ppm: u64,
    pub failure_rate_increase_ppm: u32,
    pub candidate_zero_tolerance_violations: u64,
    pub accepted: bool,
    pub report_hash: Sha256Digest,
}

/// Compares two reports only when host/workload/method/threshold identities match.
/// Binary/config/source identities may differ because those are the intended change.
pub fn compare_bound_performance_v1(
    baseline: &BoundPerformanceQualificationReportV1,
    candidate: &BoundPerformanceQualificationReportV1,
    budget: &PerformanceRegressionBudgetV1,
) -> Result<PerformanceRegressionReportV1, PerformanceBindingError> {
    budget.validate()?;
    if baseline.subject.workload_id != candidate.subject.workload_id
        || baseline.subject.host_identity_hash != candidate.subject.host_identity_hash
        || baseline.subject.workload_definition_hash != candidate.subject.workload_definition_hash
        || baseline.subject.measurement_method_hash != candidate.subject.measurement_method_hash
        || baseline.subject.threshold_version != candidate.subject.threshold_version
    {
        return Err(PerformanceBindingError::SubjectMismatch);
    }
    let p95_latency_regression_ppm = regression_ppm(
        baseline.source_report.p95_latency_ms,
        candidate.source_report.p95_latency_ms,
    )?;
    let p99_queue_age_regression_ppm = regression_ppm(
        baseline.source_report.p99_queue_age_ms,
        candidate.source_report.p99_queue_age_ms,
    )?;
    let failure_rate_increase_ppm = candidate
        .source_report
        .failure_rate_ppm
        .saturating_sub(baseline.source_report.failure_rate_ppm);
    let candidate_zero_tolerance_violations =
        candidate.source_report.zero_tolerance_violation_count;
    let accepted = baseline.source_report.accepted
        && candidate.source_report.accepted
        && p95_latency_regression_ppm <= u64::from(budget.maximum_p95_latency_regression_ppm)
        && p99_queue_age_regression_ppm
            <= u64::from(budget.maximum_p99_queue_age_regression_ppm)
        && failure_rate_increase_ppm <= budget.maximum_failure_rate_increase_ppm
        && candidate_zero_tolerance_violations <= budget.maximum_zero_tolerance_violations;
    let body = RegressionBodyV1 {
        version: 1,
        baseline_report_hash: &baseline.report_hash,
        candidate_report_hash: &candidate.report_hash,
        p95_latency_regression_ppm,
        p99_queue_age_regression_ppm,
        failure_rate_increase_ppm,
        candidate_zero_tolerance_violations,
        accepted,
    };
    let report_hash = canonical_hash_v1(&body).map_err(|_| PerformanceBindingError::Encoding)?;
    Ok(PerformanceRegressionReportV1 {
        version: body.version,
        baseline_report_hash: baseline.report_hash.clone(),
        candidate_report_hash: candidate.report_hash.clone(),
        p95_latency_regression_ppm,
        p99_queue_age_regression_ppm,
        failure_rate_increase_ppm,
        candidate_zero_tolerance_violations,
        accepted,
        report_hash,
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BoundPerformanceBodyV1<'a> {
    version: u16,
    subject_hash: &'a Sha256Digest,
    source_report_hash: &'a Sha256Digest,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RegressionBodyV1<'a> {
    version: u16,
    baseline_report_hash: &'a Sha256Digest,
    candidate_report_hash: &'a Sha256Digest,
    p95_latency_regression_ppm: u64,
    p99_queue_age_regression_ppm: u64,
    failure_rate_increase_ppm: u32,
    candidate_zero_tolerance_violations: u64,
    accepted: bool,
}

fn regression_ppm(baseline: u64, candidate: u64) -> Result<u64, PerformanceBindingError> {
    if candidate <= baseline {
        return Ok(0);
    }
    if baseline == 0 {
        return Ok(u64::MAX);
    }
    let scaled = u128::from(candidate - baseline)
        .checked_mul(u128::from(PPM))
        .ok_or(PerformanceBindingError::NumericOverflow)?
        / u128::from(baseline);
    u64::try_from(scaled).map_err(|_| PerformanceBindingError::NumericOverflow)
}

fn valid_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':' | b'/')
        })
}

/// Subject binding, evaluation, or regression failure.
#[derive(Clone, Copy, Debug, Error, Eq, PartialEq)]
pub enum PerformanceBindingError {
    #[error("performance subject is invalid")]
    SubjectInvalid,
    #[error("performance subjects are not comparable")]
    SubjectMismatch,
    #[error("performance regression budget is invalid")]
    BudgetInvalid,
    #[error("source performance evaluation rejected the subject")]
    EvaluationRejected,
    #[error("performance binding arithmetic overflow")]
    NumericOverflow,
    #[error("performance binding canonical encoding failed")]
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

    fn subject(binary: char) -> PerformanceSubjectV1 {
        PerformanceSubjectV1 {
            version: 1,
            workload_id: "workload.control".into(),
            source_tree_hash: digest('a'),
            binary_hash: digest(binary),
            configuration_hash: digest('c'),
            host_identity_hash: digest('d'),
            workload_definition_hash: digest('e'),
            measurement_method_hash: digest('f'),
            threshold_version: "threshold:v1".into(),
        }
    }

    fn budget() -> PerformanceBudgetV1 {
        PerformanceBudgetV1 {
            version: 1,
            workload_id: "workload.control".into(),
            minimum_samples: 20,
            maximum_observation_age_ms: 1_000,
            maximum_p95_latency_ms: 30,
            maximum_p99_queue_age_ms: 10,
            maximum_failure_rate_ppm: 0,
        }
    }

    fn observations(latency: u64, queue_age: u64) -> Vec<PerformanceObservationV1> {
        (0..100)
            .map(|index| PerformanceObservationV1 {
                workload_id: "workload.control".into(),
                run_id: format!("run-{index}"),
                observed_at_unix_ms: 10_000,
                latency_ms: latency,
                queue_age_ms: queue_age,
                success: true,
                zero_tolerance_violations: 0,
            })
            .collect()
    }

    #[test]
    fn bound_report_changes_when_binary_identity_changes() {
        let first = evaluate_bound_performance_v1(
            subject('1'),
            &observations(10, 2),
            &budget(),
            10_000,
        )
        .expect("first");
        let second = evaluate_bound_performance_v1(
            subject('2'),
            &observations(10, 2),
            &budget(),
            10_000,
        )
        .expect("second");
        assert_ne!(first.subject_hash, second.subject_hash);
        assert_ne!(first.report_hash, second.report_hash);
    }

    #[test]
    fn regression_budget_accepts_bounded_change_and_rejects_method_drift() {
        let baseline = evaluate_bound_performance_v1(
            subject('1'),
            &observations(10, 2),
            &budget(),
            10_000,
        )
        .expect("baseline");
        let candidate = evaluate_bound_performance_v1(
            subject('2'),
            &observations(11, 2),
            &budget(),
            10_000,
        )
        .expect("candidate");
        let regression = compare_bound_performance_v1(
            &baseline,
            &candidate,
            &PerformanceRegressionBudgetV1 {
                version: 1,
                maximum_p95_latency_regression_ppm: 100_000,
                maximum_p99_queue_age_regression_ppm: 0,
                maximum_failure_rate_increase_ppm: 0,
                maximum_zero_tolerance_violations: 0,
            },
        )
        .expect("regression");
        assert!(regression.accepted);
        assert_eq!(regression.p95_latency_regression_ppm, 100_000);

        let mut drift = candidate;
        drift.subject.measurement_method_hash = digest('0');
        assert_eq!(
            compare_bound_performance_v1(
                &baseline,
                &drift,
                &PerformanceRegressionBudgetV1 {
                    version: 1,
                    maximum_p95_latency_regression_ppm: 100_000,
                    maximum_p99_queue_age_regression_ppm: 0,
                    maximum_failure_rate_increase_ppm: 0,
                    maximum_zero_tolerance_violations: 0,
                },
            ),
            Err(PerformanceBindingError::SubjectMismatch)
        );
    }
}
