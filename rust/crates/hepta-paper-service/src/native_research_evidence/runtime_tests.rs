use super::runtime::*;
use super::tests::Temp;
use super::*;
use hepta_codex_runtime::{
    BoundedProcessRequestV1, EnvironmentPolicyV1, ProcessLimitsV1, ProcessTerminationReason,
    run_bounded_process_capturing_stdout_with_cancellation,
};
use std::{collections::BTreeMap, fs, sync::atomic::AtomicU64, time::Duration};
static NEXT: AtomicU64 = AtomicU64::new(1);
struct RuntimeDir(PathBuf);
impl Drop for RuntimeDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn fixture(root: &Path, mode: &str) -> (NativeResearchEvidenceRuntimeRequestV2, RuntimeDir) {
    assert!(std::env::var_os("HEPTA_PAPER_RUNTIME_ROOT").is_none());
    assert!(std::env::var_os("HEPTA_PAPER_WORKSPACE_ROOT").is_none());
    let id = format!(
        "actual-runtime-{}-{}-{mode}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::SeqCst)
    );
    let runtime = crate::native_workspace::current_native_command_runtime_root_v1().unwrap();
    let expected = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../../hepta-paper-runtime/native-runtime");
    let cwd = std::env::current_dir().unwrap();
    let expected =
        crate::native_workspace::resolve_native_workspace_root_v1(&cwd, &expected, None).unwrap();
    assert_eq!(
        runtime, expected,
        "same actual normal default beside workspace"
    );
    let directory = runtime.join("empirical-analysis").join(&id);
    fs::create_dir_all(root.join("source")).unwrap();
    fs::create_dir_all(root.join("logs/paperctl").join(&id)).unwrap();
    fs::write(
        root.join("source/main.tex"),
        b"Local source, no scientific authority.\n",
    )
    .unwrap();
    if mode != "absent" {
        fs::create_dir_all(&directory).unwrap();
        fs::write(directory.join("experiment-result.json"),br#"{"evidence":[{"id":"actual-data","text":"Actual outside runtime bytes"}],"experiments":[{"experimentId":"local-observation","resultClass":"observed"}],"command":"actual local observation","seed":7}"#).unwrap();
    }
    if mode == "empirical" {
        fs::write(root.join("source/main.tex"), concat!("% HEPTA_EMPIRICAL_CLAIM_BEGIN {\"claimId\":\"claim:a\",\"metric\":\"accuracy\",\"comparator\":\"baseline\",\"alternative\":\"greater\",\"minimumEffect\":0.01,\"acceptanceRequired\":true,\"proposalClaimRecordHash\":null}\nActual claim.\n% HEPTA_EMPIRICAL_CLAIM_END claim:a\n", "% HEPTA_EMPIRICAL_ASSERTION_BEGIN {\"version\":1,\"assertionId\":\"assertion:a\",\"authorityEntryHash\":\"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\"}\nDeclared result surface.\n% HEPTA_EMPIRICAL_ASSERTION_END assertion:a\n")).unwrap();
    }
    let r = NativeResearchEvidenceRuntimeRequestV2 {
        version: 2,
        root: root.into(),
        source_root: Some(root.join("source")),
        paper_task: json!({"paperId":id,"paperQualityProfile":if mode=="empirical" {"empirical_or_experiment"} else {"theoretical_or_formal"},"sourceWorkspace":"source","mainTex":"source/main.tex"}),
    };
    (r, RuntimeDir(directory))
}
#[test]
fn actual_normal_default_sibling_runtime_matches_original_whole_evidence_values() {
    let temp = Temp::new();
    let mut inputs = Vec::new();
    let mut held = Vec::new();
    for mode in ["positive", "empirical", "absent", "with-log"] {
        let root = temp.0.join(mode);
        fs::create_dir(&root).unwrap();
        let (r, dir) = fixture(&root, mode);
        if mode == "with-log" {
            fs::write(
                root.join("logs/paperctl")
                    .join(r.paper_task["paperId"].as_str().unwrap())
                    .join("referee-review-status.md"),
                b"Actual local log\n",
            )
            .unwrap();
        }
        inputs.push(r);
        held.push(dir);
    }
    let script = r#"import path from'node:path';import{defaultPaperRuntimeRoot}from'./paper-adapters/runtime/workspace-layout.mjs';import{readResearchEvidenceSources}from'./paper-adapters/research-verify/research-evidence-reader.mjs';let raw='';for await(const c of process.stdin){raw+=c;if(Buffer.byteLength(raw)>65536)throw Error('input');}const runtimeRoot=defaultPaperRuntimeRoot();const values=[];for(const input of JSON.parse(raw)){const{version,...args}=input;values.push(await readResearchEvidenceSources({...args,logRoot:path.join(input.root,'logs','paperctl',input.paperTask.paperId),empiricalRoot:path.join(runtimeRoot,'empirical-analysis',input.paperTask.paperId)}));}process.stdout.write(JSON.stringify({runtimeRoot,profile:{node:process.version,icu:process.versions.icu,cldr:process.versions.cldr},values}));"#;
    let env = EnvironmentPolicyV1::new(
        "actual-normal-default-runtime",
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
    assert_eq!(
        actual["runtimeRoot"],
        json!(crate::native_workspace::current_native_command_runtime_root_v1().unwrap())
    );
    for (i, input) in inputs.into_iter().enumerate() {
        let c = AtomicBool::new(false);
        let observed = inspect_native_research_evidence_for_current_runtime_v2(
            input,
            &c,
            Instant::now() + Duration::from_secs(60),
        )
        .unwrap();
        assert_eq!(
            *observed.observed(),
            actual["values"][i],
            "whole original normal default runtime case{i}"
        );
        observed.verify_unchanged().unwrap();
    }
    assert!(
        actual["values"][0]["empiricalEvidence"][0]["path"]
            .as_str()
            .unwrap()
            .starts_with("../")
    );
    println!(
        "actual_normal_default_runtime_evidence={}",
        json!({"nodePid":node.process.process_id,"stdoutBytes":node.process.stdout_bytes,"stdoutSha256":node.process.stdout_hash,"actualWholeCases":4,"runtimeRoot":actual["runtimeRoot"],"externalScientificAuthorityGranted":false,"fullResearchAdapterAccepted":false})
    );
}
#[test]
fn actual_runtime_cross_root_budget_named_replacement_absence_cancel_expiry_and_fresh_retry() {
    let temp = Temp::new();
    let (r, dir) = fixture(&temp.0, "positive");
    let c = AtomicBool::new(false);
    let deadline = || Instant::now() + Duration::from_secs(60);
    let wire = serde_json::to_value(r).unwrap();
    let req =
        || serde_json::from_value::<NativeResearchEvidenceRuntimeRequestV2>(wire.clone()).unwrap();
    let observed =
        inspect_native_research_evidence_for_current_runtime_v2(req(), &c, deadline()).unwrap();
    fs::rename(
        dir.0.join("experiment-result.json"),
        dir.0.join("held-result.json"),
    )
    .unwrap();
    fs::write(dir.0.join("experiment-result.json"), b"{}").unwrap();
    assert!(observed.verify_unchanged().is_err());
    drop(observed);
    let observed =
        inspect_native_research_evidence_for_current_runtime_v2(req(), &c, deadline()).unwrap();
    observed.verify_unchanged().unwrap();
    drop(observed);
    assert!(
        inspect_native_research_evidence_for_current_runtime_v2(
            req(),
            &AtomicBool::new(true),
            deadline()
        )
        .is_err()
    );
    assert!(
        inspect_native_research_evidence_for_current_runtime_v2(req(), &c, Instant::now()).is_err()
    );
    fs::remove_file(dir.0.join("held-result.json")).unwrap();
    fs::remove_file(dir.0.join("experiment-result.json")).unwrap();
    let single = 900 * 1024usize;
    assert!(single < 1024 * 1024);
    for n in 0..2 {
        fs::write(
            temp.0.join(format!("source/dataset-result-{n}.csv")),
            vec![b'x'; single],
        )
        .unwrap();
    }
    for n in 0..3 {
        fs::write(
            dir.0.join(format!("dataset-result-{n}.csv")),
            vec![b'x'; single],
        )
        .unwrap();
    }
    let mut context = NativeResearchReadContextV1::new(&c, deadline());
    let error = inspect_with_context(req(), &mut context).err().unwrap();
    assert_eq!(error, "native_research_composed_read_budget_v1_refused");
    assert!(context.charged_bytes() <= 4 * 1024 * 1024);
    fs::remove_file(dir.0.join("dataset-result-2.csv")).unwrap();
    assert!(inspect_with_context(req(), &mut context).is_err());
    drop(context);
    let observed =
        inspect_native_research_evidence_for_current_runtime_v2(req(), &c, deadline()).unwrap();
    observed.verify_unchanged().unwrap();
    drop(observed);
    let mut bad = wire.clone();
    bad["paperTask"]["paperId"] = json!("../other-paper");
    assert!(
        inspect_native_research_evidence_for_current_runtime_v2(
            serde_json::from_value(bad).unwrap(),
            &c,
            deadline()
        )
        .is_err()
    );
    let mut unknown = wire;
    unknown["empiricalRoot"] = json!("/caller-arbitrary");
    assert!(serde_json::from_value::<NativeResearchEvidenceRuntimeRequestV2>(unknown).is_err());
    let absent_root = temp.0.join("absent-root");
    fs::create_dir(&absent_root).unwrap();
    let (absent, absent_dir) = fixture(&absent_root, "absent");
    let absent_wire = serde_json::to_value(absent).unwrap();
    let absent_req = || {
        serde_json::from_value::<NativeResearchEvidenceRuntimeRequestV2>(absent_wire.clone())
            .unwrap()
    };
    let observed =
        inspect_native_research_evidence_for_current_runtime_v2(absent_req(), &c, deadline())
            .unwrap();
    assert_eq!(observed.observed()["empiricalEvidence"], json!([]));
    fs::create_dir(&absent_dir.0).unwrap();
    assert!(observed.verify_unchanged().is_err());
    drop(observed);
    let fresh =
        inspect_native_research_evidence_for_current_runtime_v2(absent_req(), &c, deadline())
            .unwrap();
    fresh.verify_unchanged().unwrap();
}
