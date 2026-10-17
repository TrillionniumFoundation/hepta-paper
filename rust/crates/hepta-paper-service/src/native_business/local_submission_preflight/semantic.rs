use super::*;
pub(super) fn promotion_lock(task: &Value, plan: &Value) -> Result<Value, String> {
    promotion_lock_with_artifact(task, plan, &Value::Null)
}
pub(super) fn promotion_lock_with_artifact(
    task: &Value,
    plan: &Value,
    artifact: &Value,
) -> Result<Value, String> {
    let mut blockers = Vec::new();
    if !local_submission_truthy(&task["taskKey"]) || !local_submission_truthy(&task["taskHash"]) {
        blockers.push("semantic_lock_paper_task_required");
    }
    blockers.extend([
        "semantic_lock_target_scope_not_verified",
        "semantic_lock_paper_outside_target_scope",
        "semantic_lock_task_scope_identity_mismatch",
        "semantic_lock_package_not_verified",
        "semantic_lock_promotion_gate_not_ready",
        "semantic_lock_promotion_dependency_not_closed",
        "semantic_lock_research_report_missing",
    ]);
    let package_index = blockers
        .iter()
        .position(|s| *s == "semantic_lock_package_not_verified")
        .ok_or_else(local_submission_error)?
        + 1;
    let mut package_blockers = Vec::new();
    if artifact["submitReady"] != true || !local_submission_truthy(&artifact["artifactPackageHash"])
    {
        package_blockers.push("semantic_lock_artifact_package_not_ready");
    }
    if !artifact.is_null() {
        package_blockers.push("semantic_lock_package_verification_binding_mismatch");
    }
    package_blockers.push("semantic_lock_artifact_settlement_not_verified");
    blockers.splice(package_index..package_index, package_blockers);
    if !local_submission_truthy(&plan["venueSubmissionPlanHash"]) {
        blockers.push("semantic_lock_venue_plan_missing");
    }
    // Missing package/verification and promotion/input-snapshot values compare
    // as undefined on both sides in the original no-authority input domain.
    let hashes = json!({"paperTaskHash":local_submission_or_null(&task["taskHash"]),"targetScopeHash":null,"sourceSnapshotHash":artifact["sourceSnapshotHash"],"sourcePackageContractHash":artifact["sourcePackageContractHash"],"paperQualityPolicyHash":null,"manuscriptPromotionGateHash":null,"promotionDependencyClosureHash":null,"promotionInputSnapshotHash":null,"researchGapClosureReceiptHash":null,"claimRegistryHash":null,"evidenceQualityGateHash":null,"experimentRegistryHash":null,"claimScopeContractHash":null,"proofObligationContractHash":null,"evidenceMatrixContractHash":null,"reproducibilityContractHash":null,"researchReportHash":null,"artifactPackageHash":artifact["artifactPackageHash"],"packageVerificationReceiptHash":null,"artifactSettlementHash":artifact["artifactSettlementHash"],"venueSubmissionPlanHash":local_submission_or_null(&plan["venueSubmissionPlanHash"])});
    let identity = local_submission_kernel_hash("SemanticPromotionIdentity", &hashes)?;
    local_submission_hashed(
        json!({"version":1,"kind":"SemanticPromotionLock","paperId":local_submission_or_null(&task["paperId"]),"status":if blockers.is_empty(){"semantic_promotion_unlocked"}else{"semantic_promotion_locked"},"canonicalHashes":hashes,"semanticIdentityHash":identity,"blockers":blockers,"externalActionPerformed":false}),
        "semanticPromotionLockHash",
        false,
    )
}
