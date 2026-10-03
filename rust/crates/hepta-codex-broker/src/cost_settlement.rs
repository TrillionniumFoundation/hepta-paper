//! Independently signed provider-cost settlement for one prepared operation.
//!
//! A broker-prepared result proves output and measured token usage. It does not
//! prove what the provider actually charged. This contract binds a separately
//! administered billing authority to the exact signed request and prepared
//! receipt. It grants no campaign-write, release, or submission authority.

use std::{collections::BTreeMap, str::FromStr};

use base64ct::{Base64UrlUnpadded, Encoding};
use ed25519_dalek::{Signature, VerifyingKey};
use hepta_codex_protocol::{CodexExecutionRequestV1, Sha256Digest, TokenUsage};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;

use crate::BrokerPreparedResultReceiptV1;

const MAXIMUM_SETTLEMENT_KEYS: usize = 32;
const HARD_MAXIMUM_SETTLEMENT_AGE_MS: u64 = 30 * 24 * 60 * 60 * 1000;
const MAXIMUM_SIGNING_MESSAGE_BYTES: usize = 64 * 1024;

/// Billing-authority receipt for the actual charge of one prepared operation.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderCostSettlementV1 {
    pub version: u16,
    pub operation_id: String,
    pub request_hash: Sha256Digest,
    pub prepared_receipt_hash: Sha256Digest,
    pub campaign_id: String,
    pub node_id: String,
    pub attempt_id: String,
    pub lease_generation: u64,
    pub campaign_revision: u64,
    pub settlement_id: String,
    pub authority_domain_id: String,
    pub trust_store_generation: u64,
    pub token_usage: Option<TokenUsage>,
    pub actual_cost_microusd: u64,
    pub issued_at_unix_ms: u64,
    pub signer_key_id: String,
    pub signature_base64: String,
}

/// Bounded settlement-freshness policy.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ProviderCostSettlementPolicyV1 {
    pub version: u16,
    pub maximum_age_ms: u64,
}

impl Default for ProviderCostSettlementPolicyV1 {
    fn default() -> Self {
        Self {
            version: 1,
            maximum_age_ms: 24 * 60 * 60 * 1000,
        }
    }
}

impl ProviderCostSettlementPolicyV1 {
    fn validate(self) -> Result<Self, ProviderCostSettlementError> {
        if self.version != 1
            || self.maximum_age_ms == 0
            || self.maximum_age_ms > HARD_MAXIMUM_SETTLEMENT_AGE_MS
        {
            return Err(ProviderCostSettlementError::InvalidPolicy);
        }
        Ok(self)
    }
}

/// Current public keys for one separately administered billing authority set.
#[derive(Clone, Debug)]
pub struct ProviderCostSettlementTrustStoreV1 {
    authority_domain_id: String,
    generation: u64,
    keys: BTreeMap<String, VerifyingKey>,
}

impl ProviderCostSettlementTrustStoreV1 {
    pub fn new<I>(
        authority_domain_id: String,
        generation: u64,
        entries: I,
    ) -> Result<Self, ProviderCostSettlementError>
    where
        I: IntoIterator<Item = (String, VerifyingKey)>,
    {
        if !valid_identifier(&authority_domain_id) {
            return Err(ProviderCostSettlementError::InvalidIdentifier);
        }
        if generation == 0 {
            return Err(ProviderCostSettlementError::InvalidTrustGeneration);
        }
        let mut keys = BTreeMap::new();
        for (key_id, key) in entries {
            if !valid_identifier(&key_id) {
                return Err(ProviderCostSettlementError::InvalidSignerKeyId);
            }
            if key.is_weak() {
                return Err(ProviderCostSettlementError::WeakSignerKey(key_id));
            }
            if keys.insert(key_id.clone(), key).is_some() {
                return Err(ProviderCostSettlementError::DuplicateSignerKey(key_id));
            }
        }
        if keys.is_empty() || keys.len() > MAXIMUM_SETTLEMENT_KEYS {
            return Err(ProviderCostSettlementError::InvalidSignerKeyCount);
        }
        Ok(Self {
            authority_domain_id,
            generation,
            keys,
        })
    }

