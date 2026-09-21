//! Node automation-runtime reconciliation plan and offline business transaction.
//!
//! Read-only inspection needs no writer scope. The private offline transaction
//! requires guarded admission retaining cutover and package-deletion scopes;
//! online coordinator activation and independent qualification remain separate.

#![forbid(unsafe_code)]

use hepta_legacy_compatibility::production_hash_record_v1;
use rusqlite::{Connection, OpenFlags, OptionalExtension, Params, Row, types::ValueRef};
use serde_json::{Map, Value, json};
use std::{fs, os::unix::fs::MetadataExt, path::Path};

// Keep the raw transaction private; the public scope composes cutover and
// package-deletion admission before obtaining its writable connection.
mod legacy_terminal_residue;
mod offline_execution;
mod scoped_execution;
pub use scoped_execution::*;

const MAX_NO_PROGRESS_SECONDS: f64 = 60.0;

#[derive(Debug, thiserror::Error)]
pub enum AutomationRuntimeReconciliationError {
    #[error("automation reconciliation database path is invalid")]
    Path,
    #[error("automation reconciliation database operation failed: {0}")]
    Database(#[from] rusqlite::Error),
    #[error("automation reconciliation input is invalid")]
    Input,
    #[error("automation reconciliation hash failed")]
    Hash,
    #[error("automation reconciliation database row is not representable")]
    Row,
    #[error("{0}")]
    Precondition(&'static str),
    #[error("{0}")]
    Admission(String),
}

fn canonical_database(path: &Path) -> Result<(), AutomationRuntimeReconciliationError> {
    if !path.is_absolute()
        || path.components().any(|component| {
            matches!(
                component,
                std::path::Component::CurDir | std::path::Component::ParentDir
            )
        })
    {
        return Err(AutomationRuntimeReconciliationError::Path);
    }
    let metadata =
        fs::symlink_metadata(path).map_err(|_| AutomationRuntimeReconciliationError::Path)?;
    if metadata.file_type().is_symlink() || !metadata.is_file() || metadata.nlink() != 1 {
        return Err(AutomationRuntimeReconciliationError::Path);
    }
    if fs::canonicalize(path).map_err(|_| AutomationRuntimeReconciliationError::Path)? != path {
        return Err(AutomationRuntimeReconciliationError::Path);
    }
    Ok(())
}

fn open_database(path: &Path) -> Result<Connection, AutomationRuntimeReconciliationError> {
    canonical_database(path)?;
    let text = path
        .to_str()
        .ok_or(AutomationRuntimeReconciliationError::Path)?;
    let mut escaped = String::with_capacity(text.len());
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || b"-._~/".contains(&byte) {
            escaped.push(byte as char);
        } else {
            escaped.push('%');
            escaped.push_str(&format!("{byte:02X}"));
        }
    }
    let connection = Connection::open_with_flags(
        format!("file:{escaped}?mode=ro"),
        OpenFlags::SQLITE_OPEN_READ_ONLY
            | OpenFlags::SQLITE_OPEN_URI
            | OpenFlags::SQLITE_OPEN_NO_MUTEX
            | OpenFlags::SQLITE_OPEN_NOFOLLOW,
    )?;
    connection.execute_batch(
        "PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; PRAGMA temp_store=MEMORY;",
    )?;
    Ok(connection)
}

fn row_error() -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(
        0,
        rusqlite::types::Type::Blob,
        Box::new(std::io::Error::other("unrepresentable reconciliation row")),
    )
}

fn value(value: ValueRef<'_>) -> rusqlite::Result<Value> {
    match value {
        ValueRef::Null => Ok(Value::Null),
        // The incumbent node:sqlite reader rejects INTEGERs outside the exact
        // binary64 range. Accepting them here could hash distinct SQLite CAS
        // values to the same JavaScript-number receipt identity.
        ValueRef::Integer(value)
            if (-9_007_199_254_740_991..=9_007_199_254_740_991).contains(&value) =>
        {
            Ok(json!(value))
        }
        ValueRef::Integer(_) => Err(row_error()),
        ValueRef::Real(value) => serde_json::Number::from_f64(value)
            .map(Value::Number)
            .ok_or_else(row_error),
        ValueRef::Text(value) => Ok(Value::String(
            std::str::from_utf8(value)
                .map_err(|_| row_error())?
                .to_owned(),
        )),
        ValueRef::Blob(_) => Err(row_error()),
    }
}

