import { hasExactObjectKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  autonomousResearchOnlineMutationReceiptHash,
  autonomousResearchOnlineMutationSignedPayload,
  AUTONOMOUS_RESEARCH_ONLINE_MUTATION_PROTOCOL,
} from './autonomous-research-online-mutation-contract.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{1,191}$/;
const ABORT_REASONS = new Set([
  'local-apply-failed',
  'local-marker-failed',
  'local-commit-failed',
]);
const ABORT_REQUEST_KEYS = Object.freeze([
  'version', 'kind', 'protocol', 'scopeId', 'databaseScopeHash',
  'writerManifestHash', 'reservationId', 'reservationReceiptHash',
  'databaseRole', 'databaseInstanceId', 'writerId', 'operationId', 'mutationAttemptId',
  'globalSequence', 'globalHash', 'databaseSequence', 'databaseHash',
  'changesetHash', 'reason', 'requestedAt',
]);
const RESOLUTION_REQUEST_KEYS = Object.freeze([
  'version', 'kind', 'protocol', 'scopeId', 'databaseScopeHash',
  'writerManifestHash', 'mutationAttemptId', 'reserveRequestHash', 'requestedAt',
]);
const RESOLUTION_RECEIPT_KEYS = Object.freeze([
  'version', 'kind', 'status', 'authorityId', 'keyId', 'requestHash',
  ...RESOLUTION_REQUEST_KEYS.slice(2),
  'resolution', 'reservation', 'observedAt', 'signature',
]);
const ABORT_RECEIPT_KEYS = Object.freeze([
  'version', 'kind', 'status', 'authorityId', 'keyId', 'requestHash',
  ...ABORT_REQUEST_KEYS.slice(2),
  'abortedAt', 'signature',
]);

function fail(code) {
  throw new Error(code);
}

function timestamp(value) {
  const milliseconds = Date.parse(String(value || ''));
  return Number.isFinite(milliseconds) ? milliseconds : null;
}

function explicitNow(now) {
  const milliseconds = now instanceof Date ? now.getTime() : new Date(now).getTime();
  if (!Number.isFinite(milliseconds)) {
    fail('autonomous_research_online_mutation_abort_now_required');
  }
  return milliseconds;
}

export function assertAutonomousResearchOnlineMutationAbortRequest(
  request,
  reservation,
) {
  const mirrored = [
    'protocol', 'scopeId', 'databaseScopeHash', 'writerManifestHash',
    'reservationId', 'databaseRole', 'databaseInstanceId', 'writerId',
    'operationId', 'mutationAttemptId', 'globalSequence', 'globalHash', 'databaseSequence',
    'databaseHash', 'changesetHash',
  ];
  if (!hasExactObjectKeys(request, ABORT_REQUEST_KEYS)
    || request.version !== 1
    || request.kind !== 'AutonomousResearchOnlineMutationAbortRequest'
    || request.protocol !== AUTONOMOUS_RESEARCH_ONLINE_MUTATION_PROTOCOL
    || !mirrored.every((key) => request[key] === reservation?.[key])
    || !SAFE_ID.test(String(request.scopeId || ''))
    || !SAFE_ID.test(String(request.reservationId || ''))
    || !SAFE_ID.test(String(request.databaseInstanceId || ''))
    || !SAFE_ID.test(String(request.writerId || ''))
    || !SAFE_ID.test(String(request.operationId || ''))
    || !SAFE_ID.test(String(request.mutationAttemptId || ''))
    || !SHA256.test(String(request.databaseScopeHash || ''))
    || !SHA256.test(String(request.writerManifestHash || ''))
    || !SHA256.test(String(request.globalHash || ''))
    || !SHA256.test(String(request.databaseHash || ''))
    || !SHA256.test(String(request.changesetHash || ''))
    || !Number.isSafeInteger(request.globalSequence)
    || request.globalSequence < 1
    || !Number.isSafeInteger(request.databaseSequence)
    || request.databaseSequence < 1
    || request.reservationReceiptHash
      !== autonomousResearchOnlineMutationReceiptHash(reservation)
    || !SHA256.test(String(request.reservationReceiptHash || ''))
    || !ABORT_REASONS.has(request.reason)
    || timestamp(request.requestedAt) === null) {
    fail('autonomous_research_online_mutation_abort_request_invalid');
  }
  return request;
}

