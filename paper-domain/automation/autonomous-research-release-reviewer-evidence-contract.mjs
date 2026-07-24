import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  deriveVerifiedSignedReviewerSemanticReview,
} from '../research/reviewer-semantic-evidence-contract.mjs';
import { evaluateRefereeConvergence } from './referee-convergence.mjs';
import {
  verifyAutonomousResearchRuntimePrincipalBinding,
} from './autonomous-research-runtime-principal-binding-contract.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;

function unique(values) {
  return [...new Set(values)];
}

function convergenceRecordValid(decision) {
  const { refereeConvergenceDecisionHash: claimedHash, ...payload } = decision || {};
  return decision?.version === 2
    && decision?.kind === 'RefereeConvergenceDecision'
    && decision?.status === 'referee_convergence_reached'
    && decision?.accepted === true
    && decision?.requireSignedReviewerReceipts === true
    && decision?.signedReviewerReceiptsVerified === true
    && decision?.evidenceIdentityBound === true
    && decision?.reviewSemanticEvidenceBound === true
    && decision?.expectedReviewerContextsBound === true
    && Array.isArray(decision?.expectedReviewerContexts)
    && decision.expectedReviewerContexts.length === decision?.reviews?.length
    && hashRecord(
      'ExpectedReviewerExecutionContexts',
      decision.expectedReviewerContexts,
    ) === decision?.expectedReviewerContextsHash
    && SHA256.test(String(decision?.campaignPlanHash || ''))
    && SHA256.test(String(claimedHash || ''))
    && hashRecord('RefereeConvergenceDecision', payload) === claimedHash;
}

function persistedReceiptsFrom(decision) {
  return (decision?.reviews || []).map((review) => review?.signedReviewerReceipt || null);
}

function expectedReceiptHashes(decision) {
  return persistedReceiptsFrom(decision).map((receipt) => (
    receipt?.signedReviewerReceiptHash || null
  ));
}

function persistedUnsignedReceiptsFrom(decision) {
  return (decision?.reviews || []).map((review) => (
    review?.unsignedAgentExecutionReceipt || null
  ));
}

function expectedUnsignedReceiptHashes(decision) {
  return persistedUnsignedReceiptsFrom(decision).map((receipt) => (
    receipt?.agentExecutionReceiptHash || null
  ));
}

function reviewerAuthorityValid(authority, runtimePrincipalBinding) {
  return typeof authority?.verifySignedReviewerReceipt === 'function'
    && authority?.researchPrincipalPoolHash
      === runtimePrincipalBinding?.researchPrincipalPoolHash
    && authority?.reviewerTrustSetHash
      === runtimePrincipalBinding?.reviewerTrustSetHash
    && authority?.reviewerSignatureVerificationPolicyHash
      === runtimePrincipalBinding?.reviewerSignatureVerificationPolicyHash;
}

function rederivedConvergence(decision, cryptographicVerifier) {
  return evaluateRefereeConvergence({
    campaignId: decision.campaignId,
    campaignPlanHash: decision.campaignPlanHash,
    paperId: decision.paperId,
    roundIndex: decision.roundIndex,
    reviews: decision.reviews,
    expectedManuscriptHash: decision.expectedManuscriptHash,
    expectedReviewerContexts: decision.expectedReviewerContexts,
    qualityGates: decision.qualityGates,
    revisionMaterialization: decision.revisionMaterialization,
    ...decision.thresholds,
    signedReviewerReceiptVerifier: cryptographicVerifier,
  });
}

