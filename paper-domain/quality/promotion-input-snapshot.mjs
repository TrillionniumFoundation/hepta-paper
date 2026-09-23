import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

function normalizedRevision(request = {}) {
  return {
    requestId: request.request_id || request.requestId || null,
    requestKey: request.request_key || request.requestKey || null,
    claimId: request.claim_id || request.claimId || null,
    status: request.status || null,
    riskClass: request.risk_class || request.riskClass || null,
    updatedAt: request.updated_at || request.updatedAt || request.created_at || request.createdAt || null,
  };
}

export function buildPromotionInputSnapshot({ paperTask, claimRegistry, evidenceQualityGate, researchGapPlan, revisionRequests = [], createdAt = null } = {}) {
  const revisions = revisionRequests.map(normalizedRevision)
    .sort((left, right) => `${left.requestId || ''}:${left.requestKey || ''}`.localeCompare(`${right.requestId || ''}:${right.requestKey || ''}`));
  const openRevisionIds = revisions.filter((item) => !['resolved', 'closed'].includes(String(item.status || '').toLowerCase()))
    .map((item) => item.requestId || item.requestKey || 'unknown');
  const subject = {
    paperId: paperTask?.paperId || null,
    taskHash: paperTask?.taskHash || null,
    paperQualityProfile: paperTask?.paperQualityProfile || null,
    claimRegistryHash: claimRegistry?.claimRegistryHash || null,
    evidenceQualityGateHash: evidenceQualityGate?.evidenceQualityGateHash || null,
    researchGapPlanHash: researchGapPlan?.researchGapPlanHash || null,
    revisions,
  };
  const payload = {
    version: 1,
    kind: 'PromotionInputSnapshot',
    status: paperTask?.taskHash && researchGapPlan?.researchGapPlanHash ? 'promotion_input_snapshot_frozen' : 'promotion_input_snapshot_blocked',
    ...subject,
    openRevisionIds,
    openRevisionCount: openRevisionIds.length,
    promotionInputIdentityHash: hashRecord('PromotionInputIdentity', subject),
    createdAt,
    blockers: [
      ...(!paperTask?.taskHash ? ['promotion_input_task_hash_missing'] : []),
      ...(!researchGapPlan?.researchGapPlanHash ? ['promotion_input_gap_plan_hash_missing'] : []),
    ],
  };
  return Object.freeze({ ...payload, promotionInputSnapshotHash: hashRecord('PromotionInputSnapshot', payload) });
}

export function buildResearchGapClosureReceipt({ promotionInputSnapshot, researchGapPlan, completedJobReceipts = [] } = {}) {
  const openJobs = Array.isArray(researchGapPlan?.jobs) ? researchGapPlan.jobs : [];
  const completed = new Set(completedJobReceipts.filter((item) => item?.status === 'research_gap_job_completed' && item?.receiptHash)
    .map((item) => item.jobId));
  const unresolvedJobs = openJobs.filter((job) => !completed.has(job.jobId));
  const blockers = [
    ...(promotionInputSnapshot?.status === 'promotion_input_snapshot_frozen' ? [] : ['promotion_input_snapshot_not_frozen']),
    ...(promotionInputSnapshot?.researchGapPlanHash === researchGapPlan?.researchGapPlanHash ? [] : ['promotion_input_gap_plan_binding_mismatch']),
    ...unresolvedJobs.map((job) => `research_gap_not_closed:${job.revisionRequestId || job.claimId || job.jobId}`),
  ];
  const payload = {
    version: 1,
    kind: 'ResearchGapClosureReceipt',
    status: blockers.length ? 'research_gap_closure_blocked' : 'research_gap_closure_verified',
    promotionInputSnapshotHash: promotionInputSnapshot?.promotionInputSnapshotHash || null,
    researchGapPlanHash: researchGapPlan?.researchGapPlanHash || null,
    openJobIds: openJobs.map((job) => job.jobId).sort(),
    completedJobIds: [...completed].sort(),
    unresolvedJobIds: unresolvedJobs.map((job) => job.jobId).sort(),
    blockers,
  };
  return Object.freeze({ ...payload, researchGapClosureReceiptHash: hashRecord('ResearchGapClosureReceipt', payload) });
}
