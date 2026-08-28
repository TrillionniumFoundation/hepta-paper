use std::{
    fs,
    io::Write,
    os::unix::{fs::{MetadataExt, PermissionsExt}, net::UnixStream},
    path::PathBuf,
    str::FromStr,
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

use hepta_codex_broker_journal::{BrokerJournalPolicyV1, BrokerJournalV1};
use hepta_codex_broker_local::{
    BrokerAdmissionError, BrokerAdmissionServicePolicyV1, BrokerAdmissionServiceV1,
};
use hepta_codex_broker_protocol::{
    BrokerAdmissionDisposition, BrokerAdmissionRequestV1, BrokerAdmissionResponseV1,
    BrokerErrorCodeV1, BrokerErrorResponseV1, BrokerFrameKind, CapabilityMacKeyV1,
    CapabilityPolicyV1, FrameLimitsV1, PeerPolicyV1,
    compute_request_capability_signature_v1, decode_json_payload, encode_json_frame,
    observe_peer_credentials, read_frame,
};
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
            "hepta-broker-admission-it-{}-{nonce}-{sequence}",
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

fn unsigned_request(operation_id: &str, nonce: &str) -> CodexExecutionRequestV1 {
    CodexExecutionRequestV1 {
        version: 1,
        operation_id: operation_id.to_owned(),
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
            nonce: nonce.to_owned(),
            expires_at_unix_ms: 12_000,
            signer_key_id: "issuer-key-1".into(),
            signature_base64: "AA==".into(),
        },
    }
}

fn policies(
    peer: hepta_codex_broker_protocol::PeerCredentialsV1,
) -> (PeerPolicyV1, CapabilityPolicyV1) {
    (
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
    )
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
    let (peer_policy, capability_policy) = policies(peer);
    BrokerAdmissionServiceV1::new(
        journal,
        peer_policy,
        capability_policy,
        CapabilityMacKeyV1::from_bytes([9_u8; 32]),
        BrokerAdmissionServicePolicyV1::default(),
    )
    .expect("service")
}

fn signed_envelope(
    peer: hepta_codex_broker_protocol::PeerCredentialsV1,
    operation_id: &str,
    nonce: &str,
) -> BrokerAdmissionRequestV1 {
    let (_, capability_policy) = policies(peer);
    let key = CapabilityMacKeyV1::from_bytes([9_u8; 32]);
    let mut request = unsigned_request(operation_id, nonce);
    request.request_capability.signature_base64 = compute_request_capability_signature_v1(
        &request,
        peer,
        &capability_policy,
        &key,
        10_000,
    )
    .expect("signature");
    BrokerAdmissionRequestV1 {
        version: 1,
        request,
    }
}

#[test]
fn response_frame_is_hash_verified_and_machine_readable() {
    let directory = TempDirectory::new();
    let (mut client, mut server) = UnixStream::pair().expect("socket pair");
    let peer = observe_peer_credentials(&server).expect("peer");
    let mut service = service(&directory, peer);
    let request = signed_envelope(peer, "operation-1", "nonce-1");
    client
        .write_all(
            &encode_json_frame(
                BrokerFrameKind::Request,
                &request,
                FrameLimitsV1::default(),
            )
            .expect("frame"),
        )
        .expect("write request");
    service
        .handle_connection(&mut server, 10_000)
        .expect("admit request");
    let frame = read_frame(&mut client, FrameLimitsV1::default()).expect("response frame");
    let response: BrokerAdmissionResponseV1 =
        decode_json_payload(&frame, BrokerFrameKind::Response).expect("response");
    assert_eq!(response.disposition, BrokerAdmissionDisposition::Created);
    assert_eq!(response.operation_id, "operation-1");
    assert_eq!(response.current_state, "reserved");
}

#[test]
fn capability_failure_returns_only_a_sanitized_error_code() {
    let directory = TempDirectory::new();
    let (mut client, mut server) = UnixStream::pair().expect("socket pair");
    let peer = observe_peer_credentials(&server).expect("peer");
    let mut service = service(&directory, peer);
    let mut request = signed_envelope(peer, "operation-1", "nonce-1");
    request.request.input_manifest_hash = digest('9');
    client
        .write_all(
            &encode_json_frame(
                BrokerFrameKind::Request,
                &request,
                FrameLimitsV1::default(),
            )
            .expect("frame"),
        )
        .expect("write request");
    assert!(matches!(
        service.handle_connection(&mut server, 10_000),
        Err(BrokerAdmissionError::Capability(_)),
    ));
    let frame = read_frame(&mut client, FrameLimitsV1::default()).expect("error frame");
    let response: BrokerErrorResponseV1 =
        decode_json_payload(&frame, BrokerFrameKind::Error).expect("error response");
    assert_eq!(response.code, BrokerErrorCodeV1::CapabilityRejected);
    assert_eq!(response.operation_id, None);
    assert!(!response.retryable);
    assert_eq!(service.journal().audit().expect("audit").operation_count, 0);
}
