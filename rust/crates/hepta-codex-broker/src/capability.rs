use std::{collections::BTreeMap, str::FromStr};

use base64ct::{Base64UrlUnpadded, Encoding};
use ed25519_dalek::{Signature, VerifyingKey};
use hepta_codex_protocol::{
    AgentRole, ApprovalPolicy, CodexExecutionRequestV1, NetworkPolicy, SandboxPolicy,
    SessionPolicy, Sha256Digest, TaskKind, Transport,
};
use sha2::{Digest, Sha256};
use thiserror::Error;

use crate::PeerIdentityV1;

const MAXIMUM_TRUSTED_KEYS: usize = 64;
const HARD_MAXIMUM_LIFETIME_MS: u64 = 5 * 60 * 1000;
const HARD_MAXIMUM_FUTURE_SKEW_MS: u64 = 30 * 1000;

/// Time bounds for a signed local request capability.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CapabilityPolicyV1 {
    pub maximum_lifetime_ms: u64,
    pub maximum_future_skew_ms: u64,
}

impl Default for CapabilityPolicyV1 {
    fn default() -> Self {
        Self {
            maximum_lifetime_ms: 60_000,
            maximum_future_skew_ms: 5_000,
        }
    }
}

impl CapabilityPolicyV1 {
    fn validate(self) -> Result<Self, CapabilityVerificationError> {
        if self.maximum_lifetime_ms == 0
            || self.maximum_lifetime_ms > HARD_MAXIMUM_LIFETIME_MS
            || self.maximum_future_skew_ms > HARD_MAXIMUM_FUTURE_SKEW_MS
        {
            return Err(CapabilityVerificationError::InvalidPolicy);
        }
        Ok(self)
    }
}

/// Immutable map from qualified signer-key IDs to Ed25519 verification keys.
#[derive(Clone, Debug)]
pub struct CapabilityTrustStoreV1 {
    keys: BTreeMap<String, VerifyingKey>,
}

impl CapabilityTrustStoreV1 {
    /// Constructs a nonempty trust store and rejects weak public keys.
    pub fn new<I>(entries: I) -> Result<Self, CapabilityVerificationError>
    where
        I: IntoIterator<Item = (String, VerifyingKey)>,
    {
        let mut keys = BTreeMap::new();
        for (key_id, key) in entries {
            if !valid_identifier(&key_id) {
                return Err(CapabilityVerificationError::InvalidSignerKeyId);
            }
            if key.is_weak() {
                return Err(CapabilityVerificationError::WeakVerificationKey(key_id));
            }
            if keys.insert(key_id.clone(), key).is_some() {
                return Err(CapabilityVerificationError::DuplicateSignerKeyId(key_id));
            }
        }
        if keys.is_empty() || keys.len() > MAXIMUM_TRUSTED_KEYS {
            return Err(CapabilityVerificationError::InvalidTrustStoreSize);
        }
        Ok(Self { keys })
    }

    fn get(&self, key_id: &str) -> Result<&VerifyingKey, CapabilityVerificationError> {
        self.keys
            .get(key_id)
            .ok_or_else(|| CapabilityVerificationError::UnknownSignerKey(key_id.to_owned()))
    }
}

/// Result of strict signature, peer, and temporal verification.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VerifiedCapabilityV1 {
    pub signer_key_id: String,
    pub nonce: String,
    pub peer_uid: u32,
    pub peer_gid: u32,
    pub signing_message_hash: Sha256Digest,
}

