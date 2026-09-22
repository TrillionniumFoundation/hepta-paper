use super::{IMPLEMENTATION_ID, Result, ensure, hash};
use crate::machine_intake::contract::{
    exact_keys, has_unsupported_local_golden_scope, integer, verify_intake,
};
use serde_json::{Value, json};
use std::collections::BTreeSet;

const INVALID: &str = "profile_invalid_or_mismatched";
const PROFILE_KEYS: &[&str] = &[
    "budgets",
    "canonicalResearchTopicHash",
    "datasetMounts",
    "kind",
    "objective",
    "profileId",
    "protocolFamily",
    "refereeCount",
    "replicationPolicy",
    "researchProfileHash",
    "revisionRounds",
    "version",
];
const PRODUCER_KEYS: &[&str] = &[
    "capabilityValidityMs",
    "implementationId",
    "implementationSha256",
    "kind",
    "maximumProviderCanaryAttemptsPerUtcDay",
    "maximumProviderCanaryCostUsdPerUtcDay",
    "maximumTopicsPerUtcDay",
    "minimumGenerationIntervalMs",
    "policyId",
    "policyProfileHash",
    "producerId",
    "producerProfileHash",
    "providerConfigurationHash",
    "registeredResearchProfiles",
    "version",
];
const DAY: u64 = 86_400_000;

fn id(value: &Value) -> bool {
    value.as_str().is_some_and(|value| {
        !value.is_empty()
            && value.len() <= 48
            && value.as_bytes()[0].is_ascii_alphanumeric()
            && value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"_.:-".contains(&byte))
    })
}

