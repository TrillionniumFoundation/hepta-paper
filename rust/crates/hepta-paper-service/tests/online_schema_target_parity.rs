use hepta_paper_service::{
    online_schema_transition::target_schema::*,
    sqlite_mutation_coordinator::{Result, storage::exact_schema_hash_v1},
};
use rusqlite::Connection;
use serde_json::{Value, json};
use std::{
    io::Write,
    path::Path,
    process::{Command, Stdio},
};
const NOW: &str = "2026-09-16T12:00:00.000Z";
fn oracle(values: &[Value]) -> Vec<Value> {
    let mut child = Command::new("node")
        .arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../oracle/online-schema-target-v1.mjs"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(json!(values).to_string().as_bytes())
        .unwrap();
    let out = child.wait_with_output().unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let result: Value = serde_json::from_slice(&out.stdout).unwrap();
    hepta_legacy_compatibility::qualify_production_node_profile_v1(&result["profile"]).unwrap();
    result["results"].as_array().unwrap().clone()
}
fn schema(database: &Connection) -> Value {
    let mut statement=database.prepare("SELECT type,name,tbl_name,coalesce(sql,'') AS sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name,tbl_name,sql;").unwrap();
    json!(statement.query_map([],|r|Ok(json!({"type":r.get::<_,String>(0)?,"name":r.get::<_,String>(1)?,"tbl_name":r.get::<_,String>(2)?,"sql":r.get::<_,String>(3)?}))).unwrap().collect::<rusqlite::Result<Vec<_>>>().unwrap())
}
fn setup(case: &Value) -> Connection {
    let database = Connection::open_in_memory().unwrap();
    for sql in case["setup"].as_array().unwrap() {
        database.execute_batch(sql.as_str().unwrap()).unwrap();
    }
    database
}
fn migration_rows(database: &Connection) -> Value {
    let mut statement=database.prepare("SELECT version,name,migration_sha256,applied_at FROM handoff_schema_migrations ORDER BY version;").unwrap();
    json!(statement.query_map([],|r|Ok(json!({"version":r.get::<_,i64>(0)?,"name":r.get::<_,String>(1)?,"migration_sha256":r.get::<_,String>(2)?,"applied_at":r.get::<_,String>(3)?}))).unwrap().collect::<rusqlite::Result<Vec<_>>>().unwrap())
}
fn apply(case: &Value) -> Value {
    let mut database = setup(case);
    let before = exact_schema_hash_v1(&database).unwrap();
    let target = SchemaTransitionTargetV1::for_role(
        case["role"].as_str().unwrap(),
        case["appliedAt"].as_str(),
    )
    .unwrap();
    let result = (|| -> Result<()> {
        if case["precheck"] == true {
            assert_schema_transition_target_objects_v1(&database, &target)?;
        }
        if case["transaction"] != false {
            database.execute_batch("BEGIN IMMEDIATE;")?;
        }
        apply_schema_transition_statements_v1(&mut database, &target)?;
        if case["repeat"] == true {
            apply_schema_transition_statements_v1(&mut database, &target)?;
        }
        if case["transaction"] != false {
            assert!(
                !database.is_autocommit(),
                "helper must not commit its caller transaction"
            );
        }
        if !database.is_autocommit() {
            database.execute_batch("COMMIT;")?;
        }
        Ok(())
    })();
    let mut result = match result {
        Ok(()) => {
            json!({"ok":true,"preSchemaHash":before,"expectedPostSchemaHash":exact_schema_hash_v1(&database).unwrap(),"objects":schema(&database),"quickCheck":"ok","foreignKeyViolationCount":0})
        }
        Err(error) => {
            if !database.is_autocommit() {
                database.execute_batch("ROLLBACK;").unwrap();
            }
            let mut out = json!({"ok":false,"error":error.code,"unchanged":before==exact_schema_hash_v1(&database).unwrap(),"objects":schema(&database)});
            if !error.details["schemaObject"].is_null() {
                out["schemaObject"] = error.details["schemaObject"].clone();
            }
            out
        }
    };
    if case["role"] == "submission-handoff" {
        result["migrations"] = migration_rows(&database);
    }
    result
}
fn fixtures() -> Vec<Value> {
    let migration = oracle(&[json!({"mode":"migrations","role":"native-store"})]).remove(0);
    let v1 = migration[0]["sql"].as_str().unwrap();
    let v2 = migration[1]["sql"].as_str().unwrap();
    let row = |index: usize| {
        format!(
            "INSERT INTO handoff_schema_migrations VALUES({},'{}','{}','{NOW}');",
            migration[index]["version"],
            migration[index]["name"].as_str().unwrap(),
            migration[index]["migrationHash"].as_str().unwrap()
        )
    };
    let cutover = format!(
        "INSERT INTO handoff_cutover VALUES(1,'autonomous-submission-handoff-cutover-v1','sha256:{}','active','{NOW}','{NOW}');",
        "1".repeat(64)
    );
    let handoff = vec![v1.to_owned(), row(0), cutover];
    let mut cases = Vec::new();
    for role in ["native-store", "resident-instance", "submission-handoff"] {
        cases.push(json!({"label":format!("{role}-upgrade"),"role":role,"appliedAt":NOW,"setup":if role=="submission-handoff"{handoff.clone()}else{vec!["CREATE TABLE business(id INTEGER PRIMARY KEY, value TEXT); INSERT INTO business VALUES(1,'kept');".into()]},"repeat":true}));
    }
    let mut add = |label: &str, extra: Vec<String>, applied_at: Value, transaction: bool| {
        let mut setup = handoff.clone();
        setup.extend(extra);
        cases.push(json!({"label":label,"role":"submission-handoff","appliedAt":applied_at,"setup":setup,"transaction":transaction}));
    };
    add("transaction-required", vec![], json!(NOW), false);
    add(
        "missing-history",
        vec!["DELETE FROM handoff_schema_migrations;".into()],
        json!(NOW),
        true,
    );
    add(
        "wrong-migration-hash",
        vec!["UPDATE handoff_schema_migrations SET migration_sha256='bad';".into()],
        json!(NOW),
        true,
    );
    add(
        "bad-history-time",
        vec!["UPDATE handoff_schema_migrations SET applied_at='invalid';".into()],
        json!(NOW),
        true,
    );
    add("partial-v2-row", vec![row(1)], json!(NOW), true);
    add("partial-v2-table", vec![v2.into()], json!(NOW), true);
    add("already-v2", vec![v2.into(), row(1)], Value::Null, true);
    add(
        "cutover-prepared",
        vec!["UPDATE handoff_cutover SET status='prepared';".into()],
        json!(NOW),
        true,
    );
    add(
        "cutover-missing",
        vec!["DELETE FROM handoff_cutover;".into()],
        json!(NOW),
        true,
    );
    add(
        "cutover-time",
        vec!["UPDATE handoff_cutover SET activated_at='invalid';".into()],
        json!(NOW),
        true,
    );
    add(
        "outbox-nonempty",
        vec![format!(
            "DROP TRIGGER handoff_outbox_binding_required; INSERT INTO submission_outbox(message_id,paper_id,dispatch_hash,provider,account_id,nonce,status,payload_json,created_at,updated_at) VALUES('message','paper','dispatch','provider','account','nonce','ready','{{}}','{NOW}','{NOW}');"
        )],
        json!(NOW),
        true,
    );
    add("foreign-key-violation",vec!["PRAGMA foreign_keys=OFF; CREATE TABLE parent(id INTEGER PRIMARY KEY); CREATE TABLE child(parent_id INTEGER REFERENCES parent(id)); INSERT INTO child VALUES(1); PRAGMA foreign_keys=ON;".into()],json!(NOW),true);
    add("target-time-null", vec![], Value::Null, true);
    add("target-time-invalid", vec![], json!("not-a-time"), true);
    add("migration-insert-abort",vec!["CREATE TRIGGER fixture_abort_upgrade BEFORE INSERT ON handoff_schema_migrations WHEN NEW.version=2 BEGIN SELECT RAISE(ABORT,'fixture_upgrade_abort'); END;".into()],json!(NOW),true);
    add("migration-postcondition",vec!["CREATE TRIGGER fixture_alter_upgrade AFTER INSERT ON handoff_schema_migrations WHEN NEW.version=2 BEGIN UPDATE handoff_schema_migrations SET migration_sha256='tampered' WHERE version=2; END;".into()],json!(NOW),true);
    for precheck in [false, true] {
        cases.push(json!({"label":format!("conflict-{precheck}"),"role":"native-store","appliedAt":NOW,"precheck":precheck,"setup":["CREATE TABLE autonomous_research_online_mutation_authority_metadata(conflict TEXT); CREATE TABLE business(id INTEGER PRIMARY KEY);"]}));
    }
    cases
}
#[test]
fn fixed_schema_templates_objects_and_bundle_hash_match_original_node() {
    let cases = [
        "native-store",
        "submission-handoff",
        "resident-instance",
        "unknown-role",
    ]
    .iter()
    .flat_map(|role| {
        [Value::Null, json!(NOW)]
            .into_iter()
            .map(move |at| json!({"mode":"target","role":role,"appliedAt":at}))
    })
    .collect::<Vec<_>>();
    let expected = oracle(&cases);
    for (case, node) in cases.iter().zip(expected) {
        let target = SchemaTransitionTargetV1::for_role(
            case["role"].as_str().unwrap(),
            case["appliedAt"].as_str(),
        )
        .unwrap();
        assert_eq!(
            json!({"target":target.value(),"bundleHash":schema_transition_bundle_hash_v1().unwrap()}),
            node,
            "{}",
            case["role"]
        );
    }
}
#[test]
fn actual_sqlite_handoff_upgrade_and_failure_rollback_match_node_twenty_one_paths() {
    let cases = fixtures();
    assert_eq!(cases.len(), 21);
    let expected = oracle(&cases);
    for (case, node) in cases.iter().zip(expected) {
        let actual = apply(case);
        assert_eq!(actual["ok"], node["ok"], "{}", case["label"]);
        assert_eq!(actual["error"], node["error"], "{}", case["label"]);
        assert_eq!(
            actual["schemaObject"], node["schemaObject"],
            "{}",
            case["label"]
        );
        assert_eq!(actual, node, "{}", case["label"]);
        if actual["ok"] == false {
            assert_eq!(actual["unchanged"], true, "{}", case["label"]);
        }
    }
}
#[test]
fn projection_uses_a_real_private_sqlite_copy_and_leaves_source_schema_and_rows_untouched() {
    let cases = fixtures()
        .into_iter()
        .filter(|c| {
            [
                "native-store-upgrade",
                "resident-instance-upgrade",
                "submission-handoff-upgrade",
                "already-v2",
                "outbox-nonempty",
                "migration-insert-abort",
            ]
            .contains(&c["label"].as_str().unwrap())
        })
        .collect::<Vec<_>>();
    let expected = oracle(&cases);
    for (case, node) in cases.iter().zip(expected) {
        let mut database = setup(case);
        let before = schema(&database);
        let dump = |db: &Connection| {
            db.query_row(
                "SELECT coalesce(sum(length(sql)),0) FROM sqlite_schema;",
                [],
                |r| r.get::<_, i64>(0),
            )
            .unwrap()
        };
        let size = dump(&database);
        let before_migrations =
            (case["role"] == "submission-handoff").then(|| migration_rows(&database));
        let target = SchemaTransitionTargetV1::for_role(
            case["role"].as_str().unwrap(),
            case["appliedAt"].as_str(),
        )
        .unwrap();
        let result = project_schema_transition_target_v1(&mut database, &target);
        assert_eq!(
            result.is_ok(),
            node["ok"] == true,
            "{}: {:?}",
            case["label"],
            result.as_ref().err().map(|e| &e.code)
        );
        if let Ok(value) = result {
            let mut expected = node.clone();
            expected.as_object_mut().unwrap().remove("ok");
            expected.as_object_mut().unwrap().remove("migrations");
            assert_eq!(value, expected, "{}", case["label"]);
        }
        assert_eq!(schema(&database), before);
        assert_eq!(dump(&database), size);
        if let Some(before) = before_migrations {
            assert_eq!(migration_rows(&database), before);
        } else {
            assert_eq!(
                database
                    .query_row("SELECT value FROM business WHERE id=1;", [], |r| r
                        .get::<_, String>(0))
                    .unwrap(),
                "kept"
            );
        }
        if case["role"] == "submission-handoff" {
            assert_eq!(
                database
                    .query_row("SELECT count(*) FROM handoff_schema_migrations;", [], |r| r
                        .get::<_, i64>(0))
                    .unwrap(),
                if case["label"] == "already-v2" { 2 } else { 1 }
            );
        }
    }
    let mut database = Connection::open_in_memory().unwrap();
    database
        .execute_batch("BEGIN;CREATE TABLE caller_transaction(id TEXT);")
        .unwrap();
    let target = SchemaTransitionTargetV1::for_role("native-store", Some(NOW)).unwrap();
    assert_eq!(
        project_schema_transition_target_v1(&mut database, &target)
            .unwrap_err()
            .code,
        "autonomous_research_online_schema_transition_projection_source_transaction_active"
    );
    assert!(!database.is_autocommit());
    database.execute_batch("ROLLBACK;").unwrap();
}
