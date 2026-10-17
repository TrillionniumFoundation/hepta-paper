//! Pure original-contract fixtures. Fabricated canary records are explicitly
//! tagged fixtureEvidence and prove no provider execution or live authority.
#[allow(dead_code)]
mod machine_intake_support;
use hepta_paper_service::topic_producer_generation::{
    Result, build_topic_producer_capability_v1 as capability,
    build_topic_producer_planned_generation_v1 as planned,
    materialize_topic_producer_intake_v1 as materialize, verify_provider_canary_pair_v1 as pair,
    verify_topic_producer_capability_v1 as verify,
};
use serde_json::{Value, json};
use std::{path::Path, process::Command};
fn oracle(input: Value) -> Value {
    let encoded = input.to_string();
    assert!(encoded.len() < 96 * 1024);
    let mut command = Command::new("node");
    command
        .arg(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../oracle/topic-producer-generation-v1.mjs"),
        )
        .arg(encoded)
        .env_clear()
        .env("PATH", std::env::var_os("PATH").unwrap())
        .env("LANG", "en_US.UTF-8");
    let output = machine_intake_support::run(&mut command);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let mut value: Value = serde_json::from_slice(&output.stdout).unwrap();
    hepta_legacy_compatibility::qualify_production_node_profile_v1(&value["profile"]).unwrap();
    assert_eq!(
        value["evidenceScope"],
        "pure_recorded_contract_fixture_no_canary_execution_or_authority"
    );
    value.as_object_mut().unwrap().remove("profile");
    value.as_object_mut().unwrap().remove("evidenceScope");
    value
}
fn setup(options: Value) -> Value {
    let mut input = options;
    input["action"] = json!("setup");
    let response = oracle(input);
    assert_eq!(response["ok"], true, "{response}");
    response["value"].clone()
}
fn encoded(result: Result<Value>) -> Value {
    match result {
        Ok(value) => json!({"ok":true,"value":value}),
        Err(error) => json!({"ok":false,"error":error.code()}),
    }
}
fn original_build(action: &str, options: &Value) -> Value {
    oracle(json!({"action":action,"options":options}))
}
fn native_build(action: &str, options: &Value) -> Value {
    encoded(match action {
        "materialize" => materialize(
            &options["producerProfile"],
            &options["generationSequence"],
            &options["admissionCreatedAt"],
        ),
        "planned" => planned(
            &options["producerProfile"],
            &options["generationSequence"],
            &options["admissionCreatedAt"],
            &options["budgetReservationId"],
        ),
        "capability" => capability(options),
        _ => panic!("test action"),
    })
}
fn compare_build(action: &str, options: &Value) -> Value {
    let expected = original_build(action, options);
    let actual = native_build(action, options);
    assert_eq!(actual, expected, "{action}: {options}");
    actual
}
fn rehash(value: &Value, domain: &str, field: &str) -> Value {
    let response = oracle(json!({"action":"rehash","value":value,"domain":domain,"field":field}));
    assert_eq!(response["ok"], true);
    response["value"].clone()
}
fn pair_hash(value: &Value) -> Value {
    rehash(
        value,
        "AutonomousResearchProviderCanaryPairReceipt",
        "providerCanaryPairReceiptHash",
    )
}
fn cap_hash(value: &Value) -> Value {
    rehash(
        value,
        "AutonomousResearchTopicProducerCapabilityReceipt",
        "autonomousResearchTopicProducerCapabilityReceiptHash",
    )
}
fn verify_options(data: &Value, now: Value, fresh: bool) -> Value {
    json!({"producerProfile":data["profile"],"machineIntakeConfigurationHash":data["capOptions"]["machineIntakeConfigurationHash"],"intake":data["planned"]["intake"],"now":now,"requireFresh":fresh})
}
fn compare_verify(value: &Value, options: &Value) -> Value {
    let expected = oracle(json!({"action":"verify","value":value,"options":options}));
    let actual = encoded(
        verify(
            value,
            &options["producerProfile"],
            &options["machineIntakeConfigurationHash"],
            &options["intake"],
            options.get("now"),
            options["requireFresh"] == true,
        )
        .map(Value::Bool),
    );
    assert_eq!(actual, expected, "full verifier: {value} options={options}");
    actual["value"].clone()
}
fn compare_pair(value: &Value, provider: &Value, now: &Value) -> Value {
    let expected = oracle(
        json!({"action":"pair","value":value,"options":{"expectedProviderConfigurationHash":provider,"now":now}}),
    );
    let actual = encoded(pair(value, provider, now).map(Value::Bool));
    assert_eq!(actual, expected, "pair {value} now={now}");
    actual["value"].clone()
}
#[test]
fn original_materialization_and_planned_hashes_match_all_families_sequences_and_date_edges() {
    let data = setup(json!({}));
    for sequence in [1_u64, 2, 3, 4, 5, 6, 10, 999, 9_007_199_254_740_991] {
        let mut options = data["options"].clone();
        options["generationSequence"] = json!(sequence);
        assert_eq!(compare_build("materialize", &options)["ok"], true);
        assert_eq!(compare_build("planned", &options)["ok"], true);
    }
    for time in [
        "0000-01-01T00:00:00.000Z",
        "-000001-12-31T23:59:59.999Z",
        "+010000-01-01T00:00:00.000Z",
        "-271821-04-20T00:00:00.000Z",
        "+275760-09-13T00:00:00.000Z",
        "2024-02-29T23:59:59.999Z",
    ] {
        let mut options = data["options"].clone();
        options["admissionCreatedAt"] = json!(time);
        assert_eq!(compare_build("planned", &options)["ok"], true);
    }
}
#[test]
fn original_generation_errors_and_reservation_string_coercions_match() {
    let data = setup(json!({}));
    for value in [
        json!(0),
        json!(-1),
        json!(1.5),
        json!(9_007_199_254_740_992_u64),
        json!("1"),
        Value::Null,
        json!([1]),
    ] {
        let mut o = data["options"].clone();
        o["generationSequence"] = value;
        assert_eq!(compare_build("planned", &o)["ok"], false);
    }
    for value in [
        json!("2026-09-22"),
        json!("2026-09-22T00:00:00Z"),
        json!("2026-02-30T00:00:00.000Z"),
        json!(0),
        Value::Null,
    ] {
        let mut o = data["options"].clone();
        o["admissionCreatedAt"] = value;
        assert_eq!(compare_build("planned", &o)["ok"], false);
    }
    for value in [
        json!(""),
        json!("r".repeat(49)),
        json!("bad@id"),
        json!("r".repeat(48)),
        json!(1),
        json!(["reservation:array"]),
        json!(true),
        json!({}),
    ] {
        let mut o = data["options"].clone();
        o["budgetReservationId"] = value;
        compare_build("planned", &o);
    }
    let mut bad = data["options"].clone();
    bad["producerProfile"]["maximumTopicsPerUtcDay"] = json!(500);
    assert_eq!(compare_build("planned", &bad)["ok"], false);
}
#[test]
fn materialization_checks_original_objective_byte_headroom_after_suffix() {
    let data = setup(json!({}));
    for count in [2600, 2700] {
        let mut profile = data["profile"].clone();
        profile["registeredResearchProfiles"][0]["objective"] = json!("中".repeat(count));
        let built = original_build("profile", &profile);
        assert_eq!(built["ok"], true, "{built}");
        let mut options = data["options"].clone();
        options["producerProfile"] = built["value"].clone();
        let result = compare_build("planned", &options);
        assert_eq!(result["ok"], count == 2600);
    }
}
#[test]
fn recorded_pair_hash_bindings_and_freshness_boundaries_match() {
    let data = setup(json!({}));
    let p = &data["profile"]["providerConfigurationHash"];
    for (time, valid) in [
        ("2026-09-21T23:59:59.999Z", false),
        ("2026-09-22T00:00:00.000Z", true),
        ("2026-09-22T00:14:59.999Z", true),
        ("2026-09-22T00:15:00.000Z", false),
    ] {
        assert_eq!(compare_pair(&data["pair"], p, &json!(time)), valid);
    }
    for (field, value) in [
        ("freshnessIntervalMs", json!(899999)),
        ("verified", json!(false)),
        ("externalActionScope", json!("none")),
        ("researchAuthorCapabilityReceiptHash", json!("bad")),
        ("unexpected", json!(true)),
    ] {
        let mut receipt = data["pair"].clone();
        receipt[field] = value;
        assert_eq!(
            compare_pair(&pair_hash(&receipt), p, &data["pair"]["observedAt"]),
            false
        );
    }
    for role in ["researchAuthor", "formalReviewer"] {
        let key = format!("{role}ProviderCanaryReceipt");
        for (field, value) in [
            ("expiresAt", json!("2026-09-22T00:14:59.999Z")),
            ("selectedModelExecutionCanaryVerified", json!(false)),
            ("fixtureExtra", json!("accepted inner extension")),
        ] {
            let mut receipt = data["pair"].clone();
            receipt[&key][field] = value;
            let inner = rehash(
                &receipt[&key],
                "CodexModelAvailabilityCanaryReceipt",
                "codexModelAvailabilityCanaryReceiptHash",
            );
            receipt[format!("{role}ProviderCanaryReceiptHash")] =
                inner["codexModelAvailabilityCanaryReceiptHash"].clone();
            receipt[&key] = inner;
            assert_eq!(
                compare_pair(&pair_hash(&receipt), p, &data["pair"]["observedAt"]),
                field == "fixtureExtra"
            );
        }
    }
    // Original pair does not bound pair.observedAt against now; preserve this
    // weaker recorded contract rather than imply live provider authority.
    let mut future = data["pair"].clone();
    future["observedAt"] = json!("2026-09-22T00:05:00.000Z");
    assert_eq!(
        compare_pair(&pair_hash(&future), p, &data["pair"]["observedAt"]),
        true
    );
}
#[test]
fn full_capability_rebuild_uses_minimum_pair_and_profile_expiry() {
    for options in [
        json!({}),
        json!({"validity":60000}),
        json!({"authorSkew":30000}),
        json!({"reviewerSkew":40000}),
        json!({"authorSkew":30000,"reviewerSkew":40000,"validity":60000}),
        json!({"observedAt":"0000-01-01T00:00:00.000Z"}),
        json!({"observedAt":"-000001-01-01T00:00:00.000Z"}),
        json!({"observedAt":"+010000-01-01T00:00:00.000Z"}),
    ] {
        let data = setup(options);
        assert_eq!(
            compare_build("capability", &data["capOptions"])["value"],
            data["capability"]
        );
        assert_eq!(
            compare_verify(
                &data["capability"],
                &verify_options(&data, data["pair"]["observedAt"].clone(), true)
            ),
            true
        );
    }
}
#[test]
fn rehashed_capability_binding_mutations_fail_full_reconstruction() {
    let data = setup(json!({}));
    let options = verify_options(&data, data["pair"]["observedAt"].clone(), true);
    for field in [
        "implementationId",
        "implementationSha256",
        "policyProfileHash",
        "producerId",
        "producerProfileHash",
        "plannedGenerationHash",
        "producerTopicId",
        "topicFingerprint",
        "canonicalResearchTopicHash",
        "registeredResearchProfileId",
        "researchProfileHash",
        "budgetEpochStart",
        "autonomousResearchProviderConfigurationHash",
        "providerCanaryPairReceiptHash",
        "autonomousResearchMachineIntakeHash",
        "expiresAt",
        "issuedAt",
        "admissionCreatedAt",
    ] {
        let mut value = data["capability"].clone();
        value[field] = if field.ends_with("At") || field == "budgetEpochStart" {
            json!("2026-09-22T00:00:01.000Z")
        } else {
            json!("changed")
        };
        assert_eq!(
            compare_verify(&cap_hash(&value), &options),
            false,
            "{field}"
        );
    }
    for field in [
        "scientificNoveltyVerified",
        "scientificCorrectnessVerified",
        "externalSubmissionAuthorized",
        "automaticBudgetExpansionPerformed",
        "extra",
    ] {
        let mut value = data["capability"].clone();
        value["safety"][field] = json!(true);
        assert_eq!(compare_verify(&cap_hash(&value), &options), false);
    }
    let mut extra = data["capability"].clone();
    extra["extra"] = json!(true);
    assert_eq!(compare_verify(&cap_hash(&extra), &options), false);
    let mut altered_intake = options.clone();
    altered_intake["intake"]["objective"] = json!("A different objective");
    assert_eq!(compare_verify(&data["capability"], &altered_intake), false);
}
#[test]
fn builder_copied_planned_fields_do_not_bypass_full_verifier() {
    let data = setup(json!({}));
    let verify_options = verify_options(&data, data["pair"]["observedAt"].clone(), true);
    for field in [
        "budgetEpochStart",
        "producerTopicId",
        "topicFingerprint",
        "canonicalResearchTopicHash",
        "registeredResearchProfileId",
        "researchProfileHash",
    ] {
        for missing in [false, true] {
            let mut options = data["capOptions"].clone();
            if missing {
                options["plannedGeneration"]
                    .as_object_mut()
                    .unwrap()
                    .remove(field);
            } else {
                options["plannedGeneration"][field] = json!("changed");
            }
            let result = compare_build("capability", &options);
            assert_eq!(result["ok"], true);
            assert_eq!(compare_verify(&result["value"], &verify_options), false);
        }
    }
}
#[test]
fn lease_and_nonce_shape_coercions_and_numeric_invalid_values_match() {
    let data = setup(json!({}));
    for field in ["producerLeaseGeneration", "residentLeaseGeneration"] {
        for value in [
            json!(0),
            json!(-1),
            json!(1.5),
            json!("1"),
            json!(9_007_199_254_740_992_u64),
        ] {
            let mut o = data["capOptions"].clone();
            o[field] = value;
            assert_eq!(compare_build("capability", &o)["ok"], false);
        }
    }
    for field in [
        "producerLeaseTokenHash",
        "residentLeaseTokenHash",
        "capabilityNonce",
    ] {
        let mut o = data["capOptions"].clone();
        o[field] = json!([o[field].clone()]);
        let value = compare_build("capability", &o);
        assert_eq!(value["ok"], true);
        assert_eq!(
            compare_verify(
                &value["value"],
                &verify_options(&data, data["pair"]["observedAt"].clone(), true)
            ),
            true
        );
    }
    for value in [
        json!("producer-nonce:BAD"),
        json!("producer-nonce:".to_owned() + &"A".repeat(32)),
        Value::Null,
    ] {
        let mut o = data["capOptions"].clone();
        o["capabilityNonce"] = value;
        assert_eq!(compare_build("capability", &o)["ok"], false);
    }
}
#[test]
fn checked_time_fallback_and_freshness_are_distinct_from_recorded_pair_validity() {
    let data = setup(json!({"validity":60000}));
    for time in [
        json!("2026-09-21T23:59:59.999Z"),
        json!("2026-09-22T00:00:00.000Z"),
        json!("2026-09-22T00:00:59.999Z"),
        json!("2026-09-22T00:01:00.000Z"),
        json!("2026-09-23T00:00:00.000Z"),
        json!(0),
        json!(false),
        json!(""),
        Value::Null,
    ] {
        for fresh in [false, true] {
            compare_verify(
                &data["capability"],
                &verify_options(&data, time.clone(), fresh),
            );
        }
    }
}
#[test]
fn original_noncanonical_date_parse_positive_is_an_explicit_native_profile_refusal() {
    let data = setup(json!({}));
    let now = json!("2026-09-22T00:00:00Z");
    let options = verify_options(&data, now.clone(), true);
    assert_eq!(
        oracle(json!({"action":"verify","value":data["capability"],"options":options}))["value"],
        true
    );
    assert_eq!(
        verify(
            &data["capability"],
            &data["profile"],
            &data["capOptions"]["machineIntakeConfigurationHash"],
            &data["planned"]["intake"],
            Some(&now),
            true
        )
        .unwrap_err()
        .code(),
        "autonomous_research_topic_producer_date_parse_profile_unsupported"
    );
    assert_eq!(
        oracle(
            json!({"action":"pair","value":data["pair"],"options":{"expectedProviderConfigurationHash":data["profile"]["providerConfigurationHash"],"now":now}})
        )["value"],
        true
    );
    assert_eq!(
        pair(
            &data["pair"],
            &data["profile"]["providerConfigurationHash"],
            &now
        )
        .unwrap_err()
        .code(),
        "autonomous_research_topic_producer_date_parse_profile_unsupported"
    );
}

