use std::{
    io::BufRead,
    process::{Child, Command, Stdio},
    sync::Mutex,
};

use hepta_codex_broker::CapabilityKeyRevocationV1;

use super::*;

// Positive temporal evidence always uses SystemBrokerClockV1. The two named
// fault modes are negative clock-source injections, not observations of a real
// operating-system clock failure or a changed system clock.
#[derive(Clone, Copy)]
enum ClockMode {
    System,
    FailAfterLock,
    RegressAfterLock,
}

struct LockClock {
    calls: AtomicU64,
    initial: AtomicU64,
    mode: ClockMode,
    before_initial: mpsc::SyncSender<()>,
    release_initial: Mutex<mpsc::Receiver<()>>,
    samples: mpsc::SyncSender<(u64, u64)>,
}

impl BrokerClockV1 for LockClock {
    fn now_unix_ms(&self) -> Result<u64, BrokerServerError> {
        let call = self.calls.fetch_add(1, Ordering::Relaxed);
        if call == 1 {
            self.before_initial
                .send(())
                .map_err(|_| BrokerServerError::ClockUnavailable)?;
            self.release_initial
                .lock()
                .map_err(|_| BrokerServerError::ClockUnavailable)?
                .recv_timeout(Duration::from_secs(4))
                .map_err(|_| BrokerServerError::ClockUnavailable)?;
        }
        if call == 2 {
            match self.mode {
                ClockMode::FailAfterLock => return Err(BrokerServerError::ClockUnavailable),
                ClockMode::RegressAfterLock => {
                    return Ok(self.initial.load(Ordering::Relaxed) - 1);
                }
                ClockMode::System => {}
            }
        }
        // Sample only after the test synchronization has finished.
        let sampled = SystemBrokerClockV1.now_unix_ms()?;
        if call == 1 {
            self.initial.store(sampled, Ordering::Relaxed);
        }
        self.samples
            .send((call, sampled))
            .map_err(|_| BrokerServerError::ClockUnavailable)?;
        Ok(sampled)
    }
}

struct ClockProbe {
    clock: Arc<LockClock>,
    before_initial: mpsc::Receiver<()>,
    release_initial: mpsc::SyncSender<()>,
    samples: mpsc::Receiver<(u64, u64)>,
}

impl ClockProbe {
    fn new(mode: ClockMode) -> Self {
        let (before_tx, before_rx) = mpsc::sync_channel(1);
        let (release_tx, release_rx) = mpsc::sync_channel(1);
        let (sample_tx, sample_rx) = mpsc::sync_channel(8);
        Self {
            clock: Arc::new(LockClock {
                calls: AtomicU64::new(0),
                initial: AtomicU64::new(0),
                mode,
                before_initial: before_tx,
                release_initial: Mutex::new(release_rx),
                samples: sample_tx,
            }),
            before_initial: before_rx,
            release_initial: release_tx,
            samples: sample_rx,
        }
    }

    fn sample(&self, expected_call: u64) -> u64 {
        loop {
            let (call, sampled) = self
                .samples
                .recv_timeout(Duration::from_secs(4))
                .expect("bounded actual clock sample");
            if call == expected_call {
                return sampled;
            }
            assert!(call < expected_call, "unexpected clock ordering");
        }
    }

    fn assert_not_revalidated_while_locked(&self) {
        thread::sleep(Duration::from_millis(75));
        assert_eq!(self.clock.calls.load(Ordering::Relaxed), 2);
    }
}

struct SqliteWriter {
    child: Child,
}

impl SqliteWriter {
    fn acquire(fixture: &Fixture) -> Self {
        let ready = fixture.root.join("writer-held");
        let child = Command::new(std::env::current_exe().expect("actual test executable"))
            .args([
                "--exact",
                "lock_wait::sqlite_writer",
                "--ignored",
                "--nocapture",
            ])
            .env("HEPTA_BROKER_WAIT_CHILD_DB", fixture.journal_path())
            .env("HEPTA_BROKER_WAIT_CHILD_READY", &ready)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("independent SQLite writer child");
        let mut writer = Self { child };
        let started = Instant::now();
        while !ready.exists() {
            assert!(
                writer.child.try_wait().expect("writer status").is_none(),
                "writer exited before acquiring lock"
            );
            assert!(
                started.elapsed() < Duration::from_secs(3),
                "writer lock timeout"
            );
            thread::sleep(Duration::from_millis(5));
        }
        assert_eq!(fs::read(ready).expect("actual lock witness"), b"held");
        writer
    }

