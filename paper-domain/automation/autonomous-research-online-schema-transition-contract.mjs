import { hasExactObjectKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  AUTONOMOUS_RESEARCH_STATE_DATABASE_ROLES,
  autonomousResearchStateDatabaseScopeHash,
} from './autonomous-research-state-backup-contract.mjs';

export const AUTONOMOUS_RESEARCH_ONLINE_SCHEMA_TRANSITION_PROTOCOL =
  'external-authority-quiesced-offline-schema-transition-v1';
export const AUTONOMOUS_RESEARCH_PRISTINE_SCHEMA_REBIND_PROTOCOL =
  'external-authority-pristine-finalized-schema-rebind-v2';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{1,191}$/;
const ROLE_SET = new Set(AUTONOMOUS_RESEARCH_STATE_DATABASE_ROLES);
const CLOCK_SKEW_MS = 5000;

const INSTANCE_KEYS = Object.freeze([
  'databaseRole', 'databaseInstanceId', 'sourceRelativePath', 'preSchemaContractId',
  'schemaContractId',
  'preSchemaHash', 'expectedPostSchemaHash', 'sourceSha256', 'sourceFileIdentityHash',
  'journalPreimageHash', 'expectedNormalizedSourceSha256', 'prePristineStateHash',
]);
const GENESIS_KEYS = Object.freeze([
  'databaseRole', 'databaseInstanceId', 'schemaContractId', 'schemaHash',
  'globalSequence', 'globalHash', 'databaseSequence', 'databaseHash', 'stateHash',
]);
const PREVIOUS_HEAD_KEYS = Object.freeze([
  'databaseRole', 'databaseInstanceId', 'sequence', 'hash', 'schemaHash', 'stateHash',
]);
const INSTALLATION_KEYS = Object.freeze([
  'databaseRole', 'databaseInstanceId', 'schemaContractId', 'preSchemaHash',
  'postSchemaHash', 'prePristineStateHash', 'postPristineStateHash', 'installationHash',
]);
const RESERVE_REQUEST_KEYS = Object.freeze([
  'version', 'kind', 'protocol', 'scopeId', 'databaseScopeHash', 'writerManifestHash',
  'stateDatabaseManifestHash', 'transitionInventoryHash', 'schemaBundleHash',
  'authorityJournalSchemaContractId', 'authorityJournalSchemaHash', 'markerSchemaHash',
  'transitionId', 'instances', 'requestedAt', 'requestedLeaseMs',
  'requiredExecutionWindowMs',
]);
const REBIND_RESERVE_REQUEST_KEYS = Object.freeze([
  ...RESERVE_REQUEST_KEYS,
  'transitionMode', 'sourceWriterManifestHash', 'prePristineRuntimeStateHash',
]);
const RESERVATION_KEYS = Object.freeze([
  'version', 'kind', 'status', 'authorityId', 'keyId', 'requestHash', 'reservationId',
  'protocol', 'scopeId', 'databaseScopeHash', 'writerManifestHash',
  'stateDatabaseManifestHash', 'transitionInventoryHash', 'schemaBundleHash',
  'authorityJournalSchemaContractId', 'authorityJournalSchemaHash', 'markerSchemaHash',
  'transitionId', 'instances', 'databaseGenesis', 'issuedAt', 'expiresAt',
  'allRegisteredMutationsFenced', 'quiescenceMode', 'signature',
]);
const REBIND_RESERVATION_KEYS = Object.freeze([
  ...RESERVATION_KEYS,
  'transitionMode', 'sourceWriterManifestHash', 'previousGlobalSequence',
  'previousGlobalHash', 'previousDatabaseHeads', 'targetAuthorityConfigurationHash',
  'authorityRestartRequired', 'prePristineRuntimeStateHash',
]);
const FINALIZE_REQUEST_KEYS = Object.freeze([
  'version', 'kind', 'protocol', 'scopeId', 'databaseScopeHash', 'writerManifestHash',
  'transitionId', 'transitionInventoryHash', 'schemaBundleHash', 'reservationId',
  'reservationReceiptHash', 'postInventoryHash', 'postPristineRuntimeStateHash',
  'installations', 'completedAt',
]);
const FINALIZATION_KEYS = Object.freeze([
  'version', 'kind', 'status', 'authorityId', 'keyId', 'requestHash', 'protocol',
  'scopeId', 'databaseScopeHash', 'writerManifestHash', 'transitionId',
  'transitionInventoryHash', 'schemaBundleHash', 'reservationId',
  'reservationReceiptHash', 'postInventoryHash', 'postPristineRuntimeStateHash',
  'installations', 'globalSequence',
  'globalHash', 'finalizedAt', 'allRegisteredMutationsFencedThroughFinalize',
  'signature',
]);
const REBIND_FINALIZATION_KEYS = Object.freeze([
  ...FINALIZATION_KEYS,
  'transitionMode', 'sourceWriterManifestHash', 'targetAuthorityConfigurationHash',
  'authorityRestartRequired',
]);
const OBSERVE_REQUEST_KEYS = Object.freeze([
  'version', 'kind', 'protocol', 'scopeId', 'databaseScopeHash', 'writerManifestHash',
  'transitionId', 'transitionInventoryHash', 'schemaBundleHash',
  'finalizationReceiptHash', 'postInventoryHash', 'postPristineRuntimeStateHash',
  'nonce', 'requestedAt',
]);
const REBIND_OBSERVE_REQUEST_KEYS = Object.freeze([
  ...OBSERVE_REQUEST_KEYS,
  'transitionMode', 'sourceWriterManifestHash',
]);
const OBSERVATION_KEYS = Object.freeze([
  'version', 'kind', 'status', 'authorityId', 'keyId', 'requestHash', 'protocol',
  'scopeId', 'databaseScopeHash', 'writerManifestHash', 'transitionId',
  'transitionInventoryHash', 'schemaBundleHash', 'finalizationReceiptHash',
  'postInventoryHash', 'postPristineRuntimeStateHash', 'transitionState',
  'globalSequence', 'globalHash',
  'observedAt', 'expiresAt', 'signature',
]);
const REBIND_OBSERVATION_KEYS = Object.freeze([
  ...OBSERVATION_KEYS,
  'transitionMode', 'sourceWriterManifestHash', 'authorityConfigurationActivated',
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
    fail('autonomous_research_online_schema_transition_now_required');
  }
  return milliseconds;
}

