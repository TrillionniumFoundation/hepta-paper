use super::{
    NativeBusinessError, NativeBusinessOutputV1, ObservationV1, hash_bytes, hash_serialized,
    validate_identifier,
};
use serde::Serialize;
use serde_json::json;
use std::collections::BTreeSet;

const MAX_OBSERVATIONS: usize = 1_000_000;

pub(super) fn empirical_aggregate(
    observations: Vec<ObservationV1>,
) -> Result<NativeBusinessOutputV1, NativeBusinessError> {
    if observations.is_empty() || observations.len() > MAX_OBSERVATIONS {
        return Err(NativeBusinessError::Contract);
    }
    let mut labels = BTreeSet::new();
    let mut mean = 0.0f64;
    let mut m2 = 0.0f64;
    let mut minimum = f64::INFINITY;
    let mut maximum = f64::NEG_INFINITY;
    for (index, observation) in observations.iter().enumerate() {
        validate_identifier(&observation.label, 256)?;
        if !labels.insert(observation.label.clone()) || !observation.value.is_finite() {
            return Err(NativeBusinessError::Numeric);
        }
        let count = (index + 1) as f64;
        let delta = observation.value - mean;
        mean += delta / count;
        let delta_after = observation.value - mean;
        m2 += delta * delta_after;
        minimum = minimum.min(observation.value);
        maximum = maximum.max(observation.value);
        if !mean.is_finite() || !m2.is_finite() {
            return Err(NativeBusinessError::Numeric);
        }
    }
    let count = observations.len();
    let variance_population = m2 / count as f64;
    let variance_sample = if count > 1 {
        Some(m2 / (count - 1) as f64)
    } else {
        None
    };
    if !variance_population.is_finite() || variance_sample.is_some_and(|value| !value.is_finite()) {
        return Err(NativeBusinessError::Numeric);
    }
    let report = EmpiricalReportV1 {
        kind: "NativeEmpiricalAggregateV1",
        version: 1,
        count,
        mean,
        minimum,
        maximum,
        variance_population,
        variance_sample,
        observation_set_hash: hash_serialized("HeptaNativeObservationSetV1", &observations)?,
    };
    let bytes = serde_json::to_vec(&report).map_err(|_| NativeBusinessError::Encoding)?;
    Ok(NativeBusinessOutputV1 {
        artifacts: vec![bytes.clone()],
        evidence: json!({
            "kind": "NativeEmpiricalEvidenceV1",
            "version": 1,
            "reportHash": hash_bytes(&bytes),
            "observationCount": count,
            "finite": true,
            "externalActionMayHaveStarted": false
        }),
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EmpiricalReportV1 {
    kind: &'static str,
    version: u16,
    count: usize,
    mean: f64,
    minimum: f64,
    maximum: f64,
    variance_population: f64,
    variance_sample: Option<f64>,
    observation_set_hash: String,
}
