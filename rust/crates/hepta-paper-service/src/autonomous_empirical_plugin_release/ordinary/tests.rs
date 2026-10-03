use super::*;
use hepta_codex_runtime::{
    BoundedProcessRequestV1, EnvironmentPolicyV1, ProcessLimitsV1, ProcessTerminationReason,
    run_bounded_process_capturing_stdout_with_cancellation,
};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    ffi::OsString,
    path::{Path, PathBuf},
    time::Duration,
};
fn args(values: &[&str]) -> Vec<String> {
    values.iter().map(|v| (*v).into()).collect()
}
fn wire(argv: &[String]) -> Value {
    let c = AtomicBool::new(false);
    let d = Instant::now() + Duration::from_secs(120);
    match original_request(argv, &c, d) {
        Ok(None) => json!({"ok":true,"stdout":format!("{USAGE}\n")}),
        Ok(Some(v)) => {
            let mut bytes = production_json_pretty_with_limits_v1(
                &v,
                ProductionJsonEncodingLimitsV1::default(),
                &c,
            )
            .unwrap();
            bytes.push(b'\n');
            json!({"ok":true,"stdout":String::from_utf8(bytes).unwrap()})
        }
        Err(error) => json!({"ok":false,"error":error}),
    }
}
fn oracle(cases: &[Vec<String>]) -> Vec<Value> {
    let root =
        std::fs::canonicalize(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..")).unwrap();
    let node = PathBuf::from(std::env::var_os("HEPTA_TEST_NODE").expect("qualified Node required"));
    let program = "import {runAutonomousEmpiricalPluginRelease as run} from './paper-core/bin/autonomous-empirical-plugin-release.mjs';import {productionOracleProfile} from './rust/oracle/production-record-hash-v1.mjs';const cases=JSON.parse(process.argv[1]);console.log(JSON.stringify({profile:productionOracleProfile(),cases:cases.map(argv=>{try{const v=run({argv});return {ok:true,stdout:(typeof v==='string'?v:JSON.stringify(v,null,2))+'\\n'};}catch(e){return {ok:false,error:e.message};}})}));";
    let environment = EnvironmentPolicyV1::new(
        "plugin-template-oracle-v1",
        ["PATH", "LANG", "LC_ALL"],
        ["PATH"],
    )
    .unwrap()
    .build(
        std::iter::empty::<(OsString, OsString)>(),
        &BTreeMap::from([
            ("PATH".into(), "/usr/bin:/bin".into()),
            ("LANG".into(), "C.UTF-8".into()),
            ("LC_ALL".into(), "C.UTF-8".into()),
        ]),
    )
    .unwrap();
    let output = run_bounded_process_capturing_stdout_with_cancellation(
        &BoundedProcessRequestV1 {
            executable: node,
            arguments: vec![
                "--input-type=module".into(),
                "-e".into(),
                program.into(),
                serde_json::to_string(cases).unwrap().into(),
            ],
            working_directory: root,
            environment,
            stdin: None,
        },
        ProcessLimitsV1 {
            timeout_ms: 30_000,
            maximum_stdout_bytes: 4 * 1024 * 1024,
            maximum_stderr_bytes: 64 * 1024,
            maximum_tail_bytes: 4 * 1024,
            ..ProcessLimitsV1::default()
        },
        &AtomicBool::new(false),
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
    let parsed: Value = serde_json::from_slice(&output.stdout).unwrap();
    hepta_legacy_compatibility::qualify_production_node_profile_v1(&parsed["profile"]).unwrap();
    parsed["cases"].as_array().unwrap().clone()
}
#[test]
fn original_unsigned_template_complete_profiles_null_ignored_flags_and_errors_match_node_raw_wire()
{
    let mut cases = vec![
        args(&["--action=template"]),
        args(&[
            "--action",
            "template",
            "--package-id",
            " custom.id ",
            "--package-version",
            " 02.03.0004-rc.2 ",
        ]),
        args(&[
            "--action=template",
            "--package-id",
            "\u{feff}custom.id\u{feff}",
        ]),
        args(&[
            "--action=template",
            "--template=missing",
            "--signing-config=missing",
            "--install-root=missing",
            "--activation=missing",
        ]),
        args(&[
            "--action=template",
            "--signing-config=missing",
            "--install-root=missing",
            "--activation=missing",
        ]),
        args(&["--help", "--action=wrong"]),
        vec![],
        args(&["--action=plan", "--package-version=1.0.0"]),
        args(&["--action=publish", "--template=missing"]),
        args(&["--action=inspect"]),
        args(&["--action=template", "--template=missing", "--package-id=x"]),
        args(&["--action=template", "--benchmark-family=wrong"]),
        args(&[
            "--action=template",
            "--benchmark-family=ml_algorithm_benchmark",
            "--benchmark-family= ml_algorithm_benchmark ",
        ]),
        args(&["--action=template", "--package-id=bad/id"]),
        args(&["--action=template", "--package-version=1.0"]),
        args(&["--action=wrong"]),
        args(&["--help=true"]),
        args(&["--help", "--help"]),
        args(&["--"]),
        args(&["--=x"]),
        args(&["positional"]),
        args(&["--unknown"]),
        args(&["--action"]),
        args(&["--action="]),
        args(&["--action", "--help"]),
        args(&["--action=template", "--action=plan"]),
    ];
    let families = [
        "rl_stochastic_control_benchmark",
        "ml_algorithm_benchmark",
        "econometrics_panel_benchmark",
        "finance_asset_pricing_benchmark",
        "operations_optimization_benchmark",
        "registered_scalar_response_benchmark",
    ];
    for f in families {
        cases.push(vec![
            "--action=template".into(),
            "--benchmark-family".into(),
            f.into(),
        ]);
    }
    let mut all = args(&["--action=template"]);
    for f in families.into_iter().rev() {
        all.extend(["--benchmark-family".into(), f.into()]);
    }
    cases.push(all);
    let expected = oracle(&cases);
    assert_eq!(expected.len(), cases.len());
    for (i, (argv, e)) in cases.iter().zip(expected).enumerate() {
        assert_eq!(wire(argv), e, "case{i} {argv:?}");
    }
    eprintln!("actual_original_node_raw_wire_cases={}", cases.len());
}
#[test]
fn ordinary_template_controls_bounds_writer_refusal_and_old_standalone_semantics_hold() {
    let c = AtomicBool::new(true);
    let d = Instant::now() + Duration::from_secs(120);
    let argv = args(&["--action=template"]);
    assert!(
        original_request(&argv, &c, d)
            .unwrap_err()
            .ends_with("cancelled")
    );
    c.store(false, Ordering::SeqCst);
    assert!(
        original_request(&argv, &c, Instant::now())
            .unwrap_err()
            .ends_with("deadline_exceeded")
    );
    assert!(original_request(&argv, &c, d).is_ok());
    assert!(
        original_request(&vec!["--help".into(); 65], &c, d)
            .unwrap_err()
            .ends_with("arguments_limit")
    );
    assert!(
        original_request(&[format!("--package-id={}", "a".repeat(32 * 1024))], &c, d)
            .unwrap_err()
            .ends_with("arguments_limit")
    );
    for argv in [
        args(&[
            "--action=plan",
            "--template=not-read",
            "--signing-config=not-read",
        ]),
        args(&[
            "--action=publish",
            "--template=not-read",
            "--signing-config=not-read",
            "--install-root=not-read",
        ]),
        args(&[
            "--action=inspect",
            "--activation=not-read",
            "--template=ignored",
            "--package-id=ignored",
        ]),
    ] {
        assert!(
            original_request(&argv, &c, d)
                .unwrap_err()
                .ends_with("ordinary_unsigned_template_action_required")
        );
    }
    assert!(
        super::super::parse_autonomous_empirical_plugin_release_arguments(&args(&[
            "--action",
            "template",
            "--template",
            "/tmp/not-read"
        ]))
        .is_err()
    );
    assert!(
        super::super::parse_autonomous_empirical_plugin_release_arguments(&args(&[
            "--action=template"
        ]))
        .is_err()
    );
    let old = super::super::parse_autonomous_empirical_plugin_release_arguments(&args(&[
        "--action", "template",
    ]))
    .unwrap();
    let legacy = super::super::generated_template(&old);
    assert!(legacy["profiles"][0].get("profileId").is_none());
    assert!(startup_pair(None, None).is_ok());
    assert!(startup_pair(Some("\u{feff} "), Some(" ")).is_ok());
    assert_eq!(
        startup_pair(Some("not-read"), None).unwrap_err(),
        "immutable_signed_json_bundle_configuration_incomplete"
    );
    assert!(
        startup_pair(Some("not-read"), Some("not-read"))
            .unwrap_err()
            .ends_with("domain_unaccepted_v1")
    );
    assert!(
        startup_pair(Some(&"x".repeat(64 * 1024 + 1)), None)
            .unwrap_err()
            .ends_with("configuration_limit")
    );
    eprintln!("old_standalone_mode_preserved=true authority=false");
}
