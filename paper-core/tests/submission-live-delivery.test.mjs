import assert from 'node:assert/strict';
import test from 'node:test';
import { createPaperArtifactPackage } from '../src/contracts/workflow-contracts.mjs';
import {
  buildExecutorResponseIntake,
  buildSubmissionDeliveryRuntime,
  buildSubmissionDispatchAuthorization,
  buildSubmissionRedriveAttempt,
  buildSubmissionRedrivePlan,
} from '../../paper-domain/submission/delivery-runtime.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

function readyFixture(nonce = 'nonce-initial-0001') {
  const paperTask = { paperId: 'paper-live', taskKey: 'paper:paper-live' };
  const artifactPackage = createPaperArtifactPackage({
    paperTask,
    artifacts: [{ path: 'paper.pdf', filename: 'paper.pdf', hash: `sha256:${'a'.repeat(64)}`, role: 'manuscript' }],
    submitReady: true,
  });
  const reviewedVenueEvidence = { status: 'reviewed_venue_evidence_verified', reviewedVenueEvidenceHash: `sha256:${'1'.repeat(64)}`, sourceVerificationReceiptHash: `sha256:${'2'.repeat(64)}`, observationSubjectHash: `sha256:${'3'.repeat(64)}`, reviewedBy: 'venue-observer', purpose: 'submission_preflight', portalRoute: '/submit/manuscript' };
  const providerCapabilityVerificationReceipt = { status: 'provider_capability_verified', provider: 'fixture-provider', accountId: 'fixture-account', portalRoute: '/submit/manuscript', providerCapabilityVerificationReceiptHash: `sha256:${'9'.repeat(64)}` };
  return {
    paperTask,
    artifactPackage,
    outbox: { status: 'queued_for_dry_run_executor', externalExecutorHandoffOutboxHash: 'sha256:outbox' },
    replayGuard: { status: 'dry_run_replay_allowed', submissionReplayGuardHash: 'sha256:replay', replayKey: `sha256:${'b'.repeat(64)}` },
    reviewedSubmitPreflightPacket: { status: 'reviewed_submit_preflight_ready_for_external_executor', reviewedSubmitPreflightPacketHash: 'sha256:preflight', artifactPackageHash: artifactPackage.artifactPackageHash },
    controlledExecutorReceipt: { status: 'controlled_external_executor_receipt_recorded', controlledExternalExecutorReceiptHash: 'sha256:controlled', executorId: 'executor-1', executorDescriptorHash: `sha256:${'c'.repeat(64)}`, executorCapabilitiesHash: `sha256:${'d'.repeat(64)}` },
    submissionDecisionPacket: { status: 'reviewed_submission_decision_verified', reviewedSubmissionDecisionPacketHash: `sha256:${'e'.repeat(64)}` },
    liveAuthorizationReceipt: {
      status: 'live_submission_authorization_verified',
      liveSubmissionAuthorizationReceiptHash: `sha256:authorization:${nonce}`,
      authorizationSubject: { artifactPackageHash: artifactPackage.artifactPackageHash, executorDescriptorHash: `sha256:${'c'.repeat(64)}`, reviewedSubmissionDecisionPacketHash: `sha256:${'e'.repeat(64)}`, reviewedVenueEvidenceHash: reviewedVenueEvidence.reviewedVenueEvidenceHash, venueObservationSourceVerificationReceiptHash: reviewedVenueEvidence.sourceVerificationReceiptHash, venueTarget: 'Journal X', portalRoute: '/submit/manuscript', providerCapabilityVerificationReceiptHash: providerCapabilityVerificationReceipt.providerCapabilityVerificationReceiptHash },
      provider: 'fixture-provider',
      accountId: 'fixture-account',
      nonce,
      responseDueAt: '2026-07-13T02:00:00.000Z',
    },
    reviewedVenueEvidence,
    providerCapabilityVerificationReceipt,
  };
}

function submittedResponse(dispatch) {
  const uploadedArtifactHashes = dispatch.expectedArtifactHashes;
  const providerReceipt = {
    version: 1,
    kind: 'ProviderSubmissionReceipt',
    provider: dispatch.provider,
    accountId: dispatch.accountId,
    submissionId: 'submission-42',
    dispatchAuthorizationHash: dispatch.submissionDispatchAuthorizationHash,
    uploadedArtifactHashes,
  };
  return {
    responseId: 'response-42',
    outcome: 'submitted',
    dispatchAuthorizationHash: dispatch.submissionDispatchAuthorizationHash,
    provider: dispatch.provider,
    accountId: dispatch.accountId,
    submissionId: providerReceipt.submissionId,
    providerReceipt,
    providerReceiptHash: hashRecord('ProviderSubmissionReceipt', providerReceipt),
    uploadedArtifactHashes,
    performedAt: '2026-07-13T00:00:00.000Z',
    attempt: dispatch.attempt,
    executorId: dispatch.executorId,
    executorDescriptorHash: dispatch.executorDescriptorHash,
    capabilitiesHash: dispatch.executorCapabilitiesHash,
  };
}

