//! Commit-bound acknowledgement of one broker-prepared result.
//!
//! The campaign sequencer remains the commit authority. This module only
//! verifies an independently signed statement that names the exact prepared
//! operation and the exact durable commit receipt, then reuses the existing
//! `ResultPrepared -> Acknowledged` broker-journal transition.

use std::{collections::BTreeMap, path::PathBuf, str::FromStr};

use base64ct::{Base64UrlUnpadded, Encoding};
use ed25519_dalek::{Signature, VerifyingKey};
use hepta_campaign_writer::{
    CampaignWriterPolicyV1, CampaignWriterStoreV1, ControlSnapshotScopeV1,
};
use hepta_codex_journal::{OperationJournalV1, OperationState};
use hepta_codex_protocol::{CodexExecutionRequestV1, Sha256Digest};
use hepta_control_plane::replay_control_log_v1;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;

use crate::{
    BrokerJournalError, BrokerJournalStoreV1, FaultInjectionPointV1, load_persisted_request,
};

const MAXIMUM_ACKNOWLEDGEMENT_KEYS: usize = 32;
const HARD_MAXIMUM_ACKNOWLEDGEMENT_AGE_MS: u64 = 24 * 60 * 60 * 1000;

/// Exact canonical campaign-writer identity which the broker may inspect. The
/// local and activated writer scopes are deliberately not interchangeable.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CommitBindingDatabaseScopeV2 {
    LocalOnly,
    ActivatedRustWriter,
}

impl From<CommitBindingDatabaseScopeV2> for ControlSnapshotScopeV1 {
    fn from(value: CommitBindingDatabaseScopeV2) -> Self {
        match value {
            CommitBindingDatabaseScopeV2::LocalOnly => Self::LocalOnly,
            CommitBindingDatabaseScopeV2::ActivatedRustWriter => Self::ActivatedRustWriter,
        }
    }
}

/// Resolves an acknowledgement's durable commit identity from the canonical
/// sequencer owner. Implementations have no signing or broker-journal authority.
pub trait CommitBindingResolverV2: Send + Sync {
    fn resolve_commit_binding(
        &self,
        subject: &PreparedResultAcknowledgementSubjectV2,
    ) -> Result<PreparedResultCommitBindingV2, CommitBoundAcknowledgementError>;
}

/// Read-only resolver over the existing campaign-writer SQLite control stream.
/// It reconstructs the full receipt chain through the control-plane replay
/// kernel; it does not trust acknowledgement-provided commit fields.
#[derive(Clone, Debug)]
pub struct SqliteCommitBindingResolverV2 {
    database_path: PathBuf,
    policy: CampaignWriterPolicyV1,
    scope: CommitBindingDatabaseScopeV2,
}

impl SqliteCommitBindingResolverV2 {
    pub fn new(
        database_path: PathBuf,
        owner_uid: u32,
        busy_timeout_ms: u64,
        maximum_database_bytes: u64,
        scope: CommitBindingDatabaseScopeV2,
    ) -> Result<Self, CommitBoundAcknowledgementError> {
        if !database_path.is_absolute()
            || busy_timeout_ms == 0
            || busy_timeout_ms > 30_000
            || maximum_database_bytes == 0
            || maximum_database_bytes > 16 * 1024 * 1024 * 1024
        {
            return Err(CommitBoundAcknowledgementError::CommitBindingPolicyInvalid);
        }
        Ok(Self {
            database_path,
            policy: CampaignWriterPolicyV1 {
                version: 1,
                owner_uid,
                busy_timeout_ms,
                maximum_database_bytes,
            },
            scope,
        })
    }

    #[must_use]
    pub fn database_path(&self) -> &std::path::Path {
        &self.database_path
    }
}

