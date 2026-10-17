//! Closed local lifecycle composition. No artifact, authority, executor or store
//! can enter this input version; complete local artifact preparation follows in
//! a separate capability-bound business owner.
use super::workflow::{self, LocalSubmissionChainV1};
use super::*;
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LocalSubmissionLifecycleInputV1 {
    pub version: u16,
    pub kind: String,
    pub preflight: LocalSubmissionPreflightInputV1,
    pub row_blockers: Vec<String>,
    pub reference_time_millis: i64,
}
/// Reproduce the incumbent's complete lifecycle for the explicit local input
/// domain. This performs computation only and grants no submission authority.
pub fn build_local_submission_lifecycle_v1(
    input: LocalSubmissionLifecycleInputV1,
) -> Result<Value, String> {
    local_submission_lifecycle_from_artifact_v1(input, &Value::Null)
}
pub(super) fn local_submission_lifecycle_from_artifact_v1(
    input: LocalSubmissionLifecycleInputV1,
    artifact: &Value,
) -> Result<Value, String> {
    if input.version != 1
        || input.kind != "NativeLocalSubmissionLifecycleInput"
        || input.row_blockers.len() > 1024
        || input
            .row_blockers
            .iter()
            .any(|s| s.len() > 64 * 1024 || s.contains('\0'))
    {
        return Err(local_submission_error());
    }
    local_submission_value_budget(
        &serde_json::to_value(&input).map_err(|_| local_submission_error())?,
    )?;
    let created = crate::sqlite_mutation_coordinator::clock::iso(input.reference_time_millis)
        .map_err(|_| local_submission_error())?;
    build_local_submission_preflight_v1(input.preflight.clone())?;
    let plan_value = records::venue_plan_with_artifact(&input.preflight, artifact)?;
    let plan = &plan_value;
    let lock_value =
        semantic::promotion_lock_with_artifact(&input.preflight.paper_task, plan, artifact)?;
    let lock = &lock_value;
    let approval_value = records::approval_with_artifact(&input.preflight, plan, lock, artifact)?;
    let approval = &approval_value;
    let reviewed = if input.preflight.reviewed_submit {
        workflow::local_reviewed_venue(&input.preflight, plan)?
    } else {
        Value::Null
    };
    let fresh = records::fresh_with_artifact(&input.preflight, plan, lock, &reviewed, artifact)?;
    let absent = Value::Null;
    let manifest = if artifact.is_null() {
        workflow::local_manifest(
            &input.preflight,
            plan,
            lock,
            approval,
            &fresh,
            &input.row_blockers,
            &created,
        )?
    } else {
        if !input.row_blockers.is_empty() {
            return Err(local_submission_error());
        }
        let chain = LocalSubmissionChainV1 {
            input: &input.preflight,
            plan,
            lock,
            approval,
            fresh: &fresh,
            manifest: &absent,
            replay: &absent,
            outbox: &absent,
        };
        workflow::local_manifest_with_artifact(&input.preflight, &chain, artifact, &created)?
    };
    let handoff = workflow::local_handoff(&manifest, &created)?;
    let replay = workflow::local_replay(&manifest, &fresh)?;
    let outbox = workflow::local_outbox(&manifest, &handoff, &replay)?;
    let chain = LocalSubmissionChainV1 {
        input: &input.preflight,
        plan,
        lock,
        approval,
        fresh: &fresh,
        manifest: &manifest,
        replay: &replay,
        outbox: &outbox,
    };
    let preflight = if input.preflight.reviewed_submit {
        workflow::local_preflight(&chain)?
    } else {
        Value::Null
    };
    let controlled = if input.preflight.reviewed_submit {
        workflow::local_controlled(&chain, &preflight)?
    } else {
        Value::Null
    };
    let receipt =
        workflow::local_receipt(&manifest, &outbox, plan, input.preflight.reviewed_submit)?;
    let inbox = workflow::local_receipt_inbox(&receipt, &outbox)?;
    let proof = workflow::local_venue_proof(&receipt, plan)?;
    let controlled_recorded =
        controlled["status"] == "controlled_external_executor_receipt_recorded";
    let archive = local_submission_hashed(
        json!({"version":1,"kind":"SubmissionAuditArchive","paperId":input.preflight.paper_task["paperId"],"mode":input.preflight.mode,"venueSubmissionPlanHash":plan["venueSubmissionPlanHash"],"approvalHash":approval["approvalHash"],"freshVenueEvidenceBundleHash":fresh["freshVenueEvidenceBundleHash"],"reviewedSubmitPreflightPacketHash":preflight["reviewedSubmitPreflightPacketHash"],"controlledExternalExecutorReceiptHash":controlled["controlledExternalExecutorReceiptHash"],"independentRefereeAuthorityReceiptHash":null,"liveSubmissionAuthorizationReceiptHash":null,"manuscriptPromotionGateHash":null,"semanticPromotionLockHash":lock["semanticPromotionLockHash"],"manifestHash":manifest["manifestHash"],"replayGuardHash":replay["submissionReplayGuardHash"],"envelopeHash":handoff["envelopeHash"],"outboxHash":outbox["externalExecutorHandoffOutboxHash"],"receiptHash":receipt["receiptHash"],"receiptInboxHash":inbox["submissionReceiptInboxHash"],"venueStateProofHash":proof["venueStateProofHash"],"externalActionPerformed":false,"liveSubmitBlocked":true,"controlledExecutorReceiptRecorded":controlled_recorded}),
        "auditArchiveHash",
        true,
    )?;
    let reconciliation =
        workflow::local_reconciliation(&manifest, &outbox, &receipt, &proof, &archive)?;
    let runtime = delivery::local_delivery_runtime(
        &chain,
        &preflight,
        &controlled,
        &reviewed,
        &reconciliation,
        artifact,
    )?;
    let external = runtime["externalActionPerformed"] == true;
    Ok(
        json!({"version":1,"kind":"PaperSubmissionLifecycle","paperId":input.preflight.paper_task["paperId"],"mode":input.preflight.mode,"reviewedSubmit":input.preflight.reviewed_submit,"venuePlan":plan,"independentReviewAuthorityReceipt":null,"liveAuthorizationReceipt":null,"approvalPacket":approval,"freshVenueEvidenceBundle":fresh,"reviewedVenueEvidence":reviewed,"submissionDecisionPacket":null,"reviewedSubmitPreflightPacket":preflight,"controlledExecutorReceipt":controlled,"manifest":manifest,"handoff":handoff,"replayGuard":replay,"outbox":outbox,"receipt":receipt,"receiptInbox":inbox,"venueStateProof":proof,"auditArchive":archive,"reconciliation":reconciliation,"postActionReconciliation":runtime["reconciliation"],"deliveryRuntime":runtime,"deliveryPersistence":{"status":"submission_delivery_persistence_blocked","messageId":null,"releaseLockStatus":null,"blockers":["dispatch_authorization_not_ready"]},"targetScopeReceipt":null,"promotionGate":null,"semanticPromotionLock":lock,"safety":{"dryRunOnly":true,"postActionEvidenceIngested":false,"externalActionPerformed":external,"controlledExecutorReceiptRecorded":controlled_recorded,"liveSubmitRequiresSeparateAuthorization":true,"independentRefereeAuthorityVerified":false,"liveAuthorizationVerified":false,"executorImplementationPresent":false}}),
    )
}
