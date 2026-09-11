use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;

const MAXIMUM_OBSERVATIONS: usize = 10_000;
const PARTS_PER_MILLION: u128 = 1_000_000;

/// Bounded acceptance envelope for one deterministic calibration report.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CalibrationPolicyV1 {
    pub policy_id: String,
    pub minimum_observations: usize,
    pub maximum_mean_absolute_utility_error_microunits: u64,
    pub maximum_mean_cost_error_ppm: u32,
    pub maximum_mean_latency_error_ppm: u32,
}

/// One prediction paired with the corresponding trusted observation.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CalibrationObservationV1 {
    pub candidate_id: String,
    pub predicted_utility_microunits: i64,
    pub observed_utility_microunits: i64,
    pub predicted_cost_microusd: u64,
    pub observed_cost_microusd: u64,
    pub predicted_latency_ms: u64,
    pub observed_latency_ms: u64,
}

/// Deterministic, non-authorizing planner calibration result.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CalibrationReportV1 {
    pub version: u16,
    pub policy_id: String,
    pub observation_count: usize,
    pub mean_absolute_utility_error_microunits: u64,
    pub mean_cost_error_ppm: u32,
    pub mean_latency_error_ppm: u32,
    pub calibrated: bool,
    pub production_authority_granted: bool,
    pub report_hash: String,
}

/// Calibrates integer utility, cost, and latency predictions against a complete
/// bounded observation set. The calculation is order independent and uses no
/// host clock or floating-point arithmetic.
pub fn calibrate_predictions_v1(
    policy: CalibrationPolicyV1,
    mut observations: Vec<CalibrationObservationV1>,
) -> Result<CalibrationReportV1, CalibrationError> {
    validate_policy(&policy)?;
    if observations.len() < policy.minimum_observations
        || observations.len() > MAXIMUM_OBSERVATIONS
    {
        return Err(CalibrationError::ObservationSetInvalid);
    }
    observations.sort_by(|left, right| left.candidate_id.cmp(&right.candidate_id));
    if observations
        .windows(2)
        .any(|window| window[0].candidate_id == window[1].candidate_id)
    {
        return Err(CalibrationError::DuplicateCandidate);
    }

    let mut total_utility_error = 0_u128;
    let mut total_cost_error_ppm = 0_u128;
    let mut total_latency_error_ppm = 0_u128;
    for observation in &observations {
        validate_observation(observation)?;
        total_utility_error = total_utility_error
            .checked_add(absolute_i64_difference(
                observation.predicted_utility_microunits,
                observation.observed_utility_microunits,
            ))
            .ok_or(CalibrationError::Arithmetic)?;
        total_cost_error_ppm = total_cost_error_ppm
            .checked_add(relative_error_ppm(
                observation.predicted_cost_microusd,
                observation.observed_cost_microusd,
            )?)
            .ok_or(CalibrationError::Arithmetic)?;
        total_latency_error_ppm = total_latency_error_ppm
            .checked_add(relative_error_ppm(
                observation.predicted_latency_ms,
                observation.observed_latency_ms,
            )?)
            .ok_or(CalibrationError::Arithmetic)?;
    }

    let count = u128::try_from(observations.len()).map_err(|_| CalibrationError::Arithmetic)?;
    let mean_absolute_utility_error_microunits = u64::try_from(total_utility_error / count)
        .map_err(|_| CalibrationError::Arithmetic)?;
    let mean_cost_error_ppm =
        u32::try_from(total_cost_error_ppm / count).map_err(|_| CalibrationError::Arithmetic)?;
    let mean_latency_error_ppm = u32::try_from(total_latency_error_ppm / count)
        .map_err(|_| CalibrationError::Arithmetic)?;
    let calibrated = mean_absolute_utility_error_microunits
        <= policy.maximum_mean_absolute_utility_error_microunits
        && mean_cost_error_ppm <= policy.maximum_mean_cost_error_ppm
        && mean_latency_error_ppm <= policy.maximum_mean_latency_error_ppm;
    let body = CalibrationReportBodyV1 {
        version: 1,
        policy_id: &policy.policy_id,
        observations: &observations,
        observation_count: observations.len(),
        mean_absolute_utility_error_microunits,
        mean_cost_error_ppm,
        mean_latency_error_ppm,
        calibrated,
        production_authority_granted: false,
    };
    let report_hash = canonical_hash("HeptaPlannerCalibrationV1", &body)?;
    Ok(CalibrationReportV1 {
        version: 1,
        policy_id: policy.policy_id,
        observation_count: observations.len(),
        mean_absolute_utility_error_microunits,
        mean_cost_error_ppm,
        mean_latency_error_ppm,
        calibrated,
        production_authority_granted: false,
        report_hash,
    })
}

fn validate_policy(policy: &CalibrationPolicyV1) -> Result<(), CalibrationError> {
    if !valid_identifier(&policy.policy_id)
        || policy.minimum_observations == 0
        || policy.minimum_observations > MAXIMUM_OBSERVATIONS
        || policy.maximum_mean_cost_error_ppm > 10_000_000
        || policy.maximum_mean_latency_error_ppm > 10_000_000
    {
        return Err(CalibrationError::PolicyInvalid);
    }
    Ok(())
}

