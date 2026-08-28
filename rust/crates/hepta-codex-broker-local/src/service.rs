use std::{
    io::Write,
    os::unix::net::UnixStream,
    time::Duration,
};

use hepta_codex_broker_journal::{
    BrokerJournalV1, BrokerOperationSnapshotV1, JournalStoreError, OperationReservationV1,
    ReservationDisposition,
};
use hepta_codex_broker_protocol::{
    BrokerAdmissionDisposition, BrokerAdmissionRequestV1, BrokerAdmissionResponseV1,
    BrokerErrorCodeV1, BrokerErrorResponseV1, BrokerFrameKind, CapabilityMacKeyV1,
    CapabilityPolicyV1, FrameLimitsV1, FrameProtocolError, PeerAuthorizationError,
    PeerPolicyV1, RequestCapabilityError, WireContractError, authorize_peer,
    decode_json_payload, encode_json_frame, read_frame, verify_request_capability_v1,
};
use hepta_codex_journal::OperationState;
use thiserror::Error;

const HARD_MAXIMUM_SOCKET_TIMEOUT_MS: u64 = 30_000;

/// Bounded socket and framing policy for one-request-per-connection admission.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct BrokerAdmissionServicePolicyV1 {
    pub version: u16,
    pub frame_limits: FrameLimitsV1,
    pub read_timeout_ms: u64,
    pub write_timeout_ms: u64,
}

impl Default for BrokerAdmissionServicePolicyV1 {
    fn default() -> Self {
        Self {
            version: 1,
            frame_limits: FrameLimitsV1::default(),
            read_timeout_ms: 5_000,
            write_timeout_ms: 5_000,
        }
    }
}

impl BrokerAdmissionServicePolicyV1 {
    fn validate(self) -> Result<Self, BrokerAdmissionError> {
        if self.version != 1
            || self.read_timeout_ms == 0
            || self.write_timeout_ms == 0
            || self.read_timeout_ms > HARD_MAXIMUM_SOCKET_TIMEOUT_MS
            || self.write_timeout_ms > HARD_MAXIMUM_SOCKET_TIMEOUT_MS
        {
            return Err(BrokerAdmissionError::InvalidServicePolicy);
        }
        Ok(self)
    }
}

/// Admission-only broker service. Provider execution is deliberately absent.
pub struct BrokerAdmissionServiceV1 {
    journal: BrokerJournalV1,
    peer_policy: PeerPolicyV1,
    capability_policy: CapabilityPolicyV1,
    capability_key: CapabilityMacKeyV1,
    service_policy: BrokerAdmissionServicePolicyV1,
}

impl BrokerAdmissionServiceV1 {
    pub fn new(
        journal: BrokerJournalV1,
        peer_policy: PeerPolicyV1,
        capability_policy: CapabilityPolicyV1,
        capability_key: CapabilityMacKeyV1,
        service_policy: BrokerAdmissionServicePolicyV1,
    ) -> Result<Self, BrokerAdmissionError> {
        peer_policy
            .validate()
            .map_err(BrokerAdmissionError::Peer)?;
        capability_policy
            .validate()
            .map_err(BrokerAdmissionError::Capability)?;
        let service_policy = service_policy.validate()?;
        journal.audit().map_err(BrokerAdmissionError::Journal)?;
        Ok(Self {
            journal,
            peer_policy,
            capability_policy,
            capability_key,
            service_policy,
        })
    }

