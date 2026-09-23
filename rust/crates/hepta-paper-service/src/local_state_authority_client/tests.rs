use super::*;
mod raw;
use std::{
    fs,
    io::{BufRead, BufReader},
    os::unix::{fs::PermissionsExt, net::UnixListener},
    path::Path,
    process::{Child, Command, Stdio},
    sync::atomic::{AtomicU64, Ordering},
};
static NEXT: AtomicU64 = AtomicU64::new(0);
struct Temp(PathBuf);
impl Temp {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "hepta-local-authority-client-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
        Self(path)
    }
    fn options(&self) -> LocalStateAuthorityClientOptionsV1 {
        LocalStateAuthorityClientOptionsV1 {
            socket_path: self.0.join("authority.sock"),
            ..Default::default()
        }
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn oracle_path() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../oracle/local-state-authority-client-v1.mjs")
}
fn profile(value: &Value) {
    hepta_legacy_compatibility::qualify_production_node_profile_v1(&value["profile"]).unwrap();
}
fn oracle(input: Value) -> Value {
    let mut child = Command::new("node")
        .arg(oracle_path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(&serde_json::to_vec(&input).unwrap())
        .unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let value: Value = serde_json::from_slice(&output.stdout).unwrap();
    profile(&value);
    value["result"].clone()
}
fn node_request(request: &Value, options: &LocalStateAuthorityClientOptionsV1) -> Value {
    oracle(
        json!({"operation":"request","options":{"request":request,"socketPath":options.socket_path,"timeoutMs":options.timeout_ms,"maximumMessageBytes":options.maximum_message_bytes}}),
    )
}
fn native_result(result: Result<Value>) -> Value {
    match result {
        Ok(value) => json!({"ok":true,"value":value}),
        Err(error) => json!({"ok":false,"error":error.to_string()}),
    }
}
fn server(
    options: &LocalStateAuthorityClientOptionsV1,
    replies: Vec<Vec<u8>>,
    request: Value,
) -> thread::JoinHandle<()> {
    let listener = UnixListener::bind(&options.socket_path).unwrap();
    listener.set_nonblocking(true).unwrap();
    thread::spawn(move || {
        for reply in replies {
            let deadline = Instant::now() + Duration::from_secs(10);
            let mut stream = loop {
                match listener.accept() {
                    Ok((stream, _)) => break stream,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        assert!(Instant::now() < deadline, "client never connected");
                        thread::sleep(Duration::from_millis(2));
                    }
                    Err(error) => panic!("accept: {error}"),
                }
            };
            stream
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let mut bytes = Vec::new();
            stream.read_to_end(&mut bytes).unwrap();
            assert!(bytes.ends_with(b"\n"));
            assert_eq!(serde_json::from_slice::<Value>(&bytes).unwrap(), request);
            // read_to_end completed only after the client really half-closed.
            for chunk in reply.chunks(17) {
                if stream.write_all(chunk).is_err() {
                    break;
                }
            }
        }
    })
}
struct NodeServer(Child);
impl Drop for NodeServer {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

#[test]
fn native_client_interoperates_with_actual_incumbent_unix_server_and_client() {
    let temp = Temp::new();
    let options = temp.options();
    let mut child = NodeServer(
        Command::new("node")
            .arg(oracle_path())
            .arg("server")
            .arg(&options.socket_path)
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap(),
    );
    let mut ready = String::new();
    BufReader::new(child.0.stdout.take().unwrap())
        .read_line(&mut ready)
        .unwrap();
    let value: Value = serde_json::from_str(&ready).unwrap();
    profile(&value);
    assert_eq!(value["ready"], true);
    for request in [
        json!({"version":1,"kind":"AutonomousResearchOnlineMutationCurrentHeadRequest","nonce":"nonce:test","requestedAt":"2026-09-21T00:00:00.000Z","scopeId":"scope:test"}),
        json!({"unicode":"中\n文","nested":[false,null,12,1.25,{"x":"y"}]}),
        json!({"kind":"reject"}),
    ] {
        assert_eq!(
            native_result(request_local_state_authority_v1(&request, &options)),
            node_request(&request, &options)
        );
    }
}

#[test]
fn half_close_chunked_envelopes_and_remote_errors_match_actual_node_client() {
    for reply in [
        r#"{"ok":true,"receipt":{"version":1,"kind":"Receipt","nested":{"a":[null,1,true,"中"]}}}"#,
        r#"{"ok":false,"error":"authority_rejected"}"#,
        r#"{"ok":true,"receipt":[]}"#,
        r#"{"ok":1,"receipt":{}}"#,
        r#"{"ok":false,"error":0}"#,
        r#"{"ok":false,"error":["x",null,3]}"#,
        r#"{"ok":false,"error":{"x":1}}"#,
        "",
        "not-json",
        "null",
    ] {
        let temp = Temp::new();
        let options = temp.options();
        let request = json!({"kind":"echo","version":1});
        let worker = server(
            &options,
            vec![reply.as_bytes().to_vec(); 2],
            request.clone(),
        );
        assert_eq!(
            native_result(request_local_state_authority_v1(&request, &options)),
            node_request(&request, &options),
            "{reply}"
        );
        worker.join().unwrap();
    }
}

#[test]
fn strict_json_rejects_ambiguous_inputs_and_responses_before_returning_a_receipt() {
    let temp = Temp::new();
    let options = temp.options();
    for input in [
        br#"{"kind":"one","kind":"two"}"#.as_slice(),
        br#"{"x":1e400}"#,
        br#"{"x":"\ud800"}"#,
        b"{\"x\":\"\xff\"}",
    ] {
        assert_eq!(
            run_local_state_authority_client_v1(&[], input, &options)
                .unwrap_err()
                .to_string(),
            "local_state_authority_client_request_invalid"
        );
    }
    for reply in [
        br#"{"ok":true,"ok":true,"receipt":{}}"#.as_slice(),
        br#"{"ok":true,"receipt":{"x":1e400}}"#,
        br#"{"ok":true,"receipt":{"x":"\ud800"}}"#,
    ] {
        let temp = Temp::new();
        let options = temp.options();
        let request = json!({});
        let worker = server(&options, vec![reply.to_vec(); 2], request.clone());
        assert_eq!(
            request_local_state_authority_v1(&request, &options)
                .unwrap_err()
                .to_string(),
            "local_state_authority_client_response_invalid"
        );
        assert_eq!(
            oracle(
                json!({"operation":"request","statusOnly":true,"options":{"request":request,"socketPath":options.socket_path}})
            )["ok"],
            true,
            "documented strict subset must be measured against Node"
        );
        worker.join().unwrap();
    }
}

#[test]
fn byte_limits_configuration_and_connection_failures_are_bounded() {
    let temp = Temp::new();
    let mut options = temp.options();
    options.maximum_message_bytes = 1024;
    let request = json!({"data":"x".repeat(2000)});
    assert_eq!(
        native_result(request_local_state_authority_v1(&request, &options)),
        node_request(&request, &options)
    );
    assert_eq!(
        request_local_state_authority_v1(&request, &options)
            .unwrap_err()
            .to_string(),
        "local_state_authority_client_request_too_large"
    );
    let request = json!({});
    let reply =
        serde_json::to_vec(&json!({"ok":true,"receipt":{"data":"x".repeat(2000)}})).unwrap();
    let worker = server(&options, vec![reply; 2], request.clone());
    assert_eq!(
        native_result(request_local_state_authority_v1(&request, &options)),
        node_request(&request, &options)
    );
    worker.join().unwrap();
    fs::remove_file(&options.socket_path).unwrap();
    assert_eq!(
        native_result(request_local_state_authority_v1(&request, &options)),
        node_request(&request, &options)
    );
    for request in [Value::Null, json!([]), json!(true), json!(1), json!("x")] {
        assert_eq!(
            native_result(request_local_state_authority_v1(&request, &options)),
            node_request(&request, &options)
        );
    }
    for bad in [
        LocalStateAuthorityClientOptionsV1 {
            socket_path: "relative".into(),
            ..options.clone()
        },
        LocalStateAuthorityClientOptionsV1 {
            timeout_ms: 999,
            ..options.clone()
        },
        LocalStateAuthorityClientOptionsV1 {
            maximum_message_bytes: 1023,
            ..options.clone()
        },
    ] {
        assert_eq!(
            native_result(request_local_state_authority_v1(&json!({}), &bad)),
            node_request(&json!({}), &bad)
        );
    }
    options.timeout_ms = MAXIMUM_TIMEOUT_MS + 1;
    assert_eq!(
        request_local_state_authority_v1(&json!({}), &options)
            .unwrap_err()
            .to_string(),
        "local_state_authority_client_configuration_invalid"
    );
}

#[test]
fn absolute_deadline_expires_despite_response_progress() {
    let temp = Temp::new();
    let mut options = temp.options();
    options.timeout_ms = 1000;
    let listener = UnixListener::bind(&options.socket_path).unwrap();
    let worker = thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let mut request = Vec::new();
        stream.read_to_end(&mut request).unwrap();
        for _ in 0..8 {
            if stream.write_all(b" ").is_err() {
                return;
            }
            thread::sleep(Duration::from_millis(200));
        }
        let _ = stream.write_all(b"{\"ok\":true,\"receipt\":{}}\n");
    });
    let started = Instant::now();
    assert_eq!(
        request_local_state_authority_v1(&json!({}), &options)
            .unwrap_err()
            .to_string(),
        "local_state_authority_client_timeout"
    );
    assert!(started.elapsed() < Duration::from_secs(2));
    worker.join().unwrap();
}

