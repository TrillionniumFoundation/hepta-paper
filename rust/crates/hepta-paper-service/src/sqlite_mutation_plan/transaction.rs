use super::*;
use crate::sqlite_changeset::{
    ChangesetEffectV1, MAX_CHANGESET_BYTES, assert_sqlite_changeset_effects_authorized_v1,
};
use rusqlite::{
    Connection, params_from_iter,
    session::Session,
    types::{Value as SqlValue, ValueRef},
};
use std::io::Write;

struct Guards<'a> {
    db: &'a Connection,
    names: Vec<String>,
}
impl Guards<'_> {
    fn remove(&mut self) -> Result<()> {
        let mut failed = false;
        while let Some(name) = self.names.pop() {
            if self
                .db
                .execute_batch(&format!("DROP TRIGGER temp.{}", quoted(&name)?))
                .is_err()
            {
                failed = true;
            }
        }
        if failed {
            Err(error(
                "externally_fenced_sqlite_mutation_guard_cleanup_failed",
            ))
        } else {
            Ok(())
        }
    }
}
impl Drop for Guards<'_> {
    fn drop(&mut self) {
        let _ = self.remove();
    }
}
fn guards<'a>(db: &'a Connection, plan: &ValidatedMutationPlanV1) -> Result<Guards<'a>> {
    let events = planned_events(plan)?;
    let tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT GLOB 'sqlite_*' ORDER BY name")?
        .query_map([],|r|r.get::<_,String>(0))?.collect::<std::result::Result<Vec<_>,_>>()?;
    if tables.len() > 1024 {
        return Err(error(
            "externally_fenced_sqlite_mutation_table_limit_exceeded",
        ));
    }
    let mut guards = Guards {
        db,
        names: Vec::new(),
    };
    for table in tables {
        for operation in ["INSERT", "UPDATE", "DELETE"] {
            if events
                .get(&table)
                .is_some_and(|allowed| allowed.contains(operation))
            {
                if ["INSERT", "UPDATE"].contains(&operation) {
                    let predicate = surface::columns(db, &table)?
                        .iter()
                        .filter(|(_, pk)| *pk > 0)
                        .map(|(name, _)| format!("NEW.{} IS NULL", surface::quote_column(name)))
                        .collect::<Vec<_>>()
                        .join(" OR ");
                    let name = format!("hepta_mutation_guard_{}", guards.names.len());
                    db.execute_batch(&format!("CREATE TEMP TRIGGER {} BEFORE {operation} ON main.{} WHEN {predicate} BEGIN SELECT RAISE(ABORT, 'externally_fenced_sqlite_mutation_null_primary_key_forbidden'); END",quoted(&name)?,quoted(&table)?))?;
                    guards.names.push(name);
                }
                continue;
            }
            let name = format!("hepta_mutation_guard_{}", guards.names.len());
            db.execute_batch(&format!("CREATE TEMP TRIGGER {} BEFORE {operation} ON main.{} BEGIN SELECT RAISE(ABORT, 'externally_fenced_sqlite_mutation_table_operation_forbidden'); END",quoted(&name)?,quoted(&table)?))?;
            guards.names.push(name);
        }
    }
    Ok(guards)
}
fn json_value(value: ValueRef<'_>) -> Result<Value> {
    Ok(match value {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(v) if v.unsigned_abs() <= 9_007_199_254_740_991 => json!(v),
        ValueRef::Integer(_) => {
            return Err(error(
                "externally_fenced_sqlite_mutation_integer_out_of_range",
            ));
        }
        ValueRef::Real(v) => json!(v),
        ValueRef::Text(v) => json!(String::from_utf8_lossy(v)),
        // Node's JSON serialization of Uint8Array is an object of byte indices.
        ValueRef::Blob(v) => Value::Object(
            v.iter()
                .enumerate()
                .map(|(i, b)| (i.to_string(), json!(b)))
                .collect(),
        ),
    })
}
/// The callback only receives this fixed-statement surface. It cannot obtain a
/// database handle, submit arbitrary SQL, or retain the surface after return.
pub struct RestrictedMutationTransactionV1<'a> {
    db: &'a Connection,
    statements: BTreeMap<String, (Statement, rusqlite::Statement<'a>)>,
    executed: Vec<ChangesetEffectV1>,
}
impl RestrictedMutationTransactionV1<'_> {
    fn invoke(&mut self, mode: &str, id: &str, parameters: &[SqlValue]) -> Result<Value> {
        let (definition, statement) = self
            .statements
            .get_mut(&json!(id).to_string())
            .filter(|(d, _)| d.mode == mode && d.raw_id.as_str() == Some(id))
            .ok_or_else(|| error("externally_fenced_sqlite_mutation_statement_not_authorized"))?;
        if mode == "run" {
            // Node StatementSync.run also executes DML with RETURNING while
            // discarding its rows. rusqlite::execute rejects that valid shape.
            let mut rows = statement.query(params_from_iter(parameters))?;
            let mut returned = 0usize;
            while rows.next()?.is_some() {
                returned += 1;
                if returned > 1_000_000 {
                    return Err(error(
                        "externally_fenced_sqlite_mutation_result_limit_exceeded",
                    ));
                }
            }
            drop(rows);
            let changed = self.db.changes();
            if let Some(table) = &definition.table {
                self.executed
                    .extend(
                        write_events(definition)?
                            .into_iter()
                            .map(|op| ChangesetEffectV1 {
                                table: table.clone(),
                                operation: op.to_owned(),
                            }),
                    );
            }
            let rowid = self.db.last_insert_rowid();
            if rowid.unsigned_abs() > 9_007_199_254_740_991 {
                return Err(error(
                    "externally_fenced_sqlite_mutation_integer_out_of_range",
                ));
            }
            return Ok(json!({"changes":changed,"lastInsertRowid":rowid}));
        }
        // Read statements are compiled from SELECT-only plans; additionally
        // retain SQLite's actual readonly check against extension surprises.
        if !statement.readonly() {
            return Err(error(
                "externally_fenced_sqlite_mutation_statement_not_authorized",
            ));
        }
        let columns = statement
            .column_names()
            .into_iter()
            .map(str::to_owned)
            .collect::<Vec<_>>();
        let mut rows = statement.query(params_from_iter(parameters))?;
        let mut values = Vec::new();
        while let Some(row) = rows.next()? {
            let mut object = serde_json::Map::new();
            for (index, name) in columns.iter().enumerate() {
                object.insert(name.clone(), json_value(row.get_ref(index)?)?);
            }
            values.push(Value::Object(object));
            if mode == "get" {
                break;
            }
            if values.len() > 1_000_000 {
                return Err(error(
                    "externally_fenced_sqlite_mutation_result_limit_exceeded",
                ));
            }
        }
        Ok(if mode == "get" {
            values.into_iter().next().unwrap_or(Value::Null)
        } else {
            Value::Array(values)
        })
    }
    pub fn get(&mut self, id: &str, parameters: &[SqlValue]) -> Result<Value> {
        self.invoke("get", id, parameters)
    }
    pub fn all(&mut self, id: &str, parameters: &[SqlValue]) -> Result<Value> {
        self.invoke("all", id, parameters)
    }
    pub fn run(&mut self, id: &str, parameters: &[SqlValue]) -> Result<Value> {
        self.invoke("run", id, parameters)
    }
}
struct BoundedBytes(Vec<u8>);
impl Write for BoundedBytes {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if self
            .0
            .len()
            .checked_add(bytes.len())
            .is_none_or(|size| size > MAX_CHANGESET_BYTES)
        {
            return Err(std::io::Error::other("sqlite_changeset_too_large"));
        }
        self.0.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
/// Run inside an already-owned transaction, revoke the callback surface, check
/// actual Session changes, and remove guards before returning. Never commits.
///
/// Exclusive ownership prevents a callback from capturing the outer connection
/// and committing before the coordinator has reserved external authority:
///
/// ```compile_fail,E0502
/// use hepta_paper_service::sqlite_mutation_plan::*;
/// use rusqlite::Connection;
/// let mut db = Connection::open_in_memory().unwrap();
/// let plan = validate_sqlite_mutation_operation_v1(&serde_json::json!({
///     "version":1,"operationId":"operation:fixture",
///     "statements":[{"statementId":"write-row","mode":"run",
///         "sql":"UPDATE fixture SET value=? WHERE id=?"}]
/// })).unwrap();
/// let _: Result<((), Vec<u8>)> = with_restricted_sqlite_mutation_v1(
///     &mut db, &plan, |_| {
///         db.execute_batch("COMMIT").unwrap();
///         Ok(())
///     }
/// );
/// ```
pub fn with_restricted_sqlite_mutation_v1<T, E, F>(
    db: &mut Connection,
    plan: &ValidatedMutationPlanV1,
    callback: F,
) -> std::result::Result<(T, Vec<u8>), E>
where
    E: From<SqliteMutationPlanError>,
    F: FnOnce(&mut RestrictedMutationTransactionV1<'_>) -> std::result::Result<T, E>,
{
    if db.is_autocommit() {
        return Err(error("externally_fenced_sqlite_mutation_transaction_required").into());
    }
    assert_sqlite_mutation_database_surface_v1(db, plan)?;
    let mut guards = guards(db, plan)?;
    let mut statements = BTreeMap::new();
    for definition in &plan.statements {
        statements.insert(
            definition.raw_id.to_string(),
            (
                definition.clone(),
                db.prepare(&definition.sql)
                    .map_err(SqliteMutationPlanError::from)?,
            ),
        );
    }
    let mut session = Session::new(db).map_err(SqliteMutationPlanError::from)?;
    session
        .attach(None::<&str>)
        .map_err(SqliteMutationPlanError::from)?;
    let mut transaction = RestrictedMutationTransactionV1 {
        db,
        statements,
        executed: Vec::new(),
    };
    let outcome = callback(&mut transaction);
    let executed = std::mem::take(&mut transaction.executed);
    drop(transaction);
    let mut changeset = BoundedBytes(Vec::new());
    let captured = session
        .changeset_strm(&mut changeset)
        .map_err(SqliteMutationPlanError::from);
    drop(session);
    let cleanup = guards.remove();
    let authorized = planned_events(plan)?
        .into_iter()
        .flat_map(|(table, events)| {
            events.into_iter().map(move |op| ChangesetEffectV1 {
                table: table.clone(),
                operation: op.into(),
            })
        })
        .collect::<Vec<_>>();
    captured?;
    assert_sqlite_changeset_effects_authorized_v1(&changeset.0, &authorized, &executed)
        .map_err(|e| error(&e.to_string()))?;
    cleanup?;
    if db.is_autocommit() {
        return Err(error("externally_fenced_sqlite_mutation_transaction_boundary_escaped").into());
    }
    Ok((outcome?, changeset.0))
}