#[test]
fn original_provider_hash_array_materialization_preserves_recorded_transport() {
    let data = setup(json!({}));
    let mut profile = data["profile"].clone();
    profile["providerConfigurationHash"] = json!([profile["providerConfigurationHash"].clone()]);
    let built = original_build("profile", &profile);
    assert_eq!(built["ok"], true);
    let mut options = data["options"].clone();
    options["producerProfile"] = built["value"].clone();
    assert_eq!(compare_build("materialize", &options)["ok"], true);
    assert_eq!(compare_build("planned", &options)["ok"], true);
}

#[test]
fn native_recursive_transport_bounds_and_shadowed_coercions_fail_explicitly() {
    let data = setup(json!({}));
    let mut nested = json!("reservation");
    for _ in 0..66 {
        nested = json!([nested]);
    }
    for id in [
        nested,
        json!({"toString":"noncallable"}),
        json!("x".repeat(2 * 1024 * 1024 + 1)),
    ] {
        let result = planned(
            &data["profile"],
            &json!(1),
            &data["options"]["admissionCreatedAt"],
            &id,
        )
        .unwrap_err();
        assert_eq!(
            result.code(),
            "autonomous_research_topic_producer_json_profile_unsupported"
        );
    }
    let mut options = data["options"].clone();
    options["budgetReservationId"] = json!({"toString":"noncallable"});
    let original = original_build("planned", &options);
    assert_eq!(original["ok"], false);
    assert!(original["error"].as_str().unwrap().contains("primitive"));
}

