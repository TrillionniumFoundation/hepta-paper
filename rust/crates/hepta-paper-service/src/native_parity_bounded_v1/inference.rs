//! Bounded native implementation of the incumbent paired-analysis algorithms.
//!
//! Source: paper-domain/automation/analysis-statistics.mjs. The Node implementation
//! is called only by differential tests. Inputs are supplied observations, not
//! trusted dataset provenance; calculated intervals and p-values are not an
//! independent scientific verdict. No worker or provider is launched here.
use crate::native_business::NativeBusinessError;
use hepta_legacy_compatibility::{ProductionCollationV1, production_hash_record_v1};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeSet;

const MAX_OPERATIONS: usize = 4_000_000;
const MAX_VALUES: usize = 65_536;
const MAX_DRAWS: usize = 65_536;
const MAX_SAFE: u64 = 9_007_199_254_740_991;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HypothesisPValueV1 {
    pub hypothesis_id: String,
    pub p_value: f64,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PairedPowerRequestV1 {
    pub alpha: f64,
    pub target_power: f64,
    pub standardized_effect: f64,
    pub hypothesis_count: u32,
}
/// Versioned paired-analysis input. All work limits are checked before resampling.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AnalysisInferenceRequestV1 {
    pub version: u16,
    pub values: Vec<f64>,
    pub confidence_level: f64,
    pub bootstrap_resamples: usize,
    pub sign_flip_draws: usize,
    pub exact_maximum_observations: usize,
    pub seed: u64,
    pub salt: String,
    pub quantile_probabilities: Vec<f64>,
    pub winsor_lower_probability: f64,
    pub winsor_upper_probability: f64,
    pub family_alpha: f64,
    pub hypotheses: Vec<HypothesisPValueV1>,
    pub power: Option<PairedPowerRequestV1>,
}
fn finite(value: f64) -> Result<f64, NativeBusinessError> {
    if value.is_finite() {
        Ok(value)
    } else {
        Err(NativeBusinessError::Numeric)
    }
}
fn probability(p: f64) -> bool {
    p.is_finite() && (0.0..=1.0).contains(&p)
}
fn interior(p: f64) -> bool {
    p > 0.0 && p < 1.0
}
fn label(s: &str) -> bool {
    !s.is_empty() && s.len() <= 256 && !s.chars().any(char::is_control)
}

/// Neumaier compensated summation, in the original operation order.
pub fn compensated_sum_v1(values: &[f64]) -> Result<f64, NativeBusinessError> {
    let (mut sum, mut correction) = (0.0_f64, 0.0_f64);
    for &value in values {
        finite(value)?;
        let next = finite(sum + value)?;
        correction = finite(
            correction
                + if sum.abs() >= value.abs() {
                    (sum - next) + value
                } else {
                    (value - next) + sum
                },
        )?;
        sum = next;
    }
    finite(sum + correction)
}
fn mean(values: &[f64]) -> Result<f64, NativeBusinessError> {
    if values.is_empty() {
        return Err(NativeBusinessError::Contract);
    }
    finite(compensated_sum_v1(values)? / values.len() as f64)
}
/// Welford's sample standard deviation; one observation has insufficient data.
pub fn sample_standard_deviation_v1(values: &[f64]) -> Result<Option<f64>, NativeBusinessError> {
    let (mut mean, mut second) = (0.0, 0.0);
    for (i, &v) in values.iter().enumerate() {
        finite(v)?;
        let delta = finite(v - mean)?;
        mean = finite(mean + delta / (i + 1) as f64)?;
        second = finite(second + delta * (v - mean))?;
    }
    if values.len() < 2 {
        Ok(None)
    } else {
        Ok(Some(finite(
            (second.max(0.0) / (values.len() - 1) as f64).sqrt(),
        )?))
    }
}
fn quantile_sorted(values: &[f64], p: f64) -> Result<f64, NativeBusinessError> {
    if values.is_empty() || !probability(p) {
        return Err(NativeBusinessError::Contract);
    }
    let position = p * (values.len() - 1) as f64;
    let lo = position.floor() as usize;
    let hi = position.ceil() as usize;
    let left = *values.get(lo).ok_or(NativeBusinessError::Contract)?;
    let right = *values.get(hi).ok_or(NativeBusinessError::Contract)?;
    if lo == hi {
        finite(left)
    } else {
        finite(left + ((right - left) * (position - lo as f64)))
    }
}
/// Linear-interpolated sample quantile with finite-input rejection.
pub fn quantile_v1(values: &[f64], p: f64) -> Result<f64, NativeBusinessError> {
    if values.len() > MAX_VALUES || values.iter().any(|x| !x.is_finite()) {
        return Err(NativeBusinessError::Numeric);
    }
    let mut sorted = values.to_vec();
    sorted.sort_by(|a, b| a.total_cmp(b));
    quantile_sorted(&sorted, p)
}

