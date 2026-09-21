use std::{
    cell::Cell,
    io::Read,
    path::PathBuf,
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};

use sha2::Digest;

use super::*;

#[derive(Clone, Copy)]
enum Failure {
    ReturnedError,
    MissingResult,
    DuplicateResult,
    VerifierRejection,
    None,
}

struct ObservedExecutor {
    calls: Rc<Cell<usize>>,
    failure: Failure,
    fail_on_call: usize,
}

impl ModuleExecutorV1 for ObservedExecutor {
    fn execute_batch(
        &mut self,
        requests: &[ExecutionRequestV1],
    ) -> Result<Vec<PreparedResultV1>, ControlPlaneError> {
        self.calls.set(self.calls.get() + 1);
        let mut results = requests
            .iter()
            .map(prepared_result)
            .collect::<Result<Vec<_>, _>>()?;
        if self.calls.get() == self.fail_on_call {
            match self.failure {
                Failure::ReturnedError => return Err(ControlPlaneError::ExecutionInvalid),
                Failure::MissingResult => {
                    results.pop();
                }
                Failure::DuplicateResult => {
                    assert_eq!(results.len(), 2, "fixture must reach duplicate-key check");
                    results[1] = results[0].clone();
                }
                Failure::VerifierRejection => {
                    results[0].external_action_may_have_started = true;
                }
                Failure::None => {}
            }
        }
        Ok(results)
    }
}

fn runtime<E: ModuleExecutorV1>(
    executor: E,
    resource_allocator: ResourceAllocatorV1,
) -> ControlPlaneV1<E, DeterministicPreparedResultVerifierV1, FixtureCommitSequencerV1> {
    let (registry, hard_policy, _, _, _) = fixture_subject();
    ControlPlaneV1::new(
        registry.clone(),
        registry.policy_hash().clone(),
        hard_policy,
        planner_policy(),
        resource_allocator,
        executor,
        DeterministicPreparedResultVerifierV1::new(digest('c')),
        FixtureCommitSequencerV1::new(digest('0'), digest('c')),
        BoundedEventLogV1::new(128, 128).expect("events"),
    )
    .expect("runtime")
}

fn assert_blocked<E: ModuleExecutorV1>(
    control: &mut ControlPlaneV1<
        E,
        DeterministicPreparedResultVerifierV1,
        FixtureCommitSequencerV1,
    >,
    snapshot: &ControlPlaneSnapshotV1,
    frontier: &PlanningFrontierV1,
    cause: ControlPlaneError,
) {
    let inspection = control
        .inspection_required()
        .expect("returned error must retain inspection record")
        .clone();
    assert_eq!(inspection.cause(), Some(cause));
    assert_eq!(inspection.phase(), ControlPlaneRunFailurePhaseV1::Execution);
    assert_eq!(
        inspection.snapshot_hash(),
        &snapshot.snapshot_hash().expect("snapshot hash")
    );
    let (_, hard, _, _, _) = fixture_subject();
    let plan = select_plan_v1(snapshot, frontier, &hard, &planner_policy()).expect("plan");
    assert_eq!(inspection.plan_hash(), &plan.plan_hash);
    assert_eq!(
        inspection.reservation_ids(),
        &[
            format!("{}:reservation:1", plan.plan_hash.as_str()),
            format!("{}:reservation:2", plan.plan_hash.as_str()),
        ]
    );
    let report = control.resource_report().expect("retained accounting");
    assert_eq!(report.reservation_count, 2);
    assert_eq!(report.reserved.cpu_millis, 20);
    assert_eq!(report.reserved.memory_bytes, 128);
    assert_eq!(report.reserved.tokens, 20);
    assert_eq!(control.sequencer().receipt_count(), 0);
    assert!(
        control
            .events()
            .iter()
            .all(|event| event.kind != ControlPlaneEventKindV1::ResourceReleased)
    );
    let events = control.events().to_vec();
    // A changed or malformed input cannot bypass the owner's block or obscure
    // the original diagnostic through a new validation error.
    let mut changed_snapshot = snapshot.clone();
    changed_snapshot.version = 0;
    assert_eq!(
        control.run(&changed_snapshot, frontier, "another-tenant", 0),
        Err(ControlPlaneError::RunRequiresInspection)
    );
    assert_eq!(
        control.run(snapshot, frontier, "tenant-1", 1_001),
        Err(ControlPlaneError::RunRequiresInspection)
    );
    assert_eq!(control.inspection_required(), Some(&inspection));
    assert_eq!(control.resource_report().expect("accounting"), report);
    assert_eq!(control.events(), events);
}