function sameArray(left, right) {
  return Array.isArray(left)
    && Array.isArray(right)
    && left.length === right.length
    && left.every((value, index) => JSON.stringify(value) === JSON.stringify(right[index]));
}

function validTrust(trust) {
  if (trust?.version !== 1
    || trust?.kind !== 'AutonomousResearchOnlineMutationAuthorityTrust'
    || !SAFE_ID.test(String(trust.authorityId || ''))
    || !SAFE_ID.test(String(trust.keyId || ''))
    || !SAFE_ID.test(String(trust.scopeId || ''))
    || !SHA256.test(String(trust.databaseScopeHash || ''))
    || !SHA256.test(String(trust.writerManifestHash || ''))
    || !Number.isSafeInteger(trust.maximumReservationLeaseMs)
    || trust.maximumReservationLeaseMs < 1000
    || !Number.isSafeInteger(trust.maximumObservationAgeMs)
    || trust.maximumObservationAgeMs < 1000) {
    fail('autonomous_research_online_schema_transition_authority_trust_invalid');
  }
  return trust;
}

function validRelativePath(value) {
  return typeof value === 'string'
    && value.length > 0
    && value === value.replaceAll('\\', '/')
    && !value.startsWith('/')
    && !value.includes('//')
    && !value.split('/').some((segment) => segment === '.' || segment === '..');
}

