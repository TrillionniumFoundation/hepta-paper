//! Real separate-process SQLite writer contention with genuine seven-package
//! signatures. Clock values are deterministic injections, not a changed OS clock
//! or an installed cross-UID authority-intake qualification.

use super::*;
use std::{
    io::BufRead,
    process::{Child, Command, Stdio},
    sync::mpsc,
    thread,
    time::Instant,
};

struct SqliteWriter {
    child: Child,
}

impl SqliteWriter {
    fn acquire(fixture: &AcceptanceFixture) -> Self {
        let ready = fixture.directory.join("sqlite-writer-held");
        let child = Command::new(env::current_exe().expect("actual test executable"))
            .args([
                "--exact",
                "tests::joint_closure::clock_wait::sqlite_writer_child",
                "--ignored",
                "--nocapture",
            ])
            .env(
                "HEPTA_QUALIFICATION_WAIT_DB",
                &fixture.request.replay_ledger.path,
            )
            .env("HEPTA_QUALIFICATION_WAIT_READY", &ready)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("owned separate-process writer");
        let mut owner = Self { child };
        let started = Instant::now();
        while !ready.exists() {
            assert!(owner.child.try_wait().expect("writer state").is_none());
            assert!(started.elapsed() < Duration::from_secs(4), "lock timeout");
            thread::sleep(Duration::from_millis(5));
        }
        assert_eq!(fs::read(ready).expect("actual lock witness"), b"held");
        owner
    }

    fn release(mut self) {
        self.child
            .stdin
            .take()
            .expect("release channel")
            .write_all(b"release\n")
            .expect("release actual writer transaction");
        let started = Instant::now();
        loop {
            if let Some(status) = self.child.try_wait().expect("writer exit") {
                assert!(status.success());
                break;
            }
            assert!(started.elapsed() < Duration::from_secs(4), "exit timeout");
            thread::sleep(Duration::from_millis(5));
        }
    }
}

impl Drop for SqliteWriter {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[test]
#[ignore = "owned helper invoked by the actual SQLite contention regressions"]
fn sqlite_writer_child() {
    let Some(path) = env::var_os("HEPTA_QUALIFICATION_WAIT_DB") else {
        return;
    };
    let ready = env::var_os("HEPTA_QUALIFICATION_WAIT_READY").expect("ready path");
    let mut connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NOFOLLOW,
    )
    .expect("open existing fixture ledger");
    connection
        .busy_timeout(Duration::from_secs(4))
        .expect("timeout");
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .expect("real process holds writer lock");
    fs::write(ready, b"held").expect("lock witness");
    let mut line = String::new();
    io::stdin()
        .lock()
        .read_line(&mut line)
        .expect("release input");
    assert_eq!(line, "release\n");
    transaction
        .rollback()
        .expect("release lock without mutation");
}

fn context(fixture: &AcceptanceFixture, expires: u64) -> VerifiedClosureTrustContextV1<'_> {
    VerifiedClosureTrustContextV1 {
        generation: 1,
        hash: &fixture.signed.trust_hash,
        previous_hash: None,
        store: &fixture.signed.trust,
        issued_at_unix_ms: NOW - 86_400_000,
        expires_at_unix_ms: expires,
    }
}

