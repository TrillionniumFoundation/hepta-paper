//! Pure recorded-data contracts. These functions never establish that a canary
//! ran, issue mutation authority, or perform any filesystem/SQLite/provider I/O.
mod generation;
mod value;

pub use generation::parse_generation;

use crate::machine_intake::contract::{canonical_instant, exact_keys, integer};
use hepta_legacy_compatibility::production_hash_record_v1;
use serde_json::Value;
use value::{safe_code, sha, strict_equal, supported, truthy};

#[derive(Clone, Debug, Eq, PartialEq, thiserror::Error)]
#[error("{code}")]
pub struct Error {
    code: &'static str,
}
impl Error {
    pub fn code(&self) -> &'static str {
        self.code
    }
    fn invalid() -> Self {
        Self {
            code: "autonomous_research_topic_producer_state_invalid",
        }
    }
    fn unsupported() -> Self {
        Self {
            code: "autonomous_research_topic_producer_state_json_profile_unsupported",
        }
    }
}
pub type Result<T> = std::result::Result<T, Error>;

const RESERVATION_KEYS: &[&str] = &[
    "budgetEpochStart",
    "budgetReservationId",
    "generationSequence",
    "plannedGenerationHash",
    "providerCanaryReservedAttemptCount",
    "providerCanaryReservedCostUsd",
];
const ACTION_KEYS: &[&str] = &[
    "errorCode",
    "providerCanaryReceiptHash",
    "role",
    "sequence",
    "status",
];
const JOURNAL_KEYS: &[&str] = &[
    "actions",
    "autonomousResearchProviderCanaryAttemptJournalHash",
    "currentRole",
    "failurePhase",
    "kind",
    "providerConfigurationHash",
    "reservation",
    "version",
];
const INSPECTION_KEYS: &[&str] = &[
    "actionAccountingComplete",
    "actions",
    "autonomousResearchProviderCanarySideEffectInspectionHash",
    "externalActionMayHaveOccurred",
    "externalActionPerformed",
    "externalActionScope",
    "failedProviderCanaryActionCount",
    "failureCode",
    "failurePhase",
    "kind",
    "providerCanaryActionCount",
    "providerConfigurationHash",
    "reservation",
    "researchAuthorCanaryAttemptCount",
    "formalReviewerCanaryAttemptCount",
    "status",
    "successfulProviderCanaryActionCount",
    "version",
];

fn valid_reservation(value: &Value) -> bool {
    exact_keys(value, RESERVATION_KEYS)
        && integer(&value["generationSequence"], 1, 9_007_199_254_740_991).is_some()
        && sha(&value["plannedGenerationHash"])
        && value::reservation_id(&value["budgetReservationId"])
        && canonical_instant(&value["budgetEpochStart"]).is_some()
        && value["providerCanaryReservedAttemptCount"].as_f64() == Some(1.0)
        && value["providerCanaryReservedCostUsd"]
            .as_f64()
            .is_some_and(|cost| cost.is_finite() && (0.0..=100.0).contains(&cost))
}

fn same_reservation(left: &Value, right: &Value) -> bool {
    RESERVATION_KEYS
        .iter()
        .all(|key| value::optional_equal(left.get(*key), right.get(*key)))
}

fn expected_matches(value: &Value, provider: Option<&Value>, reservation: Option<&Value>) -> bool {
    provider
        .filter(|expected| truthy(expected))
        .is_none_or(|expected| strict_equal(&value["providerConfigurationHash"], expected))
        && reservation
            .filter(|expected| truthy(expected))
            .is_none_or(|expected| same_reservation(&value["reservation"], expected))
}

fn valid_actions(value: &Value) -> Option<&[Value]> {
    let actions = value.as_array()?;
    if actions.len() > 2 {
        return None;
    }
    for (index, action) in actions.iter().enumerate() {
        let expected_role = if index == 0 {
            "research_author"
        } else {
            "formal_reviewer"
        };
        if !exact_keys(action, ACTION_KEYS)
            || action["sequence"].as_f64() != Some((index + 1) as f64)
            || action["role"] != expected_role
            || !matches!(action["status"].as_str(), Some("succeeded" | "failed"))
        {
            return None;
        }
        let succeeded = action["status"] == "succeeded";
        if value::or_empty(&action["providerCanaryReceiptHash"]).is_none()
            || succeeded != sha(&action["providerCanaryReceiptHash"])
            || if succeeded {
                !action["errorCode"].is_null()
            } else {
                !safe_code(&action["errorCode"])
            }
        {
            return None;
        }
    }
    Some(actions)
}

