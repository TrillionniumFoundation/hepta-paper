//! Streaming production logical hashes; no schema authority is conferred here.
use hepta_legacy_compatibility::{parse_and_digest_production_v1, parse_and_encode_production_v1};
use rusqlite::{Connection, Row, types::ValueRef};
use sha2::{Digest, Sha256};

use crate::{
    NodeLogicalSnapshotV1, NodeLogicalTableV1, ReadOnlyStoreError, digest,
    node_receipts::NodeValue, quote_identifier,
};

pub(crate) const CELL_BYTES: usize = 1024 * 1024;
const ROW_BYTES: usize = 16 * 1024 * 1024;
const TOTAL_INPUT_BYTES: u64 = 4 * 1024 * 1024 * 1024;
const SCHEMA_BYTES: usize = 2 * 1024 * 1024;
const TABLE_METADATA_BYTES: usize = 2 * 1024 * 1024;

struct BoundedCounter {
    remaining: usize,
}
impl std::io::Write for BoundedCounter {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if bytes.len() > self.remaining {
            return Err(std::io::Error::other("bounded_serialization"));
        }
        self.remaining -= bytes.len();
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
pub(crate) fn validate_serialized_budget<T: serde::Serialize>(
    value: &T,
    limit: usize,
    scope: &'static str,
) -> Result<(), ReadOnlyStoreError> {
    serde_json::to_writer(BoundedCounter { remaining: limit }, value)
        .map_err(|_| ReadOnlyStoreError::OrdinaryBudgetExceeded(scope))
}
fn preallocation_bound(row: &Row<'_>, columns: usize) -> Result<usize, ReadOnlyStoreError> {
    let mut bound = 256_usize;
    for index in 0..columns {
        bound = bound
            .checked_add(cell_bytes(row.get_ref(index)?).saturating_mul(6))
            .ok_or(ReadOnlyStoreError::NumericOverflow)?;
    }
    Ok(bound)
}

pub(crate) fn cell_bytes(value: ValueRef<'_>) -> usize {
    match value {
        ValueRef::Text(bytes) | ValueRef::Blob(bytes) => bytes.len(),
        _ => 8,
    }
}

pub(crate) fn raw_row(
    row: &Row<'_>,
    columns: &[String],
    lossy: bool,
    total: &mut u64,
    cell_limit: usize,
) -> Result<String, ReadOnlyStoreError> {
    let mut bytes = 0_usize;
    // Inspect borrowed SQLite values before any text/BLOB allocation.
    for index in 0..columns.len() {
        let length = cell_bytes(row.get_ref(index)?);
        if length > cell_limit {
            return Err(ReadOnlyStoreError::OrdinaryBudgetExceeded("cell_bytes_v1"));
        }
        bytes = bytes
            .checked_add(length)
            .ok_or(ReadOnlyStoreError::NumericOverflow)?;
    }
    if bytes > ROW_BYTES {
        return Err(ReadOnlyStoreError::OrdinaryBudgetExceeded("row_bytes_v1"));
    }
    *total = total
        .checked_add(bytes as u64)
        .ok_or(ReadOnlyStoreError::NumericOverflow)?;
    if *total > TOTAL_INPUT_BYTES {
        return Err(ReadOnlyStoreError::OrdinaryBudgetExceeded(
            "total_input_bytes_v1",
        ));
    }
    let mut raw = String::from("{");
    for (index, column) in columns.iter().enumerate() {
        if index != 0 {
            raw.push(',');
        }
        raw.push_str(
            &serde_json::to_string(column).map_err(|_| ReadOnlyStoreError::Serialization)?,
        );
        raw.push(':');
        raw.push_str(NodeValue::from_sql(row.get_ref(index)?, lossy)?.json());
        if raw.len() > ROW_BYTES {
            return Err(ReadOnlyStoreError::OrdinaryBudgetExceeded(
                "encoded_row_bytes_v1",
            ));
        }
    }
    raw.push('}');
    Ok(raw)
}

pub(crate) fn capture(
    connection: &Connection,
    schema_version: u32,
    lossy: bool,
    check: &dyn Fn() -> Result<(), ReadOnlyStoreError>,
) -> Result<NodeLogicalSnapshotV1, ReadOnlyStoreError> {
    check()?;
    let mut schema_query = connection.prepare("SELECT type,name,tbl_name,coalesce(sql,'') AS sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name,tbl_name")?;
    let mut schema_cursor = schema_query.query([])?;
    let mut schema_rows = String::from("[");
    let mut table_names = Vec::new();
    let mut schema_count = 0;
    let mut total = 0;
    while let Some(row) = schema_cursor.next()? {
        check()?;
        if schema_count >= crate::MAXIMUM_TABLES {
            return Err(ReadOnlyStoreError::SchemaObjectLimitExceeded);
        }
        if preallocation_bound(row, 4)? > SCHEMA_BYTES.saturating_sub(schema_rows.len()) {
            return Err(ReadOnlyStoreError::OrdinaryBudgetExceeded(
                "schema_preallocation_bytes_v1",
            ));
        }
        let raw = raw_row(
            row,
            &[
                "type".into(),
                "name".into(),
                "tbl_name".into(),
                "sql".into(),
            ],
            lossy,
            &mut total,
            CELL_BYTES,
        )?;
        if schema_count != 0 {
            schema_rows.push(',');
        }
        schema_rows.push_str(&raw);
        if row.get::<_, String>(0)? == "table" {
            table_names.push(row.get::<_, String>(1)?);
        }
        schema_count += 1;
    }
    schema_rows.push(']');
    let mut tables = Vec::new();
    let mut table_metadata_bytes = 0_usize;
    for name in table_names {
        check()?;
        let mut column_query =
            connection.prepare("SELECT name,pk FROM pragma_table_info(?1) ORDER BY cid")?;
        let mut cursor = column_query.query([&name])?;
        let mut columns = Vec::new();
        while let Some(row) = cursor.next()? {
            check()?;
            let length = cell_bytes(row.get_ref(0)?);
            table_metadata_bytes = table_metadata_bytes
                .checked_add(length.saturating_mul(24) + 128)
                .ok_or(ReadOnlyStoreError::NumericOverflow)?;
            if columns.len() >= 2048 || table_metadata_bytes > TABLE_METADATA_BYTES {
                return Err(ReadOnlyStoreError::OrdinaryBudgetExceeded(
                    "table_metadata_preallocation_bytes_v1",
                ));
            }
            columns.push((row.get::<_, String>(0)?, row.get::<_, u32>(1)?));
        }
        let mut keys = columns.iter().filter(|(_, pk)| *pk > 0).collect::<Vec<_>>();
        keys.sort_by_key(|(_, pk)| *pk);
        let primary_key = keys
            .iter()
            .map(|(name, _)| name.clone())
            .collect::<Vec<_>>();
        let names = columns
            .iter()
            .map(|(name, _)| name.clone())
            .collect::<Vec<_>>();
        let order_names = if primary_key.is_empty() {
            &names
        } else {
            &primary_key
        };
        let order = if order_names.is_empty() {
            String::new()
        } else {
            format!(
                " ORDER BY {}",
                order_names
                    .iter()
                    .map(|name| quote_identifier(name))
                    .collect::<Vec<_>>()
                    .join(",")
            )
        };
        let count: i64 = connection.query_row(
            &format!("SELECT count(*) FROM {}", quote_identifier(&name)),
            [],
            |row| row.get(0),
        )?;
        let count = u64::try_from(count).map_err(|_| ReadOnlyStoreError::NumericOverflow)?;
        if count > crate::MAXIMUM_ROWS_PER_TABLE as u64 {
            return Err(ReadOnlyStoreError::RowLimitExceeded(name));
        }
        let mut query =
            connection.prepare(&format!("SELECT * FROM {}{order}", quote_identifier(&name)))?;
        let mut rows = query.query([])?;
        let mut observed = 0;
        let mut hash = Sha256::new();
        hash.update(b"{\"kind\":\"SqliteCanonicalRows\",\"value\":[");
        while let Some(row) = rows.next()? {
            check()?;
            if observed >= count {
                return Err(ReadOnlyStoreError::DatabaseChanged);
            }
            let raw = raw_row(row, &names, lossy, &mut total, CELL_BYTES)?;
            if observed != 0 {
                hash.update(b",");
            }
            hash.update(parse_and_encode_production_v1(raw.as_bytes())?);
            observed += 1;
        }
        if observed != count {
            return Err(ReadOnlyStoreError::DatabaseChanged);
        }
        hash.update(b"]}");
        tables.push(NodeLogicalTableV1 {
            name,
            row_count: count,
            primary_key,
            canonical_rows_hash: digest(hash)?,
        });
    }
    let schema_hash = parse_and_digest_production_v1(
        format!("{{\"kind\":\"SqliteSchema\",\"value\":{schema_rows}}}").as_bytes(),
    )?
    .as_str()
    .parse()
    .map_err(|_| ReadOnlyStoreError::DigestConstruction)?;
    validate_serialized_budget(&tables, TABLE_METADATA_BYTES, "table_metadata_bytes_v1")?;
    let table_json =
        serde_json::to_string(&tables).map_err(|_| ReadOnlyStoreError::Serialization)?;
    let logical_database_hash = parse_and_digest_production_v1(format!("{{\"kind\":\"SqliteLogicalDatabase\",\"value\":{{\"schemaRows\":{schema_rows},\"tables\":{table_json}}}}}").as_bytes())?.as_str().parse().map_err(|_| ReadOnlyStoreError::DigestConstruction)?;
    Ok(NodeLogicalSnapshotV1 {
        schema_version,
        table_count: tables.len(),
        total_row_count: tables.iter().map(|table| table.row_count).sum(),
        schema_hash,
        logical_database_hash,
        tables,
    })
}
