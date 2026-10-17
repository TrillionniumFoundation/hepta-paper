use super::*;
use hepta_codex_runtime::{
    BoundedProcessRequestV1, EnvironmentPolicyV1, ProcessLimitsV1, ProcessTerminationReason,
    run_bounded_process_capturing_stdout_with_cancellation,
};
use std::{collections::BTreeMap, ffi::OsString, path::PathBuf, time::Duration};
fn input(v: &Value) -> QualificationInputs {
    QualificationInputs {
        descriptor: v["descriptor"].clone(),
        bundle_hash: v["bundleHash"].as_str().unwrap().into(),
        plugin_authority: v["pluginAuthority"].clone(),
        plugin_trust: v["pluginTrust"].clone(),
        statement: v["statement"].clone(),
        evidence: v["evidence"].clone(),
        trust: v["trust"].clone(),
    }
}
fn actual_cases(c: &AtomicBool) -> Value {
    actual_cases_for_profile(c, false)
}
fn actual_cases_for_profile(c: &AtomicBool, gpu: bool) -> Value {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .canonicalize()
        .expect("physical source ROOT");
    let node = PathBuf::from(std::env::var("HEPTA_TEST_NODE").expect("qualified Node required"));
    let environment = EnvironmentPolicyV1::new(
        "numerical-qualification-node-oracle-v2",
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
            arguments: if gpu {
                vec![
                    "rust/oracle/numerical-qualification.v2.mjs".into(),
                    "--gpu".into(),
                ]
            } else {
                vec!["rust/oracle/numerical-qualification.v2.mjs".into()]
            },
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
#[test]
fn ordinary_numerical_qualification_v2_actual_complete_node_chain_and_refusals_match() {
    let c = AtomicBool::new(false);
    let d = Instant::now() + Duration::from_secs(120);
    let cases = actual_cases(&c);
    assert_eq!(cases.as_array().unwrap().len(), 21);
    for case in cases.as_array().unwrap() {
        let v = &case["input"];
        let result = input(v).inspect_at(v["now"].as_i64().unwrap(), &c, d);
        let observed = match result {
            Ok(v) => serde_json::json!({"ok":value(&v,&c).unwrap()}),
            Err(error) => serde_json::json!({"error":error}),
        };
        assert_eq!(
            observed, case["expected"],
            "actual original whole-value case {}",
            case["label"]
        );
    }
    eprintln!("actual_original_qualification_whole_values=21");
}
#[test]
fn ordinary_numerical_qualification_v2_controls_input_budget_and_fresh_retry() {
    let c = AtomicBool::new(false);
    let d = Instant::now() + Duration::from_secs(120);
    let cases = actual_cases(&c);
    let v = &cases[0]["input"];
    let q = input(v);
    let now = v["now"].as_i64().unwrap();
    assert!(q.inspect_at(now, &c, d).is_ok());
    c.store(true, Ordering::Release);
    assert!(q.inspect_at(now, &c, d).unwrap_err().contains("cancelled"));
    let fresh = AtomicBool::new(false);
    assert!(
        q.inspect_at(now, &fresh, Instant::now())
            .unwrap_err()
            .contains("deadline")
    );
    assert!(q.inspect_at(now, &fresh, d).is_ok());
    let mut q = input(v);
    q.trust["keys"][0]["organization"] = Value::String("a".repeat(64 * 1024 + 1));
    assert!(q.inspect_at(now, &fresh, d).is_err());
    assert!(input(v).inspect_at(now, &fresh, d).is_ok());
}

#[test]
fn ordinary_numerical_gpu_qualification_actual_complete_node_chain_matches() {
    let c = AtomicBool::new(false);
    let d = Instant::now() + Duration::from_secs(120);
    let cases = actual_cases_for_profile(&c, true);
    assert_eq!(cases.as_array().unwrap().len(), 21);
    for case in cases.as_array().unwrap() {
        let v = &case["input"];
        let raw =
            parse_production_json_v1(case["descriptorRaw"].as_str().unwrap().as_bytes()).unwrap();
        assert_eq!(descriptor::inspect(&raw, &c, d).unwrap(), v["descriptor"]);
        let result = input(v).inspect_at(v["now"].as_i64().unwrap(), &c, d);
        let observed = match result {
            Ok(v) => serde_json::json!({"ok":value(&v,&c).unwrap()}),
            Err(error) => serde_json::json!({"error":error}),
        };
        assert_eq!(
            observed, case["expected"],
            "actual original GPU whole-value {}",
            case["label"]
        );
    }
    eprintln!("actual_original_gpu_qualification_whole_values=21");
}