/// Verifies a short-lived capability against the kernel-observed peer.
pub fn verify_request_capability(
    request: &CodexExecutionRequestV1,
    peer: PeerIdentityV1,
    now_unix_ms: u64,
    policy: CapabilityPolicyV1,
    trust_store: &CapabilityTrustStoreV1,
) -> Result<VerifiedCapabilityV1, CapabilityVerificationError> {
    let policy = policy.validate()?;
    request
        .validate()
        .map_err(|error| CapabilityVerificationError::InvalidRequest(error.to_string()))?;
    if now_unix_ms == 0 {
        return Err(CapabilityVerificationError::InvalidCurrentTime);
    }
    let capability = &request.request_capability;
    if capability.peer_uid != peer.uid || capability.peer_gid != peer.gid {
        return Err(CapabilityVerificationError::PeerBindingMismatch);
    }
    let latest_acceptable_issue = now_unix_ms
        .checked_add(policy.maximum_future_skew_ms)
        .ok_or(CapabilityVerificationError::TimeArithmeticOverflow)?;
    if capability.issued_at_unix_ms > latest_acceptable_issue {
        return Err(CapabilityVerificationError::NotYetValid);
    }
    if capability.expires_at_unix_ms <= now_unix_ms {
        return Err(CapabilityVerificationError::Expired);
    }
    if request.absolute_deadline_unix_ms <= now_unix_ms {
        return Err(CapabilityVerificationError::RequestDeadlineExpired);
    }
    let lifetime = capability
        .expires_at_unix_ms
        .checked_sub(capability.issued_at_unix_ms)
        .ok_or(CapabilityVerificationError::InvalidCapabilityLifetime)?;
    if lifetime == 0 || lifetime > policy.maximum_lifetime_ms {
        return Err(CapabilityVerificationError::InvalidCapabilityLifetime);
    }

    let signing_bytes = capability_signing_bytes(request)?;
    let signature_bytes = Base64UrlUnpadded::decode_vec(&capability.signature_base64)
        .map_err(|_| CapabilityVerificationError::InvalidSignatureEncoding)?;
    let signature = Signature::try_from(signature_bytes.as_slice())
        .map_err(|_| CapabilityVerificationError::InvalidSignatureEncoding)?;
    let key = trust_store.get(&capability.signer_key_id)?;
    key.verify_strict(&signing_bytes, &signature)
        .map_err(|_| CapabilityVerificationError::SignatureRejected)?;

    Ok(VerifiedCapabilityV1 {
        signer_key_id: capability.signer_key_id.clone(),
        nonce: capability.nonce.clone(),
        peer_uid: peer.uid,
        peer_gid: peer.gid,
        signing_message_hash: sha256_digest(&signing_bytes)?,
    })
}

/// Canonical domain-separated bytes signed by the local request authority.
pub fn capability_signing_bytes(
    request: &CodexExecutionRequestV1,
) -> Result<Vec<u8>, CapabilityVerificationError> {
    let mut writer = SigningMessageWriter::new("HeptaCodexRequestCapabilityV1")?;
    writer.u64("requestVersion", u64::from(request.version))?;
    writer.text("operationId", &request.operation_id)?;
    writer.digest("idempotencyKey", &request.idempotency_key)?;
    writer.text("campaignId", &request.campaign_id)?;
    writer.text("nodeId", &request.node_id)?;
    writer.text("attemptId", &request.attempt_id)?;
    writer.u64("leaseGeneration", request.lease_generation)?;
    writer.u64("campaignRevision", request.campaign_revision)?;
    writer.text("role", role_name(request.role))?;
    writer.text("taskKind", task_name(request.task_kind))?;
    writer.digest(
        "codexRuntimeIdentityHash",
        &request.codex_runtime_identity_hash,
    )?;
    writer.text("modelSelector", &request.model_selector)?;
    writer.text("transport", transport_name(request.transport))?;
    writer.text("sessionPolicy", session_name(request.session_policy))?;
    writer.digest("promptEnvelopeHash", &request.prompt_envelope_hash)?;
    writer.digest("inputManifestHash", &request.input_manifest_hash)?;
    writer.digest("workspaceIdentityHash", &request.workspace_identity_hash)?;
    writer.digest("outputSchemaHash", &request.output_schema_hash)?;
    writer.digest("mutationPolicyHash", &request.mutation_policy_hash)?;
    writer.text("sandboxPolicy", sandbox_name(request.sandbox_policy))?;
    writer.text("networkPolicy", network_name(request.network_policy))?;
    writer.text("approvalPolicy", approval_name(request.approval_policy))?;
    writer.u64("absoluteDeadlineUnixMs", request.absolute_deadline_unix_ms)?;
    writer.u64("maximumOutputBytes", request.maximum_output_bytes)?;
    writer.u64("maximumEventCount", request.maximum_event_count)?;
    writer.u64("maximumCostMicrousd", request.maximum_cost_microusd)?;
    writer.optional_u64("remainingTokenHint", request.remaining_token_hint)?;
    writer.text("capabilityNonce", &request.request_capability.nonce)?;
    writer.u64(
        "capabilityIssuedAtUnixMs",
        request.request_capability.issued_at_unix_ms,
    )?;
    writer.u64(
        "capabilityExpiresAtUnixMs",
        request.request_capability.expires_at_unix_ms,
    )?;
    writer.text(
        "capabilitySignerKeyId",
        &request.request_capability.signer_key_id,
    )?;
    writer.u64(
        "capabilityPeerUid",
        u64::from(request.request_capability.peer_uid),
    )?;
    writer.u64(
        "capabilityPeerGid",
        u64::from(request.request_capability.peer_gid),
    )?;
    Ok(writer.finish())
}

