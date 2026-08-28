use std::str::FromStr;

use hepta_codex_protocol::{
    AgentRole, ApprovalPolicy, CodexExecutionRequestV1, NetworkPolicy, SandboxPolicy,
    SessionPolicy, Sha256Digest, TaskKind, Transport,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;

use crate::PeerCredentialsV1;

const HMAC_BLOCK_BYTES: usize = 64;
const HMAC_OUTPUT_BYTES: usize = 32;
const HARD_MAXIMUM_FUTURE_VALIDITY_MS: u64 = 15 * 60 * 1000;
const HARD_MAXIMUM_CLOCK_SKEW_MS: u64 = 60 * 1000;

/// Local capability verification policy bound to a single broker instance.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CapabilityPolicyV1 {
    pub version: u16,
    pub policy_id: String,
    pub broker_instance_id: String,
    pub expected_signer_key_id: String,
    pub maximum_future_validity_ms: u64,
    pub maximum_clock_skew_ms: u64,
}

impl CapabilityPolicyV1 {
    /// Strict default for short-lived, per-operation local capabilities.
    pub fn strict(
        policy_id: impl Into<String>,
        broker_instance_id: impl Into<String>,
        expected_signer_key_id: impl Into<String>,
    ) -> Result<Self, RequestCapabilityError> {
        let policy = Self {
            version: 1,
            policy_id: policy_id.into(),
            broker_instance_id: broker_instance_id.into(),
            expected_signer_key_id: expected_signer_key_id.into(),
            maximum_future_validity_ms: 5 * 60 * 1000,
            maximum_clock_skew_ms: 5 * 1000,
        };
        policy.validate()?;
        Ok(policy)
    }

    /// Validates policy identifiers and non-raisable time bounds.
    pub fn validate(&self) -> Result<(), RequestCapabilityError> {
        if self.version != 1 {
            return Err(RequestCapabilityError::UnsupportedPolicyVersion(
                self.version,
            ));
        }
        for (field, value) in [
            ("policyId", self.policy_id.as_str()),
            ("brokerInstanceId", self.broker_instance_id.as_str()),
            (
                "expectedSignerKeyId",
                self.expected_signer_key_id.as_str(),
            ),
        ] {
            if !valid_identifier(value) {
                return Err(RequestCapabilityError::InvalidPolicyIdentifier(field));
            }
        }
        if self.maximum_future_validity_ms == 0
            || self.maximum_future_validity_ms > HARD_MAXIMUM_FUTURE_VALIDITY_MS
            || self.maximum_clock_skew_ms > HARD_MAXIMUM_CLOCK_SKEW_MS
        {
            return Err(RequestCapabilityError::InvalidPolicyTimeBounds);
        }
        Ok(())
    }

    /// Hashes the exact policy used for one verification decision.
    pub fn policy_hash(&self) -> Result<Sha256Digest, RequestCapabilityError> {
        self.validate()?;
        let mut subject = Vec::new();
        append_text(&mut subject, "HeptaCapabilityPolicyV1")?;
        append_u16(&mut subject, self.version)?;
        append_text(&mut subject, &self.policy_id)?;
        append_text(&mut subject, &self.broker_instance_id)?;
        append_text(&mut subject, &self.expected_signer_key_id)?;
        append_u64(&mut subject, self.maximum_future_validity_ms)?;
        append_u64(&mut subject, self.maximum_clock_skew_ms)?;
        digest_bytes(&subject)
    }
}

/// Secret MAC key used only by the capability issuer and the local broker.
///
/// The type intentionally omits `Clone`, `Copy`, `Debug`, serialization and
/// accessors. Dropping it overwrites the in-memory byte array.
pub struct CapabilityMacKeyV1 {
    bytes: [u8; HMAC_OUTPUT_BYTES],
}

impl CapabilityMacKeyV1 {
    #[must_use]
    pub const fn from_bytes(bytes: [u8; HMAC_OUTPUT_BYTES]) -> Self {
        Self { bytes }
    }
}

impl Drop for CapabilityMacKeyV1 {
    fn drop(&mut self) {
        self.bytes.fill(0);
    }
}

