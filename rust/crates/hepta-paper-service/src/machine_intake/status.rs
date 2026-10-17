//! Read-only generation-one intake status from an inode-checked private snapshot.
//! Config/authority JSON files are closed before this SQLite consumer starts.

use super::contract;
use rusqlite::{Connection, OpenFlags, OptionalExtension, Row, types::ValueRef};
use serde_json::{Value, json};
use std::{collections::BTreeSet, path::Path};

const BASE: &str = "autonomous_research_machine_intake";
const INVALID: &str = "autonomous_research_machine_intake_state_invalid";
const AUTHORITY_INVALID: &str = "autonomous_research_machine_intake_authority_state_invalid";
const RELATIVE: &str = "autonomous-research/machine-intake/machine-intake.sqlite";
const MAX_FIELD: usize = 1024 * 1024;
const MAX_RESULT_BYTES: usize = 16 * 1024 * 1024;

fn empty() -> Value {
    json!({"configuredSourceAuthorityHash":null,"configuredMachineProducerProfileHash":null,
        "configuredAuthorityGeneration":null,"pendingCount":0,"pendingProductionCount":0,
        "enqueuedCount":0,"invalidCount":0,"supersededCount":0,"pending":[]})
}

fn sql_error(_: rusqlite::Error) -> String {
    INVALID.to_owned()
}
fn table_sql(connection: &Connection, name: &str) -> Result<Option<String>, String> {
    connection.query_row("SELECT CASE WHEN length(sql)<=65536 THEN sql END FROM sqlite_schema WHERE type='table' AND name=?1", [name], |row| row.get(0)).optional().map_err(sql_error)
}
fn columns(connection: &Connection, name: &str) -> Result<BTreeSet<String>, String> {
    let mut statement = connection
        .prepare(&format!("PRAGMA table_info({name})"))
        .map_err(sql_error)?;
    let mut rows = statement.query([]).map_err(sql_error)?;
    let mut columns = BTreeSet::new();
    while let Some(row) = rows.next().map_err(sql_error)? {
        if columns.len() >= 64 {
            return Err(INVALID.into());
        }
        let column: String = row.get(1).map_err(sql_error)?;
        if column.len() > 128 {
            return Err(INVALID.into());
        }
        columns.insert(column);
    }
    Ok(columns)
}
fn ordinary_table(connection: &Connection, name: &str) -> Result<bool, String> {
    let Some(sql) = table_sql(connection, name)? else {
        return Ok(false);
    };
    // Refuse virtual tables/views: a read must not invoke a foreign module.
    if !sql
        .trim_start()
        .to_ascii_uppercase()
        .starts_with("CREATE TABLE ")
    {
        return Err(INVALID.into());
    }
    Ok(true)
}
fn optional_text(row: &Row<'_>, name: &str) -> Result<Value, String> {
    match row.get_ref(name).map_err(sql_error)? {
        ValueRef::Null => Ok(Value::Null),
        ValueRef::Text(bytes) if bytes.len() <= MAX_FIELD => std::str::from_utf8(bytes)
            .map(|text| Value::String(text.to_owned()))
            .map_err(|_| INVALID.into()),
        _ => Err(INVALID.into()),
    }
}
fn text(row: &Row<'_>, name: &str) -> Result<Value, String> {
    let value = optional_text(row, name)?;
    if !value.is_string() {
        return Err(INVALID.into());
    }
    Ok(value)
}
fn number(row: &Row<'_>, name: &str) -> Result<i64, String> {
    let value: i64 = row.get(name).map_err(sql_error)?;
    if value.unsigned_abs() > 9_007_199_254_740_991 {
        return Err(INVALID.into());
    }
    Ok(value)
}
fn truthy_text(value: Value) -> Value {
    if value.as_str() == Some("") {
        Value::Null
    } else {
        value
    }
}

fn authority(connection: &Connection) -> Result<String, String> {
    let name = format!("{BASE}_metadata");
    if !ordinary_table(connection, &name)? {
        return Err(AUTHORITY_INVALID.into());
    }
    let cols = columns(connection, &name)?;
    let selected = |column: &str, fallback: &str| {
        if cols.contains(column) {
            column.to_owned()
        } else {
            format!("{fallback} AS {column}")
        }
    };
    let query = format!(
        "SELECT configured_source_authority_hash, {}, {}, {} FROM {name} WHERE singleton=1",
        selected("authorized_machine_producer_profile_hash", "NULL"),
        selected("authority_generation", "1"),
        selected("last_authority_rotation_receipt_hash", "NULL")
    );
    let mut statement = connection.prepare(&query).map_err(sql_error)?;
    let mut rows = statement.query([]).map_err(sql_error)?;
    let row = rows.next().map_err(sql_error)?.ok_or(AUTHORITY_INVALID)?;
    let source = truthy_text(optional_text(row, "configured_source_authority_hash")?);
    let producer = truthy_text(optional_text(
        row,
        "authorized_machine_producer_profile_hash",
    )?);
    let last = optional_text(row, "last_authority_rotation_receipt_hash")?;
    let generation = number(row, "authority_generation")?;
    if !contract::hash_valid(&source)
        || (!producer.is_null() && !contract::hash_valid(&producer))
        || generation < 1
        || (!last.is_null() && !contract::hash_valid(&last))
    {
        return Err(AUTHORITY_INVALID.into());
    }
    if generation != 1 || !producer.is_null() {
        return Err("autonomous_research_machine_intake_authority_v2_unsupported".into());
    }
    if !last.is_null() || rows.next().map_err(sql_error)?.is_some() {
        return Err(AUTHORITY_INVALID.into());
    }
    for suffix in ["authority_rotation", "authority_genesis"] {
        let name = format!("{BASE}_{suffix}");
        if ordinary_table(connection, &name)? {
            let exists: bool = connection
                .query_row(
                    &format!("SELECT EXISTS(SELECT 1 FROM {name} LIMIT 1)"),
                    [],
                    |row| row.get(0),
                )
                .map_err(sql_error)?;
            if exists {
                return Err(AUTHORITY_INVALID.into());
            }
        }
    }
    source
        .as_str()
        .map(str::to_owned)
        .ok_or_else(|| AUTHORITY_INVALID.into())
}