    #[must_use]
    pub fn authority_domain_id(&self) -> &str {
        &self.authority_domain_id
    }

    #[must_use]
    pub const fn generation(&self) -> u64 {
        self.generation
    }

    fn get(&self, key_id: &str) -> Result<&VerifyingKey, ProviderCostSettlementError> {
        self.keys
            .get(key_id)
            .ok_or_else(|| ProviderCostSettlementError::UnknownSignerKey(key_id.to_owned()))
    }
}

/// Construction-restricted verified actual charge.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VerifiedProviderCostSettlementV1 {
    settlement: ProviderCostSettlementV1,
    settlement_hash: Sha256Digest,
}

impl VerifiedProviderCostSettlementV1 {
    #[must_use]
    pub fn settlement(&self) -> &ProviderCostSettlementV1 {
        &self.settlement
    }

    #[must_use]
    pub fn settlement_hash(&self) -> &Sha256Digest {
        &self.settlement_hash
    }

    #[must_use]
    pub const fn actual_cost_microusd(&self) -> u64 {
        self.settlement.actual_cost_microusd
    }
}

/// Domain-separated bytes signed by the billing authority.
pub fn provider_cost_settlement_signing_bytes(
    settlement: &ProviderCostSettlementV1,
) -> Result<Vec<u8>, ProviderCostSettlementError> {
    let mut writer = MessageWriter::new("HeptaProviderCostSettlementV1")?;
    writer.u64("version", u64::from(settlement.version))?;
    writer.text("operationId", &settlement.operation_id)?;
    writer.digest("requestHash", &settlement.request_hash)?;
    writer.digest("preparedReceiptHash", &settlement.prepared_receipt_hash)?;
    writer.text("campaignId", &settlement.campaign_id)?;
    writer.text("nodeId", &settlement.node_id)?;
    writer.text("attemptId", &settlement.attempt_id)?;
    writer.u64("leaseGeneration", settlement.lease_generation)?;
    writer.u64("campaignRevision", settlement.campaign_revision)?;
    writer.text("settlementId", &settlement.settlement_id)?;
    writer.text("authorityDomainId", &settlement.authority_domain_id)?;
    writer.u64("trustStoreGeneration", settlement.trust_store_generation)?;
    match settlement.token_usage {
        Some(usage) => {
            writer.u64("tokenUsagePresent", 1)?;
            writer.u64("inputTokens", usage.input_tokens)?;
            writer.u64("cachedInputTokens", usage.cached_input_tokens)?;
            writer.u64("outputTokens", usage.output_tokens)?;
            writer.u64("reasoningOutputTokens", usage.reasoning_output_tokens)?;
        }
        None => writer.u64("tokenUsagePresent", 0)?,
    }
    writer.u64("actualCostMicrousd", settlement.actual_cost_microusd)?;
    writer.u64("issuedAtUnixMs", settlement.issued_at_unix_ms)?;
    writer.text("signerKeyId", &settlement.signer_key_id)?;
    Ok(writer.finish())
}

