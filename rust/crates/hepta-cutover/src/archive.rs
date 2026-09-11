//! Complete Rust-native historical projection of the retired Node schema-25 store.
//!
//! The cutover remains forward-only: this module never mutates the incumbent
//! database and never recreates Node write authority. It captures every validated
//! schema object and every typed row through `hepta-readonly-store`, emits a
//! self-verifying archive artifact, and lets Rust serve historical reads after
//! Node retirement.

use std::{
    collections::{BTreeMap, BTreeSet},
    path::Path,
};

use hepta_codex_protocol::Sha256Digest;
use hepta_readonly_control::DatabaseFormatV1;
use hepta_readonly_store::{LogicalDatabaseSnapshotV1, LogicalTableV1, ReadOnlyStoreV1};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;

use crate::VerifiedLegacyNodeFreezeV1;

const REQUIRED_NODE_SCHEMA_VERSION: u32 = 25;
const MAXIMUM_ARCHIVE_BYTES: usize = 1024 * 1024 * 1024;
const MAXIMUM_TABLES: usize = 4096;
const MAXIMUM_COLUMNS_PER_TABLE: usize = 4096;

/// Complete immutable Rust-readable archive of one retired Node database.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LegacyArchiveProjectionV1 {
    /// Contract version, exactly one.
    pub version: u16,
    /// Exact immutable source SQLite bytes.
    pub source_database_content_hash: Sha256Digest,
    /// Full validated typed source snapshot including all schema objects and rows.
    pub source_snapshot: LogicalDatabaseSnapshotV1,
    /// Deterministic table-name to table-vector index.
    pub table_index: BTreeMap<String, usize>,
    /// Total retained rows across all tables.
    pub total_row_count: u64,
    /// Canonical identity over every preceding field.
    pub projection_hash: Sha256Digest,
}

impl LegacyArchiveProjectionV1 {
    /// Reads an immutable schema-25 Node database entirely in Rust and captures
    /// a complete typed archive projection.
    pub fn open(database_path: impl AsRef<Path>) -> Result<Self, LegacyArchiveError> {
        let store = ReadOnlyStoreV1::open(database_path).map_err(|_| LegacyArchiveError::Source)?;
        if store.schema_version() != REQUIRED_NODE_SCHEMA_VERSION {
            return Err(LegacyArchiveError::SchemaVersion);
        }
        let source_database_content_hash = store.database_content_hash().clone();
        let source_snapshot = store
            .logical_snapshot()
            .map_err(|_| LegacyArchiveError::Source)?;
        store
            .verify_unchanged()
            .map_err(|_| LegacyArchiveError::Source)?;
        build_projection(source_database_content_hash, source_snapshot)
    }

    /// Decodes a retained projection without consulting Node and verifies its
    /// complete content identity before exposing historical rows.
    pub fn decode_json(bytes: &[u8]) -> Result<Self, LegacyArchiveError> {
        if bytes.is_empty() || bytes.len() > MAXIMUM_ARCHIVE_BYTES {
            return Err(LegacyArchiveError::ArchiveSize);
        }
        let projection: Self =
            serde_json::from_slice(bytes).map_err(|_| LegacyArchiveError::Encoding)?;
        projection.validate()?;
        Ok(projection)
    }

    /// Encodes the complete archive artifact using deterministic struct and
    /// BTreeMap ordering.
    pub fn encode_json(&self) -> Result<Vec<u8>, LegacyArchiveError> {
        self.validate()?;
        let bytes = serde_json::to_vec(self).map_err(|_| LegacyArchiveError::Encoding)?;
        if bytes.len() > MAXIMUM_ARCHIVE_BYTES {
            return Err(LegacyArchiveError::ArchiveSize);
        }
        Ok(bytes)
    }

    /// Returns one complete historical table by exact name.
    #[must_use]
    pub fn table(&self, name: &str) -> Option<&LogicalTableV1> {
        self.table_index
            .get(name)
            .and_then(|index| self.source_snapshot.tables.get(*index))
    }

    /// Binds this archive to the exact database already accepted by the Node
    /// quiescence/freeze verifier.
    pub fn assert_matches_freeze(
        &self,
        freeze: &VerifiedLegacyNodeFreezeV1,
    ) -> Result<(), LegacyArchiveError> {
        self.validate()?;
        if &self.source_database_content_hash != freeze.database_content_hash()
            || &self.source_snapshot.logical_hash != freeze.logical_database_hash()
        {
            return Err(LegacyArchiveError::FreezeMismatch);
        }
        Ok(())
    }

