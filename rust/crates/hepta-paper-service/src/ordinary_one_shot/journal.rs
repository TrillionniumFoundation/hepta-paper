//! Audit fixed journal SQL against captured bytes. SQLite receives an in-memory
//! read-only image: it never resolves an original descriptor to a mutable path
//! or creates coordination files beside the historical journal.
use super::{audit, contract::contract, json::*};
use crate::automation_runtime_reconciliation::{
    ordinary::ReconciliationReadControlV1, rows_with_control,
};
use hepta_legacy_compatibility::ProductionJsonValue as Json;
use rusqlite::{Connection, MAIN_DB, Params};
use std::io::{Cursor, Read};

struct ControlledImageReader<'a> {
    cursor: Cursor<&'a [u8]>,
    control: &'a ReconciliationReadControlV1,
}
impl Read for ControlledImageReader<'_> {
    fn read(&mut self, output: &mut [u8]) -> std::io::Result<usize> {
        self.control.checkpoint().map_err(std::io::Error::other)?;
        let count = output.len().min(64 * 1024);
        self.cursor.read(&mut output[..count])
    }
}

fn rows<P: Params>(
    connection: &Connection,
    sql: &str,
    params: P,
    control: &ReconciliationReadControlV1,
) -> Result<Vec<serde_json::Value>, String> {
    rows_with_control(connection, sql, params, Some(control)).map_err(|error| error.to_string())
}
fn projection(value: &serde_json::Value) -> Result<Json, String> {
    let bytes = serde_json::to_vec(value).map_err(|error| error.to_string())?;
    hepta_legacy_compatibility::parse_production_json_v1(&bytes).map_err(|error| error.to_string())
}
fn raw_row(
    value: &serde_json::Value,
    column: &str,
    code: &str,
    control: &ReconciliationReadControlV1,
) -> Result<Json, String> {
    let raw = value[column].as_str().ok_or_else(|| code.to_owned())?;
    row(raw, code, &control.cancelled)
}
fn row_equals(
    value: &serde_json::Value,
    column: &str,
    payload: &Json,
    key: &str,
) -> Result<bool, String> {
    Ok(scalar_eq(&projection(&value[column])?, field(payload, key)))
}
pub(super) fn schema_hash(
    connection: &Connection,
    control: &ReconciliationReadControlV1,
) -> Result<String, String> {
    let invalid = "campaign_one_shot_attempt_journal_schema_invalid";
    let c = contract()?;
    let observed = rows(
        connection,
        "SELECT type,name,tbl_name AS tableName,coalesce(sql,'') AS sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name,tbl_name,sql",
        [],
        control,
    )?;
    let mut names = observed
        .iter()
        .map(|row| match (row["type"].as_str(), row["name"].as_str()) {
            (Some(kind), Some(name)) => Ok(format!("{kind}:{name}")),
            _ => Err(invalid.to_owned()),
        })
        .collect::<Result<Vec<_>, _>>()?;
    names.sort();
    if serde_json::to_value(&names).map_err(|error| error.to_string())? != c["schemaObjects"] {
        return Err(invalid.into());
    }
    hash(
        "CampaignOneShotAttemptJournalSqliteSchema",
        &projection(&serde_json::Value::Array(observed))?,
        &control.cancelled,
    )
}
pub(super) fn schema(
    connection: &Connection,
    control: &ReconciliationReadControlV1,
) -> Result<(), String> {
    let invalid = "campaign_one_shot_attempt_journal_schema_invalid";
    let c = contract()?;
    let schema_hash = schema_hash(connection, control)?;
    let metadata = rows(
        connection,
        "SELECT schema_version,schema_contract_id,schema_contract_hash,sqlite_schema_hash,created_at FROM campaign_one_shot_attempt_journal_metadata WHERE singleton=1 LIMIT 2",
        [],
        control,
    )?;
    if metadata.len() != 1
        || metadata[0]["schema_version"].as_f64() != Some(1.0)
        || metadata[0]["schema_contract_id"] != c["schemaContractId"]
        || metadata[0]["schema_contract_hash"] != c["schemaContractHash"]
        || metadata[0]["sqlite_schema_hash"].as_str() != Some(schema_hash.as_str())
        || instant(&projection(&metadata[0]["created_at"])?).is_none()
    {
        return Err(invalid.into());
    }
    let quick = rows(connection, "PRAGMA quick_check", [], control)?;
    let foreign = rows(connection, "PRAGMA foreign_key_check", [], control)?;
    if quick.len() != 1 || quick[0]["quick_check"] != "ok" || !foreign.is_empty() {
        return Err("campaign_one_shot_attempt_journal_integrity_invalid".into());
    }
    Ok(())
}

