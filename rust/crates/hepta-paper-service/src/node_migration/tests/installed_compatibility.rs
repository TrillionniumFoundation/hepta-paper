use super::*;
use hepta_readonly_control::node_schema::{
    known_installed_online_marker_statements_v1, validate_node_migration_structure_v1,
};
use rusqlite::types::Value as SqlValue;

fn ready_installed() -> (temp::Temp, PathBuf) {
    let (temp, path) = ready_database();
    migrate_node_store_v1(&path, Some(24)).unwrap();
    let db = Connection::open(&path).unwrap();
    // ready_database exercises the general native bootstrap with user_version
    // 1. This fixture instead models the actual Node migration format (0/0).
    db.pragma_update(None, "user_version", 0).unwrap();
    for sql in known_installed_online_marker_statements_v1().unwrap() {
        db.execute_batch(&sql).unwrap();
    }
    let hash = format!("sha256:{}", "a".repeat(64));
    db.execute(
        "INSERT INTO autonomous_research_online_mutation_authority_metadata VALUES(1,1,'external-linearizable-reserve-apply-finalize-v1','native-store','old-instance','old-contract',?1,?1,?1,0,'old-global',0,'old-database','old-state','old-provisioned')",
        [&hash],
    ).unwrap();
    let request = serde_json::json!({"kind":"AutonomousResearchOnlineMutationReserveRequest","oldBytes":"kept \\u0041"}).to_string();
    let receipt = serde_json::json!({"reservationId":"old-marker","requestHash":hash,"databaseRole":"native-store","databaseInstanceId":"old-instance","writerId":"old-writer","operationId":"old-operation","globalSequence":1,"databaseSequence":1,"postStateHash":"old-post"}).to_string();
    db.execute(
        "INSERT INTO autonomous_research_online_mutation_authority_marker VALUES('old-marker','native-store','old-instance','old-writer','old-operation',1,'old-global',1,'old-database','old-schema','old-pre','old-post','old-change',?1,?2,?1,?3,?1,'old-committed')",
        rusqlite::params![hash, request, receipt],
    ).unwrap();
    let finalization = serde_json::json!({"reservationId":"old-marker","sideEffectPermitHash":hash,"oldBytes":"kept"}).to_string();
    db.execute(
        "INSERT INTO autonomous_research_online_mutation_finalization_receipt VALUES('old-marker',?1,?2,?1,'old-finalized','old-recorded')",
        rusqlite::params![hash, finalization],
    ).unwrap();
    drop(db);
    (temp, path)
}

fn retained_records(db: &Connection) -> Vec<Vec<Vec<SqlValue>>> {
    [
        "autonomous_research_online_mutation_authority_metadata",
        "autonomous_research_online_mutation_authority_marker",
        "autonomous_research_online_mutation_finalization_receipt",
    ]
    .iter()
    .map(|table| {
        let mut query = db
            .prepare(&format!("SELECT * FROM {table} ORDER BY 1"))
            .unwrap();
        let count = query.column_count();
        query
            .query_map([], |row| (0..count).map(|index| row.get(index)).collect())
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap()
    })
    .collect()
}

#[test]
fn installed_migration_preserves_all_old_marker_values_under_actual_writer_exclusion() {
    let (_temp, path) = ready_installed();
    let db = Connection::open(&path).unwrap();
    let records = retained_records(&db);
    assert!(validate_node_migration_structure_v1(&db, 24).is_err());
    drop(db);
    let mut phases = Vec::new();
    let receipt = migrate(&path, Some(25), &mut |point, db| {
        if point == "before_transaction" { return; }
        assert_eq!(retained_records(db), records, "{point}");
        let output = Command::new("python3").args(["-c", "import sqlite3,sys\nc=sqlite3.connect(sys.argv[1],timeout=0)\ntry:\n c.execute('BEGIN IMMEDIATE');print('entered');c.rollback()\nexcept sqlite3.OperationalError as e:\n assert 'locked' in str(e);print('blocked')\nfinally:c.close()"])
            .arg(&path).output().unwrap();
        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
        assert_eq!(String::from_utf8(output.stdout).unwrap().trim(), "blocked");
        phases.push(point);
    }).unwrap();
    assert_eq!(
        phases,
        [
            "after_admission",
            "after_migration",
            "before_commit",
            "after_commit",
            "after_hash"
        ]
    );
    assert_eq!(receipt.applied_versions, [25]);
    let observed = receipt.recognized_installed_schema.unwrap();
    assert_eq!(
        observed.profile,
        KnownInstalledNodeProfileV1::NodeMigrationOnlineMutationMarker
    );
    assert!(!observed.authority_granted && !observed.old_authority_records_adopted);
    assert!(!receipt.production_activation && !receipt.node_retirement_verified);
    let db = Connection::open(&path).unwrap();
    assert_eq!(retained_records(&db), records);
    db.execute_batch("BEGIN IMMEDIATE;ROLLBACK").unwrap();
    drop(db);
    assert!(hepta_readonly_store::ReadOnlyStoreV1::open(&path).is_err());
    let read = hepta_readonly_store::ReadOnlyStoreV1::open_known_installed_v1(&path).unwrap();
    assert_eq!(read.schema_version(), 25);
    read.logical_snapshot().unwrap();
    read.verify_unchanged().unwrap();
    hepta_readonly_control::inspect_known_installed_read_only_store_v1(&path).unwrap();
    let retry = migrate_node_store_v1(&path, Some(25)).unwrap();
    assert!(retry.applied_versions.is_empty());
}

