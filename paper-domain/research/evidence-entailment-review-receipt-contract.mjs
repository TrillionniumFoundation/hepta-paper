import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  verifyAgentExecutionReceipt,
} from '../evidence/agent-execution-receipt-contract.mjs';
import { verifyEvidenceEntailmentContract } from './evidence-entailment-contract.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;

function sha(value) {
  const candidate = String(value || '').toLowerCase();
  return SHA256.test(candidate) ? candidate : null;
}

function canonicalPerClaimReview(review, contract) {
  const source = review?.unsignedAgentExecutionReceipt?.structuredOutput
    ?.evidenceEntailmentReview || null;
  const contractClaims = Array.isArray(contract?.claims) ? contract.claims : [];
  const claims = Array.isArray(source?.claims) ? source.claims.map((claim) => Object.freeze({
    claimId: String(claim?.claimId || ''),
    renderedSentenceHash: String(claim?.renderedSentenceHash || ''),
    verdict: claim?.verdict === 'entailed' ? 'entailed' : 'not_entailed',
    rationale: String(claim?.rationale || '').normalize('NFKC').trim(),
  })) : [];
  const shapeValid = source?.version === 1
    && source?.kind === 'EvidenceEntailmentPerClaimReview'
    && source?.evidenceEntailmentContractHash === contract?.evidenceEntailmentContractHash
    && Object.keys(source || {}).sort().join(',')
      === 'claims,evidenceEntailmentContractHash,kind,version'
    && claims.length === contractClaims.length
    && claims.every((claim, index) => (
      Object.keys(source.claims[index] || {}).sort().join(',')
        === 'claimId,rationale,renderedSentenceHash,verdict'
      && claim.claimId === contractClaims[index]?.claimId
      && claim.renderedSentenceHash === contractClaims[index]?.renderedSentenceHash
      && claim.verdict === 'entailed'
      && claim.rationale.length >= 8 && claim.rationale.length <= 2_000
    ));
  const payload = {
    version: 1,
    kind: 'EvidenceEntailmentPerClaimReview',
    evidenceEntailmentContractHash:
      source?.evidenceEntailmentContractHash || null,
    claims: Object.freeze(claims),
  };
  return Object.freeze({
    ...payload,
    perClaimCoverageVerified: shapeValid,
    evidenceEntailmentPerClaimReviewHash:
      hashRecord('EvidenceEntailmentPerClaimReview', payload),
  });
}

function reviewerRows(decision, contract) {
  return Object.freeze((Array.isArray(decision?.reviews) ? decision.reviews : []).map((review) => {
    const perClaimReview = canonicalPerClaimReview(review, contract);
    const unsignedReceipt = review?.unsignedAgentExecutionReceipt || null;
    return Object.freeze({
      reviewerId: review?.reviewerId || null,
      reviewPrincipalId: review?.reviewPrincipalId || null,
      reviewerTrustDomainIdentityHash:
        review?.reviewerTrustDomainIdentityHash || null,
      reviewHash: review?.reviewHash || null,
      signedReviewerReceiptHash: review?.signedReviewerReceiptHash || null,
      signatureVerificationReceiptHash:
        review?.signatureVerificationReceiptHash || null,
      manuscriptHash: review?.manuscriptHash || null,
      verdict: review?.verdict || null,
      criticalFindingCount: Number(review?.criticalFindingCount || 0),
      evidenceEntailmentContractHash:
        perClaimReview.evidenceEntailmentContractHash,
      evidenceEntailmentPerClaimReviewHash:
        perClaimReview.evidenceEntailmentPerClaimReviewHash,
      perClaimCoverageVerified: perClaimReview.perClaimCoverageVerified,
      signedStructuredOutputBound: verifyAgentExecutionReceipt(unsignedReceipt)
        && review?.unsignedAgentExecutionReceiptHash
          === unsignedReceipt?.agentExecutionReceiptHash,
      perClaimVerdicts: perClaimReview.claims,
    });
  }));
}

function convergenceHashValid(decision) {
  const { refereeConvergenceDecisionHash: claimedHash, ...payload } = decision || {};
  return Boolean(sha(claimedHash)
    && hashRecord('RefereeConvergenceDecision', payload) === claimedHash);
}

