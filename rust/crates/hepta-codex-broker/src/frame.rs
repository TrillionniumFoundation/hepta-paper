use std::{
    io::{self, Read, Write},
    str::FromStr,
};

use hepta_codex_protocol::{CodexExecutionRequestV1, Sha256Digest};
use sha2::{Digest, Sha256};
use thiserror::Error;

const FRAME_MAGIC: [u8; 8] = *b"HEPTACX1";
const FRAME_HEADER_BYTES: usize = 16;
const HARD_MAXIMUM_PAYLOAD_BYTES: usize = 1024 * 1024;

/// Size policy applied before a request is allocated or parsed.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct BrokerFramePolicyV1 {
    pub maximum_payload_bytes: usize,
}

impl Default for BrokerFramePolicyV1 {
    fn default() -> Self {
        Self {
            maximum_payload_bytes: HARD_MAXIMUM_PAYLOAD_BYTES,
        }
    }
}

impl BrokerFramePolicyV1 {
    fn validate(self) -> Result<Self, BrokerFrameError> {
        if self.maximum_payload_bytes == 0
            || self.maximum_payload_bytes > HARD_MAXIMUM_PAYLOAD_BYTES
        {
            return Err(BrokerFrameError::InvalidPolicy);
        }
        Ok(self)
    }
}

/// A validated request plus the exact bytes retained for journaling.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DecodedRequestFrameV1 {
    pub request: CodexExecutionRequestV1,
    pub payload: Vec<u8>,
    pub payload_hash: Sha256Digest,
}

/// Reads one complete request frame and rejects truncation, excess size, and invalid contracts.
pub fn read_request_frame<R: Read>(
    reader: &mut R,
    policy: BrokerFramePolicyV1,
) -> Result<DecodedRequestFrameV1, BrokerFrameError> {
    let policy = policy.validate()?;
    let mut header = [0_u8; FRAME_HEADER_BYTES];
    reader
        .read_exact(&mut header)
        .map_err(|error| BrokerFrameError::Read(error.kind()))?;
    if header[..8] != FRAME_MAGIC {
        return Err(BrokerFrameError::InvalidMagic);
    }
    let payload_length = u64::from_be_bytes(
        header[8..]
            .try_into()
            .map_err(|_| BrokerFrameError::InvalidLengthEncoding)?,
    );
    let payload_length = usize::try_from(payload_length)
        .map_err(|_| BrokerFrameError::PayloadTooLarge {
            observed: usize::MAX,
            maximum: policy.maximum_payload_bytes,
        })?;
    if payload_length == 0 {
        return Err(BrokerFrameError::EmptyPayload);
    }
    if payload_length > policy.maximum_payload_bytes {
        return Err(BrokerFrameError::PayloadTooLarge {
            observed: payload_length,
            maximum: policy.maximum_payload_bytes,
        });
    }
    let mut payload = vec![0_u8; payload_length];
    reader
        .read_exact(&mut payload)
        .map_err(|error| BrokerFrameError::Read(error.kind()))?;
    let request: CodexExecutionRequestV1 = serde_json::from_slice(&payload)
        .map_err(|error| BrokerFrameError::InvalidJson(error.to_string()))?;
    request
        .validate()
        .map_err(|error| BrokerFrameError::InvalidRequest(error.to_string()))?;
    let canonical_payload = serde_json::to_vec(&request)
        .map_err(|error| BrokerFrameError::InvalidJson(error.to_string()))?;
    if canonical_payload != payload {
        return Err(BrokerFrameError::NonCanonicalJson);
    }
    let payload_hash = sha256_digest(&payload)?;
    Ok(DecodedRequestFrameV1 {
        request,
        payload,
        payload_hash,
    })
}

/// Writes exactly one length-prefixed request frame.
pub fn write_request_frame<W: Write>(
    writer: &mut W,
    request: &CodexExecutionRequestV1,
    policy: BrokerFramePolicyV1,
) -> Result<Sha256Digest, BrokerFrameError> {
    let policy = policy.validate()?;
    request
        .validate()
        .map_err(|error| BrokerFrameError::InvalidRequest(error.to_string()))?;
    let payload = serde_json::to_vec(request)
        .map_err(|error| BrokerFrameError::InvalidJson(error.to_string()))?;
    if payload.is_empty() {
        return Err(BrokerFrameError::EmptyPayload);
    }
    if payload.len() > policy.maximum_payload_bytes {
        return Err(BrokerFrameError::PayloadTooLarge {
            observed: payload.len(),
            maximum: policy.maximum_payload_bytes,
        });
    }
    let length = u64::try_from(payload.len()).map_err(|_| BrokerFrameError::InvalidLengthEncoding)?;
    writer
        .write_all(&FRAME_MAGIC)
        .and_then(|()| writer.write_all(&length.to_be_bytes()))
        .and_then(|()| writer.write_all(&payload))
        .and_then(|()| writer.flush())
        .map_err(|error| BrokerFrameError::Write(error.kind()))?;
    sha256_digest(&payload)
}

