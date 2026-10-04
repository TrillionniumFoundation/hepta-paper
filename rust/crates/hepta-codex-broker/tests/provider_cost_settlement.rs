//! Public provider-cost settlement contract with synthetic billing keys and receipts.
use std::str::FromStr;

use base64ct::{Base64UrlUnpadded, Encoding};
use ed25519_dalek::{Signer, SigningKey};
use hepta_codex_broker::{
    BrokerPreparedResultReceiptV1, ProviderCostSettlementError, ProviderCostSettlementPolicyV1,
    ProviderCostSettlementTrustStoreV1, ProviderCostSettlementV1,
    provider_cost_settlement_signing_bytes, verify_provider_cost_settlement,
};
use hepta_codex_protocol::{
    AgentRole, ApprovalPolicy, CodexExecutionRequestV1, NetworkPolicy, RequestCapabilityV1,
    SandboxPolicy, SessionPolicy, Sha256Digest, TaskKind, TokenUsage, Transport,
};
use serde_json::json;
use sha2::{Digest, Sha256};

fn digest(marker: u8) -> Sha256Digest {
    format!("sha256:{marker:064x}").parse().unwrap()
}

fn hash(bytes: &[u8]) -> Sha256Digest {
    Sha256Digest::from_str(&format!("sha256:{}", hex::encode(Sha256::digest(bytes)))).unwrap()
}

fn request(now: u64) -> CodexExecutionRequestV1 {
    CodexExecutionRequestV1 {
        version: 1,
        operation_id: "operation-cost-1".into(),
        idempotency_key: digest(1),
        campaign_id: "campaign-cost-1".into(),
        node_id: "node-cost-1".into(),
        attempt_id: "attempt-cost-1".into(),
        lease_generation: 1,
        campaign_revision: 2,
        role: AgentRole::Author,
        task_kind: TaskKind::Draft,
        codex_runtime_identity_hash: digest(2),
        model_selector: "qualified-model".into(),
        transport: Transport::ExecJsonlV1,
        session_policy: SessionPolicy::EphemeralNewThread,
        prompt_envelope_hash: digest(3),
        input_manifest_hash: digest(4),
        workspace_identity_hash: digest(5),
        output_schema_hash: digest(6),
        mutation_policy_hash: digest(7),
        sandbox_policy: SandboxPolicy::WorkspaceWrite,
        network_policy: NetworkPolicy::None,
        approval_policy: ApprovalPolicy::Never,
        absolute_deadline_unix_ms: now + 60_000,
        maximum_output_bytes: 4096,
        maximum_event_count: 100,
        maximum_cost_microusd: 10,
        remaining_token_hint: Some(100),
        request_capability: RequestCapabilityV1 {
            nonce: "cost-nonce-1".into(),
            issued_at_unix_ms: now - 1_000,
            expires_at_unix_ms: now + 30_000,
            signer_key_id: "request-key".into(),
            peer_uid: 1000,
            peer_gid: 1000,
            signature_base64: "A".repeat(86),
        },
    }
}

fn receipt(request: &CodexExecutionRequestV1, usage: TokenUsage) -> BrokerPreparedResultReceiptV1 {
    let h = digest(8);
    let mut receipt = BrokerPreparedResultReceiptV1 {
        version: 1,
        operation_id: request.operation_id.clone(),
        request_hash: hash(&serde_json::to_vec(request).unwrap()),
        campaign_id: request.campaign_id.clone(),
        node_id: request.node_id.clone(),
        attempt_id: request.attempt_id.clone(),
        lease_generation: request.lease_generation,
        campaign_revision: request.campaign_revision,
        role: request.role,
        runtime_identity_hash: request.codex_runtime_identity_hash.clone(),
        output_schema_hash: request.output_schema_hash.clone(),
        workspace_identity_hash: request.workspace_identity_hash.clone(),
        mutation_policy_hash: request.mutation_policy_hash.clone(),
        authority_evidence_hash: h.clone(),
        output_hash: h.clone(),
        schema_validation_hash: h.clone(),
        event_stream_hash: h.clone(),
        token_usage: Some(usage),
        workspace_result: serde_json::from_value(json!({
            "version":1,"attemptId":request.attempt_id,
            "workspaceIdentityHash":request.workspace_identity_hash,
            "beforeInventoryHash":h,"afterInventoryHash":h,
            "mutationManifestHash":h,"preparedResultHash":h
        }))
        .unwrap(),
        mutation_validation_hash: h.clone(),
        execution_evidence_hash: h.clone(),
        prepared_receipt_hash: h,
    };
    rehash_receipt(&mut receipt);
    receipt
}

fn rehash_receipt(receipt: &mut BrokerPreparedResultReceiptV1) {
    let encoded = serde_json::to_string(receipt).unwrap();
    let body = format!(
        "{}{}",
        encoded.split(",\"preparedReceiptHash\":").next().unwrap(),
        "}"
    );
    let raw: Box<serde_json::value::RawValue> = serde_json::from_str(&body).unwrap();
    receipt.prepared_receipt_hash =
        hash(&serde_json::to_vec(&("HeptaBrokerPreparedResultV1", raw)).unwrap());
    receipt.verify_hash().unwrap();
}

