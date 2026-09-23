import crypto from 'node:crypto';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { hasExactObjectKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  fileSha256HashSync,
  readRegularJsonFileSync,
} from '../runtime/pinned-file-reader.mjs';
import {
  createAutonomousResearchOnlineMutationReceiptVerifier,
} from './autonomous-research-online-mutation-authority.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{1,127}$/;
const SIGNATURE = /^[A-Za-z0-9+/]+={0,2}$/;
const CLOCK_SKEW_MS = 5000;
export const AUTONOMOUS_RESEARCH_STATE_BACKUP_FINALIZED_JOURNAL_PROTOCOL =
  'external-linearizable-finalized-mutation-journal-v1';
export const AUTONOMOUS_RESEARCH_STATE_BACKUP_MAXIMUM_JOURNAL_ENTRIES = 4096;

export function autonomousResearchStateBackupAuthoritySignaturePayload(receipt) {
  const unsigned = Object.fromEntries(
    Object.entries(receipt || {}).filter(([key]) => key !== 'signature'),
  );
  return hashRecord('AutonomousResearchStateBackupAuthoritySignedPayload', unsigned);
}

export function autonomousResearchStateBackupAuthorityReceiptHash(receipt) {
  return hashRecord(String(receipt?.kind || 'InvalidAuthorityReceipt'), receipt);
}

function validTimestamp(value) {
  const milliseconds = Date.parse(String(value || ''));
  return Number.isFinite(milliseconds) ? milliseconds : null;
}

function assertTrust(trust) {
  if (trust?.version !== 1
    || trust?.kind !== 'AutonomousResearchStateBackupAuthorityTrust'
    || !SAFE_ID.test(String(trust.authorityId || ''))
    || !SAFE_ID.test(String(trust.keyId || ''))
    || trust.publicKey?.type !== 'public'
    || trust.publicKey?.asymmetricKeyType !== 'ed25519'
    || !Number.isSafeInteger(trust.maximumReservationLeaseMs)
    || trust.maximumReservationLeaseMs < 1000
    || !Number.isSafeInteger(trust.maximumHeadObservationAgeMs)
    || trust.maximumHeadObservationAgeMs < 1000) {
    throw new Error('autonomous_research_state_backup_authority_trust_invalid');
  }
  return trust;
}

function verifySignature(receipt, trust) {
  if (!SIGNATURE.test(String(receipt?.signature || ''))) return false;
  try {
    return crypto.verify(
      null,
      Buffer.from(autonomousResearchStateBackupAuthoritySignaturePayload(receipt), 'utf8'),
      trust.publicKey,
      Buffer.from(receipt.signature, 'base64'),
    );
  } catch { return false; }
}

function commonReceiptValid(receipt, trust, expectedKind, keys) {
  return hasExactObjectKeys(receipt, keys)
    && receipt.version === 1
    && receipt.kind === expectedKind
    && receipt.authorityId === trust.authorityId
    && receipt.keyId === trust.keyId
    && SAFE_ID.test(String(receipt.reservationId || ''))
    && SHA256.test(String(receipt.requestHash || ''))
    && SHA256.test(String(receipt.databaseScopeHash || ''))
    && Number.isSafeInteger(receipt.headSequence)
    && receipt.headSequence >= 0
    && SHA256.test(String(receipt.headHash || ''))
    && verifySignature(receipt, trust);
}