impl CommitBindingResolverV2 for SqliteCommitBindingResolverV2 {
    fn resolve_commit_binding(
        &self,
        subject: &PreparedResultAcknowledgementSubjectV2,
    ) -> Result<PreparedResultCommitBindingV2, CommitBoundAcknowledgementError> {
        let (_, log, _) = CampaignWriterStoreV1::read_control_snapshot(
            &self.database_path,
            self.policy,
            &subject.campaign_id,
            self.scope.into(),
        )
        .map_err(|_| CommitBoundAcknowledgementError::CommitBindingUnavailable)?;
        let receipts = replay_control_log_v1(&log)
            .map_err(|_| CommitBoundAcknowledgementError::CommitBindingUnavailable)?;
        if receipts.len() != log.entries.len() {
            return Err(CommitBoundAcknowledgementError::CommitBindingUnavailable);
        }
        let mut resolved = None;
        for (entry, receipt) in log.entries.iter().zip(receipts) {
            if entry.attempt_id != subject.attempt_id {
                continue;
            }
            if resolved.is_some() {
                return Err(CommitBoundAcknowledgementError::CommitBindingUnavailable);
            }
            resolved = Some(PreparedResultCommitBindingV2 {
                plan_hash: receipt.plan_hash,
                sequence: receipt.sequence,
                result_hash: receipt.result_hash,
                verifier_hash: receipt.verifier_hash,
                verification_receipt_hash: receipt.verification_receipt_hash,
                committed_state_hash: receipt.committed_state_hash,
                actual_cost_microusd: entry.actual_cost_microusd,
            });
        }
        resolved.ok_or(CommitBoundAcknowledgementError::CommitBindingUnavailable)
    }
}

/// Persisted broker subject which must match the original signed request and
/// prepared receipt. It deliberately contains no commit fact.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreparedResultAcknowledgementSubjectV2 {
    pub operation_id: String,
    pub request_hash: Sha256Digest,
    pub prepared_receipt_hash: Sha256Digest,
    pub campaign_id: String,
    pub node_id: String,
    pub attempt_id: String,
    pub campaign_revision: u64,
    pub lease_generation: u64,
}

/// Exact sequencer facts which an acknowledgement authority must independently
/// observe before signing. `newly_committed` is excluded because replay changes
/// that call-local flag without changing the durable commit identity.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreparedResultCommitBindingV2 {
    pub plan_hash: Sha256Digest,
    pub sequence: u64,
    pub result_hash: Sha256Digest,
    pub verifier_hash: Sha256Digest,
    pub verification_receipt_hash: Sha256Digest,
    pub committed_state_hash: Sha256Digest,
    pub actual_cost_microusd: u64,
}

/// Version-two acknowledgement: the original broker subject plus the complete
/// durable commit identity and settled provider cost.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CommitBoundPreparedResultAcknowledgementV2 {
    pub version: u16,
    pub authority_domain_id: String,
    pub trust_store_generation: u64,
    pub operation_id: String,
    pub request_hash: Sha256Digest,
    pub prepared_receipt_hash: Sha256Digest,
    pub campaign_id: String,
    pub node_id: String,
    pub attempt_id: String,
    pub campaign_revision: u64,
    pub lease_generation: u64,
    pub plan_hash: Sha256Digest,
    pub sequence: u64,
    pub result_hash: Sha256Digest,
    pub verifier_hash: Sha256Digest,
    pub verification_receipt_hash: Sha256Digest,
    pub committed_state_hash: Sha256Digest,
    pub actual_cost_microusd: u64,
    pub acknowledged_at_unix_ms: u64,
    pub signer_key_id: String,
    pub signature_base64: String,
}

impl CommitBoundPreparedResultAcknowledgementV2 {
    #[must_use]
    pub fn subject(&self) -> PreparedResultAcknowledgementSubjectV2 {
        PreparedResultAcknowledgementSubjectV2 {
            operation_id: self.operation_id.clone(),
            request_hash: self.request_hash.clone(),
            prepared_receipt_hash: self.prepared_receipt_hash.clone(),
            campaign_id: self.campaign_id.clone(),
            node_id: self.node_id.clone(),
            attempt_id: self.attempt_id.clone(),
            campaign_revision: self.campaign_revision,
            lease_generation: self.lease_generation,
        }
    }

    #[must_use]
    pub fn commit_binding(&self) -> PreparedResultCommitBindingV2 {
        PreparedResultCommitBindingV2 {
            plan_hash: self.plan_hash.clone(),
            sequence: self.sequence,
            result_hash: self.result_hash.clone(),
            verifier_hash: self.verifier_hash.clone(),
            verification_receipt_hash: self.verification_receipt_hash.clone(),
            committed_state_hash: self.committed_state_hash.clone(),
            actual_cost_microusd: self.actual_cost_microusd,
        }
    }

