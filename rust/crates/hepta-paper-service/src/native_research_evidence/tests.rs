use super::*;
use hepta_codex_runtime::{
    BoundedProcessRequestV1, EnvironmentPolicyV1, ProcessLimitsV1, ProcessTerminationReason,
    run_bounded_process_capturing_stdout_with_cancellation,
};
use std::{
    collections::BTreeMap,
    fs,
    os::unix::fs::{PermissionsExt, symlink},
    sync::atomic::AtomicU64,
};
static NEXT: AtomicU64 = AtomicU64::new(1);
pub(super) struct Temp(pub(super) PathBuf);
impl Temp {
    pub(super) fn new() -> Self {
        let p = std::env::temp_dir().join(format!(
            "hepta-evidence-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::SeqCst)
        ));
        fs::create_dir(&p).unwrap();
        fs::set_permissions(&p, fs::Permissions::from_mode(0o700)).unwrap();
        Self(p)
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn request(root: &Path) -> NativeResearchEvidenceRequestV1 {
    NativeResearchEvidenceRequestV1 {
        version: 1,
        root: root.into(),
        source_root: Some(root.join("source")),
        log_root: Some(root.join("logs")),
        empirical_root: Some(root.join("empirical")),
        paper_task: json!({"paperId":"actual","paperQualityProfile":"theoretical_or_formal"}),
    }
}
#[test]
fn actual_source_log_empirical_reader_matches_original_complete_node_values() {
    let temp = Temp::new();
    let mut requests = Vec::new();
    for n in 0..6 {
        let p = temp.0.join(format!("case{n}"));
        fs::create_dir(&p).unwrap();
        for name in ["source", "logs", "empirical"] {
            fs::create_dir(p.join(name)).unwrap();
        }
        requests.push(request(&p));
    }
    let path = |n: usize, p: &str| requests[n].root.join(p);
    let input = json!({"claims":[{"claim_id":"a","claim_text":"Actual observed claim","claim_kind":"claim","verification_plan":{"requiresEvidence":true}},{"key":"b","statement":"Second","status":"candidate","proof_obligations":["obligation:a"]}],"claim_packets":[{"id":"c","text":"Third"}],"proof_obligations":[{"id":"proof:a","obligation":"Exact statement"}],"candidate_evidence":[{"id":"e1","summary":"Bytes","claim_id":"a","available_outputs":["report"],"accepted_result_classes":["observed"],"sha256":"sha256:actual"}],"command_line":" actual\t command ","seeds":{"z":1e20,"a":true,"2":2,"1":1},"checksum":"fixed","reproducibility_plan":[{"description":"Exact run","sourceLocator":"source/run"}],"experiments":[{"experiment_id":"exp:a","result_path":"actual.json","customField":true}],"experiment_manifest":{"id":"exp:b"},"formal_verifier_adapters":[{"status":"untrusted_observed","authorized":false}],"formal_certificate_request":{"status":"not_scientific_acceptance"}});
    fs::write(
        path(1, "source/claim-proof-evidence-result.json"),
        serde_json::to_vec(&input).unwrap(),
    )
    .unwrap();
    fs::write(
        path(1, "logs/referee-review-status.md"),
        b"Local observer only\n",
    )
    .unwrap();
    fs::write(
        path(1, "empirical/dataset-benchmark-table.csv"),
        b"x\n1\n3\n",
    )
    .unwrap();
    fs::create_dir(path(2, "source/.hidden")).unwrap();
    fs::write(
        path(2, "source/.hidden/evidence.json"),
        b"{\"claims\":[{\"id\":\"hidden\"}]}",
    )
    .unwrap();
    fs::create_dir(path(2, "source/node_modules")).unwrap();
    fs::write(path(2, "source/node_modules/evidence.json"), b"{}").unwrap();
    fs::write(
        path(2, "source/proposal-seed-contract-claims.json"),
        b"{\"reproducibility\":[{\"text\":\"run\"}]}",
    )
    .unwrap();
    fs::write(path(2, "source/evidence-malformed.json"), b"not JSON").unwrap();
    fs::write(
        path(2, "source/FORMAL_CLAIM_REVIEW.json"),
        b"{\"claims\":[{\"id\":\"excluded\"}]}",
    )
    .unwrap();
    for n in 0..132 {
        fs::write(path(3, &format!("source/evidence-{n:03}.json")), b"{}").unwrap();
    }
    let mut deep = path(4, "source");
    for n in 0..7 {
        deep = deep.join(format!("nested{n}"));
        fs::create_dir(&deep).unwrap();
        fs::write(
            deep.join("evidence-status.json"),
            format!("{{\"claims\":[{{\"id\":\"depth{n}\",\"text\":\"actual\"}}]}}"),
        )
        .unwrap();
    }
    fs::write(
        path(5, "source/evidence-experiment-spread.json"),
        serde_json::to_vec(&json!({"experiments":[
            "abΣ", "x".repeat(125), ["a","b"], vec![0;125]
        ]}))
        .unwrap(),
    )
    .unwrap();
    let code = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .canonicalize()
        .unwrap();
    let script = r#"import{readResearchEvidenceSources}from'./paper-adapters/research-verify/research-evidence-reader.mjs';let raw='';for await(const c of process.stdin){raw+=c;if(Buffer.byteLength(raw)>65536)throw Error('input');}const inputs=JSON.parse(raw);const values=[];for(const input of inputs)values.push(await readResearchEvidenceSources(input));process.stdout.write(JSON.stringify({profile:{node:process.version,icu:process.versions.icu,cldr:process.versions.cldr},values}));"#;
    let env = EnvironmentPolicyV1::new(
        "actual-evidence-reader-differential",
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
            working_directory: code,
            environment: env,
            stdin: Some(serde_json::to_vec(&requests).unwrap()),
        },
        ProcessLimitsV1 {
            timeout_ms: 60_000,
            termination_grace_ms: 100,
            cleanup_timeout_ms: 2000,
            maximum_stdin_bytes: 65536,
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
    for (n, request) in requests.into_iter().enumerate() {
        let c = AtomicBool::new(false);
        let observed = inspect_native_research_evidence_v1(
            request,
            &c,
            Instant::now() + std::time::Duration::from_secs(60),
        )
        .unwrap();
        assert_eq!(
            *observed.observed(),
            actual["values"][n],
            "original complete source/log/empirical reader case{n}"
        );
        observed.verify_unchanged().unwrap();
    }
    println!(
        "actual_research_evidence_reader_observation={}",
        json!({"nodePid":node.process.process_id,"stdoutBytes":node.process.stdout_bytes,"stdoutSha256":node.process.stdout_hash,"actualCases":6,"scopedFileReceiptValuesCompared":true,"canonicalUniverseAccepted":false,"fullResearchAdapterAccepted":false})
    );
}
#[test]
fn actual_evidence_reader_rechecks_changes_cancel_budget_canonical_domains_and_unsafe_inputs() {
    let r = Temp::new();
    for p in ["source", "logs", "empirical"] {
        fs::create_dir(r.0.join(p)).unwrap();
    }
    let c = AtomicBool::new(false);
    let deadline = || Instant::now() + std::time::Duration::from_secs(60);
    fs::write(r.0.join("source/evidence.json"), b"{}").unwrap();
    let observed = inspect_native_research_evidence_v1(request(&r.0), &c, deadline()).unwrap();
    fs::write(r.0.join("source/evidence.json"), b"{\"changed\":true}").unwrap();
    assert!(observed.verify_unchanged().is_err());
    drop(observed);
    let observed = inspect_native_research_evidence_v1(request(&r.0), &c, deadline()).unwrap();
    fs::write(
        r.0.join("source/RESEARCH_WORKER_PLAN.json"),
        b"{\"workers\":[]}",
    )
    .unwrap();
    assert!(observed.verify_unchanged().is_err());
    drop(observed);
    let canonical = inspect_native_research_evidence_v1(request(&r.0), &c, deadline()).unwrap();
    assert_eq!(
        canonical.observed()["structured"]["canonicalClaimRegistry"]["status"],
        "canonical_claim_registry_blocked"
    );
    canonical.verify_unchanged().unwrap();
    drop(canonical);
    fs::remove_file(r.0.join("source/RESEARCH_WORKER_PLAN.json")).unwrap();
    assert!(
        inspect_native_research_evidence_v1(request(&r.0), &AtomicBool::new(true), deadline())
            .is_err()
    );
    assert!(inspect_native_research_evidence_v1(request(&r.0), &c, Instant::now()).is_err());
    let mut empirical = request(&r.0);
    empirical.paper_task["paperQualityProfile"] = json!("empirical_or_experiment");
    let empirical = inspect_native_research_evidence_v1(empirical, &c, deadline()).unwrap();
    assert_eq!(
        empirical.observed()["structured"]["canonicalEmpiricalClaimRegistry"]["status"],
        "canonical_empirical_claim_registry_blocked"
    );
    assert_eq!(
        empirical.observed()["structured"]["canonicalEmpiricalAssertionUniverse"]["status"],
        "canonical_empirical_assertion_universe_blocked"
    );
    empirical.verify_unchanged().unwrap();
    drop(empirical);
    fs::write(
        r.0.join("source/evidence-overflow.json"),
        vec![b'x'; MAX_BYTES as usize + 1],
    )
    .unwrap();
    assert!(inspect_native_research_evidence_v1(request(&r.0), &c, deadline()).is_err());
    fs::remove_file(r.0.join("source/evidence-overflow.json")).unwrap();
    symlink(
        r.0.join("source/evidence.json"),
        r.0.join("source/evidence-symlink.json"),
    )
    .unwrap();
    let observed = inspect_native_research_evidence_v1(request(&r.0), &c, deadline()).unwrap();
    assert_eq!(
        observed.observed()["sourceEvidence"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    observed.verify_unchanged().unwrap();
    drop(observed);
    fs::remove_file(r.0.join("source/evidence-symlink.json")).unwrap();
    let large = Value::Array((0..9).map(|_| json!("x".repeat(64 * 1024))).collect());
    let duplicated = json!({"experiments":[{"id":large}]});
    values_budget([&duplicated]).unwrap();
    let encoded = serde_json::to_vec(&duplicated).unwrap();
    assert!(encoded.len() < 1024 * 1024);
    fs::write(r.0.join("source/evidence-amplification.json"), encoded).unwrap();
    assert!(inspect_native_research_evidence_v1(request(&r.0), &c, deadline()).is_err());
    fs::remove_file(r.0.join("source/evidence-amplification.json")).unwrap();
    let expanded = json!({"experiments":["x".repeat(64 * 1024)]});
    values_budget([&expanded]).unwrap();
    let encoded = serde_json::to_vec(&expanded).unwrap();
    assert!(encoded.len() < 1024 * 1024);
    assert_eq!(
        experiment_projection(&expanded["experiments"][0], &c)
            .err()
            .unwrap(),
        refused()
    );
    fs::write(r.0.join("source/evidence-spread-overflow.json"), &encoded).unwrap();
    assert_eq!(
        inspect_native_research_evidence_v1(request(&r.0), &c, deadline())
            .err()
            .unwrap(),
        refused()
    );
    let cancelled = AtomicBool::new(true);
    assert_eq!(
        inspect_native_research_evidence_v1(request(&r.0), &cancelled, deadline())
            .err()
            .unwrap(),
        "native_research_evidence_cancelled"
    );
    fs::write(
        r.0.join("source/evidence-spread-overflow.json"),
        b"{\"experiments\":[\"retry\"]}",
    )
    .unwrap();
    let retry = inspect_native_research_evidence_v1(request(&r.0), &c, deadline()).unwrap();
    assert_eq!(retry.observed()["structured"]["experiments"][0]["0"], "r");
    retry.verify_unchanged().unwrap();
    drop(retry);
    fs::remove_file(r.0.join("source/evidence-spread-overflow.json")).unwrap();
    let unsupported_utf16 = json!({"experiments":["🐱"]});
    values_budget([&unsupported_utf16]).unwrap();
    fs::write(
        r.0.join("source/evidence-surrogate-domain.json"),
        serde_json::to_vec(&unsupported_utf16).unwrap(),
    )
    .unwrap();
    assert_eq!(
        inspect_native_research_evidence_v1(request(&r.0), &c, deadline())
            .err()
            .unwrap(),
        refused()
    );
    fs::remove_file(r.0.join("source/evidence-surrogate-domain.json")).unwrap();
    let mut shape = request(&r.0);
    shape.paper_task["paperQualityProfiles"] = json!({"not":"iterable"});
    assert!(inspect_native_research_evidence_v1(shape, &c, deadline()).is_err());
    let mut invalid = serde_json::to_value(request(&r.0)).unwrap();
    invalid["evidenceRecords"] = json!([]);
    assert!(serde_json::from_value::<NativeResearchEvidenceRequestV1>(invalid).is_err());
}

#[test]
fn actual_evidence_formal_composition_matches_original_complete_node_values() {
    let temp = Temp::new();
    let mut inputs = Vec::new();
    for (n, mode) in [
        "valid",
        "include",
        "no-formal-workers",
        "missing-bindings",
        "wrong-hash",
        "duplicate-id",
        "missing-main",
        "missing-main-path",
    ]
    .iter()
    .enumerate()
    {
        let root = temp.0.join(format!("composite{n}"));
        fs::create_dir(&root).unwrap();
        for path in ["source", "logs", "empirical"] {
            fs::create_dir(root.join(path)).unwrap();
        }
        if *mode != "missing-main" {
            fs::write(root.join("source/main.tex"), "\\begin{theorem}Actual first body\\end{theorem}\\begin{proof}Actual proof\\end{proof}\n\\begin{lemma}Actual second body\\end{lemma}\n").unwrap();
        }
        if *mode == "include" {
            fs::write(
                root.join("source/main.tex"),
                "\\input{child}\n\\begin{theorem}Actual first body\\end{theorem}\n",
            )
            .unwrap();
            fs::write(
                root.join("source/child.tex"),
                "\\begin{lemma}Actual child body\\end{lemma}\n",
            )
            .unwrap();
        }
        fs::write(root.join("source/claims-evidence.json"), b"{\"claims\":[{\"id\":\"observed-only\",\"text\":\"Original observed evidence\"}],\"experiments\":[{\"id\":\"actual\",\"result_path\":\"result.json\"}]}").unwrap();
        let mut request = request(&root);
        request.paper_task["mainTex"] = json!("drafts/project/main.tex");
        request.paper_task["sourceWorkspace"] = json!("drafts/project");
        if *mode == "missing-main-path" {
            request.paper_task["mainTex"] = json!("");
        }
        inputs.push(json!({"request":request,"mode":mode}));
    }
    let script = r#"import fs from'node:fs';import path from'node:path';import{readResearchEvidenceSources}from'./paper-adapters/research-verify/research-evidence-reader.mjs';import{readFormalClaimUniverse}from'./paper-adapters/research-verify/formal-claim-universe-reader.mjs';let raw='';for await(const c of process.stdin){raw+=c;if(Buffer.byteLength(raw)>65536)throw Error('input');}const values=[];for(const input of JSON.parse(raw)){const request=input.request;const u=readFormalClaimUniverse({sourceRoot:request.sourceRoot,manuscriptPath:'main.tex'});const bindings=u.theorems.map((t,i)=>({claimId:`claim:${i}`,manuscriptSource:{path:t.manuscriptPath,byteStart:t.manuscriptByteStart,byteEnd:t.manuscriptByteEnd,contentHash:t.manuscriptContentHash},proofObligations:['actual-proof']}));let workers=[{type:'formal_verifier_lake',parameters:{claimBindings:bindings}}];if(input.mode==='no-formal-workers')workers=[{type:'json_assertions',parameters:{}}];if(input.mode==='missing-bindings')bindings.length=0;if(input.mode==='wrong-hash')bindings[0].manuscriptSource.contentHash='sha256:wrong';if(input.mode==='duplicate-id')bindings[1].claimId=bindings[0].claimId;fs.writeFileSync(path.join(request.sourceRoot,'RESEARCH_WORKER_PLAN.json'),JSON.stringify({workers}),{mode:0o600});values.push({request,value:await readResearchEvidenceSources(request)});}process.stdout.write(JSON.stringify({profile:{node:process.version,icu:process.versions.icu,cldr:process.versions.cldr},values}));"#;
    let env = EnvironmentPolicyV1::new(
        "actual-evidence-formal-composition",
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
            working_directory: PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../../..")
                .canonicalize()
                .unwrap(),
            environment: env,
            stdin: Some(serde_json::to_vec(&inputs).unwrap()),
        },
        ProcessLimitsV1 {
            timeout_ms: 60_000,
            termination_grace_ms: 100,
            cleanup_timeout_ms: 2000,
            maximum_stdin_bytes: 65536,
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
    for (n, case) in actual["values"].as_array().unwrap().iter().enumerate() {
        let c = AtomicBool::new(false);
        let observed = inspect_native_research_evidence_v1(
            serde_json::from_value(case["request"].clone()).unwrap(),
            &c,
            Instant::now() + std::time::Duration::from_secs(60),
        )
        .unwrap();
        assert_eq!(
            *observed.observed(),
            case["value"],
            "whole original evidence/formal composition case{n}"
        );
        observed.verify_unchanged().unwrap();
    }
    println!(
        "actual_evidence_formal_composition={}",
        json!({"nodePid":node.process.process_id,"stdoutBytes":node.process.stdout_bytes,"stdoutSha256":node.process.stdout_hash,"actualWholeCases":8,"sharedReadLimitBytes":4*1024*1024,"scientificAuthorityGranted":false,"fullResearchAdapterAccepted":false})
    );
}

#[test]
fn actual_shared_evidence_formal_budget_refuses_total_deduplicates_identity_and_sticks_until_fresh_request()
 {
    use crate::native_research_formal::{
        NativeFormalClaimUniverseRequestV1, inspect_native_formal_claim_universe_v1,
    };
    let request = |root: &Path| {
        let mut request = self::request(root);
        request.paper_task["mainTex"] = json!("main.tex");
        request
    };
    let temp = Temp::new();
    for path in ["source", "logs", "empirical"] {
        fs::create_dir(temp.0.join(path)).unwrap();
    }
    let c = AtomicBool::new(false);
    let deadline = || Instant::now() + std::time::Duration::from_secs(60);
    fs::write(temp.0.join("source/main.tex"), b"\\input{child}\n").unwrap();
    fs::write(
        temp.0.join("source/child.tex"),
        b"\\begin{theorem}Actual body\\end{theorem}\n",
    )
    .unwrap();
    fs::write(
        temp.0.join("source/evidence.json"),
        b"{\"evidence\":[{\"id\":\"actual\"}]}",
    )
    .unwrap();
    fs::write(
        temp.0.join("source/RESEARCH_WORKER_PLAN.json"),
        b"{\"workers\":[]}",
    )
    .unwrap();
    let exact_bytes = fs::read_dir(temp.0.join("source"))
        .unwrap()
        .map(|entry| entry.unwrap().metadata().unwrap().len())
        .sum::<u64>();
    let mut context = NativeResearchReadContextV1::new(&c, deadline());
    let mut held = SourceObservation::new_with_deadline(&temp.0, &c, context.deadline()).unwrap();
    context
        .charge(&mut held, Path::new("source/main.tex"))
        .unwrap();
    let observed =
        inspect_native_research_evidence_with_context_v1(request(&temp.0), &mut context).unwrap();
    assert_eq!(
        context.charged_bytes(),
        exact_bytes,
        "canonical actual ROOT/source member + formal sourceRoot/member and evidence archive/JSON read charged once"
    );
    observed.verify_unchanged().unwrap();
    held.assert_current().unwrap();
    drop(observed);
    drop(held);
    let repeat =
        inspect_native_research_evidence_with_context_v1(request(&temp.0), &mut context).unwrap();
    assert_eq!(context.charged_bytes(), exact_bytes);
    repeat.verify_unchanged().unwrap();
    drop(repeat);
    fs::write(
        temp.0.join("source/main.tex"),
        b"changed identity and bytes",
    )
    .unwrap();
    assert!(
        inspect_native_research_evidence_with_context_v1(request(&temp.0), &mut context).is_err()
    );
    assert!(context.require_active().is_err());
    let retry = inspect_native_research_evidence_v1(request(&temp.0), &c, deadline()).unwrap();
    retry.verify_unchanged().unwrap();
    drop(retry);
    let mut cancelled = NativeResearchReadContextV1::new(&c, deadline());
    c.store(true, Ordering::SeqCst);
    assert!(
        inspect_native_research_evidence_with_context_v1(request(&temp.0), &mut cancelled).is_err()
    );
    c.store(false, Ordering::SeqCst);
    assert!(cancelled.require_active().is_err());
    let mut expired = NativeResearchReadContextV1::new(&c, Instant::now());
    assert!(
        inspect_native_research_evidence_with_context_v1(request(&temp.0), &mut expired).is_err()
    );
    assert!(expired.require_active().is_err());
    inspect_native_research_evidence_v1(request(&temp.0), &c, deadline())
        .unwrap()
        .verify_unchanged()
        .unwrap();
    fs::remove_file(temp.0.join("source/RESEARCH_WORKER_PLAN.json")).unwrap();
    fs::write(
        temp.0.join("source/main.tex"),
        b"\\input{large0}\n\\input{large1}\n\\input{large2}\n",
    )
    .unwrap();
    for n in 0..3 {
        fs::write(
            temp.0.join(format!("source/large{n}.tex")),
            format!("%{}\n", "x".repeat(900 * 1024)),
        )
        .unwrap();
    }
    for n in 0..2 {
        fs::write(
            temp.0.join(format!("logs/evidence{n}.txt")),
            vec![b'x'; 900 * 1024],
        )
        .unwrap();
    }
    let formal_request = NativeFormalClaimUniverseRequestV1 {
        version: 1,
        source_root: temp.0.join("source"),
        manuscript_path: "main.tex".into(),
        maximum_files: 128,
    };
    inspect_native_formal_claim_universe_v1(formal_request, &c, deadline())
        .unwrap()
        .verify_unchanged()
        .unwrap();
    inspect_native_research_evidence_v1(request(&temp.0), &c, deadline())
        .unwrap()
        .verify_unchanged()
        .unwrap();
    fs::write(
        temp.0.join("source/RESEARCH_WORKER_PLAN.json"),
        b"{\"workers\":[]}",
    )
    .unwrap();
    let mut shared = NativeResearchReadContextV1::new(&c, deadline());
    assert_eq!(
        inspect_native_research_evidence_with_context_v1(request(&temp.0), &mut shared)
            .err()
            .unwrap(),
        "native_research_composed_read_budget_v1_refused"
    );
    assert!(shared.require_active().is_err());
    fs::remove_file(temp.0.join("logs/evidence1.txt")).unwrap();
    assert!(
        inspect_native_research_evidence_with_context_v1(request(&temp.0), &mut shared).is_err(),
        "failed aggregate cannot be revived by removing input"
    );
    let retry = inspect_native_research_evidence_v1(request(&temp.0), &c, deadline()).unwrap();
    retry.verify_unchanged().unwrap();
    println!(
        "actual_shared_evidence_formal_budget={}",
        json!({"limitBytes":4*1024*1024,"independentFormalBelowLimit":true,"independentEvidenceBelowLimit":true,"combinedOverLimitRefusedBeforeRead":true,"canonicalDuplicateChargedOnce":true,"changedIdentityRefused":true,"stickyCancellationAndDeadline":true,"freshRetrySucceeded":true,"fullResearchAdapterAccepted":false})
    );
}

#[test]
fn actual_held_empirical_profile_composes_claim_assertion_and_observed_evidence_whole_original_values()
 {
    let temp = Temp::new();
    let modes = [
        "positive",
        "profile-array",
        "missing-main",
        "invalid-claim",
        "include",
        "observed-replaced",
        "no-source-root",
    ];
    let mut inputs = Vec::new();
    for mode in modes {
        let root = temp.0.join(mode);
        fs::create_dir(&root).unwrap();
        for path in ["source", "logs", "empirical"] {
            fs::create_dir(root.join(path)).unwrap();
        }
        let mut r = request(&root);
        r.paper_task["paperQualityProfile"] = json!("empirical_or_experiment");
        r.paper_task["sourceWorkspace"] = json!("source");
        r.paper_task["mainTex"] = json!("source/main.tex");
        if mode == "profile-array" {
            r.paper_task["paperQualityProfile"] = json!("theoretical_or_formal");
            r.paper_task["paperQualityProfiles"] = json!(["empirical_or_experiment"]);
        }
        let declaration = json!({"claimId":"claim:a", "metric":"accuracy", "comparator":"baseline", "alternative":"greater", "minimumEffect":0.01, "acceptanceRequired":true, "proposalClaimRecordHash":null});
        let assertion = json!({"version":1, "assertionId":"assertion:a", "authorityEntryHash":format!("sha256:{}", "a".repeat(64))});
        let claim = format!(
            "% HEPTA_EMPIRICAL_CLAIM_BEGIN {declaration}\nActual preregistered claim.\n% HEPTA_EMPIRICAL_CLAIM_END claim:a\n"
        );
        let body = format!(
            "% HEPTA_EMPIRICAL_ASSERTION_BEGIN {assertion}\nDeclared result surface.\n% HEPTA_EMPIRICAL_ASSERTION_END assertion:a\n"
        );
        let text = if mode == "invalid-claim" {
            format!(
                "% HEPTA_EMPIRICAL_CLAIM_BEGIN {{}}\n% HEPTA_EMPIRICAL_CLAIM_END claim:a\n{body}"
            )
        } else if mode == "include" {
            fs::write(root.join("source/child.tex"), body).unwrap();
            format!("{claim}\\input{{child}}\n")
        } else {
            format!("{claim}{body}")
        };
        if mode != "missing-main" {
            fs::write(root.join("source/main.tex"), text).unwrap();
        }
        if mode == "observed-replaced" {
            fs::write(root.join("source/observed-evidence.json"), br#"{"claims":[{"id":"old","text":"Observed candidate"}],"evidence":[{"id":"data","text":"Input data"}]}"#).unwrap();
        }
        if mode == "no-source-root" {
            r.source_root = None;
        }
        inputs.push(r);
    }
    let script = r#"import{readResearchEvidenceSources}from'./paper-adapters/research-verify/research-evidence-reader.mjs';let raw='';for await(const c of process.stdin){raw+=c;if(Buffer.byteLength(raw)>65536)throw Error('input');}const values=[];for(const input of JSON.parse(raw))values.push(await readResearchEvidenceSources(input));process.stdout.write(JSON.stringify({profile:{node:process.version,icu:process.versions.icu,cldr:process.versions.cldr},values}));"#;
    let env = EnvironmentPolicyV1::new(
        "actual-held-empirical-profile",
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
            maximum_stdin_bytes: 65536,
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
        let c = AtomicBool::new(false);
        let observed = inspect_native_research_evidence_v1(
            r,
            &c,
            Instant::now() + std::time::Duration::from_secs(60),
        )
        .unwrap();
        assert_eq!(
            *observed.observed(),
            actual["values"][index],
            "whole original empirical profile {}",
            modes[index]
        );
        observed.verify_unchanged().unwrap();
    }
    println!(
        "actual_held_empirical_profile={}",
        json!({"actualWholeCases":modes.len(),"nodePid":node.process.process_id,"stdoutBytes":node.process.stdout_bytes,"stdoutSha256":node.process.stdout_hash,"experimentVerificationGranted":false,"fullResearchAdapterAccepted":false})
    );
}
