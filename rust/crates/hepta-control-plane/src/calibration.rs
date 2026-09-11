use hepta_codex_protocol::Sha256Digest;
use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::canonical_hash_v1;

const PPM: u64 = 1_000_000;
const MAXIMUM_SAMPLES: usize = 100_000;

/// One exact prediction/observation pair used to calibrate a scheduler model.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CalibrationSampleV1 {
    /// Stable workload class.
    pub workload_id: String,
    /// Exact predictor/model identity.
    pub predictor_version: String,
    /// Observation completion time.
    pub observed_at_unix_ms: u64,
    /// Predicted end-to-end duration in milliseconds.
    pub predicted_duration_ms: u64,
    /// Actual end-to-end duration in milliseconds.
    pub actual_duration_ms: u64,
    /// Predicted hard cost in micro-US dollars.
    pub predicted_cost_microusd: u64,
    /// Actual charged cost in micro-US dollars.
    pub actual_cost_microusd: u64,
    /// Predictor confidence in parts per million.
    pub confidence_ppm: u32,
}

/// Bounded calibration policy. All time/cost units are explicit and integer.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CalibrationPolicyV1 {
    pub version: u16,
    pub minimum_samples: usize,
    pub maximum_sample_age_ms: u64,
    pub report_validity_ms: u64,
    pub maximum_p95_relative_error_ppm: u32,
}

impl CalibrationPolicyV1 {
    fn validate(&self) -> Result<(), CalibrationError> {
        if self.version != 1
            || self.minimum_samples == 0
            || self.minimum_samples > MAXIMUM_SAMPLES
            || self.maximum_sample_age_ms == 0
            || self.report_validity_ms == 0
            || self.maximum_p95_relative_error_ppm > PPM as u32
        {
            return Err(CalibrationError::PolicyInvalid);
        }
        Ok(())
    }
}

/// Deterministic calibration result for one predictor/workload class.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CalibrationReportV1 {
    pub version: u16,
    pub workload_id: String,
    pub predictor_version: String,
    pub sample_count: usize,
    pub duration_p50_relative_error_ppm: u64,
    pub duration_p95_relative_error_ppm: u64,
    pub cost_p50_relative_error_ppm: u64,
    pub cost_p95_relative_error_ppm: u64,
    pub duration_underestimate_rate_ppm: u32,
    pub cost_underestimate_rate_ppm: u32,
    pub minimum_confidence_ppm: u32,
    pub recommended_uncertainty_ppm: u32,
    pub calibrated: bool,
    pub generated_at_unix_ms: u64,
    pub expires_at_unix_ms: u64,
    pub report_hash: Sha256Digest,
}

