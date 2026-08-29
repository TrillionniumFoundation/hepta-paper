//! Scientific evidence contracts that separate production from independent verification.

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;

/// Strongest evidence class actually established by one record.
#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EvidenceLevelV1 {
    /// Deterministic contract-only fixture.
    ContractFixture,
    /// Real local runtime without independent external authority.
    RealRuntimeFixture,
    /// Authenticated live-model observation.
    LiveModel,
    /// Separately controlled external authority evidence.
    ExternalTrust,
}

/// Producer observation that remains untrusted until independently verified.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProducerEvidenceV1 {
    /// Contract version.
    pub version: u16,
    /// Campaign identity.
    pub campaign_id: String,
    /// Attempt identity.
    pub attempt_id: String,
    /// Producer implementation identity.
    pub producer_implementation_hash: String,
    /// Exact input manifest.
    pub input_manifest_hash: String,
    /// Exact output artifact set.
    pub artifact_hashes: Vec<String>,
    /// Assurance established by the producer alone.
    pub evidence_level: EvidenceLevelV1,
}

/// Independent recomputation and policy result.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IndependentVerificationV1 {
    /// Contract version.
    pub version: u16,
    /// Verifier implementation identity, distinct from producer.
    pub verifier_implementation_hash: String,
    /// Producer capsule hash verified by this record.
    pub producer_evidence_hash: String,
    /// Independently recomputed artifact-set hash.
    pub recomputed_artifact_set_hash: String,
    /// Evidence level actually established by this verifier.
    pub evidence_level: EvidenceLevelV1,
    /// Deterministic acceptance decision.
    pub accepted: bool,
    /// Stable bounded reason code.
    pub reason_code: String,
    /// Optional external-attestation hash required for `external_trust`.
    pub external_attestation_hash: Option<String>,
}

/// Verified capsule eligible for downstream policy evaluation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VerifiedEvidenceCapsuleV1 {
    /// Producer capsule hash.
    pub producer_evidence_hash: String,
    /// Independent verification hash.
    pub verification_hash: String,
    /// Strongest level actually proven.
    pub effective_level: EvidenceLevelV1,
    /// Sorted unique artifact hashes.
    pub artifact_hashes: Vec<String>,
}

/// Validates independent implementation, exact recomputation, and non-inflation.
pub fn verify_evidence_capsule_v1(
    producer: &ProducerEvidenceV1,
    verification: &IndependentVerificationV1,
) -> Result<VerifiedEvidenceCapsuleV1, EvidenceError> {
    validate_producer(producer)?;
    validate_verification(verification)?;
    let producer_hash = hash_serialized("HeptaProducerEvidenceV1", producer)?;
    if verification.producer_evidence_hash != producer_hash {
        return Err(EvidenceError::ProducerBindingMismatch);
    }
    if verification.verifier_implementation_hash == producer.producer_implementation_hash {
        return Err(EvidenceError::ImplementationNotIndependent);
    }
    let artifact_set_hash = hash_artifact_set(&producer.artifact_hashes)?;
    if verification.recomputed_artifact_set_hash != artifact_set_hash {
        return Err(EvidenceError::RecomputationMismatch);
    }
    if !verification.accepted {
        return Err(EvidenceError::VerificationRejected(
            verification.reason_code.clone(),
        ));
    }
    if verification.evidence_level > producer.evidence_level
        && verification.evidence_level != EvidenceLevelV1::ExternalTrust
    {
        return Err(EvidenceError::AssuranceInflation);
    }
    if verification.evidence_level == EvidenceLevelV1::ExternalTrust
        && verification.external_attestation_hash.is_none()
    {
        return Err(EvidenceError::ExternalAttestationMissing);
    }
    let effective_level = producer.evidence_level.min(verification.evidence_level);
    let verification_hash = hash_serialized("HeptaIndependentVerificationV1", verification)?;
    let mut artifact_hashes = producer.artifact_hashes.clone();
    artifact_hashes.sort();
    artifact_hashes.dedup();
    Ok(VerifiedEvidenceCapsuleV1 {
        producer_evidence_hash: producer_hash,
        verification_hash,
        effective_level,
        artifact_hashes,
    })
}

/// Canonical hash used by an independent recomputer over a sorted artifact set.
pub fn hash_artifact_set(values: &[String]) -> Result<String, EvidenceError> {
    if values.is_empty() {
        return Err(EvidenceError::ArtifactSetInvalid);
    }
    let mut ordered = BTreeSet::new();
    for value in values {
        validate_hash(value)?;
        if !ordered.insert(value) {
            return Err(EvidenceError::ArtifactSetInvalid);
        }
    }
    let mut hasher = Sha256::new();
    update(&mut hasher, b"HeptaArtifactSetV1");
    for value in ordered {
        update(&mut hasher, value.as_bytes());
    }
    Ok(format!("sha256:{}", hex::encode(hasher.finalize())))
}

fn validate_producer(value: &ProducerEvidenceV1) -> Result<(), EvidenceError> {
    if value.version != 1
        || !valid_identifier(&value.campaign_id)
        || !valid_identifier(&value.attempt_id)
    {
        return Err(EvidenceError::ContractInvalid);
    }
    validate_hash(&value.producer_implementation_hash)?;
    validate_hash(&value.input_manifest_hash)?;
    hash_artifact_set(&value.artifact_hashes)?;
    Ok(())
}

