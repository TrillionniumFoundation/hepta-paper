use hepta_paper_service::sqlite_mutation_plan::*;
use rusqlite::{Connection, types::Value as SqlValue};
use serde_json::{Value, json};
use std::{path::Path, process::Command, sync::OnceLock};

fn corpus() -> &'static Value {
    static CORPUS: OnceLock<Value> = OnceLock::new();
    CORPUS.get_or_init(|| {
        let script = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../rust/oracle/sqlite-mutation-plan-v1.mjs");
        let output = Command::new("node").arg(script).output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        serde_json::from_slice(&output.stdout).unwrap()
    })
}
fn captured<T: serde::Serialize>(value: Result<T>) -> Value {
    match value {
        Ok(value) => json!({"ok":value}),
        Err(error) => json!({"error":error.to_string()}),
    }
}
#[test]
fn fixed_statement_plans_hashes_and_rejections_match_node() {
    for case in corpus()["plans"].as_array().unwrap() {
        let actual = captured(externally_fenced_sqlite_writer_plan_hash_v1(
            "writer:resident-instance",
            std::slice::from_ref(&case["value"]),
        ));
        assert_eq!(actual, case["result"], "{}", case["name"]);
    }
    let case = &corpus()["registry"];
    let registry = validate_sqlite_mutation_plans_v1(&case["manifest"], &case["mapping"]).unwrap();
    assert_eq!(registry.manifest_hash(), case["result"]["manifestHash"]);
    let id = "resident-instance.commit.v1";
    assert_eq!(
        registry.get(id).unwrap().projection(),
        case["result"]["byOperationId"][id]
    );
}
#[test]
fn real_database_surface_checks_match_node() {
    let plan = validate_sqlite_mutation_operation_v1(&corpus()["plans"][0]["value"]).unwrap();
    for case in corpus()["surfaces"].as_array().unwrap() {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch(case["sql"].as_str().unwrap()).unwrap();
        assert_eq!(
            captured(assert_sqlite_mutation_database_surface_v1(&db, &plan).map(|()| true)),
            case["result"],
            "{}",
            case["name"]
        );
    }
}
#[test]
fn actual_session_restricted_statements_and_cleanup_match_node() {
    let plan = validate_sqlite_mutation_operation_v1(&corpus()["plans"][0]["value"]).unwrap();
    for case in corpus()["transactionCases"].as_array().unwrap() {
        let mut db = Connection::open_in_memory().unwrap();
        db.execute_batch(case["sql"].as_str().unwrap()).unwrap();
        db.execute_batch("BEGIN IMMEDIATE").unwrap();
        let result: Result<(Value, Vec<u8>)> =
            with_restricted_sqlite_mutation_v1(&mut db, &plan, |surface| {
                let mut values = Vec::new();
                for invocation in case["invocations"].as_array().unwrap() {
                    let id = invocation[1].as_str().unwrap();
                    let params = invocation[2]
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|v| match v {
                            Value::String(s) => SqlValue::Text(s.clone()),
                            Value::Number(n) => SqlValue::Integer(n.as_i64().unwrap()),
                            Value::Null => SqlValue::Null,
                            _ => panic!("unsupported fixture"),
                        })
                        .collect::<Vec<_>>();
                    values.push(match invocation[0].as_str().unwrap() {
                        "get" => surface.get(id, &params)?,
                        "all" => surface.all(id, &params)?,
                        "run" => surface.run(id, &params)?,
                        _ => panic!("fixture mode"),
                    });
                }
                Ok(Value::Array(values))
            });
        let mut actual = captured(result.map(|(value, _)| value));
        if let Some(message) = actual["error"]
            .as_str()
            .and_then(|s| s.strip_prefix("externally_fenced_sqlite_mutation_sqlite_error:"))
        {
            actual = json!({"error":message});
        }
        assert_eq!(actual, case["result"], "{}", case["name"]);
        let cleanup: i64 = db
            .query_row(
                "SELECT count(*) FROM sqlite_temp_schema WHERE type='trigger'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(json!(cleanup), case["cleanup"]);
        db.execute_batch("ROLLBACK").unwrap();
        assert_eq!(
            db.query_row("SELECT value FROM planned_rows WHERE id=1", [], |r| r
                .get::<_, String>(0))
                .unwrap(),
            "before"
        );
    }
}