pub(super) fn inspect(
    bytes: &[u8],
    attempt: &str,
    control: &ReconciliationReadControlV1,
) -> Result<Json, String> {
    inspect_image(bytes, control, |connection| {
        inspect_connection(connection, attempt, control)
    })
}

pub(super) fn inspect_target(
    bytes: &[u8],
    control: &ReconciliationReadControlV1,
) -> Result<Json, String> {
    inspect_image(bytes, control, |connection| {
        let c = contract()?;
        let campaign = c["currentTarget"]["campaignId"]
            .as_str()
            .ok_or("one_shot_status_contract_invalid")?;
        let attempts = rows(
            connection,
            "SELECT attempt_id FROM campaign_one_shot_attempts WHERE campaign_id=?1 LIMIT 2",
            [campaign],
            control,
        )?;
        if attempts.is_empty() {
            return Ok(Json::Null);
        }
        if attempts.len() != 1 {
            return Err("campaign_one_shot_attempt_journal_attempt_invalid".into());
        }
        let attempt = attempts[0]["attempt_id"]
            .as_str()
            .ok_or("campaign_one_shot_attempt_journal_attempt_invalid")?;
        inspect_connection(connection, attempt, control)
    })
}

fn inspect_image(
    bytes: &[u8],
    control: &ReconciliationReadControlV1,
    project: impl FnOnce(&Connection) -> Result<Json, String>,
) -> Result<Json, String> {
    control.checkpoint().map_err(|error| error.to_string())?;
    // The original immutable journal requires DELETE mode and no sidecars.
    // A deserialized SQLite image itself reports MEMORY, so verify the original
    // on-disk read/write format bytes rather than treating MEMORY as DELETE.
    if bytes.get(..16) != Some(b"SQLite format 3\0")
        || bytes.get(18) != Some(&1)
        || bytes.get(19) != Some(&1)
    {
        return Err("campaign_one_shot_attempt_journal_pragma_invalid".into());
    }
    let mut connection = Connection::open_in_memory().map_err(|error| error.to_string())?;
    connection
        .deserialize_read_exact(
            MAIN_DB,
            ControlledImageReader {
                cursor: Cursor::new(bytes),
                control,
            },
            bytes.len(),
            true,
        )
        .map_err(|error| error.to_string())?;
    control
        .install(&connection)
        .map_err(|error| error.to_string())?;
    connection
        .execute_batch("PRAGMA foreign_keys=ON; PRAGMA query_only=ON;")
        .map_err(|error| control.map_database(error).to_string())?;
    let foreign_keys = rows(&connection, "PRAGMA foreign_keys", [], control)?;
    if foreign_keys.len() != 1 || foreign_keys[0]["foreign_keys"].as_f64() != Some(1.0) {
        return Err("campaign_one_shot_attempt_journal_pragma_invalid".into());
    }
    schema(&connection, control)?;
    project(&connection)
}

