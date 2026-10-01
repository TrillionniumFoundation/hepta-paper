//! Existing submission-handoff read-only safety and schema boundary.
use super::{StoreStatusError, sql};
use rusqlite::Connection;
use serde_json::{Value, json};
use std::{fs, os::unix::fs::MetadataExt, path::Path};

fn refusal(code: &str) -> StoreStatusError {
    StoreStatusError::Projection(code.into())
}
fn identity(path: &Path) -> Result<(u64, u64, u32, u64, u64), StoreStatusError> {
    let m = fs::symlink_metadata(path)
        .map_err(|_| refusal("autonomous_submission_handoff_database_file_unsafe"))?;
    Ok((m.dev(), m.ino(), m.mode(), m.nlink(), m.size()))
}
fn safe_file(
    runtime: &Path,
    database: &Path,
) -> Result<(u64, u64, u32, u64, u64), StoreStatusError> {
    let root = fs::symlink_metadata(runtime)
        .map_err(|_| refusal("autonomous_submission_handoff_runtime_root_unsafe"))?;
    if !root.is_dir()
        || root.file_type().is_symlink()
        || root.mode() & 0o002 != 0
        || fs::canonicalize(runtime).ok().as_deref() != Some(runtime)
    {
        return Err(refusal("autonomous_submission_handoff_runtime_root_unsafe"));
    }
    let mut directory = runtime.to_path_buf();
    for name in ["autonomous-research", "submission-handoff"] {
        directory.push(name);
        if !directory.exists() {
            return Err(refusal("autonomous_submission_handoff_directory_missing"));
        }
        let m = fs::symlink_metadata(&directory)
            .map_err(|_| refusal("autonomous_submission_handoff_directory_unsafe"))?;
        if !m.is_dir()
            || m.file_type().is_symlink()
            || m.mode() & 0o002 != 0
            || fs::canonicalize(&directory)
                .ok()
                .is_none_or(|p| !p.starts_with(runtime))
        {
            return Err(refusal("autonomous_submission_handoff_directory_unsafe"));
        }
    }
    let m = fs::symlink_metadata(database)
        .map_err(|_| refusal("autonomous_submission_handoff_database_file_unsafe"))?;
    if !m.is_file()
        || m.file_type().is_symlink()
        || m.nlink() != 1
        || m.mode() & 0o007 != 0
        || fs::canonicalize(database)
            .ok()
            .is_none_or(|p| !p.starts_with(runtime))
    {
        return Err(refusal(
            "autonomous_submission_handoff_database_file_unsafe",
        ));
    }
    identity(database)
}
fn canonical_sql(value: &str) -> String {
    regex::Regex::new(r"(?i)\bIF\s+NOT\s+EXISTS\b")
        .map(|r| {
            r.replace_all(value, "")
                .replace(';', "")
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ")
                .to_lowercase()
        })
        .unwrap_or_default()
}
fn finite_date(value: &Value) -> bool {
    let text = match value {
        Value::String(value) => value.clone(),
        Value::Number(value) if value.as_f64() != Some(0.0) => value
            .as_f64()
            .map(|number| ryu_js::Buffer::new().format(number).to_owned())
            .unwrap_or_default(),
        Value::Object(value) => {
            let mut bytes = Vec::new();
            for i in 0..value.len() {
                let Some(byte) = value.get(&i.to_string()).and_then(Value::as_u64) else {
                    return false;
                };
                bytes.push(byte.to_string());
            }
            bytes.join(",")
        }
        _ => String::new(),
    };
    super::date::finite(&text)
}
fn raw_number(value: &Value) -> f64 {
    if let Value::Object(bytes) = value {
        let text = (0..bytes.len())
            .map(|index| {
                bytes
                    .get(&index.to_string())
                    .map(Value::to_string)
                    .unwrap_or_default()
            })
            .collect::<Vec<_>>()
            .join(",");
        return crate::automation_runtime_reconciliation::sqlite_number::string_number(&text)
            .unwrap_or(f64::NAN);
    }
    sql::number_or_zero(value)
}
fn schema(connection: &Connection) -> Result<(), StoreStatusError> {
    // Reuse the existing fixed production schema facts; status introduces no
    // independent migration definitions or writable schema upgrader.
    let data: Value =
        serde_json::from_str(include_str!("../online_schema_transition/schema_data.json"))
            .map_err(|_| refusal("autonomous_submission_handoff_schema_mismatch"))?;
    let expected = data["handoff"]
        .as_array()
        .filter(|v| v.len() == 2)
        .ok_or_else(|| refusal("autonomous_submission_handoff_schema_mismatch"))?;
    let rows = sql::query(
        connection,
        "SELECT version,name,migration_sha256,applied_at FROM handoff_schema_migrations ORDER BY version;",
    )?;
    if rows.len() != 2
        || rows.iter().zip(expected).any(|(r, m)| {
            Some(raw_number(&r["version"])) != m["version"].as_f64()
                || r["name"] != m["name"]
                || r["migration_sha256"] != m["migrationHash"]
                || !finite_date(&r["applied_at"])
        })
    {
        return Err(refusal("autonomous_submission_handoff_schema_mismatch"));
    }
    let objects = sql::query(
        connection,
        "SELECT type,name,sql FROM sqlite_schema WHERE type='table' AND name='submission_authorization_consumptions';",
    )?;
    if objects.len() != 1
        || canonical_sql(objects[0]["sql"].as_str().unwrap_or_default())
            != canonical_sql(expected[1]["sql"].as_str().unwrap_or_default())
    {
        return Err(refusal("autonomous_submission_handoff_schema_mismatch"));
    }
    let instances = sql::query(
        connection,
        "SELECT instance_nonce,provisioned_at FROM handoff_instance WHERE singleton=1;",
    )?;
    let uuid = regex::Regex::new(
        r"(?i)^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    )
    .map_err(|_| refusal("autonomous_submission_handoff_instance_identity_invalid"))?;
    if instances.len() != 1
        || !instances[0]["instance_nonce"]
            .as_str()
            .is_some_and(|v| uuid.is_match(v))
        || !finite_date(&instances[0]["provisioned_at"])
    {
        return Err(refusal(
            "autonomous_submission_handoff_instance_identity_invalid",
        ));
    }
    Ok(())
}
fn or_null(value: Value) -> Value {
    if value.is_null() || value.as_str().is_some_and(str::is_empty) || value.as_f64() == Some(0.0) {
        Value::Null
    } else {
        value
    }
}

pub(super) fn inspect(native: &Connection, runtime: &Path) -> Value {
    let path = runtime.join("autonomous-research/submission-handoff/submission-handoff.sqlite");
    if !path.exists() {
        return json!({"ready":false,"databasePath":path,"blockers":["autonomous_submission_handoff_database_missing"]});
    }
    let result = (|| -> Result<Value, StoreStatusError> {
        let file = safe_file(runtime, &path)?;
        let directory = path.parent().ok_or(StoreStatusError::Path)?;
        let tree = identity(directory)?;
        let connection = sql::inspect(&path)?;
        schema(&connection)?;
        if tree != identity(directory)? {
            return Err(refusal("autonomous_submission_handoff_directory_replaced"));
        }
        if file != identity(&path)? {
            return Err(refusal("autonomous_submission_handoff_database_replaced"));
        }
        let native = sql::query(
            native,
            "SELECT * FROM autonomous_submission_handoff_cutover WHERE singleton=1 LIMIT 1;",
        )?
        .into_iter()
        .next()
        .unwrap_or(Value::Null);
        let handoff = sql::query(
            &connection,
            "SELECT * FROM handoff_cutover WHERE singleton=1 LIMIT 1;",
        )?
        .into_iter()
        .next()
        .unwrap_or(Value::Null);
        let quick = sql::quick_check(&connection)?;
        let id = "autonomous-submission-handoff-cutover-v1";
        let ready = native["cutover_id"] == id
            && handoff["cutover_id"] == id
            && !native["handoff_database_identity_hash"].is_object()
            && !native["handoff_database_identity_hash"].is_array()
            && native["handoff_database_identity_hash"] == handoff["native_cutover_identity_hash"]
            && handoff["status"] == "active"
            && quick == "ok";
        Ok(
            json!({"ready":ready,"databasePath":path,"quickCheck":quick,"cutoverId":or_null(handoff["cutover_id"].clone()),"databaseIdentityHash":or_null(handoff["native_cutover_identity_hash"].clone()),"blockers":if ready {Vec::<String>::new()} else {vec!["autonomous_submission_handoff_cutover_not_active".into()]} }),
        )
    })();
    result.unwrap_or_else(|e| json!({"ready":false,"databasePath":path,"blockers":[e.to_string()]}))
}
