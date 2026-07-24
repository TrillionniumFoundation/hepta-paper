import { hasExactObjectKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  AUTONOMOUS_RESEARCH_STATE_DATABASE_ROLES,
} from './autonomous-research-state-backup-contract.mjs';

export const AUTONOMOUS_RESEARCH_ONLINE_MUTATION_PROTOCOL =
  'external-linearizable-reserve-apply-finalize-v1';
export const AUTONOMOUS_RESEARCH_ONLINE_MUTATION_VERIFICATION_SOURCE =
  'pinned-external-authority-public-key-v1';
export const AUTONOMOUS_RESEARCH_ONLINE_MUTATION_MAXIMUM_CHANGESET_BYTES =
  16 * 1024 * 1024;

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{1,191}$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const CLOCK_SKEW_MS = 5000;
const ROLE_SET = new Set(AUTONOMOUS_RESEARCH_STATE_DATABASE_ROLES);

const RESERVE_REQUEST_KEYS = Object.freeze([
  'version', 'kind', 'protocol', 'scopeId', 'databaseScopeHash', 'writerManifestHash',
  'databaseRole', 'databaseInstanceId', 'writerId', 'operationId', 'codeProvenanceHash',
  'mutationAttemptId',
  'globalPreviousSequence', 'globalPreviousHash', 'databasePreviousSequence',
  'databasePreviousHash', 'schemaContractId', 'schemaHash', 'preStateHash', 'postStateHash',
  'changesetEncoding', 'changesetBase64', 'changesetByteLength', 'changesetHash',
  'authorizationReceiptHashes', 'sideEffectReservationHashes', 'requestedAt',
  'requestedLeaseMs',
]);

const RESERVATION_KEYS = Object.freeze([
  'version', 'kind', 'status', 'authorityId', 'keyId', 'requestHash', 'reservationId',
  'protocol', 'scopeId', 'databaseScopeHash', 'writerManifestHash', 'databaseRole',
  'databaseInstanceId', 'writerId', 'operationId', 'codeProvenanceHash',
  'mutationAttemptId',
  'globalPreviousSequence', 'globalPreviousHash', 'globalSequence', 'globalHash',
  'databasePreviousSequence', 'databasePreviousHash', 'databaseSequence', 'databaseHash',
  'schemaContractId', 'schemaHash', 'preStateHash', 'postStateHash', 'changesetEncoding',
  'changesetBase64', 'changesetByteLength', 'changesetHash', 'authorizationReceiptHashes',
  'sideEffectReservationHashes', 'issuedAt', 'expiresAt', 'signature',
]);

const FINALIZE_REQUEST_KEYS = Object.freeze([
  'version', 'kind', 'protocol', 'scopeId', 'databaseScopeHash', 'writerManifestHash',
  'reservationId', 'reservationReceiptHash', 'databaseRole', 'databaseInstanceId',
  'writerId', 'operationId', 'globalSequence', 'globalHash', 'databaseSequence',
  'databaseHash', 'schemaHash', 'postStateHash', 'changesetHash', 'localMarkerHash',
  'authorizationReceiptHashes', 'sideEffectReservationHashes', 'committedAt',
]);

const FINALIZATION_KEYS = Object.freeze([
  'version', 'kind', 'status', 'authorityId', 'keyId', 'requestHash', 'reservationId',
  'reservationReceiptHash', 'protocol', 'scopeId', 'databaseScopeHash',
  'writerManifestHash', 'databaseRole', 'databaseInstanceId', 'writerId', 'operationId',
  'globalSequence', 'globalHash', 'databaseSequence', 'databaseHash', 'schemaHash',
  'postStateHash', 'changesetHash', 'localMarkerHash', 'authorizationReceiptHashes',
  'sideEffectReservationHashes', 'sideEffectPermitHash', 'finalizedAt', 'signature',
]);

const HEAD_REQUEST_KEYS = Object.freeze([
  'version', 'kind', 'protocol', 'scopeId', 'databaseScopeHash', 'writerManifestHash',
  'nonce', 'requestedAt',
]);

const HEAD_RECEIPT_KEYS = Object.freeze([
  'version', 'kind', 'status', 'authorityId', 'keyId', 'requestHash', 'protocol',
  'scopeId', 'databaseScopeHash', 'writerManifestHash', 'globalSequence', 'globalHash',
  'databaseHeads', 'unresolvedReservationCount', 'observedAt', 'expiresAt', 'signature',
]);

