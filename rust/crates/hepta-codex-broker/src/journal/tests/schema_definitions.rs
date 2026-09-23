use super::*;

#[test]
fn every_named_append_only_trigger_is_checked_by_definition() {
    let reference = rusqlite::Connection::open_in_memory().expect("reference schema");
    reference
        .execute_batch(crate::journal::schema::SCHEMA_SQL)
        .expect("compiled schema");
    let mut statement = reference
        .prepare("SELECT name, tbl_name FROM sqlite_schema WHERE type = 'trigger'")
        .expect("compiled trigger inventory");
    let triggers = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .expect("compiled triggers")
        .collect::<Result<Vec<_>, _>>()
        .expect("complete trigger inventory");
    assert_eq!(triggers.len(), 14);
    for (name, table) in triggers {
        let fixture = TempJournal::new();
        let store = fixture.open();
        let replacement = rusqlite::Connection::open(&fixture.path).expect("actual database");
        // These identifiers come only from the compiled, in-memory reference.
        replacement
            .execute_batch(&format!(
                "DROP TRIGGER {name};
                 CREATE TRIGGER {name} BEFORE DELETE ON {table} BEGIN SELECT 1; END;"
            ))
            .expect("replace one actual trigger with an inert body");
        assert!(
            matches!(
                store.validate_integrity(),
                Err(BrokerJournalError::SchemaDefinitionMismatch)
            ),
            "replacement trigger accepted: {name}"
        );
    }
}

#[test]
fn schema_rejection_precedes_writer_pragmas_and_preserves_actual_database() {
    let original = crate::journal::schema::SCHEMA_SQL;
    let cases = [
        original.replace("CHECK (peer_pid > 0)", "CHECK (peer_pid >= 0)"),
        format!(
            "{original}\nDROP TRIGGER operations_no_delete;
             CREATE TRIGGER operations_no_delete BEFORE DELETE ON operations
             BEGIN SELECT 1; END;"
        ),
        format!(
            "{original}\nDROP TRIGGER operations_no_delete;
             CREATE TRIGGER operations_no_delete BEFORE DELETE ON capability_nonces
             BEGIN SELECT RAISE(ABORT, 'operation records are append-only'); END;"
        ),
        format!(
            "{original}\nDROP TRIGGER operations_no_delete;
             CREATE TRIGGER operations_no_delete BEFORE DELETE ON operations
             BEGIN SELECT 1 /* {} */; END;",
            "x".repeat(65_537)
        ),
    ];
    for altered in cases {
        assert_ne!(original, altered);
        let fixture = TempJournal::new();
        let connection = rusqlite::Connection::open(&fixture.path).expect("actual SQLite file");
        connection
            .execute_batch(&altered)
            .expect("actual altered schema");
        // A source with no WAL/SHM makes entry into the writer path observable.
        // The normal initializer uses WAL; the read-only rejection comes first.
        connection
            .execute_batch("PRAGMA journal_mode = DELETE;")
            .expect("settle source without sidecars");
        drop(connection);
        fs::set_permissions(&fixture.path, fs::Permissions::from_mode(0o600))
            .expect("private source");
        let before = fs::read(&fixture.path).expect("source bytes before refusal");
        assert!(matches!(
            BrokerJournalStoreV1::open(
                &fixture.path,
                BrokerJournalPolicyV1::strict(fixture.owner_uid)
            ),
            Err(BrokerJournalError::SchemaDefinitionMismatch)
        ));
        assert_eq!(
            fs::read(&fixture.path).expect("source after refusal"),
            before
        );
        for suffix in ["-wal", "-shm", "-journal", INITIALIZATION_MARKER_SUFFIX] {
            assert!(
                !sidecar_path(&fixture.path, suffix).exists(),
                "created {suffix}"
            );
        }
    }
}

#[test]
fn sqlite_prefix_lookalike_does_not_hide_foreign_objects() {
    let fixture = TempJournal::new();
    let store = fixture.open();
    let connection = rusqlite::Connection::open(&fixture.path).expect("actual second connection");
    connection
        .execute_batch("CREATE TABLE sqliteXforeign(value TEXT) STRICT;")
        .expect("SQLite permits a name without its reserved underscore prefix");
    assert!(matches!(
        store.validate_integrity(),
        Err(BrokerJournalError::SchemaObjectMismatch { .. })
    ));
}

