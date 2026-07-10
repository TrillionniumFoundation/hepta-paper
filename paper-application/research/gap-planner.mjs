import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

export function buildResearchGapPlan({ paperTask, claimRegistry, evidenceQualityGate, priorJobs = [], priorities = {} } = {}) {
  const covered = new Set(evidenceQualityGate?.coveredClaimIds || []);
  const priorByClaim = new Map(priorJobs.map((job) => [job.claimId, job]));
  const jobs = (claimRegistry?.claims || []).filter((claim) => !covered.has(claim.claimId)).map((claim) => ({
    jobId: `research-gap:${paperTask?.paperId || 'paper'}:${claim.claimId}`,
    claimId: claim.claimId,
    action: 'produce_or_bind_research_evidence',
    priority: Number(priorities[claim.claimId] ?? 100),
    deduplicationKey: `${paperTask?.paperId || 'paper'}:${claim.claimId}:${claim.status}`,
    priorReceiptHash: priorByClaim.get(claim.claimId)?.receiptHash || null,
    arbitraryCommandAllowed: false,
  })).sort((left, right) => left.priority - right.priority || left.claimId.localeCompare(right.claimId));
  const record = { version: 2, kind: 'ResearchGapPlan', paperId: paperTask?.paperId || null, jobs };
  return { ...record, researchGapPlanHash: hashRecord('ResearchGapPlan', record) };
}
