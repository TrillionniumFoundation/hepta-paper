use std::os::unix::net::UnixStream;

use hepta_codex_protocol::{CodexExecutionRequestV1, Sha256Digest};
use thiserror::Error;

use crate::{
    BrokerFrameError, BrokerFrameLimitsV1, CapabilityError, CapabilityKeyringV1,
    CapabilityVerificationPolicyV1, PeerAuthorizationError, PeerCredentialsV1,
    PeerPolicyV1, authorize_peer_v1, decode_request_payload_v1,
    inspect_peer_credentials_v1, read_broker_frame_v1,
    verify_request_capability_v1,
};

/// Fully verified local broker input. No campaign or provider authority is granted.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VerifiedBrokerRequestV1 {
    pub peer: PeerCredentialsV1,
    pub request: CodexExecutionRequestV1,
    pub payload_hash: Sha256Digest,
    pub payload: Vec<u8>,
}

/// Authorizes the kernel peer before reading, then verifies frame, request, and HMAC.
pub fn read_verified_broker_request(
    stream: &mut UnixStream,
    frame_limits: BrokerFrameLimitsV1,
    peer_policy: &PeerPolicyV1,
    keyring: &CapabilityKeyringV1,
    current_time_unix_ms: u64,
    capability_policy: CapabilityVerificationPolicyV1,
) -> Result<VerifiedBrokerRequestV1, BrokerAdmissionError> {
    let peer = inspect_peer_credentials_v1(stream).map_err(BrokerAdmissionError::Peer)?;
    authorize_peer_v1(peer, peer_policy).map_err(BrokerAdmissionError::Peer)?;
    let frame = read_broker_frame_v1(stream, frame_limits).map_err(BrokerAdmissionError::Frame)?;
    let request = decode_request_payload_v1(&frame).map_err(BrokerAdmissionError::Frame)?;
    verify_request_capability_v1(
        &request,
        peer,
        keyring,
        current_time_unix_ms,
        capability_policy,
    )
    .map_err(BrokerAdmissionError::Capability)?;
    Ok(VerifiedBrokerRequestV1 {
        peer,
        request,
        payload_hash: frame.payload_hash,
        payload: frame.payload,
    })
}

#[derive(Debug, Error)]
pub enum BrokerAdmissionError {
    #[error("broker peer authorization failed: {0}")]
    Peer(PeerAuthorizationError),
    #[error("broker frame validation failed: {0}")]
    Frame(BrokerFrameError),
    #[error("broker request capability failed: {0}")]
    Capability(CapabilityError),
}

#[cfg(test)]
mod tests {
    use std::{
        os::unix::net::UnixStream,
        str::FromStr,
        thread,
    };

    use hepta_codex_protocol::{
        AgentRole, ApprovalPolicy, NetworkPolicy, RequestCapabilityV1,
        SandboxPolicy, SessionPolicy, Sha256Digest, TaskKind, Transport,
    };

    use crate::{
        CapabilityKeyV1, PeerPrincipalV1, sign_request_capability_v1,
        write_request_frame_v1,
    };

    use super::*;

    fn digest(byte: char) -> Sha256Digest {
        Sha256Digest::from_str(&format!("sha256:{}", byte.to_string().repeat(64)))
            .expect("test digest")
    }

    fn request(peer: PeerCredentialsV1) -> CodexExecutionRequestV1 {
        CodexExecutionRequestV1 {
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
                signer_key_id: "broker-key-1".into(),
                peer_pid: peer.pid,
                peer_uid: peer.uid,
                peer_gid: peer.gid,
                signature_hex: "0".repeat(64),
            },
        }
    }

    #[test]
    fn socket_admission_binds_kernel_peer_frame_and_hmac() {
        let (mut server, mut client) = UnixStream::pair().expect("socket pair");
        let peer = inspect_peer_credentials_v1(&server).expect("peer credentials");
        let peer_policy = PeerPolicyV1::new([PeerPrincipalV1 {
            uid: peer.uid,
            gid: peer.gid,
        }])
        .expect("peer policy");
        let key = CapabilityKeyV1::new("broker-key-1", vec![3_u8; 32])
            .expect("capability key");
        let mut request = request(peer);
        request.request_capability.signature_hex =
            sign_request_capability_v1(&request, &key).expect("signature");
        let keyring = CapabilityKeyringV1::new([key]).expect("keyring");
        let writer = thread::spawn(move || {
            write_request_frame_v1(
                &mut client,
                &request,
                BrokerFrameLimitsV1::default(),
            )
            .expect("write request")
        });
        let verified = read_verified_broker_request(
            &mut server,
            BrokerFrameLimitsV1::default(),
            &peer_policy,
            &keyring,
            12_000,
            CapabilityVerificationPolicyV1 {
                maximum_lifetime_ms: 10_000,
                maximum_future_skew_ms: 100,
            },
        )
        .expect("verified request");
        let written_hash = writer.join().expect("writer thread");
        assert_eq!(verified.payload_hash, written_hash);
        assert_eq!(verified.peer, peer);
        assert_eq!(verified.request.operation_id, "operation-1");
    }
}
