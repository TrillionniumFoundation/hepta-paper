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

// One trusted SQL replay owner for read-only recognition and offline migration.
fn replay_node_schema(
    connection: &Connection,
    expected: &Connection,
) -> Result<u32, ReadOnlyStoreError> {
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
    if metadata_version(connection)? != metadata_version(expected)? {
        return Err(ReadOnlyStoreError::MigrationHistoryMismatch);
    }
    u32::try_from(rows.len()).map_err(|_| ReadOnlyStoreError::NumericOverflow)
}

/// Verify actual SQL objects, contiguous descriptors and schema metadata against
/// the shared migration owner at a selected nonzero version. Only a private
/// in-memory expectation is written; the source connection is never reopened.
/// Header identity, integrity, leases and authority remain caller checks.
/// Structural matching alone grants neither format acceptance nor a writer.
pub fn validate_node_migration_structure_v1(
    connection: &Connection,
    expected_version: u32,
) -> Result<(), ReadOnlyStoreError> {
    let expected = Connection::open_in_memory()?;
    if replay_node_schema(connection, &expected)? != expected_version
        || schema_objects(connection)? != schema_objects(&expected)?
    {
        return Err(ReadOnlyStoreError::SchemaDrift);
    }
    Ok(())
}

/// A closed structural observation of the known installed Node format. Neither
/// profile adopts old authority rows or authorizes any production writer.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum KnownInstalledNodeProfileV1 {
    NodeMigrationBase,
    NodeMigrationOnlineMutationMarker,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnownInstalledNodeStructureV1 {
    pub version: u16,
    pub profile: KnownInstalledNodeProfileV1,
    pub schema_version: u32,
    pub authority_granted: bool,
    pub old_authority_records_adopted: bool,
}

/// Exact strings also imported by the incumbent Node schema owner. Parsing a
/// compiled, closed array never grants a caller an arbitrary SQL entry point.
pub fn known_installed_online_marker_statements_v1() -> Result<Vec<String>, ReadOnlyStoreError> {
    let source =
        include_str!("../../../../store/schema/autonomous-research-online-mutation-marker.v1.json");
    if source.len() > 64 * 1024 {
        return Err(ReadOnlyStoreError::SchemaDrift);
    }
    let statements: Vec<String> =
        serde_json::from_str(source).map_err(|_| ReadOnlyStoreError::SchemaDrift)?;
    if statements.len() != 11
        || statements
            .iter()
            .any(|s| s.is_empty() || s.len() > 16 * 1024)
    {
        return Err(ReadOnlyStoreError::SchemaDrift);
    }
    Ok(statements)
}

/// Recognize only trusted migration objects, or that exact base plus all eleven
/// objects of the known online marker extension. Missing, changed and extra SQL
/// objects remain errors. The original base-only recognizer is unchanged.
pub fn recognize_known_installed_node_migration_structure_v1(
    connection: &Connection,
    expected_version: u32,
) -> Result<KnownInstalledNodeStructureV1, ReadOnlyStoreError> {
    guard_known_installed_history(connection)?;
    let expected = Connection::open_in_memory()?;
    if replay_node_schema(connection, &expected)? != expected_version {
        return Err(ReadOnlyStoreError::SchemaDrift);
    }
    let actual = known_installed_schema_objects(connection)?;
    let profile = if actual == schema_objects(&expected)? {
        KnownInstalledNodeProfileV1::NodeMigrationBase
    } else {
        for statement in known_installed_online_marker_statements_v1()? {
            expected.execute_batch(&statement)?;
        }
        if actual != schema_objects(&expected)? {
            return Err(ReadOnlyStoreError::SchemaDrift);
        }
        KnownInstalledNodeProfileV1::NodeMigrationOnlineMutationMarker
    };
    Ok(KnownInstalledNodeStructureV1 {
        version: 1,
        profile,
        schema_version: expected_version,
        authority_granted: false,
        old_authority_records_adopted: false,
    })
}

