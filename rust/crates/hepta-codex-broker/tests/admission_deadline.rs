use std::{
    fs,
    io::{self, Write},
    os::unix::{
        fs::{MetadataExt, PermissionsExt},
        net::UnixStream,
    },
    path::PathBuf,
    str::FromStr,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use base64ct::{Base64UrlUnpadded, Encoding};
use ed25519_dalek::{Signer, SigningKey};
use hepta_codex_broker::{
    AdmissionError, AdmissionPolicyV1, BrokerClockV1, BrokerFrameError, BrokerFramePolicyV1,
    BrokerJournalPolicyV1, BrokerJournalStoreV1, BrokerListenerAccessModeV1,
    BrokerListenerPolicyV1, BrokerListenerV1, BrokerMachineCodeV1, BrokerResponseFramePolicyV1,
    BrokerResponseKindV1, BrokerRolePolicyV1, BrokerServerError, BrokerServerPolicyV1,
    BrokerServerRunSummaryV1, BrokerServerV1, BrokerStateError, CapabilityBundleAuthorityV1,
    CapabilityPolicyV1, CapabilityTrustBundleManagerV1, CapabilityTrustBundleV1,
    CapabilityTrustKeyV1, CapabilityTrustStoreV1, FaultInjectionPointV1, PeerPolicyV1,
    PeerPrincipalV1, ReservationOutcomeV1, SignedCapabilityTrustBundleV1, SystemBrokerClockV1,
    admit_and_reserve_unix_stream, capability_signing_bytes, read_response_frame,
    trust_bundle_signing_bytes, verify_capability_trust_bundle, write_request_frame,
};
use hepta_codex_journal::OperationState;
use hepta_codex_protocol::{
    AgentRole, ApprovalPolicy, CodexExecutionRequestV1, NetworkPolicy, RequestCapabilityV1,
    SandboxPolicy, SessionPolicy, Sha256Digest, TaskKind, Transport,
};

static NEXT_FIXTURE: AtomicU64 = AtomicU64::new(0);

struct Fixture {
    root: PathBuf,
    uid: u32,
    gid: u32,
    signing_key: SigningKey,
}

impl Fixture {
    fn new() -> Self {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("fixture clock")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "hepta-bd-{}-{nonce}-{}",
            std::process::id(),
            NEXT_FIXTURE.fetch_add(1, Ordering::Relaxed),
        ));
        fs::create_dir(&root).expect("fixture directory");
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700))
            .expect("private fixture directory");
        let metadata = fs::metadata(&root).expect("fixture directory metadata");
        Self {
            root,
            uid: metadata.uid(),
            gid: metadata.gid(),
            signing_key: SigningKey::from_bytes(&[37; 32]),
        }
    }

    fn journal_path(&self) -> PathBuf {
        self.root.join("journal.sqlite")
    }

    fn journal(&self) -> BrokerJournalStoreV1 {
        BrokerJournalStoreV1::open(self.journal_path(), BrokerJournalPolicyV1::strict(self.uid))
            .expect("actual journal")
    }

    fn peers(&self) -> PeerPolicyV1 {
        PeerPolicyV1::new([PeerPrincipalV1 {
            uid: self.uid,
            gid: self.gid,
        }])
        .expect("actual current principal")
    }

    fn trust_store(&self) -> CapabilityTrustStoreV1 {
        CapabilityTrustStoreV1::new([("request-key".to_owned(), self.signing_key.verifying_key())])
            .expect("request key")
    }

    fn request(&self, expires_at: u64) -> CodexExecutionRequestV1 {
        let mut request = CodexExecutionRequestV1 {
            version: 1,
            operation_id: "operation-deadline".to_owned(),
            idempotency_key: digest('1'),
            campaign_id: "campaign-1".to_owned(),
            node_id: "node-1".to_owned(),
            attempt_id: "attempt-1".to_owned(),
            lease_generation: 1,
            campaign_revision: 0,
            role: AgentRole::Author,
            task_kind: TaskKind::Draft,
            codex_runtime_identity_hash: digest('2'),
            model_selector: "fixture-model".to_owned(),
            transport: Transport::ExecJsonlV1,
            session_policy: SessionPolicy::EphemeralNewThread,
            prompt_envelope_hash: digest('3'),
            input_manifest_hash: digest('4'),
            workspace_identity_hash: digest('5'),
            output_schema_hash: digest('6'),
            mutation_policy_hash: digest('7'),
            sandbox_policy: SandboxPolicy::WorkspaceWrite,
            network_policy: NetworkPolicy::None,
            approval_policy: ApprovalPolicy::Never,
            absolute_deadline_unix_ms: expires_at + 10_000,
            maximum_output_bytes: 1024,
            maximum_event_count: 100,
            maximum_cost_microusd: 1000,
            remaining_token_hint: Some(100),
            request_capability: RequestCapabilityV1 {
                nonce: "nonce-deadline".to_owned(),
                issued_at_unix_ms: now().saturating_sub(1_000),
                expires_at_unix_ms: expires_at,
                signer_key_id: "request-key".to_owned(),
                peer_uid: self.uid,
                peer_gid: self.gid,
                signature_base64: "AA".to_owned(),
            },
        };
        request.request_capability.signature_base64 = Base64UrlUnpadded::encode_string(
            &self
                .signing_key
                .sign(&capability_signing_bytes(&request).expect("request signing bytes"))
                .to_bytes(),
        );
        request
    }

    fn assert_rows(&self, expected: i64) {
        // Every server/producer connection is gone before this independent audit.
        let connection = rusqlite::Connection::open_with_flags(
            self.journal_path(),
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY
                | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX
                | rusqlite::OpenFlags::SQLITE_OPEN_NOFOLLOW,
        )
        .expect("read-only actual journal");
        for table in ["operations", "capability_nonces"] {
            let count: i64 = connection
                .query_row(&format!("SELECT count(*) FROM {table}"), [], |row| {
                    row.get(0)
                })
                .expect("actual journal count");
            assert_eq!(count, expected, "{table}");
        }
    }

    fn manager(&self) -> Arc<CapabilityTrustBundleManagerV1> {
        let sampled_now = now();
        let authority_key = SigningKey::from_bytes(&[41; 32]);
        let bundle = CapabilityTrustBundleV1 {
            version: 1,
            generation: 1,
            issuer_id: "fixture-authority".to_owned(),
            valid_from_unix_ms: sampled_now - 1_000,
            valid_until_unix_ms: sampled_now + 60_000,
            minimum_accepted_generation: 1,
            previous_bundle_hash: None,
            keys: vec![CapabilityTrustKeyV1 {
                key_id: "request-key".to_owned(),
                public_key_base64: Base64UrlUnpadded::encode_string(
                    self.signing_key.verifying_key().as_bytes(),
                ),
                valid_from_unix_ms: sampled_now - 1_000,
                valid_until_unix_ms: sampled_now + 60_000,
                allowed_roles: vec![AgentRole::Author],
            }],
            revocations: vec![],
        };
        let signature = authority_key
            .sign(&trust_bundle_signing_bytes(&bundle).expect("actual bundle signing bytes"));
        let envelope = SignedCapabilityTrustBundleV1 {
            bundle,
            authority_key_id: "fixture-root".to_owned(),
            signature_base64: Base64UrlUnpadded::encode_string(&signature.to_bytes()),
        };
        let authority = CapabilityBundleAuthorityV1::new([(
            "fixture-root".to_owned(),
            authority_key.verifying_key(),
        )])
        .expect("fixture bundle public authority");
        let verified = verify_capability_trust_bundle(
            &envelope,
            AgentRole::Author,
            sampled_now,
            &authority,
            None,
        )
        .expect("genuinely signed fixture bundle");
        Arc::new(CapabilityTrustBundleManagerV1::new(verified))
    }

    fn server(
        &self,
        manager: Arc<CapabilityTrustBundleManagerV1>,
        clock: Arc<dyn BrokerClockV1>,
    ) -> RunningServer {
        let peers = self.peers();
        let (_, _, bundle_hash) = manager.snapshot(now()).expect("fixture trust snapshot");
        let socket_path = self.root.join("broker.sock");
        let listener = BrokerListenerV1::bind(BrokerListenerPolicyV1 {
            version: 1,
            socket_path: socket_path.clone(),
            parent_owner_uid: self.uid,
            parent_owner_gid: Some(self.gid),
            parent_mode: 0o700,
            service_uid: self.uid,
            service_gid: self.gid,
            socket_mode: 0o600,
            access_mode: BrokerListenerAccessModeV1::ServiceOnly,
            instance_generation: 1,
            backlog: 2,
            role: AgentRole::Author,
            runtime_identity_hash: digest('2'),
            trust_bundle_hash: bundle_hash,
            journal_path_hash: digest('8'),
            peer_policy_hash: peers.policy_hash().expect("actual peer policy hash"),
        })
        .expect("actual local listener");
        let shutdown = Arc::new(AtomicBool::new(false));
        let server = BrokerServerV1::new(
            listener,
            peers,
            manager,
            admission(2_000),
            self.journal_path(),
            BrokerJournalPolicyV1::strict(self.uid),
            BrokerServerPolicyV1 {
                worker_threads: 1,
                queue_capacity: 1,
                accept_poll_ms: 1,
                write_timeout_ms: 1_000,
                maximum_connections: 1,
                ..BrokerServerPolicyV1::default()
            },
            BrokerResponseFramePolicyV1::default(),
            clock,
            shutdown.clone(),
        )
        .expect("actual reservation-only server");
        let (done_tx, done_rx) = mpsc::sync_channel(1);
        let handle = thread::spawn(move || {
            let result = server.run();
            let _ = done_tx.send(());
            result
        });
        let client = UnixStream::connect(socket_path).expect("connect actual listener");
        client
            .set_read_timeout(Some(Duration::from_secs(4)))
            .expect("outer response timeout");
        client
            .set_write_timeout(Some(Duration::from_secs(2)))
            .expect("outer write timeout");
        let running = RunningServer {
            client: Some(client),
            shutdown,
            done: done_rx,
            handle: Some(handle),
        };
        let marker = self.root.join("broker.sock.listener.json");
        let wait_started = Instant::now();
        loop {
            let ready = fs::read(&marker)
                .ok()
                .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
                .is_some_and(|value| value["phase"] == "ready");
            if ready {
                break;
            }
            assert!(
                wait_started.elapsed() < Duration::from_secs(3),
                "listener readiness timeout"
            );
            thread::sleep(Duration::from_millis(5));
        }
        running
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

struct RunningServer {
    client: Option<UnixStream>,
    shutdown: Arc<AtomicBool>,
    done: mpsc::Receiver<()>,
    handle: Option<thread::JoinHandle<Result<BrokerServerRunSummaryV1, BrokerServerError>>>,
}

impl RunningServer {
    fn client(&mut self) -> &mut UnixStream {
        self.client.as_mut().expect("owned client")
    }

    fn finish(mut self) -> Result<BrokerServerRunSummaryV1, BrokerServerError> {
        self.client.take();
        self.done
            .recv_timeout(Duration::from_secs(5))
            .expect("bounded real server completion");
        self.handle
            .take()
            .expect("server handle")
            .join()
            .expect("server panic")
    }
}

impl Drop for RunningServer {
    fn drop(&mut self) {
        self.shutdown.store(true, Ordering::Release);
        self.client.take();
        // The server owns at most one incomplete connection and has a read
        // deadline. Close the client and join even if a test assertion unwinds.
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

fn digest(byte: char) -> Sha256Digest {
    Sha256Digest::from_str(&format!("sha256:{}", byte.to_string().repeat(64)))
        .expect("fixture digest")
}

fn now() -> u64 {
    SystemBrokerClockV1
        .now_unix_ms()
        .expect("actual system clock")
}

fn admission(timeout_ms: u64) -> AdmissionPolicyV1 {
    AdmissionPolicyV1 {
        read_timeout_ms: timeout_ms,
        frame: BrokerFramePolicyV1::default(),
        capability: CapabilityPolicyV1::default(),
        role: BrokerRolePolicyV1::author(digest('2')),
    }
}

fn encoded(request: &CodexExecutionRequestV1) -> (Vec<u8>, Sha256Digest) {
    let mut bytes = Vec::new();
    let hash = write_request_frame(&mut bytes, request, BrokerFramePolicyV1::default())
        .expect("canonical signed frame");
    (bytes, hash)
}

fn expect_timeout(error: BrokerStateError) {
    assert!(
        matches!(
            error,
            BrokerStateError::Admission(AdmissionError::Frame(BrokerFrameError::Read(
                io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock,
            )))
        ),
        "{error}"
    );
}

#[test]
fn actual_slow_frame_cannot_renew_the_total_read_budget() {
    let fixture = Fixture::new();
    let request = fixture.request(now() + 20_000);
    let (bytes, _) = encoded(&request);
    let (mut client, server) = UnixStream::pair().expect("actual Unix pair");
    let mut journal = fixture.journal();
    let sender = thread::spawn(move || {
        // Each pause is below the 500ms timeout, but progress cannot renew it.
        for byte in &bytes[..40] {
            if client.write_all(&[*byte]).is_err() {
                return;
            }
            thread::sleep(Duration::from_millis(25));
        }
        let _ = client.write_all(&bytes[40..]);
    });
    let started = Instant::now();
    let result = admit_and_reserve_unix_stream(
        &server,
        &fixture.peers(),
        &fixture.trust_store(),
        &mut journal,
        now(),
        admission(500),
        FaultInjectionPointV1::None,
    );
    let elapsed = started.elapsed();
    drop(server);
    sender.join().expect("bounded sender");
    drop(journal);
    expect_timeout(result.expect_err("slow progress must time out"));
    assert!(elapsed < Duration::from_secs(2), "elapsed {elapsed:?}");
    fixture.assert_rows(0);
}

#[test]
fn actual_header_and_payload_share_one_deadline() {
    let fixture = Fixture::new();
    let (bytes, _) = encoded(&fixture.request(now() + 20_000));
    let (mut client, server) = UnixStream::pair().expect("actual Unix pair");
    let mut journal = fixture.journal();
    let sender = thread::spawn(move || {
        thread::sleep(Duration::from_millis(350));
        if client.write_all(&bytes[..16]).is_err() {
            return;
        }
        thread::sleep(Duration::from_millis(350));
        let _ = client.write_all(&bytes[16..]);
    });
    let result = admit_and_reserve_unix_stream(
        &server,
        &fixture.peers(),
        &fixture.trust_store(),
        &mut journal,
        now(),
        admission(500),
        FaultInjectionPointV1::None,
    );
    drop(server);
    sender.join().expect("bounded split sender");
    drop(journal);
    expect_timeout(result.expect_err("separate header and body must not get separate budgets"));
    fixture.assert_rows(0);
}

#[test]
fn complete_signed_frame_retains_public_api_hash_and_duplicate_behavior() {
    let fixture = Fixture::new();
    let request = fixture.request(now() + 20_000);
    let (bytes, expected_hash) = encoded(&request);
    let mut journal = fixture.journal();
    for duplicate in [false, true] {
        let (mut client, server) = UnixStream::pair().expect("actual Unix pair");
        client.write_all(&bytes).expect("complete signed frame");
        let receipt = admit_and_reserve_unix_stream(
            &server,
            &fixture.peers(),
            &fixture.trust_store(),
            &mut journal,
            now(),
            admission(500),
            FaultInjectionPointV1::None,
        )
        .expect("complete valid request");
        assert_eq!(receipt.request_hash, expected_hash);
        assert_eq!(receipt.operation_id, request.operation_id);
        assert_eq!(
            matches!(receipt.outcome, ReservationOutcomeV1::Existing(_)),
            duplicate
        );
    }
    drop(journal);
    fixture.assert_rows(1);
}

#[test]
fn partial_frame_eof_retains_the_existing_error_and_allocates_no_state() {
    let fixture = Fixture::new();
    let (bytes, _) = encoded(&fixture.request(now() + 20_000));
    let (mut client, server) = UnixStream::pair().expect("actual Unix pair");
    client.write_all(&bytes[..8]).expect("partial header");
    drop(client);
    let mut journal = fixture.journal();
    let error = admit_and_reserve_unix_stream(
        &server,
        &fixture.peers(),
        &fixture.trust_store(),
        &mut journal,
        now(),
        admission(500),
        FaultInjectionPointV1::None,
    )
    .expect_err("partial EOF");
    drop(journal);
    assert!(matches!(
        error,
        BrokerStateError::Admission(AdmissionError::Frame(BrokerFrameError::Read(
            io::ErrorKind::UnexpectedEof,
        )))
    ));
    fixture.assert_rows(0);
}

#[test]
fn actual_server_rechecks_real_time_after_a_signed_request_finishes_reading() {
    let fixture = Fixture::new();
    let mut server = fixture.server(fixture.manager(), Arc::new(SystemBrokerClockV1));
    let expires_at = now() + 800;
    let (bytes, _) = encoded(&fixture.request(expires_at));
    assert!(now() < expires_at, "request must be live when sent");
    server
        .client()
        .write_all(&bytes[..16])
        .expect("live request header");
    // Under the receive deadline, but after the genuine signed expiry.
    thread::sleep(Duration::from_millis(950));
    assert!(now() >= expires_at, "actual clock reached signed expiry");
    server
        .client()
        .write_all(&bytes[16..])
        .expect("expired request body");
    let (response, _) =
        read_response_frame(server.client(), BrokerResponseFramePolicyV1::default())
            .expect("actual server response");
    assert_eq!(response.kind, BrokerResponseKindV1::Rejected);
    assert_eq!(
        response.error_code,
        Some(BrokerMachineCodeV1::AdmissionRejected)
    );
    let summary = server.finish().expect("server drained");
    assert_eq!(summary.accepted_connections, 1);
    assert_eq!(summary.telemetry.admission_rejections, 1);
    assert_eq!(summary.telemetry.reserved_operations, 0);
    fixture.assert_rows(0);
}

#[test]
fn actual_server_accepts_complete_signed_request_with_the_original_response_hash() {
    let fixture = Fixture::new();
    let mut server = fixture.server(fixture.manager(), Arc::new(SystemBrokerClockV1));
    let request = fixture.request(now() + 20_000);
    let (bytes, hash) = encoded(&request);
    server
        .client()
        .write_all(&bytes)
        .expect("complete signed frame");
    let (response, _) =
        read_response_frame(server.client(), BrokerResponseFramePolicyV1::default())
            .expect("actual server response");
    assert_eq!(response.kind, BrokerResponseKindV1::Reserved);
    assert_eq!(
        response.operation_id.as_deref(),
        Some(request.operation_id.as_str())
    );
    assert_eq!(response.request_hash, Some(hash));
    assert_eq!(response.current_state, Some(OperationState::Reserved));
    assert!(response.error_code.is_none());
    let summary = server.finish().expect("server drained");
    assert_eq!(summary.telemetry.reserved_operations, 1);
    fixture.assert_rows(1);
}

#[test]
fn actual_server_uses_current_trust_after_reading_and_does_not_reserve_when_disabled() {
    let fixture = Fixture::new();
    let manager = fixture.manager();
    let mut server = fixture.server(manager.clone(), Arc::new(SystemBrokerClockV1));
    let (bytes, _) = encoded(&fixture.request(now() + 20_000));
    server
        .client()
        .write_all(&bytes[..16])
        .expect("request header");
    manager.disable().expect("disable actual manager");
    server
        .client()
        .write_all(&bytes[16..])
        .expect("request body");
    let (response, _) =
        read_response_frame(server.client(), BrokerResponseFramePolicyV1::default())
            .expect("actual refusal");
    assert_eq!(response.kind, BrokerResponseKindV1::Rejected);
    assert_eq!(
        response.error_code,
        Some(BrokerMachineCodeV1::CapabilityUnavailable)
    );
    assert_eq!(
        server
            .finish()
            .expect("server drained")
            .telemetry
            .reserved_operations,
        0
    );
    fixture.assert_rows(0);
}

struct FailingAfterStartupClock {
    calls: AtomicU64,
}

impl BrokerClockV1 for FailingAfterStartupClock {
    fn now_unix_ms(&self) -> Result<u64, BrokerServerError> {
        if self.calls.fetch_add(1, Ordering::Relaxed) == 0 {
            SystemBrokerClockV1.now_unix_ms()
        } else {
            Err(BrokerServerError::ClockUnavailable)
        }
    }
}

#[test]
fn actual_server_clock_failure_after_reading_creates_no_reservation() {
    let fixture = Fixture::new();
    let mut server = fixture.server(
        fixture.manager(),
        Arc::new(FailingAfterStartupClock {
            calls: AtomicU64::new(0),
        }),
    );
    let (bytes, _) = encoded(&fixture.request(now() + 20_000));
    server
        .client()
        .write_all(&bytes)
        .expect("complete signed frame");
    assert!(matches!(
        server.finish(),
        Err(BrokerServerError::ClockUnavailable)
    ));
    fixture.assert_rows(0);
}