export function buildIndependentEvidenceEntailmentReviewReceipt({
  evidenceEntailmentContract,
  refereeConvergenceDecision,
  authorPrincipalId,
  requireSignedReviewerEvidence = true,
} = {}) {
  const blockers = [];
  const contractVerification = verifyEvidenceEntailmentContract(
    evidenceEntailmentContract,
  );
  if (!contractVerification.valid) {
    blockers.push('evidence_entailment_review_contract_invalid');
    blockers.push(...contractVerification.blockers.map((blocker) => (
      `evidence_entailment_contract:${blocker}`
    )));
  }
  if (!convergenceHashValid(refereeConvergenceDecision)
    || refereeConvergenceDecision?.kind !== 'RefereeConvergenceDecision') {
    blockers.push('evidence_entailment_review_convergence_invalid');
  }
  const reviewedManuscriptHash = refereeConvergenceDecision?.expectedManuscriptHash || null;
  if (!sha(reviewedManuscriptHash)
    || refereeConvergenceDecision?.status !== 'referee_convergence_reached'
    || refereeConvergenceDecision?.accepted !== true
    || refereeConvergenceDecision?.manuscriptHashBound !== true
    || refereeConvergenceDecision?.evidenceIdentityBound !== true
    || refereeConvergenceDecision?.qualityGatesPassed !== true) {
    blockers.push('evidence_entailment_review_convergence_not_accepted');
  }
  const author = String(authorPrincipalId || '').trim() || null;
  if (!author) blockers.push('evidence_entailment_review_author_identity_missing');
  const reviewers = reviewerRows(refereeConvergenceDecision, evidenceEntailmentContract);
  const reviewerPrincipals = reviewers.map((review) => review.reviewPrincipalId);
  if (reviewers.length < 2) blockers.push('evidence_entailment_review_independent_reviewers_required');
  if (reviewerPrincipals.some((principal) => !principal)
    || new Set(reviewerPrincipals).size !== reviewerPrincipals.length
    || reviewerPrincipals.some((principal) => principal === author)) {
    blockers.push('evidence_entailment_review_principal_separation_invalid');
  }
  if (reviewers.some((review) => review.verdict !== 'accept'
    || review.criticalFindingCount !== 0
    || review.manuscriptHash !== reviewedManuscriptHash
    || !sha(review.reviewHash))) {
    blockers.push('evidence_entailment_review_verdict_binding_invalid');
  }
  if (reviewers.some((review) => review.perClaimCoverageVerified !== true
    || review.evidenceEntailmentContractHash
      !== evidenceEntailmentContract?.evidenceEntailmentContractHash
    || review.perClaimVerdicts.length !== evidenceEntailmentContract?.claims?.length)) {
    blockers.push('evidence_entailment_review_per_claim_verdict_invalid');
  }
  if (requireSignedReviewerEvidence && (
    refereeConvergenceDecision?.requireSignedReviewerReceipts !== true
    || refereeConvergenceDecision?.signedReviewerReceiptsVerified !== true
    || refereeConvergenceDecision?.reviewSemanticEvidenceBound !== true
    || reviewers.some((review) => !sha(review.signedReviewerReceiptHash)
      || !sha(review.signatureVerificationReceiptHash)
      || !sha(review.reviewerTrustDomainIdentityHash)
      || review.signedStructuredOutputBound !== true)
  )) {
    blockers.push('evidence_entailment_review_signed_evidence_invalid');
  }
  const uniqueBlockers = Object.freeze([...new Set(blockers)]);
  const payload = {
    version: 1,
    kind: 'IndependentEvidenceEntailmentReviewReceipt',
    status: uniqueBlockers.length
      ? 'independent_evidence_entailment_review_blocked'
      : 'independent_evidence_entailment_review_verified',
    paperId: evidenceEntailmentContract?.paperId || null,
    evidenceBoundManuscriptIrHash:
      evidenceEntailmentContract?.evidenceBoundManuscriptIrHash || null,
    evidenceEntailmentContractHash:
      evidenceEntailmentContract?.evidenceEntailmentContractHash || null,
    evidenceEntailmentContract: evidenceEntailmentContract || null,
    reviewedManuscriptHash,
    authorPrincipalId: author,
    refereeConvergenceDecisionHash:
      refereeConvergenceDecision?.refereeConvergenceDecisionHash || null,
    refereeConvergenceDecision: refereeConvergenceDecision || null,
    reviewerCount: reviewers.length,
    reviewers,
    requireSignedReviewerEvidence: requireSignedReviewerEvidence === true,
    machinePredicateCoverageVerified: contractVerification.valid,
    allRenderedBlocksReviewed: contractVerification.valid
      && evidenceEntailmentContract?.allRenderedBlocksCovered === true,
    typedProvenancePredicatesVerified: contractVerification.valid,
    typedSourceFieldPredicatesVerified: contractVerification.valid
      && evidenceEntailmentContract?.machineVerificationScope
        === 'typed-provenance-and-source-fields',
    semanticEntailmentReviewed: uniqueBlockers.length === 0
      && reviewers.every((review) => review.perClaimCoverageVerified === true),
    reviewerPrincipalSeparatedFromAuthor:
      Boolean(author) && reviewerPrincipals.every((principal) => principal !== author),
    openWorldScientificTruthEstablished: false,
    externalActionPerformed: false,
    blockers: uniqueBlockers,
  };
  return Object.freeze({
    ...payload,
    independentEvidenceEntailmentReviewReceiptHash:
      hashRecord('IndependentEvidenceEntailmentReviewReceipt', payload),
  });
}