export function verifyAutonomousResearchStateBackupAuthorityReservation({
  receipt,
  request,
  trust,
  now,
} = {}) {
  const checkedTrust = assertTrust(trust);
  const keys = [
    'version', 'kind', 'status', 'authorityId', 'keyId', 'requestHash', 'reservationId',
    'inventoryHash', 'databaseScopeHash', 'databaseInstanceIds', 'headSequence', 'headHash',
    'issuedAt', 'expiresAt', 'mutationFenceProtocol', 'allRegisteredMutationsFenced',
    'signature',
  ];
  const issuedAt = validTimestamp(receipt?.issuedAt);
  const expiresAt = validTimestamp(receipt?.expiresAt);
  const observedAt = validTimestamp(now);
  const expectedInstances = [...(request?.databaseInstanceIds || [])].sort();
  return commonReceiptValid(receipt, checkedTrust, 'AutonomousResearchStateBackupAuthorityReservation', keys)
    && receipt.status === 'autonomous_research_state_backup_authority_reserved'
    && receipt.requestHash === hashRecord('AutonomousResearchStateBackupAuthorityReserveRequest', request)
    && receipt.inventoryHash === request.inventoryHash
    && receipt.databaseScopeHash === request.databaseScopeHash
    && Array.isArray(receipt.databaseInstanceIds)
    && receipt.databaseInstanceIds.join('\0') === expectedInstances.join('\0')
    && receipt.mutationFenceProtocol === 'external-linearizable-reserve-apply-finalize-v1'
    && receipt.allRegisteredMutationsFenced === true
    && issuedAt !== null
    && expiresAt !== null
    && observedAt !== null
    && issuedAt <= observedAt + CLOCK_SKEW_MS
    && expiresAt > issuedAt
    && expiresAt > observedAt
    && expiresAt - issuedAt <= checkedTrust.maximumReservationLeaseMs;
}

export function verifyAutonomousResearchStateBackupAuthorityFinalization({
  receipt,
  request,
  reservation,
  trust,
  now,
} = {}) {
  const checkedTrust = assertTrust(trust);
  const keys = [
    'version', 'kind', 'status', 'authorityId', 'keyId', 'requestHash', 'reservationId',
    'inventoryHash', 'databaseScopeHash', 'snapshotContentHash', 'headSequence', 'headHash',
    'finalizedAt', 'allRegisteredMutationsFencedThroughFinalize', 'signature',
  ];
  const finalizedAt = validTimestamp(receipt?.finalizedAt);
  const observedAt = validTimestamp(now);
  const issuedAt = validTimestamp(reservation?.issuedAt);
  const expiresAt = validTimestamp(reservation?.expiresAt);
  return commonReceiptValid(receipt, checkedTrust, 'AutonomousResearchStateBackupAuthorityFinalization', keys)
    && receipt.status === 'autonomous_research_state_backup_authority_finalized'
    && receipt.requestHash === hashRecord('AutonomousResearchStateBackupAuthorityFinalizeRequest', request)
    && request.reservationId === reservation.reservationId
    && request.inventoryHash === reservation.inventoryHash
    && request.databaseScopeHash === reservation.databaseScopeHash
    && receipt.reservationId === reservation.reservationId
    && receipt.inventoryHash === reservation.inventoryHash
    && receipt.databaseScopeHash === reservation.databaseScopeHash
    && receipt.snapshotContentHash === request.snapshotContentHash
    && receipt.headSequence === reservation.headSequence
    && receipt.headHash === reservation.headHash
    && receipt.allRegisteredMutationsFencedThroughFinalize === true
    && finalizedAt !== null
    && observedAt !== null
    && issuedAt !== null
    && expiresAt !== null
    && finalizedAt >= issuedAt
    && finalizedAt <= observedAt + CLOCK_SKEW_MS
    && finalizedAt <= expiresAt;
}

export function verifyAutonomousResearchStateBackupAuthorityCurrentHead({
  receipt,
  request,
  trust,
  now,
} = {}) {
  const checkedTrust = assertTrust(trust);
  const keys = [
    'version', 'kind', 'status', 'authorityId', 'keyId', 'requestHash', 'reservationId',
    'databaseScopeHash', 'headSequence', 'headHash', 'observedAt', 'expiresAt',
    'mutationFenceProtocol', 'allRegisteredMutationsFenced', 'signature',
  ];
  const receiptTime = validTimestamp(receipt?.observedAt);
  const expiresAt = validTimestamp(receipt?.expiresAt);
  const observedAt = validTimestamp(now);
  return commonReceiptValid(receipt, checkedTrust, 'AutonomousResearchStateBackupAuthorityCurrentHead', keys)
    && receipt.status === 'autonomous_research_state_backup_authority_head_observed'
    && receipt.requestHash === hashRecord('AutonomousResearchStateBackupAuthorityCurrentHeadRequest', request)
    && receipt.reservationId === request.reservationId
    && receipt.databaseScopeHash === request.databaseScopeHash
    && receipt.mutationFenceProtocol === 'external-linearizable-restore-validation-v1'
    && receipt.allRegisteredMutationsFenced === true
    && receiptTime !== null
    && expiresAt !== null
    && observedAt !== null
    && receiptTime <= observedAt + CLOCK_SKEW_MS
    && observedAt - receiptTime <= checkedTrust.maximumHeadObservationAgeMs
    && expiresAt > observedAt
    && expiresAt > receiptTime
    && expiresAt - receiptTime <= checkedTrust.maximumReservationLeaseMs;
}

