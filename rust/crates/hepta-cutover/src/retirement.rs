//! Immutable Node database drain/freeze verification for a forward-only Rust cutover.
//!
//! The legacy database is never rewritten into the Rust campaign-writer schema by
//! this module. Instead, the old writer must first drain every active runtime
//! surface, after which the exact schema-25 database is retained as an immutable
//! historical archive. Rollback is allowed only before the first Rust commit;
//! after activation, recovery proceeds forward so committed Rust records are not
//! erased by restoring a stale Node database.

use std::{
    collections::{BTreeMap, BTreeSet},
    path::Path,
    str::FromStr,
};

use hepta_codex_protocol::Sha256Digest;
use hepta_readonly_store::{
    LogicalDatabaseSnapshotV1, LogicalSqlValueV1, LogicalTableV1, ReadOnlyStoreV1,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;

const REQUIRED_REPOSITORY: &str = "TrillionniumFoundation/hepta-paper";
const REQUIRED_NODE_SCHEMA_VERSION: u32 = 25;
const MAXIMUM_OBSERVATIONS: usize = 128;

/// Rollback contract for retiring the legacy writer without dual-write risk.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LegacyRollbackModeV1 {
    /// The old writer may be restored only before the first authoritative Rust
    /// commit. Afterwards, recovery must preserve and move forward from Rust state.
    PreActivationOnlyThenForwardRecovery,
}

/// Exact immutable source subject whose legacy state is being retired.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LegacyNodeFreezeSubjectV1 {
    /// Canonical repository name.
    pub repository: String,
    /// Exact forty-character source commit.
    pub commit: String,
    /// Exact forty-character source tree.
    pub tree: String,
}

impl LegacyNodeFreezeSubjectV1 {
    fn validate(&self) -> Result<(), LegacyNodeFreezeError> {
        if self.repository != REQUIRED_REPOSITORY
            || !valid_git_hash(&self.commit)
            || !valid_git_hash(&self.tree)
        {
            return Err(LegacyNodeFreezeError::SubjectInvalid);
        }
        Ok(())
    }
}

/// One deterministic quiescence observation retained in the freeze receipt.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LegacyNodeQuiescenceObservationV1 {
    /// Exact table name.
    pub table: String,
    /// Number of rows inspected.
    pub row_count: usize,
    /// Number of rows that would still permit or require legacy runtime work.
    pub active_row_count: usize,
    /// Stable rule identifier.
    pub rule: String,
}

/// Serializable receipt body produced by an actual immutable database inspection.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LegacyNodeFreezeReceiptV1 {
    /// Contract version.
    pub version: u16,
    /// Exact source subject.
    pub subject: LegacyNodeFreezeSubjectV1,
    /// Exact database file bytes observed before and after inspection.
    pub database_content_hash: Sha256Digest,
    /// Complete typed logical database hash.
    pub logical_database_hash: Sha256Digest,
    /// Validated Node migration-ledger version; exactly 25.
    pub schema_version: u32,
    /// Hash of the closed quiescence policy implemented by this binary.
    pub policy_hash: Sha256Digest,
    /// Deterministically ordered table observations.
    pub observations: Vec<LegacyNodeQuiescenceObservationV1>,
    /// Closed rollback disposition.
    pub rollback_mode: LegacyRollbackModeV1,
    /// The legacy database is retained read-only for historical verification.
    pub immutable_archive_required: bool,
    /// Every known runtime lease, queue and active transition was absent.
    pub node_writer_quiesced: bool,
    /// Canonical receipt hash excluding this field.
    pub receipt_hash: Sha256Digest,
}

/// Opaque result of a real schema-25 immutable inspection.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VerifiedLegacyNodeFreezeV1 {
    receipt: LegacyNodeFreezeReceiptV1,
}

impl VerifiedLegacyNodeFreezeV1 {
    /// Exact source subject.
    #[must_use]
    pub fn subject(&self) -> &LegacyNodeFreezeSubjectV1 {
        &self.receipt.subject
    }

    /// Exact legacy database content hash.
    #[must_use]
    pub fn database_content_hash(&self) -> &Sha256Digest {
        &self.receipt.database_content_hash
    }

