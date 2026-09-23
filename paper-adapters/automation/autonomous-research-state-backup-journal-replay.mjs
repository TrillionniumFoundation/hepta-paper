import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { constants as sqliteConstants, DatabaseSync } from 'node:sqlite';

import {
  autonomousResearchOnlineMutationLocalMarkerHash,
  autonomousResearchOnlineMutationReceiptHash,
} from '../../paper-domain/automation/autonomous-research-online-mutation-contract.mjs';
import { hasExactObjectKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { pathWithin } from '../../workflow-kernel/runtime/file-utils.mjs';
import { copySqliteDatabase } from '../persistence/sqlite-consistent-copy.mjs';
import { fileSha256HashSync } from '../runtime/pinned-file-reader.mjs';
import {
  autonomousResearchStateBackupAuthorityReceiptHash,
} from './autonomous-research-state-backup-authority.mjs';
import { inspectSqliteDatabase } from './autonomous-research-state-database-inventory.mjs';

const ONLINE_MARKER_TABLE = 'autonomous_research_online_mutation_authority_marker';
const ONLINE_FINALIZATION_TABLE =
  'autonomous_research_online_mutation_finalization_receipt';

function exactSystemRows(database) {
  const metadata = database.prepare(`
SELECT * FROM autonomous_research_online_mutation_authority_metadata ORDER BY singleton;
`).all();
  const markers = database.prepare(`
SELECT * FROM ${ONLINE_MARKER_TABLE} ORDER BY database_sequence,reservation_id;
`).all();
  const finalizations = database.prepare(`
SELECT * FROM ${ONLINE_FINALIZATION_TABLE} ORDER BY reservation_id;
`).all();
  return JSON.stringify({ metadata, markers, finalizations });
}

function parseJsonRecord(value, blocker) {
  try {
    const parsed = JSON.parse(String(value || ''));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch {
    throw new Error(blocker);
  }
}

function checkedReplayHead(database, expected, onlineMutationVerifier) {
  const metadataRows = database.prepare(`
SELECT * FROM autonomous_research_online_mutation_authority_metadata WHERE singleton=1;
`).all();
  if (metadataRows.length !== 1) {
    throw new Error('autonomous_research_state_restore_replay_metadata_required');
  }
  const metadata = metadataRows[0];
  if (metadata.database_role !== expected.role
    || metadata.database_instance_id !== expected.instanceId
    || metadata.schema_contract_id !== expected.schemaContractId
    || metadata.schema_hash !== expected.schemaHash
    || metadata.database_scope_hash !== onlineMutationVerifier.trust.databaseScopeHash
    || metadata.writer_manifest_hash !== onlineMutationVerifier.trust.writerManifestHash) {
    throw new Error('autonomous_research_state_restore_replay_metadata_mismatch');
  }
  const row = database.prepare(`
SELECT marker.*,finalized.finalization_receipt_hash,finalized.finalization_receipt_json,
  finalized.side_effect_permit_hash,finalized.finalized_at
FROM ${ONLINE_MARKER_TABLE} marker
LEFT JOIN ${ONLINE_FINALIZATION_TABLE} finalized
  ON finalized.reservation_id=marker.reservation_id
WHERE marker.database_instance_id=?
ORDER BY marker.database_sequence DESC
LIMIT 1;
`).get(expected.instanceId);
  if (!row) {
    return Object.freeze({
      databaseRole: expected.role,
      databaseInstanceId: expected.instanceId,
      sequence: Number(metadata.genesis_database_sequence),
      hash: metadata.genesis_database_hash,
      schemaHash: metadata.schema_hash,
      stateHash: metadata.genesis_state_hash,
      globalSequence: Number(metadata.genesis_global_sequence),
      globalHash: metadata.genesis_global_hash,
    });
  }
  if (!row.finalization_receipt_json) {
    throw new Error('autonomous_research_state_restore_snapshot_pending_finalization');
  }
  const reserveRequest = parseJsonRecord(
    row.reserve_request_json,
    'autonomous_research_state_restore_snapshot_reserve_request_invalid',
  );
  const reservation = parseJsonRecord(
    row.reservation_receipt_json,
    'autonomous_research_state_restore_snapshot_reservation_invalid',
  );
  const finalization = parseJsonRecord(
    row.finalization_receipt_json,
    'autonomous_research_state_restore_snapshot_finalization_invalid',
  );
  const finalizeRequest = Object.freeze({
    version: 1,
    kind: 'AutonomousResearchOnlineMutationFinalizeRequest',
    protocol: reservation.protocol,
    scopeId: reservation.scopeId,
    databaseScopeHash: reservation.databaseScopeHash,
    writerManifestHash: reservation.writerManifestHash,
    reservationId: reservation.reservationId,
    reservationReceiptHash: row.reservation_receipt_hash,
    databaseRole: reservation.databaseRole,
    databaseInstanceId: reservation.databaseInstanceId,
    writerId: reservation.writerId,
    operationId: reservation.operationId,
    globalSequence: reservation.globalSequence,
    globalHash: reservation.globalHash,
    databaseSequence: reservation.databaseSequence,
    databaseHash: reservation.databaseHash,
    schemaHash: reservation.schemaHash,
    postStateHash: reservation.postStateHash,
    changesetHash: reservation.changesetHash,
    localMarkerHash: row.local_marker_hash,
    authorizationReceiptHashes: reservation.authorizationReceiptHashes,
    sideEffectReservationHashes: reservation.sideEffectReservationHashes,
    committedAt: row.committed_at,
  });
  const reserveRequestHash = hashRecord(
    'AutonomousResearchOnlineMutationReserveRequest', reserveRequest,
  );
  const reservationReceiptHash = autonomousResearchOnlineMutationReceiptHash(reservation);
  const finalizationReceiptHash = autonomousResearchOnlineMutationReceiptHash(finalization);
  const rowBindingValid = row.reserve_request_hash === reserveRequestHash
    && reservation.requestHash === reserveRequestHash
    && row.reservation_receipt_hash === reservationReceiptHash
    && row.finalization_receipt_hash === finalizationReceiptHash
    && row.reservation_id === reservation.reservationId
    && row.database_role === reservation.databaseRole
    && row.database_instance_id === reservation.databaseInstanceId
    && row.writer_id === reservation.writerId
    && row.operation_id === reservation.operationId
    && Number(row.global_sequence) === reservation.globalSequence
    && row.global_hash === reservation.globalHash
    && Number(row.database_sequence) === reservation.databaseSequence
    && row.database_hash === reservation.databaseHash
    && row.schema_hash === reservation.schemaHash
    && row.pre_state_hash === reservation.preStateHash
    && row.post_state_hash === reservation.postStateHash
    && row.changeset_hash === reservation.changesetHash
    && row.committed_at === finalizeRequest.committedAt
    && row.local_marker_hash === autonomousResearchOnlineMutationLocalMarkerHash({
      reservation,
      committedAt: finalizeRequest.committedAt,
    })
    && row.finalized_at === finalization.finalizedAt
    && row.side_effect_permit_hash === finalization.sideEffectPermitHash;
  let receiptsValid = false;
  try {
    receiptsValid = onlineMutationVerifier.verifyReservation({
      receipt: reservation,
      request: reserveRequest,
      now: new Date(reservation.issuedAt),
    }) && onlineMutationVerifier.verifyFinalization({
      receipt: finalization,
      request: finalizeRequest,
      reservation,
      now: new Date(finalization.finalizedAt),
    });
  } catch {
    receiptsValid = false;
  }
  if (!receiptsValid || !rowBindingValid) {
    throw new Error('autonomous_research_state_restore_snapshot_authority_receipt_invalid');
  }
  return Object.freeze({
    databaseRole: expected.role,
    databaseInstanceId: expected.instanceId,
    sequence: Number(row.database_sequence),
    hash: row.database_hash,
    schemaHash: row.schema_hash,
    stateHash: row.post_state_hash,
    globalSequence: Number(row.global_sequence),
    globalHash: row.global_hash,
  });
}

export function validateLiveInventoryFinalizedHeads({
  runtimeRoot,
  inventory,
  reservation,
  onlineMutationVerifier,
}) {
  if (onlineMutationVerifier?.trust?.databaseScopeHash !== inventory.databaseScopeHash) {
    throw new Error('autonomous_research_state_backup_online_authority_scope_mismatch');
  }
  let maximumGlobalHead = null;
  for (const instance of inventory.instances) {
    const database = new DatabaseSync(path.join(runtimeRoot, instance.sourceRelativePath), {
      readOnly: true,
    });
    try {
      const pending = Number(database.prepare(`
SELECT count(*) AS count
FROM ${ONLINE_MARKER_TABLE} marker
LEFT JOIN ${ONLINE_FINALIZATION_TABLE} finalized
  ON finalized.reservation_id=marker.reservation_id
WHERE finalized.reservation_id IS NULL;
`).get().count);
      if (pending !== 0) {
        throw new Error('autonomous_research_state_backup_pending_finalization_forbidden');
      }
      const head = checkedReplayHead(database, instance, onlineMutationVerifier);
      if (!maximumGlobalHead || head.globalSequence > maximumGlobalHead.sequence) {
        maximumGlobalHead = Object.freeze({
          sequence: head.globalSequence,
          hash: head.globalHash,
        });
      } else if (head.globalSequence === maximumGlobalHead.sequence
        && head.globalHash !== maximumGlobalHead.hash) {
        throw new Error('autonomous_research_state_backup_local_global_head_conflict');
      }
    } finally {
      database.close();
    }
  }
  if (maximumGlobalHead?.sequence !== reservation.headSequence
    || maximumGlobalHead?.hash !== reservation.headHash) {
    throw new Error('autonomous_research_state_backup_local_authority_head_mismatch');
  }
}

function insertReplayedAuthorityRecords(database, entry) {
  const {
    reserveRequest,
    reservationReceipt: reservation,
    finalizeRequest,
    finalizationReceipt: finalization,
  } = entry;
  database.exec('BEGIN IMMEDIATE;');
  try {
    database.prepare(`
INSERT INTO ${ONLINE_MARKER_TABLE}(
  reservation_id,database_role,database_instance_id,writer_id,operation_id,
  global_sequence,global_hash,database_sequence,database_hash,schema_hash,
  pre_state_hash,post_state_hash,changeset_hash,reserve_request_hash,
  reserve_request_json,reservation_receipt_hash,reservation_receipt_json,
  local_marker_hash,committed_at
) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?);
`).run(
      reservation.reservationId,
      reservation.databaseRole,
      reservation.databaseInstanceId,
      reservation.writerId,
      reservation.operationId,
      reservation.globalSequence,
      reservation.globalHash,
      reservation.databaseSequence,
      reservation.databaseHash,
      reservation.schemaHash,
      reservation.preStateHash,
      reservation.postStateHash,
      reservation.changesetHash,
      reservation.requestHash,
      JSON.stringify(reserveRequest),
      finalizeRequest.reservationReceiptHash,
      JSON.stringify(reservation),
      finalizeRequest.localMarkerHash,
      finalizeRequest.committedAt,
    );
    database.prepare(`
INSERT INTO ${ONLINE_FINALIZATION_TABLE}(
  reservation_id,finalization_receipt_hash,finalization_receipt_json,
  side_effect_permit_hash,finalized_at,recorded_at
) VALUES(?,?,?,?,?,?);
`).run(
      finalization.reservationId,
      autonomousResearchStateBackupAuthorityReceiptHash(finalization),
      JSON.stringify(finalization),
      finalization.sideEffectPermitHash,
      finalization.finalizedAt,
      finalization.finalizedAt,
    );
    database.exec('COMMIT;');
  } catch (error) {
    if (database.isTransaction) database.exec('ROLLBACK;');
    throw error;
  }
}

function assertJournalEntry({
  entry,
  globalHead,
  databaseHead,
  expectedDatabase,
  onlineMutationVerifier,
}) {
  if (!hasExactObjectKeys(entry, [
    'reserveRequest', 'reservationReceipt', 'finalizeRequest', 'finalizationReceipt',
  ])) throw new Error('autonomous_research_state_restore_journal_entry_shape_invalid');
  const {
    reserveRequest,
    reservationReceipt: reservation,
    finalizeRequest,
    finalizationReceipt: finalization,
  } = entry;
  let reservationValid = false;
  let finalizationValid = false;
  try {
    reservationValid = onlineMutationVerifier.verifyReservation({
      receipt: reservation,
      request: reserveRequest,
      now: new Date(reservation?.issuedAt),
    });
  } catch {
    reservationValid = false;
  }
  if (!reservationValid) {
    throw new Error('autonomous_research_state_restore_journal_reservation_invalid');
  }
  try {
    finalizationValid = onlineMutationVerifier.verifyFinalization({
      receipt: finalization,
      request: finalizeRequest,
      reservation,
      now: new Date(finalization?.finalizedAt),
    });
  } catch {
    finalizationValid = false;
  }
  if (!finalizationValid) {
    throw new Error('autonomous_research_state_restore_journal_finalization_invalid');
  }
  if (reservation.globalPreviousSequence !== globalHead.sequence
    || reservation.globalPreviousHash !== globalHead.hash
    || reservation.globalSequence !== globalHead.sequence + 1
    || reservation.databaseRole !== expectedDatabase.role
    || reservation.databaseInstanceId !== expectedDatabase.instanceId
    || reservation.schemaContractId !== expectedDatabase.schemaContractId
    || reservation.schemaHash !== expectedDatabase.schemaHash
    || reservation.databasePreviousSequence !== databaseHead.sequence
    || reservation.databasePreviousHash !== databaseHead.hash
    || reservation.preStateHash !== databaseHead.stateHash
    || reservation.databaseSequence !== databaseHead.sequence + 1) {
    throw new Error('autonomous_research_state_restore_journal_continuity_invalid');
  }
  return Object.freeze({ reserveRequest, reservation, finalizeRequest, finalization });
}

export async function drillDatabaseCopiesWithReplay({
  bundleRoot,
  databases,
  journalRange,
  onlineMutationVerifier,
  snapshotHead,
}) {
  const blockers = [];
  const expectedPaths = new Set(databases.map((entry) => entry.backupRelativePath));
  const databaseRoot = path.join(bundleRoot, 'databases');
  const present = fs.existsSync(databaseRoot)
    ? fs.readdirSync(databaseRoot).map((name) => `databases/${name}`)
    : [];
  if (present.some((entry) => !expectedPaths.has(entry))
    || present.length !== expectedPaths.size) {
    return Object.freeze({
      blockers: Object.freeze(['autonomous_research_state_backup_database_set_mismatch']),
      recoveredDatabaseHeads: Object.freeze([]),
    });
  }
  const drillRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-state-restore-drill-'));
  const opened = new Map();
  try {
    for (const entry of databases) {
      const sourcePath = path.resolve(bundleRoot, entry.backupRelativePath);
      if (!pathWithin(bundleRoot, sourcePath)
        || !fs.existsSync(sourcePath)
        || fs.lstatSync(sourcePath).isSymbolicLink()
        || !fs.lstatSync(sourcePath).isFile()
        || !pathWithin(fs.realpathSync(bundleRoot), fs.realpathSync(sourcePath))
        || fileSha256HashSync(sourcePath) !== entry.backupSha256
        || fs.statSync(sourcePath).size !== entry.bytes) {
        throw new Error(`autonomous_research_state_backup_database_hash_mismatch:${entry.instanceId}`);
      }
      const drillPath = path.join(drillRoot, path.basename(entry.backupRelativePath));
      await copySqliteDatabase({
        sourcePath,
        destinationPath: drillPath,
        sourceImmutable: true,
      });
      const inspection = inspectSqliteDatabase(drillPath, { immutable: true });
      if (inspection.quickCheck !== 'ok'
        || inspection.foreignKeyViolationCount !== 0
        || inspection.schemaHash !== entry.schemaHash) {
        throw new Error(`autonomous_research_state_restore_copy_invalid:${entry.instanceId}`);
      }
      const database = new DatabaseSync(drillPath);
      database.exec('PRAGMA foreign_keys=ON;');
      opened.set(entry.instanceId, Object.freeze({ database, definition: entry, path: drillPath }));
    }
    const databaseHeads = new Map();
    let observedGlobalHead = null;
    for (const [instanceId, openedDatabase] of opened) {
      const head = checkedReplayHead(
        openedDatabase.database,
        openedDatabase.definition,
        onlineMutationVerifier,
      );
      databaseHeads.set(instanceId, head);
      if (!observedGlobalHead || head.globalSequence > observedGlobalHead.sequence) {
        observedGlobalHead = Object.freeze({
          sequence: head.globalSequence,
          hash: head.globalHash,
        });
      } else if (head.globalSequence === observedGlobalHead.sequence
        && head.globalHash !== observedGlobalHead.hash) {
        throw new Error('autonomous_research_state_restore_snapshot_global_head_conflict');
      }
    }
    if (observedGlobalHead?.sequence !== snapshotHead.sequence
      || observedGlobalHead?.hash !== snapshotHead.hash) {
      throw new Error('autonomous_research_state_restore_snapshot_global_head_invalid');
    }
    let globalHead = Object.freeze({ ...observedGlobalHead });
    for (const entry of journalRange.entries) {
      const instanceId = entry?.reservationReceipt?.databaseInstanceId;
      const target = opened.get(instanceId);
      if (!target) {
        throw new Error('autonomous_research_state_restore_journal_database_unknown');
      }
      const checked = assertJournalEntry({
        entry,
        globalHead,
        databaseHead: databaseHeads.get(instanceId),
        expectedDatabase: target.definition,
        onlineMutationVerifier,
      });
      const systemRowsBefore = exactSystemRows(target.database);
      const applied = target.database.applyChangeset(
        Buffer.from(checked.reservation.changesetBase64, 'base64'),
        { onConflict: () => sqliteConstants.SQLITE_CHANGESET_ABORT },
      );
      if (!applied || exactSystemRows(target.database) !== systemRowsBefore) {
        throw new Error('autonomous_research_state_restore_business_changeset_invalid');
      }
      const inspection = inspectSqliteDatabase(target.path);
      if (inspection.schemaHash !== target.definition.schemaHash
        || inspection.quickCheck !== 'ok'
        || inspection.foreignKeyViolationCount !== 0) {
        throw new Error('autonomous_research_state_restore_replayed_database_invalid');
      }
      insertReplayedAuthorityRecords(target.database, entry);
      const head = Object.freeze({
        databaseRole: checked.reservation.databaseRole,
        databaseInstanceId: checked.reservation.databaseInstanceId,
        sequence: checked.reservation.databaseSequence,
        hash: checked.reservation.databaseHash,
        schemaHash: checked.reservation.schemaHash,
        stateHash: checked.reservation.postStateHash,
        globalSequence: checked.reservation.globalSequence,
        globalHash: checked.reservation.globalHash,
      });
      databaseHeads.set(instanceId, head);
      globalHead = Object.freeze({
        sequence: checked.reservation.globalSequence,
        hash: checked.reservation.globalHash,
      });
    }
    if (globalHead.sequence !== journalRange.toGlobalSequence
      || globalHead.hash !== journalRange.toGlobalHash) {
      throw new Error('autonomous_research_state_restore_journal_target_head_invalid');
    }
    const recoveredDatabaseHeads = [...databaseHeads.values()]
      .map((head) => Object.freeze({
        databaseRole: head.databaseRole,
        databaseInstanceId: head.databaseInstanceId,
        sequence: head.sequence,
        hash: head.hash,
        schemaHash: head.schemaHash,
        stateHash: head.stateHash,
      }))
      .sort((left, right) => left.databaseInstanceId.localeCompare(right.databaseInstanceId));
    if (JSON.stringify(recoveredDatabaseHeads) !== JSON.stringify(journalRange.databaseHeads)) {
      throw new Error('autonomous_research_state_restore_recovered_database_heads_invalid');
    }
    return Object.freeze({
      blockers: Object.freeze([]),
      recoveredDatabaseHeads: Object.freeze(recoveredDatabaseHeads),
    });
  } catch (error) {
    blockers.push(error?.message || 'autonomous_research_state_restore_journal_replay_failed');
    return Object.freeze({
      blockers: Object.freeze([...new Set(blockers)].sort()),
      recoveredDatabaseHeads: Object.freeze([]),
    });
  } finally {
    for (const openedDatabase of opened.values()) openedDatabase.database.close();
    fs.rmSync(drillRoot, { recursive: true, force: true });
  }
}