    /// Authenticates, reserves, replies, and returns the same response written to the peer.
    pub fn handle_connection(
        &mut self,
        stream: &mut UnixStream,
        now_unix_ms: u64,
    ) -> Result<BrokerAdmissionResponseV1, BrokerAdmissionError> {
        self.configure_socket(stream)?;
        match self.admit(stream, now_unix_ms) {
            Ok(response) => {
                let encoded = encode_json_frame(
                    BrokerFrameKind::Response,
                    &response,
                    self.service_policy.frame_limits,
                )
                .map_err(BrokerAdmissionError::Frame)?;
                stream
                    .write_all(&encoded)
                    .map_err(|error| BrokerAdmissionError::SocketWrite(error.kind()))?;
                stream
                    .flush()
                    .map_err(|error| BrokerAdmissionError::SocketWrite(error.kind()))?;
                Ok(response)
            }
            Err(error) => {
                let public_error = error.public_response();
                if let Ok(encoded) = encode_json_frame(
                    BrokerFrameKind::Error,
                    &public_error,
                    self.service_policy.frame_limits,
                ) {
                    let _ = stream.write_all(&encoded);
                    let _ = stream.flush();
                }
                Err(error)
            }
        }
    }

    #[must_use]
    pub fn journal(&self) -> &BrokerJournalV1 {
        &self.journal
    }

    pub fn journal_mut(&mut self) -> &mut BrokerJournalV1 {
        &mut self.journal
    }

    fn configure_socket(&self, stream: &UnixStream) -> Result<(), BrokerAdmissionError> {
        stream
            .set_read_timeout(Some(Duration::from_millis(
                self.service_policy.read_timeout_ms,
            )))
            .map_err(|error| BrokerAdmissionError::SocketConfiguration(error.kind()))?;
        stream
            .set_write_timeout(Some(Duration::from_millis(
                self.service_policy.write_timeout_ms,
            )))
            .map_err(|error| BrokerAdmissionError::SocketConfiguration(error.kind()))
    }

    fn admit(
        &mut self,
        stream: &mut UnixStream,
        now_unix_ms: u64,
    ) -> Result<BrokerAdmissionResponseV1, BrokerAdmissionError> {
        let peer = authorize_peer(stream, &self.peer_policy).map_err(BrokerAdmissionError::Peer)?;
        let frame = read_frame(stream, self.service_policy.frame_limits)
            .map_err(BrokerAdmissionError::Frame)?;
        let envelope: BrokerAdmissionRequestV1 =
            decode_json_payload(&frame, BrokerFrameKind::Request)
                .map_err(BrokerAdmissionError::Frame)?;
        envelope.validate().map_err(BrokerAdmissionError::Wire)?;
        if now_unix_ms == 0 || envelope.request.absolute_deadline_unix_ms < now_unix_ms {
            return Err(BrokerAdmissionError::RequestDeadlineExpired);
        }
        let capability = verify_request_capability_v1(
            &envelope.request,
            peer.credentials,
            &self.capability_policy,
            &self.capability_key,
            now_unix_ms,
        )
        .map_err(BrokerAdmissionError::Capability)?;
        let snapshot = self
            .journal
            .reserve_operation(&OperationReservationV1 {
                operation_id: envelope.request.operation_id.clone(),
                request_hash: capability.request_subject_hash.clone(),
                idempotency_key: envelope.request.idempotency_key.clone(),
                capability_nonce: capability.nonce,
                peer_process_id: peer.credentials.process_id,
                peer_user_id: peer.credentials.user_id,
                peer_group_id: peer.credentials.group_id,
                created_at_unix_ms: now_unix_ms,
            })
            .map_err(BrokerAdmissionError::Journal)?;
        validate_snapshot_binding(&snapshot, &envelope, peer.credentials)?;
        let response = BrokerAdmissionResponseV1 {
            version: 1,
            disposition: match snapshot.disposition {
                ReservationDisposition::Created => BrokerAdmissionDisposition::Created,
                ReservationDisposition::Existing => BrokerAdmissionDisposition::Existing,
            },
            operation_id: envelope.request.operation_id,
            request_subject_hash: capability.request_subject_hash,
            current_state: "reserved".to_owned(),
            journal_revision: snapshot.revision,
            peer: peer.credentials,
            peer_policy_hash: peer.policy_hash,
            capability_policy_hash: capability.capability_policy_hash,
        };
        response.validate().map_err(BrokerAdmissionError::Wire)?;
        Ok(response)
    }
}

