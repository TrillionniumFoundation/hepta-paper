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
    sqlite_mutation_coordinator::SqliteMutationCoordinatorError,
    state_recoverability::service::{BackupRecoveryServiceOptionsV1, BackupRecoveryServiceV1},
};
use nix::{
    sys::{
        signal::{Signal, kill},
        wait::{WaitPidFlag, WaitStatus, waitpid},
    },
    unistd::Pid,
};
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

pub(super) type Service = BackupRecoveryServiceV1<
    LocalStateAuthoritySocketTransportV1,
    LocalStateAuthoritySocketTransportV1,
>;
static NEXT: AtomicU64 = AtomicU64::new(0);

pub(super) fn repository() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..")
}
pub(super) fn digest(bytes: impl AsRef<[u8]>) -> String {
    format!("sha256:{}", hex::encode(Sha256::digest(bytes.as_ref())))
}
pub(super) fn write_private(path: &Path, bytes: impl AsRef<[u8]>) {
    fs::write(path, bytes).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
}
pub(super) fn write_json(path: &Path, value: &Value) -> String {
    let bytes = serde_json::to_vec(value).unwrap();
    write_private(path, &bytes);
    digest(bytes)
}
pub(super) fn read_json(path: impl AsRef<Path>) -> Value {
    serde_json::from_slice(&fs::read(path).unwrap()).unwrap()
}

pub(super) struct Root(pub(super) PathBuf);
impl Root {
    pub(super) fn new() -> Self {
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
pub(super) struct Daemon(Child);
impl Daemon {
    pub(super) fn start(root: &Root) -> Self {
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
    pub(super) fn stop(&mut self) {
        kill(Pid::from_raw(self.0.id() as i32), Signal::SIGTERM).unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            if let Some(status) = self.0.try_wait().unwrap() {
                assert!(status.success());
                return;
            }
            assert!(Instant::now() < deadline, "test daemon shutdown deadline");
            thread::sleep(Duration::from_millis(5));
        }
    }
    pub(super) fn pause(&mut self) {
        let pid = Pid::from_raw(self.0.id() as i32);
        kill(pid, Signal::SIGSTOP).unwrap();
        assert_eq!(
            waitpid(pid, Some(WaitPidFlag::WUNTRACED)).unwrap(),
            WaitStatus::Stopped(pid, Signal::SIGSTOP)
        );
    }
    pub(super) fn terminate_paused(&mut self) {
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

pub(super) fn oracle(root: &Root, mode: &str, public_key: Option<String>) -> Value {
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
pub(super) fn prepare(root: &Root) -> Value {
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
pub(super) fn socket_configuration(root: &Root, fixture: &Value) -> Value {
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
pub(super) fn options(fixture: &Value) -> BackupRecoveryServiceOptionsV1 {
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
pub(super) fn not_sent(error: SqliteMutationCoordinatorError, expected: &str) {
    assert_eq!(error.code, expected, "{error:?}");
    assert_eq!(error.details["requestBytesSent"], 0);
    assert_eq!(error.details["authorityOutcome"], "not_invoked");
    assert!(!error.retryable);
}
pub(super) fn empty_connections(listener: &UnixListener) -> usize {
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
