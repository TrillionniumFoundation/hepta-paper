use super::*;
fn pending_database() -> Connection {
    let db = Connection::open_in_memory().unwrap();
    db.execute_batch("CREATE TABLE autonomous_research_online_mutation_authority_marker(reservation_id TEXT PRIMARY KEY,database_sequence INTEGER,reserve_request_json TEXT,reservation_receipt_json TEXT,committed_at TEXT);CREATE TABLE autonomous_research_online_mutation_finalization_receipt(reservation_id TEXT PRIMARY KEY);").unwrap();
    db
}
#[test]
fn pending_non_json_text_obeys_real_cell_limit_without_normalizing_bad_utf8() {
    for bad_utf8 in [false, true] {
        let mut db = pending_database();
        db.execute_batch(if bad_utf8 {"INSERT INTO autonomous_research_online_mutation_authority_marker VALUES('reservation:one',1,'{}','{}',CAST(X'FF' AS TEXT));"}else{"INSERT INTO autonomous_research_online_mutation_authority_marker VALUES('reservation:one',1,'{}','{}',CAST(zeroblob(33554433) AS TEXT));"}).unwrap();
        let before = db.total_changes();
        let transaction = db.transaction().unwrap();
        let failure = pending_markers_bounded(&transaction, "pending_limit").unwrap_err();
        assert_eq!(
            failure.code,
            if bad_utf8 {
                "externally_fenced_sqlite_mutation_storage_utf8_invalid"
            } else {
                "pending_limit"
            }
        );
        transaction.rollback().unwrap();
        assert!(db.is_autocommit());
        assert_eq!(db.total_changes(), before);
    }
}
#[test]
fn aggregate_budget_counts_non_json_text_across_columns_and_rows() {
    let db = Connection::open_in_memory().unwrap();
    db.execute_batch("CREATE TABLE observations(a TEXT,b TEXT);INSERT INTO observations VALUES('abc','def'),('ghi','jkl');").unwrap();
    let limits = RowLimits {
        rows: 2,
        cell_bytes: 3,
        total_bytes: 12,
    };
    assert_eq!(
        rows_bounded(&db, "SELECT * FROM observations", &[], limits, "budget")
            .unwrap()
            .len(),
        2
    );
    assert_eq!(
        rows_bounded(
            &db,
            "SELECT * FROM observations",
            &[],
            RowLimits {
                total_bytes: 11,
                ..limits
            },
            "budget"
        )
        .unwrap_err()
        .code,
        "budget"
    );
    assert_eq!(
        rows_bounded(
            &db,
            "SELECT * FROM observations",
            &[],
            RowLimits { rows: 1, ..limits },
            "budget"
        )
        .unwrap_err()
        .code,
        "budget"
    );
    assert_eq!(
        rows_bounded(
            &db,
            "SELECT * FROM observations",
            &[],
            RowLimits {
                cell_bytes: 2,
                ..limits
            },
            "budget"
        )
        .unwrap_err()
        .code,
        "budget"
    );
    assert_eq!(
        rows(&db, "SELECT '雪🙂' AS valid", &[]).unwrap(),
        vec![json!({"valid":"雪🙂"})]
    );
    assert_eq!(
        rows(&db, "SELECT CAST(X'EDA080' AS TEXT) AS invalid", &[])
            .unwrap_err()
            .code,
        "externally_fenced_sqlite_mutation_storage_utf8_invalid"
    );
}
#[test]
fn metadata_is_bounded_before_claim_validation_and_pending_requires_snapshot() {
    let db = pending_database();
    assert_eq!(
        pending_markers_bounded(&db, "budget").unwrap_err().code,
        "externally_fenced_sqlite_mutation_pending_snapshot_required"
    );
    db.execute_batch("CREATE TABLE autonomous_research_online_mutation_authority_metadata(singleton INTEGER PRIMARY KEY,database_instance_id TEXT);INSERT INTO autonomous_research_online_mutation_authority_metadata VALUES(1,CAST(zeroblob(4097) AS TEXT));").unwrap();
    assert_eq!(
        metadata(&db).unwrap_err().code,
        "externally_fenced_sqlite_mutation_metadata_resource_limit"
    );
}
#[test]
fn selected_schema_columns_are_bounded_before_cloning_names() {
    let db = Connection::open_in_memory().unwrap();
    let sql = format!("SELECT 1 AS '{}'", "x".repeat(513));
    assert_eq!(
        rows(&db, &sql, &[]).unwrap_err().code,
        "externally_fenced_sqlite_mutation_storage_resource_limit"
    );
    let sql = format!(
        "SELECT {}",
        (0..257)
            .map(|n| format!("{n} AS c{n}"))
            .collect::<Vec<_>>()
            .join(",")
    );
    assert_eq!(
        rows(&db, &sql, &[]).unwrap_err().code,
        "externally_fenced_sqlite_mutation_storage_resource_limit"
    );
}
