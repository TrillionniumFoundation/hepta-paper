use super::{Context, LIMIT, TIME, sqlite};
use rusqlite::Connection;
use serde_json::{Value, json};
use sqlite::{Budget, Field, Kind, Result};
use std::path::Path;

const METADATA: &str = "autonomous_research_topic_producer_metadata";
const GENERATION: &str = "autonomous_research_topic_producer_generation";
const DAILY: &str = "autonomous_research_topic_producer_daily_budget";
const METADATA_FIELDS: &[Field] = &[
    Field::new("singleton", Kind::Integer),
    Field::new("machine_intake_configuration_hash", Kind::Text),
    Field::new("producer_profile_hash", Kind::Text),
    Field::new("provider_configuration_hash", Kind::Text),
    Field::new("implementation_sha256", Kind::Text),
    Field::new("generation_high_watermark", Kind::Integer),
    Field::new("last_observed_at", Kind::NullableText),
    Field::new("last_produced_at", Kind::NullableText),
    Field::new("next_attempt_at", Kind::NullableText),
];
const GENERATION_FIELDS: &[Field] = &[
    Field::new("generation_sequence", Kind::Integer),
    Field::new("status", Kind::Text),
    Field::new("lease_generation", Kind::Integer),
    Field::new("producer_topic_id", Kind::Text),
    Field::new("topic_fingerprint", Kind::Text),
    Field::new("canonical_research_topic_hash", Kind::Text),
    Field::new("budget_reservation_id", Kind::Text),
    Field::new("budget_epoch_start", Kind::Text),
    Field::new("planned_generation_hash", Kind::Text),
    Field::new("planned_generation_json", Kind::Json),
    Field::new("capability_hash", Kind::NullableText),
    Field::new("capability_nonce", Kind::NullableText),
    Field::new("capability_json", Kind::NullableJson),
    Field::new("intake_id", Kind::NullableText),
    Field::new("intake_hash", Kind::NullableText),
    Field::new("admission_hash", Kind::NullableText),
    Field::new("error", Kind::NullableText),
    Field::new("provider_canary_attempt_started", Kind::Integer),
    Field::new("provider_canary_attempt_journal_json", Kind::NullableJson),
    Field::new(
        "provider_canary_side_effect_inspection_json",
        Kind::NullableJson,
    ),
    Field::new("created_at", Kind::Text),
    Field::new("updated_at", Kind::Text),
];
const DAILY_FIELDS: &[Field] = &[
    Field::new("epoch_start", Kind::Text),
    Field::new("provider_canary_attempt_count", Kind::Integer),
    Field::new("provider_canary_reserved_cost_usd", Kind::Number),
    Field::new("produced_topic_count", Kind::Integer),
];

fn one(
    connection: &Connection,
    table: &str,
    fields: &[Field],
    predicate: &str,
    parameter: Option<&str>,
    budget: &mut Budget,
) -> Result<Option<Value>> {
    // All table/field/predicate fragments originate in this source module.
    let query = format!(
        "SELECT {} FROM {table} WHERE {predicate} LIMIT 2",
        sqlite::select(fields)
    );
    let mut statement = connection.prepare(&query).map_err(sqlite::error)?;
    let mut rows = if let Some(parameter) = parameter {
        statement.query([parameter])
    } else {
        statement.query([])
    }
    .map_err(sqlite::error)?;
    let Some(row) = rows.next().map_err(sqlite::error)? else {
        return Ok(None);
    };
    let value = sqlite::record(row, fields, budget)?;
    // Original schemas make these keys unique. Reject ambiguous altered schema
    // rows rather than choose a plan-dependent first record as a current state.
    if rows.next().map_err(sqlite::error)?.is_some() {
        return Err(super::STORAGE.into());
    }
    Ok(Some(value))
}

