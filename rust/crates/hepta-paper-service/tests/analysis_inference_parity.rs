//! Bounded checks for the Rust port of the incumbent paired-analysis helpers.

use hepta_paper_service::native_business::inference::{
    AnalysisInferenceRequestV1, evaluate_analysis_inference_v1,
};

const NODE_SOURCE: &str = "paper-domain/automation/analysis-statistics.mjs";
const ORACLE: &str = "rust/oracle/analysis-inference-v1.mjs";
const EXAMPLE: &str = "docs/modules/examples/paired-analysis.v1.json";

#[test]
fn documented_paired_analysis_fixture_is_deterministic() {
    assert!(!NODE_SOURCE.is_empty() && !ORACLE.is_empty() && !EXAMPLE.is_empty());
    let request: AnalysisInferenceRequestV1 = serde_json::from_str(include_str!(
        "../../../../docs/modules/examples/paired-analysis.v1.json"
    ))
    .expect("documented paired-analysis request");
    let first = evaluate_analysis_inference_v1(&request).expect("bounded inference");
    let second = evaluate_analysis_inference_v1(&request).expect("repeat bounded inference");
    assert_eq!(
        serde_json::to_value(&first).unwrap(),
        serde_json::to_value(&second).unwrap()
    );
    assert_eq!(first.count, 4);
    assert_eq!(first.mean, 4.0);
    assert_eq!(first.bootstrap["resamples"], 256);
    assert_eq!(first.bootstrap["lower"], 2.0);
    assert_eq!(first.bootstrap["upper"], 6.0);
    assert_eq!(
        first.sign_flip["method"],
        "exact-paired-sign-flip-enumeration-v1"
    );
    assert_eq!(
        first.seed_hash,
        "sha256:300bd0e5808dff5ceaeda37ec2730b6a3177c04b5e74d8ebe340dab91d40b2da"
    );
    assert_eq!(first.required_paired_observations, Some(32));
    assert!(!first.scientific_acceptance);
}
