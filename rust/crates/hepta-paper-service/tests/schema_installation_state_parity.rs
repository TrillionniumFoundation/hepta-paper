use hepta_paper_service::sqlite_mutation_coordinator;
#[path = "../src/online_schema_execution/maintenance/normalization/installation/state.rs"]
mod state_comparison;
use rusqlite::Connection;
use state_comparison::compare_installation_state_v1;
fn compare(
    expected: &mut Connection,
    actual: &mut Connection,
) -> sqlite_mutation_coordinator::Result<()> {
    for db in [&*expected, &*actual] {
        db.busy_timeout(std::time::Duration::ZERO).unwrap();
        db.pragma_update(None, "trusted_schema", false).unwrap();
    }
    let left = expected.transaction().unwrap();
    let right = actual.transaction().unwrap();
    let result = compare_installation_state_v1(&left, &right);
    assert!(!left.is_autocommit() && !right.is_autocommit());
    left.rollback().unwrap();
    right.rollback().unwrap();
    result
}

#[test]
fn exact_installation_state_includes_all_values_and_system_bookkeeping() {
    let schema = "CREATE TABLE business (id TEXT PRIMARY KEY,value); CREATE TABLE autonomous_research_online_mutation_finalization_receipt(id INTEGER PRIMARY KEY, finalization_receipt_json TEXT, recorded_at TEXT); CREATE TABLE generated(value, v TEXT GENERATED ALWAYS AS(typeof(value)||hex(value)) VIRTUAL,s TEXT GENERATED ALWAYS AS(hex(value)) STORED);";
    let mut expected = Connection::open_in_memory().unwrap();
    let mut actual = Connection::open_in_memory().unwrap();
    for db in [&expected, &actual] {
        db.execute_batch(schema).unwrap();
        db.execute_batch("INSERT INTO business VALUES('a',9223372036854775807),(NULL,X'6162');INSERT INTO autonomous_research_online_mutation_finalization_receipt VALUES(1,'{\"a\":1,\"b\":2}','2026-09-17T00:00:00Z');INSERT INTO generated(value)VALUES('ab');").unwrap();
    }
    compare(&mut expected, &mut actual).unwrap();
    actual.execute("UPDATE autonomous_research_online_mutation_finalization_receipt SET recorded_at='2026-09-17T00:00:01Z'",[]).unwrap();
    assert!(compare(&mut expected, &mut actual).is_err());
    actual.execute("UPDATE autonomous_research_online_mutation_finalization_receipt SET recorded_at='2026-09-17T00:00:00Z',finalization_receipt_json='{\"b\":2,\"a\":1}'",[]).unwrap();
    assert!(compare(&mut expected, &mut actual).is_err());
    assert!(expected.is_autocommit() && actual.is_autocommit());
}

