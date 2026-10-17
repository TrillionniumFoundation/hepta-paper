//! Actual incumbent business row projections; workflow journals have a separate
//! schema and are not substituted for these campaign tables.
use super::json::{
    column, field as f, hash, nullable, nullish_number, number, object, or_number, same_scalar,
    string, truthy, without,
};
use hepta_legacy_compatibility::ProductionJsonValue as Json;
use std::sync::atomic::AtomicBool;

pub(super) fn campaign(row: &Json) -> Result<Json, String> {
    if matches!(row, Json::Null) {
        return Ok(Json::Null);
    }
    let calls = or_number(f(row, "agent_call_count"), 0.0)?;
    let priced = or_number(f(row, "priced_agent_call_count"), 0.0)?;
    let known = number(&calls)? == number(&priced)?;
    let round = if matches!(f(row, "current_review_round"), Json::Null) {
        f(row, "current_round")
    } else {
        f(row, "current_review_round")
    };
    let phase = if truthy(f(row, "current_phase")) {
        f(row, "current_phase").clone()
    } else if truthy(f(row, "status")) {
        f(row, "status").clone()
    } else {
        string("queued")
    };
    Ok(object([
        ("campaignId", f(row, "campaign_id").clone()),
        ("paperId", f(row, "paper_id").clone()),
        ("status", f(row, "status").clone()),
        ("revision", or_number(f(row, "revision"), 1.0)?),
        ("currentRound", nullish_number(round, 0.0)?),
        ("currentReviewRound", nullish_number(round, 0.0)?),
        ("currentPhase", phase),
        ("maxRounds", or_number(f(row, "max_rounds"), 1.0)?),
        (
            "accumulatedRunMs",
            or_number(f(row, "accumulated_run_ms"), 0.0)?,
        ),
        ("agentCallCount", calls),
        ("cpuJobCount", or_number(f(row, "cpu_job_count"), 0.0)?),
        ("gpuJobCount", or_number(f(row, "gpu_job_count"), 0.0)?),
        ("tokenCount", or_number(f(row, "token_count"), 0.0)?),
        ("pricedAgentCallCount", priced),
        ("costKnown", Json::Bool(known)),
        (
            "costUsd",
            if known {
                or_number(f(row, "cost_usd"), 0.0)?
            } else {
                Json::Null
            },
        ),
        ("parentCampaignId", nullable(f(row, "parent_campaign_id"))),
        (
            "supersedesCampaignId",
            nullable(f(row, "supersedes_campaign_id")),
        ),
        (
            "recoveryOfCampaignId",
            nullable(f(row, "recovery_of_campaign_id")),
        ),
        (
            "effectiveStatus",
            if truthy(f(row, "effective_status")) {
                f(row, "effective_status").clone()
            } else {
                f(row, "status").clone()
            },
        ),
        (
            "spec",
            column(
                f(row, "spec_json"),
                Json::Object(Vec::new()),
                "campaign_row_json_invalid",
            )?,
        ),
        ("stopReason", nullable(f(row, "stop_reason"))),
        ("lastResumedAt", nullable(f(row, "last_resumed_at"))),
        ("createdAt", nullable(f(row, "created_at"))),
        ("updatedAt", nullable(f(row, "updated_at"))),
    ]))
}
pub(super) fn node(row: &Json, cancelled: &AtomicBool) -> Result<Json, String> {
    let prepared = column(
        f(row, "prepared_result_json"),
        Json::Null,
        "campaign_prepared_result_json_invalid",
    )?;
    let prepared_hash = nullable(f(row, "prepared_result_sha256"));
    if !matches!(f(row, "prepared_result_json"), Json::Null)
        && !same_scalar(
            &string(&hash("PaperCampaignNodeResult", &prepared, cancelled)?),
            &prepared_hash,
        )
    {
        return Err("campaign_prepared_result_hash_invalid".into());
    }
    let required = truthy(&or_number(f(row, "prepared_requires_integration"), 0.0)?);
    let integration = nullable(f(row, "prepared_integration_key"));
    let descriptor = f(
        f(&prepared, "workspaceAttemptIntegration"),
        "workspaceAttemptIntegrationDescriptorHash",
    );
    if required && (!truthy(descriptor) || !same_scalar(descriptor, &integration)) {
        return Err("campaign_prepared_integration_binding_invalid".into());
    }
    let receipt = column(
        f(row, "prepared_integration_receipt_json"),
        Json::Null,
        "campaign_prepared_integration_receipt_json_invalid",
    )?;
    let receipt_hash = nullable(f(row, "prepared_integration_receipt_sha256"));
    if !matches!(f(row, "prepared_integration_receipt_json"), Json::Null) {
        let claimed = f(&receipt, "workspaceAttemptIntegrationReceiptHash");
        if !truthy(claimed)
            || !same_scalar(claimed, &receipt_hash)
            || !same_scalar(
                &string(&hash(
                    "WorkspaceAttemptIntegrationReceipt",
                    &without(&receipt, "workspaceAttemptIntegrationReceiptHash"),
                    cancelled,
                )?),
                claimed,
            )
            || !same_scalar(f(&receipt, "descriptorHash"), &integration)
        {
            return Err("campaign_prepared_integration_receipt_invalid".into());
        }
    }
    Ok(object([
        ("nodeId", f(row, "node_id").clone()),
        ("campaignId", f(row, "campaign_id").clone()),
        ("kind", f(row, "kind").clone()),
        ("status", f(row, "status").clone()),
        ("priority", or_number(f(row, "priority"), 100.0)?),
        ("roundIndex", or_number(f(row, "round_index"), 0.0)?),
        ("attemptCount", or_number(f(row, "attempt_count"), 0.0)?),
        ("maxAttempts", or_number(f(row, "max_attempts"), 3.0)?),
        ("attemptId", nullable(f(row, "attempt_id"))),
        (
            "leaseGeneration",
            or_number(f(row, "lease_generation"), 0.0)?,
        ),
        ("nodeRevision", or_number(f(row, "node_revision"), 0.0)?),
        ("role", nullable(f(row, "role"))),
        ("reviewerId", nullable(f(row, "reviewer_id"))),
        ("childSessionId", nullable(f(row, "child_session_id"))),
        ("reviewHash", nullable(f(row, "review_hash"))),
        ("promptHash", nullable(f(row, "prompt_hash"))),
        ("resolvedModel", nullable(f(row, "resolved_model"))),
        (
            "dependencies",
            column(
                f(row, "dependencies_json"),
                Json::Array(Vec::new()),
                "campaign_row_json_invalid",
            )?,
        ),
        (
            "spec",
            column(
                f(row, "spec_json"),
                Json::Object(Vec::new()),
                "campaign_row_json_invalid",
            )?,
        ),
        (
            "result",
            column(
                f(row, "result_json"),
                Json::Null,
                "campaign_row_json_invalid",
            )?,
        ),
        ("preparedResult", prepared),
        ("preparedResultHash", prepared_hash),
        ("preparedAttemptId", nullable(f(row, "prepared_attempt_id"))),
        ("preparedAt", nullable(f(row, "prepared_at"))),
        ("preparedRequiresIntegration", Json::Bool(required)),
        ("preparedIntegrationKey", integration),
        (
            "preparedIntegrationStatus",
            if truthy(f(row, "prepared_integration_status")) {
                f(row, "prepared_integration_status").clone()
            } else {
                string(if required { "pending" } else { "none" })
            },
        ),
        (
            "preparedIntegrationStartedAt",
            nullable(f(row, "prepared_integration_started_at")),
        ),
        ("preparedIntegrationReceipt", receipt),
        ("preparedIntegrationReceiptHash", receipt_hash),
        (
            "preparedIntegratedAt",
            nullable(f(row, "prepared_integrated_at")),
        ),
        ("integratedAt", nullable(f(row, "integrated_at"))),
        (
            "failureDetail",
            column(
                f(row, "failure_json"),
                Json::Null,
                "campaign_row_json_invalid",
            )?,
        ),
        ("leaseOwner", nullable(f(row, "lease_owner"))),
        ("leaseExpiresAt", nullable(f(row, "lease_expires_at"))),
        ("resultSha256", nullable(f(row, "result_sha256"))),
        ("failureClass", nullable(f(row, "failure_class"))),
        ("failureSha256", nullable(f(row, "failure_sha256"))),
        ("createdAt", nullable(f(row, "created_at"))),
        ("updatedAt", nullable(f(row, "updated_at"))),
    ]))
}
pub(super) fn event(row: &Json) -> Result<Json, String> {
    Ok(object([
        ("eventId", f(row, "event_id").clone()),
        ("campaignId", f(row, "campaign_id").clone()),
        ("nodeId", nullable(f(row, "node_id"))),
        ("kind", f(row, "kind").clone()),
        (
            "event",
            column(
                f(row, "event_json"),
                Json::Null,
                "campaign_row_json_invalid",
            )?,
        ),
        ("eventSha256", f(row, "event_sha256").clone()),
        ("createdAt", f(row, "created_at").clone()),
    ]))
}
