//! Reuse actual Node history fixtures; no archive or migration proof is forged.
use super::*;
use crate::local_state_authority::migration::OfflineLegacyAuthorityArchiveV1;

fn write_new_archive(
    fixture: &Fixture,
    name: &str,
    archive: &OfflineLegacyAuthorityArchiveV1,
) -> PathBuf {
    let path = fixture.root.join(name);
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&path)
        .unwrap();
    file.write_all(archive.bytes()).unwrap();
    file.sync_all().unwrap();
    path
}
fn check_archive(
    fixture: &Fixture,
    archive: &OfflineLegacyAuthorityArchiveV1,
    expected: &[Vec<Vec<Value>>],
    name: &str,
) {
    assert_eq!(
        archive.report()["kind"],
        "HeptaLocalStateAuthorityOfflineLegacyArchiveV1"
    );
    assert_eq!(
        archive.report()["evidenceScope"],
        "offline_original_format_archive_no_publication_authority"
    );
    assert_eq!(
        archive.report()["archiveSha256"],
        hash_bytes(archive.bytes())
    );
    assert_eq!(archive.report()["archiveByteLength"], archive.bytes().len());
    assert_eq!(
        archive.report()["sourceLogicalHash"],
        archive.report()["archiveLogicalHash"]
    );
    assert_eq!(archive.report()["backupComplete"], true);
    // Ordinary SQLite file reopen supports an original WAL header with all
    // committed pages already copied. No original WAL/SHM is copied or needed.
    let path = write_new_archive(fixture, name, archive);
    let db = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    begin_read(&db);
    inspect_source_schema(&db).unwrap();
    assert_eq!(&exact_rows(&db), expected);
    assert_eq!(
        read_source_rows(&db).unwrap().logical_hash(),
        archive.report()["sourceLogicalHash"].as_str().unwrap()
    );
    assert_eq!(
        db.query_row("PRAGMA integrity_check", [], |row| row.get::<_, String>(0))
            .unwrap(),
        "ok"
    );
    db.execute_batch("ROLLBACK").unwrap();
    db.close().unwrap();
}

#[test]
fn full_original_format_archive_reopens_in_sqlite_and_the_actual_node_runtime() {
    for scenario in [
        "uninitialized",
        "genesis",
        "rebind2",
        "multirole",
        "aborted-tail",
    ] {
        let fixture = Fixture::node(scenario);
        let before = fs::read(fixture.path()).unwrap();
        let original_config = fs::read(fixture.root.join("configuration.json")).unwrap();
        let archive;
        {
            let verifier = fixture.load();
            let db = fixture.source(false);
            let exact = exact_rows(&db);
            let changes = db.total_changes();
            archive = verifier.build_offline_legacy_archive(&db).unwrap();
            check_archive(&fixture, &archive, &exact, "original-format.sqlite");
            assert_eq!(db.total_changes(), changes);
            assert_eq!(
                db.transaction_state(Some("main")).unwrap(),
                TransactionState::Read
            );
            assert_eq!(exact_rows(&db), exact);
            db.execute_batch("ROLLBACK").unwrap();
            db.close().unwrap();
        }
        assert_eq!(fs::read(fixture.path()).unwrap(), before);
        fixture.install_detached_image(archive.bytes());
        let service = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let script = "import {pathToFileURL} from 'node:url'; const {createLocalAutonomousResearchStateAuthority:create}=await import(pathToFileURL(process.argv[1])); const runtime=create({configurationPath:process.argv[2]}); try {process.stdout.write(JSON.stringify(runtime.inspect()));} finally {runtime.close();}";
        let output = Command::new("node")
            .args(["--input-type=module", "-e", script])
            .arg(service.ancestors().nth(3).unwrap().join(
                "paper-adapters/automation/local-autonomous-research-state-authority-runtime.mjs",
            ))
            .arg(fixture.root.join("configuration.json"))
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let actual: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(
            actual["globalSequence"],
            archive.report()["sourceHistory"]["head"]["globalSequence"]
        );
        assert_eq!(
            actual["globalHash"],
            archive.report()["sourceHistory"]["head"]["globalHash"]
        );
        assert_eq!(
            fs::read(fixture.root.join("configuration.json")).unwrap(),
            original_config
        );
        let verifier = fixture.load();
        let db = fixture.source(false);
        assert_eq!(
            verifier.inspect(&db).unwrap(),
            archive.report()["sourceHistory"]
        );
    }
}