#[test]
fn absolute_deadline_bounds_full_connect_backlog_and_blocked_write() {
    let temp = Temp::new();
    let mut options = temp.options();
    options.timeout_ms = 1000;
    let listener = UnixListener::bind(&options.socket_path).unwrap();
    nix::sys::socket::listen(&listener, nix::sys::socket::Backlog::new(0).unwrap()).unwrap();
    let _queued = UnixStream::connect(&options.socket_path).unwrap();
    let started = Instant::now();
    assert_eq!(
        request_local_state_authority_v1(&json!({}), &options)
            .unwrap_err()
            .to_string(),
        "local_state_authority_client_timeout"
    );
    assert!(started.elapsed() < Duration::from_secs(2));
    drop(listener);
    fs::remove_file(&options.socket_path).unwrap();
    let listener = UnixListener::bind(&options.socket_path).unwrap();
    let worker = thread::spawn(move || {
        let (_stream, _) = listener.accept().unwrap();
        thread::sleep(Duration::from_millis(1400));
    });
    let request = json!({"large": "x".repeat(4 * 1024 * 1024)});
    let started = Instant::now();
    assert_eq!(
        request_local_state_authority_v1(&request, &options)
            .unwrap_err()
            .to_string(),
        "local_state_authority_client_timeout"
    );
    assert!(started.elapsed() < Duration::from_secs(2));
    worker.join().unwrap();
}

