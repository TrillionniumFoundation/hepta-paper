use super::{Error, Result, ensure, files, json::*, sqlite};
use serde_json::Value;
use std::path::Path;

const RELATIVE: &str = "autonomous-research/qualification/external-qualification-state.sqlite";
const TABLE: &str = "autonomous_external_qualification_state";
const DATABASE_INVALID: &str = "autonomous_research_external_qualification_database_invalid";
const INVALID: &str = "autonomous_research_external_qualification_state_invalid";
const FILE_INVALID: &str = "autonomous_research_external_qualification_state_file_invalid";
const FENCE_INVALID: &str = "autonomous_research_external_qualification_state_fence_invalid";
const MAXIMUM_STATE_BYTES: usize = 2 * 1024 * 1024;
const STATE_KEYS: &[&str] = &[
    "version",
    "kind",
    "generation",
    "campaignId",
    "paperId",
    "campaignReleaseBundleHash",
    "receipt",
    "verifiedInspection",
    "recovery",
    "autonomousExternalQualificationStateHash",
];
const RECOVERY_KEYS: &[&str] = &[
    "status",
    "recoveryIdentityHash",
    "recoveryConfigurationIdentityHash",
    "retryPolicyIdentityHash",
    "configurationIdentityHash",
    "trustIdentityHash",
    "clientServiceIdentityHash",
    "verifierServiceIdentityHash",
    "terminalFailure",
    "cycle",
    "epoch",
    "maximumEpochs",
    "attemptCount",
    "maximumAttempts",
    "totalAttemptCount",
    "maximumTotalAttempts",
    "firstAttemptAt",
    "nextAttemptAt",
    "deadlineAt",
    "globalFirstAttemptAt",
    "globalDeadlineAt",
];
const COST_KEYS: &[&str] = &[
    "maximumTotalCostUsd",
    "reservedCostUsd",
    "attemptReservationCostUsd",
];

/// Read one original V4 stored state through an owned effective SQLite snapshot.
/// This validates its data hash and recorded bindings, not receipt signatures,
/// current qualification or permission to retry. No legacy JSON fallback is used.
/// Call before acquiring caller-owned business SQLite or database descriptors.
pub fn read_autonomous_external_qualification_state_v1(
    runtime_root: &Path,
    paper_id: &str,
) -> Result<Option<Value>> {
    ensure(
        !runtime_root.as_os_str().is_empty() && id(&Value::String(paper_id.to_owned()), 160, false),
        "autonomous_research_qualification_state_repository_scope_invalid",
    )?;
    let runtime_root = files::absolute(runtime_root)?;
    if !files::database_exists(&runtime_root.join(RELATIVE), DATABASE_INVALID)? {
        return Ok(None);
    }
    crate::state_database_inventory::with_database_effective_snapshot_path_v1(
        &runtime_root,
        Path::new(RELATIVE),
        "external-qualification",
        |path| read_snapshot(path, paper_id).map_err(|error| error.code),
    )
    .map_err(|error| Error::new(error.code))
}

fn read_snapshot(path: &Path, paper_id: &str) -> Result<Option<Value>> {
    let connection = sqlite::open(path, MAXIMUM_STATE_BYTES, DATABASE_INVALID)?;
    sqlite::table(
        &connection,
        TABLE,
        &["scope", "generation", "state_hash", "state_json"],
        DATABASE_INVALID,
    )?;
    let scope = format!("paper:{paper_id}");
    let mut statement = connection.prepare(
        "SELECT generation,state_hash,CASE WHEN typeof(state_json)='text' AND length(CAST(state_json AS BLOB)) BETWEEN 2 AND 2097152 THEN state_json END FROM autonomous_external_qualification_state WHERE scope=?1 LIMIT 2"
    ).map_err(|_| Error::new(DATABASE_INVALID))?;
    let mut rows = statement
        .query([scope])
        .map_err(|_| Error::new(DATABASE_INVALID))?;
    let Some(row) = rows.next().map_err(|_| Error::new(DATABASE_INVALID))? else {
        return Ok(None);
    };
    let raw = sqlite::text(row, 2, MAXIMUM_STATE_BYTES, FILE_INVALID)?;
    let document = Document::parse(
        raw.as_bytes(),
        "autonomous_research_external_qualification_state_json_invalid",
    )?;
    validate(&document)?;
    let generation = sqlite::integer(row, 0, FENCE_INVALID)?;
    let stored_hash = sqlite::text(row, 1, 256, FENCE_INVALID)?;
    ensure(
        document.value["paperId"].as_str() == Some(paper_id)
            && document.value["generation"].as_f64() == Some(generation as f64)
            && document.value["autonomousExternalQualificationStateHash"].as_str()
                == Some(&stored_hash),
        FENCE_INVALID,
    )?;
    ensure(
        rows.next()
            .map_err(|_| Error::new(DATABASE_INVALID))?
            .is_none(),
        FENCE_INVALID,
    )?;
    Ok(Some(document.value))
}

fn validate(document: &Document) -> Result<()> {
    let value = &document.value;
    ensure(
        exact(value, STATE_KEYS)
            && value["version"].as_f64() == Some(4.0)
            && value["kind"] == "AutonomousExternalQualificationState"
            && counter(&value["generation"], 1.0, 1_000_000.0)
            && id(&value["campaignId"], 256, true)
            && id(&value["paperId"], 256, true)
            && hash_like(&value["campaignReleaseBundleHash"])
            && valid_recovery(&value["recovery"])
            && evidence_bound(value),
        INVALID,
    )?;
    ensure(
        hash_like(&value["autonomousExternalQualificationStateHash"])
            && document.own_hash(
                "AutonomousExternalQualificationState",
                "autonomousExternalQualificationStateHash",
            )?,
        "autonomous_research_external_qualification_state_hash_invalid",
    )
}