export function verifyIndependentEvidenceEntailmentReviewReceipt(receipt, {
  paperId = null,
  evidenceEntailmentContractHash = null,
  evidenceBoundManuscriptIrHash = null,
  reviewedManuscriptHash = null,
  authorPrincipalId = null,
  requireSignedReviewerEvidence = true,
} = {}) {
  const blockers = [];
  const {
    independentEvidenceEntailmentReviewReceiptHash: claimedHash,
    ...payload
  } = receipt || {};
  if (!sha(claimedHash)
    || hashRecord('IndependentEvidenceEntailmentReviewReceipt', payload) !== claimedHash) {
    blockers.push('independent_evidence_entailment_review_receipt_hash_invalid');
  }
  const rebuilt = buildIndependentEvidenceEntailmentReviewReceipt({
    evidenceEntailmentContract: receipt?.evidenceEntailmentContract,
    refereeConvergenceDecision: receipt?.refereeConvergenceDecision,
    authorPrincipalId: receipt?.authorPrincipalId,
    requireSignedReviewerEvidence: receipt?.requireSignedReviewerEvidence === true,
  });
  if (JSON.stringify(rebuilt) !== JSON.stringify(receipt)) {
    blockers.push('independent_evidence_entailment_review_receipt_not_canonical');
  }
  for (const [actual, expected, blocker] of [
    [receipt?.paperId, paperId, 'independent_evidence_entailment_review_paper_mismatch'],
    [receipt?.evidenceEntailmentContractHash, evidenceEntailmentContractHash,
      'independent_evidence_entailment_review_contract_mismatch'],
    [receipt?.evidenceBoundManuscriptIrHash, evidenceBoundManuscriptIrHash,
      'independent_evidence_entailment_review_ir_mismatch'],
    [receipt?.reviewedManuscriptHash, reviewedManuscriptHash,
      'independent_evidence_entailment_review_manuscript_mismatch'],
    [receipt?.authorPrincipalId, authorPrincipalId,
      'independent_evidence_entailment_review_author_mismatch'],
  ]) {
    if (expected !== null && expected !== undefined && actual !== expected) blockers.push(blocker);
  }
  if (requireSignedReviewerEvidence && receipt?.requireSignedReviewerEvidence !== true) {
    blockers.push('independent_evidence_entailment_review_signed_evidence_required');
  }
  if (receipt?.version !== 1
    || receipt?.kind !== 'IndependentEvidenceEntailmentReviewReceipt'
    || receipt?.status !== 'independent_evidence_entailment_review_verified'
    || receipt?.machinePredicateCoverageVerified !== true
    || receipt?.typedProvenancePredicatesVerified !== true
    || receipt?.typedSourceFieldPredicatesVerified !== true
    || receipt?.allRenderedBlocksReviewed !== true
    || receipt?.semanticEntailmentReviewed !== true
    || receipt?.reviewerPrincipalSeparatedFromAuthor !== true
    || receipt?.openWorldScientificTruthEstablished !== false
    || receipt?.externalActionPerformed !== false
    || receipt?.blockers?.length) {
    blockers.push('independent_evidence_entailment_review_receipt_not_verified');
  }
  const uniqueBlockers = Object.freeze([...new Set(blockers)]);
  return Object.freeze({
    valid: uniqueBlockers.length === 0,
    status: uniqueBlockers.length
      ? 'independent_evidence_entailment_review_verification_blocked'
      : 'independent_evidence_entailment_review_verification_verified',
    independentEvidenceEntailmentReviewReceiptHash: claimedHash || null,
    evidenceEntailmentContractHash:
      receipt?.evidenceEntailmentContractHash || null,
    blockers: uniqueBlockers,
  });
}
