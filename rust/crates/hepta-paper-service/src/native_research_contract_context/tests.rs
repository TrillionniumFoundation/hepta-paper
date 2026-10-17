use super::*;
use hepta_codex_runtime::{
    BoundedProcessRequestV1, EnvironmentPolicyV1, ProcessLimitsV1, ProcessTerminationReason,
    run_bounded_process_capturing_stdout_with_cancellation,
};
use std::{collections::BTreeMap, time::Duration};
fn request() -> NativeResearchContractContextRequestV1 {
    NativeResearchContractContextRequestV1 {
        version: 1,
        row: json!({"task":{"paperId":"paper-local","taskKey":"paper:paper-local:research-verify"},"state":{"evidenceRefs":[]}}),
        source_root: Some(PathBuf::from("/development/scratch/source")),
        evidence_records: Vec::new(),
        proposal_seed_evidence: Vec::new(),
        structured: json!({"claims":[],"obligations":[],"evidenceItems":[],"reproducibilityItems":[]}),
        native_research_worker_execution: json!({"status":"native_research_workers_blocked"}),
        require_native_workers: false,
    }
}
#[test]
fn actual_existing_contract_and_claim_owners_match_original_whole_research_context_values() {
    let modes = [
        "empty",
        "missing-source",
        "require-workers",
        "verified-workers",
        "observed-evidence",
        "proposal-seed",
        "formal-blocked",
        "empirical-claim-blocked",
        "assertion-blocked",
        "all-blocked",
        "claim",
        "proof",
        "matrix",
        "repro",
        "state-refs",
        "dedup",
        "number-refs",
        "bounded128",
    ];
    let mut inputs = Vec::new();
    for mode in modes {
        let mut r = request();
        match mode {
            "missing-source" => r.source_root = None,
            "require-workers" => r.require_native_workers = true,
            "verified-workers" => {
                r.require_native_workers = true;
                r.native_research_worker_execution["status"] =
                    json!("native_research_workers_verified")
            }
            "observed-evidence" => {
                r.evidence_records = vec![
                    json!({"path":"source/data.csv"}),
                    json!({"path":"source/result.json"}),
                ]
            }
            "proposal-seed" => {
                r.proposal_seed_evidence = vec![json!({"path":"proposal-seed-contract.json"})]
            }
            "formal-blocked" => {
                r.structured["canonicalClaimRegistry"] = json!({"status":"canonical_claim_registry_blocked","blockers":["formal-source-missing"]})
            }
            "empirical-claim-blocked" => {
                r.structured["canonicalEmpiricalClaimRegistry"] = json!({"status":"canonical_empirical_claim_registry_blocked","blockers":["claim-missing"]})
            }
            "assertion-blocked" => {
                r.structured["canonicalEmpiricalAssertionUniverse"] = json!({"status":"canonical_empirical_assertion_universe_blocked","blockers":["assertion-missing"]})
            }
            "all-blocked" => {
                r.source_root = None;
                r.require_native_workers = true;
                for (name, status) in [
                    ("canonicalClaimRegistry", "canonical_claim_registry_blocked"),
                    (
                        "canonicalEmpiricalClaimRegistry",
                        "canonical_empirical_claim_registry_blocked",
                    ),
                    (
                        "canonicalEmpiricalAssertionUniverse",
                        "canonical_empirical_assertion_universe_blocked",
                    ),
                ] {
                    r.structured[name] =
                        json!({"status":status,"blockers":["shared","specific", "shared"]})
                }
            }
            "claim" => {
                r.structured["claims"] = json!([{"id":"claim:a","text":"Observed claim","sourceLocator":"main.tex#bytes=0-14"}])
            }
            "proof" => {
                r.structured["obligations"] =
                    json!([{"id":"proof:a","text":"Proof obligation","kind":"formal"}])
            }
            "matrix" => {
                r.structured["evidenceItems"] = json!([{"id":"evidence:a","text":"Observed source","kind":"artifact","evidenceRefs":[{"kind":"path","ref":"data.csv"}]}])
            }
            "repro" => {
                r.structured["reproducibilityItems"] = json!([{"id":"repro:a","text":"Run registered command","kind":"reproducibility"}]);
                r.evidence_records = vec![
                    json!({"path":"run-result.json"}),
                    json!({"path":"data.csv"}),
                ]
            }
            "state-refs" => {
                r.row["state"]["evidenceRefs"] = json!([{"ref":" state/path "},{"ref":"seed.json"}])
            }
            "dedup" => {
                r.row["state"]["evidenceRefs"] = json!([{"ref":" a \r\n\n\n b "},{"ref":"same"}]);
                r.evidence_records = vec![json!({"path":"same"}), json!({"path":" a \n\n b "})]
            }
            "number-refs" => {
                r.row["state"]["evidenceRefs"] =
                    json!([{"ref":4},{"ref":null},{"ref":false},{"ref":["a","b"]}])
            }
            "bounded128" => {
                r.evidence_records = (0..150)
                    .map(|i| json!({"path":format!("results/{i}.json")}))
                    .collect()
            }
            _ => (),
        }
        inputs.push(r);
    }
    let script = r#"import{buildResearchContractContext}from'./paper-adapters/research-verify/research-report-builder.mjs';let raw='';for await(const c of process.stdin){raw+=c;if(Buffer.byteLength(raw)>131072)throw Error('input');}const values=JSON.parse(raw).map(buildResearchContractContext);process.stdout.write(JSON.stringify({profile:{node:process.version,icu:process.versions.icu,cldr:process.versions.cldr},values}));"#;
    let env = EnvironmentPolicyV1::new(
        "actual-research-context",
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
                .expect("qualified Node"),
            arguments: vec!["--input-type=module".into(), "--eval".into(), script.into()],
            working_directory: PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../../..")
                .canonicalize()
                .unwrap(),
            environment: env,
            stdin: Some(serde_json::to_vec(&inputs).unwrap()),
        },
        ProcessLimitsV1 {
            timeout_ms: 60000,
            termination_grace_ms: 100,
            cleanup_timeout_ms: 2000,
            maximum_stdin_bytes: 131072,
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
    assert_eq!(node.process.stderr_bytes, 0);
    assert!(node.process.process_group_cleanup_verified);
    let actual: Value = serde_json::from_slice(&node.stdout).unwrap();
    assert_eq!(
        actual["profile"],
        json!({"node":"v22.23.1","icu":"78.2","cldr":"48.0"})
    );
    for (index, r) in inputs.into_iter().enumerate() {
        assert_eq!(
            build_native_research_contract_context_v1(
                r,
                &AtomicBool::new(false),
                Instant::now() + Duration::from_secs(60)
            )
            .unwrap(),
            actual["values"][index],
            "whole original context {}",
            modes[index]
        )
    }
    println!(
        "actual_research_contract_context={}",
        json!({"actualWholeCases":modes.len(),"nodePid":node.process.process_id,"stdoutBytes":node.process.stdout_bytes,"stdoutSha256":node.process.stdout_hash,"scientificAuthorityGranted":false})
    );
}
#[test]
fn actual_context_rejects_combined_preclone_budget_cancel_deadline_shape_and_allows_fresh_retry() {
    let c = AtomicBool::new(false);
    let deadline = || Instant::now() + Duration::from_secs(60);
    assert!(
        build_native_research_contract_context_v1(request(), &AtomicBool::new(true), deadline())
            .is_err()
    );
    assert!(build_native_research_contract_context_v1(request(), &c, Instant::now()).is_err());
    let mut r = request();
    r.structured["claims"] = json!(false);
    r.row["state"]["evidenceRefs"] = json!("wrong");
    assert!(build_native_research_contract_context_v1(r, &c, deadline()).is_err());
    let mut r = request();
    r.structured["claims"] = json!(
        (0..10)
            .map(|i| json!({"id":format!("a{i}"),"text":"x".repeat(60000)}))
            .collect::<Vec<_>>()
    );
    r.evidence_records = (0..10).map(|_| json!({"path":"y".repeat(60000)})).collect();
    assert!(build_native_research_contract_context_v1(r, &c, deadline()).is_err());
    assert!(build_native_research_contract_context_v1(request(), &c, deadline()).is_ok());
}
