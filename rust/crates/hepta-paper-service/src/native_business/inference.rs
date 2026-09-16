use super::NativeBusinessError;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::Digest;
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HypothesisV1 {
    pub hypothesis_id: String,
    pub p_value: f64,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PowerRequestV1 {
    pub alpha: f64,
    pub target_power: f64,
    pub standardized_effect: f64,
    pub hypothesis_count: u64,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AnalysisInferenceRequestV1 {
    pub version: u16,
    pub values: Vec<f64>,
    pub confidence_level: f64,
    pub family_alpha: f64,
    pub bootstrap_resamples: u64,
    pub sign_flip_draws: u64,
    pub exact_maximum_observations: u8,
    pub seed: u64,
    pub salt: String,
    pub quantile_probabilities: Vec<f64>,
    pub winsor_lower_probability: f64,
    pub winsor_upper_probability: f64,
    pub hypotheses: Vec<HypothesisV1>,
    pub power: Option<PowerRequestV1>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalysisReportV1 {
    pub kind: String,
    pub version: u16,
    pub count: usize,
    pub sum: f64,
    pub mean: f64,
    pub standard_deviation: Option<f64>,
    pub standard_error: Option<f64>,
    pub quantiles: Vec<f64>,
    pub winsorized: Vec<f64>,
    pub bootstrap: Value,
    pub sign_flip: Value,
    pub holm: Vec<Value>,
    pub required_paired_observations: Option<u64>,
    pub seed_hash: String,
    pub scientific_acceptance: bool,
    pub dataset_authority_verified: bool,
    pub production_activation: bool,
}
pub fn compensated_sum(v: &[f64]) -> f64 {
    let (mut s, mut c) = (0., 0.);
    for &x in v {
        let n = s + x;
        c += if s.abs() >= x.abs() {
            s - n + x
        } else {
            x - n + s
        };
        s = n;
    }
    s + c
}

/// Versioned names used by the source-port inventory.  The unversioned
/// helpers remain internal implementation primitives for existing callers.
pub fn compensated_sum_v1(v: &[f64]) -> f64 {
    compensated_sum(v)
}
pub fn arithmetic_mean(v: &[f64]) -> f64 {
    if v.is_empty() {
        f64::NAN
    } else {
        compensated_sum(v) / v.len() as f64
    }
}
pub fn sample_standard_deviation(v: &[f64]) -> f64 {
    if v.len() < 2 {
        return f64::NAN;
    }
    let (mut n, mut m, mut q) = (0., 0., 0.);
    for &x in v {
        n += 1.;
        let d = x - m;
        m += d / n;
        q += d * (x - m)
    }
    (q.max(0.) / (n - 1.)).sqrt()
}

pub fn sample_standard_deviation_v1(v: &[f64]) -> f64 {
    sample_standard_deviation(v)
}
pub fn quantile(v: &[f64], p: f64) -> f64 {
    if v.is_empty() || !(0. ..=1.).contains(&p) {
        return f64::NAN;
    }
    let mut s = v.to_vec();
    s.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let z = p * (s.len() - 1) as f64;
    let l = z.floor() as usize;
    let u = z.ceil() as usize;
    if l == u {
        s[l]
    } else {
        s[l] + (s[u] - s[l]) * (z - l as f64)
    }
}

pub fn quantile_v1(v: &[f64], p: f64) -> f64 {
    quantile(v, p)
}

/// Bounded inverse standard-normal CDF used by the port inventory.  Inputs
/// outside the open unit interval are rejected as NaN, matching the closed
/// numerical helper contract.
pub fn inverse_normal_cdf_v1(p: f64) -> f64 {
    if !(0.0..=1.0).contains(&p) || p == 0.0 || p == 1.0 {
        return f64::NAN;
    }
    // Abramowitz-Stegun 26.2.23 is sufficient for the bounded report path.
    let a1 = -39.696_830_286_653_8;
    let a2 = 220.946_098_424_520_5;
    let a3 = -275.928_510_446_968_7;
    let a4 = 138.357_751_867_269;
    let a5 = -30.664_798_066_147_16;
    let a6 = 2.506_628_277_459_239;
    let b1 = -54.476_098_798_224_06;
    let b2 = 161.585_836_858_040_9;
    let b3 = -155.698_979_859_886_6;
    let b4 = 66.801_311_887_719_72;
    let b5 = -13.280_681_552_885_72;
    let c1 = -0.007_784_894_002_430_293;
    let c2 = -0.322_396_458_041_136_5;
    let c3 = -2.400_758_277_161_838;
    let c4 = -2.549_732_539_343_734;
    let c5 = 4.374_664_141_464_968;
    let c6 = 2.938_163_982_698_783;
    let d1 = 0.007_784_695_709_041_462;
    let d2 = 0.322_467_129_070_039_8;
    let d3 = 2.445_134_137_142_996;
    let d4 = 3.754_408_661_907_416;
    let plow = 0.024_25;
    let phigh = 1.0 - plow;
    if p < plow {
        let q = (-2.0 * p.ln()).sqrt();
        return (((((c1 * q + c2) * q + c3) * q + c4) * q + c5) * q + c6)
            / (((d1 * q + d2) * q + d3) * q + d4);
    }
    if p > phigh {
        return -inverse_normal_cdf_v1(1.0 - p);
    }
    let q = p - 0.5;
    let r = q * q;
    (((((a1 * r + a2) * r + a3) * r + a4) * r + a5) * r + a6) * q
        / (((((b1 * r + b2) * r + b3) * r + b4) * r + b5) * r + 1.0)
}
fn rand(seed: u64, salt: &str) -> impl FnMut() -> f64 {
    use sha2::Digest;
    let mut h = sha2::Sha256::new();
    let salt_json = serde_json::to_string(salt).unwrap();
    let payload = format!(
        "{{\"kind\":\"AnalysisProtocolDeterministicRandomSeed\",\"value\":{{\"salt\":{salt_json},\"seed\":{seed}}}}}"
    );
    h.update(payload.as_bytes());
    let d = h.finalize();
    let mut x = u32::from_be_bytes([d[0], d[1], d[2], d[3]]);
    if x == 0 {
        x = 0x6d2b79f5
    }
    move || {
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        x as f64 / 4294967296.
    }
}
pub fn evaluate_analysis_inference_v1(
    r: &AnalysisInferenceRequestV1,
) -> Result<AnalysisReportV1, NativeBusinessError> {
    if r.version != 1
        || r.values.is_empty()
        || r.values.len() > 65_536
        || r.values.iter().any(|x| !x.is_finite())
        || !(0.0 < r.confidence_level && r.confidence_level < 1.0)
        || !(0.0 < r.family_alpha && r.family_alpha < 1.0)
        || r.bootstrap_resamples == 0
        || r.bootstrap_resamples > 65_536
        || r.sign_flip_draws == 0
        || r.sign_flip_draws > 65_536
        || r.exact_maximum_observations > 16
        || r.salt.is_empty()
        || r.quantile_probabilities.len() > 64
        || r.quantile_probabilities
            .iter()
            .any(|p| !(0.0..=1.0).contains(p))
        || !(0.0..=1.0).contains(&r.winsor_lower_probability)
        || !(0.0..=1.0).contains(&r.winsor_upper_probability)
        || r.winsor_lower_probability > r.winsor_upper_probability
        || r.hypotheses.len() > 4096
        || r.hypotheses
            .iter()
            .any(|h| !h.p_value.is_finite() || !(0.0..=1.0).contains(&h.p_value))
    {
        return Err(NativeBusinessError::Contract);
    }
    let sd = sample_standard_deviation(&r.values);
    let se = sd / (r.values.len() as f64).sqrt();
    let quantiles = r
        .quantile_probabilities
        .iter()
        .map(|p| quantile(&r.values, *p))
        .collect();
    let lo = quantile(&r.values, r.winsor_lower_probability);
    let hi = quantile(&r.values, r.winsor_upper_probability);
    let winsorized = r.values.iter().map(|x| x.max(lo).min(hi)).collect();
    let mut rng = rand(r.seed, &r.salt);
    let mut means = Vec::new();
    for _ in 0..r.bootstrap_resamples {
        let mut x = Vec::new();
        for _ in 0..r.values.len() {
            x.push(r.values[(rng() * r.values.len() as f64) as usize])
        }
        means.push(arithmetic_mean(&x))
    }
    let tail = (1. - r.confidence_level) / 2.;
    let bootstrap = json!({"method":"deterministic-paired-percentile-bootstrap-v1","confidenceLevel":r.confidence_level,"resamples":r.bootstrap_resamples,"seed":r.seed,"lower":quantile(&means,tail),"upper":quantile(&means,1.-tail)});
    let obs = arithmetic_mean(&r.values);
    let sign = if r.values.len() <= r.exact_maximum_observations as usize {
        let draws = 1_u64 << r.values.len();
        let mut exceed = 0_u64;
        for mask in 0..draws {
            let signed: Vec<f64> = r
                .values
                .iter()
                .enumerate()
                .map(|(i, value)| {
                    if mask & (1_u64 << i) == 0 {
                        -*value
                    } else {
                        *value
                    }
                })
                .collect();
            if arithmetic_mean(&signed) >= obs {
                exceed += 1;
            }
        }
        json!({"method":"exact-paired-sign-flip-enumeration-v1","pValue":exceed as f64/draws as f64,"draws":draws,"monteCarloStandardError":0.0})
    } else {
        let mut exceed = 0_u64;
        for _ in 0..r.sign_flip_draws {
            let signed: Vec<f64> = r
                .values
                .iter()
                .map(|value| if rng() < 0.5 { -*value } else { *value })
                .collect();
            if arithmetic_mean(&signed) >= obs {
                exceed += 1;
            }
        }
        let p = (exceed + 1) as f64 / (r.sign_flip_draws + 1) as f64;
        json!({"method":"deterministic-monte-carlo-sign-flip-v1","pValue":p,"draws":r.sign_flip_draws,"monteCarloStandardError":(p*(1.0-p)/r.sign_flip_draws as f64).sqrt()})
    };
    let mut hs = r.hypotheses.clone();
    hs.sort_by(|a, b| {
        a.p_value
            .partial_cmp(&b.p_value)
            .unwrap()
            .then(a.hypothesis_id.cmp(&b.hypothesis_id))
    });
    let mut previous_adjusted = 0.0;
    let mut all_accepted = true;
    let holm = hs
        .iter()
        .enumerate()
        .map(|(i, h)| {
            let divisor = (hs.len() - i) as f64;
            let adjusted = (h.p_value * divisor).min(1.0).max(previous_adjusted);
            previous_adjusted = adjusted;
            let accepted = all_accepted && h.p_value <= r.family_alpha / divisor;
            all_accepted = accepted;
            json!({"hypothesisId":h.hypothesis_id,"pValue":h.p_value,"holmRank":i+1,"holmThreshold":r.family_alpha/divisor,"adjustedPValue":adjusted,"multiplicityAccepted":accepted})
        })
        .collect();
    let salt_json = serde_json::to_string(&r.salt).map_err(|_| NativeBusinessError::Encoding)?;
    let seed_payload = format!(
        "{{\"kind\":\"AnalysisProtocolDeterministicRandomSeed\",\"value\":{{\"salt\":{salt_json},\"seed\":{}}}}}",
        r.seed
    );
    let seed_hash = format!(
        "sha256:{}",
        hex::encode(sha2::Sha256::digest(seed_payload.as_bytes()))
    );
    let required_paired_observations = r.power.as_ref().and_then(|power| {
        if !(power.alpha > 0.0 && power.alpha < 1.0)
            || !(power.target_power > 0.5 && power.target_power < 1.0)
            || power.standardized_effect.partial_cmp(&0.0) != Some(std::cmp::Ordering::Greater)
            || power.hypothesis_count == 0
        {
            return None;
        }
        let strict_alpha = power.alpha / power.hypothesis_count as f64;
        let critical = inverse_normal_cdf_v1(1.0 - strict_alpha);
        let power_quantile = inverse_normal_cdf_v1(power.target_power);
        Some((((critical + power_quantile) / power.standardized_effect).powi(2)).ceil() as u64)
    });
    Ok(AnalysisReportV1 {
        kind: "NativePairedAnalysisReportV1".into(),
        version: 1,
        count: r.values.len(),
        sum: compensated_sum(&r.values),
        mean: obs,
        standard_deviation: (!sd.is_nan()).then_some(sd),
        standard_error: (!se.is_nan()).then_some(se),
        quantiles,
        winsorized,
        bootstrap,
        sign_flip: sign,
        holm,
        required_paired_observations,
        seed_hash,
        scientific_acceptance: false,
        dataset_authority_verified: false,
        production_activation: false,
    })
}

pub fn empirical_inference(
    r: AnalysisInferenceRequestV1,
) -> Result<super::NativeBusinessOutputV1, NativeBusinessError> {
    let report = evaluate_analysis_inference_v1(&r)?;
    let bytes = serde_json::to_vec(&report).map_err(|_| NativeBusinessError::Encoding)?;
    Ok(super::NativeBusinessOutputV1 {
        artifacts: vec![bytes],
        evidence: json!({"kind":"native_paired_analysis","scientificAcceptance":false}),
    })
}