    /// Verifies that no table/schema/row was removed or reordered without
    /// changing the archive identity.
    pub fn validate(&self) -> Result<(), LegacyArchiveError> {
        validate_snapshot(&self.source_snapshot)?;
        let (table_index, total_row_count) = index_tables(&self.source_snapshot)?;
        if self.version != 1
            || self.table_index != table_index
            || self.total_row_count != total_row_count
        {
            return Err(LegacyArchiveError::ProjectionInvalid);
        }
        let body = ProjectionBodyV1 {
            version: self.version,
            source_database_content_hash: &self.source_database_content_hash,
            source_snapshot: &self.source_snapshot,
            table_index: &self.table_index,
            total_row_count: self.total_row_count,
        };
        if hash_serialized("HeptaLegacyArchiveProjectionV1", &body)? != self.projection_hash {
            return Err(LegacyArchiveError::ProjectionHash);
        }
        Ok(())
    }
}

fn build_projection(
    source_database_content_hash: Sha256Digest,
    source_snapshot: LogicalDatabaseSnapshotV1,
) -> Result<LegacyArchiveProjectionV1, LegacyArchiveError> {
    validate_snapshot(&source_snapshot)?;
    let (table_index, total_row_count) = index_tables(&source_snapshot)?;
    let body = ProjectionBodyV1 {
        version: 1,
        source_database_content_hash: &source_database_content_hash,
        source_snapshot: &source_snapshot,
        table_index: &table_index,
        total_row_count,
    };
    let projection_hash = hash_serialized("HeptaLegacyArchiveProjectionV1", &body)?;
    Ok(LegacyArchiveProjectionV1 {
        version: 1,
        source_database_content_hash,
        source_snapshot,
        table_index,
        total_row_count,
        projection_hash,
    })
}

fn validate_snapshot(snapshot: &LogicalDatabaseSnapshotV1) -> Result<(), LegacyArchiveError> {
    if snapshot.version != 1
        || snapshot.application_id != 0
        || snapshot.user_version != 0
        || snapshot.schema.format != DatabaseFormatV1::NodeMigrationLedger
        || snapshot.schema.schema_version != REQUIRED_NODE_SCHEMA_VERSION
        || snapshot.schema.user_version != 0
        || snapshot.schema.application_id != 0
        || snapshot.schema.local_only
        || snapshot.tables.len() > MAXIMUM_TABLES
    {
        return Err(LegacyArchiveError::SchemaVersion);
    }
    let mut schema_ids = BTreeSet::new();
    for object in &snapshot.schema_objects {
        if object.object_type.is_empty()
            || object.name.is_empty()
            || object.table_name.is_empty()
            || !schema_ids.insert((
                object.object_type.as_str(),
                object.name.as_str(),
                object.table_name.as_str(),
            ))
        {
            return Err(LegacyArchiveError::ProjectionInvalid);
        }
    }
    for table in &snapshot.tables {
        if table.name.is_empty()
            || table.columns.is_empty()
            || table.columns.len() > MAXIMUM_COLUMNS_PER_TABLE
            || table.columns.iter().any(String::is_empty)
            || table.columns.iter().collect::<BTreeSet<_>>().len() != table.columns.len()
            || table
                .rows
                .iter()
                .any(|row| row.len() != table.columns.len())
        {
            return Err(LegacyArchiveError::ProjectionInvalid);
        }
    }
    Ok(())
}

fn index_tables(
    snapshot: &LogicalDatabaseSnapshotV1,
) -> Result<(BTreeMap<String, usize>, u64), LegacyArchiveError> {
    let mut table_index = BTreeMap::new();
    let mut total_row_count = 0_u64;
    for (index, table) in snapshot.tables.iter().enumerate() {
        if table_index.insert(table.name.clone(), index).is_some() {
            return Err(LegacyArchiveError::ProjectionInvalid);
        }
        total_row_count = total_row_count
            .checked_add(u64::try_from(table.rows.len()).map_err(|_| LegacyArchiveError::Overflow)?)
            .ok_or(LegacyArchiveError::Overflow)?;
    }
    Ok((table_index, total_row_count))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectionBodyV1<'a> {
    version: u16,
    source_database_content_hash: &'a Sha256Digest,
    source_snapshot: &'a LogicalDatabaseSnapshotV1,
    table_index: &'a BTreeMap<String, usize>,
    total_row_count: u64,
}

fn hash_serialized<T: Serialize>(
    domain: &str,
    value: &T,
) -> Result<Sha256Digest, LegacyArchiveError> {
    let bytes = serde_json::to_vec(value).map_err(|_| LegacyArchiveError::Encoding)?;
    let mut hasher = Sha256::new();
    update_field(&mut hasher, domain.as_bytes());
    update_field(&mut hasher, &bytes);
    format!("sha256:{}", hex::encode(hasher.finalize()))
        .parse()
        .map_err(|_| LegacyArchiveError::Encoding)
}