fn signed(
    request: &CodexExecutionRequestV1,
    receipt: &BrokerPreparedResultReceiptV1,
    key: &SigningKey,
    now: u64,
) -> ProviderCostSettlementV1 {
    let mut settlement = ProviderCostSettlementV1 {
        version: 1,
        operation_id: request.operation_id.clone(),
        request_hash: receipt.request_hash.clone(),
        prepared_receipt_hash: receipt.prepared_receipt_hash.clone(),
        campaign_id: request.campaign_id.clone(),
        node_id: request.node_id.clone(),
        attempt_id: request.attempt_id.clone(),
        lease_generation: request.lease_generation,
        campaign_revision: request.campaign_revision,
        settlement_id: "settlement-cost-1".into(),
        authority_domain_id: "provider-billing-domain".into(),
        trust_store_generation: 7,
        token_usage: receipt.token_usage,
        actual_cost_microusd: 6,
        issued_at_unix_ms: now,
        signer_key_id: "billing-key-1".into(),
        signature_base64: "AA".into(),
    };
    resign(&mut settlement, key);
    settlement
}

fn resign(settlement: &mut ProviderCostSettlementV1, key: &SigningKey) {
    settlement.signature_base64 = Base64UrlUnpadded::encode_string(
        &key.sign(&provider_cost_settlement_signing_bytes(settlement).unwrap())
            .to_bytes(),
    );
}

#[test]
fn signed_actual_cost_binds_request_prepared_receipt_usage_and_generation() {
    let now = 100_000;
    let request = request(now);
    let usage = TokenUsage {
        input_tokens: 10,
        cached_input_tokens: 2,
        output_tokens: 5,
        reasoning_output_tokens: 1,
    };
    let receipt = receipt(&request, usage);
    let key = SigningKey::from_bytes(&[71; 32]);
    let settlement = signed(&request, &receipt, &key, now);
    let trust = ProviderCostSettlementTrustStoreV1::new(
        "provider-billing-domain".into(),
        7,
        [(settlement.signer_key_id.clone(), key.verifying_key())],
    )
    .unwrap();
    let verified = verify_provider_cost_settlement(
        &settlement,
        &request,
        &receipt,
        now,
        ProviderCostSettlementPolicyV1::default(),
        &trust,
    )
    .unwrap();
    assert_eq!(verified.actual_cost_microusd(), 6);
    assert_eq!(
        verified.settlement_hash(),
        &hash(&provider_cost_settlement_signing_bytes(&settlement).unwrap())
    );
}

#[test]
fn substitutions_expiry_and_over_cap_cost_fail_closed() {
    let now = 100_000;
    let request = request(now);
    let receipt = receipt(&request, TokenUsage::default());
    let key = SigningKey::from_bytes(&[72; 32]);
    let base = signed(&request, &receipt, &key, now);
    let trust = ProviderCostSettlementTrustStoreV1::new(
        "provider-billing-domain".into(),
        7,
        [(base.signer_key_id.clone(), key.verifying_key())],
    )
    .unwrap();
    let changes: [fn(&mut ProviderCostSettlementV1); 15] = [
        |value| value.operation_id.push('x'),
        |value| value.prepared_receipt_hash = digest(9),
        |value| value.request_hash = digest(9),
        |value| value.campaign_id.push('x'),
        |value| value.node_id.push('x'),
        |value| value.attempt_id.push('x'),
        |value| value.lease_generation += 1,
        |value| value.campaign_revision += 1,
        |value| value.authority_domain_id.push('x'),
        |value| value.token_usage = None,
        |value| value.actual_cost_microusd = 11,
        |value| value.trust_store_generation += 1,
        |value| value.issued_at_unix_ms = 1,
        |value| value.issued_at_unix_ms = 100_001,
        |value| value.signer_key_id = "revoked-billing-key".into(),
    ];
    for change in changes {
        let mut changed = base.clone();
        change(&mut changed);
        resign(&mut changed, &key);
        assert!(
            verify_provider_cost_settlement(
                &changed,
                &request,
                &receipt,
                now,
                ProviderCostSettlementPolicyV1::default(),
                &trust,
            )
            .is_err()
        );
    }
    let mut wrong_domain = base.clone();
    wrong_domain.authority_domain_id = "different-billing-domain".into();
    resign(&mut wrong_domain, &key);
    assert!(matches!(
        verify_provider_cost_settlement(
            &wrong_domain,
            &request,
            &receipt,
            now,
            ProviderCostSettlementPolicyV1::default(),
            &trust,
        ),
        Err(ProviderCostSettlementError::AuthorityDomainMismatch)
    ));

    // Agreement between a forged receipt and settlement cannot replace the
    // verifier's independent hash of the actual request object.
    let mut wrong_receipt = receipt.clone();
    wrong_receipt.request_hash = digest(9);
    rehash_receipt(&mut wrong_receipt);
    let jointly_forged = signed(&request, &wrong_receipt, &key, now);
    assert!(matches!(
        verify_provider_cost_settlement(
            &jointly_forged,
            &request,
            &wrong_receipt,
            now,
            ProviderCostSettlementPolicyV1::default(),
            &trust,
        ),
        Err(ProviderCostSettlementError::SubjectMismatch)
    ));

    let mut invalid_signature = base;
    invalid_signature.actual_cost_microusd = 5;
    assert!(matches!(
        verify_provider_cost_settlement(
            &invalid_signature,
            &request,
            &receipt,
            now,
            ProviderCostSettlementPolicyV1::default(),
            &trust,
        ),
        Err(ProviderCostSettlementError::SignatureRejected)
    ));
}
