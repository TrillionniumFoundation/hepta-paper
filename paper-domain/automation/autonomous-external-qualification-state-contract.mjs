import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { hasExactObjectKeys } from '../../workflow-kernel/exact-object-keys.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/i;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,255}$/;
const MAXIMUM_TIMESTAMP_MS = Date.parse('2100-01-01T00:00:00.000Z');
const MINIMUM_TIMESTAMP_MS = Date.parse('2000-01-01T00:00:00.000Z');
const MAXIMUM_COUNTER = 1_000_000;
export const AUTONOMOUS_EXTERNAL_QUALIFICATION_ATTEMPT_LEASE_MS = 10 * 60 * 1000;

const STATE_KEYS = Object.freeze([
  'version', 'kind', 'generation', 'campaignId', 'paperId',
  'campaignReleaseBundleHash', 'receipt', 'verifiedInspection', 'recovery',
  'autonomousExternalQualificationStateHash',
]);
const RECOVERY_KEYS_V4 = Object.freeze([
  'status', 'recoveryIdentityHash', 'recoveryConfigurationIdentityHash',
  'retryPolicyIdentityHash', 'configurationIdentityHash', 'trustIdentityHash',
  'clientServiceIdentityHash', 'verifierServiceIdentityHash', 'terminalFailure',
  'cycle', 'epoch', 'maximumEpochs', 'attemptCount', 'maximumAttempts',
  'totalAttemptCount', 'maximumTotalAttempts', 'firstAttemptAt', 'nextAttemptAt',
  'deadlineAt', 'globalFirstAttemptAt', 'globalDeadlineAt',
]);
const RECOVERY_KEYS_V5 = Object.freeze([
  ...RECOVERY_KEYS_V4,
  'maximumTotalCostUsd', 'reservedCostUsd', 'attemptReservationCostUsd',
]);
const TERMINAL_FAILURE_KEYS = Object.freeze([
  'failureCodes', 'rejectedReceiptHash', 'recoveryConfigurationIdentityHash',
]);
const RECOVERY_STATUSES = new Set([
  'qualification_retry_scheduled',
  'qualification_attempt_in_progress',
  'qualification_epoch_cooldown',
  'qualification_recovery_budget_exhausted',
  'qualification_terminal_blocked',
  'qualification_verified',
]);

function boundedInteger(value, fallback, minimum, maximum) {
  const candidate = value === undefined || value === null || value === ''
    ? fallback : Number(value);
  if (!Number.isSafeInteger(candidate)) return fallback;
  return Math.max(minimum, Math.min(maximum, candidate));
}

function boundedNumber(value, fallback, minimum, maximum) {
  const candidate = value === undefined || value === null || value === ''
    ? fallback : Number(value);
  if (!Number.isFinite(candidate)) return fallback;
  return Math.max(minimum, Math.min(maximum, candidate));
}

