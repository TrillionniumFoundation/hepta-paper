import { hasExactObjectKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  verifyAgentExecutionReceipt,
} from '../evidence/agent-execution-receipt-contract.mjs';
import {
  verifySignedReviewerReceipt,
} from './signed-reviewer-receipt-contract.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,191}$/;
const CONTEXT_KEYS = Object.freeze([
  'campaignId', 'campaignPlanHash', 'kind', 'manuscriptHash', 'nodeId', 'paperId',
  'reviewAttemptId', 'reviewerExecutionAuthorityContextHash', 'roundIndex', 'version',
]);

function canonicalText(value, maximum = 512) {
  const selected = String(value || '').normalize('NFKC').trim();
  return selected && selected.length <= maximum ? selected : null;
}

export function buildReviewerExecutionAuthorityContext({
  campaignId,
  campaignPlanHash,
  paperId,
  nodeId,
  roundIndex,
  reviewAttemptId,
  manuscriptHash,
} = {}) {
  const payload = {
    version: 1,
    kind: 'ReviewerExecutionAuthorityContext',
    campaignId: String(campaignId || ''),
    campaignPlanHash: String(campaignPlanHash || ''),
    paperId: String(paperId || ''),
    nodeId: String(nodeId || ''),
    roundIndex: Number(roundIndex || 0),
    reviewAttemptId: String(reviewAttemptId || ''),
    manuscriptHash: String(manuscriptHash || ''),
  };
  if (![payload.campaignId, payload.paperId, payload.nodeId, payload.reviewAttemptId]
    .every((value) => SAFE_ID.test(value))
    || ![payload.campaignPlanHash, payload.manuscriptHash]
      .every((value) => SHA256.test(value))
    || !Number.isSafeInteger(payload.roundIndex) || payload.roundIndex < 1) {
    throw new Error('reviewer_execution_authority_context_invalid');
  }
  return Object.freeze({
    ...payload,
    reviewerExecutionAuthorityContextHash: hashRecord(
      'ReviewerExecutionAuthorityContext',
      payload,
    ),
  });
}

export function verifyReviewerExecutionAuthorityContext(context, expected = {}) {
  if (!hasExactObjectKeys(context, CONTEXT_KEYS)) return false;
  let rebuilt;
  try { rebuilt = buildReviewerExecutionAuthorityContext(context); }
  catch { return false; }
  return JSON.stringify(rebuilt) === JSON.stringify(context)
    && Object.entries(expected).every(([field, value]) => (
      value === null || value === undefined || rebuilt[field] === value
    ));
}

function semanticOutput(receipt) {
  const output = receipt?.structuredOutput;
  const verdict = output?.verdict;
  const score = Number(output?.score);
  const criticalFindingCount = Number(output?.criticalFindingCount);
  const findings = Array.isArray(output?.findings) ? output.findings.map(String) : null;
  const summary = canonicalText(output?.summary, 8_000);
  if (!['accept', 'revise'].includes(verdict)
    || !Number.isFinite(score) || score < 0 || score > 1
    || !Number.isSafeInteger(criticalFindingCount) || criticalFindingCount < 0
    || !findings || findings.some((finding) => !canonicalText(finding, 8_000))
    || !summary) {
    throw new Error('signed_reviewer_semantic_output_invalid');
  }
  return Object.freeze({ verdict, score, criticalFindingCount, findings, summary });
}

function semanticSubjectPayload({
  unsignedAgentExecutionReceiptHash,
  principalDescriptorHash,
  researchPrincipalPoolHash,
  context,
  semantics,
  reviewHash,
  childSessionId,
  promptHash,
  resolvedModel,
} = {}) {
  return {
    unsignedAgentExecutionReceiptHash,
    principalDescriptorHash,
    researchPrincipalPoolHash,
    campaignId: context.campaignId,
    campaignPlanHash: context.campaignPlanHash,
    paperId: context.paperId,
    nodeId: context.nodeId,
    roundIndex: context.roundIndex,
    reviewAttemptId: context.reviewAttemptId,
    manuscriptHash: context.manuscriptHash,
    verdict: semantics.verdict,
    score: semantics.score,
    criticalFindingCount: semantics.criticalFindingCount,
    reviewHash,
    childSessionId,
    promptHash,
    resolvedModel,
  };
}

