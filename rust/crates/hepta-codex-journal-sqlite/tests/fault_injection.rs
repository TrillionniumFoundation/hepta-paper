#[path = "../src/schema.rs"]
mod schema;
#[path = "../src/store.rs"]
mod store;
#[path = "../src/types.rs"]
mod types;

use std::{
    fs,
    os::unix::fs::{MetadataExt, PermissionsExt},
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
use hepta_codex_protocol::{
    AgentRole, ApprovalPolicy, CodexExecutionRequestV1, NetworkPolicy,
    RequestCapabilityV1, SandboxPolicy, SessionPolicy, Sha256Digest,
    TaskKind, Transport,
};
use sha2::{Digest, Sha256};
use store::BrokerJournalStoreV1;
use types::{JournalFaultPointV1, JournalPathPolicyV1, JournalStoreError};

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
            "hepta-broker-fault-{}-{nonce}-{sequence}",
            std::process::id(),
        ));
        fs::create_dir(&path).expect("create temp directory");
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700))
            .expect("private temp directory");
        Self(path)
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

fn verified_request(tree: &TempTree) -> VerifiedBrokerRequestV1 {
    let metadata = fs::metadata(&tree.0).expect("temp metadata");
    let peer = PeerCredentialsV1 {
        pid: std::process::id(),
        uid: metadata.uid(),
        gid: metadata.gid(),
    };
    let key = CapabilityKeyV1::new("broker-key-1", vec![17_u8; 32])
        .expect("capability key");
    let mut request = CodexExecutionRequestV1 {
        version: 1,
        operation_id: "operation-1".into(),
        idempotency_key: digest('1'),
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
            nonce: "nonce-1".into(),
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
        sign_request_capability_v1(&request, &key).expect("signature");
    let payload = serde_json::to_vec(&request).expect("request JSON");
    let hash: [u8; 32] = Sha256::digest(&payload).into();
    VerifiedBrokerRequestV1 {
        peer,
        request,
        payload_hash: Sha256Digest::from_str(&format!("sha256:{}", hex::encode(hash)))
            .expect("payload hash"),
        payload,
    }
}

fn store(tree: &TempTree) -> BrokerJournalStoreV1 {
    let metadata = fs::metadata(&tree.0).expect("temp metadata");
    BrokerJournalStoreV1::open(
        tree.0.join("broker.sqlite"),
        JournalPathPolicyV1 {
            owner_uid: metadata.uid(),
            owner_gid: Some(metadata.gid()),
            busy_timeout_ms: 1_000,
        },
    )
    .expect("open journal")
}

#[test]
fn operation_insert_fault_rolls_back_the_entire_reservation() {
    let tree = TempTree::new();
    let verified = verified_request(&tree);
    let mut journal = store(&tree);
    assert!(matches!(
        journal.reserve_with_fault(
            &verified,
            12_000,
            JournalFaultPointV1::AfterOperationInsert,
        ),
        Err(JournalStoreError::InjectedFault(
            JournalFaultPointV1::AfterOperationInsert
        ))
    ));
    assert!(matches!(
        journal.load_operation("operation-1"),
        Err(JournalStoreError::OperationNotFound(_))
    ));
    assert_eq!(
        journal.verify_integrity().expect("integrity").operation_count,
        0,
    );
}

#[test]
fn transition_faults_leave_state_and_history_unchanged() {
    let tree = TempTree::new();
    let verified = verified_request(&tree);
    let mut journal = store(&tree);
    journal
        .reserve_verified_request(&verified, 12_000)
        .expect("reserve");

    assert!(matches!(
        journal.append_with_fault(
            "operation-1",
            OperationState::RequestBound,
            12_001,
            None,
            None,
            JournalFaultPointV1::AfterTransitionInsert,
        ),
        Err(JournalStoreError::InjectedFault(
            JournalFaultPointV1::AfterTransitionInsert
        ))
    ));
    let operation = journal.load_operation("operation-1").expect("operation");
    assert_eq!(operation.current_state, OperationState::Reserved);
    assert!(
        journal
            .load_journal("operation-1")
            .expect("journal")
            .transitions
            .is_empty()
    );

    assert!(matches!(
        journal.append_with_fault(
            "operation-1",
            OperationState::RequestBound,
            12_002,
            None,
            None,
            JournalFaultPointV1::AfterStateUpdate,
        ),
        Err(JournalStoreError::InjectedFault(
            JournalFaultPointV1::AfterStateUpdate
        ))
    ));
    let operation = journal.load_operation("operation-1").expect("operation");
    assert_eq!(operation.current_state, OperationState::Reserved);
    assert!(
        journal
            .load_journal("operation-1")
            .expect("journal")
            .transitions
            .is_empty()
    );
    assert_eq!(
        journal.verify_integrity().expect("integrity").transition_count,
        0,
    );
}
