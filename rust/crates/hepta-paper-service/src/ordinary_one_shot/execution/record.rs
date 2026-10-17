//! Fixed record builders reuse the existing production canonical JSON/hash and
//! audit owners. Record validity is business data, not provider authorization.
use super::super::{audit, json::*};
use hepta_legacy_compatibility::ProductionJsonValue as Json;
use std::sync::atomic::AtomicBool;

pub(super) const RESERVATION_HASH: &str = "autonomousResearchOneShotCampaignAttemptReservationHash";
pub(super) const EVENT_HASH: &str = "autonomousResearchOneShotCampaignAttemptEventHash";
pub(super) const RECEIPT_HASH: &str = "autonomousResearchOneShotCampaignAttemptTerminalReceiptHash";

fn with_hash(
    mut payload: Json,
    claim: &str,
    kind: &str,
    cancelled: &AtomicBool,
) -> Result<Json, String> {
    let digest = hash(kind, &payload, cancelled)?;
    let Json::Object(fields) = &mut payload else {
        return Err("one_shot_mutation_object_required".into());
    };
    fields.push((claim.encode_utf16().collect(), string(&digest)));
    Ok(payload)
}
pub(super) fn reservation(value: &Json, cancelled: &AtomicBool) -> Result<(), String> {
    canonical_bytes(field(value, "executionBinding"), 64 * 1024, cancelled)?;
    canonical_bytes(value, 128 * 1024, cancelled)?;
    if !audit::reservation(value, cancelled)? {
        return Err("campaign_one_shot_attempt_journal_reservation_invalid".into());
    }
    Ok(())
}
fn bounded_time(time: &str) -> Result<(), String> {
    if time.len() > 32 || instant(&string(time)).is_none() {
        return Err("campaign_one_shot_attempt_journal_clock_invalid".into());
    }
    Ok(())
}
pub(super) fn event(
    reservation: &Json,
    previous: Option<&Json>,
    phase: &str,
    evidence: &Json,
    event_id: Option<&str>,
    recorded_at: &str,
    cancelled: &AtomicBool,
) -> Result<Json, String> {
    bounded_time(recorded_at)?;
    if phase.len() > 32 || audit::phase(&string(phase)).is_none() {
        return Err("campaign_one_shot_attempt_journal_append_invalid".into());
    }
    canonical_bytes(evidence, 128 * 1024, cancelled)?;
    let sequence = previous.map_or(1.0, |v| match field(v, "sequence") {
        Json::Number(v) => v + 1.0,
        _ => f64::NAN,
    });
    if !(1.0..=7.0).contains(&sequence) || sequence.fract() != 0.0 {
        return Err("campaign_one_shot_attempt_journal_event_sequence_invalid".into());
    }
    let reservation_hash = field(reservation, RESERVATION_HASH);
    let generated_id = hash(
        "AutonomousResearchOneShotCampaignAttemptEventId",
        &object([
            ("attemptId", field(reservation, "attemptId").clone()),
            ("phase", string(phase)),
            ("reservationHash", reservation_hash.clone()),
            ("sequence", Json::Number(sequence)),
        ]),
        cancelled,
    )?;
    let id = event_id
        .filter(|id| !id.is_empty())
        .unwrap_or(&generated_id);
    if id.len() > 71 || !sha(&string(id)) {
        return Err("campaign_one_shot_attempt_journal_append_invalid".into());
    }
    let payload = object([
        ("version", Json::Number(1.0)),
        (
            "kind",
            string("AutonomousResearchOneShotCampaignAttemptEvent"),
        ),
        ("attemptId", field(reservation, "attemptId").clone()),
        (
            "idempotencyKey",
            field(reservation, "idempotencyKey").clone(),
        ),
        ("campaignId", field(reservation, "campaignId").clone()),
        ("reservationHash", reservation_hash.clone()),
        ("sequence", Json::Number(sequence)),
        ("eventId", string(id)),
        ("phase", string(phase)),
        (
            "previousEventHash",
            previous.map_or(Json::Null, |v| field(v, EVENT_HASH).clone()),
        ),
        ("evidence", evidence.clone()),
        (
            "evidenceHash",
            if matches!(evidence, Json::Null) {
                Json::Null
            } else {
                string(&hash(
                    "AutonomousResearchOneShotCampaignAttemptEventEvidence",
                    evidence,
                    cancelled,
                )?)
            },
        ),
        ("recordedAt", string(recorded_at)),
    ]);
    let result = with_hash(
        payload,
        EVENT_HASH,
        "AutonomousResearchOneShotCampaignAttemptEvent",
        cancelled,
    )?;
    audit::event(
        &result,
        reservation,
        previous,
        sequence as usize - 1,
        cancelled,
    )?;
    Ok(result)
}
pub(super) fn receipt(
    reservation: &Json,
    previous: &Json,
    status: &str,
    outcome: &Json,
    completed_at: &str,
    cancelled: &AtomicBool,
) -> Result<Json, String> {
    bounded_time(completed_at)?;
    canonical_bytes(outcome, 128 * 1024, cancelled)?;
    if status.len() > 32 {
        return Err("campaign_one_shot_attempt_journal_finalize_invalid".into());
    }
    let stage = audit::phase(field(previous, "phase"))
        .ok_or("campaign_one_shot_attempt_journal_finalize_invalid")?;
    let payload = object([
        ("version", Json::Number(1.0)),
        (
            "kind",
            string("AutonomousResearchOneShotCampaignAttemptTerminalReceipt"),
        ),
        (
            "status",
            string("autonomous_research_one_shot_campaign_attempt_terminal"),
        ),
        ("attemptId", field(reservation, "attemptId").clone()),
        (
            "idempotencyKey",
            field(reservation, "idempotencyKey").clone(),
        ),
        ("campaignId", field(reservation, "campaignId").clone()),
        (
            "reservationHash",
            field(reservation, RESERVATION_HASH).clone(),
        ),
        ("terminalStatus", string(status)),
        ("lastPhase", field(previous, "phase").clone()),
        ("lastEventHash", field(previous, EVENT_HASH).clone()),
        ("outcome", outcome.clone()),
        (
            "outcomeHash",
            if matches!(outcome, Json::Null) {
                Json::Null
            } else {
                string(&hash(
                    "AutonomousResearchOneShotCampaignAttemptTerminalOutcome",
                    outcome,
                    cancelled,
                )?)
            },
        ),
        ("providerMayHaveStarted", Json::Bool(stage >= 3)),
        ("providerCompleted", Json::Bool(stage >= 4)),
        ("launchMayHaveStarted", Json::Bool(stage >= 5)),
        ("completedAt", string(completed_at)),
    ]);
    let result = with_hash(
        payload,
        RECEIPT_HASH,
        "AutonomousResearchOneShotCampaignAttemptTerminalReceipt",
        cancelled,
    )?;
    audit::terminal(&result, reservation, previous, cancelled)?;
    Ok(result)
}
