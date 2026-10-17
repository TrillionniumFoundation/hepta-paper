//! Delivery records for a local lifecycle that has no external authority input.
use super::workflow::LocalSubmissionChainV1;
use super::*;
fn local_submission_dispatch(
    chain: &LocalSubmissionChainV1<'_>,
    preflight: &Value,
    controlled: &Value,
    reviewed: &Value,
    artifact: &Value,
) -> Result<Value, String> {
    let mut blockers = Vec::new();
    if !local_submission_truthy(&chain.input.paper_task["taskKey"]) {
        blockers.push("paper_task_required");
    }
    if chain.outbox["status"] != "queued_for_dry_run_executor" {
        blockers.push("executor_outbox_not_ready");
    }
    if chain.replay["status"] != "dry_run_replay_allowed" {
        blockers.push("replay_guard_not_ready");
    }
    if !chain.replay["replayKey"].as_str().is_some_and(|s| {
        s.len() == 71 && s.starts_with("sha256:") && s[7..].bytes().all(|b| b.is_ascii_hexdigit())
    }) {
        blockers.push("persistent_replay_key_missing");
    }
    if preflight["status"] != "reviewed_submit_preflight_ready_for_external_executor" {
        blockers.push("reviewed_submit_preflight_not_ready");
    }
    if controlled["status"] != "controlled_external_executor_receipt_recorded" {
        blockers.push("controlled_executor_boundary_not_ready");
    }
    if !local_submission_truthy(&controlled["executorId"])
        || !local_submission_truthy(&controlled["executorDescriptorHash"])
        || !local_submission_truthy(&controlled["executorCapabilitiesHash"])
    {
        blockers.push("controlled_executor_identity_not_bound");
    }
    // Optional chaining distinguishes absent (undefined) authority from an
    // explicit null field in a computed controlled or reviewed record.
    if !controlled.is_null() {
        blockers.push("live_authorization_executor_descriptor_mismatch");
    }
    blockers.extend([
        "live_submission_authorization_not_verified",
        "live_authorization_artifact_package_mismatch",
        "reviewed_submission_decision_not_verified",
    ]);
    let expected_hashes = artifact["artifacts"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|a| a["hash"].as_str())
                .collect::<BTreeSet<_>>()
        })
        .unwrap_or_default();
    if artifact["submitReady"] != true
        || !local_submission_truthy(&artifact["artifactPackageHash"])
        || expected_hashes.is_empty()
    {
        let position = blockers
            .iter()
            .position(|s| *s == "live_submission_authorization_not_verified")
            .ok_or_else(local_submission_error)?
            + 1;
        blockers.insert(position, "submit_ready_artifact_package_not_bound");
    }
    if reviewed["status"] != "reviewed_venue_evidence_verified" {
        blockers.push("reviewed_venue_evidence_not_verified");
    }
    if !reviewed.is_null() {
        blockers.extend([
            "live_authorization_reviewed_venue_evidence_mismatch",
            "live_authorization_venue_source_receipt_mismatch",
        ]);
    }
    blockers.extend([
        "provider_capability_not_verified",
        "provider_capability_principal_mismatch",
    ]);
    if !reviewed.is_null() {
        blockers.push("provider_capability_portal_route_mismatch");
    }
    blockers.push("executor_response_due_at_invalid");
    let action_scope = local_submission_kernel_hash(
        "SubmissionActionScopeKey",
        &json!({"paperId":chain.input.paper_task["paperId"],"action":"reviewed_submit","artifactPackageHash":artifact["artifactPackageHash"],"reviewedSubmissionDecisionPacketHash":null,"venueTarget":null,"provider":null,"accountId":null,"portalRoute":null,"providerCapabilityVerificationReceiptHash":null}),
    )?;
    let cycle = local_submission_kernel_hash(
        "SubmissionDispatchCycle",
        &json!({"paperId":chain.input.paper_task["paperId"],"replayKey":chain.replay["replayKey"],"nonce":null,"liveAuthorizationHash":null,"priorDispatchAuthorizationHash":null,"attempt":1}),
    )?;
    local_submission_hashed(
        json!({"version":1,"kind":"SubmissionDispatchAuthorization","paperId":chain.input.paper_task["paperId"],"taskKey":chain.input.paper_task["taskKey"],"status":if blockers.is_empty(){"submission_dispatch_authorization_ready"}else{"submission_dispatch_authorization_blocked"},"outboxHash":chain.outbox["externalExecutorHandoffOutboxHash"],"replayGuardHash":chain.replay["submissionReplayGuardHash"],"replayKey":chain.replay["replayKey"],"actionScopeKey":action_scope,"dispatchCycleHash":cycle,"preflightHash":preflight["reviewedSubmitPreflightPacketHash"],"controlledExecutorReceiptHash":controlled["controlledExternalExecutorReceiptHash"],"executorId":controlled["executorId"],"executorDescriptorHash":controlled["executorDescriptorHash"],"executorCapabilitiesHash":controlled["executorCapabilitiesHash"],"liveAuthorizationHash":null,"artifactPackageHash":artifact["artifactPackageHash"],"expectedArtifactHashes":expected_hashes,"reviewedSubmissionDecisionPacketHash":null,"provider":null,"accountId":null,"providerCapabilityVerificationReceiptHash":null,"portalRoute":null,"nonce":null,"redrivePlanHash":null,"attempt":1,"responseDueAt":null,"blockers":blockers,"externalActionPerformed":false}),
        "submissionDispatchAuthorizationHash",
        false,
    )
}
fn local_submission_intake(dispatch: &Value) -> Result<Value, String> {
    let mut blockers = Vec::new();
    if dispatch["status"] != "submission_dispatch_authorization_ready" {
        blockers.push("dispatch_authorization_not_ready");
    }
    blockers.push("executor_response_missing");
    local_submission_hashed(
        json!({"version":1,"kind":"ExecutorResponseIntake","paperId":dispatch["paperId"],"status":if blockers.is_empty(){"executor_response_accepted"}else{"executor_response_intake_blocked"},"dispatchAuthorizationHash":dispatch["submissionDispatchAuthorizationHash"],"responseId":null,"outcome":null,"provider":null,"accountId":null,"submissionId":null,"providerReceiptHash":null,"uploadedArtifactHashes":[],"performedAt":null,"responseEnvelopeHash":null,"executorResponseVerificationReceiptHash":null,"attempt":0,"blockers":blockers}),
        "executorResponseIntakeHash",
        false,
    )
}
fn local_submission_redrive(dispatch: &Value, intake: &Value) -> Result<Value, String> {
    let explicit_failure =
        intake["status"] == "executor_response_accepted" && intake["outcome"] == "failed";
    let ambiguous = intake["blockers"]
        .as_array()
        .is_some_and(|a| a.iter().any(|s| s == "executor_response_missing"));
    let mut blockers = Vec::new();
    if dispatch["status"] != "submission_dispatch_authorization_ready" {
        blockers.push("dispatch_authorization_not_ready");
    }
    if !explicit_failure {
        blockers.push("executor_response_not_retryable");
    }
    if ambiguous {
        blockers.push("ambiguous_result_review_required");
    }
    local_submission_hashed(
        json!({"version":1,"kind":"SubmissionRedrivePlan","paperId":dispatch["paperId"],"status":if blockers.is_empty(){"submission_redrive_reauthorization_required"}else{"submission_redrive_blocked"},"dispatchAuthorizationHash":dispatch["submissionDispatchAuthorizationHash"],"responseIntakeHash":intake["executorResponseIntakeHash"],"redriveDecisionHash":null,"priorAttemptHashes":[],"nextAttempt":2,"maximumAttempts":3,"provider":dispatch["provider"],"accountId":dispatch["accountId"],"priorNonce":dispatch["nonce"],"priorLiveAuthorizationHash":dispatch["liveAuthorizationHash"],"artifactPackageHash":dispatch["artifactPackageHash"],"expectedArtifactHashes":dispatch["expectedArtifactHashes"],"requiresFreshAuthorization":true,"priorDispatchCycleHash":dispatch["dispatchCycleHash"],"blockers":blockers,"externalActionPerformed":false}),
        "submissionRedrivePlanHash",
        false,
    )
}
fn local_submission_release(
    input: &LocalSubmissionPreflightInputV1,
    dispatch: &Value,
    intake: &Value,
    reconciliation: &Value,
) -> Result<Value, String> {
    let mut blockers = Vec::new();
    if !local_submission_truthy(&input.paper_task["taskKey"]) {
        blockers.push("paper_task_required");
    }
    if dispatch["status"] != "submission_dispatch_authorization_ready" {
        blockers.push("dispatch_authorization_not_ready");
    }
    if intake["status"] != "executor_response_accepted" {
        blockers.push("executor_response_not_accepted");
    }
    if reconciliation["status"] != "live_submission_reconciled"
        && reconciliation["status"] != "dry_run_reconciled"
    {
        blockers.push("submission_reconciliation_not_ready");
    }
    local_submission_hashed(
        json!({"version":1,"kind":"SubmissionReleaseLock","paperId":input.paper_task["paperId"],"taskKey":input.paper_task["taskKey"],"status":if blockers.is_empty(){"submission_release_unlocked"}else{"submission_release_locked"},"dispatchAuthorizationHash":dispatch["submissionDispatchAuthorizationHash"],"responseIntakeHash":intake["executorResponseIntakeHash"],"reconciliationHash":reconciliation["submissionReconciliationHash"],"blockers":blockers}),
        "submissionReleaseLockHash",
        false,
    )
}
pub(super) fn local_delivery_runtime(
    chain: &LocalSubmissionChainV1<'_>,
    preflight: &Value,
    controlled: &Value,
    reviewed: &Value,
    reconciliation: &Value,
    artifact: &Value,
) -> Result<Value, String> {
    let dispatch = local_submission_dispatch(chain, preflight, controlled, reviewed, artifact)?;
    let intake = local_submission_intake(&dispatch)?;
    let redrive = local_submission_redrive(&dispatch, &intake)?;
    let lock = local_submission_release(chain.input, &dispatch, &intake, reconciliation)?;
    let external = reconciliation["externalActionPerformed"] == true;
    Ok(
        json!({"version":1,"kind":"SubmissionDeliveryRuntime","status":if lock["status"]=="submission_release_unlocked"{"submission_delivery_complete"}else{"submission_delivery_blocked"},"dispatchAuthorization":dispatch,"responseIntake":intake,"redrivePlan":redrive,"liveVenueStateProof":null,"reconciliation":reconciliation,"releaseLock":lock,"executorImplementationPresent":false,"externalActionPerformed":external}),
    )
}
