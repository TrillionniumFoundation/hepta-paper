//! Read-only observation of the incumbent `hepta-store status` contract.
//! Neither a report nor `--require-trust-clean` grants mutation authority.
#![forbid(unsafe_code)]
mod cli;
mod date;
mod handoff;
mod sql;
mod timezone;
pub use cli::store_status_cli_v1;

/// Passive incumbent Date.parse finite gate; never a signed authorization clock.
pub(crate) fn passive_node_date_parse_finite_v1(value: &str) -> bool {
    date::finite(value)
}
/// Passive ordinary Date(string) canonicalization; unrelated to authority clocks.
pub(crate) fn passive_node_date_parse_iso_v1(value: &str) -> Option<String> {
    date::iso(date::millis(value)?)
}
pub(crate) fn passive_node_date_parse_millis_v1(value: &str) -> Option<i64> {
    date::millis(value)
}

use rusqlite::{Connection, OpenFlags};
use serde_json::{Value, json};
use std::{
    path::{Path, PathBuf},
    time::Duration,
};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum StoreStatusError {
    #[error("store status database path must be absolute and canonical")]
    Path,
    #[error("store status database identity is invalid")]
    Identity,
    #[error("{0}")]
    Database(#[from] rusqlite::Error),
    #[error("store status database path is not valid UTF-8")]
    Utf8,
    #[error("{0}")]
    Projection(String),
    #[error("{0}")]
    Arguments(String),
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

fn open_read_only(path: &Path) -> Result<Connection, StoreStatusError> {
    let uri = format!("file:{}?mode=ro", percent_encode(path)?);
    let connection = Connection::open_with_flags(
        uri,
        OpenFlags::SQLITE_OPEN_READ_ONLY
            | OpenFlags::SQLITE_OPEN_URI
            | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    connection.busy_timeout(Duration::from_secs(10))?;
    connection
        .execute_batch("PRAGMA query_only=ON; PRAGMA foreign_keys=ON; PRAGMA temp_store=MEMORY;")?;
    Ok(connection)
}

/// An explicit-path native extension over the same passive SQL owner.
pub fn inspect_store_status_v1(
    database_path: &Path,
    runtime_root: Option<&Path>,
) -> Result<Value, StoreStatusError> {
    inspect_store_status_with_options_v1(database_path, runtime_root, false)
}

/// The optional policy relaxes only verification/technical-conformance
/// contamination. Missing required schema is an SQL refusal, never a zero row.
pub fn inspect_store_status_with_options_v1(
    database_path: &Path,
    runtime_root: Option<&Path>,
    allow_isolated_verification_evidence: bool,
) -> Result<Value, StoreStatusError> {
    if !database_path.is_absolute() {
        return Err(StoreStatusError::Path);
    }
    if !database_path.exists() {
        return Err(StoreStatusError::Projection(format!(
            "Read-only paper store missing: {}",
            database_path.display()
        )));
    }
    // Main-store aliases are observations in the incumbent. The dedicated
    // handoff owner separately enforces its existing containment/identity gates.
    let connection = sql::inspect(database_path)?;
    let runtime = runtime_root.map(PathBuf::from).unwrap_or_else(|| {
        database_path
            .parent()
            .unwrap_or(Path::new("/"))
            .to_path_buf()
    });
    let rows = sql::query(
        &connection,
        "SELECT 'papers' AS name,count(*) AS count FROM papers
UNION ALL SELECT 'venues',count(*) FROM venues
UNION ALL SELECT 'submission_ledger',count(*) FROM submission_ledger
UNION ALL SELECT 'submissions',count(*) FROM submissions
UNION ALL SELECT 'artifacts',count(*) FROM artifacts
UNION ALL SELECT 'referee_revision_requests',count(*) FROM referee_revision_requests
UNION ALL SELECT 'patch_queue',count(*) FROM patch_queue
UNION ALL SELECT 'receipt_ledger',count(*) FROM receipt_ledger
UNION ALL SELECT 'jobs',count(*) FROM jobs
UNION ALL SELECT 'job_attempts',count(*) FROM job_attempts
UNION ALL SELECT 'submission_outbox',count(*) FROM submission_outbox
UNION ALL SELECT 'submission_inbox',count(*) FROM submission_inbox
UNION ALL SELECT 'paper_campaigns',count(*) FROM paper_campaigns
UNION ALL SELECT 'campaign_nodes',count(*) FROM campaign_nodes
UNION ALL SELECT 'campaign_events',count(*) FROM campaign_events;",
    )?;
    let tables = rows
        .into_iter()
        .map(|r| {
            Ok((
                r["name"]
                    .as_str()
                    .ok_or(StoreStatusError::Identity)?
                    .to_owned(),
                r["count"].clone(),
            ))
        })
        .collect::<Result<serde_json::Map<_, _>, StoreStatusError>>()?;
    let metadata = sql::query(
        &connection,
        "SELECT key,value,updated_at FROM store_metadata ORDER BY key;",
    )?;
    let evidence = sql::query(
        &connection,
        "SELECT environment,evidence_class,count(*) AS count FROM receipt_ledger GROUP BY environment,evidence_class ORDER BY environment,evidence_class;",
    )?;
    let qualifications = sql::query(
        &connection,
        "SELECT count(*) AS row_count,count(DISTINCT receipt_id) AS qualified_receipt_count FROM receipt_ledger_qualifications;",
    )?;
    let allow = if allow_isolated_verification_evidence {
        ""
    } else {
        "(environment='verification' AND evidence_class='technical_conformance') OR"
    };
    let contamination = sql::query(
        &connection,
        &format!(
            "SELECT count(*) AS count FROM receipt_ledger AS receipt WHERE ({allow} (environment='production' AND evidence_class='runtime_unclassified') OR (environment='production' AND evidence_class='release_conformance_with_operational_binding')) AND NOT EXISTS (SELECT 1 FROM receipt_ledger_qualifications AS qualification WHERE qualification.receipt_id=receipt.receipt_id AND qualification.disposition IN ('administrative_exported','invalid','superseded','retention_tombstone'));"
        ),
    )?;
    let unresolved = contamination
        .first()
        .map(|r| r["count"].clone())
        .unwrap_or(json!(0));
    let jobs = sql::query(
        &connection,
        "SELECT environment,evidence_class,status,count(*) AS count FROM jobs GROUP BY environment,evidence_class,status ORDER BY environment,evidence_class,status;",
    )?;
    let quick = sql::quick_check(&connection)?;
    let version = sql::query(
        &connection,
        "SELECT coalesce(max(version),0) AS version FROM schema_migrations;",
    )?
    .first()
    .map(|r| r["version"].clone())
    .unwrap_or(json!(0));
    let schema_number = sql::number_or_zero(&version);
    let version = if schema_number.is_finite() {
        serde_json::from_str(ryu_js::Buffer::new().format(schema_number))
            .map_err(|e| StoreStatusError::Projection(e.to_string()))?
    } else {
        Value::Null
    };
    let handoff = handoff::inspect(&connection, &runtime);
    let ready = quick == "ok"
        && unresolved.as_i64() == Some(0)
        && schema_number >= 25.0
        && handoff["ready"] == Value::Bool(true);
    Ok(
        json!({"version":3,"kind":"HeptaNativeStoreStatus","status":if ready {"hepta_native_store_ready"} else {"hepta_native_store_blocked"},"ready":ready,"dbPath":database_path.to_str().ok_or(StoreStatusError::Utf8)?,"schemaVersion":version,"quickCheck":quick,"tables":tables,"metadata":metadata,"evidenceClassifications":evidence,"receiptQualifications":{"rowCount":qualifications.first().map(|r|r["row_count"].clone()).unwrap_or(json!(0)),"qualifiedReceiptCount":qualifications.first().map(|r|r["qualified_receipt_count"].clone()).unwrap_or(json!(0)),"unresolvedContaminatedReceiptCount":unresolved,"rawEvidenceClassificationsPreserved":true},"jobClassifications":jobs,"autonomousSubmissionHandoff":handoff,"legacyDefaultDependency":false}),
    )
}
