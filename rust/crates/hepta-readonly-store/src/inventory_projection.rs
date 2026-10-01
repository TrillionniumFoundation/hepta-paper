//! Closed business read projection, separate from the complete logical hash profile.
use crate::{
    OrdinaryReadOnlyStoreV1, ReadOnlyStoreError, node_receipts::NodeValue,
    node_snapshot::cell_bytes,
};
use rusqlite::{Connection, types::ValueRef};
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;

/// Closed profile v1; callers cannot enlarge its fixed safety limits.
#[derive(Clone, Copy, Debug, Default)]
pub struct FixedInventoryBudgetV1 {
    _private: (),
}
impl FixedInventoryBudgetV1 {
    pub const VERSION: u8 = 1;
    pub const MAXIMUM_ROWS: usize = 1024;
    pub const MAXIMUM_CELL_BYTES: usize = 64 * 1024;
    pub const MAXIMUM_OUTPUT_BYTES: usize = 4 * 1024 * 1024;
}
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct InventoryPaperRowV1 {
    pub slug: Box<RawValue>,
    pub title: Box<RawValue>,
    pub status: Box<RawValue>,
    pub venue_target: Box<RawValue>,
    pub paper_type: Box<RawValue>,
    pub canonical_dir: Box<RawValue>,
    pub source_dir: Box<RawValue>,
    pub current_pdf: Box<RawValue>,
    pub current_source_zip: Box<RawValue>,
    pub current_verdict: Box<RawValue>,
    pub next_action: Box<RawValue>,
    pub updated_at: Box<RawValue>,
    pub metadata_json: Box<RawValue>,
    pub campaign_local_only: Box<RawValue>,
    pub ledger_lifecycle_stage: Box<RawValue>,
    pub ledger_submission_state: Box<RawValue>,
    pub ledger_next_action: Box<RawValue>,
    pub ledger_evidence_json: Box<RawValue>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct InventoryVenueRowV1 {
    pub venue_id: Box<RawValue>,
    pub name: Box<RawValue>,
    pub kind: Box<RawValue>,
    pub cycle: Box<RawValue>,
    pub deadline: Box<RawValue>,
    pub metadata_json: Box<RawValue>,
}
#[derive(Clone, Debug, Serialize)]
pub struct FixedInventoryQueryV1<T> {
    pub ok: bool,
    pub rows: Vec<T>,
    pub error: Option<String>,
}
#[derive(Clone, Debug, Serialize)]
pub struct FixedInventoryProjectionV1 {
    pub version: u8,
    pub papers: FixedInventoryQueryV1<InventoryPaperRowV1>,
    pub venues: FixedInventoryQueryV1<InventoryVenueRowV1>,
}

const PAPERS: &str = "SELECT p.slug,p.title,p.status,p.venue_target,p.paper_type,p.canonical_dir,p.source_dir,p.current_pdf,p.current_source_zip,p.current_verdict,p.next_action,p.updated_at,p.metadata_json, CASE WHEN json_extract(c.spec_json,'$.localOnly')=1 THEN 1 ELSE 0 END AS campaign_local_only, l.lifecycle_stage AS ledger_lifecycle_stage,l.submission_state AS ledger_submission_state,l.next_action AS ledger_next_action,l.evidence_json AS ledger_evidence_json FROM papers p LEFT JOIN submission_ledger l ON p.slug=l.slug LEFT JOIN paper_campaigns c ON c.campaign_id=json_extract(p.metadata_json,'$.campaignId') AND c.paper_id=p.slug ORDER BY p.slug";
const VENUES: &str =
    "SELECT venue_id,name,kind,cycle,deadline,metadata_json FROM venues ORDER BY venue_id";

fn preflight(connection: &Connection, tables: &[&str]) -> Result<(), ReadOnlyStoreError> {
    for table in tables {
        let count: i64 = connection.query_row(
            &format!("SELECT count(*) FROM (SELECT 1 FROM \"{table}\" LIMIT 1025)"),
            [],
            |row| row.get(0),
        )?;
        if count > FixedInventoryBudgetV1::MAXIMUM_ROWS as i64 {
            return Err(ReadOnlyStoreError::OrdinaryBudgetExceeded(
                "inventory_input_rows_v1",
            ));
        }
    }
    Ok(())
}
fn encoded_bound(value: ValueRef<'_>) -> usize {
    // Reserve a conservative JSON bound from borrowed values before copying them.
    match value {
        ValueRef::Text(bytes) => bytes.len().saturating_mul(6).saturating_add(2),
        ValueRef::Blob(bytes) => bytes.len().saturating_mul(16).saturating_add(2),
        _ => 32,
    }
}
fn project<T: serde::de::DeserializeOwned>(
    connection: &Connection,
    sql: &str,
    tables: &[&str],
    remaining: &mut usize,
    control: &crate::ordinary::ReadControl,
) -> Result<Vec<T>, ReadOnlyStoreError> {
    control.check()?;
    preflight(connection, tables)?;
    // Count a bounded unsorted join before SQLite can materialize the full
    // ordered result. Individually bounded tables can still form a huge join.
    let (unordered, _) = sql
        .rsplit_once(" ORDER BY ")
        .ok_or(ReadOnlyStoreError::InvalidTableName)?;
    let joined: i64 = connection.query_row(
        &format!("SELECT count(*) FROM (SELECT 1 FROM ({unordered}) LIMIT 1025)"),
        [],
        |row| row.get(0),
    )?;
    if joined > FixedInventoryBudgetV1::MAXIMUM_ROWS as i64 {
        return Err(ReadOnlyStoreError::OrdinaryBudgetExceeded(
            "inventory_joined_rows_v1",
        ));
    }
    let mut statement = connection.prepare(sql)?;
    let columns = statement
        .column_names()
        .iter()
        .map(|name| (*name).to_owned())
        .collect::<Vec<_>>();
    let mut rows = statement.query([])?;
    let mut output = Vec::new();
    let mut local_remaining = *remaining;
    while let Some(row) = rows.next()? {
        control.check()?;
        if output.len() >= FixedInventoryBudgetV1::MAXIMUM_ROWS {
            return Err(ReadOnlyStoreError::OrdinaryBudgetExceeded(
                "inventory_output_rows_v1",
            ));
        }
        let mut bound = 2_usize;
        for (index, name) in columns.iter().enumerate() {
            let value = row.get_ref(index)?;
            if cell_bytes(value) > FixedInventoryBudgetV1::MAXIMUM_CELL_BYTES {
                return Err(ReadOnlyStoreError::OrdinaryBudgetExceeded(
                    "inventory_cell_bytes_v1",
                ));
            }
            bound = bound
                .checked_add(encoded_bound(value) + name.len() + 4)
                .ok_or(ReadOnlyStoreError::NumericOverflow)?;
        }
        if bound > local_remaining {
            return Err(ReadOnlyStoreError::OrdinaryBudgetExceeded(
                "inventory_preallocation_bytes_v1",
            ));
        }
        let mut raw = String::from("{");
        for (index, name) in columns.iter().enumerate() {
            if index != 0 {
                raw.push(',');
            }
            raw.push_str(
                &serde_json::to_string(name).map_err(|_| ReadOnlyStoreError::Serialization)?,
            );
            raw.push(':');
            raw.push_str(NodeValue::from_sql(row.get_ref(index)?, true)?.json());
        }
        raw.push('}');
        local_remaining = local_remaining.checked_sub(raw.len() + 1).ok_or(
            ReadOnlyStoreError::OrdinaryBudgetExceeded("inventory_output_bytes_v1"),
        )?;
        output.push(serde_json::from_str(&raw).map_err(|_| ReadOnlyStoreError::Serialization)?);
    }
    *remaining = local_remaining;
    Ok(output)
}
fn outcome<T>(result: Result<Vec<T>, ReadOnlyStoreError>) -> FixedInventoryQueryV1<T> {
    match result {
        Ok(rows) => FixedInventoryQueryV1 {
            ok: true,
            rows,
            error: None,
        },
        Err(error) => {
            let message = match &error {
                ReadOnlyStoreError::Sqlite(rusqlite::Error::SqliteFailure(_, Some(message)))
                | ReadOnlyStoreError::Sqlite(rusqlite::Error::SqlInputError {
                    msg: message, ..
                }) => message.clone(),
                _ => error.to_string(),
            };
            FixedInventoryQueryV1 {
                ok: false,
                rows: Vec::new(),
                error: Some(message),
            }
        }
    }
}
impl OrdinaryReadOnlyStoreV1 {
    pub fn fixed_inventory_projection_v1(
        &self,
        _budget: &FixedInventoryBudgetV1,
    ) -> Result<FixedInventoryProjectionV1, ReadOnlyStoreError> {
        self.verify_unchanged()?;
        // Reserve fixed report/query framing before either bounded query allocates rows.
        let mut remaining = FixedInventoryBudgetV1::MAXIMUM_OUTPUT_BYTES - 4096;
        let papers = outcome(project(
            &self.connection,
            PAPERS,
            &["papers", "submission_ledger", "paper_campaigns"],
            &mut remaining,
            &self.control,
        ));
        let venues = outcome(project(
            &self.connection,
            VENUES,
            &["venues"],
            &mut remaining,
            &self.control,
        ));
        self.verify_unchanged()?;
        Ok(FixedInventoryProjectionV1 {
            version: 1,
            papers,
            venues,
        })
    }
}
