use super::*;
use hepta_codex_runtime::{
    BoundedProcessRequestV1, EnvironmentPolicyV1, ProcessLimitsV1, ProcessTerminationReason,
    run_bounded_process_capturing_stdout_with_cancellation,
};
use std::{collections::BTreeMap, path::PathBuf, time::Duration};
fn node_records(cases: &[Value]) -> Value {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .canonicalize()
        .unwrap();
    let script = r#"import {buildResearchGapPlan} from './paper-domain/research/gap-planner.mjs';let raw='';for await(const c of process.stdin){raw+=c;if(Buffer.byteLength(raw)>1048576)throw Error('budget');}const q=JSON.parse(raw);process.stdout.write(JSON.stringify({profile:{node:process.version,icu:process.versions.icu,cldr:process.versions.cldr},records:q.map(q=>{try{return {ok:true,value:buildResearchGapPlan(q)}}catch(e){return {ok:false,error:e.name}}})}));"#;
    let environment = EnvironmentPolicyV1::new(
        "research-gap-plan-original",
        ["PATH", "LANG", "LC_ALL"],
        ["PATH"],
    )
    .unwrap()
    .build(
        std::iter::empty::<(std::ffi::OsString, std::ffi::OsString)>(),
        &BTreeMap::from([
            ("PATH".into(), "/usr/bin:/bin".into()),
            ("LANG".into(), "C.UTF-8".into()),
            ("LC_ALL".into(), "C.UTF-8".into()),
        ]),
    )
    .unwrap();
    let result = run_bounded_process_capturing_stdout_with_cancellation(
        &BoundedProcessRequestV1 {
            executable: std::env::var_os("HEPTA_TEST_NODE")
                .map(PathBuf::from)
                .expect("qualified Node required"),
            arguments: vec!["--input-type=module".into(), "--eval".into(), script.into()],
            working_directory: root,
            environment,
            stdin: Some(serde_json::to_vec(cases).unwrap()),
        },
        ProcessLimitsV1 {
            timeout_ms: 60000,
            termination_grace_ms: 100,
            cleanup_timeout_ms: 2000,
            maximum_stdin_bytes: 1048576,
            maximum_stdout_bytes: 4 * 1024 * 1024,
            maximum_stderr_bytes: 65536,
            maximum_tail_bytes: 32768,
            ..ProcessLimitsV1::default()
        },
        &AtomicBool::new(false),
    )
    .unwrap();
    assert_eq!(
        result.process.termination_reason,
        ProcessTerminationReason::Exited
    );
    assert_eq!(result.process.exit_code, Some(0));
    assert!(result.process.process_group_cleanup_verified);
    assert_eq!(result.process.stderr_bytes, 0);
    let observed: Value = serde_json::from_slice(&result.stdout).unwrap();
    assert_eq!(
        observed["profile"],
        json!({"node":"v22.23.1","icu":"78.2","cldr":"48.0"})
    );
    println!(
        "actual_research_gap_plan_node_process={}",
        json!({"pid":result.process.process_id,"stdoutBytes":result.process.stdout_bytes,"stdoutHash":result.process.stdout_hash,"cases":cases.len()})
    );
    observed
}
fn deadline() -> Instant {
    Instant::now() + Duration::from_secs(30)
}
#[test]
fn actual_research_gap_plan_matches_original_complete_contract_values_and_hashes() {
    let mut cases = vec![
        json!({}),
        json!({"paperTask":{"paperId":false},"claimRegistry":{"claims":[]}}),
    ];
    for risk in [
        "theorem_readiness",
        "PROOF",
        "formal_verification",
        "experiment",
        "EMPIRICAL",
        "benchmark",
        "reproducibility",
        "reproduction",
        "artifact",
        "package",
        "evidence_artifact",
        "ordinary",
    ] {
        cases.push(json!({"paperTask":{"paperId":"paper:actual"},"claimRegistry":{"claims":[{"claimId":"actual","riskClass":risk,"status":"needs_evidence"}]},"priorJobs":[{"claimId":"actual","receiptHash":"old"},{"claimId":"actual","receiptHash":"latest"}]}));
    }
    for priority in [
        Value::Null,
        json!(false),
        json!(true),
        json!(0),
        json!(-2),
        json!("0x20"),
        json!(" 5 "),
        json!([]),
        json!([2]),
        json!([null]),
        json!("Infinity"),
        json!("not-a-number"),
        json!({}),
        json!(9007199254740993_u64),
    ] {
        cases.push(json!({"claimRegistry":{"claims":[{"claimId":"coercion","riskClass":"proof"}]},"priorities":{"coercion":priority}}));
    }
    cases.push(json!({"paperTask":{"paperId":true},"claimRegistry":{"claims":[{"claimId":"z","riskClass":"proof"},{"claimId":"á","kind":"experiment"},{"claimId":"A"},{"claimId":"a"},{"claimId":"é"},{"claimId":"e\u{301}"},{"claimId":"1"},{"claimId":"10"}]},"priorities":{"z":-1,"1":"2","10":null}}));
    cases.push(json!({"claimRegistry":{"claims":[{"claimId":"a"},{"claimId":"b"},{"claimId":"c"},{"claimId":"d"}]},"evidenceQualityGate":{"coveredClaimIds":"ab"}}));
    cases.push(json!({"claimRegistry":{"claims":[{"claimId":null,"status":false}]},"evidenceQualityGate":{"coveredClaimIds":[null]},"priorJobs":[{"claimId":null,"receiptHash":false}]}));
    cases.push(json!({"claimRegistry":{"claims":[{"claimId":9007199254740993_u64}]},"evidenceQualityGate":{"coveredClaimIds":[9007199254740992_u64]}}));
    cases.push(json!({"claimRegistry":{"claims":[{}]},"priorJobs":[{},false,{"receiptHash":["actual",7]}]}));
    cases.push(json!({"claimRegistry":{"claims":[{"claimId":{"key":"actual"},"status":[1,null]}]},"evidenceQualityGate":{"coveredClaimIds":[{"key":"actual"}]},"priorJobs":[{"claimId":{"key":"actual"},"receiptHash":"must_not_match_identity"}]}));
    for status in ["resolved", "closed", "requested", "needs_revision"] {
        cases.push(json!({"paperTask":{"paperId":"actual"},"revisionRequests":[{"request_id":0,"requestId":7,"request_key":"空😀/request","claim_id":false,"claimId":"real","matrix_rank":null,"matrixRank":"0x4","risk_class":"FORMAL_VERIFICATION","status":status,"updatedAt":false,"sourceLocator":{"path":"main.tex"},"evidenceNeeded":[1,null],"verification":{"requiresEvidence":true}}]}));
    }
    cases.push(json!({"claimRegistry":{"claims":[{"claimId":"a","status":"open"},{"claimId":"a","status":"new"}]},"revisionRequests":[{}, {"request_key":true,"matrix_rank":false,"status":"requested"},{"requestKey":["x",null,"y"],"matrixRank":[2],"claimId":"same","riskClass":"artifact"}]}));
    for id in ["constructor", "toString", "__proto__"] {
        cases.push(json!({"claimRegistry":{"claims":[{"claimId":id}]}}));
    }
    let actual = node_records(&cases);
    for (i, request) in cases.iter().enumerate() {
        assert_eq!(actual["records"][i]["ok"], true, "Node case {i}");
        let native =
            build_native_research_gap_plan_v1(request, &AtomicBool::new(false), deadline())
                .unwrap();
        assert_eq!(
            native, actual["records"][i]["value"],
            "whole original case {i}"
        );
    }
    println!(
        "actual_research_gap_plan_whole_value_observation={}",
        json!({"wholeCases":cases.len(),"completeValuesAndHashesEqual":true,"jobsPersisted":false,"executionAuthorityGranted":false})
    );
}
#[test]
fn actual_research_gap_plan_refuses_type_coercion_resource_and_stale_controls() {
    let type_cases = vec![
        Value::Null,
        json!({"claimRegistry":{"claims":{}}}),
        json!({"claimRegistry":{"claims":[null]}}),
        json!({"priorJobs":null}),
        json!({"revisionRequests":[null]}),
        json!({"evidenceQualityGate":{"coveredClaimIds":7}}),
        json!({"claimRegistry":{"claims":[{"claimId":"a"}]},"priorities":{"a":{"toString":false}}}),
    ];
    let original = node_records(&type_cases);
    for (i, request) in type_cases.iter().enumerate() {
        assert_eq!(original["records"][i]["ok"], false, "original refusal {i}");
        assert!(
            build_native_research_gap_plan_v1(request, &AtomicBool::new(false), deadline())
                .is_err()
        );
    }
    let legal_outside_v1 = json!({"claimRegistry":{"claims":[{"claimId":"a"},{"claimId":"b"}]},"priorities":{"a":"not-a-number","b":1}});
    let original = node_records(std::slice::from_ref(&legal_outside_v1));
    assert_eq!(original["records"][0]["ok"], true);
    assert!(
        build_native_research_gap_plan_v1(&legal_outside_v1, &AtomicBool::new(false), deadline())
            .is_err()
    );
    let joined_outside_v1 = json!({"claimRegistry":{"claims":[{"claimId":"one"}]},"priorities":{"one":["x".repeat(40000),"y".repeat(40000)]}});
    budget([&joined_outside_v1]).unwrap();
    let original_joined = node_records(std::slice::from_ref(&joined_outside_v1));
    assert_eq!(
        original_joined["records"][0]["ok"], true,
        "single original nonfinite priority is legal"
    );
    assert!(
        build_native_research_gap_plan_v1(&joined_outside_v1, &AtomicBool::new(false), deadline())
            .is_err(),
        "v1 String projection refuses before joining two legal strings"
    );
    let large = json!({"paperTask":{"paperId":"p".repeat(64000)},"claimRegistry":{"claims":(0..12).map(|i|json!({"claimId":format!("c{i}")})).collect::<Vec<_>>()}});
    budget([&large]).unwrap();
    assert!(
        build_native_research_gap_plan_v1(&large, &AtomicBool::new(false), deadline()).is_err()
    );
    assert!(
        build_native_research_gap_plan_v1(&json!({}), &AtomicBool::new(true), deadline()).is_err()
    );
    assert_eq!(
        build_native_research_gap_plan_v1(&json!({}), &AtomicBool::new(false), Instant::now())
            .unwrap_err(),
        "native_research_gap_plan_deadline_exceeded"
    );
    assert_eq!(
        build_native_research_gap_plan_v1(&json!({}), &AtomicBool::new(false), deadline()).unwrap()
            ["jobs"],
        json!([])
    );
}
