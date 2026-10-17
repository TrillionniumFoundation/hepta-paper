use super::*;
use hepta_codex_runtime::{
    BoundedProcessRequestV1, EnvironmentPolicyV1, ProcessLimitsV1, ProcessTerminationReason,
    run_bounded_process_capturing_stdout_with_cancellation,
};
use serde_json::{Value, json};
use std::{collections::BTreeMap, ffi::OsString, path::PathBuf, time::Duration};
fn actual_cases(c: &AtomicBool) -> Value {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .canonicalize()
        .expect("physical source ROOT");
    let node = PathBuf::from(std::env::var("HEPTA_TEST_NODE").expect("qualified Node required"));
    let environment = EnvironmentPolicyV1::new(
        "numerical-execution-contract-node-oracle-v1",
        ["PATH", "LANG", "LC_ALL"],
        ["PATH"],
    )
    .unwrap()
    .build(
        std::iter::empty::<(OsString, OsString)>(),
        &BTreeMap::from([
            (
                "PATH".into(),
                node.parent().unwrap().to_str().unwrap().to_owned(),
            ),
            ("LANG".into(), "C.UTF-8".into()),
            ("LC_ALL".into(), "C.UTF-8".into()),
        ]),
    )
    .unwrap();
    let output = run_bounded_process_capturing_stdout_with_cancellation(
        &BoundedProcessRequestV1 {
            executable: node,
            arguments: vec!["rust/oracle/numerical-execution-contract.v1.mjs".into()],
            working_directory: root,
            environment,
            stdin: None,
        },
        ProcessLimitsV1 {
            timeout_ms: 30_000,
            maximum_stdout_bytes: 4 * 1024 * 1024,
            maximum_stderr_bytes: 64 * 1024,
            maximum_tail_bytes: 64 * 1024,
            ..ProcessLimitsV1::default()
        },
        c,
    )
    .unwrap();
    assert_eq!(
        output.process.termination_reason,
        ProcessTerminationReason::Exited
    );
    assert!(output.process.process_group_cleanup_verified);
    assert_eq!(
        output.process.exit_code,
        Some(0),
        "{}",
        String::from_utf8_lossy(&output.process.stderr_tail)
    );
    serde_json::from_slice(&output.stdout).unwrap()
}
fn parse(raw: &Value) -> Json {
    hepta_legacy_compatibility::parse_production_json_v1(raw.as_str().unwrap().as_bytes()).unwrap()
}
#[test]
fn numerical_execution_contract_original_request_and_result_complete_values_match() {
    let c = AtomicBool::new(false);
    let d = Instant::now() + Duration::from_secs(120);
    let cases = actual_cases(&c);
    let requests = cases["requestCases"].as_array().unwrap();
    let results = cases["resultCases"].as_array().unwrap();
    let mut missing_input_domain = 0;
    let mut actual_type_errors = Vec::new();
    for case in requests {
        let descriptor = parse(&case["descriptorRaw"]);
        let wire = parse(&case["wireRaw"]);
        let expected: Value = serde_json::from_str(case["resultRaw"].as_str().unwrap()).unwrap();
        let actual = request_v1(&descriptor, &wire, &c, d);
        if case["name"] == "input-missing" {
            assert_eq!(expected["name"], "TypeError");
            assert_eq!(
                actual.unwrap_err(),
                "advanced_numerical_plugin_request_input_invalid"
            );
            missing_input_domain += 1;
            continue;
        }
        if expected["name"] == "TypeError" {
            assert_eq!(
                expected["error"],
                "Cannot convert object to primitive value"
            );
            assert_eq!(
                actual.unwrap_err(),
                "Cannot convert object to primitive value"
            );
            actual_type_errors.push(case["name"].clone());
            continue;
        }
        let actual = match actual {
            Ok(value) => json!({"ok":true,"value":super::super::value(&value,&c).unwrap()}),
            Err(error) => json!({"ok":false,"name":"Error","error":error}),
        };
        assert_eq!(
            actual, expected,
            "actual original request case {}",
            case["name"]
        );
    }
    for case in results {
        let descriptor = parse(&case["descriptorRaw"]);
        let request = parse(&case["requestRaw"]);
        let result = parse(&case["resultRaw"]);
        let expected: Value = serde_json::from_str(case["actualRaw"].as_str().unwrap()).unwrap();
        let actual = result_valid_v1(&result, &descriptor, &request, &c, d);
        if expected["name"] == "TypeError" {
            assert_eq!(
                expected["error"],
                "Cannot convert object to primitive value"
            );
            assert_eq!(
                actual.unwrap_err(),
                "Cannot convert object to primitive value"
            );
            actual_type_errors.push(case["name"].clone());
            continue;
        }
        let actual = json!({"ok":true,"value":actual.unwrap()});
        assert_eq!(
            actual, expected,
            "actual original result case {}",
            case["name"]
        );
    }
    assert_eq!(missing_input_domain, 1);
    assert_eq!(actual_type_errors.len(), 9);
    eprintln!("actual_original_json_string_type_errors={actual_type_errors:?}");
    eprintln!(
        "actual_numerical_request_cases={} actual_numerical_result_cases={} explicit_missing_input_domain_refusal={}",
        requests.len(),
        results.len(),
        missing_input_domain
    );
}
#[test]
fn numerical_execution_contract_controls_and_input_boundary_refuse() {
    let c = AtomicBool::new(false);
    let d = Instant::now() + Duration::from_secs(120);
    let cases = actual_cases(&c);
    let first = &cases["requestCases"][0];
    let descriptor = parse(&first["descriptorRaw"]);
    let wire = parse(&first["wireRaw"]);
    assert!(
        request_v1(&descriptor, &wire, &AtomicBool::new(true), d)
            .unwrap_err()
            .contains("cancelled")
    );
    assert!(
        request_v1(&descriptor, &wire, &c, Instant::now())
            .unwrap_err()
            .contains("deadline")
    );
    let mut over = wire.clone();
    let Json::Object(fields) = &mut over else {
        panic!("wire object")
    };
    fields
        .iter_mut()
        .find(|(k, _)| k.iter().copied().eq("input".encode_utf16()))
        .unwrap()
        .1 = Json::String(vec![b'x' as u16; 32767]);
    assert_eq!(
        request_v1(&descriptor, &over, &c, d).unwrap_err(),
        "advanced_numerical_plugin_request_input_too_large"
    );
    assert!(
        request_v1(
            &descriptor,
            &wire,
            &c,
            Instant::now() + Duration::from_secs(120)
        )
        .is_ok()
    );
    let result = &cases["resultCases"][0];
    assert!(
        result_valid_v1(
            &parse(&result["resultRaw"]),
            &descriptor,
            &parse(&result["requestRaw"]),
            &AtomicBool::new(true),
            d
        )
        .unwrap_err()
        .contains("cancelled")
    );
}