function validInstances(instances) {
  if (!Array.isArray(instances) || instances.length !== ROLE_SET.size) return false;
  const ids = new Set();
  const roles = new Set();
  for (const instance of instances) {
    if (!hasExactObjectKeys(instance, INSTANCE_KEYS)
      || !ROLE_SET.has(instance.databaseRole)
      || !SAFE_ID.test(String(instance.databaseInstanceId || ''))
      || ids.has(instance.databaseInstanceId)
      || !validRelativePath(instance.sourceRelativePath)
      || !SAFE_ID.test(String(instance.preSchemaContractId || ''))
      || !SAFE_ID.test(String(instance.schemaContractId || ''))
      || !SHA256.test(String(instance.preSchemaHash || ''))
      || !SHA256.test(String(instance.expectedPostSchemaHash || ''))
      || !SHA256.test(String(instance.sourceSha256 || ''))
      || !SHA256.test(String(instance.sourceFileIdentityHash || ''))
      || !SHA256.test(String(instance.journalPreimageHash || ''))
      || !SHA256.test(String(instance.expectedNormalizedSourceSha256 || ''))
      || !SHA256.test(String(instance.prePristineStateHash || ''))) return false;
    ids.add(instance.databaseInstanceId);
    roles.add(instance.databaseRole);
  }
  return ids.size === ROLE_SET.size
    && roles.size === ROLE_SET.size
    && instances.every((entry, index) => (
    index === 0 || instances[index - 1].databaseInstanceId < entry.databaseInstanceId
    )) && [...roles].sort().join('\0') === [...ROLE_SET].sort().join('\0');
}

function transitionInventoryHash(request) {
  return hashRecord('AutonomousResearchOnlineSchemaTransitionInventory', {
    stateDatabaseManifestHash: request.stateDatabaseManifestHash,
    databaseScopeHash: request.databaseScopeHash,
    instances: request.instances,
  });
}

function transitionIdentity(request) {
  const identity = {
    scopeId: request.scopeId,
    databaseScopeHash: request.databaseScopeHash,
    writerManifestHash: request.writerManifestHash,
    stateDatabaseManifestHash: request.stateDatabaseManifestHash,
    schemaBundleHash: request.schemaBundleHash,
    instances: request.instances.map((entry) => ({
      databaseRole: entry.databaseRole,
      databaseInstanceId: entry.databaseInstanceId,
      sourceRelativePath: entry.sourceRelativePath,
      preSchemaContractId: entry.preSchemaContractId,
      schemaContractId: entry.schemaContractId,
      prePristineStateHash: entry.prePristineStateHash,
      expectedPostSchemaHash: entry.expectedPostSchemaHash,
    })),
  };
  if (request.version === 2) {
    identity.transitionMode = request.transitionMode;
    identity.sourceWriterManifestHash = request.sourceWriterManifestHash;
    identity.prePristineRuntimeStateHash = request.prePristineRuntimeStateHash;
  }
  return hashRecord('AutonomousResearchOnlineSchemaTransitionIdentity', identity);
}

function requestHash(kind, request) {
  return hashRecord(kind, request);
}

function signatureValid(receipt, trust, verifySignature) {
  return receipt?.authorityId === trust.authorityId
    && receipt?.keyId === trust.keyId
    && typeof verifySignature === 'function'
    && verifySignature(receipt) === true;
}

export function autonomousResearchOnlineSchemaTransitionReceiptHash(receipt) {
  return hashRecord(String(receipt?.kind || 'InvalidSchemaTransitionReceipt'), receipt);
}

function pristineRebindRequest(request) {
  return request?.version === 2
    && request?.transitionMode === 'pristine-finalized-writer-manifest-rebind';
}