// The first callback is the post-input/pre-ledger sample. The second must not
// occur while an independent process still holds SQLite's write reservation.
fn accept_after_writer_wait(
    fixture: &AcceptanceFixture,
    trust_expiry: u64,
    after_lock: Result<u64, ClosureError>,
) -> Result<ExternalQualificationClosureReceiptV1, ClosureError> {
    let writer = SqliteWriter::acquire(fixture);
    let (sample_tx, sample_rx) = mpsc::sync_channel(2);
    let (finished_tx, finished_rx) = mpsc::sync_channel(1);
    thread::scope(|scope| {
        let worker = scope.spawn(move || {
            let mut calls = 0;
            let mut after_lock = Some(after_lock);
            let result = verify_and_commit_closure_with_clock(
                &fixture.request,
                &fixture.signed.candidates,
                &context(fixture, trust_expiry),
                NOW,
                || {
                    calls += 1;
                    sample_tx.send(calls).expect("clock sample witness");
                    match calls {
                        1 => Ok(NOW + 100),
                        2 => after_lock.take().expect("exactly one transaction sample"),
                        _ => panic!("unexpected clock sample"),
                    }
                },
            );
            finished_tx.send(()).expect("completion witness");
            result
        });
        assert_eq!(
            sample_rx
                .recv_timeout(Duration::from_secs(4))
                .expect("pre-ledger sample"),
            1
        );
        assert!(matches!(
            finished_rx.recv_timeout(Duration::from_millis(150)),
            Err(mpsc::RecvTimeoutError::Timeout)
        ));
        assert!(
            matches!(sample_rx.try_recv(), Err(mpsc::TryRecvError::Empty)),
            "transaction clock sampled while writer was held"
        );
        writer.release();
        assert_eq!(
            sample_rx
                .recv_timeout(Duration::from_secs(4))
                .expect("post-wait sample"),
            2
        );
        finished_rx
            .recv_timeout(Duration::from_secs(4))
            .expect("bounded acceptance completion");
        worker.join().expect("acceptance worker did not panic")
    })
}

#[derive(Clone, Copy, Debug)]
enum Failure {
    Outer,
    Payload,
    Inner,
    Trust,
    ClockRollback,
    ClockUnavailable,
}

fn configure_failure(fixture: &mut AcceptanceFixture, failure: Failure) -> u64 {
    match failure {
        Failure::Outer => {
            fixture.signed.candidates[0].envelope.expires_at_unix_ms = NOW + 200;
            resign_envelope(&mut fixture.signed.candidates[0], 0);
        }
        Failure::Payload => {
            validity::expire_payload(&mut fixture.signed, 1, "2026-08-30T12:00:00.200Z")
        }
        Failure::Inner => {
            validity::expire_inner(&mut fixture.signed, 3, "2026-08-30T12:00:00.1995Z")
        }
        _ => {}
    }
    fixture.signed.assert_individually_valid();
    if matches!(failure, Failure::Trust) {
        NOW + 200
    } else {
        NOW + 86_400_000
    }
}

fn assert_expected_failure(error: ClosureError, failure: Failure) {
    assert!(
        match failure {
            Failure::Outer | Failure::Payload | Failure::Inner => matches!(
                error,
                ClosureError::Closure(QualificationClosureError::ClosureExpired)
            ),
            Failure::Trust => matches!(error, ClosureError::TrustStoreInvalid),
            Failure::ClockRollback => matches!(error, ClosureError::ClockRollback),
            Failure::ClockUnavailable => matches!(error, ClosureError::ClockInvalid),
        },
        "{failure:?}: {error:?}"
    );
}

#[test]
fn expired_or_unavailable_authority_after_real_writer_wait_cannot_create_acceptance() {
    for failure in [
        Failure::Outer,
        Failure::Payload,
        Failure::Inner,
        Failure::Trust,
        Failure::ClockRollback,
        Failure::ClockUnavailable,
    ] {
        let mut fixture = AcceptanceFixture::new(&format!("clock-new-{failure:?}"));
        let trust_expiry = configure_failure(&mut fixture, failure);
        drop(
            open_replay_ledger(&fixture.request.replay_ledger, fixture.request.consumer_uid)
                .expect("empty ledger for independent lock owner"),
        );
        let before = fixture.snapshot();
        assert!(before.iter().all(|(_, rows)| rows.is_empty()));
        let after_lock = match failure {
            Failure::ClockRollback => Ok(NOW + 99),
            Failure::ClockUnavailable => Err(ClosureError::ClockInvalid),
            _ => Ok(NOW + 200),
        };
        let error = accept_after_writer_wait(&fixture, trust_expiry, after_lock)
            .expect_err("post-wait authority must fail");
        assert_expected_failure(error, failure);
        assert_eq!(
            fixture.snapshot(),
            before,
            "no clock/trust/receipt/nonce mutation for {failure:?}"
        );
    }
}

