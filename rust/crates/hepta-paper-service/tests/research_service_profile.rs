use base64ct::{Base64UrlUnpadded, Encoding};
use ed25519_dalek::SigningKey;
use hepta_campaign_writer::WriterLeaseV1;
use hepta_codex_protocol::Sha256Digest;
use hepta_control_plane::{
    ControlPlaneSnapshotV1, HardPolicyV1, PlannerPolicyV1, PlanningFrontierV1,
};
use hepta_module_platform::{
    ActionCandidateV1, ActivationStateV1, AuthorityClassV1, ModuleExecutionV1, ModuleGrantV1,
    ModuleKindV1, ModuleManifestV1, ModuleRegistryV1, QualificationTierV1, RegistryPolicyV1,
    ResourceVectorV1,
};
use hepta_paper_service::broker_prepared::{
    BrokerCostSettlementKeyV1, BrokerCostSettlementSourceV1, BrokerPreparedSourceV1,
};
use hepta_paper_service::{
    NativeJobV1, ObjectStoreV1, ResearchActivationStageV1, ResearchServiceRunV1, ServiceRunV1,
    WorkerBindingV1, native_implementation_hash_v1, validate_research_service_policy_v1,
};
use hepta_qualification_ingest::ExternalQualificationClosureSubjectV1;
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
            "hepta-research-profile-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
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

fn digest(marker: u8) -> Sha256Digest {
    format!("sha256:{marker:064x}").parse().unwrap()
}

fn subject() -> ExternalQualificationClosureSubjectV1 {
    ExternalQualificationClosureSubjectV1 {
        repository: "TrillionniumFoundation/hepta-paper".into(),
        commit: "a".repeat(40),
        tree: "b".repeat(40),
    }
}

fn configuration(
    temp: &Temp,
    capability: &str,
    qualification: QualificationTierV1,
    activation: ActivationStateV1,
) -> ResearchServiceRunV1 {
    let objects = ObjectStoreV1::open(&temp.0).unwrap();
    let initial = objects.put(b"research profile initial state").unwrap();
    let artifact = objects.put(b"research profile artifact").unwrap();
    let payload = objects
        .put(
            &serde_json::to_vec(&NativeJobV1::ArtifactInventory {
                artifacts: vec![artifact],
            })
            .unwrap(),
        )
        .unwrap();
    let module_id = "module.research-worker".to_owned();
    let capabilities = BTreeSet::from([capability.to_owned()]);
    let mut registry = ModuleRegistryV1::new(RegistryPolicyV1 {
        version: 1,
        protocol_version: 1,
        central_writer_module_id: "module.commit-sequencer".into(),
        grants: BTreeMap::from([(
            module_id.clone(),
            ModuleGrantV1 {
                module_version: "1.0.0".into(),
                authority: AuthorityClassV1::PreparedResultOnly,
                minimum_qualification: qualification,
                activation,
                capability_ids: capabilities.clone(),
            },
        )]),
    })
    .unwrap();
    registry
        .register(ModuleManifestV1 {
            version: 1,
            module_id: module_id.clone(),
            module_version: "1.0.0".into(),
            protocol_min: 1,
            protocol_max: 1,
            module_kind: ModuleKindV1::TrustedInProcess,
            requested_authority: AuthorityClassV1::PreparedResultOnly,
            qualification,
            requested_activation: activation,
            capability_ids: capabilities.iter().cloned().collect(),
            dependencies: vec![],
            primary_owner: "TEAM-RESEARCH".into(),
            secondary_owner: "TEAM-RUNTIME".into(),
            independent_reviewer: "TEAM-EVIDENCE".into(),
            rollback_version: "0.9.0".into(),
            execution: ModuleExecutionV1::InProcess {
                implementation_hash: native_implementation_hash_v1().unwrap(),
            },
        })
        .unwrap();
    let registry = registry.finish().unwrap();
    let hard_policy = HardPolicyV1 {
        version: 1,
        policy_id: "restricted-research-v1".into(),
        registry_policy_hash: registry.policy_hash().clone(),
        forbidden_module_ids: BTreeSet::new(),
        minimum_evidence_by_capability: BTreeMap::from([(capability.to_owned(), qualification)]),
        external_actions_authorized: false,
        maximum_central_writer_turns: 0,
        maximum_candidates_per_decision_group: 1,
    };
    let capacity = ResourceVectorV1 {
        cpu_millis: 100,
        memory_bytes: 1024 * 1024,
        storage_bytes: 1024 * 1024,
        tokens: 100,
        ..ResourceVectorV1::default()
    };
    let snapshot = ControlPlaneSnapshotV1 {
        version: 1,
        campaign_id: "campaign-restricted-research".into(),
        campaign_revision: 1,
        state_hash: initial.clone(),
        registry_hash: registry.registry_hash().clone(),
        registry_policy_hash: registry.policy_hash().clone(),
        objective_version: "restricted-research-v1".into(),
        constraint_set_hash: hard_policy.policy_hash().unwrap(),
        resource_limit: capacity,
        budget_microusd: 100,
        required_capability_ids: capabilities,
        random_seed: None,
    };
    let frontier = PlanningFrontierV1 {
        version: 1,
        snapshot_hash: snapshot.snapshot_hash().unwrap(),
        candidates: vec![ActionCandidateV1 {
            version: 1,
            candidate_id: "research-action-1".into(),
            decision_group: "research-action".into(),
            module_id: module_id.clone(),
            module_version: "1.0.0".into(),
            capability_id: capability.to_owned(),
            snapshot_hash: snapshot.snapshot_hash().unwrap(),
            dependency_candidate_ids: vec![],
            resources: ResourceVectorV1 {
                cpu_millis: 1,
                memory_bytes: 4096,
                ..ResourceVectorV1::default()
            },
            utility_micros: 1,
            cost_microusd: 1,
            uncertainty_ppm: 0,
            evidence_tier: qualification,
            payload_hash: payload,
        }],
    };
    let service = ServiceRunV1 {
        version: 1,
        production_activation: false,
        state_directory: temp.0.clone(),
        registry_json: serde_json::to_string(&registry).unwrap(),
        hard_policy,
        planner_policy: PlannerPolicyV1 {
            version: 1,
            maximum_exact_candidates: 1,
            cost_weight_ppm: 0,
            uncertainty_weight_micros_per_ppm: 0,
            maximum_selected_candidates: 1,
        },
        frontier,
        snapshot,
        verifier_hash: initial.clone(),
        initial_state_hash: initial,
        writer_lease: WriterLeaseV1 {
            generation: 1,
            token: "restricted-research-writer-001".into(),
            expires_at_unix_ms: 100_000,
        },
        observed_at_unix_ms: 1_000,
        workers: BTreeMap::from([(module_id, WorkerBindingV1::Native)]),
    };
    ResearchServiceRunV1 {
        version: 1,
        stage: match activation {
            ActivationStateV1::Canary => ResearchActivationStageV1::Canary,
            ActivationStateV1::Authoritative => ResearchActivationStageV1::Established,
            _ => ResearchActivationStageV1::Canary,
        },
        subject: subject(),
        service,
    }
}