#[test]
fn original_numeric_spelling_is_normalized_in_complete_builder_projections() {
    let data = setup(json!({}));
    let one: Value = serde_json::from_str("1e0").unwrap();
    let minus_zero: Value = serde_json::from_str("-0.0").unwrap();
    let mut options = data["options"].clone();
    options["generationSequence"] = one.clone();
    options["producerProfile"]["registeredResearchProfiles"][0]["version"] = one.clone();
    options["producerProfile"]["registeredResearchProfiles"][0]["revisionRounds"] = one.clone();
    options["producerProfile"]["registeredResearchProfiles"][0]["budgets"]["maxGpuJobs"] =
        minus_zero.clone();
    options["producerProfile"]["registeredResearchProfiles"][0]["budgets"]["maxCostUsd"] =
        json!(25.0);
    assert_eq!(compare_build("materialize", &options)["ok"], true);
    assert_eq!(compare_build("planned", &options)["ok"], true);
    let mut cap = data["capOptions"].clone();
    cap["producerProfile"] = options["producerProfile"].clone();
    cap["generationSequence"] = one;
    cap["producerLeaseGeneration"] = json!(3.0);
    cap["residentLeaseGeneration"] = json!(4.0);
    cap["intake"]["budgets"]["maxGpuJobs"] = minus_zero;
    cap["intake"]["budgets"]["maxCostUsd"] = json!(25.0);
    assert_eq!(compare_build("capability", &cap)["ok"], true);
}
