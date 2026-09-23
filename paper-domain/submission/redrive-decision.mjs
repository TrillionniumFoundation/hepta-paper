import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

export function buildSubmissionRedriveDecision({
  dispatchAuthorization,
  responseIntake,
  responseDueAt,
  now = null,
  reviewedVenueEvidence = null,
  humanReview = null,
  humanReviewVerificationReceipt = null,
} = {}) {
  const blockers = [];
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(String(now));
  if (!Number.isFinite(nowMs)) blockers.push('submission_redrive_reference_time_required');
  const dueMs = Date.parse(String(responseDueAt || ''));
  const explicitFailure = responseIntake?.status === 'executor_response_accepted'
    && responseIntake?.outcome === 'failed';
  const ambiguous = responseIntake?.blockers?.includes('executor_response_missing') === true;
  let decision = 'abandon_external_submission';
  if (dispatchAuthorization?.status !== 'submission_dispatch_authorization_ready') blockers.push('dispatch_authorization_not_ready');
  if (!explicitFailure && !ambiguous) blockers.push('executor_result_not_redrive_candidate');
  if (explicitFailure) decision = 'request_new_dispatch_authorization';
  if (ambiguous) {
    if (!Number.isFinite(dueMs)) blockers.push('executor_response_due_at_invalid');
    if (Number.isFinite(dueMs) && nowMs < dueMs) decision = 'continue_waiting';
    else {
      const negativeVenueProof = reviewedVenueEvidence?.status === 'reviewed_venue_evidence_verified'
        && reviewedVenueEvidence?.purpose === 'ambiguous_redrive'
        && reviewedVenueEvidence?.observedState === 'not_submitted';
      const reviewedAbandonment = humanReview?.status === 'submission_ambiguous_result_reviewed'
        && humanReview?.decision === 'confirm_not_submitted'
        && humanReview?.dispatchAuthorizationHash === dispatchAuthorization?.submissionDispatchAuthorizationHash
        && humanReview?.reviewedBy
        && humanReviewVerificationReceipt?.status === 'ambiguous_redrive_review_verified'
        && humanReviewVerificationReceipt?.cryptographicSignaturesVerified === true
        && humanReviewVerificationReceipt?.dispatchAuthorizationHash === dispatchAuthorization?.submissionDispatchAuthorizationHash
        && humanReviewVerificationReceipt?.humanReviewHash === humanReview?.submissionAmbiguousResultReviewHash;
      if (negativeVenueProof || reviewedAbandonment) decision = 'request_new_dispatch_authorization';
      else {
        decision = 'local_redrive_due';
        blockers.push('ambiguous_result_non_submission_evidence_required');
      }
    }
  }
  const payload = {
    version: 1,
    kind: 'SubmissionRedriveDecision',
    paperId: dispatchAuthorization?.paperId || null,
    status: blockers.length
      ? decision === 'continue_waiting' ? 'submission_redrive_waiting' : 'submission_redrive_decision_blocked'
      : decision === 'request_new_dispatch_authorization' ? 'submission_redrive_reauthorization_approved' : 'submission_redrive_waiting',
    decision,
    dispatchAuthorizationHash: dispatchAuthorization?.submissionDispatchAuthorizationHash || null,
    responseIntakeHash: responseIntake?.executorResponseIntakeHash || null,
    responseDueAt: Number.isFinite(dueMs) ? new Date(dueMs).toISOString() : null,
    reviewedVenueEvidenceHash: reviewedVenueEvidence?.reviewedVenueEvidenceHash || null,
    humanReviewHash: humanReview?.submissionAmbiguousResultReviewHash || null,
    humanReviewVerificationReceiptHash: humanReviewVerificationReceipt?.ambiguousRedriveReviewVerificationReceiptHash || null,
    blockers: [...new Set(blockers)],
    externalActionPerformed: false,
  };
  return Object.freeze({ ...payload, submissionRedriveDecisionHash: hashRecord('SubmissionRedriveDecision', payload) });
}