struct Random(u32);
impl Random {
    fn new(seed: u64, salt: &str) -> Result<(Self, String), NativeBusinessError> {
        let hash = production_hash_record_v1(
            "AnalysisProtocolDeterministicRandomSeed",
            &json!({"seed":seed,"salt":salt}),
        )
        .map_err(|_| NativeBusinessError::Encoding)?;
        let prefix = hash
            .as_str()
            .strip_prefix("sha256:")
            .and_then(|s| s.get(..8))
            .ok_or(NativeBusinessError::Encoding)?;
        let n = u32::from_str_radix(prefix, 16).map_err(|_| NativeBusinessError::Encoding)?;
        Ok((
            Self(if n == 0 { 0x6d2b79f5 } else { n }),
            hash.as_str().to_owned(),
        ))
    }
    fn next(&mut self) -> f64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 17;
        self.0 ^= self.0 << 5;
        f64::from(self.0) / 4_294_967_296.0
    }
}
fn bootstrap(r: &AnalysisInferenceRequestV1) -> Result<Value, NativeBusinessError> {
    let (mut random, _) = Random::new(r.seed, &r.salt)?;
    let mut sample = vec![0.0; r.values.len()];
    let mut means = Vec::with_capacity(r.bootstrap_resamples);
    for _ in 0..r.bootstrap_resamples {
        for value in &mut sample {
            let i = (random.next() * r.values.len() as f64).floor() as usize;
            *value = *r.values.get(i).ok_or(NativeBusinessError::Contract)?;
        }
        means.push(mean(&sample)?);
    }
    means.sort_by(|a, b| a.total_cmp(b));
    let tail = (1.0 - r.confidence_level) / 2.0;
    Ok(
        json!({"method":"deterministic-paired-percentile-bootstrap-v1","confidenceLevel":r.confidence_level,
        "resamples":r.bootstrap_resamples,"seed":r.seed,"lower":quantile_sorted(&means,tail)?,"upper":quantile_sorted(&means,1.0-tail)?}),
    )
}
fn sign_flip(r: &AnalysisInferenceRequestV1) -> Result<Value, NativeBusinessError> {
    let observed = mean(&r.values)?;
    let (mut random, _) = Random::new(r.seed, &r.salt)?;
    let exact = r.values.len() <= r.exact_maximum_observations;
    let draws = if exact {
        1usize << r.values.len()
    } else {
        r.sign_flip_draws
    };
    let mut at_least = 0usize;
    let mut sample = vec![0.0; r.values.len()];
    for draw in 0..draws {
        for (i, &value) in r.values.iter().enumerate() {
            let negative = if exact {
                draw & (1usize << i) == 0
            } else {
                random.next() < 0.5
            };
            sample[i] = if negative { -value } else { value };
        }
        if mean(&sample)? >= observed {
            at_least += 1;
        }
    }
    let p = if exact {
        at_least as f64 / draws as f64
    } else {
        (at_least + 1) as f64 / (draws + 1) as f64
    };
    Ok(
        json!({"method":if exact{"exact-paired-sign-flip-enumeration-v1"}else{"deterministic-monte-carlo-sign-flip-v1"},
        "pValue":p,"draws":draws,"monteCarloStandardError":if exact{0.0}else{finite(((p*(1.0-p))/draws as f64).sqrt())?}}),
    )
}
/// Preserve the incumbent rational approximation; libm ln accuracy is qualified
/// by tolerance, not asserted as cross-platform byte equality.
pub fn inverse_normal_cdf_v1(p: f64) -> Result<f64, NativeBusinessError> {
    if !interior(p) {
        return Err(NativeBusinessError::Contract);
    }
    let a = [
        -39.696_830_286_653_8,
        220.946_098_424_521,
        -275.928_510_446_969,
        138.357_751_867_269,
        -30.664_798_066_147_2,
        2.506_628_277_459_24,
    ];
    let b = [
        -54.476_098_798_224_1,
        161.585_836_858_041,
        -155.698_979_859_887,
        66.801_311_887_719_7,
        -13.280_681_552_885_7,
    ];
    let c = [
        -0.007_784_894_002_430_29,
        -0.322_396_458_041_136,
        -2.400_758_277_161_84,
        -2.549_732_539_343_73,
        4.374_664_141_464_97,
        2.938_163_982_698_78,
    ];
    let d = [
        0.007_784_695_709_041_46,
        0.322_467_129_070_04,
        2.445_134_137_143,
        3.754_408_661_907_42,
    ];
    if p < 0.02425 {
        let q = (-2.0 * p.ln()).sqrt();
        return finite(
            (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
                / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1.0),
        );
    }
    if p > 0.97575 {
        return finite(-inverse_normal_cdf_v1(1.0 - p)?);
    }
    let q = p - 0.5;
    let r = q * q;
    finite(
        (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q
            / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1.0),
    )
}
fn power(r: &PairedPowerRequestV1) -> Result<u64, NativeBusinessError> {
    if !interior(r.alpha)
        || !(r.target_power > 0.5 && r.target_power < 1.0)
        || !r.standardized_effect.is_finite()
        || r.standardized_effect <= 0.0
        || r.hypothesis_count == 0
        || r.hypothesis_count > 4096
    {
        return Err(NativeBusinessError::Contract);
    }
    let critical = inverse_normal_cdf_v1(1.0 - r.alpha / f64::from(r.hypothesis_count))?;
    let q = inverse_normal_cdf_v1(r.target_power)?;
    let ratio = finite((critical + q) / r.standardized_effect)?;
    let n = finite((ratio * ratio).ceil())?;
    if n > MAX_SAFE as f64 {
        return Err(NativeBusinessError::Numeric);
    }
    Ok(n as u64)
}
fn holm(rows: &[HypothesisPValueV1], alpha: f64) -> Result<Value, NativeBusinessError> {
    let collator = ProductionCollationV1::load().map_err(|_| NativeBusinessError::Encoding)?;
    let mut ordered: Vec<_> = rows.iter().collect();
    ordered.sort_by(|a, b| {
        if a.p_value < b.p_value {
            std::cmp::Ordering::Less
        } else if a.p_value > b.p_value {
            std::cmp::Ordering::Greater
        } else {
            collator.compare(&a.hypothesis_id, &b.hypothesis_id)
        }
    });
    let (mut previous, mut preceding) = (0.0_f64, true);
    Ok(json!(ordered.iter().enumerate().map(|(i,row)|{
        let remaining=(ordered.len()-i) as f64;
        let threshold=alpha/remaining;
        let adjusted=(row.p_value*remaining).max(previous).min(1.0);previous=adjusted;
        let accepted=preceding&&row.p_value<=threshold;preceding=accepted;
        json!({"hypothesisId":row.hypothesis_id,"pValue":row.p_value,"holmRank":i+1,"holmThreshold":threshold,
            "adjustedPValue":adjusted,"multiplicityAccepted":accepted})
    }).collect::<Vec<_>>()))
}
impl AnalysisInferenceRequestV1 {
    /// Bound runtime, allocation and arithmetic before any expensive resampling.
    pub fn validate(&self) -> Result<(), NativeBusinessError> {
        if self.version != 1
            || self.values.is_empty()
            || self.values.len() > MAX_VALUES
            || self.values.iter().any(|x| !x.is_finite())
            || !interior(self.confidence_level)
            || !(1..=MAX_DRAWS).contains(&self.bootstrap_resamples)
            || !(1..=MAX_DRAWS).contains(&self.sign_flip_draws)
            || self.exact_maximum_observations > 16
            || self.seed > MAX_SAFE
            || !label(&self.salt)
            || self.quantile_probabilities.len() > 64
            || self.quantile_probabilities.iter().any(|&p| !probability(p))
            || !probability(self.winsor_lower_probability)
            || !probability(self.winsor_upper_probability)
            || self.winsor_lower_probability > self.winsor_upper_probability
            || !interior(self.family_alpha)
            || self.hypotheses.len() > 4096
        {
            return Err(NativeBusinessError::Contract);
        }
        let draws = if self.values.len() <= self.exact_maximum_observations {
            1usize << self.values.len()
        } else {
            self.sign_flip_draws
        };
        if self
            .bootstrap_resamples
            .checked_add(draws)
            .and_then(|v| v.checked_mul(self.values.len()))
            .is_none_or(|v| v > MAX_OPERATIONS)
        {
            return Err(NativeBusinessError::OutputLimit);
        }
        let mut ids = BTreeSet::new();
        for h in &self.hypotheses {
            if !label(&h.hypothesis_id) || !probability(h.p_value) || !ids.insert(&h.hypothesis_id)
            {
                return Err(NativeBusinessError::Contract);
            }
        }
        if let Some(p) = &self.power {
            power(p)?;
        }
        Ok(())
    }
}
/// Calculate, never certify, a paired-analysis report from supplied observations.
pub fn evaluate_analysis_inference_v1(
    request: &AnalysisInferenceRequestV1,
) -> Result<Value, NativeBusinessError> {
    request.validate()?;
    let mut values = request.values.clone();
    values.sort_by(|a, b| a.total_cmp(b));
    let lower = quantile_sorted(&values, request.winsor_lower_probability)?;
    let upper = quantile_sorted(&values, request.winsor_upper_probability)?;
    let sd = sample_standard_deviation_v1(&request.values)?;
    let se = sd
        .map(|v| finite(v / (request.values.len() as f64).sqrt()))
        .transpose()?;
    let quantiles: Vec<_> = request
        .quantile_probabilities
        .iter()
        .map(|&p| quantile_sorted(&values, p))
        .collect::<Result<_, _>>()?;
    let winsorized: Vec<_> = request
        .values
        .iter()
        .map(|v| lower.max(upper.min(*v)))
        .collect();
    let (_, seed_hash) = Random::new(request.seed, &request.salt)?;
    Ok(
        json!({"kind":"NativePairedAnalysisReportV1","version":1,"count":values.len(),
        "sum":compensated_sum_v1(&request.values)?,"mean":mean(&request.values)?,"standardDeviation":sd,"standardError":se,
        "quantiles":quantiles,"winsorized":winsorized,"bootstrap":bootstrap(request)?,"signFlip":sign_flip(request)?,
        "holm":holm(&request.hypotheses,request.family_alpha)?,"requiredPairedObservations":request.power.as_ref().map(power).transpose()?,
        "seedHash":seed_hash,"scientificAcceptance":false,"datasetAuthorityVerified":false,"productionActivation":false}),
    )
}
