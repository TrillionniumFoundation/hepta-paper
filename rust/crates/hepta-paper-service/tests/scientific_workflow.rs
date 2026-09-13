use hepta_campaign_writer::WriterLeaseV1;
use hepta_control_plane::{
    ControlPlaneSnapshotV1, HardPolicyV1, PlannerPolicyV1, PlanningFrontierV1,
};
use hepta_module_platform::*;
use hepta_paper_service::workflow::*;
use hepta_paper_service::*;
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

static NEXT: AtomicU64 = AtomicU64::new(1);
struct Temp(PathBuf);
impl Temp {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "hepta-scientific-workflow-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        Self(root)
    }
    fn state(&self) -> PathBuf {
        self.0.join("state")
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn template(
    state: &Path,
    binding: WorkerBindingV1,
) -> Result<ServiceRunV1, Box<dyn std::error::Error>> {
    let source: hepta_codex_protocol::Sha256Digest =
        "sha256:1111111111111111111111111111111111111111111111111111111111111111".parse()?;
    let cap = [
        "CAP-AUTHOR",
        "CAP-REVIEW",
        "CAP-FORMAL",
        "CAP-EMPIRICAL",
        "CAP-NUMERICAL",
        "CAP-BUILD",
        "CAP-SUBMIT",
    ]
    .into_iter()
    .map(str::to_owned)
    .collect::<BTreeSet<_>>();
    let mut registry = ModuleRegistryV1::new(RegistryPolicyV1 {
        version: 1,
        protocol_version: 1,
        central_writer_module_id: "module.commit-sequencer".into(),
        grants: BTreeMap::from([(
            "module.local-native".into(),
            ModuleGrantV1 {
                module_version: "1.0.0".into(),
                authority: AuthorityClassV1::PreparedResultOnly,
                minimum_qualification: QualificationTierV1::Source,
                activation: ActivationStateV1::Shadow,
                capability_ids: cap.clone(),
            },
        )]),
    })?;
    registry.register(ModuleManifestV1 {
        version: 1,
        module_id: "module.local-native".into(),
        module_version: "1.0.0".into(),
        protocol_min: 1,
        protocol_max: 1,
        module_kind: if matches!(binding, WorkerBindingV1::Native) {
            ModuleKindV1::TrustedInProcess
        } else {
            ModuleKindV1::IsolatedProcess
        },
        requested_authority: AuthorityClassV1::PreparedResultOnly,
        qualification: QualificationTierV1::Source,
        requested_activation: ActivationStateV1::Shadow,
        capability_ids: cap.iter().cloned().collect(),
        dependencies: vec![],
        primary_owner: "TEAM-KERNEL".into(),
        secondary_owner: "TEAM-RUNTIME".into(),
        independent_reviewer: "TEAM-EVIDENCE".into(),
        rollback_version: "0.9.0".into(),
        execution: match &binding {
            WorkerBindingV1::Native => ModuleExecutionV1::InProcess {
                implementation_hash: native_implementation_hash_v1()?,
            },
            WorkerBindingV1::Process {
                executable_hash,
                network_declared,
                ..
            } => ModuleExecutionV1::IsolatedProcess {
                executable_hash: executable_hash.clone(),
                configuration_hash: hepta_control_plane::canonical_hash_v1(&binding)?,
                network_declared: *network_declared,
            },
        },
    })?;
    let registry = registry.finish()?;
    let hard = HardPolicyV1 {
        version: 1,
        policy_id: "local-shadow-v1".into(),
        registry_policy_hash: registry.policy_hash().clone(),
        forbidden_module_ids: BTreeSet::new(),
        minimum_evidence_by_capability: BTreeMap::new(),
        external_actions_authorized: false,
        maximum_central_writer_turns: 0,
        maximum_candidates_per_decision_group: 4,
    };
    let capacity = ResourceVectorV1 {
        cpu_millis: 100,
        memory_bytes: 1024 * 1024,
        tokens: 100,
        ..ResourceVectorV1::default()
    };
    let snapshot = ControlPlaneSnapshotV1 {
        version: 1,
        campaign_id: "campaign-service".into(),
        campaign_revision: 1,
        state_hash: source.clone(),
        registry_hash: registry.registry_hash().clone(),
        registry_policy_hash: registry.policy_hash().clone(),
        objective_version: "build-v1".into(),
        constraint_set_hash: hard.policy_hash()?,
        resource_limit: capacity,
        budget_microusd: 100,
        required_capability_ids: cap,
        random_seed: None,
    };
    let frontier = PlanningFrontierV1 {
        version: 1,
        snapshot_hash: snapshot.snapshot_hash()?,
        candidates: vec![],
    };
    Ok(ServiceRunV1 {
        version: 1,
        production_activation: false,
        state_directory: state.to_path_buf(),
        registry_json: serde_json::to_string(&registry)?,
        hard_policy: hard,
        planner_policy: PlannerPolicyV1 {
            version: 1,
            maximum_exact_candidates: 16,
            cost_weight_ppm: 0,
            uncertainty_weight_micros_per_ppm: 0,
            maximum_selected_candidates: 16,
        },
        snapshot,
        frontier,
        verifier_hash: source.clone(),
        initial_state_hash: source,
        writer_lease: WriterLeaseV1 {
            generation: 1,
            token: "local-writer-token-unique-001".into(),
            expires_at_unix_ms: 100_000,
        },
        observed_at_unix_ms: 1_000,
        workers: BTreeMap::from([("module.local-native".into(), binding)]),
    })
}

use hepta_paper_service::scientific_runtime::*;
fn digest(bytes: &[u8]) -> hepta_codex_protocol::Sha256Digest {
    format!("sha256:{}", hex::encode(Sha256::digest(bytes)))
        .parse()
        .unwrap()
}
fn definition(temp: &Temp, fail: bool) -> LocalWorkflowV1 {
    let mut job: ScientificJobV1 = serde_json::from_str(include_str!(
        "../../../../docs/modules/examples/scientific-python-job.v1.json"
    ))
    .unwrap();
    if fail {
        job.files.insert(
            "main.py".into(),
            "raise RuntimeError('private failure detail')\n".into(),
        );
    }
    let scratch = temp.0.join("scratch");
    fs::create_dir(&scratch).unwrap();
    fs::set_permissions(&scratch, fs::Permissions::from_mode(0o700)).unwrap();
    let python = fs::canonicalize("/usr/bin/python3").unwrap();
    let profile = ScientificRuntimeProfileV1 {
        version: 1,
        runtime: ScientificRuntimeKindV1::PythonEmpirical,
        executable_hash: digest(&fs::read(&python).unwrap()),
        executable: python,
        runtime_files: BTreeMap::new(),
        job_hash: scientific_job_hash_v1(&job).unwrap(),
        scratch_root: scratch,
        timeout_ms: 5000,
        maximum_output_bytes: 512 * 1024,
        passes: 1,
    };
    let profile_path = temp.0.join("science-profile.json");
    let profile_bytes = serde_json::to_vec(&profile).unwrap();
    fs::write(&profile_path, &profile_bytes).unwrap();
    let profile_hash = digest(&profile_bytes);
    let worker = fs::canonicalize(env!("CARGO_BIN_EXE_hepta-scientific-worker")).unwrap();
    let binding = WorkerBindingV1::Process {
        executable_hash: digest(&fs::read(&worker).unwrap()),
        executable: worker,
        arguments: vec![
            profile_path.to_str().unwrap().into(),
            profile_hash.to_string(),
        ],
        code_files: BTreeMap::from([(profile_path, profile_hash)]),
        working_directory: temp.0.clone(),
        implementation_language: "rust".into(),
        timeout_ms: 10000,
        network_declared: false,
    };
    let mut t = template(&temp.state(), WorkerBindingV1::Native).unwrap();
    let old = ModuleRegistryArtifactV1::decode_json(
        t.registry_json.as_bytes(),
        &t.hard_policy.registry_policy_hash,
    )
    .unwrap();
    let mut policy = old.policy().clone();
    let mut grant = policy.grants["module.local-native"].clone();
    grant.capability_ids = BTreeSet::from(["CAP-EMPIRICAL".into()]);
    policy.grants.insert("module.scientific".into(), grant);
    let mut registry = ModuleRegistryV1::new(policy).unwrap();
    let original = old.module("module.local-native").unwrap().manifest.clone();
    registry.register(original.clone()).unwrap();
    let mut science = original;
    science.module_id = "module.scientific".into();
    science.module_kind = ModuleKindV1::IsolatedProcess;
    science.capability_ids = vec!["CAP-EMPIRICAL".into()];
    science.execution = match &binding {
        WorkerBindingV1::Process {
            executable_hash, ..
        } => ModuleExecutionV1::IsolatedProcess {
            executable_hash: executable_hash.clone(),
            configuration_hash: hepta_control_plane::canonical_hash_v1(&binding).unwrap(),
            network_declared: false,
        },
        _ => unreachable!(),
    };
    registry.register(science).unwrap();
    let registry = registry.finish().unwrap();
    t.registry_json = serde_json::to_string(&registry).unwrap();
    t.hard_policy.registry_policy_hash = registry.policy_hash().clone();
    t.snapshot.registry_policy_hash = registry.policy_hash().clone();
    t.snapshot.registry_hash = registry.registry_hash().clone();
    t.snapshot.constraint_set_hash = t.hard_policy.policy_hash().unwrap();
    t.frontier.snapshot_hash = t.snapshot.snapshot_hash().unwrap();
    t.workers.insert("module.scientific".into(), binding);
    let step =
        |id: &str, module: &str, cap: &str, value: serde_json::Value, bindings| WorkflowStepV1 {
            id: id.into(),
            module_id: module.into(),
            capability_id: cap.into(),
            resources: ResourceVectorV1 {
                cpu_millis: 1,
                memory_bytes: 4096,
                ..ResourceVectorV1::default()
            },
            cost_microusd: 1,
            job_template: value,
            bindings,
            gate: None,
        };
    let empirical = step(
        "experiment",
        "module.scientific",
        "CAP-EMPIRICAL",
        serde_json::json!({"kind":"process","input":job}),
        vec![],
    );
    let author = step(
        "author",
        "module.local-native",
        "CAP-AUTHOR",
        serde_json::json!({"kind":"business","job":{
        "kind":"author_draft","title":"Real experiment", "abstract_text":"Program-generated observations.",
        "sections":[{"heading":"Results","body":"Bound from the experiment at execution"}],"reference_keys":[]}}),
        vec![ArtifactBindingV1 {
            from_step: "experiment".into(),
            artifact_index: 0,
            artifact_name: Some("result.json".into()),
            target_pointer: "/job/sections/0/body".into(),
            encoding: ArtifactEncodingV1::Utf8,
        }],
    );
    let build = step(
        "build",
        "module.local-native",
        "CAP-BUILD",
        serde_json::json!({"kind":"business","job":{
        "kind":"build_package","entries":[{"path":"manuscript.md","mediaType":"text/markdown","content":"Bound manuscript"}]}}),
        vec![ArtifactBindingV1 {
            from_step: "author".into(),
            artifact_index: 0,
            artifact_name: None,
            target_pointer: "/job/entries/0/content".into(),
            encoding: ArtifactEncodingV1::Utf8,
        }],
    );
    LocalWorkflowV1 {
        version: 1,
        template: t,
        steps: vec![empirical, author, build],
    }
}
fn scratch_count(temp: &Temp) -> usize {
    fs::read_dir(temp.0.join("scratch")).unwrap().count()
}
#[test]
fn real_experiment_named_result_reaches_manuscript_bundle_and_sqlite_exactly_once() {
    let temp = Temp::new();
    let definition = definition(&temp, false);
    let hash = initialize_local_workflow_v1(definition).unwrap();
    let done = operate_local_workflow_v1(
        &temp.state(),
        &hash,
        WorkflowActionV1::Advance { through_steps: 3 },
        1100,
    )
    .unwrap();
    assert_eq!(done.committed_steps, 3);
    assert_eq!(done.budget_remaining_microusd, 97);
    let objects = ObjectStoreV1::open(&temp.state()).unwrap();
    let result_hash = resolve_scientific_output_v1(
        &objects,
        &done.artifacts_by_step["experiment"],
        "result.json",
        "CAP-EMPIRICAL",
    )
    .unwrap();
    let result = objects.read(&result_hash).unwrap();
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&result).unwrap()["mean"],
        5
    );
    let manuscript = objects.read(&done.artifacts_by_step["author"][0]).unwrap();
    assert!(
        std::str::from_utf8(&manuscript)
            .unwrap()
            .contains(std::str::from_utf8(&result).unwrap())
    );
    let mut bundle_seen = false;
    for h in &done.artifacts_by_step["build"] {
        let bytes = objects.read(h).unwrap();
        if bytes.starts_with(b"HEPTA-NATIVE-BUNDLE-V1") {
            let entries =
                native_business::verify_native_build_bundle_v1(&bytes, h.as_str()).unwrap();
            assert_eq!(entries[0].content.as_bytes(), manuscript);
            bundle_seen = true;
        }
    }
    assert!(bundle_seen);
    assert_eq!(scratch_count(&temp), 1);
    let replay = operate_local_workflow_v1(
        &temp.state(),
        &hash,
        WorkflowActionV1::Advance { through_steps: 3 },
        1200,
    )
    .unwrap();
    assert_eq!(replay.budget_remaining_microusd, 97);
    assert_eq!(scratch_count(&temp), 1);
    assert_eq!(done.artifacts_by_step, replay.artifacts_by_step);
    assert!(
        !replay.production_activation
            && !replay.scientific_acceptance
            && !replay.node_retirement_verified
    );
    fs::write(
        objects
            .root()
            .join(result_hash.as_str().trim_start_matches("sha256:")),
        b"corrupt",
    )
    .unwrap();
    assert!(operate_local_workflow_v1(&temp.state(), &hash, WorkflowActionV1::Status, 0).is_err());
    assert_eq!(scratch_count(&temp), 1);
}
#[test]
fn failed_scientific_program_stays_ambiguous_and_is_not_launched_twice() {
    let temp = Temp::new();
    let hash = initialize_local_workflow_v1(definition(&temp, true)).unwrap();
    for now in [1100, 1200] {
        assert!(
            operate_local_workflow_v1(
                &temp.state(),
                &hash,
                WorkflowActionV1::Advance { through_steps: 3 },
                now
            )
            .is_err()
        );
    }
    assert_eq!(scratch_count(&temp), 1);
    let status =
        operate_local_workflow_v1(&temp.state(), &hash, WorkflowActionV1::Status, 0).unwrap();
    assert_eq!(status.committed_steps, 0);
    assert!(status.pending_step);
    assert_eq!(status.budget_remaining_microusd, 100);
}
#[test]
fn unknown_named_output_stops_downstream_dispatch_without_rerunning_experiment() {
    let temp = Temp::new();
    let mut def = definition(&temp, false);
    def.steps[1].bindings[0].artifact_name = Some("missing.json".into());
    let hash = initialize_local_workflow_v1(def).unwrap();
    for now in [1100, 1200] {
        assert!(
            operate_local_workflow_v1(
                &temp.state(),
                &hash,
                WorkflowActionV1::Advance { through_steps: 3 },
                now
            )
            .is_err()
        );
    }
    assert_eq!(scratch_count(&temp), 1);
    let status =
        operate_local_workflow_v1(&temp.state(), &hash, WorkflowActionV1::Status, 0).unwrap();
    assert_eq!(status.committed_steps, 1);
    assert_eq!(status.budget_remaining_microusd, 99);
}
#[test]
fn named_binding_rejects_ambiguous_index_and_traversal_before_initialization() {
    for (name, index) in [("result.json", 1), ("../result.json", 0)] {
        let temp = Temp::new();
        let mut def = definition(&temp, false);
        def.steps[1].bindings[0].artifact_index = index;
        def.steps[1].bindings[0].artifact_name = Some(name.into());
        assert!(initialize_local_workflow_v1(def).is_err());
        assert!(!temp.state().exists());
    }
}