export function reviewerSemanticReviewHash({
  unsignedAgentExecutionReceipt,
} = {}) {
  if (!verifyAgentExecutionReceipt(unsignedAgentExecutionReceipt)) {
    throw new Error('reviewer_semantic_review_unsigned_receipt_invalid');
  }
  const context = unsignedAgentExecutionReceipt.reviewerExecutionAuthorityContext;
  const semantics = semanticOutput(unsignedAgentExecutionReceipt);
  const childSessionId = canonicalText(
    unsignedAgentExecutionReceipt.childSessionId
      || unsignedAgentExecutionReceipt.sessionId
      || unsignedAgentExecutionReceipt.sessionKey,
  );
  const promptHash = String(unsignedAgentExecutionReceipt.promptHash || '');
  const resolvedModel = canonicalText(
    unsignedAgentExecutionReceipt.resolvedModel || unsignedAgentExecutionReceipt.model,
  );
  if (!verifyReviewerExecutionAuthorityContext(context)
    || unsignedAgentExecutionReceipt.role !== 'independent-review'
    || !SHA256.test(promptHash) || !childSessionId || !resolvedModel) {
    throw new Error('reviewer_semantic_review_invalid');
  }
  return hashRecord('ReviewerSemanticReview', {
    campaignId: context.campaignId,
    campaignPlanHash: context.campaignPlanHash,
    paperId: context.paperId,
    nodeId: context.nodeId,
    roundIndex: context.roundIndex,
    reviewAttemptId: context.reviewAttemptId,
    manuscriptHash: context.manuscriptHash,
    reviewRole: unsignedAgentExecutionReceipt.role,
    ...semantics,
    childSessionId,
    promptHash,
    resolvedModel,
  });
}

export function reviewerSemanticReceiptSigningSubject({
  unsignedAgentExecutionReceipt,
  principalDescriptorHash,
  researchPrincipalPoolHash,
} = {}) {
  if (!verifyAgentExecutionReceipt(unsignedAgentExecutionReceipt)) {
    throw new Error('reviewer_semantic_signing_subject_unsigned_receipt_invalid');
  }
  const unsignedAgentExecutionReceiptHash =
    unsignedAgentExecutionReceipt.agentExecutionReceiptHash;
  const context = unsignedAgentExecutionReceipt.reviewerExecutionAuthorityContext;
  const semantics = semanticOutput(unsignedAgentExecutionReceipt);
  const childSessionId = canonicalText(
    unsignedAgentExecutionReceipt.childSessionId
      || unsignedAgentExecutionReceipt.sessionId
      || unsignedAgentExecutionReceipt.sessionKey,
  );
  const promptHash = String(unsignedAgentExecutionReceipt.promptHash || '');
  const resolvedModel = canonicalText(
    unsignedAgentExecutionReceipt.resolvedModel || unsignedAgentExecutionReceipt.model,
  );
  if (!verifyReviewerExecutionAuthorityContext(context)
    || ![unsignedAgentExecutionReceiptHash, principalDescriptorHash,
      researchPrincipalPoolHash, promptHash].every((value) => SHA256.test(String(value || '')))
    || unsignedAgentExecutionReceipt.reviewPrincipalDescriptorHash
      !== principalDescriptorHash
    || unsignedAgentExecutionReceipt.researchPrincipalPoolHash
      !== researchPrincipalPoolHash
    || !SAFE_ID.test(String(unsignedAgentExecutionReceipt.reviewPrincipalId || ''))
    || ![
      unsignedAgentExecutionReceipt.reviewerProviderAccountIdentityHash,
      unsignedAgentExecutionReceipt.reviewerCredentialRootIdentityHash,
      unsignedAgentExecutionReceipt.reviewerTrustDomainIdentityHash,
      unsignedAgentExecutionReceipt.reviewerSignerIdentityHash,
      unsignedAgentExecutionReceipt.reviewerTrustSetHash,
      unsignedAgentExecutionReceipt.reviewerSignatureVerificationPolicyHash,
    ].every((value) => SHA256.test(String(value || '')))
    || unsignedAgentExecutionReceipt.reviewerCryptographicAuthorityReady !== true
    || unsignedAgentExecutionReceipt.reviewerIdentityIndependenceReady !== true
    || !childSessionId || !resolvedModel) {
    throw new Error('reviewer_semantic_signing_subject_invalid');
  }
  return hashRecord('ReviewerSemanticReceiptSigningSubjectV2', semanticSubjectPayload({
    unsignedAgentExecutionReceiptHash,
    principalDescriptorHash,
    researchPrincipalPoolHash,
    context,
    semantics,
    reviewHash: reviewerSemanticReviewHash({ unsignedAgentExecutionReceipt }),
    childSessionId,
    promptHash,
    resolvedModel,
  }));
}

