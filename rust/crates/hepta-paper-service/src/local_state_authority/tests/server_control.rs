//! Actual Unix request and separate-process SQLite-lock regressions. The private
//! checkpoints pause the existing owner; no request, result or COMMIT is mocked.
use super::*;
use std::{
    io::{Read, Write},
    net::Shutdown,
    os::unix::net::UnixStream,
    process::{Child, Command, Stdio},
    sync::{Arc, atomic::AtomicBool, mpsc},
    thread,
    time::{Duration, Instant},
};

#[test]
#[ignore = "owned child invoked by the real SQLite lock-wait regression"]
fn held_writer_child() {
    let db = Connection::open(std::env::var_os("HEPTA_AUTHORITY_LOCK_DB").unwrap()).unwrap();
    db.busy_timeout(Duration::ZERO).unwrap();
    db.execute_batch("BEGIN IMMEDIATE").unwrap();
    let marker = std::env::var_os("HEPTA_AUTHORITY_LOCK_READY").unwrap();
    fs::write(marker, b"held").unwrap();
    std::io::stdin().read_exact(&mut [0_u8; 1]).unwrap();
    db.execute_batch("ROLLBACK").unwrap();
}

struct HeldWriter(Child);
impl HeldWriter {
    fn new(fixture: &Fixture) -> Self {
        let marker = fixture.root.join("writer-held");
        let child = Command::new(std::env::current_exe().unwrap())
            .args([
                "--ignored",
                "--exact",
                "local_state_authority::tests::server_control::held_writer_child",
            ])
            .env(
                "HEPTA_AUTHORITY_LOCK_DB",
                fixture.config["stateDatabasePath"].as_str().unwrap(),
            )
            .env("HEPTA_AUTHORITY_LOCK_READY", &marker)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let mut owner = Self(child);
        let deadline = Instant::now() + Duration::from_secs(10);
        while !marker.exists() && Instant::now() < deadline {
            assert!(
                owner.0.try_wait().unwrap().is_none(),
                "lock child exited before ready"
            );
            thread::sleep(Duration::from_millis(2));
        }
        assert_eq!(fs::read(marker).unwrap(), b"held");
        owner
    }
    fn release(&mut self) {
        self.0.stdin.take().unwrap().write_all(b"x").unwrap();
        assert!(self.0.wait().unwrap().success());
    }
}
impl Drop for HeldWriter {
    fn drop(&mut self) {
        if self.0.try_wait().ok().flatten().is_none() {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
}
fn request(socket: &std::path::Path, value: &Value) -> UnixStream {
    let mut peer = UnixStream::connect(socket).unwrap();
    peer.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
    peer.write_all(value.to_string().as_bytes()).unwrap();
    peer.shutdown(Shutdown::Write).unwrap();
    peer
}
fn reservation_count(fixture: &Fixture) -> i64 {
    fixture
        .runtime()
        .connection
        .query_row(
            "SELECT count(*) FROM authority_schema_transition",
            [],
            |row| row.get(0),
        )
        .unwrap()
}

#[test]
fn shutdown_while_sqlite_writer_is_held_closes_peer_without_a_late_reservation() {
    let fixture = Fixture::new();
    let mut runtime = fixture.runtime();
    let (admitted, observed) = mpsc::sync_channel(1);
    runtime.request_checkpoint = Some(Box::new(move |phase| {
        if phase == "before_transaction" {
            admitted.send(()).unwrap();
        }
    }));
    let mut server = LocalStateAuthorityServerV1::bind(runtime).unwrap();
    let socket = server.socket_path().to_owned();
    let mut writer = HeldWriter::new(&fixture);
    let stopped = Arc::new(AtomicBool::new(false));
    let server_stop = Arc::clone(&stopped);
    let (done, finished) = mpsc::sync_channel(1);
    let owner = thread::spawn(move || {
        let result = server.serve(&server_stop);
        drop(server);
        done.send(result).unwrap();
    });
    let mut peer = request(&socket, &fixture.reserve);
    observed.recv_timeout(Duration::from_secs(10)).unwrap();
    stopped.store(true, Ordering::Release);
    let started = Instant::now();
    let early = finished.recv_timeout(Duration::from_millis(750));
    // Release the independent writer and reap the real server even on failure.
    writer.release();
    let result = match early {
        Ok(result) => Some(result),
        Err(_) => {
            finished
                .recv_timeout(Duration::from_secs(10))
                .unwrap()
                .unwrap();
            None
        }
    };
    owner.join().unwrap();
    let count = reservation_count(&fixture);
    assert!(
        result.is_some(),
        "shutdown waited for unrelated writer; late reservations={count}, elapsed={:?}",
        started.elapsed()
    );
    result.unwrap().unwrap();
    assert_eq!(
        count, 0,
        "stopping admission cannot authorize a later reservation"
    );
    let mut response = Vec::new();
    peer.read_to_end(&mut response).unwrap();
    assert!(response.is_empty());
    assert!(!socket.exists());
}

#[test]
fn shutdown_before_commit_rolls_back_and_original_request_can_retry() {
    let fixture = Fixture::new();
    let mut runtime = fixture.runtime();
    let (ready, reached) = mpsc::sync_channel(1);
    let (resume, resumed) = mpsc::sync_channel(1);
    runtime.request_checkpoint = Some(Box::new(move |phase| {
        if phase == "before_commit" {
            ready.send(()).unwrap();
            resumed.recv_timeout(Duration::from_secs(10)).unwrap();
        }
    }));
    let mut server = LocalStateAuthorityServerV1::bind(runtime).unwrap();
    let socket = server.socket_path().to_owned();
    let stopped = Arc::new(AtomicBool::new(false));
    let server_stop = Arc::clone(&stopped);
    let owner = thread::spawn(move || server.serve(&server_stop));
    let peer = request(&socket, &fixture.reserve);
    reached.recv_timeout(Duration::from_secs(10)).unwrap();
    stopped.store(true, Ordering::Release);
    resume.send(()).unwrap();
    owner.join().unwrap().unwrap();
    drop(peer);
    assert_eq!(
        reservation_count(&fixture),
        0,
        "request must roll back after precommit stop"
    );
    let mut restarted = fixture.runtime();
    let first = restarted.handle(&fixture.reserve).unwrap();
    assert_eq!(restarted.handle(&fixture.reserve).unwrap(), first);
}

#[test]
fn shutdown_after_commit_keeps_original_reservation_for_lost_reply_recovery() {
    let fixture = Fixture::new();
    let mut runtime = fixture.runtime();
    let (ready, reached) = mpsc::sync_channel(1);
    let (resume, resumed) = mpsc::sync_channel(1);
    runtime.request_checkpoint = Some(Box::new(move |phase| {
        if phase == "after_commit" {
            ready.send(()).unwrap();
            resumed.recv_timeout(Duration::from_secs(10)).unwrap();
        }
    }));
    let mut server = LocalStateAuthorityServerV1::bind(runtime).unwrap();
    let socket = server.socket_path().to_owned();
    let stopped = Arc::new(AtomicBool::new(false));
    let server_stop = Arc::clone(&stopped);
    let owner = thread::spawn(move || server.serve(&server_stop));
    let peer = request(&socket, &fixture.reserve);
    reached.recv_timeout(Duration::from_secs(10)).unwrap();
    peer.shutdown(Shutdown::Both).unwrap();
    stopped.store(true, Ordering::Release);
    resume.send(()).unwrap();
    owner.join().unwrap().unwrap();
    assert_eq!(reservation_count(&fixture), 1);
    let mut restarted = fixture.runtime();
    let persisted: String = restarted
        .connection
        .query_row(
            "SELECT reservation_receipt_json FROM authority_schema_transition",
            [],
            |row| row.get(0),
        )
        .unwrap();
    let receipt: Value = serde_json::from_str(&persisted).unwrap();
    assert_eq!(restarted.handle(&fixture.reserve).unwrap(), receipt);
    assert_eq!(reservation_count(&fixture), 1);
}

#[test]
fn elapsed_request_deadline_refuses_before_lock_and_rolls_back_before_commit() {
    for after_admission in [false, true] {
        let fixture = Fixture::new();
        let mut runtime = fixture.runtime();
        let stopped = AtomicBool::new(false);
        let entered_commit_boundary = Arc::new(AtomicBool::new(false));
        let deadline = if after_admission {
            Instant::now() + Duration::from_secs(2)
        } else {
            Instant::now()
        };
        if after_admission {
            let entered = Arc::clone(&entered_commit_boundary);
            runtime.request_checkpoint = Some(Box::new(move |phase| {
                if phase == "before_commit" {
                    entered.store(true, Ordering::Release);
                    while Instant::now() < deadline {
                        thread::sleep(Duration::from_millis(1));
                    }
                }
            }));
        }
        let control = RequestControl::serving(&stopped, deadline);
        let error = runtime
            .handle_with_control(&fixture.reserve, &control)
            .unwrap_err();
        assert_eq!(
            error.code,
            "local_state_authority_request_deadline_exceeded"
        );
        assert_eq!(
            entered_commit_boundary.load(Ordering::Acquire),
            after_admission,
            "the precommit case must actually reach the modified transaction"
        );
        drop(runtime);
        assert_eq!(reservation_count(&fixture), 0);
        let mut restarted = fixture.runtime();
        let receipt = restarted.handle(&fixture.reserve).unwrap();
        assert_eq!(restarted.handle(&fixture.reserve).unwrap(), receipt);
    }
}

#[test]
fn released_sqlite_contention_serves_and_replays_without_duplicate_reservation() {
    let fixture = Fixture::new();
    let mut runtime = fixture.runtime();
    let (ready, reached) = mpsc::sync_channel(1);
    runtime.request_checkpoint = Some(Box::new(move |phase| {
        if phase == "before_transaction" {
            ready.send(()).unwrap();
        }
    }));
    let mut server = LocalStateAuthorityServerV1::bind(runtime).unwrap();
    let socket = server.socket_path().to_owned();
    let mut writer = HeldWriter::new(&fixture);
    let stopped = Arc::new(AtomicBool::new(false));
    let server_stop = Arc::clone(&stopped);
    let owner = thread::spawn(move || server.serve(&server_stop));
    let mut peer = request(&socket, &fixture.reserve);
    reached.recv_timeout(Duration::from_secs(10)).unwrap();
    writer.release();
    let mut first = Vec::new();
    peer.read_to_end(&mut first).unwrap();
    let response: Value = serde_json::from_slice(&first).unwrap();
    assert_eq!(response["ok"], true);
    let mut retry = request(&socket, &fixture.reserve);
    let mut second = Vec::new();
    retry.read_to_end(&mut second).unwrap();
    assert_eq!(first, second);
    stopped.store(true, Ordering::Release);
    owner.join().unwrap().unwrap();
    assert_eq!(reservation_count(&fixture), 1);
}

#[test]
fn request_deadline_interrupts_real_sqlite_contention_without_consuming_request() {
    let fixture = Fixture::new();
    let mut runtime = fixture.runtime();
    let mut writer = HeldWriter::new(&fixture);
    let stopped = AtomicBool::new(false);
    let began = Instant::now();
    let control = RequestControl::serving(&stopped, began + Duration::from_millis(100));
    let error = runtime
        .handle_with_control(&fixture.reserve, &control)
        .unwrap_err();
    let elapsed = began.elapsed();
    writer.release();
    assert_eq!(
        error.code,
        "local_state_authority_request_deadline_exceeded"
    );
    assert!(
        elapsed < Duration::from_millis(750),
        "deadline hidden by SQLite wait: {elapsed:?}"
    );
    assert_eq!(reservation_count(&fixture), 0);
    let receipt = runtime.handle(&fixture.reserve).unwrap();
    assert_eq!(runtime.handle(&fixture.reserve).unwrap(), receipt);
}