pub(super) fn inspect_connection(
    connection: &Connection,
    attempt: &str,
    control: &ReconciliationReadControlV1,
) -> Result<Json, String> {
    let attempts = rows(
        connection,
        "SELECT attempt_id,idempotency_key,campaign_id,protected_campaign_id,execution_binding_hash,reservation_hash,reservation_json,reserved_at FROM campaign_one_shot_attempts WHERE attempt_id=?1 LIMIT 2",
        [attempt],
        control,
    )?;
    if attempts.is_empty() {
        return Err("autonomous_research_one_shot_attempt_missing".into());
    }
    if attempts.len() != 1 {
        return Err("campaign_one_shot_attempt_journal_attempt_invalid".into());
    }
    let reservation = raw_row(
        &attempts[0],
        "reservation_json",
        "campaign_one_shot_attempt_journal_reservation_json_invalid",
        control,
    )?;
    let current = audit::reservation(&reservation, &control.cancelled)?;
    for (column, key) in [
        ("attempt_id", "attemptId"),
        ("idempotency_key", "idempotencyKey"),
        ("campaign_id", "campaignId"),
        ("protected_campaign_id", "protectedCampaignId"),
        ("execution_binding_hash", "executionBindingHash"),
        (
            "reservation_hash",
            "autonomousResearchOneShotCampaignAttemptReservationHash",
        ),
        ("reserved_at", "reservedAt"),
    ] {
        if !row_equals(&attempts[0], column, &reservation, key)? {
            return Err("campaign_one_shot_attempt_journal_reservation_invalid".into());
        }
    }
    let event_rows = rows(
        connection,
        "SELECT event_id,attempt_id,sequence,phase,previous_event_hash,event_hash,event_json,recorded_at FROM campaign_one_shot_attempt_events WHERE attempt_id=?1 ORDER BY sequence LIMIT 8",
        [attempt],
        control,
    )?;
    if event_rows.is_empty() || event_rows.len() > 7 {
        return Err("campaign_one_shot_attempt_journal_event_sequence_invalid".into());
    }
    let mut events = Vec::with_capacity(event_rows.len());
    for (index, event_row) in event_rows.iter().enumerate() {
        control.checkpoint().map_err(|error| error.to_string())?;
        let event = raw_row(
            event_row,
            "event_json",
            "campaign_one_shot_attempt_journal_event_json_invalid",
            control,
        )?;
        audit::event(
            &event,
            &reservation,
            events.last(),
            index,
            &control.cancelled,
        )?;
        for (column, key) in [
            ("event_id", "eventId"),
            ("attempt_id", "attemptId"),
            ("sequence", "sequence"),
            ("phase", "phase"),
            ("previous_event_hash", "previousEventHash"),
            (
                "event_hash",
                "autonomousResearchOneShotCampaignAttemptEventHash",
            ),
            ("recorded_at", "recordedAt"),
        ] {
            if !row_equals(event_row, column, &event, key)? {
                return Err("campaign_one_shot_attempt_journal_event_invalid".into());
            }
        }
        events.push(event);
    }
    let receipt_rows = rows(
        connection,
        "SELECT attempt_id,receipt_hash,receipt_json,terminal_event_hash,completed_at FROM campaign_one_shot_attempt_terminal_receipts WHERE attempt_id=?1 LIMIT 2",
        [attempt],
        control,
    )?;
    if receipt_rows.len() > 1 {
        return Err("campaign_one_shot_attempt_journal_terminal_receipt_invalid".into());
    }
    let head = events
        .last()
        .ok_or("campaign_one_shot_attempt_journal_event_sequence_invalid")?;
    let terminal = if let Some(receipt_row) = receipt_rows.first() {
        let receipt = raw_row(
            receipt_row,
            "receipt_json",
            "campaign_one_shot_attempt_journal_terminal_receipt_json_invalid",
            control,
        )?;
        if audit::phase(field(head, "phase")) != Some(6) || events.len() < 2 {
            return Err("campaign_one_shot_attempt_journal_terminal_receipt_invalid".into());
        }
        audit::terminal(
            &receipt,
            &reservation,
            &events[events.len() - 2],
            &control.cancelled,
        )?;
        for (column, key) in [
            ("attempt_id", "attemptId"),
            (
                "receipt_hash",
                "autonomousResearchOneShotCampaignAttemptTerminalReceiptHash",
            ),
            ("completed_at", "completedAt"),
        ] {
            if !row_equals(receipt_row, column, &receipt, key)? {
                return Err("campaign_one_shot_attempt_journal_terminal_receipt_invalid".into());
            }
        }
        if !row_equals(
            receipt_row,
            "terminal_event_hash",
            head,
            "autonomousResearchOneShotCampaignAttemptEventHash",
        )? || !same_json(
            field(head, "evidence"),
            &object([(
                "terminalReceiptHash",
                field(
                    &receipt,
                    "autonomousResearchOneShotCampaignAttemptTerminalReceiptHash",
                )
                .clone(),
            )]),
            &control.cancelled,
        ) {
            return Err("campaign_one_shot_attempt_journal_terminal_receipt_invalid".into());
        }
        receipt
    } else {
        if audit::phase(field(head, "phase")) == Some(6) {
            return Err("campaign_one_shot_attempt_journal_terminal_receipt_missing".into());
        }
        Json::Null
    };
    let recovery = audit::disposition(
        &reservation,
        &events,
        terminal.clone(),
        current,
        &control.cancelled,
    )?;
    let head_phase = field(head, "phase").clone();
    let head_hash = field(head, "autonomousResearchOneShotCampaignAttemptEventHash").clone();
    control.checkpoint().map_err(|error| error.to_string())?;
    Ok(object([
        ("version", Json::Number(1.0)),
        ("kind", string("CampaignOneShotAttemptJournalInspection")),
        (
            "status",
            string("campaign_one_shot_attempt_journal_verified"),
        ),
        ("reservation", reservation),
        ("events", Json::Array(events)),
        ("headPhase", head_phase),
        ("headEventHash", head_hash),
        ("terminalReceipt", terminal),
        ("recoveryDisposition", recovery),
    ]))
}
