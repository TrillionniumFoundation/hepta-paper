//! The serialized service route cannot manufacture the missing retained owner.
use super::*;
use hepta_campaign_writer::{CampaignWriterPolicyV1, CampaignWriterStoreV1, WriterLeaseV1};
use hepta_control_plane::{ResourceReservationV1, SqliteCommitSequencerV1};
use hepta_module_platform::{ActionCandidateV1, QualificationTierV1, ResourceVectorV1};
use std::{
    cell::Cell,
    os::unix::fs::PermissionsExt,
    os::unix::net::UnixListener,
    time::{SystemTime, UNIX_EPOCH},
};

#[test]
fn raw_canary_service_refuses_before_clock_signer_publisher_transport_or_intent() {
    closed_entry(true);
}

#[test]
fn raw_canary_refuses_clock_and_intent_without_a_socket_fixture() {
    // A separate native negative owner, not a substitute for the live-listener
    // assertion above on hosts that permit Unix socket binding.
    closed_entry(false);
}

fn closed_entry(bind_listener: bool) {
    let root = std::env::temp_dir().join(format!(
        "hepta-canary-closed-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir(&root).unwrap();
    fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
    let hash = Sha256Digest::from_digest_bytes([3; 32]);
    let uid = nix::unistd::geteuid().as_raw();
    let gid = nix::unistd::getegid().as_raw();
    let mut store = CampaignWriterStoreV1::create_local(
        root.join("campaign.sqlite"),
        CampaignWriterPolicyV1::strict(uid),
    )
    .unwrap();
    let lease = store
        .acquire_writer(
            WriterLeaseV1 {
                generation: 1,
                token: "canary-test-writer-token-001".into(),
                expires_at_unix_ms: 50_000,
            },
            1000,
        )
        .unwrap();
    store
        .create_campaign(&lease, "canary-test", 100, 100, 0, 1000)
        .unwrap();
    let sequencer = SqliteCommitSequencerV1::new(
        store,
        lease,
        "canary-test".into(),
        hash.clone(),
        hash.clone(),
        1000,
    )
    .unwrap();
    let context = BrokerConsumerContextV1 {
        campaign_id: "canary-test".into(),
        campaign_revision: 1,
        lease_generation: 1,
        committed_results: sequencer.committed_result_snapshot(),
        current_time_unix_ms: Arc::new(AtomicU64::new(1000)),
        writer_lease_expires_at_unix_ms: 50_000,
    };
    let requests = root.join("requests");
    fs::create_dir(&requests).unwrap();
    fs::set_permissions(&requests, fs::Permissions::from_mode(0o700)).unwrap();
    let socket = root.join("broker.sock");
    let listener = if bind_listener {
        let listener = UnixListener::bind(&socket).unwrap();
        listener.set_nonblocking(true).unwrap();
        Some(listener)
    } else {
        None
    };
    let source = BrokerPreparedSourceV1 {
        socket_path: socket,
        broker_uid: uid,
        broker_gid: gid,
        request_directory: requests.clone(),
        request_owner_uid: uid,
        request_owner_gid: gid,
        role: AgentRole::Author,
        runtime_identity_hash: hash.clone(),
        timeout_ms: 1000,
        request_signer: Some(BrokerRequestSignerSourceV1 {
            private_key_path: root.join("must-never-open-key"),
            private_key_owner_uid: uid,
            private_key_owner_gid: gid,
            signer_key_id: "test".into(),
            public_key_base64: "never-resolved".into(),
            model_selector: "test".into(),
            maximum_lifetime_ms: 1000,
            maximum_output_bytes: 1024,
            maximum_event_count: 10,
            remaining_token_hint: None,
        }),
        operation_publisher: None,
        cost_settlement: None,
        commit_acknowledgement: None,
    };
    let input = BrokerPreparedInputV1 {
        version: 1,
        input_manifest: serde_json::json!({"kind":"no-dispatch"}),
        task_kind: hepta_codex_protocol::TaskKind::ReadOnlyCanary,
        prompt_envelope_hash: hash.clone(),
        workspace_identity_hash: hash.clone(),
        mutation_policy_hash: hash.clone(),
        output_schema_hash: hash.clone(),
    };
    let execution = ExecutionRequestV1 {
        version: 1,
        attempt_id: "canary-attempt".into(),
        snapshot_hash: hash.clone(),
        plan_hash: hash.clone(),
        candidate: ActionCandidateV1 {
            version: 1,
            candidate_id: "canary-candidate".into(),
            decision_group: "canary".into(),
            module_id: "canary-module".into(),
            module_version: "1.0.0".into(),
            capability_id: "CAP-AUTHOR".into(),
            snapshot_hash: hash.clone(),
            dependency_candidate_ids: vec![],
            resources: ResourceVectorV1::default(),
            utility_micros: 1,
            cost_microusd: 1,
            uncertainty_ppm: 0,
            evidence_tier: QualificationTierV1::Source,
            payload_hash: hash.clone(),
        },
        reservation: ResourceReservationV1 {
            reservation_id: "reservation".into(),
            tenant_id: "canary-test".into(),
            module_id: "canary-module".into(),
            candidate_id: "canary-candidate".into(),
            reserved: ResourceVectorV1::default(),
            admission_sequence: 1,
            reservation_hash: hash,
        },
    };
    for mode in [
        BrokerConsumeModeV1::ExecuteOnce,
        BrokerConsumeModeV1::RecoverExecution,
        BrokerConsumeModeV1::PreparedOnly,
    ] {
        let clock_called = Cell::new(false);
        let intent_called = Cell::new(false);
        let result = consume(
            &source,
            &input,
            &execution,
            &context,
            1024,
            &AtomicBool::new(false),
            mode,
            || {
                intent_called.set(true);
                Err(ServiceError::Execution)
            },
            &mut || {
                clock_called.set(true);
                Err(ServiceError::Execution)
            },
        );
        assert!(matches!(result, Err(ServiceError::Configuration)));
        assert!(!clock_called.get() && !intent_called.get());
        assert_eq!(fs::read_dir(&requests).unwrap().count(), 0);
        if let Some(listener) = &listener {
            assert_eq!(
                listener.accept().unwrap_err().kind(),
                std::io::ErrorKind::WouldBlock
            );
        } else {
            assert!(!source.socket_path.exists());
        }
        assert!(!root.join("must-never-open-key").exists());
    }
    drop(listener);
    drop(sequencer);
    fs::remove_dir_all(root).unwrap();
}
