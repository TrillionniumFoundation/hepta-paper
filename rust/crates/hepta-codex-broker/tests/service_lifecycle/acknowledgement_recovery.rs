use super::*;
use hepta_codex_broker::{
    PreparedResultAcknowledgementError, verify_persisted_prepared_result_acknowledgement,
};

pub(super) fn signed_ack(
    request: &CodexExecutionRequestV1,
    request_hash: Sha256Digest,
) -> (
    PreparedResultAcknowledgementV1,
    PreparedResultAcknowledgementTrustStoreV1,
) {
    let key = SigningKey::from_bytes(&[12; 32]);
    let mut acknowledgement = PreparedResultAcknowledgementV1 {
        version: 1,
        operation_id: request.operation_id.clone(),
        request_hash,
        prepared_receipt_hash: digest('e'),
        campaign_id: request.campaign_id.clone(),
        node_id: request.node_id.clone(),
        attempt_id: request.attempt_id.clone(),
        campaign_revision: request.campaign_revision,
        lease_generation: request.lease_generation,
        acknowledged_at_unix_ms: 13_000,
        signer_key_id: "campaign-writer-key-1".to_owned(),
        signature_base64: "AA".to_owned(),
    };
    resign(&mut acknowledgement);
    let trust = PreparedResultAcknowledgementTrustStoreV1::new([(
        acknowledgement.signer_key_id.clone(),
        key.verifying_key(),
    )])
    .expect("actual public acknowledgement key");
    (acknowledgement, trust)
}

fn resign(acknowledgement: &mut PreparedResultAcknowledgementV1) {
    let key = SigningKey::from_bytes(&[12; 32]);
    let bytes = prepared_result_acknowledgement_signing_bytes(acknowledgement)
        .expect("acknowledgement bytes");
    acknowledgement.signature_base64 =
        Base64UrlUnpadded::encode_string(&key.sign(&bytes).to_bytes());
}

fn prepare(
    fixture: &TempTree,
) -> (
    BrokerJournalStoreV1,
    PreparedResultAcknowledgementV1,
    PreparedResultAcknowledgementTrustStoreV1,
) {
    let mut store = fixture.open_journal();
    let (request, request_hash) = reserve_operation(&mut store, "ack-recovery");
    append_prepared_path(&mut store, fixture, &request.operation_id, digest('e'));
    let (ack, trust) = signed_ack(&request, request_hash);
    (store, ack, trust)
}

#[test]
fn lost_ack_reply_replays_the_original_terminal_journal_after_reopen() {
    let fixture = TempTree::new();
    let (mut store, ack, trust) = prepare(&fixture);
    let verified = verify_persisted_prepared_result_acknowledgement(
        &store,
        &ack,
        13_001,
        PreparedResultAcknowledgementPolicyV1::default(),
        &trust,
    )
    .expect("initial acknowledgement");
    let committed =
        apply_prepared_result_acknowledgement(&mut store, &verified, FaultInjectionPointV1::None)
            .expect("original durable acknowledgement");
    let expected = serde_json::to_vec(&committed).expect("original terminal journal");
    drop(store); // The writer committed but its reply was not received.
    let mut reopened = fixture.open_journal();
    let replay = verify_persisted_prepared_result_acknowledgement(
        &reopened,
        &ack,
        14_000,
        PreparedResultAcknowledgementPolicyV1::default(),
        &trust,
    )
    .expect("exact durable replay under unchanged signature and time policy");
    let observed =
        apply_prepared_result_acknowledgement(&mut reopened, &replay, FaultInjectionPointV1::None)
            .expect("idempotent terminal acknowledgement");
    assert_eq!(serde_json::to_vec(&observed).unwrap(), expected);
    assert_eq!(reopened.operation_count().unwrap(), 1);
    reopened.validate_integrity().unwrap();
}

#[test]
fn acknowledgement_replay_rejects_changed_signed_body_and_wrong_current_key() {
    let fixture = TempTree::new();
    let (mut store, ack, trust) = prepare(&fixture);
    let verified = verify_persisted_prepared_result_acknowledgement(
        &store,
        &ack,
        13_001,
        PreparedResultAcknowledgementPolicyV1::default(),
        &trust,
    )
    .unwrap();
    let original =
        apply_prepared_result_acknowledgement(&mut store, &verified, FaultInjectionPointV1::None)
            .unwrap();
    for change in 0..4 {
        let mut changed = ack.clone();
        match change {
            0 => changed.acknowledged_at_unix_ms += 1,
            1 => changed.campaign_revision += 1,
            2 => changed.lease_generation += 1,
            _ => changed.prepared_receipt_hash = digest('f'),
        }
        resign(&mut changed);
        assert!(
            verify_persisted_prepared_result_acknowledgement(
                &store,
                &changed,
                14_000,
                PreparedResultAcknowledgementPolicyV1::default(),
                &trust,
            )
            .is_err(),
            "changed acknowledgement {change}"
        );
    }
    let wrong_trust = PreparedResultAcknowledgementTrustStoreV1::new([(
        ack.signer_key_id.clone(),
        SigningKey::from_bytes(&[13; 32]).verifying_key(),
    )])
    .unwrap();
    assert!(matches!(
        verify_persisted_prepared_result_acknowledgement(
            &store,
            &ack,
            14_000,
            PreparedResultAcknowledgementPolicyV1::default(),
            &wrong_trust,
        ),
        Err(PreparedResultAcknowledgementError::SignatureRejected)
    ));
    assert_eq!(
        serde_json::to_vec(&store.load_journal(&ack.operation_id).unwrap()).unwrap(),
        serde_json::to_vec(&original).unwrap()
    );
}

