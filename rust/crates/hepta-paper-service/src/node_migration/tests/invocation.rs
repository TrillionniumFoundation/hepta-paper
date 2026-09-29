use super::*;
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use std::time::{Duration, Instant};

#[test]
fn pre_cancelled_and_expired_invocations_do_not_enter_source_or_transaction() {
    let (_temp, path) = ready_database();
    let before = fs::read(&path).unwrap();
    let stopped = Arc::new(AtomicBool::new(true));
    let cancelled = MigrationControl::bounded(stopped, Duration::from_secs(5)).unwrap();
    let expired =
        MigrationControl::bounded(Arc::new(AtomicBool::new(false)), Duration::from_nanos(1))
            .unwrap();
    std::thread::sleep(Duration::from_millis(1));
    for (control, cancel) in [(cancelled, true), (expired, false)] {
        let error =
            migrate_controlled(&path, Some(25), &control, &mut |_| panic!("must not enter"))
                .unwrap_err();
        assert!(
            matches!(error, NodeMigrationError::Cancelled) == cancel,
            "{error:?}"
        );
        if !cancel {
            assert!(matches!(error, NodeMigrationError::DeadlineExceeded));
        }
        assert_eq!(fs::read(&path).unwrap(), before);
        reject_sidecars(&path).unwrap();
    }
    for timeout in [
        Duration::ZERO,
        Duration::from_millis(NODE_MIGRATION_MAX_TIMEOUT_MS + 1),
    ] {
        assert!(matches!(
            migrate_node_store_with_control_v1(
                &path,
                Some(25),
                Arc::new(AtomicBool::new(false)),
                timeout,
            ),
            Err(NodeMigrationError::ControlPolicy)
        ));
        assert_eq!(fs::read(&path).unwrap(), before);
    }
}

#[test]
fn cancellation_preserves_atomic_range_and_postcommit_unknown_outcome() {
    for phase in [
        "before_transaction",
        "after_admission",
        "after_migration",
        "before_commit",
        "after_commit",
        "after_hash",
    ] {
        let (_temp, path) = ready_database();
        let before = fs::read(&path).unwrap();
        let stopped = Arc::new(AtomicBool::new(false));
        let control =
            MigrationControl::bounded(Arc::clone(&stopped), Duration::from_secs(30)).unwrap();
        let mut reached = false;
        let error = migrate_controlled(&path, Some(25), &control, &mut |point| {
            if point == phase {
                reached = true;
                stopped.store(true, Ordering::Release);
            }
        })
        .unwrap_err();
        assert!(reached, "{phase}: {error:?}");
        let committed = matches!(phase, "after_commit" | "after_hash");
        if committed {
            assert!(
                matches!(error, NodeMigrationError::OutcomeUnknown),
                "{phase}: {error:?}"
            );
        } else {
            assert!(
                matches!(error, NodeMigrationError::Cancelled),
                "{phase}: {error:?}"
            );
            assert_eq!(fs::read(&path).unwrap(), before, "{phase}");
        }
        reject_sidecars(&path).unwrap();
        let db = Connection::open(&path).unwrap();
        assert_eq!(
            validate_history(&read_history(&db).unwrap()).unwrap(),
            if committed { 25 } else { 2 }
        );
        drop(db);
        let retry = migrate_node_store_v1(&path, Some(25)).unwrap();
        assert_eq!(retry.before_version, if committed { 25 } else { 2 });
        assert_eq!(retry.applied_versions.is_empty(), committed);
    }
}

#[test]
fn monotonic_deadline_at_commit_boundary_does_not_invent_rollback() {
    for phase in ["before_commit", "after_commit"] {
        let (_temp, path) = ready_database();
        let before = fs::read(&path).unwrap();
        let control =
            MigrationControl::bounded(Arc::new(AtomicBool::new(false)), Duration::from_secs(2))
                .unwrap();
        let mut reached = false;
        let error = migrate_controlled(&path, Some(25), &control, &mut |point| {
            if point == phase {
                reached = true;
                while control.check().is_ok() {
                    std::thread::sleep(Duration::from_millis(1));
                }
            }
        })
        .unwrap_err();
        assert!(reached, "{phase}: {error:?}");
        if phase == "before_commit" {
            assert!(matches!(error, NodeMigrationError::DeadlineExceeded));
            assert_eq!(fs::read(&path).unwrap(), before);
        } else {
            assert!(matches!(error, NodeMigrationError::OutcomeUnknown));
        }
        let retry = migrate_node_store_v1(&path, Some(25)).unwrap();
        assert_eq!(
            retry.before_version,
            if phase == "before_commit" { 2 } else { 25 }
        );
    }
}

#[test]
fn sqlite_progress_deadline_interrupts_work_without_interrupting_rollback() {
    let (_temp, path) = ready_database();
    let before = fs::read(&path).unwrap();
    let source = source::MigrationSource::open(&path).unwrap();
    let mut db = Connection::open(&path).unwrap();
    let control =
        MigrationControl::bounded(Arc::new(AtomicBool::new(false)), Duration::from_millis(100))
            .unwrap();
    let enabled = control.install(&db).unwrap();
    let transaction = db
        .transaction_with_behavior(TransactionBehavior::Exclusive)
        .unwrap();
    let cleanup = RollbackProgressGuard(enabled);
    transaction
        .execute_batch("CREATE TABLE rollback_probe(value INTEGER);")
        .unwrap();
    let began = Instant::now();
    let result: rusqlite::Result<i64> = transaction.query_row(
        "WITH RECURSIVE n(x) AS (VALUES(0) UNION ALL SELECT x+1 FROM n WHERE x<1000000000) SELECT sum(x) FROM n",
        [], |row| row.get(0),
    );
    assert!(matches!(
        control.translate(result.unwrap_err().into()),
        NodeMigrationError::DeadlineExceeded
    ));
    assert!(began.elapsed() < Duration::from_secs(10));
    cleanup.disarm();
    if !transaction.is_autocommit() {
        transaction.rollback().unwrap();
    } else {
        drop(transaction);
    }
    source.assert_current().unwrap();
    drop(db);
    drop(source);
    assert_eq!(fs::read(&path).unwrap(), before);
    reject_sidecars(&path).unwrap();
}