    /// Complete typed logical database hash.
    #[must_use]
    pub fn logical_database_hash(&self) -> &Sha256Digest {
        &self.receipt.logical_database_hash
    }

    /// Canonical freeze receipt identity.
    #[must_use]
    pub fn receipt_hash(&self) -> &Sha256Digest {
        &self.receipt.receipt_hash
    }

    /// Serializable evidence body.
    #[must_use]
    pub fn receipt(&self) -> &LegacyNodeFreezeReceiptV1 {
        &self.receipt
    }
}

/// Inspect a closed Node migration-ledger database and prove that no supported
/// legacy runtime operation remains active.
pub fn verify_legacy_node_freeze_v1(
    database_path: impl AsRef<Path>,
    subject: LegacyNodeFreezeSubjectV1,
) -> Result<VerifiedLegacyNodeFreezeV1, LegacyNodeFreezeError> {
    subject.validate()?;
    let store = ReadOnlyStoreV1::open(database_path).map_err(LegacyNodeFreezeError::ReadOnly)?;
    if store.schema_version() != REQUIRED_NODE_SCHEMA_VERSION {
        return Err(LegacyNodeFreezeError::SchemaVersionInvalid(
            store.schema_version(),
        ));
    }
    let database_content_hash = store.database_content_hash().clone();
    let snapshot = store
        .logical_snapshot()
        .map_err(LegacyNodeFreezeError::ReadOnly)?;
    verify_legacy_node_snapshot_v1(subject, database_content_hash, snapshot)
}

/// Verify an already captured immutable logical snapshot. This is public so a
/// separately controlled archive service can apply the exact same policy without
/// reopening the original production path.
pub fn verify_legacy_node_snapshot_v1(
    subject: LegacyNodeFreezeSubjectV1,
    database_content_hash: Sha256Digest,
    snapshot: LogicalDatabaseSnapshotV1,
) -> Result<VerifiedLegacyNodeFreezeV1, LegacyNodeFreezeError> {
    subject.validate()?;
    if snapshot.version != 1 || snapshot.schema.schema_version != REQUIRED_NODE_SCHEMA_VERSION {
        return Err(LegacyNodeFreezeError::SchemaVersionInvalid(
            snapshot.schema.schema_version,
        ));
    }
    let tables = snapshot
        .tables
        .iter()
        .map(|table| (table.name.as_str(), table))
        .collect::<BTreeMap<_, _>>();
    if tables.len() != snapshot.tables.len() {
        return Err(LegacyNodeFreezeError::SnapshotInvalid);
    }

    let mut observations = Vec::new();
    observe_statuses(
        &tables,
        "paper_campaigns",
        "status",
        &["cancelled", "completed", "failed", "stopped"],
        &mut observations,
    )?;
    observe_statuses(
        &tables,
        "campaign_nodes",
        "status",
        &["cancelled", "completed", "failed_terminal", "skipped"],
        &mut observations,
    )?;
    observe_statuses(
        &tables,
        "jobs",
        "status",
        &["cancelled", "completed", "failed_terminal"],
        &mut observations,
    )?;
    observe_statuses(
        &tables,
        "job_attempts",
        "status",
        &[
            "cancelled",
            "completed",
            "failed_retryable",
            "failed_terminal",
            "lost_lease",
        ],
        &mut observations,
    )?;
    observe_statuses(
        &tables,
        "submission_outbox",
        "status",
        &["dead_letter", "responded", "superseded"],
        &mut observations,
    )?;
    observe_statuses(
        &tables,
        "submission_release_locks",
        "status",
        &["released"],
        &mut observations,
    )?;
    observe_statuses(
        &tables,
        "submission_response_consumption",
        "state",
        &["CONSUMED", "REJECTED"],
        &mut observations,
    )?;
    observe_statuses(
        &tables,
        "campaign_nodes",
        "prepared_integration_status",
        &["integrated", "none"],
        &mut observations,
    )?;
    observe_empty_table(&tables, "automation_resource_leases", &mut observations)?;
    observe_empty_table(&tables, "automation_resource_waiters", &mut observations)?;
    observe_empty_columns(
        &tables,
        "campaign_nodes",
        &["lease_owner", "lease_expires_at"],
        &mut observations,
    )?;
    observe_empty_columns(
        &tables,
        "jobs",
        &["lease_owner", "lease_expires_at"],
        &mut observations,
    )?;
    observe_empty_columns(
        &tables,
        "submission_outbox",
        &[
            "claimed_by",
            "lease_token",
            "lease_expires_at",
            "heartbeat_at",
        ],
        &mut observations,
    )?;
    observe_empty_columns(
        &tables,
        "submission_response_consumption",
        &["claimed_by", "lease_token", "lease_expires_at"],
        &mut observations,
    )?;
    observe_nonempty_columns(
        &tables,
        "submission_release_locks",
        &["released_at"],
        &mut observations,
    )?;

    if observations.is_empty()
        || observations.len() > MAXIMUM_OBSERVATIONS
        || observations.iter().any(|item| item.active_row_count != 0)
    {
        return Err(LegacyNodeFreezeError::ActiveLegacyRuntime);
    }
    observations.sort_by(|left, right| {
        left.table
            .cmp(&right.table)
            .then_with(|| left.rule.cmp(&right.rule))
    });
    let policy_hash = policy_hash_v1()?;
    let body = LegacyNodeFreezeReceiptBodyV1 {
        version: 1,
        subject: &subject,
        database_content_hash: &database_content_hash,
        logical_database_hash: &snapshot.logical_hash,
        schema_version: REQUIRED_NODE_SCHEMA_VERSION,
        policy_hash: &policy_hash,
        observations: &observations,
        rollback_mode: LegacyRollbackModeV1::PreActivationOnlyThenForwardRecovery,
        immutable_archive_required: true,
        node_writer_quiesced: true,
    };
    let receipt_hash = hash_serialized("HeptaLegacyNodeFreezeReceiptV1", &body)?;
    Ok(VerifiedLegacyNodeFreezeV1 {
        receipt: LegacyNodeFreezeReceiptV1 {
            version: 1,
            subject,
            database_content_hash,
            logical_database_hash: snapshot.logical_hash,
            schema_version: REQUIRED_NODE_SCHEMA_VERSION,
            policy_hash,
            observations,
            rollback_mode: LegacyRollbackModeV1::PreActivationOnlyThenForwardRecovery,
            immutable_archive_required: true,
            node_writer_quiesced: true,
            receipt_hash,
        },
    })
}