fn validate_snapshot_binding(
    snapshot: &BrokerOperationSnapshotV1,
    envelope: &BrokerAdmissionRequestV1,
    peer: hepta_codex_broker_protocol::PeerCredentialsV1,
) -> Result<(), BrokerAdmissionError> {
    if snapshot.journal.operation_id != envelope.request.operation_id
        || snapshot.journal.current_state != OperationState::Reserved
        || snapshot.revision != 0
        || snapshot.idempotency_key != envelope.request.idempotency_key
        || snapshot.capability_nonce != envelope.request.request_capability.nonce
        || snapshot.peer_process_id != peer.process_id
        || snapshot.peer_user_id != peer.user_id
        || snapshot.peer_group_id != peer.group_id
        || snapshot.provider_action_may_have_started
        || snapshot.prepared_receipt_hash.is_some()
    {
        return Err(BrokerAdmissionError::JournalBindingMismatch);
    }
    Ok(())
}

/// Socket, peer, capability, wire or journal admission failure.
#[derive(Debug, Error)]
pub enum BrokerAdmissionError {
    #[error("broker admission service policy is invalid")]
    InvalidServicePolicy,
    #[error("socket configuration failed: {0:?}")]
    SocketConfiguration(std::io::ErrorKind),
    #[error("socket write failed: {0:?}")]
    SocketWrite(std::io::ErrorKind),
    #[error("frame was rejected: {0}")]
    Frame(FrameProtocolError),
    #[error("peer was rejected: {0}")]
    Peer(PeerAuthorizationError),
    #[error("wire object was rejected: {0}")]
    Wire(WireContractError),
    #[error("request capability was rejected: {0}")]
    Capability(RequestCapabilityError),
    #[error("request deadline has expired")]
    RequestDeadlineExpired,
    #[error("journal operation failed: {0}")]
    Journal(JournalStoreError),
    #[error("journal result does not match the authenticated request")]
    JournalBindingMismatch,
}

impl BrokerAdmissionError {
    fn public_response(&self) -> BrokerErrorResponseV1 {
        let (code, retryable) = match self {
            Self::Frame(_) | Self::SocketConfiguration(_) | Self::SocketWrite(_) => {
                (BrokerErrorCodeV1::InvalidFrame, false)
            }
            Self::Wire(_) | Self::RequestDeadlineExpired => {
                (BrokerErrorCodeV1::InvalidRequest, false)
            }
            Self::Peer(_) => (BrokerErrorCodeV1::PeerUnauthorized, false),
            Self::Capability(_) => (BrokerErrorCodeV1::CapabilityRejected, false),
            Self::Journal(error) if is_replay_or_conflict(error) => {
                (BrokerErrorCodeV1::ReplayOrConflict, false)
            }
            Self::Journal(_) => (BrokerErrorCodeV1::JournalUnavailable, true),
            Self::InvalidServicePolicy | Self::JournalBindingMismatch => {
                (BrokerErrorCodeV1::InternalFailure, false)
            }
        };
        BrokerErrorResponseV1 {
            version: 1,
            code,
            operation_id: None,
            retryable,
        }
    }
}

