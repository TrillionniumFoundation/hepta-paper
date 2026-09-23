//! Recognition of production Node migration history and the distinct Rust campaign format.

use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::ReadOnlyStoreError;

/// One production migration, embedded from the same SQL file consumed by Node.
pub struct NodeMigrationV1 {
    pub version: u32,
    pub name: &'static str,
    pub sql: &'static str,
}

/// Immutable descriptors; these do not confer write or migration authority.
pub const NODE_MIGRATIONS_V1: &[NodeMigrationV1] = &[
    NodeMigrationV1 {
        version: 1,
        name: "001_initial",
        sql: include_str!("../../../../store/migrations/001_initial.sql"),
    },
    NodeMigrationV1 {
        version: 2,
        name: "002_runtime_ledger",
        sql: include_str!("../../../../store/migrations/002_runtime_ledger.sql"),
    },
    NodeMigrationV1 {
        version: 3,
        name: "003_evidence_isolation",
        sql: include_str!("../../../../store/migrations/003_evidence_isolation.sql"),
    },
    NodeMigrationV1 {
        version: 4,
        name: "004_automation_campaigns",
        sql: include_str!("../../../../store/migrations/004_automation_campaigns.sql"),
    },
    NodeMigrationV1 {
        version: 5,
        name: "005_automation_operations",
        sql: include_str!("../../../../store/migrations/005_automation_operations.sql"),
    },
    NodeMigrationV1 {
        version: 6,
        name: "006_multiprocess_automation",
        sql: include_str!("../../../../store/migrations/006_multiprocess_automation.sql"),
    },
    NodeMigrationV1 {
        version: 7,
        name: "007_campaign_lineage_backfill",
        sql: include_str!("../../../../store/migrations/007_campaign_lineage_backfill.sql"),
    },
    NodeMigrationV1 {
        version: 8,
        name: "008_reviewer_identity_backfill",
        sql: include_str!("../../../../store/migrations/008_reviewer_identity_backfill.sql"),
    },
    NodeMigrationV1 {
        version: 9,
        name: "009_resource_admission_queue",
        sql: include_str!("../../../../store/migrations/009_resource_admission_queue.sql"),
    },
    NodeMigrationV1 {
        version: 10,
        name: "010_resource_admission_metadata",
        sql: include_str!("../../../../store/migrations/010_resource_admission_metadata.sql"),
    },
    NodeMigrationV1 {
        version: 11,
        name: "011_workspace_lineage",
        sql: include_str!("../../../../store/migrations/011_workspace_lineage.sql"),
    },
    NodeMigrationV1 {
        version: 12,
        name: "012_schema_metadata_consistency",
        sql: include_str!("../../../../store/migrations/012_schema_metadata_consistency.sql"),
    },
    NodeMigrationV1 {
        version: 13,
        name: "013_campaign_telemetry",
        sql: include_str!("../../../../store/migrations/013_campaign_telemetry.sql"),
    },
    NodeMigrationV1 {
        version: 14,
        name: "014_legacy_native_lineage",
        sql: include_str!("../../../../store/migrations/014_legacy_native_lineage.sql"),
    },
    NodeMigrationV1 {
        version: 15,
        name: "015_submission_boundary_hardening",
        sql: include_str!("../../../../store/migrations/015_submission_boundary_hardening.sql"),
    },
    NodeMigrationV1 {
        version: 16,
        name: "016_submission_delivery_leases",
        sql: include_str!("../../../../store/migrations/016_submission_delivery_leases.sql"),
    },
    NodeMigrationV1 {
        version: 17,
        name: "017_trusted_evidence_and_response_consumption",
        sql: include_str!(
            "../../../../store/migrations/017_trusted_evidence_and_response_consumption.sql"
        ),
    },
    NodeMigrationV1 {
        version: 18,
        name: "018_append_only_receipt_ledger",
        sql: include_str!("../../../../store/migrations/018_append_only_receipt_ledger.sql"),
    },
    NodeMigrationV1 {
        version: 19,
        name: "019_effective_receipt_ledger",
        sql: include_str!("../../../../store/migrations/019_effective_receipt_ledger.sql"),
    },
    NodeMigrationV1 {
        version: 20,
        name: "020_monotonic_receipt_qualification",
        sql: include_str!("../../../../store/migrations/020_monotonic_receipt_qualification.sql"),
    },
    NodeMigrationV1 {
        version: 21,
        name: "021_job_lease_fencing",
        sql: include_str!("../../../../store/migrations/021_job_lease_fencing.sql"),
    },
    NodeMigrationV1 {
        version: 22,
        name: "022_campaign_attempt_fencing",
        sql: include_str!("../../../../store/migrations/022_campaign_attempt_fencing.sql"),
    },
    NodeMigrationV1 {
        version: 23,
        name: "023_workspace_retention_qualification",
        sql: include_str!("../../../../store/migrations/023_workspace_retention_qualification.sql"),
    },
    NodeMigrationV1 {
        version: 24,
        name: "024_submission_outbox_delivery_kind",
        sql: include_str!("../../../../store/migrations/024_submission_outbox_delivery_kind.sql"),
    },
    NodeMigrationV1 {
        version: 25,
        name: "025_external_autonomous_submission_handoff",
        sql: include_str!(
            "../../../../store/migrations/025_external_autonomous_submission_handoff.sql"
        ),
    },
];