fn update_field(hasher: &mut Sha256, value: &[u8]) {
    hasher.update(u64::try_from(value.len()).unwrap_or(u64::MAX).to_be_bytes());
    hasher.update(value);
}

/// Complete-archive construction or validation failure.
#[derive(Clone, Debug, Error, Eq, PartialEq)]
pub enum LegacyArchiveError {
    /// The immutable source database could not be validated or remained unstable.
    #[error("legacy archive source database is invalid")]
    Source,
    /// Only the fully migrated Node schema-25 source is accepted for retirement.
    #[error("legacy archive requires Node schema version 25")]
    SchemaVersion,
    /// A schema object, table, column, or row shape is inconsistent.
    #[error("legacy archive projection is invalid")]
    ProjectionInvalid,
    /// The retained archive does not match its canonical content identity.
    #[error("legacy archive projection hash mismatch")]
    ProjectionHash,
    /// The archive does not bind the exact database accepted by the freeze receipt.
    #[error("legacy archive does not match the freeze subject")]
    FreezeMismatch,
    /// Archive encoding/decoding failed.
    #[error("legacy archive encoding failed")]
    Encoding,
    /// The retained archive exceeds the bounded artifact size.
    #[error("legacy archive exceeds size limit")]
    ArchiveSize,
    /// Row-count arithmetic overflowed.
    #[error("legacy archive count overflow")]
    Overflow,
}

#[cfg(test)]
mod tests {
    use super::*;
    use hepta_readonly_control::DatabaseSchemaV1;
    use hepta_readonly_store::{LogicalSchemaObjectV1, LogicalSqlValueV1, LogicalTableV1};

    fn digest(byte: char) -> Sha256Digest {
        format!("sha256:{}", byte.to_string().repeat(64))
            .parse()
            .expect("digest")
    }

    fn snapshot() -> LogicalDatabaseSnapshotV1 {
        LogicalDatabaseSnapshotV1 {
            version: 1,
            application_id: 0,
            user_version: 0,
            schema: DatabaseSchemaV1 {
                format: DatabaseFormatV1::NodeMigrationLedger,
                schema_version: 25,
                user_version: 0,
                application_id: 0,
                local_only: false,
            },
            schema_objects: vec![LogicalSchemaObjectV1 {
                object_type: "table".into(),
                name: "paper_campaigns".into(),
                table_name: "paper_campaigns".into(),
                sql: "CREATE TABLE paper_campaigns(id TEXT,status TEXT)".into(),
            }],
            tables: vec![LogicalTableV1 {
                name: "paper_campaigns".into(),
                columns: vec!["id".into(), "status".into()],
                rows: vec![vec![
                    LogicalSqlValueV1::Text("campaign-1".into()),
                    LogicalSqlValueV1::Text("completed".into()),
                ]],
                table_hash: digest('b'),
            }],
            logical_hash: digest('c'),
        }
    }

    #[test]
    fn complete_projection_round_trips_without_node_runtime() {
        let projection = build_projection(digest('a'), snapshot()).expect("projection");
        assert_eq!(projection.total_row_count, 1);
        assert_eq!(
            projection
                .table("paper_campaigns")
                .expect("table")
                .rows
                .len(),
            1
        );
        let bytes = projection.encode_json().expect("encode");
        let decoded = LegacyArchiveProjectionV1::decode_json(&bytes).expect("decode");
        assert_eq!(decoded, projection);
    }

    #[test]
    fn projection_rejects_duplicate_tables_and_pre_schema_25_state() {
        let mut duplicate = snapshot();
        duplicate.tables.push(duplicate.tables[0].clone());
        assert_eq!(
            build_projection(digest('a'), duplicate).expect_err("duplicate table"),
            LegacyArchiveError::ProjectionInvalid
        );
        let mut old = snapshot();
        old.schema.schema_version = 24;
        assert_eq!(
            build_projection(digest('a'), old).expect_err("old schema"),
            LegacyArchiveError::SchemaVersion
        );
    }

    #[test]
    fn any_retained_row_mutation_breaks_the_projection_hash() {
        let mut projection = build_projection(digest('a'), snapshot()).expect("projection");
        projection.source_snapshot.tables[0].rows[0][1] = LogicalSqlValueV1::Text("failed".into());
        assert_eq!(
            projection.validate(),
            Err(LegacyArchiveError::ProjectionHash)
        );
    }
}
