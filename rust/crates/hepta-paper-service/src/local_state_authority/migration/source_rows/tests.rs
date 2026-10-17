use super::*;

fn database() -> Connection {
    let db = Connection::open_in_memory().unwrap();
    db.execute_batch(include_str!("../source_schema.sql"))
        .unwrap();
    db.execute_batch("BEGIN IMMEDIATE").unwrap();
    db
}
fn insert_mutation(db: &Connection, id: &str, sequence: i64, raw: &str) {
    db.execute("INSERT INTO authority_mutation(mutation_attempt_id,reservation_id,status,global_sequence,database_instance_id,reserve_request_json,reservation_receipt_json) VALUES(?1,?1,'reserved',?2,'instance',?3,'{}')", rusqlite::params![id, sequence, raw]).unwrap();
}
#[test]
fn raw_text_and_rowid_change_logical_digest_without_ending_transaction() {
    let db = database();
    insert_mutation(&db, "one", 1, "{\"a\":1}");
    let first = read_source_rows(&db).unwrap();
    assert_eq!(first.mutations()[0][6], "{\"a\":1}");
    let changes = db.total_changes();
    assert_eq!(
        first.logical_hash(),
        read_source_rows(&db).unwrap().logical_hash()
    );
    assert_eq!(db.total_changes(), changes);
    db.execute(
        "UPDATE authority_mutation SET reserve_request_json=' {\"a\":1} '",
        [],
    )
    .unwrap();
    let spaced = read_source_rows(&db).unwrap();
    assert_ne!(first.logical_hash(), spaced.logical_hash());
    db.execute("UPDATE authority_mutation SET rowid=9", [])
        .unwrap();
    let moved = read_source_rows(&db).unwrap();
    assert_ne!(spaced.logical_hash(), moved.logical_hash());
    assert_eq!(moved.mutations()[0][0], 9);
    assert_eq!(
        db.transaction_state(Some("main")).unwrap(),
        TransactionState::Write
    );
    db.execute_batch("ROLLBACK").unwrap();
    assert!(read_source_rows(&db).is_err());
}
#[test]
fn oversized_or_invalid_utf8_sql_text_is_rejected_before_owned_copy() {
    let db = database();
    insert_mutation(&db, "one", 1, "{}");
    db.execute(
        "UPDATE authority_mutation SET reserve_request_json=CAST(x'80' AS TEXT)",
        [],
    )
    .unwrap();
    assert_eq!(
        read_source_rows(&db).err().unwrap().code,
        "local_authority_history_sql_text_invalid"
    );
    db.execute(
        "UPDATE authority_mutation SET reserve_request_json=?1",
        [" ".repeat(MAX_CELL + 1)],
    )
    .unwrap();
    assert_eq!(
        read_source_rows(&db).err().unwrap().code,
        "local_authority_history_byte_limit_exceeded"
    );
}
#[test]
fn row_limits_reject_truncation_and_preserve_the_held_snapshot() {
    let db = database();
    db.execute_batch("WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<10001) INSERT INTO authority_mutation(mutation_attempt_id,reservation_id,status,global_sequence,database_instance_id,reserve_request_json,reservation_receipt_json) SELECT 'attempt:'||x,'reservation:'||x,'reserved',x,'instance','{}','{}' FROM n").unwrap();
    let changes = db.total_changes();
    assert_eq!(
        read_source_rows(&db).err().unwrap().code,
        "local_authority_history_row_limit_exceeded"
    );
    assert_eq!(db.total_changes(), changes);
    assert_eq!(
        db.transaction_state(Some("main")).unwrap(),
        TransactionState::Write
    );
    assert_eq!(
        db.query_row("SELECT count(*) FROM authority_mutation", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        10001
    );
}
