use super::{
    tests::{authority, signed_bundle},
    *,
};
use crate::{
    CapabilityPolicyV1, PeerIdentityV1, capability_signing_bytes, verify_request_capability,
};
use ed25519_dalek::{Signer, SigningKey};
use hepta_codex_protocol::{
    ApprovalPolicy, CodexExecutionRequestV1, NetworkPolicy, RequestCapabilityV1, SandboxPolicy,
    SessionPolicy, TaskKind, Transport,
};

const PEER: PeerIdentityV1 = PeerIdentityV1 {
    pid: 42,
    uid: 1000,
    gid: 1000,
};

fn signed_request(key_id: &str, key: &SigningKey) -> CodexExecutionRequestV1 {
    let digest = |byte: char| {
        Sha256Digest::from_str(&format!("sha256:{}", byte.to_string().repeat(64)))
            .expect("fixture digest")
    };
    let mut request = CodexExecutionRequestV1 {
        version: 1,
        operation_id: "scheduled-key-operation".into(),
        idempotency_key: digest('1'),
        campaign_id: "campaign-1".into(),
        node_id: "node-1".into(),
        attempt_id: "attempt-1".into(),
        lease_generation: 1,
        campaign_revision: 0,
        role: AgentRole::Author,
        task_kind: TaskKind::Draft,
        codex_runtime_identity_hash: digest('2'),
        model_selector: "qualified-model".into(),
        transport: Transport::ExecJsonlV1,
        session_policy: SessionPolicy::EphemeralNewThread,
        prompt_envelope_hash: digest('3'),
        input_manifest_hash: digest('4'),
        workspace_identity_hash: digest('5'),
        output_schema_hash: digest('6'),
        mutation_policy_hash: digest('7'),
        sandbox_policy: SandboxPolicy::WorkspaceWrite,
        network_policy: NetworkPolicy::None,
        approval_policy: ApprovalPolicy::Never,
        absolute_deadline_unix_ms: 60_000,
        maximum_output_bytes: 1024,
        maximum_event_count: 100,
        maximum_cost_microusd: 1000,
        remaining_token_hint: Some(100),
        request_capability: RequestCapabilityV1 {
            nonce: "scheduled-key-nonce".into(),
            issued_at_unix_ms: 1000,
            expires_at_unix_ms: 50_000,
            signer_key_id: key_id.into(),
            peer_uid: PEER.uid,
            peer_gid: PEER.gid,
            signature_base64: "AA".into(),
        },
    };
    let bytes = capability_signing_bytes(&request).expect("actual request signing bytes");
    request.request_capability.signature_base64 =
        Base64UrlUnpadded::encode_string(&key.sign(&bytes).to_bytes());
    request
}

fn verify_at(
    manager: &CapabilityTrustBundleManagerV1,
    request: &CodexExecutionRequestV1,
    now: u64,
) -> Result<(), CapabilityVerificationError> {
    let (trust, _, _) = manager.snapshot(now).expect("current signed key snapshot");
    verify_request_capability(request, PEER, now, CapabilityPolicyV1::default(), &trust).map(|_| ())
}

#[test]
fn key_expiry_and_future_activation_are_evaluated_on_every_snapshot() {
    let root = SigningKey::from_bytes(&[21; 32]);
    let old = SigningKey::from_bytes(&[22; 32]);
    let next = SigningKey::from_bytes(&[23; 32]);
    let reviewer = SigningKey::from_bytes(&[24; 32]);
    let envelope = signed_bundle(
        1,
        None,
        1,
        vec![
            (
                "old".into(),
                old.clone(),
                vec![AgentRole::Author],
                1000,
                20_000,
            ),
            (
                "next".into(),
                next.clone(),
                vec![AgentRole::Author],
                20_000,
                90_000,
            ),
            (
                "reviewer".into(),
                reviewer.clone(),
                vec![AgentRole::Reviewer],
                1000,
                90_000,
            ),
        ],
        Vec::new(),
        &root,
    );
    let verified = verify_capability_trust_bundle(
        &envelope,
        AgentRole::Author,
        10_000,
        &authority(&root),
        None,
    )
    .expect("signed installation");
    let hash = verified.bundle_hash().clone();
    let manager = CapabilityTrustBundleManagerV1::new(verified);
    let old_request = signed_request("old", &old);
    let next_request = signed_request("next", &next);
    assert!(verify_at(&manager, &old_request, 19_999).is_ok());
    assert!(matches!(
        verify_at(&manager, &next_request, 19_999),
        Err(CapabilityVerificationError::UnknownSignerKey(_))
    ));
    assert!(matches!(
        verify_at(&manager, &old_request, 20_000),
        Err(CapabilityVerificationError::UnknownSignerKey(_))
    ));
    assert!(verify_at(&manager, &next_request, 20_000).is_ok());
    assert!(matches!(
        verify_at(&manager, &signed_request("reviewer", &reviewer), 20_000),
        Err(CapabilityVerificationError::UnknownSignerKey(_))
    ));
    let (_, generation, observed_hash) = manager.snapshot(20_001).expect("unchanged bundle");
    assert_eq!(generation, 1);
    assert_eq!(observed_hash, hash);
}