function validPreviousHeads(rows, request) {
  return Array.isArray(rows)
    && rows.length === request.instances.length
    && rows.every((row, index) => {
      const instance = request.instances[index];
      return hasExactObjectKeys(row, PREVIOUS_HEAD_KEYS)
        && row.databaseRole === instance.databaseRole
        && row.databaseInstanceId === instance.databaseInstanceId
        && row.sequence === 0
        && SHA256.test(String(row.hash || ''))
        && row.schemaHash === instance.preSchemaHash
        && SHA256.test(String(row.stateHash || ''));
    });
}

export function buildAutonomousResearchPristineSchemaRebindGenesis({
  request,
  previousGlobalHash,
  previousDatabaseHeads,
} = {}) {
  if (!pristineRebindRequest(request)
    || !SHA256.test(String(previousGlobalHash || ''))
    || !validPreviousHeads(previousDatabaseHeads, request)) {
    fail('autonomous_research_pristine_schema_rebind_genesis_input_invalid');
  }
  const globalHash = hashRecord('AutonomousResearchPristineSchemaRebindGlobalGenesis', {
    transitionId: request.transitionId,
    sourceWriterManifestHash: request.sourceWriterManifestHash,
    targetWriterManifestHash: request.writerManifestHash,
    previousGlobalHash,
  });
  return Object.freeze(request.instances.map((instance, index) => {
    const previous = previousDatabaseHeads[index];
    return Object.freeze({
      databaseRole: instance.databaseRole,
      databaseInstanceId: instance.databaseInstanceId,
      schemaContractId: instance.schemaContractId,
      schemaHash: instance.expectedPostSchemaHash,
      globalSequence: 0,
      globalHash,
      databaseSequence: 0,
      databaseHash: hashRecord('AutonomousResearchPristineSchemaRebindDatabaseGenesis', {
        transitionId: request.transitionId,
        databaseInstanceId: instance.databaseInstanceId,
        previousDatabaseHash: previous.hash,
        targetSchemaHash: instance.expectedPostSchemaHash,
      }),
      stateHash: hashRecord('AutonomousResearchPristineSchemaRebindStateGenesis', {
        transitionId: request.transitionId,
        databaseInstanceId: instance.databaseInstanceId,
        previousStateHash: previous.stateHash,
        sourceSha256: instance.sourceSha256,
        targetSchemaHash: instance.expectedPostSchemaHash,
      }),
    });
  }));
}

export function assertAutonomousResearchOnlineSchemaTransitionReserveRequest(
  request,
  { trust } = {},
) {
  const checkedTrust = validTrust(trust);
  const rebind = pristineRebindRequest(request);
  if (!hasExactObjectKeys(
    request,
    rebind ? REBIND_RESERVE_REQUEST_KEYS : RESERVE_REQUEST_KEYS,
  )
    || request.version !== (rebind ? 2 : 1)
    || request.kind !== 'AutonomousResearchOnlineSchemaTransitionReserveRequest'
    || request.protocol !== (rebind
      ? AUTONOMOUS_RESEARCH_PRISTINE_SCHEMA_REBIND_PROTOCOL
      : AUTONOMOUS_RESEARCH_ONLINE_SCHEMA_TRANSITION_PROTOCOL)
    || request.scopeId !== checkedTrust.scopeId
    || request.databaseScopeHash !== checkedTrust.databaseScopeHash
    || (rebind
      ? (!SHA256.test(String(request.sourceWriterManifestHash || ''))
        || request.sourceWriterManifestHash === request.writerManifestHash
        || !SHA256.test(String(request.prePristineRuntimeStateHash || ''))
        || ![request.sourceWriterManifestHash, request.writerManifestHash]
          .includes(checkedTrust.writerManifestHash))
      : request.writerManifestHash !== checkedTrust.writerManifestHash)
    || !SHA256.test(String(request.writerManifestHash || ''))
    || !SHA256.test(String(request.stateDatabaseManifestHash || ''))
    || !SHA256.test(String(request.transitionInventoryHash || ''))
    || !SHA256.test(String(request.schemaBundleHash || ''))
    || !SAFE_ID.test(String(request.authorityJournalSchemaContractId || ''))
    || !SHA256.test(String(request.authorityJournalSchemaHash || ''))
    || !SHA256.test(String(request.markerSchemaHash || ''))
    || !SHA256.test(String(request.transitionId || ''))
    || !validInstances(request.instances)
    || request.databaseScopeHash !== autonomousResearchStateDatabaseScopeHash(
      request.instances.map((entry) => ({
        instanceId: entry.databaseInstanceId,
        role: entry.databaseRole,
        sourceRelativePath: entry.sourceRelativePath,
      })),
    )
    || request.transitionInventoryHash !== transitionInventoryHash(request)
    || request.transitionId !== transitionIdentity(request)
    || timestamp(request.requestedAt) === null
    || !Number.isSafeInteger(request.requestedLeaseMs)
    || request.requestedLeaseMs < 1000
    || request.requestedLeaseMs > checkedTrust.maximumReservationLeaseMs
    || !Number.isSafeInteger(request.requiredExecutionWindowMs)
    || request.requiredExecutionWindowMs < 1000
    || request.requiredExecutionWindowMs > request.requestedLeaseMs) {
    fail('autonomous_research_online_schema_transition_reserve_request_invalid');
  }
  return request;
}

