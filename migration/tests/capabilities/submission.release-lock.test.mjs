import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSubmissionReleaseLock } from '../../../paper-domain/submission/release-lock.mjs';

test('submission.release-lock stays locked without verified response and reconciliation', () => {
  const base = { paperTask: { paperId: 'p', taskKey: 'paper:p' }, dispatchAuthorization: { status: 'submission_dispatch_authorization_ready', submissionDispatchAuthorizationHash: 'd' }, responseIntake: { status: 'executor_response_accepted', executorResponseIntakeHash: 'i' }, reconciliation: { status: 'live_submission_reconciled', submissionReconciliationHash: 'r' } };
  assert.equal(buildSubmissionReleaseLock(base).status, 'submission_release_unlocked');
  assert.equal(buildSubmissionReleaseLock({ paperTask: base.paperTask }).status, 'submission_release_locked');
});
