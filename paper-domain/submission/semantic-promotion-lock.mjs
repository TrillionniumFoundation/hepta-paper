import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

export function buildSemanticPromotionLock({
  paperTask,
  targetScopeReceipt,
  artifactPackage,
  packageVerificationReceipt,
  researchReport,
  promotionGate,
  venuePlan,
} = {}) {
  const blockers = [];
  if (!paperTask?.taskKey || !paperTask?.taskHash) blockers.push('semantic_lock_paper_task_required');
  if (targetScopeReceipt?.status !== 'target_scope_verified') blockers.push('semantic_lock_target_scope_not_verified');
  if (!targetScopeReceipt?.selectedPaperIds?.includes(paperTask?.paperId)) blockers.push('semantic_lock_paper_outside_target_scope');
  const scopedTask = targetScopeReceipt?.selectedTaskBindings?.find((item) => item.paperId === paperTask?.paperId) || null;
  if (!scopedTask || scopedTask.taskHash !== paperTask?.taskHash || scopedTask.paperQualityProfile !== (paperTask?.paperQualityProfile || null)) {
    blockers.push('semantic_lock_task_scope_identity_mismatch');
  }
  if (packageVerificationReceipt?.status !== 'package_verification_passed') blockers.push('semantic_lock_package_not_verified');
  if (artifactPackage?.submitReady !== true || !artifactPackage?.artifactPackageHash) blockers.push('semantic_lock_artifact_package_not_ready');
  if (artifactPackage?.packageVerificationReceiptHash !== packageVerificationReceipt?.packageVerificationReceiptHash) {
    blockers.push('semantic_lock_package_verification_binding_mismatch');
  }
  if (artifactPackage?.artifactSettlementStatus !== 'artifact_settlement_verified'
    || artifactPackage?.artifactSettlementHash !== packageVerificationReceipt?.artifactSettlement?.artifactSettlementHash) {
    blockers.push('semantic_lock_artifact_settlement_not_verified');
  }
  if (promotionGate?.status !== 'manuscript_promotion_ready') blockers.push('semantic_lock_promotion_gate_not_ready');
  if (promotionGate?.promotionDependencyClosure?.status !== 'promotion_dependency_closure_ready') blockers.push('semantic_lock_promotion_dependency_not_closed');
  if (!researchReport?.researchReportHash) blockers.push('semantic_lock_research_report_missing');
  if (!venuePlan?.venueSubmissionPlanHash) blockers.push('semantic_lock_venue_plan_missing');
  const capabilities = researchReport?.capabilities || {};
  const typed = researchReport?.typedContracts || {};
  if (promotionGate?.promotionInputSnapshotHash !== capabilities.promotionInputSnapshot?.promotionInputSnapshotHash) {
    blockers.push('semantic_lock_promotion_input_snapshot_mismatch');
  }
  const canonicalHashes = {
    paperTaskHash: paperTask?.taskHash || null,
    targetScopeHash: targetScopeReceipt?.targetScopeHash || null,
    sourceSnapshotHash: artifactPackage?.sourceSnapshotHash || null,
    sourcePackageContractHash: artifactPackage?.sourcePackageContractHash || null,
    paperQualityPolicyHash: promotionGate?.paperQualityPolicy?.paperQualityPolicyHash || null,
    manuscriptPromotionGateHash: promotionGate?.manuscriptPromotionGateHash || null,
    promotionDependencyClosureHash: promotionGate?.promotionDependencyClosure?.promotionDependencyClosureHash || null,
    promotionInputSnapshotHash: capabilities.promotionInputSnapshot?.promotionInputSnapshotHash || null,
    researchGapClosureReceiptHash: capabilities.researchGapClosureReceipt?.researchGapClosureReceiptHash || null,
    claimRegistryHash: capabilities.claimRegistry?.claimRegistryHash || null,
    evidenceQualityGateHash: capabilities.evidenceQualityGate?.evidenceQualityGateHash || null,
    experimentRegistryHash: capabilities.experimentRegistry?.experimentRegistryHash || null,
    claimScopeContractHash: typed.claimScopeContract?.claimScopeContractHash || null,
    proofObligationContractHash: typed.proofObligationContract?.proofObligationContractHash || null,
    evidenceMatrixContractHash: typed.evidenceMatrixContract?.evidenceMatrixContractHash || null,
    reproducibilityContractHash: typed.reproducibilityContract?.reproducibilityContractHash || null,
    researchReportHash: researchReport?.researchReportHash || null,
    artifactPackageHash: artifactPackage?.artifactPackageHash || null,
    packageVerificationReceiptHash: packageVerificationReceipt?.packageVerificationReceiptHash || null,
    artifactSettlementHash: artifactPackage?.artifactSettlementHash || null,
    venueSubmissionPlanHash: venuePlan?.venueSubmissionPlanHash || null,
  };
  const payload = {
    version: 1,
    kind: 'SemanticPromotionLock',
    paperId: paperTask?.paperId || null,
    status: blockers.length ? 'semantic_promotion_locked' : 'semantic_promotion_unlocked',
    canonicalHashes,
    semanticIdentityHash: hashRecord('SemanticPromotionIdentity', canonicalHashes),
    blockers,
    externalActionPerformed: false,
  };
  return Object.freeze({ ...payload, semanticPromotionLockHash: hashRecord('SemanticPromotionLock', payload) });
}