#[test]
fn research_policy_accepts_target_host_private_state_without_release_authority() {
    let temp = Temp::new();
    let config = configuration(
        &temp,
        "CAP-BUILD",
        QualificationTierV1::TargetHost,
        ActivationStateV1::Canary,
    );
    assert!(validate_research_service_policy_v1(&config, &digest(9)).is_ok());
}

#[test]
fn research_broker_requires_current_signed_cost_owner_without_release_authority() {
    use std::os::unix::fs::MetadataExt;

    let temp = Temp::new();
    let mut config = configuration(
        &temp,
        "CAP-BUILD",
        QualificationTierV1::TargetHost,
        ActivationStateV1::Canary,
    );
    let owner = fs::metadata(&temp.0).unwrap();
    let requests = temp.0.join("requests");
    let settlements = temp.0.join("settlements");
    fs::create_dir(&requests).unwrap();
    fs::create_dir(&settlements).unwrap();
    fs::set_permissions(&requests, fs::Permissions::from_mode(0o700)).unwrap();
    fs::set_permissions(&settlements, fs::Permissions::from_mode(0o700)).unwrap();
    let key = SigningKey::from_bytes(&[74; 32]);
    let module = config.service.workers.keys().next().unwrap().clone();
    let mut source = BrokerPreparedSourceV1 {
        socket_path: temp.0.join("broker.sock"),
        broker_uid: owner.uid(),
        broker_gid: owner.gid(),
        request_directory: requests,
        request_owner_uid: owner.uid(),
        request_owner_gid: owner.gid(),
        role: hepta_codex_protocol::AgentRole::Author,
        runtime_identity_hash: digest(9),
        timeout_ms: 1_000,
        cost_settlement: None,
    };
    config.service.workers.insert(
        module.clone(),
        WorkerBindingV1::BrokerExecute {
            source: source.clone(),
        },
    );
    assert!(validate_research_service_policy_v1(&config, &digest(9)).is_err());

    source.cost_settlement = Some(BrokerCostSettlementSourceV1 {
        directory: settlements,
        authority_domain_id: "research-billing-domain".into(),
        authority_uid: owner.uid(),
        authority_gid: owner.gid(),
        trust_store_generation: 1,
        maximum_age_ms: 60_000,
        keys: vec![BrokerCostSettlementKeyV1 {
            key_id: "research-billing-key".into(),
            public_key_base64: Base64UrlUnpadded::encode_string(key.verifying_key().as_bytes()),
        }],
    });
    config.service.workers.insert(
        module.clone(),
        WorkerBindingV1::BrokerExecute {
            source: source.clone(),
        },
    );
    assert!(validate_research_service_policy_v1(&config, &digest(9)).is_ok());

    let mut invalid = source;
    invalid
        .cost_settlement
        .as_mut()
        .unwrap()
        .trust_store_generation = 0;
    config
        .service
        .workers
        .insert(module, WorkerBindingV1::BrokerExecute { source: invalid });
    assert!(validate_research_service_policy_v1(&config, &digest(9)).is_err());
}

