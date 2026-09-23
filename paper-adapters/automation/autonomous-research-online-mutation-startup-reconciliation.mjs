import crypto from 'node:crypto';

import {
  autonomousResearchOnlineMutationReceiptHash,
  AUTONOMOUS_RESEARCH_ONLINE_MUTATION_PROTOCOL,
} from '../../paper-domain/automation/autonomous-research-online-mutation-contract.mjs';
import {
  assertAutonomousResearchOnlineWriterOperationManifest,
  autonomousResearchOnlineWriterOperationManifestHash,
} from '../../paper-domain/automation/autonomous-research-online-writer-manifest.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  recoverExternallyFencedSqliteMutations,
} from './externally-fenced-sqlite-mutation-recovery.mjs';
import {
  externallyFencedSqliteMutationExactSchemaHash as exactSchemaHash,
  observedExternallyFencedSqliteMutationNow,
} from './externally-fenced-sqlite-storage-primitives.mjs';

function fail(code, extra = {}) {
  const error = new Error(code);
  Object.assign(error, extra);
  throw error;
}

const observedNow = (clock) => observedExternallyFencedSqliteMutationNow(
  clock,
  'autonomous_research_online_mutation_startup_clock_invalid',
);

export function buildAutonomousResearchOnlineUnresolvedReservationListRequest({
  trust,
  databaseRole,
  databaseInstanceId,
  nonce = `unresolved:${crypto.randomUUID()}`,
  requestedAt,
} = {}) {
  return Object.freeze({
    version: 1,
    kind: 'AutonomousResearchOnlineUnresolvedReservationListRequest',
    protocol: AUTONOMOUS_RESEARCH_ONLINE_MUTATION_PROTOCOL,
    scopeId: trust?.scopeId,
    databaseScopeHash: trust?.databaseScopeHash,
    writerManifestHash: trust?.writerManifestHash,
    databaseRole,
    databaseInstanceId,
    nonce,
    requestedAt,
  });
}

function validateConfiguration({
  database,
  authorityClient,
  authorityTrust,
  writerManifest,
  databaseRole,
  databaseInstanceId,
}) {
  const manifest = assertAutonomousResearchOnlineWriterOperationManifest(writerManifest);
  if (!database
    || database.isTransaction
    || typeof database.prepare !== 'function'
    || authorityClient?.protocol !== AUTONOMOUS_RESEARCH_ONLINE_MUTATION_PROTOCOL
    || authorityClient?.trust !== authorityTrust
    || typeof authorityClient.listUnresolvedMutations !== 'function'
    || typeof authorityClient.verifyStoredReservation !== 'function'
    || typeof authorityClient.finalizeMutation !== 'function'
    || typeof authorityClient.abortMutation !== 'function'
    || authorityTrust?.writerManifestHash
      !== autonomousResearchOnlineWriterOperationManifestHash(manifest)
    || !manifest.requiredDatabaseRoles.includes(databaseRole)
    || typeof databaseInstanceId !== 'string'
    || databaseInstanceId.length === 0) {
    fail('autonomous_research_online_mutation_startup_configuration_invalid');
  }
  return manifest;
}

function buildStartupAbortRequest(reservation, requestedAt) {
  return Object.freeze({
    version: 1,
    kind: 'AutonomousResearchOnlineMutationAbortRequest',
    protocol: reservation.protocol,
    scopeId: reservation.scopeId,
    databaseScopeHash: reservation.databaseScopeHash,
    writerManifestHash: reservation.writerManifestHash,
    reservationId: reservation.reservationId,
    reservationReceiptHash: autonomousResearchOnlineMutationReceiptHash(reservation),
    databaseRole: reservation.databaseRole,
    databaseInstanceId: reservation.databaseInstanceId,
    writerId: reservation.writerId,
    operationId: reservation.operationId,
    mutationAttemptId: reservation.mutationAttemptId,
    globalSequence: reservation.globalSequence,
    globalHash: reservation.globalHash,
    databaseSequence: reservation.databaseSequence,
    databaseHash: reservation.databaseHash,
    changesetHash: reservation.changesetHash,
    reason: 'local-commit-failed',
    requestedAt,
  });
}

function latestLocalDatabaseHead(database, metadata) {
  const marker = database.prepare(`
SELECT database_sequence,database_hash,schema_hash,post_state_hash
FROM autonomous_research_online_mutation_authority_marker
WHERE database_instance_id=?
ORDER BY database_sequence DESC
LIMIT 1;
`).get(metadata.database_instance_id);
  return Object.freeze(marker ? {
    databaseSequence: Number(marker.database_sequence),
    databaseHash: marker.database_hash,
    schemaHash: marker.schema_hash,
    stateHash: marker.post_state_hash,
  } : {
    databaseSequence: Number(metadata.genesis_database_sequence),
    databaseHash: metadata.genesis_database_hash,
    schemaHash: metadata.schema_hash,
    stateHash: metadata.genesis_state_hash,
  });
}