fn record(row: &Row<'_>, budget: &mut usize) -> Result<Value, String> {
    let intake_json = text(row, "intake_json")?;
    let admission_json = text(row, "admission_json")?;
    let intake: Value =
        serde_json::from_str(intake_json.as_str().ok_or(INVALID)?).map_err(|_| INVALID)?;
    let admission: Value =
        serde_json::from_str(admission_json.as_str().ok_or(INVALID)?).map_err(|_| INVALID)?;
    if contract::has_unsupported_local_golden_scope(&intake) {
        return Err("autonomous_research_machine_intake_local_golden_scope_unsupported".into());
    }
    if admission["version"].as_f64() == Some(2.0) {
        return Err("autonomous_research_machine_intake_admission_v2_unsupported".into());
    }
    let source_kind = text(row, "source_kind")?;
    let source_ref = text(row, "source_ref")?;
    let source_hash = text(row, "source_authority_hash")?;
    let disposition = text(row, "disposition")?;
    let failure_count = number(row, "failure_count")?;
    let next_attempt = text(row, "next_attempt_at")?;
    if !contract::verify_intake(&intake)
        || !contract::verify_admission_v1(&admission, &intake)
        || admission["autonomousResearchMachineIntakeAdmissionHash"] != text(row, "admission_hash")?
        || admission["sourceKind"] != source_kind
        || admission["sourceAuthorityHash"] != source_hash
        || intake["intakeId"] != text(row, "intake_id")?
        || intake["intakeHash"] != text(row, "intake_hash")?
        || intake["paperId"] != text(row, "paper_id")?
        || intake["campaignId"] != text(row, "campaign_id")?
        || !matches!(
            source_kind.as_str(),
            Some("machine" | "recurring-golden" | "static-file")
        )
        || !matches!(
            disposition.as_str(),
            Some("invalid" | "pending" | "enqueued" | "superseded")
        )
        || !contract::hash_valid(&source_hash)
        || failure_count < 0
        || !super::retry_time::supported_retry_time(&next_attempt)
    {
        return Err(INVALID.into());
    }
    if source_kind == "recurring-golden" {
        let provenance = &intake["recurringGoldenProvenance"];
        let expected = format!(
            "{}@{}",
            provenance["templateId"].as_str().ok_or(INVALID)?,
            provenance["epochStart"].as_str().ok_or(INVALID)?
        );
        if intake["launchMode"] != "golden-bootstrap"
            || provenance["sourceAuthorityHash"] != source_hash
            || source_ref != expected
        {
            return Err(INVALID.into());
        }
    } else if intake["launchMode"] != "production-run"
        || !intake["recurringGoldenProvenance"].is_null()
    {
        return Err(INVALID.into());
    }
    // Hash verification above uses JavaScript number semantics. Emit the same
    // normalized numeric values (including 1.0 -> 1) in the diagnostic projection.
    let project = |value: &Value| -> Result<Value, String> {
        let bytes =
            hepta_legacy_compatibility::production_stable_json_v1(value).map_err(|_| INVALID)?;
        serde_json::from_slice(&bytes).map_err(|_| INVALID.into())
    };
    let intake = project(&intake)?;
    let admission = project(&admission)?;
    let lease_owner = truthy_text(optional_text(row, "lease_owner")?);
    let lease = if lease_owner.is_null() {
        Value::Null
    } else {
        json!({"ownerId":lease_owner,"leaseToken":optional_text(row,"lease_token")?,"leaseGeneration":number(row,"active_lease_generation")?,"expiresAt":optional_text(row,"lease_expires_at")?})
    };
    let mut result = json!({"admissionHash":admission["autonomousResearchMachineIntakeAdmissionHash"],"intakeId":intake["intakeId"],"intakeHash":intake["intakeHash"],"paperId":intake["paperId"],"campaignId":intake["campaignId"],"intake":intake,"admission":admission,"disposition":disposition,"sourceKind":source_kind,"sourceRef":source_ref,"sourceAuthorityHash":source_hash,"leaseGeneration":number(row,"lease_generation")?,"lease":lease,"failureCount":failure_count,"nextAttemptAt":next_attempt,"createdAt":text(row,"created_at")?,"updatedAt":text(row,"updated_at")?});
    for (target, source) in [
        ("campaignPlanHash", "campaign_plan_hash"),
        ("preparationHash", "preparation_hash"),
        ("enqueuedAt", "enqueued_at"),
        ("lastError", "last_error"),
        ("invalidReason", "invalid_reason"),
    ] {
        result[target] = truthy_text(optional_text(row, source)?);
    }
    let bytes = serde_json::to_vec(&result).map_err(|_| INVALID)?.len();
    *budget = budget
        .checked_add(bytes)
        .filter(|size| *size <= MAX_RESULT_BYTES)
        .ok_or("autonomous_research_machine_intake_status_size_limit")?;
    Ok(result)
}