function liveReviewerEvidenceBlockers(evidence, {
  runtimePrincipalBinding,
  reviewerEvidenceAuthority,
  expected = {},
} = {}) {
  const blockers = [];
  const decision = evidence?.refereeConvergenceDecision || null;
  const receipts = evidence?.signedReviewerReceipts || [];
  const receiptHashes = evidence?.signedReviewerReceiptHashes || [];
  const unsignedReceipts = evidence?.unsignedAgentExecutionReceipts || [];
  const unsignedReceiptHashes = evidence?.unsignedAgentExecutionReceiptHashes || [];
  if (!verifyAutonomousResearchRuntimePrincipalBinding(runtimePrincipalBinding)
    || evidence?.runtimePrincipalBindingHash
      !== runtimePrincipalBinding?.runtimePrincipalBindingHash) {
    blockers.push('release_reviewer_evidence_runtime_principal_binding_invalid');
  }
  if (!reviewerAuthorityValid(reviewerEvidenceAuthority, runtimePrincipalBinding)) {
    blockers.push('release_reviewer_evidence_current_reviewer_authority_invalid');
  }
  for (const field of ['campaignId', 'paperId', 'campaignPlanHash', 'expectedManuscriptHash']) {
    if (expected[field] !== undefined && evidence?.[field] !== expected[field]) {
      blockers.push(`release_reviewer_evidence_${field}_mismatch`);
    }
  }
  if (!convergenceRecordValid(decision)
    || decision?.paperId !== evidence?.paperId
    || decision?.campaignId !== evidence?.campaignId
    || decision?.campaignPlanHash !== evidence?.campaignPlanHash
    || decision?.expectedManuscriptHash !== evidence?.expectedManuscriptHash
    || decision?.refereeConvergenceDecisionHash
      !== evidence?.refereeConvergenceDecisionHash) {
    blockers.push('release_reviewer_evidence_convergence_invalid');
  }
  const decisionReceipts = persistedReceiptsFrom(decision);
  const decisionReceiptHashes = expectedReceiptHashes(decision);
  const decisionUnsignedReceipts = persistedUnsignedReceiptsFrom(decision);
  const decisionUnsignedReceiptHashes = expectedUnsignedReceiptHashes(decision);
  if (!Array.isArray(receipts) || !receipts.length
    || receipts.length !== decisionReceipts.length
    || JSON.stringify(receipts) !== JSON.stringify(decisionReceipts)
    || JSON.stringify(receiptHashes) !== JSON.stringify(decisionReceiptHashes)
    || unique(receiptHashes).length !== receiptHashes.length
    || receiptHashes.some((hash) => !SHA256.test(String(hash || '')))) {
    blockers.push('release_reviewer_evidence_receipt_set_invalid');
  }
  if (!Array.isArray(unsignedReceipts) || !unsignedReceipts.length
    || JSON.stringify(unsignedReceipts) !== JSON.stringify(decisionUnsignedReceipts)
    || JSON.stringify(unsignedReceiptHashes)
      !== JSON.stringify(decisionUnsignedReceiptHashes)
    || unique(unsignedReceiptHashes).length !== unsignedReceiptHashes.length
    || unsignedReceiptHashes.some((hash) => !SHA256.test(String(hash || '')))) {
    blockers.push('release_reviewer_evidence_unsigned_receipt_set_invalid');
  }
  if ((decision?.reviews || []).some((review, index) => {
    const receipt = receipts[index] || null;
    const expectedReviewerContext =
      decision?.expectedReviewerContexts?.[index] || {};
    let derived = null;
    try {
      derived = deriveVerifiedSignedReviewerSemanticReview(review, {
        expected: {
          campaignId: evidence?.campaignId,
          campaignPlanHash: evidence?.campaignPlanHash,
          paperId: evidence?.paperId,
          manuscriptHash: evidence?.expectedManuscriptHash,
          roundIndex: decision?.roundIndex,
          nodeId: expectedReviewerContext.nodeId,
          reviewAttemptId: expectedReviewerContext.reviewAttemptId,
        },
        cryptographicVerifier: reviewerEvidenceAuthority?.verifySignedReviewerReceipt,
      });
    } catch { /* rejected below */ }
    return !derived || JSON.stringify(derived) !== JSON.stringify(review)
      || receipt?.version !== 2
      || receipt?.cryptographicAuthorityReady !== true
      || receipt?.researchPrincipalPoolHash !== evidence?.researchPrincipalPoolHash
      || review?.researchPrincipalPoolHash !== evidence?.researchPrincipalPoolHash
      || review?.signedReviewerReceiptHash !== receipt?.signedReviewerReceiptHash
      || review?.signatureVerificationReceiptHash
        !== receipt?.signatureVerificationReceiptHash
      || review?.unsignedAgentExecutionReceiptHash
        !== unsignedReceipts[index]?.agentExecutionReceiptHash;
  })) {
    blockers.push('release_reviewer_evidence_receipt_cryptographic_verification_failed');
  }
  if (reviewerAuthorityValid(reviewerEvidenceAuthority, runtimePrincipalBinding)
    && convergenceRecordValid(decision)) {
    let rederived = null;
    try {
      rederived = rederivedConvergence(
        decision,
        reviewerEvidenceAuthority.verifySignedReviewerReceipt,
      );
    } catch { /* reported below */ }
    if (JSON.stringify(rederived) !== JSON.stringify(decision)) {
      blockers.push('release_reviewer_evidence_convergence_rederivation_failed');
    }
  }
  return Object.freeze(unique(blockers));
}