function verifiedResponse(response, dispatch) {
  return { version: 1, kind: 'ExecutorResponseVerificationReceipt', status: 'executor_response_signature_verified', responseId: response.responseId, dispatchAuthorizationHash: dispatch.submissionDispatchAuthorizationHash, executorId: dispatch.executorId, executorDescriptorHash: dispatch.executorDescriptorHash, capabilitiesHash: dispatch.executorCapabilitiesHash, cryptographicSignaturesVerified: true, executorResponseVerificationReceiptHash: `sha256:${'f'.repeat(64)}` };
}

test('live submission completes only with response, artifact and venue evidence bound end to end', () => {
  const fixture = readyFixture();
  const dispatch = buildSubmissionDispatchAuthorization(fixture);
  assert.equal(dispatch.status, 'submission_dispatch_authorization_ready');
  const response = submittedResponse(dispatch);
  const responseVerificationReceipt = verifiedResponse(response, dispatch);
  const responseIntake = buildExecutorResponseIntake({ dispatchAuthorization: dispatch, response, responseVerificationReceipt });
  assert.equal(responseIntake.status, 'executor_response_accepted');
  const venueObservation = {
    dispatchAuthorizationHash: dispatch.submissionDispatchAuthorizationHash,
    executorResponseIntakeHash: responseIntake.executorResponseIntakeHash,
    provider: dispatch.provider,
    accountId: dispatch.accountId,
    providerReceiptHash: response.providerReceiptHash,
    submissionId: response.submissionId,
    observedState: 'received',
    observedAt: '2026-07-13T00:01:00.000Z',
    evidenceHashes: [`sha256:${'b'.repeat(64)}`],
  };
  const runtime = buildSubmissionDeliveryRuntime({ ...fixture, executorResponse: response, executorResponseVerificationReceipt: responseVerificationReceipt, venueObservation });
  assert.equal(runtime.status, 'submission_delivery_complete');
  assert.equal(runtime.reconciliation.status, 'live_submission_reconciled');
  assert.equal(runtime.releaseLock.status, 'submission_release_unlocked');
  assert.equal(runtime.externalActionPerformed, true);

  const badResponse = submittedResponse(dispatch);
  badResponse.uploadedArtifactHashes = ['sha256:wrong'];
  assert.equal(buildExecutorResponseIntake({ dispatchAuthorization: dispatch, response: badResponse, responseVerificationReceipt }).status, 'executor_response_intake_blocked');
  assert.equal(buildSubmissionDeliveryRuntime({ ...fixture, executorResponse: response, executorResponseVerificationReceipt: responseVerificationReceipt, venueObservation: { ...venueObservation, evidenceHashes: [] } }).status, 'submission_delivery_blocked');
});

test('redrive cannot reuse an authorization and records a fresh dispatch cycle', () => {
  const fixture = readyFixture();
  const dispatch = buildSubmissionDispatchAuthorization(fixture);
  const failedResponse = {
    responseId: 'response-failed-1',
    outcome: 'failed',
    dispatchAuthorizationHash: dispatch.submissionDispatchAuthorizationHash,
    provider: dispatch.provider,
    accountId: dispatch.accountId,
    performedAt: '2026-07-13T00:00:00.000Z',
    attempt: 1,
    executorId: dispatch.executorId,
    executorDescriptorHash: dispatch.executorDescriptorHash,
    capabilitiesHash: dispatch.executorCapabilitiesHash,
  };
  const responseIntake = buildExecutorResponseIntake({ dispatchAuthorization: dispatch, response: failedResponse, responseVerificationReceipt: verifiedResponse(failedResponse, dispatch) });
  const redrivePlan = buildSubmissionRedrivePlan({ dispatchAuthorization: dispatch, responseIntake });
  assert.equal(redrivePlan.status, 'submission_redrive_reauthorization_required');
  assert.equal(redrivePlan.nextAttempt, 2);
  assert.equal(buildSubmissionDispatchAuthorization({ ...fixture, redrivePlan }).status, 'submission_dispatch_authorization_blocked');

  const fresh = {
    ...fixture,
    liveAuthorizationReceipt: {
      ...fixture.liveAuthorizationReceipt,
      liveSubmissionAuthorizationReceiptHash: 'sha256:authorization:nonce-redrive-0002',
      nonce: 'nonce-redrive-0002',
      authorizationSubject: {
        ...fixture.liveAuthorizationReceipt.authorizationSubject,
        redrivePlanHash: redrivePlan.submissionRedrivePlanHash,
        redriveDecisionHash: redrivePlan.redriveDecisionHash,
        priorDispatchCycleHash: redrivePlan.priorDispatchCycleHash,
      },
    },
  };
  const freshDispatch = buildSubmissionDispatchAuthorization({ ...fresh, redrivePlan });
  assert.equal(freshDispatch.status, 'submission_dispatch_authorization_ready');
  assert.equal(freshDispatch.attempt, 2);
  assert.notEqual(freshDispatch.submissionDispatchAuthorizationHash, dispatch.submissionDispatchAuthorizationHash);
  const attempt = buildSubmissionRedriveAttempt({ redrivePlan, dispatchAuthorization: freshDispatch, result: { resultHash: 'sha256:redrive-result' } });
  assert.equal(attempt.status, 'submission_redrive_attempt_recorded');
});