function validDatabaseHeads(heads) {
  if (!Array.isArray(heads) || heads.length === 0) return false;
  const ids = new Set();
  for (const head of heads) {
    if (!hasExactObjectKeys(head, [
      'databaseRole', 'databaseInstanceId', 'sequence', 'hash', 'schemaHash', 'stateHash',
    ])
      || !SAFE_ID.test(String(head.databaseRole || ''))
      || !SAFE_ID.test(String(head.databaseInstanceId || ''))
      || ids.has(head.databaseInstanceId)
      || !Number.isSafeInteger(head.sequence)
      || head.sequence < 0
      || !SHA256.test(String(head.hash || ''))
      || !SHA256.test(String(head.schemaHash || ''))
      || !SHA256.test(String(head.stateHash || ''))) return false;
    ids.add(head.databaseInstanceId);
  }
  return heads.every((head, index) => (
    index === 0 || heads[index - 1].databaseInstanceId < head.databaseInstanceId
  ));
}

export function verifyAutonomousResearchStateBackupAuthorityJournalRange({
  receipt,
  request,
  trust,
  now,
} = {}) {
  const checkedTrust = assertTrust(trust);
  const requestKeys = [
    'version', 'kind', 'reservationId', 'databaseScopeHash', 'snapshotContentHash',
    'onlineAuthorityId', 'onlineKeyId', 'scopeId', 'writerManifestHash',
    'fromGlobalSequence', 'fromGlobalHash', 'toGlobalSequence', 'toGlobalHash',
    'requestedAt', 'maximumLeaseMs', 'maximumEntries',
  ];
  const receiptKeys = [
    'version', 'kind', 'status', 'authorityId', 'keyId', 'requestHash',
    'reservationId', 'databaseScopeHash', 'snapshotContentHash',
    'onlineAuthorityId', 'onlineKeyId', 'scopeId', 'writerManifestHash',
    'fromGlobalSequence', 'fromGlobalHash', 'toGlobalSequence', 'toGlobalHash',
    'databaseHeads', 'entries', 'observedAt', 'expiresAt', 'mutationFenceProtocol',
    'completeFinalizedMutationJournal', 'signature',
  ];
  const observedAt = validTimestamp(receipt?.observedAt);
  const expiresAt = validTimestamp(receipt?.expiresAt);
  const currentTime = validTimestamp(now);
  const entryCount = Number(request?.toGlobalSequence) - Number(request?.fromGlobalSequence);
  return Boolean(
    hasExactObjectKeys(request, requestKeys)
    && request.version === 1
    && request.kind === 'AutonomousResearchStateBackupAuthorityJournalRangeRequest'
    && SAFE_ID.test(String(request.reservationId || ''))
    && SHA256.test(String(request.databaseScopeHash || ''))
    && SHA256.test(String(request.snapshotContentHash || ''))
    && SAFE_ID.test(String(request.onlineAuthorityId || ''))
    && SAFE_ID.test(String(request.onlineKeyId || ''))
    && SAFE_ID.test(String(request.scopeId || ''))
    && SHA256.test(String(request.writerManifestHash || ''))
    && Number.isSafeInteger(request.fromGlobalSequence)
    && request.fromGlobalSequence >= 0
    && SHA256.test(String(request.fromGlobalHash || ''))
    && Number.isSafeInteger(request.toGlobalSequence)
    && request.toGlobalSequence > request.fromGlobalSequence
    && SHA256.test(String(request.toGlobalHash || ''))
    && validTimestamp(request.requestedAt) !== null
    && Number.isSafeInteger(request.maximumLeaseMs)
    && request.maximumLeaseMs >= 1000
    && request.maximumLeaseMs <= checkedTrust.maximumReservationLeaseMs
    && Number.isSafeInteger(request.maximumEntries)
    && request.maximumEntries >= entryCount
    && request.maximumEntries <= AUTONOMOUS_RESEARCH_STATE_BACKUP_MAXIMUM_JOURNAL_ENTRIES
    && hasExactObjectKeys(receipt, receiptKeys)
    && receipt.version === 1
    && receipt.kind === 'AutonomousResearchStateBackupAuthorityJournalRange'
    && receipt.status === 'autonomous_research_state_backup_authority_journal_range_complete'
    && receipt.authorityId === checkedTrust.authorityId
    && receipt.keyId === checkedTrust.keyId
    && receipt.requestHash === hashRecord(
      'AutonomousResearchStateBackupAuthorityJournalRangeRequest', request,
    )
    && [
      'reservationId', 'databaseScopeHash', 'snapshotContentHash',
      'onlineAuthorityId', 'onlineKeyId', 'scopeId', 'writerManifestHash',
      'fromGlobalSequence', 'fromGlobalHash', 'toGlobalSequence', 'toGlobalHash',
    ].every((key) => receipt[key] === request[key])
    && validDatabaseHeads(receipt.databaseHeads)
    && Array.isArray(receipt.entries)
    && receipt.entries.length === entryCount
    && receipt.entries.length <= request.maximumEntries
    && receipt.mutationFenceProtocol
      === AUTONOMOUS_RESEARCH_STATE_BACKUP_FINALIZED_JOURNAL_PROTOCOL
    && receipt.completeFinalizedMutationJournal === true
    && observedAt !== null
    && expiresAt !== null
    && currentTime !== null
    && observedAt <= currentTime + CLOCK_SKEW_MS
    && currentTime - observedAt <= checkedTrust.maximumHeadObservationAgeMs
    && expiresAt > currentTime
    && expiresAt > observedAt
    && expiresAt - observedAt <= checkedTrust.maximumReservationLeaseMs
    && verifySignature(receipt, checkedTrust)
  );
}

