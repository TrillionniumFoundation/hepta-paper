use std::{
    fs::{self, File},
    os::unix::fs::{MetadataExt, PermissionsExt, symlink},
    path::{Path, PathBuf},
    str::FromStr,
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

use hepta_codex_broker_protocol::{
    CapabilityKeyV1, PeerCredentialsV1, VerifiedBrokerRequestV1,
    sign_request_capability_v1,
};
use hepta_codex_journal::OperationState;
use hepta_codex_journal_sqlite::{
    BrokerJournalStoreV1, JournalPathPolicyV1, JournalStoreError,
    ReservationOutcomeV1,
};
use hepta_codex_protocol::{
    AgentRole, ApprovalPolicy, CodexExecutionRequestV1, NetworkPolicy,
    RequestCapabilityV1, SandboxPolicy, SessionPolicy, Sha256Digest,
    TaskKind, Transport,
};
use sha2::{Digest, Sha256};

static NEXT_TEMP_ID: AtomicU64 = AtomicU64::new(0);

struct TempTree(PathBuf);

impl TempTree {
    fn new() -> Self {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock after epoch")
            .as_nanos();
        let sequence = NEXT_TEMP_ID.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "hepta-broker-journal-{}-{nonce}-{sequence}",
            std::process::id(),
        ));
        fs::create_dir(&path).expect("create temp directory");
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700))
            .expect("private temp directory");
        Self(path)
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempTree {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn digest(byte: char) -> Sha256Digest {
    Sha256Digest::from_str(&format!("sha256:{}", byte.to_string().repeat(64)))
        .expect("test digest")
}

fn payload_digest(payload: &[u8]) -> Sha256Digest {
    let value: [u8; 32] = Sha256::digest(payload).into();
    Sha256Digest::from_str(&format!("sha256:{}", hex::encode(value)))
        .expect("payload digest")
}

fn peer_for(path: &Path) -> PeerCredentialsV1 {
    let metadata = fs::metadata(path).expect("temp metadata");
    PeerCredentialsV1 {
        pid: std::process::id(),
        uid: metadata.uid(),
        gid: metadata.gid(),
    }
}

fn verified_request(
    operation_number: u64,
    idempotency_byte: char,
    nonce: &str,
    peer: PeerCredentialsV1,
    key: &CapabilityKeyV1,
) -> VerifiedBrokerRequestV1 {
    let mut request = CodexExecutionRequestV1 {
        version: 1,
        operation_id: format!("operation-{operation_number}"),
        idempotency_key: digest(idempotency_byte),
        campaign_id: "campaign-1".into(),
        node_id: "node-1".into(),
        attempt_id: "attempt-1".into(),
        lease_generation: 1,
        campaign_revision: 0,
        role: AgentRole::Author,
        task_kind: TaskKind::Draft,
        codex_runtime_identity_hash: digest('2'),
        model_selector: "qualified-model".into(),
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
        maximum_output_bytes: 1024,
        maximum_event_count: 100,
        maximum_cost_microusd: 1_000_000,
        remaining_token_hint: Some(10_000),
        request_capability: RequestCapabilityV1 {
            nonce: nonce.into(),
            issued_at_unix_ms: 10_000,
            expires_at_unix_ms: 15_000,
            signer_key_id: key.key_id().into(),
            peer_pid: peer.pid,
            peer_uid: peer.uid,
            peer_gid: peer.gid,
            signature_hex: "0".repeat(64),
        },
    };
    request.request_capability.signature_hex =
        sign_request_capability_v1(&request, key).expect("request signature");
    let payload = serde_json::to_vec(&request).expect("request JSON");
    let payload_hash = payload_digest(&payload);
    VerifiedBrokerRequestV1 {
        peer,
        request,
        payload_hash,
        payload,
    }
}

fn open_store(tree: &TempTree) -> BrokerJournalStoreV1 {
    let metadata = fs::metadata(tree.path()).expect("temp metadata");
    BrokerJournalStoreV1::open(
        tree.path().join("broker.sqlite"),
        JournalPathPolicyV1 {
            owner_uid: metadata.uid(),
            owner_gid: Some(metadata.gid()),
            busy_timeout_ms: 1_000,
        },
    )
    .expect("open broker journal")
}

#[test]
fn reservation_is_idempotent_and_nonce_replay_is_rejected() {
    let tree = TempTree::new();
    let peer = peer_for(tree.path());
    let key = CapabilityKeyV1::new("broker-key-1", vec![11_u8; 32])
        .expect("capability key");
    let first = verified_request(1, '1', "nonce-1", peer, &key);
    let mut store = open_store(&tree);

    assert!(matches!(
        store
            .reserve_verified_request(&first, 12_000)
            .expect("first reservation"),
        ReservationOutcomeV1::Reserved(_)
    ));
    assert!(matches!(
        store
            .reserve_verified_request(&first, 12_000)
            .expect("idempotent reservation"),
        ReservationOutcomeV1::Existing(_)
    ));

    let idempotency_conflict = verified_request(2, '1', "nonce-2", peer, &key);
    assert!(matches!(
        store.reserve_verified_request(&idempotency_conflict, 12_000),
        Err(JournalStoreError::IdempotencyConflict)
    ));

    let nonce_replay = verified_request(3, '8', "nonce-1", peer, &key);
    assert!(matches!(
        store.reserve_verified_request(&nonce_replay, 12_000),
        Err(JournalStoreError::NonceReplay)
    ));

    let report = store.verify_integrity().expect("journal integrity");
    assert_eq!(report.operation_count, 1);
    assert_eq!(report.transition_count, 0);
}

#[test]
fn complete_transition_history_reopens_and_verifies() {
    let tree = TempTree::new();
    let peer = peer_for(tree.path());
    let key = CapabilityKeyV1::new("broker-key-1", vec![13_u8; 32])
        .expect("capability key");
    let verified = verified_request(1, '1', "nonce-1", peer, &key);
    let database = tree.path().join("broker.sqlite");
    let metadata = fs::metadata(tree.path()).expect("temp metadata");
    let policy = JournalPathPolicyV1 {
        owner_uid: metadata.uid(),
        owner_gid: Some(metadata.gid()),
        busy_timeout_ms: 1_000,
    };

    {
        let mut store = BrokerJournalStoreV1::open(&database, policy)
            .expect("open broker journal");
        store
            .reserve_verified_request(&verified, 12_000)
            .expect("reserve operation");
        let steps = [
            (OperationState::RequestBound, None),
            (OperationState::ProcessSpawned, Some(digest('8'))),
            (OperationState::EventStreamStarted, None),
            (OperationState::TerminalEventObserved, Some(digest('9'))),
            (OperationState::FinalOutputCaptured, Some(digest('a'))),
            (OperationState::SchemaValidated, Some(digest('b'))),
            (OperationState::WorkspaceSnapshotted, Some(digest('c'))),
            (OperationState::MutationValidated, Some(digest('d'))),
            (OperationState::ResultPrepared, Some(digest('e'))),
            (OperationState::Acknowledged, Some(digest('f'))),
        ];
        for (index, (state, evidence)) in steps.into_iter().enumerate() {
            store
                .append_transition(
                    "operation-1",
                    state,
                    12_001 + u64::try_from(index).expect("small index"),
                    evidence,
                    None,
                )
                .expect("append transition");
        }
        let operation = store.load_operation("operation-1").expect("operation");
        assert_eq!(operation.current_state, OperationState::Acknowledged);
        assert!(operation.provider_action_may_have_started);
        assert_eq!(operation.prepared_receipt_hash, Some(digest('e')));
        assert_eq!(
            store.load_journal("operation-1").expect("journal").transitions.len(),
            10,
        );
    }

    let reopened = BrokerJournalStoreV1::open(&database, policy)
        .expect("reopen broker journal");
    let report = reopened.verify_integrity().expect("reopened integrity");
    assert_eq!(report.operation_count, 1);
    assert_eq!(report.transition_count, 10);
}

#[test]
fn symlinked_database_path_is_rejected() {
    let tree = TempTree::new();
    let target = tree.path().join("target.sqlite");
    File::create(&target).expect("target file");
    fs::set_permissions(&target, fs::Permissions::from_mode(0o600))
        .expect("target permissions");
    let link = tree.path().join("broker.sqlite");
    symlink(&target, &link).expect("database symlink");
    let metadata = fs::metadata(tree.path()).expect("temp metadata");
    assert!(matches!(
        BrokerJournalStoreV1::open(
            &link,
            JournalPathPolicyV1 {
                owner_uid: metadata.uid(),
                owner_gid: Some(metadata.gid()),
                busy_timeout_ms: 1_000,
            },
        ),
        Err(JournalStoreError::DatabaseFileNotPrivate)
    ));
}
