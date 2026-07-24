import { evaluateRefereeConvergence } from '../../paper-domain/automation/referee-convergence.mjs';

export function buildCampaignConvergenceDecision({
  campaign,
  node,
  nodes = [],
  executionResult,
  signedReviewerReceiptVerifier = null,
} = {}) {
  const refereeNodes = nodes
    .filter((candidate) => candidate.roundIndex === node.roundIndex
      && /^revision-referee-\d+$/.test(candidate.kind))
    .filter((candidate) => candidate.result)
    .sort((left, right) => String(left.nodeId).localeCompare(String(right.nodeId)));
  const reviews = refereeNodes.map((candidate) => candidate.result);
  const expectedReviewerContexts = refereeNodes.map((candidate) => Object.freeze({
    nodeId: candidate.nodeId,
    reviewAttemptId: candidate.attemptId,
  }));
  const revisedReview = nodes.find((candidate) => candidate.roundIndex === node.roundIndex
    && candidate.kind === 'revision-referee-1')?.result;
  const capabilityScope = campaign?.spec?.autonomousResearchPreparation
    ?.capabilityScopeManifest || null;
  const minimumIndependentTrustDomains = Number(
    capabilityScope?.reviewerTrustDomainCount || 1,
  );
  return evaluateRefereeConvergence({
    campaignId: campaign.campaignId,
    campaignPlanHash: campaign.spec.campaignPlanHash,
    paperId: campaign.paperId,
    roundIndex: node.roundIndex,
    expectedManuscriptHash: revisedReview?.manuscriptHash || null,
    expectedReviewerContexts,
    reviews,
    qualityGates: executionResult?.qualityGates || [],
    revisionMaterialization: executionResult?.revisionMaterialization || null,
    ...(executionResult?.thresholds || {}),
    minimumReviewers: Number(campaign?.spec?.refereeCount || 3),
    minimumIndependentTrustDomains,
    requireSignedReviewerReceipts: minimumIndependentTrustDomains > 1,
    signedReviewerReceiptVerifier,
  });
}