    pub(crate) fn validate_shape(&self) -> Result<(), CommitBoundAcknowledgementError> {
        if self.version != 2 {
            return Err(CommitBoundAcknowledgementError::UnsupportedVersion(
                self.version,
            ));
        }
        for value in [
            self.authority_domain_id.as_str(),
            self.operation_id.as_str(),
            self.campaign_id.as_str(),
            self.node_id.as_str(),
            self.attempt_id.as_str(),
            self.signer_key_id.as_str(),
        ] {
            if !valid_identifier(value) {
                return Err(CommitBoundAcknowledgementError::InvalidIdentifier);
            }
        }
        if self.trust_store_generation == 0
            || self.lease_generation == 0
            || self.sequence == 0
            || self.acknowledged_at_unix_ms == 0
            || self.signature_base64.is_empty()
        {
            return Err(CommitBoundAcknowledgementError::InvalidNumericField);
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CommitBoundAcknowledgementPolicyV2 {
    pub version: u16,
    pub maximum_age_ms: u64,
}

impl Default for CommitBoundAcknowledgementPolicyV2 {
    fn default() -> Self {
        Self {
            version: 2,
            maximum_age_ms: 5 * 60 * 1000,
        }
    }
}

impl CommitBoundAcknowledgementPolicyV2 {
    fn validate(self) -> Result<Self, CommitBoundAcknowledgementError> {
        if self.version != 2
            || self.maximum_age_ms == 0
            || self.maximum_age_ms > HARD_MAXIMUM_ACKNOWLEDGEMENT_AGE_MS
        {
            return Err(CommitBoundAcknowledgementError::InvalidPolicy);
        }
        Ok(self)
    }
}

#[derive(Clone, Debug)]
pub struct CommitBoundAcknowledgementTrustStoreV2 {
    authority_domain_id: String,
    generation: u64,
    keys: BTreeMap<String, VerifyingKey>,
}

impl CommitBoundAcknowledgementTrustStoreV2 {
    pub fn new<I>(
        authority_domain_id: String,
        generation: u64,
        entries: I,
    ) -> Result<Self, CommitBoundAcknowledgementError>
    where
        I: IntoIterator<Item = (String, VerifyingKey)>,
    {
        if !valid_identifier(&authority_domain_id) || generation == 0 {
            return Err(CommitBoundAcknowledgementError::InvalidTrustStore);
        }
        let mut keys = BTreeMap::new();
        for (key_id, key) in entries {
            if !valid_identifier(&key_id) {
                return Err(CommitBoundAcknowledgementError::InvalidSignerKeyId);
            }
            if key.is_weak() {
                return Err(CommitBoundAcknowledgementError::WeakSignerKey(key_id));
            }
            if keys.insert(key_id.clone(), key).is_some() {
                return Err(CommitBoundAcknowledgementError::DuplicateSignerKey(key_id));
            }
        }
        if keys.is_empty() || keys.len() > MAXIMUM_ACKNOWLEDGEMENT_KEYS {
            return Err(CommitBoundAcknowledgementError::InvalidSignerKeyCount);
        }
        Ok(Self {
            authority_domain_id,
            generation,
            keys,
        })
    }

    fn get(&self, key_id: &str) -> Result<&VerifyingKey, CommitBoundAcknowledgementError> {
        self.keys
            .get(key_id)
            .ok_or_else(|| CommitBoundAcknowledgementError::UnknownSignerKey(key_id.to_owned()))
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VerifiedCommitBoundAcknowledgementV2 {
    acknowledgement: CommitBoundPreparedResultAcknowledgementV2,
    acknowledgement_hash: Sha256Digest,
}

impl VerifiedCommitBoundAcknowledgementV2 {
    #[must_use]
    pub fn acknowledgement(&self) -> &CommitBoundPreparedResultAcknowledgementV2 {
        &self.acknowledgement
    }

    #[must_use]
    pub fn acknowledgement_hash(&self) -> &Sha256Digest {
        &self.acknowledgement_hash
    }
}

pub fn commit_bound_acknowledgement_signing_bytes_v2(
    acknowledgement: &CommitBoundPreparedResultAcknowledgementV2,
) -> Result<Vec<u8>, CommitBoundAcknowledgementError> {
    let mut writer = MessageWriter::new("HeptaCommitBoundPreparedResultAcknowledgementV2")?;
    writer.u64("version", u64::from(acknowledgement.version))?;
    writer.text("authorityDomainId", &acknowledgement.authority_domain_id)?;
    writer.u64(
        "trustStoreGeneration",
        acknowledgement.trust_store_generation,
    )?;
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
    writer.digest("planHash", &acknowledgement.plan_hash)?;
    writer.u64("sequence", acknowledgement.sequence)?;
    writer.digest("resultHash", &acknowledgement.result_hash)?;
    writer.digest("verifierHash", &acknowledgement.verifier_hash)?;
    writer.digest(
        "verificationReceiptHash",
        &acknowledgement.verification_receipt_hash,
    )?;
    writer.digest("committedStateHash", &acknowledgement.committed_state_hash)?;
    writer.u64("actualCostMicrousd", acknowledgement.actual_cost_microusd)?;
    writer.u64(
        "acknowledgedAtUnixMs",
        acknowledgement.acknowledged_at_unix_ms,
    )?;
    writer.text("signerKeyId", &acknowledgement.signer_key_id)?;
    Ok(writer.finish())
}

pub fn commit_bound_acknowledgement_hash_v2(
    acknowledgement: &CommitBoundPreparedResultAcknowledgementV2,
) -> Result<Sha256Digest, CommitBoundAcknowledgementError> {
    sha256_digest(&commit_bound_acknowledgement_signing_bytes_v2(
        acknowledgement,
    )?)
}

pub fn verify_commit_bound_acknowledgement_subject_v2(
    acknowledgement: &CommitBoundPreparedResultAcknowledgementV2,
    subject: &PreparedResultAcknowledgementSubjectV2,
    commit: &PreparedResultCommitBindingV2,
    now_unix_ms: u64,
    policy: CommitBoundAcknowledgementPolicyV2,
    trust_store: &CommitBoundAcknowledgementTrustStoreV2,
) -> Result<VerifiedCommitBoundAcknowledgementV2, CommitBoundAcknowledgementError> {
    verify_common(acknowledgement, now_unix_ms, policy, trust_store)?;
    if acknowledgement.subject() != *subject || acknowledgement.commit_binding() != *commit {
        return Err(CommitBoundAcknowledgementError::SubjectMismatch);
    }
    verify_signature(acknowledgement, trust_store)
}

pub fn verify_persisted_commit_bound_acknowledgement_v2(
    store: &BrokerJournalStoreV1,
    acknowledgement: &CommitBoundPreparedResultAcknowledgementV2,
    commit: &PreparedResultCommitBindingV2,
    now_unix_ms: u64,
    policy: CommitBoundAcknowledgementPolicyV2,
    trust_store: &CommitBoundAcknowledgementTrustStoreV2,
) -> Result<VerifiedCommitBoundAcknowledgementV2, CommitBoundAcknowledgementError> {
    let request = load_persisted_request(store, &acknowledgement.operation_id)?;
    let journal = store.load_journal(&acknowledgement.operation_id)?;
    verify_common(acknowledgement, now_unix_ms, policy, trust_store)?;
    validate_persisted_subject(acknowledgement, &request, &journal)?;
    validate_commit_binding(acknowledgement, commit)?;
    verify_signature(acknowledgement, trust_store)
}

pub fn apply_commit_bound_acknowledgement_v2(
    store: &mut BrokerJournalStoreV1,
    verified: &VerifiedCommitBoundAcknowledgementV2,
    commit: &PreparedResultCommitBindingV2,
    fault: FaultInjectionPointV1,
) -> Result<OperationJournalV1, CommitBoundAcknowledgementError> {
    let acknowledgement = verified.acknowledgement();
    let request = load_persisted_request(store, &acknowledgement.operation_id)?;
    let journal = store.load_journal(&acknowledgement.operation_id)?;
    validate_persisted_subject(acknowledgement, &request, &journal)?;
    validate_commit_binding(acknowledgement, commit)?;
    if journal.current_state == OperationState::Acknowledged {
        return Ok(journal);
    }
    match store.append_transition(
        &acknowledgement.operation_id,
        OperationState::ResultPrepared,
        OperationState::Acknowledged,
        acknowledgement.acknowledged_at_unix_ms,
        Some(verified.acknowledgement_hash().clone()),
        None,
        fault,
    ) {
        Ok(journal) => Ok(journal),
        Err(BrokerJournalError::StateConflict {
            expected: OperationState::ResultPrepared,
            observed: OperationState::Acknowledged,
        }) => {
            let observed = store.load_journal(&acknowledgement.operation_id)?;
            validate_persisted_subject(acknowledgement, &request, &observed)?;
            if observed.current_state != OperationState::Acknowledged {
                return Err(CommitBoundAcknowledgementError::OperationNotPrepared);
            }
            Ok(observed)
        }
        Err(error) => Err(CommitBoundAcknowledgementError::Journal(error)),
    }
}

fn validate_commit_binding(
    acknowledgement: &CommitBoundPreparedResultAcknowledgementV2,
    commit: &PreparedResultCommitBindingV2,
) -> Result<(), CommitBoundAcknowledgementError> {
    if acknowledgement.commit_binding() != *commit {
        return Err(CommitBoundAcknowledgementError::SubjectMismatch);
    }
    Ok(())
}

fn verify_common(
    acknowledgement: &CommitBoundPreparedResultAcknowledgementV2,
    now_unix_ms: u64,
    policy: CommitBoundAcknowledgementPolicyV2,
    trust_store: &CommitBoundAcknowledgementTrustStoreV2,
) -> Result<(), CommitBoundAcknowledgementError> {
    let policy = policy.validate()?;
    acknowledgement.validate_shape()?;
    if acknowledgement.authority_domain_id != trust_store.authority_domain_id
        || acknowledgement.trust_store_generation != trust_store.generation
    {
        return Err(CommitBoundAcknowledgementError::TrustStoreMismatch);
    }
    if now_unix_ms == 0
        || acknowledgement.acknowledged_at_unix_ms > now_unix_ms
        || now_unix_ms - acknowledgement.acknowledged_at_unix_ms > policy.maximum_age_ms
    {
        return Err(CommitBoundAcknowledgementError::AcknowledgementExpired);
    }
    Ok(())
}

fn validate_persisted_subject(
    acknowledgement: &CommitBoundPreparedResultAcknowledgementV2,
    request: &CodexExecutionRequestV1,
    journal: &OperationJournalV1,
) -> Result<(), CommitBoundAcknowledgementError> {
    if !matches!(
        journal.current_state,
        OperationState::ResultPrepared | OperationState::Acknowledged
    ) {
        return Err(CommitBoundAcknowledgementError::OperationNotPrepared);
    }
    let prepared_hash = journal
        .transitions
        .iter()
        .find(|transition| transition.to == OperationState::ResultPrepared)
        .and_then(|transition| transition.evidence_hash.as_ref())
        .ok_or(CommitBoundAcknowledgementError::PreparedReceiptMissing)?;
    if acknowledgement.operation_id != request.operation_id
        || acknowledgement.operation_id != journal.operation_id
        || acknowledgement.request_hash != journal.request_hash
        || acknowledgement.prepared_receipt_hash != *prepared_hash
        || acknowledgement.campaign_id != request.campaign_id
        || acknowledgement.node_id != request.node_id
        || acknowledgement.attempt_id != request.attempt_id
        || acknowledgement.campaign_revision != request.campaign_revision
        || acknowledgement.lease_generation != request.lease_generation
        || acknowledgement.actual_cost_microusd > request.maximum_cost_microusd
    {
        return Err(CommitBoundAcknowledgementError::SubjectMismatch);
    }
    if journal.current_state == OperationState::Acknowledged {
        let terminal = journal
            .transitions
            .last()
            .filter(|transition| transition.to == OperationState::Acknowledged)
            .ok_or(CommitBoundAcknowledgementError::OperationNotPrepared)?;
        let expected = commit_bound_acknowledgement_hash_v2(acknowledgement)?;
        if terminal.evidence_hash.as_ref() != Some(&expected)
            || terminal.recorded_at_unix_ms != acknowledgement.acknowledged_at_unix_ms
        {
            return Err(CommitBoundAcknowledgementError::SubjectMismatch);
        }
    }
    Ok(())
}

fn verify_signature(
    acknowledgement: &CommitBoundPreparedResultAcknowledgementV2,
    trust_store: &CommitBoundAcknowledgementTrustStoreV2,
) -> Result<VerifiedCommitBoundAcknowledgementV2, CommitBoundAcknowledgementError> {
    let signing_bytes = commit_bound_acknowledgement_signing_bytes_v2(acknowledgement)?;
    let signature_bytes = Base64UrlUnpadded::decode_vec(&acknowledgement.signature_base64)
        .map_err(|_| CommitBoundAcknowledgementError::InvalidSignatureEncoding)?;
    if Base64UrlUnpadded::encode_string(&signature_bytes) != acknowledgement.signature_base64 {
        return Err(CommitBoundAcknowledgementError::InvalidSignatureEncoding);
    }
    let signature = Signature::try_from(signature_bytes.as_slice())
        .map_err(|_| CommitBoundAcknowledgementError::InvalidSignatureEncoding)?;
    trust_store
        .get(&acknowledgement.signer_key_id)?
        .verify_strict(&signing_bytes, &signature)
        .map_err(|_| CommitBoundAcknowledgementError::SignatureRejected)?;
    Ok(VerifiedCommitBoundAcknowledgementV2 {
        acknowledgement: acknowledgement.clone(),
        acknowledgement_hash: sha256_digest(&signing_bytes)?,
    })
}

fn valid_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':'))
}

struct MessageWriter {
    bytes: Vec<u8>,
}

impl MessageWriter {
    fn new(domain: &str) -> Result<Self, CommitBoundAcknowledgementError> {
        let mut value = Self { bytes: Vec::new() };
        value.raw(domain.as_bytes())?;
        Ok(value)
    }

    fn raw(&mut self, value: &[u8]) -> Result<(), CommitBoundAcknowledgementError> {
        let length = u64::try_from(value.len())
            .map_err(|_| CommitBoundAcknowledgementError::MessageTooLarge)?;
        self.bytes.extend_from_slice(&length.to_be_bytes());
        self.bytes.extend_from_slice(value);
        if self.bytes.len() > 1024 * 1024 {
            return Err(CommitBoundAcknowledgementError::MessageTooLarge);
        }
        Ok(())
    }

    fn text(&mut self, key: &str, value: &str) -> Result<(), CommitBoundAcknowledgementError> {
        self.raw(key.as_bytes())?;
        self.raw(value.as_bytes())
    }

    fn u64(&mut self, key: &str, value: u64) -> Result<(), CommitBoundAcknowledgementError> {
        self.raw(key.as_bytes())?;
        self.raw(&value.to_be_bytes())
    }

    fn digest(
        &mut self,
        key: &str,
        value: &Sha256Digest,
    ) -> Result<(), CommitBoundAcknowledgementError> {
        self.text(key, value.as_str())
    }

    fn finish(self) -> Vec<u8> {
        self.bytes
    }
}

fn sha256_digest(bytes: &[u8]) -> Result<Sha256Digest, CommitBoundAcknowledgementError> {
    Sha256Digest::from_str(&format!("sha256:{}", hex::encode(Sha256::digest(bytes))))
        .map_err(|_| CommitBoundAcknowledgementError::DigestConstruction)
}

#[derive(Debug, Error)]
pub enum CommitBoundAcknowledgementError {
    #[error("commit-bound acknowledgement policy is invalid")]
    InvalidPolicy,
    #[error("commit-binding resolver policy is invalid")]
    CommitBindingPolicyInvalid,
    #[error("canonical sequencer commit binding is unavailable or invalid")]
    CommitBindingUnavailable,
    #[error("commit-bound acknowledgement trust store is invalid")]
    InvalidTrustStore,
    #[error("commit-bound acknowledgement version is unsupported: {0}")]
    UnsupportedVersion(u16),
    #[error("commit-bound acknowledgement identifier is invalid")]
    InvalidIdentifier,
    #[error("commit-bound acknowledgement numeric field is invalid")]
    InvalidNumericField,
    #[error("commit-bound acknowledgement signer-key count is invalid")]
    InvalidSignerKeyCount,
    #[error("commit-bound acknowledgement signer-key id is invalid")]
    InvalidSignerKeyId,
    #[error("commit-bound acknowledgement signer-key is duplicated: {0}")]
    DuplicateSignerKey(String),
    #[error("commit-bound acknowledgement signer-key is weak: {0}")]
    WeakSignerKey(String),
    #[error("commit-bound acknowledgement signer-key is unknown: {0}")]
    UnknownSignerKey(String),
    #[error("commit-bound acknowledgement trust generation/domain does not match")]
    TrustStoreMismatch,
    #[error("commit-bound acknowledgement is expired or from the future")]
    AcknowledgementExpired,
    #[error("commit-bound acknowledgement operation is not prepared")]
    OperationNotPrepared,
    #[error("commit-bound acknowledgement prepared receipt is missing")]
    PreparedReceiptMissing,
    #[error("commit-bound acknowledgement subject does not match")]
    SubjectMismatch,
    #[error("commit-bound acknowledgement signature encoding is invalid")]
    InvalidSignatureEncoding,
    #[error("commit-bound acknowledgement signature was rejected")]
    SignatureRejected,
    #[error("commit-bound acknowledgement message is too large")]
    MessageTooLarge,
    #[error("commit-bound acknowledgement digest construction failed")]
    DigestConstruction,
    #[error(transparent)]
    Journal(#[from] BrokerJournalError),
}
