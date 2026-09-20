//! Immutable, read-only projection of the Node `hepta-store status` contract.
//!
//! This command is deliberately a diagnostic projection over one explicitly
//! supplied SQLite file (and its colocated handoff database). It never opens a
//! writable connection, provisions a handoff database, repairs rows, or grants
//! production authority.

#![forbid(unsafe_code)]

use rusqlite::{Connection, OpenFlags, Row};
use serde_json::{Map, Value, json};
use std::{
    fs,
    os::unix::fs::MetadataExt,
    path::{Path, PathBuf},
};
use thiserror::Error;

const HANDOFF_CUTOVER_ID: &str = "autonomous-submission-handoff-cutover-v1";
const TABLES: [&str; 15] = [
    "papers",
    "venues",
    "submission_ledger",
    "submissions",
    "artifacts",
    "referee_revision_requests",
    "patch_queue",
    "receipt_ledger",
    "jobs",
    "job_attempts",
    "submission_outbox",
    "submission_inbox",
    "paper_campaigns",
    "campaign_nodes",
    "campaign_events",
];

#[derive(Debug, Error)]
pub enum StoreStatusError {
    #[error("store status database path must be absolute and canonical")]
    Path,
    #[error("store status database identity is invalid")]
    Identity,
    #[error("store status database operation failed")]
    Database(#[from] rusqlite::Error),
    #[error("store status database path is not valid UTF-8")]
    Utf8,
}

fn percent_encode(path: &Path) -> Result<String, StoreStatusError> {
    let text = path.to_str().ok_or(StoreStatusError::Utf8)?;
    let mut output = String::with_capacity(text.len());
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~' | b'/') {
            output.push(byte as char);
        } else {
            output.push('%');
            output.push_str(&format!("{byte:02X}"));
        }
    }
    Ok(output)
}

fn canonical_database(path: &Path) -> Result<PathBuf, StoreStatusError> {
    if !path.is_absolute()
        || path.components().any(|part| {
            matches!(
                part,
                std::path::Component::CurDir | std::path::Component::ParentDir
            )
        })
    {
        return Err(StoreStatusError::Path);
    }
    let canonical = fs::canonicalize(path).map_err(|_| StoreStatusError::Path)?;
    if canonical != path {
        return Err(StoreStatusError::Path);
    }
    let metadata = fs::symlink_metadata(path).map_err(|_| StoreStatusError::Path)?;
    if metadata.file_type().is_symlink() || !metadata.is_file() || metadata.nlink() != 1 {
        return Err(StoreStatusError::Identity);
    }
    Ok(canonical)
}

fn open_read_only(path: &Path) -> Result<Connection, StoreStatusError> {
    let uri = format!("file:{}?mode=ro", percent_encode(path)?);
    let connection = Connection::open_with_flags(
        uri,
        OpenFlags::SQLITE_OPEN_READ_ONLY
            | OpenFlags::SQLITE_OPEN_URI
            | OpenFlags::SQLITE_OPEN_NO_MUTEX
            | OpenFlags::SQLITE_OPEN_NOFOLLOW,
    )?;
    connection.execute_batch(
        "PRAGMA query_only=ON;
         PRAGMA trusted_schema=OFF;
         PRAGMA temp_store=MEMORY;",
    )?;
    Ok(connection)
}

fn has_table(connection: &Connection, table: &str) -> Result<bool, StoreStatusError> {
    let found = connection.query_row(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1 LIMIT 1",
        [table],
        |_| Ok(()),
    );
    match found {
        Ok(()) => Ok(true),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(false),
        Err(error) => Err(error.into()),
    }
}

fn count_table(connection: &Connection, table: &str) -> Result<u64, StoreStatusError> {
    if !has_table(connection, table)? {
        return Ok(0);
    }
    let query = format!("SELECT count(*) FROM \"{}\"", table.replace('"', "\"\""));
    let count: i64 = connection.query_row(&query, [], |row| row.get(0))?;
    u64::try_from(count).map_err(|_| StoreStatusError::Identity)
}

fn value_string(row: &Row<'_>, index: usize) -> Result<Value, rusqlite::Error> {
    let value: Option<String> = row.get(index)?;
    Ok(value.map_or(Value::Null, Value::String))
}