#[test]
fn retained_hash_checks_control_between_bounded_reads_without_mutation() {
    let (_temp, path) = ready_database();
    let db = Connection::open(&path).unwrap();
    db.execute_batch(
        "CREATE TABLE hash_probe(data BLOB); INSERT INTO hash_probe VALUES(zeroblob(200000));",
    )
    .unwrap();
    drop(db);
    let before = fs::read(&path).unwrap();
    let source = source::MigrationSource::open(&path).unwrap();
    let mut checks = 0;
    let error = source
        .hash_with_check(&mut || {
            checks += 1;
            if checks == 3 {
                Err(NodeMigrationError::Cancelled)
            } else {
                Ok(())
            }
        })
        .unwrap_err();
    assert!(matches!(error, NodeMigrationError::Cancelled));
    assert_eq!(checks, 3);
    assert_eq!(fs::read(&path).unwrap(), before);
    assert_eq!(
        source.hash_with_check(&mut || Ok(())).unwrap(),
        format!("sha256:{}", hex::encode(Sha256::digest(&before)))
    );
}

#[test]
fn migration_sql_vm_deadline_rolls_back_the_real_owner_and_retries_once() {
    let (_temp, path) = ready_database();
    let db = Connection::open(&path).unwrap();
    // Inject expensive SQL at the original migration-history write. The
    // production owner, not a test-built transaction, executes migration 3.
    db.execute_batch(
        "CREATE TABLE migration_stop_probe(value INTEGER);
         CREATE TRIGGER slow_migration_history AFTER INSERT ON schema_migrations
         BEGIN
           INSERT INTO migration_stop_probe VALUES(1);
           SELECT sum(x) FROM (
             WITH RECURSIVE n(x) AS (
               VALUES(0) UNION ALL SELECT x+1 FROM n WHERE x<1000000000
             ) SELECT x FROM n
           );
         END;",
    )
    .unwrap();
    drop(db);
    let before = fs::read(&path).unwrap();
    let control =
        MigrationControl::bounded(Arc::new(AtomicBool::new(false)), Duration::from_millis(500))
            .unwrap();
    let mut admitted = false;
    let mut migration_completed = false;
    let began = Instant::now();
    let error = migrate_controlled(&path, Some(3), &control, &mut |point| {
        admitted |= point == "after_admission";
        migration_completed |= point == "after_migration";
    })
    .unwrap_err();
    assert!(admitted && !migration_completed, "{error:?}");
    assert!(matches!(error, NodeMigrationError::DeadlineExceeded));
    assert!(began.elapsed() < Duration::from_secs(10));
    assert_eq!(fs::read(&path).unwrap(), before);
    reject_sidecars(&path).unwrap();
    let db = Connection::open(&path).unwrap();
    assert_eq!(validate_history(&read_history(&db).unwrap()).unwrap(), 2);
    let rows: i64 = db
        .query_row("SELECT count(*) FROM migration_stop_probe", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(rows, 0, "trigger writes must roll back with the migration");
    // Remove only the owned fault injection, then use the original public owner.
    db.execute_batch("DROP TRIGGER slow_migration_history;")
        .unwrap();
    drop(db);
    let retry = migrate_node_store_with_control_v1(
        &path,
        Some(3),
        Arc::new(AtomicBool::new(false)),
        Duration::from_secs(30),
    )
    .unwrap();
    assert_eq!(retry.before_version, 2);
    assert_eq!(retry.applied_versions, [3]);
    let replay = migrate_node_store_with_control_v1(
        &path,
        Some(3),
        Arc::new(AtomicBool::new(false)),
        Duration::from_secs(30),
    )
    .unwrap();
    assert_eq!(replay.before_version, 3);
    assert!(replay.applied_versions.is_empty());
}

#[test]
fn sqlite_wait_rounding_preserves_fractional_deadline_without_extending_admission() {
    for (nanos, millis) in [
        (0, 0),
        (1, 1),
        (999_999, 1),
        (1_000_000, 1),
        (1_000_001, 2),
        (9_999_999, 10),
        (100_000_000, 100),
    ] {
        let input = Duration::from_nanos(nanos);
        let actual = control::sqlite_wait_duration(input).unwrap();
        assert_eq!(actual, Duration::from_millis(millis));
        assert!(actual >= input && actual - input < Duration::from_millis(1));
    }
    let expired =
        MigrationControl::bounded(Arc::new(AtomicBool::new(false)), Duration::from_nanos(1))
            .unwrap();
    std::thread::sleep(Duration::from_millis(1));
    assert!(matches!(
        expired.lock_wait(Duration::from_millis(100)),
        Err(NodeMigrationError::DeadlineExceeded)
    ));
}
