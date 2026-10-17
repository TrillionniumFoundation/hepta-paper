use super::*;
pub(super) fn venue_plan(input: &LocalSubmissionPreflightInputV1) -> Result<Value, String> {
    venue_plan_with_artifact(input, &Value::Null)
}
pub(super) fn venue_plan_with_artifact(
    input: &LocalSubmissionPreflightInputV1,
    artifact: &Value,
) -> Result<Value, String> {
    let task = &input.paper_task;
    let absent = Value::Null;
    let venue = input.venue.as_ref().unwrap_or(&absent);
    let mut blockers = Vec::new();
    if !local_submission_truthy(&task["venueTarget"]) && !local_submission_truthy(&venue["name"]) {
        blockers.push("venue_target_missing".to_owned());
    }
    if !local_submission_truthy(&artifact["artifactCount"]) {
        blockers.push("artifact_package_missing".to_owned());
    }
    let target = if local_submission_truthy(&task["venueTarget"]) {
        task["venueTarget"].clone()
    } else {
        local_submission_or_null(&venue["name"])
    };
    let venue_id = if local_submission_truthy(&venue["venue_id"]) {
        venue["venue_id"].clone()
    } else {
        local_submission_or_null(&venue["venueId"])
    };
    local_submission_hashed(
        json!({"version":1,"kind":"VenueSubmissionPlan","taskKey":task["taskKey"],"paperId":task["paperId"],"venueTarget":target,"venueId":venue_id,"venueKind":local_submission_or_null(&venue["kind"]),"mode":input.mode,"status":if blockers.is_empty(){"local_dry_run_ready"}else{"blocked_plan"},"artifactPackageHash":artifact["artifactPackageHash"],"externalActionAuthorized":false,"blockers":local_submission_unique(blockers,32),"warnings":if venue.is_null(){vec!["venue_registry_match_missing"]}else{vec![]},"safety":{"opensPortal":false,"uploads":false,"emails":false,"submits":false},"createdAt":null}),
        "venueSubmissionPlanHash",
        true,
    )
}
pub(super) fn approval(
    input: &LocalSubmissionPreflightInputV1,
    plan: &Value,
    lock: &Value,
) -> Result<Value, String> {
    approval_with_artifact(input, plan, lock, &Value::Null)
}
pub(super) fn approval_with_artifact(
    input: &LocalSubmissionPreflightInputV1,
    plan: &Value,
    lock: &Value,
    artifact: &Value,
) -> Result<Value, String> {
    let mut blockers = vec![
        "explicit_reviewed_submit_approval_required",
        "artifact_package_not_submit_ready",
        "verified_artifact_package_required",
        "manuscript_promotion_gate_not_ready",
    ];
    if artifact["submitReady"] == true {
        blockers.retain(|s| *s != "artifact_package_not_submit_ready");
    }
    if lock["status"] != "semantic_promotion_unlocked" {
        blockers.push("semantic_promotion_lock_not_ready");
    }
    if plan["status"] != "local_dry_run_ready" {
        blockers.push("venue_submission_plan_not_ready");
    }
    blockers.extend([
        "attested_academic_evidence_required_for_reviewed_submit",
        "independent_referee_acceptance_authority_required",
        "live_submission_authorization_required",
    ]);
    let v = json!({"version":1,"kind":"SubmissionApprovalPacket","taskKey":input.paper_task["taskKey"],"paperId":input.paper_task["paperId"],"mode":input.mode,"status":if blockers.is_empty(){"approved_for_external_executor_handoff"}else{"blocked_approval_packet"},"approved":false,"approver":null,"approvalActor":null,"agentApproved":false,"artifactPackageHash":artifact["artifactPackageHash"],"venueSubmissionPlanHash":plan["venueSubmissionPlanHash"],"researchReportHash":null,"academicEvidenceVerificationHash":null,"independentRefereeAuthorityReceiptHash":null,"liveSubmissionAuthorizationReceiptHash":null,"manuscriptPromotionGateHash":null,"semanticPromotionLockHash":lock["semanticPromotionLockHash"],"externalExecutorRequired":true,"blockers":local_submission_unique(blockers.into_iter().map(str::to_owned),32),"safety":{"grantsLiveExecutionInsideOverlay":false,"externalActionPerformed":false,"requiresSeparateExecutor":true,"agentMayApprove":false,"cryptographicDualControlRequired":true},"createdAt":null});
    let h = local_submission_paper_hash("SubmissionApprovalPacket", &v)?;
    let mut v = v;
    let o = v.as_object_mut().ok_or_else(local_submission_error)?;
    o.insert("approvalHash".into(), json!(h));
    o.insert("submissionApprovalPacketHash".into(), json!(h));
    Ok(v)
}
pub(super) fn fresh(
    input: &LocalSubmissionPreflightInputV1,
    plan: &Value,
    lock: &Value,
) -> Result<Value, String> {
    fresh_with_reviewed(input, plan, lock, &Value::Null)
}
pub(super) fn fresh_with_reviewed(
    input: &LocalSubmissionPreflightInputV1,
    plan: &Value,
    lock: &Value,
    reviewed: &Value,
) -> Result<Value, String> {
    fresh_with_artifact(input, plan, lock, reviewed, &Value::Null)
}
pub(super) fn fresh_with_artifact(
    input: &LocalSubmissionPreflightInputV1,
    plan: &Value,
    lock: &Value,
    reviewed: &Value,
    artifact: &Value,
) -> Result<Value, String> {
    let mut blockers = Vec::new();
    if plan["status"] != "local_dry_run_ready" {
        blockers.push("venue_plan_not_ready");
    }
    if !local_submission_truthy(&artifact["artifactPackageHash"]) {
        blockers.push("artifact_package_hash_missing");
    }
    if input.reviewed_submit {
        blockers.push("manuscript_promotion_gate_not_ready");
        if lock["status"] != "semantic_promotion_unlocked" {
            blockers.push("semantic_promotion_lock_not_ready");
        }
        blockers.extend([
            "attested_academic_evidence_required_for_reviewed_submit",
            "independent_referee_acceptance_authority_required",
            "reviewed_fresh_venue_evidence_required",
        ]);
        if reviewed["venueSubmissionPlanHash"] != plan["venueSubmissionPlanHash"] {
            blockers.push("reviewed_venue_evidence_plan_mismatch");
        }
    }
    local_submission_hashed(
        json!({"version":1,"kind":"FreshVenueEvidenceBundle","taskKey":input.paper_task["taskKey"],"paperId":input.paper_task["paperId"],"status":if blockers.is_empty(){"fresh_venue_evidence_ready"}else{"blocked_fresh_venue_evidence"},"venueSubmissionPlanHash":plan["venueSubmissionPlanHash"],"artifactPackageHash":artifact["artifactPackageHash"],"researchReportHash":null,"academicEvidenceStatus":null,"academicEvidenceEligible":false,"academicEvidenceVerificationHash":null,"independentRefereeAuthorityReceiptHash":null,"manuscriptPromotionGateHash":null,"semanticPromotionLockHash":lock["semanticPromotionLockHash"],"reviewedVenueEvidenceHash":reviewed["reviewedVenueEvidenceHash"],"evidenceRefs":[],"blockers":local_submission_unique(blockers.into_iter().map(str::to_owned),32),"safety":{"fetchedPortalState":false,"externalActionPerformed":false,"dryRunEvidenceOnly":!input.reviewed_submit},"createdAt":null}),
        "freshVenueEvidenceBundleHash",
        true,
    )
}
