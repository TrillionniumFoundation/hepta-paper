//! Pure incumbent generation/capability data contracts for builtin profiles.
//! These functions rebuild recorded data. They do not run canaries, acquire
//! leases, admit work, verify independent signers or establish live authority.
mod capability;
mod value;
use crate::machine_intake::contract::{canonical_instant, integer, verify_intake};
pub use capability::{
    build_topic_producer_capability_v1, verify_provider_canary_pair_v1,
    verify_topic_producer_capability_v1,
};
use serde_json::{Value, json};
use value::{ensure_supported, hash, or_empty, own_hash, project, sha};

pub type Result<T> = std::result::Result<T, TopicProducerContractError>;
#[derive(Debug, thiserror::Error)]
#[error("{code}")]
pub struct TopicProducerContractError {
    code: String,
}
impl TopicProducerContractError {
    pub(super) fn new(code: &str) -> Self {
        Self {
            code: code.to_owned(),
        }
    }
    pub fn code(&self) -> &str {
        &self.code
    }
}
fn invalid(code: &str) -> TopicProducerContractError {
    TopicProducerContractError::new(code)
}
fn valid_profile(profile: &Value) -> Result<bool> {
    match crate::topic_producer_profile::verify_serialized_profile(profile) {
        Ok(()) => Ok(true),
        Err(error) if error.code().ends_with("_unsupported") => Err(invalid(error.code())),
        Err(_) => Ok(false),
    }
}

/// Deterministically select a registered profile and rebuild its production-run
/// intake. No dataset or implementation observation is implied by this pure API.
pub fn materialize_topic_producer_intake_v1(
    profile: &Value,
    sequence: &Value,
    admitted_at: &Value,
) -> Result<Value> {
    for value in [profile, sequence, admitted_at] {
        ensure_supported(value)?;
    }
    let sequence = integer(sequence, 1, 9_007_199_254_740_991);
    // Preserve explicit unsupported profile diagnostics, independently of the
    // ordinary invalid profile/generation result.
    let profile_valid = valid_profile(profile)?;
    let Some(sequence) = sequence.filter(|_| profile_valid) else {
        return Err(invalid(
            "autonomous_research_topic_producer_generation_invalid",
        ));
    };
    canonical_instant(admitted_at)
        .ok_or_else(|| invalid("autonomous_research_topic_producer_admission_time_invalid"))?;
    let profiles = profile["registeredResearchProfiles"]
        .as_array()
        .ok_or_else(|| invalid("autonomous_research_topic_producer_generation_invalid"))?;
    let selected = profiles
        .get(((sequence - 1) % profiles.len() as u64) as usize)
        .ok_or_else(|| invalid("autonomous_research_topic_producer_generation_invalid"))?;
    let producer = profile["producerId"].as_str().unwrap_or_default();
    let id = selected["profileId"].as_str().unwrap_or_default();
    let paper = format!("prod:{producer}:{id}:{sequence}");
    let objective = format!(
        "{} Preregistered bounded replication epoch {sequence}; this run does not assert scientific novelty, correctness, or validity outside the registered evaluation universe.",
        selected["objective"].as_str().unwrap_or_default()
    );
    if objective.encode_utf16().count() > 7000 || objective.len() > 8192 {
        return Err(invalid(
            "autonomous_research_machine_intake_objective_invalid",
        ));
    }
    let mut intake = json!({"version":2,"kind":"AutonomousResearchMachineIntake",
        "intakeId":format!("intake:{paper}"),"paperId":paper,
        "campaignId":format!("autonomous-research:{paper}"),"launchMode":"production-run",
        "admissionCreatedAt":admitted_at,"objective":objective,"protocolFamily":selected["protocolFamily"],
        "datasetMounts":selected["datasetMounts"],"budgets":selected["budgets"],
        "providerConfigurationHash":profile["providerConfigurationHash"],"recurringGoldenProvenance":null,
        "revisionRounds":selected["revisionRounds"],"refereeCount":selected["refereeCount"]});
    intake["intakeHash"] = json!(hash("AutonomousResearchMachineIntake", &intake)?);
    if !verify_recorded_intake(&intake)? {
        return Err(invalid(
            "autonomous_research_topic_producer_generation_invalid",
        ));
    }
    project(json!({"registeredResearchProfile":selected,"intake":intake}))
}

