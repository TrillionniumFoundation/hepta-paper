use std::cell::Cell;

use super::*;

struct ClockExecutor {
    time: Rc<Cell<u64>>,
    calls: Rc<Cell<usize>>,
    after_calls: Vec<u64>,
}

impl ModuleExecutorV1 for ClockExecutor {
    fn execute_batch(
        &mut self,
        requests: &[ExecutionRequestV1],
    ) -> Result<Vec<PreparedResultV1>, ControlPlaneError> {
        let results = FakeExecutorV1.execute_batch(requests)?;
        let index = self.calls.get();
        self.calls.set(index + 1);
        self.time.set(self.after_calls[index]);
        Ok(results)
    }
}

fn runtime(
    fixture: &DurableFixture,
    time: &Rc<Cell<u64>>,
    calls: &Rc<Cell<usize>>,
    after_calls: Vec<u64>,
) -> ControlPlaneV1<ClockExecutor, DeterministicPreparedResultVerifierV1, SqliteCommitSequencerV1> {
    let (registry, hard, _, _, limit) = fixture_subject();
    ControlPlaneV1::new(
        registry.clone(),
        registry.policy_hash().clone(),
        hard,
        planner_policy(),
        allocator(limit),
        ClockExecutor {
            time: time.clone(),
            calls: calls.clone(),
            after_calls,
        },
        DeterministicPreparedResultVerifierV1::new(digest('c')),
        fixture.sequencer(true, 100),
        BoundedEventLogV1::new(128, 128).unwrap(),
    )
    .unwrap()
}

#[test]
fn expired_or_rolled_back_clock_stops_later_waves_and_retains_charges() {
    for after in [10_000, 5] {
        let fixture = DurableFixture::new();
        let (_, _, snapshot, frontier, _) = fixture_subject();
        let time = Rc::new(Cell::new(10));
        let calls = Rc::new(Cell::new(0));
        let mut control = runtime(&fixture, &time, &calls, vec![after, after]);
        assert_eq!(
            control.run_with_clock(&snapshot, &frontier, "tenant-1", &mut || Ok(time.get())),
            Err(ControlPlaneError::RunRequiresInspection)
        );
        assert_eq!(calls.get(), 1);
        let inspection = control.inspection_required().unwrap();
        assert_eq!(inspection.phase(), ControlPlaneRunFailurePhaseV1::Execution);
        assert_eq!(
            inspection.cause(),
            Some(ControlPlaneError::PersistenceInvalid)
        );
        assert_eq!(control.resource_report().unwrap().reservation_count, 2);
        assert_eq!(control.sequencer().receipt_count(), 0);
        assert_eq!(
            control
                .sequencer()
                .store()
                .load_campaign("campaign-1")
                .unwrap()
                .budget_remaining_microusd,
            100
        );
        // Neither supplying an earlier time nor another request unblocks this owner.
        assert_eq!(
            control.run(&snapshot, &frontier, "tenant-1", 10),
            Err(ControlPlaneError::RunRequiresInspection)
        );
        assert_eq!(calls.get(), 1);
        drop(control);
        assert_eq!(fixture.sequencer(false, 100).receipt_count(), 0);
    }
}

#[test]
fn expiry_after_final_wave_cannot_commit_prepared_results() {
    let fixture = DurableFixture::new();
    let (_, _, snapshot, frontier, _) = fixture_subject();
    let time = Rc::new(Cell::new(10));
    let calls = Rc::new(Cell::new(0));
    let mut control = runtime(&fixture, &time, &calls, vec![11, 10_000]);
    assert_eq!(
        control.run_with_clock(&snapshot, &frontier, "tenant-1", &mut || Ok(time.get())),
        Err(ControlPlaneError::RunRequiresInspection)
    );
    assert_eq!(calls.get(), 2);
    assert_eq!(
        control.inspection_required().unwrap().phase(),
        ControlPlaneRunFailurePhaseV1::Finalization
    );
    assert_eq!(control.sequencer().receipt_count(), 0);
    assert_eq!(control.resource_report().unwrap().reservation_count, 2);
}