fn check_execution_failure(failure: Failure, fail_on_call: usize, same_wave: bool) {
    let (_, _, snapshot, mut frontier, limit) = fixture_subject();
    if same_wave {
        frontier.candidates[1].dependency_candidate_ids.clear();
    }
    let calls = Rc::new(Cell::new(0));
    let mut control = runtime(
        ObservedExecutor {
            calls: Rc::clone(&calls),
            failure,
            fail_on_call,
        },
        allocator(limit),
    );
    assert_eq!(
        control.run(&snapshot, &frontier, "tenant-1", 1_000),
        Err(ControlPlaneError::RunRequiresInspection)
    );
    assert_blocked(
        &mut control,
        &snapshot,
        &frontier,
        if matches!(failure, Failure::VerifierRejection) {
            ControlPlaneError::VerificationInvalid
        } else {
            ControlPlaneError::ExecutionInvalid
        },
    );
    assert_eq!(
        calls.get(),
        fail_on_call,
        "blocked owner must not dispatch again"
    );
}

#[test]
fn missing_result_preserves_entire_plan_including_unstarted_wave() {
    check_execution_failure(Failure::MissingResult, 1, false);
}

#[test]
fn duplicate_results_preserve_both_reservations() {
    check_execution_failure(Failure::DuplicateResult, 1, true);
}

#[test]
fn verifier_rejection_preserves_all_reservations() {
    check_execution_failure(Failure::VerifierRejection, 1, false);
}

#[test]
fn later_wave_error_preserves_previously_verified_work() {
    check_execution_failure(Failure::ReturnedError, 2, false);
}

struct OwnedChild(Child);