#[test]
fn research_policy_rejects_release_submission_cutover_and_external_effects() {
    for capability in ["CAP-REL-VERIFY", "CAP-SUBMIT", "CAP-MIG-CUTOVER"] {
        let temp = Temp::new();
        let config = configuration(
            &temp,
            capability,
            QualificationTierV1::TargetHost,
            ActivationStateV1::Canary,
        );
        assert!(validate_research_service_policy_v1(&config, &digest(9)).is_err());
    }
    let temp = Temp::new();
    let mut config = configuration(
        &temp,
        "CAP-BUILD",
        QualificationTierV1::TargetHost,
        ActivationStateV1::Canary,
    );
    config.service.snapshot.resource_limit.external_actions = 1;
    config.service.frontier.candidates[0]
        .resources
        .external_actions = 1;
    assert!(validate_research_service_policy_v1(&config, &digest(9)).is_err());
}

#[test]
fn research_policy_rejects_source_process_activation_and_runtime_substitution() {
    let temp = Temp::new();
    let source = configuration(
        &temp,
        "CAP-BUILD",
        QualificationTierV1::Source,
        ActivationStateV1::Canary,
    );
    assert!(validate_research_service_policy_v1(&source, &digest(9)).is_err());
    let temp = Temp::new();
    let mut process = configuration(
        &temp,
        "CAP-BUILD",
        QualificationTierV1::TargetHost,
        ActivationStateV1::Canary,
    );
    let module = process.service.workers.keys().next().unwrap().clone();
    process.service.workers.insert(
        module,
        WorkerBindingV1::Process {
            executable: temp.0.join("worker"),
            executable_hash: digest(7),
            arguments: vec![],
            code_files: BTreeMap::new(),
            working_directory: temp.0.clone(),
            implementation_language: "rust".into(),
            timeout_ms: 1_000,
            network_declared: false,
        },
    );
    assert!(validate_research_service_policy_v1(&process, &digest(9)).is_err());

    let temp = Temp::new();
    let mut activation = configuration(
        &temp,
        "CAP-BUILD",
        QualificationTierV1::TargetHost,
        ActivationStateV1::Canary,
    );
    activation.stage = ResearchActivationStageV1::Established;
    assert!(validate_research_service_policy_v1(&activation, &digest(9)).is_err());

    let temp = Temp::new();
    let mut runtime = configuration(
        &temp,
        "CAP-BUILD",
        QualificationTierV1::TargetHost,
        ActivationStateV1::Canary,
    );
    let module = runtime.service.workers.keys().next().unwrap().clone();
    runtime.service.workers.insert(
        module,
        WorkerBindingV1::BrokerPrepared {
            source: hepta_paper_service::broker_prepared::BrokerPreparedSourceV1 {
                socket_path: temp.0.join("broker.sock"),
                broker_uid: 1,
                broker_gid: 1,
                request_directory: temp.0.join("requests"),
                request_owner_uid: 1,
                request_owner_gid: 1,
                role: hepta_codex_protocol::AgentRole::Author,
                runtime_identity_hash: digest(8),
                timeout_ms: 1_000,
                cost_settlement: None,
            },
        },
    );
    assert!(validate_research_service_policy_v1(&runtime, &digest(9)).is_err());
}