/// Calibrates one exact predictor/workload class from fresh observations.
pub fn calibrate_predictions_v1(
    samples: &[CalibrationSampleV1],
    policy: &CalibrationPolicyV1,
    now_unix_ms: u64,
) -> Result<CalibrationReportV1, CalibrationError> {
    policy.validate()?;
    if now_unix_ms == 0 || samples.len() < policy.minimum_samples || samples.len() > MAXIMUM_SAMPLES
    {
        return Err(CalibrationError::SampleInvalid);
    }
    let first = samples.first().ok_or(CalibrationError::SampleInvalid)?;
    if !valid_identifier(&first.workload_id) || !valid_identifier(&first.predictor_version) {
        return Err(CalibrationError::SampleInvalid);
    }
    let minimum_observed_at = now_unix_ms
        .checked_sub(policy.maximum_sample_age_ms)
        .unwrap_or_default();
    let mut duration_errors = Vec::with_capacity(samples.len());
    let mut cost_errors = Vec::with_capacity(samples.len());
    let mut duration_underestimates = 0_u64;
    let mut cost_underestimates = 0_u64;
    let mut minimum_confidence_ppm = PPM as u32;
    for sample in samples {
        if sample.workload_id != first.workload_id
            || sample.predictor_version != first.predictor_version
            || sample.observed_at_unix_ms < minimum_observed_at
            || sample.observed_at_unix_ms > now_unix_ms
            || sample.predicted_duration_ms == 0
            || sample.actual_duration_ms == 0
            || sample.confidence_ppm > PPM as u32
        {
            return Err(CalibrationError::SampleInvalid);
        }
        duration_errors.push(relative_error_ppm(
            sample.predicted_duration_ms,
            sample.actual_duration_ms,
        )?);
        cost_errors.push(relative_error_ppm(
            sample.predicted_cost_microusd,
            sample.actual_cost_microusd,
        )?);
        duration_underestimates = duration_underestimates
            .checked_add(u64::from(
                sample.predicted_duration_ms < sample.actual_duration_ms,
            ))
            .ok_or(CalibrationError::NumericOverflow)?;
        cost_underestimates = cost_underestimates
            .checked_add(u64::from(
                sample.predicted_cost_microusd < sample.actual_cost_microusd,
            ))
            .ok_or(CalibrationError::NumericOverflow)?;
        minimum_confidence_ppm = minimum_confidence_ppm.min(sample.confidence_ppm);
    }
    let duration_p50 = percentile(&mut duration_errors, 50)?;
    let duration_p95 = percentile(&mut duration_errors, 95)?;
    let cost_p50 = percentile(&mut cost_errors, 50)?;
    let cost_p95 = percentile(&mut cost_errors, 95)?;
    let duration_underestimate_rate_ppm = rate_ppm(duration_underestimates, samples.len())?;
    let cost_underestimate_rate_ppm = rate_ppm(cost_underestimates, samples.len())?;
    let recommended_uncertainty_ppm = u32::try_from(duration_p95.max(cost_p95).min(PPM))
        .map_err(|_| CalibrationError::NumericOverflow)?;
    let calibrated = duration_p95 <= u64::from(policy.maximum_p95_relative_error_ppm)
        && cost_p95 <= u64::from(policy.maximum_p95_relative_error_ppm);
    let expires_at_unix_ms = now_unix_ms
        .checked_add(policy.report_validity_ms)
        .ok_or(CalibrationError::NumericOverflow)?;
    let body = CalibrationReportBodyV1 {
        version: 1,
        workload_id: first.workload_id.clone(),
        predictor_version: first.predictor_version.clone(),
        sample_count: samples.len(),
        duration_p50_relative_error_ppm: duration_p50,
        duration_p95_relative_error_ppm: duration_p95,
        cost_p50_relative_error_ppm: cost_p50,
        cost_p95_relative_error_ppm: cost_p95,
        duration_underestimate_rate_ppm,
        cost_underestimate_rate_ppm,
        minimum_confidence_ppm,
        recommended_uncertainty_ppm,
        calibrated,
        generated_at_unix_ms: now_unix_ms,
        expires_at_unix_ms,
    };
    let report_hash = canonical_hash_v1(&body).map_err(|_| CalibrationError::Encoding)?;
    Ok(CalibrationReportV1 {
        version: body.version,
        workload_id: body.workload_id,
        predictor_version: body.predictor_version,
        sample_count: body.sample_count,
        duration_p50_relative_error_ppm: body.duration_p50_relative_error_ppm,
        duration_p95_relative_error_ppm: body.duration_p95_relative_error_ppm,
        cost_p50_relative_error_ppm: body.cost_p50_relative_error_ppm,
        cost_p95_relative_error_ppm: body.cost_p95_relative_error_ppm,
        duration_underestimate_rate_ppm: body.duration_underestimate_rate_ppm,
        cost_underestimate_rate_ppm: body.cost_underestimate_rate_ppm,
        minimum_confidence_ppm: body.minimum_confidence_ppm,
        recommended_uncertainty_ppm: body.recommended_uncertainty_ppm,
        calibrated: body.calibrated,
        generated_at_unix_ms: body.generated_at_unix_ms,
        expires_at_unix_ms: body.expires_at_unix_ms,
        report_hash,
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CalibrationReportBodyV1 {
    version: u16,
    workload_id: String,
    predictor_version: String,
    sample_count: usize,
    duration_p50_relative_error_ppm: u64,
    duration_p95_relative_error_ppm: u64,
    cost_p50_relative_error_ppm: u64,
    cost_p95_relative_error_ppm: u64,
    duration_underestimate_rate_ppm: u32,
    cost_underestimate_rate_ppm: u32,
    minimum_confidence_ppm: u32,
    recommended_uncertainty_ppm: u32,
    calibrated: bool,
    generated_at_unix_ms: u64,
    expires_at_unix_ms: u64,
}

fn relative_error_ppm(predicted: u64, actual: u64) -> Result<u64, CalibrationError> {
    let denominator = actual.max(1);
    let scaled = u128::from(predicted.abs_diff(actual))
        .checked_mul(u128::from(PPM))
        .ok_or(CalibrationError::NumericOverflow)?
        / u128::from(denominator);
    u64::try_from(scaled).map_err(|_| CalibrationError::NumericOverflow)
}

fn percentile(values: &mut [u64], percentage: usize) -> Result<u64, CalibrationError> {
    if values.is_empty() || !(1..=100).contains(&percentage) {
        return Err(CalibrationError::SampleInvalid);
    }
    values.sort_unstable();
    let rank = values.len().saturating_mul(percentage).div_ceil(100);
    Ok(values[rank.saturating_sub(1).min(values.len() - 1)])
}

fn rate_ppm(count: u64, sample_count: usize) -> Result<u32, CalibrationError> {
    let denominator =
        u128::try_from(sample_count).map_err(|_| CalibrationError::NumericOverflow)?;
    let value = u128::from(count)
        .checked_mul(u128::from(PPM))
        .ok_or(CalibrationError::NumericOverflow)?
        / denominator;
    u32::try_from(value).map_err(|_| CalibrationError::NumericOverflow)
}

fn valid_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':' | b'/')
        })
}