    fn release(mut self) -> u64 {
        let before_release = now();
        self.child
            .stdin
            .take()
            .expect("writer release channel")
            .write_all(b"release\n")
            .expect("release actual transaction");
        let started = Instant::now();
        loop {
            if let Some(status) = self.child.try_wait().expect("writer completion") {
                assert!(status.success(), "writer failed");
                break;
            }
            assert!(
                started.elapsed() < Duration::from_secs(3),
                "writer exit timeout"
            );
            thread::sleep(Duration::from_millis(5));
        }
        before_release
    }
}

impl Drop for SqliteWriter {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[test]
#[ignore = "owned helper process invoked by the real lock-wait regressions"]
fn sqlite_writer() {
    let path = std::env::var_os("HEPTA_BROKER_WAIT_CHILD_DB").expect("owned database");
    let ready = std::env::var_os("HEPTA_BROKER_WAIT_CHILD_READY").expect("owned witness");
    let connection = rusqlite::Connection::open_with_flags(
        PathBuf::from(path),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE | rusqlite::OpenFlags::SQLITE_OPEN_NOFOLLOW,
    )
    .expect("actual child connection");
    connection
        .busy_timeout(Duration::from_secs(2))
        .expect("bounded child lock wait");
    connection
        .execute_batch("BEGIN IMMEDIATE")
        .expect("actual write lock");
    fs::write(PathBuf::from(ready), b"held").expect("publish held-lock witness");
    let mut line = String::new();
    std::io::stdin()
        .lock()
        .read_line(&mut line)
        .expect("parent release");
    assert_eq!(line, "release\n");
    connection
        .execute_batch("COMMIT")
        .expect("release actual lock");
}

fn locked_server(
    fixture: &Fixture,
    manager: Arc<CapabilityTrustBundleManagerV1>,
    request: &CodexExecutionRequestV1,
    mode: ClockMode,
) -> (RunningServer, SqliteWriter, ClockProbe, u64) {
    let probe = ClockProbe::new(mode);
    let mut server = fixture.server(manager, probe.clock.clone());
    let (bytes, _) = encoded(request);
    server
        .client()
        .write_all(&bytes)
        .expect("genuinely signed Unix request");
    // The worker is initialized and has read the whole frame, but has not yet
    // taken its first current-time sample. Hold SQLite independently before
    // allowing this actual sample and initial authentication to proceed.
    probe
        .before_initial
        .recv_timeout(Duration::from_secs(3))
        .expect("worker reached after-read clock");
    let writer = SqliteWriter::acquire(fixture);
    probe
        .release_initial
        .send(())
        .expect("permit real initial time sample");
    let initial = probe.sample(1);
    assert!(initial < request.request_capability.expires_at_unix_ms);
    assert!(initial < request.absolute_deadline_unix_ms);
    probe.assert_not_revalidated_while_locked();
    (server, writer, probe, initial)
}

fn wait_until(deadline: u64) {
    let started = Instant::now();
    while now() <= deadline {
        assert!(
            started.elapsed() < Duration::from_secs(4),
            "real-time deadline was not reached"
        );
        thread::sleep(Duration::from_millis(5));
    }
}

fn assert_refused(server: RunningServer, fixture: &Fixture, expected: BrokerMachineCodeV1) {
    assert_refused_with_rows(server, fixture, expected, 0);
}

fn assert_refused_with_rows(
    mut server: RunningServer,
    fixture: &Fixture,
    expected: BrokerMachineCodeV1,
    expected_rows: i64,
) {
    let (response, _) =
        read_response_frame(server.client(), BrokerResponseFramePolicyV1::default())
            .expect("actual refusal after writer released");
    assert_eq!(response.kind, BrokerResponseKindV1::Rejected);
    assert_eq!(response.error_code, Some(expected));
    assert!(response.request_hash.is_none());
    assert!(response.current_state.is_none());
    let summary = server.finish().expect("server drained after refusal");
    assert_eq!(summary.telemetry.reserved_operations, 0);
    assert_eq!(summary.telemetry.existing_operations, 0);
    fixture.assert_rows(expected_rows);
}

fn resign(fixture: &Fixture, request: &mut CodexExecutionRequestV1) {
    request.request_capability.signature_base64 = Base64UrlUnpadded::encode_string(
        &fixture
            .signing_key
            .sign(&capability_signing_bytes(request).expect("bound request"))
            .to_bytes(),
    );
}

#[test]
fn real_sqlite_lock_wait_cannot_preserve_an_expired_signed_capability() {
    let fixture = Fixture::new();
    let request = fixture.request(now() + 2_500);
    let (server, writer, probe, initial) =
        locked_server(&fixture, fixture.manager(), &request, ClockMode::System);
    wait_until(request.request_capability.expires_at_unix_ms);
    assert!(initial < request.request_capability.expires_at_unix_ms);
    probe.assert_not_revalidated_while_locked();
    let released_at = writer.release();
    assert!(probe.sample(2) >= released_at);
    assert_refused(server, &fixture, BrokerMachineCodeV1::AdmissionRejected);
}

#[test]
fn real_sqlite_lock_wait_past_the_signed_request_deadline_does_not_reserve() {
    let fixture = Fixture::new();
    let mut request = fixture.request(now() + 2_500);
    // The protocol requires capability expiry <= request deadline. Both end at
    // this genuine deadline; this is not an invalid longer-lived capability.
    request.absolute_deadline_unix_ms = request.request_capability.expires_at_unix_ms;
    resign(&fixture, &mut request);
    let (server, writer, probe, _) =
        locked_server(&fixture, fixture.manager(), &request, ClockMode::System);
    wait_until(request.absolute_deadline_unix_ms);
    probe.assert_not_revalidated_while_locked();
    writer.release();
    assert!(probe.sample(2) >= request.absolute_deadline_unix_ms);
    assert_refused(server, &fixture, BrokerMachineCodeV1::AdmissionRejected);
}

#[test]
fn manager_disabled_during_real_sqlite_lock_wait_is_rechecked() {
    let fixture = Fixture::new();
    let manager = fixture.manager();
    let request = fixture.request(now() + 20_000);
    let (server, writer, probe, _) =
        locked_server(&fixture, manager.clone(), &request, ClockMode::System);
    manager.disable().expect("disable actual retained manager");
    probe.assert_not_revalidated_while_locked();
    writer.release();
    probe.sample(2);
    assert_refused(server, &fixture, BrokerMachineCodeV1::CapabilityUnavailable);
}

#[test]
fn expired_request_after_lock_does_not_return_an_existing_success() {
    let fixture = Fixture::new();
    let request = fixture.request(now() + 2_500);
    let (bytes, _) = encoded(&request);
    {
        let mut journal = fixture.journal();
        let (mut client, stream) = UnixStream::pair().expect("original real Unix request");
        client.write_all(&bytes).expect("initial signed request");
        admit_and_reserve_unix_stream(
            &stream,
            &fixture.peers(),
            &fixture.trust_store(),
            &mut journal,
            now(),
            admission(500),
            FaultInjectionPointV1::None,
        )
        .expect("actual existing reservation");
    }
    let (server, writer, probe, _) =
        locked_server(&fixture, fixture.manager(), &request, ClockMode::System);
    wait_until(request.request_capability.expires_at_unix_ms);
    probe.assert_not_revalidated_while_locked();
    writer.release();
    probe.sample(2);
    assert_refused_with_rows(server, &fixture, BrokerMachineCodeV1::AdmissionRejected, 1);
}

fn signed_bundle(
    fixture: &Fixture,
    generation: u64,
    previous: Option<Sha256Digest>,
    key_expiry: Option<u64>,
    revoke_at: Option<u64>,
) -> (SignedCapabilityTrustBundleV1, CapabilityBundleAuthorityV1) {
    let sampled = now();
    let authority_key = SigningKey::from_bytes(&[41; 32]);
    let backup_key = SigningKey::from_bytes(&[43; 32]);
    let bundle = CapabilityTrustBundleV1 {
        version: 1,
        generation,
        issuer_id: "fixture-authority".to_owned(),
        valid_from_unix_ms: sampled - 1_000,
        valid_until_unix_ms: sampled + 60_000,
        minimum_accepted_generation: 1,
        previous_bundle_hash: previous,
        keys: vec![
            CapabilityTrustKeyV1 {
                key_id: "backup-key".to_owned(),
                public_key_base64: Base64UrlUnpadded::encode_string(
                    backup_key.verifying_key().as_bytes(),
                ),
                valid_from_unix_ms: sampled - 1_000,
                valid_until_unix_ms: sampled + 60_000,
                allowed_roles: vec![AgentRole::Author],
            },
            CapabilityTrustKeyV1 {
                key_id: "request-key".to_owned(),
                public_key_base64: Base64UrlUnpadded::encode_string(
                    fixture.signing_key.verifying_key().as_bytes(),
                ),
                valid_from_unix_ms: sampled - 1_000,
                valid_until_unix_ms: key_expiry.unwrap_or(sampled + 60_000),
                allowed_roles: vec![AgentRole::Author],
            },
        ],
        revocations: revoke_at
            .into_iter()
            .map(|effective_at_unix_ms| CapabilityKeyRevocationV1 {
                key_id: "request-key".to_owned(),
                effective_at_unix_ms,
                reason_code: "fixture-scheduled-revocation".to_owned(),
            })
            .collect(),
    };
    let bytes = trust_bundle_signing_bytes(&bundle).expect("real bundle signing bytes");
    let envelope = SignedCapabilityTrustBundleV1 {
        bundle,
        authority_key_id: "fixture-root".to_owned(),
        signature_base64: Base64UrlUnpadded::encode_string(&authority_key.sign(&bytes).to_bytes()),
    };
    let authority = CapabilityBundleAuthorityV1::new([(
        "fixture-root".to_owned(),
        authority_key.verifying_key(),
    )])
    .expect("real fixture root public key");
    (envelope, authority)
}

#[test]
fn signed_manager_reload_during_real_sqlite_lock_wait_is_rechecked() {
    let fixture = Fixture::new();
    let manager = fixture.manager();
    let (_, _, previous) = manager.snapshot(now()).expect("original bundle");
    let request = fixture.request(now() + 20_000);
    let (server, writer, probe, _) =
        locked_server(&fixture, manager.clone(), &request, ClockMode::System);
    let (envelope, authority) = signed_bundle(&fixture, 2, Some(previous.clone()), None, None);
    let installed = manager
        .install(&envelope, now(), &authority)
        .expect("actual authenticated manager reload");
    assert_ne!(installed.bundle_hash(), &previous);
    probe.assert_not_revalidated_while_locked();
    writer.release();
    probe.sample(2);
    assert_refused(server, &fixture, BrokerMachineCodeV1::TrustBundleChanged);
}

fn request_key_expires_during_wait(revocation: bool) {
    let fixture = Fixture::new();
    let transition_at = now() + 2_500;
    let (envelope, authority) = signed_bundle(
        &fixture,
        1,
        None,
        (!revocation).then_some(transition_at),
        revocation.then_some(transition_at),
    );
    let verified =
        verify_capability_trust_bundle(&envelope, AgentRole::Author, now(), &authority, None)
            .expect("actually signed live key schedule");
    let original_hash = verified.bundle_hash().clone();
    let manager = Arc::new(CapabilityTrustBundleManagerV1::new(verified));
    let request = fixture.request(now() + 20_000);
    let (server, writer, probe, _) =
        locked_server(&fixture, manager.clone(), &request, ClockMode::System);
    wait_until(transition_at);
    // The unchanged signed bundle remains usable through its other active key.
    // Only the request's signer has become ineligible.
    assert_eq!(
        manager.snapshot(now()).expect("backup key still active").2,
        original_hash
    );
    probe.assert_not_revalidated_while_locked();
    writer.release();
    probe.sample(2);
    assert_refused(server, &fixture, BrokerMachineCodeV1::AdmissionRejected);
}

#[test]
fn same_bundle_request_key_expiry_is_rechecked_after_real_sqlite_lock_wait() {
    request_key_expires_during_wait(false);
}

#[test]
fn same_bundle_scheduled_revocation_is_rechecked_after_real_sqlite_lock_wait() {
    request_key_expires_during_wait(true);
}

#[test]
fn fresh_request_after_lock_uses_new_time_and_exact_existing_preserves_first_time() {
    for already_reserved in [false, true] {
        let fixture = Fixture::new();
        let request = fixture.request(now() + 20_000);
        let (bytes, request_hash) = encoded(&request);
        let first_time = now();
        if already_reserved {
            let mut journal = fixture.journal();
            let (mut client, stream) = UnixStream::pair().expect("initial Unix pair");
            client.write_all(&bytes).expect("initial signed frame");
            // This public entry intentionally preserves its supplied-time contract.
            thread::sleep(Duration::from_millis(20));
            admit_and_reserve_unix_stream(
                &stream,
                &fixture.peers(),
                &fixture.trust_store(),
                &mut journal,
                first_time,
                admission(500),
                FaultInjectionPointV1::None,
            )
            .expect("first public explicit-time reservation");
        }
        let (mut server, writer, probe, initial) =
            locked_server(&fixture, fixture.manager(), &request, ClockMode::System);
        probe.assert_not_revalidated_while_locked();
        let released_at = writer.release();
        let refreshed = probe.sample(2);
        assert!(refreshed >= released_at && refreshed >= initial);
        let (response, _) =
            read_response_frame(server.client(), BrokerResponseFramePolicyV1::default())
                .expect("actual successful response after wait");
        assert_eq!(
            response.kind,
            if already_reserved {
                BrokerResponseKindV1::Existing
            } else {
                BrokerResponseKindV1::Reserved
            }
        );
        assert_eq!(response.request_hash, Some(request_hash));
        assert_eq!(response.current_state, Some(OperationState::Reserved));
        server.finish().expect("server drained");
        fixture.assert_rows(1);
        let connection = rusqlite::Connection::open_with_flags(
            fixture.journal_path(),
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .expect("final actual timestamp audit");
        let (created, consumed): (i64, i64) = connection
            .query_row(
                "SELECT operations.created_at_unix_ms, capability_nonces.consumed_at_unix_ms
             FROM operations JOIN capability_nonces USING(operation_id)",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("actual stored timestamps");
        let expected = if already_reserved {
            first_time
        } else {
            refreshed
        };
        assert_eq!(created, i64::try_from(expected).expect("actual time range"));
        assert_eq!(consumed, created);
    }
}

#[test]
fn clock_source_failure_after_real_lock_wait_leaves_no_reservation() {
    let fixture = Fixture::new();
    let request = fixture.request(now() + 20_000);
    let (server, writer, probe, _) = locked_server(
        &fixture,
        fixture.manager(),
        &request,
        ClockMode::FailAfterLock,
    );
    probe.assert_not_revalidated_while_locked();
    writer.release();
    assert!(matches!(
        server.finish(),
        Err(BrokerServerError::ClockUnavailable)
    ));
    fixture.assert_rows(0);
}

#[test]
fn injected_backward_clock_after_real_lock_wait_cannot_extend_initial_validity() {
    let fixture = Fixture::new();
    let request = fixture.request(now() + 20_000);
    let (server, writer, probe, _) = locked_server(
        &fixture,
        fixture.manager(),
        &request,
        ClockMode::RegressAfterLock,
    );
    probe.assert_not_revalidated_while_locked();
    writer.release();
    assert!(matches!(
        server.finish(),
        Err(BrokerServerError::ClockUnavailable)
    ));
    fixture.assert_rows(0);
}
