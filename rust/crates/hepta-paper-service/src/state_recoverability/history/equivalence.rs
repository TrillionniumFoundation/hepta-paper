//! Fixed, read-only comparison of effective SQLite state in isolated copies.
//! This result is not authority. The enclosing refresh also verifies the signed
//! snapshot/range and exact live database heads before constructing an epoch.
use super::*;
use rusqlite::{Connection, types::ValueRef};
use sha2::{Digest, Sha256};

const MAX_TABLES: usize = 1024;
const MAX_COLUMNS: usize = 4096;
const MAX_ROWS: usize = 1_000_000;
const MAX_BYTES: usize = 1024 * 1024 * 1024;
const MAX_CELL: usize = 16 * 1024 * 1024;
const FINALIZATIONS: &str = "autonomous_research_online_mutation_finalization_receipt";
const MARKERS: &str = "autonomous_research_online_mutation_authority_marker";

fn invalid() -> crate::sqlite_mutation_coordinator::SqliteMutationCoordinatorError {
    error("autonomous_research_state_heartbeat_effective_state_mismatch")
}
fn quoted(identifier: &str) -> Result<String> {
    ensure(
        !identifier.is_empty() && identifier.len() <= 4096 && !identifier.contains('\0'),
        "autonomous_research_state_heartbeat_schema_unsupported",
    )?;
    Ok(format!("\"{}\"", identifier.replace('"', "\"\"")))
}
fn field(hash: &mut Sha256, tag: u8, bytes: &[u8]) {
    hash.update([tag]);
    hash.update((bytes.len() as u64).to_be_bytes());
    hash.update(bytes);
}
fn canonical_signed_json(table: &str, column: &str) -> bool {
    (table == MARKERS && matches!(column, "reserve_request_json" | "reservation_receipt_json"))
        || (table == FINALIZATIONS && column == "finalization_receipt_json")
}
fn table_digest(
    db: &Connection,
    table: &str,
    without_rowid: bool,
    total_rows: &mut usize,
    total_bytes: &mut usize,
) -> Result<[u8; 32]> {
    let mut columns = Vec::new();
    let mut column_query =
        db.prepare("SELECT name,hidden FROM pragma_table_xinfo(?1) ORDER BY cid")?;
    let mut column_rows = column_query.query([table])?;
    while let Some(row) = column_rows.next()? {
        ensure(
            columns.len() < MAX_COLUMNS,
            "autonomous_research_state_heartbeat_resource_limit",
        )?;
        let ValueRef::Text(raw_name) = row.get_ref(0)? else {
            return Err(invalid());
        };
        ensure(
            raw_name.len() <= 4096,
            "autonomous_research_state_heartbeat_schema_unsupported",
        )?;
        let name = std::str::from_utf8(raw_name)
            .map_err(|_| invalid())?
            .to_owned();
        let hidden: i64 = row.get(1)?;
        // Ordinary generated columns (2/3) are observed explicitly. Hidden
        // virtual-table columns are outside this bounded comparison.
        ensure(
            hidden != 1,
            "autonomous_research_state_heartbeat_schema_unsupported",
        )?;
        quoted(&name)?;
        columns.push(name);
    }
    ensure(
        !columns.is_empty(),
        "autonomous_research_state_heartbeat_schema_unsupported",
    )?;
    let mut projection = columns
        .iter()
        .map(|name| quoted(name))
        .collect::<Result<Vec<_>>>()?;
    let rowid = if without_rowid {
        None
    } else {
        Some(
            ["_rowid_", "rowid", "oid"]
                .into_iter()
                .find(|alias| {
                    columns
                        .iter()
                        .all(|column| !column.eq_ignore_ascii_case(alias))
                })
                .ok_or_else(invalid)?,
        )
    };
    if let Some(rowid) = rowid {
        projection.push(quoted(rowid)?);
    }
    let mut query = db.prepare(&format!(
        "SELECT {} FROM {}",
        projection.join(","),
        quoted(table)?
    ))?;
    let mut rows = query.query([])?;
    let mut hashes: Vec<[u8; 32]> = Vec::new();
    while let Some(row) = rows.next()? {
        *total_rows = total_rows.checked_add(1).ok_or_else(invalid)?;
        ensure(
            *total_rows <= MAX_ROWS,
            "autonomous_research_state_heartbeat_resource_limit",
        )?;
        let mut digest = Sha256::new();
        for index in 0..projection.len() {
            let value = row.get_ref(index)?;
            // recorded_at is local bookkeeping, whereas finalized_at is signed.
            // Native/Node replay can record the same receipt at different times.
            if table == FINALIZATIONS && columns.get(index).is_some_and(|c| c == "recorded_at") {
                let ValueRef::Text(raw) = value else {
                    return Err(invalid());
                };
                let time = std::str::from_utf8(raw).map_err(|_| invalid())?;
                ensure(
                    timestamp(&json!(time)).is_some(),
                    "autonomous_research_state_heartbeat_finalization_time_invalid",
                )?;
                field(
                    &mut digest,
                    3,
                    b"authenticated-receipt-local-recording-time",
                );
                continue;
            }
            match value {
                ValueRef::Null => field(&mut digest, 0, &[]),
                ValueRef::Integer(n) => field(&mut digest, 1, &n.to_be_bytes()),
                ValueRef::Real(n) => field(&mut digest, 2, &n.to_bits().to_be_bytes()),
                ValueRef::Text(raw) | ValueRef::Blob(raw) => {
                    *total_bytes = total_bytes.checked_add(raw.len()).ok_or_else(invalid)?;
                    ensure(
                        raw.len() <= MAX_CELL && *total_bytes <= MAX_BYTES,
                        "autonomous_research_state_heartbeat_resource_limit",
                    )?;
                    if matches!(value, ValueRef::Text(_)) {
                        std::str::from_utf8(raw).map_err(|_| invalid())?;
                        if columns
                            .get(index)
                            .is_some_and(|name| canonical_signed_json(table, name))
                        {
                            let parsed =
                                crate::sqlite_mutation_coordinator::authority::files::parse(
                                    raw,
                                    "autonomous_research_state_heartbeat_journal_json_invalid",
                                )?;
                            let canonical =
                                hepta_legacy_compatibility::production_stable_json_v1(&parsed)
                                    .map_err(|e| error(e.to_string()))?;
                            field(&mut digest, 3, &canonical);
                        } else {
                            field(&mut digest, 3, raw);
                        }
                    } else {
                        field(&mut digest, 4, raw);
                    }
                }
            }
        }
        hashes.push(digest.finalize().into());
    }
    // The complete multiset includes duplicate/no-PK rows and hidden rowids.
    // Session::diff alone silently ignores missing/NULL primary keys.
    hashes.sort_unstable();
    let mut result = Sha256::new();
    field(&mut result, 0, table.as_bytes());
    for name in columns {
        field(&mut result, 1, name.as_bytes());
    }
    result.update((hashes.len() as u64).to_be_bytes());
    for hash in hashes {
        result.update(hash);
    }
    Ok(result.finalize().into())
}
/// Bound SQLite value/row construction before the engine evaluates generated
/// expressions or materializes an oversized row. Never raise an existing limit.
pub(super) fn limit_private_sqlite(db: &Connection) -> Result<()> {
    use rusqlite::limits::Limit;
    let limit = db.limit(Limit::SQLITE_LIMIT_LENGTH)?.min(MAX_CELL as i32);
    db.set_limit(Limit::SQLITE_LIMIT_LENGTH, limit)?;
    Ok(())
}

