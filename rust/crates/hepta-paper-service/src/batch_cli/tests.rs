use super::*;
use hepta_codex_runtime::{
    BoundedProcessRequestV1, EnvironmentPolicyV1, ProcessLimitsV1, ProcessTerminationReason,
    run_bounded_process_capturing_stdout_with_cancellation,
};
use serde_json::{Value, json};
use sha2::Digest;
use std::{collections::BTreeMap, ffi::OsString, path::PathBuf, sync::atomic::AtomicBool};
#[test]
fn native_batch_options_match_actual_fixed_normal_node_parser_and_normalizer_whole_values() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .canonicalize()
        .unwrap();
    let default_root = "/fixed/default/root";
    let default_runtime = "/fixed/default/runtime";
    let mut cases: Vec<Vec<String>> = vec![vec![]];
    for &flag in BOOLEANS {
        cases.push(vec![format!("--{flag}")]);
        cases.push(vec!["--execute".into(), "--execute".into()]);
    }
    for &flag in VALUES {
        cases.push(vec![
            format!("--{flag}"),
            match flag {
                "limit" | "max-rounds" => "2".into(),
                "dataset-authorization" => format!("SHA256:{}", "a".repeat(64)),
                _ => "fixed value".into(),
            },
        ]);
    }
    for args in [
        vec![
            "--mode",
            "local-dry-run",
            "--paper",
            "paper-a",
            "--paper=paper-b",
            "--execute",
            "--json",
        ],
        vec![
            "--target=primary",
            "--venue=ignored",
            "--dataset-root=data-a",
            "--dataset=data-b",
            "--benchmark-id=bench-a",
            "--benchmark=bench-b",
        ],
        vec![
            "--root",
            "../../relative//root/./",
            "--runtime-root=/absolute/a/../../runtime/",
            "--dataset-harness",
            "a/../authority.json",
        ],
        vec![
            "--languages",
            "\u{feff} python \u{00a0},,, latex,\u{0085} next\u{0085}",
        ],
        vec![
            "--paper=p",
            "--paper=p",
            "--material=ignored",
            "--constraint=ignored",
        ],
        vec!["--help"],
        vec!["--"],
        vec!["--="],
        vec!["--unknown"],
        vec!["--json=true"],
        vec!["--mode"],
        vec!["--mode= "],
        vec!["--mode="],
        vec!["--mode", "--execute"],
        vec!["--mode", "one", "--mode", "two"],
        vec!["position"],
        vec!["--legacy-workflow-projection"],
        vec!["--approved"],
        vec!["--dataset-authorization=no", "--limit=no"],
        vec!["--dataset-authorization=no", "--max-rounds=no"],
        vec!["--dataset-authorization=no"],
    ] {
        cases.push(args.into_iter().map(str::to_owned).collect());
    }
    for number in [
        "1",
        "1.0",
        "1e2",
        "0x10",
        "0b10",
        "0o10",
        "\u{feff}2\u{00a0}",
        "\u{0085}2",
        "0",
        "-0",
        "-1",
        "1.5",
        "NaN",
        "Infinity",
        "9007199254740991",
        "9007199254740992",
        "1_0",
        "+0x10",
    ] {
        for flag in ["--limit", "--max-rounds"] {
            cases.push(vec![flag.into(), number.into()]);
        }
    }
    let expected = cases
        .iter()
        .map(|a| {
            match normalize_native_batch_cli_arguments_v1(
                a,
                root.to_str().unwrap(),
                default_root,
                default_runtime,
            ) {
                Ok(v) => json!({"ok":true,"value":v}),
                Err(e) => json!({"ok":false,"error":e}),
            }
        })
        .collect::<Vec<_>>();
    let script = format!(
        "{}\n{}",
        include_str!("../release_replay/oracle-input-guard.mjs"),
        r#"import {parsePaperProductionArgs,buildPaperBatchCliOptions} from './paper-core/src/paper-production-cli-options.mjs';const input=readBoundedReplayInput('referee');const actual=input.cases.map(row=>{if(row.name!=='native_batch_options'||row.args.length!==1)throw new Error('batch_case');try{return {ok:true,value:buildPaperBatchCliOptions(parsePaperProductionArgs(['batch-run',...row.args[0]]),{defaultRoot:'/fixed/default/root',defaultRuntimeRoot:'/fixed/default/runtime'})};}catch(e){return {ok:false,error:e.message};}});process.stdout.write(JSON.stringify({profile:{node:process.version,icu:process.versions.icu,cldr:process.versions.cldr},actual}));"#
    );
    let environment = EnvironmentPolicyV1::new(
        "native-batch-options-differential-v1",
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
    let result=run_bounded_process_capturing_stdout_with_cancellation(&BoundedProcessRequestV1{executable:std::env::var_os("HEPTA_TEST_NODE").map(PathBuf::from).unwrap(),arguments:vec!["--input-type=module".into(),"--eval".into(),script.into()],working_directory:root,environment,stdin:Some(serde_json::to_vec(&json!({"version":1,"baseCaseCount":0,"cases":cases.iter().map(|a|json!({"name":"native_batch_options","args":[a]})).collect::<Vec<_>>()})).unwrap())},ProcessLimitsV1{timeout_ms:60_000,termination_grace_ms:100,cleanup_timeout_ms:2_000,maximum_stdin_bytes:64*1024,maximum_stdout_bytes:1024*1024,maximum_stderr_bytes:64*1024,maximum_tail_bytes:4096,..ProcessLimitsV1::default()},&AtomicBool::new(false)).unwrap();
    assert_eq!(
        result.process.termination_reason,
        ProcessTerminationReason::Exited
    );
    assert_eq!(result.process.exit_code, Some(0), "{:?}", result);
    assert!(result.process.process_group_cleanup_verified);
    // The legacy field describes the bounded tail, not full captured stdout.
    assert_eq!(result.process.stderr_bytes, 0);
    assert_eq!(result.process.stdout_bytes, result.stdout.len() as u64);
    assert_eq!(
        result.process.stdout_hash.as_str(),
        format!(
            "sha256:{}",
            hex::encode(sha2::Sha256::digest(&result.stdout))
        )
    );
    let value: Value = serde_json::from_slice(&result.stdout).unwrap();
    assert_eq!(
        value["profile"],
        json!({"node":"v22.23.1","icu":"78.2","cldr":"48.0"})
    );
    let actual = value["actual"].as_array().unwrap();
    assert_eq!(actual.len(), expected.len());
    for (index, (native, node)) in expected.iter().zip(actual).enumerate() {
        assert_eq!(native, node, "batch input {index}: {:?}", cases[index]);
    }
    println!(
        "native_batch_options_observation={}",
        json!({"version":1,"actualCaseCount":cases.len(),"actualNodePid":result.process.process_id,"actualStdoutBytes":result.stdout.len(),"actualStdoutSha256":result.process.stdout_hash,"wholeOriginalNormalParserAndOptionsMatched":true,"inventoryOrQueueExecuted":false,"normalSubmissionRouteAccepted":false})
    );
}
#[test]
fn native_batch_options_finite_v1_domain_refuses_unbounded_or_nul_inputs_without_io() {
    let defaults = ("/cwd", "/root", "/runtime");
    for args in [
        vec!["--paper".into(), "\0".into()],
        vec!["--paper".into(), "x".repeat(64 * 1024 + 1)],
        vec!["--help".into(); 257],
    ] {
        assert_eq!(
            normalize_native_batch_cli_arguments_v1(&args, defaults.0, defaults.1, defaults.2)
                .unwrap_err(),
            "native_batch_cli_input_budget_v1"
        );
    }
    assert!(normalize_native_batch_cli_arguments_v1(&[], "relative", "/root", "/runtime").is_err());
}
