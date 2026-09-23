use super::*;
use rusqlite::types::ValueRef;
const MAX_CELL: usize = 32 * 1024 * 1024;
const MAX_ROWS_BYTES: usize = 256 * 1024 * 1024;
pub(super) fn rows(db: &Connection, sql: &str, maximum: usize) -> Result<Vec<Value>> {
    let mut statement = db.prepare(sql)?;
    let names = statement
        .column_names()
        .iter()
        .map(|n| (*n).to_owned())
        .collect::<Vec<_>>();
    let mut cursor = statement.query([])?;
    let mut out = Vec::new();
    let mut bytes = 0usize;
    while let Some(row) = cursor.next()? {
        checked(out.len() < maximum, "database_resource_limit")?;
        let mut result = serde_json::Map::new();
        for (index, name) in names.iter().enumerate() {
            let value = match row.get_ref(index)? {
                ValueRef::Null => Value::Null,
                ValueRef::Integer(v) => json!(v),
                ValueRef::Real(v) => {
                    checked(v.is_finite(), "database_value_invalid")?;
                    json!(v)
                }
                ValueRef::Text(v) => {
                    bytes = bytes
                        .checked_add(v.len())
                        .ok_or_else(|| error(code("database_resource_limit")))?;
                    checked(
                        v.len() <= MAX_CELL && bytes <= MAX_ROWS_BYTES,
                        "database_resource_limit",
                    )?;
                    json!(
                        std::str::from_utf8(v)
                            .map_err(|_| error(code("database_value_invalid")))?
                    )
                }
                ValueRef::Blob(_) => return Err(error(code("database_value_invalid"))),
            };
            result.insert(name.clone(), value);
        }
        out.push(Value::Object(result));
    }
    Ok(out)
}
pub(super) fn parse(value: &Value, suffix: &str) -> Result<Value> {
    let bytes = value
        .as_str()
        .filter(|s| s.len() <= MAX_CELL)
        .ok_or_else(|| error(code(suffix)))?;
    let result = crate::sqlite_mutation_coordinator::authority::files::parse(
        bytes.as_bytes(),
        &code(suffix),
    )?;
    checked(result.is_object(), suffix)?;
    Ok(result)
}
pub(super) fn surface(db: &Connection) -> Result<()> {
    let databases = rows(db, "PRAGMA database_list;", 3)?;
    let temp: i64 = db.query_row("SELECT count(*) FROM temp.sqlite_schema;", [], |r| r.get(0))?;
    checked(
        databases.len() == 1 && databases[0]["name"] == "main" && temp == 0,
        "database_surface_invalid",
    )?;
    let checks = rows(db, "PRAGMA quick_check;", 2)?;
    let foreign = rows(db, "PRAGMA foreign_key_check;", 1)?;
    checked(
        checks.len() == 1
            && (checks[0]["quick_check"] == "ok" || checks[0]["integrity_check"] == "ok")
            && foreign.is_empty(),
        "database_integrity_invalid",
    )?;
    // The legacy hash excludes names with LIKE 'sqlite_%' (where '_' is a
    // wildcard). Reject user objects hidden by that projection instead of
    // treating a legacy digest as proof of their absence.
    let hidden:i64=db.query_row("SELECT count(*) FROM sqlite_schema WHERE name LIKE 'sqlite_%' AND name NOT GLOB 'sqlite_*';",[],|r|r.get(0))?;
    checked(hidden == 0, "database_surface_invalid")
}
