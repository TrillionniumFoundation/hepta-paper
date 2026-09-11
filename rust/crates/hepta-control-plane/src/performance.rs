use std::collections::BTreeSet;

use hepta_codex_protocol::Sha256Digest;
use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::canonical_hash_v1;

const PPM: u64 = 1_000_000;
const MAXIMUM_OBSERVATIONS: usize = 1_000_000;

/// One bounded canonical-workload observation. It carries no authority by itself.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PerformanceObservationV1 {
    pub workload_id: String,
    pub run_id: String,
    pub observed_at_unix_ms: u64,
    pub latency_ms: u64,
    pub queue_age_ms: u64,
    pub success: bool,
    pub zero_tolerance_violations: u32,
}

/// Source-level evaluator policy for one canonical workload.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PerformanceBudgetV1 {
    pub version: u16,
    pub workload_id: String,
    pub minimum_samples: usize,
    pub maximum_observation_age_ms: u64,
    pub maximum_p95_latency_ms: u64,
    pub maximum_p99_queue_age_ms: u64,
    pub maximum_failure_rate_ppm: u32,
}

impl PerformanceBudgetV1 {
    fn validate(&self) -> Result<(), PerformanceError> {
        if self.version != 1
            || !valid_identifier(&self.workload_id)
            || self.minimum_samples == 0
            || self.minimum_samples > MAXIMUM_OBSERVATIONS
            || self.maximum_observation_age_ms == 0
            || self.maximum_p95_latency_ms == 0
            || self.maximum_p99_queue_age_ms == 0
            || self.maximum_failure_rate_ppm > PPM as u32
        {
            return Err(PerformanceError::BudgetInvalid);
        }
        Ok(())
    }
}

/// Deterministic source report. `accepted` is not target-host qualification.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PerformanceQualificationReportV1 {
    pub version: u16,
    pub workload_id: String,
    pub sample_count: usize,
    pub success_count: usize,
    pub failure_rate_ppm: u32,
    pub p50_latency_ms: u64,
    pub p95_latency_ms: u64,
    pub p99_latency_ms: u64,
    pub p50_queue_age_ms: u64,
    pub p95_queue_age_ms: u64,
    pub p99_queue_age_ms: u64,
    pub zero_tolerance_violation_count: u64,
    pub accepted: bool,
    pub generated_at_unix_ms: u64,
    pub report_hash: Sha256Digest,
}

