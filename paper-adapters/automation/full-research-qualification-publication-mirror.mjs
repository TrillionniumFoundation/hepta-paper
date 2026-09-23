import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { writeDurableJsonSync } from '../runtime/durable-json-repository.mjs';
import {
  FULL_RESEARCH_QUALIFICATION_PUBLICATION_DATABASE_ROLE,
  FULL_RESEARCH_QUALIFICATION_PUBLICATION_OPERATION_IDS,
} from './full-research-qualification-publication-mutation-plan.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;

function fail(code) { throw new Error(code); }

export function fullResearchQualificationCommittedMirrorPending(error, mutationReceipt) {
  const wrapped = new Error(
    `full_research_qualification_pointer_committed_mirror_pending:${error?.message || 'unknown'}`,
    { cause: error },
  );
  wrapped.committed = true;
  wrapped.retryableSideEffectOnly = true;
  wrapped.reservationId = mutationReceipt?.reservationId || null;
  wrapped.sideEffectPermitHash = mutationReceipt?.sideEffectPermitHash || null;
  return wrapped;
}

function parseJson(value, code) {
  try { return JSON.parse(String(value)); }
  catch { fail(code); }
}

export function fullResearchQualificationMirrorReservationHash({
  databaseInstanceId,
  qualificationReceiptPath,
  receiptHash,
  receiptContentHash,
} = {}) {
  return hashRecord('FullResearchQualificationPointerMirrorSideEffectReservation', {
    version: 1,
    databaseInstanceId,
    qualificationReceiptPath,
    receiptHash,
    receiptContentHash,
  });
}

function journalMirrorPermit(database, {
  databaseInstanceId,
  expectedReservationHash,
} = {}) {
  let row;
  try {
    row = database.prepare(`SELECT
      marker.reservation_id,marker.database_role,marker.database_instance_id,
      marker.operation_id,marker.reserve_request_json,
      finalization.side_effect_permit_hash,finalization.finalization_receipt_json
      FROM autonomous_research_online_mutation_authority_marker AS marker
      JOIN autonomous_research_online_mutation_finalization_receipt AS finalization
        ON finalization.reservation_id=marker.reservation_id
      WHERE marker.database_instance_id=? AND marker.operation_id=?
      ORDER BY marker.database_sequence DESC LIMIT 1`).get(
      databaseInstanceId,
      FULL_RESEARCH_QUALIFICATION_PUBLICATION_OPERATION_IDS.publish,
    );
  } catch {
    fail('full_research_qualification_pointer_side_effect_permit_required');
  }
  const reserveRequest = parseJson(
    row?.reserve_request_json,
    'full_research_qualification_pointer_side_effect_reservation_invalid',
  );
  const finalization = parseJson(
    row?.finalization_receipt_json,
    'full_research_qualification_pointer_side_effect_permit_invalid',
  );
  if (row?.database_role !== FULL_RESEARCH_QUALIFICATION_PUBLICATION_DATABASE_ROLE
    || row?.database_instance_id !== databaseInstanceId
    || row?.operation_id !== FULL_RESEARCH_QUALIFICATION_PUBLICATION_OPERATION_IDS.publish
    || !Array.isArray(reserveRequest.sideEffectReservationHashes)
    || reserveRequest.sideEffectReservationHashes.length !== 1
    || reserveRequest.sideEffectReservationHashes[0] !== expectedReservationHash
    || finalization.reservationId !== row.reservation_id
    || finalization.sideEffectPermitHash !== row.side_effect_permit_hash
    || !SHA256.test(String(row.side_effect_permit_hash || ''))) {
    fail('full_research_qualification_pointer_side_effect_permit_invalid');
  }
  return row.side_effect_permit_hash;
}

function authorizedMirrorPermit(database, {
  authority,
  qualificationReceiptPath,
  databaseInstanceId,
  requirePermit,
  ephemeralPermit,
} = {}) {
  if (!requirePermit) return null;
  const expectedReservationHash = fullResearchQualificationMirrorReservationHash({
    databaseInstanceId,
    qualificationReceiptPath,
    receiptHash: authority.row.receipt_hash,
    receiptContentHash: authority.row.receipt_content_hash,
  });
  if (ephemeralPermit
    && ephemeralPermit.receiptHash === authority.row.receipt_hash
    && ephemeralPermit.receiptContentHash === authority.row.receipt_content_hash
    && ephemeralPermit.publicationGeneration === Number(authority.row.publication_generation)
    && ephemeralPermit.reservationHash === expectedReservationHash
    && SHA256.test(String(ephemeralPermit.sideEffectPermitHash || ''))) {
    return ephemeralPermit.sideEffectPermitHash;
  }
  return journalMirrorPermit(database, { databaseInstanceId, expectedReservationHash });
}

export function reconcileFullResearchQualificationMirror({
  database,
  qualificationReceiptPath,
  databaseInstanceId,
  requirePermit,
  ephemeralPermit = null,
  onlyIfNeeded = false,
  validatedAuthority,
  safeReadMirror,
} = {}) {
  const authority = validatedAuthority(database);
  if (!authority) return null;
  if (onlyIfNeeded) {
    try {
      const mirror = safeReadMirror(qualificationReceiptPath);
      if (hashBytes(mirror.bytes) === authority.row.receipt_content_hash
        && JSON.stringify(mirror.receipt) === JSON.stringify(authority.receipt)) {
        return Object.freeze({
          qualificationReceiptHash: authority.row.receipt_hash,
          receiptContentHash: authority.row.receipt_content_hash,
          publicationGeneration: Number(authority.row.publication_generation),
          sideEffectPermitHash: null,
        });
      }
    } catch { /* a missing or invalid mirror must be repaired from SQLite authority */ }
  }
  const sideEffectPermitHash = authorizedMirrorPermit(database, {
    authority,
    qualificationReceiptPath,
    databaseInstanceId,
    requirePermit,
    ephemeralPermit,
  });
  writeDurableJsonSync(qualificationReceiptPath, authority.receipt, { mode: 0o400 });
  const mirror = safeReadMirror(qualificationReceiptPath);
  const current = validatedAuthority(database);
  if (!current
    || current.row.receipt_hash !== authority.row.receipt_hash
    || current.row.receipt_content_hash !== authority.row.receipt_content_hash
    || Number(current.row.publication_generation)
      !== Number(authority.row.publication_generation)
    || hashBytes(mirror.bytes) !== authority.row.receipt_content_hash
    || JSON.stringify(mirror.receipt) !== JSON.stringify(authority.receipt)) {
    fail('full_research_qualification_pointer_mirror_reconciliation_failed');
  }
  return Object.freeze({
    qualificationReceiptHash: authority.row.receipt_hash,
    receiptContentHash: authority.row.receipt_content_hash,
    publicationGeneration: Number(authority.row.publication_generation),
    sideEffectPermitHash,
  });
}
