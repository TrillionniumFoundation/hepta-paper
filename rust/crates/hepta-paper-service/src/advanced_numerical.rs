//! Native reference-candidate execution for the advanced numerical operator.
//!
//! This module deliberately implements only the three deterministic reference
//! families shipped in `numerical-plugins/reference-candidates/worker.py`:
//! linear algebra, Monte Carlo, and convex quadratic optimization.  It is a
//! local Rust computation surface, not the incumbent plugin runner.  Signed
//! plugin bundles, executable/source identity, an OS sandbox, GPU containers,
//! independent oracle/replay/uncertainty qualification, and production
//! activation remain outside this module and are reported as blockers.

#![allow(clippy::cast_precision_loss)]

use hepta_legacy_compatibility::production_hash_record_v1;
use serde_json::{Map, Value, json};
use thiserror::Error;

/// Maximum raw request size accepted by the native candidate command.
pub const ADVANCED_NUMERICAL_MAX_INPUT_BYTES: usize = 32 * 1024;
const MAX_DIMENSION: usize = 128;
const MAX_SAMPLES: usize = 1_000_000;
const MAX_ITERATIONS: usize = 1_000_000;
const SAFE_INTEGER: i64 = 9_007_199_254_740_991;
const SUPPORTED_FAMILIES: [&str; 3] = ["linear-algebra", "monte-carlo", "optimization"];
const BLOCKERS: [&str; 7] = [
    "advanced_numerical_plugin_signed_bundle_unverified",
    "advanced_numerical_plugin_runtime_identity_unverified",
    "advanced_numerical_plugin_os_sandbox_unverified",
    "advanced_numerical_plugin_independent_oracle_missing",
    "advanced_numerical_plugin_replay_qualification_missing",
    "advanced_numerical_plugin_uncertainty_qualification_missing",
    "advanced_numerical_plugin_production_activation_forbidden",
];

