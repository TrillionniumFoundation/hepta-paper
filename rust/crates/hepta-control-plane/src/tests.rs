use std::{
    cell::RefCell,
    collections::{BTreeMap, BTreeSet},
    rc::Rc,
    str::FromStr,
};

use hepta_codex_protocol::Sha256Digest;
use hepta_module_platform::{
    ActionCandidateV1, ActivationStateV1, AuthorityClassV1, ModuleExecutionV1, ModuleGrantV1,
    ModuleKindV1, ModuleManifestV1, ModuleRegistryArtifactV1, ModuleRegistryV1,
    PreparedResultStatusV1, PreparedResultV1, QualificationTierV1, RegistryPolicyV1,
    ResourceVectorV1,
};

use crate::*;

#[derive(Debug)]
struct FakeExecutorV1;

impl ModuleExecutorV1 for FakeExecutorV1 {
    fn execute_batch(
        &mut self,
        requests: &[ExecutionRequestV1],
    ) -> Result<Vec<PreparedResultV1>, ControlPlaneError> {
        requests.iter().map(prepared_result).collect()
    }
}

#[derive(Clone, Debug)]
struct RecordingExecutorV1 {
    batches: Rc<RefCell<Vec<Vec<String>>>>,
}

impl ModuleExecutorV1 for RecordingExecutorV1 {
    fn execute_batch(
        &mut self,
        requests: &[ExecutionRequestV1],
    ) -> Result<Vec<PreparedResultV1>, ControlPlaneError> {
        self.batches.borrow_mut().push(
            requests
                .iter()
                .map(|request| request.candidate.candidate_id.clone())
                .collect(),
        );
        requests.iter().map(prepared_result).collect()
    }
}

fn prepared_result(request: &ExecutionRequestV1) -> Result<PreparedResultV1, ControlPlaneError> {
    Ok(PreparedResultV1 {
        version: 1,
        attempt_id: request.attempt_id.clone(),
        snapshot_hash: request.snapshot_hash.clone(),
        plan_hash: request.plan_hash.clone(),
        candidate_hash: request
            .candidate
            .candidate_hash()
            .map_err(|_| ControlPlaneError::ExecutionInvalid)?,
        module_id: request.candidate.module_id.clone(),
        module_version: request.candidate.module_version.clone(),
        status: PreparedResultStatusV1::Prepared,
        artifact_hashes: vec![digest('e')],
        actual_resources: request.candidate.resources,
        actual_cost_microusd: request.candidate.cost_microusd,
        evidence_hash: digest('f'),
        external_action_may_have_started: false,
    })
}

fn digest(marker: char) -> Sha256Digest {
    Sha256Digest::from_str(&format!("sha256:{}", marker.to_string().repeat(64)))
        .expect("test digest")
}

fn registry() -> ModuleRegistryArtifactV1 {
    let capabilities = BTreeSet::from(["CAP-MOD-EXECUTION".to_owned(), "CAP-SCH-PLAN".to_owned()]);
    let policy = RegistryPolicyV1 {
        version: 1,
        protocol_version: 1,
        central_writer_module_id: "module.commit-sequencer".to_owned(),
        grants: BTreeMap::from([(
            "module.fake-executor".to_owned(),
            ModuleGrantV1 {
                module_version: "1.0.0".to_owned(),
                authority: AuthorityClassV1::PreparedResultOnly,
                minimum_qualification: QualificationTierV1::Source,
                activation: ActivationStateV1::Shadow,
                capability_ids: capabilities.clone(),
            },
        )]),
    };
    let mut registry = ModuleRegistryV1::new(policy).expect("registry policy");
    registry
        .register(ModuleManifestV1 {
            version: 1,
            module_id: "module.fake-executor".to_owned(),
            module_version: "1.0.0".to_owned(),
            protocol_min: 1,
            protocol_max: 1,
            module_kind: ModuleKindV1::TrustedInProcess,
            requested_authority: AuthorityClassV1::PreparedResultOnly,
            qualification: QualificationTierV1::Source,
            requested_activation: ActivationStateV1::Shadow,
            capability_ids: capabilities.into_iter().collect(),
            dependencies: Vec::new(),
            primary_owner: "TEAM-KERNEL".to_owned(),
            secondary_owner: "TEAM-RUNTIME".to_owned(),
            independent_reviewer: "TEAM-EVIDENCE".to_owned(),
            rollback_version: "0.9.0".to_owned(),
            execution: ModuleExecutionV1::InProcess {
                implementation_hash: digest('a'),
            },
        })
        .expect("module manifest");
    registry.finish().expect("registry artifact")
}