#[test]
fn live_clock_success_commits_through_the_original_writer() {
    let fixture = DurableFixture::new();
    let (_, _, snapshot, frontier, _) = fixture_subject();
    let time = Rc::new(Cell::new(10));
    let calls = Rc::new(Cell::new(0));
    let mut control = runtime(&fixture, &time, &calls, vec![11, 12]);
    let result = control
        .run_with_clock(&snapshot, &frontier, "tenant-1", &mut || Ok(time.get()))
        .unwrap();
    assert_eq!(calls.get(), 2);
    assert_eq!(result.commit_receipts.len(), 2);
    assert_eq!(result.resource_report.reservation_count, 0);
    assert!(control.inspection_required().is_none());
    drop(control);
    assert_eq!(fixture.sequencer(false, 100).receipt_count(), 2);
}

#[test]
fn missing_clock_before_dispatch_has_no_execution_or_reservation() {
    let fixture = DurableFixture::new();
    let (_, _, snapshot, frontier, _) = fixture_subject();
    let time = Rc::new(Cell::new(10));
    let calls = Rc::new(Cell::new(0));
    let mut control = runtime(&fixture, &time, &calls, vec![]);
    assert_eq!(
        control.run_with_clock(&snapshot, &frontier, "tenant-1", &mut || {
            Err(ControlPlaneError::PersistenceInvalid)
        }),
        Err(ControlPlaneError::PersistenceInvalid)
    );
    assert_eq!(calls.get(), 0);
    assert!(control.inspection_required().is_none());
    assert_eq!(control.resource_report().unwrap().reservation_count, 0);
}

#[test]
fn sql_final_clock_failure_rolls_back_entire_batch_and_events() {
    for final_sample in [
        Ok(10_000),
        Ok(5),
        Err(ControlPlaneError::PersistenceInvalid),
    ] {
        let fixture = DurableFixture::new();
        let mut sequencer = fixture.sequencer(true, 100);
        let requests = ['a', 'b'].map(|marker| {
            CommitRequestV1::new(
                digest('9'),
                standalone_verified(digest('c'), digest('9'), marker),
            )
            .unwrap()
        });
        // Sequencer admission, after SQLite write lock, then before COMMIT.
        let mut samples = [Ok(10), Ok(20), final_sample].into_iter();
        assert_eq!(
            sequencer.commit_batch_with_clock(&requests, &mut || samples.next().unwrap()),
            Err(ControlPlaneError::PersistenceInvalid)
        );
        assert!(samples.next().is_none());
        assert_eq!(sequencer.receipt_count(), 0);
        assert_eq!(sequencer.next_sequence(), 1);
        assert_eq!(
            sequencer
                .store()
                .load_campaign("campaign-1")
                .unwrap()
                .budget_remaining_microusd,
            100
        );
        sequencer.store().validate_integrity().unwrap();
        drop(sequencer);
        assert_eq!(fixture.sequencer(false, 100).receipt_count(), 0);
    }
}

#[test]
fn lifecycle_final_clock_failure_rolls_back_state_and_event() {
    let fixture = DurableFixture::new();
    let mut store = fixture.sequencer(true, 100).into_store();
    let before = store.load_campaign("campaign-1").unwrap();
    let mut samples = [Ok(10), Ok(10_000)].into_iter();
    assert!(
        store
            .set_campaign_state_with_clock(
                &DurableFixture::lease(),
                "campaign-1",
                before.revision,
                hepta_campaign_writer::CampaignStateV1::Cancelled,
                3,
                &mut || samples.next().unwrap(),
            )
            .is_err()
    );
    assert!(samples.next().is_none());
    assert_eq!(store.load_campaign("campaign-1").unwrap(), before);
    store.validate_integrity().unwrap();
}

struct SequentialClockExecutor {
    time: Rc<Cell<Option<u64>>>,
    after_first: Option<u64>,
    executed: Rc<RefCell<Vec<String>>>,
}

impl ModuleExecutorV1 for SequentialClockExecutor {
    fn execute_batch(
        &mut self,
        requests: &[ExecutionRequestV1],
    ) -> Result<Vec<PreparedResultV1>, ControlPlaneError> {
        let mut results = Vec::new();
        for request in requests {
            results.push(prepared_result(request)?);
            self.executed
                .borrow_mut()
                .push(request.candidate.candidate_id.clone());
            // A legacy executor does not know about the caller's clock/lease.
            // Before the fix, the remaining same-wave requests still ran here.
            self.time.set(self.after_first);
        }
        Ok(results)
    }
}