#[derive(Debug, Error, PartialEq)]
pub enum AdvancedNumericalError {
    #[error("advanced numerical request is invalid: {0}")]
    Contract(&'static str),
    #[error("advanced numerical family is unsupported")]
    UnsupportedFamily,
    #[error("advanced numerical numeric input is invalid")]
    Numeric,
    #[error("advanced numerical canonical hash failed")]
    Hash,
    #[error("advanced numerical request exceeds the input bound")]
    InputLimit,
    #[error("advanced numerical computation diverged or is singular")]
    Computation,
}

type Result<T> = std::result::Result<T, AdvancedNumericalError>;

/// Execute a bounded native reference candidate and return a self-hashed,
/// explicitly unqualified result.  The returned object intentionally differs
/// from the incumbent execution receipt: no worker receipt or authority is
/// fabricated here.
pub fn execute_advanced_numerical_plugin_v1(request: &Value) -> Result<Value> {
    let parsed = ParsedRequest::parse(request)?;
    let (estimate, uncertainty, oracle) = match parsed.analysis_family.as_str() {
        "linear-algebra" => linear_algebra(&parsed.input)?,
        "monte-carlo" => monte_carlo(&parsed.input, parsed.seed)?,
        "optimization" => optimization(&parsed.input)?,
        _ => return Err(AdvancedNumericalError::UnsupportedFamily),
    };
    let estimate_hash = hash_record("AdvancedNumericalEstimateArtifact", &estimate)?;
    let uncertainty_hash = hash_record("AdvancedNumericalUncertaintyArtifact", &uncertainty)?;
    let oracle_hash = hash_record("AdvancedNumericalOracleReceipt", &oracle)?;
    let replay = json!({
        "kind": "DeterministicNativeReferenceReplay",
        "analysisFamily": parsed.analysis_family,
        "requestHash": parsed.request_hash,
        "seed": parsed.seed,
        "estimateHash": estimate_hash,
    });
    let replay_hash = hash_record("AdvancedNumericalReplayReceipt", &replay)?;
    let uncertainty_receipt_hash = hash_record(
        "AdvancedNumericalUncertaintyReceipt",
        &json!({"estimate": estimate, "uncertainty": uncertainty}),
    )?;
    let mut payload = json!({
        "version": 1,
        "kind": "AdvancedNumericalPluginResult",
        "status": "advanced_numerical_computation_completed",
        "pluginId": parsed.plugin_id,
        "analysisFamily": parsed.analysis_family,
        "requestHash": parsed.request_hash,
        "oracleContractHash": parsed.oracle_contract_hash,
        "replayContractHash": parsed.replay_contract_hash,
        "uncertaintyContractHash": parsed.uncertainty_contract_hash,
        "estimateArtifactHash": estimate_hash,
        "uncertaintyArtifactHash": uncertainty_hash,
        "oracleReceiptHash": oracle_hash,
        "replayReceiptHash": replay_hash,
        "uncertaintyReceiptHash": uncertainty_receipt_hash,
        "estimate": estimate,
        "uncertainty": uncertainty,
        "oracle": oracle,
        "replay": replay,
        "qualificationStatus": "reference_candidate_unqualified",
        "nativeExecution": true,
        "productionQualified": false,
        "blockers": BLOCKERS,
    });
    let result_hash = hash_record("AdvancedNumericalPluginResult", &payload)?;
    payload
        .as_object_mut()
        .ok_or(AdvancedNumericalError::Hash)?
        .insert(
            "advancedNumericalPluginResultHash".into(),
            Value::String(result_hash),
        );
    Ok(payload)
}

/// Whether the native implementation has a reference-candidate computation
/// for a family.  This is a capability report only and grants no authority.
pub fn supports_advanced_numerical_family_v1(family: &str) -> bool {
    SUPPORTED_FAMILIES.contains(&family)
}

struct ParsedRequest {
    plugin_id: String,
    analysis_family: String,
    seed: i64,
    input: Value,
    request_hash: String,
    oracle_contract_hash: String,
    replay_contract_hash: String,
    uncertainty_contract_hash: String,
}

impl ParsedRequest {
    fn parse(request: &Value) -> Result<Self> {
        let object = request
            .as_object()
            .ok_or(AdvancedNumericalError::Contract("request_object_required"))?;
        if object.get("version") != Some(&Value::from(1))
            || object.get("kind").and_then(Value::as_str) != Some("AdvancedNumericalPluginRequest")
        {
            return Err(AdvancedNumericalError::Contract("request_kind_invalid"));
        }
        if serde_json::to_vec(request)
            .map_err(|_| AdvancedNumericalError::Hash)?
            .len()
            > ADVANCED_NUMERICAL_MAX_INPUT_BYTES
        {
            return Err(AdvancedNumericalError::InputLimit);
        }
        let plugin_id = safe_string(object, "pluginId")?;
        let analysis_family = safe_string(object, "analysisFamily")?;
        let seed = safe_integer(object, "seed")?;
        let input = object
            .get("input")
            .filter(|value| value.is_object())
            .cloned()
            .ok_or(AdvancedNumericalError::Contract("input_object_required"))?;
        let request_hash = safe_hash(object, "advancedNumericalPluginRequestHash")?;
        let assurance = object
            .get("assuranceContracts")
            .and_then(Value::as_object)
            .ok_or(AdvancedNumericalError::Contract(
                "assurance_contracts_required",
            ))?;
        let oracle_contract_hash = nested_hash(assurance, "oracle")?;
        let replay_contract_hash = nested_hash(assurance, "replay")?;
        let uncertainty_contract_hash = nested_hash(assurance, "uncertainty")?;
        let mut payload = object.clone();
        payload.remove("advancedNumericalPluginRequestHash");
        let expected_hash = hash_record("AdvancedNumericalPluginRequest", &Value::Object(payload))?;
        if expected_hash != request_hash {
            return Err(AdvancedNumericalError::Contract("request_hash_mismatch"));
        }
        Ok(Self {
            plugin_id,
            analysis_family,
            seed,
            input,
            request_hash,
            oracle_contract_hash,
            replay_contract_hash,
            uncertainty_contract_hash,
        })
    }
}

fn safe_string(object: &Map<String, Value>, key: &'static str) -> Result<String> {
    let value = object
        .get(key)
        .and_then(Value::as_str)
        .ok_or(AdvancedNumericalError::Contract(key))?;
    if value.is_empty() || value.len() > 192 || value.chars().any(char::is_control) {
        return Err(AdvancedNumericalError::Contract(key));
    }
    Ok(value.to_owned())
}

fn safe_hash(object: &Map<String, Value>, key: &'static str) -> Result<String> {
    let value = safe_string(object, key)?;
    if value.len() != 71
        || !value.starts_with("sha256:")
        || !value[7..]
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(AdvancedNumericalError::Contract(key));
    }
    Ok(value)
}