#[test]
fn expired_new_acknowledgement_does_not_gain_historical_replay_privilege() {
    let fixture = TempTree::new();
    let (store, ack, trust) = prepare(&fixture);
    assert!(matches!(
        verify_persisted_prepared_result_acknowledgement(
            &store,
            &ack,
            13_000 + 24 * 60 * 60 * 1000,
            PreparedResultAcknowledgementPolicyV1::default(),
            &trust,
        ),
        Err(PreparedResultAcknowledgementError::AcknowledgementExpired)
    ));
    assert_eq!(
        store.load_journal(&ack.operation_id).unwrap().current_state,
        OperationState::ResultPrepared
    );
}

#[test]
fn two_verified_acknowledgements_do_not_append_two_terminal_transitions() {
    let fixture = TempTree::new();
    let (mut first, ack, trust) = prepare(&fixture);
    let mut second = fixture.open_journal();
    let verify = |store: &BrokerJournalStoreV1| {
        verify_persisted_prepared_result_acknowledgement(
            store,
            &ack,
            13_001,
            PreparedResultAcknowledgementPolicyV1::default(),
            &trust,
        )
        .unwrap()
    };
    let a = verify(&first);
    let b = verify(&second);
    let expected =
        apply_prepared_result_acknowledgement(&mut first, &a, FaultInjectionPointV1::None).unwrap();
    let observed =
        apply_prepared_result_acknowledgement(&mut second, &b, FaultInjectionPointV1::None)
            .expect("second writer observes the same committed acknowledgement");
    assert_eq!(
        serde_json::to_vec(&observed).unwrap(),
        serde_json::to_vec(&expected).unwrap()
    );
}

#[test]
fn failed_ack_transaction_rolls_back_and_remains_retryable() {
    for fault in [
        FaultInjectionPointV1::AfterTransitionInsert,
        FaultInjectionPointV1::AfterProjectionUpdate,
    ] {
        let fixture = TempTree::new();
        let (mut store, ack, trust) = prepare(&fixture);
        let verified = verify_persisted_prepared_result_acknowledgement(
            &store,
            &ack,
            13_001,
            PreparedResultAcknowledgementPolicyV1::default(),
            &trust,
        )
        .unwrap();
        let original = serde_json::to_vec(&store.load_journal(&ack.operation_id).unwrap()).unwrap();
        assert!(matches!(
            apply_prepared_result_acknowledgement(&mut store, &verified, fault),
            Err(PreparedResultAcknowledgementError::Journal(_))
        ));
        assert_eq!(
            serde_json::to_vec(&store.load_journal(&ack.operation_id).unwrap()).unwrap(),
            original
        );
        drop(store);
        let mut reopened = fixture.open_journal();
        let result = apply_prepared_result_acknowledgement(
            &mut reopened,
            &verified,
            FaultInjectionPointV1::None,
        )
        .unwrap();
        assert_eq!(result.current_state, OperationState::Acknowledged);
        reopened.validate_integrity().unwrap();
    }
}

#[test]
fn completed_ack_replay_still_requires_current_time_and_signature_policy() {
    let fixture = TempTree::new();
    let (mut store, ack, trust) = prepare(&fixture);
    let verified = verify_persisted_prepared_result_acknowledgement(
        &store,
        &ack,
        13_001,
        PreparedResultAcknowledgementPolicyV1::default(),
        &trust,
    )
    .unwrap();
    apply_prepared_result_acknowledgement(&mut store, &verified, FaultInjectionPointV1::None)
        .unwrap();
    for now in [0, 12_999, 13_000 + 24 * 60 * 60 * 1000] {
        assert!(matches!(
            verify_persisted_prepared_result_acknowledgement(
                &store,
                &ack,
                now,
                PreparedResultAcknowledgementPolicyV1::default(),
                &trust,
            ),
            Err(PreparedResultAcknowledgementError::AcknowledgementExpired)
        ));
    }
}
