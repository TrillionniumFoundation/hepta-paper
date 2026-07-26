import { hasExactObjectKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  verifyAgentExecutionReceipt,
} from '../evidence/agent-execution-receipt-contract.mjs';
import {
  verifyExternalResearchReplayRequest,
  verifyExternalResearchReplayReceipt,
} from './external-research-replay-contract.mjs';
import {
  reviewerReceiptSigningSubject,
} from './signed-reviewer-receipt-contract.mjs';
import {
  REQUIRED_GENERIC_FORMAL_DOMAIN_PROFILE_IDS,
} from './formal-domain-profile-registry.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const REVIEW_KEYS = Object.freeze([
  'blockers', 'formalDomainCoverageReceiptHash', 'kind',
  'reviewedProfileEvidenceHashes', 'reviewedProfileIds',
  'status', 'summary', 'version', 'externalReplayReceiptHash',
]);
const EVIDENCE_KEYS = Object.freeze([
  'blockers', 'externalReplayReceipt', 'externalReplayRequest',
  'formalDomainCoverageReceiptHash', 'formalDomainIndependentReviewAgentReceipt',
  'formalDomainQualificationExternalEvidenceHash', 'kind', 'status', 'version',
]);

function expectedProfileEvidenceHashes(coverageReceipt) {
  return Object.freeze([...(coverageReceipt?.profileEvidence || [])]
    .sort((left, right) => left.profileId.localeCompare(right.profileId))
    .map((item) => item.formalProofSearchOperationReceiptHash));
}
function expectedReplayHashes(coverageReceipt) {
  return Object.freeze([...(coverageReceipt?.profileEvidence || [])]
    .map((item) => item.replayExecutionReceiptHash).sort());
}

function independentReviewValid({
  receipt,
  coverageReceipt,
  externalReplayReceipt,
  reviewerReceiptVerificationAuthority,
} = {}) {
  const output = receipt?.structuredOutput;
  const signedReceipt = receipt?.signedReviewerReceipt;
  if (!verifyAgentExecutionReceipt(receipt)
    || !hasExactObjectKeys(output, REVIEW_KEYS)
    || output.version !== 1
    || output.kind !== 'FormalDomainQualificationIndependentReview'
    || output.status !== 'approved'
    || typeof output.summary !== 'string' || !output.summary.trim()
    || !Array.isArray(output.blockers) || output.blockers.length !== 0
    || output.formalDomainCoverageReceiptHash
      !== coverageReceipt?.formalDomainCoverageReceiptHash
    || output.externalReplayReceiptHash
      !== externalReplayReceipt?.externalResearchReplayReceiptHash
    || JSON.stringify(output.reviewedProfileIds)
      !== JSON.stringify(REQUIRED_GENERIC_FORMAL_DOMAIN_PROFILE_IDS)
    || JSON.stringify(output.reviewedProfileEvidenceHashes)
      !== JSON.stringify(expectedProfileEvidenceHashes(coverageReceipt))
    || receipt.reviewerCryptographicAuthorityReady !== true
    || receipt.reviewerIdentityIndependenceReady !== true
    || receipt.signedReviewerReceiptHash !== signedReceipt?.signedReviewerReceiptHash
    || signedReceipt?.version !== 2
    || signedReceipt?.cryptographicAuthorityReady !== true
    || signedReceipt?.identityIndependenceReady !== true
    || reviewerReceiptVerificationAuthority?.version !== 2
    || reviewerReceiptVerificationAuthority?.cryptographicAuthorityReady !== true
    || reviewerReceiptVerificationAuthority?.identityIndependenceReady !== true
    || receipt.researchPrincipalPoolHash
      !== reviewerReceiptVerificationAuthority.researchPrincipalPoolHash
    || receipt.reviewerTrustSetHash
      !== reviewerReceiptVerificationAuthority.reviewerTrustSetHash
    || receipt.reviewerSignatureVerificationPolicyHash
      !== reviewerReceiptVerificationAuthority.reviewerSignatureVerificationPolicyHash
    || typeof reviewerReceiptVerificationAuthority.verifySignedReviewerReceipt !== 'function') {
    return false;
  }
  let subjectHash = null;
  try {
    subjectHash = reviewerReceiptSigningSubject({
      unsignedAgentExecutionReceiptHash: receipt.unsignedAgentExecutionReceiptHash,
      principalDescriptorHash: receipt.reviewPrincipalDescriptorHash,
      researchPrincipalPoolHash: receipt.researchPrincipalPoolHash,
    });
  } catch { return false; }
  return reviewerReceiptVerificationAuthority.verifySignedReviewerReceipt({
    receipt: signedReceipt,
    expected: {
      subjectHash,
      principalId: receipt.reviewPrincipalId,
      principalDescriptorHash: receipt.reviewPrincipalDescriptorHash,
      researchPrincipalPoolHash: receipt.researchPrincipalPoolHash,
      signerIdentityHash: receipt.reviewerSignerIdentityHash,
    },
  }) === true;
}