fn nested_hash(object: &Map<String, Value>, key: &'static str) -> Result<String> {
    let nested = object
        .get(key)
        .and_then(Value::as_object)
        .ok_or(AdvancedNumericalError::Contract("assurance_contract"))?;
    safe_hash(nested, "contractHash")
}

fn safe_integer(object: &Map<String, Value>, key: &'static str) -> Result<i64> {
    let number = object
        .get(key)
        .and_then(Value::as_i64)
        .ok_or(AdvancedNumericalError::Contract(key))?;
    if number.unsigned_abs() > SAFE_INTEGER as u64 {
        return Err(AdvancedNumericalError::Contract(key));
    }
    Ok(number)
}

fn hash_record(kind: &str, value: &Value) -> Result<String> {
    production_hash_record_v1(kind, value)
        .map(|hash| hash.as_str().to_owned())
        .map_err(|_| AdvancedNumericalError::Hash)
}

fn finite(value: &Value, name: &'static str) -> Result<f64> {
    let value = value
        .as_f64()
        .ok_or(AdvancedNumericalError::Contract(name))?;
    if !value.is_finite() {
        return Err(AdvancedNumericalError::Numeric);
    }
    Ok(value)
}

fn vector(value: &Value, name: &'static str) -> Result<Vec<f64>> {
    let values = value
        .as_array()
        .ok_or(AdvancedNumericalError::Contract(name))?;
    if values.is_empty() || values.len() > MAX_DIMENSION {
        return Err(AdvancedNumericalError::Contract(name));
    }
    values.iter().map(|value| finite(value, name)).collect()
}

fn square_matrix(value: &Value, name: &'static str) -> Result<Vec<Vec<f64>>> {
    let rows = value
        .as_array()
        .ok_or(AdvancedNumericalError::Contract(name))?;
    if rows.is_empty() || rows.len() > MAX_DIMENSION {
        return Err(AdvancedNumericalError::Contract(name));
    }
    let matrix = rows
        .iter()
        .map(|row| vector(row, name))
        .collect::<Result<Vec<_>>>()?;
    if matrix.iter().any(|row| row.len() != matrix.len()) {
        return Err(AdvancedNumericalError::Contract("matrix_not_square"));
    }
    Ok(matrix)
}

fn tolerance(input: &Map<String, Value>, key: &'static str, default: f64) -> Result<f64> {
    let value = input
        .get(key)
        .map_or(Ok(default), |value| finite(value, key))?;
    if value <= 0.0 {
        return Err(AdvancedNumericalError::Contract(key));
    }
    Ok(value)
}