#[test]
fn exact_byte_limit_includes_request_and_response_newlines() {
    let temp = Temp::new();
    let mut options = temp.options();
    options.maximum_message_bytes = 1024;
    let empty_request = json!({"data":""});
    let request =
        json!({"data":"x".repeat(1024 - serde_json::to_vec(&empty_request).unwrap().len() - 1)});
    let empty_response = json!({"ok":true,"receipt":{"data":""}});
    let receipt =
        json!({"data":"x".repeat(1024 - serde_json::to_vec(&empty_response).unwrap().len() - 1)});
    let mut response = serde_json::to_vec(&json!({"ok":true,"receipt":receipt})).unwrap();
    response.push(b'\n');
    assert_eq!(response.len(), 1024);
    let worker = server(&options, vec![response; 2], request.clone());
    assert_eq!(
        request_local_state_authority_v1(&request, &options).unwrap(),
        receipt
    );
    assert_eq!(node_request(&request, &options)["value"], receipt);
    worker.join().unwrap();
    let mut too_large = request;
    too_large["data"] = format!("{}x", too_large["data"].as_str().unwrap()).into();
    assert_eq!(
        request_local_state_authority_v1(&too_large, &options)
            .unwrap_err()
            .to_string(),
        "local_state_authority_client_request_too_large"
    );
    assert_eq!(
        run_local_state_authority_client_v1(&[], vec![b' '; 1025].as_slice(), &options)
            .unwrap_err()
            .to_string(),
        "local_state_authority_client_request_too_large"
    );
}

#[test]
fn strict_cli_arguments_help_and_stdin_errors_match_actual_node_entry_function() {
    let temp = Temp::new();
    let options = temp.options();
    for args in [
        vec!["--help"],
        vec!["--help", "--bogus"],
        vec!["--help", "--help"],
        vec!["--help=true"],
        vec!["--"],
        vec!["positional"],
        vec!["--=x"],
        vec!["--socket-path=/tmp/no"],
    ] {
        let argv = args.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(
            native_result(run_local_state_authority_client_v1(
                &argv,
                b"invalid".as_slice(),
                &options
            )),
            oracle(
                json!({"operation":"cli","options":{"argv":args,"input":"invalid","socketPath":options.socket_path}})
            )
        );
    }
    for input in ["", "not json", "null", "[]"] {
        assert_eq!(
            native_result(run_local_state_authority_client_v1(
                &[],
                input.as_bytes(),
                &options
            )),
            oracle(
                json!({"operation":"cli","options":{"input":input,"socketPath":options.socket_path}})
            )
        );
    }
    assert_eq!(
        format_local_state_authority_client_output_v1(&json!({"help":USAGE})).unwrap(),
        format!("{USAGE}\n")
    );
    assert_eq!(
        format_local_state_authority_client_output_v1(&json!({"help":false,"value":1})).unwrap(),
        "{\"help\":false,\"value\":1}\n"
    );
}
