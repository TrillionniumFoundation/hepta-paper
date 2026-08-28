use std::{
    fs,
    io::Write,
    os::unix::{fs::{MetadataExt, PermissionsExt}, net::UnixStream},
    path::PathBuf,
    str::FromStr,
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

use hepta_codex_broker_journal::{
    BrokerJournalPolicyV1, BrokerJournalV1, TransitionCommandV1,
};
use hepta_codex_broker_local::{
    BrokerAdmissionServicePolicyV1, BrokerAdmissionServiceV1,
};
use hepta_codex_broker_protocol::{
    BrokerAdmissionDisposition, BrokerAdmissionRequestV1, BrokerFrameKind,
    CapabilityMacKeyV1, CapabilityPolicyV1, FrameLimitsV1, PeerPolicyV1,
    compute_request_capability_signature_v1, encode_json_frame, observe_peer_credentials,
};
use hepta_codex_journal::OperationState;
use hepta_codex_protocol::{
    AgentRole, ApprovalPolicy, CodexExecutionRequestV1, NetworkPolicy, RequestCapabilityV1,
    SandboxPolicy, SessionPolicy, Sha256Digest, TaskKind, Transport,
};

static NEXT_TEMP_ID: AtomicU64 = AtomicU64::new(0);

struct TempDirectory(PathBuf);

impl TempDirectory {
    fn new() -> Self {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock after epoch")
            .as_nanos();
        let sequence = NEXT_TEMP_ID.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "hepta-broker-progressed-{}-{nonce}-{sequence}",
            std::process::id(),
        ));
        fs::create_dir(&path).expect("create temp directory");
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700))
            .expect("private temp directory");
        Self(path)
    }
}

impl Drop for TempDirectory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn digest(byte: char) -> Sha256Digest {
    Sha256Digest::from_str(&format!("sha256:{}", byte.to_string().repeat(64)))
        .expect("test digest")
}

fn request() -> CodexExecutionRequestV1 {
    CodexExecutionRequestV1 {
        version: 1,
        operation_id: "operation-1".into(),
        idempotency_key: digest('1'),
        campaign_id: "campaign-1".into(),
        node_id: "node-1".into(),
        attempt_id: "attempt-1".into(),
        lease_generation: 1,
        campaign_revision: 1,
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
        maximum_cost_microusd: 1000,
        remaining_token_hint: Some(100),
        request_capability: RequestCapabilityV1 {
            nonce: "nonce-1".into(),
            expires_at_unix_ms: 12_000,
            signer_key_id: "issuer-key-1".into(),
            signature_base64: "AA==".into(),
        },
    }
}

fn write_request(
    client: &mut UnixStream,
    peer: hepta_codex_broker_protocol::PeerCredentialsV1,
) {
    let capability_policy = CapabilityPolicyV1::strict(
        "author-capability-v1",
        "author-broker-1",
        "issuer-key-1",
    )
    .expect("capability policy");
    let key = CapabilityMacKeyV1::from_bytes([9_u8; 32]);
    let mut request = request();
    request.request_capability.signature_base64 = compute_request_capability_signature_v1(
        &request,
        peer,
        &capability_policy,
        &key,
        10_000,
    )
    .expect("signature");
    let frame = encode_json_frame(
        BrokerFrameKind::Request,
        &BrokerAdmissionRequestV1 {
            version: 1,
            request,
        },
        FrameLimitsV1::default(),
    )
    .expect("frame");
    client.write_all(&frame).expect("write request");
}

fn service(
    directory: &TempDirectory,
    peer: hepta_codex_broker_protocol::PeerCredentialsV1,
) -> BrokerAdmissionServiceV1 {
    let owner = fs::metadata(&directory.0)
        .expect("directory metadata")
        .uid();
    let journal = BrokerJournalV1::open(
        &directory.0.join("broker.sqlite"),
        BrokerJournalPolicyV1::strict(owner),
    )
    .expect("journal");
    BrokerAdmissionServiceV1::new(
        journal,
        PeerPolicyV1::new(
            "author-peer-v1",
            [peer.user_id],
            [peer.group_id],
            false,
        )
        .expect("peer policy"),
        CapabilityPolicyV1::strict(
            "author-capability-v1",
            "author-broker-1",
            "issuer-key-1",
        )
        .expect("capability policy"),
        CapabilityMacKeyV1::from_bytes([9_u8; 32]),
        BrokerAdmissionServicePolicyV1::default(),
    )
    .expect("service")
}

#[test]
fn later_exact_duplicate_returns_existing_persisted_state_without_new_transition() {
    let directory = TempDirectory::new();
    let (mut client, mut server) = UnixStream::pair().expect("socket pair");
    let peer = observe_peer_credentials(&server).expect("peer credentials");
    let mut service = service(&directory, peer);
    write_request(&mut client, peer);
    let created = service
        .handle_connection(&mut server, 10_000)
        .expect("created admission");
    assert_eq!(created.disposition, BrokerAdmissionDisposition::Created);

    service
        .journal_mut()
        .append_transition(&TransitionCommandV1 {
            operation_id: "operation-1".into(),
            expected_state: OperationState::Reserved,
            to_state: OperationState::RequestBound,
            recorded_at_unix_ms: 10_100,
            evidence_hash: None,
            reason_code: None,
        })
        .expect("request-bound transition");

    let (mut retry_client, mut retry_server) = UnixStream::pair().expect("retry socket pair");
    write_request(&mut retry_client, peer);
    let existing = service
        .handle_connection(&mut retry_server, 11_000)
        .expect("existing admission");
    assert_eq!(existing.disposition, BrokerAdmissionDisposition::Existing);
    assert_eq!(existing.current_state, "request_bound");
    assert_eq!(existing.journal_revision, 1);

    let snapshot = service
        .journal()
        .load_operation("operation-1")
        .expect("load operation");
    assert_eq!(snapshot.revision, 1);
    assert_eq!(snapshot.journal.transitions.len(), 1);
}

#[test]
fn request_at_exact_deadline_is_rejected_before_reservation() {
    let directory = TempDirectory::new();
    let (mut client, mut server) = UnixStream::pair().expect("socket pair");
    let peer = observe_peer_credentials(&server).expect("peer credentials");
    let mut service = service(&directory, peer);
    write_request(&mut client, peer);
    assert!(service.handle_connection(&mut server, 20_000).is_err());
    assert_eq!(service.journal().audit().expect("audit").operation_count, 0);
}
