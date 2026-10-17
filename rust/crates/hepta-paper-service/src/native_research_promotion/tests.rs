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
    let script = r#"import {buildPromotionInputSnapshot,buildResearchGapClosureReceipt} from './paper-domain/quality/promotion-input-snapshot.mjs';import {buildResearchChangeProposal} from './paper-domain/research/change-proposal.mjs';let raw='';for await(const c of process.stdin){raw+=c;if(Buffer.byteLength(raw)>1048576)throw Error('budget');}const q=JSON.parse(raw);process.stdout.write(JSON.stringify({profile:{node:process.version,icu:process.versions.icu,cldr:process.versions.cldr},records:q.map(q=>{try{return {ok:true,value:({snapshot:buildPromotionInputSnapshot,closure:buildResearchGapClosureReceipt,change:buildResearchChangeProposal})[q.api](q.input)}}catch(e){return {ok:false,error:e.name}}})}));"#;
    let environment = EnvironmentPolicyV1::new(
        "research-promotion-original",
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
        "actual_research_promotion_node_process={}",
        json!({"pid":result.process.process_id,"stdoutBytes":result.process.stdout_bytes,"stdoutHash":result.process.stdout_hash,"cases":cases.len()})
    );
    observed
}

fn deadline() -> Instant {
    Instant::now() + Duration::from_secs(30)
}
fn native(case: &Value, c: &AtomicBool, d: Instant) -> Result<Value, String> {
    match case["api"].as_str() {
        Some("snapshot") => build_native_promotion_input_snapshot_v1(&case["input"], c, d),
        Some("closure") => build_native_research_gap_closure_receipt_v1(&case["input"], c, d),
        Some("change") => build_native_research_change_proposal_v1(&case["input"], c, d),
        _ => Err(refused()),
    }
}
#[test]
fn actual_research_promotion_records_match_original_whole_values_and_hashes() {
    let mut cases = vec![
        json!({"api":"snapshot","input":{}}),
        json!({"api":"closure","input":{}}),
        json!({"api":"change","input":{}}),
    ];
    for id in [
        Value::Null,
        json!(false),
        json!(0),
        json!(true),
        json!(9007199254740993_u64),
        json!([1, null, "x"]),
        json!({"key":"actual"}),
    ] {
        cases.push(json!({"api":"snapshot","input":{"paperTask":{"paperId":id,"taskHash":true,"paperQualityProfile":"survey_or_position"},"claimRegistry":{"claimRegistryHash":[9007199254740993_u64]},"evidenceQualityGate":{"evidenceQualityGateHash":"actual-quality"},"researchGapPlan":{"researchGapPlanHash":"actual-plan"},"createdAt":false,"revisionRequests":[{"request_id":id,"request_key":"A","claimId":"c","risk_class":"proof","status":"OPEN","createdAt":"actual-creation"},{"requestId":"z","requestKey":"á","status":"CLOSED","updatedAt":"actual-update"},false,{}, {"requestId":"e\u{301}","status":"RESOLVED"},{"requestId":"é","status":"requested"}]}}));
    }
    for status in [
        Value::Null,
        json!(false),
        json!(0),
        json!("resolved"),
        json!("CLOSED"),
        json!(["closed"]),
        json!({"value":"closed"}),
    ] {
        cases.push(json!({"api":"snapshot","input":{"revisionRequests":[{"requestId":"revision","status":status}]}}));
    }
    for plan_hash in [
        Value::Null,
        json!(false),
        json!(0),
        json!(true),
        json!("plan"),
        json!(9007199254740993_u64),
        json!([]),
        json!({"h":"same-but-not-identical"}),
    ] {
        cases.push(json!({"api":"closure","input":{"promotionInputSnapshot":{"status":"promotion_input_snapshot_frozen","promotionInputSnapshotHash":"snapshot","researchGapPlanHash":plan_hash},"researchGapPlan":{"researchGapPlanHash":plan_hash,"jobs":[{"jobId":"b","claimId":"c"},{"jobId":"a","revisionRequestId":9},{"jobId":"c"}]},"completedJobReceipts":[null,{"jobId":"b","status":"research_gap_job_completed","receiptHash":true},{"jobId":"b","status":"research_gap_job_completed","receiptHash":"duplicate"},{"jobId":"a","status":"claimed-complete","receiptHash":"unaccepted"}]}}));
    }
    cases.push(json!({"api":"closure","input":{"promotionInputSnapshot":{"status":"promotion_input_snapshot_frozen"},"researchGapPlan":{"jobs":[{}, {"jobId":null},{"jobId":1},{"jobId":true},{"jobId":[1,null]},{"jobId":{"a":1}}]},"completedJobReceipts":[{"status":"research_gap_job_completed","receiptHash":1}, {"jobId":{"a":1},"status":"research_gap_job_completed","receiptHash":1},{"jobId":9007199254740993_u64,"status":"research_gap_job_completed","receiptHash":1},{"jobId":9007199254740992_u64,"status":"research_gap_job_completed","receiptHash":1}]}}));
    for gate in [
        Value::Null,
        json!("evidence_quality_ready"),
        json!("blocked"),
        json!(true),
    ] {
        for patches in [
            json!([]),
            json!([{}]),
            json!([{}, false, 7, "patch"]),
            json!([{"preimageHash":true,"patchHash":1},{"preimageHash":["hash"],"patchHash":{"value":9007199254740993_u64}}]),
        ] {
            cases.push(json!({"api":"change","input":{"paperTask":{"paperId":9007199254740993_u64},"evidenceQualityGate":{"status":gate},"patches":patches}}));
        }
    }
    let original = node_records(&cases);
    for (i, case) in cases.iter().enumerate() {
        assert_eq!(original["records"][i]["ok"], true, "original case {i}");
        assert_eq!(
            native(case, &AtomicBool::new(false), deadline()).unwrap(),
            original["records"][i]["value"],
            "whole value/hash case {i}"
        );
    }
    println!(
        "actual_research_promotion_whole_records={}",
        json!({"cases":cases.len(),"suppliedClosureReceiptsAuthenticated":false,"scientificAcceptanceGranted":false,"repairAuthorityGranted":false,"sourceMutationPerformed":false})
    );
}
#[test]
fn actual_research_promotion_refuses_null_custom_shared_projection_and_stale_controls() {
    let invalid = vec![
        json!({"api":"snapshot","input":null}),
        json!({"api":"snapshot","input":{"revisionRequests":null}}),
        json!({"api":"snapshot","input":{"revisionRequests":[null]}}),
        json!({"api":"closure","input":{"completedJobReceipts":null}}),
        json!({"api":"closure","input":{"researchGapPlan":{"jobs":[null]}}}),
        json!({"api":"change","input":{"patches":null}}),
        json!({"api":"change","input":{"patches":[null]}}),
    ];
    let original = node_records(&invalid);
    for (i, case) in invalid.iter().enumerate() {
        assert_eq!(original["records"][i]["ok"], false);
        assert!(native(case, &AtomicBool::new(false), deadline()).is_err());
    }
    let custom = json!({"api":"snapshot","input":{"revisionRequests":[{"requestId":{"toString":false}},{}]}});
    assert!(native(&custom, &AtomicBool::new(false), deadline()).is_err());
    let large = json!({"api":"change","input":{"evidenceQualityGate":{"status":"evidence_quality_ready"},"patches":[{"preimageHash":"pre","patchHash":"post","payload":(0..14).map(|_|"x".repeat(65536)).collect::<Vec<_>>()}]}});
    budget([&large["input"]]).unwrap();
    let original = node_records(std::slice::from_ref(&large));
    assert_eq!(original["records"][0]["ok"], true);
    assert!(native(&large, &AtomicBool::new(false), deadline()).is_err());
    for api in ["snapshot", "closure", "change"] {
        let case = json!({"api":api,"input":{}});
        assert!(native(&case, &AtomicBool::new(true), deadline()).is_err());
        assert_eq!(
            native(&case, &AtomicBool::new(false), Instant::now()).unwrap_err(),
            "native_research_promotion_deadline_exceeded"
        );
        assert!(native(&case, &AtomicBool::new(false), deadline()).is_ok());
    }
}