fn timestamp(value: &Value) -> Option<i64> {
    canonical_time(value).filter(|time| (946_684_800_000..=4_102_444_800_000).contains(time))
}

fn valid_recovery(value: &Value) -> bool {
    let extended = value
        .as_object()
        .is_some_and(|object| object.contains_key("maximumTotalCostUsd"));
    let mut keys = RECOVERY_KEYS.to_vec();
    if extended {
        keys.extend(COST_KEYS);
    }
    if !exact(value, &keys)
        || ![
            "qualification_retry_scheduled",
            "qualification_attempt_in_progress",
            "qualification_epoch_cooldown",
            "qualification_recovery_budget_exhausted",
            "qualification_terminal_blocked",
            "qualification_verified",
        ]
        .iter()
        .any(|status| value["status"] == *status)
        || ![
            "recoveryIdentityHash",
            "recoveryConfigurationIdentityHash",
            "retryPolicyIdentityHash",
            "configurationIdentityHash",
            "trustIdentityHash",
            "clientServiceIdentityHash",
            "verifierServiceIdentityHash",
        ]
        .iter()
        .all(|field| hash_like(&value[*field]))
        || !terminal_failure(
            &value["terminalFailure"],
            &value["recoveryConfigurationIdentityHash"],
        )
        || ![
            "cycle",
            "epoch",
            "maximumEpochs",
            "maximumAttempts",
            "maximumTotalAttempts",
        ]
        .iter()
        .all(|field| counter(&value[*field], 1.0, 1_000_000.0))
        || !["attemptCount", "totalAttemptCount"]
            .iter()
            .all(|field| counter(&value[*field], 0.0, 1_000_000.0))
        || !ordered_number(&value["epoch"], &value["maximumEpochs"])
        || !ordered_number(&value["attemptCount"], &value["maximumAttempts"])
        || !ordered_number(&value["totalAttemptCount"], &value["maximumTotalAttempts"])
    {
        return false;
    }
    if extended {
        let valid = match (
            value["maximumTotalCostUsd"].as_f64(),
            value["reservedCostUsd"].as_f64(),
            value["attemptReservationCostUsd"].as_f64(),
        ) {
            (Some(maximum), Some(reserved), Some(attempt)) => {
                maximum.is_finite()
                    && maximum > 0.0
                    && reserved.is_finite()
                    && reserved >= 0.0
                    && reserved <= maximum
                    && attempt.is_finite()
                    && attempt > 0.0
                    && attempt <= maximum
            }
            _ => false,
        };
        if !valid {
            return false;
        }
    }
    let first = timestamp(&value["firstAttemptAt"]);
    let deadline = timestamp(&value["deadlineAt"]);
    let global_first = timestamp(&value["globalFirstAttemptAt"]);
    let global_deadline = timestamp(&value["globalDeadlineAt"]);
    // Deliberate original diagnostic compatibility: invalid nonnull next times
    // also become None here. The original JSON field is never rewritten.
    let next = timestamp(&value["nextAttemptAt"]);
    match (first, deadline, global_first, global_deadline) {
        (Some(first), Some(deadline), Some(global_first), Some(global_deadline)) => {
            first >= global_first
                && deadline >= first
                && deadline <= global_deadline
                && global_deadline >= global_first
                && next.is_none_or(|next| next >= first)
        }
        _ => false,
    }
}

fn ordered_number(left: &Value, right: &Value) -> bool {
    matches!((left.as_f64(), right.as_f64()), (Some(left), Some(right)) if left <= right)
}

fn terminal_failure(value: &Value, identity: &Value) -> bool {
    value.is_null()
        || (exact(
            value,
            &[
                "failureCodes",
                "rejectedReceiptHash",
                "recoveryConfigurationIdentityHash",
            ],
        ) && value["failureCodes"].as_array().is_some_and(|codes| {
            (1..=64).contains(&codes.len())
                && codes.iter().all(|code| {
                    code.as_str()
                        .is_some_and(|code| code.encode_utf16().count() <= 256)
                })
        }) && (value["rejectedReceiptHash"].is_null()
            || hash_like(&value["rejectedReceiptHash"]))
            && strict_equal(&value["recoveryConfigurationIdentityHash"], identity))
}

fn evidence_bound(value: &Value) -> bool {
    let recovery = &value["recovery"];
    if recovery["status"] != "qualification_verified" {
        return value["receipt"].is_null() && value["verifiedInspection"].is_null();
    }
    let inspection = &value["verifiedInspection"];
    value["receipt"].is_object()
        && inspection.is_object()
        && inspection["kind"] == "FullResearchQualificationInspection"
        && inspection["ready"] == true
        && inspection["receiptAccepted"] == true
        && ["campaignId", "paperId", "campaignReleaseBundleHash"]
            .iter()
            .all(|field| strict_equal(&inspection[*field], &value[*field]))
        && [
            "configurationIdentityHash",
            "trustIdentityHash",
            "clientServiceIdentityHash",
            "verifierServiceIdentityHash",
        ]
        .iter()
        .all(|field| strict_equal(&inspection[*field], &recovery[*field]))
        && timestamp(&value["receipt"]["expiresAt"]).is_some()
}