/// Evaluates a canonical workload deterministically while preserving the
/// separation between source evidence and target-host qualification.
pub fn evaluate_performance_v1(
    observations: &[PerformanceObservationV1],
    budget: &PerformanceBudgetV1,
    now_unix_ms: u64,
) -> Result<PerformanceQualificationReportV1, PerformanceError> {
    budget.validate()?;
    if now_unix_ms == 0
        || observations.len() < budget.minimum_samples
        || observations.len() > MAXIMUM_OBSERVATIONS
    {
        return Err(PerformanceError::ObservationInvalid);
    }
    let minimum_observed_at = now_unix_ms.saturating_sub(budget.maximum_observation_age_ms);
    let mut run_ids = BTreeSet::new();
    let mut latencies = Vec::with_capacity(observations.len());
    let mut queue_ages = Vec::with_capacity(observations.len());
    let mut success_count = 0_usize;
    let mut zero_tolerance_violation_count = 0_u64;
    for observation in observations {
        if observation.workload_id != budget.workload_id
            || !valid_identifier(&observation.run_id)
            || !run_ids.insert(observation.run_id.as_str())
            || observation.observed_at_unix_ms < minimum_observed_at
            || observation.observed_at_unix_ms > now_unix_ms
        {
            return Err(PerformanceError::ObservationInvalid);
        }
        latencies.push(observation.latency_ms);
        queue_ages.push(observation.queue_age_ms);
        success_count = success_count
            .checked_add(usize::from(observation.success))
            .ok_or(PerformanceError::NumericOverflow)?;
        zero_tolerance_violation_count = zero_tolerance_violation_count
            .checked_add(u64::from(observation.zero_tolerance_violations))
            .ok_or(PerformanceError::NumericOverflow)?;
    }
    let failure_count = observations
        .len()
        .checked_sub(success_count)
        .ok_or(PerformanceError::NumericOverflow)?;
    let failure_rate_ppm = rate_ppm(failure_count, observations.len())?;
    let p50_latency_ms = percentile(&mut latencies, 50)?;
    let p95_latency_ms = percentile(&mut latencies, 95)?;
    let p99_latency_ms = percentile(&mut latencies, 99)?;
    let p50_queue_age_ms = percentile(&mut queue_ages, 50)?;
    let p95_queue_age_ms = percentile(&mut queue_ages, 95)?;
    let p99_queue_age_ms = percentile(&mut queue_ages, 99)?;
    let accepted = failure_rate_ppm <= budget.maximum_failure_rate_ppm
        && p95_latency_ms <= budget.maximum_p95_latency_ms
        && p99_queue_age_ms <= budget.maximum_p99_queue_age_ms
        && zero_tolerance_violation_count == 0;
    let body = PerformanceReportBodyV1 {
        version: 1,
        workload_id: budget.workload_id.clone(),
        sample_count: observations.len(),
        success_count,
        failure_rate_ppm,
        p50_latency_ms,
        p95_latency_ms,
        p99_latency_ms,
        p50_queue_age_ms,
        p95_queue_age_ms,
        p99_queue_age_ms,
        zero_tolerance_violation_count,
        accepted,
        generated_at_unix_ms: now_unix_ms,
    };
    let report_hash = canonical_hash_v1(&body).map_err(|_| PerformanceError::Encoding)?;
    Ok(PerformanceQualificationReportV1 {
        version: body.version,
        workload_id: body.workload_id,
        sample_count: body.sample_count,
        success_count: body.success_count,
        failure_rate_ppm: body.failure_rate_ppm,
        p50_latency_ms: body.p50_latency_ms,
        p95_latency_ms: body.p95_latency_ms,
        p99_latency_ms: body.p99_latency_ms,
        p50_queue_age_ms: body.p50_queue_age_ms,
        p95_queue_age_ms: body.p95_queue_age_ms,
        p99_queue_age_ms: body.p99_queue_age_ms,
        zero_tolerance_violation_count: body.zero_tolerance_violation_count,
        accepted: body.accepted,
        generated_at_unix_ms: body.generated_at_unix_ms,
        report_hash,
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PerformanceReportBodyV1 {
    version: u16,
    workload_id: String,
    sample_count: usize,
    success_count: usize,
    failure_rate_ppm: u32,
    p50_latency_ms: u64,
    p95_latency_ms: u64,
    p99_latency_ms: u64,
    p50_queue_age_ms: u64,
    p95_queue_age_ms: u64,
    p99_queue_age_ms: u64,
    zero_tolerance_violation_count: u64,
    accepted: bool,
    generated_at_unix_ms: u64,
}

fn percentile(values: &mut [u64], percentage: usize) -> Result<u64, PerformanceError> {
    if values.is_empty() || !(1..=100).contains(&percentage) {
        return Err(PerformanceError::ObservationInvalid);
    }
    values.sort_unstable();
    let rank = values.len().saturating_mul(percentage).div_ceil(100);
    Ok(values[rank.saturating_sub(1).min(values.len() - 1)])
}

fn rate_ppm(count: usize, total: usize) -> Result<u32, PerformanceError> {
    let numerator = u128::try_from(count)
        .map_err(|_| PerformanceError::NumericOverflow)?
        .checked_mul(u128::from(PPM))
        .ok_or(PerformanceError::NumericOverflow)?;
    let denominator = u128::try_from(total).map_err(|_| PerformanceError::NumericOverflow)?;
    u32::try_from(numerator / denominator).map_err(|_| PerformanceError::NumericOverflow)
}

fn valid_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':' | b'/')
        })
}

/// Source performance evaluator failure.
#[derive(Clone, Copy, Debug, Error, Eq, PartialEq)]
pub enum PerformanceError {
    #[error("performance budget is invalid")]
    BudgetInvalid,
    #[error("performance observation set is invalid")]
    ObservationInvalid,
    #[error("performance arithmetic overflow")]
    NumericOverflow,
    #[error("performance report encoding failed")]
    Encoding,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn observations(count: usize) -> Vec<PerformanceObservationV1> {
        (0..count)
            .map(|index| PerformanceObservationV1 {
                workload_id: "workload.control".into(),
                run_id: format!("run-{index}"),
                observed_at_unix_ms: 10_000,
                latency_ms: 10 + u64::try_from(index % 3).expect("small"),
                queue_age_ms: 2,
                success: true,
                zero_tolerance_violations: 0,
            })
            .collect()
    }

    #[test]
    fn canonical_workload_evaluator_enforces_slo_and_zero_tolerance() {
        let budget = PerformanceBudgetV1 {
            version: 1,
            workload_id: "workload.control".into(),
            minimum_samples: 20,
            maximum_observation_age_ms: 1_000,
            maximum_p95_latency_ms: 20,
            maximum_p99_queue_age_ms: 5,
            maximum_failure_rate_ppm: 0,
        };
        let report = evaluate_performance_v1(&observations(100), &budget, 10_000)
            .expect("performance report");
        assert!(report.accepted);
        assert_eq!(report.failure_rate_ppm, 0);
        assert_eq!(report.zero_tolerance_violation_count, 0);
    }

    #[test]
    fn safety_violation_is_reported_not_normalized_away() {
        let budget = PerformanceBudgetV1 {
            version: 1,
            workload_id: "workload.control".into(),
            minimum_samples: 2,
            maximum_observation_age_ms: 1_000,
            maximum_p95_latency_ms: 20,
            maximum_p99_queue_age_ms: 5,
            maximum_failure_rate_ppm: 500_000,
        };
        let mut values = observations(2);
        values[1].zero_tolerance_violations = 1;
        let report = evaluate_performance_v1(&values, &budget, 10_000).expect("report");
        assert!(!report.accepted);
        assert_eq!(report.zero_tolerance_violation_count, 1);
    }
}
