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

fn fixture_subject() -> (
    ModuleRegistryArtifactV1,
    HardPolicyV1,
    ControlPlaneSnapshotV1,
    PlanningFrontierV1,
    ResourceVectorV1,
) {
    let registry = registry();
    let hard_policy = HardPolicyV1 {
        version: 1,
        policy_id: "hard-policy-v1".to_owned(),
        registry_policy_hash: registry.policy_hash().clone(),
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
        registry_hash: registry.registry_hash().clone(),
        registry_policy_hash: registry.policy_hash().clone(),
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
    (registry, hard_policy, snapshot, frontier, resource_limit)
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

fn control_plane(
    event_limit: usize,
    sequencer: FixtureCommitSequencerV1,
) -> (
    ControlPlaneV1<FakeExecutorV1, DeterministicPreparedResultVerifierV1, FixtureCommitSequencerV1>,
    ControlPlaneSnapshotV1,
    PlanningFrontierV1,
) {
    let (registry, hard_policy, snapshot, frontier, resource_limit) = fixture_subject();
    let expected_registry_policy_hash = registry.policy_hash().clone();
    let verifier = DeterministicPreparedResultVerifierV1::new(digest('c'));
    let events = BoundedEventLogV1::new(event_limit, event_limit).expect("events");
    let control = ControlPlaneV1::new(
        registry,
        expected_registry_policy_hash,
        hard_policy,
        planner_policy(),
        allocator(resource_limit),
        FakeExecutorV1,
        verifier,
        sequencer,
        events,
    )
    .expect("control plane");
    (control, snapshot, frontier)
}

fn standalone_verified(
    verifier_hash: Sha256Digest,
    plan_hash: Sha256Digest,
    marker: char,
) -> VerifiedPreparedResultV1 {
    let candidate = ActionCandidateV1 {
        version: 1,
        candidate_id: format!("candidate-{marker}"),
        decision_group: format!("group-{marker}"),
        module_id: "module.fake-executor".to_owned(),
        module_version: "1.0.0".to_owned(),
        capability_id: "CAP-MOD-EXECUTION".to_owned(),
        snapshot_hash: digest('1'),
        dependency_candidate_ids: Vec::new(),
        resources: ResourceVectorV1 {
            cpu_millis: 1,
            ..ResourceVectorV1::default()
        },
        utility_micros: 1,
        cost_microusd: 1,
        uncertainty_ppm: 0,
        evidence_tier: QualificationTierV1::Source,
        payload_hash: digest(marker),
    };
    let plan = PlanCertificateV1 {
        version: 1,
        snapshot_hash: candidate.snapshot_hash.clone(),
        frontier_hash: digest('2'),
        hard_policy_hash: digest('3'),
        planner_policy_hash: digest('4'),
        objective_version: "objective-v1".to_owned(),
        selected_candidate_ids: vec![candidate.candidate_id.clone()],
        total_resources: candidate.resources,
        total_cost_microusd: candidate.cost_microusd,
        objective_micros: 1,
        upper_bound_micros: Some(1),
        optimality_gap_micros: Some(0),
        mode: PlanModeV1::ExactOptimum,
        fallback_reason: None,
        plan_hash: plan_hash.clone(),
    };
    let result = PreparedResultV1 {
        version: 1,
        attempt_id: format!("attempt-{marker}"),
        snapshot_hash: candidate.snapshot_hash.clone(),
        plan_hash,
        candidate_hash: candidate.candidate_hash().expect("candidate hash"),
        module_id: candidate.module_id.clone(),
        module_version: candidate.module_version.clone(),
        status: PreparedResultStatusV1::Prepared,
        artifact_hashes: vec![digest('e')],
        actual_resources: candidate.resources,
        actual_cost_microusd: candidate.cost_microusd,
        evidence_hash: digest('f'),
        external_action_may_have_started: false,
    };
    DeterministicPreparedResultVerifierV1::new(verifier_hash)
        .verify(result, &candidate, &plan)
        .expect("verified result")
}

#[test]
fn control_plane_requires_an_independently_selected_registry_policy_hash() {
    let (registry, hard_policy, _snapshot, _frontier, resource_limit) = fixture_subject();
    let verifier_hash = digest('c');
    let verifier = DeterministicPreparedResultVerifierV1::new(verifier_hash.clone());
    let sequencer = FixtureCommitSequencerV1::new(digest('0'), verifier_hash);
    let events = BoundedEventLogV1::new(64, 64).expect("events");
    assert_eq!(
        ControlPlaneV1::new(
            registry,
            digest('9'),
            hard_policy,
            planner_policy(),
            allocator(resource_limit),
            FakeExecutorV1,
            verifier,
            sequencer,
            events,
        )
        .map(|_| ()),
        Err(ControlPlaneError::ModulePlatformRejected)
    );
}

#[test]
fn fake_provider_vertical_slice_is_deterministic_and_non_activating() {
    let verifier_hash = digest('c');
    let sequencer = FixtureCommitSequencerV1::new(digest('0'), verifier_hash);
    let (mut control, snapshot, frontier) = control_plane(64, sequencer);
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
    assert_eq!(receipt.resource_report.last_observed_unix_ms, Some(1_000));
    assert_eq!(control.events().len(), 13);
    assert_eq!(control.sequencer().receipt_count(), 2);
}

#[test]
fn commit_sequencer_authenticates_result_hash_verifier_and_receipt() {
    let verifier_hash = digest('7');
    let plan_hash = digest('2');
    let verified = standalone_verified(verifier_hash.clone(), plan_hash.clone(), '6');
    let request = CommitRequestV1::new(plan_hash, verified.clone()).expect("request");
    let mut sequencer = FixtureCommitSequencerV1::new(digest('0'), verifier_hash.clone());
    let first = sequencer.commit(request.clone()).expect("first commit");
    assert!(first.newly_committed);
    let replay = sequencer.commit(request).expect("idempotent replay");
    assert!(!replay.newly_committed);
    assert_eq!(replay.committed_state_hash, first.committed_state_hash);

    let initial = digest('0');
    let mut wrong_result_hash = verified.clone();
    wrong_result_hash.result_hash = digest('8');
    let mut rejected = FixtureCommitSequencerV1::new(initial.clone(), verifier_hash.clone());
    assert_eq!(
        rejected.commit(CommitRequestV1::new(digest('2'), wrong_result_hash).expect("request")),
        Err(ControlPlaneError::CommitInvalid)
    );
    assert_eq!(rejected.current_state_hash(), &initial);

    let mut modified_result = verified.clone();
    modified_result.result.module_version = "9.9.9".to_owned();
    assert_eq!(
        rejected.commit(CommitRequestV1::new(digest('2'), modified_result).expect("request")),
        Err(ControlPlaneError::CommitInvalid)
    );

    let mut wrong_verifier = verified.clone();
    wrong_verifier.verifier_hash = digest('9');
    wrong_verifier.verification_receipt_hash =
        verification_receipt_hash_v1(&wrong_verifier.result_hash, &wrong_verifier.verifier_hash)
            .expect("receipt hash");
    assert_eq!(
        rejected.commit(CommitRequestV1::new(digest('2'), wrong_verifier).expect("request")),
        Err(ControlPlaneError::CommitInvalid)
    );
    assert_eq!(rejected.receipt_count(), 0);
}

#[test]
fn commit_batch_failure_is_atomic_at_commit_n() {
    let verifier_hash = digest('7');
    let plan_hash = digest('2');
    let requests = vec![
        CommitRequestV1::new(
            plan_hash.clone(),
            standalone_verified(verifier_hash.clone(), plan_hash.clone(), '6'),
        )
        .expect("first request"),
        CommitRequestV1::new(
            plan_hash.clone(),
            standalone_verified(verifier_hash.clone(), plan_hash, '8'),
        )
        .expect("second request"),
    ];
    let initial = digest('0');
    let mut sequencer =
        FixtureCommitSequencerV1::with_failure_at(initial.clone(), verifier_hash, 2);
    assert_eq!(
        sequencer.commit_batch(&requests),
        Err(ControlPlaneError::CommitInvalid)
    );
    assert_eq!(sequencer.current_state_hash(), &initial);
    assert_eq!(sequencer.next_sequence(), 1);
    assert_eq!(sequencer.receipt_count(), 0);
}

#[test]
fn commit_batch_rejects_duplicate_results_and_mixed_plans_atomically() {
    let verifier_hash = digest('7');
    let plan_hash = digest('2');
    let first = CommitRequestV1::new(
        plan_hash.clone(),
        standalone_verified(verifier_hash.clone(), plan_hash.clone(), '6'),
    )
    .expect("first request");
    let mixed = CommitRequestV1::new(
        digest('3'),
        standalone_verified(verifier_hash.clone(), digest('3'), '8'),
    )
    .expect("mixed request");
    let initial = digest('0');
    let mut sequencer = FixtureCommitSequencerV1::new(initial.clone(), verifier_hash);

    assert_eq!(
        sequencer.commit_batch(&[first.clone(), first.clone()]),
        Err(ControlPlaneError::CommitInvalid)
    );
    assert_eq!(
        sequencer.commit_batch(&[first, mixed]),
        Err(ControlPlaneError::CommitInvalid)
    );
    assert_eq!(sequencer.current_state_hash(), &initial);
    assert_eq!(sequencer.next_sequence(), 1);
    assert_eq!(sequencer.receipt_count(), 0);
}

#[test]
fn commit_batch_retry_and_mixed_replay_are_idempotent() {
    let verifier_hash = digest('7');
    let plan_hash = digest('2');
    let first_verified = standalone_verified(verifier_hash.clone(), plan_hash.clone(), '6');
    let second_verified = standalone_verified(verifier_hash.clone(), plan_hash.clone(), '8');
    let first_request =
        CommitRequestV1::new(plan_hash.clone(), first_verified).expect("first request");
    let second_request =
        CommitRequestV1::new(plan_hash.clone(), second_verified).expect("second request");

    let mut sequencer = FixtureCommitSequencerV1::new(digest('0'), verifier_hash);
    let first_receipt = sequencer
        .commit(first_request.clone())
        .expect("first commit");
    assert_eq!(first_receipt.sequence, 1);

    let mixed = sequencer
        .commit_batch(&[first_request.clone(), second_request.clone()])
        .expect("mixed replay and new commit");
    assert_eq!(mixed.len(), 2);
    assert!(!mixed[0].newly_committed);
    assert_eq!(mixed[0].sequence, 1);
    assert!(mixed[1].newly_committed);
    assert_eq!(mixed[1].sequence, 2);
    let committed_state = sequencer.current_state_hash().clone();
    assert_eq!(sequencer.next_sequence(), 3);

    let replay = sequencer
        .commit_batch(&[first_request, second_request])
        .expect("whole-batch replay");
    assert!(replay.iter().all(|receipt| !receipt.newly_committed));
    assert_eq!(replay[0].sequence, 1);
    assert_eq!(replay[1].sequence, 2);
    assert_eq!(sequencer.current_state_hash(), &committed_state);
    assert_eq!(sequencer.next_sequence(), 3);
}

#[test]
fn observability_capacity_is_reserved_before_execution_or_state_mutation() {
    let (registry, hard_policy, snapshot, frontier, resource_limit) = fixture_subject();
    let expected_registry_policy_hash = registry.policy_hash().clone();
    let verifier_hash = digest('c');
    let verifier = DeterministicPreparedResultVerifierV1::new(verifier_hash.clone());
    let initial = digest('0');
    let sequencer = FixtureCommitSequencerV1::new(initial.clone(), verifier_hash);
    let batches = Rc::new(RefCell::new(Vec::new()));
    let executor = RecordingExecutorV1 {
        batches: Rc::clone(&batches),
    };
    let events = BoundedEventLogV1::new(12, 12).expect("events");
    let mut control = ControlPlaneV1::new(
        registry,
        expected_registry_policy_hash,
        hard_policy,
        planner_policy(),
        allocator(resource_limit),
        executor,
        verifier,
        sequencer,
        events,
    )
    .expect("control plane");

    assert_eq!(
        control.run(&snapshot, &frontier, "tenant-1", 1_000),
        Err(ControlPlaneError::ObservabilityBudgetExceeded)
    );
    assert!(batches.borrow().is_empty());
    assert!(control.events().is_empty());
    assert_eq!(control.sequencer().current_state_hash(), &initial);
    assert_eq!(control.sequencer().receipt_count(), 0);
    let report = control.resource_report().expect("resource report");
    assert!(report.reserved.is_zero());
    assert_eq!(report.reservation_count, 0);
    assert_eq!(report.last_observed_unix_ms, None);
}

#[test]
fn dependent_candidates_execute_in_deterministic_topological_waves() {
    let (registry, hard_policy, snapshot, frontier, resource_limit) = fixture_subject();
    let expected_registry_policy_hash = registry.policy_hash().clone();
    let verifier_hash = digest('c');
    let verifier = DeterministicPreparedResultVerifierV1::new(verifier_hash.clone());
    let sequencer = FixtureCommitSequencerV1::new(digest('0'), verifier_hash);
    let batches = Rc::new(RefCell::new(Vec::new()));
    let executor = RecordingExecutorV1 {
        batches: Rc::clone(&batches),
    };
    let events = BoundedEventLogV1::new(64, 64).expect("events");
    let mut control = ControlPlaneV1::new(
        registry,
        expected_registry_policy_hash,
        hard_policy,
        planner_policy(),
        allocator(resource_limit),
        executor,
        verifier,
        sequencer,
        events,
    )
    .expect("control plane");

    control
        .run(&snapshot, &frontier, "tenant-1", 1_000)
        .expect("vertical slice");
    let observed = batches.borrow().clone();
    assert_eq!(
        observed,
        vec![
            vec!["candidate-execute".to_owned()],
            vec!["candidate-plan".to_owned()],
        ]
    );
}

#[test]
fn commit_failure_at_second_result_cannot_partially_mutate_state() {
    let verifier_hash = digest('c');
    let initial = digest('0');
    let sequencer = FixtureCommitSequencerV1::with_failure_at(initial.clone(), verifier_hash, 2);
    let (mut control, snapshot, frontier) = control_plane(64, sequencer);
    assert_eq!(
        control.run(&snapshot, &frontier, "tenant-1", 1_000),
        Err(ControlPlaneError::CommitInvalid)
    );
    assert_eq!(control.sequencer().current_state_hash(), &initial);
    assert_eq!(control.sequencer().receipt_count(), 0);
    let report = control.resource_report().expect("resource report");
    assert!(report.reserved.is_zero());
    assert_eq!(report.reservation_count, 0);
}

#[test]
fn bounded_event_log_push_batch_is_atomic() {
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
    let before = log.events().to_vec();
    assert_eq!(
        log.push_batch(vec![event(digest('2')), event(digest('3'))]),
        Err(ControlPlaneError::ObservabilityBudgetExceeded)
    );
    assert_eq!(log.events(), before.as_slice());
}