fn is_replay_or_conflict(error: &JournalStoreError) -> bool {
    matches!(
        error,
        JournalStoreError::OperationIdentityConflict
            | JournalStoreError::RequestHashConflict
            | JournalStoreError::IdempotencyConflict
            | JournalStoreError::CapabilityNonceReplay
            | JournalStoreError::UniqueConstraint(_)
    )
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        io::Write,
        os::unix::{fs::{MetadataExt, PermissionsExt}, net::UnixStream},
        path::PathBuf,
        str::FromStr,
        sync::atomic::{AtomicU64, Ordering},
        time::{SystemTime, UNIX_EPOCH},
    };

    use hepta_codex_broker_journal::BrokerJournalPolicyV1;
    use hepta_codex_broker_protocol::{
        CapabilityPolicyV1, PeerPolicyV1, compute_request_capability_signature_v1,
        encode_json_frame, observe_peer_credentials,
    };
    use hepta_codex_protocol::{
        AgentRole, ApprovalPolicy, CodexExecutionRequestV1, NetworkPolicy,
        RequestCapabilityV1, SandboxPolicy, SessionPolicy, Sha256Digest, TaskKind,
        Transport,
    };

    use super::*;

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
                "hepta-broker-local-{}-{nonce}-{sequence}",
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

    fn unsigned_request() -> CodexExecutionRequestV1 {
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

    fn service_for_peer(
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
        let peer_policy = PeerPolicyV1::new(
            "author-peer-v1",
            [peer.user_id],
            [peer.group_id],
            false,
        )
        .expect("peer policy");
        let capability_policy = CapabilityPolicyV1::strict(
            "author-capability-v1",
            "author-broker-1",
            "issuer-key-1",
        )
        .expect("capability policy");
        BrokerAdmissionServiceV1::new(
            journal,
            peer_policy,
            capability_policy,
            CapabilityMacKeyV1::from_bytes([9_u8; 32]),
            BrokerAdmissionServicePolicyV1::default(),
        )
        .expect("service")
    }

    fn signed_request(
        peer: hepta_codex_broker_protocol::PeerCredentialsV1,
    ) -> BrokerAdmissionRequestV1 {
        let policy = CapabilityPolicyV1::strict(
            "author-capability-v1",
            "author-broker-1",
            "issuer-key-1",
        )
        .expect("capability policy");
        let key = CapabilityMacKeyV1::from_bytes([9_u8; 32]);
        let mut request = unsigned_request();
        request.request_capability.signature_base64 =
            compute_request_capability_signature_v1(&request, peer, &policy, &key, 10_000)
                .expect("signature");
        BrokerAdmissionRequestV1 {
            version: 1,
            request,
        }
    }

    #[test]
    fn authenticated_request_is_reserved_once_and_duplicate_is_existing() {
        let directory = TempDirectory::new();
        let (mut client, mut server) = UnixStream::pair().expect("socket pair");
        let peer = observe_peer_credentials(&server).expect("peer");
        let mut service = service_for_peer(&directory, peer);
        let envelope = signed_request(peer);
        let encoded = encode_json_frame(
            BrokerFrameKind::Request,
            &envelope,
            FrameLimitsV1::default(),
        )
        .expect("request frame");
        client.write_all(&encoded).expect("write request");
        let first = service
            .handle_connection(&mut server, 10_000)
            .expect("first admission");
        assert_eq!(first.disposition, BrokerAdmissionDisposition::Created);

        let (mut second_client, mut second_server) = UnixStream::pair().expect("socket pair");
        second_client.write_all(&encoded).expect("write duplicate");
        let second = service
            .handle_connection(&mut second_server, 10_000)
            .expect("duplicate admission");
        assert_eq!(second.disposition, BrokerAdmissionDisposition::Existing);
        assert_eq!(service.journal().audit().expect("audit").operation_count, 1);
    }

    #[test]
    fn tampered_request_is_rejected_before_journal_reservation() {
        let directory = TempDirectory::new();
        let (mut client, mut server) = UnixStream::pair().expect("socket pair");
        let peer = observe_peer_credentials(&server).expect("peer");
        let mut service = service_for_peer(&directory, peer);
        let mut envelope = signed_request(peer);
        envelope.request.model_selector = "tampered-model".into();
        let encoded = encode_json_frame(
            BrokerFrameKind::Request,
            &envelope,
            FrameLimitsV1::default(),
        )
        .expect("request frame");
        client.write_all(&encoded).expect("write request");
        assert!(matches!(
            service.handle_connection(&mut server, 10_000),
            Err(BrokerAdmissionError::Capability(
                hepta_codex_broker_protocol::RequestCapabilityError::SignatureMismatch
            )),
        ));
        assert_eq!(service.journal().audit().expect("audit").operation_count, 0);
    }
}
