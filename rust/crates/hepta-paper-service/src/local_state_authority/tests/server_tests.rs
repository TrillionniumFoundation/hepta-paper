use super::*;
use crate::local_state_authority_client::{
    LocalStateAuthorityClientOptionsV1, request_local_state_authority_v1,
};
use std::{
    io::{Read, Write},
    net::Shutdown,
    os::unix::{fs::MetadataExt, net::UnixStream},
    process::{Command, Stdio},
    sync::{Arc, atomic::AtomicBool},
    thread::{self, JoinHandle},
};

struct Running {
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<Result<()>>>,
}
impl Running {
    fn new(mut server: LocalStateAuthorityServerV1) -> Self {
        let stop = Arc::new(AtomicBool::new(false));
        let child_stop = stop.clone();
        let thread = thread::spawn(move || server.serve(&child_stop));
        Self {
            stop,
            thread: Some(thread),
        }
    }
}
impl Drop for Running {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        let _ = self.thread.take().unwrap().join();
    }
}
fn node_oracle(name: &str, input: &Value) -> Value {
    let mut child = Command::new("node")
        .arg(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(format!("../../oracle/{name}")))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(input.to_string().as_bytes())
        .unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap()
}

#[test]
fn original_node_client_and_native_client_use_real_native_signing_server() {
    let fixture = Fixture::new();
    let socket = PathBuf::from(fixture.config["socketPath"].as_str().unwrap());
    let server = LocalStateAuthorityServerV1::bind(fixture.runtime()).unwrap();
    assert_eq!(server.socket_path(), socket);
    let mode = fs::symlink_metadata(&socket).unwrap();
    assert_eq!(mode.mode() & 0o7777, 0o660);
    assert_eq!(mode.gid(), nix::unistd::getegid().as_raw());
    let running = Running::new(server);
    let result = node_oracle(
        "local-state-authority-client-v1.mjs",
        &json!({
            "operation":"request","options":{"request":fixture.reserve,"socketPath":socket,"timeoutMs":5000}
        }),
    );
    assert_eq!(result["result"]["ok"], true, "{result}");
    let reservation = result["result"]["value"].clone();
    let options = LocalStateAuthorityClientOptionsV1 {
        socket_path: socket.clone(),
        timeout_ms: 5000,
        ..Default::default()
    };
    assert_eq!(
        request_local_state_authority_v1(&fixture.reserve, &options).unwrap(),
        reservation
    );
    let finalize = fixture.finalize(&reservation);
    let finalization = request_local_state_authority_v1(&finalize, &options).unwrap();
    let observe = fixture.observe(&finalize, &finalization);
    let observation = request_local_state_authority_v1(&observe, &options).unwrap();
    let verified = node_oracle(
        "local-state-authority-runtime-v1.mjs",
        &json!({
            "configurationPath":fixture.config_path,"reserve":fixture.reserve,"reservation":reservation,
            "finalize":finalize,"finalization":finalization,"observe":observe,"observation":observation,"now":NOW
        }),
    );
    assert_eq!(verified["accepted"], json!([true, true, true]));
    // Invalid untrusted JSON produces one error envelope and leaves the server
    // available for the next independently framed request.
    let mut malformed = UnixStream::connect(&socket).unwrap();
    malformed
        .set_read_timeout(Some(std::time::Duration::from_secs(5)))
        .unwrap();
    malformed.write_all(b"{\"kind\":1,\"kind\":2}\n").unwrap();
    malformed.shutdown(Shutdown::Write).unwrap();
    let mut output = String::new();
    malformed.read_to_string(&mut output).unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&output).unwrap(),
        json!({"ok":false,"error":"local_state_authority_request_invalid"})
    );
    assert_eq!(
        request_local_state_authority_v1(&observe, &options).unwrap(),
        observation
    );
    drop(running);
    assert!(!socket.exists());
    assert_eq!(fixture.runtime().handle(&observe).unwrap(), observation);
}

#[test]
fn socket_publication_never_overwrites_or_removes_other_owners_names() {
    let fixture = Fixture::new();
    let socket = fixture.root.join("authority.sock");
    fs::write(&socket, b"sentinel").unwrap();
    let result = LocalStateAuthorityServerV1::bind(fixture.runtime());
    assert_eq!(
        result.err().unwrap().code,
        "local_state_authority_socket_path_conflict"
    );
    assert_eq!(fs::read(&socket).unwrap(), b"sentinel");
    assert!(
        !fs::read_dir(&fixture.root).unwrap().any(|v| v
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(".s-"))
    );
    fs::remove_file(&socket).unwrap();
    let server = LocalStateAuthorityServerV1::bind(fixture.runtime()).unwrap();
    let saved = fixture.root.join("saved.sock");
    fs::rename(&socket, &saved).unwrap();
    fs::write(&socket, b"replacement").unwrap();
    drop(server);
    assert_eq!(fs::read(&socket).unwrap(), b"replacement");
    assert!(saved.exists());
}

#[test]
fn socket_permission_change_fences_serving_before_any_request() {
    let fixture = Fixture::new();
    let mut server = LocalStateAuthorityServerV1::bind(fixture.runtime()).unwrap();
    fs::set_permissions(server.socket_path(), fs::Permissions::from_mode(0o666)).unwrap();
    let error = server.serve(&AtomicBool::new(false)).unwrap_err();
    assert_eq!(error.code, "local_state_authority_socket_identity_changed");
}

#[test]
fn idle_or_trickling_peers_do_not_block_other_complete_requests() {
    let fixture = Fixture::new();
    let server = LocalStateAuthorityServerV1::bind(fixture.runtime()).unwrap();
    let socket = server.socket_path().to_path_buf();
    let running = Running::new(server);
    let idle = UnixStream::connect(&socket).unwrap();
    let mut partial = UnixStream::connect(&socket).unwrap();
    partial.write_all(b"{\"kind\":").unwrap();
    let options = LocalStateAuthorityClientOptionsV1 {
        socket_path: socket.clone(),
        timeout_ms: 1000,
        ..Default::default()
    };
    let reservation = request_local_state_authority_v1(&fixture.reserve, &options).unwrap();
    let finalize = fixture.finalize(&reservation);
    request_local_state_authority_v1(&finalize, &options).unwrap();
    // Shutdown also closes incomplete peers without waiting for their deadline.
    let started = std::time::Instant::now();
    drop(running);
    assert!(started.elapsed() < std::time::Duration::from_secs(1));
    assert!(!socket.exists());
    drop((idle, partial));
}