#[test]
fn expired_exact_replay_is_rejected_before_any_durable_state_advances() {
    for failure in [
        Failure::Outer,
        Failure::Payload,
        Failure::Inner,
        Failure::Trust,
    ] {
        let mut fixture = AcceptanceFixture::new(&format!("clock-replay-{failure:?}"));
        let trust_expiry = configure_failure(&mut fixture, failure);
        fixture
            .accept(NOW)
            .expect("initial valid genuinely signed acceptance");
        let before = fixture.snapshot();
        let error = accept_after_writer_wait(&fixture, trust_expiry, Ok(NOW + 200))
            .expect_err("old receipt does not bypass fresh gate");
        assert_expected_failure(error, failure);
        assert_eq!(fixture.snapshot(), before, "expired replay for {failure:?}");
    }
}

#[test]
fn valid_admission_after_real_writer_wait_records_fresh_time_and_stable_receipt_bytes() {
    for replay in [false, true] {
        let fixture = AcceptanceFixture::new(&format!("clock-valid-{replay}"));
        if replay {
            fixture.accept(NOW).expect("initial current acceptance");
        } else {
            drop(
                open_replay_ledger(&fixture.request.replay_ledger, fixture.request.consumer_uid)
                    .expect("initial empty ledger"),
            );
        }
        let before = fixture.snapshot();
        let receipt = accept_after_writer_wait(&fixture, NOW + 86_400_000, Ok(NOW + 200))
            .expect("still current after contention");
        assert_eq!(
            serde_json::to_vec(&receipt).expect("receipt bytes"),
            legacy_receipt_bytes(&fixture.signed)
        );
        let snapshot = fixture.snapshot();
        assert_eq!(
            snapshot[1].1[0].last(),
            Some(&SqlValue::Integer((NOW + 200) as i64))
        );
        if replay {
            assert_eq!(
                snapshot[0], before[0],
                "same trust generation retains first acceptance time"
            );
            assert_eq!(
                snapshot[2], before[2],
                "exact replay retains original receipt and acceptance time"
            );
            assert_eq!(snapshot[3], before[3], "exact replay cannot add nonces");
        } else {
            assert_eq!(
                snapshot[0].1[0].last(),
                Some(&SqlValue::Integer((NOW + 200) as i64))
            );
            assert_eq!(
                snapshot[2].1[0].last(),
                Some(&SqlValue::Integer((NOW + 200) as i64))
            );
            assert_eq!(snapshot[3].1.len(), 7);
        }
    }
}

#[test]
fn fresh_pre_ledger_time_rejects_expiry_regression_and_clock_failure_without_creating_ledger() {
    for failure in [
        Failure::Outer,
        Failure::Payload,
        Failure::Inner,
        Failure::Trust,
        Failure::ClockRollback,
        Failure::ClockUnavailable,
    ] {
        let mut fixture = AcceptanceFixture::new(&format!("clock-pre-ledger-{failure:?}"));
        let trust_expiry = configure_failure(&mut fixture, failure);
        let mut calls = 0;
        let result = verify_and_commit_closure_with_clock(
            &fixture.request,
            &fixture.signed.candidates,
            &context(&fixture, trust_expiry),
            NOW,
            || {
                calls += 1;
                match failure {
                    Failure::ClockRollback => Ok(NOW - 1),
                    Failure::ClockUnavailable => Err(ClosureError::ClockInvalid),
                    _ => Ok(NOW + 200),
                }
            },
        );
        assert!(result.is_err(), "pre-ledger {failure:?}");
        assert_eq!(calls, 1);
        fixture.assert_no_ledger();
    }
}
