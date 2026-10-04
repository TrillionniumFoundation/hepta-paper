use super::*;
use hepta_codex_runtime::{
    BoundedProcessRequestV1, EnvironmentPolicyV1, ProcessLimitsV1, ProcessTerminationReason,
    run_bounded_process_capturing_stdout_with_cancellation,
};
use std::{collections::BTreeMap, path::PathBuf};
fn base() -> NativeResearchContractBundleRequestV1 {
    NativeResearchContractBundleRequestV1 {
        version: 1,
        paper_task: json!({"paperId":"paper:actual","taskKey":"task:actual"}),
        claims: vec![],
        obligations: vec![],
        evidence_items: vec![],
        reproducibility_items: vec![],
        evidence_refs: vec![],
        reproducibility_evidence_refs: vec![],
        claim_scope_blockers: vec![],
        receipt_blockers: vec![],
        receipt_warnings: vec![],
        created_at: None,
    }
}
#[test]
fn actual_four_contracts_and_derived_receipt_match_original_node_full_values() {
    let mut cases = vec![base()];
    let mut r = base();
    r.claims = vec![json!("Measured claim")];
    r.obligations = vec![json!("Prove relation")];
    r.evidence_items = vec![json!("Actual measurement")];
    r.reproducibility_items = vec![json!("seed:7")];
    r.evidence_refs = vec![json!("result.json")];
    r.reproducibility_evidence_refs = r.evidence_refs.clone();
    cases.push(r);
    let mut r = base();
    r.claims = vec![
        json!({"key":" alias ","description":"a\r\n\n\nb\t\t c","state":" pending ","type":" empirical ","evidence_refs":[{"path":" measurements.json ","hash":" sha256:measured ","notes":" own observed "}],"source_locator":" paper/main.md "}),
    ];
    r.obligations = r.claims.clone();
    r.evidence_items = r.claims.clone();
    r.reproducibility_items = r.claims.clone();
    r.created_at = Some(json!("2026-01-02T03:04:05.000Z"));
    cases.push(r);
    let mut r = base();
    r.claims = vec![
        json!({"text":1.0,"status":true,"id":1e21,"kind":false}),
        json!({"text":[null,1,"x"],"sourceLocator":true}),
        json!(null),
        json!(false),
        json!(7),
    ];
    r.evidence_refs = vec![
        json!({"id":1.0,"kind":0,"notes":true}),
        json!(" "),
        json!({"ref":false}),
    ];
    cases.push(r);
    let mut r = base();
    r.claims = (0..110).map(|n| json!(format!("claim {n}"))).collect();
    r.obligations = r.claims.clone();
    r.evidence_items = (0..200).map(|n| json!(format!("evidence {n}"))).collect();
    r.reproducibility_items = r.claims.clone();
    cases.push(r);
    let mut r = base();
    r.claim_scope_blockers = vec![json!(" "), json!("same"), json!("same")];
    r.receipt_blockers = vec![json!(" same "), json!("")];
    r.receipt_warnings = vec![json!("manual"), json!(" manual "), json!(1.0)];
    cases.push(r);
    let mut r = base();
    r.evidence_refs = vec![json!("")];
    r.claim_scope_blockers = vec![json!("")];
    cases.push(r);
    let mut r = base();
    r.claims = vec![
        json!("\u{feff}\t\u{00a0}Ａ\r\n\n\nＢ \u{feff}"),
        json!({"id":" ","key":"ignored","text":" ","claim":"ignored","evidenceRefs":[" a "]}),
    ];
    r.created_at = Some(json!(false));
    cases.push(r);
    let mut r = base();
    r.evidence_refs = vec![
        json!({"url":" https://example.invalid/data ","kind":" ","hash":"","notes":0}),
        json!("run.json"),
    ];
    r.reproducibility_evidence_refs = vec![json!("run.json")];
    r.reproducibility_items = vec![json!({"locator":"log/result.json"})];
    cases.push(r);
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .canonicalize()
        .unwrap();
    let script = r#"import {createClaimScopeContract,createProofObligationContract,createEvidenceMatrixContract,createReproducibilityContract,buildPaperResearchVerifyReceipt} from './paper-domain/contracts/research-contracts.mjs';let raw='';for await(const c of process.stdin){raw+=c;if(Buffer.byteLength(raw)>1048576)throw Error('input');}const requests=JSON.parse(raw);const records=requests.map(q=>{const c=createClaimScopeContract({paperTask:q.paperTask,claims:q.claims,evidenceRefs:q.evidenceRefs,blockers:q.claimScopeBlockers,createdAt:q.createdAt});const p=createProofObligationContract({paperTask:q.paperTask,obligations:q.obligations,evidenceRefs:q.evidenceRefs,createdAt:q.createdAt});const e=createEvidenceMatrixContract({paperTask:q.paperTask,evidenceItems:q.evidenceItems,evidenceRefs:q.evidenceRefs,createdAt:q.createdAt});const r=createReproducibilityContract({paperTask:q.paperTask,artifacts:q.reproducibilityItems,evidenceRefs:q.reproducibilityEvidenceRefs,createdAt:q.createdAt});return {claimScopeContract:c,proofObligationContract:p,evidenceMatrixContract:e,reproducibilityContract:r,verifyReceipt:buildPaperResearchVerifyReceipt({paperTask:q.paperTask,claimScopeContract:c,proofObligationContract:p,evidenceMatrixContract:e,reproducibilityContract:r,evidenceRefs:q.evidenceRefs,blockers:q.receiptBlockers,warnings:q.receiptWarnings,createdAt:q.createdAt})};});process.stdout.write(JSON.stringify({profile:{node:process.version,icu:process.versions.icu,cldr:process.versions.cldr},records}));"#;
    let env = EnvironmentPolicyV1::new(
        "contract-differential",
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
    let node = run_bounded_process_capturing_stdout_with_cancellation(
        &BoundedProcessRequestV1 {
            executable: std::env::var_os("HEPTA_TEST_NODE")
                .map(PathBuf::from)
                .expect("qualified Node required"),
            arguments: vec!["--input-type=module".into(), "--eval".into(), script.into()],
            working_directory: root,
            environment: env,
            stdin: Some(serde_json::to_vec(&cases).unwrap()),
        },
        ProcessLimitsV1 {
            timeout_ms: 60_000,
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
        node.process.termination_reason,
        ProcessTerminationReason::Exited
    );
    assert_eq!(node.process.exit_code, Some(0));
    assert!(node.process.process_group_cleanup_verified);
    assert_eq!(node.process.stderr_bytes, 0);
    let actual: Value = serde_json::from_slice(&node.stdout).unwrap();
    assert_eq!(
        actual["profile"],
        json!({"node":"v22.23.1","icu":"78.2","cldr":"48.0"})
    );
    for (i, request) in cases.into_iter().enumerate() {
        assert_eq!(
            build_native_research_contract_bundle_v1(request, &AtomicBool::new(false)).unwrap(),
            actual["records"][i],
            "actual original whole Value case {i}"
        );
    }
    println!(
        "actual_research_contract_observation={}",
        json!({"nodePid":node.process.process_id,"stdoutBytes":node.process.stdout_bytes,"stdoutSha256":node.process.stdout_hash,"actualCaseCount":actual["records"].as_array().unwrap().len(),"fullContractsPerCase":5,"fullResearchAdapterAccepted":false,"scientificAcceptanceGranted":false})
    );
}
#[test]
fn actual_contract_bundle_refuses_cancel_budget_custom_coercion_and_caller_hashes() {
    assert!(build_native_research_contract_bundle_v1(base(), &AtomicBool::new(true)).is_err());
    let mut r = base();
    r.claims = vec![json!({"text":{"toString":"uncallable"}})];
    assert!(build_native_research_contract_bundle_v1(r, &AtomicBool::new(false)).is_err());
    let mut r = base();
    r.claims = vec![json!("x".repeat(65537))];
    assert!(build_native_research_contract_bundle_v1(r, &AtomicBool::new(false)).is_err());
    let mut r = serde_json::to_value(base()).unwrap();
    r["claimScopeContractHash"] = json!("caller");
    assert!(serde_json::from_value::<NativeResearchContractBundleRequestV1>(r).is_err());
}