#[test]
fn scheduled_revocation_removes_only_the_revoked_signer_at_the_exact_boundary() {
    let root = SigningKey::from_bytes(&[25; 32]);
    let revoked = SigningKey::from_bytes(&[26; 32]);
    let continuing = SigningKey::from_bytes(&[27; 32]);
    let mut envelope = signed_bundle(
        1,
        None,
        1,
        vec![
            (
                "revoked".into(),
                revoked.clone(),
                vec![AgentRole::Author],
                1000,
                90_000,
            ),
            (
                "continuing".into(),
                continuing.clone(),
                vec![AgentRole::Author],
                1000,
                90_000,
            ),
        ],
        vec![CapabilityKeyRevocationV1 {
            key_id: "revoked".into(),
            effective_at_unix_ms: 25_000,
            reason_code: "scheduled_rotation".into(),
        }],
        &root,
    );
    let verified = verify_capability_trust_bundle(
        &envelope,
        AgentRole::Author,
        10_000,
        &authority(&root),
        None,
    )
    .expect("signed future revocation");
    let manager = CapabilityTrustBundleManagerV1::new(verified);
    // Altering the input after verification cannot alter its retained schedule.
    envelope.bundle.revocations[0].effective_at_unix_ms = 80_000;
    assert!(matches!(
        verify_capability_trust_bundle(
            &envelope,
            AgentRole::Author,
            10_000,
            &authority(&root),
            None,
        ),
        Err(TrustBundleError::BundleSignatureRejected)
    ));
    let request = signed_request("revoked", &revoked);
    assert!(verify_at(&manager, &request, 24_999).is_ok());
    assert!(matches!(
        verify_at(&manager, &request, 25_000),
        Err(CapabilityVerificationError::UnknownSignerKey(_))
    ));
    assert!(verify_at(&manager, &signed_request("continuing", &continuing), 25_000).is_ok());
}

#[test]
fn no_active_key_refuses_the_gap_without_losing_a_signed_future_key() {
    let root = SigningKey::from_bytes(&[28; 32]);
    let old = SigningKey::from_bytes(&[29; 32]);
    let future = SigningKey::from_bytes(&[30; 32]);
    let envelope = signed_bundle(
        1,
        None,
        1,
        vec![
            ("old".into(), old, vec![AgentRole::Author], 1000, 20_000),
            (
                "future".into(),
                future.clone(),
                vec![AgentRole::Author],
                30_000,
                90_000,
            ),
        ],
        Vec::new(),
        &root,
    );
    let verified = verify_capability_trust_bundle(
        &envelope,
        AgentRole::Author,
        10_000,
        &authority(&root),
        None,
    )
    .expect("initially active signed bundle");
    let manager = CapabilityTrustBundleManagerV1::new(verified);
    for sampled_now in [20_000, 29_999] {
        assert!(matches!(
            manager.snapshot(sampled_now),
            Err(TrustBundleError::NoActiveRoleKey(AgentRole::Author))
        ));
    }
    assert!(verify_at(&manager, &signed_request("future", &future), 30_000).is_ok());
    assert!(matches!(
        manager.snapshot(100_000),
        Err(TrustBundleError::ManagerDisabled(
            TrustBundleDisableReasonV1::Expired
        ))
    ));
    assert!(matches!(
        manager.snapshot(99_999),
        Err(TrustBundleError::ManagerDisabled(
            TrustBundleDisableReasonV1::Expired
        ))
    ));
}

#[test]
fn future_only_bundle_still_cannot_bootstrap_without_an_active_role_key() {
    let root = SigningKey::from_bytes(&[31; 32]);
    let future = SigningKey::from_bytes(&[32; 32]);
    let envelope = signed_bundle(
        1,
        None,
        1,
        vec![(
            "future".into(),
            future,
            vec![AgentRole::Author],
            30_000,
            90_000,
        )],
        Vec::new(),
        &root,
    );
    assert!(matches!(
        verify_capability_trust_bundle(
            &envelope,
            AgentRole::Author,
            10_000,
            &authority(&root),
            None,
        ),
        Err(TrustBundleError::NoActiveRoleKey(AgentRole::Author))
    ));
}
