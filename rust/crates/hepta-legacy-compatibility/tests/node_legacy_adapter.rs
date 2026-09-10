use std::str::FromStr;

use hepta_codex_protocol::Sha256Digest;
use hepta_legacy_compatibility::{
    NodeLegacyAdapterError, NodeLegacyAdapterV1, NodeLegacyAuthorityObservationV1,
    NodeLegacyObservationV1, NodeLegacyParityClassV1,
};
use sha2::{Digest, Sha256};

fn digest(marker: char) -> Sha256Digest {
    Sha256Digest::from_str(&format!("sha256:{}", marker.to_string().repeat(64)))
        .expect("test digest")
}

fn hash_bytes(bytes: &[u8]) -> Sha256Digest {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    Sha256Digest::from_str(&format!("sha256:{}", hex::encode(hasher.finalize())))
        .expect("test digest")
}

fn observation() -> NodeLegacyObservationV1 {
    let output = br#"{"status":"prepared","value":7}"#.to_vec();
    NodeLegacyObservationV1 {
        version: 1,
        operation_id: "operation-1".to_owned(),
        attempt_id: "attempt-1".to_owned(),
        campaign_id: "campaign-1".to_owned(),
        capability_id: "CAP-CMP-LEGACY".to_owned(),
        module_id: "module.node-control-plane".to_owned(),
        module_version: "0.6.0".to_owned(),
        node_runtime_hash: digest('a'),
        node_entrypoint_hash: digest('b'),
        legacy_state_revision: 41,
        snapshot_hash: digest('c'),
        planning_request_hash: digest('d'),
        plan_hash: digest('e'),
        candidate_hash: digest('f'),
        input_hash: digest('1'),
        output_hash: hash_bytes(&output),
        output_bytes: output,
        artifact_hashes: vec![digest('2'), digest('3')],
        parity_class: NodeLegacyParityClassV1::Exact,
        parity_evidence_hash: digest('4'),
        observed_at_unix_ms: 1_000,
        expires_at_unix_ms: 2_000,
        authority: NodeLegacyAuthorityObservationV1::default(),
    }
}

#[test]
fn emits_non_authorizing_hash_bound_prepared_observation() {
    let mut adapter = NodeLegacyAdapterV1::new(1024, 8).expect("adapter");
    let result = adapter.observe(observation(), 1_500).expect("observation");
    assert_eq!(result.operation_id, "operation-1");
    assert_eq!(result.output_bytes, 31);
    assert!(!result.central_writer_authorized);
    assert!(!result.provider_dispatch_authorized);
    assert!(!result.external_effect_authorized);
    assert_eq!(adapter.record_count(), 1);
}

#[test]
fn exact_replay_returns_original_receipt_and_conflict_fails() {
    let mut adapter = NodeLegacyAdapterV1::new(1024, 8).expect("adapter");
    let first = adapter.observe(observation(), 1_500).expect("first");
    let second = adapter.observe(observation(), 1_600).expect("replay");
    assert_eq!(first, second);

    let mut conflict = observation();
    conflict.attempt_id = "attempt-2".to_owned();
    assert_eq!(
        adapter.observe(conflict, 1_600),
        Err(NodeLegacyAdapterError::ReplayConflict)
    );
}

#[test]
fn rejects_authority_exposure_hash_drift_staleness_and_bounds() {
    let mut adapter = NodeLegacyAdapterV1::new(64, 2).expect("adapter");

    let mut authority = observation();
    authority.authority.provider_dispatch_reachable = true;
    assert_eq!(
        adapter.observe(authority, 1_500),
        Err(NodeLegacyAdapterError::AuthorityEscalation)
    );

    let mut hash_drift = observation();
    hash_drift.output_hash = digest('9');
    assert_eq!(
        adapter.observe(hash_drift, 1_500),
        Err(NodeLegacyAdapterError::OutputHashMismatch)
    );

    assert_eq!(
        adapter.observe(observation(), 2_000),
        Err(NodeLegacyAdapterError::ObservationInvalid)
    );

    let mut too_large = observation();
    too_large.output_bytes = vec![0; 65];
    too_large.output_hash = hash_bytes(&too_large.output_bytes);
    assert_eq!(
        adapter.observe(too_large, 1_500),
        Err(NodeLegacyAdapterError::ObservationInvalid)
    );

    let mut duplicate_artifact = observation();
    duplicate_artifact.artifact_hashes = vec![digest('2'), digest('2')];
    assert_eq!(
        adapter.observe(duplicate_artifact, 1_500),
        Err(NodeLegacyAdapterError::ObservationInvalid)
    );
}

#[test]
fn wire_decoder_rejects_unknown_fields() {
    let mut value = serde_json::to_value(observation()).expect("serialize fixture");
    value
        .as_object_mut()
        .expect("object")
        .insert("unexpected".to_owned(), serde_json::Value::Bool(true));
    assert!(serde_json::from_value::<NodeLegacyObservationV1>(value).is_err());
}

#[test]
fn deployment_policy_cannot_exceed_protocol_limits() {
    assert!(matches!(
        NodeLegacyAdapterV1::new(0, 1),
        Err(NodeLegacyAdapterError::PolicyInvalid)
    ));
    assert!(matches!(
        NodeLegacyAdapterV1::new(1, 0),
        Err(NodeLegacyAdapterError::PolicyInvalid)
    ));
}
