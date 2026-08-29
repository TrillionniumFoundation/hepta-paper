//! Cryptographic verification and exactly-once consumption of external qualification evidence.

use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, File, OpenOptions},
    io::Read,
    os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
    path::{Component, Path, PathBuf},
    str::FromStr,
    time::Duration,
};

use base64ct::{Base64UrlUnpadded, Encoding};
use ed25519_dalek::{Signature, VerifyingKey};
use rusqlite::{Connection, OpenFlags, OptionalExtension, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use thiserror::Error;

const MAXIMUM_EVIDENCE_BYTES: u64 = 16 * 1024 * 1024;
const MAXIMUM_ATTACHMENT_BYTES: u64 = 1024 * 1024 * 1024 * 1024;
const LEDGER_APPLICATION_ID: i64 = 1_213_224_757;
const LEDGER_USER_VERSION: i64 = 1;

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EvidenceKindV1 {
    IndependentLinuxReview,
    TargetHostQualification,
    StorageDestructiveDrill,
    CapabilityKeyOwnerDrill,
    AuthenticatedCodexRoleQualification,
    CampaignWriterCutoverSoak,
    ReleaseExternalAuthority,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AuthorityClassV1 {
    IndependentReviewer,
    TargetHostOperator,
    StorageOperator,
    CapabilityKeyOwner,
    ProviderAccountOwner,
    CampaignDatabaseOwner,
    ReleaseAuthority,
}

impl EvidenceKindV1 {
    const fn authority_class(self) -> AuthorityClassV1 {
        match self {
            Self::IndependentLinuxReview => AuthorityClassV1::IndependentReviewer,
            Self::TargetHostQualification => AuthorityClassV1::TargetHostOperator,
            Self::StorageDestructiveDrill => AuthorityClassV1::StorageOperator,
            Self::CapabilityKeyOwnerDrill => AuthorityClassV1::CapabilityKeyOwner,
            Self::AuthenticatedCodexRoleQualification => AuthorityClassV1::ProviderAccountOwner,
            Self::CampaignWriterCutoverSoak => AuthorityClassV1::CampaignDatabaseOwner,
            Self::ReleaseExternalAuthority => AuthorityClassV1::ReleaseAuthority,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChallengeBindingV1 {
    pub challenge_id: String,
    pub nonce: String,
    pub issued_at_unix_ms: u64,
    pub expires_at_unix_ms: u64,
    pub repository: String,
    pub commit: String,
    pub tree: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EvidenceSubjectV1 {
    pub repository: String,
    pub commit: String,
    pub tree: String,
    pub binary_digests: BTreeMap<String, String>,
    pub configuration_digests: BTreeMap<String, String>,
    pub host_identity_hash: Option<String>,
    pub trust_store_hash: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EvidenceIssuerV1 {
    pub authority_id: String,
    pub authority_class: AuthorityClassV1,
    pub key_id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EvidenceAttachmentV1 {
    pub path: String,
    pub bytes: u64,
    pub sha256: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EvidenceSignatureV1 {
    pub algorithm: String,
    pub value_base64_url: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExternalEvidenceEnvelopeV1 {
    pub schema_version: u16,
    pub evidence_kind: EvidenceKindV1,
    pub package_id: String,
    pub challenge: ChallengeBindingV1,
    pub subject: EvidenceSubjectV1,
    pub issuer: EvidenceIssuerV1,
    pub observed_at_unix_ms: u64,
    pub expires_at_unix_ms: u64,
    pub claims: Value,
    pub attachments: Vec<EvidenceAttachmentV1>,
    pub previous_evidence_hash: Option<String>,
    pub record_hash: String,
    pub signature: EvidenceSignatureV1,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QualificationTrustStoreDocumentV1 {
    pub version: u16,
    pub generation: u64,
    pub keys: Vec<QualificationTrustKeyDocumentV1>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QualificationTrustKeyDocumentV1 {
    pub key_id: String,
    pub authority_id: String,
    pub authority_class: AuthorityClassV1,
    pub public_key_base64_url: String,
    pub valid_from_unix_ms: u64,
    pub valid_until_unix_ms: u64,
    pub revoked_at_unix_ms: Option<u64>,
}

#[derive(Clone)]
struct QualificationTrustKeyV1 {
    authority_id: String,
    authority_class: AuthorityClassV1,
    verifying_key: VerifyingKey,
    valid_from_unix_ms: u64,
    valid_until_unix_ms: u64,
    revoked_at_unix_ms: Option<u64>,
}

#[derive(Clone)]
pub struct QualificationTrustStoreV1 {
    generation: u64,
    keys: BTreeMap<String, QualificationTrustKeyV1>,
    content_hash: String,
}

impl QualificationTrustStoreV1 {
    pub fn from_json_bytes(bytes: &[u8]) -> Result<Self, QualificationEvidenceError> {
        if bytes.is_empty()
            || u64::try_from(bytes.len()).map_or(true, |size| size > MAXIMUM_EVIDENCE_BYTES)
        {
            return Err(QualificationEvidenceError::TrustStoreInvalid);
        }
        let document: QualificationTrustStoreDocumentV1 =
            serde_json::from_slice(bytes).map_err(|_| QualificationEvidenceError::TrustStoreInvalid)?;
        if document.version != 1 || document.generation == 0 || document.keys.is_empty() || document.keys.len() > 256 {
            return Err(QualificationEvidenceError::TrustStoreInvalid);
        }
        let canonical = canonical_json_bytes(&document)?;
        if canonical != bytes {
            return Err(QualificationEvidenceError::NonCanonicalJson);
        }
        let mut keys = BTreeMap::new();
        for selected in document.keys {
            if !valid_identifier(&selected.key_id)
                || !valid_identifier(&selected.authority_id)
                || selected.valid_from_unix_ms == 0
                || selected.valid_until_unix_ms <= selected.valid_from_unix_ms
                || selected
                    .revoked_at_unix_ms
                    .is_some_and(|value| value < selected.valid_from_unix_ms)
            {
                return Err(QualificationEvidenceError::TrustStoreInvalid);
            }
            let public_key = Base64UrlUnpadded::decode_vec(&selected.public_key_base64_url)
                .map_err(|_| QualificationEvidenceError::TrustStoreInvalid)?;
            let public_key: [u8; 32] = public_key
                .try_into()
                .map_err(|_| QualificationEvidenceError::TrustStoreInvalid)?;
            let verifying_key = VerifyingKey::from_bytes(&public_key)
                .map_err(|_| QualificationEvidenceError::TrustStoreInvalid)?;
            if verifying_key.is_weak() {
                return Err(QualificationEvidenceError::TrustStoreInvalid);
            }
            let key = QualificationTrustKeyV1 {
                authority_id: selected.authority_id,
                authority_class: selected.authority_class,
                verifying_key,
                valid_from_unix_ms: selected.valid_from_unix_ms,
                valid_until_unix_ms: selected.valid_until_unix_ms,
                revoked_at_unix_ms: selected.revoked_at_unix_ms,
            };
            if keys.insert(selected.key_id, key).is_some() {
                return Err(QualificationEvidenceError::TrustStoreInvalid);
            }
        }
        Ok(Self {
            generation: document.generation,
            keys,
            content_hash: hash_raw_bytes(bytes),
        })
    }

    #[must_use]
    pub fn content_hash(&self) -> &str {
        &self.content_hash
    }

    #[must_use]
    pub const fn generation(&self) -> u64 {
        self.generation
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct QualificationExpectationV1 {
    pub evidence_kind: EvidenceKindV1,
    pub package_id: String,
    pub repository: String,
    pub commit: String,
    pub tree: String,
    pub challenge_id: String,
    pub challenge_nonce: String,
    pub now_unix_ms: u64,
    pub trust_store_hash: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VerifiedExternalEvidenceV1 {
    pub evidence_kind: EvidenceKindV1,
    pub package_id: String,
    pub challenge_id: String,
    pub issuer_authority_id: String,
    pub issuer_key_id: String,
    pub record_hash: String,
    pub expires_at_unix_ms: u64,
    pub attachment_count: u64,
}

pub fn decode_evidence(bytes: &[u8]) -> Result<ExternalEvidenceEnvelopeV1, QualificationEvidenceError> {
    if bytes.is_empty()
        || u64::try_from(bytes.len()).map_or(true, |size| size > MAXIMUM_EVIDENCE_BYTES)
    {
        return Err(QualificationEvidenceError::EvidenceTooLarge);
    }
    let envelope: ExternalEvidenceEnvelopeV1 =
        serde_json::from_slice(bytes).map_err(|_| QualificationEvidenceError::EvidenceInvalid)?;
    let canonical = canonical_json_bytes(&envelope)?;
    if canonical != bytes {
        return Err(QualificationEvidenceError::NonCanonicalJson);
    }
    Ok(envelope)
}

pub fn evidence_signing_payload(
    envelope: &ExternalEvidenceEnvelopeV1,
) -> Result<Vec<u8>, QualificationEvidenceError> {
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct SigningView<'a> {
        schema_version: u16,
        evidence_kind: EvidenceKindV1,
        package_id: &'a str,
        challenge: &'a ChallengeBindingV1,
        subject: &'a EvidenceSubjectV1,
        issuer: &'a EvidenceIssuerV1,
        observed_at_unix_ms: u64,
        expires_at_unix_ms: u64,
        claims: &'a Value,
        attachments: &'a [EvidenceAttachmentV1],
        previous_evidence_hash: &'a Option<String>,
    }
    let view = SigningView {
        schema_version: envelope.schema_version,
        evidence_kind: envelope.evidence_kind,
        package_id: &envelope.package_id,
        challenge: &envelope.challenge,
        subject: &envelope.subject,
        issuer: &envelope.issuer,
        observed_at_unix_ms: envelope.observed_at_unix_ms,
        expires_at_unix_ms: envelope.expires_at_unix_ms,
        claims: &envelope.claims,
        attachments: &envelope.attachments,
        previous_evidence_hash: &envelope.previous_evidence_hash,
    };
    let encoded = canonical_json_bytes(&view)?;
    let domain = b"HeptaExternalQualificationEvidenceV1";
    let mut payload = Vec::with_capacity(16 + domain.len() + encoded.len());
    payload.extend_from_slice(
        &u64::try_from(domain.len())
            .map_err(|_| QualificationEvidenceError::NumericOverflow)?
            .to_be_bytes(),
    );
    payload.extend_from_slice(domain);
    payload.extend_from_slice(
        &u64::try_from(encoded.len())
            .map_err(|_| QualificationEvidenceError::NumericOverflow)?
            .to_be_bytes(),
    );
    payload.extend_from_slice(&encoded);
    Ok(payload)
}

pub fn verify_external_evidence(
    envelope: &ExternalEvidenceEnvelopeV1,
    trust_store: &QualificationTrustStoreV1,
    expectation: &QualificationExpectationV1,
    attachments_root: &Path,
) -> Result<VerifiedExternalEvidenceV1, QualificationEvidenceError> {
    validate_envelope(envelope, trust_store, expectation)?;
    verify_attachments(&envelope.attachments, attachments_root)?;
    let payload = evidence_signing_payload(envelope)?;
    let expected_record_hash = hash_raw_bytes(&payload);
    if envelope.record_hash != expected_record_hash {
        return Err(QualificationEvidenceError::RecordHashMismatch);
    }
    if envelope.signature.algorithm != "ed25519"
        || envelope.signature.value_base64_url.contains('=')
    {
        return Err(QualificationEvidenceError::SignatureInvalid);
    }
    let signature = Base64UrlUnpadded::decode_vec(&envelope.signature.value_base64_url)
        .map_err(|_| QualificationEvidenceError::SignatureInvalid)?;
    let signature = Signature::try_from(signature.as_slice())
        .map_err(|_| QualificationEvidenceError::SignatureInvalid)?;
    let key = trust_store
        .keys
        .get(&envelope.issuer.key_id)
        .ok_or(QualificationEvidenceError::UnknownKey)?;
    key.verifying_key
        .verify_strict(&payload, &signature)
        .map_err(|_| QualificationEvidenceError::SignatureRejected)?;
    Ok(VerifiedExternalEvidenceV1 {
        evidence_kind: envelope.evidence_kind,
        package_id: envelope.package_id.clone(),
        challenge_id: envelope.challenge.challenge_id.clone(),
        issuer_authority_id: envelope.issuer.authority_id.clone(),
        issuer_key_id: envelope.issuer.key_id.clone(),
        record_hash: envelope.record_hash.clone(),
        expires_at_unix_ms: envelope.expires_at_unix_ms,
        attachment_count: u64::try_from(envelope.attachments.len())
            .map_err(|_| QualificationEvidenceError::NumericOverflow)?,
    })
}

fn validate_envelope(
    envelope: &ExternalEvidenceEnvelopeV1,
    trust_store: &QualificationTrustStoreV1,
    expectation: &QualificationExpectationV1,
) -> Result<(), QualificationEvidenceError> {
    if envelope.schema_version != 1
        || envelope.evidence_kind != expectation.evidence_kind
        || envelope.package_id != expectation.package_id
        || !valid_identifier(&envelope.package_id)
        || expectation.now_unix_ms == 0
    {
        return Err(QualificationEvidenceError::EvidenceInvalid);
    }
    let challenge = &envelope.challenge;
    if challenge.challenge_id != expectation.challenge_id
        || challenge.nonce != expectation.challenge_nonce
        || challenge.repository != expectation.repository
        || challenge.commit != expectation.commit
        || challenge.tree != expectation.tree
        || !valid_identifier(&challenge.challenge_id)
        || !valid_nonce(&challenge.nonce)
        || challenge.issued_at_unix_ms == 0
        || challenge.expires_at_unix_ms <= challenge.issued_at_unix_ms
        || expectation.now_unix_ms >= challenge.expires_at_unix_ms
    {
        return Err(QualificationEvidenceError::ChallengeMismatch);
    }
    let subject = &envelope.subject;
    if subject.repository != expectation.repository
        || subject.commit != expectation.commit
        || subject.tree != expectation.tree
        || !valid_git_sha(&subject.commit)
        || !valid_git_sha(&subject.tree)
        || subject.binary_digests.is_empty()
        || subject.binary_digests.len() > 256
        || subject.configuration_digests.len() > 1024
        || subject.trust_store_hash.as_deref() != Some(expectation.trust_store_hash.as_str())
        || expectation.trust_store_hash != trust_store.content_hash
    {
        return Err(QualificationEvidenceError::SubjectMismatch);
    }
    for (name, digest) in subject
        .binary_digests
        .iter()
        .chain(subject.configuration_digests.iter())
    {
        if !valid_identifier(name) || !valid_digest(digest) {
            return Err(QualificationEvidenceError::SubjectMismatch);
        }
    }
    if subject
        .host_identity_hash
        .as_ref()
        .is_some_and(|value| !valid_digest(value))
        || subject
            .trust_store_hash
            .as_ref()
            .is_some_and(|value| !valid_digest(value))
        || envelope
            .previous_evidence_hash
            .as_ref()
            .is_some_and(|value| !valid_digest(value))
        || !valid_digest(&envelope.record_hash)
    {
        return Err(QualificationEvidenceError::EvidenceInvalid);
    }
    if envelope.observed_at_unix_ms < challenge.issued_at_unix_ms
        || envelope.observed_at_unix_ms >= envelope.expires_at_unix_ms
        || envelope.expires_at_unix_ms > challenge.expires_at_unix_ms
        || expectation.now_unix_ms >= envelope.expires_at_unix_ms
    {
        return Err(QualificationEvidenceError::EvidenceExpired);
    }
    if envelope.issuer.authority_class != envelope.evidence_kind.authority_class()
        || !valid_identifier(&envelope.issuer.authority_id)
        || !valid_identifier(&envelope.issuer.key_id)
    {
        return Err(QualificationEvidenceError::AuthorityMismatch);
    }
    let key = trust_store
        .keys
        .get(&envelope.issuer.key_id)
        .ok_or(QualificationEvidenceError::UnknownKey)?;
    if key.authority_id != envelope.issuer.authority_id
        || key.authority_class != envelope.issuer.authority_class
        || envelope.observed_at_unix_ms < key.valid_from_unix_ms
        || envelope.observed_at_unix_ms >= key.valid_until_unix_ms
        || key
            .revoked_at_unix_ms
            .is_some_and(|revoked| envelope.observed_at_unix_ms >= revoked)
    {
        return Err(QualificationEvidenceError::AuthorityMismatch);
    }
    validate_claims(envelope.evidence_kind, &envelope.claims)
}

fn validate_claims(kind: EvidenceKindV1, claims: &Value) -> Result<(), QualificationEvidenceError> {
    let object = claims
        .as_object()
        .ok_or(QualificationEvidenceError::ClaimsInvalid)?;
    let expected: BTreeSet<&str> = match kind {
        EvidenceKindV1::IndependentLinuxReview => [
            "passed",
            "reviewedUnsafeBoundaries",
            "reviewedKernelAssumptions",
            "openCriticalFindings",
            "reviewerIndependenceAttestationHash",
        ]
        .into_iter()
        .collect(),
        EvidenceKindV1::TargetHostQualification => [
            "passed",
            "kernelRelease",
            "cgroupV2Qualified",
            "systemdHardeningQualified",
            "listenerAuthorizedPeerSucceeded",
            "listenerUnauthorizedPeerRejected",
            "gateAuthoritySeparated",
            "schemaAuthoritySeparated",
            "rebootRecoveryPassed",
        ]
        .into_iter()
        .collect(),
        EvidenceKindV1::StorageDestructiveDrill => [
            "passed",
            "sigkillMatrixPassed",
            "hostRebootPassed",
            "diskFullPassed",
            "readOnlyRemountPassed",
            "walCorruptionRejected",
            "pageCorruptionRejected",
            "restoreDrillPassed",
            "liveProductionDataTouched",
        ]
        .into_iter()
        .collect(),
        EvidenceKindV1::CapabilityKeyOwnerDrill => [
            "passed",
            "overlapRotationPassed",
            "revocationPassed",
            "rollbackRejected",
            "bundleSignerCompromiseDrillPassed",
            "requestSignerCompromiseDrillPassed",
            "emergencyAdmissionStopPassed",
        ]
        .into_iter()
        .collect(),
        EvidenceKindV1::AuthenticatedCodexRoleQualification => [
            "passed",
            "authorPrincipalDistinct",
            "reviewerPrincipalDistinct",
            "authorCanaryPassed",
            "reviewerCanaryPassed",
            "freshEphemeralSessions",
            "credentialLeakCount",
            "crossRoleReadCount",
            "providerNetworkCallsBounded",
        ]
        .into_iter()
        .collect(),
        EvidenceKindV1::CampaignWriterCutoverSoak => [
            "passed",
            "schemaVersion",
            "mixedWriterExcluded",
            "durationSeconds",
            "staleCommitCount",
            "duplicateIntegrationCount",
            "unexplainedBudgetDeltaMicrousd",
            "backupRestorePassed",
            "rollbackPassed",
        ]
        .into_iter()
        .collect(),
        EvidenceKindV1::ReleaseExternalAuthority => [
            "passed",
            "kmsOrHsmQualified",
            "wormCustodyQualified",
            "releaseSignatureVerified",
            "singleUseDispatchQualified",
            "modelPrincipalSecretAccessCount",
            "ambiguousExternalActionReconciled",
        ]
        .into_iter()
        .collect(),
    };
    let observed = object.keys().map(String::as_str).collect::<BTreeSet<_>>();
    if observed != expected || object.get("passed").and_then(Value::as_bool) != Some(true) {
        return Err(QualificationEvidenceError::ClaimsInvalid);
    }
    match kind {
        EvidenceKindV1::IndependentLinuxReview => {
            require_true(object, "reviewedUnsafeBoundaries")?;
            require_true(object, "reviewedKernelAssumptions")?;
            require_zero(object, "openCriticalFindings")?;
            require_digest(object, "reviewerIndependenceAttestationHash")?;
        }
        EvidenceKindV1::TargetHostQualification => {
            for field in [
                "cgroupV2Qualified",
                "systemdHardeningQualified",
                "listenerAuthorizedPeerSucceeded",
                "listenerUnauthorizedPeerRejected",
                "gateAuthoritySeparated",
                "schemaAuthoritySeparated",
                "rebootRecoveryPassed",
            ] {
                require_true(object, field)?;
            }
            if object
                .get("kernelRelease")
                .and_then(Value::as_str)
                .is_none_or(str::is_empty)
            {
                return Err(QualificationEvidenceError::ClaimsInvalid);
            }
        }
        EvidenceKindV1::StorageDestructiveDrill => {
            for field in [
                "sigkillMatrixPassed",
                "hostRebootPassed",
                "diskFullPassed",
                "readOnlyRemountPassed",
                "walCorruptionRejected",
                "pageCorruptionRejected",
                "restoreDrillPassed",
            ] {
                require_true(object, field)?;
            }
            if object.get("liveProductionDataTouched").and_then(Value::as_bool) != Some(false) {
                return Err(QualificationEvidenceError::ClaimsInvalid);
            }
        }
        EvidenceKindV1::CapabilityKeyOwnerDrill => {
            for field in expected.into_iter().filter(|field| *field != "passed") {
                require_true(object, field)?;
            }
        }
        EvidenceKindV1::AuthenticatedCodexRoleQualification => {
            for field in [
                "authorPrincipalDistinct",
                "reviewerPrincipalDistinct",
                "authorCanaryPassed",
                "reviewerCanaryPassed",
                "freshEphemeralSessions",
                "providerNetworkCallsBounded",
            ] {
                require_true(object, field)?;
            }
            require_zero(object, "credentialLeakCount")?;
            require_zero(object, "crossRoleReadCount")?;
        }
        EvidenceKindV1::CampaignWriterCutoverSoak => {
            require_true(object, "mixedWriterExcluded")?;
            require_true(object, "backupRestorePassed")?;
            require_true(object, "rollbackPassed")?;
            if object.get("schemaVersion").and_then(Value::as_u64) != Some(25)
                || object
                    .get("durationSeconds")
                    .and_then(Value::as_u64)
                    .is_none_or(|value| value < 259_200)
            {
                return Err(QualificationEvidenceError::ClaimsInvalid);
            }
            require_zero(object, "staleCommitCount")?;
            require_zero(object, "duplicateIntegrationCount")?;
            require_zero(object, "unexplainedBudgetDeltaMicrousd")?;
        }
        EvidenceKindV1::ReleaseExternalAuthority => {
            for field in [
                "kmsOrHsmQualified",
                "wormCustodyQualified",
                "releaseSignatureVerified",
                "singleUseDispatchQualified",
                "ambiguousExternalActionReconciled",
            ] {
                require_true(object, field)?;
            }
            require_zero(object, "modelPrincipalSecretAccessCount")?;
        }
    }
    Ok(())
}

fn require_true(
    object: &serde_json::Map<String, Value>,
    field: &str,
) -> Result<(), QualificationEvidenceError> {
    if object.get(field).and_then(Value::as_bool) == Some(true) {
        Ok(())
    } else {
        Err(QualificationEvidenceError::ClaimsInvalid)
    }
}

fn require_zero(
    object: &serde_json::Map<String, Value>,
    field: &str,
) -> Result<(), QualificationEvidenceError> {
    if object.get(field).and_then(Value::as_u64) == Some(0) {
        Ok(())
    } else {
        Err(QualificationEvidenceError::ClaimsInvalid)
    }
}

fn require_digest(
    object: &serde_json::Map<String, Value>,
    field: &str,
) -> Result<(), QualificationEvidenceError> {
    if object
        .get(field)
        .and_then(Value::as_str)
        .is_some_and(valid_digest)
    {
        Ok(())
    } else {
        Err(QualificationEvidenceError::ClaimsInvalid)
    }
}

fn verify_attachments(
    attachments: &[EvidenceAttachmentV1],
    root: &Path,
) -> Result<(), QualificationEvidenceError> {
    if attachments.is_empty() || attachments.len() > 1024 || !root.is_absolute() {
        return Err(QualificationEvidenceError::AttachmentInvalid);
    }
    let canonical_root = fs::canonicalize(root)
        .map_err(|error| QualificationEvidenceError::Filesystem("attachment_root", error.kind()))?;
    if canonical_root != root {
        return Err(QualificationEvidenceError::AttachmentInvalid);
    }
    let mut seen = BTreeSet::new();
    for attachment in attachments {
        let relative = valid_relative_path(&attachment.path)?;
        if !seen.insert(attachment.path.as_str()) || !valid_digest(&attachment.sha256) {
            return Err(QualificationEvidenceError::AttachmentInvalid);
        }
        let selected = root.join(&relative);
        let metadata = fs::symlink_metadata(&selected)
            .map_err(|error| QualificationEvidenceError::Filesystem("attachment", error.kind()))?;
        let canonical = fs::canonicalize(&selected)
            .map_err(|error| QualificationEvidenceError::Filesystem("attachment", error.kind()))?;
        if metadata.file_type().is_symlink()
            || !metadata.is_file()
            || metadata.nlink() != 1
            || metadata.size() != attachment.bytes
            || metadata.size() > MAXIMUM_ATTACHMENT_BYTES
            || !canonical.starts_with(&canonical_root)
            || canonical != selected
            || hash_file(&selected, metadata.size())? != attachment.sha256
        {
            return Err(QualificationEvidenceError::AttachmentInvalid);
        }
    }
    Ok(())
}

pub struct ChallengeLedgerV1 {
    connection: Connection,
    path: PathBuf,
    owner_uid: u32,
}

impl ChallengeLedgerV1 {
    pub fn open(path: impl AsRef<Path>, owner_uid: u32) -> Result<Self, QualificationEvidenceError> {
        let requested = path.as_ref();
        if !requested.is_absolute() || requested.file_name().is_none() {
            return Err(QualificationEvidenceError::LedgerInvalid);
        }
        let parent = requested
            .parent()
            .ok_or(QualificationEvidenceError::LedgerInvalid)?;
        let canonical_parent = fs::canonicalize(parent)
            .map_err(|error| QualificationEvidenceError::Filesystem("ledger_parent", error.kind()))?;
        let parent_metadata = fs::symlink_metadata(parent)
            .map_err(|error| QualificationEvidenceError::Filesystem("ledger_parent", error.kind()))?;
        if canonical_parent != parent
            || parent_metadata.file_type().is_symlink()
            || !parent_metadata.is_dir()
            || parent_metadata.uid() != owner_uid
            || parent_metadata.mode() & 0o7777 != 0o700
        {
            return Err(QualificationEvidenceError::LedgerInvalid);
        }
        let canonical = canonical_parent.join(
            requested
                .file_name()
                .ok_or(QualificationEvidenceError::LedgerInvalid)?,
        );
        if canonical != requested {
            return Err(QualificationEvidenceError::LedgerInvalid);
        }
        if !requested.exists() {
            let file = OpenOptions::new()
                .create_new(true)
                .read(true)
                .write(true)
                .mode(0o600)
                .open(requested)
                .map_err(|error| QualificationEvidenceError::Filesystem("ledger_create", error.kind()))?;
            file.sync_all()
                .map_err(|error| QualificationEvidenceError::Filesystem("ledger_create", error.kind()))?;
            File::open(parent)
                .and_then(|directory| directory.sync_all())
                .map_err(|error| QualificationEvidenceError::Filesystem("ledger_parent_sync", error.kind()))?;
        }
        inspect_private_file(requested, owner_uid, MAXIMUM_EVIDENCE_BYTES * 16)?;
        let connection = Connection::open_with_flags(
            requested,
            OpenFlags::SQLITE_OPEN_READ_WRITE
                | OpenFlags::SQLITE_OPEN_NO_MUTEX
                | OpenFlags::SQLITE_OPEN_NOFOLLOW,
        )?;
        connection.busy_timeout(Duration::from_millis(5_000))?;
        connection.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = FULL;
             PRAGMA trusted_schema = OFF;
             PRAGMA application_id = 1213224757;
             PRAGMA user_version = 1;
             CREATE TABLE IF NOT EXISTS consumed_challenges (
                 challenge_id TEXT PRIMARY KEY,
                 nonce_hash TEXT NOT NULL,
                 evidence_kind TEXT NOT NULL,
                 record_hash TEXT NOT NULL UNIQUE,
                 consumed_at_unix_ms INTEGER NOT NULL CHECK (consumed_at_unix_ms > 0)
             ) STRICT;",
        )?;
        let application_id: i64 =
            connection.query_row("PRAGMA application_id", [], |row| row.get(0))?;
        let user_version: i64 =
            connection.query_row("PRAGMA user_version", [], |row| row.get(0))?;
        if application_id != LEDGER_APPLICATION_ID || user_version != LEDGER_USER_VERSION {
            return Err(QualificationEvidenceError::LedgerInvalid);
        }
        Ok(Self {
            connection,
            path: canonical,
            owner_uid,
        })
    }

    pub fn consume(
        &mut self,
        verified: &VerifiedExternalEvidenceV1,
        challenge_nonce: &str,
        now_unix_ms: u64,
    ) -> Result<(), QualificationEvidenceError> {
        if now_unix_ms == 0 || now_unix_ms >= verified.expires_at_unix_ms || !valid_nonce(challenge_nonce) {
            return Err(QualificationEvidenceError::ChallengeExpired);
        }
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let existing = tx
            .query_row(
                "SELECT record_hash FROM consumed_challenges WHERE challenge_id = ?1",
                [&verified.challenge_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        if existing.is_some() {
            return Err(QualificationEvidenceError::ChallengeAlreadyConsumed);
        }
        tx.execute(
            "INSERT INTO consumed_challenges (
                challenge_id, nonce_hash, evidence_kind, record_hash, consumed_at_unix_ms
             ) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                verified.challenge_id,
                hash_raw_bytes(challenge_nonce.as_bytes()),
                format!("{:?}", verified.evidence_kind),
                verified.record_hash,
                i64::try_from(now_unix_ms).map_err(|_| QualificationEvidenceError::NumericOverflow)?,
            ],
        )?;
        tx.commit()?;
        inspect_private_file(&self.path, self.owner_uid, MAXIMUM_EVIDENCE_BYTES * 16)
    }
}

fn canonical_json_bytes<T: Serialize>(value: &T) -> Result<Vec<u8>, QualificationEvidenceError> {
    let value = serde_json::to_value(value).map_err(|_| QualificationEvidenceError::Serialization)?;
    serde_json::to_vec(&canonicalize(value)).map_err(|_| QualificationEvidenceError::Serialization)
}

fn canonicalize(value: Value) -> Value {
    match value {
        Value::Array(values) => Value::Array(values.into_iter().map(canonicalize).collect()),
        Value::Object(values) => {
            let ordered = values
                .into_iter()
                .map(|(key, value)| (key, canonicalize(value)))
                .collect::<BTreeMap<_, _>>();
            let mut result = serde_json::Map::new();
            for (key, value) in ordered {
                result.insert(key, value);
            }
            Value::Object(result)
        }
        other => other,
    }
}

fn valid_identifier(value: &str) -> bool {
    if value.is_empty() || value.len() > 160 {
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

fn valid_nonce(value: &str) -> bool {
    (32..=160).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

fn valid_git_sha(value: &str) -> bool {
    value.len() == 40
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
}

fn valid_digest(value: &str) -> bool {
    value.strip_prefix("sha256:").is_some_and(|hex| {
        hex.len() == 64
            && hex
                .bytes()
                .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
    })
}

fn valid_relative_path(value: &str) -> Result<PathBuf, QualificationEvidenceError> {
    if value.is_empty() || value.len() > 512 {
        return Err(QualificationEvidenceError::AttachmentInvalid);
    }
    let selected = Path::new(value);
    if selected.is_absolute() {
        return Err(QualificationEvidenceError::AttachmentInvalid);
    }
    let mut result = PathBuf::new();
    for component in selected.components() {
        match component {
            Component::Normal(name) if !name.is_empty() => result.push(name),
            _ => return Err(QualificationEvidenceError::AttachmentInvalid),
        }
    }
    Ok(result)
}

fn hash_raw_bytes(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("sha256:{}", hex::encode(hasher.finalize()))
}

fn hash_file(path: &Path, expected_size: u64) -> Result<String, QualificationEvidenceError> {
    let mut file = File::open(path)
        .map_err(|error| QualificationEvidenceError::Filesystem("file_hash", error.kind()))?;
    let before = file
        .metadata()
        .map_err(|error| QualificationEvidenceError::Filesystem("file_hash", error.kind()))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    let mut total = 0_u64;
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| QualificationEvidenceError::Filesystem("file_hash", error.kind()))?;
        if read == 0 {
            break;
        }
        total = total
            .checked_add(u64::try_from(read).map_err(|_| QualificationEvidenceError::NumericOverflow)?)
            .ok_or(QualificationEvidenceError::NumericOverflow)?;
        if total > MAXIMUM_ATTACHMENT_BYTES {
            return Err(QualificationEvidenceError::AttachmentInvalid);
        }
        hasher.update(&buffer[..read]);
    }
    let after = file
        .metadata()
        .map_err(|error| QualificationEvidenceError::Filesystem("file_hash", error.kind()))?;
    if total != expected_size
        || before.dev() != after.dev()
        || before.ino() != after.ino()
        || before.mode() != after.mode()
        || before.uid() != after.uid()
        || before.gid() != after.gid()
        || before.nlink() != after.nlink()
        || before.size() != after.size()
    {
        return Err(QualificationEvidenceError::AttachmentInvalid);
    }
    Ok(format!("sha256:{}", hex::encode(hasher.finalize())))
}

fn inspect_private_file(
    path: &Path,
    owner_uid: u32,
    maximum_bytes: u64,
) -> Result<(), QualificationEvidenceError> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| QualificationEvidenceError::Filesystem("private_file", error.kind()))?;
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || metadata.uid() != owner_uid
        || metadata.mode() & 0o7777 != 0o600
        || metadata.nlink() != 1
        || metadata.size() > maximum_bytes
    {
        return Err(QualificationEvidenceError::LedgerInvalid);
    }
    Ok(())
}

#[derive(Debug, Error)]
pub enum QualificationEvidenceError {
    #[error("external evidence is invalid")]
    EvidenceInvalid,
    #[error("external evidence exceeds its hard byte limit")]
    EvidenceTooLarge,
    #[error("external evidence JSON is not canonical")]
    NonCanonicalJson,
    #[error("external evidence subject differs")]
    SubjectMismatch,
    #[error("external evidence challenge differs")]
    ChallengeMismatch,
    #[error("external evidence or challenge expired")]
    EvidenceExpired,
    #[error("external evidence claims are invalid")]
    ClaimsInvalid,
    #[error("external evidence authority differs")]
    AuthorityMismatch,
    #[error("external evidence signer key is unknown")]
    UnknownKey,
    #[error("external evidence record hash differs")]
    RecordHashMismatch,
    #[error("external evidence signature encoding is invalid")]
    SignatureInvalid,
    #[error("external evidence signature was rejected")]
    SignatureRejected,
    #[error("external evidence attachment is invalid")]
    AttachmentInvalid,
    #[error("qualification trust store is invalid")]
    TrustStoreInvalid,
    #[error("challenge ledger is invalid")]
    LedgerInvalid,
    #[error("challenge was already consumed")]
    ChallengeAlreadyConsumed,
    #[error("challenge is expired")]
    ChallengeExpired,
    #[error("serialization failed")]
    Serialization,
    #[error("numeric conversion overflowed")]
    NumericOverflow,
    #[error("filesystem operation failed at {0}: {1:?}")]
    Filesystem(&'static str, std::io::ErrorKind),
    #[error(transparent)]
    Sqlite(#[from] rusqlite::Error),
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64ct::{Base64UrlUnpadded, Encoding};
    use ed25519_dalek::{Signer, SigningKey};
    use std::{
        os::unix::fs::{MetadataExt, PermissionsExt},
        sync::atomic::{AtomicU64, Ordering},
        time::{SystemTime, UNIX_EPOCH},
    };

    static NEXT_TEMP: AtomicU64 = AtomicU64::new(0);

    struct Fixture {
        root: PathBuf,
        uid: u32,
    }

    impl Fixture {
        fn new() -> Self {
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("clock")
                .as_nanos();
            let root = std::env::temp_dir().join(format!(
                "hepta-qualification-{}-{nonce}-{}",
                std::process::id(),
                NEXT_TEMP.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&root).expect("root");
            fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).expect("mode");
            let uid = fs::metadata(&root).expect("metadata").uid();
            Self { root, uid }
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    fn digest(byte: char) -> String {
        format!("sha256:{}", byte.to_string().repeat(64))
    }

    fn signed_fixture(
        fixture: &Fixture,
    ) -> (
        ExternalEvidenceEnvelopeV1,
        QualificationTrustStoreV1,
        QualificationExpectationV1,
    ) {
        fs::write(fixture.root.join("review.txt"), b"review passed").expect("attachment");
        let attachment_hash = hash_file(&fixture.root.join("review.txt"), 13).expect("hash");
        let signing_key = SigningKey::from_bytes(&[23_u8; 32]);
        let trust_document = QualificationTrustStoreDocumentV1 {
            version: 1,
            generation: 1,
            keys: vec![QualificationTrustKeyDocumentV1 {
                key_id: "review-key-1".to_owned(),
                authority_id: "independent-reviewer-1".to_owned(),
                authority_class: AuthorityClassV1::IndependentReviewer,
                public_key_base64_url: Base64UrlUnpadded::encode_string(
                    signing_key.verifying_key().as_bytes(),
                ),
                valid_from_unix_ms: 1,
                valid_until_unix_ms: 100_000,
                revoked_at_unix_ms: None,
            }],
        };
        let trust_bytes = canonical_json_bytes(&trust_document).expect("trust bytes");
        let trust_store = QualificationTrustStoreV1::from_json_bytes(&trust_bytes).expect("trust");
        let mut envelope = ExternalEvidenceEnvelopeV1 {
            schema_version: 1,
            evidence_kind: EvidenceKindV1::IndependentLinuxReview,
            package_id: "linux-review-1".to_owned(),
            challenge: ChallengeBindingV1 {
                challenge_id: "review-challenge-1".to_owned(),
                nonce: "abcdefghijklmnopqrstuvwxyzABCDEFG_123456789".to_owned(),
                issued_at_unix_ms: 10,
                expires_at_unix_ms: 10_000,
                repository: "TrillionniumFoundation/hepta-paper".to_owned(),
                commit: "a".repeat(40),
                tree: "b".repeat(40),
            },
            subject: EvidenceSubjectV1 {
                repository: "TrillionniumFoundation/hepta-paper".to_owned(),
                commit: "a".repeat(40),
                tree: "b".repeat(40),
                binary_digests: BTreeMap::from([("gate".to_owned(), digest('1'))]),
                configuration_digests: BTreeMap::new(),
                host_identity_hash: None,
                trust_store_hash: Some(trust_store.content_hash().to_owned()),
            },
            issuer: EvidenceIssuerV1 {
                authority_id: "independent-reviewer-1".to_owned(),
                authority_class: AuthorityClassV1::IndependentReviewer,
                key_id: "review-key-1".to_owned(),
            },
            observed_at_unix_ms: 100,
            expires_at_unix_ms: 9_000,
            claims: serde_json::json!({
                "openCriticalFindings": 0,
                "passed": true,
                "reviewedKernelAssumptions": true,
                "reviewedUnsafeBoundaries": true,
                "reviewerIndependenceAttestationHash": digest('2'),
            }),
            attachments: vec![EvidenceAttachmentV1 {
                path: "review.txt".to_owned(),
                bytes: 13,
                sha256: attachment_hash,
            }],
            previous_evidence_hash: None,
            record_hash: digest('0'),
            signature: EvidenceSignatureV1 {
                algorithm: "ed25519".to_owned(),
                value_base64_url: "A".repeat(86),
            },
        };
        let payload = evidence_signing_payload(&envelope).expect("payload");
        envelope.record_hash = hash_raw_bytes(&payload);
        envelope.signature.value_base64_url =
            Base64UrlUnpadded::encode_string(&signing_key.sign(&payload).to_bytes());
        let expectation = QualificationExpectationV1 {
            evidence_kind: EvidenceKindV1::IndependentLinuxReview,
            package_id: envelope.package_id.clone(),
            repository: envelope.subject.repository.clone(),
            commit: envelope.subject.commit.clone(),
            tree: envelope.subject.tree.clone(),
            challenge_id: envelope.challenge.challenge_id.clone(),
            challenge_nonce: envelope.challenge.nonce.clone(),
            now_unix_ms: 500,
            trust_store_hash: trust_store.content_hash().to_owned(),
        };
        (envelope, trust_store, expectation)
    }

    #[test]
    fn signature_subject_attachments_and_exactly_once_consumption_are_bound() {
        let fixture = Fixture::new();
        let (envelope, trust_store, expectation) = signed_fixture(&fixture);
        let verified = verify_external_evidence(
            &envelope,
            &trust_store,
            &expectation,
            &fixture.root,
        )
        .expect("verify");
        let mut ledger = ChallengeLedgerV1::open(fixture.root.join("ledger.sqlite"), fixture.uid)
            .expect("ledger");
        ledger
            .consume(&verified, &expectation.challenge_nonce, expectation.now_unix_ms)
            .expect("consume");
        assert!(matches!(
            ledger.consume(&verified, &expectation.challenge_nonce, expectation.now_unix_ms),
            Err(QualificationEvidenceError::ChallengeAlreadyConsumed)
        ));
    }

    #[test]
    fn wrong_tree_tampering_and_expiry_fail_closed() {
        let fixture = Fixture::new();
        let (mut envelope, trust_store, mut expectation) = signed_fixture(&fixture);
        expectation.tree = "c".repeat(40);
        assert!(matches!(
            verify_external_evidence(&envelope, &trust_store, &expectation, &fixture.root),
            Err(QualificationEvidenceError::ChallengeMismatch | QualificationEvidenceError::SubjectMismatch)
        ));
        expectation.tree = envelope.subject.tree.clone();
        envelope.claims["openCriticalFindings"] = Value::from(1);
        assert!(matches!(
            verify_external_evidence(&envelope, &trust_store, &expectation, &fixture.root),
            Err(QualificationEvidenceError::ClaimsInvalid)
        ));
        let (envelope, trust_store, mut expectation) = signed_fixture(&fixture);
        expectation.now_unix_ms = 20_000;
        assert!(matches!(
            verify_external_evidence(&envelope, &trust_store, &expectation, &fixture.root),
            Err(QualificationEvidenceError::ChallengeMismatch | QualificationEvidenceError::EvidenceExpired)
        ));
    }
}
