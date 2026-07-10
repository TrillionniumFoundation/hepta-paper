import { hashRecord as hashPaperRecord } from '../../workflow-kernel/record-hash.mjs';
import { buildSubmissionReleaseLock } from './release-lock.mjs';

export function buildSubmissionDispatchAuthorization({
  paperTask,
  outbox,
  replayGuard,
  reviewedSubmitPreflightPacket,
  controlledExecutorReceipt,
  liveAuthorizationReceipt,
} = {}) {
  const blockers = [];
  if (!paperTask?.taskKey) blockers.push('paper_task_required');
  if (outbox?.status !== 'queued_for_dry_run_executor') blockers.push('executor_outbox_not_ready');
  if (replayGuard?.status !== 'dry_run_replay_allowed') blockers.push('replay_guard_not_ready');
  if (reviewedSubmitPreflightPacket?.status !== 'reviewed_submit_preflight_ready_for_external_executor') {
    blockers.push('reviewed_submit_preflight_not_ready');
  }
  if (controlledExecutorReceipt?.status !== 'controlled_external_executor_receipt_recorded') {
    blockers.push('controlled_executor_boundary_not_ready');
  }
  if (liveAuthorizationReceipt?.status !== 'live_submission_authorization_verified') {
    blockers.push('live_submission_authorization_not_verified');
  }
  const record = {
    version: 1,
    kind: 'SubmissionDispatchAuthorization',
    paperId: paperTask?.paperId || null,
    taskKey: paperTask?.taskKey || null,
    status: blockers.length ? 'submission_dispatch_authorization_blocked' : 'submission_dispatch_authorization_ready',
    outboxHash: outbox?.externalExecutorHandoffOutboxHash || null,
    replayGuardHash: replayGuard?.submissionReplayGuardHash || null,
    preflightHash: reviewedSubmitPreflightPacket?.reviewedSubmitPreflightPacketHash || null,
    controlledExecutorReceiptHash: controlledExecutorReceipt?.controlledExternalExecutorReceiptHash || null,
    liveAuthorizationHash: liveAuthorizationReceipt?.liveSubmissionAuthorizationReceiptHash || null,
    provider: liveAuthorizationReceipt?.provider || null,
    accountId: liveAuthorizationReceipt?.accountId || null,
    nonce: liveAuthorizationReceipt?.nonce || null,
    blockers,
    externalActionPerformed: false,
  };
  return { ...record, submissionDispatchAuthorizationHash: hashPaperRecord('SubmissionDispatchAuthorization', record) };
}

export function buildExecutorResponseIntake({ dispatchAuthorization, response = null } = {}) {
  const blockers = [];
  if (dispatchAuthorization?.status !== 'submission_dispatch_authorization_ready') blockers.push('dispatch_authorization_not_ready');
  if (!response) blockers.push('executor_response_missing');
  if (response && response.dispatchAuthorizationHash !== dispatchAuthorization?.submissionDispatchAuthorizationHash) {
    blockers.push('executor_response_dispatch_hash_mismatch');
  }
  if (response && !['submitted', 'rejected', 'failed', 'cancelled'].includes(response.outcome)) {
    blockers.push('executor_response_outcome_invalid');
  }
  if (response?.outcome === 'submitted' && (!response.providerReceiptHash || !response.providerReceipt)) {
    blockers.push('provider_receipt_missing');
  }
  if (response?.outcome === 'submitted' && response.providerReceipt
    && hashPaperRecord('ProviderSubmissionReceipt', response.providerReceipt) !== response.providerReceiptHash) {
    blockers.push('provider_receipt_hash_invalid');
  }
  const record = {
    version: 1,
    kind: 'ExecutorResponseIntake',
    paperId: dispatchAuthorization?.paperId || null,
    status: blockers.length ? 'executor_response_intake_blocked' : 'executor_response_accepted',
    dispatchAuthorizationHash: dispatchAuthorization?.submissionDispatchAuthorizationHash || null,
    responseId: response?.responseId || null,
    outcome: response?.outcome || null,
    providerReceiptHash: response?.providerReceiptHash || null,
    attempt: Number(response?.attempt || 0),
    blockers,
  };
  return { ...record, executorResponseIntakeHash: hashPaperRecord('ExecutorResponseIntake', record) };
}