fn validate_observation(observation: &CalibrationObservationV1) -> Result<(), CalibrationError> {
    if !valid_identifier(&observation.candidate_id)
        || observation.predicted_cost_microusd == 0
        || observation.predicted_latency_ms == 0
    {
        return Err(CalibrationError::ObservationInvalid);
    }
    Ok(())
}

fn absolute_i64_difference(left: i64, right: i64) -> u128 {
    let left = i128::from(left);
    let right = i128::from(right);
    left.abs_diff(right)
}

fn relative_error_ppm(predicted: u64, observed: u64) -> Result<u128, CalibrationError> {
    let difference = u128::from(predicted.abs_diff(observed));
    difference
        .checked_mul(PARTS_PER_MILLION)
        .map(|value| value / u128::from(predicted))
        .ok_or(CalibrationError::Arithmetic)
}

fn valid_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':' | b'/')
        })
}

fn canonical_hash<T: Serialize>(domain: &str, value: &T) -> Result<String, CalibrationError> {
    let bytes = serde_json::to_vec(value).map_err(|_| CalibrationError::Encoding)?;
    let mut hasher = Sha256::new();
    update_hash(&mut hasher, domain.as_bytes());
    update_hash(&mut hasher, &bytes);
    Ok(format!("sha256:{}", hex::encode(hasher.finalize())))
}

fn update_hash(hasher: &mut Sha256, value: &[u8]) {
    hasher.update(u64::try_from(value.len()).unwrap_or(u64::MAX).to_be_bytes());
    hasher.update(value);
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CalibrationReportBodyV1<'a> {
    version: u16,
    policy_id: &'a str,
    observations: &'a [CalibrationObservationV1],
    observation_count: usize,
    mean_absolute_utility_error_microunits: u64,
    mean_cost_error_ppm: u32,
    mean_latency_error_ppm: u32,
    calibrated: bool,
    production_authority_granted: bool,
}

#[derive(Clone, Copy, Debug, Error, Eq, PartialEq)]
pub enum CalibrationError {
    #[error("planner calibration policy is invalid")]
    PolicyInvalid,
    #[error("planner calibration observation set is invalid")]
    ObservationSetInvalid,
    #[error("planner calibration candidate is duplicated")]
    DuplicateCandidate,
    #[error("planner calibration observation is invalid")]
    ObservationInvalid,
    #[error("planner calibration arithmetic overflowed")]
    Arithmetic,
    #[error("planner calibration encoding failed")]
    Encoding,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn policy() -> CalibrationPolicyV1 {
        CalibrationPolicyV1 {
            policy_id: "calibration:v1".to_owned(),
            minimum_observations: 2,
            maximum_mean_absolute_utility_error_microunits: 10,
            maximum_mean_cost_error_ppm: 200_000,
            maximum_mean_latency_error_ppm: 200_000,
        }
    }

    fn observation(id: &str, utility_error: i64, cost: u64, latency: u64) -> CalibrationObservationV1 {
        CalibrationObservationV1 {
            candidate_id: id.to_owned(),
            predicted_utility_microunits: 100,
            observed_utility_microunits: 100 + utility_error,
            predicted_cost_microusd: 100,
            observed_cost_microusd: cost,
            predicted_latency_ms: 100,
            observed_latency_ms: latency,
        }
    }

    #[test]
    fn calibration_is_order_independent_and_non_authorizing() {
        let left = calibrate_predictions_v1(
            policy(),
            vec![
                observation("candidate:b", -5, 110, 110),
                observation("candidate:a", 5, 90, 90),
            ],
        )
        .expect("left report");
        let right = calibrate_predictions_v1(
            policy(),
            vec![
                observation("candidate:a", 5, 90, 90),
                observation("candidate:b", -5, 110, 110),
            ],
        )
        .expect("right report");
        assert_eq!(left, right);
        assert!(left.calibrated);
        assert_eq!(left.mean_absolute_utility_error_microunits, 5);
        assert_eq!(left.mean_cost_error_ppm, 100_000);
        assert_eq!(left.mean_latency_error_ppm, 100_000);
        assert!(!left.production_authority_granted);
    }

    #[test]
    fn duplicate_missing_and_zero_predictions_fail_closed() {
        assert_eq!(
            calibrate_predictions_v1(policy(), vec![observation("candidate:a", 0, 100, 100)]),
            Err(CalibrationError::ObservationSetInvalid)
        );
        assert_eq!(
            calibrate_predictions_v1(
                policy(),
                vec![
                    observation("candidate:a", 0, 100, 100),
                    observation("candidate:a", 0, 100, 100),
                ],
            ),
            Err(CalibrationError::DuplicateCandidate)
        );
        let mut invalid = observation("candidate:b", 0, 100, 100);
        invalid.predicted_latency_ms = 0;
        assert_eq!(
            calibrate_predictions_v1(
                policy(),
                vec![observation("candidate:a", 0, 100, 100), invalid],
            ),
            Err(CalibrationError::ObservationInvalid)
        );
    }
}
