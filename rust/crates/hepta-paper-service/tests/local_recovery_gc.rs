//! Real workflow fixtures for immutable recovery and quarantine-GC tests.
use hepta_campaign_writer::{CampaignStateV1, WriterLeaseV1};
use hepta_control_plane::{
    ControlPlaneSnapshotV1, HardPolicyV1, PlannerPolicyV1, PlanningFrontierV1,
};
use hepta_module_platform::*;
use hepta_paper_service::workflow::*;
use hepta_paper_service::*;
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::Command,
    sync::atomic::{AtomicU64, Ordering},
};

static NEXT: AtomicU64 = AtomicU64::new(1);
struct Temp(PathBuf);
impl Temp {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "hepta-workflow-{}-{}",
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
fn steps() -> Vec<WorkflowStepV1> {
    serde_json::from_slice(include_bytes!(
        "../../../../docs/modules/examples/local-workflow-steps.v1.json"
    ))
    .unwrap()
}
fn definition(temp: &Temp) -> LocalWorkflowV1 {
    LocalWorkflowV1 {
        version: 1,
        template: template(&temp.state(), WorkerBindingV1::Native).unwrap(),
        steps: steps(),
    }
}
fn fixture() -> (Temp, hepta_codex_protocol::Sha256Digest) {
    let temp = Temp::new();
    let hash = initialize_local_workflow_v1(definition(&temp)).unwrap();
    (temp, hash)
}
fn status(temp: &Temp, hash: &hepta_codex_protocol::Sha256Digest) -> WorkflowProgressV1 {
    operate_local_workflow_v1(&temp.state(), hash, WorkflowActionV1::Status, 0).unwrap()
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

#[path = "workflow_extensions/recovery.rs"]
mod recovery;

#[path = "workflow_extensions/gc.rs"]
mod gc;

#[path = "workflow_extensions/purge.rs"]
mod purge;

#[path = "workflow_extensions/reconcile.rs"]
mod reconcile;
