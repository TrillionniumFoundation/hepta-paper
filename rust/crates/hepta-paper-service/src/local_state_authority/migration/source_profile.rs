//! Closed structural inspection of the incumbent Node authority journal.
//!
//! The caller owns an already active main-database transaction. This module
//! performs only read-only statements on that connection; the DDL reference is
//! constructed in a separate, memory-only connection. This is not a history,
//! signature, process-stop, file identity, migration, or production proof.
use crate::sqlite_mutation_coordinator::{Result, error, hash};
use rusqlite::{Connection, Params, TransactionState, types::ValueRef};
use serde_json::{Value, json};
use std::collections::BTreeSet;

const SOURCE_SCHEMA: &str = include_str!("source_schema.sql");
const DOMAIN: &str = "HeptaLocalStateAuthorityNodeJournalSourceSchemaV1";
const MAX_ROWS: usize = 64;
const MAX_COLUMNS: usize = 7;
const MAX_CELL_BYTES: usize = 4096;
const MAX_QUERY_BYTES: usize = 32 * 1024;
const TABLES: [&str; 6] = [
    "authority_backup_reservation",
    "authority_database_head",
    "authority_metadata",
    "authority_mutation",
    "authority_schema_rebind",
    "authority_schema_transition",
];

/// A structural observation only. No caller-supplied JSON constructor exists.
#[derive(Debug, PartialEq)]
pub(super) struct SourceProfile {
    schema: Value,
    schema_hash: String,
}
impl SourceProfile {
    pub(super) fn schema(&self) -> &Value {
        &self.schema
    }
    pub(super) fn schema_hash(&self) -> &str {
        &self.schema_hash
    }
}

/// Inspect exactly the six-table, user_version=0 Node journal schema.
///
/// A bare BEGIN DEFERRED is insufficient: main must already hold a snapshot or
/// writer transaction. The function never changes transaction or connection
/// settings, opens source files, or invokes a caller callback.
pub(super) fn inspect_source_schema(db: &Connection) -> Result<SourceProfile> {
    let before = held_main_state(db)?;
    let changes = db.total_changes();
    // quick_check follows ignore_check_constraints; accepting an ON connection
    // would silently weaken the integrity result. Never normalize caller state.
    if integer(db, "PRAGMA ignore_check_constraints")? != 0
        || integer(db, "PRAGMA writable_schema")? != 0
    {
        return Err(error(
            "local_authority_source_schema_connection_settings_invalid",
        ));
    }
    if integer(db, "PRAGMA main.user_version")? != 0 {
        return Err(error("local_authority_source_schema_version_invalid"));
    }
    let reference = Connection::open_in_memory()?;
    reference.execute_batch(SOURCE_SCHEMA)?;
    let expected = observe_structure(&reference, None)?;
    let actual = observe_structure(db, Some(&expected["catalog"]))?;
    if actual != expected {
        return Err(error("local_authority_source_schema_mismatch"));
    }
    if rows(db, "PRAGMA main.quick_check", [])? != vec![json!(["ok"])] {
        return Err(error("local_authority_source_schema_integrity_invalid"));
    }
    if held_main_state(db)? != before || db.total_changes() != changes {
        return Err(error("local_authority_source_schema_transaction_changed"));
    }
    let schema_hash = hash(DOMAIN, &actual)?;
    Ok(SourceProfile {
        schema: actual,
        schema_hash,
    })
}

fn held_main_state(db: &Connection) -> Result<TransactionState> {
    let state = db.transaction_state(Some("main"))?;
    if db.is_autocommit() || !matches!(state, TransactionState::Read | TransactionState::Write) {
        return Err(error(
            "local_authority_source_schema_held_transaction_required",
        ));
    }
    Ok(state)
}