/// Verify signature, trust generation, freshness and exact prepared-result subject.
pub fn verify_provider_cost_settlement(
    settlement: &ProviderCostSettlementV1,
    request: &CodexExecutionRequestV1,
    receipt: &BrokerPreparedResultReceiptV1,
    now_unix_ms: u64,
    policy: ProviderCostSettlementPolicyV1,
    trust_store: &ProviderCostSettlementTrustStoreV1,
) -> Result<VerifiedProviderCostSettlementV1, ProviderCostSettlementError> {
    let policy = policy.validate()?;
    request
        .validate()
        .map_err(|_| ProviderCostSettlementError::RequestInvalid)?;
    receipt
        .verify_hash()
        .map_err(|_| ProviderCostSettlementError::PreparedReceiptInvalid)?;
    let request_hash = sha256_digest(
        &serde_json::to_vec(request).map_err(|_| ProviderCostSettlementError::RequestInvalid)?,
    )?;
    validate_shape(settlement)?;
    if settlement.authority_domain_id != trust_store.authority_domain_id() {
        return Err(ProviderCostSettlementError::AuthorityDomainMismatch);
    }
    if settlement.trust_store_generation != trust_store.generation() {
        return Err(ProviderCostSettlementError::TrustGenerationMismatch);
    }
    if now_unix_ms == 0
        || settlement.issued_at_unix_ms > now_unix_ms
        || settlement.issued_at_unix_ms < request.request_capability.issued_at_unix_ms
        || now_unix_ms - settlement.issued_at_unix_ms > policy.maximum_age_ms
    {
        return Err(ProviderCostSettlementError::SettlementExpired);
    }
    if settlement.operation_id != request.operation_id
        || settlement.operation_id != receipt.operation_id
        || settlement.request_hash != request_hash
        || receipt.request_hash != request_hash
        || settlement.prepared_receipt_hash != receipt.prepared_receipt_hash
        || settlement.campaign_id != request.campaign_id
        || settlement.campaign_id != receipt.campaign_id
        || settlement.node_id != request.node_id
        || settlement.node_id != receipt.node_id
        || settlement.attempt_id != request.attempt_id
        || settlement.attempt_id != receipt.attempt_id
        || settlement.lease_generation != request.lease_generation
        || settlement.lease_generation != receipt.lease_generation
        || settlement.campaign_revision != request.campaign_revision
        || settlement.campaign_revision != receipt.campaign_revision
        || settlement.token_usage != receipt.token_usage
        || settlement.actual_cost_microusd > request.maximum_cost_microusd
    {
        return Err(ProviderCostSettlementError::SubjectMismatch);
    }
    let signing_bytes = provider_cost_settlement_signing_bytes(settlement)?;
    let signature_bytes = Base64UrlUnpadded::decode_vec(&settlement.signature_base64)
        .map_err(|_| ProviderCostSettlementError::InvalidSignatureEncoding)?;
    if Base64UrlUnpadded::encode_string(&signature_bytes) != settlement.signature_base64 {
        return Err(ProviderCostSettlementError::InvalidSignatureEncoding);
    }
    let signature = Signature::try_from(signature_bytes.as_slice())
        .map_err(|_| ProviderCostSettlementError::InvalidSignatureEncoding)?;
    trust_store
        .get(&settlement.signer_key_id)?
        .verify_strict(&signing_bytes, &signature)
        .map_err(|_| ProviderCostSettlementError::SignatureRejected)?;
    Ok(VerifiedProviderCostSettlementV1 {
        settlement: settlement.clone(),
        settlement_hash: sha256_digest(&signing_bytes)?,
    })
}

fn validate_shape(
    settlement: &ProviderCostSettlementV1,
) -> Result<(), ProviderCostSettlementError> {
    if settlement.version != 1 {
        return Err(ProviderCostSettlementError::UnsupportedVersion(
            settlement.version,
        ));
    }
    for value in [
        settlement.operation_id.as_str(),
        settlement.campaign_id.as_str(),
        settlement.node_id.as_str(),
        settlement.attempt_id.as_str(),
        settlement.settlement_id.as_str(),
        settlement.authority_domain_id.as_str(),
        settlement.signer_key_id.as_str(),
    ] {
        if !valid_identifier(value) {
            return Err(ProviderCostSettlementError::InvalidIdentifier);
        }
    }
    if settlement.trust_store_generation == 0
        || settlement.lease_generation == 0
        || settlement.issued_at_unix_ms == 0
    {
        return Err(ProviderCostSettlementError::InvalidTimestampOrGeneration);
    }
    if let Some(usage) = settlement.token_usage
        && (usage.cached_input_tokens > usage.input_tokens
            || usage.reasoning_output_tokens > usage.output_tokens)
    {
        return Err(ProviderCostSettlementError::InvalidTokenUsage);
    }
    if settlement.signature_base64.is_empty() || settlement.signature_base64.len() > 256 {
        return Err(ProviderCostSettlementError::InvalidSignatureEncoding);
    }
    Ok(())
}