function abortProvenRemoteOnlyReservation({
  database,
  entry,
  authorityClient,
  authorityTrust,
  clock,
}) {
  const { reserveRequest, reservation } = entry;
  database.exec('BEGIN IMMEDIATE;');
  try {
    if (markerState(database, entry) !== 'absent') {
      fail('autonomous_research_online_mutation_startup_remote_only_state_changed');
    }
    const metadataRows = database.prepare(`
SELECT * FROM autonomous_research_online_mutation_authority_metadata
WHERE singleton=1;
`).all();
    const quickCheck = database.prepare('PRAGMA quick_check;').all();
    const metadata = metadataRows[0];
    const schemaHash = exactSchemaHash(database);
    if (metadataRows.length !== 1
      || quickCheck.length !== 1
      || String(quickCheck[0]?.quick_check || quickCheck[0]?.integrity_check) !== 'ok'
      || database.prepare('PRAGMA foreign_key_check;').all().length !== 0
      || metadata.protocol !== AUTONOMOUS_RESEARCH_ONLINE_MUTATION_PROTOCOL
      || metadata.database_role !== reservation.databaseRole
      || metadata.database_instance_id !== reservation.databaseInstanceId
      || metadata.schema_contract_id !== reserveRequest.schemaContractId
      || metadata.schema_hash !== schemaHash
      || metadata.database_scope_hash !== authorityTrust.databaseScopeHash
      || metadata.writer_manifest_hash !== authorityTrust.writerManifestHash
      || reserveRequest.schemaHash !== schemaHash) {
      fail('autonomous_research_online_mutation_startup_remote_only_metadata_mismatch');
    }
    const localHead = latestLocalDatabaseHead(database, metadata);
    if (localHead.databaseSequence !== reserveRequest.databasePreviousSequence
      || localHead.databaseHash !== reserveRequest.databasePreviousHash
      || localHead.schemaHash !== reserveRequest.schemaHash
      || localHead.stateHash !== reserveRequest.preStateHash) {
      fail('autonomous_research_online_mutation_startup_remote_only_local_head_mismatch');
    }
    const requestedAt = observedNow(clock).toISOString();
    const abortReceipt = authorityClient.abortMutation({
      request: buildStartupAbortRequest(reservation, requestedAt),
      reservation,
      now: observedNow(clock),
    });
    database.exec('ROLLBACK;');
    return Object.freeze({
      reservationId: reservation.reservationId,
      abortReceiptHash: autonomousResearchOnlineMutationReceiptHash(abortReceipt),
      abortReceipt,
    });
  } catch (error) {
    if (database.isTransaction) database.exec('ROLLBACK;');
    throw error;
  }
}

function validateManifestBinding(reserveRequest, reservation, manifest) {
  const operation = manifest.operations.find((candidate) => (
    candidate.operationId === reservation?.operationId
  ));
  const writer = manifest.writers.find((candidate) => (
    candidate.writerId === reservation?.writerId
    && candidate.operationIds.includes(reservation.operationId)
  ));
  if (!operation?.coordinatorIntegrated
    || operation.databaseRole !== reservation?.databaseRole
    || !writer
    || writer.implementationHash !== reservation?.codeProvenanceHash
    || reserveRequest?.mutationAttemptId !== reservation?.mutationAttemptId
    || reserveRequest?.operationId !== reservation?.operationId
    || reserveRequest?.writerId !== reservation?.writerId) {
    fail('autonomous_research_online_mutation_startup_manifest_binding_invalid');
  }
}