fn metadata(connection: &Connection) -> Result<Value, StoreStatusError> {
    if !has_table(connection, "store_metadata")? {
        return Ok(Value::Array(Vec::new()));
    }
    let mut statement =
        connection.prepare("SELECT key,value,updated_at FROM store_metadata ORDER BY key")?;
    let rows = statement
        .query_map([], |row| {
            Ok(json!({
                "key": row.get::<_, String>(0)?,
                "value": row.get::<_, String>(1)?,
                "updated_at": row.get::<_, String>(2)?,
            }))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(Value::Array(rows))
}

fn grouped(
    connection: &Connection,
    query: &str,
    fields: &[&str],
) -> Result<Value, StoreStatusError> {
    let mut statement = connection.prepare(query)?;
    let rows = statement
        .query_map([], |row| {
            let mut object = Map::new();
            for (index, field) in fields.iter().enumerate() {
                if *field == "count" {
                    object.insert((*field).to_owned(), json!(row.get::<_, i64>(index)?));
                } else {
                    object.insert((*field).to_owned(), value_string(row, index)?);
                }
            }
            Ok(Value::Object(object))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(Value::Array(rows))
}

fn schema_version(connection: &Connection) -> Result<u32, StoreStatusError> {
    if !has_table(connection, "schema_migrations")? {
        return Ok(0);
    }
    let value: i64 = connection.query_row(
        "SELECT coalesce(max(version),0) FROM schema_migrations",
        [],
        |row| row.get(0),
    )?;
    u32::try_from(value).map_err(|_| StoreStatusError::Identity)
}

fn quick_check(connection: &Connection) -> Result<String, StoreStatusError> {
    let result: Option<String> = connection
        .query_row("PRAGMA quick_check", [], |row| row.get(0))
        .ok();
    Ok(result.unwrap_or_else(|| "unknown".to_owned()))
}

fn contaminated_count(connection: &Connection) -> Result<u64, StoreStatusError> {
    if !has_table(connection, "receipt_ledger")?
        || !has_table(connection, "receipt_ledger_qualifications")?
    {
        return Ok(0);
    }
    let count: i64 = connection.query_row(
        "SELECT count(*)
           FROM receipt_ledger AS receipt
          WHERE ((environment='verification' AND evidence_class='technical_conformance')
             OR (environment='production' AND evidence_class='runtime_unclassified')
             OR (environment='production' AND evidence_class='release_conformance_with_operational_binding'))
            AND NOT EXISTS (
                SELECT 1 FROM receipt_ledger_qualifications AS qualification
                 WHERE qualification.receipt_id=receipt.receipt_id
                   AND qualification.disposition IN
                     ('administrative_exported','invalid','superseded','retention_tombstone')
            )",
        [],
        |row| row.get(0),
    )?;
    u64::try_from(count).map_err(|_| StoreStatusError::Identity)
}

fn handoff(connection: &Connection, runtime_root: &Path) -> Value {
    let database_path =
        runtime_root.join("autonomous-research/submission-handoff/submission-handoff.sqlite");
    let path_text = database_path.to_string_lossy().into_owned();
    if !database_path.exists() {
        return json!({
            "ready": false,
            "databasePath": path_text,
            "blockers": ["autonomous_submission_handoff_database_missing"],
        });
    }
    let result = (|| -> Result<Value, StoreStatusError> {
        let handoff = canonical_database(&database_path)?;
        let handoff_connection = open_read_only(&handoff)?;
        let native = if has_table(connection, "autonomous_submission_handoff_cutover")? {
            connection
                .query_row(
                    "SELECT cutover_id,handoff_database_identity_hash
                       FROM autonomous_submission_handoff_cutover
                      WHERE singleton=1 LIMIT 1",
                    [],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
                )
                .ok()
        } else {
            None
        };
        let handoff_row = if has_table(&handoff_connection, "handoff_cutover")? {
            handoff_connection
                .query_row(
                    "SELECT cutover_id,native_cutover_identity_hash,status
                       FROM handoff_cutover WHERE singleton=1 LIMIT 1",
                    [],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, String>(2)?,
                        ))
                    },
                )
                .ok()
        } else {
            None
        };
        let quick = quick_check(&handoff_connection)?;
        let ready = native.as_ref().is_some_and(|native| {
            handoff_row.as_ref().is_some_and(|handoff| {
                native.0 == HANDOFF_CUTOVER_ID
                    && handoff.0 == HANDOFF_CUTOVER_ID
                    && native.1 == handoff.1
                    && handoff.2 == "active"
                    && quick == "ok"
            })
        });
        Ok(json!({
            "ready": ready,
            "databasePath": path_text,
            "quickCheck": quick,
            "cutoverId": handoff_row.as_ref().map(|row| row.0.clone()),
            "databaseIdentityHash": handoff_row.as_ref().map(|row| row.1.clone()),
            "blockers": if ready { Vec::<String>::new() } else { vec!["autonomous_submission_handoff_cutover_not_active".to_owned()] },
        }))
    })();
    result.unwrap_or_else(|error| {
        let blocker = match error {
            StoreStatusError::Database(_) => "autonomous_submission_handoff_schema_mismatch",
            StoreStatusError::Path | StoreStatusError::Identity | StoreStatusError::Utf8 => {
                "autonomous_submission_handoff_database_file_unsafe"
            }
        };
        json!({
            "ready": false,
            "databasePath": path_text,
            "blockers": [blocker],
        })
    })
}

/// Build the Node `hepta-store status` report over one explicitly supplied
/// read-only database.
/// `runtime_root` is explicit so the colocated submission-handoff store can be
/// inspected without discovering or creating a production workspace.
pub fn inspect_store_status_v1(
    database_path: &Path,
    runtime_root: Option<&Path>,
) -> Result<Value, StoreStatusError> {
    let database_path = canonical_database(database_path)?;
    let connection = open_read_only(&database_path)?;
    let runtime_root =
        runtime_root.unwrap_or_else(|| database_path.parent().unwrap_or(Path::new("/")));
    let runtime_root = runtime_root.to_path_buf();
    let mut tables = Map::new();
    for table in TABLES {
        tables.insert(table.to_owned(), json!(count_table(&connection, table)?));
    }
    let quick = quick_check(&connection)?;
    let unresolved = contaminated_count(&connection)?;
    let version = schema_version(&connection)?;
    let handoff = handoff(&connection, &runtime_root);
    let ready =
        quick == "ok" && unresolved == 0 && version >= 25 && handoff["ready"] == Value::Bool(true);
    let evidence = if has_table(&connection, "receipt_ledger")? {
        grouped(
            &connection,
            "SELECT environment,evidence_class,count(*) AS count
               FROM receipt_ledger
              GROUP BY environment,evidence_class
              ORDER BY environment,evidence_class",
            &["environment", "evidence_class", "count"],
        )?
    } else {
        Value::Array(Vec::new())
    };
    let qualifications = if has_table(&connection, "receipt_ledger_qualifications")? {
        connection.query_row(
            "SELECT count(*) AS row_count,count(DISTINCT receipt_id) AS qualified_receipt_count
               FROM receipt_ledger_qualifications",
            [],
            |row| {
                Ok(json!({
                    "rowCount": row.get::<_, i64>(0)?,
                    "qualifiedReceiptCount": row.get::<_, i64>(1)?,
                    "unresolvedContaminatedReceiptCount": unresolved,
                    "rawEvidenceClassificationsPreserved": true,
                }))
            },
        )?
    } else {
        json!({
            "rowCount": 0,
            "qualifiedReceiptCount": 0,
            "unresolvedContaminatedReceiptCount": unresolved,
            "rawEvidenceClassificationsPreserved": true,
        })
    };
    let jobs = if has_table(&connection, "jobs")? {
        grouped(
            &connection,
            "SELECT environment,evidence_class,status,count(*) AS count
               FROM jobs
              GROUP BY environment,evidence_class,status
              ORDER BY environment,evidence_class,status",
            &["environment", "evidence_class", "status", "count"],
        )?
    } else {
        Value::Array(Vec::new())
    };
    Ok(json!({
        "version": 3,
        "kind": "HeptaNativeStoreStatus",
        "status": if ready { "hepta_native_store_ready" } else { "hepta_native_store_blocked" },
        "ready": ready,
        "dbPath": database_path.to_string_lossy(),
        "schemaVersion": version,
        "quickCheck": quick,
        "tables": Value::Object(tables),
        "metadata": metadata(&connection)?,
        "evidenceClassifications": evidence,
        "receiptQualifications": qualifications,
        "jobClassifications": jobs,
        "autonomousSubmissionHandoff": handoff,
        "legacyDefaultDependency": false,
    }))
}