function validGenesis(rows, request, receipt = null) {
  if (!Array.isArray(rows) || rows.length !== request.instances.length) return false;
  let expectedRebindGenesis = null;
  if (pristineRebindRequest(request)) {
    try {
      expectedRebindGenesis = buildAutonomousResearchPristineSchemaRebindGenesis({
        request,
        previousGlobalHash: receipt?.previousGlobalHash,
        previousDatabaseHeads: receipt?.previousDatabaseHeads,
      });
    } catch { return false; }
  }
  return rows.every((row, index) => {
    const instance = request.instances[index];
    return hasExactObjectKeys(row, GENESIS_KEYS)
      && row.databaseRole === instance.databaseRole
      && row.databaseInstanceId === instance.databaseInstanceId
      && row.schemaContractId === instance.schemaContractId
      && row.schemaHash === instance.expectedPostSchemaHash
      && row.globalSequence === 0
      && SHA256.test(String(row.globalHash || ''))
      && row.databaseSequence === 0
      && SHA256.test(String(row.databaseHash || ''))
      && SHA256.test(String(row.stateHash || ''))
      && (!expectedRebindGenesis
        || JSON.stringify(row) === JSON.stringify(expectedRebindGenesis[index]));
  });
}

export function verifyAutonomousResearchOnlineSchemaTransitionReservation({
  receipt,
  request,
  trust,
  now,
  verifySignature,
} = {}) {
  const checkedTrust = validTrust(trust);
  const checkedRequest = assertAutonomousResearchOnlineSchemaTransitionReserveRequest(
    request,
    { trust: checkedTrust },
  );
  const currentTime = explicitNow(now);
  const issuedAt = timestamp(receipt?.issuedAt);
  const expiresAt = timestamp(receipt?.expiresAt);
  const rebind = pristineRebindRequest(checkedRequest);
  const mirrored = [
    'protocol', 'scopeId', 'databaseScopeHash', 'writerManifestHash',
    'stateDatabaseManifestHash', 'transitionInventoryHash', 'schemaBundleHash',
    'authorityJournalSchemaContractId', 'authorityJournalSchemaHash', 'markerSchemaHash',
    'transitionId',
  ];
  return Boolean(hasExactObjectKeys(
    receipt,
    rebind ? REBIND_RESERVATION_KEYS : RESERVATION_KEYS,
  )
    && receipt.version === checkedRequest.version
    && receipt.kind === 'AutonomousResearchOnlineSchemaTransitionReservationReceipt'
    && receipt.status === 'autonomous_research_online_schema_transition_reserved'
    && SAFE_ID.test(String(receipt.reservationId || ''))
    && receipt.requestHash === requestHash(
      'AutonomousResearchOnlineSchemaTransitionReserveRequest', checkedRequest,
    )
    && mirrored.every((key) => receipt[key] === checkedRequest[key])
    && sameArray(receipt.instances, checkedRequest.instances)
    && validGenesis(receipt.databaseGenesis, checkedRequest, receipt)
    && (!rebind || (
      receipt.transitionMode === checkedRequest.transitionMode
      && receipt.sourceWriterManifestHash === checkedRequest.sourceWriterManifestHash
      && receipt.prePristineRuntimeStateHash === checkedRequest.prePristineRuntimeStateHash
      && receipt.previousGlobalSequence === 0
      && SHA256.test(String(receipt.previousGlobalHash || ''))
      && validPreviousHeads(receipt.previousDatabaseHeads, checkedRequest)
      && SHA256.test(String(receipt.targetAuthorityConfigurationHash || ''))
      && receipt.authorityRestartRequired === true
    ))
    && receipt.allRegisteredMutationsFenced === true
    && receipt.quiescenceMode === (rebind
      ? 'pristine-scope-held-through-target-configuration-restart'
      : 'scope-wide-no-new-reservations-until-finalize-or-expiry')
    && issuedAt !== null
    && expiresAt !== null
    && issuedAt <= currentTime + CLOCK_SKEW_MS
    && expiresAt > currentTime
    && expiresAt > issuedAt
    && expiresAt - issuedAt <= checkedRequest.requestedLeaseMs
    && signatureValid(receipt, checkedTrust, verifySignature));
}

