use super::*;
use hepta_codex_runtime::{
    BoundedProcessRequestV1, EnvironmentPolicyV1, ProcessLimitsV1, ProcessTerminationReason,
    run_bounded_process_capturing_stdout_with_cancellation,
};
use std::{collections::BTreeMap, fs, os::unix::fs::PermissionsExt, sync::atomic::AtomicU64};
static NEXT: AtomicU64 = AtomicU64::new(1);
struct Temp(PathBuf);
impl Temp {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "hepta-canonical-formal-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::SeqCst)
        ));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        Self(root)
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn request(root: &Path) -> NativeCanonicalFormalClaimRegistryRequestV1 {
    NativeCanonicalFormalClaimRegistryRequestV1 {
        version: 1,
        source_root: root.into(),
        paper_task: json!({"mainTex":"main.tex"}),
        plan: json!({"workers":[]}),
    }
}
#[test]
fn actual_formal_worker_plan_bindings_match_original_node_complete_registry_values() {
    let temp = Temp::new();
    let mut inputs = Vec::new();
    for (n, mode) in [
        "valid",
        "include",
        "no-workers",
        "missing-bindings",
        "missing-id",
        "duplicate-id",
        "duplicate-theorem",
        "unlisted-path",
        "negative-range",
        "inexact-range",
        "wrong-hash",
        "obligations",
        "other-worker",
        "malformed-source",
        "missing-main",
        "string-range",
    ]
    .iter()
    .enumerate()
    {
        let root = temp.0.join(format!("case{n}"));
        fs::create_dir(&root).unwrap();
        if *mode != "missing-main" {
            fs::write(root.join("main.tex"),"\\begin{theorem}First actual body\\end{theorem}\\begin{proof}Exact proof\\end{proof}\n\\begin{lemma}Second Ω body\\end{lemma}\n").unwrap();
        }
        if *mode == "include" {
            fs::write(root.join("main.tex"),"\\newtheorem{custom}{Custom}\n\\begin{custom}Actual root body\\end{custom}\n\\input{child}\n").unwrap();
            fs::write(root.join("child.tex"),"\\begin{lemma}Actual child body\\end{lemma}\\begin{proof}Child proof\\end{proof}\n").unwrap();
        }
        if *mode == "malformed-source" {
            fs::write(
                root.join("main.tex"),
                "\\newcommand{\\bad}{\\input{hidden}}\n\\begin{theorem}Actual body\\end{theorem}\n",
            )
            .unwrap();
        }
        inputs.push(json!({"sourceRoot":root,"paperTask":{"mainTex":"drafts/project/main.tex","sourceWorkspace":"drafts/project"},"mode":mode}));
    }
    let script = r#"import{canonicalClaimsFromWorkerPlan}from'./paper-adapters/research-verify/canonical-claim-registry-reader.mjs';import{readFormalClaimUniverse}from'./paper-adapters/research-verify/formal-claim-universe-reader.mjs';let raw='';for await(const c of process.stdin){raw+=c;if(Buffer.byteLength(raw)>65536)throw Error('input');}const values=[];for(const input of JSON.parse(raw)){const u=readFormalClaimUniverse({sourceRoot:input.sourceRoot,manuscriptPath:'main.tex'});let bindings=u.theorems.map((t,i)=>({claimId:`claim:${i}`,manuscriptSource:{path:t.manuscriptPath,byteStart:t.manuscriptByteStart,byteEnd:t.manuscriptByteEnd,contentHash:t.manuscriptContentHash},proofObligations:['goal.z','goal.a']}));let workers=[{id:'formal',type:'formal_verifier_lake',parameters:{claimBindings:bindings}}];switch(input.mode){case'no-workers':workers=[];break;case'missing-bindings':bindings.length=0;break;case'missing-id':bindings[0].claimId=' ';break;case'duplicate-id':bindings[1].claimId=bindings[0].claimId;break;case'duplicate-theorem':bindings[1].manuscriptSource={...bindings[0].manuscriptSource};break;case'unlisted-path':bindings[0].manuscriptSource.path='unlisted.tex';break;case'negative-range':bindings[0].manuscriptSource.byteStart=-1;break;case'inexact-range':bindings[0].manuscriptSource.byteEnd=bindings[0].manuscriptSource.byteStart+1;break;case'wrong-hash':bindings[0].manuscriptSource.contentHash='sha256:wrong';break;case'obligations':bindings[0].proofObligations=[true,2,{x:1},['x','y'],'Ω','a'];break;case'other-worker':workers=[{type:'json_assertions',parameters:{}}];break;case'string-range':bindings[0].manuscriptSource.byteStart=String(bindings[0].manuscriptSource.byteStart);break;}const request={version:1,sourceRoot:input.sourceRoot,paperTask:input.paperTask,plan:{workers}};values.push({request,value:canonicalClaimsFromWorkerPlan(request)});}process.stdout.write(JSON.stringify({profile:{node:process.version,icu:process.versions.icu,cldr:process.versions.cldr},values}));"#;
    let env = EnvironmentPolicyV1::new(
        "actual-canonical-formal-differential",
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
        let request = serde_json::from_value(case["request"].clone()).unwrap();
        let c = AtomicBool::new(false);
        let observed = inspect_native_canonical_formal_claim_registry_v1(
            request,
            &c,
            Instant::now() + std::time::Duration::from_secs(60),
        )
        .unwrap();
        assert_eq!(
            *observed.observed(),
            case["value"],
            "complete original canonical formal case{n}"
        );
        observed.verify_unchanged().unwrap();
    }
    println!(
        "actual_canonical_formal_registry_observation={}",
        json!({"nodePid":node.process.process_id,"stdoutBytes":node.process.stdout_bytes,"stdoutSha256":node.process.stdout_hash,"actualWholeCases":16,"scientificAcceptanceGranted":false,"fullResearchAdapterAccepted":false})
    );
}
#[test]
fn actual_formal_binding_member_buffers_refuse_unsafe_projection_cancel_bounds_and_change() {
    let temp = Temp::new();
    fs::write(
        temp.0.join("main.tex"),
        b"\\begin{theorem}Actual body\\end{theorem}",
    )
    .unwrap();
    fs::write(
        temp.0.join("unlisted.tex"),
        b"private member not in include graph",
    )
    .unwrap();
    let c = AtomicBool::new(false);
    let deadline = || Instant::now() + std::time::Duration::from_secs(60);
    let observed =
        inspect_native_canonical_formal_claim_registry_v1(request(&temp.0), &c, deadline())
            .unwrap();
    assert!(
        observed
            .source
            .member_bytes_v1("main.tex")
            .unwrap()
            .is_some()
    );
    assert!(
        observed
            .source
            .member_bytes_v1("unlisted.tex")
            .unwrap()
            .is_none()
    );
    assert!(
        observed
            .source
            .member_bytes_v1("../escape")
            .unwrap()
            .is_none()
    );
    observed.verify_unchanged().unwrap();
    fs::write(temp.0.join("main.tex"), b"changed").unwrap();
    assert!(observed.verify_unchanged().is_err());
    drop(observed);
    assert!(
        inspect_native_canonical_formal_claim_registry_v1(
            request(&temp.0),
            &AtomicBool::new(true),
            deadline()
        )
        .is_err()
    );
    assert!(
        inspect_native_canonical_formal_claim_registry_v1(request(&temp.0), &c, Instant::now())
            .is_err()
    );
    let mut overflow = request(&temp.0);
    overflow.plan = json!({"workers":[{"type":"formal_verifier_lake","parameters":{"claimBindings":vec![json!({});257]}}]});
    assert!(inspect_native_canonical_formal_claim_registry_v1(overflow, &c, deadline()).is_err());
    let mut custom = request(&temp.0);
    custom.paper_task["mainTex"] = json!({"toString":"custom"});
    assert!(inspect_native_canonical_formal_claim_registry_v1(custom, &c, deadline()).is_err());
    let mut projection = serde_json::to_value(request(&temp.0)).unwrap();
    projection["callerUniverseHash"] = json!("trusted");
    assert!(
        serde_json::from_value::<NativeCanonicalFormalClaimRegistryRequestV1>(projection).is_err()
    );
}
