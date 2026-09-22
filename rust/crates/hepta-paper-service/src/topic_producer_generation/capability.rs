use super::value::{
    ensure_supported, hash, iso, or_empty, own_hash, project, sha, strict_equal, time, truthy,
};
use super::{
    Result, build_topic_producer_planned_generation_v1 as planned, invalid, valid_profile,
    verify_recorded_intake,
};
use crate::machine_intake::contract::{exact_keys, integer};
use serde_json::{Value, json};
const PAIR_KEYS: &[&str] = &[
    "autonomousResearchProviderConfigurationHash",
    "externalActionPerformed",
    "externalActionScope",
    "formalReviewerCapabilityReceiptHash",
    "formalReviewerProviderCanaryReceipt",
    "formalReviewerProviderCanaryReceiptHash",
    "freshnessIntervalMs",
    "kind",
    "observedAt",
    "providerCanaryPairReceiptHash",
    "researchAuthorCapabilityReceiptHash",
    "researchAuthorProviderCanaryReceipt",
    "researchAuthorProviderCanaryReceiptHash",
    "status",
    "verified",
    "version",
];
const CAP_KEYS: &[&str] = &[
    "admissionCreatedAt",
    "autonomousResearchMachineIntakeHash",
    "autonomousResearchProviderConfigurationHash",
    "autonomousResearchTopicProducerCapabilityReceiptHash",
    "budgetEpochStart",
    "budgetReservationId",
    "canProduce",
    "canonicalResearchTopicHash",
    "capabilityNonce",
    "expiresAt",
    "generationSequence",
    "implementationId",
    "implementationSha256",
    "issuedAt",
    "kind",
    "machineIntakeConfigurationHash",
    "plannedGenerationHash",
    "policyProfileHash",
    "producerId",
    "producerLeaseGeneration",
    "producerLeaseTokenHash",
    "producerTopicId",
    "residentLeaseGeneration",
    "residentLeaseTokenHash",
    "producerProfileHash",
    "providerCanaryPairReceipt",
    "providerCanaryPairReceiptHash",
    "registeredResearchProfileId",
    "researchProfileHash",
    "safety",
    "status",
    "topicFingerprint",
    "version",
];
fn receipt_valid(receipt: &Value, expected: &Value, now: i64) -> Result<bool> {
    if receipt["version"].as_f64() != Some(1.0)
        || receipt["kind"] != "CodexModelAvailabilityCanaryReceipt"
        || receipt["status"] != "codex_model_live_canary_verified"
        || receipt["selectedModelExecutionCanaryVerified"] != true
        || receipt["externalActionPerformed"] != true
        || receipt["externalActionScope"] != "single_read_only_ephemeral_model_canary"
        || !strict_equal(
            &receipt["codexModelAvailabilityCanaryReceiptHash"],
            expected,
        )
        || !sha(&receipt["codexModelAvailabilityCanaryReceiptHash"])
        || !own_hash(
            receipt,
            "CodexModelAvailabilityCanaryReceipt",
            "codexModelAvailabilityCanaryReceiptHash",
        )?
    {
        return Ok(false);
    }
    let observed = time(&receipt["observedAt"])?;
    let expires = time(&receipt["expiresAt"])?;
    Ok(expires - observed == 900_000 && now >= observed && now < expires)
}
/// Original recorded pair contract, including both inner hashes and windows.
/// This verifies recorded claims; it never executes or authenticates canaries.
/// Noncanonical Date.parse transports return an explicit unsupported error.
pub fn verify_provider_canary_pair_v1(
    receipt: &Value,
    expected_provider: &Value,
    now: &Value,
) -> Result<bool> {
    for value in [receipt, expected_provider, now] {
        ensure_supported(value)?;
    }
    if !exact_keys(receipt, PAIR_KEYS)
        || receipt["version"].as_f64() != Some(1.0)
        || receipt["kind"] != "AutonomousResearchProviderCanaryPairReceipt"
        || receipt["status"] != "autonomous_research_provider_canary_pair_verified"
        || receipt["verified"] != true
        || receipt["externalActionPerformed"] != true
        || receipt["externalActionScope"] != "two_read_only_ephemeral_model_canaries"
        || receipt["freshnessIntervalMs"].as_f64() != Some(900_000.0)
        || !strict_equal(
            &receipt["autonomousResearchProviderConfigurationHash"],
            expected_provider,
        )
        || !sha(&receipt["researchAuthorCapabilityReceiptHash"])
        || !sha(&receipt["formalReviewerCapabilityReceiptHash"])
    {
        return Ok(false);
    }
    time(&receipt["observedAt"])?;
    let now = time(now)?;
    for role in ["researchAuthor", "formalReviewer"] {
        let canary = &receipt[format!("{role}ProviderCanaryReceipt")];
        if !receipt_valid(
            canary,
            &receipt[format!("{role}ProviderCanaryReceiptHash")],
            now,
        )? {
            return Ok(false);
        }
        // JS <= compares two strings in UTF-16 order, even for expanded years.
        if canary["observedAt"]
            .as_str()
            .map(|v| v.encode_utf16().collect::<Vec<_>>())
            > receipt["observedAt"]
                .as_str()
                .map(|v| v.encode_utf16().collect::<Vec<_>>())
        {
            return Ok(false);
        }
    }
    Ok(sha(&receipt["providerCanaryPairReceiptHash"])
        && own_hash(
            receipt,
            "AutonomousResearchProviderCanaryPairReceipt",
            "providerCanaryPairReceiptHash",
        )?)
}
fn safety_valid(value: &Value) -> bool {
    value["boundedRegisteredResearchOnly"] == true
        && value["scientificNoveltyVerified"] == false
        && value["scientificCorrectnessVerified"] == false
        && value["externalSubmissionAuthorized"] == false
        && value["automaticBudgetExpansionPerformed"] == false
}
/// Rebuild a recorded capability from the incumbent builder's named fields.
/// No lease, reservation, provider execution or admission is performed.
pub fn build_topic_producer_capability_v1(options: &Value) -> Result<Value> {
    ensure_supported(options)?;
    let profile = &options["producerProfile"];
    let intake = &options["intake"];
    let supplied = &options["plannedGeneration"];
    let pair = &options["providerCanaryPairReceipt"];
    let generated = planned(
        profile,
        &options["generationSequence"],
        &intake["admissionCreatedAt"],
        &supplied["budgetReservationId"],
    )?;
    let nonce = or_empty(&options["capabilityNonce"]);
    let valid_nonce = nonce.strip_prefix("producer-nonce:").is_some_and(|v| {
        v.len() == 32
            && v.bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    });
    if !sha(&options["machineIntakeConfigurationHash"])
        || !verify_recorded_intake(intake)?
        || !strict_equal(&generated["intake"]["intakeHash"], &intake["intakeHash"])
        || !strict_equal(
            &generated["plannedGenerationHash"],
            &supplied["plannedGenerationHash"],
        )
        || integer(
            &options["producerLeaseGeneration"],
            1,
            9_007_199_254_740_991,
        )
        .is_none()
        || !sha(&options["producerLeaseTokenHash"])
        || integer(
            &options["residentLeaseGeneration"],
            1,
            9_007_199_254_740_991,
        )
        .is_none()
        || !sha(&options["residentLeaseTokenHash"])
        || !valid_nonce
    {
        return Err(invalid(
            "autonomous_research_topic_producer_capability_invalid",
        ));
    }
    if !verify_provider_canary_pair_v1(
        pair,
        &profile["providerConfigurationHash"],
        &options["now"],
    )? {
        return Err(invalid(
            "autonomous_research_topic_producer_capability_invalid",
        ));
    }
    let issued = &pair["observedAt"];
    let expires = time(&pair["researchAuthorProviderCanaryReceipt"]["expiresAt"])?
        .min(time(
            &pair["formalReviewerProviderCanaryReceipt"]["expiresAt"],
        )?)
        .min(
            time(issued)?
                + integer(&profile["capabilityValidityMs"], 60_000, 900_000).ok_or_else(|| {
                    invalid("autonomous_research_topic_producer_capability_invalid")
                })? as i64,
        );
    let mut payload = json!({"version":1,"kind":"AutonomousResearchTopicProducerCapabilityReceipt","status":"autonomous_research_topic_producer_capability_ready","canProduce":true,
 "producerId":profile["producerId"],"implementationId":profile["implementationId"],"implementationSha256":profile["implementationSha256"],"producerProfileHash":profile["producerProfileHash"],"policyProfileHash":profile["policyProfileHash"],
 "machineIntakeConfigurationHash":options["machineIntakeConfigurationHash"],"autonomousResearchProviderConfigurationHash":profile["providerConfigurationHash"],"generationSequence":options["generationSequence"],
 "producerLeaseGeneration":options["producerLeaseGeneration"],"producerLeaseTokenHash":options["producerLeaseTokenHash"],"residentLeaseGeneration":options["residentLeaseGeneration"],"residentLeaseTokenHash":options["residentLeaseTokenHash"],
 "budgetReservationId":supplied["budgetReservationId"],"budgetEpochStart":supplied["budgetEpochStart"],"plannedGenerationHash":supplied["plannedGenerationHash"],"producerTopicId":supplied["producerTopicId"],"topicFingerprint":supplied["topicFingerprint"],"canonicalResearchTopicHash":supplied["canonicalResearchTopicHash"],"registeredResearchProfileId":supplied["registeredResearchProfileId"],"researchProfileHash":supplied["researchProfileHash"],
 "autonomousResearchMachineIntakeHash":intake["intakeHash"],"admissionCreatedAt":intake["admissionCreatedAt"],"providerCanaryPairReceiptHash":pair["providerCanaryPairReceiptHash"],"providerCanaryPairReceipt":pair,"capabilityNonce":options["capabilityNonce"],"issuedAt":issued,"expiresAt":iso(expires)?,
 "safety":{"boundedRegisteredResearchOnly":true,"scientificNoveltyVerified":false,"scientificCorrectnessVerified":false,"externalSubmissionAuthorized":false,"automaticBudgetExpansionPerformed":false}});
    // JS omits undefined copied fields; the full verifier rebuilds all fields.
    for key in [
        "budgetEpochStart",
        "producerTopicId",
        "topicFingerprint",
        "canonicalResearchTopicHash",
        "registeredResearchProfileId",
        "researchProfileHash",
    ] {
        if supplied.get(key).is_none()
            && let Some(object) = payload.as_object_mut()
        {
            object.remove(key);
        }
    }
    payload["autonomousResearchTopicProducerCapabilityReceiptHash"] = json!(hash(
        "AutonomousResearchTopicProducerCapabilityReceipt",
        &payload
    )?);
    project(payload)
}
/// Full rebuild/equality and optional freshness, rather than envelope hashing.
/// Verification remains pure recorded-data validation, never live authority.
pub fn verify_topic_producer_capability_v1(
    value: &Value,
    profile: &Value,
    configuration: &Value,
    intake: &Value,
    now: Option<&Value>,
    require_fresh: bool,
) -> Result<bool> {
    for input in [value, profile, configuration, intake] {
        ensure_supported(input)?;
    }
    if let Some(now) = now {
        ensure_supported(now)?;
    }
    if !exact_keys(value, CAP_KEYS)
        || value["version"].as_f64() != Some(1.0)
        || value["kind"] != "AutonomousResearchTopicProducerCapabilityReceipt"
        || value["status"] != "autonomous_research_topic_producer_capability_ready"
        || value["canProduce"] != true
        || !valid_profile(profile)?
        || !strict_equal(
            &value["producerProfileHash"],
            &profile["producerProfileHash"],
        )
        || !strict_equal(&value["machineIntakeConfigurationHash"], configuration)
        || !strict_equal(
            &value["autonomousResearchMachineIntakeHash"],
            &intake["intakeHash"],
        )
        || !strict_equal(
            &value["providerCanaryPairReceiptHash"],
            &value["providerCanaryPairReceipt"]["providerCanaryPairReceiptHash"],
        )
        || !safety_valid(&value["safety"])
    {
        return Ok(false);
    }
    let checked = time(now.filter(|v| truthy(v)).unwrap_or(&value["issuedAt"]))?;
    let rebuilt = (|| {
        let generated = planned(
            profile,
            &value["generationSequence"],
            &value["admissionCreatedAt"],
            &value["budgetReservationId"],
        )?;
        build_topic_producer_capability_v1(
            &json!({"producerProfile":profile,"machineIntakeConfigurationHash":configuration,"generationSequence":value["generationSequence"],"intake":intake,"providerCanaryPairReceipt":value["providerCanaryPairReceipt"],"plannedGeneration":generated,"producerLeaseGeneration":value["producerLeaseGeneration"],"producerLeaseTokenHash":value["producerLeaseTokenHash"],"residentLeaseGeneration":value["residentLeaseGeneration"],"residentLeaseTokenHash":value["residentLeaseTokenHash"],"capabilityNonce":value["capabilityNonce"],"now":value["issuedAt"]}),
        )
    })();
    let expected = match rebuilt {
        Ok(value) => value,
        Err(error) if error.code().ends_with("_unsupported") => return Err(error),
        Err(_) => return Ok(false),
    };
    if hash(
        "AutonomousResearchTopicProducerCapabilityReceiptEquality",
        value,
    )? != hash(
        "AutonomousResearchTopicProducerCapabilityReceiptEquality",
        &expected,
    )? {
        return Ok(false);
    }
    Ok(!require_fresh
        || (checked >= time(&value["issuedAt"])? && checked < time(&value["expiresAt"])?))
}