function validInstallations(installations, reservation) {
  if (!Array.isArray(installations)
    || installations.length !== reservation.instances.length) return false;
  const reservationReceiptHash = autonomousResearchOnlineSchemaTransitionReceiptHash(
    reservation,
  );
  return installations.every((entry, index) => {
    const instance = reservation.instances[index];
    return hasExactObjectKeys(entry, INSTALLATION_KEYS)
      && entry.databaseRole === instance.databaseRole
      && entry.databaseInstanceId === instance.databaseInstanceId
      && entry.schemaContractId === instance.schemaContractId
      && entry.preSchemaHash === instance.preSchemaHash
      && entry.postSchemaHash === instance.expectedPostSchemaHash
      && entry.prePristineStateHash === instance.prePristineStateHash
      && SHA256.test(String(entry.postPristineStateHash || ''))
      && entry.installationHash === hashRecord(
        'AutonomousResearchOnlineSchemaTransitionDatabaseInstallation',
        {
          transitionId: reservation.transitionId,
          reservationReceiptHash,
          databaseRole: entry.databaseRole,
          databaseInstanceId: entry.databaseInstanceId,
          schemaContractId: entry.schemaContractId,
          preSchemaHash: entry.preSchemaHash,
          postSchemaHash: entry.postSchemaHash,
          prePristineStateHash: entry.prePristineStateHash,
          postPristineStateHash: entry.postPristineStateHash,
        },
      );
  });
}

export function assertAutonomousResearchOnlineSchemaTransitionFinalizeRequest(
  request,
  reservation,
) {
  const rebind = reservation?.version === 2
    && reservation?.transitionMode === 'pristine-finalized-writer-manifest-rebind';
  if (!hasExactObjectKeys(request, FINALIZE_REQUEST_KEYS)
    || request.version !== (rebind ? 2 : 1)
    || request.kind !== 'AutonomousResearchOnlineSchemaTransitionFinalizeRequest'
    || request.protocol !== (rebind
      ? AUTONOMOUS_RESEARCH_PRISTINE_SCHEMA_REBIND_PROTOCOL
      : AUTONOMOUS_RESEARCH_ONLINE_SCHEMA_TRANSITION_PROTOCOL)
    || request.scopeId !== reservation?.scopeId
    || request.databaseScopeHash !== reservation?.databaseScopeHash
    || request.writerManifestHash !== reservation?.writerManifestHash
    || request.transitionId !== reservation?.transitionId
    || request.transitionInventoryHash !== reservation?.transitionInventoryHash
    || request.schemaBundleHash !== reservation?.schemaBundleHash
    || request.reservationId !== reservation?.reservationId
    || request.reservationReceiptHash
      !== autonomousResearchOnlineSchemaTransitionReceiptHash(reservation)
    || !SHA256.test(String(request.postInventoryHash || ''))
    || !SHA256.test(String(request.postPristineRuntimeStateHash || ''))
    || !validInstallations(request.installations, reservation)
    || timestamp(request.completedAt) === null) {
    fail('autonomous_research_online_schema_transition_finalize_request_invalid');
  }
  return request;
}