fn candidate(
    candidate_id: &str,
    capability_id: &str,
    decision_group: &str,
    dependency_candidate_ids: Vec<String>,
    snapshot_hash: Sha256Digest,
    utility_micros: i64,
) -> ActionCandidateV1 {
    ActionCandidateV1 {
        version: 1,
        candidate_id: candidate_id.to_owned(),
        decision_group: decision_group.to_owned(),
        module_id: "module.fake-executor".to_owned(),
        module_version: "1.0.0".to_owned(),
        capability_id: capability_id.to_owned(),
        snapshot_hash,
        dependency_candidate_ids,
        resources: ResourceVectorV1 {
            cpu_millis: 10,
            memory_bytes: 64,
            tokens: 10,
            ..ResourceVectorV1::default()
        },
        utility_micros,
        cost_microusd: 10,
        uncertainty_ppm: 0,
        evidence_tier: QualificationTierV1::Source,
        payload_hash: digest('b'),
    }
}

fn vertical_fixture() -> (
    ModuleRegistryArtifactV1,
    HardPolicyV1,
    ResourceVectorV1,
    ControlPlaneSnapshotV1,
    PlanningFrontierV1,
) {
    let registry = registry();
    let hard_policy = HardPolicyV1 {
        version: 1,
        policy_id: "hard-policy-v1".to_owned(),
        forbidden_module_ids: BTreeSet::new(),
        minimum_evidence_by_capability: BTreeMap::new(),
        external_actions_authorized: false,
        maximum_central_writer_turns: 0,
        maximum_candidates_per_decision_group: 4,
    };
    let resource_limit = ResourceVectorV1 {
        cpu_millis: 100,
        memory_bytes: 1_024,
        tokens: 100,
        ..ResourceVectorV1::default()
    };
    let snapshot = ControlPlaneSnapshotV1 {
        version: 1,
        campaign_id: "campaign-1".to_owned(),
        campaign_revision: 1,
        state_hash: digest('1'),
        registry_hash: registry.registry_hash.clone(),
        objective_version: "objective-v1".to_owned(),
        constraint_set_hash: hard_policy.policy_hash().expect("policy hash"),
        resource_limit,
        budget_microusd: 100,
        required_capability_ids: BTreeSet::from([
            "CAP-MOD-EXECUTION".to_owned(),
            "CAP-SCH-PLAN".to_owned(),
        ]),
        random_seed: Some(7),
    };
    let snapshot_hash = snapshot.snapshot_hash().expect("snapshot hash");
    let frontier = PlanningFrontierV1 {
        version: 1,
        snapshot_hash: snapshot_hash.clone(),
        candidates: vec![
            candidate(
                "candidate-execute",
                "CAP-MOD-EXECUTION",
                "execution",
                Vec::new(),
                snapshot_hash.clone(),
                100,
            ),
            candidate(
                "candidate-plan",
                "CAP-SCH-PLAN",
                "planning",
                vec!["candidate-execute".to_owned()],
                snapshot_hash,
                50,
            ),
        ],
    };
    (registry, hard_policy, resource_limit, snapshot, frontier)
}

fn allocator(resource_limit: ResourceVectorV1) -> ResourceAllocatorV1 {
    ResourceAllocatorV1::new(
        resource_limit,
        BTreeMap::from([("tenant-1".to_owned(), resource_limit)]),
        BTreeMap::from([("tenant-1".to_owned(), 1)]),
        1,
    )
    .expect("allocator")
}

fn planner_policy() -> PlannerPolicyV1 {
    PlannerPolicyV1 {
        version: 1,
        maximum_exact_candidates: 20,
        cost_weight_ppm: 0,
        uncertainty_weight_micros_per_ppm: 0,
        maximum_selected_candidates: 8,
    }
}

#[test]
fn fake_provider_vertical_slice_is_deterministic_and_non_activating() {
    let (registry, hard_policy, resource_limit, snapshot, frontier) = vertical_fixture();
    let verifier = DeterministicPreparedResultVerifierV1::new(digest('c'));
    let sequencer = FixtureCommitSequencerV1::new(snapshot.state_hash.clone());
    let events = BoundedEventLogV1::new(64, 64).expect("events");
    let mut control = ControlPlaneV1::new(
        registry,
        hard_policy,
        planner_policy(),
        allocator(resource_limit),
        FakeExecutorV1,
        verifier,
        sequencer,
        events,
    )
    .expect("control plane");
    let receipt = control
        .run(&snapshot, &frontier, "tenant-1", 1_000)
        .expect("vertical slice");
    assert_eq!(receipt.commit_receipts.len(), 2);
    assert!(
        receipt
            .commit_receipts
            .iter()
            .all(|row| row.newly_committed)
    );
    assert!(!receipt.automatic_activation);
    assert!(!receipt.production_activation);
    assert!(receipt.resource_report.reserved.is_zero());
    assert_eq!(receipt.resource_report.reservation_count, 0);
    assert_eq!(control.events().len(), 13);
}

