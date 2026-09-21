//! These fixtures exercise the actual socket wrapper and zbus codec. Private
//! exchange fixtures cannot mint the public manager-association observation.
use super::*;
use std::{
    fs, io,
    os::{fd::AsFd, unix::net::UnixListener},
    path::Path,
    process::{Child, Command, Stdio},
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
};
use zbus::connection::socket::{ReadHalf, Socket, WriteHalf};

const HELPER: &str = "local_state_authority_client::manager::tests::manager_origin_child";
static NEXT: AtomicU64 = AtomicU64::new(0);

struct Directory(PathBuf);
impl Directory {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "hepta-manager-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        Self(path)
    }
    fn options(&self) -> LocalStateAuthorityClientOptionsV1 {
        LocalStateAuthorityClientOptionsV1 {
            socket_path: self.0.join("peer.sock"),
            timeout_ms: 5_000,
            maximum_message_bytes: 1024,
        }
    }
}
impl Drop for Directory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

struct ChildOwner(Child);
impl Drop for ChildOwner {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn read_auth(stream: &mut UnixStream) {
    stream
        .set_read_timeout(Some(Duration::from_secs(3)))
        .unwrap();
    let mut bytes = Vec::new();
    loop {
        let mut byte = [0_u8; 1];
        stream.read_exact(&mut byte).unwrap();
        bytes.push(byte[0]);
        assert!(bytes.len() < 4096, "bounded real client authentication");
        if byte[0] == b'\n' {
            break;
        }
    }
    assert!(bytes.starts_with(b"\0AUTH EXTERNAL "));
    assert!(bytes.ends_with(b"\r\n"));
}

fn exchange_failure(client: UnixStream, timeout: Duration) -> LocalStateAuthorityClientError {
    let (origin_socket, _retained_peer) = UnixStream::pair().unwrap();
    let origin =
        peer::SocketPeer::observe(&origin_socket, Instant::now() + Duration::from_secs(3)).unwrap();
    let start = Instant::now();
    let error = exchange_manager(client, origin.origin_pidfd(), start + timeout).unwrap_err();
    assert!(start.elapsed() < timeout + Duration::from_secs(2));
    assert_ne!(
        error.to_string(),
        "local_state_authority_manager_reader_not_destroyed",
        "an exchange error must still destroy both socket halves"
    );
    error
}

#[test]
fn stalled_sasl_has_an_absolute_deadline_and_closes_the_socket() {
    let (client, mut server) = UnixStream::pair().unwrap();
    let worker = thread::spawn(move || {
        read_auth(&mut server);
        // Do not answer AUTH. EOF proves the real exchange socket was closed.
        let mut byte = [0_u8; 1];
        assert_eq!(server.read(&mut byte).unwrap(), 0);
    });
    let error = exchange_failure(client, Duration::from_millis(200));
    assert!(matches!(
        error.to_string().as_str(),
        "local_state_authority_manager_timeout"
            | "local_state_authority_client_timeout"
            | "local_state_authority_manager_connection_failed"
    ));
    worker.join().unwrap();
}

#[test]
fn bare_lf_in_either_sasl_response_is_an_error_and_closes_the_socket() {
    for response in [
        b"\n".as_slice(),
        b"OK 0123456789abcdef0123456789abcdef\r\n\n".as_slice(),
    ] {
        let (client, mut server) = UnixStream::pair().unwrap();
        let worker = thread::spawn(move || {
            read_auth(&mut server);
            server.write_all(response).unwrap();
            // There may be a pipelined NEGOTIATE/BEGIN/Hello after OK. Drain
            // bounded bytes to EOF rather than mistaking those for a leak.
            let mut pending = Vec::new();
            server.take(4097).read_to_end(&mut pending).unwrap();
            assert!(pending.len() <= 4096, "the exchange must close its socket");
        });
        // Intentionally no catch_unwind: the production Result boundary must
        // reject malformed SASL before zbus's line[-1] indexing can panic.
        let error = exchange_failure(client, Duration::from_secs(2));
        assert_eq!(
            error.to_string(),
            "local_state_authority_manager_connection_failed"
        );
        worker.join().unwrap();
    }
}

#[test]
fn wire_accepts_split_crlf_and_stops_sasl_line_checks_before_binary_data() {
    let (client, mut server) = UnixStream::pair().unwrap();
    let (socket, closed) =
        wire::BoundedSocket::new(client, Instant::now() + Duration::from_secs(3)).unwrap();
    let mut halves = socket.split();
    async_io::block_on(async {
        for fragment in [
            b"OK 0123456789abcdef0123456789abcdef\r".as_slice(),
            b"\nAGREE_UNIX_FD\r".as_slice(),
            b"\n\x00\n\r\n\x01\n".as_slice(),
        ] {
            server.write_all(fragment).unwrap();
            let mut received = Vec::new();
            while received.len() < fragment.len() {
                let mut buffer = vec![0_u8; fragment.len() - received.len()];
                let (count, descriptors) = halves.read_mut().recvmsg(&mut buffer).await.unwrap();
                assert!(count > 0);
                assert!(descriptors.is_empty());
                received.extend_from_slice(&buffer[..count]);
            }
            assert_eq!(received, fragment);
        }
    });
    // This is a wire transparency check, not a successful D-Bus handshake or
    // typed message: binary bytes after the two SASL lines belong to zbus.
    drop(halves);
    assert!(closed.is_closed());
    server
        .set_read_timeout(Some(Duration::from_secs(1)))
        .unwrap();
    assert_eq!(server.read(&mut [0_u8; 1]).unwrap(), 0);
}

#[test]
fn sasl_without_a_newline_cannot_extend_the_deadline_or_receive_budget() {
    let (client, mut server) = UnixStream::pair().unwrap();
    let worker = thread::spawn(move || {
        read_auth(&mut server);
        server
            .set_write_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        let chunk = [b'A'; 16 * 1024];
        let mut sent = 0;
        while sent <= wire::MAXIMUM_RECEIVED_BYTES {
            match server.write(&chunk) {
                Ok(0) | Err(_) => break,
                Ok(count) => sent += count,
            }
        }
        sent
    });
    let error = exchange_failure(client, Duration::from_millis(800));
    assert!(matches!(
        error.to_string().as_str(),
        "local_state_authority_manager_timeout"
            | "local_state_authority_client_timeout"
            | "local_state_authority_manager_connection_failed"
    ));
    assert!(worker.join().unwrap() >= 1024);
}

#[test]
fn wire_receive_budget_is_cumulative_and_exactly_four_mib() {
    let (client, mut server) = UnixStream::pair().unwrap();
    let worker = thread::spawn(move || {
        server
            .set_write_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        let bytes = vec![b'A'; wire::MAXIMUM_RECEIVED_BYTES + 1];
        let mut sent = 0;
        while sent < bytes.len() {
            match server.write(&bytes[sent..]) {
                Ok(0) => break,
                Ok(count) => sent += count,
                Err(error) if error.kind() == io::ErrorKind::BrokenPipe => break,
                Err(error) => panic!("bounded fixture writer failed: {error}"),
            }
        }
        sent
    });
    let (socket, closed) =
        wire::BoundedSocket::new(client, Instant::now() + Duration::from_secs(3)).unwrap();
    let mut halves = socket.split();
    async_io::block_on(async {
        let mut total = 0;
        let mut buffer = vec![0_u8; 64 * 1024];
        while total < wire::MAXIMUM_RECEIVED_BYTES {
            let (count, fds) = halves.read_mut().recvmsg(&mut buffer).await.unwrap();
            assert!(count > 0 && count <= 16 * 1024);
            assert!(fds.is_empty());
            total += count;
        }
        assert_eq!(total, 4 * 1024 * 1024);
        let error = halves.read_mut().recvmsg(&mut buffer).await.unwrap_err();
        assert_eq!(error.to_string(), "manager_receive_budget_exceeded");
    });
    assert!(!closed.is_closed());
    drop(halves);
    assert!(closed.is_closed());
    assert!(worker.join().unwrap() >= wire::MAXIMUM_RECEIVED_BYTES);
}

fn reject_received_descriptors(count: usize) {
    let (client, mut server) = UnixStream::pair().unwrap();
    let (mut sentinel_reader, sentinel_writer) = UnixStream::pair().unwrap();
    sentinel_reader
        .set_read_timeout(Some(Duration::from_secs(3)))
        .unwrap();
    let worker = thread::spawn(move || {
        read_auth(&mut server);
        let mut server = Arc::new(async_io::Async::new(server).unwrap());
        let descriptors = vec![sentinel_writer.as_fd(); count];
        let sent = async_io::block_on(WriteHalf::sendmsg(
            &mut server,
            b"OK 0123456789abcdef0123456789abcdef\r\n",
            &descriptors,
        ))
        .unwrap();
        assert!(sent > 0);
        // Every received SCM_RIGHTS descriptor aliases this socket endpoint.
        // EOF at the other endpoint detects leaks without counting global FDs
        // or racing other parallel tests.
    });
    let error = exchange_failure(client, Duration::from_secs(2));
    assert_eq!(
        error.to_string(),
        "local_state_authority_manager_connection_failed"
    );
    worker.join().unwrap();
    let mut byte = [0_u8; 1];
    assert_eq!(sentinel_reader.read(&mut byte).unwrap(), 0);
}

#[test]
fn unexpected_scm_rights_is_rejected_and_received_descriptor_is_closed() {
    reject_received_descriptors(1);
}

#[test]
fn many_scm_rights_are_rejected_and_every_received_alias_is_closed() {
    // The kernel really transfers 64 aliases; this is not an invented JSON FD.
    reject_received_descriptors(64);
}

#[test]
fn wire_refuses_oversized_or_multiple_descriptor_writes_before_sending() {
    let (client, mut server) = UnixStream::pair().unwrap();
    let (first, second) = UnixStream::pair().unwrap();
    let (socket, closed) =
        wire::BoundedSocket::new(client, Instant::now() + Duration::from_secs(3)).unwrap();
    let mut halves = socket.split();
    async_io::block_on(async {
        let error = halves
            .write_mut()
            .sendmsg(&vec![0_u8; 1024 * 1024 + 1], &[])
            .await
            .unwrap_err();
        assert_eq!(error.to_string(), "manager_send_budget_exceeded");
        let error = halves
            .write_mut()
            .sendmsg(b"x", &[first.as_fd(), second.as_fd()])
            .await
            .unwrap_err();
        assert_eq!(error.to_string(), "manager_send_budget_exceeded");
    });
    server
        .set_read_timeout(Some(Duration::from_millis(50)))
        .unwrap();
    let mut byte = [0_u8; 1];
    assert!(matches!(
        server.read(&mut byte).unwrap_err().kind(),
        io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
    ));
    drop(halves);
    assert!(closed.is_closed());
    assert_eq!(server.read(&mut byte).unwrap(), 0);
}

fn method_call() -> Message {
    Message::method_call("/fixture", "Fixture")
        .unwrap()
        .sender(":1.10")
        .unwrap()
        .build(&())
        .unwrap()
}
fn reply(bytes: &[u8]) -> Message {
    Message::method_return(&method_call().header())
        .unwrap()
        .sender(":1.42")
        .unwrap()
        .build(&bytes)
        .unwrap()
}
fn assert_reply_invalid(message: &Message, destination: &str) {
    assert_eq!(
        validate_reply(message, destination)
            .unwrap_err()
            .to_string(),
        "local_state_authority_manager_reply_invalid"
    );
}

#[test]
fn reply_requires_method_return_and_exact_observed_unique_sender() {
    let valid = reply(b"fixture");
    validate_reply(&valid, ":1.42").unwrap();
    assert_reply_invalid(&valid, ":1.43");
    assert_reply_invalid(&method_call(), ":1.10");
    let no_sender = Message::method_return(&method_call().header())
        .unwrap()
        .build(&())
        .unwrap();
    assert_reply_invalid(&no_sender, ":1.42");
    let error = Message::error(&method_call().header(), "org.example.Rejected")
        .unwrap()
        .sender(":1.42")
        .unwrap()
        .build(&"rejected")
        .unwrap();
    assert_reply_invalid(&error, ":1.42");
}

#[test]
fn reply_limit_includes_headers_and_rejects_a_real_serialized_fd() {
    let overhead = reply(&[]).data().len();
    let boundary = reply(&vec![0_u8; MAXIMUM_REPLY_BYTES - overhead]);
    assert_eq!(boundary.data().len(), MAXIMUM_REPLY_BYTES);
    validate_reply(&boundary, ":1.42").unwrap();
    let oversize = reply(&vec![0_u8; MAXIMUM_REPLY_BYTES - overhead + 1]);
    assert_eq!(oversize.data().len(), MAXIMUM_REPLY_BYTES + 1);
    assert_reply_invalid(&oversize, ":1.42");

    let (descriptor, _other_endpoint) = UnixStream::pair().unwrap();
    let fd_reply = Message::method_return(&method_call().header())
        .unwrap()
        .sender(":1.42")
        .unwrap()
        .build(&(Fd::Borrowed(descriptor.as_fd()),))
        .unwrap();
    assert_eq!(fd_reply.data().fds().len(), 1);
    assert_reply_invalid(&fd_reply, ":1.42");
}

#[test]
#[ignore = "internal child fixture, invoked with an isolated socket directory"]
fn manager_origin_child() {
    let directory = std::env::var_os("HEPTA_MANAGER_ORIGIN_CHILD_DIRECTORY")
        .expect("child fixture requires its isolated directory");
    let directory = Path::new(&directory);
    let _listener = UnixListener::bind(directory.join("peer.sock")).unwrap();
    fs::write(directory.join("ready"), b"ready").unwrap();
    let mut input = Vec::new();
    std::io::stdin().read_to_end(&mut input).unwrap();
    assert!(input.is_empty());
}

#[test]
fn dead_original_process_is_refused_before_any_manager_observation() {
    let directory = Directory::new();
    let mut child = ChildOwner(
        Command::new(std::env::current_exe().unwrap())
            .args(["--exact", HELPER, "--ignored", "--nocapture"])
            .env("HEPTA_MANAGER_ORIGIN_CHILD_DIRECTORY", &directory.0)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap(),
    );
    let deadline = Instant::now() + Duration::from_secs(5);
    while !directory.0.join("ready").exists() {
        assert!(
            Instant::now() < deadline,
            "child must bind its actual socket"
        );
        assert!(child.0.try_wait().unwrap().is_none());
        thread::sleep(Duration::from_millis(5));
    }
    let transport = LocalStateAuthoritySocketTransportV1::connect(&directory.options()).unwrap();
    drop(child.0.stdin.take());
    assert!(child.0.wait().unwrap().success());
    let error = transport.observe_system_manager_v1().unwrap_err();
    assert_eq!(error.code, "local_state_authority_socket_peer_exited");
    assert_eq!(error.details["requestBytesSent"], 0);
    assert_eq!(error.details["requestDelivery"], "not_sent");
    assert_eq!(error.details["authorityOutcome"], "not_invoked");
    assert_eq!(error.details["inspectionRequired"], false);
    assert!(error.details.get("committed").is_none());
    assert!(!error.retryable);
}

#[test]
#[ignore = "requires the actual root system bus and PID 1 systemd GetUnitByPIDFD"]
fn actual_fixed_system_bus_observes_original_peer_and_closes_before_return() {
    let directory = Directory::new();
    let options = directory.options();
    let listener = UnixListener::bind(&options.socket_path).unwrap();
    let transport = LocalStateAuthoritySocketTransportV1::connect(&options).unwrap();
    let (mut probe, _) = listener.accept().unwrap();
    let mut request = Vec::new();
    probe.read_to_end(&mut request).unwrap();
    assert!(request.is_empty(), "observation sends no authority request");
    let observation = transport.observe_system_manager_v1().unwrap();
    let report = observation.report();
    assert_eq!(report["kind"], "HeptaSocketPeerSystemManagerObservationV1");
    assert_eq!(report["socketOrigin"]["pid"], std::process::id());
    assert_eq!(
        report["socketOrigin"]["uid"],
        nix::unistd::geteuid().as_raw()
    );
    assert_eq!(
        report["socketOrigin"]["gid"],
        nix::unistd::getegid().as_raw()
    );
    assert_eq!(report["busPeer"]["uid"], 0);
    assert_eq!(report["manager"]["ownerUid"], 0);
    assert_eq!(report["manager"]["ownerPid"], 1);
    assert_eq!(report["busClosedBeforeReturn"], true);
    assert_eq!(report["maximumReceivedBytes"], 4 * 1024 * 1024);
    assert_eq!(report["maximumReplyBytes"], 64 * 1024);
    assert_eq!(
        report["manager"]["unitProperties"]["Id"],
        report["manager"]["unitId"]
    );
    assert!(!report["manager"]["unitId"].as_str().unwrap().is_empty());
    assert_eq!(
        report["manager"]["invocationId"].as_str().unwrap().len(),
        32
    );
    assert_eq!(
        report["evidenceScope"],
        "static_socket_origin_manager_observation_no_installation_or_activation_authority"
    );
    // The actual unit may be user@.service or another enclosing host service.
    // No fixture asserts Hepta installation, native provenance or permission.
}
