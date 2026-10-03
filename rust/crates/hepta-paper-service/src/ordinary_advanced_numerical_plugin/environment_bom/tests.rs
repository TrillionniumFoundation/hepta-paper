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
        "numerical-bom-node-oracle-v2",
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
            arguments: vec!["rust/oracle/numerical-bom.v2.mjs".into()],
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
fn numerical_environment_bom_actual_material_and_rehashed_original_values_match() {
    let c = AtomicBool::new(false);
    let d = Instant::now() + Duration::from_secs(120);
    let all = actual_cases(&c);
    let mut refused = 0;
    for group in ["builderCases", "verificationCases", "receiptCases"] {
        for case in all[group].as_array().unwrap() {
            let expected: Value =
                serde_json::from_str(case["resultRaw"].as_str().unwrap()).unwrap();
            let actual = match group {
                "builderCases" => build_v2(&parse(&case["inputRaw"]), &c, d),
                "verificationCases" => verify_v2(&parse(&case["bomRaw"]), &c, d),
                _ => against_worker_receipt_v2(
                    &parse(&case["bomRaw"]),
                    &parse(&case["receiptRaw"]),
                    &c,
                    d,
                )
                .map(Json::Bool),
            };
            if !case["domain"].is_null() {
                assert!(expected["ok"].as_bool().unwrap());
                assert_eq!(
                    actual.unwrap_err(),
                    if case["domain"] == "finite_json_numbers" {
                        "environment_bom_nonfinite_builder_domain_unaccepted"
                    } else {
                        "environment_bom_threads_data_domain_unaccepted"
                    }
                );
                refused += 1;
                continue;
            }
            let actual = match actual {
                Ok(v) => {
                    let raw = hepta_legacy_compatibility::production_json_stringify_with_limits_v1(
                        &v,
                        hepta_legacy_compatibility::ProductionJsonEncodingLimitsV1 {
                            maximum_bytes: 4 * 1024 * 1024,
                            ..Default::default()
                        },
                        &c,
                    )
                    .unwrap();
                    assert_eq!(
                        String::from_utf8(raw).unwrap(),
                        case["valueRaw"].as_str().unwrap(),
                        "original complete raw JSON order {group} {}",
                        case["name"]
                    );
                    json!({"ok":true,"value":super::super::value(&v,&c).unwrap()})
                }
                Err(e) => {
                    json!({"ok":false,"name":if e=="Cannot convert object to primitive value"||e.starts_with("Cannot read properties")||e=="Cannot convert undefined or null to object" {"TypeError"}else{"Error"},"error":e})
                }
            };
            assert_eq!(actual, expected, "original {group} case {}", case["name"]);
        }
    }
    assert_eq!(refused, 4);
    eprintln!(
        "actual_environment_bom_builders={} actual_rehashed_verifiers={} actual_worker_bindings={} explicit_data_domain_refusals={refused}",
        all["builderCases"].as_array().unwrap().len(),
        all["verificationCases"].as_array().unwrap().len(),
        all["receiptCases"].as_array().unwrap().len()
    );
}
#[test]
fn numerical_environment_bom_preclone_budget_cancel_deadline_and_fresh_retry_refuse() {
    let c = AtomicBool::new(false);
    let d = Instant::now() + Duration::from_secs(120);
    let all = actual_cases(&c);
    let case = &all["builderCases"][0];
    let input = parse(&case["inputRaw"]);
    assert!(
        build_v2(&input, &AtomicBool::new(true), d)
            .unwrap_err()
            .contains("cancelled")
    );
    assert!(
        build_v2(&input, &c, Instant::now())
            .unwrap_err()
            .contains("deadline")
    );
    let over = Json::String(vec![b'x' as u16; 4 * 1024 * 1024]);
    assert!(build_v2(&over, &c, d).is_err());
    let partial = Json::String(vec![b'x' as u16; 3 * 1024 * 1024]);
    assert!(reserve([&partial], &c, d).is_ok());
    assert!(reserve([&partial, &partial], &c, d).is_err());
    let bom = build_v2(&input, &c, d).unwrap();
    assert_eq!(
        super::super::value(&verify_v2(&bom, &c, d).unwrap(), &c).unwrap(),
        json!({"valid":true,"blockers":[]})
    );
    assert!(
        verify_v2(&bom, &AtomicBool::new(true), d)
            .unwrap_err()
            .contains("cancelled")
    );
    assert!(
        against_worker_receipt_v2(&bom, &Json::Null, &c, Instant::now())
            .unwrap_err()
            .contains("deadline")
    );
    assert!(build_v2(&input, &c, Instant::now() + Duration::from_secs(120)).is_ok());
}
