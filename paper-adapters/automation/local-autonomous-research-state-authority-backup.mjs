import crypto from 'node:crypto';

import {
  AUTONOMOUS_RESEARCH_ONLINE_MUTATION_PROTOCOL,
} from '../../paper-domain/automation/autonomous-research-online-mutation-contract.mjs';
import { hasExactObjectKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  AUTONOMOUS_RESEARCH_STATE_BACKUP_FINALIZED_JOURNAL_PROTOCOL,
  AUTONOMOUS_RESEARCH_STATE_BACKUP_MAXIMUM_JOURNAL_ENTRIES,
} from './autonomous-research-state-backup-authority.mjs';
import {
  failLocalStateAuthority,
  LOCAL_STATE_AUTHORITY_SAFE_ID,
  LOCAL_STATE_AUTHORITY_SHA256,
  localStateAuthorityExpiry,
  localStateAuthorityNow,
  localStateAuthoritySortedUniqueIds,
  localStateAuthorityTimestamp,
  parseLocalStateAuthorityRecord,
  readLocalStateAuthorityDatabaseHeads,
  readLocalStateAuthorityMetadata,
  runLocalStateAuthorityTransaction,
} from './local-autonomous-research-state-authority-support.mjs';

const BACKUP_RESERVE_KEYS = Object.freeze([
  'version', 'kind', 'inventoryHash', 'databaseScopeHash', 'databaseInstanceIds',
  'requestedAt', 'maximumLeaseMs',
]);
const BACKUP_FINALIZE_KEYS = Object.freeze([
  'version', 'kind', 'reservationId', 'inventoryHash', 'databaseScopeHash',
  'snapshotContentHash', 'requestedAt',
]);
const BACKUP_HEAD_KEYS = Object.freeze([
  'version', 'kind', 'reservationId', 'databaseScopeHash', 'snapshotContentHash',
  'requestedAt', 'maximumLeaseMs',
]);
const BACKUP_JOURNAL_KEYS = Object.freeze([
  'version', 'kind', 'reservationId', 'databaseScopeHash', 'snapshotContentHash',
  'onlineAuthorityId', 'onlineKeyId', 'scopeId', 'writerManifestHash',
  'fromGlobalSequence', 'fromGlobalHash', 'toGlobalSequence', 'toGlobalHash',
  'requestedAt', 'maximumLeaseMs', 'maximumEntries',
]);

