//! Native paper-domain record composition for the closed non-authorizing domain.
use super::*;
fn local_submission_semantic_payload(v: &Value) -> Value {
    match v {
        Value::Array(a) => Value::Array(a.iter().map(local_submission_semantic_payload).collect()),
        Value::Object(o) => Value::Object(
            o.iter()
                .filter(|(k, _)| {
                    !matches!(
                        k.as_str(),
                        "createdAt"
                            | "observedAt"
                            | "recordedAt"
                            | "verifiedAt"
                            | "semanticIdentityVersion"
                            | "semanticIdentityHash"
                    )
                })
                .map(|(k, v)| (k.clone(), local_submission_semantic_payload(v)))
                .collect(),
        ),
        _ => v.clone(),
    }
}
pub(super) fn local_submission_semantic_hash(kind: &str, v: &Value) -> Result<String, String> {
    hepta_legacy_compatibility::production_digest_v1(&json!({"version":2,"policy":"paper-semantic-identity-v2","kind":kind,"payload":local_submission_semantic_payload(v)})).map(|v|v.as_str().to_owned()).map_err(|_|local_submission_error())
}
pub(super) fn local_manifest(
    input: &LocalSubmissionPreflightInputV1,
    plan: &Value,
    lock: &Value,
    approval: &Value,
    fresh: &Value,
    extra: &[String],
    created: &str,
) -> Result<Value, String> {
    let task = &input.paper_task;
    let reviewed = input.reviewed_submit;
    let action = if reviewed {
        "paper.venue.reviewed_submit"
    } else {
        "paper.venue.dry_run"
    };
    let mut blockers = Vec::new();
    if reviewed {
        if approval["approved"] != true {
            blockers.push("explicit_reviewed_submit_approval_required".to_owned());
        }
        blockers.push("manuscript_promotion_gate_not_ready".to_owned());
        if lock["status"] != "semantic_promotion_unlocked" {
            blockers.push("semantic_promotion_lock_not_ready".to_owned());
        }
    }
    if !local_submission_truthy(&task["sourceWorkspace"]) {
        blockers.push("source_workspace_required".to_owned());
    }
    blockers.push("artifact_package_not_submit_ready".to_owned());
    if plan["status"] != "local_dry_run_ready" {
        blockers.push("venue_submission_plan_not_ready".to_owned());
    }
    blockers.extend(extra.iter().cloned());
    let status = if blockers.is_empty() {
        "ready_for_adapter"
    } else {
        "blocked_manifest"
    };
    let mut v = json!({"version":1,"kind":"PaperActionManifest","taskKey":task["taskKey"],"paperId":task["paperId"],"action":action,"mode":input.mode,"status":status,"readyForAdapter":blockers.is_empty(),"adapter":{"runnerId":"hepta-paper.paper-adapters","actionId":action,"sideEffectClass":if reviewed{"external_blocked"}else{"local_only"},"dryRun":true},"payload":{"paperId":task["paperId"],"venueTarget":local_submission_or_null(&task["venueTarget"]),"sourceWorkspace":local_submission_or_null(&task["sourceWorkspace"]),"mainTex":local_submission_or_null(&task["mainTex"]),"artifactPackageHash":null,"artifactHashes":[],"researchReportHash":null,"venueSubmissionPlanHash":plan["venueSubmissionPlanHash"],"freshVenueEvidenceBundleHash":fresh["freshVenueEvidenceBundleHash"],"approvalHash":if reviewed{approval["approvalHash"].clone()}else{Value::Null},"manuscriptPromotionGateHash":null,"semanticPromotionLockHash":lock["semanticPromotionLockHash"],"independentRefereeAuthorityReceiptHash":null,"liveSubmissionAuthorizationReceiptHash":null,"externalActionAuthorized":false,"controlledExternalExecutorRequired":reviewed},"blockers":local_submission_unique(blockers,32),"warnings":[],"evidenceRefs":[],"safety":{"dryRun":true,"sourceMutation":false,"executesExternalAction":false,"liveSubmitBlocked":false,"controlledExecutorBoundary":reviewed,"cryptographicDualControlRequired":reviewed},"createdAt":created});
    for name in ["channelId", "productLineId", "workflowId"] {
        if let Some(value) = task.get(name) {
            v.as_object_mut()
                .ok_or_else(local_submission_error)?
                .insert(name.into(), value.clone());
        }
    }
    if let Some(value) = task.get("title") {
        v["payload"]
            .as_object_mut()
            .ok_or_else(local_submission_error)?
            .insert("title".into(), value.clone());
    }
    let h = local_submission_paper_hash("PaperActionManifest", &v)?;
    let semantic = local_submission_semantic_hash("PaperActionManifest", &v)?;
    let o = v.as_object_mut().ok_or_else(local_submission_error)?;
    o.insert("manifestHash".into(), json!(h));
    o.insert("hash".into(), json!(h));
    o.insert("semanticIdentityVersion".into(), json!(2));
    o.insert("semanticIdentityHash".into(), json!(semantic));
    Ok(v)
}
pub(super) fn local_handoff(manifest: &Value, created: &str) -> Result<Value, String> {
    let blocked = manifest["status"] != "ready_for_adapter" || manifest["readyForAdapter"] != true;
    let action = manifest["action"]
        .as_str()
        .ok_or_else(local_submission_error)?;
    let paper = manifest["paperId"]
        .as_str()
        .ok_or_else(local_submission_error)?;
    let hash = manifest["manifestHash"]
        .as_str()
        .ok_or_else(local_submission_error)?;
    let mut v = json!({"version":1,"kind":"PaperHandoffEnvelope","taskKey":manifest["taskKey"],"paperId":manifest["paperId"],"action":manifest["action"],"status":if blocked{"blocked_handoff"}else{"dry_run_ready"},"readyForDryRun":!blocked,"readyForExecution":false,"manifestHash":hash,"commandPreview":format!("paper-adapter-runner handoff --action-id {action} --paper {paper} --manifest-hash {hash} --dry-run"),"blockers":if blocked{manifest["blockers"].clone()}else{json!([])},"safety":{"commandPreviewOnly":true,"executesExternalAction":false,"sourceMutation":false},"createdAt":created});
    let h = local_submission_paper_hash("PaperHandoffEnvelope", &v)?;
    let mut sem = v.clone();
    sem["manifestHash"] = manifest["semanticIdentityHash"].clone();
    let semantic = local_submission_semantic_hash("PaperHandoffEnvelope", &sem)?;
    let o = v.as_object_mut().ok_or_else(local_submission_error)?;
    o.insert("envelopeHash".into(), json!(h));
    o.insert("semanticIdentityVersion".into(), json!(2));
    o.insert("semanticIdentityHash".into(), json!(semantic));
    Ok(v)
}
pub(super) fn local_replay(manifest: &Value, fresh: &Value) -> Result<Value, String> {
    let mut blockers = Vec::new();
    if manifest["status"] != "ready_for_adapter" {
        blockers.push("manifest_not_ready".to_owned());
    }
    if fresh["status"] != "fresh_venue_evidence_ready" {
        blockers.push("fresh_venue_evidence_not_ready".to_owned());
    }
    let key = local_submission_paper_hash(
        "SubmissionReplayKey",
        &json!({"paperId":manifest["paperId"],"action":manifest["action"],"manifestHash":manifest["manifestHash"],"freshVenueEvidenceBundleHash":fresh["freshVenueEvidenceBundleHash"]}),
    )?;
    local_submission_hashed(
        json!({"version":1,"kind":"SubmissionReplayGuard","taskKey":manifest["taskKey"],"paperId":manifest["paperId"],"action":manifest["action"],"status":if blockers.is_empty(){"dry_run_replay_allowed"}else{"blocked_replay_guard"},"manifestHash":manifest["manifestHash"],"freshVenueEvidenceBundleHash":fresh["freshVenueEvidenceBundleHash"],"priorReceiptHash":null,"replayKey":key,"blockers":local_submission_unique(blockers,32),"safety":{"preventsDuplicateLiveAction":true,"grantsExecutionPermission":false,"externalActionPerformed":false},"createdAt":null}),
        "submissionReplayGuardHash",
        true,
    )
}
fn local_submission_record_blockers(
    records: &[&Value],
    limit: usize,
) -> Result<Vec<String>, String> {
    let mut all = Vec::new();
    for record in records {
        for item in record["blockers"]
            .as_array()
            .ok_or_else(local_submission_error)?
        {
            all.push(item.as_str().ok_or_else(local_submission_error)?.to_owned());
        }
    }
    Ok(local_submission_unique(all, limit))
}
pub(super) fn local_outbox(
    manifest: &Value,
    handoff: &Value,
    replay: &Value,
) -> Result<Value, String> {
    let blockers = local_submission_record_blockers(&[manifest, handoff, replay], 32)?;
    local_submission_hashed(
        json!({"version":1,"kind":"ExternalExecutorHandoffOutbox","taskKey":manifest["taskKey"],"paperId":manifest["paperId"],"action":manifest["action"],"status":if blockers.is_empty(){"queued_for_dry_run_executor"}else{"blocked_outbox_item"},"manifestHash":manifest["manifestHash"],"handoffEnvelopeHash":handoff["envelopeHash"],"replayGuardHash":replay["submissionReplayGuardHash"],"commandPreview":handoff["commandPreview"],"blockers":blockers,"safety":{"previewOnly":true,"externalActionPerformed":false,"sourceMutation":false},"createdAt":null}),
        "externalExecutorHandoffOutboxHash",
        true,
    )
}
pub(super) fn local_receipt(
    manifest: &Value,
    outbox: &Value,
    plan: &Value,
    reviewed: bool,
) -> Result<Value, String> {
    let blockers = local_submission_record_blockers(&[manifest, outbox], 32)?;
    let mut v = json!({"version":1,"kind":"ExternalSubmissionReceipt","taskKey":manifest["taskKey"],"paperId":manifest["paperId"],"action":manifest["action"],"status":if blockers.is_empty(){"dry_run_recorded"}else{"blocked_run"},"result":if blockers.is_empty(){"dry_run_success"}else{"blocked"},"manifestHash":manifest["manifestHash"],"outboxHash":outbox["externalExecutorHandoffOutboxHash"],"venueSubmissionPlanHash":plan["venueSubmissionPlanHash"],"reviewedSubmitRequested":reviewed,"externalActionPerformed":false,"sourceMutationPerformed":false,"blockers":blockers,"createdAt":null});
    let hash = local_submission_paper_hash("ExternalSubmissionReceipt", &v)?;
    let o = v.as_object_mut().ok_or_else(local_submission_error)?;
    o.insert("receiptHash".into(), json!(hash));
    o.insert("externalSubmissionReceiptHash".into(), json!(hash));
    Ok(v)
}
pub(super) fn local_receipt_inbox(receipt: &Value, outbox: &Value) -> Result<Value, String> {
    let mut blockers = Vec::new();
    if receipt["outboxHash"] != outbox["externalExecutorHandoffOutboxHash"] {
        blockers.push("receipt_outbox_hash_mismatch");
    }
    if receipt["externalActionPerformed"] == true {
        blockers.push("unexpected_external_action_performed");
    }
    local_submission_hashed(
        json!({"version":1,"kind":"SubmissionReceiptInbox","taskKey":receipt["taskKey"],"paperId":receipt["paperId"],"status":if blockers.is_empty(){"receipt_inbox_recorded"}else{"blocked_receipt_inbox"},"receiptHash":receipt["receiptHash"],"outboxHash":outbox["externalExecutorHandoffOutboxHash"],"blockers":blockers,"createdAt":null}),
        "submissionReceiptInboxHash",
        true,
    )
}
pub(super) fn local_venue_proof(receipt: &Value, plan: &Value) -> Result<Value, String> {
    let mut blockers = Vec::new();
    if receipt["status"] != "dry_run_recorded" {
        blockers.push("receipt_not_dry_run_recorded");
    }
    if plan["status"] != "local_dry_run_ready" {
        blockers.push("venue_plan_not_ready");
    }
    if receipt["externalActionPerformed"] == true {
        blockers.push("unexpected_external_action_performed");
    }
    if plan["externalActionAuthorized"] == true {
        blockers.push("unexpected_external_authorization");
    }
    local_submission_hashed(
        json!({"version":1,"kind":"VenueStateProof","taskKey":receipt["taskKey"],"paperId":receipt["paperId"],"venueSubmissionPlanHash":plan["venueSubmissionPlanHash"],"receiptHash":receipt["receiptHash"],"status":if blockers.is_empty(){"dry_run_state_proof"}else{"blocked_proof"},"externalStateChanged":false,"blockers":blockers,"createdAt":null}),
        "venueStateProofHash",
        true,
    )
}
pub(super) fn local_reconciliation(
    manifest: &Value,
    outbox: &Value,
    receipt: &Value,
    proof: &Value,
    archive: &Value,
) -> Result<Value, String> {
    let mut blockers = Vec::new();
    if receipt["manifestHash"] != manifest["manifestHash"] {
        blockers.push("receipt_manifest_hash_mismatch");
    }
    if receipt["outboxHash"] != outbox["externalExecutorHandoffOutboxHash"] {
        blockers.push("receipt_outbox_hash_mismatch");
    }
    if proof["receiptHash"] != receipt["receiptHash"] {
        blockers.push("proof_receipt_hash_mismatch");
    }
    if receipt["externalActionPerformed"] == true || proof["externalStateChanged"] == true {
        blockers.push("unexpected_external_state_change");
    }
    local_submission_hashed(
        json!({"version":1,"kind":"SubmissionReconciliation","taskKey":manifest["taskKey"],"paperId":manifest["paperId"],"status":if blockers.is_empty(){"dry_run_reconciled"}else{"blocked_reconciliation"},"manifestHash":manifest["manifestHash"],"outboxHash":outbox["externalExecutorHandoffOutboxHash"],"receiptHash":receipt["receiptHash"],"venueStateProofHash":proof["venueStateProofHash"],"auditArchiveHash":archive["auditArchiveHash"],"blockers":blockers,"safety":{"externalActionPerformed":false,"externalStateChanged":false},"createdAt":null}),
        "submissionReconciliationHash",
        true,
    )
}