fn sha256_digest(bytes: &[u8]) -> Result<Sha256Digest, BrokerFrameError> {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let value = format!("sha256:{}", hex::encode(hasher.finalize()));
    Sha256Digest::from_str(&value).map_err(|_| BrokerFrameError::DigestConstruction)
}

/// Invalid framing, allocation, JSON, request, or stream I/O.
#[derive(Clone, Debug, Error, Eq, PartialEq)]
pub enum BrokerFrameError {
    #[error("broker frame policy is invalid")]
    InvalidPolicy,
    #[error("broker frame magic is invalid")]
    InvalidMagic,
    #[error("broker frame payload is empty")]
    EmptyPayload,
    #[error("broker frame payload is too large: observed {observed}, maximum {maximum}")]
    PayloadTooLarge { observed: usize, maximum: usize },
    #[error("broker frame length encoding is invalid")]
    InvalidLengthEncoding,
    #[error("broker frame JSON is invalid: {0}")]
    InvalidJson(String),
    #[error("broker frame JSON is not the canonical request encoding")]
    NonCanonicalJson,
    #[error("broker request is invalid: {0}")]
    InvalidRequest(String),
    #[error("broker frame read failed: {0:?}")]
    Read(io::ErrorKind),
    #[error("broker frame write failed: {0:?}")]
    Write(io::ErrorKind),
    #[error("failed to construct frame digest")]
    DigestConstruction,
}

#[cfg(test)]
mod tests {
    use std::{io::Cursor, str::FromStr};

    use hepta_codex_protocol::{
        AgentRole, ApprovalPolicy, NetworkPolicy, RequestCapabilityV1, SandboxPolicy,
        SessionPolicy, TaskKind, Transport,
    };

    use super::*;

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
                signer_key_id: "key-1".into(),
                peer_uid: 1000,
                peer_gid: 1000,
                signature_base64: "A".repeat(86),
            },
        }
    }

    #[test]
    fn frame_round_trip_retains_exact_payload_hash() {
        let mut encoded = Vec::new();
        let written_hash = write_request_frame(
            &mut encoded,
            &request(),
            BrokerFramePolicyV1::default(),
        )
        .expect("write frame");
        let decoded = read_request_frame(
            &mut Cursor::new(encoded),
            BrokerFramePolicyV1::default(),
        )
        .expect("read frame");
        assert_eq!(decoded.request, request());
        assert_eq!(decoded.payload_hash, written_hash);
    }

    #[test]
    fn rejects_semantically_valid_but_noncanonical_json() {
        let canonical = serde_json::to_vec(&request()).expect("canonical request JSON");
        let mut noncanonical = Vec::with_capacity(canonical.len() + 1);
        noncanonical.push(b' ');
        noncanonical.extend_from_slice(&canonical);
        let mut frame = Vec::from(FRAME_MAGIC);
        frame.extend_from_slice(
            &u64::try_from(noncanonical.len())
                .expect("small fixture")
                .to_be_bytes(),
        );
        frame.extend_from_slice(&noncanonical);
        assert_eq!(
            read_request_frame(
                &mut Cursor::new(frame),
                BrokerFramePolicyV1::default(),
            ),
            Err(BrokerFrameError::NonCanonicalJson),
        );
    }

    #[test]
    fn rejects_oversized_length_before_allocation() {
        let mut bytes = Vec::from(FRAME_MAGIC);
        bytes.extend_from_slice(&(2_u64 * 1024 * 1024).to_be_bytes());
        assert!(matches!(
            read_request_frame(
                &mut Cursor::new(bytes),
                BrokerFramePolicyV1::default(),
            ),
            Err(BrokerFrameError::PayloadTooLarge { .. }),
        ));
    }

    #[test]
    fn rejects_truncated_payload() {
        let mut bytes = Vec::from(FRAME_MAGIC);
        bytes.extend_from_slice(&10_u64.to_be_bytes());
        bytes.extend_from_slice(b"short");
        assert!(matches!(
            read_request_frame(
                &mut Cursor::new(bytes),
                BrokerFramePolicyV1::default(),
            ),
            Err(BrokerFrameError::Read(_)),
        ));
    }
}
