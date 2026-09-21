//! Actual CLI exports remain detached original-format artifacts. These tests
//! never replace the Node journal or claim process retirement or live migration.
use super::*;

fn arguments(fixture: &Fixture) -> Vec<String> {
    let mut arguments = fixture.arguments(true);
    arguments[0] = "export-legacy-archive".into();
    arguments
}
fn run(fixture: &Fixture) -> Output {
    Command::new(BINARY)
        .args(arguments(fixture))
        .output()
        .unwrap()
}

// Call only after all source SQLite connections are closed. The source's raw
// main/WAL/SHM descriptors must never interfere with held process-level locks.
fn check_bundle(
    fixture: &Fixture,
    exported: &Value,
    expected: &[Vec<Vec<Value>>],
    inspected: &Value,
) -> Value {
    assert_eq!(exported["version"], 1);
    assert_eq!(
        exported["kind"],
        "HeptaLocalStateAuthorityOfflineLegacyArchivePublicationV1"
    );
    assert_eq!(
        exported["evidenceScope"],
        "offline_original_format_archive_no_live_migration_authority"
    );
    assert_eq!(exported["publicationCommitted"], true);
    assert_eq!(exported["outputPath"], json!(fixture.output));
    let archive_path = fixture.output.join("legacy-authority.sqlite");
    let report_path = fixture.output.join("report.json");
    assert_eq!(exported["archivePath"], json!(archive_path));
    assert_eq!(exported["reportPath"], json!(report_path));
    let mut names = fs::read_dir(&fixture.output)
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect::<Vec<_>>();
    names.sort();
    assert_eq!(
        names,
        [
            OsString::from("legacy-authority.sqlite"),
            OsString::from("report.json")
        ]
    );
    assert_eq!(
        fs::metadata(&fixture.output).unwrap().permissions().mode() & 0o7777,
        0o700
    );
    for path in [&archive_path, &report_path] {
        assert_eq!(
            fs::metadata(path).unwrap().permissions().mode() & 0o7777,
            0o600
        );
    }
    let archive_bytes = fs::read(&archive_path).unwrap();
    let report_bytes = fs::read(&report_path).unwrap();
    assert_eq!(exported["archiveSha256"], digest(&archive_bytes));
    assert_eq!(exported["archiveByteLength"], archive_bytes.len());
    assert_eq!(exported["reportSha256"], digest(&report_bytes));
    assert_eq!(exported["reportByteLength"], report_bytes.len());
    let bundle: Value = serde_json::from_slice(&report_bytes).unwrap();
    assert_eq!(bundle["version"], 1);
    assert_eq!(
        bundle["kind"],
        "HeptaLocalStateAuthorityOfflineLegacyArchiveBundleV1"
    );
    assert_eq!(
        bundle["evidenceScope"],
        "offline_original_format_archive_no_migration_or_restore_authority"
    );
    assert_eq!(&bundle["sourceNamespaceObservation"], inspected);
    assert_eq!(inspected["sourceConnectionClosed"], true);
    assert_eq!(inspected["sourceLogicalDataWritten"], false);
    let archive = &bundle["archive"];
    assert_eq!(archive["version"], 1);
    assert_eq!(
        archive["kind"],
        "HeptaLocalStateAuthorityOfflineLegacyArchiveV1"
    );
    assert_eq!(
        archive["evidenceScope"],
        "offline_original_format_archive_no_publication_authority"
    );
    assert_eq!(archive["archiveSha256"], digest(&archive_bytes));
    assert_eq!(archive["archiveByteLength"], archive_bytes.len());
    assert_eq!(archive["userVersion"], 0);
    assert_eq!(archive["backupComplete"], true);
    assert_eq!(archive["sourceHistory"], inspected["history"]);
    for field in ["sourceLogicalHash", "sourceSchemaHash", "rowCounts"] {
        assert_eq!(archive[field], inspected["history"][field]);
    }
    assert_eq!(archive["archiveLogicalHash"], archive["sourceLogicalHash"]);
    for (index, table) in TABLES.iter().enumerate() {
        assert_eq!(archive["rowCounts"][*table], expected[index].len());
    }
    assert_eq!(&archive_bytes[..16], b"SQLite format 3\0");
    match archive["journalHeaderMode"].as_str().unwrap() {
        "rollback" => assert_eq!(archive_bytes[18..20], [1, 1]),
        "wal" => assert_eq!(archive_bytes[18..20], [2, 2]),
        other => panic!("unexpected archive journal mode: {other}"),
    }
    let db = Connection::open_with_flags(&archive_path, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    db.execute_batch("BEGIN DEFERRED").unwrap();
    assert_eq!(rows(&db), expected);
    assert_eq!(
        db.query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert_eq!(
        db.query_row("PRAGMA integrity_check", [], |row| row.get::<_, String>(0))
            .unwrap(),
        "ok"
    );
    for (pragma, field) in [
        ("PRAGMA page_size", "pageSize"),
        ("PRAGMA page_count", "pageCount"),
    ] {
        let actual: i64 = db.query_row(pragma, [], |row| row.get(0)).unwrap();
        assert_eq!(archive[field], actual);
    }
    let reference = Connection::open_in_memory().unwrap();
    reference
        .execute_batch(include_str!(
            "../../src/local_state_authority/migration/source_schema.sql"
        ))
        .unwrap();
    let original_catalog = catalog(&reference);
    // The exact original Node schema excludes the native identity table and
    // retains all original constraints and SQL text, not just six table names.
    assert_eq!(catalog(&db), original_catalog);
    reference.close().unwrap();
    db.execute_batch("ROLLBACK").unwrap();
    db.close().unwrap();

    // Open only the detached archive with Node's actual read-only SQLite API.
    // The same executable already passed production profile qualification in
    // Fixture::node; no substitute runtime or fabricated profile is accepted.
    let node = Command::new("node")
        .arg(
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("tests/local_state_authority_journal_cli/legacy_archive_readonly.mjs"),
        )
        .arg(&archive_path)
        .output()
        .unwrap();
    assert!(
        node.status.success(),
        "{}",
        String::from_utf8_lossy(&node.stderr)
    );
    let node: Value = serde_json::from_slice(&node.stdout).unwrap();
    assert_eq!(node["rows"], json!(expected));
    assert_eq!(node["catalog"], json!(original_catalog));
    assert_eq!(node["userVersion"], 0);
    assert_eq!(node["integrityCheck"], "ok");
    // Read-only reopen must not alter the published bytes or their digest.
    assert_eq!(fs::read(&archive_path).unwrap(), archive_bytes);
    assert_eq!(fs::read(&report_path).unwrap(), report_bytes);
    bundle
}

#[test]
fn actual_node_histories_export_original_schema_and_every_raw_row() {
    for scenario in ["uninitialized", "rebind2", "aborted-tail"] {
        let fixture = Fixture::node(scenario);
        let original_rows = snapshot(&fixture.database());
        let original_bytes = fs::read(fixture.database()).unwrap();
        let inspected = success(fixture.run(false));
        let arguments = arguments(&fixture);
        let inline = std::iter::once(arguments[0].clone()).chain(
            arguments[1..]
                .as_chunks::<2>()
                .0
                .iter()
                .map(|pair| format!("{}={}", pair[0], pair[1])),
        );
        let exported = success(Command::new(BINARY).args(inline).output().unwrap());
        check_bundle(&fixture, &exported, &original_rows, &inspected);
        assert_eq!(fs::read(fixture.database()).unwrap(), original_bytes);
        assert_eq!(snapshot(&fixture.database()), original_rows);
        assert!(!fixture.source.join("fixture-key.pem").exists());
    }
}

#[test]
fn committed_only_wal_rows_reach_the_archive_without_changing_the_old_reader() {
    let fixture = Fixture::node("aborted-tail");
    // From the first SQLite open through the last close below, use only SQL
    // observations; do not read/hash/open raw source main, WAL or SHM files.
    let keeper = Connection::open(fixture.database()).unwrap();
    keeper.pragma_update(None, "journal_mode", "WAL").unwrap();
    keeper.pragma_update(None, "wal_autocheckpoint", 0).unwrap();
    keeper.execute_batch("BEGIN DEFERRED").unwrap();
    let old_rows = rows(&keeper);
    let writer = Connection::open(fixture.database()).unwrap();
    writer.pragma_update(None, "wal_autocheckpoint", 0).unwrap();
    writer.execute_batch("BEGIN IMMEDIATE").unwrap();
    assert_eq!(writer.execute(
        "UPDATE authority_mutation SET reserve_request_json=' '||reserve_request_json||char(10) WHERE global_sequence=1",
        [],
    ).unwrap(), 1);
    writer.execute_batch("COMMIT").unwrap();
    let before: (i64, i64, i64) = writer
        .query_row("PRAGMA wal_checkpoint(PASSIVE)", [], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })
        .unwrap();
    assert_eq!(before.0, 0);
    assert!(before.1 > before.2, "committed frames must remain in WAL");
    let fresh =
        Connection::open_with_flags(fixture.database(), OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    fresh.execute_batch("BEGIN DEFERRED").unwrap();
    let new_rows = rows(&fresh);
    assert_ne!(new_rows, old_rows);
    assert_eq!(
        new_rows[4][0][6].as_str().unwrap(),
        format!(" {}\n", old_rows[4][0][6].as_str().unwrap())
    );
    let inspected = success(fixture.run(false));
    let exported = success(run(&fixture));
    assert_eq!(rows(&keeper), old_rows);
    assert_eq!(rows(&fresh), new_rows);
    let after: (i64, i64, i64) = writer
        .query_row("PRAGMA wal_checkpoint(PASSIVE)", [], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })
        .unwrap();
    assert_eq!(after, before);
    assert_eq!(keeper.total_changes(), 0);
    assert_eq!(fresh.total_changes(), 0);
    fresh.execute_batch("ROLLBACK").unwrap();
    fresh.close().unwrap();
    writer.close().unwrap();
    keeper.execute_batch("ROLLBACK").unwrap();
    keeper.close().unwrap();
    // Raw archive and source observations resume only after all source SQLite
    // connections have closed and the CLI child has exited.
    let source_bytes = fs::read(fixture.database()).unwrap();
    let bundle = check_bundle(&fixture, &exported, &new_rows, &inspected);
    assert_eq!(bundle["archive"]["journalHeaderMode"], "wal");
    assert_eq!(snapshot(&fixture.database()), new_rows);
    assert_eq!(fs::read(fixture.database()).unwrap(), source_bytes);
}

#[test]
fn pending_wrong_pin_and_wrong_key_refusals_leave_no_archive_or_source_change() {
    for scenario in [
        "pending-mutation",
        "pending-schema",
        "pending-rebind",
        "unactivated-rebind",
        "completed-backup",
    ] {
        let fixture = Fixture::node(scenario);
        let before_rows = snapshot(&fixture.database());
        let before = fs::read(fixture.database()).unwrap();
        failure(run(&fixture));
        assert!(!fixture.output.exists());
        assert_eq!(fs::read(fixture.database()).unwrap(), before);
        assert_eq!(snapshot(&fixture.database()), before_rows);
    }
    let mut fixture = Fixture::node("genesis");
    let before = fs::read(fixture.database()).unwrap();
    for pin_index in [4, 8] {
        let mut arguments = arguments(&fixture);
        arguments[pin_index] = digest(b"wrong archive input pin");
        failure(Command::new(BINARY).args(arguments).output().unwrap());
        assert!(!fixture.output.exists());
        assert_eq!(fs::read(fixture.database()).unwrap(), before);
    }
    fixture.pin_public(SigningKey::from_bytes(&[109; 32]).verifying_key());
    failure(run(&fixture));
    assert!(!fixture.output.exists());
    assert_eq!(fs::read(fixture.database()).unwrap(), before);
}

#[test]
fn source_aliases_and_protected_outputs_refuse_and_existing_bundle_is_preserved() {
    let fixture = Fixture::node("genesis");
    let before = fs::read(fixture.database()).unwrap();
    let alias = fixture.source.join("source-alias.sqlite");
    fs::hard_link(fixture.database(), &alias).unwrap();
    failure(run(&fixture));
    assert!(!fixture.output.exists());
    fs::remove_file(&alias).unwrap();
    fs::rename(fixture.database(), &alias).unwrap();
    symlink(&alias, fixture.database()).unwrap();
    failure(run(&fixture));
    assert!(!fixture.output.exists());
    assert_eq!(fs::read(&alias).unwrap(), before);
    fs::remove_file(fixture.database()).unwrap();
    fs::rename(&alias, fixture.database()).unwrap();

    let displaced = fixture.root.join("retained-source-root");
    fs::rename(&fixture.source, &displaced).unwrap();
    symlink(&displaced, &fixture.source).unwrap();
    failure(run(&fixture));
    assert!(!fixture.output.exists());
    assert_eq!(
        fs::read(displaced.join("authority.sqlite")).unwrap(),
        before
    );
    fs::remove_file(&fixture.source).unwrap();
    fs::rename(displaced, &fixture.source).unwrap();

    let protected = fixture.source.join("forbidden-offline-bundle");
    let mut protected_arguments = arguments(&fixture);
    *protected_arguments.last_mut().unwrap() = protected.display().to_string();
    let error = failure(
        Command::new(BINARY)
            .args(protected_arguments)
            .output()
            .unwrap(),
    );
    assert_eq!(error["details"]["publicationCommitted"], false);
    assert!(!protected.exists());
    assert!(!fixture.output.exists());

    success(run(&fixture));
    let archive_path = fixture.output.join("legacy-authority.sqlite");
    let report_path = fixture.output.join("report.json");
    let archive = fs::read(&archive_path).unwrap();
    let report = fs::read(&report_path).unwrap();
    let sentinel = fixture.output.join("existing-user-artifact");
    private_file(&sentinel, b"retain this exact sentinel\n");
    let error = failure(run(&fixture));
    assert_eq!(error["details"]["publicationCommitted"], false);
    assert_eq!(error["details"]["outputPath"], json!(fixture.output));
    assert_eq!(fs::read(sentinel).unwrap(), b"retain this exact sentinel\n");
    assert_eq!(fs::read(archive_path).unwrap(), archive);
    assert_eq!(fs::read(report_path).unwrap(), report);
    assert_eq!(fs::read(fixture.database()).unwrap(), before);
}

#[test]
fn archive_help_checks_all_tokens_before_source_io_and_export_requires_output() {
    let hash = digest(b"nonexistent archive help inputs");
    let valid = vec![
        "export-legacy-archive".to_owned(),
        "--daemon-configuration=/definitely-absent-hepta/daemon.json".into(),
        format!("--daemon-configuration-sha256={hash}"),
        "--online-configuration=/definitely-absent-hepta/online.json".into(),
        format!("--online-configuration-sha256={hash}"),
        "--output-directory=/definitely-absent-hepta-output/bundle".into(),
        "--help".into(),
    ];
    let output = Command::new(BINARY).args(&valid).output().unwrap();
    assert!(output.status.success());
    assert!(output.stderr.is_empty());
    assert!(
        String::from_utf8(output.stdout)
            .unwrap()
            .contains("export-legacy-archive")
    );
    for extra in [
        "--unknown",
        "--output-directory=/another-output",
        "extra-positional",
        "--",
    ] {
        let error = failure(
            Command::new(BINARY)
                .args(&valid)
                .arg(extra)
                .output()
                .unwrap(),
        );
        assert!(
            error["code"]
                .as_str()
                .unwrap()
                .starts_with("local_authority_journal_cli_"),
            "{error}"
        );
    }
    // All source options are lexically valid but absent; missing output must be
    // diagnosed by parsing, before any attempted configuration access.
    let error = failure(Command::new(BINARY).args(&valid[..5]).output().unwrap());
    assert!(
        error["code"]
            .as_str()
            .unwrap()
            .starts_with("local_authority_journal_cli_"),
        "{error}"
    );
    assert_eq!(error["details"]["option"], "output-directory");
}
