use crate::sqlite_mutation_coordinator::{Result, error, hash};
use rusqlite::{
    Connection,
    types::{Value as SqlValue, ValueRef},
};
use serde_json::{Value, json};
pub(super) fn fail(
    code: &str,
) -> crate::sqlite_mutation_coordinator::SqliteMutationCoordinatorError {
    error(format!("autonomous_research_pristine_state_{code}"))
}
pub(super) fn string(v: &Value) -> Result<&str> {
    v.as_str().ok_or_else(|| fail("value_invalid"))
}
// Node Number() behavior needed for persisted SQLite numeric fields only.
pub(super) fn number(v: &Value) -> Option<f64> {
    match v {
        Value::Null => Some(0.),
        Value::Bool(v) => Some(if *v { 1. } else { 0. }),
        Value::String(v) => {
            if v.trim().is_empty() {
                Some(0.)
            } else {
                v.trim().parse().ok()
            }
        }
        _ => v.as_f64(),
    }
}
pub(super) fn field_number(value: &Value, key: &str) -> Option<f64> {
    value.get(key).and_then(number)
}
pub(super) fn null_field(value: &Value, key: &str) -> bool {
    value.get(key).is_some_and(Value::is_null)
}
pub(super) fn canonical_timestamp(v: &Value) -> Option<i64> {
    crate::sqlite_mutation_coordinator::timestamp(v)
}
// The native store emits SQLite UTC datetime strings. Accept that actual source
// format and ISO/RFC3339 offsets; do not approximate locale-dependent Date.parse.
pub(super) fn timestamp(v: &Value) -> Option<i64> {
    if let Some(value) = canonical_timestamp(v) {
        return Some(value);
    }
    let value = v.as_str()?;
    if !value.is_ascii() || value.len() < 19 {
        return None;
    }
    let bytes = value.as_bytes();
    if !matches!(bytes[10], b'T' | b' ') {
        return None;
    }
    let mut base = value[..19].to_owned();
    base.replace_range(10..11, "T");
    let mut suffix = &value[19..];
    let mut fraction = String::new();
    if let Some(rest) = suffix.strip_prefix('.') {
        let length = rest.bytes().take_while(u8::is_ascii_digit).count();
        if length == 0 {
            return None;
        }
        fraction = rest[..length.min(3)].to_owned();
        suffix = &rest[length..];
    }
    while fraction.len() < 3 {
        fraction.push('0');
    }
    let utc = canonical_timestamp(&json!(format!("{base}.{fraction}Z")))?;
    if suffix.is_empty() || suffix == "Z" {
        return Some(utc);
    }
    let zone = suffix.as_bytes();
    if zone.len() != 6 || !matches!(zone[0], b'+' | b'-') || zone[3] != b':' {
        return None;
    }
    let hour = suffix[1..3].parse::<i64>().ok()?;
    let minute = suffix[4..6].parse::<i64>().ok()?;
    if hour > 23 || minute > 59 {
        return None;
    }
    let offset = (hour * 60 + minute) * 60_000 * if zone[0] == b'+' { 1 } else { -1 };
    utc.checked_sub(offset)
}
pub(super) fn identifier(s: &str) -> String {
    format!("\"{}\"", s.replace('"', "\"\""))
}
pub(super) fn rows(
    db: &Connection,
    sql: &str,
    parameters: &[SqlValue],
    limit: usize,
    max_bytes: usize,
) -> Result<Vec<Value>> {
    let mut stmt = db.prepare(sql)?;
    let names = stmt
        .column_names()
        .iter()
        .map(|v| (*v).to_owned())
        .collect::<Vec<_>>();
    if names.len() > 2048 {
        return Err(fail("row_limit_exceeded"));
    }
    let mut cursor = stmt.query(rusqlite::params_from_iter(parameters.iter()))?;
    let mut values = Vec::new();
    let mut total = 0usize;
    while let Some(row) = cursor.next()? {
        if values.len() >= limit {
            return Err(fail("baseline_row_limit_exceeded"));
        }
        let mut value = serde_json::Map::new();
        for (i, name) in names.iter().enumerate() {
            let v = match row.get_ref(i)? {
                ValueRef::Null => Value::Null,
                ValueRef::Integer(v) => json!(v),
                ValueRef::Real(v) => json!(v),
                ValueRef::Text(v) => {
                    total = total
                        .checked_add(v.len())
                        .ok_or_else(|| fail("canonical_row_limit_exceeded"))?;
                    if total > max_bytes {
                        return Err(fail("canonical_row_limit_exceeded"));
                    }
                    json!(std::str::from_utf8(v).map_err(|_| fail("invalid_utf8"))?)
                }
                ValueRef::Blob(_) => return Err(fail("unexpected_blob")),
            };
            value.insert(name.clone(), v);
        }
        values.push(Value::Object(value));
    }
    Ok(values)
}
pub(super) fn one(db: &Connection, sql: &str) -> Result<Value> {
    Ok(rows(db, sql, &[], 10000, 4 * 1024 * 1024)?
        .into_iter()
        .next()
        .unwrap_or(Value::Null))
}
pub(super) fn canonical_rows(
    db: &Connection,
    table: &str,
    count: i64,
) -> Result<(Vec<String>, String)> {
    if count > 10000 {
        return Err(fail("baseline_row_limit_exceeded"));
    }
    let columns = rows(
        db,
        "SELECT name FROM pragma_table_xinfo(?) WHERE hidden=0 ORDER BY cid",
        &[SqlValue::Text(table.into())],
        2048,
        1024 * 1024,
    )?
    .into_iter()
    .map(|v| string(&v["name"]).map(str::to_owned))
    .collect::<Result<Vec<_>>>()?;
    if columns.is_empty() {
        return Err(fail("table_columns_missing"));
    }
    let projection = columns
        .iter()
        .enumerate()
        .map(|(i, c)| format!("quote({}) AS c{i}", identifier(c)))
        .collect::<Vec<_>>()
        .join(",");
    let values = rows(
        db,
        &format!("SELECT {projection} FROM {}", identifier(table)),
        &[],
        10000,
        4 * 1024 * 1024,
    )?;
    let mut values = values
        .iter()
        .map(|v| {
            let a = columns
                .iter()
                .enumerate()
                .map(|(i, _)| v[format!("c{i}")].clone())
                .collect::<Vec<_>>();
            serde_json::to_string(&a)
                .map(|s| (s, a))
                .map_err(|e| error(e.to_string()))
        })
        .collect::<Result<Vec<_>>>()?;
    let collator = hepta_legacy_compatibility::ProductionCollationV1::load()
        .map_err(|e| error(e.to_string()))?;
    values.sort_by(|a, b| collator.compare(&a.0, &b.0));
    let values = values.into_iter().map(|v| v.1).collect::<Vec<_>>();
    let bytes = serde_json::to_vec(&values).map_err(|e| error(e.to_string()))?;
    if bytes.len() > 4 * 1024 * 1024 {
        return Err(fail("canonical_row_limit_exceeded"));
    }
    let digest = hash(
        "AutonomousResearchPristineDatabaseTableRows",
        &json!({"tableName":table,"columns":columns,"rows":values}),
    )?;
    Ok((columns, digest))
}