#[test]
fn dependent_candidates_execute_in_topological_waves() {
    let (registry, hard_policy, resource_limit, snapshot, frontier) = vertical_fixture();
    let batches = Rc::new(RefCell::new(Vec::new()));
    let executor = RecordingExecutorV1 {
        batches: batches.clone(),
    };
    let mut control = ControlPlaneV1::new(
        registry,
        hard_policy,
        planner_policy(),
        allocator(resource_limit),
        executor,
        DeterministicPreparedResultVerifierV1::new(digest('c')),
        FixtureCommitSequencerV1::new(snapshot.state_hash.clone()),
        BoundedEventLogV1::new(64, 64).expect("events"),
    )
    .expect("control plane");
    control
        .run(&snapshot, &frontier, "tenant-1", 1_000)
        .expect("vertical slice");
    let recorded = batches.borrow();
    assert_eq!(
        recorded.as_slice(),
        &[
            vec!["candidate-execute".to_owned()],
            vec!["candidate-plan".to_owned()],
        ]
    );
}

#[test]
fn observability_capacity_is_reserved_before_execution() {
    let (registry, hard_policy, resource_limit, snapshot, frontier) = vertical_fixture();
    let batches = Rc::new(RefCell::new(Vec::new()));
    let executor = RecordingExecutorV1 {
        batches: batches.clone(),
    };
    let mut control = ControlPlaneV1::new(
        registry,
        hard_policy,
        planner_policy(),
        allocator(resource_limit),
        executor,
        DeterministicPreparedResultVerifierV1::new(digest('c')),
        FixtureCommitSequencerV1::new(snapshot.state_hash.clone()),
        BoundedEventLogV1::new(12, 12).expect("events"),
    )
    .expect("control plane");
    assert_eq!(
        control.run(&snapshot, &frontier, "tenant-1", 1_000),
        Err(ControlPlaneError::ObservabilityBudgetExceeded)
    );
    assert!(batches.borrow().is_empty());
    assert!(control.events().is_empty());
}

fn verified_result(plan_hash: Sha256Digest, result_marker: char) -> VerifiedPreparedResultV1 {
    VerifiedPreparedResultV1::new(
        PreparedResultV1 {
            version: 1,
            attempt_id: format!("attempt-{result_marker}"),
            snapshot_hash: digest('1'),
            plan_hash,
            candidate_hash: digest('3'),
            module_id: "module.fake-executor".to_owned(),
            module_version: "1.0.0".to_owned(),
            status: PreparedResultStatusV1::Prepared,
            artifact_hashes: vec![digest('4')],
            actual_resources: ResourceVectorV1::default(),
            actual_cost_microusd: 0,
            evidence_hash: digest('5'),
            external_action_may_have_started: false,
        },
        digest('7'),
    )
    .expect("verified result")
}

#[test]
fn commit_sequencer_is_idempotent_and_monotonic_per_plan() {
    let plan_one = digest('2');
    let request = CommitRequestV1::new(
        plan_one.clone(),
        1,
        verified_result(plan_one.clone(), '6'),
    )
    .expect("commit request");
    let mut sequencer = FixtureCommitSequencerV1::new(digest('0'));
    let first = sequencer.commit(request.clone()).expect("first commit");
    assert!(first.newly_committed);
    let replay = sequencer.commit(request.clone()).expect("idempotent replay");
    assert!(!replay.newly_committed);
    assert_eq!(replay.committed_state_hash, first.committed_state_hash);

    let conflicting_replay =
        CommitRequestV1::new(plan_one.clone(), 2, verified_result(plan_one, '6'))
            .expect("conflicting replay command");
    assert_eq!(
        sequencer.commit(conflicting_replay),
        Err(ControlPlaneError::CommitInvalid)
    );

    let plan_two = digest('8');
    let second_plan = sequencer
        .commit(
            CommitRequestV1::new(plan_two.clone(), 1, verified_result(plan_two, '9'))
                .expect("second plan request"),
        )
        .expect("second plan begins at sequence one");
    assert!(second_plan.newly_committed);
    assert_ne!(second_plan.committed_state_hash, first.committed_state_hash);
}

#[test]
fn bounded_event_log_rejects_cardinality_overflow() {
    let mut log = BoundedEventLogV1::new(2, 1).expect("event log");
    let event = |subject_hash| ControlPlaneEventV1 {
        ordinal: 0,
        kind: ControlPlaneEventKindV1::SnapshotFrozen,
        snapshot_hash: digest('1'),
        plan_hash: None,
        candidate_id: None,
        module_id: None,
        reservation_id: None,
        subject_hash,
    };
    log.push(event(digest('2'))).expect("first event");
    assert_eq!(
        log.ensure_capacity(1, 1),
        Err(ControlPlaneError::ObservabilityBudgetExceeded)
    );
    assert_eq!(
        log.push(event(digest('3'))),
        Err(ControlPlaneError::ObservabilityBudgetExceeded)
    );
}