struct SigningMessageWriter {
    bytes: Vec<u8>,
}

impl SigningMessageWriter {
    fn new(domain: &str) -> Result<Self, CapabilityVerificationError> {
        let mut writer = Self { bytes: Vec::new() };
        writer.raw(domain.as_bytes())?;
        Ok(writer)
    }

    fn text(&mut self, key: &str, value: &str) -> Result<(), CapabilityVerificationError> {
        self.raw(key.as_bytes())?;
        self.raw(value.as_bytes())
    }

    fn digest(
        &mut self,
        key: &str,
        value: &Sha256Digest,
    ) -> Result<(), CapabilityVerificationError> {
        self.text(key, value.as_str())
    }

    fn u64(&mut self, key: &str, value: u64) -> Result<(), CapabilityVerificationError> {
        self.raw(key.as_bytes())?;
        self.raw(&value.to_be_bytes())
    }

    fn optional_u64(
        &mut self,
        key: &str,
        value: Option<u64>,
    ) -> Result<(), CapabilityVerificationError> {
        self.raw(key.as_bytes())?;
        match value {
            Some(value) => {
                self.raw(&[1])?;
                self.raw(&value.to_be_bytes())
            }
            None => self.raw(&[0]),
        }
    }

    fn raw(&mut self, value: &[u8]) -> Result<(), CapabilityVerificationError> {
        let length = u64::try_from(value.len())
            .map_err(|_| CapabilityVerificationError::SigningMessageTooLarge)?;
        self.bytes.extend_from_slice(&length.to_be_bytes());
        self.bytes.extend_from_slice(value);
        Ok(())
    }

    fn finish(self) -> Vec<u8> {
        self.bytes
    }
}

fn role_name(value: AgentRole) -> &'static str {
    match value {
        AgentRole::Author => "author",
        AgentRole::Reviewer => "reviewer",
        AgentRole::FormalReviewer => "formal_reviewer",
        AgentRole::Repairer => "repairer",
    }
}

fn task_name(value: TaskKind) -> &'static str {
    match value {
        TaskKind::Draft => "draft",
        TaskKind::Revise => "revise",
        TaskKind::Review => "review",
        TaskKind::FormalReview => "formal_review",
        TaskKind::CodeRepair => "code_repair",
        TaskKind::LatexRepair => "latex_repair",
    }
}

fn transport_name(value: Transport) -> &'static str {
    match value {
        Transport::ExecJsonlV1 => "exec-jsonl-v1",
    }
}

fn session_name(value: SessionPolicy) -> &'static str {
    match value {
        SessionPolicy::EphemeralNewThread => "ephemeral-new-thread",
    }
}

fn sandbox_name(value: SandboxPolicy) -> &'static str {
    match value {
        SandboxPolicy::ReadOnly => "read-only",
        SandboxPolicy::WorkspaceWrite => "workspace-write",
    }
}

fn network_name(value: NetworkPolicy) -> &'static str {
    match value {
        NetworkPolicy::None => "none",
    }
}

fn approval_name(value: ApprovalPolicy) -> &'static str {
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
        && bytes
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b':' | b'-'))
}

fn sha256_digest(bytes: &[u8]) -> Result<Sha256Digest, CapabilityVerificationError> {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let value = format!("sha256:{}", hex::encode(hasher.finalize()));
    Sha256Digest::from_str(&value).map_err(|_| CapabilityVerificationError::DigestConstruction)
}

