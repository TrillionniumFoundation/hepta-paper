use std::collections::BTreeSet;

use hepta_paper_service::native_business::{
    NativeBusinessJobV1, execute_native_business_for_capability_v1,
};
use serde::Deserialize;
use serde_json::Value;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Examples {
    schema_version: u16,
    scope: String,
    cases: Vec<Example>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Example {
    capability_id: String,
    expected_evidence_kind: String,
    expected_artifact_count: usize,
    job: Value,
}

fn examples() -> Examples {
    serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../docs/modules/examples/native-business.v1.json"
    )))
    .expect("closed documentation examples")
}

#[test]
fn documented_native_business_examples_execute_without_authority() {
    let examples = examples();
    assert_eq!(examples.schema_version, 1);
    assert_eq!(examples.scope, "bounded_native_kernels_only");
    let mut seen = BTreeSet::new();
    for case in examples.cases {
        assert!(seen.insert(case.capability_id.clone()));
        let job: NativeBusinessJobV1 = serde_json::from_value(case.job).expect("documented job");
        assert_eq!(job.capability_id(), case.capability_id);
        let first = execute_native_business_for_capability_v1(job.clone(), &case.capability_id)
            .expect("execute documented example");
        let second = execute_native_business_for_capability_v1(job, &case.capability_id)
            .expect("repeat documented example");
        assert_eq!(first, second);
        assert_eq!(first.artifacts.len(), case.expected_artifact_count);
        assert!(first.artifacts.iter().all(|bytes| !bytes.is_empty()));
        assert_eq!(first.evidence["kind"], case.expected_evidence_kind);
        if case.capability_id == "CAP-SUBMIT" {
            assert_eq!(first.evidence["externalEffectAuthorized"], false);
        } else {
            assert_eq!(first.evidence["externalActionMayHaveStarted"], false);
        }
    }
    let expected: BTreeSet<String> = [
        "CAP-AUTHOR",
        "CAP-REVIEW",
        "CAP-FORMAL",
        "CAP-EMPIRICAL",
        "CAP-NUMERICAL",
        "CAP-BUILD",
        "CAP-SUBMIT",
    ]
    .into_iter()
    .map(String::from)
    .collect();
    assert_eq!(seen, expected);
}

#[test]
fn documented_jobs_reject_unknown_fields_and_wrong_capabilities() {
    for case in examples().cases {
        let job: NativeBusinessJobV1 =
            serde_json::from_value(case.job.clone()).expect("documented job");
        assert!(execute_native_business_for_capability_v1(job, "CAP-UNKNOWN").is_err());
        let mut malformed = case.job;
        malformed
            .as_object_mut()
            .expect("job object")
            .insert("unexpectedAuthority".into(), Value::Bool(true));
        assert!(serde_json::from_value::<NativeBusinessJobV1>(malformed).is_err());
    }
}
