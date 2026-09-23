use hepta_legacy_compatibility::{
    MAXIMUM_NODE_ADAPTER_OUTPUT_BYTES_V1, NODE_LEGACY_ADAPTER_MODULE_ID_V1, NodeLegacyAdapterError,
    NodeLegacyObservationAdapterV1, NodeLegacyObservationRequestV1, NodeLegacyObservationV1,
};

fn digest(byte: u8) -> String {
    format!("sha256:{}", hex::encode([byte; 32]))
}

fn request() -> NodeLegacyObservationRequestV1 {
    NodeLegacyObservationRequestV1 {
        version: 1,
        attempt_id: "attempt:legacy:1".to_owned(),
        module_id: NODE_LEGACY_ADAPTER_MODULE_ID_V1.to_owned(),
        legacy_module_id: "module.node-control-plane".to_owned(),
        legacy_module_version: "node-source:1".to_owned(),
        capability_id: "CAP-CMP-LEGACY".to_owned(),
        candidate_hash: digest(1),
        input_hash: digest(2),
        node_entrypoint_hash: digest(3),
        expected_state_revision: 9,
        output_record_kind: "LegacyPreparedResult".to_owned(),
        maximum_output_bytes: 4096,
        maximum_artifacts: 4,
    }
}

fn observation() -> NodeLegacyObservationV1 {
    let request = request();
    NodeLegacyObservationV1 {
        version: 1,
        attempt_id: request.attempt_id,
        legacy_module_id: request.legacy_module_id,
        legacy_module_version: request.legacy_module_version,
        capability_id: request.capability_id,
        candidate_hash: request.candidate_hash,
        input_hash: request.input_hash,
        node_entrypoint_hash: request.node_entrypoint_hash,
        state_revision: request.expected_state_revision,
        output_json: br#"{"status":"prepared","value":{"a":1,"b":2}}"#.to_vec(),
        artifact_hashes: vec![digest(4), digest(5)],
        external_action_may_have_started: false,
    }
}

#[test]
fn exact_observation_is_prepared_without_authority_and_replays_idempotently() {
    let request = request();
    let observation = observation();
    let mut adapter = NodeLegacyObservationAdapterV1::default();

    let first = adapter
        .observe(&request, &observation)
        .expect("exact observation");
    let replay = adapter
        .observe(&request, &observation)
        .expect("exact replay");

    assert_eq!(first, replay);
    assert_eq!(first.module_id, NODE_LEGACY_ADAPTER_MODULE_ID_V1);
    assert!(first.output_record_hash.starts_with("sha256:"));
    assert!(first.observation_hash.starts_with("sha256:"));
    assert!(!first.authority_granted);
    assert!(!first.central_state_committed);
    assert!(!first.external_action_may_have_started);
}

#[test]
fn identity_or_external_action_drift_fails_closed() {
    let request = request();
    let mut adapter = NodeLegacyObservationAdapterV1::default();

    let mut identity_drift = observation();
    identity_drift.state_revision += 1;
    assert_eq!(
        adapter.observe(&request, &identity_drift),
        Err(NodeLegacyAdapterError::IdentityMismatch)
    );

    let mut external = observation();
    external.external_action_may_have_started = true;
    assert_eq!(
        adapter.observe(&request, &external),
        Err(NodeLegacyAdapterError::ExternalActionMayHaveStarted)
    );
}

#[test]
fn conflicting_attempt_reuse_is_rejected() {
    let request = request();
    let mut adapter = NodeLegacyObservationAdapterV1::default();
    adapter
        .observe(&request, &observation())
        .expect("first observation");

    let mut changed = observation();
    changed.output_json = br#"{"status":"prepared","value":{"a":2}}"#.to_vec();
    assert_eq!(
        adapter.observe(&request, &changed),
        Err(NodeLegacyAdapterError::ReplayConflict)
    );
}

#[test]
fn output_artifact_and_json_boundaries_are_enforced() {
    let mut adapter = NodeLegacyObservationAdapterV1::default();

    let mut invalid_request = request();
    invalid_request.maximum_output_bytes = MAXIMUM_NODE_ADAPTER_OUTPUT_BYTES_V1 + 1;
    assert_eq!(
        adapter.observe(&invalid_request, &observation()),
        Err(NodeLegacyAdapterError::Contract)
    );

    let request = request();
    let mut oversized = observation();
    oversized.output_json = vec![b' '; request.maximum_output_bytes + 1];
    assert_eq!(
        adapter.observe(&request, &oversized),
        Err(NodeLegacyAdapterError::OutputLimit)
    );

    let mut unordered = observation();
    unordered.artifact_hashes.reverse();
    assert_eq!(
        adapter.observe(&request, &unordered),
        Err(NodeLegacyAdapterError::ArtifactOrder)
    );

    let mut malformed = observation();
    malformed.output_json = b"{".to_vec();
    assert!(matches!(
        adapter.observe(&request, &malformed),
        Err(NodeLegacyAdapterError::Compatibility(_))
    ));
}