/// Successful capability authentication evidence.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CapabilityVerificationV1 {
    pub request_subject_hash: Sha256Digest,
    pub capability_signature_hash: Sha256Digest,
    pub capability_policy_hash: Sha256Digest,
    pub signer_key_id: String,
    pub nonce: String,
    pub expires_at_unix_ms: u64,
    pub peer: PeerCredentialsV1,
}

/// Computes the canonical Base64 HMAC for an issuer constructing a request.
///
/// The request must already contain all capability metadata and a syntactically
/// valid placeholder signature. Only `signatureBase64` is excluded from the
/// authenticated subject.
pub fn compute_request_capability_signature_v1(
    request: &CodexExecutionRequestV1,
    peer: PeerCredentialsV1,
    policy: &CapabilityPolicyV1,
    key: &CapabilityMacKeyV1,
    now_unix_ms: u64,
) -> Result<String, RequestCapabilityError> {
    validate_before_mac(request, peer, policy, now_unix_ms)?;
    let subject = request_capability_subject_bytes_v1(request, peer, policy)?;
    Ok(base64_encode_32(hmac_sha256(&key.bytes, &subject)))
}

/// Hashes the exact request/peer/broker subject authenticated by the capability.
pub fn request_capability_subject_hash_v1(
    request: &CodexExecutionRequestV1,
    peer: PeerCredentialsV1,
    policy: &CapabilityPolicyV1,
) -> Result<Sha256Digest, RequestCapabilityError> {
    digest_bytes(&request_capability_subject_bytes_v1(
        request, peer, policy,
    )?)
}

/// Authenticates the request capability and enforces its short expiry window.
pub fn verify_request_capability_v1(
    request: &CodexExecutionRequestV1,
    peer: PeerCredentialsV1,
    policy: &CapabilityPolicyV1,
    key: &CapabilityMacKeyV1,
    now_unix_ms: u64,
) -> Result<CapabilityVerificationV1, RequestCapabilityError> {
    validate_before_mac(request, peer, policy, now_unix_ms)?;
    let observed_signature = request.request_capability.signature_base64.as_bytes();
    if observed_signature.len() != 44
        || observed_signature[43] != b'='
        || !observed_signature.iter().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/' | b'=')
        })
    {
        return Err(RequestCapabilityError::NonCanonicalSignature);
    }
    let subject = request_capability_subject_bytes_v1(request, peer, policy)?;
    let expected_signature = base64_encode_32(hmac_sha256(&key.bytes, &subject));
    if !constant_time_equal(expected_signature.as_bytes(), observed_signature) {
        return Err(RequestCapabilityError::SignatureMismatch);
    }
    Ok(CapabilityVerificationV1 {
        request_subject_hash: digest_bytes(&subject)?,
        capability_signature_hash: digest_bytes(observed_signature)?,
        capability_policy_hash: policy.policy_hash()?,
        signer_key_id: request.request_capability.signer_key_id.clone(),
        nonce: request.request_capability.nonce.clone(),
        expires_at_unix_ms: request.request_capability.expires_at_unix_ms,
        peer,
    })
}

fn validate_before_mac(
    request: &CodexExecutionRequestV1,
    peer: PeerCredentialsV1,
    policy: &CapabilityPolicyV1,
    now_unix_ms: u64,
) -> Result<(), RequestCapabilityError> {
    request
        .validate()
        .map_err(RequestCapabilityError::RequestInvalid)?;
    policy.validate()?;
    if now_unix_ms == 0 {
        return Err(RequestCapabilityError::InvalidCurrentTime);
    }
    if peer.process_id <= 0 {
        return Err(RequestCapabilityError::InvalidPeerProcessId(
            peer.process_id,
        ));
    }
    if request.request_capability.signer_key_id != policy.expected_signer_key_id {
        return Err(RequestCapabilityError::SignerKeyIdMismatch);
    }
    let expiry_with_skew = request
        .request_capability
        .expires_at_unix_ms
        .checked_add(policy.maximum_clock_skew_ms)
        .ok_or(RequestCapabilityError::TimeArithmeticOverflow)?;
    if expiry_with_skew < now_unix_ms {
        return Err(RequestCapabilityError::Expired);
    }
    let maximum_expiry = now_unix_ms
        .checked_add(policy.maximum_future_validity_ms)
        .ok_or(RequestCapabilityError::TimeArithmeticOverflow)?;
    if request.request_capability.expires_at_unix_ms > maximum_expiry {
        return Err(RequestCapabilityError::ExpiryTooFarInFuture);
    }
    Ok(())
}

