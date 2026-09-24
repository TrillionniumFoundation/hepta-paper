use super::*;
use hepta_codex_broker::{
    BrokerClockV1, BrokerListenerAccessModeV1, BrokerListenerPolicyV1, BrokerListenerV1,
    BrokerMachineCodeV1, BrokerOperationDispatcherV1, BrokerResponseFramePolicyV1,
    BrokerResponseKindV1, BrokerResponseV1, BrokerServerError, BrokerServerPolicyV1,
    BrokerServerV1, CapabilityBundleAuthorityV1, CapabilityTrustBundleManagerV1,
    CapabilityTrustBundleV1, CapabilityTrustKeyV1, CodexDispatchError,
    SignedCapabilityTrustBundleV1, read_response_frame, trust_bundle_signing_bytes,
    verify_capability_trust_bundle,
};
use std::{
    sync::{Arc, atomic::AtomicBool},
    thread,
    time::Duration,
};

struct Clock;
impl BrokerClockV1 for Clock {
    fn now_unix_ms(&self) -> Result<u64, BrokerServerError> {
        Ok(12_000)
    }
}

// Actual server, signed admission, SQLite and supervised process; this explicit
// local fixture does not attest a live model or production dispatch authority.
struct PreparedDispatcher {
    fixture: Arc<TempTree>,
    calls: AtomicU64,
    reject: bool,
}
impl BrokerOperationDispatcherV1 for PreparedDispatcher {
    fn recover_before_ready(&self, _: &mut BrokerJournalStoreV1) -> Result<(), CodexDispatchError> {
        Ok(())
    }
    fn dispatch(
        &self,
        journal: &mut BrokerJournalStoreV1,
        operation: &str,
        _: &AtomicBool,
    ) -> Result<(), CodexDispatchError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        if self.reject {
            return Err(CodexDispatchError::InvalidBinding("fixture_rejected"));
        }
        append_prepared_path(journal, &self.fixture, operation, digest('e'));
        Ok(())
    }
}

fn manager() -> Arc<CapabilityTrustBundleManagerV1> {
    let root = SigningKey::from_bytes(&[41; 32]);
    let request = SigningKey::from_bytes(&[11; 32]);
    let bundle = CapabilityTrustBundleV1 {
        version: 1,
        generation: 1,
        issuer_id: "fixture-root".into(),
        valid_from_unix_ms: 10_000,
        valid_until_unix_ms: 20_000,
        minimum_accepted_generation: 1,
        previous_bundle_hash: None,
        keys: vec![CapabilityTrustKeyV1 {
            key_id: "request-key-1".into(),
            public_key_base64: Base64UrlUnpadded::encode_string(request.verifying_key().as_bytes()),
            valid_from_unix_ms: 10_000,
            valid_until_unix_ms: 20_000,
            allowed_roles: vec![AgentRole::Author],
        }],
        revocations: vec![],
    };
    let signature = root.sign(&trust_bundle_signing_bytes(&bundle).unwrap());
    let signed = SignedCapabilityTrustBundleV1 {
        bundle,
        authority_key_id: "fixture-root".into(),
        signature_base64: Base64UrlUnpadded::encode_string(&signature.to_bytes()),
    };
    let authority =
        CapabilityBundleAuthorityV1::new([("fixture-root".into(), root.verifying_key())]).unwrap();
    let verified =
        verify_capability_trust_bundle(&signed, AgentRole::Author, 12_000, &authority, None)
            .unwrap();
    Arc::new(CapabilityTrustBundleManagerV1::new(verified))
}

fn request(fixture: &TempTree) -> CodexExecutionRequestV1 {
    signed_request(
        fixture.owner_uid,
        fs::metadata(&fixture.root).unwrap().gid(),
        "response-operation",
        "response-nonce",
        &SigningKey::from_bytes(&[11; 32]),
    )
}

