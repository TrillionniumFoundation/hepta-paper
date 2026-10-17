//! The incumbent SQLite JSON projection, including nulls and Uint8Array blobs.
use super::{StoreStatusError, open_read_only};
use rusqlite::{Connection, types::ValueRef};
use serde_json::{Map, Value, json};
use std::path::Path;

pub(super) fn query(connection: &Connection, sql: &str) -> Result<Vec<Value>, StoreStatusError> {
    let mut statement = connection.prepare(sql)?;
    let names = statement
        .column_names()
        .iter()
        .map(|v| (*v).to_owned())
        .collect::<Vec<_>>();
    let mut cursor = statement.query([])?;
    let mut values = Vec::new();
    while let Some(row) = cursor.next()? {
        let mut value = Map::new();
        for (index, name) in names.iter().enumerate() {
            let item = match row.get_ref(index)? {
                ValueRef::Null => Value::Null,
                ValueRef::Integer(value) => {
                    if !(-9_007_199_254_740_991..=9_007_199_254_740_991).contains(&value) {
                        return Err(StoreStatusError::Projection(format!(
                            "Value is too large to be represented as a JavaScript number: {value}"
                        )));
                    }
                    json!(value)
                }
                ValueRef::Real(value) => json!(value),
                ValueRef::Text(value) => json!(String::from_utf8_lossy(value)),
                ValueRef::Blob(value) => Value::Object(
                    value
                        .iter()
                        .enumerate()
                        .map(|(i, v)| (i.to_string(), json!(v)))
                        .collect(),
                ),
            };
            value.insert(name.clone(), item);
        }
        values.push(Value::Object(value));
    }
    Ok(values)
}

pub(super) fn inspect(path: &Path) -> Result<Connection, StoreStatusError> {
    open_read_only(path)
}

pub(super) fn quick_check(connection: &Connection) -> Result<String, StoreStatusError> {
    let rows = query(connection, "PRAGMA quick_check;")?;
    Ok(rows
        .first()
        .and_then(|r| r["quick_check"].as_str())
        .filter(|v| !v.is_empty())
        .unwrap_or("unknown")
        .to_owned())
}

/// Number(value || 0) after the incumbent runSql JSON round trip.
/// In particular, Blob JSON is a plain object, not a typed-array coercion.
pub(super) fn number_or_zero(value: &Value) -> f64 {
    match value {
        Value::Null => 0.0,
        Value::Number(value) => value.as_f64().unwrap_or(f64::NAN),
        Value::String(value) => {
            crate::automation_runtime_reconciliation::sqlite_number::string_number(value)
                .unwrap_or(f64::NAN)
        }
        _ => f64::NAN,
    }
}
