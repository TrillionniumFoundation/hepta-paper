use ed25519_dalek::{SigningKey, pkcs8::EncodePrivateKey};
use hepta_paper_service::local_state_authority_client::{
    LocalStateAuthorityClientOptionsV1, request_local_state_authority_v1,
};
use nix::{
    sys::signal::{Signal, kill},
    unistd::Pid,
};
use serde_json::{Value, json};
use std::{
    fs,
    io::Write,
    os::unix::fs::{FileTypeExt, MetadataExt, PermissionsExt},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::atomic::{AtomicU64, Ordering},
    thread,
    time::{Duration, Instant},
};
const BIN: &str = env!("CARGO_BIN_EXE_hepta-paper-state-authority-daemon");
static NEXT: AtomicU64 = AtomicU64::new(0);
struct ChildOwner(Child);
impl Drop for ChildOwner {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
struct Fixture(PathBuf);
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn daemon_argument_modes_match_original_node_without_starting_node_authority() {
    let rows = vec![
        vec!["--help"],
        vec!["--configuration=a/../b", "--help"],
        vec!["--help", "--configuration", "-x"],
        vec!["--help", "--unknown=x"],
        vec!["--help", "--configuration"],
        vec!["--configuration=", "--help"],
        vec!["--configuration", "", "--help"],
        vec!["--help", "--configuration=a", "--configuration=b"],
        vec!["--help", "--help"],
        vec!["--help=true"],
        vec!["--help", "--"],
        vec!["--help", "--=x"],
        vec!["--help", "-x"],
    ];
    let mut node = Command::new("node")
        .arg(
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../../oracle/local-state-authority-daemon-cli-v1.mjs"),
        )
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    node.stdin
        .take()
        .unwrap()
        .write_all(json!(rows).to_string().as_bytes())
        .unwrap();
    let output = node.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let expected: Vec<Value> = serde_json::from_slice(&output.stdout).unwrap();
    for (args, expect) in rows.iter().zip(expected) {
        let result = Command::new(BIN).args(args).output().unwrap();
        if expect["ok"] == true {
            assert!(result.status.success(), "{args:?}");
            assert!(result.stderr.is_empty());
            assert_eq!(
                String::from_utf8(result.stdout).unwrap(),
                format!("{}\n", expect["value"]["help"].as_str().unwrap())
            );
        } else {
            assert_eq!(result.status.code(), Some(1), "{args:?}");
            assert!(result.stdout.is_empty());
            assert_eq!(
                String::from_utf8(result.stderr).unwrap(),
                format!("{}\n", expect["error"].as_str().unwrap()),
                "{args:?}"
            );
        }
    }
}

#[test]
fn actual_native_daemon_with_zero_umask_serves_and_cleans_up_on_sigterm() {
    let root = Fixture(std::env::temp_dir().join(format!(
        "hepta-native-daemon-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    )));
    fs::create_dir(&root.0).unwrap();
    fs::set_permissions(&root.0, fs::Permissions::from_mode(0o700)).unwrap();
    let private = SigningKey::from_bytes(&[97; 32])
        .to_pkcs8_pem(Default::default())
        .unwrap();
    let key = root.0.join("private.pem");
    fs::write(&key, private.as_bytes()).unwrap();
    fs::set_permissions(&key, fs::Permissions::from_mode(0o600)).unwrap();
    let socket = root.0.join("authority.sock");
    let configuration = json!({"version":1,"kind":"HeptaLocalAutonomousResearchStateAuthorityConfiguration","authorityId":"authority:test","keyId":"key:test","scopeId":"scope:test",
        "databaseScopeHash":format!("sha256:{}","a".repeat(64)),"writerManifestHash":format!("sha256:{}","b".repeat(64)),"privateKeyPath":key,
        "stateDatabasePath":root.0.join("authority.sqlite"),"socketPath":socket,"maximumReservationLeaseMs":60000,"maximumObservationAgeMs":60000});
    let config = root.0.join("configuration.json");
    fs::write(&config, configuration.to_string()).unwrap();
    fs::set_permissions(&config, fs::Permissions::from_mode(0o600)).unwrap();
    // Only the child changes its umask; parallel tests keep their process state.
    let spawn = || {
        Command::new("sh")
            .args(["-c", "umask 000; exec \"$@\"", "sh", BIN])
            .arg(format!("--configuration={}", config.display()))
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap()
    };
    let mut child = ChildOwner(spawn());
    let deadline = Instant::now() + Duration::from_secs(10);
    while !socket.exists() {
        assert!(
            child.0.try_wait().unwrap().is_none(),
            "daemon exited before publication"
        );
        assert!(Instant::now() < deadline, "daemon startup timed out");
        thread::sleep(Duration::from_millis(5));
    }
    let options = LocalStateAuthorityClientOptionsV1 {
        socket_path: socket.clone(),
        timeout_ms: 5000,
        ..Default::default()
    };
    assert_eq!(
        request_local_state_authority_v1(&json!({"kind":"UnsupportedFixtureRequest"}), &options)
            .unwrap_err()
            .to_string(),
        "local_state_authority_request_kind_unsupported"
    );
    let metadata = fs::symlink_metadata(&socket).unwrap();
    assert!(metadata.file_type().is_socket());
    assert_eq!(metadata.mode() & 0o7777, 0o660);
    assert_eq!(metadata.gid(), nix::unistd::getegid().as_raw());
    assert_eq!(metadata.nlink(), 1);
    assert!(
        !fs::read_dir(&root.0).unwrap().any(|v| v
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(".s-"))
    );
    kill(Pid::from_raw(child.0.id() as i32), Signal::SIGKILL).unwrap();
    assert!(!child.0.wait().unwrap().success());
    assert!(
        socket.exists(),
        "SIGKILL must leave a real stale socket fixture"
    );
    child = ChildOwner(spawn());
    let restarted_deadline = Instant::now() + Duration::from_secs(10);
    loop {
        assert!(
            child.0.try_wait().unwrap().is_none(),
            "daemon restart failed"
        );
        let response = request_local_state_authority_v1(
            &json!({"kind":"UnsupportedFixtureRequest"}),
            &options,
        );
        if response
            .is_err_and(|e| e.to_string() == "local_state_authority_request_kind_unsupported")
        {
            break;
        }
        assert!(
            Instant::now() < restarted_deadline,
            "daemon did not reclaim stale socket"
        );
        thread::sleep(Duration::from_millis(5));
    }
    kill(Pid::from_raw(child.0.id() as i32), Signal::SIGTERM).unwrap();
    while child.0.try_wait().unwrap().is_none() {
        assert!(
            Instant::now() < restarted_deadline,
            "daemon shutdown timed out"
        );
        thread::sleep(Duration::from_millis(5));
    }
    assert!(child.0.wait().unwrap().success());
    assert!(!socket.exists());
    assert_eq!(
        fs::symlink_metadata(root.0.join("authority.sqlite"))
            .unwrap()
            .mode()
            & 0o7777,
        0o600
    );
}