/// Build the original planned-generation hash and complete attached intake.
/// A planned-generation document is data, not a reservation or authorization.
pub fn build_topic_producer_planned_generation_v1(
    profile: &Value,
    sequence: &Value,
    admitted_at: &Value,
    reservation_id: &Value,
) -> Result<Value> {
    let generated = materialize_topic_producer_intake_v1(profile, sequence, admitted_at)?;
    ensure_supported(reservation_id)?;
    let reservation = or_empty(reservation_id);
    if reservation.is_empty()
        || reservation.len() > 48
        || !reservation.as_bytes()[0].is_ascii_alphanumeric()
        || !reservation
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_.:-".contains(&b))
    {
        return Err(invalid(
            "autonomous_research_topic_producer_budget_reservation_id_invalid",
        ));
    }
    let selected = &generated["registeredResearchProfile"];
    let intake = &generated["intake"];
    let time = admitted_at
        .as_str()
        .ok_or_else(|| invalid("autonomous_research_topic_producer_admission_time_invalid"))?;
    let (date, _) = time
        .split_once('T')
        .ok_or_else(|| invalid("autonomous_research_topic_producer_admission_time_invalid"))?;
    let sequence = integer(sequence, 1, 9_007_199_254_740_991)
        .ok_or_else(|| invalid("autonomous_research_topic_producer_generation_invalid"))?;
    let producer_topic_id = format!(
        "{}:{}:{sequence}",
        profile["producerId"].as_str().unwrap_or_default(),
        selected["profileId"].as_str().unwrap_or_default()
    );
    let fingerprint = hash(
        "AutonomousResearchTopicFingerprint",
        &json!({"producerProfileHash":profile["producerProfileHash"],
        "canonicalResearchTopicHash":selected["canonicalResearchTopicHash"],"replicationPolicy":selected["replicationPolicy"],"replicationEpoch":sequence}),
    )?;
    let mut planned = json!({"version":1,"kind":"AutonomousResearchTopicProducerPlannedGeneration",
        "producerId":profile["producerId"],"producerProfileHash":profile["producerProfileHash"],
        "providerConfigurationHash":profile["providerConfigurationHash"],"generationSequence":sequence,
        "producerTopicId":producer_topic_id,"topicFingerprint":fingerprint,"registeredResearchProfileId":selected["profileId"],
        "researchProfileHash":selected["researchProfileHash"],"canonicalResearchTopicHash":selected["canonicalResearchTopicHash"],
        "autonomousResearchMachineIntakeHash":intake["intakeHash"],"admissionCreatedAt":admitted_at,
        "budgetReservationId":reservation,"budgetEpochStart":format!("{date}T00:00:00.000Z")});
    planned["plannedGenerationHash"] = json!(hash(
        "AutonomousResearchTopicProducerPlannedGeneration",
        &planned
    )?);
    planned["intake"] = intake.clone();
    project(planned)
}

// The incumbent retains hash-shaped provider arrays. Validate their original
// payload hash before independently applying the established scalar contract
// to an equivalent private shape probe. No caller-supplied ready bit is used.
fn verify_recorded_intake(value: &Value) -> Result<bool> {
    if value["providerConfigurationHash"].is_string() {
        return Ok(verify_intake(value));
    }
    if !sha(&value["providerConfigurationHash"])
        || !own_hash(value, "AutonomousResearchMachineIntake", "intakeHash")?
    {
        return Ok(false);
    }
    let mut probe = value.clone();
    probe["providerConfigurationHash"] = json!(or_empty(&value["providerConfigurationHash"]));
    if let Some(map) = probe.as_object_mut() {
        map.remove("intakeHash");
    }
    probe["intakeHash"] = json!(hash("AutonomousResearchMachineIntake", &probe)?);
    Ok(verify_intake(&probe))
}
