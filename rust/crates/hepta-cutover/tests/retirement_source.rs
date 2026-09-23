use std::str::FromStr;

use hepta_codex_protocol::Sha256Digest;
use hepta_cutover::{
    LegacyNodeFreezeError, LegacyNodeFreezeSubjectV1, LegacyRollbackModeV1,
    verify_legacy_node_snapshot_v1,
};
use hepta_readonly_control::{DatabaseFormatV1, DatabaseSchemaV1};
use hepta_readonly_store::{LogicalDatabaseSnapshotV1, LogicalSqlValueV1, LogicalTableV1};

fn digest(marker: char) -> Sha256Digest {
    Sha256Digest::from_str(&format!("sha256:{}", marker.to_string().repeat(64)))
        .expect("test digest")
}

fn subject() -> LegacyNodeFreezeSubjectV1 {
    LegacyNodeFreezeSubjectV1 {
        repository: "TrillionniumFoundation/hepta-paper".to_owned(),
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
    let verified =
        verify_legacy_node_snapshot_v1(subject(), digest('6'), snapshot(false)).expect("freeze");

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
