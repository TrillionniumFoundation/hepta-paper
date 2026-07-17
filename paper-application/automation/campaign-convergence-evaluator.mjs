import { evaluateRefereeConvergence } from '../../paper-domain/automation/referee-convergence.mjs';

export function buildCampaignConvergenceDecision({ campaign, node, nodes = [], executionResult } = {}) {
  const reviews = nodes
    .filter((candidate) => candidate.roundIndex === node.roundIndex
      && /^revision-referee-\d+$/.test(candidate.kind))
    .map((candidate) => candidate.result)
    .filter(Boolean);
  const revisedReview = nodes.find((candidate) => candidate.roundIndex === node.roundIndex
    && candidate.kind === 'revision-referee-1')?.result;
  return evaluateRefereeConvergence({
    paperId: campaign.paperId,
    roundIndex: node.roundIndex,
    expectedManuscriptHash: revisedReview?.manuscriptHash || null,
    reviews,
    qualityGates: executionResult?.qualityGates || [],
    revisionMaterialization: executionResult?.revisionMaterialization || null,
    ...(executionResult?.thresholds || {}),
    minimumReviewers: Number(campaign?.spec?.refereeCount || 3),
  });
}