export function createLocalAutonomousResearchStateAuthorityBackupHandlers({
  database,
  configuration,
  clock,
  signBackup,
} = {}) {
  function assertBackupLease(request) {
    if (!Number.isSafeInteger(request.maximumLeaseMs)
      || request.maximumLeaseMs < 1000
      || request.maximumLeaseMs > configuration.maximumReservationLeaseMs
      || localStateAuthorityTimestamp(request.requestedAt) === null) {
      failLocalStateAuthority('local_state_authority_backup_lease_invalid');
    }
  }

  function reserveBackup(request) {
    if (!hasExactObjectKeys(request, BACKUP_RESERVE_KEYS)
      || request.version !== 1
      || request.kind !== 'AutonomousResearchStateBackupAuthorityReserveRequest'
      || !LOCAL_STATE_AUTHORITY_SHA256.test(String(request.inventoryHash || ''))
      || request.databaseScopeHash !== configuration.databaseScopeHash
      || !localStateAuthoritySortedUniqueIds(request.databaseInstanceIds)) {
      failLocalStateAuthority('local_state_authority_backup_reserve_request_invalid');
    }
    assertBackupLease(request);
    return runLocalStateAuthorityTransaction(database, () => {
      const current = readLocalStateAuthorityMetadata(database);
      const heads = readLocalStateAuthorityDatabaseHeads(database);
      if (current.schema_transition_state !== 'finalized'
        || database.prepare(`
SELECT count(*) AS count FROM authority_mutation WHERE status='reserved';
`).get().count !== 0
        || request.databaseInstanceIds.join('\0')
          !== heads.map((head) => head.databaseInstanceId).join('\0')) {
        failLocalStateAuthority('local_state_authority_backup_scope_not_quiescent');
      }
      const issuedAt = localStateAuthorityNow(clock);
      const receipt = signBackup({
        version: 1,
        kind: 'AutonomousResearchStateBackupAuthorityReservation',
        status: 'autonomous_research_state_backup_authority_reserved',
        authorityId: configuration.authorityId,
        keyId: configuration.keyId,
        requestHash: hashRecord(
          'AutonomousResearchStateBackupAuthorityReserveRequest',
          request,
        ),
        reservationId: `backup:${crypto.randomUUID()}`,
        inventoryHash: request.inventoryHash,
        databaseScopeHash: request.databaseScopeHash,
        databaseInstanceIds: request.databaseInstanceIds,
        headSequence: Number(current.global_sequence),
        headHash: current.global_hash,
        issuedAt,
        expiresAt: localStateAuthorityExpiry(issuedAt, request.maximumLeaseMs),
        mutationFenceProtocol: AUTONOMOUS_RESEARCH_ONLINE_MUTATION_PROTOCOL,
        allRegisteredMutationsFenced: true,
      });
      database.prepare(`
INSERT INTO authority_backup_reservation(
  reservation_id,reserve_request_json,reservation_receipt_json
) VALUES(?,?,?);
`).run(receipt.reservationId, JSON.stringify(request), JSON.stringify(receipt));
      return receipt;
    });
  }

  function finalizeBackup(request) {
    if (!hasExactObjectKeys(request, BACKUP_FINALIZE_KEYS)
      || request.version !== 1
      || request.kind !== 'AutonomousResearchStateBackupAuthorityFinalizeRequest'
      || !LOCAL_STATE_AUTHORITY_SAFE_ID.test(String(request.reservationId || ''))
      || !LOCAL_STATE_AUTHORITY_SHA256.test(String(request.inventoryHash || ''))
      || request.databaseScopeHash !== configuration.databaseScopeHash
      || !LOCAL_STATE_AUTHORITY_SHA256.test(String(request.snapshotContentHash || ''))
      || localStateAuthorityTimestamp(request.requestedAt) === null) {
      failLocalStateAuthority('local_state_authority_backup_finalize_request_invalid');
    }
    return runLocalStateAuthorityTransaction(database, () => {
      const row = database.prepare(`
SELECT * FROM authority_backup_reservation WHERE reservation_id=?;
`).get(request.reservationId);
      if (!row) {
        failLocalStateAuthority('local_state_authority_backup_reservation_required');
      }
      const reservation = parseLocalStateAuthorityRecord(
        row.reservation_receipt_json,
        'local_state_authority_backup_state_invalid',
      );
      if (request.inventoryHash !== reservation.inventoryHash
        || request.databaseScopeHash !== reservation.databaseScopeHash) {
        failLocalStateAuthority('local_state_authority_backup_finalize_mismatch');
      }
      if (row.finalization_receipt_json) {
        const storedRequest = parseLocalStateAuthorityRecord(
          row.finalize_request_json,
          'local_state_authority_backup_state_invalid',
        );
        if (JSON.stringify(storedRequest) !== JSON.stringify(request)) {
          failLocalStateAuthority('local_state_authority_backup_finalize_conflict');
        }
        return Object.freeze(parseLocalStateAuthorityRecord(
          row.finalization_receipt_json,
          'local_state_authority_backup_state_invalid',
        ));
      }
      const receipt = signBackup({
        version: 1,
        kind: 'AutonomousResearchStateBackupAuthorityFinalization',
        status: 'autonomous_research_state_backup_authority_finalized',
        authorityId: configuration.authorityId,
        keyId: configuration.keyId,
        requestHash: hashRecord(
          'AutonomousResearchStateBackupAuthorityFinalizeRequest',
          request,
        ),
        reservationId: reservation.reservationId,
        inventoryHash: reservation.inventoryHash,
        databaseScopeHash: reservation.databaseScopeHash,
        snapshotContentHash: request.snapshotContentHash,
        headSequence: reservation.headSequence,
        headHash: reservation.headHash,
        finalizedAt: localStateAuthorityNow(clock),
        allRegisteredMutationsFencedThroughFinalize: true,
      });
      database.prepare(`
UPDATE authority_backup_reservation
SET finalize_request_json=?,finalization_receipt_json=?
WHERE reservation_id=?;
`).run(JSON.stringify(request), JSON.stringify(receipt), request.reservationId);
      return receipt;
    });
  }

  function observeBackupHead(request) {
    if (!hasExactObjectKeys(request, BACKUP_HEAD_KEYS)
      || request.version !== 1
      || request.kind !== 'AutonomousResearchStateBackupAuthorityCurrentHeadRequest'
      || !LOCAL_STATE_AUTHORITY_SAFE_ID.test(String(request.reservationId || ''))
      || request.databaseScopeHash !== configuration.databaseScopeHash
      || !LOCAL_STATE_AUTHORITY_SHA256.test(String(request.snapshotContentHash || ''))) {
      failLocalStateAuthority('local_state_authority_backup_head_request_invalid');
    }
    assertBackupLease(request);
    const current = readLocalStateAuthorityMetadata(database);
    const observedAt = localStateAuthorityNow(clock);
    return signBackup({
      version: 1,
      kind: 'AutonomousResearchStateBackupAuthorityCurrentHead',
      status: 'autonomous_research_state_backup_authority_head_observed',
      authorityId: configuration.authorityId,
      keyId: configuration.keyId,
      requestHash: hashRecord(
        'AutonomousResearchStateBackupAuthorityCurrentHeadRequest',
        request,
      ),
      reservationId: request.reservationId,
      databaseScopeHash: request.databaseScopeHash,
      headSequence: Number(current.global_sequence),
      headHash: current.global_hash,
      observedAt,
      expiresAt: localStateAuthorityExpiry(observedAt, request.maximumLeaseMs),
      mutationFenceProtocol: 'external-linearizable-restore-validation-v1',
      allRegisteredMutationsFenced: true,
    });
  }

  function readBackupJournal(request) {
    if (!hasExactObjectKeys(request, BACKUP_JOURNAL_KEYS)
      || request.version !== 1
      || request.kind !== 'AutonomousResearchStateBackupAuthorityJournalRangeRequest'
      || !LOCAL_STATE_AUTHORITY_SAFE_ID.test(String(request.reservationId || ''))
      || request.databaseScopeHash !== configuration.databaseScopeHash
      || !LOCAL_STATE_AUTHORITY_SHA256.test(String(request.snapshotContentHash || ''))
      || request.onlineAuthorityId !== configuration.authorityId
      || request.onlineKeyId !== configuration.keyId
      || request.scopeId !== configuration.scopeId
      || request.writerManifestHash !== configuration.writerManifestHash
      || !Number.isSafeInteger(request.fromGlobalSequence)
      || request.fromGlobalSequence < 0
      || !LOCAL_STATE_AUTHORITY_SHA256.test(String(request.fromGlobalHash || ''))
      || !Number.isSafeInteger(request.toGlobalSequence)
      || request.toGlobalSequence <= request.fromGlobalSequence
      || !LOCAL_STATE_AUTHORITY_SHA256.test(String(request.toGlobalHash || ''))
      || !Number.isSafeInteger(request.maximumEntries)
      || request.maximumEntries < 1
      || request.maximumEntries
        > AUTONOMOUS_RESEARCH_STATE_BACKUP_MAXIMUM_JOURNAL_ENTRIES) {
      failLocalStateAuthority('local_state_authority_backup_journal_request_invalid');
    }
    assertBackupLease(request);
    const rows = database.prepare(`
SELECT * FROM authority_mutation
WHERE status='finalized' AND global_sequence>? AND global_sequence<=?
ORDER BY global_sequence;
`).all(request.fromGlobalSequence, request.toGlobalSequence);
    if (rows.length !== request.toGlobalSequence - request.fromGlobalSequence
      || rows.length > request.maximumEntries) {
      failLocalStateAuthority('local_state_authority_backup_journal_incomplete');
    }
    const current = readLocalStateAuthorityMetadata(database);
    if (Number(current.global_sequence) < request.toGlobalSequence) {
      failLocalStateAuthority('local_state_authority_backup_journal_head_unavailable');
    }
    const entries = rows.map((row) => Object.freeze({
      reserveRequest: parseLocalStateAuthorityRecord(
        row.reserve_request_json,
        'local_state_authority_mutation_state_invalid',
      ),
      reservationReceipt: parseLocalStateAuthorityRecord(
        row.reservation_receipt_json,
        'local_state_authority_mutation_state_invalid',
      ),
      finalizeRequest: parseLocalStateAuthorityRecord(
        row.finalize_request_json,
        'local_state_authority_mutation_state_invalid',
      ),
      finalizationReceipt: parseLocalStateAuthorityRecord(
        row.finalization_receipt_json,
        'local_state_authority_mutation_state_invalid',
      ),
    }));
    const observedAt = localStateAuthorityNow(clock);
    return signBackup({
      version: 1,
      kind: 'AutonomousResearchStateBackupAuthorityJournalRange',
      status: 'autonomous_research_state_backup_authority_journal_range_complete',
      authorityId: configuration.authorityId,
      keyId: configuration.keyId,
      requestHash: hashRecord(
        'AutonomousResearchStateBackupAuthorityJournalRangeRequest',
        request,
      ),
      reservationId: request.reservationId,
      databaseScopeHash: request.databaseScopeHash,
      snapshotContentHash: request.snapshotContentHash,
      onlineAuthorityId: request.onlineAuthorityId,
      onlineKeyId: request.onlineKeyId,
      scopeId: request.scopeId,
      writerManifestHash: request.writerManifestHash,
      fromGlobalSequence: request.fromGlobalSequence,
      fromGlobalHash: request.fromGlobalHash,
      toGlobalSequence: request.toGlobalSequence,
      toGlobalHash: request.toGlobalHash,
      databaseHeads: readLocalStateAuthorityDatabaseHeads(database),
      entries,
      observedAt,
      expiresAt: localStateAuthorityExpiry(observedAt, request.maximumLeaseMs),
      mutationFenceProtocol:
        AUTONOMOUS_RESEARCH_STATE_BACKUP_FINALIZED_JOURNAL_PROTOCOL,
      completeFinalizedMutationJournal: true,
    });
  }

  return Object.freeze({
    reserveBackup,
    finalizeBackup,
    observeBackupHead,
    readBackupJournal,
  });
}