pub(super) struct LocalSubmissionChainV1<'a> {
    pub input: &'a LocalSubmissionPreflightInputV1,
    pub plan: &'a Value,
    pub lock: &'a Value,
    pub approval: &'a Value,
    pub fresh: &'a Value,
    pub manifest: &'a Value,
    pub replay: &'a Value,
    pub outbox: &'a Value,
}
pub(super) fn local_reviewed_venue(
    input: &LocalSubmissionPreflightInputV1,
    plan: &Value,
) -> Result<Value, String> {
    let mut blockers = Vec::new();
    if !local_submission_truthy(&input.paper_task["taskKey"]) {
        blockers.push("reviewed_venue_evidence_paper_task_missing".to_owned());
    }
    if plan["status"] != "local_dry_run_ready" {
        blockers.push("reviewed_venue_evidence_venue_plan_not_ready".to_owned());
    }
    blockers.push("reviewed_venue_observation_missing".to_owned());
    for field in [
        "provider",
        "portalRoute",
        "venueTarget",
        "track",
        "deadlineState",
        "observedState",
        "reviewedBy",
    ] {
        blockers.push(format!("reviewed_venue_{field}_missing"));
    }
    blockers.extend(
        [
            "reviewed_venue_portal_state_not_fetched",
            "reviewed_venue_observed_at_invalid",
            "reviewed_venue_expires_at_invalid",
            "reviewed_venue_evidence_hashes_missing",
        ]
        .into_iter()
        .map(str::to_owned),
    );
    if local_submission_truthy(&input.paper_task["venueTarget"]) {
        blockers.push("reviewed_venue_target_mismatch".to_owned());
    }
    blockers.extend(
        [
            "reviewed_venue_deadline_not_open",
            "reviewed_venue_not_accepting_submissions",
            "reviewed_venue_source_verification_required",
            "reviewed_venue_source_purpose_mismatch",
            "reviewed_venue_source_reviewer_mismatch",
        ]
        .into_iter()
        .map(str::to_owned),
    );
    local_submission_hashed(
        json!({"version":1,"kind":"ReviewedVenueEvidence","paperId":local_submission_or_null(&input.paper_task["paperId"]),"taskKey":local_submission_or_null(&input.paper_task["taskKey"]),"status":if blockers.is_empty(){"reviewed_venue_evidence_verified"}else{"reviewed_venue_evidence_blocked"},"purpose":"submission_preflight","venueSubmissionPlanHash":local_submission_or_null(&plan["venueSubmissionPlanHash"]),"provider":null,"portalRoute":null,"venueTarget":null,"track":null,"deadlineState":null,"observedState":null,"observedAt":null,"expiresAt":null,"reviewedBy":null,"evidenceHashes":[],"retargetEvidenceHashes":[],"exceptionEvidenceHashes":[],"fetchedPortalState":false,"observationSubjectHash":null,"sourceVerificationReceiptHash":null,"sourceVerifiedSubjectIds":[],"blockers":blockers,"externalActionPerformed":false}),
        "reviewedVenueEvidenceHash",
        false,
    )
}
pub(super) fn local_preflight(chain: &LocalSubmissionChainV1<'_>) -> Result<Value, String> {
    let mut blockers = local_submission_record_blockers(
        &[
            chain.approval,
            chain.fresh,
            chain.manifest,
            chain.replay,
            chain.outbox,
        ],
        64,
    )?;
    blockers.extend(
        [
            "independent_referee_acceptance_authority_required",
            "live_submission_authorization_required",
            "manuscript_promotion_gate_not_ready",
        ]
        .into_iter()
        .map(str::to_owned),
    );
    if chain.lock["status"] != "semantic_promotion_unlocked" {
        blockers.push("semantic_promotion_lock_not_ready".to_owned());
    }
    blockers.push("reviewed_submission_decision_required".to_owned());
    let blockers = local_submission_unique(blockers, 64);
    let approved = chain.approval["approved"] == true;
    let approval_required = blockers
        .iter()
        .any(|s| s == "explicit_reviewed_submit_approval_required")
        || !approved;
    local_submission_hashed(
        json!({"version":1,"kind":"ReviewedSubmitPreflightPacket","taskKey":chain.input.paper_task["taskKey"],"paperId":chain.input.paper_task["paperId"],"mode":"reviewed-submit","status":if blockers.is_empty(){"reviewed_submit_preflight_ready_for_external_executor"}else{"reviewed_submit_preflight_blocked"},"externalExecutorHandoffReady":blockers.is_empty(),"approvalRequired":approval_required,"liveExecutorBoundaryBlocked":!blockers.is_empty(),"artifactPackageHash":null,"researchReportHash":null,"venueSubmissionPlanHash":chain.plan["venueSubmissionPlanHash"],"approvalHash":chain.approval["approvalHash"],"freshVenueEvidenceBundleHash":chain.fresh["freshVenueEvidenceBundleHash"],"manifestHash":chain.manifest["manifestHash"],"replayGuardHash":chain.replay["submissionReplayGuardHash"],"outboxHash":chain.outbox["externalExecutorHandoffOutboxHash"],"independentRefereeAuthorityReceiptHash":null,"liveSubmissionAuthorizationReceiptHash":null,"manuscriptPromotionGateHash":null,"semanticPromotionLockHash":chain.lock["semanticPromotionLockHash"],"reviewedSubmissionDecisionPacketHash":null,"blockers":blockers,"safety":{"preflightOnly":true,"grantsLiveExecutionInsideOverlay":false,"requiresSeparateReviewedApproval":!approved,"requiresExternalExecutor":true,"dualControlAuthorizationVerified":false,"externalActionPerformed":false},"createdAt":null}),
        "reviewedSubmitPreflightPacketHash",
        true,
    )
}
pub(super) fn local_controlled(
    chain: &LocalSubmissionChainV1<'_>,
    preflight: &Value,
) -> Result<Value, String> {
    let mut blockers = Vec::new();
    for (record, expected, reason) in [
        (
            chain.approval,
            "approved_for_external_executor_handoff",
            "submission_approval_packet_not_ready",
        ),
        (
            preflight,
            "reviewed_submit_preflight_ready_for_external_executor",
            "reviewed_submit_preflight_not_ready",
        ),
        (chain.manifest, "ready_for_adapter", "manifest_not_ready"),
        (
            chain.outbox,
            "queued_for_dry_run_executor",
            "executor_outbox_not_ready",
        ),
        (
            chain.replay,
            "dry_run_replay_allowed",
            "replay_guard_not_ready",
        ),
    ] {
        if record["status"] != expected {
            blockers.push(reason.to_owned());
        }
    }
    blockers.extend(
        [
            "independent_referee_acceptance_authority_required",
            "live_submission_authorization_required",
            "submission_executor_descriptor_required",
            "reviewed_submission_decision_required",
        ]
        .into_iter()
        .map(str::to_owned),
    );
    let blockers = local_submission_unique(blockers, 32);
    local_submission_hashed(
        json!({"version":1,"kind":"ControlledExternalExecutorReceipt","taskKey":chain.input.paper_task["taskKey"],"paperId":chain.input.paper_task["paperId"],"action":chain.manifest["action"],"mode":"reviewed-submit","status":if blockers.is_empty(){"controlled_external_executor_receipt_recorded"}else{"controlled_external_executor_blocked"},"executorId":"openclaw-agent-controlled-reviewed-submit-executor","executorDescriptorHash":null,"executorCapabilitiesHash":null,"reviewedSubmissionDecisionPacketHash":null,"agentApproved":chain.approval["agentApproved"]==true,"independentRefereeAuthorityReceiptHash":null,"liveSubmissionAuthorizationReceiptHash":null,"controlledExecutorReady":blockers.is_empty(),"liveSubmitPerformed":false,"externalActionPerformed":false,"hashChain":{"approvalHash":chain.approval["approvalHash"],"reviewedSubmitPreflightPacketHash":preflight["reviewedSubmitPreflightPacketHash"],"manifestHash":chain.manifest["manifestHash"],"outboxHash":chain.outbox["externalExecutorHandoffOutboxHash"],"replayGuardHash":chain.replay["submissionReplayGuardHash"],"independentRefereeAuthorityReceiptHash":null,"liveSubmissionAuthorizationReceiptHash":null,"executorDescriptorHash":null,"executorCapabilitiesHash":null,"reviewedSubmissionDecisionPacketHash":null},"blockers":blockers,"safety":{"receiptOnly":true,"grantsLiveExecutionInsideOverlay":false,"executesExternalAction":false,"externalActionPerformed":false,"sourceMutation":false,"liveSubmitPerformed":false,"requiresSeparateRealPortalExecutor":true,"dualControlAuthorizationVerified":false},"createdAt":null}),
        "controlledExternalExecutorReceiptHash",
        true,
    )
}