pub(super) fn effective_digest(db: &Connection) -> Result<[u8; 32]> {
    limit_private_sqlite(db)?;
    ensure(
        db.is_autocommit(),
        "autonomous_research_state_heartbeat_open_transaction",
    )?;
    db.pragma_update(None, "trusted_schema", false)?;
    let mut tables = Vec::new();
    let mut schema_objects = 0;
    let mut query = db.prepare("SELECT name,type,wr FROM pragma_table_list WHERE schema='main' AND name NOT IN ('sqlite_schema','sqlite_temp_schema') ORDER BY name")?;
    let mut rows = query.query([])?;
    while let Some(row) = rows.next()? {
        schema_objects += 1;
        ensure(
            schema_objects <= MAX_TABLES,
            "autonomous_research_state_heartbeat_resource_limit",
        )?;
        let ValueRef::Text(raw_name) = row.get_ref(0)? else {
            return Err(invalid());
        };
        ensure(
            raw_name.len() <= 4096,
            "autonomous_research_state_heartbeat_schema_unsupported",
        )?;
        let name = std::str::from_utf8(raw_name)
            .map_err(|_| invalid())?
            .to_owned();
        let kind: String = row.get(1)?;
        if kind == "view" {
            continue;
        }
        ensure(
            kind == "table",
            "autonomous_research_state_heartbeat_schema_unsupported",
        )?;
        tables.push((name, row.get::<_, i64>(2)? == 1));
    }
    let mut result = Sha256::new();
    let mut count = 0;
    let mut bytes = 0;
    for (table, without_rowid) in tables {
        result.update(table_digest(
            db,
            &table,
            without_rowid,
            &mut count,
            &mut bytes,
        )?);
    }
    for pragma in ["user_version", "application_id"] {
        let value: i64 = db.pragma_query_value(None, pragma, |row| row.get(0))?;
        field(&mut result, 2, &value.to_be_bytes());
    }
    Ok(result.finalize().into())
}