impl Drop for OwnedChild {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

struct ChildExecutor {
    marker: PathBuf,
    child: Rc<RefCell<Option<OwnedChild>>>,
    calls: Rc<Cell<usize>>,
}

impl ModuleExecutorV1 for ChildExecutor {
    fn execute_batch(
        &mut self,
        _requests: &[ExecutionRequestV1],
    ) -> Result<Vec<PreparedResultV1>, ControlPlaneError> {
        self.calls.set(self.calls.get() + 1);
        let child = Command::new(std::env::current_exe().expect("test executable"))
            .args([
                "--exact",
                "tests::runtime_failure::owned_execution_child",
                "--ignored",
            ])
            .env("HEPTA_RUNTIME_EXECUTION_MARKER", &self.marker)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("owned execution child");
        let mut child = OwnedChild(child);
        let deadline = Instant::now() + Duration::from_secs(10);
        while !self.marker.exists() {
            assert!(child.0.try_wait().expect("child status").is_none());
            assert!(Instant::now() < deadline, "child did not write marker");
            std::thread::sleep(Duration::from_millis(5));
        }
        *self.child.borrow_mut() = Some(child);
        Err(ControlPlaneError::ExecutionInvalid)
    }
}

#[test]
#[ignore = "private child entrypoint invoked by the owned-process regression"]
fn owned_execution_child() {
    let marker = std::env::var_os("HEPTA_RUNTIME_EXECUTION_MARKER").expect("private child marker");
    std::fs::write(marker, b"work started; no terminal receipt\n")
        .expect("actual execution marker");
    let mut byte = [0_u8; 1];
    let _ = std::io::stdin().read(&mut byte).expect("wait for parent");
}

#[test]
fn returned_error_with_live_owned_child_retains_charges_without_redispatch() {
    let fixture = DurableFixture::new();
    let marker = fixture.root.join("actual-execution-marker");
    let child = Rc::new(RefCell::new(None));
    let calls = Rc::new(Cell::new(0));
    let (_, _, snapshot, frontier, limit) = fixture_subject();
    let mut control = runtime(
        ChildExecutor {
            marker: marker.clone(),
            child: Rc::clone(&child),
            calls: Rc::clone(&calls),
        },
        allocator(limit),
    );
    assert_eq!(
        control.run(&snapshot, &frontier, "tenant-1", 1_000),
        Err(ControlPlaneError::RunRequiresInspection)
    );
    assert_eq!(
        std::fs::read(marker).expect("execution marker"),
        b"work started; no terminal receipt\n"
    );
    assert!(
        child
            .borrow_mut()
            .as_mut()
            .expect("actual child remains owned")
            .0
            .try_wait()
            .expect("child is alive")
            .is_none()
    );
    assert_blocked(
        &mut control,
        &snapshot,
        &frontier,
        ControlPlaneError::ExecutionInvalid,
    );
    assert_eq!(calls.get(), 1);
    // Test cleanup is not presented to the runtime as proof of reconciliation.
    drop(child.borrow_mut().take());
    assert!(control.inspection_required().is_some());
    assert_eq!(
        control
            .resource_report()
            .expect("still charged")
            .reservation_count,
        2
    );
}

#[test]
fn partial_admission_failure_rolls_back_before_dispatch_and_allows_valid_run() {
    let (_, _, snapshot, frontier, limit) = fixture_subject();
    let calls = Rc::new(Cell::new(0));
    let resource_allocator = ResourceAllocatorV1::new(
        limit,
        BTreeMap::from([
            ("tenant-1".to_owned(), limit),
            (
                "limited-tenant".to_owned(),
                frontier.candidates[0].resources,
            ),
        ]),
        BTreeMap::from([("tenant-1".to_owned(), 1), ("limited-tenant".to_owned(), 1)]),
        1,
    )
    .expect("allocator with insufficient tenant ceiling");
    let mut control = runtime(
        ObservedExecutor {
            calls: Rc::clone(&calls),
            failure: Failure::None,
            fail_on_call: 1,
        },
        resource_allocator,
    );
    assert_eq!(
        control.run(&snapshot, &frontier, "limited-tenant", 1_000),
        Err(ControlPlaneError::ResourceDenied)
    );
    assert_eq!(calls.get(), 0);
    assert!(control.inspection_required().is_none());
    let report = control.resource_report().expect("rolled back reservations");
    assert_eq!(report.reservation_count, 0);
    assert!(report.reserved.is_zero());
    assert_eq!(
        control
            .events()
            .iter()
            .filter(|event| event.kind == ControlPlaneEventKindV1::ResourceReserved)
            .count(),
        1,
        "the test must reserve the first action before refusing the second"
    );
    let receipt = control
        .run(&snapshot, &frontier, "tenant-1", 1_001)
        .expect("fresh successful run on the same owner");
    assert_eq!(calls.get(), 2);
    assert!(control.inspection_required().is_none());
    assert_eq!(receipt.commit_receipts.len(), 2);
    assert!(receipt.resource_report.reserved.is_zero());
}

#[test]
fn successful_run_has_only_existing_v1_receipt_fields_and_releases_charges() {
    let (_, _, snapshot, frontier, limit) = fixture_subject();
    let mut control = runtime(FakeExecutorV1, allocator(limit));
    let receipt = control
        .run(&snapshot, &frontier, "tenant-1", 1_000)
        .expect("successful run");
    assert!(control.inspection_required().is_none());
    assert_eq!(receipt.resource_report.reservation_count, 0);
    assert!(receipt.resource_report.reserved.is_zero());
    let encoded = serde_json::to_string(&receipt).expect("receipt JSON");
    let fields = serde_json::to_value(&receipt).expect("receipt fields");
    assert_eq!(fields.as_object().expect("receipt object").len(), 10);
    let suffix = format!(",\"receiptHash\":\"{}\"}}", receipt.receipt_hash.as_str());
    let body = format!(
        "{}}}",
        encoded
            .strip_suffix(&suffix)
            .expect("V1 receipt hash is the last field")
    );
    assert_eq!(
        format!(
            "sha256:{}",
            hex::encode(sha2::Sha256::digest(body.as_bytes()))
        ),
        receipt.receipt_hash.as_str()
    );
    let sequencer = FixtureCommitSequencerV1::new(digest('0'), digest('c'));
    let (mut identical, _, _) = control_plane(128, sequencer);
    let repeated = identical
        .run(&snapshot, &frontier, "tenant-1", 1_000)
        .expect("independent deterministic run");
    assert_eq!(
        serde_json::to_vec(&receipt).expect("receipt bytes"),
        serde_json::to_vec(&repeated).expect("same-input receipt bytes")
    );
}
