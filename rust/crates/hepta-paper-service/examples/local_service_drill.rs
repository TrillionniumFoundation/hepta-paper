//! Disposable real-byte control/service replay, never a production activation.
use hepta_campaign_writer::WriterLeaseV1;
use hepta_control_plane::{
    ControlPlaneSnapshotV1, HardPolicyV1, PlannerPolicyV1, PlanningFrontierV1,
};
use hepta_module_platform::*;
use hepta_paper_service::*;
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    os::unix::fs::DirBuilderExt,
    path::{Path, PathBuf},
};

fn configuration(state: &Path) -> Result<ServiceRunV1, Box<dyn std::error::Error>> {
    let objects = ObjectStoreV1::open(state)?;
    let source = objects.put(b"real manuscript bytes\n")?;
    let payload = objects.put(&serde_json::to_vec(&NativeJobV1::ArtifactInventory {
        artifacts: vec![source.clone()],
    })?)?;
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
    })?;
    registry.register(ModuleManifestV1 {
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
            implementation_hash: native_implementation_hash_v1()?,
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
        constraint_set_hash: hard.policy_hash()?,
        resource_limit: capacity,
        budget_microusd: 100,
        required_capability_ids: cap,
        random_seed: None,
    };
    let frontier = PlanningFrontierV1 {
        version: 1,
        snapshot_hash: snapshot.snapshot_hash()?,
        candidates: vec![ActionCandidateV1 {
            version: 1,
            candidate_id: "inventory-1".into(),
            decision_group: "inventory".into(),
            module_id: "module.native-inventory".into(),
            module_version: "1.0.0".into(),
            capability_id: "CAP-BUILD".into(),
            snapshot_hash: snapshot.snapshot_hash()?,
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
        workers: BTreeMap::from([("module.native-inventory".into(), WorkerBindingV1::Native)]),
    })
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let path = PathBuf::from(
        std::env::args()
            .nth(1)
            .ok_or("supply a new absolute disposable state directory")?,
    );
    if !path.is_absolute() || path.exists() {
        return Err("directory must be absolute and absent".into());
    }
    fs::DirBuilder::new().mode(0o700).create(&path)?;
    let config = configuration(&path)?;
    let config_path = path.join("run.json");
    fs::write(&config_path, serde_json::to_vec_pretty(&config)?)?;
    let first = run_service_v1(config.clone())?;
    let replay = run_service_v1(config)?;
    if first.commit_receipts.len() != 1
        || !first.commit_receipts[0].newly_committed
        || replay.commit_receipts.len() != 1
        || replay.commit_receipts[0].newly_committed
        || first.commit_receipts[0].committed_state_hash
            != replay.commit_receipts[0].committed_state_hash
    {
        return Err("persistent replay mismatch".into());
    }
    println!(
        "{}",
        serde_json::json!({"status":"local_service_drill_passed","productionActivation":false,
        "configuration":config_path,"first":first,"replay":replay})
    );
    Ok(())
}
