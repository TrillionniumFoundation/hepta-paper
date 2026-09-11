use hepta_campaign_writer::WriterLeaseV1;
use hepta_control_plane::{
    ControlPlaneSnapshotV1, HardPolicyV1, PlannerPolicyV1, PlanningFrontierV1,
};
use hepta_module_platform::{
    ActionCandidateV1, ActivationStateV1, AuthorityClassV1, ModuleExecutionV1, ModuleGrantV1,
    ModuleKindV1, ModuleManifestV1, ModuleRegistryV1, QualificationTierV1, RegistryPolicyV1,
    ResourceVectorV1,
};
use hepta_paper_service::{
    NativeJobV1, ObjectStoreV1, ServiceRunV1, WorkerBindingV1,
    native_business::{BuildEntryV1, NativeBusinessJobV1},
    native_implementation_hash_v1, run_service_v1,
};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    os::unix::fs::PermissionsExt,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
};

static NEXT: AtomicU64 = AtomicU64::new(1);

struct Temp(PathBuf);

impl Temp {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "hepta-native-business-service-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).expect("create private test directory");
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700))
            .expect("private test permissions");
        Self(path)
    }
}

impl Drop for Temp {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn build_configuration(temp: &Temp) -> ServiceRunV1 {
    let objects = ObjectStoreV1::open(&temp.0).expect("object store");
    let initial = objects
        .put(b"native business initial state\n")
        .expect("initial object");
    let payload = objects
        .put(
            &serde_json::to_vec(&NativeJobV1::Business {
                job: NativeBusinessJobV1::BuildPackage {
                    entries: vec![BuildEntryV1 {
                        path: "manuscript/main.md".into(),
                        content: "# Rust-native package\n".into(),
                        media_type: "text/markdown".into(),
                    }],
                },
            })
            .expect("native business payload"),
        )
        .expect("payload object");
    let capabilities = BTreeSet::from(["CAP-BUILD".to_owned()]);
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
            capability_id: "CAP-BUILD".into(),
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
        state_directory: temp.0.clone(),
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

#[test]
fn native_business_runs_through_durable_service_and_replays() {
    let temp = Temp::new();
    let config = build_configuration(&temp);
    let first = run_service_v1(config.clone()).expect("native business execution");
    assert_eq!(first.commit_receipts.len(), 1);
    assert!(first.commit_receipts[0].newly_committed);
    assert!(!first.production_activation);

    let replay = run_service_v1(config).expect("native business durable replay");
    assert_eq!(replay.commit_receipts.len(), 1);
    assert!(!replay.commit_receipts[0].newly_committed);
    assert_eq!(
        first.commit_receipts[0].result_hash,
        replay.commit_receipts[0].result_hash
    );
}