export function buildSubmissionRedrivePlan({ dispatchAuthorization, responseIntake, priorAttempts = [], maximumAttempts = 3 } = {}) {
  const attempts = Array.isArray(priorAttempts) ? priorAttempts : [];
  const retryableOutcome = ['failed'].includes(responseIntake?.outcome) || responseIntake?.blockers?.includes('executor_response_missing');
  const blockers = [];
  if (dispatchAuthorization?.status !== 'submission_dispatch_authorization_ready') blockers.push('dispatch_authorization_not_ready');
  if (!retryableOutcome) blockers.push('executor_response_not_retryable');
  if (attempts.length >= maximumAttempts) blockers.push('redrive_attempt_limit_reached');
  const record = {
    version: 1,
    kind: 'SubmissionRedrivePlan',
    paperId: dispatchAuthorization?.paperId || null,
    status: blockers.length ? 'submission_redrive_blocked' : 'submission_redrive_ready',
    dispatchAuthorizationHash: dispatchAuthorization?.submissionDispatchAuthorizationHash || null,
    responseIntakeHash: responseIntake?.executorResponseIntakeHash || null,
    priorAttemptHashes: attempts.map((attempt) => attempt.submissionRedriveAttemptHash).filter(Boolean),
    nextAttempt: attempts.length + 1,
    maximumAttempts,
    blockers,
    externalActionPerformed: false,
  };
  return { ...record, submissionRedrivePlanHash: hashPaperRecord('SubmissionRedrivePlan', record) };
}

export function buildSubmissionRedriveAttempt({ redrivePlan, result = null } = {}) {
  const blockers = [];
  if (redrivePlan?.status !== 'submission_redrive_ready') blockers.push('redrive_plan_not_ready');
  if (!result) blockers.push('redrive_result_missing');
  const record = {
    version: 1,
    kind: 'SubmissionRedriveAttempt',
    paperId: redrivePlan?.paperId || null,
    status: blockers.length ? 'submission_redrive_attempt_blocked' : 'submission_redrive_attempt_recorded',
    redrivePlanHash: redrivePlan?.submissionRedrivePlanHash || null,
    attempt: redrivePlan?.nextAttempt || null,
    resultHash: result?.resultHash || null,
    blockers,
  };
  return { ...record, submissionRedriveAttemptHash: hashPaperRecord('SubmissionRedriveAttempt', record) };
}

export function buildSubmissionDeliveryRuntime({
  paperTask,
  outbox,
  replayGuard,
  reviewedSubmitPreflightPacket,
  controlledExecutorReceipt,
  liveAuthorizationReceipt,
  reconciliation,
  executorResponse = null,
  priorRedriveAttempts = [],
} = {}) {
  const dispatchAuthorization = buildSubmissionDispatchAuthorization({
    paperTask,
    outbox,
    replayGuard,
    reviewedSubmitPreflightPacket,
    controlledExecutorReceipt,
    liveAuthorizationReceipt,
  });
  const responseIntake = buildExecutorResponseIntake({ dispatchAuthorization, response: executorResponse });
  const redrivePlan = buildSubmissionRedrivePlan({ dispatchAuthorization, responseIntake, priorAttempts: priorRedriveAttempts });
  const releaseLock = buildSubmissionReleaseLock({ paperTask, dispatchAuthorization, responseIntake, reconciliation });
  return Object.freeze({
    version: 1,
    kind: 'SubmissionDeliveryRuntime',
    status: releaseLock.status === 'submission_release_unlocked'
      ? 'submission_delivery_complete'
      : 'submission_delivery_blocked',
    dispatchAuthorization,
    responseIntake,
    redrivePlan,
    releaseLock,
    executorImplementationPresent: false,
    externalActionPerformed: false,
  });
}
