use hepta_campaign_writer::WriterLeaseV1;
use hepta_control_plane::{
    ControlPlaneSnapshotV1, FilesystemPreparedResultVerifierV1, HardPolicyV1, PlannerPolicyV1,
    PlanningFrontierV1,
};
use hepta_module_platform::*;
use hepta_paper_service::*;
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
        let p = std::env::temp_dir().join(format!(
            "hepta-native-service-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&p).unwrap();
        fs::set_permissions(&p, fs::Permissions::from_mode(0o700)).unwrap();
        Self(p)
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn configuration(temp: &Temp) -> ServiceRunV1 {
    let objects = ObjectStoreV1::open(&temp.0).unwrap();
    let source = objects.put(b"real manuscript bytes\n").unwrap();
    let payload = objects
        .put(
            &serde_json::to_vec(&NativeJobV1::ArtifactInventory {
                artifacts: vec![source.clone()],
            })
            .unwrap(),
        )
        .unwrap();
    let cap = BTreeSet::from(["CAP-BUILD".to_string()]);
    let mut registry = ModuleRegistryV1::new(RegistryPolicyV1 {
        version: 1,
        protocol_version: 1,
        central_writer_module_id: "module.commit-sequencer".into(),
        grants: BTreeMap::from([(
            "module.native-inventory".into(),
            ModuleGrantV1 {
                module_version: "1.0.0".into(),
                authority: AuthorityClassV1::PreparedResultOnly,
                minimum_qualification: QualificationTierV1::Source,
                activation: ActivationStateV1::Shadow,
                capability_ids: cap.clone(),
            },
        )]),
    })
    .unwrap();
    registry
        .register(ModuleManifestV1 {
            version: 1,
            module_id: "module.native-inventory".into(),
            module_version: "1.0.0".into(),
            protocol_min: 1,
            protocol_max: 1,
            module_kind: ModuleKindV1::TrustedInProcess,
            requested_authority: AuthorityClassV1::PreparedResultOnly,
            qualification: QualificationTierV1::Source,
            requested_activation: ActivationStateV1::Shadow,
            capability_ids: cap.iter().cloned().collect(),
            dependencies: vec![],
            primary_owner: "TEAM-KERNEL".into(),
            secondary_owner: "TEAM-RUNTIME".into(),
            independent_reviewer: "TEAM-EVIDENCE".into(),
            rollback_version: "0.9.0".into(),
            execution: ModuleExecutionV1::InProcess {
                implementation_hash: native_implementation_hash_v1().unwrap(),
            },
        })
        .unwrap();
    let registry = registry.finish().unwrap();
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
        memory_bytes: 1024,
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
        constraint_set_hash: hard.policy_hash().unwrap(),
        resource_limit: capacity,
        budget_microusd: 100,
        required_capability_ids: cap,
        random_seed: None,
    };
    let frontier = PlanningFrontierV1 {
        version: 1,
        snapshot_hash: snapshot.snapshot_hash().unwrap(),
        candidates: vec![ActionCandidateV1 {
            version: 1,
            candidate_id: "inventory-1".into(),
            decision_group: "inventory".into(),
            module_id: "module.native-inventory".into(),
            module_version: "1.0.0".into(),
            capability_id: "CAP-BUILD".into(),
            snapshot_hash: snapshot.snapshot_hash().unwrap(),
            dependency_candidate_ids: vec![],
            resources: ResourceVectorV1 {
                cpu_millis: 1,
                memory_bytes: 8,
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
        registry_json: serde_json::to_string(&registry).unwrap(),
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
        workers: BTreeMap::from([("module.native-inventory".into(), WorkerBindingV1::Native)]),
    }
}

#[test]
fn native_bytes_plan_to_durable_sqlite_reopens_and_replays() {
    let temp = Temp::new();
    let config = configuration(&temp);
    let first = run_service_v1(config.clone()).expect("durable actual execution");
    assert_eq!(first.commit_receipts.len(), 1);
    assert!(first.commit_receipts[0].newly_committed);
    assert!(!first.production_activation);
    let second = run_service_v1(config).expect("reopen idempotent committed plan");
    assert!(!second.commit_receipts[0].newly_committed);
    assert_eq!(
        first.commit_receipts[0].committed_state_hash,
        second.commit_receipts[0].committed_state_hash
    );
}

#[test]
fn production_boolean_and_backend_substitution_rejected() {
    let temp = Temp::new();
    let mut config = configuration(&temp);
    config.production_activation = true;
    assert!(run_service_v1(config).is_err());
    let mut config = configuration(&temp);
    config.workers.clear();
    assert!(run_service_v1(config).is_err());
}

#[test]
fn independent_cas_verifier_rejects_tampered_bytes_and_symlink() {
    let temp = Temp::new();
    let objects = ObjectStoreV1::open(&temp.0).unwrap();
    let hash = objects.put(b"valid").unwrap();
    let verifier =
        FilesystemPreparedResultVerifierV1::new(objects.root(), hash.clone(), 1024).unwrap();
    assert_eq!(verifier.read_object(&hash).unwrap(), b"valid");
    let path = objects
        .root()
        .join(hash.to_string().trim_start_matches("sha256:"));
    fs::write(&path, b"other").unwrap();
    assert!(verifier.read_object(&hash).is_err());
    fs::remove_file(&path).unwrap();
    std::os::unix::fs::symlink("/etc/passwd", &path).unwrap();
    assert!(verifier.read_object(&hash).is_err());
}

#[test]
fn cli_executes_json_file_and_returns_receipt() {
    let temp = Temp::new();
    let config = configuration(&temp);
    let path = temp.0.join("run.json");
    fs::write(&path, serde_json::to_vec(&config).unwrap()).unwrap();
    let output = std::process::Command::new(env!("CARGO_BIN_EXE_hepta-paper-rust"))
        .args(["run", path.to_str().unwrap()])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let receipt: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(receipt["productionActivation"], false);
}

#[test]
fn prepared_cache_survives_readmission_with_a_new_reservation_sequence() {
    use hepta_control_plane::{
        AdmissionRequestV1, ExecutionRequestV1, ModuleExecutorV1, ResourceAllocatorV1,
        select_plan_v1,
    };
    let temp = Temp::new();
    let config = configuration(&temp);
    let objects = ObjectStoreV1::open(&temp.0).expect("objects");
    let candidate = config.frontier.candidates[0].clone();
    let plan = select_plan_v1(
        &config.snapshot,
        &config.frontier,
        &config.hard_policy,
        &config.planner_policy,
    )
    .expect("plan");
    let tenant = config.snapshot.campaign_id.clone();
    let mut allocator = ResourceAllocatorV1::new(
        config.snapshot.resource_limit,
        BTreeMap::from([(tenant.clone(), config.snapshot.resource_limit)]),
        BTreeMap::from([(tenant.clone(), 1)]),
        1,
    )
    .expect("allocator");
    let admission = AdmissionRequestV1 {
        reservation_id: "stable-reservation".into(),
        tenant_id: tenant,
        module_id: candidate.module_id.clone(),
        candidate_id: candidate.candidate_id.clone(),
        resources: candidate.resources,
        queued_at_unix_ms: 1_000,
        deadline_unix_ms: None,
    };
    let reservation = allocator
        .reserve(admission.clone(), 1_000)
        .expect("first reservation");
    let mut request = ExecutionRequestV1 {
        version: 1,
        attempt_id: "same-plan-attempt".into(),
        snapshot_hash: config.snapshot.snapshot_hash().unwrap(),
        plan_hash: plan.plan_hash,
        candidate,
        reservation,
    };
    let mut executor = ServiceExecutorV1::new(objects.clone(), config.workers).expect("executor");
    let first = executor
        .execute_batch(&[request.clone()])
        .expect("actual native execution");
    allocator.release("stable-reservation").expect("release");
    let next = allocator.reserve(admission, 1_001).expect("readmit");
    assert_ne!(
        request.reservation.admission_sequence,
        next.admission_sequence
    );
    assert_ne!(request.reservation.reservation_hash, next.reservation_hash);
    request.reservation = next;
    // A fresh execution would now fail because the inventory source is absent.
    // Its prepared inventory/evidence remain present, so a real cache hit works.
    fs::remove_file(
        objects.root().join(
            config
                .initial_state_hash
                .to_string()
                .trim_start_matches("sha256:"),
        ),
    )
    .unwrap();
    let replay = executor
        .execute_batch(&[request])
        .expect("prepared replay, no second execution");
    assert_eq!(first, replay);
    assert_eq!(fs::read_dir(temp.0.join("attempts")).unwrap().count(), 2);
}

#[test]
fn pinned_process_multiple_artifacts_form_a_valid_unique_canonical_result() {
    use hepta_control_plane::{
        AdmissionRequestV1, ExecutionRequestV1, ModuleExecutorV1, ResourceAllocatorV1,
        select_plan_v1,
    };
    use sha2::{Digest, Sha256};
    let temp = Temp::new();
    let mut config = configuration(&temp);
    let objects = ObjectStoreV1::open(&temp.0).unwrap();
    let script = temp.0.join("worker.py");
    let script_bytes = b"import sys\nsys.stdout.write('{\"version\":1,\"artifacts\":[\"YQ==\",\"Yg==\",\"YQ==\"],\"evidence\":{\"fixture\":true},\"externalActionMayHaveStarted\":false}')\n";
    fs::write(&script, script_bytes).unwrap();
    fs::set_permissions(&script, fs::Permissions::from_mode(0o600)).unwrap();
    let executable =
        fs::canonicalize("/usr/bin/python3").expect("system Python for pinned worker fixture");
    let hash = |bytes: &[u8]| {
        format!("sha256:{}", hex::encode(Sha256::digest(bytes)))
            .parse()
            .unwrap()
    };
    let binding = WorkerBindingV1::Process {
        executable_hash: hash(&fs::read(&executable).unwrap()),
        executable,
        arguments: vec![script.to_str().unwrap().into()],
        code_files: BTreeMap::from([(script, hash(script_bytes))]),
        working_directory: temp.0.clone(),
        implementation_language: "python".into(),
        timeout_ms: 5_000,
        network_declared: false,
    };
    config.frontier.candidates[0].payload_hash = objects
        .put(
            &serde_json::to_vec(&NativeJobV1::Process {
                input: serde_json::json!({"test":"multiple-artifact-contract"}),
            })
            .unwrap(),
        )
        .unwrap();
    let candidate = config.frontier.candidates[0].clone();
    let plan = select_plan_v1(
        &config.snapshot,
        &config.frontier,
        &config.hard_policy,
        &config.planner_policy,
    )
    .unwrap();
    let tenant = config.snapshot.campaign_id.clone();
    let mut allocator = ResourceAllocatorV1::new(
        config.snapshot.resource_limit,
        BTreeMap::from([(tenant.clone(), config.snapshot.resource_limit)]),
        BTreeMap::from([(tenant.clone(), 1)]),
        1,
    )
    .unwrap();
    let reservation = allocator
        .reserve(
            AdmissionRequestV1 {
                reservation_id: "process-reservation".into(),
                tenant_id: tenant,
                module_id: candidate.module_id.clone(),
                candidate_id: candidate.candidate_id.clone(),
                resources: candidate.resources,
                queued_at_unix_ms: 1_000,
                deadline_unix_ms: None,
            },
            1_000,
        )
        .unwrap();
    let request = ExecutionRequestV1 {
        version: 1,
        attempt_id: "process-attempt".into(),
        snapshot_hash: config.snapshot.snapshot_hash().unwrap(),
        plan_hash: plan.plan_hash.clone(),
        candidate: candidate.clone(),
        reservation,
    };
    let mut executor = ServiceExecutorV1::new(
        objects.clone(),
        BTreeMap::from([(candidate.module_id.clone(), binding)]),
    )
    .unwrap();
    let results = executor
        .execute_batch(&[request])
        .expect("real pinned process produces multiple artifacts");
    assert_eq!(results[0].artifact_hashes.len(), 2);
    results[0]
        .validate(&candidate, &plan.plan_hash)
        .expect("sorted unique PreparedResult contract");
    let bytes: BTreeSet<Vec<u8>> = results[0]
        .artifact_hashes
        .iter()
        .map(|hash| objects.read(hash).unwrap())
        .collect();
    assert_eq!(bytes, BTreeSet::from([b"a".to_vec(), b"b".to_vec()]));
}

#[test]
fn native_database_inspection_pins_bytes_and_replays_the_historical_input() {
    use sha2::{Digest, Sha256};
    let temp = Temp::new();
    let mut config = configuration(&temp);
    let fixtures = temp.0.join("native-fixtures");
    let generator = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../tools/create-node-store-compat-fixtures.mjs");
    let output = std::process::Command::new(
        std::env::var_os("HEPTA_NODE_BINARY").unwrap_or_else(|| "node".into()),
    )
    .arg(generator)
    .arg(&fixtures)
    .output()
    .expect("production Node fixture creator");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let path = fixtures.join("node-v25.sqlite");
    let expected = format!(
        "sha256:{}",
        hex::encode(Sha256::digest(fs::read(&path).unwrap()))
    )
    .parse()
    .unwrap();
    let objects = ObjectStoreV1::open(&temp.0).unwrap();
    let bad_payload = NativeJobV1::InspectNodeDatabase {
        path: path.clone(),
        expected_database_hash: config.initial_state_hash.clone(),
    };
    config.frontier.candidates[0].payload_hash = objects
        .put(&serde_json::to_vec(&bad_payload).unwrap())
        .unwrap();
    assert!(
        run_service_v1(config.clone()).is_err(),
        "valid Node schema with wrong exact byte hash must fail"
    );
    let good_payload = NativeJobV1::InspectNodeDatabase {
        path: path.clone(),
        expected_database_hash: expected,
    };
    config.frontier.candidates[0].payload_hash = objects
        .put(&serde_json::to_vec(&good_payload).unwrap())
        .unwrap();
    let first =
        run_service_v1(config.clone()).expect("exact pinned production Node DB inspected in Rust");
    fs::remove_file(path).unwrap();
    let replay =
        run_service_v1(config).expect("replay references original pinned input and stored output");
    assert!(!replay.commit_receipts[0].newly_committed);
    assert_eq!(
        first.commit_receipts[0].result_hash,
        replay.commit_receipts[0].result_hash
    );
}