fn guard_known_installed_history(connection: &Connection) -> Result<(), ReadOnlyStoreError> {
    use rusqlite::types::ValueRef;
    let mut query = connection.prepare(
        "SELECT version,name,migration_sha256 FROM schema_migrations ORDER BY version LIMIT 26",
    )?;
    let mut rows = query.query([])?;
    let mut count = 0;
    while let Some(row) = rows.next()? {
        count += 1;
        let ValueRef::Integer(version) = row.get_ref(0)? else {
            return Err(ReadOnlyStoreError::MigrationHistoryMismatch);
        };
        let ValueRef::Text(name) = row.get_ref(1)? else {
            return Err(ReadOnlyStoreError::MigrationHistoryMismatch);
        };
        let ValueRef::Text(hash) = row.get_ref(2)? else {
            return Err(ReadOnlyStoreError::MigrationHistoryMismatch);
        };
        if !(1..=25).contains(&version) || name.len() > 512 || hash.len() != 71 || count > 25 {
            return Err(ReadOnlyStoreError::MigrationHistoryMismatch);
        }
    }
    if count == 0 {
        return Err(ReadOnlyStoreError::MigrationHistoryMismatch);
    }
    Ok(())
}

// This new native profile bounds untrusted SQL text before allocating it. The
// established base-only recognizer retains its original acceptance contract.
fn known_installed_schema_objects(
    connection: &Connection,
) -> Result<Vec<SchemaObject>, ReadOnlyStoreError> {
    use rusqlite::types::ValueRef;
    let mut query = connection.prepare(
        "SELECT type,name,tbl_name,coalesce(sql,'') FROM sqlite_schema
         WHERE name NOT GLOB 'sqlite_*' ORDER BY type,name,tbl_name",
    )?;
    let mut rows = query.query([])?;
    let mut result = Vec::new();
    let mut total = 0usize;
    while let Some(row) = rows.next()? {
        if result.len() >= 4096 {
            return Err(ReadOnlyStoreError::SchemaDrift);
        }
        let mut values = Vec::with_capacity(4);
        for index in 0..4 {
            let ValueRef::Text(bytes) = row.get_ref(index)? else {
                return Err(ReadOnlyStoreError::SchemaDrift);
            };
            total = total
                .checked_add(bytes.len())
                .ok_or(ReadOnlyStoreError::NumericOverflow)?;
            if bytes.len() > if index == 3 { 64 * 1024 } else { 512 } || total > 8 * 1024 * 1024 {
                return Err(ReadOnlyStoreError::SchemaDrift);
            }
            values.push(
                std::str::from_utf8(bytes)
                    .map_err(|_| ReadOnlyStoreError::SchemaDrift)?
                    .to_owned(),
            );
        }
        let mut fields = values.into_iter();
        result.push((
            fields.next().ok_or(ReadOnlyStoreError::SchemaDrift)?,
            fields.next().ok_or(ReadOnlyStoreError::SchemaDrift)?,
            fields.next().ok_or(ReadOnlyStoreError::SchemaDrift)?,
            fields.next().ok_or(ReadOnlyStoreError::SchemaDrift)?,
        ));
    }
    Ok(result)
}

