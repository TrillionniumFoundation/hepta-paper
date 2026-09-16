use super::*;
fn database(sql: &str) -> Connection {
    let db = Connection::open_in_memory().unwrap();
    db.execute_batch(sql).unwrap();
    db
}
#[test]
fn complete_effective_rows_include_null_primary_keys_duplicates_and_hidden_rowids() {
    for schema in [
        "CREATE TABLE records(value TEXT)",
        "CREATE TABLE records(id TEXT PRIMARY KEY,value TEXT)",
    ] {
        let a = database(schema);
        let b = database(schema);
        for db in [&a, &b] {
            db.execute("INSERT INTO records(value) VALUES('same')", [])
                .unwrap();
        }
        assert_eq!(
            equivalence::effective_digest(&a).unwrap(),
            equivalence::effective_digest(&b).unwrap()
        );
        b.execute("INSERT INTO records(value) VALUES('same')", [])
            .unwrap();
        assert_ne!(
            equivalence::effective_digest(&a).unwrap(),
            equivalence::effective_digest(&b).unwrap(),
            "duplicate/no-PK or NULL-PK row must be observed"
        );
        b.execute("DELETE FROM records WHERE rowid=2", []).unwrap();
        assert_eq!(
            equivalence::effective_digest(&a).unwrap(),
            equivalence::effective_digest(&b).unwrap()
        );
        b.execute("UPDATE records SET rowid=7", []).unwrap();
        assert_ne!(
            equivalence::effective_digest(&a).unwrap(),
            equivalence::effective_digest(&b).unwrap(),
            "hidden rowid is part of effective state"
        );
        assert!(a.is_autocommit() && b.is_autocommit());
    }
    let a = database("CREATE TABLE typed(value); INSERT INTO typed VALUES('ab')");
    let b = database("CREATE TABLE typed(value); INSERT INTO typed VALUES(X'6162')");
    assert_ne!(
        equivalence::effective_digest(&a).unwrap(),
        equivalence::effective_digest(&b).unwrap(),
        "TEXT and BLOB with equal bytes are different state"
    );
}
#[test]
fn unsupported_or_unbounded_state_never_gets_an_effective_digest() {
    for sql in [
        "CREATE TABLE bad(value TEXT); INSERT INTO bad VALUES(CAST(X'80' AS TEXT))",
        "CREATE TABLE bad(_rowid_ TEXT,rowid TEXT,oid TEXT); INSERT INTO bad VALUES('x','y','z')",
        "CREATE VIRTUAL TABLE bad USING fts5(value)",
        "CREATE TABLE bad(value BLOB); INSERT INTO bad VALUES(zeroblob(16777217))",
    ] {
        let db = database(sql);
        assert!(
            equivalence::effective_digest(&db).is_err(),
            "unsupported input: {sql}"
        );
        assert!(db.is_autocommit());
    }
}

#[test]
fn historical_candidate_currentness_rechecks_exact_database_namespace() {
    use std::os::unix::fs::PermissionsExt;
    let mut random = [0u8; 16];
    getrandom::fill(&mut random).unwrap();
    let root = std::env::temp_dir().join(format!(
        "hepta-heartbeat-directory-{}-{}",
        std::process::id(),
        hex::encode(random)
    ));
    fs::create_dir(&root).unwrap();
    fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
    fs::create_dir(root.join("databases")).unwrap();
    fs::set_permissions(root.join("databases"), fs::Permissions::from_mode(0o700)).unwrap();
    let manifest = root.join("AUTONOMOUS_RESEARCH_STATE_BACKUP.json");
    let database = root.join("databases/only.sqlite");
    fs::write(&manifest, b"{}").unwrap();
    fs::write(&database, b"pinned fixture bytes").unwrap();
    for path in [&manifest, &database] {
        fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
    }
    // This private unit fixture exercises file-set observations only. It is
    // never passed to replay, any production constructor, or a ready path.
    let candidate = HistoricalBackupCandidateV1 {
        path: root.clone(),
        directory: Directory::open_or_create(&root, false).unwrap(),
        manifest: Snapshot::load(&manifest, &hash_bytes(b"{}"), 1024, "fixture").unwrap(),
        bundle: json!({}),
        databases: vec![(
            json!({"backupRelativePath":"databases/only.sqlite"}),
            Snapshot::load(
                &database,
                &hash_bytes(b"pinned fixture bytes"),
                1024,
                "fixture",
            )
            .unwrap(),
        )],
    };
    candidate.assert_current().unwrap();
    let foreign = root.join("databases/foreign.sqlite");
    fs::write(&foreign, b"foreign file must remain").unwrap();
    assert_eq!(
        candidate.assert_current().unwrap_err().code,
        "autonomous_research_state_heartbeat_history_database_set_mismatch"
    );
    assert_eq!(fs::read(&foreign).unwrap(), b"foreign file must remain");
    drop(candidate);
    fs::remove_dir_all(root).unwrap();
}
