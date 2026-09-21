use super::*;
use std::{
    fs,
    os::unix::{fs::PermissionsExt, net::UnixListener},
    path::PathBuf,
    process::Command,
    sync::atomic::{AtomicU64, Ordering},
};
static NEXT: AtomicU64 = AtomicU64::new(0);

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "hepta-socket-transport-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        Self(root)
    }
    fn options(&self) -> LocalStateAuthorityClientOptionsV1 {
        LocalStateAuthorityClientOptionsV1 {
            socket_path: self.0.join("authority.sock"),
            timeout_ms: 1000,
            maximum_message_bytes: 1024,
        }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn accepted_request(listener: &UnixListener) -> (UnixStream, Vec<u8>) {
    let (mut probe, _) = listener.accept().unwrap();
    let mut empty = Vec::new();
    probe.read_to_end(&mut empty).unwrap();
    assert!(
        empty.is_empty(),
        "constructor probe must not invoke a handler"
    );
    let (mut connection, _) = listener.accept().unwrap();
    let mut request = Vec::new();
    connection.read_to_end(&mut request).unwrap();
    (connection, request)
}
fn assert_unknown(error: &SqliteMutationCoordinatorError, sent: usize) {
    assert_eq!(error.details["requestBytesSent"], sent);
    assert_eq!(error.details["requestDelivery"], "sent");
    assert_eq!(error.details["authorityOutcome"], "unknown");
    assert_eq!(error.details["inspectionRequired"], true);
    assert!(error.details.get("committed").is_none());
    assert!(!error.retryable);
}

#[test]
fn recovery_pair_retains_one_origin_and_makes_only_one_empty_probe() {
    let fixture = Fixture::new();
    let options = fixture.options();
    let listener = UnixListener::bind(&options.socket_path).unwrap();
    let (first, second) =
        LocalStateAuthoritySocketTransportV1::connect_recovery_pair(&options).unwrap();
    assert!(Arc::ptr_eq(&first.origin, &second.origin));
    let weak = Arc::downgrade(&first.origin);
    let (mut probe, _) = listener.accept().unwrap();
    probe
        .set_read_timeout(Some(Duration::from_millis(500)))
        .unwrap();
    let mut bytes = Vec::new();
    probe.read_to_end(&mut bytes).unwrap();
    assert!(bytes.is_empty());
    listener.set_nonblocking(true).unwrap();
    assert_eq!(
        listener.accept().unwrap_err().kind(),
        std::io::ErrorKind::WouldBlock
    );
    drop(first);
    assert_eq!(weak.strong_count(), 1);
    second
        .origin
        .assert_alive(Instant::now() + Duration::from_secs(1))
        .unwrap();
    drop(second);
    assert!(weak.upgrade().is_none());
}

#[test]
fn invalid_requests_are_not_sent_and_do_not_consume_the_origin() {
    let fixture = Fixture::new();
    let options = fixture.options();
    let listener = UnixListener::bind(&options.socket_path).unwrap();
    let server = thread::spawn(move || {
        let (mut probe, _) = listener.accept().unwrap();
        let mut empty = Vec::new();
        probe.read_to_end(&mut empty).unwrap();
        assert!(empty.is_empty());
        let (mut connection, _) = listener.accept().unwrap();
        let mut bytes = Vec::new();
        connection.read_to_end(&mut bytes).unwrap();
        assert_eq!(bytes, b"{\"valid\":true}\n");
        connection
            .write_all(b"{\"ok\":true,\"receipt\":{\"seen\":true}}")
            .unwrap();
    });
    let mut transport = LocalStateAuthoritySocketTransportV1::connect(&options).unwrap();
    for request in [json!(null), json!({"tooLarge":"x".repeat(1024)})] {
        let failure = transport.invoke(&request).unwrap_err();
        assert_eq!(failure.details["requestBytesSent"], 0);
        assert_eq!(failure.details["authorityOutcome"], "not_invoked");
        assert_eq!(failure.details["inspectionRequired"], false);
        assert!(!failure.retryable);
    }
    assert_eq!(
        transport.invoke(&json!({"valid":true})).unwrap(),
        json!({"seen":true})
    );
    server.join().unwrap();
}

#[test]
fn missing_oversize_duplicate_or_rejected_responses_remain_unknown_after_send() {
    for response in [
        Vec::new(),
        vec![b' '; 1025],
        b"{\"ok\":true,\"receipt\":{},\"receipt\":{}}".to_vec(),
        b"{\"ok\":false,\"error\":\"fixture_rejected\"}".to_vec(),
    ] {
        let fixture = Fixture::new();
        let options = fixture.options();
        let listener = UnixListener::bind(&options.socket_path).unwrap();
        let server = thread::spawn(move || {
            let (mut probe, _) = listener.accept().unwrap();
            let mut empty = Vec::new();
            probe.read_to_end(&mut empty).unwrap();
            assert!(empty.is_empty());
            let (mut connection, _) = listener.accept().unwrap();
            let mut request = Vec::new();
            connection.read_to_end(&mut request).unwrap();
            assert_eq!(request, b"{}\n");
            connection.write_all(&response).unwrap();
        });
        let mut transport = LocalStateAuthoritySocketTransportV1::connect(&options).unwrap();
        assert_unknown(&transport.invoke(&json!({})).unwrap_err(), 3);
        server.join().unwrap();
    }
}

#[test]
fn absolute_deadline_after_request_remains_unknown() {
    let fixture = Fixture::new();
    let options = fixture.options();
    let listener = UnixListener::bind(&options.socket_path).unwrap();
    let server = thread::spawn(move || {
        let (mut stream, request) = accepted_request(&listener);
        assert_eq!(request, b"{}\n");
        // Continuous progress cannot renew the transport's absolute deadline.
        for _ in 0..15 {
            if stream.write_all(b" ").is_err() {
                break;
            }
            thread::sleep(Duration::from_millis(100));
        }
    });
    let mut transport = LocalStateAuthoritySocketTransportV1::connect(&options).unwrap();
    let failure = transport.invoke(&json!({})).unwrap_err();
    assert_eq!(failure.code, "local_state_authority_client_timeout");
    assert_unknown(&failure, 3);
    server.join().unwrap();
}

#[test]
fn sqlite_peer_lock_probe() {
    let Ok(path) = std::env::var("HEPTA_SOCKET_LOCK_PROBE") else {
        return;
    };
    let db = rusqlite::Connection::open(path).unwrap();
    db.busy_timeout(Duration::ZERO).unwrap();
    let begin = db.execute_batch("BEGIN IMMEDIATE");
    if std::env::var("HEPTA_SOCKET_LOCK_EXPECT").unwrap() == "blocked" {
        assert!(
            matches!(begin, Err(rusqlite::Error::SqliteFailure(ref e, _))
            if e.code == rusqlite::ErrorCode::DatabaseBusy)
        );
    } else {
        begin.unwrap();
        db.execute_batch("ROLLBACK").unwrap();
    }
    db.close().unwrap();
}

#[test]
fn transport_observation_errors_and_drop_preserve_actual_sqlite_writer_locks() {
    for mode in ["DELETE", "WAL"] {
        let fixture = Fixture::new();
        let options = fixture.options();
        let database = fixture.0.join("source.sqlite");
        let db = rusqlite::Connection::open(&database).unwrap();
        db.pragma_update(None, "journal_mode", mode).unwrap();
        db.execute_batch("CREATE TABLE held(value); BEGIN IMMEDIATE; INSERT INTO held VALUES(1)")
            .unwrap();
        let probe = |expected: &str| {
            let output = Command::new("/proc/self/exe")
                .args([
                    "--exact",
                    "local_state_authority_client::transport::tests::sqlite_peer_lock_probe",
                    "--nocapture",
                ])
                .env("HEPTA_SOCKET_LOCK_PROBE", &database)
                .env("HEPTA_SOCKET_LOCK_EXPECT", expected)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
        };
        let listener = UnixListener::bind(&options.socket_path).unwrap();
        let server = thread::spawn(move || {
            let (mut connection, request) = accepted_request(&listener);
            assert_eq!(request, b"{}\n");
            connection
                .write_all(b"{\"ok\":true,\"receipt\":{},\"receipt\":{}}")
                .unwrap();
        });
        let mut transport = LocalStateAuthoritySocketTransportV1::connect(&options).unwrap();
        probe("blocked");
        assert_unknown(&transport.invoke(&json!({})).unwrap_err(), 3);
        probe("blocked");
        drop(transport);
        probe("blocked");
        server.join().unwrap();
        db.execute_batch("ROLLBACK").unwrap();
        probe("available");
        db.close().unwrap();
    }
}