fn observe_statuses(
    tables: &BTreeMap<&str, &LogicalTableV1>,
    table_name: &str,
    column_name: &str,
    allowed: &[&str],
    observations: &mut Vec<LegacyNodeQuiescenceObservationV1>,
) -> Result<(), LegacyNodeFreezeError> {
    let table = required_table(tables, table_name)?;
    let index = required_column(table, column_name)?;
    let allowed = allowed.iter().copied().collect::<BTreeSet<_>>();
    let mut active = 0usize;
    for row in &table.rows {
        let value = row
            .get(index)
            .ok_or(LegacyNodeFreezeError::SnapshotInvalid)?;
        match value {
            LogicalSqlValueV1::Text(value) if allowed.contains(value.as_str()) => {}
            _ => active = active.saturating_add(1),
        }
    }
    observations.push(LegacyNodeQuiescenceObservationV1 {
        table: table_name.to_owned(),
        row_count: table.rows.len(),
        active_row_count: active,
        rule: format!("{column_name}:terminal_status"),
    });
    Ok(())
}

fn observe_empty_table(
    tables: &BTreeMap<&str, &LogicalTableV1>,
    table_name: &str,
    observations: &mut Vec<LegacyNodeQuiescenceObservationV1>,
) -> Result<(), LegacyNodeFreezeError> {
    let table = required_table(tables, table_name)?;
    observations.push(LegacyNodeQuiescenceObservationV1 {
        table: table_name.to_owned(),
        row_count: table.rows.len(),
        active_row_count: table.rows.len(),
        rule: "table:empty".to_owned(),
    });
    Ok(())
}

