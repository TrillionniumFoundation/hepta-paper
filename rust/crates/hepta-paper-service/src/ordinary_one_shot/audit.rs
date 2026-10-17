//! Read-only chain audit. Dispositions describe the original journal; none
//! returns the incumbent journal's private WeakMap action permits.
use super::{binding::execution_binding, contract::contract, json::*};
use hepta_legacy_compatibility::ProductionJsonValue as Json;
use std::sync::atomic::AtomicBool;
const PHASES: &[&str] = &[
    "attempt_reserved",
    "preconditions_verified",
    "prepare_verified",
    "provider_started",
    "provider_completed",
    "launch_started",
    "terminal",
];
const STATUSES: &[&str] = &[
    "blocked_pre_provider",
    "blocked_post_provider",
    "completed",
    "failed_terminal",
    "recovered_incomplete",
];
pub(super) fn phase(value: &Json) -> Option<usize> {
    PHASES.iter().position(|p| is_text(value, p))
}
fn self_hash(
    value: &Json,
    claim: &str,
    kind: &str,
    cancelled: &AtomicBool,
) -> Result<bool, String> {
    let payload = without(value, claim)?;
    Ok(is_text(
        field(value, claim),
        &hash(kind, &payload, cancelled)?,
    ))
}
pub(super) fn reservation(value: &Json, cancelled: &AtomicBool) -> Result<bool, String> {
    let invalid = "campaign_one_shot_attempt_journal_reservation_invalid";
    let c = contract()?;
    if !exact_data(value, &c["reservationKeys"])
        || !number(field(value, "version"), 1.0)
        || !is_text(
            field(value, "kind"),
            "AutonomousResearchOneShotCampaignAttemptReservation",
        )
        || !is_text(field(value, "status"), "attempt_reserved")
        || !["attemptId", "campaignId", "protectedCampaignId"]
            .iter()
            .all(|k| safe_id(field(value, k)))
        || !sha(field(value, "idempotencyKey"))
        || !sha(field(value, "executionBindingHash"))
        || scalar_eq(
            field(value, "campaignId"),
            field(value, "protectedCampaignId"),
        )
        || instant(field(value, "reservedAt")).is_none()
    {
        return Err(invalid.into());
    }
    let binding = field(value, "executionBinding");
    let current = execution_binding(binding, cancelled)?.ok_or(invalid)?;
    if !scalar_eq(
        field(field(binding, "targetCampaignDefinition"), "campaignId"),
        field(value, "campaignId"),
    ) || !scalar_eq(
        field(field(binding, "protectedCampaignDefinition"), "campaignId"),
        field(value, "protectedCampaignId"),
    ) || !is_text(
        field(value, "executionBindingHash"),
        &hash(
            "AutonomousResearchOneShotCampaignExecutionBinding",
            binding,
            cancelled,
        )?,
    ) || !self_hash(
        value,
        "autonomousResearchOneShotCampaignAttemptReservationHash",
        "AutonomousResearchOneShotCampaignAttemptReservation",
        cancelled,
    )? {
        return Err(invalid.into());
    }
    Ok(current)
}
pub(super) fn event(
    value: &Json,
    reservation: &Json,
    previous: Option<&Json>,
    index: usize,
    cancelled: &AtomicBool,
) -> Result<(), String> {
    let invalid = "campaign_one_shot_attempt_journal_event_invalid";
    let c = contract()?;
    let Some(stage) = phase(field(value, "phase")) else {
        return Err(invalid.into());
    };
    if !exact_data(value, &c["eventKeys"])
        || !number(field(value, "version"), 1.0)
        || !is_text(
            field(value, "kind"),
            "AutonomousResearchOneShotCampaignAttemptEvent",
        )
        || !number(field(value, "sequence"), (index + 1) as f64)
        || !safe_id(field(value, "attemptId"))
        || !safe_id(field(value, "campaignId"))
        || !["idempotencyKey", "reservationHash", "eventId"]
            .iter()
            .all(|k| sha(field(value, k)))
        || !(matches!(field(value, "previousEventHash"), Json::Null)
            || sha(field(value, "previousEventHash")))
        || !(matches!(field(value, "evidenceHash"), Json::Null)
            || sha(field(value, "evidenceHash")))
        || instant(field(value, "recordedAt")).is_none()
    {
        return Err(invalid.into());
    }
    for key in ["attemptId", "idempotencyKey", "campaignId"] {
        if !scalar_eq(field(value, key), field(reservation, key)) {
            return Err(invalid.into());
        }
    }
    if !scalar_eq(
        field(value, "reservationHash"),
        field(
            reservation,
            "autonomousResearchOneShotCampaignAttemptReservationHash",
        ),
    ) {
        return Err(invalid.into());
    }
    let evidence = field(value, "evidence");
    canonical_bytes(evidence, 128 * 1024, cancelled).map_err(|_| invalid.to_owned())?;
    if if matches!(evidence, Json::Null) {
        !matches!(field(value, "evidenceHash"), Json::Null)
    } else {
        !is_text(
            field(value, "evidenceHash"),
            &hash(
                "AutonomousResearchOneShotCampaignAttemptEventEvidence",
                evidence,
                cancelled,
            )?,
        )
    } {
        return Err(invalid.into());
    }
    match previous {
        None => {
            if stage != 0
                || !matches!(field(value, "previousEventHash"), Json::Null)
                || !same_json(
                    evidence,
                    &object([(
                        "reservationHash",
                        field(
                            reservation,
                            "autonomousResearchOneShotCampaignAttemptReservationHash",
                        )
                        .clone(),
                    )]),
                    cancelled,
                )
            {
                return Err(invalid.into());
            }
        }
        Some(previous) => {
            let prior = phase(field(previous, "phase")).ok_or(invalid)?;
            if prior == 6
                || (stage != 6 && stage != prior + 1)
                || instant(field(value, "recordedAt")) < instant(field(previous, "recordedAt"))
                || !scalar_eq(
                    field(value, "previousEventHash"),
                    field(
                        previous,
                        "autonomousResearchOneShotCampaignAttemptEventHash",
                    ),
                )
            {
                return Err(invalid.into());
            }
        }
    }
    if !self_hash(
        value,
        "autonomousResearchOneShotCampaignAttemptEventHash",
        "AutonomousResearchOneShotCampaignAttemptEvent",
        cancelled,
    )? {
        return Err(invalid.into());
    }
    Ok(())
}
pub(super) fn terminal(
    value: &Json,
    reservation: &Json,
    previous: &Json,
    cancelled: &AtomicBool,
) -> Result<(), String> {
    let invalid = "campaign_one_shot_attempt_journal_terminal_receipt_invalid";
    let c = contract()?;
    let stage = phase(field(value, "lastPhase"))
        .filter(|s| *s < 6)
        .ok_or(invalid)?;
    let status = text(field(value, "terminalStatus")).ok_or(invalid)?;
    if !exact_data(value, &c["receiptKeys"])
        || !number(field(value, "version"), 1.0)
        || !is_text(
            field(value, "kind"),
            "AutonomousResearchOneShotCampaignAttemptTerminalReceipt",
        )
        || !is_text(
            field(value, "status"),
            "autonomous_research_one_shot_campaign_attempt_terminal",
        )
        || !STATUSES.contains(&status.as_str())
        || !["attemptId", "campaignId"]
            .iter()
            .all(|k| safe_id(field(value, k)))
        || !["idempotencyKey", "reservationHash", "lastEventHash"]
            .iter()
            .all(|k| sha(field(value, k)))
        || instant(field(value, "completedAt")).is_none()
        || !(matches!(field(value, "outcomeHash"), Json::Null) || sha(field(value, "outcomeHash")))
        || !boolean(field(value, "providerMayHaveStarted"), stage >= 3)
        || !boolean(field(value, "providerCompleted"), stage >= 4)
        || !boolean(field(value, "launchMayHaveStarted"), stage >= 5)
    {
        return Err(invalid.into());
    }
    if (stage == 3 && status != "recovered_incomplete")
        || (status == "recovered_incomplete" && !matches!(stage, 3 | 5))
        || (status == "blocked_pre_provider" && stage >= 3)
        || (status == "blocked_post_provider" && stage != 4)
        || (matches!(status.as_str(), "completed" | "failed_terminal") && stage != 5)
    {
        return Err(invalid.into());
    }
    for key in ["attemptId", "idempotencyKey", "campaignId"] {
        if !scalar_eq(field(value, key), field(reservation, key)) {
            return Err(invalid.into());
        }
    }
    if !scalar_eq(
        field(value, "reservationHash"),
        field(
            reservation,
            "autonomousResearchOneShotCampaignAttemptReservationHash",
        ),
    ) || !scalar_eq(field(value, "lastPhase"), field(previous, "phase"))
        || !scalar_eq(
            field(value, "lastEventHash"),
            field(
                previous,
                "autonomousResearchOneShotCampaignAttemptEventHash",
            ),
        )
        || instant(field(value, "completedAt")) < instant(field(previous, "recordedAt"))
    {
        return Err(invalid.into());
    }
    let outcome = field(value, "outcome");
    canonical_bytes(outcome, 128 * 1024, cancelled).map_err(|_| invalid.to_owned())?;
    if if matches!(outcome, Json::Null) {
        !matches!(field(value, "outcomeHash"), Json::Null)
    } else {
        !is_text(
            field(value, "outcomeHash"),
            &hash(
                "AutonomousResearchOneShotCampaignAttemptTerminalOutcome",
                outcome,
                cancelled,
            )?,
        )
    } {
        return Err(invalid.into());
    }
    if !self_hash(
        value,
        "autonomousResearchOneShotCampaignAttemptTerminalReceiptHash",
        "AutonomousResearchOneShotCampaignAttemptTerminalReceipt",
        cancelled,
    )? {
        return Err(invalid.into());
    }
    Ok(())
}
fn historical_anchor(
    reservation: &Json,
    events: &[Json],
    terminal: &Json,
    cancelled: &AtomicBool,
) -> Result<bool, String> {
    let c = contract()?;
    let campaign = text(field(reservation, "campaignId"))
        .ok_or("autonomous_research_one_shot_historical_attempt_anchor_invalid")?;
    let anchor = &c["historicalAnchors"][&campaign];
    let Some(head) = events.last() else {
        return Ok(false);
    };
    if anchor.is_null() || anchor["headSequence"].as_u64() != Some(events.len() as u64) {
        return Ok(false);
    }
    for (key, expected) in [
        ("attemptId", "attemptId"),
        ("idempotencyKey", "idempotencyKey"),
        (
            "autonomousResearchOneShotCampaignAttemptReservationHash",
            "reservationHash",
        ),
    ] {
        if !anchor[expected]
            .as_str()
            .is_some_and(|text| is_text(field(reservation, key), text))
        {
            return Ok(false);
        }
    }
    let chain = object([
        ("version", Json::Number(1.0)),
        ("campaignId", field(reservation, "campaignId").clone()),
        (
            "eventHashes",
            Json::Array(
                events
                    .iter()
                    .map(|event| {
                        field(event, "autonomousResearchOneShotCampaignAttemptEventHash").clone()
                    })
                    .collect(),
            ),
        ),
    ]);
    Ok(anchor["headEventHash"].as_str().is_some_and(|expected| {
        is_text(
            field(head, "autonomousResearchOneShotCampaignAttemptEventHash"),
            expected,
        )
    }) && anchor["terminalReceiptHash"]
        .as_str()
        .is_some_and(|expected| {
            is_text(
                field(
                    terminal,
                    "autonomousResearchOneShotCampaignAttemptTerminalReceiptHash",
                ),
                expected,
            )
        })
        && anchor["eventChainHash"].as_str()
            == Some(
                hash(
                    "AutonomousResearchOneShotHistoricalCampaignAttemptEventChain",
                    &chain,
                    cancelled,
                )?
                .as_str(),
            ))
}
pub(super) fn disposition(
    reservation: &Json,
    events: &[Json],
    terminal: Json,
    current: bool,
    cancelled: &AtomicBool,
) -> Result<Json, String> {
    let head = events
        .last()
        .ok_or("campaign_one_shot_attempt_journal_event_sequence_invalid")?;
    let stage = phase(field(head, "phase"))
        .ok_or("campaign_one_shot_attempt_journal_event_sequence_invalid")?;
    if !current && !historical_anchor(reservation, events, &terminal, cancelled)? {
        return Err("autonomous_research_one_shot_historical_attempt_anchor_invalid".into());
    }
    let (status, provider, launch, monitor) = match stage {
        0 => ("resume_preconditions", false, false, false),
        1 => ("resume_prepare", false, false, false),
        2 => ("provider_marker_append_permitted", true, false, false),
        3 => ("provider_outcome_unknown_no_replay", false, false, false),
        4 => ("launch_marker_append_permitted", false, true, false),
        5 => ("launch_outcome_unknown_monitor_only", false, false, true),
        6 => ("terminal_replay", false, false, false),
        _ => return Err("campaign_one_shot_attempt_journal_event_sequence_invalid".into()),
    };
    Ok(object([
        (
            "status",
            string(if current {
                status
            } else {
                "historical_audit_only"
            }),
        ),
        ("headPhase", field(head, "phase").clone()),
        ("mayAppendProviderStarted", Json::Bool(current && provider)),
        ("mayAppendLaunchStarted", Json::Bool(current && launch)),
        ("monitorOnly", Json::Bool(current && monitor)),
        ("terminalReceipt", terminal),
    ]))
}