pub(super) fn local_manifest_with_artifact(
    input: &LocalSubmissionPreflightInputV1,
    chain: &LocalSubmissionChainV1<'_>,
    artifact: &Value,
    created: &str,
) -> Result<Value, String> {
    let mut manifest = local_manifest(
        input,
        chain.plan,
        chain.lock,
        chain.approval,
        chain.fresh,
        &[],
        created,
    )?;
    if artifact.is_null() {
        return Ok(manifest);
    }
    let blockers = manifest["blockers"]
        .as_array()
        .ok_or_else(local_submission_error)?
        .iter()
        .filter(|v| artifact["submitReady"] != true || **v != "artifact_package_not_submit_ready")
        .cloned()
        .collect::<Vec<_>>();
    manifest["blockers"] = json!(blockers);
    manifest["status"] = json!(if blockers.is_empty() {
        "ready_for_adapter"
    } else {
        "blocked_manifest"
    });
    manifest["readyForAdapter"] = json!(blockers.is_empty());
    manifest["payload"]["artifactPackageHash"] = artifact["artifactPackageHash"].clone();
    manifest["payload"]["artifactHashes"] = json!(
        artifact["artifacts"]
            .as_array()
            .ok_or_else(local_submission_error)?
            .iter()
            .filter_map(|a| a["hash"].as_str())
            .collect::<Vec<_>>()
    );
    let object = manifest
        .as_object_mut()
        .ok_or_else(local_submission_error)?;
    for field in [
        "manifestHash",
        "hash",
        "semanticIdentityVersion",
        "semanticIdentityHash",
    ] {
        object.remove(field);
    }
    let h = local_submission_paper_hash("PaperActionManifest", &manifest)?;
    let semantic = local_submission_semantic_hash("PaperActionManifest", &manifest)?;
    let object = manifest
        .as_object_mut()
        .ok_or_else(local_submission_error)?;
    object.insert("manifestHash".into(), json!(h));
    object.insert("hash".into(), json!(h));
    object.insert("semanticIdentityVersion".into(), json!(2));
    object.insert("semanticIdentityHash".into(), json!(semantic));
    Ok(manifest)
}
