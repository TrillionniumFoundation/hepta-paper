use super::*;
use rusqlite::{
    Connection,
    types::{Value as SqlValue, ValueRef},
};
#[cfg(test)]
#[path = "storage_tests.rs"]
mod tests;

#[derive(Clone, Copy)]
struct RowLimits {
    rows: usize,
    cell_bytes: usize,
    total_bytes: usize,
}
const DEFAULT_ROW_LIMITS: RowLimits = RowLimits {
    rows: 100_000,
    cell_bytes: 32 * 1024 * 1024,
    total_bytes: 256 * 1024 * 1024,
};
pub(super) const SYSTEM_TABLES: &[&str] = &[
    "autonomous_research_online_mutation_authority_metadata",
    "autonomous_research_online_mutation_authority_marker",
    "autonomous_research_online_mutation_finalization_receipt",
];
impl From<rusqlite::Error> for SqliteMutationCoordinatorError {
    fn from(value: rusqlite::Error) -> Self {
        match value {
            rusqlite::Error::SqliteFailure(_, Some(message)) => error(message),
            other => error(format!(
                "externally_fenced_sqlite_mutation_sqlite_error:{other}"
            )),
        }
    }
}
impl From<crate::sqlite_mutation_plan::SqliteMutationPlanError> for SqliteMutationCoordinatorError {
    fn from(value: crate::sqlite_mutation_plan::SqliteMutationPlanError) -> Self {
        error(value.to_string())
    }
}
pub(super) fn rows(database: &Connection, sql: &str, params: &[SqlValue]) -> Result<Vec<Value>> {
    rows_bounded(
        database,
        sql,
        params,
        DEFAULT_ROW_LIMITS,
        "externally_fenced_sqlite_mutation_storage_resource_limit",
    )
}
fn rows_bounded(
    database: &Connection,
    sql: &str,
    params: &[SqlValue],
    limits: RowLimits,
    code: &str,
) -> Result<Vec<Value>> {
    let mut statement = database.prepare(sql)?;
    // Bound names before cloning them as well: SELECT * must not materialize an
    // attacker-expanded schema before its exact schema hash has been checked.
    if statement.column_count() > 256 || statement.column_names().iter().any(|n| n.len() > 512) {
        return Err(error(code));
    }
    let names = statement
        .column_names()
        .iter()
        .map(|s| (*s).to_owned())
        .collect::<Vec<_>>();
    let mut cursor = statement.query(rusqlite::params_from_iter(params.iter()))?;
    let mut values = Vec::new();
    let mut total_bytes = 0usize;
    while let Some(row) = cursor.next()? {
        if values.len() >= limits.rows {
            return Err(error(code));
        }
        let mut result = serde_json::Map::new();
        for (index, name) in names.iter().enumerate() {
            let value = match row.get_ref(index)? {
                ValueRef::Null => Value::Null,
                ValueRef::Integer(v) => json!(v),
                ValueRef::Real(v) => json!(v),
                ValueRef::Text(v) => {
                    total_bytes = total_bytes
                        .checked_add(v.len())
                        .ok_or_else(|| error(code))?;
                    if v.len() > limits.cell_bytes || total_bytes > limits.total_bytes {
                        return Err(error(code));
                    }
                    let text = std::str::from_utf8(v).map_err(|_| {
                        error("externally_fenced_sqlite_mutation_storage_utf8_invalid")
                    })?;
                    Value::String(text.to_owned())
                }
                ValueRef::Blob(_) => {
                    return Err(rusqlite::Error::InvalidColumnType(
                        index,
                        name.clone(),
                        rusqlite::types::Type::Blob,
                    )
                    .into());
                }
            };
            result.insert(name.clone(), value);
        }
        values.push(Value::Object(result));
    }
    Ok(values)
}
pub fn exact_schema_hash_v1(database: &Connection) -> Result<String> {
    hash(
        "AutonomousResearchStateDatabaseSchema",
        &json!(rows(
            database,
            "SELECT type,name,tbl_name,coalesce(sql,'') AS sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name,tbl_name,sql;",
            &[]
        )?),
    )
}
pub(super) fn metadata(database: &Connection) -> Result<Value> {
    let mut rows = rows_bounded(
        database,
        "SELECT * FROM autonomous_research_online_mutation_authority_metadata WHERE singleton=1;",
        &[],
        RowLimits {
            rows: 2,
            cell_bytes: 4096,
            total_bytes: 64 * 1024,
        },
        "externally_fenced_sqlite_mutation_metadata_resource_limit",
    )?;
    if rows.len() != 1 {
        return Err(error("externally_fenced_sqlite_mutation_metadata_required"));
    }
    rows.pop()
        .ok_or_else(|| error("externally_fenced_sqlite_mutation_metadata_required"))
}
pub(super) fn latest_local_head(database: &Connection, instance: &str) -> Result<Value> {
    let genesis = metadata(database)?;
    let marker = rows(
        database,
        "SELECT * FROM autonomous_research_online_mutation_authority_marker WHERE database_instance_id=? ORDER BY database_sequence DESC LIMIT 1;",
        &[SqlValue::Text(instance.into())],
    )?;
    Ok(if let Some(marker) = marker.first() {
        json!({"sequence":marker["database_sequence"],"hash":marker["database_hash"],"schemaHash":marker["schema_hash"],"stateHash":marker["post_state_hash"]})
    } else {
        json!({"sequence":genesis["genesis_database_sequence"],"hash":genesis["genesis_database_hash"],"schemaHash":genesis["schema_hash"],"stateHash":genesis["genesis_state_hash"]})
    })
}
pub(super) fn system_counts(database: &Connection) -> Result<Vec<i64>> {
    SYSTEM_TABLES
        .iter()
        .map(|table| {
            database
                .query_row(&format!("SELECT count(*) FROM {table};"), [], |row| {
                    row.get(0)
                })
                .map_err(Into::into)
        })
        .collect()
}
pub(super) fn pending_count(database: &Connection) -> Result<i64> {
    Ok(database.query_row("SELECT count(*) FROM autonomous_research_online_mutation_authority_marker marker LEFT JOIN autonomous_research_online_mutation_finalization_receipt finalized ON finalized.reservation_id=marker.reservation_id WHERE finalized.reservation_id IS NULL;",[],|row|row.get(0))?)
}
// Journal JSON is authenticated by canonical hashes, not original object-member
// order. Match JavaScript Number spelling at this persistence boundary: an
// authenticated 1.0 is the integer 1, including SQLite's json_type checks.
fn journal_json(value: &Value) -> Result<String> {
    let bytes = hepta_legacy_compatibility::production_stable_json_v1(value)
        .map_err(|e| error(e.to_string()))?;
    String::from_utf8(bytes)
        .map_err(|_| error("externally_fenced_sqlite_mutation_journal_json_invalid"))
}
pub(super) fn insert_marker(
    database: &Connection,
    reservation: &Value,
    request: &Value,
    reserve_request: &Value,
) -> Result<()> {
    use contracts::online_mutation_receipt_hash_v1;
    let mut params = Vec::new();
    for key in [
        "reservationId",
        "databaseRole",
        "databaseInstanceId",
        "writerId",
        "operationId",
        "globalSequence",
        "globalHash",
        "databaseSequence",
        "databaseHash",
        "schemaHash",
        "preStateHash",
        "postStateHash",
        "changesetHash",
    ] {
        params.push(if ["globalSequence", "databaseSequence"].contains(&key) {
            SqlValue::Integer(int(reservation, key)?)
        } else {
            SqlValue::Text(text(reservation, key)?.into())
        });
    }
    params.extend([
        SqlValue::Text(hash(
            "AutonomousResearchOnlineMutationReserveRequest",
            reserve_request,
        )?),
        SqlValue::Text(journal_json(reserve_request)?),
        SqlValue::Text(online_mutation_receipt_hash_v1(reservation)?),
        SqlValue::Text(journal_json(reservation)?),
        SqlValue::Text(text(request, "localMarkerHash")?.into()),
        SqlValue::Text(text(request, "committedAt")?.into()),
    ]);
    database.execute("INSERT INTO autonomous_research_online_mutation_authority_marker(reservation_id,database_role,database_instance_id,writer_id,operation_id,global_sequence,global_hash,database_sequence,database_hash,schema_hash,pre_state_hash,post_state_hash,changeset_hash,reserve_request_hash,reserve_request_json,reservation_receipt_hash,reservation_receipt_json,local_marker_hash,committed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?);",rusqlite::params_from_iter(params))?;
    Ok(())
}
pub(super) fn record_finalization(
    database: &Connection,
    receipt: &Value,
    recorded_at: &str,
) -> Result<()> {
    database.execute_batch("BEGIN IMMEDIATE;")?;
    let result = (|| {
        record_finalization_in_transaction(database, receipt, recorded_at)?;
        database.execute_batch("COMMIT;")?;
        Ok(())
    })();
    if result.is_err() && !database.is_autocommit() {
        database.execute_batch("ROLLBACK;")?;
    }
    result
}