#[test]
fn archive_copies_both_old_and_new_wal_snapshots_without_checkpointing_or_releasing_them() {
    let fixture = Fixture::node("aborted-tail");
    let verifier = fixture.load();
    let keeper = Connection::open(fixture.path()).unwrap();
    keeper.pragma_update(None, "journal_mode", "WAL").unwrap();
    keeper.pragma_update(None, "wal_autocheckpoint", 0).unwrap();
    begin_read(&keeper);
    let old = exact_rows(&keeper);
    let writer = Connection::open(fixture.path()).unwrap();
    writer.pragma_update(None, "wal_autocheckpoint", 0).unwrap();
    writer.execute("UPDATE authority_mutation SET reserve_request_json=' '||reserve_request_json||char(10) WHERE global_sequence=1",[]).unwrap();
    let (_, log, checkpointed): (i64, i64, i64) = writer
        .query_row("PRAGMA wal_checkpoint(PASSIVE)", [], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })
        .unwrap();
    assert!(log > checkpointed);
    let fresh = fixture.source(false);
    let new = exact_rows(&fresh);
    assert_ne!(old, new);
    let old_archive = verifier.build_offline_legacy_archive(&keeper).unwrap();
    let new_archive = verifier.build_offline_legacy_archive(&fresh).unwrap();
    assert_ne!(
        old_archive.report()["sourceLogicalHash"],
        new_archive.report()["sourceLogicalHash"]
    );
    assert_eq!(old_archive.report()["journalHeaderMode"], "wal");
    assert_eq!(new_archive.report()["journalHeaderMode"], "wal");
    check_archive(&fixture, &old_archive, &old, "old-snapshot.sqlite");
    check_archive(&fixture, &new_archive, &new, "new-snapshot.sqlite");
    assert_eq!(exact_rows(&keeper), old);
    assert_eq!(exact_rows(&fresh), new);
    let (_, log_after, checkpointed_after): (i64, i64, i64) = writer
        .query_row("PRAGMA wal_checkpoint(PASSIVE)", [], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })
        .unwrap();
    assert_eq!((log_after, checkpointed_after), (log, checkpointed));
}

#[test]
fn write_transactions_pending_histories_and_wrong_keys_refuse_without_altering_source() {
    for mode in ["DELETE", "WAL"] {
        let fixture = Fixture::node("genesis");
        {
            let db = Connection::open(fixture.path()).unwrap();
            db.pragma_update(None, "journal_mode", mode).unwrap();
        }
        let verifier = fixture.load();
        let db = fixture.source(true);
        let rows = exact_rows(&db);
        peer(&fixture, true);
        assert_eq!(
            verifier
                .build_offline_legacy_archive(&db)
                .err()
                .unwrap()
                .code,
            "local_authority_archive_main_read_snapshot_required"
        );
        peer(&fixture, true);
        assert_eq!(exact_rows(&db), rows);
        db.execute_batch("ROLLBACK").unwrap();
        assert!(verifier.build_offline_legacy_archive(&db).is_err());
        db.execute_batch("BEGIN DEFERRED").unwrap();
        assert!(verifier.build_offline_legacy_archive(&db).is_err());
    }
    for scenario in [
        "pending-schema",
        "pending-rebind",
        "unactivated-rebind",
        "pending-mutation",
        "completed-backup",
        "wrong-key",
    ] {
        let mut fixture = Fixture::node(if scenario == "wrong-key" {
            "genesis"
        } else {
            scenario
        });
        if scenario == "wrong-key" {
            fixture.pin_public(SigningKey::from_bytes(&[38; 32]).verifying_key());
        }
        let before = fs::read(fixture.path()).unwrap();
        {
            let verifier = fixture.load();
            let db = fixture.source(false);
            let rows = exact_rows(&db);
            assert!(
                verifier.build_offline_legacy_archive(&db).is_err(),
                "{scenario}"
            );
            assert_eq!(exact_rows(&db), rows);
            assert_eq!(db.total_changes(), 0);
            assert_eq!(
                db.transaction_state(Some("main")).unwrap(),
                TransactionState::Read
            );
            db.execute_batch("ROLLBACK").unwrap();
            db.close().unwrap();
        }
        assert_eq!(fs::read(fixture.path()).unwrap(), before);
    }
}

#[test]
fn original_page_size_is_preserved_and_full_physical_allocation_is_bounded() {
    for page_size in [512, 16_384] {
        let fixture = Fixture::node("multirole");
        {
            let db = Connection::open(fixture.path()).unwrap();
            db.pragma_update(None, "journal_mode", "DELETE").unwrap();
            db.pragma_update(None, "page_size", page_size).unwrap();
            db.execute_batch("VACUUM").unwrap();
        }
        let verifier = fixture.load();
        let db = fixture.source(false);
        let exact = exact_rows(&db);
        let archive = verifier.build_offline_legacy_archive(&db).unwrap();
        assert_eq!(archive.report()["pageSize"], page_size);
        assert_eq!(archive.report()["journalHeaderMode"], "rollback");
        check_archive(&fixture, &archive, &exact, "different-page-size.sqlite");
    }
    let fixture = Fixture::node("uninitialized");
    {
        let db = Connection::open(fixture.path()).unwrap();
        db.pragma_update(None, "journal_mode", "DELETE").unwrap();
        db.execute_batch("CREATE TABLE allocation_probe(x BLOB); INSERT INTO allocation_probe VALUES(zeroblob(201326592)); DROP TABLE allocation_probe;").unwrap();
    }
    let verifier = fixture.load();
    let db = fixture.source(false);
    inspect_source_schema(&db).unwrap();
    let before = read_source_rows(&db).unwrap().logical_hash().to_owned();
    assert_eq!(
        verifier
            .build_offline_legacy_archive(&db)
            .err()
            .unwrap()
            .code,
        "local_authority_archive_limit_exceeded"
    );
    assert_eq!(read_source_rows(&db).unwrap().logical_hash(), before);
    assert_eq!(db.total_changes(), 0);
}
