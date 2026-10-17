use super::*;
use hepta_codex_runtime::{
    BoundedProcessRequestV1, EnvironmentPolicyV1, ProcessLimitsV1, ProcessTerminationReason,
    run_bounded_process_capturing_stdout_with_cancellation,
};
use serde_json::{Value, json};
use std::{fs, os::unix::fs::PermissionsExt, path::PathBuf, sync::atomic::AtomicU64};
static NEXT: AtomicU64 = AtomicU64::new(1);
struct Temp(PathBuf);
impl Temp {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "hepta-plan-data-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::SeqCst)
        ));
        fs::create_dir(&path).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
        Self(path)
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn fixture(
    objects: &ObjectStoreV1,
) -> (NativeResearchPlanRequestV1, Vec<(String, Vec<u8>)>, Value) {
    let files = vec![
        ("data.csv".to_owned(), b"x\n1\n3\n".to_vec()),
        (
            "doc.json".to_owned(),
            br#"{"z":1,"a":2,"yes":true}"#.to_vec(),
        ),
    ];
    let source_objects = files
        .iter()
        .map(|(p, b)| (p.clone(), objects.put(b).unwrap()))
        .collect::<BTreeMap<_, _>>();
    let common = |id: &str, kind: &str, path: &str, parameters: Value| json!({"id":id,"type":kind,"evidenceClass":"research_evidence","syntheticInput":false,"outcomesPreprogrammed":false,"claimIds":["claim:actual"],"inputs":[{"role":"dataset","path":path,"sha256":source_objects[path]}],"parameters":parameters});
    let plan = json!({"version":1,"kind":"NativeResearchWorkerPlan","paperId":"actual-paper","taskKey":"paper:actual","workers":[common("integrity","artifact_integrity","data.csv",json!({})),common("statistics","csv_descriptive_statistics","data.csv",json!({})),common("assertions","json_assertions","doc.json",json!({"assertions":[{"path":"yes","op":"truthy"},{"path":"$","op":"equals","value":{"z":1,"a":2,"yes":true}}]}))]});
    let plan_object = objects.put(&serde_json::to_vec(&plan).unwrap()).unwrap();
    (
        NativeResearchPlanRequestV1 {
            version: 1,
            paper_id: "actual-paper".into(),
            task_key: "paper:actual".into(),
            plan_object,
            source_objects,
        },
        files,
        plan,
    )
}
#[test]
fn actual_plan_forms_jobs_and_matches_original_runtime_worker_values() {
    let temp = Temp::new();
    let objects = ObjectStoreV1::open(&temp.0).unwrap();
    let (request, files, plan) = fixture(&objects);
    let prepared =
        prepare_native_research_data_plan_v1(&objects, request.clone(), &AtomicBool::new(false))
            .unwrap();
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .canonicalize()
        .unwrap();
    let script = r#"import fs from 'node:fs/promises';import path from 'node:path';import {runNativeResearchWorkers} from './paper-adapters/research-verify/worker-runtime.mjs';
let input='';for await(const chunk of process.stdin){input+=chunk;if(Buffer.byteLength(input)>65536)throw new Error('budget');}const c=JSON.parse(input);const root=process.argv[1];const sourceRoot=path.join(root,'source');const runtimeRoot=path.join(root,'runtime');await fs.mkdir(sourceRoot);for(const f of c.files)await fs.writeFile(path.join(sourceRoot,f.path),Buffer.from(f.hex,'hex'),{flag:'wx',mode:384});await fs.writeFile(path.join(sourceRoot,'RESEARCH_WORKER_PLAN.json'),JSON.stringify(c.plan),{flag:'wx',mode:384});const report=await runNativeResearchWorkers({root,sourceRoot,runtimeRoot,paperTask:{paperId:c.plan.paperId,taskKey:c.plan.taskKey},execute:false});process.stdout.write(JSON.stringify({profile:{node:process.version,icu:process.versions.icu,cldr:process.versions.cldr},planHash:report.planHash,rows:report.workerReceipts.map(r=>({id:r.workerId,type:r.workerType,claimIds:r.claimIds,inputs:r.inputs,resultWire:JSON.stringify(r.result),sourceMutationDetected:r.sourceMutationDetected})),status:report.status,fullAdapterAccepted:false}));"#;
    let env = EnvironmentPolicyV1::new(
        "actual-plan-differential",
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
    let input=serde_json::to_vec(&json!({"plan":plan,"files":files.iter().map(|(p,b)|json!({"path":p,"hex":hex::encode(b)})).collect::<Vec<_>>()})).unwrap();
    let node = run_bounded_process_capturing_stdout_with_cancellation(
        &BoundedProcessRequestV1 {
            executable: std::env::var_os("HEPTA_TEST_NODE")
                .map(PathBuf::from)
                .expect("qualified Node producer required"),
            arguments: vec![
                "--input-type=module".into(),
                "--eval".into(),
                script.into(),
                temp.0.as_os_str().to_owned(),
            ],
            working_directory: root,
            environment: env,
            stdin: Some(input),
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
    assert_eq!(node.process.exit_code, Some(0), "{:?}", node);
    assert!(node.process.process_group_cleanup_verified);
    assert_eq!(node.process.stderr_bytes, 0);
    let observed: Value = serde_json::from_slice(&node.stdout).unwrap();
    assert_eq!(
        observed["profile"],
        json!({"node":"v22.23.1","icu":"78.2","cldr":"48.0"})
    );
    assert_eq!(observed["planHash"], request.plan_object.to_string());
    assert_eq!(
        observed["rows"].as_array().unwrap().len(),
        prepared.jobs.len()
    );
    for (job, row) in prepared
        .jobs
        .iter()
        .zip(observed["rows"].as_array().unwrap())
    {
        assert_eq!(row["id"], job.worker_id);
        assert_eq!(row["claimIds"], json!(job.claim_ids));
        assert_eq!(row["sourceMutationDetected"], false);
        let NativeJobV1::Business { job: business } = job.job.clone() else {
            panic!("typed data job");
        };
        let output =
            crate::native_business::execute_native_business_with_objects_for_capability_v1(
                business,
                "CAP-EVD-VERIFY",
                &objects,
                &AtomicBool::new(false),
            )
            .unwrap();
        assert_eq!(
            String::from_utf8(output.artifacts[0].clone()).unwrap(),
            row["resultWire"].as_str().unwrap()
        );
    }
    assert!(!prepared.scientific_acceptance);
    assert!(!prepared.external_effect_authorized);
    println!(
        "actual_plan_data_observation={}",
        json!({"actualNodePid":node.process.process_id,"stdoutBytes":node.process.stdout_bytes,"stdoutSha256":node.process.stdout_hash,"actualPlanHash":prepared.plan_hash,"derivedJobs":prepared.jobs.len(),"originalWorkerValuesMatched":true,"originalRuntimeWholeReceiptMatched":false,"fullResearchAdapterAccepted":false,"normalBatchRouteAccepted":false})
    );
}
#[test]
fn actual_plan_refuses_invalid_bindings_cancel_and_changed_objects_without_writes() {
    let temp = Temp::new();
    let objects = ObjectStoreV1::open(&temp.0).unwrap();
    let (request, _, plan) = fixture(&objects);
    let count = fs::read_dir(objects.root()).unwrap().count();
    assert!(
        prepare_native_research_data_plan_v1(&objects, request.clone(), &AtomicBool::new(true))
            .is_err()
    );
    let mut wrong = request.clone();
    wrong.paper_id = "other".into();
    assert!(
        prepare_native_research_data_plan_v1(&objects, wrong, &AtomicBool::new(false)).is_err()
    );
    let mut wrong = request.clone();
    wrong.source_objects.remove("data.csv");
    assert!(
        prepare_native_research_data_plan_v1(&objects, wrong, &AtomicBool::new(false)).is_err()
    );
    let mut duplicate = plan;
    duplicate["workers"][1]["id"] = duplicate["workers"][0]["id"].clone();
    let mut wrong = request.clone();
    wrong.plan_object = objects
        .put(&serde_json::to_vec(&duplicate).unwrap())
        .unwrap();
    assert!(
        prepare_native_research_data_plan_v1(&objects, wrong, &AtomicBool::new(false)).is_err()
    );
    fs::write(
        objects.root().join(
            request.source_objects["data.csv"]
                .as_str()
                .trim_start_matches("sha256:"),
        ),
        b"corrupt retained",
    )
    .unwrap();
    assert!(
        prepare_native_research_data_plan_v1(&objects, request, &AtomicBool::new(false)).is_err()
    );
    assert_eq!(fs::read_dir(objects.root()).unwrap().count(), count + 1);
}