fn pair(schema: &str, rows: &str) -> (Connection, Connection) {
    let left = Connection::open_in_memory().unwrap();
    let right = Connection::open_in_memory().unwrap();
    for db in [&left, &right] {
        db.execute_batch(schema).unwrap();
        db.execute_batch(rows).unwrap();
    }
    (left, right)
}
#[test]
fn comparison_preserves_integer_types_blobs_duplicates_null_keys_rowids_and_generated_values() {
    let (mut left, mut right) = pair(
        "CREATE TABLE loose(value); CREATE TABLE nullable(id TEXT PRIMARY KEY,value); CREATE TABLE computed(value,stored TEXT GENERATED ALWAYS AS(typeof(value)||hex(value)) STORED, virtual TEXT GENERATED ALWAYS AS(typeof(value)||hex(value)) VIRTUAL);CREATE TABLE wr(k TEXT PRIMARY KEY,v) WITHOUT ROWID;",
        "INSERT INTO loose(rowid,value)VALUES(7,NULL),(11,NULL),(15,9223372036854775807),(16,-9223372036854775808),(17,CAST(X'ff' AS TEXT));INSERT INTO nullable VALUES(NULL,'ab');INSERT INTO computed(value)VALUES('ab');INSERT INTO wr VALUES('b',2),('a',1);",
    );
    compare(&mut left, &mut right).unwrap();
    for (mutate, undo) in [
        (
            "INSERT INTO loose(rowid,value)VALUES(12,NULL)",
            "DELETE FROM loose WHERE rowid=12",
        ),
        (
            "UPDATE loose SET rowid=8 WHERE rowid=7",
            "UPDATE loose SET rowid=7 WHERE rowid=8",
        ),
        (
            "UPDATE loose SET value=9223372036854775806 WHERE rowid=15",
            "UPDATE loose SET value=9223372036854775807 WHERE rowid=15",
        ),
        (
            "UPDATE loose SET value=CAST(X'fe' AS TEXT) WHERE rowid=17",
            "UPDATE loose SET value=CAST(X'ff' AS TEXT) WHERE rowid=17",
        ),
        (
            "UPDATE nullable SET value=X'6162'",
            "UPDATE nullable SET value='ab'",
        ),
        (
            "INSERT INTO nullable VALUES(NULL,'extra')",
            "DELETE FROM nullable WHERE value='extra'",
        ),
        (
            "UPDATE computed SET value=X'6162'",
            "UPDATE computed SET value='ab'",
        ),
        (
            "UPDATE wr SET v=1.0 WHERE k='a'",
            "UPDATE wr SET v=1 WHERE k='a'",
        ),
    ] {
        right.execute_batch(mutate).unwrap();
        let error = compare(&mut left, &mut right).unwrap_err();
        assert_eq!(
            error.code, "schema_transition_installation_state_mismatch",
            "{mutate}"
        );
        right.execute_batch(undo).unwrap();
        compare(&mut left, &mut right).unwrap();
    }
}
#[test]
fn complete_schema_controls_and_autoincrement_history_are_not_ignored() {
    let (mut left, mut right) = pair(
        "CREATE TABLE business(id INTEGER PRIMARY KEY AUTOINCREMENT,value TEXT); CREATE VIEW projection AS SELECT value FROM business; CREATE INDEX ix ON business(value); CREATE TRIGGER kept AFTER UPDATE ON business BEGIN SELECT 1; END;",
        "INSERT INTO business(value)VALUES('a');INSERT INTO business(value)VALUES('deleted');DELETE FROM business WHERE id=2;",
    );
    compare(&mut left, &mut right).unwrap();
    for (mutate, undo) in [
        (
            "UPDATE sqlite_sequence SET seq=99",
            "UPDATE sqlite_sequence SET seq=2",
        ),
        ("PRAGMA user_version=1", "PRAGMA user_version=0"),
        ("PRAGMA application_id=4", "PRAGMA application_id=0"),
        (
            "DROP VIEW projection;CREATE VIEW projection AS SELECT value || '' FROM business;",
            "DROP VIEW projection;CREATE VIEW projection AS SELECT value FROM business;",
        ),
        (
            "DROP INDEX ix;CREATE INDEX ix ON business(value DESC);",
            "DROP INDEX ix;CREATE INDEX ix ON business(value);",
        ),
        (
            "DROP TRIGGER kept;CREATE TRIGGER kept AFTER UPDATE ON business BEGIN SELECT 2; END;",
            "DROP TRIGGER kept;CREATE TRIGGER kept AFTER UPDATE ON business BEGIN SELECT 1; END;",
        ),
    ] {
        right.execute_batch(mutate).unwrap();
        assert!(compare(&mut left, &mut right).is_err(), "{mutate}");
        right.execute_batch(undo).unwrap();
        compare(&mut left, &mut right).unwrap();
    }
}
#[test]
fn actual_fixed_installation_ddl_preserves_business_rows_in_comparison() {
    use hepta_paper_service::online_schema_transition::target_schema::{
        SchemaTransitionTargetV1, apply_schema_transition_statements_v1,
    };
    let (mut left, mut right) = pair(
        "CREATE TABLE original_business(id TEXT PRIMARY KEY,payload BLOB);",
        "INSERT INTO original_business VALUES(NULL,X'0001ff'),('item',X'abcdefff');",
    );
    let target = SchemaTransitionTargetV1::for_role("native-store", None).unwrap();
    for db in [&mut left, &mut right] {
        db.busy_timeout(std::time::Duration::ZERO).unwrap();
        db.pragma_update(None, "trusted_schema", false).unwrap();
        db.execute_batch("BEGIN EXCLUSIVE").unwrap();
        apply_schema_transition_statements_v1(db, &target).unwrap();
        let schema = sqlite_mutation_coordinator::storage::exact_schema_hash_v1(db).unwrap();
        let bound = format!("sha256:{}", "a".repeat(64));
        // Actual fixed metadata table/constraints, identical genesis data on
        // both sides. The enclosing installation suite verifies its signature;
        // this observation helper must still catch unrelated business changes.
        db.execute("INSERT INTO autonomous_research_online_mutation_authority_metadata(singleton,schema_version,protocol,database_role,database_instance_id,schema_contract_id,schema_hash,database_scope_hash,writer_manifest_hash,genesis_global_sequence,genesis_global_hash,genesis_database_sequence,genesis_database_hash,genesis_state_hash,provisioned_at) VALUES(1,1,?1,'native-store','native-store','native-store-schema-v1',?2,?3,?3,0,?3,0,?3,?3,'2026-09-17T00:00:00.000Z')",rusqlite::params![sqlite_mutation_coordinator::ONLINE_MUTATION_PROTOCOL,schema,bound]).unwrap();
    }
    compare_installation_state_v1(&left, &right).unwrap();
    right
        .execute(
            "UPDATE original_business SET payload=X'00' WHERE id='item'",
            [],
        )
        .unwrap();
    assert_eq!(
        compare_installation_state_v1(&left, &right)
            .unwrap_err()
            .code,
        "schema_transition_installation_state_mismatch"
    );
    assert!(!left.is_autocommit() && !right.is_autocommit());
    left.execute_batch("ROLLBACK").unwrap();
    right.execute_batch("ROLLBACK").unwrap();
}
#[test]
fn oversized_generated_value_is_refused_inside_sqlite_and_outer_transactions_survive() {
    let (mut left, mut right) = pair(
        "CREATE TABLE generated(size INTEGER,bytes BLOB GENERATED ALWAYS AS(zeroblob(size)) VIRTUAL);",
        "INSERT INTO generated(size)VALUES(16777217);",
    );
    for db in [&left, &right] {
        db.busy_timeout(std::time::Duration::ZERO).unwrap();
        db.pragma_update(None, "trusted_schema", false).unwrap();
        db.execute_batch("BEGIN").unwrap();
    }
    let error = compare_installation_state_v1(&left, &right).unwrap_err();
    assert_eq!(
        error.code,
        "schema_transition_installation_state_unsupported"
    );
    let sqlite = left
        .query_row::<Vec<u8>, _, _>("SELECT bytes FROM generated", [], |r| r.get(0))
        .unwrap_err();
    assert_eq!(
        sqlite.sqlite_error_code(),
        Some(rusqlite::ErrorCode::TooBig)
    );
    assert!(!left.is_autocommit() && !right.is_autocommit());
    left.execute_batch("ROLLBACK").unwrap();
    right.execute_batch("ROLLBACK").unwrap();
    right
        .set_limit(rusqlite::limits::Limit::SQLITE_LIMIT_LENGTH, 1024)
        .unwrap();
    assert!(compare(&mut left, &mut right).is_err());
    assert_eq!(
        right
            .limit(rusqlite::limits::Limit::SQLITE_LIMIT_LENGTH)
            .unwrap(),
        1024
    );
}
#[test]
fn transaction_and_connection_policy_are_explicit_and_unsupported_state_fails_closed() {
    let (left, right) = pair("CREATE TABLE safe(value)", "");
    assert_eq!(
        compare_installation_state_v1(&left, &right)
            .unwrap_err()
            .code,
        "schema_transition_installation_state_invalid"
    );
    assert!(left.is_autocommit() && right.is_autocommit());
    for db in [&left, &right] {
        db.execute_batch("BEGIN").unwrap();
    }
    assert_eq!(
        compare_installation_state_v1(&left, &right)
            .unwrap_err()
            .code,
        "schema_transition_installation_state_unsupported"
    );
    assert!(!left.is_autocommit() && !right.is_autocommit());
    for db in [&left, &right] {
        db.execute_batch("ROLLBACK").unwrap();
    }
    for schema in [
        "CREATE TABLE hidden(rowid TEXT,_rowid_ TEXT,oid TEXT)",
        "CREATE VIRTUAL TABLE virtual USING fts5(value)",
        "CREATE TEMP TABLE temporary(value)",
        "ATTACH ':memory:' AS extra",
    ] {
        let (mut left, mut right) = pair("CREATE TABLE safe(value)", "");
        left.execute_batch(schema).unwrap();
        right.execute_batch(schema).unwrap();
        assert_eq!(
            compare(&mut left, &mut right).unwrap_err().code,
            "schema_transition_installation_state_unsupported",
            "{schema}"
        );
        assert!(left.is_autocommit() && right.is_autocommit());
    }
}