/// Explicit known-installed read-only format selection. The original strict
/// validator continues to accept only its existing formats. This observation
/// changes no authority metadata and permits no DDL on the source connection.
pub fn validate_known_installed_database_schema_v1(
    connection: &Connection,
) -> Result<DatabaseSchemaV1, ReadOnlyStoreError> {
    let user_version: i64 = connection.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    let application_id: i64 =
        connection.query_row("PRAGMA application_id", [], |row| row.get(0))?;
    if user_version != 0 || application_id != 0 {
        // Preserve the existing distinct Rust campaign format only through
        // its original complete schema validator.
        return validate_database_schema_v1(connection);
    }
    guard_known_installed_history(connection)?;
    let expected = Connection::open_in_memory()?;
    let schema_version = replay_node_schema(connection, &expected)?;
    recognize_known_installed_node_migration_structure_v1(connection, schema_version)?;
    let quick_check: String = connection.query_row("PRAGMA quick_check", [], |row| row.get(0))?;
    if quick_check != "ok" || connection.prepare("PRAGMA foreign_key_check")?.exists([])? {
        return Err(ReadOnlyStoreError::IntegrityCheck);
    }
    Ok(DatabaseSchemaV1 {
        format: DatabaseFormatV1::NodeMigrationLedger,
        schema_version,
        user_version: 0,
        application_id: 0,
        local_only: false,
    })
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
        (
            DatabaseFormatV1::NodeMigrationLedger,
            replay_node_schema(connection, &expected)?,
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

    fn node_at(version: u32) -> Connection {
        let db = Connection::open_in_memory().unwrap();
        for migration in NODE_MIGRATIONS_V1.iter().take(version as usize) {
            db.execute_batch(migration.sql).unwrap();
            db.execute(
                "INSERT INTO schema_migrations(version,name,migration_sha256) VALUES(?1,?2,?3)",
                rusqlite::params![
                    migration.version,
                    migration.name,
                    format!(
                        "sha256:{}",
                        hex::encode(Sha256::digest(migration.sql.as_bytes()))
                    )
                ],
            )
            .unwrap();
        }
        db
    }

    #[test]
    fn known_installed_marker_is_explicit_complete_and_never_adopts_authority() {
        for version in [1, 12, 20, 24, 25] {
            let db = node_at(version);
            let base = recognize_known_installed_node_migration_structure_v1(&db, version).unwrap();
            assert_eq!(base.profile, KnownInstalledNodeProfileV1::NodeMigrationBase);
            validate_node_migration_structure_v1(&db, version).unwrap();
            for sql in known_installed_online_marker_statements_v1().unwrap() {
                db.execute_batch(&sql).unwrap();
            }
            let installed =
                recognize_known_installed_node_migration_structure_v1(&db, version).unwrap();
            assert_eq!(
                installed.profile,
                KnownInstalledNodeProfileV1::NodeMigrationOnlineMutationMarker
            );
            assert!(!installed.authority_granted && !installed.old_authority_records_adopted);
            assert!(matches!(
                validate_node_migration_structure_v1(&db, version),
                Err(ReadOnlyStoreError::SchemaDrift)
            ));
            assert!(matches!(
                validate_database_schema_v1(&db),
                Err(ReadOnlyStoreError::SchemaDrift)
            ));
            assert_eq!(
                validate_known_installed_database_schema_v1(&db)
                    .unwrap()
                    .schema_version,
                version
            );
        }
    }

    #[test]
    fn known_installed_rejects_each_missing_object_unknown_objects_and_changed_sql() {
        let statements = known_installed_online_marker_statements_v1().unwrap();
        for omitted in 0..statements.len() {
            let db = node_at(25);
            for (index, sql) in statements.iter().enumerate() {
                if index != omitted {
                    // Missing tables also make dependent indexes/triggers invalid.
                    let _ = db.execute_batch(sql);
                }
            }
            assert!(
                recognize_known_installed_node_migration_structure_v1(&db, 25).is_err(),
                "omitted {omitted}"
            );
        }
        for mutation in [
            "CREATE TABLE unknown_extra(id INTEGER)",
            "CREATE INDEX unknown_extra ON papers(slug)",
            "CREATE TRIGGER unknown_extra BEFORE INSERT ON papers BEGIN SELECT 1; END;",
            "ALTER TABLE autonomous_research_online_mutation_authority_marker ADD COLUMN unknown_extra TEXT",
            "DROP TRIGGER autonomous_research_online_mutation_metadata_no_update; CREATE TRIGGER autonomous_research_online_mutation_metadata_no_update BEFORE UPDATE ON autonomous_research_online_mutation_authority_metadata BEGIN SELECT RAISE(ABORT,'changed'); END;",
            "UPDATE schema_migrations SET migration_sha256='sha256:bad' WHERE version=25",
        ] {
            let db = node_at(25);
            for sql in &statements {
                db.execute_batch(sql).unwrap();
            }
            db.execute_batch(mutation).unwrap();
            assert!(
                recognize_known_installed_node_migration_structure_v1(&db, 25).is_err(),
                "{mutation}"
            );
            assert!(validate_known_installed_database_schema_v1(&db).is_err());
        }
    }

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