/// Write only while the caller owns the transaction and its current marker.
pub(super) fn record_finalization_in_transaction(
    database: &Connection,
    receipt: &Value,
    recorded_at: &str,
) -> Result<()> {
    if database.is_autocommit() {
        return Err(error(
            "externally_fenced_sqlite_mutation_finalization_transaction_required",
        ));
    }
    let receipt_hash = contracts::online_mutation_receipt_hash_v1(receipt)?;
    database.execute("INSERT INTO autonomous_research_online_mutation_finalization_receipt(reservation_id,finalization_receipt_hash,finalization_receipt_json,side_effect_permit_hash,finalized_at,recorded_at) VALUES(?,?,?,?,?,?) ON CONFLICT(reservation_id) DO NOTHING;",rusqlite::params![text(receipt,"reservationId")?,receipt_hash,journal_json(receipt)?,text(receipt,"sideEffectPermitHash")?,text(receipt,"finalizedAt")?,recorded_at])?;
    let stored:String=database.query_row("SELECT finalization_receipt_hash FROM autonomous_research_online_mutation_finalization_receipt WHERE reservation_id=?;",[text(receipt,"reservationId")?],|row|row.get(0))?;
    if stored != receipt_hash {
        return Err(error(
            "externally_fenced_sqlite_mutation_finalization_receipt_conflict",
        ));
    }
    Ok(())
}

