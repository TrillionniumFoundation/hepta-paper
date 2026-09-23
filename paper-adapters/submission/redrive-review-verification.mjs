import { verifyAuthoritySignatures, verifyAuthorityTimeWindow } from '../../paper-adapters/authority/authority-signatures.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

export function verifySignedAmbiguousRedriveReview({ dispatchAuthorization, humanReview, trustStore, now = new Date() } = {}) {
  const blockers = [];
  if (humanReview?.version !== 1 || humanReview?.kind !== 'SignedAmbiguousSubmissionReview') blockers.push('ambiguous_review_schema_invalid');
  if (humanReview?.status !== 'submission_ambiguous_result_reviewed') blockers.push('ambiguous_review_status_invalid');
  if (humanReview?.decision !== 'confirm_not_submitted') blockers.push('ambiguous_review_decision_invalid');
  if (humanReview?.dispatchAuthorizationHash !== dispatchAuthorization?.submissionDispatchAuthorizationHash) blockers.push('ambiguous_review_dispatch_mismatch');
  const { signatures: _signatures, submissionAmbiguousResultReviewHash: _claimed, ...reviewPayload } = humanReview || {};
  const expectedHash = hashRecord('SignedAmbiguousSubmissionReview', reviewPayload);
  if (humanReview?.submissionAmbiguousResultReviewHash !== expectedHash) blockers.push('ambiguous_review_hash_invalid');
  const signatures = verifyAuthoritySignatures({ document: humanReview, trustStore, requiredRoles: ['submission_operator'], minSignatures: 1 });
  blockers.push(...signatures.blockers);
  const timeWindow = verifyAuthorityTimeWindow({ signedAt: humanReview?.signedAt, validFrom: humanReview?.validFrom, expiresAt: humanReview?.expiresAt, now, maximumLifetimeMs: 24 * 60 * 60 * 1000 });
  blockers.push(...timeWindow.blockers);
  const payload = {
    version: 1,
    kind: 'AmbiguousRedriveReviewVerificationReceipt',
    status: blockers.length ? 'ambiguous_redrive_review_blocked' : 'ambiguous_redrive_review_verified',
    dispatchAuthorizationHash: dispatchAuthorization?.submissionDispatchAuthorizationHash || null,
    humanReviewHash: humanReview?.submissionAmbiguousResultReviewHash || null,
    verifiedSubjectIds: signatures.verifiedSubjectIds,
    cryptographicSignaturesVerified: signatures.cryptographicSignaturesVerified,
    blockers: [...new Set(blockers)],
  };
  return Object.freeze({ ...payload, ambiguousRedriveReviewVerificationReceiptHash: hashRecord('AmbiguousRedriveReviewVerificationReceipt', payload) });
}
