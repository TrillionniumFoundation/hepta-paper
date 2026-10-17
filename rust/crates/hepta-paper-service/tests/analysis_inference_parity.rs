//! Bounded checks for the Rust port of the incumbent paired-analysis helpers.

use hepta_paper_service::native_business::inference::{
    AnalysisInferenceRequestV1, evaluate_analysis_inference_v1,
};
use serde_json::Value;
use std::io::Write;
use std::process::{Command, Stdio};

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

fn assert_json_numeric_equivalent(left: &Value, right: &Value, path: &str) {
    match (left, right) {
        (Value::Number(left), Value::Number(right)) => {
            assert_eq!(left.as_f64(), right.as_f64(), "numeric mismatch at {path}")
        }
        (Value::Array(left), Value::Array(right)) => {
            assert_eq!(left.len(), right.len(), "array length mismatch at {path}");
            for (index, (left, right)) in left.iter().zip(right).enumerate() {
                assert_json_numeric_equivalent(left, right, &format!("{path}[{index}]"));
            }
        }
        (Value::Object(left), Value::Object(right)) => {
            assert_eq!(
                left.keys().collect::<Vec<_>>(),
                right.keys().collect::<Vec<_>>()
            );
            for (key, left) in left {
                assert_json_numeric_equivalent(left, &right[key], &format!("{path}.{key}"));
            }
        }
        _ => assert_eq!(left, right, "value mismatch at {path}"),
    }
}

#[test]
fn bounded_corpus_matches_the_production_node_oracle() {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../../docs/modules/examples/paired-analysis.v1.json"
    ))
    .expect("documented analysis fixture");
    let edge = serde_json::json!({
        "version": 1,
        "values": [0.1, -2.3, 4.5, 8.9, -1.2, 3.4, 0.0, 9.1, -7.7, 2.2, 1.1, -4.4, 5.5, -6.6, 7.7, -8.8, 9.9],
        "confidenceLevel": 0.9,
        "familyAlpha": 0.1,
        "bootstrapResamples": 17,
        "signFlipDraws": 19,
        "exactMaximumObservations": 2,
        "seed": 987654321,
        "salt": "edge-corpus-v1",
        "quantileProbabilities": [0.0, 0.1, 0.5, 0.9, 1.0],
        "winsorLowerProbability": 0.1,
        "winsorUpperProbability": 0.9,
        "hypotheses": [
            {"hypothesisId":"zeta","pValue":0.08},
            {"hypothesisId":"alpha","pValue":0.02},
            {"hypothesisId":"beta","pValue":0.2}
        ],
        "power": {"alpha":0.1,"targetPower":0.75,"standardizedEffect":0.8,"hypothesisCount":3}
    });
    let requests = serde_json::json!([fixture, edge]);
    let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let mut child = Command::new("node")
        .arg(root.join("rust/oracle/analysis-inference-v1.mjs"))
        .current_dir(&root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .expect("Node 22.23.1 oracle runtime is required");
    child
        .stdin
        .take()
        .expect("oracle stdin")
        .write_all(requests.to_string().as_bytes())
        .expect("oracle request");
    let output = child.wait_with_output().expect("oracle process");
    assert!(
        output.status.success(),
        "Node oracle failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let oracle: Value = serde_json::from_slice(&output.stdout).expect("oracle response");
    hepta_legacy_compatibility::qualify_production_node_profile_v1(&oracle["profile"])
        .expect("qualified Node/ICU/CLDR and incumbent canonicalization source");
    assert_eq!(
        oracle["sources"][NODE_SOURCE],
        hex::encode(<sha2::Sha256 as sha2::Digest>::digest(include_bytes!(
            "../../../../paper-domain/automation/analysis-statistics.mjs"
        ))),
        "exact incumbent source binding"
    );
    for (index, request) in requests
        .as_array()
        .expect("corpus array")
        .iter()
        .enumerate()
    {
        let typed: AnalysisInferenceRequestV1 =
            serde_json::from_value(request.clone()).expect("typed inference request");
        let rust =
            serde_json::to_value(evaluate_analysis_inference_v1(&typed).expect("Rust inference"))
                .expect("Rust report JSON");
        assert_json_numeric_equivalent(&rust, &oracle["results"][index], &format!("case {index}"));
    }
}
