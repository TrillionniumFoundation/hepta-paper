import { hashPaperRecord } from '../../paper-core/src/paper-contract-primitives.mjs';

export function buildResearchGapPlan({ paperTask, claimRegistry, evidenceQualityGate } = {}) {
  const covered = new Set(evidenceQualityGate?.coveredClaimIds || []);
  const jobs = (claimRegistry?.claims || []).filter((claim) => !covered.has(claim.claimId)).map((claim) => ({
    jobId: `research-gap:${paperTask?.paperId || 'paper'}:${claim.claimId}`,
    claimId: claim.claimId,
    action: 'produce_or_bind_research_evidence',
    arbitraryCommandAllowed: false,
  }));
  const record = { version: 1, kind: 'ResearchGapPlan', paperId: paperTask?.paperId || null, jobs };
  return { ...record, researchGapPlanHash: hashPaperRecord('ResearchGapPlan', record) };
}

