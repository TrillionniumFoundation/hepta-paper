use super::*;
use crate::{
    BrokerClockV1, BrokerListenerAccessModeV1, BrokerListenerPolicyV1, BrokerListenerV1,
    BrokerOperationDispatcherV1, BrokerResponseFramePolicyV1, BrokerServerError,
    BrokerServerPolicyV1, BrokerServerV1, CapabilityBundleAuthorityV1,
    CapabilityTrustBundleManagerV1, CapabilityTrustBundleV1, CapabilityTrustKeyV1,
    SignedCapabilityTrustBundleV1, load_codex_prepared_delivery, load_persisted_request,
    query_prepared_result, read_prepared_delivery_frame, trust_bundle_signing_bytes,
    verify_capability_trust_bundle, write_prepared_delivery_frame,
};
use std::io::Cursor;

struct QueryClock(AtomicU64);
impl BrokerClockV1 for QueryClock {
    fn now_unix_ms(&self) -> Result<u64, BrokerServerError> {
        Ok(self.0.load(Ordering::SeqCst))
    }
}
struct QuerySource {
    root: PathBuf,
    uid: u32,
    reads: AtomicU64,
    expire_after_read: Option<Arc<QueryClock>>,
}
impl BrokerOperationDispatcherV1 for QuerySource {
    fn recover_before_ready(&self, _: &mut BrokerJournalStoreV1) -> Result<(), CodexDispatchError> {
        Ok(())
    }
    fn dispatch(
        &self,
        _: &mut BrokerJournalStoreV1,
        _: &str,
        _: &AtomicBool,
    ) -> Result<(), CodexDispatchError> {
        panic!("a result query must never call the execution dispatcher")
    }
    fn prepared_delivery(
        &self,
        store: &BrokerJournalStoreV1,
        operation: &str,
    ) -> Result<crate::BrokerPreparedDeliveryV1, CodexDispatchError> {
        self.reads.fetch_add(1, Ordering::SeqCst);
        let result = load_codex_prepared_delivery(store, &self.root, operation, self.uid);
        if let Some(clock) = &self.expire_after_read {
            clock.0.store(16_000, Ordering::SeqCst);
        }
        result
    }
}
fn source(fixture: &Fixture) -> Arc<QuerySource> {
    Arc::new(QuerySource {
        root: fixture.root.clone(),
        uid: fixture.uid,
        reads: AtomicU64::new(0),
        expire_after_read: None,
    })
}
fn manager() -> Arc<CapabilityTrustBundleManagerV1> {
    let root = SigningKey::from_bytes(&[41; 32]);
    let key = SigningKey::from_bytes(&[31; 32]);
    let bundle = CapabilityTrustBundleV1 {
        version: 1,
        generation: 1,
        issuer_id: "fixture-root".into(),
        valid_from_unix_ms: 10_000,
        valid_until_unix_ms: 20_000,
        minimum_accepted_generation: 1,
        previous_bundle_hash: None,
        keys: vec![CapabilityTrustKeyV1 {
            key_id: "test-key".into(),
            public_key_base64: Base64UrlUnpadded::encode_string(key.verifying_key().as_bytes()),
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
    Arc::new(CapabilityTrustBundleManagerV1::new(
        verify_capability_trust_bundle(&signed, AgentRole::Author, 12_000, &authority, None)
            .unwrap(),
    ))
}
fn exchange(
    fixture: &Fixture,
    generation: u64,
    request: &CodexExecutionRequestV1,
    source: Arc<QuerySource>,
    clock: Arc<QueryClock>,
    lose_reply: bool,
) -> Option<Result<crate::BrokerPreparedDeliveryV1, crate::BrokerResultClientError>> {
    let gid = fs::metadata(&fixture.root).unwrap().gid();
    let peers = PeerPolicyV1::new([PeerPrincipalV1 {
        uid: fixture.uid,
        gid,
    }])
    .unwrap();
    let manager = manager();
    let socket = fixture.root.join("query.sock");
    let listener = BrokerListenerV1::bind(BrokerListenerPolicyV1 {
        version: 1,
        socket_path: socket.clone(),
        parent_owner_uid: fixture.uid,
        parent_owner_gid: Some(gid),
        parent_mode: 0o700,
        service_uid: fixture.uid,
        service_gid: gid,
        socket_mode: 0o600,
        access_mode: BrokerListenerAccessModeV1::ServiceOnly,
        instance_generation: generation,
        backlog: 2,
        role: AgentRole::Author,
        runtime_identity_hash: fixture.runtime.identity_hash.clone(),
        trust_bundle_hash: manager.snapshot(12_000).unwrap().2,
        journal_path_hash: hash_bytes(b"query-fixture-journal").unwrap(),
        peer_policy_hash: peers.policy_hash().unwrap(),
    })
    .unwrap();
    let server = BrokerServerV1::new(
        listener,
        peers.clone(),
        manager,
        AdmissionPolicyV1::for_role(BrokerRolePolicyV1::author(
            fixture.runtime.identity_hash.clone(),
        )),
        fixture.root.join("broker.sqlite"),
        BrokerJournalPolicyV1::strict(fixture.uid),
        BrokerServerPolicyV1 {
            worker_threads: 1,
            queue_capacity: 1,
            accept_poll_ms: 1,
            write_timeout_ms: 2_000,
            maximum_connections: 1,
            ..BrokerServerPolicyV1::default()
        },
        BrokerResponseFramePolicyV1::default(),
        clock,
        Arc::new(AtomicBool::new(false)),
    )
    .unwrap()
    .with_dispatcher(source);
    let worker = thread::spawn(move || server.run());
    let mut client = UnixStream::connect(socket).unwrap();
    let result = if lose_reply {
        crate::write_result_query_frame(&mut client, request, Default::default()).unwrap();
        None
    } else {
        Some(query_prepared_result(&client, &peers, request, 30_000))
    };
    drop(client);
    worker
        .join()
        .expect("server thread")
        .expect("server drains query without dispatch");
    result
}
fn prepared(fixture: &Fixture) -> (BrokerJournalStoreV1, crate::BrokerPreparedResultReceiptV1) {
    let mut store = fixture.reserved();
    run_reserved_codex_operation_inner(&mut store, fixture.plan(&AtomicBool::new(false)), false)
        .unwrap();
    let receipt = crate::finalize_codex_prepared_result(
        &mut store,
        &fixture.root,
        "dispatch-1",
        &fixture.workspace,
        fixture.uid,
        &fixture.mutation_policy,
        12_001,
    )
    .unwrap();
    (store, receipt)
}
fn clock() -> Arc<QueryClock> {
    Arc::new(QueryClock(AtomicU64::new(12_000)))
}
fn resign(request: &mut CodexExecutionRequestV1) {
    request.request_capability.signature_base64 = Base64UrlUnpadded::encode_string(
        &SigningKey::from_bytes(&[31; 32])
            .sign(&capability_signing_bytes(request).unwrap())
            .to_bytes(),
    );
}

#[test]
fn actual_prepared_bytes_cross_authenticated_rpc_and_replay_after_lost_reply() {
    let fixture = Fixture::new(r#"{"answer":"original prepared output"}"#, "");
    let (store, receipt) = prepared(&fixture);
    let request = load_persisted_request(&store, "dispatch-1").unwrap();
    let original = store.load_journal("dispatch-1").unwrap();
    let marker = fs::metadata(fixture.workspace.join("started.txt"))
        .unwrap()
        .modified()
        .unwrap();
    let source = source(&fixture);
    assert!(exchange(&fixture, 1, &request, source.clone(), clock(), true).is_none());
    for generation in [2, 3] {
        let result = exchange(
            &fixture,
            generation,
            &request,
            source.clone(),
            clock(),
            false,
        )
        .unwrap()
        .unwrap();
        assert_eq!(result.receipt(), &receipt);
        assert_eq!(result.output(), br#"{"answer":"original prepared output"}"#);
    }
    assert_eq!(source.reads.load(Ordering::SeqCst), 3);
    assert_eq!(store.load_journal("dispatch-1").unwrap(), original);
    assert_eq!(
        fs::metadata(fixture.workspace.join("started.txt"))
            .unwrap()
            .modified()
            .unwrap(),
        marker
    );
    assert_eq!(store.operation_count().unwrap(), 1);
}

#[test]
fn unknown_and_unprepared_queries_do_not_reserve_or_dispatch() {
    let fixture = Fixture::new(r#"{"answer":"not run"}"#, "");
    let store = fixture.reserved();
    let request = load_persisted_request(&store, "dispatch-1").unwrap();
    let source = source(&fixture);
    let not_prepared = exchange(&fixture, 1, &request, source.clone(), clock(), false).unwrap();
    assert!(matches!(
        not_prepared,
        Err(crate::BrokerResultClientError::Rejected(Some(
            crate::BrokerMachineCodeV1::StateConflict
        )))
    ));
    let mut unknown = request.clone();
    unknown.operation_id = "unknown-operation".into();
    resign(&mut unknown);
    let result = exchange(&fixture, 2, &unknown, source.clone(), clock(), false).unwrap();
    assert!(matches!(
        result,
        Err(crate::BrokerResultClientError::Rejected(Some(
            crate::BrokerMachineCodeV1::OperationNotFound
        )))
    ));
    assert_eq!(source.reads.load(Ordering::SeqCst), 0);
    assert_eq!(store.operation_count().unwrap(), 1);
    assert_eq!(
        store.load_journal("dispatch-1").unwrap().current_state,
        OperationState::Reserved
    );
    assert!(!fixture.workspace.join("started.txt").exists());
}

#[test]
fn query_refuses_signed_subject_change_and_invalid_signature() {
    let fixture = Fixture::new(r#"{"answer":"private"}"#, "");
    let (store, _) = prepared(&fixture);
    let request = load_persisted_request(&store, "dispatch-1").unwrap();
    let source = source(&fixture);
    let mut changed = request.clone();
    changed.campaign_revision += 1;
    resign(&mut changed);
    assert!(matches!(
        exchange(&fixture, 1, &changed, source.clone(), clock(), false).unwrap(),
        Err(crate::BrokerResultClientError::Rejected(Some(
            crate::BrokerMachineCodeV1::JournalConflict
        )))
    ));
    changed = request;
    changed.request_capability.signature_base64 = "A".repeat(86);
    assert!(matches!(
        exchange(&fixture, 2, &changed, source.clone(), clock(), false).unwrap(),
        Err(crate::BrokerResultClientError::Rejected(Some(
            crate::BrokerMachineCodeV1::AdmissionRejected
        )))
    ));
    assert_eq!(source.reads.load(Ordering::SeqCst), 0);
}

#[test]
fn expiry_during_output_read_denies_delivery_without_changing_prepared_state() {
    let fixture = Fixture::new(r#"{"answer":"must not escape"}"#, "");
    let (store, _) = prepared(&fixture);
    let request = load_persisted_request(&store, "dispatch-1").unwrap();
    let clock = clock();
    let source = Arc::new(QuerySource {
        root: fixture.root.clone(),
        uid: fixture.uid,
        reads: AtomicU64::new(0),
        expire_after_read: Some(clock.clone()),
    });
    assert!(matches!(
        exchange(&fixture, 1, &request, source, clock, false).unwrap(),
        Err(crate::BrokerResultClientError::Rejected(Some(
            crate::BrokerMachineCodeV1::AdmissionRejected
        )))
    ));
    assert_eq!(
        store.load_journal("dispatch-1").unwrap().current_state,
        OperationState::ResultPrepared
    );
}

#[test]
fn corrupted_or_missing_prepared_bytes_never_become_a_response() {
    let fixture = Fixture::new(r#"{"answer":"original"}"#, "");
    let (store, _) = prepared(&fixture);
    let request = load_persisted_request(&store, "dispatch-1").unwrap();
    let path = fixture.root.join("codex-result-dispatch-1.json");
    fs::write(&path, b"{}").unwrap();
    assert!(matches!(
        exchange(&fixture, 1, &request, source(&fixture), clock(), false).unwrap(),
        Err(crate::BrokerResultClientError::Rejected(Some(
            crate::BrokerMachineCodeV1::PreparedResultMismatch
        )))
    ));
    fs::remove_file(path).unwrap();
    assert!(
        load_codex_prepared_delivery(&store, &fixture.root, "dispatch-1", fixture.uid).is_err()
    );
    assert_eq!(
        store.load_journal("dispatch-1").unwrap().current_state,
        OperationState::ResultPrepared
    );
}

#[test]
fn delivery_decoder_rejects_oversize_truncation_substitution_and_wrong_subject() {
    let fixture = Fixture::new(r#"{"answer":"framing"}"#, "");
    let (store, receipt) = prepared(&fixture);
    let request = load_persisted_request(&store, "dispatch-1").unwrap();
    let delivery =
        load_codex_prepared_delivery(&store, &fixture.root, "dispatch-1", fixture.uid).unwrap();
    let mut encoded = Vec::new();
    write_prepared_delivery_frame(&mut encoded, &delivery).unwrap();
    let decode = |bytes: &[u8]| {
        read_prepared_delivery_frame(
            &mut Cursor::new(bytes),
            &request,
            &receipt.prepared_receipt_hash,
        )
    };
    assert_eq!(decode(&encoded).unwrap(), delivery);
    for cut in [0, 7, 16, 23, 24, encoded.len() - 1] {
        assert!(decode(&encoded[..cut]).is_err());
    }
    let mut changed = encoded.clone();
    changed[8..16].copy_from_slice(&u64::MAX.to_be_bytes());
    assert!(decode(&changed).is_err());
    changed = encoded.clone();
    changed[16..24].copy_from_slice(&(request.maximum_output_bytes + 1).to_be_bytes());
    assert!(decode(&changed).is_err());
    changed = encoded.clone();
    *changed.last_mut().unwrap() ^= 1;
    assert!(decode(&changed).is_err());
    let mut other = request;
    other.campaign_id = "different".into();
    resign(&mut other);
    assert!(
        read_prepared_delivery_frame(
            &mut Cursor::new(&encoded),
            &other,
            &receipt.prepared_receipt_hash
        )
        .is_err()
    );
    assert!(
        read_prepared_delivery_frame(
            &mut Cursor::new(&encoded),
            &other,
            &hash_bytes(b"wrong receipt").unwrap()
        )
        .is_err()
    );
}

#[test]
fn query_magic_is_never_accepted_by_execution_only_admission() {
    let fixture = Fixture::new(r#"{"answer":"not run"}"#, "");
    let store = fixture.reserved();
    let request = load_persisted_request(&store, "dispatch-1").unwrap();
    let mut frame = Vec::new();
    crate::write_result_query_frame(&mut frame, &request, Default::default()).unwrap();
    assert!(crate::read_request_frame(&mut Cursor::new(&frame), Default::default()).is_err());
    let (mut client, server) = UnixStream::pair().unwrap();
    client.write_all(&frame).unwrap();
    let peer = inspect_peer_identity(&server).unwrap();
    let key = SigningKey::from_bytes(&[31; 32]);
    assert!(matches!(
        admit_unix_stream(
            &server,
            &PeerPolicyV1::new([PeerPrincipalV1 {
                uid: peer.uid,
                gid: peer.gid
            }])
            .unwrap(),
            &CapabilityTrustStoreV1::new([("test-key".into(), key.verifying_key())]).unwrap(),
            12_000,
            AdmissionPolicyV1::for_role(BrokerRolePolicyV1::author(
                fixture.runtime.identity_hash.clone()
            ))
        ),
        Err(crate::AdmissionError::ReadOnlyQuery)
    ));
    assert!(!fixture.workspace.join("started.txt").exists());
}

#[test]
fn acknowledged_operation_retains_queryable_original_output_without_another_ack() {
    let fixture = Fixture::new(r#"{"answer":"already acknowledged"}"#, "");
    let (mut store, receipt) = prepared(&fixture);
    let request = load_persisted_request(&store, "dispatch-1").unwrap();
    let key = SigningKey::from_bytes(&[44; 32]);
    let mut ack = crate::PreparedResultAcknowledgementV1 {
        version: 1,
        operation_id: request.operation_id.clone(),
        request_hash: receipt.request_hash.clone(),
        prepared_receipt_hash: receipt.prepared_receipt_hash.clone(),
        campaign_id: request.campaign_id.clone(),
        node_id: request.node_id.clone(),
        attempt_id: request.attempt_id.clone(),
        campaign_revision: request.campaign_revision,
        lease_generation: request.lease_generation,
        acknowledged_at_unix_ms: 13_000,
        signer_key_id: "writer-key".into(),
        signature_base64: "A".repeat(86),
    };
    ack.signature_base64 = Base64UrlUnpadded::encode_string(
        &key.sign(&crate::prepared_result_acknowledgement_signing_bytes(&ack).unwrap())
            .to_bytes(),
    );
    let trust = crate::PreparedResultAcknowledgementTrustStoreV1::new([(
        "writer-key".into(),
        key.verifying_key(),
    )])
    .unwrap();
    let verified = crate::verify_persisted_prepared_result_acknowledgement(
        &store,
        &ack,
        13_001,
        Default::default(),
        &trust,
    )
    .unwrap();
    crate::apply_prepared_result_acknowledgement(
        &mut store,
        &verified,
        FaultInjectionPointV1::None,
    )
    .unwrap();
    let original = store.load_journal("dispatch-1").unwrap();
    let returned = exchange(
        &fixture,
        1,
        &request,
        source(&fixture),
        Arc::new(QueryClock(AtomicU64::new(13_001))),
        false,
    )
    .unwrap()
    .unwrap();
    assert_eq!(returned.receipt(), &receipt);
    assert_eq!(returned.output(), br#"{"answer":"already acknowledged"}"#);
    assert_eq!(store.load_journal("dispatch-1").unwrap(), original);
}

#[test]
fn client_rejects_unexpected_broker_before_sending_the_signed_request() {
    let fixture = Fixture::new(r#"{"answer":"not run"}"#, "");
    let store = fixture.reserved();
    let request = load_persisted_request(&store, "dispatch-1").unwrap();
    let (client, mut server) = UnixStream::pair().unwrap();
    let peer = inspect_peer_identity(&client).unwrap();
    let wrong = PeerPolicyV1::new([PeerPrincipalV1 {
        uid: peer.uid + 1,
        gid: peer.gid,
    }])
    .unwrap();
    assert!(matches!(
        query_prepared_result(&client, &wrong, &request, 100),
        Err(crate::BrokerResultClientError::Peer(_))
    ));
    server.set_nonblocking(true).unwrap();
    let mut byte = [0_u8; 1];
    assert_eq!(
        std::io::Read::read(&mut server, &mut byte)
            .unwrap_err()
            .kind(),
        std::io::ErrorKind::WouldBlock
    );
}
