//! Real plan-derived data tasks through the existing durable workflow consumer.
use super::*;
use hepta_paper_service::{
    native_research_plan::{NativeResearchPlanRequestV1, prepare_native_research_data_plan_v1},
    native_research_workflow::{
        NativeResearchDataWorkflowBindingV1, initialize_native_research_data_workflow_v1,
    },
    workflow::{WorkflowActionV1, operate_local_workflow_v1},
};
use serde_json::{Value, json};
use std::sync::atomic::AtomicBool;

fn fixture(temp: &Temp) -> (NativeResearchPlanRequestV1, ServiceRunV1) {
    let objects = ObjectStoreV1::open(&temp.0).unwrap();
    let source_objects = BTreeMap::from([
        ("values.csv".into(), objects.put(b"x\n1\n3\n").unwrap()),
        (
            "document.json".into(),
            objects.put(br#"{"actual":true}"#).unwrap(),
        ),
    ]);
    let make = |id: &str, kind: &str, path: &str, parameters: Value| {
        json!({
            "id":id,"type":kind,"evidenceClass":"research_evidence",
            "syntheticInput":false,"outcomesPreprogrammed":false,
            "claimIds":["claim:measured"],"inputs":[{"role":"dataset","path":path,"sha256":source_objects[path]}],"parameters":parameters,
        })
    };
    let plan = json!({"version":1,"kind":"NativeResearchWorkerPlan","paperId":"workflow-paper","taskKey":"paper:workflow","workers":[
        make("integrity","artifact_integrity","values.csv",json!({})),
        make("statistics","csv_descriptive_statistics","values.csv",json!({})),
        make("assertions","json_assertions","document.json",json!({"assertions":[{"path":"actual","op":"truthy"}]})),
    ]});
    let request = NativeResearchPlanRequestV1 {
        version: 1,
        paper_id: "workflow-paper".into(),
        task_key: "paper:workflow".into(),
        plan_object: objects.put(&serde_json::to_vec(&plan).unwrap()).unwrap(),
        source_objects,
    };
    let prepared =
        prepare_native_research_data_plan_v1(&objects, request.clone(), &AtomicBool::new(false))
            .unwrap();
    let NativeJobV1::Business { job } = prepared.jobs[0].job.clone() else {
        panic!("actual derived job");
    };
    let mut template = configuration_for_job(temp, job);
    template.frontier.candidates.clear();
    template.state_directory = temp.0.join("workflow");
    (request, template)
}
fn binding(template: ServiceRunV1) -> NativeResearchDataWorkflowBindingV1 {
    NativeResearchDataWorkflowBindingV1 {
        template,
        research_profile: None,
        module_id: "module.native-business".into(),
        resources: ResourceVectorV1 {
            cpu_millis: 1,
            memory_bytes: 4096,
            ..ResourceVectorV1::default()
        },
        cost_microusd: 1, // Source candidate tariff, not a measured provider charge or OS memory grant.
    }
}
fn attempts_at(path: &std::path::Path) -> BTreeMap<String, Vec<u8>> {
    fs::read_dir(path.join("attempts"))
        .unwrap()
        .map(|e| {
            let e = e.unwrap();
            (
                e.file_name().into_string().unwrap(),
                fs::read(e.path()).unwrap(),
            )
        })
        .collect()
}
#[test]
fn actual_plan_workflow_producer_commits_three_data_reports_and_reopens_once() {
    let temp = Temp::new();
    let (request, template) = fixture(&temp);
    let source = ObjectStoreV1::open(&temp.0).unwrap();
    let state = template.state_directory.clone();
    let hash = initialize_native_research_data_workflow_v1(
        &source,
        request.clone(),
        binding(template),
        &AtomicBool::new(false),
    )
    .unwrap();
    let queued = operate_local_workflow_v1(&state, &hash, WorkflowActionV1::Status, 1000).unwrap();
    let persisted: Value =
        serde_json::from_slice(&fs::read(state.join("workflow.json")).unwrap()).unwrap();
    assert!(persisted.get("providerCallBudget").is_none());
    assert!(queued.provider_call_usage.is_none());
    assert_eq!(queued.committed_steps, 0);
    assert_eq!(queued.budget_remaining_microusd, 100);
    let target = ObjectStoreV1::open(&state).unwrap();
    assert_eq!(
        target.read(&request.plan_object).unwrap(),
        source.read(&request.plan_object).unwrap()
    );
    let done = operate_local_workflow_v1(
        &state,
        &hash,
        WorkflowActionV1::Advance { through_steps: 3 },
        1100,
    )
    .unwrap();
    assert_eq!(done.committed_steps, 3);
    assert_eq!(done.total_steps, 3);
    assert!(done.provider_call_usage.is_none());
    assert_eq!(done.budget_remaining_microusd, 97);
    assert!(!done.scientific_acceptance);
    assert!(!done.production_activation);
    assert!(!done.node_retirement_verified);
    let prepared =
        prepare_native_research_data_plan_v1(&source, request, &AtomicBool::new(false)).unwrap();
    for expected in prepared.jobs {
        let NativeJobV1::Business { job } = expected.job else {
            panic!("derived data job");
        };
        let result=hepta_paper_service::native_business::execute_native_business_with_objects_for_capability_v1(job,"CAP-EVD-VERIFY",&source,&AtomicBool::new(false)).unwrap();
        let artifacts = &done.artifacts_by_step[&format!("research.{}", expected.worker_id)];
        assert_eq!(artifacts.len(), 1);
        assert_eq!(target.read(&artifacts[0]).unwrap(), result.artifacts[0]);
    }
    let before = attempts_at(&state);
    assert_eq!(before.len(), 6);
    let replay = operate_local_workflow_v1(
        &state,
        &hash,
        WorkflowActionV1::Advance { through_steps: 3 },
        1200,
    )
    .unwrap();
    assert_eq!(replay.committed_steps, 3);
    assert_eq!(replay.budget_remaining_microusd, 97);
    assert_eq!(done.artifacts_by_step, replay.artifacts_by_step);
    assert_eq!(before, attempts_at(&state));
    println!(
        "actual_plan_workflow_observation={}",
        json!({"committedDataReports":3,"sourceTariffMicrousd":3,"responseLossRetryAdditionalCommits":0,"fullResearchAdapterAccepted":false,"normalBatchRouteAccepted":false,"actualProviderCostMeasured":false,"scientificAcceptance":false})
    );
}
#[test]
fn actual_plan_workflow_unknown_start_survives_restore_without_reexecution() {
    let temp = Temp::new();
    let (request, template) = fixture(&temp);
    let source = ObjectStoreV1::open(&temp.0).unwrap();
    let state = template.state_directory.clone();
    let hash = initialize_native_research_data_workflow_v1(
        &source,
        request.clone(),
        binding(template),
        &AtomicBool::new(false),
    )
    .unwrap();
    let target = ObjectStoreV1::open(&state).unwrap();
    let digest = &request.source_objects["values.csv"];
    let path = target
        .root()
        .join(digest.as_str().trim_start_matches("sha256:"));
    let original = fs::read(&path).unwrap();
    fs::write(&path, b"unknown retained input").unwrap();
    assert!(
        operate_local_workflow_v1(
            &state,
            &hash,
            WorkflowActionV1::Advance { through_steps: 3 },
            1100
        )
        .is_err()
    );
    let before = attempts_at(&state);
    assert_eq!(before.len(), 1);
    assert!(before.keys().all(|n| n.ends_with(".started")));
    fs::write(&path, original).unwrap();
    assert!(
        operate_local_workflow_v1(
            &state,
            &hash,
            WorkflowActionV1::Advance { through_steps: 3 },
            1200
        )
        .is_err()
    );
    assert_eq!(before, attempts_at(&state));
    let status = operate_local_workflow_v1(&state, &hash, WorkflowActionV1::Status, 1300).unwrap();
    assert_eq!(status.committed_steps, 0);
    assert_eq!(status.budget_remaining_microusd, 100);
    assert!(status.pending_step);
}
#[test]
fn actual_plan_workflow_refuses_cancel_missing_objects_and_authority_before_creation() {
    for variant in [
        "cancel",
        "missing",
        "authority",
        "module",
        "too_many_inputs",
        "long_path",
    ] {
        let temp = Temp::new();
        let (mut request, mut template) = fixture(&temp);
        let state = template.state_directory.clone();
        let source = ObjectStoreV1::open(&temp.0).unwrap();
        if variant == "missing" {
            fs::remove_file(
                source.root().join(
                    request.source_objects["values.csv"]
                        .as_str()
                        .trim_start_matches("sha256:"),
                ),
            )
            .unwrap();
        }
        if variant == "too_many_inputs" {
            let digest = request.source_objects["values.csv"].clone();
            request.source_objects = (0..129)
                .map(|n| (format!("input{n}.csv"), digest.clone()))
                .collect();
        }
        if variant == "long_path" {
            request.source_objects.insert(
                "x".repeat(4097),
                request.source_objects["values.csv"].clone(),
            );
        }
        if variant == "authority" {
            template.hard_policy.external_actions_authorized = true;
        }
        let mut runtime = binding(template);
        if variant == "module" {
            runtime.module_id = "unknown.module".into();
        }
        assert!(
            initialize_native_research_data_workflow_v1(
                &source,
                request,
                runtime,
                &AtomicBool::new(variant == "cancel")
            )
            .is_err()
        );
        assert!(!state.exists());
    }
}

fn actual_node_normal_source_fixture(temp: &Temp, paper_mode: u32) -> (Value, Value, Value) {
    use hepta_codex_runtime::{
        BoundedProcessRequestV1, EnvironmentPolicyV1, ProcessLimitsV1, ProcessTerminationReason,
        run_bounded_process_capturing_stdout_with_cancellation,
    };
    let code = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .canonicalize()
        .unwrap();
    let script = r#"import fs from 'node:fs/promises';import path from 'node:path';import crypto from 'node:crypto';import {createPaperTask} from './paper-domain/contracts/workflow-contracts.mjs';import {runNativeResearchWorkers} from './paper-adapters/research-verify/worker-runtime.mjs';import {defaultPaperRuntimeRoot} from './paper-adapters/runtime/workspace-layout.mjs';import {createFilesystemArtifactRepository} from './paper-adapters/artifacts/filesystem-artifact-repository.mjs';import {createFilesystemReportReceiptLedger} from './paper-adapters/artifacts/filesystem-report-receipt-ledger.mjs';import {createSystemClock} from './paper-adapters/runtime/system-clock.mjs';
const root=process.argv[1];const sourceRoot=path.join(root,'source');await fs.mkdir(sourceRoot);const task=createPaperTask({paperId:`actual-normal-source-${process.pid}`,sourceWorkspace:'source',mainTex:'source/main.tex',paperQualityProfile:'theoretical_or_formal',createdAt:'2026-10-02T00:00:00.000Z'});const files={'values.csv':'x\n1\n3\n','document.json':'{"actual":true}','main.tex':'Actual local manuscript.\n'};for(const [p,b] of Object.entries(files))await fs.writeFile(path.join(sourceRoot,p),b,{flag:'wx',mode:384});const hash=p=>'sha256:'+crypto.createHash('sha256').update(files[p]).digest('hex');const worker=(id,type,p,parameters)=>({id,type,evidenceClass:'research_evidence',syntheticInput:false,outcomesPreprogrammed:false,claimIds:['claim:measured'],inputs:[{role:'dataset',path:p,sha256:hash(p)}],parameters});const plan={version:1,kind:'NativeResearchWorkerPlan',paperId:task.paperId,taskKey:task.taskKey,workers:[worker('integrity','artifact_integrity','values.csv',{}),worker('statistics','csv_descriptive_statistics','values.csv',{}),worker('assertions','json_assertions','document.json',{assertions:[{path:'actual',op:'truthy'}]})]};await fs.writeFile(path.join(sourceRoot,'RESEARCH_WORKER_PLAN.json'),JSON.stringify(plan),{flag:'wx',mode:384});const paperRoot=path.join(defaultPaperRuntimeRoot(),'research-workers',task.paperId);await fs.mkdir(path.dirname(paperRoot),{recursive:true});await fs.mkdir(paperRoot,{mode:Number(process.argv[2])});const report=await runNativeResearchWorkers({root,sourceRoot,runtimeRoot:defaultPaperRuntimeRoot(),paperTask:task,execute:false});const clock=createSystemClock();const ledger=createFilesystemReportReceiptLedger({scopeRoot:paperRoot,receiptRoot:path.join(paperRoot,'old-node-receipts'),clock});const repository=createFilesystemArtifactRepository({scopeRoot:paperRoot,casRoot:path.join(paperRoot,'old-node-cas'),receiptLedger:ledger,clock});const oldArtifact=path.join(paperRoot,'RESEARCH_WORKER_EXECUTION_REPORT.json');const artifactWriteReceipt=await repository.writeJson(oldArtifact,report,{role:'native_research_worker_execution_report'});const oldArtifactBytes=await fs.readFile(oldArtifact);const paperStat=await fs.stat(paperRoot);process.stdout.write(JSON.stringify({paperMode:paperStat.mode&511,paperUid:paperStat.uid,paperInode:paperStat.ino,oldArtifact:{path:oldArtifact,sha256:'sha256:'+crypto.createHash('sha256').update(oldArtifactBytes).digest('hex'),bytes:oldArtifactBytes.length,artifactWriteReceipt},profile:{node:process.version,icu:process.versions.icu,cldr:process.versions.cldr},runtimeRoot:defaultPaperRuntimeRoot(),task,planHash:report.planHash,rows:report.workerReceipts.map(r=>({id:r.workerId,type:r.workerType,claimIds:r.claimIds,inputs:r.inputs,resultWire:JSON.stringify(r.result),sourceMutationDetected:r.sourceMutationDetected})),status:report.status}));"#;
    let environment = EnvironmentPolicyV1::new(
        "actual-normal-source-plan",
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
            arguments: vec![
                "--input-type=module".into(),
                "--eval".into(),
                script.into(),
                temp.0.as_os_str().to_owned(),
                paper_mode.to_string().into(),
            ],
            working_directory: code,
            environment,
            stdin: None,
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
    assert_eq!(node.process.exit_code, Some(0), "{node:?}");
    assert_eq!(node.process.stderr_bytes, 0);
    assert!(node.process.process_group_cleanup_verified);
    let output: Value = serde_json::from_slice(&node.stdout).unwrap();
    assert_eq!(
        output["profile"],
        json!({"node":"v22.23.1","icu":"78.2","cldr":"48.0"})
    );
    (
        output["task"].clone(),
        output.clone(),
        json!({"actualNodePid":node.process.process_id,"stdoutBytes":node.process.stdout_bytes,"stdoutHash":node.process.stdout_hash}),
    )
}
struct ActualNormalRuntimeCleanup(PathBuf);
impl Drop for ActualNormalRuntimeCleanup {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
#[test]
fn actual_normal_task_workspace_plan_commits_three_original_worker_values_and_recovers() {
    use hepta_paper_service::native_research_evidence::{
        NativeResearchObservedInputsRequestV1, inspect_native_research_observed_inputs_v1,
    };
    use hepta_paper_service::native_research_source_plan::{
        NativeResearchSourcePlanRequestV1, initialize_native_research_source_data_workflow_v1,
        open_native_research_source_data_runtime_v1,
        prepare_native_research_data_plan_from_observed_workspace_v1,
    };
    use std::time::{Duration, Instant};
    for (paper_mode, unknown, preexisting_state) in [
        (0o755, false, false),
        (0o775, true, false),
        (0o755, false, true),
    ] {
        let temp = Temp::new();
        let (task, original, receipt) = actual_node_normal_source_fixture(&temp, paper_mode);
        // Prepare the existing real registry before holding the source namespace.
        let (_, mut template) = fixture(&temp);
        template.frontier.candidates.clear();
        use std::os::unix::fs::MetadataExt;
        let runtime_root = PathBuf::from(original["runtimeRoot"].as_str().unwrap());
        let root_before = fs::metadata(&runtime_root).unwrap();
        let paper_root = runtime_root
            .join("research-workers")
            .join(task["paperId"].as_str().unwrap());
        let paper_before = fs::metadata(&paper_root).unwrap();
        assert_eq!(paper_before.mode() & 0o777, paper_mode);
        assert_eq!(
            paper_before.uid() as u64,
            original["paperUid"].as_u64().unwrap()
        );
        assert_eq!(paper_before.ino(), original["paperInode"].as_u64().unwrap());
        let old_path = PathBuf::from(original["oldArtifact"]["path"].as_str().unwrap());
        let old_bytes = fs::read(&old_path).unwrap();
        let old_meta = fs::symlink_metadata(&old_path).unwrap();
        assert!(old_meta.is_file());
        assert_eq!(old_meta.nlink(), 1);
        assert_eq!(old_bytes.len() as u64, original["oldArtifact"]["bytes"]);
        assert_eq!(
            hepta_codex_protocol::Sha256Digest::from_digest_bytes(
                <sha2::Sha256 as sha2::Digest>::digest(&old_bytes).into(),
            )
            .as_str(),
            original["oldArtifact"]["sha256"],
        );
        assert_eq!(
            original["oldArtifact"]["artifactWriteReceipt"]["kind"],
            "ArtifactWriteReceipt"
        );
        assert_eq!(
            original["oldArtifact"]["artifactWriteReceipt"]["externalActionPerformed"],
            false
        );
        assert!(
            !original["oldArtifact"]["artifactWriteReceipt"]["ledgerReceiptId"]
                .as_str()
                .unwrap()
                .is_empty()
        );
        let request_started = Instant::now();
        let cancelled = AtomicBool::new(false);
        let deadline = Instant::now() + Duration::from_secs(30);
        let source_request = NativeResearchSourcePlanRequestV1 {
            version: 1,
            root: temp.0.clone(),
            paper_task: task.clone(),
        };
        let runtime =
            open_native_research_source_data_runtime_v1(&source_request, &cancelled, deadline)
                .unwrap();
        let cleanup =
            ActualNormalRuntimeCleanup(runtime.workflow_directory().parent().unwrap().to_owned());
        assert_eq!(
            runtime.workflow_directory(),
            PathBuf::from(original["runtimeRoot"].as_str().unwrap())
                .join("research-workers")
                .join(task["paperId"].as_str().unwrap())
                .join("native-data-workflow.v1")
        );
        template.state_directory = runtime.workflow_directory().to_owned();
        let objects = runtime.objects();
        assert_eq!(
            fs::metadata(objects.root().parent().unwrap())
                .unwrap()
                .mode()
                & 0o777,
            0o700
        );
        println!(
            "normal_source_phase={}",
            json!({"phase":"default-runtime-open","elapsedMs":request_started.elapsed().as_millis(),"paperMode":paper_mode,"runtimeRootMode":root_before.mode()&0o777})
        );
        let mut observed = inspect_native_research_observed_inputs_v1(
            NativeResearchObservedInputsRequestV1 {
                version: 1,
                root: temp.0.clone(),
                source_root: Some(temp.0.join("source")),
                paper_task: task.clone(),
            },
            &cancelled,
            deadline,
        )
        .unwrap();
        println!(
            "normal_source_phase={}",
            json!({"phase":"held-inputs-observed","elapsedMs":request_started.elapsed().as_millis()})
        );
        let objects_before_drift = fs::read_dir(objects.root()).unwrap().count();
        for field in [
            "title",
            "paperQualityProfile",
            "createdAt",
            "sourceWorkspace",
        ] {
            let mut drifted = task.clone();
            drifted[field] = json!(format!("changed-{field}"));
            assert!(
                prepare_native_research_data_plan_from_observed_workspace_v1(
                    &NativeResearchSourcePlanRequestV1 {
                        version: 1,
                        root: temp.0.clone(),
                        paper_task: drifted,
                    },
                    &mut observed,
                    &runtime,
                )
                .is_err(),
                "same IDs must not substitute another normal task subject: {field}"
            );
            assert_eq!(
                objects_before_drift,
                fs::read_dir(objects.root()).unwrap().count()
            );
            assert!(!runtime.workflow_directory().exists());
        }
        let prepared = prepare_native_research_data_plan_from_observed_workspace_v1(
            &NativeResearchSourcePlanRequestV1 {
                version: 1,
                root: temp.0.clone(),
                paper_task: task.clone(),
            },
            &mut observed,
            &runtime,
        )
        .unwrap();
        println!(
            "normal_source_phase={}",
            json!({"phase":"actual-source-inputs-in-cas","elapsedMs":request_started.elapsed().as_millis()})
        );
        assert_eq!(prepared.request().paper_id, task["paperId"]);
        assert_eq!(prepared.request().task_key, task["taskKey"]);
        assert_eq!(prepared.plan().plan_hash.to_string(), original["planHash"]);
        assert_eq!(prepared.selected_source_members(), 3);
        assert_eq!(prepared.plan().jobs.len(), 3);
        for (derived, original_row) in prepared
            .plan()
            .jobs
            .iter()
            .zip(original["rows"].as_array().unwrap())
        {
            assert_eq!(derived.worker_id, original_row["id"]);
            assert_eq!(json!(derived.claim_ids), original_row["claimIds"]);
            let NativeJobV1::Business { job } = derived.job.clone() else {
                panic!("derived data job")
            };
            let value=hepta_paper_service::native_business::execute_native_business_with_objects_for_capability_v1(job,"CAP-EVD-VERIFY",objects,&cancelled).unwrap();
            assert_eq!(
                String::from_utf8(value.artifacts[0].clone()).unwrap(),
                original_row["resultWire"]
            );
        }
        let cas_count = fs::read_dir(objects.root()).unwrap().count();
        prepare_native_research_data_plan_from_observed_workspace_v1(
            &NativeResearchSourcePlanRequestV1 {
                version: 1,
                root: temp.0.clone(),
                paper_task: task,
            },
            &mut observed,
            &runtime,
        )
        .unwrap();
        assert_eq!(cas_count, fs::read_dir(objects.root()).unwrap().count());
        let state = template.state_directory.clone();
        let mut wrong = template.clone();
        wrong.state_directory = temp.0.join("arbitrary-output");
        assert!(
            initialize_native_research_source_data_workflow_v1(
                &prepared,
                &mut observed,
                &runtime,
                binding(wrong)
            )
            .is_err()
        );
        assert!(!temp.0.join("arbitrary-output").exists());
        if preexisting_state {
            fs::create_dir(&state).unwrap();
            fs::set_permissions(&state, fs::Permissions::from_mode(0o700)).unwrap();
            fs::write(
                state.join("workflow.json"),
                br#"{"version":1,"status":"completed","callerSupplied":true}"#,
            )
            .unwrap();
            let untrusted = fs::read(state.join("workflow.json")).unwrap();
            assert!(
                initialize_native_research_source_data_workflow_v1(
                    &prepared,
                    &mut observed,
                    &runtime,
                    binding(template)
                )
                .is_err()
            );
            assert_eq!(untrusted, fs::read(state.join("workflow.json")).unwrap());
            assert_eq!(fs::read_dir(&state).unwrap().count(), 1);
            assert_eq!(old_bytes, fs::read(&old_path).unwrap());
            observed.verify_unchanged().unwrap();
            drop(observed);
            drop(runtime);
            drop(cleanup);
            continue;
        }
        let hash = initialize_native_research_source_data_workflow_v1(
            &prepared,
            &mut observed,
            &runtime,
            binding(template),
        )
        .unwrap();
        observed.verify_unchanged().unwrap();
        println!(
            "normal_source_phase={}",
            json!({"phase":"original-workflow-initialized","elapsedMs":request_started.elapsed().as_millis()})
        );
        let target = ObjectStoreV1::open(&state).unwrap();
        if unknown {
            let path = target.root().join(
                prepared.request().source_objects["values.csv"]
                    .as_str()
                    .trim_start_matches("sha256:"),
            );
            let before = fs::read(&path).unwrap();
            fs::write(&path, b"actual retained unknown input").unwrap();
            assert!(
                operate_local_workflow_v1(
                    &state,
                    &hash,
                    WorkflowActionV1::Advance { through_steps: 3 },
                    1100
                )
                .is_err()
            );
            let attempts = attempts_at(&state);
            assert_eq!(attempts.len(), 1);
            assert!(attempts.keys().all(|p| p.ends_with(".started")));
            fs::write(path, before).unwrap();
            assert!(
                operate_local_workflow_v1(
                    &state,
                    &hash,
                    WorkflowActionV1::Advance { through_steps: 3 },
                    1200
                )
                .is_err()
            );
            assert_eq!(attempts, attempts_at(&state));
            let status =
                operate_local_workflow_v1(&state, &hash, WorkflowActionV1::Status, 1300).unwrap();
            assert_eq!(status.committed_steps, 0);
            assert!(status.pending_step);
        } else {
            let done = operate_local_workflow_v1(
                &state,
                &hash,
                WorkflowActionV1::Advance { through_steps: 3 },
                1100,
            )
            .unwrap();
            assert_eq!(done.committed_steps, 3);
            assert_eq!(done.budget_remaining_microusd, 97);
            for (derived, original_row) in prepared
                .plan()
                .jobs
                .iter()
                .zip(original["rows"].as_array().unwrap())
            {
                let artifacts = &done.artifacts_by_step[&format!("research.{}", derived.worker_id)];
                assert_eq!(artifacts.len(), 1);
                assert_eq!(
                    String::from_utf8(target.read(&artifacts[0]).unwrap()).unwrap(),
                    original_row["resultWire"]
                );
            }
            let attempts = attempts_at(&state);
            let retry = operate_local_workflow_v1(
                &state,
                &hash,
                WorkflowActionV1::Advance { through_steps: 3 },
                1200,
            )
            .unwrap();
            assert_eq!(retry.artifacts_by_step, done.artifacts_by_step);
            assert_eq!(retry.budget_remaining_microusd, 97);
            assert_eq!(attempts, attempts_at(&state));
        }
        println!(
            "normal_source_phase={}",
            json!({"phase":"original-workflow-commit-and-retry","elapsedMs":request_started.elapsed().as_millis()})
        );
        assert_eq!(old_bytes, fs::read(&old_path).unwrap());
        let old_after = fs::symlink_metadata(&old_path).unwrap();
        assert_eq!(
            (
                old_meta.dev(),
                old_meta.ino(),
                old_meta.mode(),
                old_meta.uid(),
                old_meta.len(),
                old_meta.mtime(),
                old_meta.mtime_nsec(),
                old_meta.ctime(),
                old_meta.ctime_nsec(),
                old_meta.nlink()
            ),
            (
                old_after.dev(),
                old_after.ino(),
                old_after.mode(),
                old_after.uid(),
                old_after.len(),
                old_after.mtime(),
                old_after.mtime_nsec(),
                old_after.ctime(),
                old_after.ctime_nsec(),
                old_after.nlink()
            )
        );
        let root_after = fs::metadata(&runtime_root).unwrap();
        let paper_after = fs::metadata(&paper_root).unwrap();
        assert_eq!(
            (
                root_before.dev(),
                root_before.ino(),
                root_before.mode(),
                root_before.uid()
            ),
            (
                root_after.dev(),
                root_after.ino(),
                root_after.mode(),
                root_after.uid()
            )
        );
        assert_eq!(
            (
                paper_before.dev(),
                paper_before.ino(),
                paper_before.mode(),
                paper_before.uid()
            ),
            (
                paper_after.dev(),
                paper_after.ino(),
                paper_after.mode(),
                paper_after.uid()
            )
        );
        observed.verify_unchanged().unwrap();
        drop(target);
        drop(observed);
        drop(runtime);
        drop(cleanup);
        println!(
            "actual_normal_source_plan_workflow={}",
            json!({"originalObservation":receipt,"unknownStart":unknown,"selectedDistinctSourceMembers":3,"originalWorkerResultValuesMatched":true,"originalRuntimeWholeReceiptMatched":false,"normalBatchRouteAccepted":false,"sixRolesAccepted":false,"actualProviderCostMeasured":false,"sourceTariffMicrousd":if unknown{0}else{3}})
        );
    }
}
