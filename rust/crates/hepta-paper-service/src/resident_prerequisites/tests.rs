//! Private contract tests, not actual independent qualification acceptance.
//! Root's differential integration suite separately exercises the public source
//! collector with actual Node builders, public keys, SQLite and pointer mirrors.
use super::*;
use base64ct::{Base64, Encoding};
use ed25519_dalek::{Signer, SigningKey, pkcs8::EncodePublicKey};
use serde_json::json;

fn sign(receipt: &mut Value, key: &SigningKey) {
    let object = receipt.as_object_mut().expect("owned receipt object");
    object.remove("signature");
    object.remove("fullResearchQualificationReceiptHash");
    let payload_hash = value::hash("FullResearchQualificationSigningPayload", receipt)
        .expect("actual domain hash");
    receipt["signature"] = json!(Base64::encode_string(
        &key.sign(payload_hash.as_bytes()).to_bytes()
    ));
    seal_receipt(receipt);
}
fn seal_receipt(receipt: &mut Value) {
    receipt
        .as_object_mut()
        .expect("owned receipt object")
        .remove("fullResearchQualificationReceiptHash");
    receipt["fullResearchQualificationReceiptHash"] = json!(
        value::hash(
            "FullResearchGoldenMicroCampaignQualificationReceipt",
            receipt
        )
        .expect("real receipt own hash")
    );
}
fn private_configuration(key: &SigningKey) -> collect::ConfigurationObservation {
    collect::ConfigurationObservation {
        identity: json!({"trustedSigner":{
            "keyId":"owned-active","keyVersion":"1","subjectId":"owned-subject","organization":"owned organization",
            "role":"research_execution_release_attestor","algorithm":"ed25519","status":"active","revokedAt":null,
            "effectiveFrom":"2026-09-22T00:00:00.000Z","expiresAt":"2026-09-23T00:00:00.000Z",
        }}),
        public_key_pem: key
            .verifying_key()
            .to_public_key_pem(Default::default())
            .expect("public SPKI"),
    }
}
fn key() -> SigningKey {
    let mut seed = [0u8; 32];
    getrandom::fill(&mut seed).expect("ephemeral in-memory fixture key");
    SigningKey::from_bytes(&seed)
}
fn at(text: &str) -> i64 {
    value::canonical(&json!(text)).expect("canonical fixture time")
}

#[test]
fn resident_signature_includes_extra_fields_and_accepts_node_utf16_transport() {
    let key = key();
    let configuration = private_configuration(&key);
    let mut receipt = json!({"version":1,"issuedAt":"2026-09-22T01:00:00.000Z","extra":{"scientificResult":"owned synthetic"}});
    sign(&mut receipt, &key);
    assert_eq!(
        qualification::signature_valid(Some(&configuration), &receipt),
        Ok(true)
    );
    receipt["extra"]["scientificResult"] = json!("changed while keeping signature");
    seal_receipt(&mut receipt);
    assert_eq!(
        qualification::signature_valid(Some(&configuration), &receipt),
        Ok(false),
        "rehashing outer receipt is not a signature"
    );
    sign(&mut receipt, &key);
    let original = receipt["signature"]
        .as_str()
        .expect("signature text")
        .to_owned();
    receipt["signature"] = json!(
        original
            .bytes()
            .map(|byte| char::from_u32(u32::from(byte) + 0x100).expect("mapped scalar"))
            .collect::<String>()
    );
    seal_receipt(&mut receipt);
    assert_eq!(
        qualification::signature_valid(Some(&configuration), &receipt),
        Ok(true)
    );
    let mut paired = String::from_utf16(&[
        0xd800 | u16::from(original.as_bytes()[0]),
        0xdc00 | u16::from(original.as_bytes()[1]),
    ])
    .expect("paired Unicode transport");
    paired.push_str(original.get(2..).expect("remaining ASCII signature"));
    receipt["signature"] = json!(paired);
    seal_receipt(&mut receipt);
    assert_eq!(
        qualification::signature_valid(Some(&configuration), &receipt),
        Ok(true)
    );
    let wrong = private_configuration(&self::key());
    assert_eq!(
        qualification::signature_valid(Some(&wrong), &receipt),
        Ok(false)
    );
}

