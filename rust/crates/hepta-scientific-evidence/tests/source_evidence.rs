use hepta_scientific_evidence::{
    EvidenceError, EvidenceLevelV1, IndependentVerificationV1, ProducerEvidenceV1,
    hash_artifact_set, verify_evidence_capsule_v1,
};
use sha2::{Digest, Sha256};

fn hash(marker: char) -> String {
    format!("sha256:{}", marker.to_string().repeat(64))
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

fn producer_hash(value: &ProducerEvidenceV1) -> String {
    let bytes = serde_json::to_vec(value).expect("producer encoding");
    let mut hasher = Sha256::new();
    update(&mut hasher, b"HeptaProducerEvidenceV1");
    update(&mut hasher, &bytes);
    format!("sha256:{}", hex::encode(hasher.finalize()))
}

fn update(hasher: &mut Sha256, value: &[u8]) {
    hasher.update(
        u64::try_from(value.len())
            .expect("bounded test value")
            .to_be_bytes(),
    );
    hasher.update(value);
}

#[test]
fn independent_recomputation_is_accepted_without_assurance_inflation() {
    let producer = producer();
    let verification = IndependentVerificationV1 {
        version: 1,
        verifier_implementation_hash: hash('5'),
        producer_evidence_hash: producer_hash(&producer),
        recomputed_artifact_set_hash: hash_artifact_set(&producer.artifact_hashes)
            .expect("artifact set"),
        evidence_level: EvidenceLevelV1::RealRuntimeFixture,
        accepted: true,
        reason_code: "independent_replay_passed".into(),
        external_attestation_hash: None,
    };

    let capsule = verify_evidence_capsule_v1(&producer, &verification).expect("capsule");
    assert_eq!(capsule.effective_level, EvidenceLevelV1::RealRuntimeFixture);
    assert_eq!(capsule.artifact_hashes, producer.artifact_hashes);
}

#[test]
fn shared_implementation_and_unattested_external_trust_fail_closed() {
    let producer = producer();
    let mut verification = IndependentVerificationV1 {
        version: 1,
        verifier_implementation_hash: producer.producer_implementation_hash.clone(),
        producer_evidence_hash: producer_hash(&producer),
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