fn inspect_snapshot(path: &Path, now: &str) -> Result<Value, String> {
    let connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY
            | OpenFlags::SQLITE_OPEN_NOFOLLOW
            | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(sql_error)?;
    connection
        .execute_batch("PRAGMA trusted_schema=OFF; PRAGMA query_only=ON;")
        .map_err(sql_error)?;
    let sql = table_sql(&connection, BASE)?;
    if let Some(sql) = sql {
        let cols = columns(&connection, BASE)?;
        if !["admission_json", "admission_hash", "invalid_reason"]
            .iter()
            .all(|name| cols.contains(*name))
            || !sql.contains("'superseded'")
            || !sql.contains("'invalid'")
        {
            return Err("autonomous_research_machine_intake_schema_migration_required".into());
        }
    }
    let source = authority(&connection)?;
    if !ordinary_table(&connection, BASE)?
        || !ordinary_table(&connection, &format!("{BASE}_lease"))?
    {
        return Err(INVALID.into());
    }
    let mut result = empty();
    result["configuredSourceAuthorityHash"] = json!(source);
    result["configuredAuthorityGeneration"] = json!(1);
    let mut statement = connection
        .prepare(&format!(
            "SELECT disposition,COUNT(*) FROM {BASE} GROUP BY disposition LIMIT 5"
        ))
        .map_err(sql_error)?;
    let mut rows = statement.query([]).map_err(sql_error)?;
    while let Some(row) = rows.next().map_err(sql_error)? {
        let disposition: String = row.get(0).map_err(sql_error)?;
        let count: i64 = row.get(1).map_err(sql_error)?;
        if !(0..=9_007_199_254_740_991).contains(&count) {
            return Err(INVALID.into());
        }
        let field = match disposition.as_str() {
            "pending" => "pendingCount",
            "enqueued" => "enqueuedCount",
            "invalid" => "invalidCount",
            "superseded" => "supersededCount",
            _ => return Err(INVALID.into()),
        };
        result[field] = json!(count);
    }
    let production:i64=connection.query_row(&format!("SELECT COUNT(*) FROM {BASE} WHERE disposition='pending' AND source_kind IN ('machine','static-file')"),[],|row|row.get(0)).map_err(sql_error)?;
    result["pendingProductionCount"] = json!(production);
    let mut statement=connection.prepare(&format!("SELECT i.*,l.owner_id AS lease_owner,l.lease_token,l.lease_generation AS active_lease_generation,l.expires_at AS lease_expires_at FROM {BASE} i LEFT JOIN {BASE}_lease l ON l.intake_id=i.intake_id WHERE i.disposition='pending' AND i.next_attempt_at<=?1 ORDER BY CASE i.source_kind WHEN 'recurring-golden' THEN 0 ELSE 1 END, CASE WHEN i.source_kind='recurring-golden' THEN i.created_at END DESC,i.next_attempt_at,i.created_at,i.intake_id LIMIT 100")).map_err(sql_error)?;
    let mut rows = statement.query([now]).map_err(sql_error)?;
    let mut pending = Vec::new();
    let mut budget = 0;
    while let Some(row) = rows.next().map_err(sql_error)? {
        pending.push(record(row, &mut budget)?);
    }
    result["pending"] = Value::Array(pending);
    Ok(result)
}

pub(super) fn inspect(runtime_root: &Path, now_millis: i64) -> Result<Value, String> {
    let relative = Path::new(RELATIVE);
    match std::fs::symlink_metadata(runtime_root.join(relative)) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(empty()),
        Err(_) => return Err("autonomous_research_machine_intake_database_invalid".into()),
        Ok(_) => {}
    }
    let now = crate::sqlite_mutation_coordinator::clock::iso(now_millis)
        .map_err(|_| "autonomous_research_machine_intake_clock_invalid")?;
    crate::state_database_inventory::with_database_effective_snapshot_path_v1(
        runtime_root,
        relative,
        "machine-intake",
        |path| inspect_snapshot(path, &now),
    )
    .map_err(|error| error.code)
}