function parseStoredJson(value, blocker) {
  try {
    const parsed = JSON.parse(String(value || ''));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch { fail(blocker); }
}

function pendingLocalMarkers(database, authorityClient, manifest) {
  const rows = database.prepare(`
SELECT marker.* FROM autonomous_research_online_mutation_authority_marker marker
LEFT JOIN autonomous_research_online_mutation_finalization_receipt finalized
  ON finalized.reservation_id=marker.reservation_id
WHERE finalized.reservation_id IS NULL
ORDER BY marker.database_sequence;
`).all();
  return rows.map((row) => {
    const reserveRequest = parseStoredJson(
      row.reserve_request_json,
      'autonomous_research_online_mutation_startup_local_request_invalid',
    );
    const reservation = parseStoredJson(
      row.reservation_receipt_json,
      'autonomous_research_online_mutation_startup_local_reservation_invalid',
    );
    if (!authorityClient.verifyStoredReservation({
      receipt: reservation,
      request: reserveRequest,
    })) {
      fail('autonomous_research_online_mutation_startup_local_reservation_invalid');
    }
    validateManifestBinding(reserveRequest, reservation, manifest);
    return Object.freeze({ row, reserveRequest, reservation });
  });
}

function markerState(database, entry) {
  const row = database.prepare(`
SELECT marker.reserve_request_hash,marker.reservation_receipt_hash,
       finalized.reservation_id AS finalized_reservation_id
FROM autonomous_research_online_mutation_authority_marker marker
LEFT JOIN autonomous_research_online_mutation_finalization_receipt finalized
  ON finalized.reservation_id=marker.reservation_id
WHERE marker.reservation_id=?;
`).get(entry.reservation.reservationId);
  if (!row) return 'absent';
  if (row.finalized_reservation_id !== null) {
    fail('autonomous_research_online_mutation_startup_broker_local_state_conflict');
  }
  const reserveRequestHash = hashRecord(
    'AutonomousResearchOnlineMutationReserveRequest', entry.reserveRequest,
  );
  const reservationReceiptHash = autonomousResearchOnlineMutationReceiptHash(
    entry.reservation,
  );
  if (row.reserve_request_hash !== reserveRequestHash
    || row.reservation_receipt_hash !== reservationReceiptHash) {
    fail('autonomous_research_online_mutation_startup_marker_binding_invalid');
  }
  return 'pending';
}

function listUnresolved({
  authorityClient,
  authorityTrust,
  databaseRole,
  databaseInstanceId,
  clock,
}) {
  const requestedAt = observedNow(clock).toISOString();
  const request = buildAutonomousResearchOnlineUnresolvedReservationListRequest({
    trust: authorityTrust,
    databaseRole,
    databaseInstanceId,
    requestedAt,
  });
  return Object.freeze({
    request,
    receipt: authorityClient.listUnresolvedMutations({
      request,
      now: observedNow(clock),
    }),
  });
}

export function reconcileAutonomousResearchOnlineMutationDatabaseStartup({
  database,
  databaseRole,
  databaseInstanceId,
  authorityClient,
  authorityTrust = authorityClient?.trust,
  writerManifest,
  clock = { now: () => new Date() },
} = {}) {
  const manifest = validateConfiguration({
    database,
    authorityClient,
    authorityTrust,
    writerManifest,
    databaseRole,
    databaseInstanceId,
  });
  const initial = listUnresolved({
    authorityClient,
    authorityTrust,
    databaseRole,
    databaseInstanceId,
    clock,
  });
  const absent = [];
  for (const entry of initial.receipt.unresolvedReservations) {
    validateManifestBinding(entry.reserveRequest, entry.reservation, manifest);
    if (markerState(database, entry) === 'absent') absent.push(entry);
  }
  pendingLocalMarkers(database, authorityClient, manifest);
  const recovery = recoverExternallyFencedSqliteMutations({
    database,
    authorityClient,
    authorityTrust,
    clock,
  });
  const abortedRemoteOnly = absent.map((entry) => (
    abortProvenRemoteOnlyReservation({
      database,
      entry,
      authorityClient,
      authorityTrust,
      clock,
    })
  ));
  const confirmation = listUnresolved({
    authorityClient,
    authorityTrust,
    databaseRole,
    databaseInstanceId,
    clock,
  });
  if (confirmation.receipt.unresolvedReservationCount !== 0
    || confirmation.receipt.unresolvedReservations.length !== 0) {
    fail('autonomous_research_online_mutation_startup_reconciliation_incomplete');
  }
  const localPendingCount = database.prepare(`
SELECT count(*) AS count
FROM autonomous_research_online_mutation_authority_marker marker
LEFT JOIN autonomous_research_online_mutation_finalization_receipt finalized
  ON finalized.reservation_id=marker.reservation_id
WHERE finalized.reservation_id IS NULL;
`).get().count;
  if (localPendingCount !== 0) {
    fail('autonomous_research_online_mutation_startup_local_recovery_incomplete');
  }
  return Object.freeze({
    version: 1,
    kind: 'AutonomousResearchOnlineMutationUnresolvedReservationReconciliationReceipt',
    status: 'autonomous_research_online_mutation_unresolved_reservations_reconciled',
    databaseRole,
    databaseInstanceId,
    initialUnresolvedReservationCount: initial.receipt.unresolvedReservationCount,
    recoveredReservationIds: recovery.recoveredReservationIds,
    finalizedHeads: recovery.finalizedHeads,
    abortedRemoteOnlyReservationIds: Object.freeze(abortedRemoteOnly.map(
      (entry) => entry.reservationId,
    )),
    abortedRemoteOnlyAbortReceiptHashes: Object.freeze(abortedRemoteOnly.map(
      (entry) => entry.abortReceiptHash,
    )),
    abortedRemoteOnlyAbortReceipts: Object.freeze(abortedRemoteOnly.map(
      (entry) => entry.abortReceipt,
    )),
    initialRemoteOnlyReservationCount: absent.length,
    remoteOnlyReservationCount: 0,
    businessDmlReplayed: false,
    confirmationReceiptHash: autonomousResearchOnlineMutationReceiptHash(
      confirmation.receipt,
    ),
    remainingBlockers: Object.freeze([
      'autonomous_research_online_mutation_finalized_head_reconciliation_required',
      'autonomous_research_online_mutation_active_startup_head_challenge_required',
    ]),
    runtimeReady: false,
  });
}
