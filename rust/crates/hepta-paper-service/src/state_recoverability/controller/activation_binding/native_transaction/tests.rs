//! Uses the parent's genuine ten-database fixture and signed test brokers.
use super::*;
use rusqlite::{Connection, ErrorCode};
use std::{
    io::{BufRead, BufReader, Read},
    process::{Child, ChildStdout},
    time::Duration,
};

fn target(fixture: &Fixture) -> PathBuf {
    let row = fixture.data["manifest"]["databases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["role"] == "native-store")
        .unwrap();
    Path::new(fixture.data["runtime"].as_str().unwrap()).join(row["relativePath"].as_str().unwrap())
}

const CHILD_PREFIX: &str = "state_recoverability::controller::fence::activation_binding::tests::native_transaction_tests::";

fn probe(path: &Path, expected: &str) {
    // Concurrent cargo builds may unlink this running test binary. Proc keeps
    // the actual loaded image available, rather than its replaced pathname.
    let output = Command::new("/proc/self/exe")
        .args([
            "--exact",
            &format!("{CHILD_PREFIX}lock_probe_child"),
            "--nocapture",
        ])
        .env("HEPTA_RECOVERY_TRANSACTION_PROBE", path)
        .env("HEPTA_RECOVERY_TRANSACTION_EXPECTED", expected)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "probe {expected}: {} {}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(
        String::from_utf8_lossy(&output.stdout)
            .contains("actual recoverability process lock probe")
    );
}

#[test]
fn lock_probe_child() {
    let Some(path) = std::env::var_os("HEPTA_RECOVERY_TRANSACTION_PROBE") else {
        return;
    };
    let database = Connection::open(path).unwrap();
    database.busy_timeout(Duration::ZERO).unwrap();
    let result = database.execute_batch("BEGIN IMMEDIATE");
    match std::env::var("HEPTA_RECOVERY_TRANSACTION_EXPECTED")
        .unwrap()
        .as_str()
    {
        "busy" => assert_eq!(
            result.unwrap_err().sqlite_error_code(),
            Some(ErrorCode::DatabaseBusy)
        ),
        "acquired" => {
            result.unwrap();
            database.execute_batch("ROLLBACK").unwrap();
        }
        other => panic!("unknown expected {other}"),
    }
    println!("actual recoverability process lock probe");
}

#[test]
fn wal_holder_child() {
    let Some(path) = std::env::var_os("HEPTA_RECOVERY_TRANSACTION_WAL_HOLDER") else {
        return;
    };
    let database = Connection::open(path).unwrap();
    database.execute_batch("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; UPDATE records SET value='before' WHERE id='subject';").unwrap();
    println!("actual recoverability WAL holder ready");
    std::io::stdout().flush().unwrap();
    let mut done = [0; 1];
    std::io::stdin().read_exact(&mut done).unwrap();
    database.close().unwrap();
}