#[test]
fn resident_active_signer_requires_actual_scalar_identity_and_both_time_windows() {
    let key = key();
    let mut configuration = private_configuration(&key);
    let mut signer = configuration.identity["trustedSigner"].clone();
    for field in ["status", "revokedAt", "effectiveFrom", "expiresAt"] {
        signer.as_object_mut().expect("signer").remove(field);
    }
    let mut receipt = json!({"signer":signer,"issuedAt":"2026-09-22T00:00:00.000Z"});
    let start = at("2026-09-22T00:00:00.000Z");
    let end = at("2026-09-23T00:00:00.000Z");
    assert!(qualification::signer_matches(
        &configuration.identity,
        &receipt,
        start
    ));
    assert!(qualification::signer_matches(
        &configuration.identity,
        &receipt,
        end - 1
    ));
    assert!(!qualification::signer_matches(
        &configuration.identity,
        &receipt,
        end
    ));
    receipt["issuedAt"] = json!("2026-09-21T23:59:59.999Z");
    assert!(!qualification::signer_matches(
        &configuration.identity,
        &receipt,
        start
    ));
    receipt["issuedAt"] = json!("2026-09-22T00:00:00.000Z");
    receipt["signer"]["keyVersion"] = json!(1);
    assert!(
        !qualification::signer_matches(&configuration.identity, &receipt, start),
        "string version is not numeric version"
    );
    receipt["signer"]["keyVersion"] = json!("1");
    configuration.identity["trustedSigner"]["status"] = json!("retiring");
    assert!(
        !qualification::signer_matches(&configuration.identity, &receipt, start),
        "resident uses active key only"
    );
}

#[test]
fn resident_time_and_cost_state_binding_do_not_infer_validity_from_current_hashes() {
    let start = at("2026-09-22T00:00:00.000Z");
    let mut receipt =
        json!({"issuedAt":"2026-09-22T00:00:00.000Z","expiresAt":"2026-09-23T00:00:00.000Z"});
    assert!(qualification::receipt_current(&receipt, start));
    assert!(!qualification::receipt_current(&receipt, start - 1));
    assert!(!qualification::receipt_current(
        &receipt,
        start + 86_400_000
    ));
    receipt["expiresAt"] = json!("2026-09-23T00:00:00.001Z");
    assert!(
        !qualification::receipt_current(&receipt, start),
        "maximum age is 24 hours"
    );
    receipt["expiresAt"] = json!("2026-09-23T00:00:00Z");
    assert!(
        !qualification::receipt_current(&receipt, start),
        "canonical millisecond spelling required"
    );

    let configuration = json!({"configurationIdentityHash":"config","trustIdentityHash":"trust","clientServiceIdentityHash":"client",
        "verifierServiceIdentityHash":"verifier","maximumQualificationCostUsd":0,"qualificationCostAuthority":"externally_operated_zero_cost"});
    let recovery_hash = value::hash(
        "AutonomousExternalQualificationRecoveryConfigurationIdentity",
        &configuration,
    )
    .expect("actual six-field cost-inclusive hash");
    let pointer = json!({"qualificationStateHash":"state","qualificationStateGeneration":1,"receipt":{"campaignId":"campaign","paperId":"paper","campaignReleaseBundleHash":"release","fullResearchQualificationReceiptHash":"receipt"}});
    let mut state = pointer["receipt"].clone();
    state["receipt"] = pointer["receipt"].clone();
    state["autonomousExternalQualificationStateHash"] = json!("state");
    state["generation"] = json!(1);
    state["recovery"] = configuration.clone();
    state["recovery"]["status"] = json!("qualification_verified");
    state["recovery"]["recoveryConfigurationIdentityHash"] = json!(recovery_hash);
    assert_eq!(
        qualification::state_matches(&state, &pointer, &configuration),
        Ok(true)
    );
    let mut changed = configuration.clone();
    changed["maximumQualificationCostUsd"] = json!(1);
    changed["qualificationCostAuthority"] = json!("operator_declared_worst_case_usd");
    assert_eq!(
        qualification::state_matches(&state, &pointer, &changed),
        Ok(false),
        "four unchanged service/config hashes do not omit changed costs"
    );
}

