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
