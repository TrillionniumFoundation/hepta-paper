use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use thiserror::Error;

const MAX_OBSERVATIONS: usize = 100_000;
const PPM: u128 = 1_000_000;

/// One bounded prediction/outcome pair used to calibrate a specific module
/// version. Raw prompts, manuscript bytes and credentials are intentionally not
/// part of this contract.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PredictionObservationV1 {
    pub module_id: String,
    pub module_version: String,
    pub workload_id: String,
    pub predicted_duration_ms: u64,
    pub actual_duration_ms: u64,
    pub predicted_cost_microusd: u64,
    pub actual_cost_microusd: u64,
    pub predicted_success_ppm: u32,
    pub succeeded: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModuleCalibrationSummaryV1 {
    pub module_id: String,
    pub module_version: String,
    pub sample_count: usize,
    pub mean_duration_absolute_error_ppm: u32,
    pub mean_cost_absolute_error_ppm: u32,
    pub mean_success_absolute_error_ppm: u32,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CalibrationReceiptV1 {
    pub version: u16,
    pub summaries: Vec<ModuleCalibrationSummaryV1>,
    pub observation_count: usize,
    pub grants_authority: bool,
    pub receipt_hash: String,
}

/// Aggregates prediction error independently for every exact module version.
pub fn calibrate_predictions_v1(
    observations: Vec<PredictionObservationV1>,
) -> Result<CalibrationReceiptV1, CalibrationError> {
    if observations.is_empty() || observations.len() > MAX_OBSERVATIONS {
        return Err(CalibrationError::Contract);
    }
    let mut grouped = BTreeMap::<(String, String), CalibrationAccumulatorV1>::new();
    for observation in observations {
        validate_prediction(&observation)?;
        let key = (observation.module_id.clone(), observation.module_version.clone());
        let accumulator = grouped.entry(key).or_default();
        accumulator.sample_count = accumulator
            .sample_count
            .checked_add(1)
            .ok_or(CalibrationError::Arithmetic)?;
        accumulator.duration_error_ppm = accumulator
            .duration_error_ppm
            .checked_add(relative_error_ppm(
                observation.predicted_duration_ms,
                observation.actual_duration_ms,
            )?)
            .ok_or(CalibrationError::Arithmetic)?;
        accumulator.cost_error_ppm = accumulator
            .cost_error_ppm
            .checked_add(relative_error_ppm(
                observation.predicted_cost_microusd,
                observation.actual_cost_microusd,
            )?)
            .ok_or(CalibrationError::Arithmetic)?;
        let actual_success_ppm = if observation.succeeded { 1_000_000_u64 } else { 0_u64 };
        accumulator.success_error_ppm = accumulator
            .success_error_ppm
            .checked_add(u64::from(observation.predicted_success_ppm).abs_diff(actual_success_ppm))
            .ok_or(CalibrationError::Arithmetic)?;
    }

    let mut summaries = Vec::with_capacity(grouped.len());
    for ((module_id, module_version), accumulator) in grouped {
        let count = u64::try_from(accumulator.sample_count).map_err(|_| CalibrationError::Arithmetic)?;
        summaries.push(ModuleCalibrationSummaryV1 {
            module_id,
            module_version,
            sample_count: accumulator.sample_count,
            mean_duration_absolute_error_ppm: u32::try_from(accumulator.duration_error_ppm / count)
                .map_err(|_| CalibrationError::Arithmetic)?,
            mean_cost_absolute_error_ppm: u32::try_from(accumulator.cost_error_ppm / count)
                .map_err(|_| CalibrationError::Arithmetic)?,
            mean_success_absolute_error_ppm: u32::try_from(accumulator.success_error_ppm / count)
                .map_err(|_| CalibrationError::Arithmetic)?,
        });
    }
    let observation_count = summaries
        .iter()
        .try_fold(0_usize, |total, summary| total.checked_add(summary.sample_count))
        .ok_or(CalibrationError::Arithmetic)?;
    let body = CalibrationReceiptBodyV1 {
        version: 1,
        summaries: &summaries,
        observation_count,
        grants_authority: false,
    };
    let receipt_hash = canonical_hash("HeptaCalibrationReceiptV1", &body)?;
    Ok(CalibrationReceiptV1 {
        version: 1,
        summaries,
        observation_count,
        grants_authority: false,
        receipt_hash,
    })
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlannerVariantObservationV1 {
    pub workload_id: String,
    pub variant_id: String,
    pub objective_micros: i64,
    pub latency_ms: u64,
    pub hard_constraint_violations: u32,
    pub fallback_used: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChampionChallengerPolicyV1 {
    pub version: u16,
    pub minimum_workloads: usize,
    pub minimum_total_objective_improvement_micros: i64,
    pub maximum_latency_regression_ppm: u32,
    pub reject_challenger_fallback: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChampionChallengerReceiptV1 {
    pub version: u16,
    pub champion_id: String,
    pub challenger_id: String,
    pub workload_ids: Vec<String>,
    pub champion_total_objective_micros: i64,
    pub challenger_total_objective_micros: i64,
    pub champion_total_latency_ms: u64,
    pub challenger_total_latency_ms: u64,
    pub challenger_latency_regression_ppm: u32,
    pub promotion_recommended: bool,
    pub grants_authority: bool,
    pub receipt_hash: String,
}

/// Compares two planner variants on exactly the same workload set. Any hard
/// constraint violation rejects the comparison. A recommendation remains a
/// source-level planning signal and cannot activate a planner by itself.
pub fn compare_planner_variants_v1(
    champion_id: String,
    challenger_id: String,
    policy: ChampionChallengerPolicyV1,
    observations: Vec<PlannerVariantObservationV1>,
) -> Result<ChampionChallengerReceiptV1, CalibrationError> {
    if champion_id == challenger_id
        || !valid_identifier(&champion_id, 128)
        || !valid_identifier(&challenger_id, 128)
        || policy.version != 1
        || policy.minimum_workloads == 0
        || policy.minimum_workloads > 10_000
        || policy.maximum_latency_regression_ppm > 10_000_000
        || observations.is_empty()
        || observations.len() > MAX_OBSERVATIONS
    {
        return Err(CalibrationError::Contract);
    }

    let mut by_workload = BTreeMap::<String, BTreeMap<String, PlannerVariantObservationV1>>::new();
    for observation in observations {
        if !valid_identifier(&observation.workload_id, 256)
            || !valid_identifier(&observation.variant_id, 128)
            || observation.latency_ms == 0
            || observation.hard_constraint_violations != 0
            || (observation.variant_id != champion_id && observation.variant_id != challenger_id)
        {
            return Err(CalibrationError::ObservationInvalid);
        }
        let variants = by_workload.entry(observation.workload_id.clone()).or_default();
        let variant_id = observation.variant_id.clone();
        if variants.insert(variant_id, observation).is_some() {
            return Err(CalibrationError::ObservationInvalid);
        }
    }
    if by_workload.len() < policy.minimum_workloads
        || by_workload
            .values()
            .any(|variants| variants.len() != 2 || !variants.contains_key(&champion_id) || !variants.contains_key(&challenger_id))
    {
        return Err(CalibrationError::ObservationSetMismatch);
    }

    let mut workload_ids = Vec::with_capacity(by_workload.len());
    let mut champion_total_objective = 0_i64;
    let mut challenger_total_objective = 0_i64;
    let mut champion_total_latency = 0_u64;
    let mut challenger_total_latency = 0_u64;
    let mut challenger_used_fallback = false;
    for (workload_id, variants) in by_workload {
        let champion = variants.get(&champion_id).ok_or(CalibrationError::ObservationSetMismatch)?;
        let challenger = variants.get(&challenger_id).ok_or(CalibrationError::ObservationSetMismatch)?;
        workload_ids.push(workload_id);
        champion_total_objective = champion_total_objective
            .checked_add(champion.objective_micros)
            .ok_or(CalibrationError::Arithmetic)?;
        challenger_total_objective = challenger_total_objective
            .checked_add(challenger.objective_micros)
            .ok_or(CalibrationError::Arithmetic)?;
        champion_total_latency = champion_total_latency
            .checked_add(champion.latency_ms)
            .ok_or(CalibrationError::Arithmetic)?;
        challenger_total_latency = challenger_total_latency
            .checked_add(challenger.latency_ms)
            .ok_or(CalibrationError::Arithmetic)?;
        challenger_used_fallback |= challenger.fallback_used;
    }
    let latency_regression = regression_ppm(champion_total_latency, challenger_total_latency)?;
    let objective_improvement = challenger_total_objective
        .checked_sub(champion_total_objective)
        .ok_or(CalibrationError::Arithmetic)?;
    let promotion_recommended = objective_improvement
        >= policy.minimum_total_objective_improvement_micros
        && latency_regression <= policy.maximum_latency_regression_ppm
        && !(policy.reject_challenger_fallback && challenger_used_fallback);

    let body = ChampionChallengerBodyV1 {
        version: 1,
        champion_id: &champion_id,
        challenger_id: &challenger_id,
        workload_ids: &workload_ids,
        champion_total_objective_micros: champion_total_objective,
        challenger_total_objective_micros: challenger_total_objective,
        champion_total_latency_ms: champion_total_latency,
        challenger_total_latency_ms: challenger_total_latency,
        challenger_latency_regression_ppm: latency_regression,
        promotion_recommended,
        grants_authority: false,
    };
    let receipt_hash = canonical_hash("HeptaChampionChallengerReceiptV1", &body)?;
    Ok(ChampionChallengerReceiptV1 {
        version: 1,
        champion_id,
        challenger_id,
        workload_ids,
        champion_total_objective_micros: champion_total_objective,
        challenger_total_objective_micros: challenger_total_objective,
        champion_total_latency_ms: champion_total_latency,
        challenger_total_latency_ms: challenger_total_latency,
        challenger_latency_regression_ppm: latency_regression,
        promotion_recommended,
        grants_authority: false,
        receipt_hash,
    })
}

#[derive(Default)]
struct CalibrationAccumulatorV1 {
    sample_count: usize,
    duration_error_ppm: u64,
    cost_error_ppm: u64,
    success_error_ppm: u64,
}

fn validate_prediction(observation: &PredictionObservationV1) -> Result<(), CalibrationError> {
    if !valid_module_id(&observation.module_id)
        || !valid_semver(&observation.module_version)
        || !valid_identifier(&observation.workload_id, 256)
        || observation.predicted_duration_ms == 0
        || observation.actual_duration_ms == 0
        || observation.predicted_success_ppm > 1_000_000
    {
        return Err(CalibrationError::ObservationInvalid);
    }
    Ok(())
}

fn relative_error_ppm(predicted: u64, actual: u64) -> Result<u64, CalibrationError> {
    if actual == 0 {
        return Ok(if predicted == 0 { 0 } else { 1_000_000 });
    }
    let difference = u128::from(predicted.abs_diff(actual));
    let value = difference
        .checked_mul(PPM)
        .ok_or(CalibrationError::Arithmetic)?
        / u128::from(actual);
    u64::try_from(value.min(u128::from(u32::MAX))).map_err(|_| CalibrationError::Arithmetic)
}

fn regression_ppm(baseline: u64, observed: u64) -> Result<u32, CalibrationError> {
    if observed <= baseline {
        return Ok(0);
    }
    if baseline == 0 {
        return Err(CalibrationError::Arithmetic);
    }
    let value = u128::from(observed - baseline)
        .checked_mul(PPM)
        .ok_or(CalibrationError::Arithmetic)?
        / u128::from(baseline);
    u32::try_from(value).map_err(|_| CalibrationError::Arithmetic)
}

fn valid_identifier(value: &str, maximum: usize) -> bool {
    !value.is_empty()
        && value.len() <= maximum
        && value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':' | b'/')
        })
}

fn valid_module_id(value: &str) -> bool {
    value.starts_with("module.") && valid_identifier(value, 128)
}

fn valid_semver(value: &str) -> bool {
    let mut parts = value.split('.');
    let valid = |part: Option<&str>| {
        part.is_some_and(|value| {
            !value.is_empty()
                && (value == "0" || !value.starts_with('0'))
                && value.bytes().all(|byte| byte.is_ascii_digit())
        })
    };
    valid(parts.next()) && valid(parts.next()) && valid(parts.next()) && parts.next().is_none()
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
struct CalibrationReceiptBodyV1<'a> {
    version: u16,
    summaries: &'a [ModuleCalibrationSummaryV1],
    observation_count: usize,
    grants_authority: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ChampionChallengerBodyV1<'a> {
    version: u16,
    champion_id: &'a str,
    challenger_id: &'a str,
    workload_ids: &'a [String],
    champion_total_objective_micros: i64,
    challenger_total_objective_micros: i64,
    champion_total_latency_ms: u64,
    challenger_total_latency_ms: u64,
    challenger_latency_regression_ppm: u32,
    promotion_recommended: bool,
    grants_authority: bool,
}

#[derive(Clone, Debug, Error, Eq, PartialEq)]
pub enum CalibrationError {
    #[error("calibration contract is invalid")]
    Contract,
    #[error("calibration observation is invalid")]
    ObservationInvalid,
    #[error("calibration observation sets do not match")]
    ObservationSetMismatch,
    #[error("calibration arithmetic overflowed")]
    Arithmetic,
    #[error("calibration encoding failed")]
    Encoding,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn calibration_is_version_scoped_and_deterministic() {
        let observations = vec![
            PredictionObservationV1 {
                module_id: "module.author-node".to_owned(),
                module_version: "1.0.0".to_owned(),
                workload_id: "workload:a".to_owned(),
                predicted_duration_ms: 100,
                actual_duration_ms: 110,
                predicted_cost_microusd: 100,
                actual_cost_microusd: 120,
                predicted_success_ppm: 900_000,
                succeeded: true,
            },
            PredictionObservationV1 {
                module_id: "module.author-node".to_owned(),
                module_version: "2.0.0".to_owned(),
                workload_id: "workload:a".to_owned(),
                predicted_duration_ms: 80,
                actual_duration_ms: 80,
                predicted_cost_microusd: 90,
                actual_cost_microusd: 90,
                predicted_success_ppm: 1_000_000,
                succeeded: true,
            },
        ];
        let left = calibrate_predictions_v1(observations.clone()).expect("calibration");
        let right = calibrate_predictions_v1(observations).expect("calibration");
        assert_eq!(left, right);
        assert_eq!(left.summaries.len(), 2);
        assert!(!left.grants_authority);
    }

    #[test]
    fn champion_challenger_requires_same_workloads_and_zero_hard_violations() {
        let policy = ChampionChallengerPolicyV1 {
            version: 1,
            minimum_workloads: 2,
            minimum_total_objective_improvement_micros: 10,
            maximum_latency_regression_ppm: 100_000,
            reject_challenger_fallback: true,
        };
        let observations = ["w1", "w2"]
            .into_iter()
            .flat_map(|workload| {
                [
                    PlannerVariantObservationV1 {
                        workload_id: workload.to_owned(),
                        variant_id: "champion".to_owned(),
                        objective_micros: 100,
                        latency_ms: 100,
                        hard_constraint_violations: 0,
                        fallback_used: false,
                    },
                    PlannerVariantObservationV1 {
                        workload_id: workload.to_owned(),
                        variant_id: "challenger".to_owned(),
                        objective_micros: 110,
                        latency_ms: 105,
                        hard_constraint_violations: 0,
                        fallback_used: false,
                    },
                ]
            })
            .collect::<Vec<_>>();
        let receipt = compare_planner_variants_v1(
            "champion".to_owned(),
            "challenger".to_owned(),
            policy.clone(),
            observations.clone(),
        )
        .expect("comparison");
        assert!(receipt.promotion_recommended);
        assert!(!receipt.grants_authority);

        let mut invalid = observations;
        invalid[1].hard_constraint_violations = 1;
        assert_eq!(
            compare_planner_variants_v1(
                "champion".to_owned(),
                "challenger".to_owned(),
                policy,
                invalid,
            ),
            Err(CalibrationError::ObservationInvalid)
        );
    }
}
