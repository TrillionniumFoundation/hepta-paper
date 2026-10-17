//! Pure projection into the schema-25 Rust diagnostic wire from blob
//! `c9b9d7686a4c3ca46011ebd785690f4233ca04ac`.
//!
//! This module accepts already-observed values and a caller-claimed database byte hash.
//! It performs no filesystem/SQLite I/O and does not verify that hash or snapshot provenance.
//! Obtain observations through the current owner before projecting; this is not an integrity
//! attestation, Node logical hash, or replacement for current source-preservation checks.

use hepta_codex_protocol::Sha256Digest;
use serde::Serialize;
use thiserror::Error;

use crate::{LogicalDatabaseSnapshotV1, LogicalSqlValueV1, ReadOnlyStoreError, hash_serialized};

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogicalTableV1 {
    pub name: String,
    pub columns: Vec<String>,
    pub row_count: u64,
    pub row_hashes: Vec<String>,
    pub table_hash: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogicalStoreSnapshotV1 {
    pub version: u16,
    pub schema_version: i64,
    pub application_id: i64,
    pub tables: Vec<LogicalTableV1>,
    pub logical_hash: String,
    pub database_content_hash: String,
}

/// Rebuild the earlier row/table/store hashes from a current typed observation.
/// Database byte identity is copied as a claim and is excluded from the logical hash,
/// exactly as in the earlier contract. Current snapshot hashes are not reused.
pub fn from_logical_snapshot(
    snapshot: &LogicalDatabaseSnapshotV1,
    claimed_database_content_hash: &Sha256Digest,
) -> Result<LogicalStoreSnapshotV1, ProjectionError> {
    if snapshot.version != 1 || snapshot.user_version != 25 {
        return Err(ProjectionError::SchemaProfile);
    }
    let mut ordered = snapshot.tables.iter().collect::<Vec<_>>();
    ordered.sort_by(|a, b| a.name.as_bytes().cmp(b.name.as_bytes()));
    if ordered.windows(2).any(|pair| pair[0].name == pair[1].name) {
        return Err(ProjectionError::ValueProfile);
    }
    let mut tables = Vec::new();
    for table in ordered {
        // Original SQL was `name NOT LIKE 'sqlite_%'`: `_` is a wildcard,
        // and ASCII LIKE is case insensitive, unlike a literal starts_with.
        let name = table.name.as_bytes();
        if name.len() >= 7 && name[..6].eq_ignore_ascii_case(b"sqlite") {
            continue;
        }
        if table.name.is_empty() || table.name.contains('\0') {
            return Err(ProjectionError::ValueProfile);
        }
        let mut rows = table
            .rows
            .iter()
            .map(|row| {
                if row.len() != table.columns.len() {
                    return Err(ProjectionError::ValueProfile);
                }
                let cells = row.iter().map(cell).collect::<Result<Vec<_>, _>>()?;
                serde_json::to_vec(&cells).map_err(|_| ProjectionError::ValueProfile)
            })
            .collect::<Result<Vec<_>, _>>()?;
        rows.sort();
        let row_hashes = rows
            .iter()
            .map(|row| {
                // The legacy row domain hashes the encoded array bytes directly.
                let mut hash = sha2::Sha256::new();
                use sha2::Digest;
                crate::update_field(&mut hash, b"HeptaLogicalStoreRowV1");
                crate::update_field(&mut hash, row);
                crate::digest(hash).map(|value| value.as_str().to_owned())
            })
            .collect::<Result<Vec<_>, _>>()?;
        let table_hash = hash_serialized(
            "HeptaLogicalStoreTableV1",
            &(&table.name, &table.columns, &row_hashes),
        )?;
        tables.push(LogicalTableV1 {
            name: table.name.clone(),
            columns: table.columns.clone(),
            row_count: u64::try_from(row_hashes.len())
                .map_err(|_| ProjectionError::ValueProfile)?,
            row_hashes,
            table_hash: table_hash.as_str().to_owned(),
        });
    }
    let logical_hash = hash_serialized(
        "HeptaLogicalStoreSnapshotV1",
        &(25_i64, snapshot.application_id, &tables),
    )?;
    Ok(LogicalStoreSnapshotV1 {
        version: 1,
        schema_version: 25,
        application_id: snapshot.application_id,
        tables,
        logical_hash: logical_hash.as_str().to_owned(),
        database_content_hash: claimed_database_content_hash.as_str().to_owned(),
    })
}

#[derive(Serialize)]
#[serde(tag = "type", content = "value", rename_all = "snake_case")]
enum Cell<'a> {
    Null,
    Integer(String),
    RealBits(String),
    Text(&'a str),
    Blob(&'a str),
}

fn cell(value: &LogicalSqlValueV1) -> Result<Cell<'_>, ProjectionError> {
    Ok(match value {
        LogicalSqlValueV1::Null => Cell::Null,
        LogicalSqlValueV1::Integer(value) => Cell::Integer(value.to_string()),
        LogicalSqlValueV1::Real(value) => {
            let number = value
                .parse::<f64>()
                .map_err(|_| ProjectionError::ValueProfile)?;
            if !number.is_finite() || number.to_string() != *value {
                return Err(ProjectionError::ValueProfile);
            }
            Cell::RealBits(format!("{:016x}", number.to_bits()))
        }
        LogicalSqlValueV1::Text(value) => Cell::Text(value),
        LogicalSqlValueV1::BlobHex(value) => {
            if value.len() % 2 != 0
                || !value
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            {
                return Err(ProjectionError::ValueProfile);
            }
            Cell::Blob(value)
        }
    })
}

#[derive(Debug, Error)]
pub enum ProjectionError {
    #[error("legacy logical projection requires a version-one user_version-25 observation")]
    SchemaProfile,
    #[error("logical value is outside the current-to-legacy projection profile")]
    ValueProfile,
    #[error(transparent)]
    Encoding(#[from] ReadOnlyStoreError),
}
