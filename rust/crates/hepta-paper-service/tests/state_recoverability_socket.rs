//! Actual ten-database recovery through one original Rust daemon peer.
#[allow(dead_code)]
#[path = "state_recoverability_socket/support.rs"]
mod support;
use ed25519_dalek::{SigningKey, pkcs8::EncodePublicKey};
use hepta_paper_service::sqlite_mutation_coordinator::clock::SystemMutationClockV1;
use rusqlite::{Connection, OpenFlags};
use serde_json::json;
use std::{fs, os::unix::net::UnixListener, path::Path};
use support::*;

#[test]
fn actual_daemon_service_backs_up_restores_reconciles_and_keeps_one_original_peer() {
    let root = Root::new();
    let fixture = prepare(&root);
    let mut daemon = Daemon::start(&root);
    let installed = oracle(&root, "install", None);
    assert_eq!(
        installed["inventory"]["instances"]
            .as_array()
            .unwrap()
            .len(),
        10
    );
    let configuration = socket_configuration(&root, &fixture);
    let path = root.0.join("backup-socket.json");
    let pin = write_json(&path, &configuration);

    // Reject malformed options and real, internally pinned scope/key drift
    // before even an empty probe is observable on a separate live listener.
    let refused_path = root.0.join("refused.sock");
    let refused = UnixListener::bind(&refused_path).unwrap();
    refused.set_nonblocking(true).unwrap();
    for case in [
        "raw-pin",
        "options",
        "databaseScopeHash",
        "writerManifestHash",
        "key",
    ] {
        let mut candidate = configuration.clone();
        candidate["socketPath"] = json!(refused_path);
        let mut settings = options(&fixture);
        match case {
            "options" => settings.runtime_root = "relative-runtime".into(),
            "databaseScopeHash" | "writerManifestHash" => {
                let mut online = read_json(fixture["onlineConfiguration"].as_str().unwrap());
                online[case] = json!(digest(case));
                let online_path = root.0.join(format!("refused-{case}.json"));
                candidate["onlineMutationAuthorityConfigurationSha256"] =
                    json!(write_json(&online_path, &online));
                candidate["onlineMutationAuthorityConfigurationPath"] = json!(online_path);
            }
            "key" => {
                let mut public = read_json(candidate["publicKeyPath"].as_str().unwrap());
                public["publicKeyPem"] = json!(
                    SigningKey::from_bytes(&[108; 32])
                        .verifying_key()
                        .to_public_key_pem(Default::default())
                        .unwrap()
                );
                let public_path = root.0.join("refused-public.json");
                candidate["publicKeySha256"] = json!(write_json(&public_path, &public));
                candidate["publicKeyPath"] = json!(public_path);
            }
            _ => {}
        }
        let candidate_path = root.0.join(format!("refused-profile-{case}.json"));
        let raw_pin = write_json(&candidate_path, &candidate);
        let supplied_pin = if case == "raw-pin" {
            digest("wrong")
        } else {
            raw_pin
        };
        let error = Service::load_socket_v1(&candidate_path, &supplied_pin, settings)
            .err()
            .unwrap();
        let expected = match case {
            "raw-pin" => "autonomous_research_state_backup_authority_socket_configuration_invalid",
            "options" => {
                "autonomous_research_state_reconcile_and_renew_backup_online_authority_mismatch"
            }
            "key" => "autonomous_research_state_backup_online_authority_binding_mismatch",
            _ => "autonomous_research_state_reconcile_and_renew_authority_scope_mismatch",
        };
        assert_eq!(error.code, expected, "{case}: {error:?}");
        assert_eq!(empty_connections(&refused), 0, "{case} opened a probe");
    }

    let mut service = Service::load_socket_v1(&path, &pin, options(&fixture)).unwrap();
    let mut clock = SystemMutationClockV1;
    let pending = service.reconcile_pending(&mut clock).unwrap();
    assert_eq!(pending.value()["reconciledDatabaseCount"], 10);
    assert_eq!(pending.value()["recoveredFinalizationCount"], 0);
    assert_eq!(pending.value()["businessDmlReplayed"], false);
    drop(pending);
    let backup = service.backup(&mut clock).unwrap();
    assert_eq!(backup["databaseCount"], 10);
    assert_eq!(
        backup["status"],
        "autonomous_research_state_backup_recorded"
    );
    let bundle = Path::new(backup["bundlePath"].as_str().unwrap());
    let manifest = read_json(bundle.join("AUTONOMOUS_RESEARCH_STATE_BACKUP.json"));
    for entry in manifest["content"]["databases"].as_array().unwrap() {
        let bytes = fs::read(bundle.join(entry["backupRelativePath"].as_str().unwrap())).unwrap();
        assert!(bytes.starts_with(b"SQLite format 3\0"));
    }
    let drill = service.restore_drill(bundle, &mut clock).unwrap();
    assert_eq!(
        drill["status"],
        "autonomous_research_state_restore_drill_passed"
    );
    assert_eq!(drill["databaseCount"], 10);
    assert_eq!(drill["productionStateMutated"], false);
    assert_eq!(read_json(bundle.join("RESTORE_DRILL_RECEIPT.json")), drill);
    let journal = Connection::open_with_flags(
        root.0.join("authority.sqlite"),
        OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    let finalized: i64 = journal.query_row("SELECT count(*) FROM authority_backup_reservation WHERE finalization_receipt_json IS NOT NULL", [], |row| row.get(0)).unwrap();
    assert_eq!(finalized, 1);
    journal.close().unwrap();

    // Keep the original process alive while a DIFFERENT process (this test)
    // owns a replacement socket at exactly the same pathname.
    // Pause only this test child: otherwise the real daemon correctly detects
    // its own socket replacement and exits before the clients can observe the
    // distinct live-origin replacement case. A stopped process has a live pidfd.
    daemon.pause();
    fs::remove_file(root.0.join("authority.sock")).unwrap();
    let replacement = UnixListener::bind(root.0.join("authority.sock")).unwrap();
    replacement.set_nonblocking(true).unwrap();
    not_sent(
        service.backup(&mut clock).unwrap_err(),
        "local_state_authority_socket_peer_changed",
    );
    not_sent(
        service.reconcile_pending(&mut clock).err().unwrap(),
        "local_state_authority_socket_peer_changed",
    );
    assert_eq!(empty_connections(&replacement), 2);
    daemon.terminate_paused();
    not_sent(
        service.backup(&mut clock).unwrap_err(),
        "local_state_authority_socket_peer_exited",
    );
    not_sent(
        service.reconcile_pending(&mut clock).err().unwrap(),
        "local_state_authority_socket_peer_exited",
    );
    assert_eq!(
        empty_connections(&replacement),
        0,
        "dead origin must be rejected before connect"
    );
}