const CHALLENGE_REQUEST_KEYS = Object.freeze([
  'version', 'kind', 'protocol', 'scopeId', 'databaseScopeHash', 'writerManifestHash',
  'challengeNonce', 'requestedAt',
]);

const CHALLENGE_RECEIPT_KEYS = Object.freeze([
  'version', 'kind', 'status', 'authorityId', 'keyId', 'requestHash', 'protocol',
  'scopeId', 'databaseScopeHash', 'writerManifestHash', 'globalSequence', 'globalHash',
  'databaseHeads', 'challengeNonce', 'challengedAt', 'expiresAt', 'signature',
]);

const SCOPE_REQUEST_KEYS = Object.freeze([
  'version', 'kind', 'protocol', 'scopeId', 'databaseScopeHash', 'writerManifestHash',
  'staticInspectionReceiptHash', 'astGateReceiptHash', 'codeProvenanceHash',
  'operationCount', 'operationIds', 'requiredDatabaseRoles', 'coveredDatabaseRoles',
  'nonce', 'requestedAt',
]);

const SCOPE_RECEIPT_KEYS = Object.freeze([
  'version', 'kind', 'status', 'authorityId', 'keyId', 'requestHash', 'protocol',
  'scopeId', 'databaseScopeHash', 'writerManifestHash', 'staticInspectionReceiptHash',
  'astGateReceiptHash', 'codeProvenanceHash', 'operationCount', 'operationIds',
  'requiredDatabaseRoles', 'coveredDatabaseRoles', 'globalSequence', 'globalHash',
  'observedAt', 'expiresAt', 'signature',
]);

function fail(code) {
  throw new Error(code);
}

function isSha256(value) {
  return SHA256.test(String(value || ''));
}

function isSafeId(value) {
  return SAFE_ID.test(String(value || ''));
}

function timestamp(value) {
  const milliseconds = Date.parse(String(value || ''));
  return Number.isFinite(milliseconds) ? milliseconds : null;
}

function explicitNow(now) {
  const milliseconds = now instanceof Date ? now.getTime() : new Date(now).getTime();
  if (!Number.isFinite(milliseconds)) fail('autonomous_research_online_mutation_now_required');
  return milliseconds;
}

