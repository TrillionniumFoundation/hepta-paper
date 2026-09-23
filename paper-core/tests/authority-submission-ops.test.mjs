import assert from 'node:assert/strict';
import test from 'node:test';

import { runPortalTargetQualificationCli } from '../bin/portal-target-qualification.mjs';
import { buildSubmissionRedriveDecision } from '../../paper-domain/submission/redrive-decision.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const NOW = new Date('2026-08-23T10:00:00.000Z');
const H = (label) => hashRecord('AuthoritySubmissionOpsTestValue', { label });

test('single-target portal preflight is descriptor-bound and read-only until a human permit', () => {
  const result = runPortalTargetQualificationCli({
    argv: [
      '--action', 'preflight',
      '--target', 'tmlr',
      '--require-ready',
    ],
    environment: {},
    now: NOW,
  });
  assert.equal(result.exitCode, 2);
  assert.equal(result.report.selectedTargetCount, 1);
  assert.equal(result.report.targets.length, 1);
  assert.equal(result.report.targets[0].venueId, 'tmlr');
  assert.equal(result.report.targets[0].liveCommitAuthorized, false);
  assert.equal(result.report.targets[0].liveSubmissionReady, false);
  assert.equal(result.report.registry.liveCommitAuthorizationIncluded, false);
  assert.equal(result.report.registry.humanSingleUseAuthorizationRequired, true);
  assert.equal(result.report.safety.readOnly, true);
  assert.equal(result.report.safety.networkActionPerformed, false);
  assert.equal(result.report.safety.portalLoginPerformed, false);
  assert.equal(result.report.safety.uploadPerformed, false);
  assert.equal(result.report.safety.signatureProduced, false);
  assert.equal(result.report.safety.authorizationProduced, false);
  assert.equal(result.report.safety.liveCommitPermitProduced, false);
  assert.equal(result.report.safety.liveCommitPermitConsumed, false);
});

test('redrive state machine requires fresh human review after an ambiguous outcome', () => {
  const dispatchAuthorization = {
    status: 'submission_dispatch_authorization_ready',
    paperId: 'paper-ops-1',
    submissionDispatchAuthorizationHash: H('dispatch-1'),
  };
  const responseDueAt = '2026-08-23T09:00:00.000Z';
  const explicitFailure = buildSubmissionRedriveDecision({
    dispatchAuthorization,
    responseIntake: {
      status: 'executor_response_accepted',
      outcome: 'failed',
      executorResponseIntakeHash: H('response-failed'),
    },
    responseDueAt,
    now: NOW,
  });
  assert.equal(explicitFailure.status, 'submission_redrive_reauthorization_approved');
  assert.equal(explicitFailure.decision, 'request_new_dispatch_authorization');
  assert.equal(explicitFailure.externalActionPerformed, false);

  const ambiguous = buildSubmissionRedriveDecision({
    dispatchAuthorization,
    responseIntake: {
      status: 'executor_response_ambiguous',
      blockers: ['executor_response_missing'],
      executorResponseIntakeHash: H('response-ambiguous'),
    },
    responseDueAt,
    now: NOW,
  });
  assert.equal(ambiguous.status, 'submission_redrive_decision_blocked');
  assert.equal(ambiguous.decision, 'local_redrive_due');
  assert.ok(ambiguous.blockers.includes(
    'ambiguous_result_non_submission_evidence_required',
  ));
  assert.equal(ambiguous.externalActionPerformed, false);

  const humanReview = {
    status: 'submission_ambiguous_result_reviewed',
    decision: 'confirm_not_submitted',
    reviewedBy: 'human-operator',
    dispatchAuthorizationHash: dispatchAuthorization.submissionDispatchAuthorizationHash,
    submissionAmbiguousResultReviewHash: H('human-review'),
  };
  const reviewReceipt = {
    status: 'ambiguous_redrive_review_verified',
    cryptographicSignaturesVerified: true,
    dispatchAuthorizationHash: dispatchAuthorization.submissionDispatchAuthorizationHash,
    humanReviewHash: humanReview.submissionAmbiguousResultReviewHash,
    ambiguousRedriveReviewVerificationReceiptHash: H('human-review-receipt'),
  };
  const reviewed = buildSubmissionRedriveDecision({
    dispatchAuthorization,
    responseIntake: {
      status: 'executor_response_ambiguous',
      blockers: ['executor_response_missing'],
      executorResponseIntakeHash: H('response-ambiguous'),
    },
    responseDueAt,
    now: NOW,
    humanReview,
    humanReviewVerificationReceipt: reviewReceipt,
  });
  assert.equal(reviewed.status, 'submission_redrive_reauthorization_approved');
  assert.equal(reviewed.decision, 'request_new_dispatch_authorization');
  assert.equal(reviewed.externalActionPerformed, false);
});
