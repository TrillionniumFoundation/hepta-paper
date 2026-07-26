import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,191}$/;
const OPERATION_STATUSES = new Set(['completed', 'in_progress', 'not_found']);

function recoveryOutcome({
  kind,
  hashField,
  serviceId,
  serviceIdentityHash,
  operationId,
  idempotencyKey,
  requestHash,
  operationStatus,
  externalActionPerformed,
  resultHash,
} = {}) {
  const completed = operationStatus === 'completed';
  if (!SAFE_ID.test(String(serviceId || ''))
    || ![serviceIdentityHash, operationId, idempotencyKey, requestHash]
      .every((value) => SHA256.test(String(value || '')))
    || !OPERATION_STATUSES.has(operationStatus)
    || externalActionPerformed !== completed
    || (completed
      ? !SHA256.test(String(resultHash || ''))
      : resultHash !== null)) {
    throw new Error('external_operation_recovery_outcome_invalid');
  }
  const payload = {
    version: 1,
    kind,
    serviceId,
    serviceIdentityHash,
    operationId,
    idempotencyKey,
    requestHash,
    operationStatus,
    externalActionPerformed,
    resultHash,
  };
  return Object.freeze({
    ...payload,
    [hashField]: hashRecord(kind, payload),
  });
}

export function buildExternalResearchReplayRecoveryOutcome(input = {}) {
  return recoveryOutcome({
    ...input,
    kind: 'ExternalResearchReplayRecoveryOutcome',
    hashField: 'externalResearchReplayRecoveryOutcomeHash',
  });
}

export function buildReviewerReceiptSigningRecoveryOutcome(input = {}) {
  return recoveryOutcome({
    ...input,
    kind: 'ReviewerReceiptSigningRecoveryOutcome',
    hashField: 'reviewerReceiptSigningRecoveryOutcomeHash',
  });
}