fn own_hash(value: &Value, domain: &str, key: &str) -> bool {
    let Some(claimed) = value.get(key).and_then(Value::as_str) else {
        return false;
    };
    let Some(mut payload) = value.as_object().cloned() else {
        return false;
    };
    payload.remove(key);
    sha(&value[key])
        && production_hash_record_v1(domain, &Value::Object(payload))
            .is_ok_and(|actual| actual.as_str() == claimed)
}

fn bounded_inputs(value: &Value, provider: Option<&Value>, reservation: Option<&Value>) -> bool {
    supported(value) && provider.is_none_or(supported) && reservation.is_none_or(supported)
}

/// Verify the original recorded attempt-journal contract. Optional expected
/// bindings follow original JavaScript truthiness and strict equality. This is
/// not a live provider observation or an authorization constructor.
pub fn verify_journal(
    value: &Value,
    provider: Option<&Value>,
    reservation: Option<&Value>,
) -> bool {
    if !bounded_inputs(value, provider, reservation)
        || !exact_keys(value, JOURNAL_KEYS)
        || value["version"].as_f64() != Some(1.0)
        || value["kind"] != "AutonomousResearchProviderCanaryAttemptJournal"
        || !sha(&value["providerConfigurationHash"])
        || !valid_reservation(&value["reservation"])
        || !expected_matches(value, provider, reservation)
        || (!value["currentRole"].is_null()
            && !matches!(
                value["currentRole"].as_str(),
                Some("research_author" | "formal_reviewer")
            ))
        || !safe_code(&value["failurePhase"])
    {
        return false;
    }
    let Some(actions) = valid_actions(&value["actions"]) else {
        return false;
    };
    if (value["currentRole"] == "research_author" && !actions.is_empty())
        || (value["currentRole"] == "formal_reviewer"
            && (actions.len() != 1 || actions[0]["status"] != "succeeded"))
        || (value["currentRole"].is_null()
            && actions.is_empty()
            && value["failurePhase"] != "provider_canary_reserved")
    {
        return false;
    }
    own_hash(
        value,
        "AutonomousResearchProviderCanaryAttemptJournal",
        "autonomousResearchProviderCanaryAttemptJournalHash",
    )
}

/// Verify recorded failure accounting without asserting that its actions were
/// actually executed. A matching hash is not a signature or authority grant.
pub fn verify_side_effect(
    value: &Value,
    provider: Option<&Value>,
    reservation: Option<&Value>,
) -> bool {
    if !bounded_inputs(value, provider, reservation)
        || !exact_keys(value, INSPECTION_KEYS)
        || value["version"].as_f64() != Some(1.0)
        || value["kind"] != "AutonomousResearchProviderCanarySideEffectInspection"
        || value["status"] != "autonomous_research_provider_canary_attempt_failed"
        || !sha(&value["providerConfigurationHash"])
        || !valid_reservation(&value["reservation"])
        || !expected_matches(value, provider, reservation)
        || !value["actionAccountingComplete"].is_boolean()
        || !safe_code(&value["failurePhase"])
        || !safe_code(&value["failureCode"])
    {
        return false;
    }
    let Some(phase) = value::string(&value["failurePhase"]) else {
        return false;
    };
    if value["failureCode"].as_str() != Some(format!("{phase}_failed").as_str()) {
        return false;
    }
    let Some(actions) = valid_actions(&value["actions"]) else {
        return false;
    };
    let successful = actions
        .iter()
        .filter(|action| action["status"] == "succeeded")
        .count();
    let failed = actions.len() - successful;
    let author = usize::from(!actions.is_empty());
    let reviewer = usize::from(actions.len() == 2);
    let performed = !actions.is_empty();
    let may_have_occurred = performed || value["actionAccountingComplete"] == false;
    if value["providerCanaryActionCount"].as_f64() != Some(actions.len() as f64)
        || value["successfulProviderCanaryActionCount"].as_f64() != Some(successful as f64)
        || value["failedProviderCanaryActionCount"].as_f64() != Some(failed as f64)
        || value["researchAuthorCanaryAttemptCount"].as_f64() != Some(author as f64)
        || value["formalReviewerCanaryAttemptCount"].as_f64() != Some(reviewer as f64)
        || value["externalActionPerformed"] != performed
        || value["externalActionMayHaveOccurred"] != may_have_occurred
        || value["externalActionScope"]
            != if performed {
                "read_only_ephemeral_model_canaries"
            } else {
                "none_observed"
            }
    {
        return false;
    }
    own_hash(
        value,
        "AutonomousResearchProviderCanarySideEffectInspection",
        "autonomousResearchProviderCanarySideEffectInspectionHash",
    )
}
