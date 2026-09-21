use super::*;
fn shadow() -> DurableCutoverStateV1 {
    DurableCutoverStateV1 {
        version: 1,
        cutover_id: "native-preview".into(),
        database_path: "/srv/runtime/hepta-paper.sqlite".into(),
        mode: DurableCutoverModeV1::Production,
        phase: DurableCutoverPhaseV1::ShadowVerified,
        old_writer_id: "node".into(),
        new_writer_id: LOCAL_RECONCILIATION_WRITER_ID_V1.into(),
        writer_id: None,
        generation: 2,
        token: "native-preview:2".into(),
        revision: 3,
        shadow_cases: 2,
        shadow_mismatches: 0,
        canary_scopes: vec![],
        production_activation: false,
        activation_receipt_hash: None,
    }
}
fn preview(state: &DurableCutoverStateV1) -> Result<DurableCutoverStateV1> {
    prospective_canary(
        state,
        Path::new("/srv/external-cutover"),
        &format!("sha256:{}", "a".repeat(64)).parse().unwrap(),
    )
}
#[test]
fn prospective_state_is_a_closed_next_epoch_without_a_receipt() {
    let before = shadow();
    let after = preview(&before).unwrap();
    assert_eq!(before.phase, DurableCutoverPhaseV1::ShadowVerified);
    assert_eq!(before.writer_id, None);
    assert_eq!(after.generation, 3);
    assert_eq!(after.revision, 4);
    assert_eq!(after.token, "native-preview:3");
    assert_eq!(after.activation_receipt_hash, None);
    assert_eq!(after.canary_scopes, [RECONCILIATION_WRITER_SCOPE_V1]);
}
#[test]
fn incompatible_or_overflowing_shadow_state_cannot_preview_a_native_subject() {
    for name in [
        "local",
        "canary",
        "writer",
        "scope",
        "active",
        "receipt",
        "new-writer",
        "token",
        "generation-zero",
        "revision-zero",
        "generation-max",
        "revision-max",
        "shadow-zero",
        "mismatch",
    ] {
        let mut value = shadow();
        match name {
            "local" => value.mode = DurableCutoverModeV1::LocalDrill,
            "canary" => value.phase = DurableCutoverPhaseV1::Canary,
            "writer" => value.writer_id = Some("node".into()),
            "scope" => value
                .canary_scopes
                .push(RECONCILIATION_WRITER_SCOPE_V1.into()),
            "active" => value.production_activation = true,
            "receipt" => value.activation_receipt_hash = Some("copied".into()),
            "new-writer" => value.new_writer_id = "other".into(),
            "token" => value.token = "other:2".into(),
            "generation-zero" => {
                value.generation = 0;
                value.token = "native-preview:0".into();
            }
            "revision-zero" => value.revision = 0,
            "generation-max" => {
                value.generation = MAX_SAFE;
                value.token = format!("native-preview:{MAX_SAFE}");
            }
            "revision-max" => value.revision = MAX_SAFE,
            "shadow-zero" => value.shadow_cases = 0,
            "mismatch" => value.shadow_mismatches = 1,
            _ => unreachable!(),
        }
        assert!(preview(&value).is_err(), "{name}");
    }
}