fn request_capability_subject_bytes_v1(
    request: &CodexExecutionRequestV1,
    peer: PeerCredentialsV1,
    policy: &CapabilityPolicyV1,
) -> Result<Vec<u8>, RequestCapabilityError> {
    policy.validate()?;
    let mut output = Vec::with_capacity(2048);
    append_text(&mut output, "HeptaBrokerRequestCapabilityV1")?;
    append_text(&mut output, &policy.broker_instance_id)?;
    append_i32(&mut output, peer.process_id)?;
    append_u32(&mut output, peer.user_id)?;
    append_u32(&mut output, peer.group_id)?;
    append_u16(&mut output, request.version)?;
    append_text(&mut output, &request.operation_id)?;
    append_digest(&mut output, &request.idempotency_key)?;
    append_text(&mut output, &request.campaign_id)?;
    append_text(&mut output, &request.node_id)?;
    append_text(&mut output, &request.attempt_id)?;
    append_u64(&mut output, request.lease_generation)?;
    append_u64(&mut output, request.campaign_revision)?;
    append_text(&mut output, agent_role_name(request.role))?;
    append_text(&mut output, task_kind_name(request.task_kind))?;
    append_digest(&mut output, &request.codex_runtime_identity_hash)?;
    append_text(&mut output, &request.model_selector)?;
    append_text(&mut output, transport_name(request.transport))?;
    append_text(&mut output, session_policy_name(request.session_policy))?;
    append_digest(&mut output, &request.prompt_envelope_hash)?;
    append_digest(&mut output, &request.input_manifest_hash)?;
    append_digest(&mut output, &request.workspace_identity_hash)?;
    append_digest(&mut output, &request.output_schema_hash)?;
    append_digest(&mut output, &request.mutation_policy_hash)?;
    append_text(&mut output, sandbox_policy_name(request.sandbox_policy))?;
    append_text(&mut output, network_policy_name(request.network_policy))?;
    append_text(&mut output, approval_policy_name(request.approval_policy))?;
    append_u64(&mut output, request.absolute_deadline_unix_ms)?;
    append_u64(&mut output, request.maximum_output_bytes)?;
    append_u64(&mut output, request.maximum_event_count)?;
    append_u64(&mut output, request.maximum_cost_microusd)?;
    match request.remaining_token_hint {
        Some(value) => {
            append_u8(&mut output, 1)?;
            append_u64(&mut output, value)?;
        }
        None => append_u8(&mut output, 0)?,
    }
    append_text(&mut output, &request.request_capability.nonce)?;
    append_u64(
        &mut output,
        request.request_capability.expires_at_unix_ms,
    )?;
    append_text(
        &mut output,
        &request.request_capability.signer_key_id,
    )?;
    Ok(output)
}

fn hmac_sha256(key: &[u8; HMAC_OUTPUT_BYTES], message: &[u8]) -> [u8; HMAC_OUTPUT_BYTES] {
    let mut inner_key = [0x36_u8; HMAC_BLOCK_BYTES];
    let mut outer_key = [0x5c_u8; HMAC_BLOCK_BYTES];
    for (index, byte) in key.iter().enumerate() {
        inner_key[index] ^= byte;
        outer_key[index] ^= byte;
    }
    let mut inner = Sha256::new();
    inner.update(inner_key);
    inner.update(message);
    let inner_digest = inner.finalize();
    let mut outer = Sha256::new();
    outer.update(outer_key);
    outer.update(inner_digest);
    outer.finalize().into()
}

fn base64_encode_32(bytes: [u8; HMAC_OUTPUT_BYTES]) -> String {
    const TABLE: &[u8; 64] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut output = [b'='; 44];
    let mut source = 0_usize;
    let mut target = 0_usize;
    while source + 3 <= bytes.len() {
        let block = (u32::from(bytes[source]) << 16)
            | (u32::from(bytes[source + 1]) << 8)
            | u32::from(bytes[source + 2]);
        output[target] = TABLE[((block >> 18) & 0x3f) as usize];
        output[target + 1] = TABLE[((block >> 12) & 0x3f) as usize];
        output[target + 2] = TABLE[((block >> 6) & 0x3f) as usize];
        output[target + 3] = TABLE[(block & 0x3f) as usize];
        source += 3;
        target += 4;
    }
    let remaining = bytes.len() - source;
    if remaining == 2 {
        let block = (u32::from(bytes[source]) << 16) | (u32::from(bytes[source + 1]) << 8);
        output[target] = TABLE[((block >> 18) & 0x3f) as usize];
        output[target + 1] = TABLE[((block >> 12) & 0x3f) as usize];
        output[target + 2] = TABLE[((block >> 6) & 0x3f) as usize];
    }
    String::from_utf8(output.to_vec()).expect("Base64 alphabet is UTF-8")
}