export function normalizeExternalQualificationRetryPolicy(retry = {}) {
  const maximumAttempts = boundedInteger(retry.maximumAttempts, 4, 1, 10);
  const maximumEpochs = boundedInteger(retry.maximumEpochs, 12, 1, 100);
  const maximumTotalAttempts = Math.max(maximumAttempts, boundedInteger(
    retry.maximumTotalAttempts,
    maximumAttempts * maximumEpochs,
    maximumAttempts,
    1000,
  ));
  const initialBackoffMs = boundedInteger(retry.initialBackoffMs, 250, 0, 60_000);
  const maximumBackoffMs = Math.max(initialBackoffMs, boundedInteger(
    retry.maximumBackoffMs,
    5000,
    initialBackoffMs,
    5 * 60_000,
  ));
  const deadlineMs = boundedInteger(retry.deadlineMs, 60_000, 1000, 24 * 60 * 60 * 1000);
  const epochCooldownMs = boundedInteger(
    retry.epochCooldownMs,
    30_000,
    0,
    60 * 60 * 1000,
  );
  const globalDeadlineMs = Math.max(deadlineMs, boundedInteger(
    retry.globalDeadlineMs,
    24 * 60 * 60 * 1000,
    deadlineMs,
    7 * 24 * 60 * 60 * 1000,
  ));
  const exhaustedCooldownMs = boundedInteger(
    retry.exhaustedCooldownMs,
    60 * 60 * 1000,
    1000,
    7 * 24 * 60 * 60 * 1000,
  );
  const attemptLeaseMs = boundedInteger(
    retry.attemptLeaseMs,
    AUTONOMOUS_EXTERNAL_QUALIFICATION_ATTEMPT_LEASE_MS,
    AUTONOMOUS_EXTERNAL_QUALIFICATION_ATTEMPT_LEASE_MS,
    AUTONOMOUS_EXTERNAL_QUALIFICATION_ATTEMPT_LEASE_MS,
  );
  const renewalLeadMs = boundedInteger(
    retry.renewalLeadMs,
    15 * 60 * 1000,
    0,
    24 * 60 * 60 * 1000,
  );
  const maximumTotalCostUsd = boundedNumber(
    retry.maximumTotalCostUsd,
    25,
    0.01,
    10_000,
  );
  const attemptReservationCostUsd = boundedNumber(
    retry.attemptReservationCostUsd,
    0.05,
    0.000001,
    maximumTotalCostUsd,
  );
  const payload = Object.freeze({
    maximumAttempts,
    maximumEpochs,
    maximumTotalAttempts,
    initialBackoffMs,
    maximumBackoffMs,
    deadlineMs,
    epochCooldownMs,
    globalDeadlineMs,
    exhaustedCooldownMs,
    attemptLeaseMs,
    renewalLeadMs,
    maximumTotalCostUsd,
    attemptReservationCostUsd,
  });
  return Object.freeze({
    ...payload,
    retryPolicyIdentityHash: hashRecord(
      'AutonomousExternalQualificationRetryPolicyIdentity',
      payload,
    ),
  });
}

function timestamp(value, nullable = false) {
  if (nullable && value === null) return null;
  if (typeof value !== 'string') return null;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)
    || milliseconds < MINIMUM_TIMESTAMP_MS || milliseconds > MAXIMUM_TIMESTAMP_MS
    || new Date(milliseconds).toISOString() !== value) return null;
  return milliseconds;
}

function validCounter(value, minimum = 0) {
  return Number.isSafeInteger(value) && value >= minimum && value <= MAXIMUM_COUNTER;
}

function validTerminalFailure(value, recoveryConfigurationIdentityHash) {
  if (value === null) return true;
  return hasExactObjectKeys(value, TERMINAL_FAILURE_KEYS)
    && Array.isArray(value.failureCodes) && value.failureCodes.length > 0
    && value.failureCodes.length <= 64
    && value.failureCodes.every((code) => typeof code === 'string' && code.length <= 256)
    && (value.rejectedReceiptHash === null || SHA256.test(String(value.rejectedReceiptHash)))
    && value.recoveryConfigurationIdentityHash === recoveryConfigurationIdentityHash;
}

