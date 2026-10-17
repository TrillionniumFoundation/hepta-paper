//! Real inventory/source producer → existing durable service consumer.
use super::*;
use hepta_paper_service::{
    native_inventory::{NativeInventoryRequestV1, discover_native_inventory_v1},
    native_research_assessment::{
        initialize_native_research_cas_assessment_workflow_v1,
        operate_native_research_cas_assessment_workflow_v1,
        prepare_native_research_cas_assessment_for_inventory_row_v1,
    },
    native_research_source_plan::{
        NativeResearchSourcePlanRequestV1, open_native_research_source_data_runtime_v1,
    },
    native_research_workflow::NativeResearchDataWorkflowBindingV1,
    workflow::{WorkflowActionV1, operate_local_workflow_v1},
};
use serde_json::{Value, json};
use std::{
    path::Path,
    sync::{Arc, atomic::AtomicBool},
    time::{Duration, Instant},
};
fn inputs(root: &Path) -> NativeInventoryRequestV1 {
    fs::create_dir(root.join("registry")).unwrap();
    fs::create_dir(root.join("source")).unwrap();
    let id = root.file_name().unwrap().to_str().unwrap();
    fs::write(root.join("registry/papers.yaml"),format!("papers:\n  - slug: {id}\n    title: Actual service research assessment\n    status: draft\n    canonical_dir: source\n")).unwrap();
    fs::write(root.join("source/main.tex"), "Observed actual manuscript\n").unwrap();
    let raw = b"actual artifact consumed by persistent source worker\n";
    fs::write(root.join("source/raw.dat"), raw).unwrap();
    use sha2::Digest;
    let hash =
        hepta_codex_protocol::Sha256Digest::from_digest_bytes(sha2::Sha256::digest(raw).into());
    let data = json!({"claims":[{"id":"claim:actual","text":"Actual local evidence claim","verificationPlan":{"kind":"evidence","requiresEvidence":true}}],"evidence":[{"id":"actual-evidence","path":root.join("source/raw.dat"),"source_locator":root.join("source/raw.dat"),"sha256":hash,"claim_ids":["claim:actual"],"result_class":"verified"}]});
    fs::write(
        root.join("source/claims.json"),
        serde_json::to_vec(&data).unwrap(),
    )
    .unwrap();
    NativeInventoryRequestV1 {
        version: 1,
        root: root.into(),
        database: None,
        inventory_source: "yaml".into(),
        include_loose_drafts: false,
        include_retired: false,
        include_quarantined: false,
        include_proposal_staging: false,
        proposal_staging_root: None,
        paper_ids: Vec::new(),
        limit: None,
        observed_at: Some("2026-10-02T00:00:00.000Z".into()),
    }
}
struct RuntimeCleanup(PathBuf);
impl Drop for RuntimeCleanup {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn binding(mut template: ServiceRunV1, state: PathBuf) -> NativeResearchDataWorkflowBindingV1 {
    template.frontier.candidates.clear();
    template.state_directory = state;
    NativeResearchDataWorkflowBindingV1 {
        template,
        research_profile: None,
        module_id: "module.native-business".into(),
        resources: ResourceVectorV1 {
            cpu_millis: 1,
            memory_bytes: 4096,
            ..ResourceVectorV1::default()
        },
        cost_microusd: 1,
    }
}
fn attempts(state: &Path) -> BTreeMap<String, Vec<u8>> {
    fs::read_dir(state.join("attempts"))
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
fn actual_inventory_cas_assessment_service_commits_settles_once_and_replays_original_result() {
    let source = Temp::new();
    let config_root = Temp::new();
    let request = inputs(&source.0);
    let c = Arc::new(AtomicBool::new(false));
    let deadline = Instant::now() + Duration::from_secs(30);
    let initial = discover_native_inventory_v1(&request, &c, deadline).unwrap();
    let task = initial.scan()["rows"][0]["task"].clone();
    drop(initial);
    let runtime = open_native_research_source_data_runtime_v1(
        &NativeResearchSourcePlanRequestV1 {
            version: 1,
            root: source.0.clone(),
            paper_task: task.clone(),
        },
        &c,
        deadline,
    )
    .unwrap();
    let _cleanup = RuntimeCleanup(runtime.workflow_directory().parent().unwrap().to_owned());
    let inventory = discover_native_inventory_v1(&request, &c, deadline).unwrap();
    let prepared = prepare_native_research_cas_assessment_for_inventory_row_v1(
        &inventory,
        task["paperId"].as_str().unwrap(),
        &runtime,
        &c,
        deadline,
    )
    .unwrap();
    let NativeJobV1::Business { job } = prepared.job() else {
        panic!("actual source job");
    };
    let template = configuration_for_job(&config_root, job);
    let state = runtime
        .workflow_directory()
        .with_file_name("native-assessment-workflow.v1");
    let definition = initialize_native_research_cas_assessment_workflow_v1(
        &prepared,
        &runtime,
        binding(template, state.clone()),
    )
    .unwrap();
    assert!(
        initialize_native_research_cas_assessment_workflow_v1(
            &prepared,
            &runtime,
            binding(
                configuration_for_job(
                    &config_root,
                    match prepared.job() {
                        NativeJobV1::Business { job } => job,
                        _ => unreachable!(),
                    }
                ),
                state.clone()
            )
        )
        .is_err(),
        "unknown prior runtime never silently adopted"
    );
    let persisted: Value =
        serde_json::from_slice(&fs::read(state.join("workflow.json")).unwrap()).unwrap();
    assert!(persisted.get("providerCallBudget").is_none());
    assert_eq!(
        persisted["steps"][0]["jobTemplate"]["job"]["request"]["manifestObject"],
        json!(prepared.request().manifest_object)
    );
    let done = operate_native_research_cas_assessment_workflow_v1(
        &prepared,
        &runtime,
        &definition,
        WorkflowActionV1::Advance { through_steps: 1 },
        &mut || Ok(1100),
        Arc::clone(&c),
    )
    .unwrap();
    assert_eq!(done.committed_steps, 1);
    assert_eq!(done.budget_remaining_microusd, 99);
    assert!(done.provider_call_usage.is_none());
    assert!(!done.scientific_acceptance);
    assert!(!done.production_activation);
    assert!(!done.node_retirement_verified);
    let target = ObjectStoreV1::open(&state).unwrap();
    let artifacts = &done.artifacts_by_step["research.source-assessment"];
    assert_eq!(artifacts.len(), 1);
    let raw = target.read(&artifacts[0]).unwrap();
    let report: Value = serde_json::from_slice(&raw).unwrap();
    assert_eq!(
        report["sourceManifestObject"],
        json!(prepared.request().manifest_object)
    );
    assert_eq!(
        report["evidenceQualityGate"]["status"],
        "evidence_quality_ready"
    );
    assert_eq!(report["academicAuthorityGranted"], false);
    assert_eq!(report["currentFilesystemVerified"], false);
    let before = attempts(&state);
    assert_eq!(before.len(), 2);
    drop(prepared);
    drop(inventory);
    drop(runtime);
    // A fresh original workflow consumer has no source deadline and performs no
    // new native execution. It replays exactly the persisted committed result.
    let replay = operate_local_workflow_v1(
        &state,
        &definition,
        WorkflowActionV1::Advance { through_steps: 1 },
        1200,
    )
    .unwrap();
    assert_eq!(replay.committed_steps, 1);
    assert_eq!(replay.budget_remaining_microusd, 99);
    assert_eq!(replay.artifacts_by_step, done.artifacts_by_step);
    assert_eq!(attempts(&state), before);
    assert_eq!(target.read(&artifacts[0]).unwrap(), raw);
    eprintln!(
        "actual_cas_assessment_persisted={}",
        json!({"manifest":report["sourceManifestObject"],"committedSourceAssessments":1,"sourceTariffMicrousd":1,"freshResponseLossAdditionalCommits":0,"artifactsAndAttemptBytesUnchanged":true,"normalBatchSixRolesAccepted":false,"actualProviderCostMeasured":false,"academicAuthorityGranted":false})
    );
}
#[test]
fn actual_cas_assessment_inherits_same_controls_and_unknown_start_never_reexecutes() {
    let source = Temp::new();
    let config_root = Temp::new();
    let request = inputs(&source.0);
    let c = Arc::new(AtomicBool::new(false));
    let deadline = Instant::now() + Duration::from_secs(30);
    let initial = discover_native_inventory_v1(&request, &c, deadline).unwrap();
    let task = initial.scan()["rows"][0]["task"].clone();
    drop(initial);
    let runtime = open_native_research_source_data_runtime_v1(
        &NativeResearchSourcePlanRequestV1 {
            version: 1,
            root: source.0.clone(),
            paper_task: task.clone(),
        },
        &c,
        deadline,
    )
    .unwrap();
    let _cleanup = RuntimeCleanup(runtime.workflow_directory().parent().unwrap().to_owned());
    let inventory = discover_native_inventory_v1(&request, &c, deadline).unwrap();
    let prepared = prepare_native_research_cas_assessment_for_inventory_row_v1(
        &inventory,
        task["paperId"].as_str().unwrap(),
        &runtime,
        &c,
        deadline,
    )
    .unwrap();
    let NativeJobV1::Business { job } = prepared.job() else {
        panic!("actual source job");
    };
    let state = runtime
        .workflow_directory()
        .with_file_name("native-assessment-workflow.v1");
    let definition = initialize_native_research_cas_assessment_workflow_v1(
        &prepared,
        &runtime,
        binding(configuration_for_job(&config_root, job), state.clone()),
    )
    .unwrap();
    let wrong = Arc::new(AtomicBool::new(false));
    assert!(
        operate_native_research_cas_assessment_workflow_v1(
            &prepared,
            &runtime,
            &definition,
            WorkflowActionV1::Advance { through_steps: 1 },
            &mut || Ok(1100),
            wrong
        )
        .is_err()
    );
    assert!(attempts(&state).is_empty());
    // The unscoped old consumer has no inherited deadline and refuses the new
    // capability before it can execute. Its dispatch intent remains unknown.
    assert!(
        operate_local_workflow_v1(
            &state,
            &definition,
            WorkflowActionV1::Advance { through_steps: 1 },
            1100
        )
        .is_err()
    );
    let before = attempts(&state);
    assert_eq!(before.len(), 1);
    assert!(before.keys().all(|name| name.ends_with(".started")));
    assert!(
        operate_native_research_cas_assessment_workflow_v1(
            &prepared,
            &runtime,
            &definition,
            WorkflowActionV1::Advance { through_steps: 1 },
            &mut || Ok(1200),
            Arc::clone(&c)
        )
        .is_err()
    );
    assert_eq!(attempts(&state), before);
    let status =
        operate_local_workflow_v1(&state, &definition, WorkflowActionV1::Status, 1300).unwrap();
    assert_eq!(status.committed_steps, 0);
    assert_eq!(status.budget_remaining_microusd, 100);
    c.store(true, Ordering::SeqCst);
    assert!(prepared.verify_unchanged().is_err());
    assert_eq!(attempts(&state), before);
    eprintln!(
        "actual_cas_assessment_unknown_start={}",
        json!({"wrongAtomicOwnerRefusedBeforeDispatch":true,"missingInheritedDeadlineRefused":true,"unknownStartAttemptBytesRetained":true,"freshScopedConsumerDidNotReexecute":true,"commits":0,"sourceTariffSettled":0})
    );
}

#[test]
fn actual_cas_assessment_source_drift_at_prepared_commit_clock_refuses_then_fresh_subject_retries()
{
    let source = Temp::new();
    let config_root = Temp::new();
    let request = inputs(&source.0);
    let c = Arc::new(AtomicBool::new(false));
    let deadline = Instant::now() + Duration::from_secs(30);
    let initial = discover_native_inventory_v1(&request, &c, deadline).unwrap();
    let task = initial.scan()["rows"][0]["task"].clone();
    drop(initial);
    let runtime = open_native_research_source_data_runtime_v1(
        &NativeResearchSourcePlanRequestV1 {
            version: 1,
            root: source.0.clone(),
            paper_task: task.clone(),
        },
        &c,
        deadline,
    )
    .unwrap();
    let _cleanup = RuntimeCleanup(runtime.workflow_directory().parent().unwrap().to_owned());
    let inventory = discover_native_inventory_v1(&request, &c, deadline).unwrap();
    let prepared = prepare_native_research_cas_assessment_for_inventory_row_v1(
        &inventory,
        task["paperId"].as_str().unwrap(),
        &runtime,
        &c,
        deadline,
    )
    .unwrap();
    let NativeJobV1::Business { job } = prepared.job() else {
        panic!("actual source job");
    };
    let state = runtime
        .workflow_directory()
        .with_file_name("native-assessment-workflow.v1");
    let definition = initialize_native_research_cas_assessment_workflow_v1(
        &prepared,
        &runtime,
        binding(configuration_for_job(&config_root, job), state.clone()),
    )
    .unwrap();
    let mut changed_after_prepared = false;
    let mut observe = || {
        if !changed_after_prepared
            && attempts(&state)
                .keys()
                .any(|name| name.ends_with(".prepared"))
        {
            fs::write(
                source.0.join("source/raw.dat"),
                b"changed before SQL commit\n",
            )
            .unwrap();
            changed_after_prepared = true;
        }
        Ok(1100)
    };
    assert!(
        operate_native_research_cas_assessment_workflow_v1(
            &prepared,
            &runtime,
            &definition,
            WorkflowActionV1::Advance { through_steps: 1 },
            &mut observe,
            Arc::clone(&c)
        )
        .is_err()
    );
    assert!(
        changed_after_prepared,
        "observed real cached result before drift"
    );
    let before = attempts(&state);
    assert_eq!(before.len(), 2);
    assert!(before.keys().any(|name| name.ends_with(".prepared")));
    assert!(prepared.verify_unchanged().is_err());
    let status =
        operate_local_workflow_v1(&state, &definition, WorkflowActionV1::Status, 1200).unwrap();
    assert_eq!(status.committed_steps, 0);
    assert_eq!(status.budget_remaining_microusd, 100);
    assert!(
        operate_native_research_cas_assessment_workflow_v1(
            &prepared,
            &runtime,
            &definition,
            WorkflowActionV1::Advance { through_steps: 1 },
            &mut || Ok(1200),
            Arc::clone(&c)
        )
        .is_err()
    );
    assert_eq!(attempts(&state), before);
    // This failure cannot revive the old source observation or erase its durable
    // preparation. A separately observed, new normal source subject can execute.
    // The existing immutable-CAS recovery domain is distinct from live FS proof.
    drop(prepared);
    drop(inventory);
    drop(runtime);
    actual_inventory_cas_assessment_service_commits_settles_once_and_replays_original_result();
    eprintln!(
        "actual_cas_assessment_source_drift={}",
        json!({"driftTriggeredOnlyAfterActualPreparedResult":true,"sourceScopedCommitRefused":true,"commits":0,"sourceTariffSettled":0,"attemptBytesRetained":true,"oldObservationCannotRetry":true,"freshNormalSubjectCommittedOnce":true,"globalFilesystemWriterFencingClaimed":false})
    );
}
