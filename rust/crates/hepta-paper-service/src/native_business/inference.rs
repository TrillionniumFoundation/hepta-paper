use super::{NativeBusinessError, hash_serialized};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
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
fn rand(seed: u64, salt: &str) -> impl FnMut() -> f64 {
    use sha2::Digest;
    let mut h = sha2::Sha256::new();
    h.update(b"AnalysisProtocolDeterministicRandomSeed");
    h.update(serde_json::to_vec(&json!({"seed":seed,"salt":salt})).unwrap());
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
    let seed_hash = hash_serialized(
        "AnalysisProtocolDeterministicRandomSeed",
        &json!({"seed":r.seed,"salt":r.salt}),
    )
    .map_err(|_| NativeBusinessError::Encoding)?;
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
        required_paired_observations: None,
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