fn digest(byte: char) -> Sha256Digest {
    format!("sha256:{}", byte.to_string().repeat(64))
        .parse()
        .unwrap()
}
// A diagnostic vector, not a production deployment, qualification or admission.
fn observed_vector() -> ObservedNativeSigningSubjectV1 {
    let shadow = shadow();
    let prospective_canary = preview(&shadow).unwrap();
    let external_root = PathBuf::from("/srv/external-cutover");
    let enrollment_hash = digest('a');
    let epoch_hash = native_reconciliation_durable_epoch_hash_v1(
        &prospective_canary,
        &external_root,
        &enrollment_hash,
    )
    .unwrap();
    ObservedNativeSigningSubjectV1 {
        shadow,
        prospective_canary,
        external_root,
        enrollment_hash,
        epoch_hash,
        subject: WriterCutoverSubjectV1 {
            repository: "TrillionniumFoundation/hepta-paper".into(),
            commit_sha: "1".repeat(40),
            tree_sha: "2".repeat(40),
            binary_hash: digest('3'),
            configuration_hash: digest('4'),
            host_identity_hash: digest('5'),
            service_identity_hash: digest('6'),
        },
        preimage_hash: digest('7'),
        report: json!({"runtimeReady":false}),
    }
}
fn signed_vector(
    observed: &ObservedNativeSigningSubjectV1,
    changed: &str,
) -> hepta_campaign_writer::VerifiedWriterCutoverV1 {
    use base64ct::{Base64UrlUnpadded, Encoding};
    use ed25519_dalek::{Signer, SigningKey};
    use hepta_campaign_writer::{
        WriterCutoverAuthorizationV1, WriterCutoverPolicyV1, WriterCutoverTrustStoreV1,
        verify_writer_cutover_authorization_v1, writer_cutover_signing_bytes_v1,
    };
    let mut authorization = WriterCutoverAuthorizationV1 {
        version: 1,
        cutover_id: observed.shadow.cutover_id.clone(),
        subject: observed.subject.clone(),
        database_preimage_hash: observed.preimage_hash.clone(),
        initial_writer_lease_hash: observed.epoch_hash.clone(),
        node_writer_disabled: true,
        issued_at_unix_ms: 1,
        expires_at_unix_ms: 100_000,
        nonce: "native-binding-vector".into(),
        signer_key_id: "native-binding-test-key".into(),
        signature_base64: "AA".into(),
    };
    match changed {
        "none" => {}
        "repository" => authorization.subject.repository = "OtherFoundation/hepta-paper".into(),
        "commit" => authorization.subject.commit_sha = "a".repeat(40),
        "tree" => authorization.subject.tree_sha = "b".repeat(40),
        "binary" => authorization.subject.binary_hash = digest('b'),
        "configuration" => authorization.subject.configuration_hash = digest('b'),
        "host" => authorization.subject.host_identity_hash = digest('b'),
        "service" => authorization.subject.service_identity_hash = digest('b'),
        "preimage" => authorization.database_preimage_hash = digest('b'),
        "epoch" => authorization.initial_writer_lease_hash = digest('b'),
        "cutover" => authorization.cutover_id = "other-cutover".into(),
        _ => unreachable!(),
    }
    let key = SigningKey::from_bytes(&[82; 32]);
    authorization.signature_base64 = Base64UrlUnpadded::encode_string(
        &key.sign(&writer_cutover_signing_bytes_v1(&authorization).unwrap())
            .to_bytes(),
    );
    let trust =
        WriterCutoverTrustStoreV1::new([("native-binding-test-key".into(), key.verifying_key())])
            .unwrap();
    verify_writer_cutover_authorization_v1(
        &authorization,
        &authorization.subject,
        10,
        WriterCutoverPolicyV1::default(),
        &trust,
    )
    .unwrap()
}
#[test]
fn genuinely_signed_other_native_bindings_are_rejected_before_lower_transfer() {
    let observed = observed_vector();
    for changed in [
        "none",
        "repository",
        "commit",
        "tree",
        "binary",
        "configuration",
        "host",
        "service",
        "preimage",
        "epoch",
        "cutover",
    ] {
        let verified = signed_vector(&observed, changed);
        assert_eq!(
            observed.assert_authorization(&verified).is_ok(),
            changed == "none",
            "{changed}"
        );
    }
}
#[test]
fn lease_is_derived_only_from_complete_actual_canary_and_signed_receipt() {
    let observed = observed_vector();
    let signed = signed_vector(&observed, "none");
    let mut actual = observed.prospective_canary.clone();
    actual.activation_receipt_hash = Some(signed.authorization_hash().as_str().into());
    let lease = observed.actual_lease(&actual, &signed).unwrap();
    assert_eq!(lease, actual.writer_fence().unwrap());
    for changed in ["receipt", "phase", "writer", "revision", "shadow", "scope"] {
        let mut bad = actual.clone();
        match changed {
            "receipt" => bad.activation_receipt_hash = Some(digest('b').to_string()),
            "phase" => bad.phase = DurableCutoverPhaseV1::Active,
            "writer" => bad.writer_id = Some("other-writer".into()),
            "revision" => bad.revision += 1,
            "shadow" => bad.shadow_cases += 1,
            "scope" => bad.canary_scopes.push("another-scope".into()),
            _ => unreachable!(),
        }
        assert!(observed.actual_lease(&bad, &signed).is_err(), "{changed}");
    }
}