fn constant_time_equal(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.iter()
        .zip(right)
        .fold(0_u8, |difference, (left, right)| difference | (left ^ right))
        == 0
}

fn digest_bytes(bytes: &[u8]) -> Result<Sha256Digest, RequestCapabilityError> {
    Sha256Digest::from_str(&format!("sha256:{}", hex::encode(Sha256::digest(bytes))))
        .map_err(|_| RequestCapabilityError::DigestConstruction)
}

fn append_text(output: &mut Vec<u8>, value: &str) -> Result<(), RequestCapabilityError> {
    append_bytes(output, value.as_bytes())
}

fn append_digest(
    output: &mut Vec<u8>,
    value: &Sha256Digest,
) -> Result<(), RequestCapabilityError> {
    append_text(output, value.as_str())
}

fn append_bytes(output: &mut Vec<u8>, value: &[u8]) -> Result<(), RequestCapabilityError> {
    let length = u64::try_from(value.len()).map_err(|_| RequestCapabilityError::SubjectTooLarge)?;
    output.extend_from_slice(&length.to_be_bytes());
    output.extend_from_slice(value);
    Ok(())
}

fn append_u8(output: &mut Vec<u8>, value: u8) -> Result<(), RequestCapabilityError> {
    append_bytes(output, &[value])
}

fn append_u16(output: &mut Vec<u8>, value: u16) -> Result<(), RequestCapabilityError> {
    append_bytes(output, &value.to_be_bytes())
}

fn append_u32(output: &mut Vec<u8>, value: u32) -> Result<(), RequestCapabilityError> {
    append_bytes(output, &value.to_be_bytes())
}

fn append_i32(output: &mut Vec<u8>, value: i32) -> Result<(), RequestCapabilityError> {
    append_bytes(output, &value.to_be_bytes())
}

fn append_u64(output: &mut Vec<u8>, value: u64) -> Result<(), RequestCapabilityError> {
    append_bytes(output, &value.to_be_bytes())
}

const fn agent_role_name(value: AgentRole) -> &'static str {
    match value {
        AgentRole::Author => "author",
        AgentRole::Reviewer => "reviewer",
        AgentRole::FormalReviewer => "formal_reviewer",
        AgentRole::Repairer => "repairer",
    }
}

const fn task_kind_name(value: TaskKind) -> &'static str {
    match value {
        TaskKind::Draft => "draft",
        TaskKind::Revise => "revise",
        TaskKind::Review => "review",
        TaskKind::FormalReview => "formal_review",
        TaskKind::CodeRepair => "code_repair",
        TaskKind::LatexRepair => "latex_repair",
    }
}

const fn transport_name(value: Transport) -> &'static str {
    match value {
        Transport::ExecJsonlV1 => "exec-jsonl-v1",
    }
}

const fn session_policy_name(value: SessionPolicy) -> &'static str {
    match value {
        SessionPolicy::EphemeralNewThread => "ephemeral-new-thread",
    }
}

const fn sandbox_policy_name(value: SandboxPolicy) -> &'static str {
    match value {
        SandboxPolicy::ReadOnly => "read-only",
        SandboxPolicy::WorkspaceWrite => "workspace-write",
    }
}

const fn network_policy_name(value: NetworkPolicy) -> &'static str {
    match value {
        NetworkPolicy::None => "none",
    }
}

const fn approval_policy_name(value: ApprovalPolicy) -> &'static str {
    match value {
        ApprovalPolicy::Never => "never",
    }
}

fn valid_identifier(value: &str) -> bool {
    if value.is_empty() || value.len() > 128 {
        return false;
    }
    let mut bytes = value.bytes();
    let Some(first) = bytes.next() else {
        return false;
    };
    first.is_ascii_alphanumeric()
        && bytes.all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b':' | b'-')
        })
}