export function verifyAutonomousResearchReleaseReviewerEvidenceRecord(evidence, {
  runtimePrincipalBinding = null,
} = {}) {
  const {
    autonomousResearchReleaseReviewerEvidenceHash: claimedHash,
    ...payload
  } = evidence || {};
  const decision = evidence?.refereeConvergenceDecision || null;
  const structurallyValid = evidence?.version === 2
    && evidence?.kind === 'AutonomousResearchReleaseReviewerEvidence'
    && evidence?.status === 'autonomous_research_release_reviewer_evidence_bound'
    && SHA256.test(String(claimedHash || ''))
    && hashRecord('AutonomousResearchReleaseReviewerEvidence', payload) === claimedHash
    && convergenceRecordValid(decision)
    && evidence?.refereeConvergenceDecisionHash
      === decision?.refereeConvergenceDecisionHash
    && evidence?.campaignId === decision?.campaignId
    && evidence?.paperId === decision?.paperId
    && evidence?.campaignPlanHash === decision?.campaignPlanHash
    && evidence?.expectedManuscriptHash === decision?.expectedManuscriptHash
    && JSON.stringify(evidence?.signedReviewerReceipts)
      === JSON.stringify(persistedReceiptsFrom(decision))
    && JSON.stringify(evidence?.signedReviewerReceiptHashes)
      === JSON.stringify(expectedReceiptHashes(decision))
    && JSON.stringify(evidence?.unsignedAgentExecutionReceipts)
      === JSON.stringify(persistedUnsignedReceiptsFrom(decision))
    && JSON.stringify(evidence?.unsignedAgentExecutionReceiptHashes)
      === JSON.stringify(expectedUnsignedReceiptHashes(decision))
    && evidence?.signedReviewerReceipts?.every((receipt) => receipt?.version === 2)
    && evidence?.researchPrincipalPoolHash
      === runtimePrincipalBinding?.researchPrincipalPoolHash
    && evidence?.reviewerTrustSetHash
      === runtimePrincipalBinding?.reviewerTrustSetHash
    && evidence?.reviewerSignatureVerificationPolicyHash
      === runtimePrincipalBinding?.reviewerSignatureVerificationPolicyHash
    && evidence?.runtimePrincipalBindingHash
      === runtimePrincipalBinding?.runtimePrincipalBindingHash;
  return structurallyValid;
}

export function inspectAutonomousResearchReleaseReviewerEvidence(evidence, options = {}) {
  const blockers = [];
  if (!verifyAutonomousResearchReleaseReviewerEvidenceRecord(evidence, options)) {
    blockers.push('release_reviewer_evidence_record_invalid');
  }
  blockers.push(...liveReviewerEvidenceBlockers(evidence, options));
  return Object.freeze({
    valid: blockers.length === 0,
    blockers: Object.freeze(unique(blockers)),
  });
}

