//! Actual ten-database backup/recovery service through one Rust daemon origin.
//! Node supplies incumbent schema/data and verifies the installation protocol;
//! service construction, backup, restore and reconciliation run in Rust. These
//! supplied-key fixtures do not establish installed principals or activation.
use ed25519_dalek::{
    SigningKey,
    pkcs8::{EncodePrivateKey, EncodePublicKey},
};
use hepta_paper_service::{
    local_state_authority_client::LocalStateAuthoritySocketTransportV1,
    online_mutation_composition::BuiltinOnlineMutationPlansV1,
    sqlite_mutation_coordinator::{SqliteMutationCoordinatorError, clock::SystemMutationClockV1},
    state_recoverability::service::{BackupRecoveryServiceOptionsV1, BackupRecoveryServiceV1},
};
use nix::{
    sys::{
        signal::{Signal, kill},
        wait::{WaitPidFlag, WaitStatus, waitpid},
    },
    unistd::Pid,
};
use rusqlite::{Connection, OpenFlags};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Read, Write},
    os::unix::{
        fs::PermissionsExt,
        net::UnixListener,
        process::{CommandExt, ExitStatusExt},
    },
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::atomic::{AtomicU64, Ordering},
    thread,
    time::{Duration, Instant},
};

type Service = BackupRecoveryServiceV1<
    LocalStateAuthoritySocketTransportV1,
    LocalStateAuthoritySocketTransportV1,
>;
static NEXT: AtomicU64 = AtomicU64::new(0);

fn repository() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..")
}
fn digest(bytes: impl AsRef<[u8]>) -> String {
    format!("sha256:{}", hex::encode(Sha256::digest(bytes.as_ref())))
}
fn write_private(path: &Path, bytes: impl AsRef<[u8]>) {
    fs::write(path, bytes).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
}
fn write_json(path: &Path, value: &Value) -> String {
    let bytes = serde_json::to_vec(value).unwrap();
    write_private(path, &bytes);
    digest(bytes)
}
fn read_json(path: impl AsRef<Path>) -> Value {
    serde_json::from_slice(&fs::read(path).unwrap()).unwrap()
}

