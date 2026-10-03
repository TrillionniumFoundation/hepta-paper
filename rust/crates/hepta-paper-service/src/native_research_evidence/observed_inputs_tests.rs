use super::observed_inputs::*;
use super::tests::Temp;
use super::*;
use hepta_codex_runtime::{
    BoundedProcessRequestV1, EnvironmentPolicyV1, ProcessLimitsV1, ProcessTerminationReason,
    run_bounded_process_capturing_stdout_with_cancellation,
};
use std::{collections::BTreeMap, fs, time::Duration};
const NOW: &str = "2026-10-02T00:00:00.000Z";
const NOW_MILLIS: i64 = 1_790_899_200_000;
struct RuntimeDir(PathBuf);
impl Drop for RuntimeDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn request(root: &Path, id: &str) -> NativeResearchObservedInputsRequestV1 {
    NativeResearchObservedInputsRequestV1 {
        version: 1,
        root: root.into(),
        source_root: Some(root.join("source")),
        paper_task: json!({"paperId":id,"paperQualityProfile":"theoretical_or_formal","sourceWorkspace":"source","mainTex":"source/main.tex"}),
    }
}
fn actual_node(script: &str, inputs: &Value) -> (Value, Value) {
    let env = EnvironmentPolicyV1::new(
        "actual-native-observed-inputs",
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
            stdin: Some(serde_json::to_vec(inputs).unwrap()),
        },
        ProcessLimitsV1 {
            timeout_ms: 60_000,
            termination_grace_ms: 100,
            cleanup_timeout_ms: 2000,
            maximum_stdin_bytes: 1024 * 1024,
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
    let value: Value = serde_json::from_slice(&node.stdout).unwrap();
    assert_eq!(
        value["profile"],
        json!({"node":"v22.23.1","icu":"78.2","cldr":"48.0"})
    );
    (
        value,
        json!({"nodePid":node.process.process_id,"stdoutBytes":node.process.stdout_bytes,"stdoutSha256":node.process.stdout_hash}),
    )
}
#[test]
fn actual_source_runtime_candidates_verifier_match_original_whole_composition_values() {
    assert_eq!(
        crate::sqlite_mutation_coordinator::clock::iso(NOW_MILLIS).unwrap(),
        NOW,
        "same original Node/Rust exact canonical clock"
    );
    let temp = Temp::new();
    let runtime = crate::native_workspace::current_native_command_runtime_root_v1().unwrap();
    let mut inputs = Vec::new();
    let mut held = Vec::new();
    for mode in [
        "positive",
        "empty",
        "json",
        "runtime",
        "empirical",
        "absolute-ready",
    ] {
        let root = temp.0.join(mode);
        fs::create_dir_all(root.join("source")).unwrap();
        let id = format!("actual-native-composition-{}-{mode}", std::process::id());
        let mut r = request(&root, &id);
        // Every case owns an existing task namespace. Another test creating its
        // own task must not mutate a sealed shared-parent absence observation.
        let dir = runtime.join("empirical-analysis").join(&id);
        fs::create_dir_all(&dir).unwrap();
        held.push(RuntimeDir(dir.clone()));
        fs::write(root.join("source/main.tex"), b"Actual local manuscript.\n").unwrap();
        if mode != "empty" {
            fs::write(root.join("source/dataset-result.csv"), b"x,y\n1,2\n").unwrap();
        }
        if mode == "absolute-ready" {
            let bytes = b"x,y\n1,2\n";
            use sha2::Digest;
            fs::write(root.join("source/evidence-manifest.json"),serde_json::to_vec(&json!({"evidence":[{"id":"direct-integrity","path":root.join("source/dataset-result.csv"),"source_locator":root.join("source/dataset-result.csv"),"sha256":format!("sha256:{:x}",sha2::Sha256::digest(bytes)),"claim_ids":["claim:a"],"result_class":"verified"}]})).unwrap()).unwrap();
        }
        if mode == "json" {
            fs::write(root.join("source/claim-evidence-result.json"),br#"{"claims":[{"id":"claim:a","text":"Actual measured candidate"}],"candidate_evidence":[{"id":9007199254740993,"text":"Observed local JSON"}],"experiments":[{"id":"exp:a","resultClass":"observed"}]}"#).unwrap();
        }
        if mode == "runtime" {
            fs::write(dir.join("experiment-result.json"),br#"{"experiments":[{"experimentId":"actual-outside","resultClass":"observed"}],"evidence":[{"id":"outside-local"}]}"#).unwrap();
        }
        if mode == "empirical" {
            r.paper_task["paperQualityProfile"] = json!("empirical_or_experiment");
            fs::write(root.join("source/main.tex"),b"% HEPTA_EMPIRICAL_CLAIM_BEGIN {\"claimId\":\"claim:a\",\"metric\":\"accuracy\",\"comparator\":\"baseline\",\"alternative\":\"greater\",\"minimumEffect\":0.01,\"acceptanceRequired\":true,\"proposalClaimRecordHash\":null}\nActual claim.\n% HEPTA_EMPIRICAL_CLAIM_END claim:a\n").unwrap();
        }
        inputs.push(r);
    }
    let script = r#"import path from'node:path';import{defaultPaperRuntimeRoot}from'./paper-adapters/runtime/workspace-layout.mjs';import{inspectWorkspaceExecutionSnapshot,directoryMerkleHash,sourceTreeExcludedNames}from'./paper-adapters/runtime/execution-snapshot.mjs';import{readResearchEvidenceSources}from'./paper-adapters/research-verify/research-evidence-reader.mjs';import{buildEvidenceVerificationCandidates,buildResearchEvidenceIntake}from'./paper-adapters/research-verify/research-evidence-candidates.mjs';import{verifyEvidenceBatch}from'./paper-adapters/research-verify/evidence-verifier.mjs';let raw='';for await(const c of process.stdin){raw+=c;if(Buffer.byteLength(raw)>1048576)throw Error('input');}const values=[];for(const{version,...input}of JSON.parse(raw)){const excludeNames=sourceTreeExcludedNames(input.sourceRoot);const sourceSnapshot={workspaceSnapshot:inspectWorkspaceExecutionSnapshot(input.sourceRoot,{excludeNames}),sourceMerkle:directoryMerkleHash(input.sourceRoot,{excludeNames})};const evidence=await readResearchEvidenceSources({...input,logRoot:path.join(input.root,'logs/paperctl',input.paperTask.paperId),empiricalRoot:path.join(defaultPaperRuntimeRoot(),'empirical-analysis',input.paperTask.paperId)});const verificationCandidates=buildEvidenceVerificationCandidates({root:input.root,sourceRoot:input.sourceRoot,structured:evidence.structured});const evidenceVerificationReceipts=await verifyEvidenceBatch({sourceRoot:input.sourceRoot,evidenceItems:verificationCandidates,clock:{nowIso:()=> '2026-10-02T00:00:00.000Z'}});const evidenceIntake=buildResearchEvidenceIntake({paperTask:input.paperTask,structured:evidence.structured,academicEvidenceAttestation:{academicEvidenceEligible:false},evidenceVerificationReceipts,now:new Date("2026-10-02T00:00:00.000Z")});values.push({sourceSnapshot,evidence,verificationCandidates,evidenceVerificationReceipts,evidenceIntake});}process.stdout.write(JSON.stringify({profile:{node:process.version,icu:process.versions.icu,cldr:process.versions.cldr},values}));"#;
    let (actual, receipt) = actual_node(script, &json!(inputs));
    for (i, r) in inputs.iter().enumerate() {
        let c = AtomicBool::new(false);
        let mut ctx =
            NativeResearchReadContextV1::new(&c, Instant::now() + Duration::from_secs(60));
        let observed =
            inspect_with_context(r, &mut ctx, NOW_MILLIS, &mut || Ok(NOW.into())).unwrap();
        assert_eq!(
            *observed.observed(),
            actual["values"][i],
            "whole original observed pipeline case{i}"
        );
        observed.verify_unchanged().unwrap();
        assert_eq!(
            ctx.charged_bytes(),
            observed.observed()["sourceSnapshot"]["workspaceSnapshot"]["fileRecords"]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v["bytes"].as_u64().unwrap())
                .sum::<u64>()
                + if i == 3 {
                    fs::metadata(held[3].0.join("experiment-result.json"))
                        .unwrap()
                        .len()
                } else {
                    0
                }
        );
    }
    assert_eq!(
        actual["values"][0]["evidenceVerificationReceipts"][0]["status"],
        "evidence_artifact_verified"
    );
    assert!(
        actual["values"][5]["evidenceIntake"]["items"]
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v["evidenceId"] == "direct-integrity"
                && v["consumptionPolicy"]["status"] == "evidence_consumption_ready"),
        "actual positive local artifact consumption without scientific authority"
    );
    println!(
        "actual_native_observed_inputs={}",
        json!({"process":receipt,"actualWholeCases":inputs.len(),"normalRoleChainAccepted":false,"scientificAuthorityGranted":false})
    );
}
#[test]
fn actual_source_runtime_pipeline_shares_budget_deduplicates_and_refuses_until_fresh_request() {
    let temp = Temp::new();
    fs::create_dir_all(temp.0.join("source")).unwrap();
    let id = format!("actual-pipeline-budget-{}", std::process::id());
    let r = request(&temp.0, &id);
    let runtime = crate::native_workspace::current_native_command_runtime_root_v1()
        .unwrap()
        .join("empirical-analysis")
        .join(&id);
    fs::create_dir_all(&runtime).unwrap();
    let dir = RuntimeDir(runtime);
    let single = 900 * 1024usize;
    for n in 0..3 {
        fs::write(
            temp.0.join(format!("source/dataset-result-{n}.csv")),
            vec![b'x'; single],
        )
        .unwrap();
    }
    for n in 0..2 {
        fs::write(
            dir.0.join(format!("dataset-result-{n}.csv")),
            vec![b'x'; single],
        )
        .unwrap();
    }
    let c = AtomicBool::new(false);
    let deadline = || Instant::now() + Duration::from_secs(60);
    let mut ctx = NativeResearchReadContextV1::new(&c, deadline());
    let error = inspect_with_context(&r, &mut ctx, NOW_MILLIS, &mut || Ok(NOW.into()))
        .err()
        .unwrap();
    assert_eq!(error, "native_research_composed_read_budget_v1_refused");
    assert!(ctx.charged_bytes() <= 4 * 1024 * 1024);
    fs::remove_file(dir.0.join("dataset-result-1.csv")).unwrap();
    assert!(inspect_with_context(&r, &mut ctx, NOW_MILLIS, &mut || Ok(NOW.into())).is_err());
    drop(ctx);
    let mut fresh = NativeResearchReadContextV1::new(&c, deadline());
    let observed =
        inspect_with_context(&r, &mut fresh, NOW_MILLIS, &mut || Ok(NOW.into())).unwrap();
    assert_eq!(
        fresh.charged_bytes(),
        4 * single as u64,
        "source snapshot/evidence/verifier repeat actual files charge once"
    );
    observed.verify_unchanged().unwrap();
    drop(observed);
    fs::write(temp.0.join("source/dataset-result-0.csv"), b"changed").unwrap();
    let observed = inspect_with_context(
        &r,
        &mut NativeResearchReadContextV1::new(&c, deadline()),
        NOW_MILLIS,
        &mut || Ok(NOW.into()),
    )
    .unwrap();
    fs::rename(
        temp.0.join("source/dataset-result-0.csv"),
        temp.0.join("source/held.csv"),
    )
    .unwrap();
    fs::write(temp.0.join("source/dataset-result-0.csv"), b"replacement").unwrap();
    assert!(observed.verify_unchanged().is_err());
    drop(observed);
    assert!(
        inspect_native_research_observed_inputs_v1(
            request(&temp.0, &id),
            &AtomicBool::new(true),
            deadline()
        )
        .is_err()
    );
    assert!(
        inspect_native_research_observed_inputs_v1(request(&temp.0, &id), &c, Instant::now())
            .is_err()
    );
    inspect_native_research_observed_inputs_v1(request(&temp.0, &id), &c, deadline())
        .unwrap()
        .verify_unchanged()
        .unwrap();
}
#[test]
fn actual_candidate_data_matches_original_path_filter_number_and_omission_values() {
    let root = Path::new("/actual-native-root");
    let source = root.join("source");
    let mut inputs = Vec::new();
    for path in [
        json!("source/evidence.csv"),
        json!("source/../source/evidence.csv"),
        json!("/actual-native-root/source/./evidence.csv"),
        json!("elsewhere/evidence.csv"),
        json!("source/missing.csv"),
        Value::Null,
        json!(false),
        json!(["source/evidence.csv"]),
    ] {
        for (id, kind, hash) in [
            (
                json!(9007199254740993_u64),
                json!({"nested":[9007199254740993_u64]}),
                json!("sha256:actual"),
            ),
            (json!(false), json!(false), json!(true)),
            (Value::Null, Value::Null, Value::Null),
        ] {
            inputs.push(json!({"evidenceItems":[{"id":id,"kind":kind,"sourceLocator":path,"evidenceRefs":[{"ref":"source/fallback.csv","hash":hash}]}]}));
        }
    }
    inputs.push(json!({"evidenceItems":[{"sourceLocator":"source/evidence.csv","evidenceRefs":[{"hash":"sha256:actual"}]}]}));
    let script = r#"import{buildEvidenceVerificationCandidates}from'./paper-adapters/research-verify/research-evidence-candidates.mjs';let raw='';for await(const c of process.stdin){raw+=c;if(Buffer.byteLength(raw)>1048576)throw Error('input');}const values=JSON.parse(raw).map(structured=>buildEvidenceVerificationCandidates({root:'/actual-native-root',sourceRoot:'/actual-native-root/source',structured}));process.stdout.write(JSON.stringify({profile:{node:process.version,icu:process.versions.icu,cldr:process.versions.cldr},values}));"#;
    let (actual, receipt) = actual_node(script, &json!(inputs));
    for (i, input) in inputs.iter().enumerate() {
        assert_eq!(
            json!(
                build_native_evidence_verification_candidates_v1(
                    root,
                    Some(&source),
                    input,
                    &AtomicBool::new(false),
                    Instant::now() + Duration::from_secs(30)
                )
                .unwrap()
            ),
            actual["values"][i],
            "whole candidatescase{i}"
        );
    }
    println!(
        "actual_native_evidence_candidates={}",
        json!({"process":receipt,"actualWholeCases":inputs.len(),"candidateFieldsAreAuthority":false})
    );
}
#[test]
fn actual_intake_requires_held_receipts_and_rejects_derived_coercion_overflow_cancel_expiry_with_fresh_retry()
 {
    let temp = Temp::new();
    let file = temp.0.join("artifact.csv");
    let bytes = b"actual locally measured bytes\n";
    fs::write(&file, bytes).unwrap();
    use sha2::Digest;
    let actual_hash = format!("sha256:{:x}", sha2::Sha256::digest(bytes));
    let c = AtomicBool::new(false);
    let deadline = || Instant::now() + Duration::from_secs(60);
    let mut context = NativeResearchReadContextV1::new(&c, deadline());
    let verified = super::verification::verify_with_context(
        &NativeEvidenceArtifactVerificationRequestV1 {
            version: 1,
            source_root: Some(temp.0.clone()),
            evidence_items: vec![
                json!({"id":"direct","path":file,"hash":actual_hash,"provenance":"observed"}),
            ],
            expected_source_snapshot_hash: None,
        },
        &mut context,
        &mut || Ok(NOW.into()),
    )
    .unwrap();
    let task = json!({"paperId":"actual"});
    let mut structured = json!({"evidenceItems":[{"id":"direct","sourceLocator":file,"evidenceRefs":[{"ref":file,"hash":actual_hash}],"claimIds":["claim:a"],"resultClass":"verified"}]});
    let actual = build_native_research_evidence_intake_v1(
        &task,
        &structured,
        &verified,
        NOW_MILLIS,
        &c,
        deadline(),
    )
    .unwrap();
    assert_eq!(actual["status"], "evidence_intake_ready");
    assert_eq!(verified.receipts()[0]["authorityReceiptHash"], Value::Null);
    assert!(
        build_native_research_evidence_intake_v1(
            &task,
            &structured,
            &verified,
            NOW_MILLIS,
            &AtomicBool::new(true),
            deadline()
        )
        .is_err()
    );
    assert!(
        build_native_research_evidence_intake_v1(
            &task,
            &structured,
            &verified,
            NOW_MILLIS,
            &c,
            Instant::now()
        )
        .is_err()
    );
    let original = structured.clone();
    structured["evidenceItems"][0]["claimIds"] = json!([["a".repeat(40000), "b".repeat(40000)]]);
    assert!(
        values_budget([&structured]).is_ok(),
        "actual legal two40k string input but coerced scalar would exceed64k"
    );
    assert!(
        build_native_research_evidence_intake_v1(
            &task,
            &structured,
            &verified,
            NOW_MILLIS,
            &c,
            deadline()
        )
        .is_err()
    );
    structured = original.clone();
    structured["evidenceItems"][0]["id"] = json!("a".repeat(65530));
    assert!(values_budget([&structured]).is_ok());
    assert!(
        build_native_research_evidence_intake_v1(
            &task,
            &structured,
            &verified,
            NOW_MILLIS,
            &c,
            deadline()
        )
        .is_err(),
        "id plus blocker prefix refuses before derived string allocation"
    );
    build_native_research_evidence_intake_v1(
        &task,
        &original,
        &verified,
        NOW_MILLIS,
        &c,
        deadline(),
    )
    .unwrap();
    fs::write(&file, b"changed actual bytes").unwrap();
    assert!(
        build_native_research_evidence_intake_v1(
            &task,
            &original,
            &verified,
            NOW_MILLIS,
            &c,
            deadline()
        )
        .is_err()
    );
}
