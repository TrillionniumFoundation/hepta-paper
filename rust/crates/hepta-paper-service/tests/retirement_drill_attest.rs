//! Acceptance and hostile-input tests for the native drill-attest boundary.

use hepta_paper_service::{
    LegacyDeletionDrillAttestationRequestV1, inspect_legacy_deletion_drill_attest_v1,
};
use hepta_readonly_control::node_schema::NODE_MIGRATIONS_V1;
use rusqlite::Connection;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::Command,
};

fn fixture(name: &str) -> PathBuf {
    let root = std::env::temp_dir().join(format!(
        "hepta-native-drill-attest-{}-{name}",
        std::process::id()
    ));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(&root).expect("fixture root");
    fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).expect("root mode");
    root
}

fn node_database(root: &Path) -> PathBuf {
    let path = root.join("legacy.sqlite");
    let connection = Connection::open(&path).expect("database");
    connection
        .execute_batch("PRAGMA journal_mode=DELETE; PRAGMA foreign_keys=ON;")
        .expect("journal");
    for migration in NODE_MIGRATIONS_V1 {
        connection.execute_batch("BEGIN IMMEDIATE;").expect("begin");
        connection.execute_batch(migration.sql).expect("migration");
        connection
            .execute(
                "INSERT INTO schema_migrations(version,name,migration_sha256,applied_at) VALUES(?1,?2,?3,'2026-01-01')",
                rusqlite::params![
                    migration.version,
                    migration.name,
                    format!("sha256:{:x}", Sha256::digest(migration.sql.as_bytes()))
                ],
            )
            .expect("migration history");
        connection.execute_batch("COMMIT;").expect("commit");
    }
    drop(connection);
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).expect("database mode");
    path
}

fn request(database: &Path, archive: &Path) -> LegacyDeletionDrillAttestationRequestV1 {
    LegacyDeletionDrillAttestationRequestV1 {
        version: 1,
        kind: "LegacyDeletionDrillAttestationRequest".to_owned(),
        legacy_database_path: database.to_string_lossy().into_owned(),
        archive_path: archive.to_string_lossy().into_owned(),
        repository: "TrillionniumFoundation/hepta-paper".to_owned(),
        commit: "a".repeat(40),
        tree: "b".repeat(40),
        release_commit: "a".repeat(40),
        release_state_snapshot_hash: format!("sha256:{}", "c".repeat(64)),
    }
}

#[test]
fn native_attest_reads_real_schema25_and_stays_blocked_without_external_authority() {
    let root = fixture("real-schema");
    let database = node_database(&root);
    let archive = root.join("reference.tar.gz");
    fs::write(&archive, b"immutable reference fixture").expect("archive");
    let before = fs::read(&database).expect("database before");
    let report = inspect_legacy_deletion_drill_attest_v1(request(&database, &archive))
        .expect("inspection report");
    assert!(report.local_freeze_verified);
    assert!(report.legacy_freeze_receipt_hash.is_some());
    assert!(!report.technical_release_ready);
    assert!(!report.physical_deletion_allowed);
    assert!(!report.signing_key_read);
    assert!(!report.runtime_evidence_written);
    assert!(!report.external_action_performed);
    assert!(
        report
            .blockers
            .iter()
            .any(|value| value == "legacy_deletion_drill_node_differential_replay_external")
    );
    assert!(
        report
            .blockers
            .iter()
            .any(|value| value == "legacy_reference_archive_not_filesystem_immutable")
    );
    assert_eq!(fs::read(&database).expect("database after"), before);
    assert!(!database.with_extension("sqlite-wal").exists());
    assert!(!database.with_extension("sqlite-shm").exists());
    let _ = fs::remove_dir_all(root);
}

#[test]
fn native_attest_rejects_archive_hardlink_before_any_freeze_claim() {
    let root = fixture("hardlink");
    let database = node_database(&root);
    let source = root.join("reference.tar.gz");
    let hardlink = root.join("hardlink.tar.gz");
    fs::write(&source, b"reference").expect("archive");
    fs::hard_link(&source, &hardlink).expect("hardlink");
    let report = inspect_legacy_deletion_drill_attest_v1(request(&database, &hardlink))
        .expect("inspection report");
    assert!(report.local_freeze_verified);
    assert!(report.archive.is_none());
    assert!(
        report
            .blockers
            .iter()
            .any(|value| value == "legacy_deletion_drill_archive_unsafe")
    );
    assert!(!report.physical_deletion_allowed);
    let _ = fs::remove_dir_all(root);
}

#[test]
fn native_attest_cli_prints_blocked_report_and_exits_nonzero() {
    let root = fixture("cli");
    let database = node_database(&root);
    let archive = root.join("reference.tar.gz");
    fs::write(&archive, b"reference").expect("archive");
    let request_path = root.join("request.json");
    fs::write(
        &request_path,
        serde_json::to_vec(&request(&database, &archive)).expect("request JSON"),
    )
    .expect("request");
    let output = Command::new(env!("CARGO_BIN_EXE_hepta-paper-rust"))
        .args([
            "retirement-drill-attest",
            request_path.to_str().expect("UTF-8 path"),
        ])
        .output()
        .expect("native CLI");
    assert!(!output.status.success());
    let report: Value = serde_json::from_slice(&output.stdout).expect("blocked report JSON");
    assert_eq!(report["kind"], "LegacyDeletionDrillAttestationInspection");
    assert_eq!(
        report["status"],
        "legacy_reference_restore_drill_attestation_blocked"
    );
    assert_eq!(report["physicalDeletionAllowed"], false);
    assert!(
        report["blockers"]
            .as_array()
            .expect("blockers")
            .iter()
            .any(|value| value == "legacy_deletion_drill_release_signature_external")
    );
    let _ = fs::remove_dir_all(root);
}
