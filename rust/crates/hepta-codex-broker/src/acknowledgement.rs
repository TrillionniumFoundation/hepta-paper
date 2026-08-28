use std::{collections::BTreeMap, str::FromStr};

use base64ct::{Base64UrlUnpadded, Encoding};
use ed25519_dalek::{Signature, VerifyingKey};
use hepta_codex_journal::{OperationJournalV1, OperationState};
use hepta_codex_protocol::{CodexExecutionRequestV1, Sha256Digest};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;

use crate::{BrokerJournalError, BrokerJournalStoreV1, FaultInjectionPointV1};

const MAXIMUM_ACKNOWLEDGEMENT_KEYS: usize = 32;
const HARD_MAXIMUM_ACKNOWLEDGEMENT_AGE_MS: u64 = 24 * 60 * 60 * 1000;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreparedResultAcknowledgementV1 {
    pub version: u16,
    pub operation_id: String,
    pub request_hash: Sha256Digest,
    pub prepared_receipt_hash: Sha256Digest,
    pub campaign_id: String,
    pub node_id: String,
    pub attempt_id: String,
    pub campaign_revision: u64,
    pub lease_generation: u64,
    pub acknowledged_at_unix_ms: u64,
    pub signer_key_id: String,
    pub signature_base64: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PreparedResultAcknowledgementPolicyV1 {
    pub version: u16,
    pub maximum_age_ms: u64,
}

impl Default for PreparedResultAcknowledgementPolicyV1 {
    fn default() -> Self {
        Self {
            version: 1,
            maximum_age_ms: 5 * 60 * 1000,
        }
    }
}

impl PreparedResultAcknowledgementPolicyV1 {
    fn validate(self) -> Result<Self, PreparedResultAcknowledgementError> {
        if self.version != 1
            || self.maximum_age_ms == 0
            || self.maximum_age_ms > HARD_MAXIMUM_ACKNOWLEDGEMENT_AGE_MS
        {
            return Err(PreparedResultAcknowledgementError::InvalidPolicy);
        }
        Ok(self)
    }
}

#[derive(Clone, Debug)]
pub struct PreparedResultAcknowledgementTrustStoreV1 {
    keys: BTreeMap<String, VerifyingKey>,
}

impl PreparedResultAcknowledgementTrustStoreV1 {
    pub fn new<I>(entries: I) -> Result<Self, PreparedResultAcknowledgementError>
    where
        I: IntoIterator<Item = (String, VerifyingKey)>,
    {
        let mut keys = BTreeMap::new();
        for (key_id, key) in entries {
            if !valid_identifier(&key_id) {
                return Err(PreparedResultAcknowledgementError::InvalidSignerKeyId);
            }
            if key.is_weak() {
                return Err(PreparedResultAcknowledgementError::WeakSignerKey(key_id));
            }
            if keys.insert(key_id.clone(), key).is_some() {
                return Err(PreparedResultAcknowledgementError::DuplicateSignerKey(
                    key_id,
                ));
            }
        }
        if keys.is_empty() || keys.len() > MAXIMUM_ACKNOWLEDGEMENT_KEYS {
            return Err(PreparedResultAcknowledgementError::InvalidSignerKeyCount);
        }
        Ok(Self { keys })
    }

    fn get(&self, key_id: &str) -> Result<&VerifyingKey, PreparedResultAcknowledgementError> {
        self.keys
            .get(key_id)
            .ok_or_else(|| PreparedResultAcknowledgementError::UnknownSignerKey(key_id.to_owned()))
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VerifiedPreparedResultAcknowledgementV1 {
    acknowledgement: PreparedResultAcknowledgementV1,
    acknowledgement_hash: Sha256Digest,
}

impl VerifiedPreparedResultAcknowledgementV1 {
    #[must_use]
    pub fn acknowledgement(&self) -> &PreparedResultAcknowledgementV1 {
        &self.acknowledgement
    }

    #[must_use]
    pub fn acknowledgement_hash(&self) -> &Sha256Digest {
        &self.acknowledgement_hash
    }
}

pub fn prepared_result_acknowledgement_signing_bytes(
    acknowledgement: &PreparedResultAcknowledgementV1,
) -> Result<Vec<u8>, PreparedResultAcknowledgementError> {
    let mut writer = MessageWriter::new("HeptaPreparedResultAcknowledgementV1")?;
    writer.u64("version", u64::from(acknowledgement.version))?;
    writer.text("operationId", &acknowledgement.operation_id)?;
    writer.digest("requestHash", &acknowledgement.request_hash)?;
    writer.digest(
        "preparedReceiptHash",
        &acknowledgement.prepared_receipt_hash,
    )?;
    writer.text("campaignId", &acknowledgement.campaign_id)?;
    writer.text("nodeId", &acknowledgement.node_id)?;
    writer.text("attemptId", &acknowledgement.attempt_id)?;
    writer.u64("campaignRevision", acknowledgement.campaign_revision)?;
    writer.u64("leaseGeneration", acknowledgement.lease_generation)?;
    writer.u64(
        "acknowledgedAtUnixMs",
        acknowledgement.acknowledged_at_unix_ms,
    )?;
    writer.text("signerKeyId", &acknowledgement.signer_key_id)?;
    Ok(writer.finish())
}

#[allow(clippy::too_many_arguments)]
pub fn verify_prepared_result_acknowledgement(
    acknowledgement: &PreparedResultAcknowledgementV1,
    request: &CodexExecutionRequestV1,
    journal: &OperationJournalV1,
    now_unix_ms: u64,
    policy: PreparedResultAcknowledgementPolicyV1,
    trust_store: &PreparedResultAcknowledgementTrustStoreV1,
) -> Result<VerifiedPreparedResultAcknowledgementV1, PreparedResultAcknowledgementError> {
    let policy = policy.validate()?;
    validate_acknowledgement_shape(acknowledgement)?;
    if now_unix_ms == 0
        || acknowledgement.acknowledged_at_unix_ms > now_unix_ms
        || now_unix_ms - acknowledgement.acknowledged_at_unix_ms > policy.maximum_age_ms
    {
        return Err(PreparedResultAcknowledgementError::AcknowledgementExpired);
    }
    if journal.current_state != OperationState::ResultPrepared {
        return Err(PreparedResultAcknowledgementError::OperationNotPrepared);
    }
    let prepared_hash = journal
        .transitions
        .iter()
        .find(|transition| transition.to == OperationState::ResultPrepared)
        .and_then(|transition| transition.evidence_hash.as_ref())
        .ok_or(PreparedResultAcknowledgementError::PreparedReceiptMissing)?;
    if acknowledgement.operation_id != request.operation_id
        || acknowledgement.operation_id != journal.operation_id
        || acknowledgement.request_hash != journal.request_hash
        || acknowledgement.prepared_receipt_hash != *prepared_hash
        || acknowledgement.campaign_id != request.campaign_id
        || acknowledgement.node_id != request.node_id
        || acknowledgement.attempt_id != request.attempt_id
        || acknowledgement.campaign_revision != request.campaign_revision
        || acknowledgement.lease_generation != request.lease_generation
    {
        return Err(PreparedResultAcknowledgementError::SubjectMismatch);
    }

    let signing_bytes = prepared_result_acknowledgement_signing_bytes(acknowledgement)?;
    let signature_bytes = Base64UrlUnpadded::decode_vec(&acknowledgement.signature_base64)
        .map_err(|_| PreparedResultAcknowledgementError::InvalidSignatureEncoding)?;
    if Base64UrlUnpadded::encode_string(&signature_bytes) != acknowledgement.signature_base64 {
        return Err(PreparedResultAcknowledgementError::InvalidSignatureEncoding);
    }
    let signature = Signature::try_from(signature_bytes.as_slice())
        .map_err(|_| PreparedResultAcknowledgementError::InvalidSignatureEncoding)?;
    trust_store
        .get(&acknowledgement.signer_key_id)?
        .verify_strict(&signing_bytes, &signature)
        .map_err(|_| PreparedResultAcknowledgementError::SignatureRejected)?;
    Ok(VerifiedPreparedResultAcknowledgementV1 {
        acknowledgement: acknowledgement.clone(),
        acknowledgement_hash: sha256_digest(&signing_bytes)?,
    })
}

pub fn apply_prepared_result_acknowledgement(
    store: &mut BrokerJournalStoreV1,
    verified: &VerifiedPreparedResultAcknowledgementV1,
    fault: FaultInjectionPointV1,
) -> Result<OperationJournalV1, PreparedResultAcknowledgementError> {
    let acknowledgement = verified.acknowledgement();
    let journal = store.load_journal(&acknowledgement.operation_id)?;
    if journal.current_state != OperationState::ResultPrepared
        || journal.request_hash != acknowledgement.request_hash
        || journal
            .transitions
            .iter()
            .find(|transition| transition.to == OperationState::ResultPrepared)
            .and_then(|transition| transition.evidence_hash.as_ref())
            != Some(&acknowledgement.prepared_receipt_hash)
    {
        return Err(PreparedResultAcknowledgementError::SubjectMismatch);
    }
    store
        .append_transition(
            &acknowledgement.operation_id,
            OperationState::ResultPrepared,
            OperationState::Acknowledged,
            acknowledgement.acknowledged_at_unix_ms,
            Some(verified.acknowledgement_hash().clone()),
            None,
            fault,
        )
        .map_err(PreparedResultAcknowledgementError::Journal)
}

fn validate_acknowledgement_shape(
    acknowledgement: &PreparedResultAcknowledgementV1,
) -> Result<(), PreparedResultAcknowledgementError> {
    if acknowledgement.version != 1 {
        return Err(PreparedResultAcknowledgementError::UnsupportedVersion(
            acknowledgement.version,
        ));
    }
    for value in [
        acknowledgement.operation_id.as_str(),
        acknowledgement.campaign_id.as_str(),
        acknowledgement.node_id.as_str(),
        acknowledgement.attempt_id.as_str(),
        acknowledgement.signer_key_id.as_str(),
    ] {
        if !valid_identifier(value) {
            return Err(PreparedResultAcknowledgementError::InvalidIdentifier);
        }
    }
    if acknowledgement.lease_generation == 0 || acknowledgement.acknowledged_at_unix_ms == 0 {
        return Err(PreparedResultAcknowledgementError::InvalidTimestampOrGeneration);
    }
    Ok(())
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

struct MessageWriter {
    bytes: Vec<u8>,
}

impl MessageWriter {
    fn new(domain: &str) -> Result<Self, PreparedResultAcknowledgementError> {
        let mut writer = Self { bytes: Vec::new() };
        writer.raw(domain.as_bytes())?;
        Ok(writer)
    }

    fn raw(&mut self, value: &[u8]) -> Result<(), PreparedResultAcknowledgementError> {
        let length = u64::try_from(value.len())
            .map_err(|_| PreparedResultAcknowledgementError::MessageTooLarge)?;
        self.bytes.extend_from_slice(&length.to_be_bytes());
        self.bytes.extend_from_slice(value);
        Ok(())
    }

    fn text(
        &mut self,
        key: &str,
        value: &str,
    ) -> Result<(), PreparedResultAcknowledgementError> {
        self.raw(key.as_bytes())?;
        self.raw(value.as_bytes())
    }

    fn u64(
        &mut self,
        key: &str,
        value: u64,
    ) -> Result<(), PreparedResultAcknowledgementError> {
        self.raw(key.as_bytes())?;
        self.raw(&value.to_be_bytes())
    }

    fn digest(
        &mut self,
        key: &str,
        value: &Sha256Digest,
    ) -> Result<(), PreparedResultAcknowledgementError> {
        self.text(key, value.as_str())
    }

    fn finish(self) -> Vec<u8> {
        self.bytes
    }
}

fn sha256_digest(bytes: &[u8]) -> Result<Sha256Digest, PreparedResultAcknowledgementError> {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let value = format!("sha256:{}", hex::encode(hasher.finalize()));
    Sha256Digest::from_str(&value)
        .map_err(|_| PreparedResultAcknowledgementError::DigestConstruction)
}

#[derive(Debug, Error)]
pub enum PreparedResultAcknowledgementError {
    #[error("prepared-result acknowledgement policy is invalid")]
    InvalidPolicy,
    #[error("unsupported prepared-result acknowledgement version: {0}")]
    UnsupportedVersion(u16),
    #[error("prepared-result acknowledgement identifier is invalid")]
    InvalidIdentifier,
    #[error("prepared-result acknowledgement timestamp or generation is invalid")]
    InvalidTimestampOrGeneration,
    #[error("prepared-result acknowledgement is expired or from the future")]
    AcknowledgementExpired,
    #[error("prepared-result acknowledgement signer-key count is invalid")]
    InvalidSignerKeyCount,
    #[error("prepared-result acknowledgement signer-key id is invalid")]
    InvalidSignerKeyId,
    #[error("prepared-result acknowledgement signer-key is duplicated: {0}")]
    DuplicateSignerKey(String),
    #[error("prepared-result acknowledgement signer-key is weak: {0}")]
    WeakSignerKey(String),
    #[error("prepared-result acknowledgement signer-key is unknown: {0}")]
    UnknownSignerKey(String),
    #[error("prepared-result acknowledgement signature encoding is invalid")]
    InvalidSignatureEncoding,
    #[error("prepared-result acknowledgement signature was rejected")]
    SignatureRejected,
    #[error("operation is not in result_prepared state")]
    OperationNotPrepared,
    #[error("prepared-result receipt evidence is missing")]
    PreparedReceiptMissing,
    #[error("prepared-result acknowledgement subject differs from operation evidence")]
    SubjectMismatch,
    #[error("prepared-result acknowledgement message is too large")]
    MessageTooLarge,
    #[error("failed to construct acknowledgement digest")]
    DigestConstruction,
    #[error(transparent)]
    Journal(#[from] BrokerJournalError),
}