/// Trust-store, clock, peer-binding, encoding, or signature failure.
#[derive(Clone, Debug, Error, Eq, PartialEq)]
pub enum CapabilityVerificationError {
    #[error("capability policy is invalid")]
    InvalidPolicy,
    #[error("capability trust-store size is invalid")]
    InvalidTrustStoreSize,
    #[error("capability signer key id is invalid")]
    InvalidSignerKeyId,
    #[error("capability signer key id is duplicated: {0}")]
    DuplicateSignerKeyId(String),
    #[error("capability verification key is weak: {0}")]
    WeakVerificationKey(String),
    #[error("capability signer key is unknown: {0}")]
    UnknownSignerKey(String),
    #[error("broker request is invalid: {0}")]
    InvalidRequest(String),
    #[error("current time is invalid")]
    InvalidCurrentTime,
    #[error("capability peer binding does not match SO_PEERCRED")]
    PeerBindingMismatch,
    #[error("capability is not yet valid")]
    NotYetValid,
    #[error("capability has expired")]
    Expired,
    #[error("request deadline has expired")]
    RequestDeadlineExpired,
    #[error("capability lifetime is invalid")]
    InvalidCapabilityLifetime,
    #[error("capability time arithmetic overflowed")]
    TimeArithmeticOverflow,
    #[error("capability signature encoding is invalid")]
    InvalidSignatureEncoding,
    #[error("capability signature was rejected")]
    SignatureRejected,
    #[error("capability signing message is too large")]
    SigningMessageTooLarge,
    #[error("failed to construct capability digest")]
    DigestConstruction,
}

#[cfg(test)]
mod tests {
    use base64ct::{Base64UrlUnpadded, Encoding};
    use ed25519_dalek::{Signer, SigningKey};
    use std::str::FromStr;

    use hepta_codex_protocol::{
        AgentRole, ApprovalPolicy, NetworkPolicy, RequestCapabilityV1, SandboxPolicy,
        SessionPolicy, Sha256Digest, TaskKind, Transport,
    };

    use super::*;

    fn signed_request(peer: PeerIdentityV1) -> (CodexExecutionRequestV1, CapabilityTrustStoreV1) {
        let signing_key = SigningKey::from_bytes(&[7_u8; 32]);
        let digest = |byte: char| {
            Sha256Digest::from_str(&format!("sha256:{}", byte.to_string().repeat(64)))
                .expect("test digest")
        };
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
                nonce: "placeholder".into(),
                issued_at_unix_ms: 10_000,
                expires_at_unix_ms: 15_000,
                signer_key_id: "key-1".into(),
                peer_uid: peer.uid,
                peer_gid: peer.gid,
                signature_base64: "AA".into(),
            },
        };
        request.request_capability = RequestCapabilityV1 {
            nonce: "nonce-signed-1".into(),
            issued_at_unix_ms: 10_000,
            expires_at_unix_ms: 15_000,
            signer_key_id: "key-1".into(),
            peer_uid: peer.uid,
            peer_gid: peer.gid,
            signature_base64: "AA".into(),
        };
        let message = capability_signing_bytes(&request).expect("signing message");
        request.request_capability.signature_base64 =
            Base64UrlUnpadded::encode_string(&signing_key.sign(&message).to_bytes());
        let trust =
            CapabilityTrustStoreV1::new([("key-1".to_owned(), signing_key.verifying_key())])
                .expect("trust store");
        (request, trust)
    }

    #[test]
    fn verifies_signature_time_and_kernel_peer_binding() {
        let peer = PeerIdentityV1 {
            pid: 42,
            uid: 1000,
            gid: 1000,
        };
        let (request, trust) = signed_request(peer);
        let verified = verify_request_capability(
            &request,
            peer,
            12_000,
            CapabilityPolicyV1::default(),
            &trust,
        )
        .expect("verified capability");
        assert_eq!(verified.nonce, "nonce-signed-1");
    }

    #[test]
    fn rejects_peer_mismatch_and_tampering() {
        let peer = PeerIdentityV1 {
            pid: 42,
            uid: 1000,
            gid: 1000,
        };
        let (mut request, trust) = signed_request(peer);
        assert_eq!(
            verify_request_capability(
                &request,
                PeerIdentityV1 { uid: 1001, ..peer },
                12_000,
                CapabilityPolicyV1::default(),
                &trust,
            ),
            Err(CapabilityVerificationError::PeerBindingMismatch),
        );
        request.maximum_output_bytes = 2048;
        assert_eq!(
            verify_request_capability(
                &request,
                peer,
                12_000,
                CapabilityPolicyV1::default(),
                &trust,
            ),
            Err(CapabilityVerificationError::SignatureRejected),
        );
    }

    #[test]
    fn rejects_expired_capability() {
        let peer = PeerIdentityV1 {
            pid: 42,
            uid: 1000,
            gid: 1000,
        };
        let (request, trust) = signed_request(peer);
        assert_eq!(
            verify_request_capability(
                &request,
                peer,
                15_000,
                CapabilityPolicyV1::default(),
                &trust,
            ),
            Err(CapabilityVerificationError::Expired),
        );
    }
}