function validRecovery(recovery) {
  const extended = Object.hasOwn(recovery || {}, 'maximumTotalCostUsd');
  const keys = extended ? RECOVERY_KEYS_V5 : RECOVERY_KEYS_V4;
  if (!hasExactObjectKeys(recovery, keys)
    || !RECOVERY_STATUSES.has(recovery.status)
    || ![
      recovery.recoveryIdentityHash,
      recovery.recoveryConfigurationIdentityHash,
      recovery.retryPolicyIdentityHash,
      recovery.configurationIdentityHash,
      recovery.trustIdentityHash,
      recovery.clientServiceIdentityHash,
      recovery.verifierServiceIdentityHash,
    ].every((value) => SHA256.test(String(value || '')))
    || !validTerminalFailure(
      recovery.terminalFailure,
      recovery.recoveryConfigurationIdentityHash,
    )
    || !validCounter(recovery.cycle, 1)
    || !validCounter(recovery.epoch, 1)
    || !validCounter(recovery.maximumEpochs, 1)
    || !validCounter(recovery.attemptCount)
    || !validCounter(recovery.maximumAttempts, 1)
    || !validCounter(recovery.totalAttemptCount)
    || !validCounter(recovery.maximumTotalAttempts, 1)
    || recovery.epoch > recovery.maximumEpochs
    || recovery.attemptCount > recovery.maximumAttempts
    || recovery.totalAttemptCount > recovery.maximumTotalAttempts) return false;
  if (extended && (!Number.isFinite(recovery.maximumTotalCostUsd)
    || recovery.maximumTotalCostUsd <= 0
    || !Number.isFinite(recovery.reservedCostUsd)
    || recovery.reservedCostUsd < 0
    || recovery.reservedCostUsd > recovery.maximumTotalCostUsd
    || !Number.isFinite(recovery.attemptReservationCostUsd)
    || recovery.attemptReservationCostUsd <= 0
    || recovery.attemptReservationCostUsd > recovery.maximumTotalCostUsd)) return false;
  const first = timestamp(recovery.firstAttemptAt);
  const next = timestamp(recovery.nextAttemptAt, true);
  const deadline = timestamp(recovery.deadlineAt);
  const globalFirst = timestamp(recovery.globalFirstAttemptAt);
  const globalDeadline = timestamp(recovery.globalDeadlineAt);
  return first !== null && deadline !== null && globalFirst !== null && globalDeadline !== null
    && first >= globalFirst && deadline >= first && deadline <= globalDeadline
    && globalDeadline >= globalFirst
    && (next === null || next >= first);
}

function verifiedEvidenceBound(value) {
  const { recovery, receipt, verifiedInspection } = value;
  if (recovery.status !== 'qualification_verified') {
    return receipt === null && verifiedInspection === null;
  }
  return receipt && typeof receipt === 'object' && !Array.isArray(receipt)
    && verifiedInspection && typeof verifiedInspection === 'object'
    && !Array.isArray(verifiedInspection)
    && verifiedInspection.kind === 'FullResearchQualificationInspection'
    && verifiedInspection.ready === true
    && verifiedInspection.receiptAccepted === true
    && verifiedInspection.campaignId === value.campaignId
    && verifiedInspection.paperId === value.paperId
    && verifiedInspection.campaignReleaseBundleHash === value.campaignReleaseBundleHash
    && verifiedInspection.configurationIdentityHash === recovery.configurationIdentityHash
    && verifiedInspection.trustIdentityHash === recovery.trustIdentityHash
    && verifiedInspection.clientServiceIdentityHash === recovery.clientServiceIdentityHash
    && verifiedInspection.verifierServiceIdentityHash === recovery.verifierServiceIdentityHash
    && timestamp(receipt.expiresAt) !== null;
}

export function validateAutonomousExternalQualificationState(value) {
  if (!hasExactObjectKeys(value, STATE_KEYS)
    || value.version !== 4 || value.kind !== 'AutonomousExternalQualificationState'
    || !validCounter(value.generation, 1)
    || !SAFE_ID.test(String(value.campaignId || ''))
    || !SAFE_ID.test(String(value.paperId || ''))
    || !SHA256.test(String(value.campaignReleaseBundleHash || ''))
    || !validRecovery(value.recovery)
    || !verifiedEvidenceBound(value)) {
    throw new Error('autonomous_research_external_qualification_state_invalid');
  }
  const { autonomousExternalQualificationStateHash, ...payload } = value;
  if (!SHA256.test(String(autonomousExternalQualificationStateHash || ''))
    || hashRecord('AutonomousExternalQualificationState', payload)
      !== autonomousExternalQualificationStateHash) {
    throw new Error('autonomous_research_external_qualification_state_hash_invalid');
  }
  return value;
}

export function createAutonomousExternalQualificationState(payload) {
  const value = Object.freeze({
    ...payload,
    autonomousExternalQualificationStateHash:
      hashRecord('AutonomousExternalQualificationState', payload),
  });
  validateAutonomousExternalQualificationState(value);
  return value;
}