fn canonical_optional(value: &Value) -> Result<Option<i64>> {
    match value {
        Value::Null => Ok(None),
        Value::String(value) if value.is_empty() => Ok(None),
        Value::String(value) => {
            crate::journal_connector_coverage::qualification::canonical_instant_millis(value)
                .map(Some)
                .ok_or_else(|| TIME.into())
        }
        _ => Err(super::STORAGE.into()),
    }
}
fn truthy_timestamp(value: &Value) -> Value {
    if value.is_null() || value.as_str() == Some("") {
        Value::Null
    } else {
        value.clone()
    }
}
fn numeric(value: &Value) -> Result<f64> {
    value
        .as_f64()
        .filter(|value| value.is_finite())
        .ok_or_else(|| super::STORAGE.into())
}

struct Latest {
    planned: Value,
    capability: Value,
    empty_raw: bool,
}
fn history(
    connection: &Connection,
    context: &Context,
    budget: &mut Budget,
) -> Result<Option<Latest>> {
    let query = format!(
        "SELECT {} FROM {GENERATION} ORDER BY generation_sequence LIMIT {}",
        sqlite::select(GENERATION_FIELDS),
        sqlite::MAXIMUM_GENERATIONS + 1
    );
    let mut statement = connection.prepare(&query).map_err(sqlite::error)?;
    let mut rows = statement.query([]).map_err(sqlite::error)?;
    let mut count = 0usize;
    let mut latest = None;
    let mut previous_sequence = None;
    while let Some(row) = rows.next().map_err(sqlite::error)? {
        count += 1;
        if count > sqlite::MAXIMUM_GENERATIONS {
            return Err(LIMIT.into());
        }
        let row = sqlite::record(row, GENERATION_FIELDS, budget)?;
        let sequence = row["generation_sequence"].as_i64().ok_or(super::STORAGE)?;
        if previous_sequence.is_some_and(|previous| sequence <= previous) {
            // The original schema uses a primary key. An altered duplicate-key
            // table makes its ascending and descending latest-row queries
            // ambiguous; reject that storage profile instead of choosing one.
            return Err(super::STORAGE.into());
        }
        previous_sequence = Some(sequence);
        let parsed = crate::topic_producer_canary::parse_generation(
            &row,
            Some(&context.profile["providerConfigurationHash"]),
            None,
        )
        .map_err(|error| error.code().to_owned())?;
        if !row["capability_json"].is_null() {
            // Preserve the original non-NULL query, irrespective of status or
            // whether the capability is truthy. Do not fall back to older data.
            latest = Some(Latest {
                planned: parsed["plannedGeneration"].clone(),
                capability: parsed["capability"].clone(),
                empty_raw: row["capability_json"].as_str() == Some(""),
            });
        }
    }
    Ok(latest)
}