fn linear_algebra(input: &Value) -> Result<(Value, Value, Value)> {
    let input = input
        .as_object()
        .ok_or(AdvancedNumericalError::Contract("input_object_required"))?;
    let matrix = square_matrix(
        input
            .get("matrix")
            .ok_or(AdvancedNumericalError::Contract("matrix"))?,
        "matrix",
    )?;
    let rhs = vector(
        input
            .get("vector")
            .ok_or(AdvancedNumericalError::Contract("vector"))?,
        "vector",
    )?;
    if rhs.len() != matrix.len() {
        return Err(AdvancedNumericalError::Contract(
            "linear_algebra_dimension_mismatch",
        ));
    }
    let residual_tolerance = tolerance(input, "residualTolerance", 1e-9)?;
    let n = matrix.len();
    let mut augmented: Vec<Vec<f64>> = matrix
        .iter()
        .zip(rhs.iter())
        .map(|(row, value)| {
            let mut row = row.clone();
            row.push(*value);
            row
        })
        .collect();
    let mut pivots = Vec::with_capacity(n);
    for column in 0..n {
        let pivot_row = (column..n)
            .max_by(|left, right| {
                augmented[*left][column]
                    .abs()
                    .total_cmp(&augmented[*right][column].abs())
            })
            .ok_or(AdvancedNumericalError::Computation)?;
        let pivot = augmented[pivot_row][column];
        if !pivot.is_finite() || pivot.abs() <= 1e-12 {
            return Err(AdvancedNumericalError::Computation);
        }
        augmented.swap(column, pivot_row);
        pivots.push(pivot.abs());
        let scale = augmented[column][column];
        for value in &mut augmented[column] {
            *value /= scale;
        }
        let pivot_values = augmented[column].clone();
        for (row, row_values) in augmented.iter_mut().enumerate().take(n) {
            if row == column {
                continue;
            }
            let factor = row_values[column];
            for (value, pivot_value) in row_values.iter_mut().zip(&pivot_values) {
                *value -= factor * pivot_value;
            }
        }
    }
    let solution = augmented.iter().map(|row| row[n]).collect::<Vec<_>>();
    let residuals = matrix.iter().zip(rhs.iter()).map(|(row, target)| {
        row.iter()
            .zip(solution.iter())
            .map(|(left, right)| left * right)
            .sum::<f64>()
            - target
    });
    let residual = residuals
        .map(|value| value.abs())
        .max_by(f64::total_cmp)
        .ok_or(AdvancedNumericalError::Computation)?;
    if !residual.is_finite() || solution.iter().any(|value| !value.is_finite()) {
        return Err(AdvancedNumericalError::Numeric);
    }
    let pivot_ratio = pivots.iter().copied().fold(0.0, f64::max)
        / pivots.iter().copied().fold(f64::INFINITY, f64::min);
    if !pivot_ratio.is_finite() {
        return Err(AdvancedNumericalError::Numeric);
    }
    let estimate = json!({"kind":"LinearAlgebraEstimate", "solution": solution});
    let uncertainty = json!({"kind":"ResidualAndPivotUncertainty", "residualInfinityNorm":residual, "pivotRatio":pivot_ratio});
    let oracle = json!({"kind":"LinearSystemResidualOracle", "accepted":residual <= residual_tolerance, "residualInfinityNorm":residual});
    Ok((estimate, uncertainty, oracle))
}

