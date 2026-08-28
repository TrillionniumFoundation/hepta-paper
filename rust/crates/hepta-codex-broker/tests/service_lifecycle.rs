use std::{
    collections::BTreeMap,
    ffi::OsString,
    fs::{self, File},
    io::Write,
    os::unix::{
        fs::{MetadataExt, PermissionsExt},
        net::UnixStream,
    },
    path::{Path, PathBuf},
    str::FromStr,
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

use base64ct::{Base64UrlUnpadded, Encoding};
use ed25519_dalek::{Signer, SigningKey};
use hepta_codex_broker::{
    AdmissionPolicyV1, BrokerBackupPolicyV1, BrokerFramePolicyV1, BrokerJournalPolicyV1,
    BrokerJournalStoreV1, BrokerRolePolicyV1, CapabilityPolicyV1, CapabilityTrustStoreV1,
    FakeBrokerExecutionError, FakeBrokerExecutionPlanV1, FakeExecutionEvidenceV1,
    FakeExecutionFaultV1, FakeExecutionTimelineV1, FaultInjectionPointV1, PeerPolicyV1,
    PeerPrincipalV1, PreparedResultAcknowledgementPolicyV1,
    PreparedResultAcknowledgementTrustStoreV1, PreparedResultAcknowledgementV1,
    ReservationOutcomeV1, admit_and_reserve_unix_stream, apply_prepared_result_acknowledgement,
    capability_signing_bytes, create_broker_backup, inspect_peer_identity,
    list_recovery_candidates, prepared_result_acknowledgement_signing_bytes, restore_broker_backup,
    run_reserved_fake_operation, verify_prepared_result_acknowledgement, write_request_frame,
};
use hepta_codex_journal::{OperationState, RecoveryDisposition};
use hepta_codex_protocol::{
    AgentRole, ApprovalPolicy, CodexExecutionRequestV1, NetworkPolicy, RequestCapabilityV1,
    SandboxPolicy, SessionPolicy, Sha256Digest, TaskKind, Transport,
};
use hepta_codex_runtime::{BoundedProcessRequestV1, EnvironmentPolicyV1, ProcessLimitsV1};

static NEXT_TEMP_ID: AtomicU64 = AtomicU64::new(0);

struct TempTree {
    root: PathBuf,
    journal_path: PathBuf,
    owner_uid: u32,
}

impl TempTree {
    fn new() -> Self {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock after epoch")
            .as_nanos();
        let sequence = NEXT_TEMP_ID.fetch_add(1, Ordering::Relaxed);
        let root = std::env::temp_dir().join(format!(
            "hepta-broker-service-test-{}-{nonce}-{sequence}",
            std::process::id(),
        ));
        fs::create_dir(&root).expect("create private root");
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700))
            .expect("set private root mode");
        let owner_uid = fs::metadata(&root).expect("root metadata").uid();
        Self {
            journal_path: root.join("broker.sqlite"),
            root,
            owner_uid,
        }
    }

    fn journal_policy(&self) -> BrokerJournalPolicyV1 {
        BrokerJournalPolicyV1::strict(self.owner_uid)
    }

    fn open_journal(&self) -> BrokerJournalStoreV1 {
        BrokerJournalStoreV1::open(&self.journal_path, self.journal_policy())
            .expect("open broker journal")
    }
}