fn valid_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':'))
}

struct MessageWriter {
    bytes: Vec<u8>,
    failed: bool,
}

impl MessageWriter {
    fn new(domain: &str) -> Result<Self, ProviderCostSettlementError> {
        let mut writer = Self {
            bytes: Vec::new(),
            failed: false,
        };
        writer.raw(domain.as_bytes())?;
        Ok(writer)
    }

    fn raw(&mut self, value: &[u8]) -> Result<(), ProviderCostSettlementError> {
        let length =
            u64::try_from(value.len()).map_err(|_| ProviderCostSettlementError::MessageTooLarge)?;
        self.bytes.extend_from_slice(&length.to_be_bytes());
        self.bytes.extend_from_slice(value);
        if self.bytes.len() > MAXIMUM_SIGNING_MESSAGE_BYTES {
            self.failed = true;
            return Err(ProviderCostSettlementError::MessageTooLarge);
        }
        Ok(())
    }

    fn text(&mut self, key: &str, value: &str) -> Result<(), ProviderCostSettlementError> {
        self.raw(key.as_bytes())?;
        self.raw(value.as_bytes())
    }

    fn u64(&mut self, key: &str, value: u64) -> Result<(), ProviderCostSettlementError> {
        self.raw(key.as_bytes())?;
        self.raw(&value.to_be_bytes())
    }

    fn digest(
        &mut self,
        key: &str,
        value: &Sha256Digest,
    ) -> Result<(), ProviderCostSettlementError> {
        self.text(key, value.as_str())
    }

    fn finish(self) -> Vec<u8> {
        debug_assert!(!self.failed);
        self.bytes
    }
}

fn sha256_digest(bytes: &[u8]) -> Result<Sha256Digest, ProviderCostSettlementError> {
    Sha256Digest::from_str(&format!("sha256:{}", hex::encode(Sha256::digest(bytes))))
        .map_err(|_| ProviderCostSettlementError::DigestConstruction)
}

#[derive(Debug, Error)]
pub enum ProviderCostSettlementError {
    #[error("provider-cost settlement policy is invalid")]
    InvalidPolicy,
    #[error("provider-cost settlement trust generation is invalid")]
    InvalidTrustGeneration,
    #[error("provider-cost settlement authority domain changed")]
    AuthorityDomainMismatch,
    #[error("provider-cost settlement trust generation changed")]
    TrustGenerationMismatch,
    #[error("unsupported provider-cost settlement version: {0}")]
    UnsupportedVersion(u16),
    #[error("provider-cost settlement identifier is invalid")]
    InvalidIdentifier,
    #[error("provider-cost settlement timestamp or generation is invalid")]
    InvalidTimestampOrGeneration,
    #[error("provider-cost settlement token usage is invalid")]
    InvalidTokenUsage,
    #[error("provider-cost settlement signer-key count is invalid")]
    InvalidSignerKeyCount,
    #[error("provider-cost settlement signer-key id is invalid")]
    InvalidSignerKeyId,
    #[error("provider-cost settlement signer-key is duplicated: {0}")]
    DuplicateSignerKey(String),
    #[error("provider-cost settlement signer-key is weak: {0}")]
    WeakSignerKey(String),
    #[error("provider-cost settlement signer-key is unknown: {0}")]
    UnknownSignerKey(String),
    #[error("provider-cost settlement signature encoding is invalid")]
    InvalidSignatureEncoding,
    #[error("provider-cost settlement signature was rejected")]
    SignatureRejected,
    #[error("provider-cost settlement is expired or from the future")]
    SettlementExpired,
    #[error("provider-cost settlement subject differs from the prepared operation")]
    SubjectMismatch,
    #[error("provider-cost settlement request is invalid")]
    RequestInvalid,
    #[error("provider-cost settlement prepared receipt is invalid")]
    PreparedReceiptInvalid,
    #[error("provider-cost settlement message is too large")]
    MessageTooLarge,
    #[error("failed to construct provider-cost settlement digest")]
    DigestConstruction,
}