#[test]
fn diagnostic_identity_excludes_observation_time_and_blockers_keep_insertion_order() {
    let mut observation = collect::Observation {
        configuration_inspection: Value::Null,
        configuration: None,
        pointer: None,
        state: None,
        runtime: None,
        code: None,
        recovery: json!({"ready":false,"blocker":"owned recovery blocked"}),
        infrastructure_input_blockers: vec!["z-first".into(), "a-next".into(), "z-first".into()],
        global_input_blockers: vec!["z-global-first".into(), "z-first".into()],
        inspected_at: "2026-09-22T00:00:00.000Z".into(),
    };
    let first = evaluate::evaluate(&observation, at(&observation.inspected_at))
        .expect("private diagnostic");
    assert_eq!(first["infrastructureBlockers"][0], "z-first");
    assert_eq!(first["infrastructureBlockers"][1], "a-next");
    assert_eq!(first["globalQualificationBlockers"][0], "z-global-first");
    assert_eq!(
        first["blockers"]
            .as_array()
            .expect("blockers")
            .iter()
            .filter(|value| *value == "z-first")
            .count(),
        1
    );
    observation.inspected_at = "2026-09-22T00:00:01.000Z".into();
    let second = evaluate::evaluate(&observation, at(&observation.inspected_at))
        .expect("later private diagnostic");
    assert_eq!(
        first["autonomousResearchResidentPrerequisiteIdentityHash"],
        second["autonomousResearchResidentPrerequisiteIdentityHash"]
    );
    assert_ne!(
        first["autonomousResearchResidentPrerequisiteReceiptHash"],
        second["autonomousResearchResidentPrerequisiteReceiptHash"]
    );
    assert_eq!(second["ready"], false);
    assert!(
        value::own_hash(
            "AutonomousResearchResidentPrerequisiteReceipt",
            &second,
            "autonomousResearchResidentPrerequisiteReceiptHash"
        )
        .expect("real report hash")
    );
}

#[test]
fn unsupported_clock_and_release_override_refuse_before_any_source_observation() {
    let mut environment = BTreeMap::new();
    let root = Path::new("/not-opened-resident-contract-test");
    for now in [
        8_640_000_000_000_001i64,
        -8_640_000_000_000_001,
        i64::MAX,
        i64::MIN,
    ] {
        let options = ResidentPrerequisiteInspectionOptions {
            runtime_root: root,
            repository_root: root,
            working_directory: Path::new("/"),
            environment: &environment,
            external_qualification_config: None,
            external_action_recovery_config: None,
            now_millis: now,
        };
        assert_eq!(
            inspect_autonomous_research_resident_prerequisites_v1(&options)
                .expect_err("unsupported TimeClip")
                .code(),
            "autonomous_research_resident_clock_profile_unsupported"
        );
    }
    environment.insert(
        "HEPTA_RELEASE_COMMIT".into(),
        "explicit-unported-release-override".into(),
    );
    let options = ResidentPrerequisiteInspectionOptions {
        runtime_root: root,
        repository_root: root,
        working_directory: Path::new("/"),
        environment: &environment,
        external_qualification_config: None,
        external_action_recovery_config: None,
        now_millis: 0,
    };
    assert_eq!(
        inspect_autonomous_research_resident_prerequisites_v1(&options)
            .expect_err("unsupported override")
            .code(),
        "autonomous_research_resident_release_commit_profile_unsupported"
    );
}
