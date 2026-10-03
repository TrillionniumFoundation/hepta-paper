//! Real definition-persisted initialization interruption; no recovery kernel.
use super::tests::{RuntimeCleanup, Temp, setup};
use super::*;
use crate::{
    NativeJobV1, ServiceRunV1, WorkerBindingV1,
    native_business::NativeBusinessJobV1,
    native_implementation_hash_v1,
    native_inventory::{NativeInventoryRequestV1, discover_native_inventory_v1},
    native_research_source_plan::{
        NativeResearchSourcePlanRequestV1, open_native_research_source_data_runtime_v1,
    },
    native_research_workflow::NativeResearchDataWorkflowBindingV1,
    workflow::{WorkflowActionV1, operate_local_workflow_v1},
};
use hepta_campaign_writer::WriterLeaseV1;
use hepta_codex_runtime::{
    BoundedProcessRequestV1, EnvironmentPolicyV1, ProcessLimitsV1,
    run_bounded_process_capturing_stdout_with_cancellation,
};
use hepta_control_plane::{
    ControlPlaneSnapshotV1, HardPolicyV1, PlannerPolicyV1, PlanningFrontierV1,
};
use hepta_module_platform::{
    ActionCandidateV1, ActivationStateV1, AuthorityClassV1, ModuleExecutionV1, ModuleGrantV1,
    ModuleKindV1, ModuleManifestV1, ModuleRegistryV1, QualificationTierV1, RegistryPolicyV1,
    ResourceVectorV1,
};
use nix::sys::signal::{Signal, raise};
use serde_json::json;
use std::{
    cell::RefCell,
    collections::{BTreeMap, BTreeSet},
    ffi::OsString,
    fs,
    io::Read,
    os::unix::fs::{MetadataExt, PermissionsExt},
    path::PathBuf,
    sync::Arc,
    time::Duration,
};
type CreatedHook = Box<dyn FnOnce(&Sha256Digest)>;
thread_local! { static AFTER_CREATED: RefCell<Option<CreatedHook>> = RefCell::new(None); }
pub(super) fn after_definition_created(hash: &Sha256Digest) {
    AFTER_CREATED.with(|slot| {
        if let Some(f) = slot.borrow_mut().take() {
            f(hash);
        }
    });
}
fn set_hook(f: CreatedHook) {
    AFTER_CREATED.with(|slot| {
        assert!(slot.borrow().is_none());
        *slot.borrow_mut() = Some(f);
    });
}
fn configuration_for_job(root: &Path, business_job: NativeBusinessJobV1) -> ServiceRunV1 {
    // This is a new test-owned configuration directory, outside held sources.
    // The existing private CAS owner still refuses a public or unknown root.
    fs::set_permissions(root, fs::Permissions::from_mode(0o700)).unwrap();
    let capability = business_job.capability_id().to_owned();
    let objects = ObjectStoreV1::open(root).expect("object store");
    let initial = objects
        .put(b"native business initial state\n")
        .expect("initial object");
    let payload = objects
        .put(
            &serde_json::to_vec(&NativeJobV1::Business { job: business_job })
                .expect("payload bytes"),
        )
        .expect("payload object");
    let capabilities = BTreeSet::from([capability.clone()]);
    let module_id = "module.native-business".to_owned();
    let mut registry = ModuleRegistryV1::new(RegistryPolicyV1 {
        version: 1,
        protocol_version: 1,
        central_writer_module_id: "module.commit-sequencer".into(),
        grants: BTreeMap::from([(
            module_id.clone(),
            ModuleGrantV1 {
                module_version: "1.0.0".into(),
                authority: AuthorityClassV1::PreparedResultOnly,
                minimum_qualification: QualificationTierV1::Source,
                activation: ActivationStateV1::Shadow,
                capability_ids: capabilities.clone(),
            },
        )]),
    })
    .expect("registry policy");
    registry
        .register(ModuleManifestV1 {
            version: 1,
            module_id: module_id.clone(),
            module_version: "1.0.0".into(),
            protocol_min: 1,
            protocol_max: 1,
            module_kind: ModuleKindV1::TrustedInProcess,
            requested_authority: AuthorityClassV1::PreparedResultOnly,
            qualification: QualificationTierV1::Source,
            requested_activation: ActivationStateV1::Shadow,
            capability_ids: capabilities.iter().cloned().collect(),
            dependencies: vec![],
            primary_owner: "TEAM-KERNEL".into(),
            secondary_owner: "TEAM-RUNTIME".into(),
            independent_reviewer: "TEAM-EVIDENCE".into(),
            rollback_version: "0.9.0".into(),
            execution: ModuleExecutionV1::InProcess {
                implementation_hash: native_implementation_hash_v1()
                    .expect("native implementation identity"),
            },
        })
        .expect("native module registration");
    let registry = registry.finish().expect("registry artifact");
    let hard_policy = HardPolicyV1 {
        version: 1,
        policy_id: "native-business-shadow-v1".into(),
        registry_policy_hash: registry.policy_hash().clone(),
        forbidden_module_ids: BTreeSet::new(),
        minimum_evidence_by_capability: BTreeMap::new(),
        external_actions_authorized: false,
        maximum_central_writer_turns: 0,
        maximum_candidates_per_decision_group: 1,
    };
    let capacity = ResourceVectorV1 {
        cpu_millis: 100,
        memory_bytes: 1024 * 1024,
        tokens: 100,
        ..ResourceVectorV1::default()
    };
    let snapshot = ControlPlaneSnapshotV1 {
        version: 1,
        campaign_id: "campaign-native-business".into(),
        campaign_revision: 1,
        state_hash: initial.clone(),
        registry_hash: registry.registry_hash().clone(),
        registry_policy_hash: registry.policy_hash().clone(),
        objective_version: "native-build-v1".into(),
        constraint_set_hash: hard_policy.policy_hash().expect("hard policy hash"),
        resource_limit: capacity,
        budget_microusd: 100,
        required_capability_ids: capabilities,
        random_seed: None,
    };
    let frontier = PlanningFrontierV1 {
        version: 1,
        snapshot_hash: snapshot.snapshot_hash().expect("snapshot hash"),
        candidates: vec![ActionCandidateV1 {
            version: 1,
            candidate_id: "native-build-1".into(),
            decision_group: "native-build".into(),
            module_id: module_id.clone(),
            module_version: "1.0.0".into(),
            capability_id: capability,
            snapshot_hash: snapshot.snapshot_hash().expect("snapshot hash"),
            dependency_candidate_ids: vec![],
            resources: ResourceVectorV1 {
                cpu_millis: 1,
                memory_bytes: 4096,
                ..ResourceVectorV1::default()
            },
            utility_micros: 1,
            cost_microusd: 1,
            uncertainty_ppm: 0,
            evidence_tier: QualificationTierV1::Source,
            payload_hash: payload,
        }],
    };
    ServiceRunV1 {
        version: 1,
        production_activation: false,
        state_directory: root.to_owned(),
        registry_json: serde_json::to_string(&registry).expect("registry JSON"),
        hard_policy,
        planner_policy: PlannerPolicyV1 {
            version: 1,
            maximum_exact_candidates: 1,
            cost_weight_ppm: 0,
            uncertainty_weight_micros_per_ppm: 0,
            maximum_selected_candidates: 1,
        },
        snapshot,
        frontier,
        verifier_hash: initial.clone(),
        initial_state_hash: initial,
        writer_lease: WriterLeaseV1 {
            generation: 1,
            token: "native-business-writer-token-001".into(),
            expires_at_unix_ms: 100_000,
        },
        observed_at_unix_ms: 1_000,
        workers: BTreeMap::from([(module_id, WorkerBindingV1::Native)]),
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
fn request(root: &Path) -> NativeInventoryRequestV1 {
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
fn all_bytes(root: &Path) -> BTreeMap<PathBuf, Sha256Digest> {
    fn walk(root: &Path, path: &Path, out: &mut BTreeMap<PathBuf, Sha256Digest>) {
        for entry in fs::read_dir(path).unwrap() {
            let p = entry.unwrap().path();
            let m = fs::symlink_metadata(&p).unwrap();
            assert!(!m.file_type().is_symlink());
            if m.is_dir() {
                walk(root, &p, out)
            } else {
                assert!(m.is_file());
                assert!(out.len() < 128);
                assert!(m.len() < 4 * 1024 * 1024);
                out.insert(
                    p.strip_prefix(root).unwrap().into(),
                    sha(&fs::read(p).unwrap()),
                );
            }
        }
    }
    let mut out = BTreeMap::new();
    walk(root, root, &mut out);
    out
}
fn assert_unknown_initializer_retained(
    root: &Path,
    state: &Path,
    expected: &Sha256Digest,
    manifest: &Sha256Digest,
) {
    assert!(state.join("workflow.json").is_file());
    let original = all_bytes(state);
    assert!(original.keys().all(|p| !p.starts_with("attempts")));
    let objects = ObjectStoreV1::open(state).unwrap();
    assert!(objects.read(manifest).is_err());
    let c = Arc::new(AtomicBool::new(false));
    let deadline = Instant::now() + Duration::from_secs(30);
    let inventory = discover_native_inventory_v1(&request(root), &c, deadline).unwrap();
    let task = inventory.scan()["rows"][0]["task"].clone();
    drop(inventory);
    let runtime = open_native_research_source_data_runtime_v1(
        &NativeResearchSourcePlanRequestV1 {
            version: 1,
            root: root.into(),
            paper_task: task.clone(),
        },
        &c,
        deadline,
    )
    .unwrap();
    let inventory = discover_native_inventory_v1(&request(root), &c, deadline).unwrap();
    let prepared = prepare_native_research_cas_assessment_for_inventory_row_v1(
        &inventory,
        task["paperId"].as_str().unwrap(),
        &runtime,
        &c,
        deadline,
    )
    .unwrap();
    assert_eq!(
        &prepared.request().manifest_object,
        manifest,
        "fresh control, same observed subject"
    );
    let NativeJobV1::Business { job } = prepared.job() else {
        panic!("actual source job")
    };
    let config = Temp::new();
    assert!(
        initialize_native_research_cas_assessment_workflow_v1(
            &prepared,
            &runtime,
            binding(configuration_for_job(&config.0, job), state.into())
        )
        .is_err()
    );
    assert_eq!(
        all_bytes(state),
        original,
        "unknown initializer is never cleaned or overwritten"
    );
    assert!(
        operate_native_research_cas_assessment_workflow_v1(
            &prepared,
            &runtime,
            expected,
            WorkflowActionV1::Advance { through_steps: 1 },
            &mut || Ok(1200),
            Arc::clone(&c)
        )
        .is_err()
    );
    assert_eq!(
        all_bytes(state),
        original,
        "missing immutable input is refused before dispatch"
    );
    let status =
        operate_local_workflow_v1(state, expected, WorkflowActionV1::Status, 1300).unwrap();
    assert_eq!(status.committed_steps, 0);
    assert_eq!(status.budget_remaining_microusd, 100);
}
#[test]
fn actual_cancellation_after_definition_persistence_retains_unknown_initialization() {
    let source = Temp::new();
    let config = Temp::new();
    let req = setup(&source.0);
    let c = Arc::new(AtomicBool::new(false));
    let deadline = Instant::now() + Duration::from_secs(30);
    let initial = discover_native_inventory_v1(&req, &c, deadline).unwrap();
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
    let _cleanup = RuntimeCleanup(runtime.workflow_directory().parent().unwrap().into());
    let inventory = discover_native_inventory_v1(&req, &c, deadline).unwrap();
    let prepared = prepare_native_research_cas_assessment_for_inventory_row_v1(
        &inventory,
        task["paperId"].as_str().unwrap(),
        &runtime,
        &c,
        deadline,
    )
    .unwrap();
    let manifest = prepared.request().manifest_object.clone();
    let state = runtime
        .workflow_directory()
        .with_file_name("native-assessment-workflow.v1");
    let point = Arc::new(std::sync::Mutex::new(None));
    let shared = Arc::clone(&point);
    let flag = Arc::clone(&c);
    set_hook(Box::new(move |hash| {
        *shared.lock().unwrap() = Some(hash.clone());
        flag.store(true, Ordering::SeqCst);
    }));
    let NativeJobV1::Business { job } = prepared.job() else {
        panic!("actual source job")
    };
    assert!(
        initialize_native_research_cas_assessment_workflow_v1(
            &prepared,
            &runtime,
            binding(configuration_for_job(&config.0, job), state.clone())
        )
        .is_err()
    );
    let expected = point.lock().unwrap().take().unwrap();
    assert!(prepared.verify_unchanged().is_err());
    drop(prepared);
    drop(inventory);
    drop(runtime);
    assert_unknown_initializer_retained(&source.0, &state, &expected, &manifest);
    eprintln!(
        "actual_cas_initializer_cancel={}",
        json!({"actualDefinitionPersistedBeforeCancellation":true,"originalInputCopyNeverStarted":true,"freshSameSubjectInitRefused":true,"unknownStateBytesRetained":true,"dispatches":0,"commits":0,"initializationRecoveryAccepted":false})
    );
}
#[test]
fn initializer_signal_child() {
    let Ok(label) = std::env::var("HEPTA_CAS_INIT_SIGNAL_CHILD") else {
        return;
    };
    assert!(matches!(label.as_str(), "term" | "kill"));
    let work = PathBuf::from(std::env::var_os("HEPTA_CAS_INIT_CHILD_ROOT").unwrap());
    let source = work.join("actual-paper");
    fs::create_dir(&source).unwrap();
    let req = setup(&source);
    let config = work.join("config");
    fs::create_dir(&config).unwrap();
    let c = Arc::new(AtomicBool::new(false));
    let deadline = Instant::now() + Duration::from_secs(30);
    let initial = discover_native_inventory_v1(&req, &c, deadline).unwrap();
    let task = initial.scan()["rows"][0]["task"].clone();
    drop(initial);
    let runtime = open_native_research_source_data_runtime_v1(
        &NativeResearchSourcePlanRequestV1 {
            version: 1,
            root: source.clone(),
            paper_task: task.clone(),
        },
        &c,
        deadline,
    )
    .unwrap();
    let inventory = discover_native_inventory_v1(&req, &c, deadline).unwrap();
    let prepared = prepare_native_research_cas_assessment_for_inventory_row_v1(
        &inventory,
        task["paperId"].as_str().unwrap(),
        &runtime,
        &c,
        deadline,
    )
    .unwrap();
    let manifest = prepared.request().manifest_object.clone();
    let state = runtime
        .workflow_directory()
        .with_file_name("native-assessment-workflow.v1");
    let observed_state = state.clone();
    set_hook(Box::new(move |hash| {
        assert!(observed_state.join("workflow.json").is_file());
        assert!(
            ObjectStoreV1::open(&observed_state)
                .unwrap()
                .read(&manifest)
                .is_err()
        );
        fs::write(work.join("actual-created-window.json"),serde_json::to_vec(&json!({"workflow":observed_state,"definitionHash":hash,"manifest":manifest,"pid":std::process::id(),"signal":label})).unwrap()).unwrap();
        raise(if label == "term" {
            Signal::SIGTERM
        } else {
            Signal::SIGKILL
        })
        .unwrap();
        panic!("signal unexpectedly returned")
    }));
    let NativeJobV1::Business { job } = prepared.job() else {
        panic!("actual source job")
    };
    let _ = initialize_native_research_cas_assessment_workflow_v1(
        &prepared,
        &runtime,
        binding(configuration_for_job(&config, job), state),
    );
    panic!("initializer child survived");
}
fn elf_observation(path: &Path) -> Value {
    let m = fs::symlink_metadata(path).unwrap();
    assert!(m.is_file() && m.len() <= 256 * 1024 * 1024);
    let mut bytes = Vec::new();
    fs::File::open(path)
        .unwrap()
        .take(256 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .unwrap();
    assert_eq!(bytes.len() as u64, m.len());
    assert!(bytes.starts_with(b"\x7fELF"));
    json!({"dev":m.dev(),"inode":m.ino(),"bytes":m.len(),"uid":m.uid(),"gid":m.gid(),"nlink":m.nlink(),"mode":m.mode(),"mtime":m.mtime(),"mtimeNs":m.mtime_nsec(),"ctime":m.ctime(),"ctimeNs":m.ctime_nsec(),"hash":sha(&bytes)})
}
#[test]
fn actual_term_kill_after_definition_persistence_preserves_unknown_state_before_fresh_refusal() {
    let executable = fs::canonicalize(std::env::current_exe().unwrap()).unwrap();
    let before = elf_observation(&executable);
    let fixture = Temp::new();
    fs::set_permissions(&fixture.0, fs::Permissions::from_mode(0o700)).unwrap();
    let copy = fixture.0.join("native-cas-initializer-test");
    fs::copy(&executable, &copy).unwrap();
    fs::set_permissions(&copy, fs::Permissions::from_mode(0o550)).unwrap();
    let copied = elf_observation(&copy);
    assert_eq!(before["hash"], copied["hash"]);
    assert_ne!(before["inode"], copied["inode"]);
    for (label, signal) in [("term", 15), ("kill", 9)] {
        let work = fixture.0.join(label);
        fs::create_dir(&work).unwrap();
        let runtime_root = work.join("runtime");
        fs::create_dir(&runtime_root).unwrap();
        let environment = EnvironmentPolicyV1::new(
            "native-cas-initializer-signals-v1",
            [
                "PATH",
                "HEPTA_CAS_INIT_SIGNAL_CHILD",
                "HEPTA_CAS_INIT_CHILD_ROOT",
                "HEPTA_PAPER_RUNTIME_ROOT",
            ],
            [
                "PATH",
                "HEPTA_CAS_INIT_SIGNAL_CHILD",
                "HEPTA_CAS_INIT_CHILD_ROOT",
                "HEPTA_PAPER_RUNTIME_ROOT",
            ],
        )
        .unwrap()
        .build(
            std::iter::empty::<(OsString, OsString)>(),
            &BTreeMap::from([
                ("PATH".into(), "/usr/bin:/bin".into()),
                ("HEPTA_CAS_INIT_SIGNAL_CHILD".into(), label.into()),
                (
                    "HEPTA_CAS_INIT_CHILD_ROOT".into(),
                    work.to_str().unwrap().to_owned(),
                ),
                (
                    "HEPTA_PAPER_RUNTIME_ROOT".into(),
                    runtime_root.to_str().unwrap().to_owned(),
                ),
            ]),
        )
        .unwrap();
        let process=run_bounded_process_capturing_stdout_with_cancellation(&BoundedProcessRequestV1{executable:copy.clone(),arguments:vec!["--exact".into(),"native_research_assessment::cas::initialization_tests::initializer_signal_child".into(),"--nocapture".into()],working_directory:work.clone(),environment,stdin:None},ProcessLimitsV1{timeout_ms:30_000,termination_grace_ms:100,cleanup_timeout_ms:2_000,maximum_stdin_bytes:1,maximum_stdout_bytes:16*1024,maximum_stderr_bytes:16*1024,maximum_tail_bytes:16*1024,..ProcessLimitsV1::default()},&AtomicBool::new(false)).unwrap();
        assert_eq!(
            process.process.signal,
            Some(signal),
            "{:?}",
            process.process
        );
        assert!(process.process.process_group_cleanup_verified);
        assert!(!process.process.stdout_truncated && !process.process.stderr_truncated);
        let value: Value =
            serde_json::from_slice(&fs::read(work.join("actual-created-window.json")).unwrap())
                .unwrap();
        assert_eq!(value["signal"], label);
        let state = PathBuf::from(value["workflow"].as_str().unwrap());
        let expected = value["definitionHash"].as_str().unwrap().parse().unwrap();
        let manifest = value["manifest"].as_str().unwrap().parse().unwrap();
        // Keep the actual normal runtime selector for the fresh producer, then restore
        // it exactly. Serialized marker paths do not create any production authority.
        let original = std::env::var_os("HEPTA_PAPER_RUNTIME_ROOT");
        // No process-global environment mutation is needed: the original runtime
        // request defaults to this compile-bound layout in the parent. Recovery only
        // checks the immutable original definition; fresh init refuses its existence.
        let source = work.join("actual-paper");
        let bytes_before = all_bytes(&state);
        assert!(
            ObjectStoreV1::open(&state)
                .unwrap()
                .read(&manifest)
                .is_err()
        );
        let persisted: crate::workflow::LocalWorkflowV1 =
            serde_json::from_slice(&fs::read(state.join("workflow.json")).unwrap()).unwrap();
        assert!(crate::workflow::initialize_local_workflow_v1(persisted).is_err());
        assert_eq!(all_bytes(&state), bytes_before);
        let status =
            operate_local_workflow_v1(&state, &expected, WorkflowActionV1::Status, 1300).unwrap();
        assert_eq!(status.committed_steps, 0);
        assert_eq!(status.budget_remaining_microusd, 100);
        let after_status = all_bytes(&state);
        let status_created = after_status
            .keys()
            .filter(|path| !bytes_before.contains_key(*path))
            .cloned()
            .collect::<Vec<_>>();
        assert!(status_created.iter().all(|path| matches!(
            path.to_str(),
            Some("campaign.sqlite-wal" | "campaign.sqlite-shm")
        )));
        for (path, bytes) in &bytes_before {
            if path != Path::new("campaign.sqlite") {
                assert_eq!(after_status.get(path), Some(bytes));
            }
        }
        assert!(source.join("source/raw.dat").is_file());
        assert_eq!(std::env::var_os("HEPTA_PAPER_RUNTIME_ROOT"), original);
        eprintln!(
            "actual_cas_initializer_signal={}",
            json!({"signal":signal,"actualChild":value["pid"],"definitionPersisted":true,"inputObjectMissing":true,"existingKernelFreshInitRefused":true,"freshInitAttemptAllRawBytesUnchanged":true,"unknownDefinitionAndInputNamespaceUnchanged":true,"statusCreatedDatabaseSidecars":status_created,"statusDatabaseBytesChanged":after_status.get(Path::new("campaign.sqlite"))!=bytes_before.get(Path::new("campaign.sqlite")),"commits":0,"processGroupCleanupVerified":process.process.process_group_cleanup_verified,"originalAndShippingElfHash":before["hash"],"initializationRecoveryAccepted":false})
        );
    }
    assert_eq!(elf_observation(&copy), copied);
    assert_eq!(elf_observation(&executable), before);
}