pub(super) fn inspect(path: &Path, context: &Context) -> Result<Value> {
    let connection = sqlite::open(path)?;
    let schema = sqlite::Schema::observe(&connection)?;
    let generation_columns = schema.columns(&connection, GENERATION)?;
    if !generation_columns.as_ref().is_some_and(|columns| {
        [
            "provider_canary_attempt_started",
            "provider_canary_attempt_journal_json",
            "provider_canary_side_effect_inspection_json",
        ]
        .iter()
        .all(|name| columns.contains(*name))
    }) {
        return Err("autonomous_research_topic_producer_schema_upgrade_required".into());
    }
    let metadata_columns = schema.columns(&connection, METADATA)?;
    sqlite::require_columns(metadata_columns.as_ref(), METADATA_FIELDS)?;
    let mut budget = Budget::default();
    let metadata = one(
        &connection,
        METADATA,
        METADATA_FIELDS,
        "singleton=1",
        None,
        &mut budget,
    )?
    .ok_or("autonomous_research_topic_producer_authority_mismatch")?;
    if metadata["machine_intake_configuration_hash"].as_str()
        != Some(context.configuration.as_str())
        || metadata["producer_profile_hash"] != context.profile["producerProfileHash"]
        || metadata["provider_configuration_hash"] != context.profile["providerConfigurationHash"]
        || metadata["implementation_sha256"].as_str() != Some(context.implementation.as_str())
    {
        return Err("autonomous_research_topic_producer_authority_mismatch".into());
    }
    sqlite::require_columns(generation_columns.as_ref(), GENERATION_FIELDS)?;
    let maximum: Option<i64> = connection.query_row(
        &format!("SELECT CASE WHEN typeof(COALESCE(MAX(generation_sequence),0))='integer' THEN COALESCE(MAX(generation_sequence),0) END FROM {GENERATION}"),
        [], |row| row.get(0),
    ).map_err(sqlite::error)?;
    let maximum = maximum.ok_or(super::STORAGE)?;
    if maximum.unsigned_abs() > 9_007_199_254_740_991 {
        return Err(super::STORAGE.into());
    }
    if metadata["generation_high_watermark"].as_i64() != Some(maximum) {
        return Err("autonomous_research_topic_producer_high_watermark_invalid".into());
    }
    let latest = history(&connection, context, &mut budget)?;
    let last_observed = canonical_optional(&metadata["last_observed_at"])?;
    let clock_monotonic = last_observed.is_none_or(|time| context.now >= time);
    let live = clock_monotonic && last_observed.is_some_and(|time| context.now - time < 900_000);

    let daily_columns = schema.columns(&connection, DAILY)?;
    sqlite::require_columns(daily_columns.as_ref(), DAILY_FIELDS)?;
    let daily = one(
        &connection,
        DAILY,
        DAILY_FIELDS,
        "epoch_start=?1",
        Some(&context.epoch),
        &mut budget,
    )?;
    let counter = |name: &str| -> Result<f64> {
        daily
            .as_ref()
            .map_or(Ok(0.0), |daily| numeric(&daily[name]))
    };
    let canary_budget = counter("provider_canary_attempt_count")?
        < numeric(&context.profile["maximumProviderCanaryAttemptsPerUtcDay"])?
        && counter("provider_canary_reserved_cost_usd")?
            < numeric(&context.profile["maximumProviderCanaryCostUsdPerUtcDay"])?;
    let topic_budget =
        counter("produced_topic_count")? < numeric(&context.profile["maximumTopicsPerUtcDay"])?;
    let last_produced = canonical_optional(&metadata["last_produced_at"])?;
    let interval = numeric(&context.profile["minimumGenerationIntervalMs"])?;
    let rate_eligible = last_produced.is_none_or(|time| (context.now - time) as f64 >= interval);
    let retry_eligible =
        canonical_optional(&metadata["next_attempt_at"])?.is_none_or(|time| context.now >= time);
    let latest_fresh = if let Some(latest) = latest {
        if latest.empty_raw {
            // parseGeneration skips this falsy cell, but the original later
            // JSON.parse('') throws an engine message. Keep an explicit profile
            // diagnostic instead of silently claiming there is no capability.
            return Err("autonomous_research_topic_producer_state_json_profile_unsupported".into());
        }
        crate::topic_producer_generation::verify_topic_producer_capability_v1(
            &latest.capability,
            &context.profile,
            &Value::String(context.configuration.clone()),
            &latest.planned["intake"],
            Some(&Value::String(context.now_iso.clone())),
            true,
        )
        .map_err(|error| error.code().to_owned())?
    } else {
        false
    };
    // connection/statements are private snapshot objects and close on return,
    // before the shared helper performs its final original-source observations.
    Ok(
        json!({"ready":clock_monotonic && live,"live":live,"clockMonotonic":clock_monotonic,
        "currentlyProducible":live && canary_budget && topic_budget && rate_eligible && retry_eligible && latest_fresh,
        "providerMutationRequiresNewLiveCanary":true,"latestCapabilityFresh":latest_fresh,
        "canaryBudgetAvailable":canary_budget,"topicBudgetAvailable":topic_budget,
        "rateEligible":rate_eligible,"retryEligible":retry_eligible,"generationHighWatermark":maximum,
        "lastObservedAt":truthy_timestamp(&metadata["last_observed_at"]),"lastProducedAt":truthy_timestamp(&metadata["last_produced_at"]),"nextAttemptAt":truthy_timestamp(&metadata["next_attempt_at"]),
        "blocker":if clock_monotonic && live { Value::Null } else if clock_monotonic { json!("autonomous_research_topic_producer_not_live") } else { json!("autonomous_research_topic_producer_clock_rollback_detected") }}),
    )
}