fn observe_empty_columns(
    tables: &BTreeMap<&str, &LogicalTableV1>,
    table_name: &str,
    columns: &[&str],
    observations: &mut Vec<LegacyNodeQuiescenceObservationV1>,
) -> Result<(), LegacyNodeFreezeError> {
    let table = required_table(tables, table_name)?;
    let indices = columns
        .iter()
        .map(|column| required_column(table, column))
        .collect::<Result<Vec<_>, _>>()?;
    let active = table
        .rows
        .iter()
        .filter(|row| {
            indices.iter().any(|index| {
                row.get(*index)
                    .is_none_or(|value| !logical_value_is_empty(value))
            })
        })
        .count();
    observations.push(LegacyNodeQuiescenceObservationV1 {
        table: table_name.to_owned(),
        row_count: table.rows.len(),
        active_row_count: active,
        rule: format!("columns_empty:{}", columns.join(",")),
    });
    Ok(())
}

fn observe_nonempty_columns(
    tables: &BTreeMap<&str, &LogicalTableV1>,
    table_name: &str,
    columns: &[&str],
    observations: &mut Vec<LegacyNodeQuiescenceObservationV1>,
) -> Result<(), LegacyNodeFreezeError> {
    let table = required_table(tables, table_name)?;
    let indices = columns
        .iter()
        .map(|column| required_column(table, column))
        .collect::<Result<Vec<_>, _>>()?;
    let active = table
        .rows
        .iter()
        .filter(|row| {
            indices
                .iter()
                .any(|index| row.get(*index).is_none_or(logical_value_is_empty))
        })
        .count();
    observations.push(LegacyNodeQuiescenceObservationV1 {
        table: table_name.to_owned(),
        row_count: table.rows.len(),
        active_row_count: active,
        rule: format!("columns_nonempty:{}", columns.join(",")),
    });
    Ok(())
}

fn required_table<'a>(
    tables: &'a BTreeMap<&str, &LogicalTableV1>,
    name: &str,
) -> Result<&'a LogicalTableV1, LegacyNodeFreezeError> {
    tables
        .get(name)
        .copied()
        .ok_or_else(|| LegacyNodeFreezeError::RequiredTableMissing(name.to_owned()))
}

fn required_column(table: &LogicalTableV1, name: &str) -> Result<usize, LegacyNodeFreezeError> {
    table
        .columns
        .iter()
        .position(|column| column == name)
        .ok_or_else(|| LegacyNodeFreezeError::RequiredColumnMissing {
            table: table.name.clone(),
            column: name.to_owned(),
        })
}

fn logical_value_is_empty(value: &LogicalSqlValueV1) -> bool {
    matches!(value, LogicalSqlValueV1::Null)
        || matches!(value, LogicalSqlValueV1::Text(value) if value.is_empty())
}

fn policy_hash_v1() -> Result<Sha256Digest, LegacyNodeFreezeError> {
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Policy<'a> {
        version: u16,
        schema_version: u32,
        status_rules: &'a [(&'a str, &'a str, &'a [&'a str])],
        empty_tables: &'a [&'a str],
        empty_columns: &'a [(&'a str, &'a [&'a str])],
        nonempty_columns: &'a [(&'a str, &'a [&'a str])],
        rollback_mode: LegacyRollbackModeV1,
    }
    let status_rules: &[(&str, &str, &[&str])] = &[
        (
            "campaign_nodes",
            "prepared_integration_status",
            &["integrated", "none"],
        ),
        (
            "campaign_nodes",
            "status",
            &["cancelled", "completed", "failed_terminal", "skipped"],
        ),
        (
            "job_attempts",
            "status",
            &[
                "cancelled",
                "completed",
                "failed_retryable",
                "failed_terminal",
                "lost_lease",
            ],
        ),
        (
            "jobs",
            "status",
            &["cancelled", "completed", "failed_terminal"],
        ),
        (
            "paper_campaigns",
            "status",
            &["cancelled", "completed", "failed", "stopped"],
        ),
        (
            "submission_outbox",
            "status",
            &["dead_letter", "responded", "superseded"],
        ),
        ("submission_release_locks", "status", &["released"]),
        (
            "submission_response_consumption",
            "state",
            &["CONSUMED", "REJECTED"],
        ),
    ];
    let empty_tables = &["automation_resource_leases", "automation_resource_waiters"];
    let empty_columns: &[(&str, &[&str])] = &[
        ("campaign_nodes", &["lease_owner", "lease_expires_at"]),
        ("jobs", &["lease_owner", "lease_expires_at"]),
        (
            "submission_outbox",
            &[
                "claimed_by",
                "heartbeat_at",
                "lease_expires_at",
                "lease_token",
            ],
        ),
        (
            "submission_response_consumption",
            &["claimed_by", "lease_expires_at", "lease_token"],
        ),
    ];
    let nonempty_columns: &[(&str, &[&str])] = &[("submission_release_locks", &["released_at"])];
    hash_serialized(
        "HeptaLegacyNodeFreezePolicyV1",
        &Policy {
            version: 1,
            schema_version: REQUIRED_NODE_SCHEMA_VERSION,
            status_rules,
            empty_tables,
            empty_columns,
            nonempty_columns,
            rollback_mode: LegacyRollbackModeV1::PreActivationOnlyThenForwardRecovery,
        },
    )
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LegacyNodeFreezeReceiptBodyV1<'a> {
    version: u16,
    subject: &'a LegacyNodeFreezeSubjectV1,
    database_content_hash: &'a Sha256Digest,
    logical_database_hash: &'a Sha256Digest,
    schema_version: u32,
    policy_hash: &'a Sha256Digest,
    observations: &'a [LegacyNodeQuiescenceObservationV1],
    rollback_mode: LegacyRollbackModeV1,
    immutable_archive_required: bool,
    node_writer_quiesced: bool,
}

