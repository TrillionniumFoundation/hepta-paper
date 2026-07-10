import { hashRecord as hashPaperRecord } from '../../workflow-kernel/record-hash.mjs';

export function buildSubmissionReleaseLock({ paperTask, dispatchAuthorization, responseIntake, reconciliation } = {}) {
  const blockers = [];
  if (!paperTask?.taskKey) blockers.push('paper_task_required');
  if (dispatchAuthorization?.status !== 'submission_dispatch_authorization_ready') {
    blockers.push('dispatch_authorization_not_ready');
  }
  if (responseIntake?.status !== 'executor_response_accepted') blockers.push('executor_response_not_accepted');
  if (!['live_submission_reconciled', 'dry_run_reconciled'].includes(reconciliation?.status)) {
    blockers.push('submission_reconciliation_not_ready');
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
