import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  deriveVerifiedIsolatedReviewerSemanticReview,
  deriveVerifiedSignedReviewerSemanticReview,
} from '../research/reviewer-semantic-evidence-contract.mjs';

function variance(values, mean) {
  return values.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / Math.max(1, values.length);
}

function canonicalExpectedReviewerContexts(contexts) {
  return (Array.isArray(contexts) ? contexts : []).map((context) => Object.freeze({
    nodeId: String(context?.nodeId || ''),
    reviewAttemptId: String(context?.reviewAttemptId || ''),
  }));
}

export function evaluateRefereeConvergence({
  campaignId = null,
  campaignPlanHash = null,
  paperId,
  roundIndex,
  reviews = [],
  minimumReviewers = 3,
  minimumMeanScore = 0.8,
  minimumAcceptRatio = 2 / 3,
  maximumVariance = 0.04,
  expectedManuscriptHash = null,
  expectedReviewerContexts = [],
  minimumRoundIndex = 1,
  qualityGates = [],
  revisionMaterialization = null,
  minimumIndependentTrustDomains = 1,
  requireSignedReviewerReceipts = false,
  requireSessionBoundReviewerReceipts = false,
  signedReviewerReceiptVerifier = null,
  sessionReviewerReceiptVerifier = null,
} = {}) {
  if (requireSignedReviewerReceipts === true
    && requireSessionBoundReviewerReceipts === true) {
    throw new Error('referee_convergence_reviewer_evidence_mode_ambiguous');
  }
  const reviewerEvidenceReceiptRequired = requireSignedReviewerReceipts === true
    || requireSessionBoundReviewerReceipts === true;
  const strictPrincipalEvidence = Number(minimumIndependentTrustDomains) > 1
    || requireSignedReviewerReceipts === true;
  const canonicalReviewerContexts = canonicalExpectedReviewerContexts(
    expectedReviewerContexts,
  );
  const expectedReviewerContextsBound = reviewerEvidenceReceiptRequired
    && canonicalReviewerContexts.length === reviews.length
    && canonicalReviewerContexts.every((context) => (
      context.nodeId && context.reviewAttemptId
    ))
    && new Set(canonicalReviewerContexts.map((context) => context.nodeId)).size
      === canonicalReviewerContexts.length
    && new Set(canonicalReviewerContexts.map((context) => context.reviewAttemptId)).size
      === canonicalReviewerContexts.length
    && JSON.stringify(canonicalReviewerContexts)
      === JSON.stringify(expectedReviewerContexts);
  const semanticReviews = reviewerEvidenceReceiptRequired
    ? reviews.map((review, index) => {
      const expectedReviewerContext = canonicalReviewerContexts[index] || {};
      try {
        const expected = {
          campaignId,
          campaignPlanHash,
          paperId,
          roundIndex: Number(roundIndex || 1),
          manuscriptHash: expectedManuscriptHash,
          nodeId: expectedReviewerContext.nodeId,
          reviewAttemptId: expectedReviewerContext.reviewAttemptId,
        };
        return requireSignedReviewerReceipts === true
          ? deriveVerifiedSignedReviewerSemanticReview(review, {
            expected,
            cryptographicVerifier: signedReviewerReceiptVerifier,
          })
          : deriveVerifiedIsolatedReviewerSemanticReview(review, {
            expected,
            sessionVerifier: sessionReviewerReceiptVerifier,
          });
      } catch { return null; }
    }) : [];
  const normalized = reviews.map((review, index) => semanticReviews[index] || ({
    reviewerId: String(review.reviewerId || 'unknown'),
    verdict: review.verdict === 'accept' ? 'accept' : 'revise',
    score: Math.max(0, Math.min(1, Number(review.score || 0))),
    criticalFindingCount: Math.max(0, Number(review.criticalFindingCount || 0)),
    reviewHash: review.reviewHash || null,
    manuscriptHash: review.manuscriptHash || null,
    childSessionId: review.childSessionId || review.sessionKey || null,
    promptHash: review.promptHash || null,
    resolvedModel: review.resolvedModel || null,
    reviewPrincipalId: review.reviewPrincipalId
      || (strictPrincipalEvidence ? null : review.reviewerId) || null,
    reviewPrincipalDescriptorHash: review.reviewPrincipalDescriptorHash || null,
    reviewerProviderAccountIdentityHash:
      review.reviewerProviderAccountIdentityHash || null,
    reviewerCredentialRootIdentityHash:
      review.reviewerCredentialRootIdentityHash || null,
    reviewerTrustDomainIdentityHash:
      review.reviewerTrustDomainIdentityHash || null,
    reviewerSignerIdentityHash: review.reviewerSignerIdentityHash || null,
    signedReviewerReceiptHash: review.signedReviewerReceiptHash || null,
    signedReviewerReceipt: review.signedReviewerReceipt || null,
    unsignedAgentExecutionReceiptHash:
      review.unsignedAgentExecutionReceiptHash || null,
    ...(requireSessionBoundReviewerReceipts === true ? {
      unsignedAgentExecutionReceipt:
        review.unsignedAgentExecutionReceipt || null,
    } : {}),
    signatureVerificationReceiptHash:
      review.signatureVerificationReceiptHash || null,
    researchPrincipalPoolHash: review.researchPrincipalPoolHash || null,
    ...(requireSessionBoundReviewerReceipts === true ? {
      reviewEvidenceMode: review.reviewEvidenceMode || null,
    } : {}),
  }));
  const scores = normalized.map((review) => review.score);
  const meanScore = scores.reduce((sum, score) => sum + score, 0) / Math.max(1, scores.length);
  const scoreVariance = variance(scores, meanScore);
  const acceptCount = normalized.filter((review) => review.verdict === 'accept').length;
  const acceptRatio = acceptCount / Math.max(1, normalized.length);
  const criticalFindingCount = normalized.reduce((sum, review) => sum + review.criticalFindingCount, 0);
  const manuscriptHashBound = Boolean(expectedManuscriptHash)
    && normalized.every((review) => review.manuscriptHash === expectedManuscriptHash);
  const uniqueNonEmpty = (values) => values.every(Boolean) && new Set(values).size === values.length;
  const reviewerIdentityUnique = uniqueNonEmpty(normalized.map((review) => review.reviewerId === 'unknown' ? null : review.reviewerId));
  const reviewerSessionUnique = uniqueNonEmpty(normalized.map((review) => review.childSessionId));
  const reviewHashUnique = uniqueNonEmpty(normalized.map((review) => review.reviewHash));
  const reviewPrincipalIdentityUnique = uniqueNonEmpty(
    normalized.map((review) => review.reviewPrincipalId),
  );
  const trustDomainIdentities = normalized.map((review) => review.reviewerTrustDomainIdentityHash)
    .filter(Boolean);
  const providerAccountIdentities = normalized
    .map((review) => review.reviewerProviderAccountIdentityHash).filter(Boolean);
  const credentialRootIdentities = normalized
    .map((review) => review.reviewerCredentialRootIdentityHash).filter(Boolean);
  const reviewerTrustDomainCount = new Set(trustDomainIdentities).size;
  const reviewerProviderAccountCount = new Set(providerAccountIdentities).size;
  const reviewerCredentialRootCount = new Set(credentialRootIdentities).size;
  const reviewerPrincipalSeparationBound = !strictPrincipalEvidence || (
    reviewPrincipalIdentityUnique
    && reviewerTrustDomainCount >= Number(minimumIndependentTrustDomains)
    && reviewerProviderAccountCount >= Number(minimumIndependentTrustDomains)
    && reviewerCredentialRootCount >= Number(minimumIndependentTrustDomains)
  );
  const reviewSemanticEvidenceBound = reviewerEvidenceReceiptRequired
    && expectedReviewerContextsBound
    && semanticReviews.length === reviews.length && semanticReviews.every(Boolean);
  const signedReviewerReceiptsVerified = requireSignedReviewerReceipts !== true
    || reviewSemanticEvidenceBound;
  const sessionBoundReviewerReceiptsVerified =
    requireSessionBoundReviewerReceipts !== true || reviewSemanticEvidenceBound;
  const evidenceIdentityBound = reviewerIdentityUnique && reviewerSessionUnique && reviewHashUnique
    && reviewerPrincipalSeparationBound && signedReviewerReceiptsVerified
    && sessionBoundReviewerReceiptsVerified;
  const normalizedQualityGates = (Array.isArray(qualityGates) ? qualityGates : []).map((gate) => ({
    kind: gate?.kind || 'UnknownQualityGate',
    status: gate?.status || null,
    passed: gate?.passed === true,
    blockers: Array.isArray(gate?.blockers) ? gate.blockers.map(String) : [],
    receiptHash: gate?.theoremManuscriptReadinessPolicyHash || gate?.paperQualityPolicyHash || gate?.manuscriptPromotionGateHash || gate?.receiptHash || null,
  }));
  const qualityGatesPassed = normalizedQualityGates.every((gate) => gate.passed);
  const qualityGateBlockers = normalizedQualityGates.flatMap((gate) => gate.blockers);
  const accepted = normalized.length >= minimumReviewers
    && Number(roundIndex || 1) >= Math.max(1, Number(minimumRoundIndex || 1))
    && meanScore >= minimumMeanScore
    && acceptRatio >= minimumAcceptRatio
    && scoreVariance <= maximumVariance
    && criticalFindingCount === 0
    && manuscriptHashBound
    && evidenceIdentityBound
    && qualityGatesPassed;
  const payload = {
    version: requireSignedReviewerReceipts === true
      ? 2 : requireSessionBoundReviewerReceipts === true ? 3 : 1,
    kind: 'RefereeConvergenceDecision',
    campaignId,
    campaignPlanHash,
    paperId,
    roundIndex: Number(roundIndex || 1),
    status: accepted ? 'referee_convergence_reached' : 'referee_revision_required',
    accepted,
    reviewerCount: normalized.length,
    acceptCount,
    acceptRatio,
    meanScore,
    scoreVariance,
    criticalFindingCount,
    expectedManuscriptHash,
    manuscriptHashBound,
    reviewerIdentityUnique,
    reviewerSessionUnique,
    reviewHashUnique,
    reviewPrincipalIdentityUnique,
    reviewerTrustDomainCount,
    reviewerProviderAccountCount,
    reviewerCredentialRootCount,
    minimumIndependentTrustDomains: Number(minimumIndependentTrustDomains),
    reviewerPrincipalSeparationBound,
    requireSignedReviewerReceipts: requireSignedReviewerReceipts === true,
    signedReviewerReceiptsVerified,
    ...(requireSessionBoundReviewerReceipts === true ? {
      requireSessionBoundReviewerReceipts: true,
      sessionBoundReviewerReceiptsVerified,
    } : {}),
    reviewSemanticEvidenceBound,
    ...(reviewerEvidenceReceiptRequired ? {
      expectedReviewerContextsBound,
      expectedReviewerContextsHash: hashRecord(
        'ExpectedReviewerExecutionContexts',
        canonicalReviewerContexts,
      ),
      expectedReviewerContexts: canonicalReviewerContexts,
    } : {}),
    evidenceIdentityBound,
    qualityGatesPassed,
    qualityGateBlockers,
    qualityGates: normalizedQualityGates,
    revisionMaterialization: revisionMaterialization && typeof revisionMaterialization === 'object'
      ? Object.freeze({ ...revisionMaterialization }) : null,
    reviews: normalized,
    thresholds: {
      minimumReviewers,
      minimumMeanScore,
      minimumAcceptRatio,
      maximumVariance,
      minimumRoundIndex: Math.max(1, Number(minimumRoundIndex || 1)),
      minimumIndependentTrustDomains: Number(minimumIndependentTrustDomains),
      requireSignedReviewerReceipts: requireSignedReviewerReceipts === true,
      ...(requireSessionBoundReviewerReceipts === true ? {
        requireSessionBoundReviewerReceipts: true,
      } : {}),
    },
    academicAcceptanceGranted: false,
    externalActionPerformed: false,
  };
  return Object.freeze({ ...payload, refereeConvergenceDecisionHash: hashRecord('RefereeConvergenceDecision', payload) });
}

export function requiredRevalidationForChanges(paths = []) {
  const values = paths.map(String);
  const code = values.some((value) => /\.(py|r|R|jl|mjs|js|ts|lean)$/.test(value));
  const empirical = code || values.some((value) => /(data|experiment|result|table|figure)/i.test(value));
  const compile = values.some((value) => /\.(tex|bib|cls|sty)$/.test(value)) || empirical;
  const artifacts = empirical || values.some((value) => /(table|figure|plot|result)/i.test(value));
  return Object.freeze({ code, empirical, compile, citationCheck: compile, artifacts, required: [
    ...(code ? ['revalidate-code'] : []),
    ...(empirical ? ['revalidate-empirical'] : []),
    ...(compile ? ['revalidate-compile'] : []),
    ...(compile ? ['revalidate-citations'] : []),
    ...(artifacts ? ['revalidate-artifacts'] : []),
  ] });
}