#[test]
fn same_wave_dispatch_revalidates_each_legacy_executor_handoff() {
    // Positive control also proves the planner selects both same-wave requests.
    for after_first in [Some(11), Some(10_000), Some(5), None] {
        let fixture = DurableFixture::new();
        let (registry, hard, snapshot, mut frontier, limit) = fixture_subject();
        frontier.candidates[1].dependency_candidate_ids.clear();
        let time = Rc::new(Cell::new(Some(10)));
        let executed = Rc::new(RefCell::new(Vec::new()));
        let mut control = ControlPlaneV1::new(
            registry.clone(),
            registry.policy_hash().clone(),
            hard,
            planner_policy(),
            allocator(limit),
            SequentialClockExecutor {
                time: time.clone(),
                after_first,
                executed: executed.clone(),
            },
            DeterministicPreparedResultVerifierV1::new(digest('c')),
            fixture.sequencer(true, 100),
            BoundedEventLogV1::new(128, 128).unwrap(),
        )
        .unwrap();
        let outcome = control.run_with_clock(&snapshot, &frontier, "tenant-1", &mut || {
            time.get().ok_or(ControlPlaneError::PersistenceInvalid)
        });
        if after_first == Some(11) {
            let receipt = outcome.unwrap();
            assert_eq!(executed.borrow().len(), 2);
            assert_eq!(receipt.commit_receipts.len(), 2);
            assert_eq!(receipt.resource_report.reservation_count, 0);
            assert!(control.inspection_required().is_none());
        } else {
            assert_eq!(outcome, Err(ControlPlaneError::RunRequiresInspection));
            assert_eq!(executed.borrow().len(), 1);
            let inspection = control.inspection_required().unwrap();
            assert_eq!(inspection.phase(), ControlPlaneRunFailurePhaseV1::Execution);
            assert_eq!(
                inspection.cause(),
                Some(ControlPlaneError::PersistenceInvalid)
            );
            assert_eq!(inspection.reservation_ids().len(), 2);
            assert_eq!(control.resource_report().unwrap().reservation_count, 2);
            assert_eq!(control.sequencer().receipt_count(), 0);
            assert_eq!(
                control
                    .sequencer()
                    .store()
                    .load_campaign("campaign-1")
                    .unwrap()
                    .budget_remaining_microusd,
                100
            );
            // Supplying an earlier clock must not clear the inspection guard.
            assert_eq!(
                control.run(&snapshot, &frontier, "tenant-1", 10),
                Err(ControlPlaneError::RunRequiresInspection)
            );
            assert_eq!(executed.borrow().len(), 1);
            drop(control);
            assert_eq!(fixture.sequencer(false, 100).receipt_count(), 0);
        }
    }
}

#[test]
fn admitted_default_refuses_wrong_singleton_count_before_next_handoff() {
    struct MissingResultExecutor(Rc<Cell<usize>>);
    impl ModuleExecutorV1 for MissingResultExecutor {
        fn execute_batch(
            &mut self,
            requests: &[ExecutionRequestV1],
        ) -> Result<Vec<PreparedResultV1>, ControlPlaneError> {
            self.0.set(self.0.get() + 1);
            assert_eq!(requests.len(), 1);
            Ok(Vec::new())
        }
    }
    let (registry, hard, snapshot, mut frontier, limit) = fixture_subject();
    frontier.candidates[1].dependency_candidate_ids.clear();
    let calls = Rc::new(Cell::new(0));
    let mut control = ControlPlaneV1::new(
        registry.clone(),
        registry.policy_hash().clone(),
        hard,
        planner_policy(),
        allocator(limit),
        MissingResultExecutor(calls.clone()),
        DeterministicPreparedResultVerifierV1::new(digest('c')),
        FixtureCommitSequencerV1::new(digest('1'), digest('c')),
        BoundedEventLogV1::new(128, 128).unwrap(),
    )
    .unwrap();
    assert_eq!(
        control.run(&snapshot, &frontier, "tenant-1", 10),
        Err(ControlPlaneError::RunRequiresInspection)
    );
    assert_eq!(calls.get(), 1);
    assert_eq!(
        control.inspection_required().unwrap().cause(),
        Some(ControlPlaneError::ExecutionInvalid)
    );
    assert_eq!(control.resource_report().unwrap().reservation_count, 2);
}