fn hash_serialized<T: Serialize>(
    domain: &str,
    value: &T,
) -> Result<Sha256Digest, LegacyNodeFreezeError> {
    let bytes = serde_json::to_vec(value).map_err(|_| LegacyNodeFreezeError::EncodingInvalid)?;
    let mut hasher = Sha256::new();
    update_hash(&mut hasher, domain.as_bytes());
    update_hash(&mut hasher, &bytes);
    Sha256Digest::from_str(&format!("sha256:{}", hex::encode(hasher.finalize())))
        .map_err(|_| LegacyNodeFreezeError::DigestInvalid)
}

fn update_hash(hasher: &mut Sha256, value: &[u8]) {
    hasher.update(u64::try_from(value.len()).unwrap_or(u64::MAX).to_be_bytes());
    hasher.update(value);
}

fn valid_git_hash(value: &str) -> bool {
    value.len() == 40 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

/// Legacy drain, snapshot or receipt failure.
#[derive(Debug, Error)]
pub enum LegacyNodeFreezeError {
    /// Repository/commit/tree identity is malformed.
    #[error("legacy freeze subject is invalid")]
    SubjectInvalid,
    /// The inspected database is not the exact supported Node schema.
    #[error("legacy Node schema version is unsupported: {0}")]
    SchemaVersionInvalid(u32),
    /// A required critical table is absent.
    #[error("required legacy runtime table is missing: {0}")]
    RequiredTableMissing(String),
    /// A required critical column is absent.
    #[error("required legacy runtime column is missing: {table}.{column}")]
    RequiredColumnMissing { table: String, column: String },
    /// Active work, lease, lock or transition remains.
    #[error("legacy Node runtime is not fully quiesced")]
    ActiveLegacyRuntime,
    /// Logical snapshot structure is inconsistent.
    #[error("legacy logical snapshot is invalid")]
    SnapshotInvalid,
    /// Canonical evidence encoding failed.
    #[error("legacy freeze evidence encoding failed")]
    EncodingInvalid,
    /// Internal SHA-256 wrapper rejected a generated digest.
    #[error("legacy freeze digest construction failed")]
    DigestInvalid,
    /// Immutable database inspection failed.
    #[error("legacy database inspection failed: {0}")]
    ReadOnly(hepta_readonly_store::ReadOnlyStoreError),
}

#[cfg(test)]
mod tests {
    use super::*;
    use hepta_readonly_control::{DatabaseFormatV1, DatabaseSchemaV1};

    fn digest(marker: char) -> Sha256Digest {
        Sha256Digest::from_str(&format!("sha256:{}", marker.to_string().repeat(64)))
            .expect("test digest")
    }

    fn subject() -> LegacyNodeFreezeSubjectV1 {
        LegacyNodeFreezeSubjectV1 {
            repository: REQUIRED_REPOSITORY.to_owned(),
            commit: "1".repeat(40),
            tree: "2".repeat(40),
        }
    }

    fn table(name: &str, columns: &[&str], rows: Vec<Vec<LogicalSqlValueV1>>) -> LogicalTableV1 {
        LogicalTableV1 {
            name: name.to_owned(),
            columns: columns.iter().map(|value| (*value).to_owned()).collect(),
            rows,
            table_hash: digest('3'),
        }
    }

    fn text(value: &str) -> LogicalSqlValueV1 {
        LogicalSqlValueV1::Text(value.to_owned())
    }

    fn snapshot(active_job: bool) -> LogicalDatabaseSnapshotV1 {
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
            schema_objects: Vec::new(),
            tables: vec![
                table(
                    "paper_campaigns",
                    &["status"],
                    vec![vec![text("completed")]],
                ),
                table(
                    "campaign_nodes",
                    &[
                        "status",
                        "prepared_integration_status",
                        "lease_owner",
                        "lease_expires_at",
                    ],
                    vec![vec![
                        text("completed"),
                        text("integrated"),
                        LogicalSqlValueV1::Null,
                        LogicalSqlValueV1::Null,
                    ]],
                ),
                table(
                    "jobs",
                    &["status", "lease_owner", "lease_expires_at"],
                    vec![vec![
                        text(if active_job { "running" } else { "completed" }),
                        LogicalSqlValueV1::Null,
                        LogicalSqlValueV1::Null,
                    ]],
                ),
                table("job_attempts", &["status"], vec![vec![text("completed")]]),
                table(
                    "submission_outbox",
                    &[
                        "status",
                        "claimed_by",
                        "lease_token",
                        "lease_expires_at",
                        "heartbeat_at",
                    ],
                    vec![vec![
                        text("responded"),
                        LogicalSqlValueV1::Null,
                        LogicalSqlValueV1::Null,
                        LogicalSqlValueV1::Null,
                        LogicalSqlValueV1::Null,
                    ]],
                ),
                table(
                    "submission_release_locks",
                    &["status", "released_at"],
                    vec![vec![text("released"), text("2026-09-08T00:00:00Z")]],
                ),
                table(
                    "submission_response_consumption",
                    &["state", "claimed_by", "lease_token", "lease_expires_at"],
                    vec![vec![
                        text("CONSUMED"),
                        LogicalSqlValueV1::Null,
                        LogicalSqlValueV1::Null,
                        LogicalSqlValueV1::Null,
                    ]],
                ),
                table("automation_resource_leases", &["lease_id"], Vec::new()),
                table("automation_resource_waiters", &["waiter_id"], Vec::new()),
            ],
            logical_hash: digest('5'),
        }
    }

    #[test]
    fn quiescent_snapshot_produces_forward_only_freeze_receipt() {
        let verified = verify_legacy_node_snapshot_v1(subject(), digest('6'), snapshot(false))
            .expect("freeze");
        assert!(verified.receipt().node_writer_quiesced);
        assert!(verified.receipt().immutable_archive_required);
        assert_eq!(
            verified.receipt().rollback_mode,
            LegacyRollbackModeV1::PreActivationOnlyThenForwardRecovery
        );
        assert!(
            verified
                .receipt()
                .observations
                .iter()
                .all(|item| item.active_row_count == 0)
        );
    }

    #[test]
    fn active_job_blocks_freeze() {
        assert!(matches!(
            verify_legacy_node_snapshot_v1(subject(), digest('6'), snapshot(true)),
            Err(LegacyNodeFreezeError::ActiveLegacyRuntime)
        ));
    }

    #[test]
    fn missing_critical_table_fails_closed() {
        let mut value = snapshot(false);
        value
            .tables
            .retain(|table| table.name != "submission_outbox");
        assert!(matches!(
            verify_legacy_node_snapshot_v1(subject(), digest('6'), value),
            Err(LegacyNodeFreezeError::RequiredTableMissing(table)) if table == "submission_outbox"
        ));
    }
}