/// Calibration input, arithmetic, or encoding failure.
#[derive(Clone, Copy, Debug, Error, Eq, PartialEq)]
pub enum CalibrationError {
    #[error("calibration policy is invalid")]
    PolicyInvalid,
    #[error("calibration sample set is invalid")]
    SampleInvalid,
    #[error("calibration arithmetic overflow")]
    NumericOverflow,
    #[error("calibration report encoding failed")]
    Encoding,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn calibration_binds_units_confidence_and_expiry() {
        let samples = (0..20)
            .map(|index| CalibrationSampleV1 {
                workload_id: "workload.author".into(),
                predictor_version: "predictor:v1".into(),
                observed_at_unix_ms: 9_900 + index,
                predicted_duration_ms: 100,
                actual_duration_ms: 100 + (index % 5),
                predicted_cost_microusd: 1_000,
                actual_cost_microusd: 1_000 + (index % 5) * 10,
                confidence_ppm: 900_000,
            })
            .collect::<Vec<_>>();
        let report = calibrate_predictions_v1(
            &samples,
            &CalibrationPolicyV1 {
                version: 1,
                minimum_samples: 10,
                maximum_sample_age_ms: 1_000,
                report_validity_ms: 500,
                maximum_p95_relative_error_ppm: 100_000,
            },
            10_000,
        )
        .expect("calibration");
        assert!(report.calibrated);
        assert_eq!(report.expires_at_unix_ms, 10_500);
        assert_eq!(report.minimum_confidence_ppm, 900_000);
        assert!(report.report_hash.as_str().starts_with("sha256:"));
    }

    #[test]
    fn stale_or_mixed_predictor_samples_fail_closed() {
        let samples = vec![
            CalibrationSampleV1 {
                workload_id: "workload.author".into(),
                predictor_version: "v1".into(),
                observed_at_unix_ms: 1,
                predicted_duration_ms: 1,
                actual_duration_ms: 1,
                predicted_cost_microusd: 1,
                actual_cost_microusd: 1,
                confidence_ppm: 1,
            },
            CalibrationSampleV1 {
                workload_id: "workload.author".into(),
                predictor_version: "v2".into(),
                observed_at_unix_ms: 100,
                predicted_duration_ms: 1,
                actual_duration_ms: 1,
                predicted_cost_microusd: 1,
                actual_cost_microusd: 1,
                confidence_ppm: 1,
            },
        ];
        assert_eq!(
            calibrate_predictions_v1(
                &samples,
                &CalibrationPolicyV1 {
                    version: 1,
                    minimum_samples: 2,
                    maximum_sample_age_ms: 100,
                    report_validity_ms: 10,
                    maximum_p95_relative_error_ppm: 1_000_000,
                },
                100,
            ),
            Err(CalibrationError::SampleInvalid)
        );
    }
}