impl Drop for TempTree {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn digest(byte: char) -> Sha256Digest {
    Sha256Digest::from_str(&format!("sha256:{}", byte.to_string().repeat(64))).expect("test digest")
}

fn signed_request(
    peer_uid: u32,
    peer_gid: u32,
    operation_id: &str,
    nonce: &str,
    signing_key: &SigningKey,
) -> CodexExecutionRequestV1 {
    let mut request = CodexExecutionRequestV1 {
        version: 1,
        operation_id: operation_id.to_owned(),
        idempotency_key: digest('1'),
        campaign_id: "campaign-1".to_owned(),
        node_id: "node-1".to_owned(),
        attempt_id: "attempt-1".to_owned(),
        lease_generation: 1,
        campaign_revision: 0,
        role: AgentRole::Author,
        task_kind: TaskKind::Draft,
        codex_runtime_identity_hash: digest('2'),
        model_selector: "qualified-model".to_owned(),
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
        absolute_deadline_unix_ms: 20_000,
        maximum_output_bytes: 64 * 1024,
        maximum_event_count: 100,
        maximum_cost_microusd: 1_000_000,
        remaining_token_hint: Some(10_000),
        request_capability: RequestCapabilityV1 {
            nonce: nonce.to_owned(),
            issued_at_unix_ms: 10_000,
            expires_at_unix_ms: 15_000,
            signer_key_id: "request-key-1".to_owned(),
            peer_uid,
            peer_gid,
            signature_base64: "AA".to_owned(),
        },
    };
    let message = capability_signing_bytes(&request).expect("request signing bytes");
    request.request_capability.signature_base64 =
        Base64UrlUnpadded::encode_string(&signing_key.sign(&message).to_bytes());
    request
}

fn reserve_operation(
    store: &mut BrokerJournalStoreV1,
    operation_id: &str,
) -> (CodexExecutionRequestV1, Sha256Digest) {
    let (mut client, server) = UnixStream::pair().expect("Unix stream pair");
    let peer = inspect_peer_identity(&server).expect("peer credentials");
    let signing_key = SigningKey::from_bytes(&[11_u8; 32]);
    let request = signed_request(
        peer.uid,
        peer.gid,
        operation_id,
        &format!("nonce-{operation_id}"),
        &signing_key,
    );
    let trust_store =
        CapabilityTrustStoreV1::new([("request-key-1".to_owned(), signing_key.verifying_key())])
            .expect("request trust store");
    let peer_policy = PeerPolicyV1::new([PeerPrincipalV1 {
        uid: peer.uid,
        gid: peer.gid,
    }])
    .expect("peer policy");
    let admission = AdmissionPolicyV1 {
        read_timeout_ms: 5_000,
        frame: BrokerFramePolicyV1::default(),
        capability: CapabilityPolicyV1::default(),
        role: BrokerRolePolicyV1::author(digest('2')),
    };
    let expected_request_hash =
        write_request_frame(&mut client, &request, BrokerFramePolicyV1::default())
            .expect("write request frame");
    let reserved = admit_and_reserve_unix_stream(
        &server,
        &peer_policy,
        &trust_store,
        store,
        12_000,
        admission,
        FaultInjectionPointV1::None,
    )
    .expect("admit and reserve");
    assert_eq!(reserved.request_hash, expected_request_hash);
    assert!(matches!(
        reserved.outcome,
        ReservationOutcomeV1::Reserved(_),
    ));
    (request, expected_request_hash)
}

fn append_prepared_path(
    store: &mut BrokerJournalStoreV1,
    operation_id: &str,
    prepared_receipt_hash: Sha256Digest,
) {
    let states = [
        (OperationState::Reserved, OperationState::RequestBound, None),
        (
            OperationState::RequestBound,
            OperationState::ProcessSpawned,
            Some(digest('8')),
        ),
        (
            OperationState::ProcessSpawned,
            OperationState::EventStreamStarted,
            None,
        ),
        (
            OperationState::EventStreamStarted,
            OperationState::TerminalEventObserved,
            Some(digest('9')),
        ),
        (
            OperationState::TerminalEventObserved,
            OperationState::FinalOutputCaptured,
            Some(digest('a')),
        ),
        (
            OperationState::FinalOutputCaptured,
            OperationState::SchemaValidated,
            Some(digest('b')),
        ),
        (
            OperationState::SchemaValidated,
            OperationState::WorkspaceSnapshotted,
            Some(digest('c')),
        ),
        (
            OperationState::WorkspaceSnapshotted,
            OperationState::MutationValidated,
            Some(digest('d')),
        ),
        (
            OperationState::MutationValidated,
            OperationState::ResultPrepared,
            Some(prepared_receipt_hash),
        ),
    ];
    for (index, (from, to, evidence)) in states.into_iter().enumerate() {
        store
            .append_transition(
                operation_id,
                from,
                to,
                12_001 + u64::try_from(index).expect("small transition sequence"),
                evidence,
                None,
                FaultInjectionPointV1::None,
            )
            .expect("append prepared path transition");
    }
}

#[test]
fn backup_restore_preserves_operations_and_recovery_projection() {
    let fixture = TempTree::new();
    let mut store = fixture.open_journal();
    let (_request, _request_hash) = reserve_operation(&mut store, "operation-backup");
    let candidates = list_recovery_candidates(&store, 10).expect("recovery candidates");
    assert_eq!(candidates.len(), 1);
    assert_eq!(
        candidates[0].recovery_disposition,
        RecoveryDisposition::ResumeSameOperation,
    );

    let backup = fixture.root.join("broker-backup.sqlite");
    let receipt = create_broker_backup(
        &store,
        &backup,
        fixture.journal_policy(),
        BrokerBackupPolicyV1::strict(fixture.owner_uid),
        13_000,
    )
    .expect("create broker backup");
    assert_eq!(receipt.operation_count, 1);
    drop(store);

    let restored = fixture.root.join("broker-restored.sqlite");
    let restore_receipt = restore_broker_backup(
        &backup,
        &restored,
        fixture.journal_policy(),
        BrokerBackupPolicyV1::strict(fixture.owner_uid),
        14_000,
    )
    .expect("restore broker backup");
    assert_eq!(restore_receipt.operation_count, 1);
    let restored_store = BrokerJournalStoreV1::open(&restored, fixture.journal_policy())
        .expect("open restored journal");
    restored_store
        .validate_integrity()
        .expect("restored integrity");
    assert_eq!(
        restored_store
            .load_journal("operation-backup")
            .expect("restored operation")
            .current_state,
        OperationState::Reserved,
    );
}

#[test]
fn signed_acknowledgement_closes_only_the_exact_prepared_subject() {
    let fixture = TempTree::new();
    let mut store = fixture.open_journal();
    let (request, request_hash) = reserve_operation(&mut store, "operation-ack");
    let prepared_hash = digest('e');
    append_prepared_path(&mut store, &request.operation_id, prepared_hash.clone());
    let journal = store
        .load_journal(&request.operation_id)
        .expect("prepared journal");

    let acknowledgement_key = SigningKey::from_bytes(&[12_u8; 32]);
    let mut acknowledgement = PreparedResultAcknowledgementV1 {
        version: 1,
        operation_id: request.operation_id.clone(),
        request_hash,
        prepared_receipt_hash: prepared_hash.clone(),
        campaign_id: request.campaign_id.clone(),
        node_id: request.node_id.clone(),
        attempt_id: request.attempt_id.clone(),
        campaign_revision: request.campaign_revision,
        lease_generation: request.lease_generation,
        acknowledged_at_unix_ms: 13_000,
        signer_key_id: "campaign-writer-key-1".to_owned(),
        signature_base64: "AA".to_owned(),
    };
    let signing_bytes = prepared_result_acknowledgement_signing_bytes(&acknowledgement)
        .expect("acknowledgement signing bytes");
    acknowledgement.signature_base64 =
        Base64UrlUnpadded::encode_string(&acknowledgement_key.sign(&signing_bytes).to_bytes());
    let trust_store = PreparedResultAcknowledgementTrustStoreV1::new([(
        "campaign-writer-key-1".to_owned(),
        acknowledgement_key.verifying_key(),
    )])
    .expect("acknowledgement trust store");
    let verified = verify_prepared_result_acknowledgement(
        &acknowledgement,
        &request,
        &journal,
        13_001,
        PreparedResultAcknowledgementPolicyV1::default(),
        &trust_store,
    )
    .expect("verify acknowledgement");
    let acknowledged =
        apply_prepared_result_acknowledgement(&mut store, &verified, FaultInjectionPointV1::None)
            .expect("apply acknowledgement");
    assert_eq!(acknowledged.current_state, OperationState::Acknowledged);

    let mut wrong_subject = acknowledgement;
    wrong_subject.lease_generation = 2;
    assert!(
        verify_prepared_result_acknowledgement(
            &wrong_subject,
            &request,
            &journal,
            13_001,
            PreparedResultAcknowledgementPolicyV1::default(),
            &trust_store,
        )
        .is_err()
    );
}

fn write_executable(path: &Path, body: &str) {
    let mut file = File::create(path).expect("create fake executable");
    file.write_all(body.as_bytes())
        .expect("write fake executable");
    file.sync_all().expect("sync fake executable");
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
        .expect("mark fake executable private executable");
}

fn fake_process_request(fixture: &TempTree, script: &str) -> BoundedProcessRequestV1 {
    let executable = fixture.root.join("fake-codex.sh");
    write_executable(&executable, script);
    let environment = EnvironmentPolicyV1::new(
        "fake-process-v1",
        ["PATH", "HOME", "TMPDIR"],
        ["PATH", "HOME", "TMPDIR"],
    )
    .expect("fake environment policy")
    .build(
        [
            (OsString::from("PATH"), OsString::from("/usr/bin:/bin")),
            (
                OsString::from("HOME"),
                fixture.root.clone().into_os_string(),
            ),
            (
                OsString::from("TMPDIR"),
                fixture.root.clone().into_os_string(),
            ),
        ],
        &BTreeMap::new(),
    )
    .expect("restricted fake environment");
    BoundedProcessRequestV1 {
        executable,
        arguments: Vec::new(),
        working_directory: fixture.root.clone(),
        environment,
        stdin: None,
    }
}

fn timeline() -> FakeExecutionTimelineV1 {
    FakeExecutionTimelineV1 {
        request_bound_unix_ms: 12_001,
        process_spawned_unix_ms: 12_002,
        event_stream_started_unix_ms: 12_003,
        terminal_event_observed_unix_ms: 12_004,
        final_output_captured_unix_ms: 12_005,
        schema_validated_unix_ms: 12_006,
        workspace_snapshotted_unix_ms: 12_007,
        mutation_validated_unix_ms: 12_008,
        result_prepared_unix_ms: 12_009,
    }
}

fn fake_evidence() -> FakeExecutionEvidenceV1 {
    FakeExecutionEvidenceV1 {
        process_start_identity_hash: digest('8'),
        final_output_hash: digest('9'),
        schema_validation_hash: digest('a'),
        workspace_snapshot_hash: digest('b'),
        mutation_validation_hash: digest('c'),
        prepared_receipt_hash: digest('d'),
    }
}

#[test]
fn fake_process_is_durably_linked_through_result_prepared() {
    let fixture = TempTree::new();
    let mut store = fixture.open_journal();
    reserve_operation(&mut store, "operation-fake-success");
    let script = r#"#!/bin/sh
set -eu
cat <<'EOF'
{"type":"thread.started","thread_id":"thread-1"}
{"type":"turn.started"}
{"type":"item.completed","item":{"id":"item-1"}}
{"type":"turn.completed","usage":{"input_tokens":10,"cached_input_tokens":0,"output_tokens":3,"reasoning_output_tokens":0}}
EOF
"#;
    let prepared = run_reserved_fake_operation(
        &mut store,
        FakeBrokerExecutionPlanV1 {
            operation_id: "operation-fake-success".to_owned(),
            process: fake_process_request(&fixture, script),
            process_limits: ProcessLimitsV1::default(),
            maximum_event_count: 16,
            maximum_jsonl_line_bytes: 4096,
            timeline: timeline(),
            evidence: fake_evidence(),
            fault: None,
        },
    )
    .expect("run fake operation");
    assert_eq!(
        prepared.journal.current_state,
        OperationState::ResultPrepared
    );
    assert_eq!(
        prepared.event_stream.terminal_event_kind,
        hepta_codex_protocol::TerminalEventKind::TurnCompleted,
    );
    assert!(prepared.process.process_group_cleanup_verified);
}

#[test]
fn failed_spawn_journal_commit_kills_fake_process_and_rolls_back_transition() {
    let fixture = TempTree::new();
    let mut store = fixture.open_journal();
    reserve_operation(&mut store, "operation-fake-fault");
    let script = "#!/bin/sh\nset -eu\nsleep 30\n";
    let error = run_reserved_fake_operation(
        &mut store,
        FakeBrokerExecutionPlanV1 {
            operation_id: "operation-fake-fault".to_owned(),
            process: fake_process_request(&fixture, script),
            process_limits: ProcessLimitsV1 {
                timeout_ms: 5_000,
                ..ProcessLimitsV1::default()
            },
            maximum_event_count: 16,
            maximum_jsonl_line_bytes: 4096,
            timeline: timeline(),
            evidence: fake_evidence(),
            fault: Some(FakeExecutionFaultV1 {
                transition_to: OperationState::ProcessSpawned,
                fault: FaultInjectionPointV1::AfterProjectionUpdate,
            }),
        },
    )
    .expect_err("spawn journal fault must fail closed");
    assert!(matches!(
        error,
        FakeBrokerExecutionError::SpawnJournalLinkFailed(_),
    ));
    assert_eq!(
        store
            .load_journal("operation-fake-fault")
            .expect("journal after rollback")
            .current_state,
        OperationState::RequestBound,
    );
}
