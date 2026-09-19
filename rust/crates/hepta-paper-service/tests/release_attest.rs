//! Integration coverage for the bounded native release-attest composition.

use hepta_paper_service::LegacyDeletionDrillAttestationRequestV1;
use hepta_paper_service::release_attest::{
    ReleaseAttestationRequestV1, inspect_release_attestation_v1,
};
use hepta_readonly_control::node_schema::NODE_MIGRATIONS_V1;
use rusqlite::Connection;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::Command,
};

fn fixture() -> PathBuf {
    let root = std::env::temp_dir().join(format!(
        "hepta-native-release-attest-{}",
        std::process::id()
    ));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(&root).expect("fixture root");
    fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).expect("root mode");
    root
}

fn schema25_database(root: &Path) -> PathBuf {
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

#[test]
fn native_release_attest_composes_local_checks_and_stays_blocked() {
    let root = fixture();
    let database = schema25_database(&root);
    let archive = root.join("reference.tar.gz");
    fs::write(&archive, b"reference archive").expect("archive");
    let drill = LegacyDeletionDrillAttestationRequestV1 {
        version: 1,
        kind: "LegacyDeletionDrillAttestationRequest".to_owned(),
        legacy_database_path: database.to_string_lossy().into_owned(),
        archive_path: archive.to_string_lossy().into_owned(),
        repository: "TrillionniumFoundation/hepta-paper".to_owned(),
        commit: "a".repeat(40),
        tree: "b".repeat(40),
        release_commit: "a".repeat(40),
        release_state_snapshot_hash: format!("sha256:{}", "c".repeat(64)),
    };
    let request = ReleaseAttestationRequestV1 {
        version: 1,
        kind: "ReleaseAttestationRequest".to_owned(),
        drill,
        release_state: json!({}),
        release_trust_gate: json!({
            "releaseCommit": "a".repeat(40),
            "capabilityCount": 1,
            "implementationVerified": 0,
            "releaseBoundConformanceVerified": 0,
            "independentProductionOperationalVerified": 0
        }),
    };
    let report = inspect_release_attestation_v1(request.clone()).expect("inspection report");
    assert_eq!(report["kind"], "ReleaseAttestationInspection");
    assert_eq!(report["status"], "release_attestation_blocked");
    assert_eq!(report["releaseEvidenceReady"], false);
    assert_eq!(report["signingKeyRead"], false);
    assert_eq!(report["runtimeEvidenceWritten"], false);
    assert_eq!(report["externalActionPerformed"], false);
    assert!(
        report["reportHash"]
            .as_str()
            .is_some_and(|v| v.starts_with("sha256:"))
    );
    assert!(report["blockers"].as_array().is_some_and(|items| {
        items
            .iter()
            .any(|value| value == "release_attestation_node_differential_replay_external")
    }));
    let request_path = root.join("request.json");
    fs::write(
        &request_path,
        serde_json::to_vec(&request).expect("request JSON"),
    )
    .expect("request file");
    let output = Command::new(env!("CARGO_BIN_EXE_hepta-paper-rust"))
        .args(["release-attest", request_path.to_str().expect("UTF-8 path")])
        .output()
        .expect("native CLI");
    assert!(!output.status.success());
    let cli_report: Value = serde_json::from_slice(&output.stdout).expect("CLI report JSON");
    assert_eq!(cli_report["kind"], "ReleaseAttestationInspection");
    assert_eq!(cli_report["releaseEvidenceReady"], false);
    let _ = fs::remove_dir_all(root);
}