function outerSemanticsMatch(review, canonical) {
  return [
    'verdict', 'score', 'criticalFindingCount', 'reviewHash', 'manuscriptHash',
    'childSessionId', 'promptHash', 'resolvedModel', 'reviewAttemptId',
    'campaignId', 'campaignPlanHash', 'paperId', 'nodeId', 'roundIndex',
  ].every((field) => review?.[field] === canonical[field]);
}

export function deriveVerifiedSignedReviewerSemanticReview(review, {
  expected = {},
  cryptographicVerifier = null,
} = {}) {
  const unsigned = review?.unsignedAgentExecutionReceipt;
  if (!verifyAgentExecutionReceipt(unsigned)
    || review?.unsignedAgentExecutionReceiptHash !== unsigned?.agentExecutionReceiptHash) {
    throw new Error('signed_reviewer_unsigned_execution_receipt_invalid');
  }
  const context = unsigned.reviewerExecutionAuthorityContext;
  if (!verifyReviewerExecutionAuthorityContext(context, expected)) {
    throw new Error('signed_reviewer_execution_authority_context_invalid');
  }
  const semantics = semanticOutput(unsigned);
  const childSessionId = canonicalText(
    unsigned.childSessionId || unsigned.sessionId || unsigned.sessionKey,
  );
  const promptHash = String(unsigned.promptHash || '');
  const resolvedModel = canonicalText(unsigned.resolvedModel || unsigned.model);
  const reviewHash = reviewerSemanticReviewHash({
    unsignedAgentExecutionReceipt: unsigned,
  });
  const subjectHash = reviewerSemanticReceiptSigningSubject({
    unsignedAgentExecutionReceipt: unsigned,
    principalDescriptorHash: unsigned.reviewPrincipalDescriptorHash,
    researchPrincipalPoolHash: unsigned.researchPrincipalPoolHash,
  });
  if (review?.signedReviewerReceiptHash
      !== review?.signedReviewerReceipt?.signedReviewerReceiptHash
    || review?.signatureVerificationReceiptHash
      !== review?.signedReviewerReceipt?.signatureVerificationReceiptHash
    || !verifySignedReviewerReceipt(review.signedReviewerReceipt, {
      subjectHash,
      principalId: unsigned.reviewPrincipalId,
      principalDescriptorHash: unsigned.reviewPrincipalDescriptorHash,
      researchPrincipalPoolHash: unsigned.researchPrincipalPoolHash,
      signerIdentityHash: unsigned.reviewerSignerIdentityHash,
    }, { cryptographicVerifier })) {
    throw new Error('signed_reviewer_semantic_signature_invalid');
  }
  const canonical = Object.freeze({
    reviewerId: unsigned.reviewPrincipalId,
    role: unsigned.role || 'independent-review',
    ...semantics,
    reviewHash,
    manuscriptHash: context.manuscriptHash,
    childSessionId,
    promptHash,
    resolvedModel,
    reviewPrincipalId: unsigned.reviewPrincipalId,
    reviewPrincipalDescriptorHash: unsigned.reviewPrincipalDescriptorHash,
    reviewerProviderAccountIdentityHash: unsigned.reviewerProviderAccountIdentityHash,
    reviewerCredentialRootIdentityHash: unsigned.reviewerCredentialRootIdentityHash,
    reviewerTrustDomainIdentityHash: unsigned.reviewerTrustDomainIdentityHash,
    reviewerSignerIdentityHash: unsigned.reviewerSignerIdentityHash,
    signedReviewerReceiptHash: review.signedReviewerReceiptHash,
    signedReviewerReceipt: review.signedReviewerReceipt,
    unsignedAgentExecutionReceiptHash: unsigned.agentExecutionReceiptHash,
    unsignedAgentExecutionReceipt: unsigned,
    signatureVerificationReceiptHash: review.signatureVerificationReceiptHash,
    researchPrincipalPoolHash: unsigned.researchPrincipalPoolHash,
    reviewAttemptId: context.reviewAttemptId,
    campaignId: context.campaignId,
    campaignPlanHash: context.campaignPlanHash,
    paperId: context.paperId,
    nodeId: context.nodeId,
    roundIndex: context.roundIndex,
    selectedExecutorId: unsigned.selectedExecutorId || unsigned.executorId || null,
  });
  if (!outerSemanticsMatch(review, canonical)) {
    throw new Error('signed_reviewer_outer_semantics_mismatch');
  }
  return canonical;
}