fn update_plan(sql: &str) -> ValidatedMutationPlanV1 {
    validate_sqlite_mutation_operation_v1(&json!({"version":1,"operationId":"review-operation","statements":[{"statementId":"write-row","mode":"run","sql":sql}]})).unwrap()
}

fn guard_count(db: &Connection) -> i64 {
    db.query_row(
        "SELECT count(*) FROM sqlite_temp_schema WHERE type='trigger'",
        [],
        |r| r.get(0),
    )
    .unwrap()
}

#[test]
fn session_blind_null_primary_keys_and_case_alias_side_effects_are_rejected() {
    let plan = update_plan("UPDATE planned_rows SET value=? WHERE id=?");
    for (sql, error) in [
        (
            "CREATE TABLE planned_rows(id,value)",
            "explicit_primary_key_required",
        ),
        (
            "CREATE TABLE planned_rows(id TEXT PRIMARY KEY,value); INSERT INTO planned_rows VALUES(NULL,'before')",
            "null_primary_key_forbidden",
        ),
        (
            "CREATE TABLE planned_rows(id INTEGER PRIMARY KEY,value); CREATE TRIGGER alias_effect AFTER UPDATE ON planned_rows BEGIN UPDATE PLANNED_ROWS SET value='hidden' WHERE id=new.id; END",
            "business_trigger_forbidden",
        ),
        (
            "CREATE TABLE planned_rows(id INTEGER PRIMARY KEY,value); CREATE TABLE child(id INTEGER PRIMARY KEY,parent INTEGER REFERENCES PLANNED_ROWS(id) ON UPDATE CASCADE)",
            "foreign_key_forbidden",
        ),
    ] {
        let mut db = Connection::open_in_memory().unwrap();
        db.execute_batch(sql).unwrap();
        db.execute_batch("BEGIN IMMEDIATE").unwrap();
        let mut invoked = false;
        let result: Result<((), Vec<u8>)> =
            with_restricted_sqlite_mutation_v1(&mut db, &plan, |_| {
                invoked = true;
                Ok(())
            });
        assert!(result.unwrap_err().to_string().contains(error), "{sql}");
        assert!(!invoked, "surface must be checked before callback");
        assert_eq!(guard_count(&db), 0);
        db.execute_batch("ROLLBACK").unwrap();
    }
    // SQLite allows a table named sqliteX. SQL LIKE 'sqlite_%' incorrectly
    // excluded it from guards because '_' is a wildcard, hiding no-PK effects.
    let mut db = Connection::open_in_memory().unwrap();
    db.execute_batch("CREATE TABLE planned_rows(id INTEGER PRIMARY KEY,value); INSERT INTO planned_rows VALUES(1,'before'); CREATE TABLE sqliteX(value); CREATE TRIGGER side_effect AFTER UPDATE ON planned_rows BEGIN INSERT INTO sqliteX VALUES(new.value); END; BEGIN IMMEDIATE").unwrap();
    let result: Result<(Value, Vec<u8>)> =
        with_restricted_sqlite_mutation_v1(&mut db, &plan, |s| {
            s.run(
                "write-row",
                &[SqlValue::Text("bad".into()), SqlValue::Integer(1)],
            )
        });
    assert!(
        result
            .unwrap_err()
            .to_string()
            .contains("table_operation_forbidden")
    );
    assert_eq!(
        db.query_row("SELECT count(*) FROM sqliteX", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert_eq!(guard_count(&db), 0);
    db.execute_batch("ROLLBACK").unwrap();
}

#[test]
fn nullable_key_inserts_updates_returning_and_guard_cleanup_are_real() {
    for sql in [
        "INSERT INTO planned_rows VALUES(?,?)",
        "UPDATE planned_rows SET id=? WHERE value=?",
    ] {
        let mut db = Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE planned_rows(id TEXT PRIMARY KEY,value); INSERT INTO planned_rows VALUES('valid','before'); BEGIN IMMEDIATE").unwrap();
        let plan = update_plan(sql);
        let result: Result<(Value, Vec<u8>)> =
            with_restricted_sqlite_mutation_v1(&mut db, &plan, |s| {
                s.run(
                    "write-row",
                    &[SqlValue::Null, SqlValue::Text("before".into())],
                )
            });
        assert!(
            result
                .unwrap_err()
                .to_string()
                .contains("null_primary_key_forbidden")
        );
        assert_eq!(guard_count(&db), 0);
        db.execute_batch("ROLLBACK").unwrap();
    }
    let mut db = Connection::open_in_memory().unwrap();
    db.execute_batch("CREATE TABLE planned_rows(id INTEGER PRIMARY KEY,value); INSERT INTO planned_rows VALUES(1,'before'),(2,'before'); BEGIN IMMEDIATE").unwrap();
    let plan = update_plan("UPDATE planned_rows SET value=? RETURNING id");
    let result: Result<(Value, Vec<u8>)> =
        with_restricted_sqlite_mutation_v1(&mut db, &plan, |s| {
            s.run("write-row", &[SqlValue::Text("after".into())])
        });
    let (result, bytes) = result.unwrap();
    assert_eq!(result, json!({"changes":2,"lastInsertRowid":2}));
    assert_eq!(
        hepta_paper_service::sqlite_changeset::inspect_sqlite_changeset_effects_v1(&bytes)
            .unwrap()
            .len(),
        2
    );
    assert_eq!(guard_count(&db), 0);
    db.execute_batch("ROLLBACK").unwrap();

    db.execute_batch("BEGIN IMMEDIATE").unwrap();
    let result: Result<((), Vec<u8>)> = with_restricted_sqlite_mutation_v1(&mut db, &plan, |s| {
        s.run("write-row", &[SqlValue::Text("after".into())])?;
        Err(SqliteMutationPlanError("callback_failure".into()))
    });
    assert_eq!(result.unwrap_err().to_string(), "callback_failure");
    assert_eq!(guard_count(&db), 0);
    db.execute_batch("ROLLBACK").unwrap();
    db.execute_batch("BEGIN IMMEDIATE").unwrap();
    let unwind = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _: Result<((), Vec<u8>)> =
            with_restricted_sqlite_mutation_v1(&mut db, &plan, |_| panic!("test cancellation"));
    }));
    assert!(unwind.is_err());
    assert_eq!(guard_count(&db), 0);
    db.execute_batch("ROLLBACK").unwrap();
    assert_eq!(
        db.query_row(
            "SELECT count(*) FROM planned_rows WHERE value='before'",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        2
    );
}