export function assertAutonomousResearchOnlineMutationResolutionRequest(
  request,
  reserveRequest,
) {
  const reserveRequestHash = hashRecord(
    'AutonomousResearchOnlineMutationReserveRequest', reserveRequest,
  );
  if (!hasExactObjectKeys(request, RESOLUTION_REQUEST_KEYS)
    || request.version !== 1
    || request.kind !== 'AutonomousResearchOnlineMutationResolutionRequest'
    || request.protocol !== AUTONOMOUS_RESEARCH_ONLINE_MUTATION_PROTOCOL
    || request.protocol !== reserveRequest?.protocol
    || request.scopeId !== reserveRequest?.scopeId
    || request.databaseScopeHash !== reserveRequest?.databaseScopeHash
    || request.writerManifestHash !== reserveRequest?.writerManifestHash
    || request.mutationAttemptId !== reserveRequest?.mutationAttemptId
    || request.reserveRequestHash !== reserveRequestHash
    || !SAFE_ID.test(String(request.scopeId || ''))
    || !SAFE_ID.test(String(request.mutationAttemptId || ''))
    || !SHA256.test(String(request.databaseScopeHash || ''))
    || !SHA256.test(String(request.writerManifestHash || ''))
    || timestamp(request.requestedAt) === null) {
    fail('autonomous_research_online_mutation_resolution_request_invalid');
  }
  return request;
}

export function verifyAutonomousResearchOnlineMutationResolution({
  receipt,
  request,
  reserveRequest,
  trust,
  now,
  verifySignature,
  verifyReservation,
} = {}) {
  const checked = assertAutonomousResearchOnlineMutationResolutionRequest(
    request,
    reserveRequest,
  );
  const currentTime = explicitNow(now);
  const observedAt = timestamp(receipt?.observedAt);
  const expectedRequestHash = hashRecord(
    'AutonomousResearchOnlineMutationResolutionRequest', checked,
  );
  const mirrored = RESOLUTION_REQUEST_KEYS.slice(2);
  const resolutionValid = receipt?.resolution === 'not-found'
    ? receipt.reservation === null
    : receipt?.resolution === 'reserved'
      && typeof verifyReservation === 'function'
      && verifyReservation({
        receipt: receipt.reservation,
        request: reserveRequest,
        now,
      }) === true;
  return Boolean(
    trust?.authorityId === receipt?.authorityId
    && trust?.keyId === receipt?.keyId
    && hasExactObjectKeys(receipt, RESOLUTION_RECEIPT_KEYS)
    && receipt.version === 1
    && receipt.kind === 'AutonomousResearchOnlineMutationResolutionReceipt'
    && receipt.status === 'autonomous_research_online_mutation_resolution_observed'
    && receipt.requestHash === expectedRequestHash
    && mirrored.every((key) => receipt[key] === checked[key])
    && resolutionValid
    && observedAt !== null
    && observedAt <= currentTime + 5000
    && currentTime - observedAt <= Number(trust?.maximumObservationAgeMs || 0)
    && typeof verifySignature === 'function'
    && verifySignature(receipt) === true
  );
}

export function verifyAutonomousResearchOnlineMutationAbort({
  receipt,
  request,
  reservation,
  trust,
  now,
  verifySignature,
} = {}) {
  const checkedRequest = assertAutonomousResearchOnlineMutationAbortRequest(
    request,
    reservation,
  );
  const currentTime = explicitNow(now);
  const abortedAt = timestamp(receipt?.abortedAt);
  const expectedRequestHash = hashRecord(
    'AutonomousResearchOnlineMutationAbortRequest',
    checkedRequest,
  );
  const mirrored = ABORT_REQUEST_KEYS.slice(2);
  return Boolean(
    trust?.authorityId === receipt?.authorityId
    && trust?.keyId === receipt?.keyId
    && hasExactObjectKeys(receipt, ABORT_RECEIPT_KEYS)
    && receipt.version === 1
    && receipt.kind === 'AutonomousResearchOnlineMutationAbortReceipt'
    && receipt.status === 'autonomous_research_online_mutation_aborted'
    && receipt.requestHash === expectedRequestHash
    && mirrored.every((key) => receipt[key] === checkedRequest[key])
    && abortedAt !== null
    && abortedAt <= currentTime + 5000
    && typeof verifySignature === 'function'
    && verifySignature(receipt) === true
  );
}

export function autonomousResearchOnlineMutationAbortSignedPayload(receipt) {
  return autonomousResearchOnlineMutationSignedPayload(receipt);
}