#[test]
fn installed_unknown_partial_and_changed_objects_refuse_without_changing_records_or_bytes() {
    for sql in [
        "CREATE TABLE unknown_extra(id INTEGER)",
        "DROP TRIGGER autonomous_research_online_mutation_marker_no_delete",
        "ALTER TABLE autonomous_research_online_mutation_authority_marker ADD COLUMN unknown_extra TEXT",
    ] {
        let (_temp, path) = ready_installed();
        let db = Connection::open(&path).unwrap();
        db.execute_batch(sql).unwrap();
        let records = retained_records(&db);
        drop(db);
        let before = fs::read(&path).unwrap();
        assert!(matches!(
            migrate_node_store_v1(&path, Some(25)),
            Err(NodeMigrationError::History)
        ));
        assert_eq!(fs::read(&path).unwrap(), before);
        let db = Connection::open(&path).unwrap();
        assert_eq!(retained_records(&db), records);
        drop(db);
        assert!(hepta_readonly_store::ReadOnlyStoreV1::open_known_installed_v1(&path).is_err());
    }
}

#[test]
fn installed_cancel_and_fresh_retry_preserve_unadopted_marker_records() {
    let (_temp, path) = ready_installed();
    let db = Connection::open(&path).unwrap();
    let records = retained_records(&db);
    drop(db);
    let original = fs::read(&path).unwrap();
    let stopped = Arc::new(AtomicBool::new(false));
    let control = MigrationControl::bounded(stopped.clone(), Duration::from_secs(30)).unwrap();
    let result = migrate_controlled(&path, Some(25), &control, &mut |point, db| {
        assert_eq!(retained_records(db), records);
        if point == "after_admission" {
            stopped.store(true, std::sync::atomic::Ordering::SeqCst);
        }
    });
    assert!(matches!(result, Err(NodeMigrationError::Cancelled)));
    assert_eq!(fs::read(&path).unwrap(), original);
    let retry = migrate_node_store_v1(&path, Some(25)).unwrap();
    assert_eq!(retry.applied_versions, [25]);
    let db = Connection::open(&path).unwrap();
    assert_eq!(retained_records(&db), records);
}

#[test]
fn installed_process_death_keeps_original_journal_and_private_recovery_keeps_marker_records() {
    use std::os::unix::process::ExitStatusExt;
    use std::time::Instant;
    for phase in ["before_commit", "after_commit"] {
        let (temp, path) = ready_installed();
        let db = Connection::open(&path).unwrap();
        let records = retained_records(&db);
        drop(db);
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "node_migration::tests::migration_crash_child",
                "--ignored",
                "--nocapture",
            ])
            .env("HEPTA_MIGRATION_TEST_DATABASE", &path)
            .env("HEPTA_MIGRATION_TEST_PHASE", phase)
            .spawn()
            .unwrap();
        let started = Instant::now();
        let status = loop {
            if let Some(status) = child.try_wait().unwrap() {
                break status;
            }
            if started.elapsed() > Duration::from_secs(30) {
                child.kill().unwrap();
                child.wait().unwrap();
                panic!("owned migration child exceeded bound");
            }
            std::thread::sleep(Duration::from_millis(5));
        };
        assert_eq!(status.signal(), Some(9));
        let original = fs::read(&path).unwrap();
        let journal = fs::read(path.with_file_name("paper.sqlite-journal")).unwrap();
        for _ in 0..2 {
            assert!(matches!(
                migrate_node_store_v1(&path, Some(25)),
                Err(NodeMigrationError::Sidecar)
            ));
            assert_eq!(fs::read(&path).unwrap(), original);
            assert_eq!(
                fs::read(path.with_file_name("paper.sqlite-journal")).unwrap(),
                journal
            );
        }
        let copy = path.with_file_name("diagnostic.sqlite");
        fs::write(&copy, &original).unwrap();
        fs::write(copy.with_file_name("diagnostic.sqlite-journal"), &journal).unwrap();
        fs::set_permissions(&copy, fs::Permissions::from_mode(0o600)).unwrap();
        let db = Connection::open(&copy).unwrap();
        let version = validate_history(&read_history(&db).unwrap()).unwrap();
        assert_eq!(version, if phase == "before_commit" { 24 } else { 25 });
        assert_eq!(retained_records(&db), records);
        recognize_known_installed_node_migration_structure_v1(&db, version).unwrap();
        drop(db);
        let diagnostic_bytes = fs::read(&copy).unwrap();
        let diagnostic_journal = fs::read(copy.with_file_name("diagnostic.sqlite-journal")).ok();
        // A cold EXCLUSIVE journal is evidence, not permission to delete it.
        // The existing Backup kernel creates a second closed diagnostic DB;
        // only that new file enters normal offline migration.
        crate::state_recoverability::closed_private_backup_for_migration_test_v1(
            &copy,
            temp.path(),
        )
        .unwrap();
        assert_eq!(fs::read(&copy).unwrap(), diagnostic_bytes);
        assert_eq!(
            fs::read(copy.with_file_name("diagnostic.sqlite-journal")).ok(),
            diagnostic_journal
        );
        let recovered = path.with_file_name("recovered.sqlite");
        let retry = migrate_node_store_v1(&recovered, Some(25)).unwrap();
        assert_eq!(
            retry.applied_versions,
            if phase == "before_commit" {
                vec![25]
            } else {
                vec![]
            }
        );
        assert_eq!(fs::read(&path).unwrap(), original);
        assert_eq!(
            fs::read(path.with_file_name("paper.sqlite-journal")).unwrap(),
            journal
        );
    }
}
