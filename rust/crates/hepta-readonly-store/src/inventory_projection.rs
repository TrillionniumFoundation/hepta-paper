//! Closed business read projection, separate from the complete logical hash profile.
use crate::{
    OrdinaryReadOnlyStoreV1, ReadOnlyStoreError, ReadOnlyStoreV1, node_receipts::NodeValue,
    node_snapshot::cell_bytes,
};
use rusqlite::{Connection, types::ValueRef};
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use std::collections::BTreeMap;

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
/// Actual SQLite cell coercion, captured from the existing NodeValue owner.
/// This metadata is deliberately absent from the ordinary JSON report wire.
#[derive(Clone, Debug)]
pub struct InventorySqlCellCoercionV1 {
    pub string: String,
    pub truthy: bool,
}

trait RetainSqlCoercion {
    fn retain_sql_coercion(&mut self, values: BTreeMap<String, InventorySqlCellCoercionV1>);
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct InventoryPaperRowV1 {
    #[serde(skip)]
    sql_coercions: BTreeMap<String, InventorySqlCellCoercionV1>,
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
    #[serde(skip)]
    sql_coercions: BTreeMap<String, InventorySqlCellCoercionV1>,
    pub venue_id: Box<RawValue>,
    pub name: Box<RawValue>,
    pub kind: Box<RawValue>,
    pub cycle: Box<RawValue>,
    pub deadline: Box<RawValue>,
    pub metadata_json: Box<RawValue>,
}
impl InventoryPaperRowV1 {
    pub fn sql_coercions(&self) -> &BTreeMap<String, InventorySqlCellCoercionV1> {
        &self.sql_coercions
    }
}
impl InventoryVenueRowV1 {
    pub fn sql_coercions(&self) -> &BTreeMap<String, InventorySqlCellCoercionV1> {
        &self.sql_coercions
    }
}
impl RetainSqlCoercion for InventoryPaperRowV1 {
    fn retain_sql_coercion(&mut self, values: BTreeMap<String, InventorySqlCellCoercionV1>) {
        self.sql_coercions = values;
    }
}
impl RetainSqlCoercion for InventoryVenueRowV1 {
    fn retain_sql_coercion(&mut self, values: BTreeMap<String, InventorySqlCellCoercionV1>) {
        self.sql_coercions = values;
    }
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
fn coercion_bound(value: ValueRef<'_>) -> usize {
    match value {
        ValueRef::Text(bytes) => bytes.len().saturating_mul(3),
        ValueRef::Blob(bytes) => bytes.len().saturating_mul(4),
        ValueRef::Null => 0,
        _ => 32,
    }
}

fn project<T: serde::de::DeserializeOwned + RetainSqlCoercion>(
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
                .checked_add(encoded_bound(value) + coercion_bound(value) + name.len() + 4)
                .ok_or(ReadOnlyStoreError::NumericOverflow)?;
        }
        if bound > local_remaining {
            return Err(ReadOnlyStoreError::OrdinaryBudgetExceeded(
                "inventory_preallocation_bytes_v1",
            ));
        }
        let mut raw = String::from("{");
        let mut coercions = BTreeMap::new();
        let mut coercion_bytes = 0_usize;
        for (index, name) in columns.iter().enumerate() {
            if index != 0 {
                raw.push(',');
            }
            raw.push_str(
                &serde_json::to_string(name).map_err(|_| ReadOnlyStoreError::Serialization)?,
            );
            raw.push(':');
            let value = NodeValue::from_sql(row.get_ref(index)?, true)?;
            raw.push_str(value.json());
            let string = value.inventory_string();
            coercion_bytes = coercion_bytes
                .checked_add(string.len())
                .ok_or(ReadOnlyStoreError::NumericOverflow)?;
            coercions.insert(
                name.clone(),
                InventorySqlCellCoercionV1 {
                    string,
                    truthy: value.inventory_truthy(),
                },
            );
        }
        raw.push('}');
        local_remaining = local_remaining
            .checked_sub(raw.len() + coercion_bytes + 1)
            .ok_or(ReadOnlyStoreError::OrdinaryBudgetExceeded(
                "inventory_output_bytes_v1",
            ))?;
        let mut projected: T =
            serde_json::from_str(&raw).map_err(|_| ReadOnlyStoreError::Serialization)?;
        projected.retain_sql_coercion(coercions);
        output.push(projected);
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
fn fixed_projection(
    connection: &Connection,
    control: &crate::ordinary::ReadControl,
) -> FixedInventoryProjectionV1 {
    // One bounded SQL owner for ordinary and explicitly immutable profiles.
    let mut remaining = FixedInventoryBudgetV1::MAXIMUM_OUTPUT_BYTES - 4096;
    let papers = outcome(project(
        connection,
        PAPERS,
        &["papers", "submission_ledger", "paper_campaigns"],
        &mut remaining,
        control,
    ));
    let venues = outcome(project(
        connection,
        VENUES,
        &["venues"],
        &mut remaining,
        control,
    ));
    FixedInventoryProjectionV1 {
        version: 1,
        papers,
        venues,
    }
}
impl OrdinaryReadOnlyStoreV1 {
    pub fn fixed_inventory_projection_v1(
        &self,
        _budget: &FixedInventoryBudgetV1,
    ) -> Result<FixedInventoryProjectionV1, ReadOnlyStoreError> {
        self.verify_unchanged()?;
        let result = fixed_projection(&self.connection, &self.control);
        self.verify_unchanged()?;
        Ok(result)
    }
}
impl ReadOnlyStoreV1 {
    /// Reuses the same fixed business queries without creating SQLite sidecars.
    pub fn fixed_inventory_projection_with_cancellation_v1(
        &self,
        _budget: &FixedInventoryBudgetV1,
        cancelled: std::sync::Arc<std::sync::atomic::AtomicBool>,
        deadline: std::time::Instant,
    ) -> Result<FixedInventoryProjectionV1, ReadOnlyStoreError> {
        let control = crate::ordinary::ReadControl::new(cancelled, deadline);
        control.check()?;
        self.verify_unchanged()?;
        let result = fixed_projection(&self.connection, &control);
        control.check()?;
        self.verify_unchanged()?;
        Ok(result)
    }
}