/// Distinguishes migration-ledger Node databases from the Rust writer's separate schema.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DatabaseFormatV1 {
    NodeMigrationLedger,
    RustCampaignWriter,
}

/// Validated effective version plus original SQLite header metadata.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseSchemaV1 {
    pub format: DatabaseFormatV1,
    pub schema_version: u32,
    pub user_version: u32,
    pub application_id: i64,
    /// True only for the separately marked local Rust writer format.
    pub local_only: bool,
}

type SchemaObject = (String, String, String, String);

fn schema_objects(connection: &Connection) -> Result<Vec<SchemaObject>, ReadOnlyStoreError> {
    let mut query = connection.prepare(
        "SELECT type,name,tbl_name,coalesce(sql,'') FROM sqlite_schema
         WHERE name NOT GLOB 'sqlite_*' ORDER BY type,name,tbl_name",
    )?;
    Ok(query
        .query_map([], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
        })?
        .collect::<Result<Vec<_>, _>>()?)
}

fn metadata_version(connection: &Connection) -> Result<Option<String>, ReadOnlyStoreError> {
    Ok(connection
        .query_row(
            "SELECT value FROM store_metadata WHERE key='schema_version'",
            [],
            |row| row.get(0),
        )
        .optional()?)
}

/// Validates names, SQL hashes, contiguous history, schema objects and header metadata.
/// Replays trusted SQL only into a private in-memory database; never migrates the input.
pub fn validate_database_schema_v1(
    connection: &Connection,
) -> Result<DatabaseSchemaV1, ReadOnlyStoreError> {
    let user_version: i64 = connection.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    let application_id: i64 =
        connection.query_row("PRAGMA application_id", [], |row| row.get(0))?;
    let expected = Connection::open_in_memory()?;
    let mut local_only = false;
    let (format, schema_version) = if application_id == 0x4850_4357 && user_version == 1 {
        expected.execute_batch(hepta_campaign_writer::CAMPAIGN_WRITER_SCHEMA_V1)?;
        let control_tables: u32 = connection.query_row(
            "SELECT count(*) FROM sqlite_schema WHERE type='table' AND name IN ('control_streams_v1','control_results_v1')",
            [], |row| row.get(0),
        )?;
        if control_tables != 0 {
            if control_tables != 2 {
                return Err(ReadOnlyStoreError::SchemaDrift);
            }
            expected.execute_batch(hepta_campaign_writer::CONTROL_STREAM_SCHEMA_V1)?;
        }
        local_only = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='local_writer_identity_v1')",
            [], |row| row.get(0),
        )?;
        if local_only {
            expected.execute_batch(hepta_campaign_writer::LOCAL_WRITER_SCHEMA_V1)?;
        }
        (DatabaseFormatV1::RustCampaignWriter, 1)
    } else if application_id == 0 && user_version == 0 {
        let present: bool = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='schema_migrations')", [], |row| row.get(0),
        )?;
        if !present {
            return Err(ReadOnlyStoreError::SchemaVersion);
        }
        let mut statement = connection.prepare(
            "SELECT version,name,migration_sha256 FROM schema_migrations ORDER BY version LIMIT 26",
        )?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        if rows.is_empty() || rows.len() > NODE_MIGRATIONS_V1.len() {
            return Err(ReadOnlyStoreError::SchemaVersion);
        }
        for (row, migration) in rows.iter().zip(NODE_MIGRATIONS_V1) {
            let hash = format!(
                "sha256:{}",
                hex::encode(Sha256::digest(migration.sql.as_bytes()))
            );
            if row.0 != i64::from(migration.version) || row.1 != migration.name || row.2 != hash {
                return Err(ReadOnlyStoreError::MigrationHistoryMismatch);
            }
            // Node applies each migration in a transaction before recording the descriptor.
            expected.execute_batch("BEGIN IMMEDIATE;")?;
            expected.execute_batch(migration.sql)?;
            expected.execute(
                "INSERT INTO schema_migrations(version,name,migration_sha256) VALUES(?1,?2,?3)",
                rusqlite::params![migration.version, migration.name, hash],
            )?;
            expected.execute_batch("COMMIT;")?;
        }
        if metadata_version(connection)? != metadata_version(&expected)? {
            return Err(ReadOnlyStoreError::MigrationHistoryMismatch);
        }
        (
            DatabaseFormatV1::NodeMigrationLedger,
            u32::try_from(rows.len()).map_err(|_| ReadOnlyStoreError::NumericOverflow)?,
        )
    } else {
        return Err(ReadOnlyStoreError::SchemaVersion);
    };
    if schema_objects(connection)? != schema_objects(&expected)? {
        return Err(ReadOnlyStoreError::SchemaDrift);
    }
    if local_only {
        let marker_count: u32 = connection.query_row(
            "SELECT count(*) FROM local_writer_identity_v1 WHERE singleton=1 AND purpose='local_only'",
            [], |row| row.get(0),
        )?;
        if marker_count != 1 {
            return Err(ReadOnlyStoreError::SchemaDrift);
        }
    }
    let quick_check: String = connection.query_row("PRAGMA quick_check", [], |row| row.get(0))?;
    if quick_check != "ok" {
        return Err(ReadOnlyStoreError::IntegrityCheck);
    }
    let mut foreign_keys = connection.prepare("PRAGMA foreign_key_check")?;
    if foreign_keys.query([])?.next()?.is_some() {
        return Err(ReadOnlyStoreError::IntegrityCheck);
    }
    Ok(DatabaseSchemaV1 {
        format,
        schema_version,
        application_id,
        local_only,
        user_version: u32::try_from(user_version).map_err(|_| ReadOnlyStoreError::SchemaVersion)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognizes_only_complete_exported_rust_writer_schema_groups() {
        for control in [false, true] {
            for local in [false, true] {
                let db = Connection::open_in_memory().expect("memory");
                db.execute_batch(hepta_campaign_writer::CAMPAIGN_WRITER_SCHEMA_V1)
                    .expect("base");
                if control {
                    db.execute_batch(hepta_campaign_writer::CONTROL_STREAM_SCHEMA_V1)
                        .expect("control");
                }
                if local {
                    db.execute_batch(hepta_campaign_writer::LOCAL_WRITER_SCHEMA_V1)
                        .expect("local");
                    db.execute(
                        "INSERT INTO local_writer_identity_v1 VALUES(1,'local_only')",
                        [],
                    )
                    .expect("marker");
                }
                let schema = validate_database_schema_v1(&db).expect("recognized writer");
                assert_eq!(schema.format, DatabaseFormatV1::RustCampaignWriter);
                assert_eq!(schema.local_only, local);
                assert_eq!(schema.schema_version, 1);
                if control {
                    db.execute_batch("DROP TABLE control_results_v1")
                        .expect("partial group");
                    assert!(matches!(
                        validate_database_schema_v1(&db),
                        Err(ReadOnlyStoreError::SchemaDrift)
                    ));
                } else if local {
                    db.execute("DELETE FROM local_writer_identity_v1", [])
                        .expect("missing marker");
                    assert!(matches!(
                        validate_database_schema_v1(&db),
                        Err(ReadOnlyStoreError::SchemaDrift)
                    ));
                }
            }
        }
    }
}
