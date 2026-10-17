use super::*;
use hepta_control_plane::ResourceReservationV1;
use hepta_module_platform::{ActionCandidateV1, QualificationTierV1, ResourceVectorV1};
use std::{
    os::unix::fs::PermissionsExt,
    sync::{Condvar, atomic::AtomicUsize},
    time::Duration,
};

static NEXT: AtomicUsize = AtomicUsize::new(0);
struct Fixture {
    path: PathBuf,
    executor: ServiceExecutorV1,
    requests: Vec<ExecutionRequestV1>,
}
impl Fixture {
    fn new(count: usize) -> Self {
        let path = std::env::temp_dir().join(format!(
            "hepta-bounded-worker-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
        let objects = ObjectStoreV1::open(&path).unwrap();
        let job = NativeJobV1::Business {
            job: NativeBusinessJobV1::NumericalLinearSolve {
                matrix: vec![vec![2.0]],
                rhs: vec![6.0],
                tolerance: 0.00001,
            },
        };
        let hash = objects.put(&serde_json::to_vec(&job).unwrap()).unwrap();
        let resources = ResourceVectorV1 {
            cpu_millis: 1000,
            memory_bytes: 64 * 1024 * 1024,
            storage_bytes: 1024 * 1024,
            ..ResourceVectorV1::default()
        };
        let requests = (0..count)
            .map(|index| ExecutionRequestV1 {
                version: 1,
                attempt_id: format!("attempt-{index}"),
                snapshot_hash: hash.clone(),
                plan_hash: hash.clone(),
                candidate: ActionCandidateV1 {
                    version: 1,
                    candidate_id: format!("candidate-{index}"),
                    decision_group: format!("group-{index}"),
                    module_id: "module.numeric".into(),
                    module_version: "1.0.0".into(),
                    capability_id: "CAP-NUMERICAL".into(),
                    snapshot_hash: hash.clone(),
                    dependency_candidate_ids: vec![],
                    resources,
                    utility_micros: 1,
                    cost_microusd: 1,
                    uncertainty_ppm: 0,
                    evidence_tier: QualificationTierV1::Source,
                    // Independent immutable systems share the solution but
                    // have distinct input identities and can genuinely overlap.
                    payload_hash: objects
                        .put(
                            &serde_json::to_vec(&NativeJobV1::Business {
                                job: NativeBusinessJobV1::NumericalLinearSolve {
                                    matrix: vec![vec![2.0 + index as f64]],
                                    rhs: vec![3.0 * (2.0 + index as f64)],
                                    tolerance: 0.00001,
                                },
                            })
                            .unwrap(),
                        )
                        .unwrap(),
                },
                reservation: ResourceReservationV1 {
                    reservation_id: format!("reserve-{index}"),
                    tenant_id: "tenant".into(),
                    module_id: "module.numeric".into(),
                    candidate_id: format!("candidate-{index}"),
                    reserved: resources,
                    admission_sequence: index as u64,
                    reservation_hash: hash.clone(),
                },
            })
            .collect();
        let executor = ServiceExecutorV1::new(
            objects,
            BTreeMap::from([("module.numeric".into(), WorkerBindingV1::Native)]),
        )
        .unwrap();
        Self {
            path,
            executor,
            requests,
        }
    }
    fn guard(&self) -> recovery::DispatchGuardV1 {
        let incoming = self
            .requests
            .iter()
            .map(|request| {
                execution_identity(request, &WorkerBindingV1::Native)
                    .unwrap()
                    .as_str()
                    .trim_start_matches("sha256:")
                    .to_owned()
            })
            .collect();
        recovery::DispatchGuardV1::acquire(
            &self.executor.objects,
            &incoming,
            &BTreeSet::new(),
            self.requests.first().map(|request| &request.plan_hash),
            None,
        )
        .unwrap()
    }
    fn records(&self, suffix: &str) -> usize {
        fs::read_dir(self.path.join("attempts"))
            .unwrap()
            .filter(|entry| {
                entry
                    .as_ref()
                    .unwrap()
                    .file_name()
                    .to_str()
                    .unwrap()
                    .ends_with(suffix)
            })
            .count()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

// Unlike an unbounded Barrier wait, a scheduling regression terminates the test.
fn rendezvous(pair: &(Mutex<usize>, Condvar)) {
    let mut entered = pair.0.lock().unwrap();
    *entered += 1;
    pair.1.notify_all();
    let required = if entered.is_multiple_of(2) {
        *entered
    } else {
        *entered + 1
    };
    let (entered, _) = pair
        .1
        .wait_timeout_while(entered, Duration::from_secs(5), |n| *n < required)
        .unwrap();
    assert!(*entered >= required, "second bounded worker did not start");
}

#[test]
fn actual_pure_workers_overlap_with_two_slots_and_preserve_exact_order_and_cache() {
    let mut fixture = Fixture::new(4);
    let guard = fixture.guard();
    let coordinator = std::thread::current().id();
    let active = AtomicUsize::new(0);
    let peak = AtomicUsize::new(0);
    let entered = (Mutex::new(0), Condvar::new());
    let results = fixture
        .executor
        .execute_bounded_batch(
            &fixture.requests,
            &mut || {
                assert_eq!(std::thread::current().id(), coordinator);
                Ok(())
            },
            &guard,
            2,
            &|job, capability, cancelled, deadline| {
                assert_ne!(std::thread::current().id(), coordinator);
                let count = active.fetch_add(1, Ordering::SeqCst) + 1;
                peak.fetch_max(count, Ordering::SeqCst);
                assert!(count <= 2);
                rendezvous(&entered);
                let output = compute(job, capability, cancelled, deadline);
                active.fetch_sub(1, Ordering::SeqCst);
                output
            },
        )
        .unwrap();
    let serial = Fixture::new(4);
    let serial_guard = serial.guard();
    let mut observed = || {
        assert_eq!(std::thread::current().id(), coordinator);
        Ok(())
    };
    let expected: Vec<_> = serial
        .requests
        .iter()
        .map(|request| {
            serial_guard.validate().unwrap();
            observed().unwrap();
            let result = serial.executor.execute_one(request, &mut observed).unwrap();
            serial_guard.validate().unwrap();
            result
        })
        .collect();
    assert_eq!(
        results, expected,
        "complete prepared values equal original execute_one"
    );
    for result in &results {
        for hash in result
            .artifact_hashes
            .iter()
            .chain(std::iter::once(&result.evidence_hash))
        {
            assert_eq!(
                fixture.executor.objects.read(hash).unwrap(),
                serial.executor.objects.read(hash).unwrap()
            );
        }
    }
    assert_eq!(peak.load(Ordering::SeqCst), 2);
    assert_eq!(active.load(Ordering::SeqCst), 0);
    assert_eq!(
        results.iter().map(|r| &r.attempt_id).collect::<Vec<_>>(),
        fixture
            .requests
            .iter()
            .map(|r| &r.attempt_id)
            .collect::<Vec<_>>()
    );
    for (result, request) in results.iter().zip(&fixture.requests) {
        result
            .validate(&request.candidate, &request.plan_hash)
            .unwrap();
        assert_eq!(result.actual_resources, request.reservation.reserved);
        let bytes = fixture
            .executor
            .objects
            .read(&result.artifact_hashes[0])
            .unwrap();
        assert_eq!(
            serde_json::from_slice::<Value>(&bytes).unwrap()["solution"],
            json!([3.0])
        );
    }
    assert_eq!(fixture.records("started"), 4);
    assert_eq!(fixture.records("prepared"), 4);
    drop(guard);
    assert_eq!(
        fixture.executor.execute_batch(&fixture.requests).unwrap(),
        results
    );
}

#[test]
fn failed_live_handoff_after_intent_stops_launches_and_retains_recovery_fence() {
    let mut fixture = Fixture::new(3);
    let guard = fixture.guard();
    let mut calls = 0;
    let ran = AtomicUsize::new(0);
    assert!(
        fixture
            .executor
            .execute_bounded_batch(
                &fixture.requests,
                &mut || {
                    calls += 1;
                    if calls == 4 {
                        Err(ControlPlaneError::ExecutionInvalid)
                    } else {
                        Ok(())
                    }
                },
                &guard,
                2,
                &|job, capability, cancelled, deadline| {
                    ran.fetch_add(1, Ordering::SeqCst);
                    compute(job, capability, cancelled, deadline)
                }
            )
            .is_err()
    );
    assert_eq!(calls, 4);
    assert_eq!(ran.load(Ordering::SeqCst), 1);
    assert_eq!(fixture.records("started"), 2);
    assert_eq!(fixture.records("prepared"), 0);
    drop(guard);
    assert!(
        fixture
            .executor
            .execute_batch(&fixture.requests[2..])
            .is_err()
    );
    assert_eq!(fixture.records("started"), 2);
}

#[test]
fn cancellation_joins_started_workers_suppresses_publication_and_never_retries() {
    let mut fixture = Fixture::new(3);
    let guard = fixture.guard();
    let entered = (Mutex::new(0), Condvar::new());
    let finished = AtomicUsize::new(0);
    assert!(
        fixture
            .executor
            .execute_bounded_batch(
                &fixture.requests,
                &mut || Ok(()),
                &guard,
                2,
                &|job, capability, cancelled, deadline| {
                    rendezvous(&entered);
                    cancelled.store(true, Ordering::Release);
                    let result = compute(job, capability, cancelled, deadline);
                    finished.fetch_add(1, Ordering::SeqCst);
                    result
                }
            )
            .is_err()
    );
    assert_eq!(finished.load(Ordering::SeqCst), 2);
    assert_eq!(fixture.records("started"), 2);
    assert_eq!(fixture.records("prepared"), 0);
    drop(guard);
    fixture.executor.cancelled.store(false, Ordering::Release);
    assert!(fixture.executor.execute_batch(&fixture.requests).is_err());
}

#[test]
fn worker_panic_is_joined_and_no_later_batch_is_launched() {
    for panic in [false, true] {
        let mut fixture = Fixture::new(3);
        let sibling = NativeJobV1::Business {
            job: NativeBusinessJobV1::NumericalLinearSolve {
                matrix: vec![vec![2.0]],
                rhs: vec![9.0],
                tolerance: 0.00001,
            },
        };
        fixture.requests[1].candidate.payload_hash = fixture
            .executor
            .objects
            .put(&serde_json::to_vec(&sibling).unwrap())
            .unwrap();
        let guard = fixture.guard();
        let entered = (Mutex::new(0), Condvar::new());
        let finished = AtomicUsize::new(0);
        let before = fs::read_dir(fixture.executor.objects.root())
            .unwrap()
            .count();
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            fixture.executor.execute_bounded_batch(&fixture.requests, &mut || Ok(()), &guard, 2,
                &|job, capability, cancelled, deadline| {
                    rendezvous(&entered);
                    finished.fetch_add(1, Ordering::SeqCst);
                    if matches!(&job, NativeBusinessJobV1::NumericalLinearSolve { rhs, .. } if rhs[0] == 6.0) {
                        assert!(!panic, "injected bounded worker panic");
                        return Err(ServiceError::Execution);
                    }
                    compute(job, capability, cancelled, deadline)
                })
        }));
        assert!(outcome.unwrap().is_err());
        assert_eq!(finished.load(Ordering::SeqCst), 2);
        assert_eq!(fixture.records("started"), 2);
        assert_eq!(fixture.records("prepared"), 0);
        assert_eq!(
            fs::read_dir(fixture.executor.objects.root())
                .unwrap()
                .count(),
            before
        );
    }
}

#[test]
fn expired_cancelled_mismatched_and_underreserved_inputs_never_start() {
    for mode in 0..4 {
        let mut fixture = Fixture::new(1);
        match mode {
            0 => fixture.executor.inherited_native_deadline = Some(Instant::now()),
            1 => fixture.executor.cancelled.store(true, Ordering::Release),
            2 => fixture.requests[0].candidate.capability_id = "CAP-BUILD".into(),
            _ => fixture.requests[0].reservation.reserved.memory_bytes = 1,
        }
        assert!(fixture.executor.execute_batch(&fixture.requests).is_err());
        assert_eq!(fixture.records("started"), 0);
        assert_eq!(fixture.records("prepared"), 0);
    }
}

#[test]
fn duplicate_requests_drain_then_replay_without_duplicate_publication() {
    let mut fixture = Fixture::new(1);
    fixture.requests.push(fixture.requests[0].clone());
    let results = fixture.executor.execute_batch(&fixture.requests).unwrap();
    assert_eq!(results.len(), 2);
    assert_eq!(results[0], results[1]);
    assert_eq!(fixture.records("started"), 1);
    assert_eq!(fixture.records("prepared"), 1);
}

#[test]
fn serial_native_barrier_keeps_order_and_does_not_enter_pure_worker() {
    let mut fixture = Fixture::new(3);
    fixture.requests[1].candidate.payload_hash = fixture
        .executor
        .objects
        .put(
            &serde_json::to_vec(&NativeJobV1::ArtifactInventory {
                artifacts: vec![fixture.requests[0].candidate.payload_hash.clone()],
            })
            .unwrap(),
        )
        .unwrap();
    let guard = fixture.guard();
    let ran = AtomicUsize::new(0);
    let results = fixture
        .executor
        .execute_bounded_batch(
            &fixture.requests,
            &mut || Ok(()),
            &guard,
            2,
            &|job, capability, cancelled, deadline| {
                ran.fetch_add(1, Ordering::SeqCst);
                compute(job, capability, cancelled, deadline)
            },
        )
        .unwrap();
    assert_eq!(ran.load(Ordering::SeqCst), 2);
    assert_eq!(
        results.iter().map(|r| &r.attempt_id).collect::<Vec<_>>(),
        fixture
            .requests
            .iter()
            .map(|r| &r.attempt_id)
            .collect::<Vec<_>>()
    );
    let evidence: Value = serde_json::from_slice(
        &fixture
            .executor
            .objects
            .read(&results[1].evidence_hash)
            .unwrap(),
    )
    .unwrap();
    assert_eq!(evidence["verifier"], "native_artifact_inventory");
}

#[test]
fn deadline_expiring_inside_computation_cannot_publish_success() {
    let mut fixture = Fixture::new(1);
    let deadline = Instant::now() + Duration::from_millis(200);
    fixture.executor.inherited_native_deadline = Some(deadline);
    let guard = fixture.guard();
    let ran = AtomicBool::new(false);
    assert!(
        fixture
            .executor
            .execute_bounded_batch(
                &fixture.requests,
                &mut || Ok(()),
                &guard,
                1,
                &|job, capability, cancelled, inherited| {
                    ran.store(true, Ordering::SeqCst);
                    let output = compute(job, capability, cancelled, inherited)?;
                    std::thread::sleep(
                        deadline.saturating_duration_since(Instant::now())
                            + Duration::from_millis(1),
                    );
                    Ok(output)
                }
            )
            .is_err()
    );
    assert!(ran.load(Ordering::SeqCst));
    assert_eq!(fixture.records("started"), 1);
    assert_eq!(fixture.records("prepared"), 0);
}

#[test]
fn rejected_first_admission_creates_no_intent_or_worker() {
    let fixture = Fixture::new(1);
    let guard = fixture.guard();
    assert!(
        fixture
            .executor
            .execute_bounded_batch(
                &fixture.requests,
                &mut || Err(ControlPlaneError::ExecutionInvalid),
                &guard,
                2,
                &|_, _, _, _| panic!("denied worker must not execute")
            )
            .is_err()
    );
    assert_eq!(fixture.records("started"), 0);
}

#[test]
fn live_admission_expiring_during_compute_joins_without_any_cas_publication() {
    let fixture = Fixture::new(2);
    let guard = fixture.guard();
    let expired = AtomicBool::new(false);
    let entered = (Mutex::new(0), Condvar::new());
    let finished = AtomicUsize::new(0);
    let before = fs::read_dir(fixture.executor.objects.root())
        .unwrap()
        .count();
    assert!(
        fixture
            .executor
            .execute_bounded_batch(
                &fixture.requests,
                &mut || {
                    if expired.load(Ordering::Acquire) {
                        Err(ControlPlaneError::ExecutionInvalid)
                    } else {
                        Ok(())
                    }
                },
                &guard,
                2,
                &|job, capability, cancelled, deadline| {
                    rendezvous(&entered);
                    let output = compute(job, capability, cancelled, deadline);
                    expired.store(true, Ordering::Release);
                    finished.fetch_add(1, Ordering::SeqCst);
                    output
                }
            )
            .is_err()
    );
    assert_eq!(finished.load(Ordering::SeqCst), 2);
    assert_eq!(fixture.records("started"), 2);
    assert_eq!(fixture.records("prepared"), 0);
    assert_eq!(
        fs::read_dir(fixture.executor.objects.root())
            .unwrap()
            .count(),
        before
    );
}

#[test]
fn revocation_after_evidence_io_cannot_write_prepared_record_or_publish_later_output() {
    let fixture = Fixture::new(2);
    let guard = fixture.guard();
    let mut admissions = 0;
    let finished = AtomicUsize::new(0);
    let before = fs::read_dir(fixture.executor.objects.root())
        .unwrap()
        .count();
    assert!(
        fixture
            .executor
            .execute_bounded_batch(
                &fixture.requests,
                &mut || {
                    admissions += 1;
                    // Four launch checks, then pre-CAS and post-evidence publication checks.
                    if admissions == 6 {
                        Err(ControlPlaneError::ExecutionInvalid)
                    } else {
                        Ok(())
                    }
                },
                &guard,
                2,
                &|job, capability, cancelled, deadline| {
                    let output = compute(job, capability, cancelled, deadline);
                    finished.fetch_add(1, Ordering::SeqCst);
                    output
                }
            )
            .is_err()
    );
    assert_eq!(admissions, 6);
    assert_eq!(finished.load(Ordering::SeqCst), 2);
    assert_eq!(fixture.records("prepared"), 0);
    // Only the first result's artifact/evidence may have been staged.
    assert_eq!(
        fs::read_dir(fixture.executor.objects.root())
            .unwrap()
            .count(),
        before + 2
    );
}

#[test]
fn original_admission_error_is_retained_at_handoff_and_publication_boundaries() {
    for error in [
        ControlPlaneError::PersistenceInvalid,
        ControlPlaneError::ResourceClockRollback,
        ControlPlaneError::ResourceDenied,
        ControlPlaneError::CommitInvalid,
    ] {
        for fail_at in [1, 2, 5, 6] {
            let fixture = Fixture::new(2);
            let guard = fixture.guard();
            let mut calls = 0;
            let finished = AtomicUsize::new(0);
            let result = fixture.executor.execute_bounded_batch(
                &fixture.requests,
                &mut || {
                    calls += 1;
                    if calls == fail_at { Err(error) } else { Ok(()) }
                },
                &guard,
                2,
                &|job, capability, cancelled, deadline| {
                    let output = compute(job, capability, cancelled, deadline);
                    finished.fetch_add(1, Ordering::SeqCst);
                    output
                },
            );
            assert_eq!(result.unwrap_err(), error);
            assert_eq!(calls, fail_at);
            assert_eq!(
                finished.load(Ordering::SeqCst),
                if fail_at <= 2 { 0 } else { 2 }
            );
            assert_eq!(fixture.records("prepared"), 0);
        }
    }
}

#[test]
fn repeated_payload_observes_publication_before_second_handoff_on_two_slot_host() {
    let mut fixture = Fixture::new(2);
    fixture.requests[1].candidate.payload_hash = fixture.requests[0].candidate.payload_hash.clone();
    let guard = fixture.guard();
    let finished = AtomicUsize::new(0);
    let result = fixture.executor.execute_bounded_batch(
        &fixture.requests,
        &mut || {
            if fixture.records("prepared") > 0 {
                Err(ControlPlaneError::PersistenceInvalid)
            } else {
                Ok(())
            }
        },
        &guard,
        2,
        &|job, capability, cancelled, deadline| {
            let output = compute(job, capability, cancelled, deadline);
            finished.fetch_add(1, Ordering::SeqCst);
            output
        },
    );
    assert_eq!(result.unwrap_err(), ControlPlaneError::PersistenceInvalid);
    assert_eq!(finished.load(Ordering::SeqCst), 1);
    assert_eq!(fixture.records("started"), 1);
    assert_eq!(fixture.records("prepared"), 1);
}

#[test]
fn distinct_payloads_with_identical_outputs_publish_without_cas_races() {
    use crate::native_business::BuildEntryV1;
    let mut fixture = Fixture::new(2);
    let mut entries = vec![
        BuildEntryV1 {
            path: "a.txt".into(),
            content: "first".into(),
            media_type: "text/plain".into(),
        },
        BuildEntryV1 {
            path: "b.txt".into(),
            content: "second".into(),
            media_type: "text/plain".into(),
        },
    ];
    for request in &mut fixture.requests {
        request.candidate.capability_id = "CAP-BUILD".into();
        request.candidate.payload_hash = fixture
            .executor
            .objects
            .put(
                &serde_json::to_vec(&NativeJobV1::Business {
                    job: NativeBusinessJobV1::BuildPackage {
                        entries: entries.clone(),
                    },
                })
                .unwrap(),
            )
            .unwrap();
        entries.reverse();
    }
    assert_ne!(
        fixture.requests[0].candidate.payload_hash,
        fixture.requests[1].candidate.payload_hash
    );
    let guard = fixture.guard();
    let entered = (Mutex::new(0), Condvar::new());
    let results = fixture
        .executor
        .execute_bounded_batch(
            &fixture.requests,
            &mut || Ok(()),
            &guard,
            2,
            &|job, capability, cancelled, deadline| {
                rendezvous(&entered);
                compute(job, capability, cancelled, deadline)
            },
        )
        .unwrap();
    assert_eq!(results[0].artifact_hashes, results[1].artifact_hashes);
    assert_eq!(results[0].artifact_hashes.len(), 2);
    for hash in &results[0].artifact_hashes {
        assert!(!fixture.executor.objects.read(hash).unwrap().is_empty());
    }
    assert_eq!(fixture.records("prepared"), 2);
}

#[test]
fn service_callback_adapter_keeps_first_admission_error_sticky() {
    let mut calls = 0;
    let result = preserve_admission_error(
        &mut || {
            calls += 1;
            Err(ControlPlaneError::PersistenceInvalid)
        },
        |admission| {
            assert!(admission().is_err());
            assert!(admission().is_err());
            Ok(())
        },
    );
    assert_eq!(result, Err(ControlPlaneError::PersistenceInvalid));
    assert_eq!(calls, 1);
}