fn validate_verification(value: &IndependentVerificationV1) -> Result<(), EvidenceError> {
    if value.version != 1 || !valid_reason(&value.reason_code) {
        return Err(EvidenceError::ContractInvalid);
    }
    validate_hash(&value.verifier_implementation_hash)?;
    validate_hash(&value.producer_evidence_hash)?;
    validate_hash(&value.recomputed_artifact_set_hash)?;
    if let Some(hash) = &value.external_attestation_hash {
        validate_hash(hash)?;
    }
    Ok(())
}

fn hash_serialized<T: Serialize>(domain: &str, value: &T) -> Result<String, EvidenceError> {
    let bytes = serde_json::to_vec(value).map_err(|_| EvidenceError::Encoding)?;
    let mut hasher = Sha256::new();
    update(&mut hasher, domain.as_bytes());
    update(&mut hasher, &bytes);
    Ok(format!("sha256:{}", hex::encode(hasher.finalize())))
}

fn update(hasher: &mut Sha256, value: &[u8]) {
    hasher.update(u64::try_from(value.len()).unwrap_or(u64::MAX).to_be_bytes());
    hasher.update(value);
}

fn validate_hash(value: &str) -> Result<(), EvidenceError> {
    let Some(hex) = value.strip_prefix("sha256:") else {
        return Err(EvidenceError::HashInvalid);
    };
    if hex.len() != 64
        || !hex
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(EvidenceError::HashInvalid);
    }
    Ok(())
}

fn valid_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':')
        })
}

fn valid_reason(value: &str) -> bool {
    valid_identifier(value)
}

/// Evidence contract or independence failure.
#[derive(Clone, Debug, Error, Eq, PartialEq)]
pub enum EvidenceError {
    /// Contract fields are invalid.
    #[error("scientific evidence contract is invalid")]
    ContractInvalid,
    /// A digest is noncanonical.
    #[error("scientific evidence hash is invalid")]
    HashInvalid,
    /// Artifact set is empty, duplicated, or malformed.
    #[error("scientific artifact set is invalid")]
    ArtifactSetInvalid,
    /// Producer record hash differs.
    #[error("scientific producer binding mismatch")]
    ProducerBindingMismatch,
    /// Producer and verifier share an implementation identity.
    #[error("scientific verifier is not implementation-independent")]
    ImplementationNotIndependent,
    /// Independent recomputation differs.
    #[error("scientific recomputation mismatch")]
    RecomputationMismatch,
    /// Verifier rejected evidence.
    #[error("scientific verification rejected: {0}")]
    VerificationRejected(String),
    /// Evidence was promoted without matching authority.
    #[error("scientific evidence assurance inflation")]
    AssuranceInflation,
    /// External-trust level lacks external attestation.
    #[error("external scientific attestation is missing")]
    ExternalAttestationMissing,
    /// Canonical encoding failed.
    #[error("scientific evidence encoding failed")]
    Encoding,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hash(byte: char) -> String {
        format!("sha256:{}", byte.to_string().repeat(64))
    }

    fn producer() -> ProducerEvidenceV1 {
        ProducerEvidenceV1 {
            version: 1,
            campaign_id: "campaign-1".into(),
            attempt_id: "attempt-1".into(),
            producer_implementation_hash: hash('1'),
            input_manifest_hash: hash('2'),
            artifact_hashes: vec![hash('3'), hash('4')],
            evidence_level: EvidenceLevelV1::RealRuntimeFixture,
        }
    }

    #[test]
    fn independent_recomputation_is_accepted_without_assurance_inflation() {
        let producer = producer();
        let verification = IndependentVerificationV1 {
            version: 1,
            verifier_implementation_hash: hash('5'),
            producer_evidence_hash: hash_serialized("HeptaProducerEvidenceV1", &producer)
                .expect("producer hash"),
            recomputed_artifact_set_hash: hash_artifact_set(&producer.artifact_hashes)
                .expect("artifact set"),
            evidence_level: EvidenceLevelV1::RealRuntimeFixture,
            accepted: true,
            reason_code: "independent_replay_passed".into(),
            external_attestation_hash: None,
        };
        let capsule = verify_evidence_capsule_v1(&producer, &verification).expect("capsule");
        assert_eq!(capsule.effective_level, EvidenceLevelV1::RealRuntimeFixture);
    }

    #[test]
    fn shared_implementation_and_unattested_external_trust_fail_closed() {
        let producer = producer();
        let mut verification = IndependentVerificationV1 {
            version: 1,
            verifier_implementation_hash: producer.producer_implementation_hash.clone(),
            producer_evidence_hash: hash_serialized("HeptaProducerEvidenceV1", &producer)
                .expect("producer hash"),
            recomputed_artifact_set_hash: hash_artifact_set(&producer.artifact_hashes)
                .expect("artifact set"),
            evidence_level: EvidenceLevelV1::RealRuntimeFixture,
            accepted: true,
            reason_code: "passed".into(),
            external_attestation_hash: None,
        };
        assert_eq!(
            verify_evidence_capsule_v1(&producer, &verification),
            Err(EvidenceError::ImplementationNotIndependent)
        );
        verification.verifier_implementation_hash = hash('6');
        verification.evidence_level = EvidenceLevelV1::ExternalTrust;
        assert_eq!(
            verify_evidence_capsule_v1(&producer, &verification),
            Err(EvidenceError::ExternalAttestationMissing)
        );
    }
}