fn exchange(
    fixture: &TempTree,
    generation: u64,
    request: &CodexExecutionRequestV1,
    dispatcher: Arc<PreparedDispatcher>,
    lose_reply: bool,
) -> Option<BrokerResponseV1> {
    let gid = fs::metadata(&fixture.root).unwrap().gid();
    let peers = PeerPolicyV1::new([PeerPrincipalV1 {
        uid: fixture.owner_uid,
        gid,
    }])
    .unwrap();
    let manager = manager();
    let socket = fixture.root.join("result.sock");
    let listener = BrokerListenerV1::bind(BrokerListenerPolicyV1 {
        version: 1,
        socket_path: socket.clone(),
        parent_owner_uid: fixture.owner_uid,
        parent_owner_gid: Some(gid),
        parent_mode: 0o700,
        service_uid: fixture.owner_uid,
        service_gid: gid,
        socket_mode: 0o600,
        access_mode: BrokerListenerAccessModeV1::ServiceOnly,
        instance_generation: generation,
        backlog: 2,
        role: AgentRole::Author,
        runtime_identity_hash: digest('2'),
        trust_bundle_hash: manager.snapshot(12_000).unwrap().2,
        journal_path_hash: digest('8'),
        peer_policy_hash: peers.policy_hash().unwrap(),
    })
    .unwrap();
    let server = BrokerServerV1::new(
        listener,
        peers,
        manager,
        AdmissionPolicyV1 {
            read_timeout_ms: 2_000,
            frame: BrokerFramePolicyV1::default(),
            capability: CapabilityPolicyV1::default(),
            role: BrokerRolePolicyV1::author(digest('2')),
        },
        fixture.journal_path.clone(),
        fixture.journal_policy(),
        BrokerServerPolicyV1 {
            worker_threads: 1,
            queue_capacity: 1,
            accept_poll_ms: 1,
            write_timeout_ms: 2_000,
            maximum_connections: 1,
            ..BrokerServerPolicyV1::default()
        },
        BrokerResponseFramePolicyV1::default(),
        Arc::new(Clock),
        Arc::new(AtomicBool::new(false)),
    )
    .unwrap()
    .with_dispatcher(dispatcher);
    let handle = thread::spawn(move || server.run());
    let mut client = UnixStream::connect(socket).unwrap();
    // The fixture includes real SQLite fsync and process reconciliation on a
    // shared host. This outer wait is not a production latency/SLO assertion.
    client
        .set_read_timeout(Some(Duration::from_secs(120)))
        .unwrap();
    client
        .set_write_timeout(Some(Duration::from_secs(2)))
        .unwrap();
    write_request_frame(&mut client, request, BrokerFramePolicyV1::default()).unwrap();
    let result = if lose_reply {
        None
    } else {
        Some(read_response_frame(
            &mut client,
            BrokerResponseFramePolicyV1::default(),
        ))
    };
    drop(client);
    handle
        .join()
        .expect("server thread")
        .expect("server drains and stops");
    result.map(|value| value.expect("bounded actual response").0)
}

fn dispatcher(fixture: Arc<TempTree>, reject: bool) -> Arc<PreparedDispatcher> {
    Arc::new(PreparedDispatcher {
        fixture,
        calls: AtomicU64::new(0),
        reject,
    })
}

#[test]
fn normal_rpc_returns_prepared_identity_and_replays_after_listener_restart() {
    let fixture = Arc::new(TempTree::new());
    let dispatcher = dispatcher(fixture.clone(), false);
    let request = request(&fixture);
    let first = exchange(&fixture, 1, &request, dispatcher.clone(), false).unwrap();
    assert_eq!(first.kind, BrokerResponseKindV1::Prepared);
    assert_eq!(first.current_state, Some(OperationState::ResultPrepared));
    assert_eq!(first.prepared_receipt_hash, Some(digest('e')));
    let second = exchange(&fixture, 2, &request, dispatcher.clone(), false).unwrap();
    assert_eq!(first, second);
    assert_eq!(dispatcher.calls.load(Ordering::SeqCst), 1);
    fixture.open_journal().validate_integrity().unwrap();
}