fn row_object(row: &Row<'_>) -> rusqlite::Result<Value> {
    let statement = row.as_ref();
    let mut object = Map::new();
    for index in 0..statement.column_count() {
        let name = statement.column_name(index).map_err(|_| row_error())?;
        object.insert(name.to_owned(), value(row.get_ref(index)?)?);
    }
    Ok(Value::Object(object))
}

fn rows<P: Params>(
    connection: &Connection,
    sql: &str,
    params: P,
) -> Result<Vec<Value>, AutomationRuntimeReconciliationError> {
    let mut statement = connection.prepare(sql)?;
    let mapped = statement.query_map(params, row_object)?;
    Ok(mapped.collect::<rusqlite::Result<Vec<_>>>()?)
}

fn valid_campaign_id(value: &str) -> bool {
    let mut chars = value.chars();
    chars
        .next()
        .is_some_and(|first| first.is_ascii_alphanumeric())
        && value.len() <= 192
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"_.:-".contains(&byte))
}

fn verify_campaign_scope(
    connection: &Connection,
    campaign_id: Option<&str>,
) -> Result<(), AutomationRuntimeReconciliationError> {
    let Some(campaign_id) = campaign_id else {
        return Ok(());
    };
    if !valid_campaign_id(campaign_id) {
        return Err(AutomationRuntimeReconciliationError::Input);
    }
    let found: Option<(String, i64)> = connection
        .query_row(
            "SELECT campaign_id, CAST(coalesce(json_extract(spec_json, '$.terminalSiblingSettlementPolicyVersion'),0) AS INTEGER) FROM paper_campaigns WHERE campaign_id=?1 LIMIT 2",
            [campaign_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let Some((found_id, policy_version)) = found else {
        return Err(AutomationRuntimeReconciliationError::Input);
    };
    if found_id != campaign_id || policy_version != 1 {
        return Err(AutomationRuntimeReconciliationError::Input);
    }
    Ok(())
}

/// Build the same passive plan as Node `planAutomationRuntimeReconciliation`.
pub fn inspect_automation_runtime_reconciliation_v1(
    database: &Path,
    now: &str,
    no_progress_seconds: f64,
    campaign_id: Option<&str>,
) -> Result<Value, AutomationRuntimeReconciliationError> {
    // Preserve validation precedence of the original read-only entrypoint.
    if crate::journal_connector_coverage::qualification::canonical_instant_millis(now).is_none()
        || !no_progress_seconds.is_finite()
    {
        return Err(AutomationRuntimeReconciliationError::Input);
    }
    let connection = open_database(database)?;
    plan_on_connection(&connection, now, no_progress_seconds, campaign_id)
}

/// Inspect the incumbent policy-v0 maintenance plan without acquiring a writer.
pub fn inspect_legacy_terminal_active_residue_v1(
    database: &Path,
    now: &str,
    campaign_id: &str,
) -> Result<Value, AutomationRuntimeReconciliationError> {
    if crate::journal_connector_coverage::qualification::canonical_instant_millis(now).is_none() {
        return Err(AutomationRuntimeReconciliationError::Input);
    }
    let connection = open_database(database)?;
    legacy_terminal_residue::plan_on_connection(&connection, now, campaign_id)
}

fn plan_on_connection(
    connection: &Connection,
    now: &str,
    no_progress_seconds: f64,
    campaign_id: Option<&str>,
) -> Result<Value, AutomationRuntimeReconciliationError> {
    let now_millis =
        crate::journal_connector_coverage::qualification::canonical_instant_millis(now)
            .ok_or(AutomationRuntimeReconciliationError::Input)?;
    if !no_progress_seconds.is_finite() {
        return Err(AutomationRuntimeReconciliationError::Input);
    }
    verify_campaign_scope(connection, campaign_id)?;
    plan_on_connection_at(
        connection,
        now,
        now_millis,
        no_progress_seconds,
        campaign_id,
    )
}

// Scope is checked by the caller before sampling the clock, as in Node. The
// cutoff instant is a separate sample from the plan's ISO observation instant.
fn plan_on_connection_at(
    connection: &Connection,
    now: &str,
    cutoff_now_millis: i64,
    no_progress_seconds: f64,
    campaign_id: Option<&str>,
) -> Result<Value, AutomationRuntimeReconciliationError> {
    if crate::journal_connector_coverage::qualification::canonical_instant_millis(now).is_none()
        || !no_progress_seconds.is_finite()
    {
        return Err(AutomationRuntimeReconciliationError::Input);
    }
    // The incumbent uses `Math.max(60, Number(value || 1800))`: an explicit
    // zero therefore selects the 1800-second default rather than the 60-second
    // floor. Preserve that JavaScript truthiness boundary before applying the
    // lower bound.
    let effective_no_progress_seconds = if no_progress_seconds == 0.0 {
        1800.0
    } else {
        no_progress_seconds.max(MAX_NO_PROGRESS_SECONDS)
    };
    // Node subtracts in binary64 before Date's TimeClip truncates the result
    // toward zero. Rounding the interval first changes fractional-millisecond
    // cutoffs (and therefore the selected rows and reconciliation plan hash).
    let cutoff = cutoff_now_millis as f64 - effective_no_progress_seconds * 1000.0;
    if !cutoff.is_finite() || cutoff.abs() > 8_640_000_000_000_000.0 {
        return Err(AutomationRuntimeReconciliationError::Input);
    }
    let cutoff_millis = cutoff.trunc() as i64;
    let no_progress_cutoff = crate::sqlite_mutation_coordinator::clock::iso(cutoff_millis)
        .map_err(|_| AutomationRuntimeReconciliationError::Input)?;
    let expired_nodes = if let Some(id) = campaign_id {
        rows(
            connection,
            "SELECT n.node_id,n.campaign_id,n.status,n.lease_owner,n.lease_expires_at,n.attempt_id,n.lease_generation,n.node_revision,c.revision AS campaign_revision FROM campaign_nodes n JOIN paper_campaigns c ON c.campaign_id=n.campaign_id WHERE c.status='running' AND n.status IN ('leased','running') AND n.lease_expires_at IS NOT NULL AND julianday(n.lease_expires_at)<=julianday(?1) AND n.campaign_id=?2 ORDER BY n.campaign_id,n.node_id",
            rusqlite::params![now, id],
        )?
    } else {
        rows(
            connection,
            "SELECT n.node_id,n.campaign_id,n.status,n.lease_owner,n.lease_expires_at,n.attempt_id,n.lease_generation,n.node_revision,c.revision AS campaign_revision FROM campaign_nodes n JOIN paper_campaigns c ON c.campaign_id=n.campaign_id WHERE c.status='running' AND n.status IN ('leased','running') AND n.lease_expires_at IS NOT NULL AND julianday(n.lease_expires_at)<=julianday(?1) ORDER BY n.campaign_id,n.node_id",
            rusqlite::params![now],
        )?
    };
    let expired_resource_leases = if let Some(id) = campaign_id {
        rows(
            connection,
            "SELECT lease_id,scope,owner_id,campaign_id,node_id,agent,cpu,gpu,memory_mib,acquired_at,renewed_at,expires_at FROM automation_resource_leases WHERE expires_at<=?1 AND campaign_id=?2 ORDER BY lease_id",
            rusqlite::params![now, id],
        )?
    } else {
        rows(
            connection,
            "SELECT lease_id,scope,owner_id,campaign_id,node_id,agent,cpu,gpu,memory_mib,acquired_at,renewed_at,expires_at FROM automation_resource_leases WHERE expires_at<=?1 ORDER BY lease_id",
            rusqlite::params![now],
        )?
    };
    let expired_waiters = if let Some(id) = campaign_id {
        rows(
            connection,
            "SELECT waiter_id,scope,owner_id,campaign_id,node_id,agent,cpu,gpu,memory_mib,requested_at,renewed_at,expires_at FROM automation_resource_waiters WHERE expires_at IS NOT NULL AND expires_at<=?1 AND campaign_id=?2 ORDER BY waiter_id",
            rusqlite::params![now, id],
        )?
    } else {
        rows(
            connection,
            "SELECT waiter_id,scope,owner_id,campaign_id,node_id,agent,cpu,gpu,memory_mib,requested_at,renewed_at,expires_at FROM automation_resource_waiters WHERE expires_at IS NOT NULL AND expires_at<=?1 ORDER BY waiter_id",
            rusqlite::params![now],
        )?
    };
    let no_progress_campaigns = if let Some(id) = campaign_id {
        rows(
            connection,
            "SELECT c.campaign_id,c.paper_id,c.updated_at,c.current_phase,c.revision,count(n.node_id) AS queued_node_count FROM paper_campaigns c JOIN campaign_nodes n ON n.campaign_id=c.campaign_id AND n.status='queued' WHERE c.status='running' AND c.updated_at<=?1 AND c.campaign_id=?2 AND NOT EXISTS(SELECT 1 FROM campaign_nodes active WHERE active.campaign_id=c.campaign_id AND active.status IN ('leased','running')) GROUP BY c.campaign_id,c.paper_id,c.updated_at,c.current_phase,c.revision ORDER BY c.updated_at,c.campaign_id",
            rusqlite::params![no_progress_cutoff, id],
        )?
    } else {
        rows(
            connection,
            "SELECT c.campaign_id,c.paper_id,c.updated_at,c.current_phase,c.revision,count(n.node_id) AS queued_node_count FROM paper_campaigns c JOIN campaign_nodes n ON n.campaign_id=c.campaign_id AND n.status='queued' WHERE c.status='running' AND c.updated_at<=?1 AND NOT EXISTS(SELECT 1 FROM campaign_nodes active WHERE active.campaign_id=c.campaign_id AND active.status IN ('leased','running')) GROUP BY c.campaign_id,c.paper_id,c.updated_at,c.current_phase,c.revision ORDER BY c.updated_at,c.campaign_id",
            rusqlite::params![no_progress_cutoff],
        )?
    };
    let terminal_campaign_queued_nodes = if let Some(id) = campaign_id {
        rows(
            connection,
            "SELECT n.node_id,n.campaign_id,n.node_revision,c.status AS campaign_status,c.stop_reason,c.revision AS campaign_revision FROM campaign_nodes n JOIN paper_campaigns c ON c.campaign_id=n.campaign_id WHERE n.status='queued' AND c.status IN ('failed','cancelled','stopped','completed') AND CAST(coalesce(json_extract(c.spec_json,'$.terminalSiblingSettlementPolicyVersion'),0) AS INTEGER)=1 AND n.campaign_id=?1 ORDER BY n.campaign_id,n.node_id",
            rusqlite::params![id],
        )?
    } else {
        rows(
            connection,
            "SELECT n.node_id,n.campaign_id,n.node_revision,c.status AS campaign_status,c.stop_reason,c.revision AS campaign_revision FROM campaign_nodes n JOIN paper_campaigns c ON c.campaign_id=n.campaign_id WHERE n.status='queued' AND c.status IN ('failed','cancelled','stopped','completed') AND CAST(coalesce(json_extract(c.spec_json,'$.terminalSiblingSettlementPolicyVersion'),0) AS INTEGER)=1 ORDER BY n.campaign_id,n.node_id",
            rusqlite::params![],
        )?
    };
    let terminal_campaign_active_nodes = if let Some(id) = campaign_id {
        rows(
            connection,
            "SELECT n.node_id,n.campaign_id,n.status,n.lease_owner,n.lease_expires_at,n.attempt_id,n.lease_generation,n.node_revision,n.prepared_integration_status,c.status AS campaign_status,c.stop_reason,c.revision AS campaign_revision FROM campaign_nodes n JOIN paper_campaigns c ON c.campaign_id=n.campaign_id WHERE n.status IN ('leased','running') AND c.status IN ('failed','cancelled','stopped','completed') AND CAST(coalesce(json_extract(c.spec_json,'$.terminalSiblingSettlementPolicyVersion'),0) AS INTEGER)=1 AND n.campaign_id=?1 ORDER BY n.campaign_id,n.node_id",
            rusqlite::params![id],
        )?
    } else {
        rows(
            connection,
            "SELECT n.node_id,n.campaign_id,n.status,n.lease_owner,n.lease_expires_at,n.attempt_id,n.lease_generation,n.node_revision,n.prepared_integration_status,c.status AS campaign_status,c.stop_reason,c.revision AS campaign_revision FROM campaign_nodes n JOIN paper_campaigns c ON c.campaign_id=n.campaign_id WHERE n.status IN ('leased','running') AND c.status IN ('failed','cancelled','stopped','completed') AND CAST(coalesce(json_extract(c.spec_json,'$.terminalSiblingSettlementPolicyVersion'),0) AS INTEGER)=1 ORDER BY n.campaign_id,n.node_id",
            rusqlite::params![],
        )?
    };
    let preserved_legacy_terminal_nodes = if let Some(id) = campaign_id {
        rows(
            connection,
            "SELECT n.node_id,n.campaign_id,n.status,n.lease_owner,n.lease_expires_at,n.attempt_id,n.lease_generation,n.node_revision,n.prepared_integration_status,c.status AS campaign_status,c.stop_reason FROM campaign_nodes n JOIN paper_campaigns c ON c.campaign_id=n.campaign_id WHERE n.status IN ('queued','leased','running') AND c.status IN ('failed','cancelled','stopped','completed') AND CAST(coalesce(json_extract(c.spec_json,'$.terminalSiblingSettlementPolicyVersion'),0) AS INTEGER)<>1 AND n.campaign_id=?1 ORDER BY n.campaign_id,n.node_id",
            rusqlite::params![id],
        )?
    } else {
        rows(
            connection,
            "SELECT n.node_id,n.campaign_id,n.status,n.lease_owner,n.lease_expires_at,n.attempt_id,n.lease_generation,n.node_revision,n.prepared_integration_status,c.status AS campaign_status,c.stop_reason FROM campaign_nodes n JOIN paper_campaigns c ON c.campaign_id=n.campaign_id WHERE n.status IN ('queued','leased','running') AND c.status IN ('failed','cancelled','stopped','completed') AND CAST(coalesce(json_extract(c.spec_json,'$.terminalSiblingSettlementPolicyVersion'),0) AS INTEGER)<>1 ORDER BY n.campaign_id,n.node_id",
            rusqlite::params![],
        )?
    };

    let required = !expired_nodes.is_empty()
        || !expired_resource_leases.is_empty()
        || !expired_waiters.is_empty()
        || !no_progress_campaigns.is_empty()
        || !terminal_campaign_queued_nodes.is_empty()
        || !terminal_campaign_active_nodes.is_empty();
    let status = if required {
        "automation_runtime_reconciliation_required"
    } else if !preserved_legacy_terminal_nodes.is_empty() {
        "automation_runtime_reconciliation_legacy_terminal_evidence_preserved"
    } else {
        "automation_runtime_reconciliation_clean"
    };
    let mut payload = json!({
        "version": 2,
        "kind": "AutomationRuntimeReconciliationPlan",
        "status": status,
        "plannedAt": now,
        "expiredNodes": expired_nodes,
        "expiredResourceLeases": expired_resource_leases,
        "expiredWaiters": expired_waiters,
        "noProgressCutoff": no_progress_cutoff,
        "noProgressCampaigns": no_progress_campaigns,
        "terminalCampaignQueuedNodes": terminal_campaign_queued_nodes,
        "terminalCampaignActiveNodes": terminal_campaign_active_nodes,
        "preservedLegacyTerminalNodes": preserved_legacy_terminal_nodes,
    });
    if let Some(campaign_id) = campaign_id {
        payload["campaignId"] = Value::String(campaign_id.to_owned());
    }
    let hash = production_hash_record_v1("AutomationRuntimeReconciliationPlan", &payload)
        .map_err(|_| AutomationRuntimeReconciliationError::Hash)?;
    payload["reconciliationPlanHash"] = Value::String(hash.as_str().to_owned());
    Ok(payload)
}