export function verifyAutonomousResearchOnlineSchemaTransitionFinalization({
  receipt,
  request,
  reservation,
  trust,
  now,
  verifySignature,
} = {}) {
  const checkedTrust = validTrust(trust);
  const checkedRequest = assertAutonomousResearchOnlineSchemaTransitionFinalizeRequest(
    request,
    reservation,
  );
  const currentTime = explicitNow(now);
  const finalizedAt = timestamp(receipt?.finalizedAt);
  const completedAt = timestamp(checkedRequest.completedAt);
  const expiresAt = timestamp(reservation?.expiresAt);
  const mirrored = [
    'protocol', 'scopeId', 'databaseScopeHash', 'writerManifestHash', 'transitionId',
    'transitionInventoryHash', 'schemaBundleHash', 'reservationId',
    'reservationReceiptHash', 'postInventoryHash', 'postPristineRuntimeStateHash',
  ];
  const rebind = reservation?.version === 2
    && reservation?.transitionMode === 'pristine-finalized-writer-manifest-rebind';
  return Boolean(hasExactObjectKeys(
    receipt,
    rebind ? REBIND_FINALIZATION_KEYS : FINALIZATION_KEYS,
  )
    && receipt.version === checkedRequest.version
    && receipt.kind === 'AutonomousResearchOnlineSchemaTransitionFinalizationReceipt'
    && receipt.status === 'autonomous_research_online_schema_transition_finalized'
    && receipt.requestHash === requestHash(
      'AutonomousResearchOnlineSchemaTransitionFinalizeRequest', checkedRequest,
    )
    && mirrored.every((key) => receipt[key] === checkedRequest[key])
    && sameArray(receipt.installations, checkedRequest.installations)
    && (!rebind || (
      receipt.transitionMode === reservation.transitionMode
      && receipt.sourceWriterManifestHash === reservation.sourceWriterManifestHash
      && receipt.targetAuthorityConfigurationHash
        === reservation.targetAuthorityConfigurationHash
      && receipt.authorityRestartRequired === true
    ))
    && Number.isSafeInteger(receipt.globalSequence)
    && receipt.globalSequence >= 0
    && SHA256.test(String(receipt.globalHash || ''))
    && receipt.allRegisteredMutationsFencedThroughFinalize === true
    && completedAt !== null
    && finalizedAt !== null
    && expiresAt !== null
    && completedAt <= expiresAt
    && finalizedAt >= completedAt
    && finalizedAt <= currentTime + CLOCK_SKEW_MS
    && finalizedAt <= expiresAt
    && signatureValid(receipt, checkedTrust, verifySignature));
}

