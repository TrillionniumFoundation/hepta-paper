import { hasExactObjectKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  AUTONOMOUS_RESEARCH_ONLINE_MUTATION_PROTOCOL,
} from './autonomous-research-online-mutation-contract.mjs';
import {
  AUTONOMOUS_RESEARCH_STATE_DATABASE_ROLES,
} from './autonomous-research-state-backup-contract.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{1,191}$/;
const ROLE_SET = new Set(AUTONOMOUS_RESEARCH_STATE_DATABASE_ROLES);
const REQUEST_KEYS = Object.freeze([
  'version', 'kind', 'protocol', 'scopeId', 'databaseScopeHash',
  'writerManifestHash', 'databaseRole', 'databaseInstanceId', 'nonce',
  'requestedAt',
]);
const ENTRY_KEYS = Object.freeze(['reserveRequest', 'reservation']);
const RECEIPT_KEYS = Object.freeze([
  'version', 'kind', 'status', 'authorityId', 'keyId', 'requestHash',
  ...REQUEST_KEYS.slice(2),
  'unresolvedReservationCount', 'unresolvedReservationSetHash',
  'unresolvedReservations', 'observedAt', 'expiresAt', 'signature',
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
    fail('autonomous_research_online_unresolved_reservation_now_required');
  }
  return milliseconds;
}

export function assertAutonomousResearchOnlineUnresolvedReservationListRequest(
  request,
  trust,
) {
  if (!hasExactObjectKeys(request, REQUEST_KEYS)
    || request.version !== 1
    || request.kind !== 'AutonomousResearchOnlineUnresolvedReservationListRequest'
    || request.protocol !== AUTONOMOUS_RESEARCH_ONLINE_MUTATION_PROTOCOL
    || request.scopeId !== trust?.scopeId
    || request.databaseScopeHash !== trust?.databaseScopeHash
    || request.writerManifestHash !== trust?.writerManifestHash
    || !SAFE_ID.test(String(request.scopeId || ''))
    || !SHA256.test(String(request.databaseScopeHash || ''))
    || !SHA256.test(String(request.writerManifestHash || ''))
    || !ROLE_SET.has(request.databaseRole)
    || !SAFE_ID.test(String(request.databaseInstanceId || ''))
    || !SAFE_ID.test(String(request.nonce || ''))
    || timestamp(request.requestedAt) === null) {
    fail('autonomous_research_online_unresolved_reservation_list_request_invalid');
  }
  return request;
}

export function autonomousResearchOnlineUnresolvedReservationSetHash(entries) {
  if (!Array.isArray(entries)) {
    fail('autonomous_research_online_unresolved_reservation_set_invalid');
  }
  return hashRecord('AutonomousResearchOnlineUnresolvedReservationSet', entries.map((entry) => ({
    mutationAttemptId: entry?.reserveRequest?.mutationAttemptId,
    reserveRequestHash: hashRecord(
      'AutonomousResearchOnlineMutationReserveRequest',
      entry?.reserveRequest,
    ),
    reservationReceiptHash: hashRecord(
      'AutonomousResearchOnlineMutationReservationReceipt',
      entry?.reservation,
    ),
  })));
}

function validEntry(entry, request, verifyStoredReservation) {
  if (!hasExactObjectKeys(entry, ENTRY_KEYS)) return false;
  const reserveRequest = entry.reserveRequest;
  const reservation = entry.reservation;
  const bindingValid = reserveRequest?.scopeId === request.scopeId
    && reserveRequest?.databaseScopeHash === request.databaseScopeHash
    && reserveRequest?.writerManifestHash === request.writerManifestHash
    && reserveRequest?.databaseRole === request.databaseRole
    && reserveRequest?.databaseInstanceId === request.databaseInstanceId
    && reservation?.mutationAttemptId === reserveRequest?.mutationAttemptId
    && reservation?.databaseRole === request.databaseRole
    && reservation?.databaseInstanceId === request.databaseInstanceId
    && typeof verifyStoredReservation === 'function';
  if (!bindingValid) return false;
  try {
    return verifyStoredReservation({ receipt: reservation, request: reserveRequest }) === true;
  } catch { return false; }
}

export function verifyAutonomousResearchOnlineUnresolvedReservationList({
  receipt,
  request,
  trust,
  now,
  verifySignature,
  verifyStoredReservation,
} = {}) {
  const checked = assertAutonomousResearchOnlineUnresolvedReservationListRequest(
    request,
    trust,
  );
  const currentTime = explicitNow(now);
  const observedAt = timestamp(receipt?.observedAt);
  const expiresAt = timestamp(receipt?.expiresAt);
  const entries = receipt?.unresolvedReservations;
  const mirrored = REQUEST_KEYS.slice(2);
  const entriesValid = Array.isArray(entries)
    // The broker's global head is fenced while a reservation is unresolved.
    // More than one entry would contradict the linearization protocol and
    // could also turn a bounded recovery response into an unbounded payload.
    && entries.length <= 1
    && entries.every((entry) => validEntry(entry, checked, verifyStoredReservation))
    && entries.every((entry, index) => index === 0
      || entries[index - 1].reserveRequest.mutationAttemptId
        < entry.reserveRequest.mutationAttemptId)
    && new Set(entries.map((entry) => entry.reservation.reservationId)).size
      === entries.length;
  return Boolean(
    trust?.version === 1
    && trust?.kind === 'AutonomousResearchOnlineMutationAuthorityTrust'
    && SAFE_ID.test(String(trust.authorityId || ''))
    && SAFE_ID.test(String(trust.keyId || ''))
    && Number.isSafeInteger(trust.maximumObservationAgeMs)
    && trust.maximumObservationAgeMs >= 1000
    && hasExactObjectKeys(receipt, RECEIPT_KEYS)
    && receipt.version === 1
    && receipt.kind === 'AutonomousResearchOnlineUnresolvedReservationListReceipt'
    && receipt.status === 'autonomous_research_online_unresolved_reservations_observed'
    && receipt.authorityId === trust?.authorityId
    && receipt.keyId === trust?.keyId
    && receipt.requestHash === hashRecord(
      'AutonomousResearchOnlineUnresolvedReservationListRequest', checked,
    )
    && mirrored.every((key) => receipt[key] === checked[key])
    && entriesValid
    && receipt.unresolvedReservationCount === entries?.length
    && SHA256.test(String(receipt.unresolvedReservationSetHash || ''))
    && receipt.unresolvedReservationSetHash
      === autonomousResearchOnlineUnresolvedReservationSetHash(entries)
    && observedAt !== null
    && expiresAt !== null
    && observedAt <= currentTime + 5000
    && currentTime - observedAt <= Number(trust?.maximumObservationAgeMs || 0)
    && expiresAt > currentTime
    && expiresAt > observedAt
    && expiresAt - observedAt <= Number(trust?.maximumObservationAgeMs || 0)
    && typeof verifySignature === 'function'
    && verifySignature(receipt) === true
  );
}
