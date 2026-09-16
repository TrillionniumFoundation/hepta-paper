use super::*;
use rusqlite::{
    Connection,
    types::{Value as SqlValue, ValueRef},
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
    let mut statement = database.prepare(sql)?;
    let names = statement
        .column_names()
        .iter()
        .map(|s| (*s).to_owned())
        .collect::<Vec<_>>();
    let values = statement
        .query_map(rusqlite::params_from_iter(params.iter()), |row| {
            let mut result = serde_json::Map::new();
            for (index, name) in names.iter().enumerate() {
                let value = match row.get_ref(index)? {
                    ValueRef::Null => Value::Null,
                    ValueRef::Integer(v) => json!(v),
                    ValueRef::Real(v) => json!(v),
                    ValueRef::Text(v) => Value::String(String::from_utf8_lossy(v).into_owned()),
                    ValueRef::Blob(_) => {
                        return Err(rusqlite::Error::InvalidColumnType(
                            index,
                            name.clone(),
                            rusqlite::types::Type::Blob,
                        ));
                    }
                };
                result.insert(name.clone(), value);
            }
            Ok(Value::Object(result))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
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
    let mut rows = rows(
        database,
        "SELECT * FROM autonomous_research_online_mutation_authority_metadata WHERE singleton=1;",
        &[],
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
        SqlValue::Text(reserve_request.to_string()),
        SqlValue::Text(online_mutation_receipt_hash_v1(reservation)?),
        SqlValue::Text(reservation.to_string()),
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
    let receipt_hash = contracts::online_mutation_receipt_hash_v1(receipt)?;
    database.execute_batch("BEGIN IMMEDIATE;")?;
    let result = (|| {
        database.execute("INSERT INTO autonomous_research_online_mutation_finalization_receipt(reservation_id,finalization_receipt_hash,finalization_receipt_json,side_effect_permit_hash,finalized_at,recorded_at) VALUES(?,?,?,?,?,?) ON CONFLICT(reservation_id) DO NOTHING;",rusqlite::params![text(receipt,"reservationId")?,receipt_hash,receipt.to_string(),text(receipt,"sideEffectPermitHash")?,text(receipt,"finalizedAt")?,recorded_at])?;
        let stored:String=database.query_row("SELECT finalization_receipt_hash FROM autonomous_research_online_mutation_finalization_receipt WHERE reservation_id=?;",[text(receipt,"reservationId")?],|row|row.get(0))?;
        if stored != receipt_hash {
            return Err(error(
                "externally_fenced_sqlite_mutation_finalization_receipt_conflict",
            ));
        }
        database.execute_batch("COMMIT;")?;
        Ok(())
    })();
    if result.is_err() && !database.is_autocommit() {
        database.execute_batch("ROLLBACK;")?;
    }
    result
}