export function assertAutonomousResearchOnlineSchemaTransitionObserveRequest(
  request,
  { trust } = {},
) {
  const checkedTrust = validTrust(trust);
  const rebind = pristineRebindRequest(request);
  if (!hasExactObjectKeys(
    request,
    rebind ? REBIND_OBSERVE_REQUEST_KEYS : OBSERVE_REQUEST_KEYS,
  )
    || request.version !== (rebind ? 2 : 1)
    || request.kind !== 'AutonomousResearchOnlineSchemaTransitionObserveRequest'
    || request.protocol !== (rebind
      ? AUTONOMOUS_RESEARCH_PRISTINE_SCHEMA_REBIND_PROTOCOL
      : AUTONOMOUS_RESEARCH_ONLINE_SCHEMA_TRANSITION_PROTOCOL)
    || request.scopeId !== checkedTrust.scopeId
    || request.databaseScopeHash !== checkedTrust.databaseScopeHash
    || (rebind
      ? (!SHA256.test(String(request.sourceWriterManifestHash || ''))
        || !SHA256.test(String(request.writerManifestHash || ''))
        || request.sourceWriterManifestHash === request.writerManifestHash
        || ![request.sourceWriterManifestHash, request.writerManifestHash]
          .includes(checkedTrust.writerManifestHash))
      : request.writerManifestHash !== checkedTrust.writerManifestHash)
    || !SHA256.test(String(request.transitionId || ''))
    || !SHA256.test(String(request.transitionInventoryHash || ''))
    || !SHA256.test(String(request.schemaBundleHash || ''))
    || !SHA256.test(String(request.finalizationReceiptHash || ''))
    || !SHA256.test(String(request.postInventoryHash || ''))
    || !SHA256.test(String(request.postPristineRuntimeStateHash || ''))
    || !SAFE_ID.test(String(request.nonce || ''))
    || timestamp(request.requestedAt) === null) {
    fail('autonomous_research_online_schema_transition_observe_request_invalid');
  }
  return request;
}

export function verifyAutonomousResearchOnlineSchemaTransitionObservation({
  receipt,
  request,
  trust,
  now,
  verifySignature,
} = {}) {
  const checkedTrust = validTrust(trust);
  const checkedRequest = assertAutonomousResearchOnlineSchemaTransitionObserveRequest(
    request,
    { trust: checkedTrust },
  );
  const currentTime = explicitNow(now);
  const observedAt = timestamp(receipt?.observedAt);
  const expiresAt = timestamp(receipt?.expiresAt);
  const rebind = pristineRebindRequest(checkedRequest);
  const mirrored = [
    'protocol', 'scopeId', 'databaseScopeHash', 'writerManifestHash', 'transitionId',
    'transitionInventoryHash', 'schemaBundleHash', 'finalizationReceiptHash',
    'postInventoryHash', 'postPristineRuntimeStateHash',
  ];
  return Boolean(hasExactObjectKeys(
    receipt,
    rebind ? REBIND_OBSERVATION_KEYS : OBSERVATION_KEYS,
  )
    && receipt.version === checkedRequest.version
    && receipt.kind === 'AutonomousResearchOnlineSchemaTransitionObservationReceipt'
    && receipt.status === 'autonomous_research_online_schema_transition_observed_finalized'
    && receipt.requestHash === requestHash(
      'AutonomousResearchOnlineSchemaTransitionObserveRequest', checkedRequest,
    )
    && mirrored.every((key) => receipt[key] === checkedRequest[key])
    && (!rebind || (
      receipt.transitionMode === checkedRequest.transitionMode
      && receipt.sourceWriterManifestHash === checkedRequest.sourceWriterManifestHash
      && receipt.authorityConfigurationActivated === true
    ))
    && receipt.transitionState === 'finalized'
    && Number.isSafeInteger(receipt.globalSequence)
    && receipt.globalSequence >= 0
    && SHA256.test(String(receipt.globalHash || ''))
    && observedAt !== null
    && expiresAt !== null
    && observedAt <= currentTime + CLOCK_SKEW_MS
    && currentTime - observedAt <= checkedTrust.maximumObservationAgeMs
    && expiresAt > currentTime
    && expiresAt > observedAt
    && expiresAt - observedAt <= checkedTrust.maximumReservationLeaseMs
    && signatureValid(receipt, checkedTrust, verifySignature));
}

export function autonomousResearchOnlineSchemaTransitionReadyReceiptHash(receipt) {
  return hashRecord('AutonomousResearchOnlineSchemaTransitionReadyReceipt', receipt);
}