struct WalHolder {
    child: Option<Child>,
    stdout: BufReader<ChildStdout>,
}
impl WalHolder {
    fn new(path: &Path) -> Self {
        let mut child = Command::new("/proc/self/exe")
            .args([
                "--exact",
                &format!("{CHILD_PREFIX}wal_holder_child"),
                "--nocapture",
            ])
            .env("HEPTA_RECOVERY_TRANSACTION_WAL_HOLDER", path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap();
        let mut stdout = BufReader::new(child.stdout.take().unwrap());
        loop {
            let mut line = String::new();
            assert!(stdout.read_line(&mut line).unwrap() > 0, "WAL child exited");
            if line.contains("actual recoverability WAL holder ready") {
                break;
            }
        }
        Self {
            child: Some(child),
            stdout,
        }
    }
}
impl Drop for WalHolder {
    fn drop(&mut self) {
        let Some(mut child) = self.child.take() else {
            return;
        };
        let _ = child.stdin.take().unwrap().write_all(b"x");
        let mut tail = String::new();
        let _ = self.stdout.read_to_string(&mut tail);
        let status = child.wait().unwrap();
        if !std::thread::panicking() {
            assert!(status.success(), "{tail}");
        }
    }
}

fn run_lock_lifetime(mode: &str, failure: &str) {
    let fixture = Fixture::new();
    let path = target(&fixture);
    // Pre-existing WAL belongs to another OS process. No local SQLite handle
    // exists during inventory/controller full observation or token mint.
    let holder = (mode == "WAL").then(|| WalHolder::new(&path));
    let fence = Fence::new(fixture.controller());
    ready(&fence);
    let inventory = inventory(&fixture);
    let authority = authority(&fixture);
    let binding = binding(&fixture, &fence, &inventory);
    let guard = inventory.native_store_transaction_guard_v1().unwrap();
    if mode == "WAL" {
        assert!(guard.instance()["walFileIdentity"].is_object());
    }
    let weak = Rc::downgrade(fence.state.borrow().controller.evidence.as_ref().unwrap());
    let token = fence
        .retain_native_store_with_pins(&binding, &guard, &authority, || Ok(()))
        .unwrap();
    let calls = fixture.state.borrow().calls.len();
    // Important destructor order: database is declared AFTER the retained token.
    let database = Connection::open(&path).unwrap();
    database
        .execute_batch("BEGIN IMMEDIATE; UPDATE records SET value='staged' WHERE id='subject';")
        .unwrap();
    probe(&path, "busy");
    fence
        .assert_native_store_with_pins(&token, &authority, || Ok(()))
        .unwrap();
    fence.assert_native_store_time(&token, NOW).unwrap();
    probe(&path, "busy");
    // Every full API rejects before inventory/resident I/O; the same scope
    // remains usable because refusal did not perform any partial observation.
    for failure in [
        fence
            .observe_action("sqlite_online_mutation")
            .err()
            .unwrap(),
        fence
            .assert_action_current(&binding.action, "sqlite_online_mutation")
            .unwrap_err(),
        fence.reconcile_with_validity(0).unwrap_err(),
        fence
            .assert_activation_binding_with_pins(&binding, &inventory, &authority, || Ok(()))
            .unwrap_err(),
    ] {
        assert!(
            failure
                .code
                .ends_with("native_transaction_full_observation_forbidden"),
            "{}",
            failure.code
        );
        probe(&path, "busy");
    }
    fence
        .assert_native_store_with_pins(&token, &authority, || Ok(()))
        .unwrap();
    match failure {
        "feedback" => {
            let mut feedback = fence.clone();
            use crate::sqlite_mutation_coordinator::RecoverabilityEpochFenceV1;
            feedback
                .mark_mutation_finalized(&json!({"globalSequence":0,"globalHash":h("global:0")}))
                .unwrap();
            assert!(fence.state.borrow().controller.evidence.is_some());
            // Actual coordinator feedback trait reaches enter_fatal and drops
            // controller evidence; the token still owns the original raw FDs.
            let fatal = feedback
                .mark_mutation_reconciliation_required(&json!({}))
                .unwrap_err();
            assert!(fatal.state_recoverability_fatal);
            assert!(fence.assert_native_store_time(&token, NOW).is_err());
        }
        "clock" => {
            let fatal = fence.assert_native_store_time(&token, NOW - 1).unwrap_err();
            assert!(fatal.code.ends_with("clock_invalid"), "{}", fatal.code);
            assert!(fatal.state_recoverability_fatal);
        }
        "pins" => {
            let err = fence
                .assert_native_store_with_pins(&token, &authority, || {
                    Err(fail("fixture_pin_changed"))
                })
                .unwrap_err();
            assert_eq!(err.code, "fixture_pin_changed");
        }
        _ => unreachable!(),
    }
    assert!(fence.state.borrow().controller.evidence.is_none());
    assert!(
        weak.upgrade().is_some(),
        "token must retain actual evidence after controller clear"
    );
    assert_eq!(
        fixture.state.borrow().calls.len(),
        calls,
        "transaction checks must not invoke brokers"
    );
    probe(&path, "busy");
    // Dropping every shared controller owner still must not release target FDs.
    drop(fence);
    assert!(weak.upgrade().is_some());
    probe(&path, "busy");
    database.execute_batch("ROLLBACK").unwrap();
    database.close().unwrap();
    probe(&path, "acquired");
    drop(token);
    assert!(weak.upgrade().is_none());
    drop(guard);
    drop(inventory);
    drop(holder);
}

#[test]
fn retained_delete_evidence_survives_clear_feedback_and_clock_failures() {
    for failure in ["feedback", "clock", "pins"] {
        run_lock_lifetime("DELETE", failure);
    }
}
#[test]
fn retained_existing_wal_evidence_survives_clear_feedback_and_clock_failures() {
    for failure in ["feedback", "clock", "pins"] {
        run_lock_lifetime("WAL", failure);
    }
}

#[test]
fn direct_fatal_feedback_clears_populated_evidence_without_releasing_sqlite_locks() {
    for mode in ["DELETE", "WAL"] {
        run_lock_lifetime(mode, "feedback");
    }
}

#[test]
fn retained_scope_rejects_other_inventory_resident_root_and_same_head_renewal() {
    let fixture = Fixture::new();
    let other = Fixture::new();
    let fence = Fence::new(fixture.controller());
    ready(&fence);
    let own = inventory(&fixture);
    let other_inventory = inventory(&other);
    let authority = authority(&fixture);
    let proof = binding(&fixture, &fence, &own);
    let wrong_guard = other_inventory.native_store_transaction_guard_v1().unwrap();
    assert!(
        fence
            .retain_native_store_with_pins(&proof, &wrong_guard, &authority, || Ok(()))
            .is_err()
    );
    {
        let state = fence.state.borrow();
        let evidence = state.controller.evidence.as_ref().unwrap();
        evidence.resident.assert_inventory_binding(&own).unwrap();
        assert!(
            evidence
                .resident
                .assert_inventory_binding(&other_inventory)
                .is_err()
        );
    }
    ready(&fence);
    let guard = own.native_store_transaction_guard_v1().unwrap();
    assert!(
        fence
            .retain_native_store_with_pins(&proof, &guard, &authority, || Ok(()))
            .is_err()
    );

    // A separately valid resident row under another root cannot qualify this
    // controller even though the row claims match and the signed head is equal.
    let mut controller = fixture.controller();
    let claim = &other.data["lease"];
    controller.lease = ResidentLeaseV1::new(
        Path::new(other.data["runtime"].as_str().unwrap()),
        claim["ownerId"].as_str().unwrap(),
        claim["leaseToken"].as_str().unwrap(),
        claim["leaseGeneration"].as_i64().unwrap(),
    )
    .unwrap();
    let wrong_resident_fence = Fence::new(controller);
    ready(&wrong_resident_fence);
    let proof = binding(&fixture, &wrong_resident_fence, &own);
    let error = wrong_resident_fence
        .retain_native_store_with_pins(&proof, &guard, &authority, || Ok(()))
        .err()
        .unwrap();
    assert!(
        error.code.ends_with("resident_inventory_binding_mismatch"),
        "{}",
        error.code
    );
}

#[test]
fn retained_scope_rejects_non_target_change_and_holds_fd_until_connection_close() {
    let fixture = Fixture::new();
    let fence = Fence::new(fixture.controller());
    ready(&fence);
    let inventory = inventory(&fixture);
    let authority = authority(&fixture);
    let proof = binding(&fixture, &fence, &inventory);
    let guard = inventory.native_store_transaction_guard_v1().unwrap();
    let weak = Rc::downgrade(fence.state.borrow().controller.evidence.as_ref().unwrap());
    let token = fence
        .retain_native_store_with_pins(&proof, &guard, &authority, || Ok(()))
        .unwrap();
    let path = target(&fixture);
    let database = Connection::open(&path).unwrap();
    database
        .execute_batch("BEGIN IMMEDIATE; UPDATE records SET value='staged';")
        .unwrap();
    let resident = Path::new(fixture.data["runtime"].as_str().unwrap())
        .join("autonomous-research/supervisor/resident-instance.sqlite");
    // Different pre-bound inode: this deliberate non-target writer is safe for
    // the target lock but must invalidate the transaction's inventory proof.
    let other = Connection::open(resident).unwrap();
    other
        .execute_batch("UPDATE records SET value='changed';")
        .unwrap();
    other.close().unwrap();
    assert!(
        fence
            .assert_native_store_with_pins(&token, &authority, || Ok(()))
            .is_err()
    );
    assert!(fence.state.borrow().controller.evidence.is_none());
    assert!(weak.upgrade().is_some());
    probe(&path, "busy");
    database.execute_batch("ROLLBACK").unwrap();
    database.close().unwrap();
    drop(token);
    assert!(weak.upgrade().is_none());
}

#[test]
fn retained_scope_unwind_closes_sqlite_before_last_evidence_reference() {
    let fixture = Fixture::new();
    let fence = Fence::new(fixture.controller());
    ready(&fence);
    let inventory = inventory(&fixture);
    let authority = authority(&fixture);
    let proof = binding(&fixture, &fence, &inventory);
    let guard = inventory.native_store_transaction_guard_v1().unwrap();
    let weak = Rc::downgrade(fence.state.borrow().controller.evidence.as_ref().unwrap());
    let path = target(&fixture);
    struct CloseFirst<F: FnOnce()>(Option<F>);
    impl<F: FnOnce()> Drop for CloseFirst<F> {
        fn drop(&mut self) {
            self.0.take().unwrap()();
        }
    }
    let unwound = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let token = fence
            .retain_native_store_with_pins(&proof, &guard, &authority, || Ok(()))
            .unwrap();
        let database = Connection::open(&path).unwrap();
        database
            .execute_batch("BEGIN IMMEDIATE; UPDATE records SET value='staged';")
            .unwrap();
        let _close_first = CloseFirst(Some(|| {
            assert!(
                weak.upgrade().is_some(),
                "evidence must outlive owning connection"
            );
            probe(&path, "busy");
            database.close().unwrap();
        }));
        assert!(fence.assert_native_store_time(&token, NOW - 1).is_err());
        panic!("fixture unwind after fatal invalidation");
    }));
    assert!(unwound.is_err());
    assert!(weak.upgrade().is_none());
    probe(&path, "acquired");
}