struct Root(PathBuf);
impl Root {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "hepta-online-initial-composition-socket-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
        Self(path)
    }
}
impl Drop for Root {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
struct Daemon(Child);
impl Daemon {
    fn start(root: &Root) -> Self {
        let mut daemon = Self(
            Command::new(env!("CARGO_BIN_EXE_hepta-paper-state-authority-daemon"))
                .arg("--configuration")
                .arg(root.0.join("daemon.json"))
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::inherit())
                .process_group(0)
                .spawn()
                .unwrap(),
        );
        let deadline = Instant::now() + Duration::from_secs(10);
        while !root.0.join("authority.sock").exists() {
            assert!(daemon.0.try_wait().unwrap().is_none());
            assert!(Instant::now() < deadline, "actual daemon startup deadline");
            thread::sleep(Duration::from_millis(5));
        }
        daemon
    }
    fn pause(&mut self) {
        let pid = Pid::from_raw(self.0.id() as i32);
        kill(pid, Signal::SIGSTOP).unwrap();
        assert_eq!(
            waitpid(pid, Some(WaitPidFlag::WUNTRACED)).unwrap(),
            WaitStatus::Stopped(pid, Signal::SIGSTOP)
        );
    }
    fn terminate_paused(&mut self) {
        self.0.kill().unwrap();
        assert_eq!(
            self.0.wait().unwrap().signal(),
            Some(Signal::SIGKILL as i32)
        );
    }
}
impl Drop for Daemon {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn oracle(root: &Root, mode: &str, public_key: Option<String>) -> Value {
    let mut process = Command::new("node")
        .arg(repository().join("rust/oracle/native-authority-business-composition-v1.mjs"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    process
        .stdin
        .take()
        .unwrap()
        .write_all(
            json!({"root":root.0,"mode":mode,"publicKeyPem":public_key})
                .to_string()
                .as_bytes(),
        )
        .unwrap();
    let output = process.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let response: Value = serde_json::from_slice(&output.stdout).unwrap();
    hepta_legacy_compatibility::qualify_production_node_profile_v1(&response["profile"]).unwrap();
    assert_eq!(response["ok"], true, "{response}");
    response["value"].clone()
}
fn prepare(root: &Root) -> Value {
    let example = std::env::current_exe()
        .unwrap()
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("examples/native-authority-fixture-client");
    assert!(
        example.is_file(),
        "build the native-authority-fixture-client example first"
    );
    let adapter = root.0.join("native-fixture-client");
    fs::copy(example, &adapter).unwrap();
    fs::set_permissions(&adapter, fs::Permissions::from_mode(0o700)).unwrap();
    // Only the fresh test copy is stripped, before the oracle pins its bytes.
    assert!(
        Command::new("strip")
            .arg("--strip-debug")
            .arg(&adapter)
            .status()
            .unwrap()
            .success()
    );
    assert!(fs::metadata(&adapter).unwrap().len() < 128 * 1024 * 1024);
    write_json(
        &root.0.join("adapter.json"),
        &json!({
            "version":1,"kind":"HeptaNativeAuthorityTestSocketBindingV1",
            "socketPath":root.0.join("authority.sock")
        }),
    );
    let key = SigningKey::from_bytes(&[107; 32]);
    write_private(
        &root.0.join("supplied-key.pem"),
        key.to_pkcs8_pem(Default::default()).unwrap(),
    );
    oracle(
        root,
        "prepare",
        Some(
            key.verifying_key()
                .to_public_key_pem(Default::default())
                .unwrap(),
        ),
    )
}
fn socket_configuration(root: &Root, fixture: &Value) -> Value {
    let mut value = read_json(fixture["backupConfiguration"].as_str().unwrap());
    let object = value.as_object_mut().unwrap();
    for key in ["commandPath", "commandSha256", "fixedArguments"] {
        object.remove(key);
    }
    value["version"] = json!(1);
    value["kind"] = json!("AutonomousResearchStateBackupAuthoritySocketConfiguration");
    value["socketPath"] = json!(root.0.join("authority.sock"));
    value["timeoutMs"] = json!(5000);
    value["maximumMessageBytes"] = json!(16 * 1024 * 1024);
    value
}
fn options(fixture: &Value) -> BackupRecoveryServiceOptionsV1 {
    BackupRecoveryServiceOptionsV1 {
        runtime_root: fixture["runtime"].as_str().unwrap().into(),
        backup_root: fixture["backupRoot"].as_str().unwrap().into(),
        state_database_manifest: read_json(
            repository().join("paper-core/config/autonomous-research-state-databases.v1.json"),
        ),
        writer_manifest: BuiltinOnlineMutationPlansV1::load()
            .unwrap()
            .writer_manifest()
            .clone(),
    }
}
fn not_sent(error: SqliteMutationCoordinatorError, expected: &str) {
    assert_eq!(error.code, expected, "{error:?}");
    assert_eq!(error.details["requestBytesSent"], 0);
    assert_eq!(error.details["authorityOutcome"], "not_invoked");
    assert!(!error.retryable);
}
fn empty_connections(listener: &UnixListener) -> usize {
    let mut count = 0;
    loop {
        match listener.accept() {
            Ok((stream, _)) => {
                stream
                    .set_read_timeout(Some(Duration::from_secs(1)))
                    .unwrap();
                let mut bytes = Vec::new();
                stream.take(1024).read_to_end(&mut bytes).unwrap();
                assert!(bytes.is_empty(), "replacement received authority bytes");
                count += 1;
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => return count,
            Err(error) => panic!("replacement listener: {error}"),
        }
    }
}

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
