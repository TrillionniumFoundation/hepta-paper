use super::{Error, Result, value, verify_journal, verify_side_effect};
use hepta_legacy_compatibility::production_stable_json_v1;
use serde_json::{Map, Value, json};
use value::{Document, optional_equal, truthy};

fn ensure(valid: bool) -> Result<()> {
    if valid { Ok(()) } else { Err(Error::invalid()) }
}

fn expected_reservation(planned: &Value, cost: Option<&Value>, document: &Value) -> Value {
    let mut expected = Map::new();
    for key in [
        "generationSequence",
        "plannedGenerationHash",
        "budgetReservationId",
        "budgetEpochStart",
    ] {
        if let Some(value) = planned.get(key) {
            expected.insert(key.to_owned(), value.clone());
        }
    }
    expected.insert("providerCanaryReservedAttemptCount".to_owned(), json!(1));
    if let Some(cost) = cost.filter(|value| !value.is_null()).or_else(|| {
        document
            .get("reservation")
            .and_then(|value| value.get("providerCanaryReservedCostUsd"))
    }) {
        expected.insert("providerCanaryReservedCostUsd".to_owned(), cost.clone());
    }
    Value::Object(expected)
}

fn optional_document(row: &Value, key: &str) -> Result<Option<Document>> {
    row.get(key)
        .filter(|value| truthy(value))
        .map(|value| Document::parse(Some(value)))
        .transpose()
}

fn optional_projection(document: &Option<Document>) -> Value {
    document
        .as_ref()
        .filter(|document| truthy(&document.value))
        .map_or(Value::Null, |document| document.value.clone())
}

/// Parse the original stored-generation diagnostic contract. This deliberately
/// does not recompute plannedGenerationHash or verify the complete capability:
/// the original status reader separately verifies its latest stored capability.
/// Input is a recorded row, not an authority object or a live execution proof.
pub fn parse_generation(
    row: &Value,
    provider: Option<&Value>,
    max_cost: Option<&Value>,
) -> Result<Value> {
    if !value::supported(row)
        || !provider.is_none_or(value::supported)
        || !max_cost.is_none_or(value::supported)
    {
        return Err(Error::unsupported());
    }
    if !truthy(row) {
        return Ok(Value::Null);
    }
    let planned = Document::parse(row.get("planned_generation_json"))?;
    let planned_value = &planned.value;
    ensure(value::sha(&planned_value["plannedGenerationHash"]))?;
    ensure(optional_equal(
        planned_value.get("plannedGenerationHash"),
        row.get("planned_generation_hash"),
    ))?;
    ensure(matches!(
        (planned_value.get("generationSequence").and_then(Value::as_f64), value::number(row.get("generation_sequence"))),
        (Some(left), Some(right)) if left == right
    ))?;
    for (key, column) in [
        ("producerTopicId", "producer_topic_id"),
        ("topicFingerprint", "topic_fingerprint"),
        (
            "canonicalResearchTopicHash",
            "canonical_research_topic_hash",
        ),
        ("budgetReservationId", "budget_reservation_id"),
        ("budgetEpochStart", "budget_epoch_start"),
    ] {
        ensure(optional_equal(planned_value.get(key), row.get(column)))?;
    }
    ensure(matches!(
        row["status"].as_str(),
        Some("planned" | "authorized" | "produced" | "failed")
    ))?;

    let capability = optional_document(row, "capability_json")?;
    if let Some(capability) = &capability {
        // JSON null causes an original engine TypeError, rather than its named
        // state-invalid failure. Keep that difference an explicit profile refusal.
        if capability.value.is_null() {
            return Err(Error::unsupported());
        }
        ensure(optional_equal(
            capability
                .value
                .get("autonomousResearchTopicProducerCapabilityReceiptHash"),
            row.get("capability_hash"),
        ))?;
        ensure(optional_equal(
            capability.value.get("capabilityNonce"),
            row.get("capability_nonce"),
        ))?;
    }
    let started = value::number(row.get("provider_canary_attempt_started"));
    ensure(matches!(started, Some(0.0 | 1.0)))?;
    let started = started == Some(1.0);
    let journal = optional_document(row, "provider_canary_attempt_journal_json")?;
    if let Some(journal) = &journal {
        let expected = expected_reservation(planned_value, max_cost, &journal.value);
        ensure(started && verify_journal(&journal.value, provider, Some(&expected)))?;
    }
    if started && matches!(row["status"].as_str(), Some("planned" | "authorized")) {
        ensure(journal.is_some())?;
    }
    let inspection = optional_document(row, "provider_canary_side_effect_inspection_json")?;
    if let Some(inspection) = &inspection {
        // The original evaluates journalActionsBound before its inspection
        // validator. A nonempty journal dereferences inspection.actions[index];
        // absent/null actions (or a null inspection) throw. An empty journal's
        // every() does not execute the callback, so it still reaches the normal
        // state-invalid predicate instead.
        if journal.as_ref().is_some_and(|journal| {
            journal.value["actions"]
                .as_array()
                .is_some_and(|actions| !actions.is_empty())
        }) && inspection.value.get("actions").is_none_or(Value::is_null)
        {
            return Err(Error::unsupported());
        }
        let expected = expected_reservation(planned_value, max_cost, &inspection.value);
        let actions_bound = journal
            .as_ref()
            .is_none_or(|journal| journal.actions_prefix_matches(inspection));
        ensure(
            row["status"] == "failed"
                && verify_side_effect(&inspection.value, provider, Some(&expected))
                && optional_equal(row.get("error"), inspection.value.get("failureCode"))
                && actions_bound,
        )?;
    }
    if started && row["status"] == "failed" {
        ensure(inspection.is_some())?;
    }

    let mut output = Map::new();
    output.insert(
        "generationSequence".to_owned(),
        value::number_value(row.get("generation_sequence")),
    );
    output.insert("status".to_owned(), row["status"].clone());
    output.insert(
        "leaseGeneration".to_owned(),
        value::number_value(row.get("lease_generation")),
    );
    output.insert("plannedGeneration".to_owned(), planned.value);
    output.insert("capability".to_owned(), optional_projection(&capability));
    for (key, column) in [
        ("intakeId", "intake_id"),
        ("intakeHash", "intake_hash"),
        ("admissionHash", "admission_hash"),
        ("error", "error"),
    ] {
        output.insert(
            key.to_owned(),
            row.get(column)
                .filter(|value| truthy(value))
                .map_or(Value::Null, Clone::clone),
        );
    }
    // An absent row property is JS undefined and is omitted by JSON.stringify;
    // SQL NULL remains an explicit JSON null.
    for (key, column) in [("createdAt", "created_at"), ("updatedAt", "updated_at")] {
        if let Some(value) = row.get(column) {
            output.insert(key.to_owned(), value.clone());
        }
    }
    output.insert(
        "providerCanaryAttemptStarted".to_owned(),
        Value::Bool(started),
    );
    output.insert(
        "providerCanaryAttemptJournal".to_owned(),
        optional_projection(&journal),
    );
    output.insert(
        "providerCanarySideEffectInspection".to_owned(),
        optional_projection(&inspection),
    );
    // Match the original JSON boundary's Number spellings and nonfinite lease
    // Number projection, after the ordered raw action comparison is complete.
    let bytes =
        production_stable_json_v1(&Value::Object(output)).map_err(|_| Error::unsupported())?;
    serde_json::from_slice(&bytes).map_err(|_| Error::unsupported())
}