#[test]
fn unchanged_compiled_schema_and_durable_history_still_reopen() {
    let fixture = TempJournal::new();
    let mut store = fixture.open();
    store
        .reserve_operation(
            &admitted("exact-schema-operation", "exact-schema-nonce", '5'),
            12_000,
            FaultInjectionPointV1::None,
        )
        .expect("real reservation");
    store
        .append_transition(
            "exact-schema-operation",
            OperationState::Reserved,
            OperationState::RequestBound,
            12_001,
            None,
            None,
            FaultInjectionPointV1::None,
        )
        .expect("append actual transition");
    drop(store);
    let reopened = fixture.open();
    let journal = reopened
        .load_journal("exact-schema-operation")
        .expect("real history");
    assert_eq!(journal.current_state, OperationState::RequestBound);
    assert_eq!(journal.transitions.len(), 1);
    reopened
        .validate_integrity()
        .expect("exact schema and history");
}

#[test]
fn interrupted_initialization_refuses_prefix_lookalike_without_stamping_source() {
    let fixture = TempJournal::new();
    let connection = rusqlite::Connection::open(&fixture.path).expect("actual foreign file");
    connection
        .execute_batch(
            "CREATE TABLE sqliteXforeign(value TEXT) STRICT;
                        INSERT INTO sqliteXforeign VALUES ('preserved');",
        )
        .expect("foreign schema with lookalike prefix");
    drop(connection);
    fs::set_permissions(&fixture.path, fs::Permissions::from_mode(0o600)).expect("private source");
    let marker = sidecar_path(&fixture.path, INITIALIZATION_MARKER_SUFFIX);
    fs::write(&marker, INITIALIZATION_MARKER_BYTES).expect("actual interrupted marker");
    fs::set_permissions(&marker, fs::Permissions::from_mode(0o600)).expect("private marker");
    let before = fs::read(&fixture.path).expect("source before refusal");
    assert!(matches!(
        BrokerJournalStoreV1::open(
            &fixture.path,
            BrokerJournalPolicyV1::strict(fixture.owner_uid)
        ),
        Err(BrokerJournalError::InitializationCandidateForeignSchema)
    ));
    assert_eq!(
        fs::read(&fixture.path).expect("source after refusal"),
        before
    );
    assert_eq!(
        fs::read(&marker).expect("marker preserved"),
        INITIALIZATION_MARKER_BYTES
    );
    for suffix in ["-wal", "-shm", "-journal"] {
        assert!(
            !sidecar_path(&fixture.path, suffix).exists(),
            "created {suffix}"
        );
    }
}

#[test]
fn foreign_metadata_view_is_rejected_before_any_metadata_query() {
    let fixture = TempJournal::new();
    drop(fixture.open());
    let connection = rusqlite::Connection::open(&fixture.path).expect("actual source");
    connection
        .execute_batch(
            "DROP TABLE broker_metadata;
                        CREATE VIEW broker_metadata AS
                        SELECT key, value FROM deliberately_absent_metadata_source;
                        PRAGMA journal_mode = DELETE;",
        )
        .expect("replace metadata with a view that cannot be queried");
    drop(connection);
    let before = fs::read(&fixture.path).expect("source before refusal");
    // Schema identity must win before SELECT against this foreign view can run.
    assert!(matches!(
        BrokerJournalStoreV1::open(
            &fixture.path,
            BrokerJournalPolicyV1::strict(fixture.owner_uid)
        ),
        Err(BrokerJournalError::SchemaObjectMismatch { .. })
    ));
    assert_eq!(
        fs::read(&fixture.path).expect("source after refusal"),
        before
    );
    for suffix in ["-wal", "-shm", "-journal", INITIALIZATION_MARKER_SUFFIX] {
        assert!(
            !sidecar_path(&fixture.path, suffix).exists(),
            "created {suffix}"
        );
    }
}