export function inspectFormalDomainQualificationExternalEvidence({
  evidence,
  coverageReceipt,
  externalResearchReplayReceiptVerifier,
  reviewerReceiptVerificationAuthority,
} = {}) {
  const blockers = [];
  const request = evidence?.externalReplayRequest;
  const receipt = evidence?.externalReplayReceipt;
  const replayHashes = expectedReplayHashes(coverageReceipt);
  const replayRequestValid = verifyExternalResearchReplayRequest(request)
    && request.paperId === 'formal-domain-production-qualification'
    && request.campaignId === 'formal-domain-production-qualification'
    && request.sourceSnapshotHash === coverageReceipt?.formalDomainCoverageReceiptHash
    && request.experimentPairs.length === 0
    && replayHashes.length === REQUIRED_GENERIC_FORMAL_DOMAIN_PROFILE_IDS.length
    && JSON.stringify(request.formalReplayReceiptHashes) === JSON.stringify(replayHashes);
  if (!replayRequestValid) {
    blockers.push('formal_domain_qualification_external_replay_request_invalid');
  }
  const replayReceiptValid = replayRequestValid
    && receipt?.version === 3
    && receipt?.cryptographicAuthorityReady === true
    && receipt?.identityIndependenceReady === true
    && verifyExternalResearchReplayReceipt(receipt, {
      request,
      cryptographicVerifier: externalResearchReplayReceiptVerifier,
    });
  if (!replayReceiptValid) {
    blockers.push('formal_domain_qualification_external_replay_receipt_invalid');
  }
  const independentReviewReady = replayReceiptValid && independentReviewValid({
    receipt: evidence?.formalDomainIndependentReviewAgentReceipt,
    coverageReceipt,
    externalReplayReceipt: receipt,
    reviewerReceiptVerificationAuthority,
  });
  if (!independentReviewReady) {
    blockers.push('formal_domain_qualification_independent_review_invalid');
  }
  if (evidence?.formalDomainCoverageReceiptHash
    !== coverageReceipt?.formalDomainCoverageReceiptHash) {
    blockers.push('formal_domain_qualification_coverage_binding_invalid');
  }
  const uniqueBlockers = Object.freeze([...new Set(blockers)]);
  return Object.freeze({
    ready: uniqueBlockers.length === 0,
    replayRequestValid,
    replayReceiptValid,
    independentReviewReady,
    blockers: uniqueBlockers,
  });
}

export function buildFormalDomainQualificationExternalEvidence({
  coverageReceipt,
  externalReplayRequest,
  externalReplayReceipt,
  formalDomainIndependentReviewAgentReceipt,
  externalResearchReplayReceiptVerifier,
  reviewerReceiptVerificationAuthority,
} = {}) {
  const base = {
    version: 1,
    kind: 'FormalDomainQualificationExternalEvidence',
    status: 'formal_domain_qualification_external_evidence_verified',
    formalDomainCoverageReceiptHash: coverageReceipt?.formalDomainCoverageReceiptHash || null,
    externalReplayRequest,
    externalReplayReceipt,
    formalDomainIndependentReviewAgentReceipt,
    blockers: Object.freeze([]),
  };
  const inspection = inspectFormalDomainQualificationExternalEvidence({
    evidence: base,
    coverageReceipt,
    externalResearchReplayReceiptVerifier,
    reviewerReceiptVerificationAuthority,
  });
  if (!inspection.ready) {
    throw new Error(`formal_domain_qualification_external_evidence_blocked:${inspection.blockers.join(',')}`);
  }
  return Object.freeze({
    ...base,
    formalDomainQualificationExternalEvidenceHash:
      hashRecord('FormalDomainQualificationExternalEvidence', base),
  });
}

export function verifyFormalDomainQualificationExternalEvidence(evidence, options = {}) {
  return formalDomainQualificationExternalEvidenceContentHash(evidence) !== null
    && inspectFormalDomainQualificationExternalEvidence({
      evidence,
      ...options,
    }).ready;
}

export function formalDomainQualificationExternalEvidenceContentHash(evidence) {
  if (!hasExactObjectKeys(evidence, EVIDENCE_KEYS)
    || evidence?.version !== 1
    || evidence?.kind !== 'FormalDomainQualificationExternalEvidence'
    || evidence?.status !== 'formal_domain_qualification_external_evidence_verified'
    || !Array.isArray(evidence?.blockers) || evidence.blockers.length !== 0
    || !SHA256.test(String(evidence?.formalDomainQualificationExternalEvidenceHash || ''))) {
    return null;
  }
  const { formalDomainQualificationExternalEvidenceHash: claimedHash, ...payload } = evidence;
  return hashRecord('FormalDomainQualificationExternalEvidence', payload)
    === claimedHash ? claimedHash : null;
}