function assertProcessConfiguration(configuration) {
  const versionOneKeys = [
    'version', 'kind', 'authorityId', 'keyId', 'commandPath', 'commandSha256',
    'publicKeyPath', 'publicKeySha256', 'fixedArguments', 'timeoutMs',
    'maximumReservationLeaseMs', 'maximumHeadObservationAgeMs',
  ];
  const versionTwoKeys = [
    ...versionOneKeys,
    'onlineMutationAuthorityConfigurationPath',
    'onlineMutationAuthorityConfigurationSha256',
  ];
  const exactKeys = configuration?.version === 2 ? versionTwoKeys : versionOneKeys;
  if (!hasExactObjectKeys(configuration, exactKeys)
    || ![1, 2].includes(configuration.version)
    || configuration.kind !== 'AutonomousResearchStateBackupAuthorityProcessConfiguration'
    || !SAFE_ID.test(String(configuration.authorityId || ''))
    || !SAFE_ID.test(String(configuration.keyId || ''))
    || !path.isAbsolute(configuration.commandPath)
    || !path.isAbsolute(configuration.publicKeyPath)
    || !SHA256.test(String(configuration.commandSha256 || ''))
    || !SHA256.test(String(configuration.publicKeySha256 || ''))
    || !Array.isArray(configuration.fixedArguments)
    || configuration.fixedArguments.length !== 0
    || !Number.isSafeInteger(configuration.timeoutMs)
    || configuration.timeoutMs < 1000
    || configuration.timeoutMs > 120000
    || (configuration.version === 2 && (
      !path.isAbsolute(configuration.onlineMutationAuthorityConfigurationPath)
      || !SHA256.test(String(configuration.onlineMutationAuthorityConfigurationSha256 || ''))
    ))) {
    throw new Error('autonomous_research_state_backup_authority_process_configuration_invalid');
  }
  return configuration;
}

