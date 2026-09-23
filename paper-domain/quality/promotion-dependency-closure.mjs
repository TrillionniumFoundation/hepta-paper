import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

export function evaluatePromotionDependencyClosure({ researchReport } = {}) {
  const gapPlan = researchReport?.capabilities?.researchGapPlan || null;
  const inputSnapshot = researchReport?.capabilities?.promotionInputSnapshot || null;
  const closureReceipt = researchReport?.capabilities?.researchGapClosureReceipt || null;
  const jobs = Array.isArray(gapPlan?.jobs) ? gapPlan.jobs : [];
  const blockers = [];
  if (!researchReport?.researchReportHash) blockers.push('promotion_research_report_missing');
  if (!gapPlan?.researchGapPlanHash) blockers.push('promotion_research_gap_plan_missing');
  if (inputSnapshot?.status !== 'promotion_input_snapshot_frozen') blockers.push('promotion_input_snapshot_required');
  if (inputSnapshot?.researchGapPlanHash !== gapPlan?.researchGapPlanHash) blockers.push('promotion_input_snapshot_gap_plan_mismatch');
  if (closureReceipt?.status !== 'research_gap_closure_verified') blockers.push('promotion_research_gap_closure_receipt_required');
  if (closureReceipt?.promotionInputSnapshotHash !== inputSnapshot?.promotionInputSnapshotHash) blockers.push('promotion_gap_closure_snapshot_mismatch');
  for (const job of jobs) {
    blockers.push(`promotion_gap_open:${job.revisionRequestId || job.claimId || job.jobId || 'unknown'}`);
  }
  const payload = {
    version: 1,
    kind: 'PromotionDependencyClosure',
    status: blockers.length ? 'promotion_dependency_closure_blocked' : 'promotion_dependency_closure_ready',
    researchReportHash: researchReport?.researchReportHash || null,
    researchGapPlanHash: gapPlan?.researchGapPlanHash || null,
    promotionInputSnapshotHash: inputSnapshot?.promotionInputSnapshotHash || null,
    researchGapClosureReceiptHash: closureReceipt?.researchGapClosureReceiptHash || null,
    openGapCount: jobs.length,
    openGapIds: jobs.map((job) => job.revisionRequestId || job.claimId || job.jobId || 'unknown').sort(),
    blockers,
  };
  return Object.freeze({ ...payload, promotionDependencyClosureHash: hashRecord('PromotionDependencyClosure', payload) });
}