#[test]
fn comparison_never_releases_callers_exclusive_locks_or_writes_database_bytes() {
    use std::{
        fs,
        path::PathBuf,
        sync::atomic::{AtomicU64, Ordering},
    };
    static NEXT: AtomicU64 = AtomicU64::new(0);
    struct Cleanup(PathBuf);
    impl Drop for Cleanup {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    let root = std::env::temp_dir().join(format!(
        "hepta-installation-state-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    fs::create_dir(&root).unwrap();
    let _cleanup = Cleanup(root.clone());
    let expected_file = root.join("expected.sqlite");
    let actual_file = root.join("actual.sqlite");
    for file in [&expected_file, &actual_file] {
        let db = Connection::open(file).unwrap();
        db.execute_batch("CREATE TABLE actual(id INTEGER PRIMARY KEY,value);INSERT INTO actual VALUES(1,'before');").unwrap();
    }
    let before = fs::read(&actual_file).unwrap();
    let expected = Connection::open(&expected_file).unwrap();
    let actual = Connection::open(&actual_file).unwrap();
    let contender = Connection::open(&actual_file).unwrap();
    contender.busy_timeout(std::time::Duration::ZERO).unwrap();
    for db in [&expected, &actual] {
        db.busy_timeout(std::time::Duration::ZERO).unwrap();
        db.pragma_update(None, "trusted_schema", false).unwrap();
        db.execute_batch("BEGIN EXCLUSIVE").unwrap();
    }
    compare_installation_state_v1(&expected, &actual).unwrap();
    assert_eq!(fs::read(&actual_file).unwrap(), before);
    let locked = contender.execute_batch("BEGIN IMMEDIATE").unwrap_err();
    assert_eq!(
        locked.sqlite_error_code(),
        Some(rusqlite::ErrorCode::DatabaseBusy)
    );
    expected
        .execute("UPDATE actual SET value='different'", [])
        .unwrap();
    assert!(compare_installation_state_v1(&expected, &actual).is_err());
    let locked = contender.execute_batch("BEGIN IMMEDIATE").unwrap_err();
    assert_eq!(
        locked.sqlite_error_code(),
        Some(rusqlite::ErrorCode::DatabaseBusy)
    );
    assert!(!expected.is_autocommit() && !actual.is_autocommit());
    assert_eq!(fs::read(&actual_file).unwrap(), before);
    expected.execute_batch("ROLLBACK").unwrap();
    actual.execute_batch("ROLLBACK").unwrap();
    contender.execute_batch("BEGIN IMMEDIATE;ROLLBACK").unwrap();
    assert_eq!(fs::read(&actual_file).unwrap(), before);
}

#[test]
fn secondary_index_corruption_cannot_pass_logically_equal_table_rows() {
    let (mut left, mut right) = pair(
        "CREATE TABLE a(id INTEGER PRIMARY KEY,value);CREATE INDEX a_index ON a(value);CREATE TABLE b(id INTEGER PRIMARY KEY,value);CREATE INDEX b_index ON b(value);",
        "INSERT INTO a VALUES(1,'a'),(2,'aa');INSERT INTO b VALUES(1,'b'),(2,'bb');",
    );
    compare(&mut left, &mut right).unwrap();
    // Isolated corruption: physical index root is rebound while all logical
    // schema SQL and all table rows remain unchanged. quick_check alone does
    // not establish that secondary indexes represent those rows.
    right.execute_batch("PRAGMA writable_schema=ON;UPDATE sqlite_schema SET rootpage=(SELECT rootpage FROM sqlite_schema WHERE name='b_index') WHERE name='a_index';PRAGMA writable_schema=OFF;PRAGMA schema_version=999;").unwrap();
    let error = compare(&mut left, &mut right).unwrap_err();
    assert_eq!(
        error.code,
        "schema_transition_installation_state_unsupported"
    );
    assert!(left.is_autocommit() && right.is_autocommit());
}
