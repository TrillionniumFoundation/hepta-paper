//! Fixed schema templates and actual SQLite migration operations. These helpers
//! do not reserve authority, acquire a deployment lease, or mint runtime readiness.
use crate::sqlite_mutation_coordinator::{Result, error, hash, hash_bytes, timestamp};
use rusqlite::{
    Connection, OptionalExtension,
    backup::{Backup, StepResult},
    types::ValueRef,
};
use serde_json::{Value, json};
use std::{collections::BTreeMap, sync::OnceLock};
fn data() -> Result<&'static Value> {
    static DATA: OnceLock<std::result::Result<Value, String>> = OnceLock::new();
    DATA.get_or_init(|| {
        serde_json::from_str(include_str!("schema_data.json")).map_err(|e| e.to_string())
    })
    .as_ref()
    .map_err(|e| error(e.clone()))
}
fn strings(value: &Value) -> Result<Vec<String>> {
    value
        .as_array()
        .ok_or_else(|| error("autonomous_research_online_schema_transition_fixed_schema_invalid"))?
        .iter()
        .map(|v| {
            v.as_str().map(str::to_owned).ok_or_else(|| {
                error("autonomous_research_online_schema_transition_fixed_schema_invalid")
            })
        })
        .collect()
}
fn rows(database: &Connection, sql: &str) -> Result<Vec<Value>> {
    let mut statement = database.prepare(sql)?;
    let names = statement
        .column_names()
        .iter()
        .map(|s| (*s).to_owned())
        .collect::<Vec<_>>();
    if names.len() > 16 {
        return Err(error(
            "autonomous_research_online_schema_transition_row_limit",
        ));
    }
    let mut cursor = statement.query([])?;
    let mut result = Vec::new();
    let mut bytes = 0usize;
    while let Some(row) = cursor.next()? {
        if result.len() >= 2048 {
            return Err(error(
                "autonomous_research_online_schema_transition_row_limit",
            ));
        }
        let mut object = serde_json::Map::new();
        for (index, name) in names.iter().enumerate() {
            let value = match row.get_ref(index)? {
                ValueRef::Null => Value::Null,
                ValueRef::Integer(value) => json!(value),
                ValueRef::Real(value) => json!(value),
                ValueRef::Text(value) => {
                    bytes = bytes.checked_add(value.len()).ok_or_else(|| {
                        error("autonomous_research_online_schema_transition_row_limit")
                    })?;
                    if bytes > 16 * 1024 * 1024 {
                        return Err(error(
                            "autonomous_research_online_schema_transition_row_limit",
                        ));
                    }
                    json!(std::str::from_utf8(value).map_err(|_| error(
                        "autonomous_research_online_schema_transition_invalid_utf8"
                    ))?)
                }
                ValueRef::Blob(_) => {
                    return Err(error(
                        "autonomous_research_online_schema_transition_unexpected_blob",
                    ));
                }
            };
            object.insert(name.clone(), value);
        }
        result.push(Value::Object(object));
    }
    Ok(result)
}
fn schema_rows(database: &Connection) -> Result<Vec<Value>> {
    rows(
        database,
        "SELECT type,name,tbl_name,coalesce(sql,'') AS sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name,tbl_name,sql;",
    )
}
fn objects(statements: &[String]) -> Result<Vec<(String, Value)>> {
    let connection = Connection::open_in_memory()?;
    for statement in statements {
        connection.execute_batch(statement)?;
    }
    schema_rows(&connection)?
        .into_iter()
        .map(|v| {
            let name = v["name"]
                .as_str()
                .ok_or_else(|| {
                    error("autonomous_research_online_schema_transition_fixed_schema_invalid")
                })?
                .to_owned();
            Ok((name, v))
        })
        .collect()
}
/// Only the checked-in fixed source SQL can construct a target. No Deserialize
/// or arbitrary-SQL constructor is exposed. Applied-at remains data, never SQL.
pub struct SchemaTransitionTargetV1 {
    statements: Vec<String>,
    objects: Vec<(String, Value)>,
    handoff_migrations: Vec<Value>,
}
impl SchemaTransitionTargetV1 {
    pub fn for_role(role: &str, applied_at: Option<&str>) -> Result<Self> {
        let data = data()?;
        let mut statements = strings(&data["marker"])?;
        let mut target_objects = objects(&statements)?;
        let mut handoff_migrations = Vec::new();
        if role == "resident-instance" {
            let journal = strings(&data["journal"])?;
            target_objects.extend(objects(&journal)?);
            statements.extend(journal);
        }
        if role == "submission-handoff" {
            let mut migration = data["handoff"]
                .as_array()
                .and_then(|a| a.last())
                .cloned()
                .ok_or_else(|| {
                    error("autonomous_submission_handoff_target_schema_migration_invalid")
                })?;
            if migration["version"] != 2 {
                return Err(error(
                    "autonomous_submission_handoff_target_schema_migration_invalid",
                ));
            }
            let sql = migration["sql"]
                .as_str()
                .ok_or_else(|| {
                    error("autonomous_submission_handoff_target_schema_migration_invalid")
                })?
                .to_owned();
            if migration["migrationHash"] != hash_bytes(sql.as_bytes()) {
                return Err(error(
                    "autonomous_submission_handoff_target_schema_migration_invalid",
                ));
            }
            target_objects.extend(objects(std::slice::from_ref(&sql))?);
            statements.push(sql);
            migration["appliedAt"] = json!(applied_at);
            handoff_migrations.push(migration);
        }
        Ok(Self {
            statements,
            objects: target_objects,
            handoff_migrations,
        })
    }
    /// A template description only; it does not assert that a database has it.
    pub fn value(&self) -> Value {
        json!({"statements":self.statements,"objects":self.objects,"handoffMigrations":self.handoff_migrations})
    }
}
pub fn schema_transition_bundle_hash_v1() -> Result<String> {
    let data = data()?;
    let journal_hash = hash(
        "AutonomousResearchOnlineAuthorityJournalSchema",
        &json!({"version":data["version"],"contractId":data["contractId"],"statements":data["journal"]}),
    )?;
    let marker_hash = hash(
        "AutonomousResearchOnlineMutationMarkerSchema",
        &json!({"version":1,"protocol":"external-linearizable-reserve-apply-finalize-v1","statements":data["marker"]}),
    )?;
    hash(
        "AutonomousResearchOnlineSchemaTransitionBundle",
        &json!({"authorityJournalSchemaContractId":data["contractId"],"authorityJournalSchemaHash":journal_hash,"markerSchemaHash":marker_hash,"authorityJournalStatements":data["journal"],"markerStatements":data["marker"],"autonomousSubmissionHandoffMigrations":data["handoff"]}),
    )
}
pub fn assert_schema_transition_target_objects_v1(
    database: &Connection,
    target: &SchemaTransitionTargetV1,
) -> Result<()> {
    let actual = schema_rows(database)?
        .into_iter()
        .map(|row| (row["name"].as_str().unwrap_or_default().to_owned(), row))
        .collect::<BTreeMap<_, _>>();
    for (name, expected) in &target.objects {
        if actual.get(name).is_some_and(|row| row != expected) {
            let mut error =
                error("autonomous_research_online_schema_transition_target_schema_conflict");
            error.details = json!({"schemaObject":name});
            return Err(error);
        }
    }
    Ok(())
}
fn migrations(database: &Connection) -> Result<Vec<Value>> {
    rows(
        database,
        "SELECT version,name,migration_sha256,applied_at FROM handoff_schema_migrations ORDER BY version;",
    )
}
fn migrations_match(rows: &[Value], migrations: &[Value]) -> bool {
    rows.len() == migrations.len()
        && rows.iter().zip(migrations).all(|(row, migration)| {
            row["version"].as_f64() == migration["version"].as_f64()
                && row["name"] == migration["name"]
                && row["migration_sha256"] == migration["migrationHash"]
                && timestamp(&row["applied_at"]).is_some()
        })
}
fn handoff_pending<'a>(
    database: &Connection,
    target: &'a SchemaTransitionTargetV1,
) -> Result<&'a [Value]> {
    if target.handoff_migrations.is_empty() {
        return Ok(&[]);
    }
    if database.is_autocommit() {
        return Err(error(
            "autonomous_submission_handoff_schema_upgrade_authority_transaction_required",
        ));
    }
    let all = data()?["handoff"]
        .as_array()
        .filter(|a| a.len() == 2)
        .ok_or_else(|| error("autonomous_submission_handoff_target_schema_migration_invalid"))?;
    let observed = migrations(database)?;
    let table_exists=database.query_row("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='submission_authorization_consumptions';",[],|r|r.get::<_,i64>(0)).optional()?.is_some();
    if migrations_match(&observed, all) {
        if !table_exists {
            return Err(error(
                "autonomous_submission_handoff_schema_upgrade_partial_state",
            ));
        }
        return Ok(&[]);
    }
    if !migrations_match(&observed, &all[..1]) || table_exists {
        return Err(error(
            "autonomous_submission_handoff_schema_upgrade_preimage_mismatch",
        ));
    }
    let cutovers = rows(
        database,
        "SELECT status,activated_at FROM handoff_cutover WHERE singleton=1;",
    )?;
    let count = database.query_row("SELECT count(*) FROM submission_outbox;", [], |r| {
        r.get::<_, i64>(0)
    })?;
    let quick = rows(database, "PRAGMA quick_check;")?;
    let foreign = database.prepare("PRAGMA foreign_key_check;")?.exists([])?;
    if cutovers.len() != 1
        || cutovers[0]["status"] != "active"
        || timestamp(&cutovers[0]["activated_at"]).is_none()
        || count != 0
        || quick.len() != 1
        || quick[0]["quick_check"] != "ok"
        || foreign
    {
        return Err(error(if count != 0 {
            "autonomous_submission_handoff_schema_upgrade_empty_outbox_required"
        } else {
            "autonomous_submission_handoff_schema_upgrade_preconditions_failed"
        }));
    }
    let migration = target
        .handoff_migrations
        .first()
        .ok_or_else(|| error("autonomous_submission_handoff_schema_upgrade_target_invalid"))?;
    let expected = &all[1];
    if target.handoff_migrations.len() != 1
        || migration["version"] != expected["version"]
        || migration["name"] != expected["name"]
        || migration["migrationHash"] != expected["migrationHash"]
        || timestamp(&migration["appliedAt"]).is_none()
    {
        return Err(error(
            "autonomous_submission_handoff_schema_upgrade_target_invalid",
        ));
    }
    Ok(&target.handoff_migrations)
}
/// Applies fixed DDL and migration rows inside the caller's transaction. The
/// caller owns commit/rollback and must hold the real external reservation and
/// lease before using this against live state. This helper grants no authority.
pub fn apply_schema_transition_statements_v1(
    database: &mut Connection,
    target: &SchemaTransitionTargetV1,
) -> Result<()> {
    let pending = handoff_pending(database, target)?;
    let name =
        regex::Regex::new(r"(?i)\bCREATE\s+(?:TABLE|INDEX|TRIGGER)\s+([A-Za-z_][A-Za-z0-9_]*)")
            .map_err(|e| error(e.to_string()))?;
    for statement in &target.statements {
        let selected = name
            .captures(statement)
            .and_then(|c| c.get(1))
            .map(|s| s.as_str())
            .ok_or_else(|| {
                error("autonomous_research_online_schema_transition_statement_invalid")
            })?;
        let exists = database
            .query_row(
                "SELECT 1 FROM sqlite_schema WHERE name=?;",
                [selected],
                |r| r.get::<_, i64>(0),
            )
            .optional()?
            .is_some();
        if !exists {
            database.execute_batch(statement)?;
        }
    }
    for migration in pending {
        let at = timestamp(&migration["appliedAt"])
            .ok_or_else(|| error("autonomous_submission_handoff_schema_upgrade_target_invalid"))?;
        database.execute("INSERT INTO handoff_schema_migrations(version,name,migration_sha256,applied_at) VALUES(?,?,?,?);",rusqlite::params![migration["version"].as_i64(),migration["name"].as_str(),migration["migrationHash"].as_str(),crate::sqlite_mutation_coordinator::clock::iso(at)?])?;
    }
    assert_schema_transition_target_objects_v1(database, target)?;
    if !target.handoff_migrations.is_empty()
        && !migrations_match(
            &migrations(database)?,
            data()?["handoff"].as_array().ok_or_else(|| {
                error("autonomous_submission_handoff_target_schema_migration_invalid")
            })?,
        )
    {
        return Err(error(
            "autonomous_submission_handoff_schema_upgrade_postcondition_failed",
        ));
    }
    Ok(())
}
/// Projects real DDL on a private in-memory SQLite backup. The source connection
/// is never used for DDL or journal-mode changes. This is a local projection,
/// not a plan bound to file identity or an authority capability.
pub fn project_schema_transition_target_v1(
    source: &mut Connection,
    target: &SchemaTransitionTargetV1,
) -> Result<Value> {
    if !source.is_autocommit() {
        return Err(error(
            "autonomous_research_online_schema_transition_projection_source_transaction_active",
        ));
    }
    // Hold one read snapshot across size checks and backup, so another writer
    // cannot grow the source beyond the checked bound between these operations.
    let source_snapshot =
        source.transaction_with_behavior(rusqlite::TransactionBehavior::Deferred)?;
    let page_size = source_snapshot.query_row("PRAGMA page_size;", [], |r| r.get::<_, i64>(0))?;
    let page_count = source_snapshot.query_row("PRAGMA page_count;", [], |r| r.get::<_, i64>(0))?;
    if page_size <= 0
        || page_count < 0
        || page_size
            .checked_mul(page_count)
            .is_none_or(|v| v > 256 * 1024 * 1024)
    {
        return Err(error(
            "autonomous_research_online_schema_transition_projection_source_limit",
        ));
    }
    let source_schema = hash(
        "AutonomousResearchStateDatabaseSchema",
        &json!(schema_rows(&source_snapshot)?),
    )?;
    let mut copy = Connection::open_in_memory()?;
    {
        let backup = Backup::new(&source_snapshot, &mut copy)?;
        if backup.step(-1)? != StepResult::Done {
            return Err(error(
                "autonomous_research_online_schema_transition_projection_backup_busy",
            ));
        }
    }
    if hash(
        "AutonomousResearchStateDatabaseSchema",
        &json!(schema_rows(&source_snapshot)?),
    )? != source_schema
        || hash(
            "AutonomousResearchStateDatabaseSchema",
            &json!(schema_rows(&copy)?),
        )? != source_schema
    {
        return Err(error(
            "autonomous_research_online_schema_transition_database_changed_during_simulation",
        ));
    }
    source_snapshot.rollback()?;
    assert_schema_transition_target_objects_v1(&copy, target)?;
    copy.execute_batch("PRAGMA foreign_keys=ON; BEGIN IMMEDIATE;")?;
    let result = apply_schema_transition_statements_v1(&mut copy, target);
    match result {
        Ok(()) => copy.execute_batch("COMMIT;")?,
        Err(error) => {
            let _ = copy.execute_batch("ROLLBACK;");
            return Err(error);
        }
    }
    let quick = rows(&copy, "PRAGMA quick_check;")?;
    if quick.len() != 1
        || quick[0]["quick_check"] != "ok"
        || copy.prepare("PRAGMA foreign_key_check;")?.exists([])?
    {
        return Err(error(
            "autonomous_research_online_schema_transition_simulated_schema_invalid",
        ));
    }
    let schema = schema_rows(&copy)?;
    Ok(
        json!({"preSchemaHash":source_schema,"expectedPostSchemaHash":hash("AutonomousResearchStateDatabaseSchema",&json!(schema))?,"objects":schema,"quickCheck":"ok","foreignKeyViolationCount":0}),
    )
}
