import { hashRecord as hashPaperRecord } from '../../workflow-kernel/record-hash.mjs';

export function buildSubmissionReleaseLock({ paperTask, dispatchAuthorization, responseIntake, reconciliation } = {}) {
  const blockers = [];
  if (!paperTask?.taskKey) blockers.push('paper_task_required');
  if (dispatchAuthorization?.status !== 'submission_dispatch_authorization_ready') {
    blockers.push('dispatch_authorization_not_ready');
  }
  if (responseIntake?.status !== 'executor_response_accepted') blockers.push('executor_response_not_accepted');
  const expectedReconciliationStatus = responseIntake?.outcome === 'submitted'
    ? 'live_submission_reconciled'
    : null;
  if (expectedReconciliationStatus && reconciliation?.status !== expectedReconciliationStatus) {
    blockers.push('live_submission_reconciliation_not_ready');
  } else if (!expectedReconciliationStatus && !['live_submission_reconciled', 'dry_run_reconciled'].includes(reconciliation?.status)) {
    blockers.push('submission_reconciliation_not_ready');
  }
  if (reconciliation?.status === 'live_submission_reconciled') {
    if (reconciliation.dispatchAuthorizationHash !== dispatchAuthorization?.submissionDispatchAuthorizationHash) {
      blockers.push('reconciliation_dispatch_hash_mismatch');
    }
    if (reconciliation.responseIntakeHash !== responseIntake?.executorResponseIntakeHash) {
      blockers.push('reconciliation_response_hash_mismatch');
    }
    if (!reconciliation.venueStateProofHash) blockers.push('reconciliation_venue_state_proof_missing');
    if (reconciliation.responseEnvelopeHash !== responseIntake?.responseEnvelopeHash) blockers.push('reconciliation_response_envelope_mismatch');
    if ((reconciliation.providerReceiptHash || null) !== (responseIntake?.providerReceiptHash || null)) blockers.push('reconciliation_provider_receipt_mismatch');
    if ((reconciliation.submissionId || null) !== (responseIntake?.submissionId || null)) blockers.push('reconciliation_submission_id_mismatch');
  }
  const record = {
    version: 1,
    kind: 'SubmissionReleaseLock',
    paperId: paperTask?.paperId || null,
    taskKey: paperTask?.taskKey || null,
    status: blockers.length ? 'submission_release_locked' : 'submission_release_unlocked',
    dispatchAuthorizationHash: dispatchAuthorization?.submissionDispatchAuthorizationHash || null,
    responseIntakeHash: responseIntake?.executorResponseIntakeHash || null,
    reconciliationHash: reconciliation?.submissionReconciliationHash || null,
    blockers,
  };
  return { ...record, submissionReleaseLockHash: hashPaperRecord('SubmissionReleaseLock', record) };
}
