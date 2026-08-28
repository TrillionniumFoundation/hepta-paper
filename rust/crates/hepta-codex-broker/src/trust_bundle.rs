use std::{
    collections::{BTreeMap, BTreeSet},
    str::FromStr,
    sync::RwLock,
};

use base64ct::{Base64UrlUnpadded, Encoding};
use ed25519_dalek::{Signature, VerifyingKey};
use hepta_codex_protocol::{AgentRole, Sha256Digest};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;

use crate::{CapabilityTrustStoreV1, CapabilityVerificationError};

const MAXIMUM_BUNDLE_KEYS: usize = 64;
const MAXIMUM_BUNDLE_REVOCATIONS: usize = 256;
const MAXIMUM_BUNDLE_LIFETIME_MS: u64 = 90 * 24 * 60 * 60 * 1000;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CapabilityTrustKeyV1 {
    pub key_id: String,
    pub public_key_base64: String,
    pub valid_from_unix_ms: u64,
    pub valid_until_unix_ms: u64,
    pub allowed_roles: Vec<AgentRole>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CapabilityKeyRevocationV1 {
    pub key_id: String,
    pub effective_at_unix_ms: u64,
    pub reason_code: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CapabilityTrustBundleV1 {
    pub version: u16,
    pub generation: u64,
    pub issuer_id: String,
    pub valid_from_unix_ms: u64,
    pub valid_until_unix_ms: u64,
    pub minimum_accepted_generation: u64,
    pub previous_bundle_hash: Option<Sha256Digest>,
    pub keys: Vec<CapabilityTrustKeyV1>,
    pub revocations: Vec<CapabilityKeyRevocationV1>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SignedCapabilityTrustBundleV1 {
    pub bundle: CapabilityTrustBundleV1,
    pub authority_key_id: String,
    pub signature_base64: String,
}

#[derive(Clone, Debug)]
pub struct CapabilityBundleAuthorityV1 {
    keys: BTreeMap<String, VerifyingKey>,
}

impl CapabilityBundleAuthorityV1 {
    pub fn new<I>(entries: I) -> Result<Self, TrustBundleError>
    where
        I: IntoIterator<Item = (String, VerifyingKey)>,
    {
        let mut keys = BTreeMap::new();
        for (key_id, key) in entries {
            if !valid_identifier(&key_id) {
                return Err(TrustBundleError::InvalidAuthorityKeyId);
            }
            if key.is_weak() {
                return Err(TrustBundleError::WeakAuthorityKey(key_id));
            }
            if keys.insert(key_id.clone(), key).is_some() {
                return Err(TrustBundleError::DuplicateAuthorityKey(key_id));
            }
        }
        if keys.is_empty() || keys.len() > MAXIMUM_BUNDLE_KEYS {
            return Err(TrustBundleError::InvalidAuthorityKeyCount);
        }
        Ok(Self { keys })
    }

    fn get(&self, key_id: &str) -> Result<&VerifyingKey, TrustBundleError> {
        self.keys
            .get(key_id)
            .ok_or_else(|| TrustBundleError::UnknownAuthorityKey(key_id.to_owned()))
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AcceptedCapabilityTrustCheckpointV1 {
    generation: u64,
    minimum_accepted_generation: u64,
    bundle_hash: Sha256Digest,
}

impl AcceptedCapabilityTrustCheckpointV1 {
    #[must_use]
    pub fn generation(&self) -> u64 {
        self.generation
    }

    #[must_use]
    pub fn minimum_accepted_generation(&self) -> u64 {
        self.minimum_accepted_generation
    }

    #[must_use]
    pub fn bundle_hash(&self) -> &Sha256Digest {
        &self.bundle_hash
    }
}

#[derive(Clone, Debug)]
pub struct VerifiedCapabilityTrustBundleV1 {
    role: AgentRole,
    generation: u64,
    minimum_accepted_generation: u64,
    bundle_hash: Sha256Digest,
    previous_bundle_hash: Option<Sha256Digest>,
    valid_from_unix_ms: u64,
    valid_until_unix_ms: u64,
    trust_store: CapabilityTrustStoreV1,
}

impl VerifiedCapabilityTrustBundleV1 {
    #[must_use]
    pub fn role(&self) -> AgentRole {
        self.role
    }

    #[must_use]
    pub fn generation(&self) -> u64 {
        self.generation
    }

    #[must_use]
    pub fn minimum_accepted_generation(&self) -> u64 {
        self.minimum_accepted_generation
    }

    #[must_use]
    pub fn bundle_hash(&self) -> &Sha256Digest {
        &self.bundle_hash
    }

    #[must_use]
    pub fn previous_bundle_hash(&self) -> Option<&Sha256Digest> {
        self.previous_bundle_hash.as_ref()
    }

    #[must_use]
    pub fn valid_until_unix_ms(&self) -> u64 {
        self.valid_until_unix_ms
    }

    #[must_use]
    pub fn checkpoint(&self) -> AcceptedCapabilityTrustCheckpointV1 {
        AcceptedCapabilityTrustCheckpointV1 {
            generation: self.generation,
            minimum_accepted_generation: self.minimum_accepted_generation,
            bundle_hash: self.bundle_hash.clone(),
        }
    }

    pub(crate) fn trust_store(&self) -> CapabilityTrustStoreV1 {
        self.trust_store.clone()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TrustBundleDisableReasonV1 {
    OperatorStop,
    RefreshRejected,
    Expired,
}

#[derive(Clone, Debug)]
enum TrustBundleManagerStateV1 {
    Active(VerifiedCapabilityTrustBundleV1),
    Disabled {
        checkpoint: AcceptedCapabilityTrustCheckpointV1,
        reason: TrustBundleDisableReasonV1,
    },
}

pub struct CapabilityTrustBundleManagerV1 {
    role: AgentRole,
    state: RwLock<TrustBundleManagerStateV1>,
}

impl CapabilityTrustBundleManagerV1 {
    #[must_use]
    pub fn new(initial: VerifiedCapabilityTrustBundleV1) -> Self {
        Self {
            role: initial.role,
            state: RwLock::new(TrustBundleManagerStateV1::Active(initial)),
        }
    }

    pub fn snapshot(
        &self,
        now_unix_ms: u64,
    ) -> Result<(CapabilityTrustStoreV1, u64, Sha256Digest), TrustBundleError> {
        if now_unix_ms == 0 {
            return Err(TrustBundleError::InvalidCurrentTime);
        }
        let mut state = self
            .state
            .write()
            .map_err(|_| TrustBundleError::ManagerLockPoisoned)?;
        let checkpoint = match &*state {
            TrustBundleManagerStateV1::Active(bundle)
                if now_unix_ms >= bundle.valid_from_unix_ms
                    && now_unix_ms < bundle.valid_until_unix_ms =>
            {
                return Ok((
                    bundle.trust_store(),
                    bundle.generation,
                    bundle.bundle_hash.clone(),
                ));
            }
            TrustBundleManagerStateV1::Active(bundle) => bundle.checkpoint(),
            TrustBundleManagerStateV1::Disabled { reason, .. } => {
                return Err(TrustBundleError::ManagerDisabled(*reason));
            }
        };
        *state = TrustBundleManagerStateV1::Disabled {
            checkpoint,
            reason: TrustBundleDisableReasonV1::Expired,
        };
        Err(TrustBundleError::ManagerDisabled(
            TrustBundleDisableReasonV1::Expired,
        ))
    }

    pub fn install(
        &self,
        envelope: &SignedCapabilityTrustBundleV1,
        now_unix_ms: u64,
        authority: &CapabilityBundleAuthorityV1,
    ) -> Result<VerifiedCapabilityTrustBundleV1, TrustBundleError> {
        let mut state = self
            .state
            .write()
            .map_err(|_| TrustBundleError::ManagerLockPoisoned)?;
        let checkpoint = match &*state {
            TrustBundleManagerStateV1::Active(bundle) => bundle.checkpoint(),
            TrustBundleManagerStateV1::Disabled { checkpoint, .. } => checkpoint.clone(),
        };
        match verify_capability_trust_bundle(
            envelope,
            self.role,
            now_unix_ms,
            authority,
            Some(&checkpoint),
        ) {
            Ok(verified) => {
                *state = TrustBundleManagerStateV1::Active(verified.clone());
                Ok(verified)
            }
            Err(error) => {
                *state = TrustBundleManagerStateV1::Disabled {
                    checkpoint,
                    reason: TrustBundleDisableReasonV1::RefreshRejected,
                };
                Err(error)
            }
        }
    }

    pub fn disable(&self) -> Result<(), TrustBundleError> {
        let mut state = self
            .state
            .write()
            .map_err(|_| TrustBundleError::ManagerLockPoisoned)?;
        let checkpoint = match &*state {
            TrustBundleManagerStateV1::Active(bundle) => bundle.checkpoint(),
            TrustBundleManagerStateV1::Disabled { checkpoint, .. } => checkpoint.clone(),
        };
        *state = TrustBundleManagerManagerStateV1::Disabled {
            checkpoint,
            reason: TrustBundleDisableReasonV1::OperatorStop,
        };
        Ok(())
    }
}

pub fn verify_capability_trust_bundle(
    envelope: &SignedCapabilityTrustBundleV1,
    role: AgentRole,
    now_unix_ms: u64,
    authority: &CapabilityBundleAuthorityV1,
    previous: Option<&AcceptedCapabilityTrustCheckpointV1>,
) -> Result<VerifiedCapabilityTrustBundleV1, TrustBundleError> {
    if now_unix_ms == 0 {
        return Err(TrustBundleError::InvalidCurrentTime);
    }
    validate_bundle_shape(&envelope.bundle)?;
    validate_bundle_chain(&envelope.bundle, previous)?;
    if now_unix_ms < envelope.bundle.valid_from_unix_ms {
        return Err(TrustBundleError::BundleNotYetValid);
    }
    if now_unix_ms >= envelope.bundle.valid_until_unix_ms {
        return Err(TrustBundleError::BundleExpired);
    }
    if !valid_identifier(&envelope.authority_key_id) {
        return Err(TrustBundleError::InvalidAuthorityKeyId);
    }
    let signing_bytes = trust_bundle_signing_bytes(&envelope.bundle)?;
    let signature_bytes = Base64UrlUnpadded::decode_vec(&envelope.signature_base64)
        .map_err(|_| TrustBundleError::InvalidBundleSignatureEncoding)?;
    if Base64UrlUnpadded::encode_string(&signature_bytes) != envelope.signature_base64 {
        return Err(TrustBundleError::InvalidBundleSignatureEncoding);
    }
    let signature = Signature::try_from(signature_bytes.as_slice())
        .map_err(|_| TrustBundleError::InvalidBundleSignatureEncoding)?;
    authority
        .get(&envelope.authority_key_id)?
        .verify_strict(&signing_bytes, &signature)
        .map_err(|_| TrustBundleError::BundleSignatureRejected)?;

    let revocations = envelope
        .bundle
        .revocations
        .iter()
        .map(|item| (item.key_id.as_str(), item.effective_at_unix_ms))
        .collect::<BTreeMap<_, _>>();
    let mut active = Vec::new();
    for item in &envelope.bundle.keys {
        let key = decode_verifying_key(item)?;
        if !item.allowed_roles.contains(&role)
            || now_unix_ms < item.valid_from_unix_ms
            || now_unix_ms >= item.valid_until_unix_ms
            || revocations
                .get(item.key_id.as_str())
                .is_some_and(|effective| now_unix_ms >= *effective)
        {
            continue;
        }
        active.push((item.key_id.clone(), key));
    }
    if active.is_empty() {
        return Err(TrustBundleError::NoActiveRoleKey(role));
    }
    let trust_store = CapabilityTrustStoreV1::new(active)
        .map_err(TrustBundleError::CapabilityTrustStore)?;
    let bundle_hash = sha256_digest(&signing_bytes)?;
    Ok(VerifiedCapabilityTrustBundleV1 {
        role,
        generation: envelope.bundle.generation,
        minimum_accepted_generation: envelope.bundle.minimum_accepted_generation,
        bundle_hash,
        previous_bundle_hash: envelope.bundle.previous_bundle_hash.clone(),
        valid_from_unix_ms: envelope.bundle.valid_from_unix_ms,
        valid_until_unix_ms: envelope.bundle.valid_until_unix_ms,
        trust_store,
    })
}

pub fn trust_bundle_signing_bytes(
    bundle: &CapabilityTrustBundleV1,
) -> Result<Vec<u8>, TrustBundleError> {
    let mut writer = BundleWriter::new("HeptaCapabilityTrustBundleV1")?;
    writer.u64("version", u64::from(bundle.version))?;
    writer.u64("generation", bundle.generation)?;
    writer.text("issuerId", &bundle.issuer_id)?;
    writer.u64("validFromUnixMs", bundle.valid_from_unix_ms)?;
    writer.u64("validUntilUnixMs", bundle.valid_until_unix_ms)?;
    writer.u64(
        "minimumAcceptedGeneration",
        bundle.minimum_accepted_generation,
    )?;
    writer.optional_digest("previousBundleHash", bundle.previous_bundle_hash.as_ref())?;
    for key in &bundle.keys {
        writer.text("keyId", &key.key_id)?;
        writer.text("publicKeyBase64", &key.public_key_base64)?;
        writer.u64("keyValidFromUnixMs", key.valid_from_unix_ms)?;
        writer.u64("keyValidUntilUnixMs", key.valid_until_unix_ms)?;
        for role in &key.allowed_roles {
            writer.text("allowedRole", role_name(*role))?;
        }
        writer.raw(b"keyEnd")?;
    }
    for revocation in &bundle.revocations {
        writer.text("revokedKeyId", &revocation.key_id)?;
        writer.u64("revocationEffectiveAtUnixMs", revocation.effective_at_unix_ms)?;
        writer.text("revocationReasonCode", &revocation.reason_code)?;
        writer.raw(b"revocationEnd")?;
    }
    Ok(writer.finish())
}

fn validate_bundle_shape(bundle: &CapabilityTrustBundleV1) -> Result<(), TrustBundleError> {
    if bundle.version != 1 {
        return Err(TrustBundleError::UnsupportedBundleVersion(bundle.version));
    }
    if bundle.generation == 0
        || bundle.minimum_accepted_generation == 0
        || bundle.minimum_accepted_generation > bundle.generation
        || bundle.valid_from_unix_ms == 0
        || bundle.valid_until_unix_ms <= bundle.valid_from_unix_ms
        || bundle.valid_until_unix_ms - bundle.valid_from_unix_ms > MAXIMUM_BUNDLE_LIFETIME_MS
        || !valid_identifier(&bundle.issuer_id)
    {
        return Err(TrustBundleError::InvalidBundleShape);
    }
    if bundle.keys.is_empty() || bundle.keys.len() > MAXIMUM_BUNDLE_KEYS {
        return Err(TrustBundleError::InvalidBundleKeyCount);
    }
    if bundle.revocations.len() > MAXIMUM_BUNDLE_REVOCATIONS {
        return Err(TrustBundleError::InvalidRevocationCount);
    }
    if !strictly_sorted_by_key(&bundle.keys, |item| item.key_id.as_str())
        || !strictly_sorted_by_key(&bundle.revocations, |item| item.key_id.as_str())
    {
        return Err(TrustBundleError::NonCanonicalBundleOrdering);
    }
    let mut key_ids = BTreeSet::new();
    for key in &bundle.keys {
        if !valid_identifier(&key.key_id)
            || !key_ids.insert(key.key_id.clone())
            || key.valid_from_unix_ms < bundle.valid_from_unix_ms
            || key.valid_until_unix_ms > bundle.valid_until_unix_ms
            || key.valid_until_unix_ms <= key.valid_from_unix_ms
            || key.allowed_roles.is_empty()
        {
            return Err(TrustBundleError::InvalidBundleKey(key.key_id.clone()));
        }
        let mut roles = BTreeSet::new();
        for role in &key.allowed_roles {
            if !roles.insert(role_name(*role)) {
                return Err(TrustBundleError::DuplicateKeyRole(key.key_id.clone()));
            }
        }
        let _ = decode_verifying_key(key)?;
    }
    let mut revoked = BTreeSet::new();
    for revocation in &bundle.revocations {
        if !key_ids.contains(&revocation.key_id)
            || !revoked.insert(revocation.key_id.clone())
            || revocation.effective_at_unix_ms < bundle.valid_from_unix_ms
            || revocation.effective_at_unix_ms >= bundle.valid_until_unix_ms
            || !valid_reason_code(&revocation.reason_code)
        {
            return Err(TrustBundleError::InvalidRevocation(
                revocation.key_id.clone(),
            ));
        }
    }
    Ok(())
}

fn validate_bundle_chain(
    bundle: &CapabilityTrustBundleV1,
    previous: Option<&AcceptedCapabilityTrustCheckpointV1>,
) -> Result<(), TrustBundleError> {
    match previous {
        None => {
            if bundle.previous_bundle_hash.is_some()
                || bundle.minimum_accepted_generation != bundle.generation
            {
                return Err(TrustBundleError::InvalidBootstrapChain);
            }
        }
        Some(previous) => {
            if bundle.generation != previous.generation.saturating_add(1)
                || bundle.previous_bundle_hash.as_ref() != Some(&previous.bundle_hash)
                || bundle.minimum_accepted_generation < previous.minimum_accepted_generation
                || bundle.minimum_accepted_generation > bundle.generation
            {
                return Err(TrustBundleError::BundleRollbackOrChainMismatch);
            }
        }
    }
    Ok(())
}

fn decode_verifying_key(item: &CapabilityTrustKeyV1) -> Result<VerifyingKey, TrustBundleError> {
    let bytes = Base64UrlUnpadded::decode_vec(&item.public_key_base64)
        .map_err(|_| TrustBundleError::InvalidVerificationKeyEncoding(item.key_id.clone()))?;
    if Base64UrlUnpadded::encode_string(&bytes) != item.public_key_base64 {
        return Err(TrustBundleError::InvalidVerificationKeyEncoding(
            item.key_id.clone(),
        ));
    }
    let bytes: [u8; 32] = bytes
        .try_into()
        .map_err(|_| TrustBundleError::InvalidVerificationKeyEncoding(item.key_id.clone()))?;
    let key = VerifyingKey::from_bytes(&bytes)
        .map_err(|_| TrustBundleError::InvalidVerificationKeyEncoding(item.key_id.clone()))?;
    if key.is_weak() {
        return Err(TrustBundleError::WeakVerificationKey(item.key_id.clone()));
    }
    Ok(key)
}

fn strictly_sorted_by_key<T, F>(items: &[T], key: F) -> bool
where
    F: Fn(&T) -> &str,
{
    items.windows(2).all(|window| key(&window[0]) < key(&window[1]))
}

fn role_name(role: AgentRole) -> &'static str {
    match role {
        AgentRole::Author => "author",
        AgentRole::Reviewer => "reviewer",
        AgentRole::FormalReviewer => "formal_reviewer",
        AgentRole::Repairer => "repairer",
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

fn valid_reason_code(value: &str) -> bool {
    valid_identifier(value) && value.bytes().all(|byte| !byte.is_ascii_uppercase())
}

struct BundleWriter {
    bytes: Vec<u8>,
}

impl BundleWriter {
    fn new(domain: &str) -> Result<Self, TrustBundleError> {
        let mut writer = Self { bytes: Vec::new() };
        writer.raw(domain.as_bytes())?;
        Ok(writer)
    }

    fn raw(&mut self, value: &[u8]) -> Result<(), TrustBundleError> {
        let length = u64::try_from(value.len()).map_err(|_| TrustBundleError::MessageTooLarge)?;
        self.bytes.extend_from_slice(&length.to_be_bytes());
        self.bytes.extend_from_slice(value);
        Ok(())
    }

    fn text(&mut self, key: &str, value: &str) -> Result<(), TrustBundleError> {
        self.raw(key.as_bytes())?;
        self.raw(value.as_bytes())
    }

    fn u64(&mut self, key: &str, value: u64) -> Result<(), TrustBundleError> {
        self.raw(key.as_bytes())?;
        self.raw(&value.to_be_bytes())
    }

    fn optional_digest(
        &mut self,
        key: &str,
        value: Option<&Sha256Digest>,
    ) -> Result<(), TrustBundleError> {
        self.raw(key.as_bytes())?;
        match value {
            Some(value) => {
                self.raw(&[1])?;
                self.raw(value.as_str().as_bytes())
            }
            None => self.raw(&[0]),
        }
    }

    fn finish(self) -> Vec<u8> {
        self.bytes
    }
}

fn sha256_digest(bytes: &[u8]) -> Result<Sha256Digest, TrustBundleError> {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let value = format!("sha256:{}", hex::encode(hasher.finalize()));
    Sha256Digest::from_str(&value).map_err(|_| TrustBundleError::DigestConstruction)
}

#[derive(Clone, Debug, Error, Eq, PartialEq)]
pub enum TrustBundleError {
    #[error("current time is invalid")]
    InvalidCurrentTime,
    #[error("unsupported trust-bundle version: {0}")]
    UnsupportedBundleVersion(u16),
    #[error("trust bundle shape is invalid")]
    InvalidBundleShape,
    #[error("trust bundle key count is invalid")]
    InvalidBundleKeyCount,
    #[error("trust bundle key is invalid: {0}")]
    InvalidBundleKey(String),
    #[error("trust bundle key repeats a role: {0}")]
    DuplicateKeyRole(String),
    #[error("trust bundle revocation count is invalid")]
    InvalidRevocationCount,
    #[error("trust bundle revocation is invalid: {0}")]
    InvalidRevocation(String),
    #[error("trust bundle ordering is not canonical")]
    NonCanonicalBundleOrdering,
    #[error("trust bundle bootstrap chain is invalid")]
    InvalidBootstrapChain,
    #[error("trust bundle generation rolled back or hash chain mismatched")]
    BundleRollbackOrChainMismatch,
    #[error("trust bundle is not yet valid")]
    BundleNotYetValid,
    #[error("trust bundle has expired")]
    BundleExpired,
    #[error("bundle authority key count is invalid")]
    InvalidAuthorityKeyCount,
    #[error("bundle authority key id is invalid")]
    InvalidAuthorityKeyId,
    #[error("bundle authority key is duplicated: {0}")]
    DuplicateAuthorityKey(String),
    #[error("bundle authority key is weak: {0}")]
    WeakAuthorityKey(String),
    #[error("bundle authority key is unknown: {0}")]
    UnknownAuthorityKey(String),
    #[error("bundle signature encoding is invalid")]
    InvalidBundleSignatureEncoding,
    #[error("bundle signature was rejected")]
    BundleSignatureRejected,
    #[error("request verification key encoding is invalid: {0}")]
    InvalidVerificationKeyEncoding(String),
    #[error("request verification key is weak: {0}")]
    WeakVerificationKey(String),
    #[error("trust bundle has no active key for role {0:?}")]
    NoActiveRoleKey(AgentRole),
    #[error("trust-bundle manager is disabled: {0:?}")]
    ManagerDisabled(TrustBundleDisableReasonV1),
    #[error("trust-bundle manager lock was poisoned")]
    ManagerLockPoisoned,
    #[error("trust-bundle signing message is too large")]
    MessageTooLarge,
    #[error("failed to construct trust-bundle digest")]
    DigestConstruction,
    #[error("active request trust store is invalid: {0}")]
    CapabilityTrustStore(CapabilityVerificationError),
}

#[cfg(test)]
mod tests {
    use base64ct::{Base64UrlUnpadded, Encoding};
    use ed25519_dalek::{Signer, SigningKey};

    use super::*;

    fn signed_bundle(
        generation: u64,
        previous: Option<Sha256Digest>,
        minimum: u64,
        mut request_keys: Vec<(String, SigningKey, Vec<AgentRole>, u64, u64)>,
        mut revocations: Vec<CapabilityKeyRevocationV1>,
        authority_key: &SigningKey,
    ) -> SignedCapabilityTrustBundleV1 {
        request_keys.sort_by(|left, right| left.0.cmp(&right.0));
        revocations.sort_by(|left, right| left.key_id.cmp(&right.key_id));
        let bundle = CapabilityTrustBundleV1 {
            version: 1,
            generation,
            issuer_id: "hepta-key-owner".to_owned(),
            valid_from_unix_ms: 1_000,
            valid_until_unix_ms: 100_000,
            minimum_accepted_generation: minimum,
            previous_bundle_hash: previous,
            keys: request_keys
                .into_iter()
                .map(|(key_id, key, allowed_roles, valid_from, valid_until)| {
                    CapabilityTrustKeyV1 {
                        key_id,
                        public_key_base64: Base64UrlUnpadded::encode_string(
                            key.verifying_key().as_bytes(),
                        ),
                        valid_from_unix_ms: valid_from,
                        valid_until_unix_ms: valid_until,
                        allowed_roles,
                    }
                })
                .collect(),
            revocations,
        };
        let bytes = trust_bundle_signing_bytes(&bundle).expect("bundle signing bytes");
        let signature = authority_key.sign(&bytes);
        SignedCapabilityTrustBundleV1 {
            bundle,
            authority_key_id: "bundle-root-1".to_owned(),
            signature_base64: Base64UrlUnpadded::encode_string(&signature.to_bytes()),
        }
    }

    fn authority(signing_key: &SigningKey) -> CapabilityBundleAuthorityV1 {
        CapabilityBundleAuthorityV1::new([(
            "bundle-root-1".to_owned(),
            signing_key.verifying_key(),
        )])
        .expect("bundle authority")
    }

    #[test]
    fn verifies_role_scoped_bootstrap_and_overlap_rotation() {
        let root = SigningKey::from_bytes(&[1_u8; 32]);
        let request_1 = SigningKey::from_bytes(&[2_u8; 32]);
        let request_2 = SigningKey::from_bytes(&[3_u8; 32]);
        let first = signed_bundle(
            1,
            None,
            1,
            vec![(
                "author-key-1".to_owned(),
                request_1.clone(),
                vec![AgentRole::Author],
                1_000,
                90_000,
            )],
            Vec::new(),
            &root,
        );
        let verified = verify_capability_trust_bundle(
            &first,
            AgentRole::Author,
            10_000,
            &authority(&root),
            None,
        )
        .expect("bootstrap bundle");
        let second = signed_bundle(
            2,
            Some(verified.bundle_hash().clone()),
            1,
            vec![
                (
                    "author-key-1".to_owned(),
                    request_1,
                    vec![AgentRole::Author],
                    1_000,
                    30_000,
                ),
                (
                    "author-key-2".to_owned(),
                    request_2,
                    vec![AgentRole::Author],
                    5_000,
                    90_000,
                ),
            ],
            Vec::new(),
            &root,
        );
        let rotated = verify_capability_trust_bundle(
            &second,
            AgentRole::Author,
            10_000,
            &authority(&root),
            Some(&verified.checkpoint()),
        )
        .expect("overlap rotation");
        assert_eq!(rotated.generation(), 2);
    }

    #[test]
    fn revoked_or_wrong_role_keys_do_not_authorize_admission() {
        let root = SigningKey::from_bytes(&[4_u8; 32]);
        let request = SigningKey::from_bytes(&[5_u8; 32]);
        let revoked = signed_bundle(
            1,
            None,
            1,
            vec![(
                "reviewer-key-1".to_owned(),
                request,
                vec![AgentRole::Reviewer],
                1_000,
                90_000,
            )],
            vec![CapabilityKeyRevocationV1 {
                key_id: "reviewer-key-1".to_owned(),
                effective_at_unix_ms: 9_000,
                reason_code: "credential_compromise".to_owned(),
            }],
            &root,
        );
        assert!(matches!(
            verify_capability_trust_bundle(
                &revoked,
                AgentRole::Reviewer,
                10_000,
                &authority(&root),
                None,
            ),
            Err(TrustBundleError::NoActiveRoleKey(AgentRole::Reviewer)),
        ));
    }

    #[test]
    fn rejected_rotation_disables_new_admission_until_recovery() {
        let root = SigningKey::from_bytes(&[6_u8; 32]);
        let request = SigningKey::from_bytes(&[7_u8; 32]);
        let first = signed_bundle(
            1,
            None,
            1,
            vec![(
                "author-key-1".to_owned(),
                request.clone(),
                vec![AgentRole::Author],
                1_000,
                90_000,
            )],
            Vec::new(),
            &root,
        );
        let verified = verify_capability_trust_bundle(
            &first,
            AgentRole::Author,
            10_000,
            &authority(&root),
            None,
        )
        .expect("bootstrap bundle");
        let manager = CapabilityTrustBundleManagerV1::new(verified);
        let rollback = signed_bundle(
            1,
            None,
            1,
            vec![(
                "author-key-1".to_owned(),
                request,
                vec![AgentRole::Author],
                1_000,
                90_000,
            )],
            Vec::new(),
            &root,
        );
        assert!(matches!(
            manager.install(&rollback, 10_000, &authority(&root)),
            Err(TrustBundleError::BundleRollbackOrChainMismatch),
        ));
        assert!(matches!(
            manager.snapshot(10_001),
            Err(TrustBundleError::ManagerDisabled(
                TrustBundleDisableReasonV1::RefreshRejected,
            )),
        ));
    }
}
