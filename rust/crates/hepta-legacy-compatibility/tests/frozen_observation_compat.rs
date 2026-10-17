//! Frozen outputs executed from original blob 2da20018c57dca72db106966f832be5384c921db.
use hepta_legacy_compatibility::frozen_observation_compat_v1::*;
use serde_json::Value;

fn fixture() -> (NodeLegacyObservationV1, Value) {
    let value: Value =
        serde_json::from_str(include_str!("fixtures/frozen-observation-compat-v1.json")).unwrap();
    (
        serde_json::from_value(value["observationInput"].clone()).unwrap(),
        value["observationPrepared"].clone(),
    )
}

#[test]
fn exact_original_raw_byte_receipt_and_operation_replay_are_preserved() {
    let (observation, expected) = fixture();
    assert!(std::str::from_utf8(&observation.output_bytes).is_err());
    let mut adapter = NodeLegacyAdapterV1::new(1024, 16).unwrap();
    let result = adapter.observe(observation.clone(), 1000).unwrap();
    assert_eq!(serde_json::to_value(&result).unwrap(), expected);
    assert!(!result.central_writer_authorized);
    assert!(!result.provider_dispatch_authorized);
    assert!(!result.external_effect_authorized);
    assert_eq!(adapter.observe(observation.clone(), 1001).unwrap(), result);
    assert_eq!(adapter.record_count(), 1);
    let mut different_attempt = observation;
    different_attempt.attempt_id = "attempt:2".into();
    assert_eq!(
        adapter.observe(different_attempt, 1000),
        Err(NodeLegacyAdapterError::ReplayConflict)
    );
}

#[test]
fn runtime_and_parity_claims_are_hash_bound_without_becoming_authority() {
    let (original, _) = fixture();
    for field in [
        "nodeRuntimeHash",
        "parityEvidenceHash",
        "candidateHash",
        "planHash",
    ] {
        let mut value = serde_json::to_value(&original).unwrap();
        value[field] = Value::String(format!("sha256:{}", "f".repeat(64)));
        let changed: NodeLegacyObservationV1 = serde_json::from_value(value).unwrap();
        let mut adapter = NodeLegacyAdapterV1::new(1024, 16).unwrap();
        let initial = adapter.observe(original.clone(), 1000).unwrap();
        assert_eq!(
            adapter.observe(changed.clone(), 1000),
            Err(NodeLegacyAdapterError::ReplayConflict)
        );
        let mut independent = NodeLegacyAdapterV1::new(1024, 16).unwrap();
        let rebuilt = independent.observe(changed, 1000).unwrap();
        assert_ne!(initial.receipt_hash, rebuilt.receipt_hash, "{field}");
        assert!(
            !rebuilt.central_writer_authorized
                && !rebuilt.provider_dispatch_authorized
                && !rebuilt.external_effect_authorized
        );
    }
}

#[test]
fn original_exact_24_hour_and_expiry_boundaries_are_preserved_on_replay() {
    let (original, _) = fixture();
    let mut adapter = NodeLegacyAdapterV1::new(1024, 16).unwrap();
    assert_eq!(
        adapter.observe(original.clone(), 999),
        Err(NodeLegacyAdapterError::ObservationInvalid)
    );
    adapter.observe(original.clone(), 1000).unwrap();
    adapter
        .observe(original.clone(), original.expires_at_unix_ms - 1)
        .unwrap();
    assert_eq!(
        adapter.observe(original.clone(), original.expires_at_unix_ms),
        Err(NodeLegacyAdapterError::ObservationInvalid)
    );
    let mut too_long = original;
    too_long.expires_at_unix_ms += 1;
    assert_eq!(
        NodeLegacyAdapterV1::new(1024, 16)
            .unwrap()
            .observe(too_long, 1000),
        Err(NodeLegacyAdapterError::ObservationInvalid)
    );
}

#[test]
fn every_authority_flag_and_tampered_or_oversized_bytes_are_rejected() {
    let (original, _) = fixture();
    for flag in [
        "centralWriterReachable",
        "providerDispatchReachable",
        "externalEffectReachable",
        "externalActionMayHaveStarted",
    ] {
        let mut value = serde_json::to_value(&original).unwrap();
        value["authority"][flag] = Value::Bool(true);
        let changed = serde_json::from_value(value).unwrap();
        assert_eq!(
            NodeLegacyAdapterV1::new(1024, 16)
                .unwrap()
                .observe(changed, 1000),
            Err(NodeLegacyAdapterError::AuthorityEscalation)
        );
    }
    let mut tampered = original.clone();
    tampered.output_bytes[0] = 1;
    assert_eq!(
        NodeLegacyAdapterV1::new(1024, 16)
            .unwrap()
            .observe(tampered, 1000),
        Err(NodeLegacyAdapterError::OutputHashMismatch)
    );
    assert_eq!(
        NodeLegacyAdapterV1::new(4, 16)
            .unwrap()
            .observe(original.clone(), 1000),
        Err(NodeLegacyAdapterError::ObservationInvalid)
    );
    for artifacts in [
        vec![],
        vec![original.artifact_hashes[0].clone(); 2],
        original.artifact_hashes.iter().rev().cloned().collect(),
    ] {
        let mut changed = original.clone();
        changed.artifact_hashes = artifacts;
        assert_eq!(
            NodeLegacyAdapterV1::new(1024, 16)
                .unwrap()
                .observe(changed, 1000),
            Err(NodeLegacyAdapterError::ObservationInvalid)
        );
    }
    assert!(matches!(
        NodeLegacyAdapterV1::new(0, 1),
        Err(NodeLegacyAdapterError::PolicyInvalid)
    ));
    assert!(matches!(
        NodeLegacyAdapterV1::new(1, 0),
        Err(NodeLegacyAdapterError::PolicyInvalid)
    ));
}
