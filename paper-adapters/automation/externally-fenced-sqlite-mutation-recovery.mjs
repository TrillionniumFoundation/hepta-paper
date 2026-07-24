import {
  autonomousResearchOnlineMutationLocalMarkerHash,
  autonomousResearchOnlineMutationReceiptHash,
  AUTONOMOUS_RESEARCH_ONLINE_MUTATION_PROTOCOL,
} from '../../paper-domain/automation/autonomous-research-online-mutation-contract.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  externallyFencedSqliteMutationExactSchemaHash as exactSchemaHash,
  observedExternallyFencedSqliteMutationNow as observedNow,
  readExternallyFencedSqliteMutationMetadata as metadata,
} from './externally-fenced-sqlite-storage-primitives.mjs';

function fail(code, extra = {}) {
  const error = new Error(code);
  Object.assign(error, extra);
  throw error;
}

export function buildExternallyFencedSqliteMutationFinalizeRequest(
  reservation,
  committedAt,
) {
  return Object.freeze({
    version: 1,
    kind: 'AutonomousResearchOnlineMutationFinalizeRequest',
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
    globalSequence: reservation.globalSequence,
    globalHash: reservation.globalHash,
    databaseSequence: reservation.databaseSequence,
    databaseHash: reservation.databaseHash,
    schemaHash: reservation.schemaHash,
    postStateHash: reservation.postStateHash,
    changesetHash: reservation.changesetHash,
    localMarkerHash: autonomousResearchOnlineMutationLocalMarkerHash({
      reservation,
      committedAt,
    }),
    authorizationReceiptHashes: reservation.authorizationReceiptHashes,
    sideEffectReservationHashes: reservation.sideEffectReservationHashes,
    committedAt,
  });
}

export function recordExternallyFencedSqliteMutationFinalization(
  database,
  receipt,
  recordedAt,
) {
  const receiptHash = autonomousResearchOnlineMutationReceiptHash(receipt);
  database.exec('BEGIN IMMEDIATE;');
  try {
    database.prepare(`
INSERT INTO autonomous_research_online_mutation_finalization_receipt(
  reservation_id,finalization_receipt_hash,finalization_receipt_json,
  side_effect_permit_hash,finalized_at,recorded_at
) VALUES(?,?,?,?,?,?)
ON CONFLICT(reservation_id) DO NOTHING;
`).run(
      receipt.reservationId,
      receiptHash,
      JSON.stringify(receipt),
      receipt.sideEffectPermitHash,
      receipt.finalizedAt,
      recordedAt,
    );
    const stored = database.prepare(`
SELECT finalization_receipt_hash FROM autonomous_research_online_mutation_finalization_receipt
WHERE reservation_id=?;
`).get(receipt.reservationId);
    if (stored?.finalization_receipt_hash !== receiptHash) {
      fail('externally_fenced_sqlite_mutation_finalization_receipt_conflict');
    }
    database.exec('COMMIT;');
  } catch (error) {
    if (database.isTransaction) database.exec('ROLLBACK;');
    throw error;
  }
}

function checkedPendingMarker(row, meta, authorityClient) {
  let reservation;
  let reserveRequest;
  try { reservation = JSON.parse(row.reservation_receipt_json); }
  catch { fail('externally_fenced_sqlite_mutation_recovery_reservation_invalid'); }
  try { reserveRequest = JSON.parse(row.reserve_request_json); }
  catch { fail('externally_fenced_sqlite_mutation_recovery_request_invalid'); }
  const reserveRequestHash = hashRecord(
    'AutonomousResearchOnlineMutationReserveRequest', reserveRequest,
  );
  const reservationReceiptHash = autonomousResearchOnlineMutationReceiptHash(reservation);
  const exact = row.reserve_request_hash === reserveRequestHash
    && row.reservation_receipt_hash === reservationReceiptHash
    && reservation.requestHash === reserveRequestHash
    && row.reservation_id === reservation.reservationId
    && row.database_role === reservation.databaseRole
    && row.database_instance_id === reservation.databaseInstanceId
    && row.writer_id === reservation.writerId
    && row.operation_id === reservation.operationId
    && row.global_sequence === reservation.globalSequence
    && row.global_hash === reservation.globalHash
    && row.database_sequence === reservation.databaseSequence
    && row.database_hash === reservation.databaseHash
    && row.schema_hash === reservation.schemaHash
    && row.pre_state_hash === reservation.preStateHash
    && row.post_state_hash === reservation.postStateHash
    && row.changeset_hash === reservation.changesetHash
    && meta.database_role === reservation.databaseRole
    && meta.database_instance_id === reservation.databaseInstanceId
    && meta.schema_contract_id === reservation.schemaContractId;
  if (!exact || !authorityClient.verifyStoredReservation({
    receipt: reservation,
    request: reserveRequest,
  })) fail('externally_fenced_sqlite_mutation_recovery_reservation_invalid');
  const request = buildExternallyFencedSqliteMutationFinalizeRequest(
    reservation,
    row.committed_at,
  );
  if (request.localMarkerHash !== row.local_marker_hash) {
    fail('externally_fenced_sqlite_mutation_recovery_marker_mismatch');
  }
  return Object.freeze({ reservation, request });
}

export function recoverExternallyFencedSqliteMutations({
  database,
  authorityClient,
  authorityTrust,
  clock,
} = {}) {
  if (!database || database.isTransaction) {
    fail('externally_fenced_sqlite_mutation_recovery_database_invalid');
  }
  const meta = metadata(database);
  const schemaHash = exactSchemaHash(database);
  if (meta.protocol !== AUTONOMOUS_RESEARCH_ONLINE_MUTATION_PROTOCOL
    || meta.database_scope_hash !== authorityTrust.databaseScopeHash
    || meta.writer_manifest_hash !== authorityTrust.writerManifestHash
    || meta.schema_hash !== schemaHash) {
    fail('externally_fenced_sqlite_mutation_recovery_metadata_mismatch');
  }
  const rows = database.prepare(`
SELECT marker.* FROM autonomous_research_online_mutation_authority_marker marker
LEFT JOIN autonomous_research_online_mutation_finalization_receipt finalized
  ON finalized.reservation_id=marker.reservation_id
WHERE finalized.reservation_id IS NULL
ORDER BY marker.database_sequence;
`).all();
  const recovered = [];
  const finalizedHeads = [];
  for (const row of rows) {
    const { reservation, request } = checkedPendingMarker(row, meta, authorityClient);
    const finalization = authorityClient.finalizeMutation({
      request,
      reservation,
      now: observedNow(clock),
    });
    recordExternallyFencedSqliteMutationFinalization(
      database,
      finalization,
      observedNow(clock).toISOString(),
    );
    recovered.push(reservation.reservationId);
    finalizedHeads.push(Object.freeze({
      reservationId: reservation.reservationId,
      globalSequence: finalization.globalSequence,
      globalHash: finalization.globalHash,
    }));
  }
  return Object.freeze({
    version: 1,
    kind: 'ExternallyFencedSqliteMutationRecoveryReceipt',
    status: 'externally_fenced_sqlite_mutation_recovery_complete',
    recoveredReservationIds: Object.freeze(recovered),
    finalizedHeads: Object.freeze(finalizedHeads),
  });
}
