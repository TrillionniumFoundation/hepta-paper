import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  deriveVerifiedIsolatedReviewerSemanticReview,
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
  const signedMode = decision?.version === 2
    && decision?.requireSignedReviewerReceipts === true
    && decision?.signedReviewerReceiptsVerified === true;
  const sessionMode = decision?.version === 3
    && decision?.requireSignedReviewerReceipts === false
    && decision?.requireSessionBoundReviewerReceipts === true
    && decision?.sessionBoundReviewerReceiptsVerified === true;
  return (signedMode || sessionMode)
    && decision?.kind === 'RefereeConvergenceDecision'
    && decision?.status === 'referee_convergence_reached'
    && decision?.accepted === true
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

function reviewerEvidenceMode(decision) {
  if (decision?.version === 2
    && decision?.requireSignedReviewerReceipts === true) {
    return 'external-cryptographic-authority';
  }
  if (decision?.version === 3
    && decision?.requireSessionBoundReviewerReceipts === true) {
    return 'fresh-isolated-session';
  }
  return null;
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

function reviewerAuthorityValid(authority, runtimePrincipalBinding, mode) {
  const verifierReady = mode === 'fresh-isolated-session'
    ? authority?.authorityMode === 'fresh-isolated-session'
      && authority?.sessionIsolationReady === true
      && authority?.identityIndependenceReady === true
      && typeof authority?.verifySessionReviewerReceipt === 'function'
    : typeof authority?.verifySignedReviewerReceipt === 'function';
  return verifierReady
    && authority?.researchPrincipalPoolHash
      === runtimePrincipalBinding?.researchPrincipalPoolHash
    && authority?.reviewerTrustSetHash
      === runtimePrincipalBinding?.reviewerTrustSetHash
    && authority?.reviewerSignatureVerificationPolicyHash
      === runtimePrincipalBinding?.reviewerSignatureVerificationPolicyHash;
}

function rederivedConvergence(decision, authority) {
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
    signedReviewerReceiptVerifier: authority?.verifySignedReviewerReceipt,
    sessionReviewerReceiptVerifier: authority?.verifySessionReviewerReceipt,
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
  const evidenceMode = reviewerEvidenceMode(decision);
  if (!verifyAutonomousResearchRuntimePrincipalBinding(runtimePrincipalBinding)
    || evidence?.runtimePrincipalBindingHash
      !== runtimePrincipalBinding?.runtimePrincipalBindingHash) {
    blockers.push('release_reviewer_evidence_runtime_principal_binding_invalid');
  }
  if (!reviewerAuthorityValid(
    reviewerEvidenceAuthority,
    runtimePrincipalBinding,
    evidenceMode,
  )) {
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
  const signedReceiptSetValid = evidenceMode === 'fresh-isolated-session'
    ? Array.isArray(receipts)
      && receipts.length === decisionReceipts.length
      && receipts.every((receipt) => receipt === null)
      && JSON.stringify(receipts) === JSON.stringify(decisionReceipts)
      && JSON.stringify(receiptHashes) === JSON.stringify(decisionReceiptHashes)
      && receiptHashes.every((hash) => hash === null)
    : Array.isArray(receipts) && receipts.length > 0
      && receipts.length === decisionReceipts.length
      && JSON.stringify(receipts) === JSON.stringify(decisionReceipts)
      && JSON.stringify(receiptHashes) === JSON.stringify(decisionReceiptHashes)
      && unique(receiptHashes).length === receiptHashes.length
      && receiptHashes.every((hash) => SHA256.test(String(hash || '')));
  if (!signedReceiptSetValid) {
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
    const signedReceipt = receipts[index] || null;
    const expectedReviewerContext =
      decision?.expectedReviewerContexts?.[index] || {};
    let derived = null;
    try {
      const expected = {
        campaignId: evidence?.campaignId,
        campaignPlanHash: evidence?.campaignPlanHash,
        paperId: evidence?.paperId,
        manuscriptHash: evidence?.expectedManuscriptHash,
        roundIndex: decision?.roundIndex,
        nodeId: expectedReviewerContext.nodeId,
        reviewAttemptId: expectedReviewerContext.reviewAttemptId,
      };
      derived = evidenceMode === 'fresh-isolated-session'
        ? deriveVerifiedIsolatedReviewerSemanticReview(review, {
          expected,
          sessionVerifier: reviewerEvidenceAuthority?.verifySessionReviewerReceipt,
        })
        : deriveVerifiedSignedReviewerSemanticReview(review, {
          expected,
          cryptographicVerifier: reviewerEvidenceAuthority?.verifySignedReviewerReceipt,
        });
    } catch { /* rejected below */ }
    return !derived || JSON.stringify(derived) !== JSON.stringify(review)
      || (evidenceMode !== 'fresh-isolated-session'
        && (signedReceipt?.version !== 2
          || signedReceipt?.cryptographicAuthorityReady !== true))
      || (evidenceMode === 'fresh-isolated-session'
        && (signedReceipt !== null
          || review?.reviewEvidenceMode !== 'fresh-isolated-session'))
      || (evidenceMode !== 'fresh-isolated-session'
        && signedReceipt?.researchPrincipalPoolHash
          !== evidence?.researchPrincipalPoolHash)
      || review?.researchPrincipalPoolHash !== evidence?.researchPrincipalPoolHash
      || (evidenceMode !== 'fresh-isolated-session'
        && (review?.signedReviewerReceiptHash
          !== signedReceipt?.signedReviewerReceiptHash
          || review?.signatureVerificationReceiptHash
            !== signedReceipt?.signatureVerificationReceiptHash))
      || review?.unsignedAgentExecutionReceiptHash
        !== unsignedReceipts[index]?.agentExecutionReceiptHash;
  })) {
    blockers.push(evidenceMode === 'fresh-isolated-session'
      ? 'release_reviewer_evidence_session_verification_failed'
      : 'release_reviewer_evidence_receipt_cryptographic_verification_failed');
  }
  if (reviewerAuthorityValid(
    reviewerEvidenceAuthority,
    runtimePrincipalBinding,
    evidenceMode,
  )
    && convergenceRecordValid(decision)) {
    let rederived = null;
    try {
      rederived = rederivedConvergence(decision, reviewerEvidenceAuthority);
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
  const evidenceMode = reviewerEvidenceMode(decision);
  const structurallyValid = [2, 3].includes(evidence?.version)
    && evidence?.version === (evidenceMode === 'fresh-isolated-session' ? 3 : 2)
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
    && (evidenceMode === 'fresh-isolated-session'
      ? evidence?.signedReviewerReceipts?.every((receipt) => receipt === null)
        && evidence?.signedReviewerReceiptHashes?.every((hash) => hash === null)
        && evidence?.reviewEvidenceMode === 'fresh-isolated-session'
      : evidence?.signedReviewerReceipts?.every((receipt) => receipt?.version === 2))
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
  const evidenceMode = reviewerEvidenceMode(refereeConvergenceDecision);
  const payload = {
    version: evidenceMode === 'fresh-isolated-session' ? 3 : 2,
    kind: 'AutonomousResearchReleaseReviewerEvidence',
    status: 'autonomous_research_release_reviewer_evidence_bound',
    ...(evidenceMode === 'fresh-isolated-session' ? {
      reviewEvidenceMode: evidenceMode,
    } : {}),
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