function readAuthorityPublicKey(publicKeyPath) {
  const document = readRegularJsonFileSync(publicKeyPath);
  if (!hasExactObjectKeys(document, [
    'version', 'kind', 'authorityId', 'keyId', 'algorithm', 'publicKeyPem',
  ])
    || document.version !== 1
    || document.kind !== 'AutonomousResearchStateBackupAuthorityPublicKey'
    || document.algorithm !== 'ed25519'
    || !SAFE_ID.test(String(document.authorityId || ''))
    || !SAFE_ID.test(String(document.keyId || ''))
    || typeof document.publicKeyPem !== 'string'
    || !/-----BEGIN PUBLIC KEY-----/.test(document.publicKeyPem)
    || /-----BEGIN (?:ENCRYPTED )?PRIVATE KEY-----/.test(document.publicKeyPem)) {
    throw new Error('autonomous_research_state_backup_authority_public_key_invalid');
  }
  let publicKey;
  try { publicKey = crypto.createPublicKey(document.publicKeyPem); }
  catch { throw new Error('autonomous_research_state_backup_authority_public_key_invalid'); }
  if (publicKey.type !== 'public' || publicKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('autonomous_research_state_backup_authority_public_key_invalid');
  }
  return Object.freeze({ document, publicKey });
}

export function createAutonomousResearchStateBackupAuthorityProcessClient({ configurationPath } = {}) {
  const configuration = assertProcessConfiguration(readRegularJsonFileSync(configurationPath));
  if (fileSha256HashSync(configuration.commandPath) !== configuration.commandSha256
    || fileSha256HashSync(configuration.publicKeyPath) !== configuration.publicKeySha256) {
    throw new Error('autonomous_research_state_backup_authority_process_identity_mismatch');
  }
  const publicKeyDocument = readAuthorityPublicKey(configuration.publicKeyPath);
  if (publicKeyDocument.document.authorityId !== configuration.authorityId
    || publicKeyDocument.document.keyId !== configuration.keyId) {
    throw new Error('autonomous_research_state_backup_authority_public_key_identity_mismatch');
  }
  const trust = assertTrust(Object.freeze({
    version: 1,
    kind: 'AutonomousResearchStateBackupAuthorityTrust',
    authorityId: configuration.authorityId,
    keyId: configuration.keyId,
    publicKey: publicKeyDocument.publicKey,
    maximumReservationLeaseMs: configuration.maximumReservationLeaseMs,
    maximumHeadObservationAgeMs: configuration.maximumHeadObservationAgeMs,
  }));
  if (configuration.version === 2
    && fileSha256HashSync(configuration.onlineMutationAuthorityConfigurationPath)
      !== configuration.onlineMutationAuthorityConfigurationSha256) {
    throw new Error('autonomous_research_state_backup_online_authority_identity_mismatch');
  }
  const onlineMutationVerifier = configuration.version === 2
    ? createAutonomousResearchOnlineMutationReceiptVerifier({
      configurationPath: configuration.onlineMutationAuthorityConfigurationPath,
    })
    : null;
  const invoke = (request) => {
    if (fileSha256HashSync(configuration.commandPath) !== configuration.commandSha256
      || fileSha256HashSync(configuration.publicKeyPath) !== configuration.publicKeySha256
      || (configuration.version === 2
        && fileSha256HashSync(configuration.onlineMutationAuthorityConfigurationPath)
          !== configuration.onlineMutationAuthorityConfigurationSha256)) {
      throw new Error('autonomous_research_state_backup_authority_command_changed');
    }
    const result = spawnSync(configuration.commandPath, configuration.fixedArguments, {
      input: `${JSON.stringify(request)}\n`,
      encoding: 'utf8',
      timeout: configuration.timeoutMs,
      // A single online mutation journal record can contain the 16 MiB changeset
      // in both its signed reserve request and reservation receipt.
      maxBuffer: 256 * 1024 * 1024,
      shell: false,
      // Node may append NODE_V8_COVERAGE to options.env. The child still gets
      // only this allowlist (plus that Node-owned instrumentation variable),
      // while the per-call object remains safe for child_process to extend.
      env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
    });
    if (result.status !== 0 || result.error) {
      throw new Error('autonomous_research_state_backup_authority_process_failed');
    }
    try { return JSON.parse(String(result.stdout || '').trim()); }
    catch { throw new Error('autonomous_research_state_backup_authority_process_output_invalid'); }
  };
  return Object.freeze({
    trust,
    onlineMutationVerifier,
    configurationHash: hashRecord('AutonomousResearchStateBackupAuthorityProcessConfiguration', configuration),
    client: Object.freeze({
      reserveSnapshot: invoke,
      finalizeSnapshot: invoke,
      observeCurrentHead: invoke,
      readFinalizedMutationJournal: invoke,
    }),
  });
}