export function verifyAutonomousResearchReleaseReviewerBindingFields(binding, {
  productionScope = false,
} = {}) {
  const runtimePrincipalBinding = binding?.runtimePrincipalBinding || null;
  const releaseReviewerEvidence = binding?.releaseReviewerEvidence || null;
  const runtimeBindingValid = verifyAutonomousResearchRuntimePrincipalBinding(
    runtimePrincipalBinding,
  ) && binding?.runtimePrincipalBindingHash
    === runtimePrincipalBinding?.runtimePrincipalBindingHash;
  const reviewerEvidenceValid = verifyAutonomousResearchReleaseReviewerEvidenceRecord(
    releaseReviewerEvidence,
    { runtimePrincipalBinding },
  ) && binding?.releaseReviewerEvidenceHash
    === releaseReviewerEvidence?.autonomousResearchReleaseReviewerEvidenceHash
    && releaseReviewerEvidence?.campaignId === binding?.campaignId
    && releaseReviewerEvidence?.paperId === binding?.paperId
    && releaseReviewerEvidence?.campaignPlanHash === binding?.campaignPlanHash
    && releaseReviewerEvidence?.expectedManuscriptHash === binding?.renderedManuscriptHash;
  return productionScope
    ? runtimeBindingValid && reviewerEvidenceValid
    : (!runtimePrincipalBinding && !releaseReviewerEvidence)
      || (runtimeBindingValid && (!releaseReviewerEvidence || reviewerEvidenceValid));
}

export function buildAutonomousResearchReleaseReviewerEvidence({
  campaignId,
  paperId,
  campaignPlanHash,
  expectedManuscriptHash,
  refereeConvergenceDecision,
  runtimePrincipalBinding,
  reviewerEvidenceAuthority,
} = {}) {
  const payload = {
    version: 2,
    kind: 'AutonomousResearchReleaseReviewerEvidence',
    status: 'autonomous_research_release_reviewer_evidence_bound',
    campaignId: String(campaignId || ''),
    paperId: String(paperId || ''),
    campaignPlanHash: String(campaignPlanHash || ''),
    expectedManuscriptHash: String(expectedManuscriptHash || ''),
    runtimePrincipalBindingHash:
      runtimePrincipalBinding?.runtimePrincipalBindingHash || null,
    researchPrincipalPoolHash:
      runtimePrincipalBinding?.researchPrincipalPoolHash || null,
    reviewerTrustSetHash: runtimePrincipalBinding?.reviewerTrustSetHash || null,
    reviewerSignatureVerificationPolicyHash:
      runtimePrincipalBinding?.reviewerSignatureVerificationPolicyHash || null,
    refereeConvergenceDecisionHash:
      refereeConvergenceDecision?.refereeConvergenceDecisionHash || null,
    refereeConvergenceDecision,
    signedReviewerReceiptHashes: Object.freeze(
      expectedReceiptHashes(refereeConvergenceDecision),
    ),
    signedReviewerReceipts: Object.freeze(
      persistedReceiptsFrom(refereeConvergenceDecision),
    ),
    unsignedAgentExecutionReceiptHashes: Object.freeze(
      expectedUnsignedReceiptHashes(refereeConvergenceDecision),
    ),
    unsignedAgentExecutionReceipts: Object.freeze(
      persistedUnsignedReceiptsFrom(refereeConvergenceDecision),
    ),
  };
  const evidence = Object.freeze({
    ...payload,
    autonomousResearchReleaseReviewerEvidenceHash: hashRecord(
      'AutonomousResearchReleaseReviewerEvidence',
      payload,
    ),
  });
  const inspection = inspectAutonomousResearchReleaseReviewerEvidence(evidence, {
    runtimePrincipalBinding,
    reviewerEvidenceAuthority,
    expected: { campaignId, paperId, campaignPlanHash, expectedManuscriptHash },
  });
  if (!inspection.valid) {
    throw new Error(
      `autonomous_research_release_reviewer_evidence_invalid:${inspection.blockers.join(',')}`,
    );
  }
  return evidence;
}