#[test]
fn raw_legacy_id_hashing_does_not_grant_string_alias_execution_or_system_writes() {
    let mut input = corpus()["plans"][0]["value"].clone();
    input["statements"][0]["statementId"] = json!(12);
    let plan = validate_sqlite_mutation_operation_v1(&input).unwrap();
    assert_eq!(plan.projection()["statements"][0]["statementId"], 12);
    let mut db = Connection::open_in_memory().unwrap();
    db.execute_batch("CREATE TABLE planned_rows(id INTEGER PRIMARY KEY,value); BEGIN IMMEDIATE")
        .unwrap();
    let result: Result<(Value, Vec<u8>)> =
        with_restricted_sqlite_mutation_v1(&mut db, &plan, |s| s.all("12", &[]));
    assert_eq!(
        result.unwrap_err().to_string(),
        "externally_fenced_sqlite_mutation_statement_not_authorized"
    );
    assert_eq!(guard_count(&db), 0);
    db.execute_batch("ROLLBACK").unwrap();
    input["statements"][2]["sql"] =
        "UPDATE AUTONOMOUS_RESEARCH_ONLINE_MUTATION_AUTHORITY_MARKER SET reservation_id=?".into();
    assert!(validate_sqlite_mutation_operation_v1(&input).is_err());
    let mut registry = corpus()["registry"]["mapping"].clone();
    registry["resident-instance.commit.v1"]["operationId"] = 12.into();
    assert_eq!(
        validate_sqlite_mutation_plans_v1(&corpus()["registry"]["manifest"], &registry)
            .unwrap_err()
            .to_string(),
        "externally_fenced_sqlite_mutation_operation_plan_identity_mismatch"
    );
}
