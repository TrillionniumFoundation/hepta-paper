use super::*;
use crate::native_research_claims::{
    NativeResearchClaimRegistryRequestV1, build_native_research_claim_registry_v1,
};
use hepta_codex_runtime::{
    BoundedProcessRequestV1, EnvironmentPolicyV1, ProcessLimitsV1, ProcessTerminationReason,
    run_bounded_process_capturing_stdout_with_cancellation,
};
use std::{collections::BTreeMap, path::PathBuf, time::Duration};
pub(crate) fn actual_node(script: &str, input: &Value) -> (Value, Value) {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .canonicalize()
        .unwrap();
    let environment = EnvironmentPolicyV1::new(
        "native-actual-research-assessment",
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
                .expect("qualified Node"),
            arguments: vec!["--input-type=module".into(), "--eval".into(), script.into()],
            working_directory: root,
            environment,
            stdin: Some(serde_json::to_vec(input).unwrap()),
        },
        ProcessLimitsV1 {
            timeout_ms: 60000,
            termination_grace_ms: 100,
            cleanup_timeout_ms: 2000,
            maximum_stdin_bytes: 1048576,
            maximum_stdout_bytes: 4 * 1048576,
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
    let value: Value = serde_json::from_slice(&result.stdout).unwrap();
    assert_eq!(
        value["profile"],
        json!({"node":"v22.23.1","icu":"78.2","cldr":"48.0"})
    );
    (
        value,
        json!({"pid":result.process.process_id,"stdoutBytes":result.process.stdout_bytes,"stdoutHash":result.process.stdout_hash}),
    )
}
fn deadline() -> Instant {
    Instant::now() + Duration::from_secs(30)
}
#[test]
fn actual_nonattested_quality_matches_original_complete_claim_coverage_values_and_hashes() {
    let task = json!({"paperId":"quality-actual","taskKey":"paper:quality-actual"});
    let mut cases = Vec::new();
    for kind in [
        "evidence",
        "ordinary",
        "FORMAL",
        "proof",
        "theorem",
        "empirical",
        "experiment",
        "reproducibility",
        "",
    ] {
        for verified in [false, true] {
            for require in [false, true] {
                let claim = json!({"id":"claim:a","text":"Observed source claim","sourceLocator":"main.tex:1","riskClass":kind,"verificationPlan":{"kind":kind,"requiresEvidence":require},"proofObligations":["goal"]});
                let intake = json!({"status":if verified{"evidence_intake_ready"}else{"evidence_intake_blocked"},"items":[{"claimIds":["claim:a","unregistered"],"hash":"sha256:actual","verifiedHash":if verified{"sha256:actual"}else{"sha256:other"},"verificationStatus":"evidence_artifact_verified","provenanceReceiptHash":"sha256:provenance","consumptionPolicy":{"status":"evidence_consumption_ready"}}]});
                cases.push(json!({"paperTask":task,"claims":[claim],"evidenceIntake":intake}));
            }
        }
    }
    cases.push(json!({"paperTask":task,"claims":[],"evidenceIntake":{"status":"evidence_intake_blocked","items":[]}}));
    cases.push(json!({"paperTask":task,"claims":[{"id":"a","text":"a","sourceLocator":"main.tex:1","verificationPlan":{"kind":"evidence","requiresEvidence":false}},{"id":"b","text":"b","sourceLocator":"main.tex:2","verificationPlan":{"kind":"evidence","requiresEvidence":false,"requiresWorker":true}}],"evidenceIntake":{"status":"evidence_intake_blocked","items":[]}}));
    cases.push(json!({"paperTask":task,"claims":[{"id":"a","text":"source","sourceLocator":"main.tex","verificationPlan":{"kind":"evidence","requiresEvidence":true}}],"evidenceIntake":{"status":"evidence_intake_ready","items":[{"claimIds":["z","b","z","a"],"hash":"sha256:actual","verifiedHash":"sha256:actual","verificationStatus":"evidence_artifact_verified","provenanceReceiptHash":"sha256:p","consumptionPolicy":{"status":"evidence_consumption_ready"}}]}}));
    let script = r#"import{buildClaimRegistry}from'./paper-domain/research/claim-registry.mjs';import{buildEvidenceQualityGate}from'./paper-domain/research/evidence-quality-gate.mjs';let raw='';for await(const c of process.stdin){raw+=c;if(Buffer.byteLength(raw)>1048576)throw Error('budget');}const values=JSON.parse(raw).map(q=>buildEvidenceQualityGate({paperTask:q.paperTask,claimRegistry:buildClaimRegistry({paperTask:q.paperTask,claims:q.claims}),evidenceIntake:q.evidenceIntake}));process.stdout.write(JSON.stringify({profile:{node:process.version,icu:process.versions.icu,cldr:process.versions.cldr},values}));"#;
    let (node, receipt) = actual_node(script, &json!(cases));
    for (i, input) in cases.iter().enumerate() {
        let registry = build_native_research_claim_registry_v1(
            NativeResearchClaimRegistryRequestV1 {
                version: 1,
                paper_task: input["paperTask"].clone(),
                claims: input["claims"].as_array().unwrap().clone(),
            },
            &AtomicBool::new(false),
        )
        .unwrap();
        let result = quality_from_observed_intake(
            &input["paperTask"],
            &registry,
            &input["evidenceIntake"],
            &AtomicBool::new(false),
            deadline(),
        )
        .unwrap();
        assert_eq!(result, node["values"][i], "whole original quality case {i}");
    }
    assert!(
        node["values"]
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v["status"] == "evidence_quality_ready")
    );
    println!(
        "actual_nonattested_quality_observation={}",
        json!({"process":receipt,"wholeOriginalValues":cases.len(),"academicAuthorityGranted":false,"productionRequiresOpaqueArtifactObservation":true})
    );
}
#[test]
fn actual_nonattested_quality_refuses_budget_expiration_cancellation_and_retries() {
    let task = json!({"paperId":"p"});
    let input = json!({"status":"claim_graph_valid","claims":[{"claimId":"a","text":"actual","sourceLocator":"main.tex:1","verificationPlan":{"kind":"evidence","requiresEvidence":false}}]});
    let intake = json!({"items":[],"status":"evidence_intake_blocked"});
    assert!(
        quality_from_observed_intake(&task, &input, &intake, &AtomicBool::new(true), deadline())
            .is_err()
    );
    assert_eq!(
        quality_from_observed_intake(
            &task,
            &input,
            &intake,
            &AtomicBool::new(false),
            Instant::now()
        )
        .unwrap_err(),
        "native_research_quality_deadline_exceeded"
    );
    let mut large = input.clone();
    large["claims"]=json!((0..256).map(|i|json!({"claimId":format!("c{i}"),"text":"x".repeat(3800),"sourceLocator":"main.tex","verificationPlan":{"kind":"evidence","requiresEvidence":false}})).collect::<Vec<_>>());
    reserve([&large], 0, 0).unwrap();
    assert!(
        quality_from_observed_intake(&task, &large, &intake, &AtomicBool::new(false), deadline())
            .is_err()
    );
    let mut outside = input.clone();
    outside["claims"][0]["verificationPlan"]["kind"] = json!("ΟΣ");
    assert!(
        quality_from_observed_intake(
            &task,
            &outside,
            &intake,
            &AtomicBool::new(false),
            deadline()
        )
        .is_err()
    );
    assert_eq!(
        quality_from_observed_intake(&task, &input, &intake, &AtomicBool::new(false), deadline())
            .unwrap()["status"],
        "evidence_quality_ready"
    );
}
