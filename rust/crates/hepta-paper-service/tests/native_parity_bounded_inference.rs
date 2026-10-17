#[path = "native_parity_bounded_support/mod.rs"]
mod native_oracle;
use hepta_paper_service::native_parity_bounded_v1::inference::{
    AnalysisInferenceRequestV1, compensated_sum_v1, evaluate_analysis_inference_v1,
    inverse_normal_cdf_v1, quantile_v1,
};
use serde_json::{Value, json};
fn request() -> AnalysisInferenceRequestV1 {
    serde_json::from_slice(include_bytes!(
        "../../../../docs/modules/examples/paired-analysis.v1.json"
    ))
    .unwrap()
}
fn compare(a: &Value, b: &Value, path: &str) {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => {
            let x = x.as_f64().unwrap();
            let y = y.as_f64().unwrap();
            assert!(
                (x - y).abs() <= 1e-12_f64.max(1e-12 * x.abs().max(y.abs())),
                "{path}: {x} != {y}"
            );
        }
        (Value::Array(x), Value::Array(y)) => {
            assert_eq!(x.len(), y.len(), "{path}");
            for (i, (a, b)) in x.iter().zip(y).enumerate() {
                compare(a, b, &format!("{path}/{i}"));
            }
        }
        (Value::Object(x), Value::Object(y)) => {
            assert_eq!(x.len(), y.len(), "{path}");
            for (k, a) in x {
                compare(a, &y[k], &format!("{path}/{k}"));
            }
        }
        _ => assert_eq!(a, b, "{path}"),
    }
}
#[test]
fn native_inference_matches_real_node_statistical_functions() {
    let mut requests = Vec::new();
    for seed in 0..80 {
        let mut r = request();
        let n = [1, 2, 3, 8, 17, 31, 32, 64][seed % 8];
        r.values = (0..n)
            .map(|i| (((i * 17 + seed * 13) % 41) as f64 - 20.0) / 10.0)
            .collect();
        r.seed = seed as u64;
        r.salt = format!("paired-{seed}-é");
        r.bootstrap_resamples = 32 + seed;
        r.sign_flip_draws = 129 + seed;
        r.exact_maximum_observations = 8;
        r.power.as_mut().unwrap().hypothesis_count = 1 + seed as u32;
        r.hypotheses=serde_json::from_value(json!([{"hypothesisId":"Z","pValue":0.01},{"hypothesisId":"a","pValue":0.01},{"hypothesisId":"é","pValue":0.5},{"hypothesisId":"é","pValue":0.5},{"hypothesisId":"zero-positive","pValue":0.0},{"hypothesisId":"zero-negative","pValue":-0.0}])).unwrap();
        requests.push(r);
    }
    let result = native_oracle::oracle(
        "rust/oracle/analysis-inference-v1.mjs",
        &serde_json::to_value(&requests).unwrap(),
        &[(
            "paper-domain/automation/analysis-statistics.mjs",
            include_bytes!("../../../../paper-domain/automation/analysis-statistics.mjs"),
        )],
    );
    for (i, r) in requests.iter().enumerate() {
        compare(
            &evaluate_analysis_inference_v1(r).unwrap(),
            &result["results"][i],
            &format!("case-{i}"),
        );
    }
    eprintln!(
        "source-bound native inference cases: {} (finite-float tolerance 1e-12 absolute/relative)",
        requests.len()
    );
}
#[test]
fn documented_bounded_inference_is_deterministic_and_non_authoritative() {
    let first = evaluate_analysis_inference_v1(&request()).unwrap();
    let second = evaluate_analysis_inference_v1(&request()).unwrap();
    assert_eq!(first, second);
    assert_eq!(first["mean"], 4.0);
    assert_eq!(first["signFlip"]["draws"], 16);
    assert_eq!(first["scientificAcceptance"], false);
    assert_eq!(first["datasetAuthorityVerified"], false);
    assert_eq!(first["productionActivation"], false);
}
#[test]
fn unknown_fields_are_rejected() {
    let mut r = serde_json::to_value(request()).unwrap();
    r["scientificAcceptance"] = json!(true);
    assert!(serde_json::from_value::<AnalysisInferenceRequestV1>(r).is_err());
}
#[test]
fn exact_branch_enumerates_all_signs() {
    let mut r = request();
    r.values = vec![1.0, 1.0];
    assert_eq!(
        evaluate_analysis_inference_v1(&r).unwrap()["signFlip"]["pValue"],
        0.25
    );
}
#[test]
fn monte_carlo_branch_uses_finite_sample_correction() {
    let mut r = request();
    r.exact_maximum_observations = 0;
    r.values = vec![1.0];
    r.sign_flip_draws = 1;
    let v = evaluate_analysis_inference_v1(&r).unwrap();
    assert!(v["signFlip"]["pValue"].as_f64().unwrap() > 0.0);
    assert_eq!(
        v["signFlip"]["method"],
        "deterministic-monte-carlo-sign-flip-v1"
    );
}
#[test]
fn compensated_sum_preserves_cancellation_residual() {
    assert_eq!(compensated_sum_v1(&[1e16, 1.0, -1e16]).unwrap(), 1.0);
}
#[test]
fn one_value_marks_dispersion_insufficient() {
    let mut r = request();
    r.values = vec![4.0];
    let v = evaluate_analysis_inference_v1(&r).unwrap();
    assert!(v["standardDeviation"].is_null());
    assert!(v["standardError"].is_null());
}
#[test]
fn nan_and_infinite_input_rejected_before_analysis() {
    for x in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
        let mut r = request();
        r.values = vec![x];
        assert!(evaluate_analysis_inference_v1(&r).is_err());
    }
}
#[test]
fn overflow_cannot_become_successful_report() {
    let mut r = request();
    r.values = vec![f64::MAX, f64::MAX];
    assert!(evaluate_analysis_inference_v1(&r).is_err());
    assert!(compensated_sum_v1(&[f64::MAX, f64::MAX]).is_err());
}
#[test]
fn resampling_product_bound_is_checked() {
    let mut r = request();
    r.values = vec![1.0; 65536];
    r.bootstrap_resamples = 65536;
    assert!(r.validate().is_err());
}
#[test]
fn exact_shift_limit_is_checked() {
    let mut r = request();
    r.exact_maximum_observations = usize::MAX;
    assert!(r.validate().is_err());
}
#[test]
fn invalid_probabilities_and_zero_draws_fail() {
    for mut r in [request(), request(), request(), request(), request()]
        .into_iter()
        .enumerate()
    {
        match r.0 {
            0 => r.1.confidence_level = 1.0,
            1 => r.1.sign_flip_draws = 0,
            2 => r.1.bootstrap_resamples = 0,
            3 => r.1.family_alpha = 0.0,
            _ => r.1.winsor_lower_probability = 0.99,
        };
        assert!(r.1.validate().is_err());
    }
}
#[test]
fn duplicate_hypotheses_rejected() {
    let mut r = request();
    r.hypotheses.push(r.hypotheses[0].clone());
    assert!(r.validate().is_err());
}
#[test]
fn holm_ties_use_pinned_locale_and_stop_after_failure() {
    let mut r = request();
    r.hypotheses = serde_json::from_value(
        json!([{"hypothesisId":"Z","pValue":0.03},{"hypothesisId":"a","pValue":0.03}]),
    )
    .unwrap();
    let v = evaluate_analysis_inference_v1(&r).unwrap();
    assert_eq!(v["holm"][0]["hypothesisId"], "a");
    assert_eq!(v["holm"][0]["multiplicityAccepted"], false);
    assert_eq!(v["holm"][1]["multiplicityAccepted"], false);
}
#[test]
fn seed_changes_resampling_stream() {
    let a = evaluate_analysis_inference_v1(&request()).unwrap();
    let mut r = request();
    r.seed += 1;
    let b = evaluate_analysis_inference_v1(&r).unwrap();
    assert_ne!(a["seedHash"], b["seedHash"]);
}
#[test]
fn sample_quantiles_include_endpoints() {
    assert_eq!(quantile_v1(&[7.0, 1.0, 3.0, 5.0], 0.25).unwrap(), 2.5);
    assert_eq!(quantile_v1(&[7.0, 1.0], 1.0).unwrap(), 7.0);
    assert!(quantile_v1(&[], 0.5).is_err());
}
#[test]
fn inverse_normal_domain_and_symmetry() {
    assert_eq!(inverse_normal_cdf_v1(0.5).unwrap(), 0.0);
    assert!(inverse_normal_cdf_v1(0.0).is_err());
    assert!(
        (inverse_normal_cdf_v1(0.025).unwrap() + inverse_normal_cdf_v1(0.975).unwrap()).abs()
            < 1e-10
    );
}
#[test]
fn zero_and_extreme_effect_size_rejected() {
    let mut r = request();
    r.power.as_mut().unwrap().standardized_effect = 0.0;
    assert!(r.validate().is_err());
    r.power.as_mut().unwrap().standardized_effect = f64::MIN_POSITIVE;
    assert!(r.validate().is_err());
}