/// Invalid request capability, time window or signature.
#[derive(Clone, Debug, Error, Eq, PartialEq)]
pub enum RequestCapabilityError {
    #[error("unsupported capability policy version: {0}")]
    UnsupportedPolicyVersion(u16),
    #[error("capability policy identifier is invalid: {0}")]
    InvalidPolicyIdentifier(&'static str),
    #[error("capability policy time bounds are invalid")]
    InvalidPolicyTimeBounds,
    #[error("request is invalid: {0}")]
    RequestInvalid(hepta_codex_protocol::ProtocolValidationError),
    #[error("current time must be positive")]
    InvalidCurrentTime,
    #[error("peer process id is invalid: {0}")]
    InvalidPeerProcessId(i32),
    #[error("capability signer key id does not match policy")]
    SignerKeyIdMismatch,
    #[error("capability has expired")]
    Expired,
    #[error("capability expiry is too far in the future")]
    ExpiryTooFarInFuture,
    #[error("capability time arithmetic overflowed")]
    TimeArithmeticOverflow,
    #[error("capability signature is not canonical Base64 HMAC-SHA256")]
    NonCanonicalSignature,
    #[error("capability signature does not authenticate the request and peer")]
    SignatureMismatch,
    #[error("capability subject exceeded representable limits")]
    SubjectTooLarge,
    #[error("failed to construct capability digest")]
    DigestConstruction,
}

#[cfg(test)]
mod tests {
    use std::str::FromStr;

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

    fn signed_request(
        peer: PeerCredentialsV1,
        policy: &CapabilityPolicyV1,
        key: &CapabilityMacKeyV1,
    ) -> CodexExecutionRequestV1 {
        let mut request = request();
        request.request_capability.signature_base64 =
            compute_request_capability_signature_v1(&request, peer, policy, key, 10_000)
                .expect("capability signature");
        request
    }

    #[test]
    fn capability_binds_every_request_field_and_kernel_peer() {
        let peer = PeerCredentialsV1 {
            process_id: 42,
            user_id: 1000,
            group_id: 1000,
        };
        let policy = CapabilityPolicyV1::strict(
            "author-capability-v1",
            "author-broker-1",
            "issuer-key-1",
        )
        .expect("policy");
        let key = CapabilityMacKeyV1::from_bytes([7_u8; 32]);
        let request = signed_request(peer, &policy, &key);
        assert!(
            verify_request_capability_v1(&request, peer, &policy, &key, 10_000).is_ok()
        );
        let different_peer = PeerCredentialsV1 {
            process_id: 43,
            ..peer
        };
        assert_eq!(
            verify_request_capability_v1(&request, different_peer, &policy, &key, 10_000),
            Err(RequestCapabilityError::SignatureMismatch),
        );
        let mut changed = request.clone();
        changed.campaign_revision += 1;
        assert_eq!(
            verify_request_capability_v1(&changed, peer, &policy, &key, 10_000),
            Err(RequestCapabilityError::SignatureMismatch),
        );
    }

    #[test]
    fn expired_and_overlong_capabilities_fail_before_admission() {
        let peer = PeerCredentialsV1 {
            process_id: 42,
            user_id: 1000,
            group_id: 1000,
        };
        let policy = CapabilityPolicyV1::strict(
            "author-capability-v1",
            "author-broker-1",
            "issuer-key-1",
        )
        .expect("policy");
        let key = CapabilityMacKeyV1::from_bytes([7_u8; 32]);
        let mut expired = request();
        expired.request_capability.expires_at_unix_ms = 1_000;
        expired.request_capability.signature_base64 =
            compute_request_capability_signature_v1(&expired, peer, &policy, &key, 900)
                .expect("signature");
        assert_eq!(
            verify_request_capability_v1(&expired, peer, &policy, &key, 10_000),
            Err(RequestCapabilityError::Expired),
        );
        let mut future = request();
        future.request_capability.expires_at_unix_ms = 400_001;
        assert_eq!(
            compute_request_capability_signature_v1(&future, peer, &policy, &key, 10_000),
            Err(RequestCapabilityError::ExpiryTooFarInFuture),
        );
    }
}