fn observe_structure(db: &Connection, expected_catalog: Option<&Value>) -> Result<Value> {
    let catalog = rows(
        db,
        "SELECT type,name,tbl_name,rootpage,sql FROM main.sqlite_schema ORDER BY type COLLATE BINARY,name COLLATE BINARY",
        [],
    )?;
    let page_count = integer(db, "PRAGMA main.page_count")?;
    let mut roots = BTreeSet::new();
    let mut schema = Vec::with_capacity(catalog.len());
    for row in &catalog {
        let root = row[3].as_i64().filter(|n| *n > 0 && *n <= page_count);
        if !matches!(row[0].as_str(), Some("table" | "index"))
            || root.is_none_or(|root| !roots.insert(root))
        {
            return Err(error("local_authority_source_schema_catalog_invalid"));
        }
        // Physical page allocations may differ without changing the schema.
        // Every root is still validated above; none is silently ignored.
        schema.push(json!([row[0], row[1], row[2], row[4]]));
    }
    let schema = Value::Array(schema);
    if expected_catalog.is_some_and(|expected| expected != &schema) {
        return Err(error("local_authority_source_schema_mismatch"));
    }
    // Only after the entire catalog matches do we inspect the fixed six tables
    // and their six known autoindexes. Together with rows() limits this closes
    // the query count and total observation size, including malformed sources.
    let mut tables = Vec::new();
    for name in TABLES {
        let columns = rows(
            db,
            "SELECT cid,name,type,\"notnull\",dflt_value,pk,hidden FROM pragma_table_xinfo(?1,'main') ORDER BY cid",
            [name],
        )?;
        let indices = rows(
            db,
            "SELECT seq,name,\"unique\",origin,partial FROM pragma_index_list(?1,'main') ORDER BY seq",
            [name],
        )?;
        let mut index_columns = Vec::new();
        for index in &indices {
            let index_name = index[1]
                .as_str()
                .ok_or_else(|| error("local_authority_source_schema_index_invalid"))?;
            let columns = rows(
                db,
                "SELECT seqno,cid,name,\"desc\",coll,\"key\" FROM pragma_index_xinfo(?1,'main') ORDER BY seqno",
                [index_name],
            )?;
            index_columns.push(json!({"name":index_name,"columns":columns}));
        }
        tables.push(
            json!({"name":name,"columns":columns,"indices":indices,"indexColumns":index_columns}),
        );
    }
    Ok(
        json!({"version":1,"kind":DOMAIN,"userVersion":integer(db,"PRAGMA main.user_version")?,"catalog":schema,"tables":tables}),
    )
}

fn integer(db: &Connection, sql: &str) -> Result<i64> {
    let result = rows(db, sql, [])?;
    if result.len() != 1 || result[0].as_array().is_none_or(|row| row.len() != 1) {
        return Err(error("local_authority_source_schema_scalar_invalid"));
    }
    result[0][0]
        .as_i64()
        .ok_or_else(|| error("local_authority_source_schema_scalar_invalid"))
}

fn rows(db: &Connection, sql: &str, parameters: impl Params) -> Result<Vec<Value>> {
    let mut statement = db.prepare(sql)?;
    if !statement.readonly() {
        return Err(error("local_authority_source_schema_readonly_required"));
    }
    let count = statement.column_count();
    if count > MAX_COLUMNS {
        return Err(error("local_authority_source_schema_limit_exceeded"));
    }
    let mut cursor = statement.query(parameters)?;
    let mut result = Vec::new();
    let mut remaining = MAX_QUERY_BYTES;
    while let Some(row) = cursor.next()? {
        if result.len() == MAX_ROWS {
            return Err(error("local_authority_source_schema_limit_exceeded"));
        }
        let mut values = Vec::with_capacity(count);
        for column in 0..count {
            let value = row.get_ref(column)?;
            let size = match value {
                ValueRef::Null => 1,
                ValueRef::Integer(_) => 8,
                ValueRef::Text(value) => value.len(),
                _ => return Err(error("local_authority_source_schema_value_invalid")),
            };
            if size > MAX_CELL_BYTES || size > remaining {
                return Err(error("local_authority_source_schema_limit_exceeded"));
            }
            remaining -= size;
            values.push(match value {
                ValueRef::Null => Value::Null,
                ValueRef::Integer(value) => json!(value),
                ValueRef::Text(value) => json!(
                    std::str::from_utf8(value)
                        .map_err(|_| { error("local_authority_source_schema_text_invalid") })?
                ),
                _ => unreachable!("non-profile SQLite value was rejected before allocation"),
            });
        }
        result.push(Value::Array(values));
    }
    Ok(result)
}

#[cfg(test)]
#[path = "source_profile/tests.rs"]
mod tests;