#[test]
fn lost_prepared_response_is_recovered_without_another_dispatch() {
    let fixture = Arc::new(TempTree::new());
    let dispatcher = dispatcher(fixture.clone(), false);
    let request = request(&fixture);
    assert!(exchange(&fixture, 1, &request, dispatcher.clone(), true).is_none());
    let recovered = exchange(&fixture, 2, &request, dispatcher.clone(), false).unwrap();
    assert_eq!(recovered.kind, BrokerResponseKindV1::Prepared);
    assert_eq!(recovered.prepared_receipt_hash, Some(digest('e')));
    assert_eq!(dispatcher.calls.load(Ordering::SeqCst), 1);
    assert_eq!(fixture.open_journal().operation_count().unwrap(), 1);
}

#[test]
fn acknowledged_response_carries_both_original_durable_hashes() {
    let fixture = Arc::new(TempTree::new());
    let dispatcher = dispatcher(fixture.clone(), false);
    let request = request(&fixture);
    let prepared = exchange(&fixture, 1, &request, dispatcher.clone(), false).unwrap();
    let (ack, trust) = super::acknowledgement_recovery::signed_ack(
        &request,
        prepared.request_hash.clone().unwrap(),
    );
    let mut store = fixture.open_journal();
    let verified = hepta_codex_broker::verify_persisted_prepared_result_acknowledgement(
        &store,
        &ack,
        13_001,
        PreparedResultAcknowledgementPolicyV1::default(),
        &trust,
    )
    .unwrap();
    apply_prepared_result_acknowledgement(&mut store, &verified, FaultInjectionPointV1::None)
        .unwrap();
    drop(store);
    let observed = exchange(&fixture, 2, &request, dispatcher.clone(), false).unwrap();
    assert_eq!(observed.kind, BrokerResponseKindV1::Acknowledged);
    assert_eq!(observed.current_state, Some(OperationState::Acknowledged));
    assert_eq!(
        observed.prepared_receipt_hash,
        prepared.prepared_receipt_hash
    );
    assert_eq!(
        observed.acknowledgement_hash.as_ref(),
        Some(verified.acknowledgement_hash())
    );
    assert_eq!(dispatcher.calls.load(Ordering::SeqCst), 1);
}

#[test]
fn conflicting_signed_retry_cannot_read_or_replace_the_prepared_subject() {
    let fixture = Arc::new(TempTree::new());
    let dispatcher = dispatcher(fixture.clone(), false);
    let mut request = request(&fixture);
    let original = exchange(&fixture, 1, &request, dispatcher.clone(), false).unwrap();
    request.campaign_revision += 1;
    request.request_capability.signature_base64 = Base64UrlUnpadded::encode_string(
        &SigningKey::from_bytes(&[11; 32])
            .sign(&capability_signing_bytes(&request).unwrap())
            .to_bytes(),
    );
    let rejected = exchange(&fixture, 2, &request, dispatcher.clone(), false).unwrap();
    assert_eq!(rejected.kind, BrokerResponseKindV1::Rejected);
    assert_eq!(
        rejected.error_code,
        Some(BrokerMachineCodeV1::JournalConflict)
    );
    assert!(rejected.prepared_receipt_hash.is_none());
    assert_eq!(dispatcher.calls.load(Ordering::SeqCst), 1);
    let persisted = fixture
        .open_journal()
        .load_journal(&request.operation_id)
        .unwrap();
    assert_eq!(Some(persisted.request_hash), original.request_hash);
}

#[test]
fn rejected_dispatch_never_becomes_a_prepared_response_or_reexecutes() {
    let fixture = Arc::new(TempTree::new());
    let dispatcher = dispatcher(fixture.clone(), true);
    let request = request(&fixture);
    let first = exchange(&fixture, 1, &request, dispatcher.clone(), false).unwrap();
    assert_eq!(first.current_state, Some(OperationState::RejectedPreflight));
    assert_eq!(first.kind, BrokerResponseKindV1::Reserved);
    assert!(first.prepared_receipt_hash.is_none());
    let second = exchange(&fixture, 2, &request, dispatcher.clone(), false).unwrap();
    assert_eq!(second.kind, BrokerResponseKindV1::Existing);
    assert_eq!(second.current_state, first.current_state);
    assert!(second.prepared_receipt_hash.is_none());
    assert_eq!(dispatcher.calls.load(Ordering::SeqCst), 1);
}