/// Caller must hold a read transaction across bound checking and row loading.
pub(super) fn pending_markers_bounded(database: &Connection, code: &str) -> Result<Vec<Value>> {
    if database.is_autocommit() {
        return Err(error(
            "externally_fenced_sqlite_mutation_pending_snapshot_required",
        ));
    }
    // Bound rows and aggregate serialized bytes before materializing hostile
    // persisted JSON. Legitimate over-limit history requires operator review.
    let limits:(i64,i64,i64)=database.query_row("SELECT count(*),coalesce(sum(length(CAST(marker.reserve_request_json AS BLOB))+length(CAST(marker.reservation_receipt_json AS BLOB))),0),coalesce(max(max(length(CAST(marker.reserve_request_json AS BLOB)),length(CAST(marker.reservation_receipt_json AS BLOB)))),0) FROM autonomous_research_online_mutation_authority_marker marker LEFT JOIN autonomous_research_online_mutation_finalization_receipt finalized ON finalized.reservation_id=marker.reservation_id WHERE finalized.reservation_id IS NULL;",[],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?)))?;
    if limits.0 > 4096 || limits.1 > 64 * 1024 * 1024 || limits.2 > 32 * 1024 * 1024 {
        return Err(error(code));
    }
    let rows = rows_bounded(
        database,
        "SELECT marker.* FROM autonomous_research_online_mutation_authority_marker marker LEFT JOIN autonomous_research_online_mutation_finalization_receipt finalized ON finalized.reservation_id=marker.reservation_id WHERE finalized.reservation_id IS NULL ORDER BY marker.database_sequence LIMIT 4097;",
        &[],
        RowLimits {
            rows: 4096,
            cell_bytes: 32 * 1024 * 1024,
            total_bytes: 64 * 1024 * 1024,
        },
        code,
    )?;
    Ok(rows)
}