fn next_unit(state: &mut u64) -> f64 {
    // SplitMix64 gives a deterministic, platform-independent bounded stream.
    *state = state.wrapping_add(0x9e37_79b9_7f4a_7c15);
    let mut value = *state;
    value = (value ^ (value >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
    value = (value ^ (value >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
    value ^= value >> 31;
    (value >> 11) as f64 / ((1u64 << 53) as f64)
}

fn monte_carlo(input: &Value, seed: i64) -> Result<(Value, Value, Value)> {
    let input = input
        .as_object()
        .ok_or(AdvancedNumericalError::Contract("input_object_required"))?;
    let sample_count = input
        .get("sampleCount")
        .and_then(Value::as_u64)
        .and_then(|value| usize::try_from(value).ok())
        .ok_or(AdvancedNumericalError::Contract("sampleCount"))?;
    if !(100..=MAX_SAMPLES).contains(&sample_count) {
        return Err(AdvancedNumericalError::Contract("sampleCount"));
    }
    let integrand = input
        .get("integrand")
        .and_then(Value::as_str)
        .unwrap_or("exp-neg-square");
    if !matches!(integrand, "exp-neg-square" | "unit-circle") {
        return Err(AdvancedNumericalError::Contract("integrand"));
    }
    let mut state = seed as u64;
    let mut observations = Vec::with_capacity(sample_count);
    for _ in 0..sample_count {
        let value = match integrand {
            "exp-neg-square" => {
                let point = next_unit(&mut state);
                (-(point * point)).exp()
            }
            "unit-circle" => {
                let left = 2.0 * next_unit(&mut state) - 1.0;
                let right = 2.0 * next_unit(&mut state) - 1.0;
                if left * left + right * right <= 1.0 {
                    4.0
                } else {
                    0.0
                }
            }
            _ => return Err(AdvancedNumericalError::UnsupportedFamily),
        };
        if !value.is_finite() {
            return Err(AdvancedNumericalError::Numeric);
        }
        observations.push(value);
    }
    let mean = observations.iter().sum::<f64>() / sample_count as f64;
    let variance = observations
        .iter()
        .map(|value| (value - mean).powi(2))
        .sum::<f64>()
        / (sample_count - 1) as f64;
    let standard_error = (variance / sample_count as f64).sqrt();
    if !mean.is_finite() || !variance.is_finite() || !standard_error.is_finite() {
        return Err(AdvancedNumericalError::Numeric);
    }
    let estimate = json!({"kind":"MonteCarloEstimate", "integrand":integrand, "sampleCount":sample_count, "value":mean});
    let uncertainty = json!({"kind":"MonteCarloNormalApproximation", "standardError":standard_error, "lower95":mean - 1.96 * standard_error, "upper95":mean + 1.96 * standard_error});
    let oracle = json!({"kind":"MonteCarloFiniteSampleOracle", "accepted":mean.is_finite() && standard_error.is_finite(), "sampleCount":sample_count, "seed":seed});
    Ok((estimate, uncertainty, oracle))
}

fn optimization(input: &Value) -> Result<(Value, Value, Value)> {
    let input = input
        .as_object()
        .ok_or(AdvancedNumericalError::Contract("input_object_required"))?;
    let matrix = square_matrix(
        input
            .get("quadratic")
            .ok_or(AdvancedNumericalError::Contract("quadratic"))?,
        "quadratic",
    )?;
    let linear = vector(
        input
            .get("linear")
            .ok_or(AdvancedNumericalError::Contract("linear"))?,
        "linear",
    )?;
    if linear.len() != matrix.len() {
        return Err(AdvancedNumericalError::Contract(
            "optimization_dimension_mismatch",
        ));
    }
    let iterations = input
        .get("iterations")
        .map(|value| {
            value
                .as_u64()
                .and_then(|value| usize::try_from(value).ok())
                .ok_or(AdvancedNumericalError::Contract("iterations"))
        })
        .transpose()?
        .unwrap_or(1_000);
    if !(1..=MAX_ITERATIONS).contains(&iterations) {
        return Err(AdvancedNumericalError::Contract("iterations"));
    }
    let step_size = input
        .get("stepSize")
        .map(|value| finite(value, "stepSize"))
        .transpose()?
        .unwrap_or(0.01);
    if step_size <= 0.0 {
        return Err(AdvancedNumericalError::Contract("stepSize"));
    }
    let gradient_tolerance = tolerance(input, "gradientTolerance", 1e-6)?;
    let mut point = vec![0.0; linear.len()];
    for _ in 0..iterations {
        let gradient = matrix
            .iter()
            .map(|row| {
                row.iter()
                    .zip(point.iter())
                    .map(|(left, right)| left * right)
                    .sum::<f64>()
            })
            .zip(linear.iter())
            .map(|(quadratic, linear)| quadratic + linear)
            .collect::<Vec<_>>();
        for (value, gradient) in point.iter_mut().zip(gradient) {
            *value -= step_size * gradient;
        }
        if point.iter().any(|value| !value.is_finite()) {
            return Err(AdvancedNumericalError::Computation);
        }
    }
    let gradient = matrix
        .iter()
        .map(|row| {
            row.iter()
                .zip(point.iter())
                .map(|(left, right)| left * right)
                .sum::<f64>()
        })
        .zip(linear.iter())
        .map(|(quadratic, linear)| quadratic + linear)
        .collect::<Vec<_>>();
    let gradient_norm = gradient
        .iter()
        .map(|value| value * value)
        .sum::<f64>()
        .sqrt();
    let quadratic = matrix
        .iter()
        .enumerate()
        .map(|(row, values)| {
            0.5 * point[row]
                * values
                    .iter()
                    .zip(point.iter())
                    .map(|(left, right)| left * right)
                    .sum::<f64>()
        })
        .sum::<f64>();
    let objective = quadratic
        + linear
            .iter()
            .zip(point.iter())
            .map(|(left, right)| left * right)
            .sum::<f64>();
    if !gradient_norm.is_finite() || !objective.is_finite() {
        return Err(AdvancedNumericalError::Numeric);
    }
    let estimate =
        json!({"kind":"ConvexQuadraticEstimate", "minimizer":point, "objective":objective});
    let uncertainty = json!({"kind":"FirstOrderResidualUncertainty", "gradientNorm":gradient_norm, "iterations":iterations, "stepSize":step_size});
    let oracle = json!({"kind":"FirstOrderOptimalityOracle", "accepted":gradient_norm <= gradient_tolerance, "gradientNorm":gradient_norm});
    Ok((estimate, uncertainty, oracle))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(family: &str, input: Value, seed: i64) -> Value {
        let mut value = json!({
            "version": 1,
            "kind": "AdvancedNumericalPluginRequest",
            "runId": "native-candidate-run",
            "pluginId": "hepta.reference.native",
            "pluginDescriptorHash": "sha256:1111111111111111111111111111111111111111111111111111111111111111",
            "analysisFamily": family,
            "seed": seed,
            "input": input,
            "assuranceContracts": {
                "oracle": {"kind":"independent-numeric-oracle-v1", "contractHash":"sha256:5555555555555555555555555555555555555555555555555555555555555555"},
                "replay": {"kind":"deterministic-process-replay-v1", "contractHash":"sha256:6666666666666666666666666666666666666666666666666666666666666666"},
                "uncertainty": {"kind":"typed-uncertainty-report-v1", "contractHash":"sha256:7777777777777777777777777777777777777777777777777777777777777777"}
            }
        });
        let hash = hash_record("AdvancedNumericalPluginRequest", &value).expect("hash");
        value["advancedNumericalPluginRequestHash"] = Value::String(hash);
        value
    }

    #[test]
    fn linear_candidate_is_deterministic_and_unqualified() {
        let request = request(
            "linear-algebra",
            json!({"matrix":[[4,1],[2,3]],"vector":[1,2],"residualTolerance":1e-10}),
            17,
        );
        let first = execute_advanced_numerical_plugin_v1(&request).expect("candidate");
        let second = execute_advanced_numerical_plugin_v1(&request).expect("candidate");
        assert_eq!(first, second);
        assert_eq!(first["productionQualified"], false);
        assert_eq!(
            first["qualificationStatus"],
            "reference_candidate_unqualified"
        );
        assert!(first["oracle"]["accepted"].as_bool().unwrap_or(false));
    }

    #[test]
    fn monte_carlo_and_optimization_candidates_are_finite() {
        let monte = execute_advanced_numerical_plugin_v1(&request(
            "monte-carlo",
            json!({"integrand":"unit-circle","sampleCount":5000}),
            41,
        ))
        .expect("monte candidate");
        assert!(
            monte["estimate"]["value"]
                .as_f64()
                .unwrap_or(f64::NAN)
                .is_finite()
        );
        let optimization = execute_advanced_numerical_plugin_v1(&request(
            "optimization",
            json!({"quadratic":[[2,0],[0,4]],"linear":[-2,-8],"iterations":2000,"stepSize":0.05,"gradientTolerance":1e-7}),
            17,
        ))
        .expect("optimization candidate");
        assert!(
            optimization["uncertainty"]["gradientNorm"]
                .as_f64()
                .unwrap_or(f64::NAN)
                .is_finite()
        );
        let optimization_defaults = execute_advanced_numerical_plugin_v1(&request(
            "optimization",
            json!({"quadratic":[[1]],"linear":[-1]}),
            17,
        ))
        .expect("optimization defaults");
        assert_eq!(
            optimization_defaults["uncertainty"]["iterations"],
            Value::from(1_000)
        );
    }

    #[test]
    fn request_hash_and_unsupported_family_fail_closed() {
        let mut invalid = request("linear-algebra", json!({"matrix":[[1]],"vector":[1]}), 1);
        invalid["advancedNumericalPluginRequestHash"] = Value::String(
            "sha256:0000000000000000000000000000000000000000000000000000000000000000".into(),
        );
        assert_eq!(
            execute_advanced_numerical_plugin_v1(&invalid),
            Err(AdvancedNumericalError::Contract("request_hash_mismatch"))
        );
        let mut uppercase = request("linear-algebra", json!({"matrix":[[1]],"vector":[1]}), 1);
        uppercase["advancedNumericalPluginRequestHash"] = Value::String(
            "sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA".into(),
        );
        assert_eq!(
            execute_advanced_numerical_plugin_v1(&uppercase),
            Err(AdvancedNumericalError::Contract(
                "advancedNumericalPluginRequestHash"
            ))
        );
        let mut minimum_seed = request("linear-algebra", json!({"matrix":[[1]],"vector":[1]}), 1);
        minimum_seed["seed"] = Value::from(i64::MIN);
        assert_eq!(
            execute_advanced_numerical_plugin_v1(&minimum_seed),
            Err(AdvancedNumericalError::Contract("seed"))
        );
        let unsupported = request("bayesian", json!({}), 1);
        assert_eq!(
            execute_advanced_numerical_plugin_v1(&unsupported),
            Err(AdvancedNumericalError::UnsupportedFamily)
        );
    }
}