fn js_string(value: &Value) -> String {
    match value {
        Value::Null => "null".to_owned(),
        Value::Bool(value) => value.to_string(),
        Value::Number(value) => value.to_string(),
        Value::String(value) => value.clone(),
        Value::Array(values) => values
            .iter()
            .map(|value| {
                if value.is_null() {
                    String::new()
                } else {
                    js_string(value)
                }
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".to_owned(),
    }
}

fn hash_shape(value: &Value) -> bool {
    let text = js_string(value);
    text.strip_prefix("sha256:").is_some_and(|hex| {
        hex.len() == 64
            && hex
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    })
}

fn supported_mount_hash_transport(value: &Value) -> Result<()> {
    if value.is_string() {
        return Ok(());
    }
    let text = js_string(value);
    let original_hash_shape = text
        .get(..7)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("sha256:"))
        && text
            .get(7..)
            .is_some_and(|hex| hex.len() == 64 && hex.bytes().all(|byte| byte.is_ascii_hexdigit()));
    // Do not advertise invalid scalars/null as an original positive transport.
    // This explicit finite-profile refusal is for String([hash])-style arrays.
    ensure(value.is_array() && original_hash_shape, INVALID)?;
    Err(super::TopicProducerProfileError::new(
        "dataset_mount_transport_unsupported",
    ))
}

fn policy() -> Value {
    // Original builtin registry compiles profiles in localeCompare family order.
    // Configured plugin startup registries are explicitly outside this profile.
    json!({
        "version":1,"policyId":"hepta-bounded-autonomous-research-v1",
        "allowedProtocolFamilies":["econometrics_panel_benchmark","finance_asset_pricing_benchmark",
            "ml_algorithm_benchmark","operations_optimization_benchmark","rl_stochastic_control_benchmark"],
        "allowedCapabilities":["draft_manuscript","formalize_claims","attempt_kernel_checked_proofs",
            "generate_experiment_code","execute_preregistered_empirical_protocol","run_independent_replay",
            "run_referee_revision_loop","prepare_external_qualification_request"],
        "minimumRefereeCount":2,"minimumRevisionRounds":1,"maximumRevisionRounds":10,
        "externalSubmissionEnabled":false,"humanSubjectsAllowed":false,
        "privateDataWithoutExternalAuthorityAllowed":false,"externalReleaseAttestationRequired":true,
    })
}

fn registered(value: &Value) -> Result<Value> {
    ensure(
        exact_keys(value, PROFILE_KEYS)
            && value["version"].as_f64() == Some(1.0)
            && value["kind"] == "AutonomousResearchRegisteredTopicProfile"
            && id(&value["profileId"])
            && value["objective"]
                .as_str()
                .is_some_and(|text| text.encode_utf16().count() <= 6000),
        INVALID,
    )?;
    ensure(
        !has_unsupported_local_golden_scope(value),
        "local_golden_dataset_scope_unsupported",
    )?;
    let Some(profile_id) = value["profileId"].as_str() else {
        return Err(super::TopicProducerProfileError::new(INVALID));
    };
    // A serialized original profile must equal its rebuilt normalized intake
    // fields. The established builtin verifier checks those canonical fields,
    // exact budgets, ordinary mounts, objective NFKC and numerical contracts.
    let mut probe = json!({"version":2,"kind":"AutonomousResearchMachineIntake",
        "intakeId":format!("intake:producer-probe:{profile_id}"),
        "paperId":format!("producer-probe:{profile_id}"),
        "campaignId":format!("autonomous-research:producer-probe:{profile_id}"),
        "launchMode":"production-run","objective":value["objective"],
        "protocolFamily":value["protocolFamily"],"datasetMounts":value["datasetMounts"],
        "budgets":value["budgets"],"providerConfigurationHash":format!("sha256:{}","0".repeat(64)),
        "revisionRounds":value["revisionRounds"],"refereeCount":value["refereeCount"],
        "admissionCreatedAt":"2026-01-01T00:00:00.000Z","recurringGoldenProvenance":null,
    });
    if let Some(mounts) = value["datasetMounts"].as_array() {
        for mount in mounts {
            for key in [
                "manifestHash",
                "operatorDatasetAuthorityDocumentHash",
                "operatorDatasetResearchSemanticsHash",
                "operatorDatasetHarnessHandle",
                "splitManifestHash",
                "benchmarkHarnessDocumentHash",
                "benchmarkHarnessDefinitionHash",
                "analysisProtocolHash",
            ] {
                if let Some(value) = mount.get(key) {
                    supported_mount_hash_transport(value)?;
                }
            }
            if mount["licenseId"]
                .as_str()
                .is_some_and(|value| value.starts_with("LicenseRef-"))
            {
                supported_mount_hash_transport(&mount["operatorAuthorizationHash"])?;
            }
        }
    }
    probe["intakeHash"] = json!(hash("AutonomousResearchMachineIntake", &probe)?);
    ensure(verify_intake(&probe), INVALID)?;
    let topic_hash = hash(
        "AutonomousResearchCanonicalTopic",
        &json!({
            "objective":value["objective"],"protocolFamily":value["protocolFamily"],"datasetMounts":value["datasetMounts"],
        }),
    )?;
    let mut expected = json!({"version":1,"kind":"AutonomousResearchRegisteredTopicProfile",
        "profileId":profile_id,"objective":value["objective"],"protocolFamily":value["protocolFamily"],
        "datasetMounts":value["datasetMounts"],"budgets":value["budgets"],
        "revisionRounds":value["revisionRounds"],"refereeCount":value["refereeCount"],
        "replicationPolicy":"bounded-independent-epoch-replication-v1","canonicalResearchTopicHash":topic_hash,
    });
    expected["researchProfileHash"] =
        json!(hash("AutonomousResearchRegisteredTopicProfile", &expected)?);
    Ok(expected)
}

pub(super) fn verify(value: &Value) -> Result<()> {
    ensure(
        exact_keys(value, PRODUCER_KEYS)
            && value["version"].as_f64() == Some(1.0)
            && value["kind"] == "AutonomousResearchTopicProducerProfile"
            && value["implementationId"] == IMPLEMENTATION_ID
            && id(&value["producerId"])
            && hash_shape(&value["implementationSha256"])
            && hash_shape(&value["providerConfigurationHash"]),
        INVALID,
    )?;
    let profiles = value["registeredResearchProfiles"]
        .as_array()
        .ok_or_else(|| super::TopicProducerProfileError::new(INVALID))?;
    ensure(!profiles.is_empty() && profiles.len() <= 16, INVALID)?;
    let interval = integer(&value["minimumGenerationIntervalMs"], 3_600_000, DAY)
        .ok_or_else(|| super::TopicProducerProfileError::new(INVALID))?;
    ensure(DAY.is_multiple_of(interval), INVALID)?;
    let maximum_topics = integer(
        &value["maximumTopicsPerUtcDay"],
        1,
        (DAY / interval).min(24),
    )
    .ok_or_else(|| super::TopicProducerProfileError::new(INVALID))?;
    ensure(
        integer(
            &value["maximumProviderCanaryAttemptsPerUtcDay"],
            maximum_topics,
            48,
        )
        .is_some()
            && integer(&value["capabilityValidityMs"], 60_000, 900_000).is_some()
            && value["maximumProviderCanaryCostUsdPerUtcDay"]
                .as_f64()
                .is_some_and(|value| value.is_finite() && value > 0.0 && value <= 100.0),
        INVALID,
    )?;
    let expected_profiles = profiles
        .iter()
        .map(registered)
        .collect::<Result<Vec<_>>>()?;
    let mut ids = BTreeSet::new();
    let mut topics = BTreeSet::new();
    for profile in &expected_profiles {
        ensure(
            ids.insert(profile["profileId"].as_str())
                && topics.insert(profile["canonicalResearchTopicHash"].as_str()),
            INVALID,
        )?;
    }
    let mut expected = json!({"version":1,"kind":"AutonomousResearchTopicProducerProfile",
        "producerId":value["producerId"],"implementationId":IMPLEMENTATION_ID,
        "implementationSha256":value["implementationSha256"],"providerConfigurationHash":value["providerConfigurationHash"],
        "policyId":"hepta-bounded-autonomous-research-v1",
        "policyProfileHash":hash("AutonomousResearchPolicyProfile", &policy())?,
        "registeredResearchProfiles":expected_profiles,
        "minimumGenerationIntervalMs":interval,"maximumTopicsPerUtcDay":maximum_topics,
        "maximumProviderCanaryAttemptsPerUtcDay":value["maximumProviderCanaryAttemptsPerUtcDay"],
        "maximumProviderCanaryCostUsdPerUtcDay":value["maximumProviderCanaryCostUsdPerUtcDay"],
        "capabilityValidityMs":value["capabilityValidityMs"],
    });
    expected["producerProfileHash"] =
        json!(hash("AutonomousResearchTopicProducerProfile", &expected)?);
    ensure(
        hash("AutonomousResearchTopicProducerProfileEquality", value)?
            == hash("AutonomousResearchTopicProducerProfileEquality", &expected)?,
        INVALID,
    )
}