function sameArray(left, right) {
  return Array.isArray(left)
    && Array.isArray(right)
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function sortedUniqueHashes(values) {
  return Array.isArray(values)
    && values.every(isSha256)
    && values.every((value, index) => index === 0 || values[index - 1] < value);
}

function sortedUniqueIds(values) {
  return Array.isArray(values)
    && values.every(isSafeId)
    && values.every((value, index) => index === 0 || values[index - 1] < value);
}

function sortedUniqueRoles(values) {
  return Array.isArray(values)
    && values.every((role) => ROLE_SET.has(role))
    && values.every((value, index) => index === 0 || values[index - 1] < value);
}

function decodedBase64ByteLength(value) {
  if (typeof value !== 'string' || !BASE64.test(value)) return null;
  if (value.length === 0) return 0;
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  return ((value.length / 4) * 3) - padding;
}

function assertTrust(trust) {
  if (trust?.version !== 1
    || trust?.kind !== 'AutonomousResearchOnlineMutationAuthorityTrust'
    || !isSafeId(trust.authorityId)
    || !isSafeId(trust.keyId)
    || !isSafeId(trust.scopeId)
    || !isSha256(trust.databaseScopeHash)
    || !isSha256(trust.writerManifestHash)
    || !Number.isSafeInteger(trust.maximumReservationLeaseMs)
    || trust.maximumReservationLeaseMs < 1000
    || !Number.isSafeInteger(trust.maximumObservationAgeMs)
    || trust.maximumObservationAgeMs < 1000) {
    fail('autonomous_research_online_mutation_authority_trust_invalid');
  }
  return trust;
}

function commonRequestValid(request, keys, kind) {
  return hasExactObjectKeys(request, keys)
    && request.version === 1
    && request.kind === kind
    && request.protocol === AUTONOMOUS_RESEARCH_ONLINE_MUTATION_PROTOCOL
    && isSafeId(request.scopeId)
    && isSha256(request.databaseScopeHash)
    && isSha256(request.writerManifestHash);
}

function requestMatchesTrust(request, trust) {
  return request.scopeId === trust.scopeId
    && request.databaseScopeHash === trust.databaseScopeHash
    && request.writerManifestHash === trust.writerManifestHash;
}

function validChangeset(value, hashChangesetBase64) {
  const byteLength = decodedBase64ByteLength(value?.changesetBase64);
  return value?.changesetEncoding === 'base64'
    && byteLength !== null
    && byteLength > 0
    && byteLength <= AUTONOMOUS_RESEARCH_ONLINE_MUTATION_MAXIMUM_CHANGESET_BYTES
    && value.changesetByteLength === byteLength
    && isSha256(value.changesetHash)
    && typeof hashChangesetBase64 === 'function'
    && hashChangesetBase64(value.changesetBase64) === value.changesetHash;
}

function validDatabaseHeads(heads, expectedDatabaseInstances) {
  if (!Array.isArray(heads) || heads.length === 0) return false;
  const instanceIds = new Set();
  for (const head of heads) {
    if (!hasExactObjectKeys(head, [
      'databaseRole', 'databaseInstanceId', 'sequence', 'hash', 'schemaHash', 'stateHash',
    ])
      || !ROLE_SET.has(head.databaseRole)
      || !isSafeId(head.databaseInstanceId)
      || instanceIds.has(head.databaseInstanceId)
      || !Number.isSafeInteger(head.sequence)
      || head.sequence < 0
      || !isSha256(head.hash)
      || !isSha256(head.schemaHash)
      || !isSha256(head.stateHash)) return false;
    instanceIds.add(head.databaseInstanceId);
  }
  const sorted = heads.every((head, index) => (
    index === 0 || heads[index - 1].databaseInstanceId < head.databaseInstanceId
  ));
  const coveredRoles = [...new Set(heads.map((head) => head.databaseRole))].sort();
  if (!sorted || !sameArray(coveredRoles, [...ROLE_SET].sort())) return false;
  if (expectedDatabaseInstances === undefined) return true;
  if (!Array.isArray(expectedDatabaseInstances)
    || expectedDatabaseInstances.length !== heads.length) return false;
  return expectedDatabaseInstances.every((expected, index) => (
    hasExactObjectKeys(expected, ['databaseRole', 'databaseInstanceId', 'schemaHash'])
    && expected.databaseRole === heads[index].databaseRole
    && expected.databaseInstanceId === heads[index].databaseInstanceId
    && expected.schemaHash === heads[index].schemaHash
  ));
}

function signatureValid(receipt, trust, verifySignature) {
  return receipt.authorityId === trust.authorityId
    && receipt.keyId === trust.keyId
    && typeof verifySignature === 'function'
    && verifySignature(receipt) === true;
}

function liveWindowValid({ observedAt, expiresAt, now, maximumAgeMs, maximumLeaseMs }) {
  const observed = timestamp(observedAt);
  const expires = timestamp(expiresAt);
  return observed !== null
    && expires !== null
    && observed <= now + CLOCK_SKEW_MS
    && now - observed <= maximumAgeMs
    && expires > now
    && expires > observed
    && expires - observed <= maximumLeaseMs;
}

function requestHash(kind, request) {
  return hashRecord(kind, request);
}

export function autonomousResearchOnlineMutationSignedPayload(receipt) {
  const unsigned = Object.fromEntries(
    Object.entries(receipt || {}).filter(([key]) => key !== 'signature'),
  );
  return hashRecord('AutonomousResearchOnlineMutationAuthoritySignedPayload', unsigned);
}

export function autonomousResearchOnlineMutationReceiptHash(receipt) {
  return hashRecord(String(receipt?.kind || 'InvalidOnlineMutationReceipt'), receipt);
}

export function autonomousResearchOnlineMutationStateHash(input) {
  if (!hasExactObjectKeys(input, [
    'databaseRole', 'databaseInstanceId', 'writerId', 'operationId',
    'schemaHash', 'previousStateHash', 'changesetHash', 'databaseSequence',
    'authorizationReceiptHashes', 'sideEffectReservationHashes',
  ])
    || !ROLE_SET.has(input.databaseRole)
    || !isSafeId(input.databaseInstanceId)
    || !isSafeId(input.writerId)
    || !isSafeId(input.operationId)
    || !isSha256(input.schemaHash)
    || !isSha256(input.previousStateHash)
    || !isSha256(input.changesetHash)
    || !Number.isSafeInteger(input.databaseSequence)
    || input.databaseSequence < 1
    || !sortedUniqueHashes(input.authorizationReceiptHashes)
    || !sortedUniqueHashes(input.sideEffectReservationHashes)) {
    fail('autonomous_research_online_mutation_state_hash_input_invalid');
  }
  return hashRecord('AutonomousResearchOnlineMutationState', input);
}

export function autonomousResearchOnlineMutationLocalMarkerHash({
  reservation,
  committedAt,
} = {}) {
  if (!reservation
    || !isSafeId(reservation.reservationId)
    || timestamp(committedAt) === null) {
    fail('autonomous_research_online_mutation_local_marker_input_invalid');
  }
  return hashRecord('AutonomousResearchOnlineMutationLocalMarker', {
    reservationId: reservation.reservationId,
    reservationReceiptHash: autonomousResearchOnlineMutationReceiptHash(reservation),
    databaseRole: reservation.databaseRole,
    databaseInstanceId: reservation.databaseInstanceId,
    writerId: reservation.writerId,
    operationId: reservation.operationId,
    globalSequence: reservation.globalSequence,
    globalHash: reservation.globalHash,
    databaseSequence: reservation.databaseSequence,
    databaseHash: reservation.databaseHash,
    schemaHash: reservation.schemaHash,
    preStateHash: reservation.preStateHash,
    postStateHash: reservation.postStateHash,
    changesetHash: reservation.changesetHash,
    committedAt,
  });
}

export function assertAutonomousResearchOnlineMutationReserveRequest(
  request,
  { trust, hashChangesetBase64 } = {},
) {
  const checkedTrust = assertTrust(trust);
  if (!commonRequestValid(
    request,
    RESERVE_REQUEST_KEYS,
    'AutonomousResearchOnlineMutationReserveRequest',
  )
    || !requestMatchesTrust(request, checkedTrust)
    || !ROLE_SET.has(request.databaseRole)
    || !isSafeId(request.databaseInstanceId)
    || !isSafeId(request.writerId)
    || !isSafeId(request.operationId)
    || !isSafeId(request.mutationAttemptId)
    || !isSha256(request.codeProvenanceHash)
    || !Number.isSafeInteger(request.globalPreviousSequence)
    || request.globalPreviousSequence < 0
    || !isSha256(request.globalPreviousHash)
    || !Number.isSafeInteger(request.databasePreviousSequence)
    || request.databasePreviousSequence < 0
    || !isSha256(request.databasePreviousHash)
    || !isSafeId(request.schemaContractId)
    || !isSha256(request.schemaHash)
    || !isSha256(request.preStateHash)
    || !isSha256(request.postStateHash)
    || request.preStateHash === request.postStateHash
    || !validChangeset(request, hashChangesetBase64)
    || !sortedUniqueHashes(request.authorizationReceiptHashes)
    || !sortedUniqueHashes(request.sideEffectReservationHashes)
    || timestamp(request.requestedAt) === null
    || !Number.isSafeInteger(request.requestedLeaseMs)
    || request.requestedLeaseMs < 1000
    || request.requestedLeaseMs > checkedTrust.maximumReservationLeaseMs
    || request.postStateHash !== autonomousResearchOnlineMutationStateHash({
      databaseRole: request.databaseRole,
      databaseInstanceId: request.databaseInstanceId,
      writerId: request.writerId,
      operationId: request.operationId,
      schemaHash: request.schemaHash,
      previousStateHash: request.preStateHash,
      changesetHash: request.changesetHash,
      databaseSequence: request.databasePreviousSequence + 1,
      authorizationReceiptHashes: request.authorizationReceiptHashes,
      sideEffectReservationHashes: request.sideEffectReservationHashes,
    })) {
    fail('autonomous_research_online_mutation_reserve_request_invalid');
  }
  return request;
}

export function verifyAutonomousResearchOnlineMutationReservation({
  receipt,
  request,
  trust,
  now,
  verifySignature,
  hashChangesetBase64,
} = {}) {
  const checkedTrust = assertTrust(trust);
  const checkedRequest = assertAutonomousResearchOnlineMutationReserveRequest(
    request,
    { trust: checkedTrust, hashChangesetBase64 },
  );
  const currentTime = explicitNow(now);
  const expectedRequestHash = requestHash(
    'AutonomousResearchOnlineMutationReserveRequest', checkedRequest,
  );
  const issuedAt = timestamp(receipt?.issuedAt);
  const expiresAt = timestamp(receipt?.expiresAt);
  const mirroredKeys = [
    'protocol', 'scopeId', 'databaseScopeHash', 'writerManifestHash', 'databaseRole',
    'databaseInstanceId', 'writerId', 'operationId', 'codeProvenanceHash',
    'mutationAttemptId',
    'globalPreviousSequence', 'globalPreviousHash', 'databasePreviousSequence',
    'databasePreviousHash', 'schemaContractId', 'schemaHash', 'preStateHash', 'postStateHash',
    'changesetEncoding', 'changesetBase64', 'changesetByteLength', 'changesetHash',
  ];
  return Boolean(
    hasExactObjectKeys(receipt, RESERVATION_KEYS)
    && receipt.version === 1
    && receipt.kind === 'AutonomousResearchOnlineMutationReservationReceipt'
    && receipt.status === 'autonomous_research_online_mutation_reserved'
    && isSafeId(receipt.reservationId)
    && receipt.requestHash === expectedRequestHash
    && mirroredKeys.every((key) => receipt[key] === checkedRequest[key])
    && sameArray(receipt.authorizationReceiptHashes, checkedRequest.authorizationReceiptHashes)
    && sameArray(receipt.sideEffectReservationHashes, checkedRequest.sideEffectReservationHashes)
    && receipt.globalSequence === checkedRequest.globalPreviousSequence + 1
    && isSha256(receipt.globalHash)
    && receipt.databaseSequence === checkedRequest.databasePreviousSequence + 1
    && isSha256(receipt.databaseHash)
    && validChangeset(receipt, hashChangesetBase64)
    && issuedAt !== null
    && expiresAt !== null
    && issuedAt <= currentTime + CLOCK_SKEW_MS
    && expiresAt > currentTime
    && expiresAt > issuedAt
    && expiresAt - issuedAt <= checkedRequest.requestedLeaseMs
    && signatureValid(receipt, checkedTrust, verifySignature)
  );
}

export function assertAutonomousResearchOnlineMutationFinalizeRequest(request, reservation) {
  if (!commonRequestValid(
    request,
    FINALIZE_REQUEST_KEYS,
    'AutonomousResearchOnlineMutationFinalizeRequest',
  )
    || !isSafeId(request.reservationId)
    || request.reservationId !== reservation?.reservationId
    || request.reservationReceiptHash !== autonomousResearchOnlineMutationReceiptHash(reservation)
    || !isSha256(request.reservationReceiptHash)
    || !ROLE_SET.has(request.databaseRole)
    || !isSafeId(request.databaseInstanceId)
    || !isSafeId(request.writerId)
    || !isSafeId(request.operationId)
    || !Number.isSafeInteger(request.globalSequence)
    || !isSha256(request.globalHash)
    || !Number.isSafeInteger(request.databaseSequence)
    || !isSha256(request.databaseHash)
    || !isSha256(request.schemaHash)
    || !isSha256(request.postStateHash)
    || !isSha256(request.changesetHash)
    || !isSha256(request.localMarkerHash)
    || !sortedUniqueHashes(request.authorizationReceiptHashes)
    || !sortedUniqueHashes(request.sideEffectReservationHashes)
    || timestamp(request.committedAt) === null
    || request.localMarkerHash !== autonomousResearchOnlineMutationLocalMarkerHash({
      reservation,
      committedAt: request.committedAt,
    })) {
    fail('autonomous_research_online_mutation_finalize_request_invalid');
  }
  const mirrored = [
    'protocol', 'scopeId', 'databaseScopeHash', 'writerManifestHash', 'databaseRole',
    'databaseInstanceId', 'writerId', 'operationId', 'globalSequence', 'globalHash',
    'databaseSequence', 'databaseHash', 'schemaHash', 'postStateHash', 'changesetHash',
  ];
  if (!mirrored.every((key) => request[key] === reservation[key])
    || !sameArray(request.authorizationReceiptHashes, reservation.authorizationReceiptHashes)
    || !sameArray(request.sideEffectReservationHashes, reservation.sideEffectReservationHashes)) {
    fail('autonomous_research_online_mutation_finalize_request_reservation_mismatch');
  }
  return request;
}

export function verifyAutonomousResearchOnlineMutationFinalization({
  receipt,
  request,
  reservation,
  trust,
  now,
  verifySignature,
} = {}) {
  const checkedTrust = assertTrust(trust);
  const checkedRequest = assertAutonomousResearchOnlineMutationFinalizeRequest(request, reservation);
  const currentTime = explicitNow(now);
  const finalizedAt = timestamp(receipt?.finalizedAt);
  const committedAt = timestamp(checkedRequest.committedAt);
  const issuedAt = timestamp(reservation?.issuedAt);
  const expiresAt = timestamp(reservation?.expiresAt);
  const mirrored = [
    'reservationId', 'reservationReceiptHash', 'protocol', 'scopeId', 'databaseScopeHash',
    'writerManifestHash', 'databaseRole', 'databaseInstanceId', 'writerId', 'operationId',
    'globalSequence', 'globalHash', 'databaseSequence', 'databaseHash', 'schemaHash',
    'postStateHash', 'changesetHash', 'localMarkerHash',
  ];
  return Boolean(
    hasExactObjectKeys(receipt, FINALIZATION_KEYS)
    && receipt.version === 1
    && receipt.kind === 'AutonomousResearchOnlineMutationFinalizationReceipt'
    && receipt.status === 'autonomous_research_online_mutation_finalized'
    && receipt.requestHash === requestHash(
      'AutonomousResearchOnlineMutationFinalizeRequest', checkedRequest,
    )
    && mirrored.every((key) => receipt[key] === checkedRequest[key])
    && sameArray(receipt.authorizationReceiptHashes, checkedRequest.authorizationReceiptHashes)
    && sameArray(receipt.sideEffectReservationHashes, checkedRequest.sideEffectReservationHashes)
    && isSha256(receipt.sideEffectPermitHash)
    && finalizedAt !== null
    && committedAt !== null
    && issuedAt !== null
    && expiresAt !== null
    && committedAt >= issuedAt - CLOCK_SKEW_MS
    && committedAt <= expiresAt
    && finalizedAt >= committedAt
    && finalizedAt <= currentTime + CLOCK_SKEW_MS
    && signatureValid(receipt, checkedTrust, verifySignature)
  );
}

function assertObservationRequest(request, trust, keys, kind, nonceKey) {
  const checkedTrust = assertTrust(trust);
  if (!commonRequestValid(request, keys, kind)
    || !requestMatchesTrust(request, checkedTrust)
    || !isSafeId(request[nonceKey])
    || timestamp(request.requestedAt) === null) {
    fail('autonomous_research_online_mutation_observation_request_invalid');
  }
  return request;
}

function verifyHeadLikeReceipt({
  receipt,
  request,
  trust,
  now,
  verifySignature,
  requestKeys,
  requestKind,
  requestNonceKey,
  receiptKeys,
  receiptKind,
  receiptStatus,
  observedField,
  expectedDatabaseInstances,
} = {}) {
  const checkedTrust = assertTrust(trust);
  const checkedRequest = assertObservationRequest(
    request, checkedTrust, requestKeys, requestKind, requestNonceKey,
  );
  const currentTime = explicitNow(now);
  return Boolean(
    hasExactObjectKeys(receipt, receiptKeys)
    && receipt.version === 1
    && receipt.kind === receiptKind
    && receipt.status === receiptStatus
    && receipt.requestHash === requestHash(requestKind, checkedRequest)
    && receipt.protocol === checkedRequest.protocol
    && receipt.scopeId === checkedRequest.scopeId
    && receipt.databaseScopeHash === checkedRequest.databaseScopeHash
    && receipt.writerManifestHash === checkedRequest.writerManifestHash
    && Number.isSafeInteger(receipt.globalSequence)
    && receipt.globalSequence >= 0
    && isSha256(receipt.globalHash)
    && validDatabaseHeads(receipt.databaseHeads, expectedDatabaseInstances)
    && signatureValid(receipt, checkedTrust, verifySignature)
    && liveWindowValid({
      observedAt: receipt[observedField],
      expiresAt: receipt.expiresAt,
      now: currentTime,
      maximumAgeMs: checkedTrust.maximumObservationAgeMs,
      maximumLeaseMs: checkedTrust.maximumReservationLeaseMs,
    })
  );
}

export function verifyAutonomousResearchOnlineMutationCurrentHead(input = {}) {
  return verifyHeadLikeReceipt({
    ...input,
    requestKeys: HEAD_REQUEST_KEYS,
    requestKind: 'AutonomousResearchOnlineMutationCurrentHeadRequest',
    requestNonceKey: 'nonce',
    receiptKeys: HEAD_RECEIPT_KEYS,
    receiptKind: 'AutonomousResearchOnlineMutationCurrentHeadReceipt',
    receiptStatus: 'autonomous_research_online_mutation_current_head_observed',
    observedField: 'observedAt',
  }) && input.receipt.unresolvedReservationCount === 0;
}

export function verifyAutonomousResearchOnlineMutationActiveChallenge(input = {}) {
  return verifyHeadLikeReceipt({
    ...input,
    requestKeys: CHALLENGE_REQUEST_KEYS,
    requestKind: 'AutonomousResearchOnlineMutationActiveChallengeRequest',
    requestNonceKey: 'challengeNonce',
    receiptKeys: CHALLENGE_RECEIPT_KEYS,
    receiptKind: 'AutonomousResearchOnlineMutationActiveChallengeReceipt',
    receiptStatus: 'autonomous_research_online_mutation_active_challenge_verified',
    observedField: 'challengedAt',
  }) && input.receipt.challengeNonce === input.request.challengeNonce;
}

export function assertAutonomousResearchOnlineMutationScopeRequest(request, trust) {
  const checkedTrust = assertTrust(trust);
  if (!commonRequestValid(
    request,
    SCOPE_REQUEST_KEYS,
    'AutonomousResearchOnlineMutationScopeRequest',
  )
    || !requestMatchesTrust(request, checkedTrust)
    || !isSha256(request.staticInspectionReceiptHash)
    || !isSha256(request.astGateReceiptHash)
    || request.staticInspectionReceiptHash !== request.astGateReceiptHash
    || !isSha256(request.codeProvenanceHash)
    || !Number.isSafeInteger(request.operationCount)
    || request.operationCount < 1
    || !sortedUniqueIds(request.operationIds)
    || request.operationIds.length !== request.operationCount
    || !sortedUniqueRoles(request.requiredDatabaseRoles)
    || !sameArray(request.requiredDatabaseRoles, [...ROLE_SET].sort())
    || !sortedUniqueRoles(request.coveredDatabaseRoles)
    || request.coveredDatabaseRoles.some((role) => !request.requiredDatabaseRoles.includes(role))
    || !isSafeId(request.nonce)
    || timestamp(request.requestedAt) === null) {
    fail('autonomous_research_online_mutation_scope_request_invalid');
  }
  return request;
}

export function verifyAutonomousResearchOnlineMutationScopeReceipt({
  receipt,
  request,
  trust,
  now,
  verifySignature,
} = {}) {
  const checkedTrust = assertTrust(trust);
  const checkedRequest = assertAutonomousResearchOnlineMutationScopeRequest(request, checkedTrust);
  const currentTime = explicitNow(now);
  return Boolean(
    hasExactObjectKeys(receipt, SCOPE_RECEIPT_KEYS)
    && receipt.version === 1
    && receipt.kind === 'AutonomousResearchOnlineMutationScopeReceipt'
    && receipt.status === 'autonomous_research_online_mutation_scope_observed'
    && receipt.requestHash === requestHash(
      'AutonomousResearchOnlineMutationScopeRequest', checkedRequest,
    )
    && receipt.protocol === checkedRequest.protocol
    && receipt.scopeId === checkedRequest.scopeId
    && receipt.databaseScopeHash === checkedRequest.databaseScopeHash
    && receipt.writerManifestHash === checkedRequest.writerManifestHash
    && receipt.staticInspectionReceiptHash === checkedRequest.staticInspectionReceiptHash
    && receipt.astGateReceiptHash === checkedRequest.astGateReceiptHash
    && receipt.codeProvenanceHash === checkedRequest.codeProvenanceHash
    && receipt.operationCount === checkedRequest.operationCount
    && sameArray(receipt.operationIds, checkedRequest.operationIds)
    && sameArray(receipt.requiredDatabaseRoles, checkedRequest.requiredDatabaseRoles)
    && sameArray(receipt.coveredDatabaseRoles, checkedRequest.coveredDatabaseRoles)
    && Number.isSafeInteger(receipt.globalSequence)
    && receipt.globalSequence >= 0
    && isSha256(receipt.globalHash)
    && signatureValid(receipt, checkedTrust, verifySignature)
    && liveWindowValid({
      observedAt: receipt.observedAt,
      expiresAt: receipt.expiresAt,
      now: currentTime,
      maximumAgeMs: checkedTrust.maximumObservationAgeMs,
      maximumLeaseMs: checkedTrust.maximumReservationLeaseMs,
    })
  );
}
