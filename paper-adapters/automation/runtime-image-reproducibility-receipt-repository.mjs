import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { validateExternallyFencedSqliteMutationCoordinatorConfiguration } from './externally-fenced-sqlite-mutation-coordinator-configuration.mjs';
import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { writeDurableJsonSync } from '../runtime/durable-json-repository.mjs';
import {
  RUNTIME_IMAGE_REPRODUCIBILITY_PUBLICATION_DATABASE_INSTANCE_ID,
  RUNTIME_IMAGE_REPRODUCIBILITY_PUBLICATION_DATABASE_ROLE,
  RUNTIME_IMAGE_REPRODUCIBILITY_PUBLICATION_OPERATION_ID,
  RUNTIME_IMAGE_REPRODUCIBILITY_PUBLICATION_SCHEMA_CONTRACT_ID,
  RUNTIME_IMAGE_REPRODUCIBILITY_PUBLICATION_WRITER_ID,
  createOfflineRuntimeImageReproducibilityPublicationMutationCoordinator,
} from './runtime-image-reproducibility-publication-mutation-plan.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,255}$/;
const MAXIMUM_BYTES = 32 * 1024 * 1024;

function receiptHashValid(receipt) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)
    || !SHA256.test(String(receipt.runtimeImageReproducibilityReceiptHash || ''))) return false;
  const { runtimeImageReproducibilityReceiptHash, ...payload } = receipt;
  return hashRecord('RuntimeImageReproducibilityReceipt', payload)
    === runtimeImageReproducibilityReceiptHash;
}

function receiptBytes(receipt) {
  return Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`);
}

function safeFile(candidate, { minimumBytes = 1, maximumBytes = MAXIMUM_BYTES } = {}) {
  const requested = path.resolve(candidate);
  const stat = fs.lstatSync(requested);
  const currentUid = typeof process.getuid === 'function' ? process.getuid() : stat.uid;
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== currentUid
    || (stat.mode & 0o022) !== 0 || stat.size < minimumBytes || stat.size > maximumBytes
    || fs.realpathSync(requested) !== requested) {
    throw new Error('runtime_reproducibility_receipt_file_invalid');
  }
  return requested;
}

function canonicalTimestamp(value) {
  const milliseconds = Date.parse(String(value || ''));
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value
    ? milliseconds : null;
}

function ensurePublicationDatabaseFile(candidate) {
  try {
    const descriptor = fs.openSync(
      candidate,
      fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL
        | (fs.constants.O_NOFOLLOW || 0),
      0o600,
    );
    try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    safeFile(candidate, { minimumBytes: 0, maximumBytes: 256 * 1024 * 1024 });
  }
}

function parseReceiptBytes(bytes) {
  let receipt;
  try { receipt = JSON.parse(bytes.toString('utf8')); }
  catch { throw new Error('runtime_reproducibility_receipt_json_invalid'); }
  if (!receiptHashValid(receipt)) throw new Error('runtime_reproducibility_receipt_hash_invalid');
  return Object.freeze(receipt);
}

function safeReadMirror(candidate) {
  const bytes = fs.readFileSync(safeFile(candidate));
  return Object.freeze({ receipt: parseReceiptBytes(bytes), bytes });
}

function ensureSchema(database) {
  database.exec('PRAGMA journal_mode=DELETE;');
  database.exec('PRAGMA synchronous=FULL;');
  database.exec(`CREATE TABLE IF NOT EXISTS runtime_image_reproducibility_receipt (
    singleton_id INTEGER PRIMARY KEY CHECK(singleton_id=1),
    receipt_json TEXT NOT NULL,
    receipt_content_hash TEXT NOT NULL,
    receipt_hash TEXT NOT NULL,
    issued_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    publication_generation INTEGER NOT NULL CHECK(publication_generation>=1),
    updated_at TEXT NOT NULL
  ) STRICT;`);
}

function authorityRow(database) {
  return database.prepare(`SELECT receipt_json,receipt_content_hash,receipt_hash,
    issued_at,expires_at,publication_generation,updated_at
    FROM runtime_image_reproducibility_receipt WHERE singleton_id=1`).get() || null;
}

function validatedAuthority(database) {
  const row = authorityRow(database);
  if (!row) return null;
  const bytes = Buffer.from(String(row.receipt_json));
  const receipt = parseReceiptBytes(bytes);
  if (hashBytes(bytes) !== row.receipt_content_hash
    || receipt.runtimeImageReproducibilityReceiptHash !== row.receipt_hash
    || receipt.issuedAt !== row.issued_at || receipt.expiresAt !== row.expires_at
    || !Number.isSafeInteger(Number(row.publication_generation))
    || Number(row.publication_generation) < 1) {
    throw new Error('runtime_reproducibility_receipt_authority_state_invalid');
  }
  return Object.freeze({ row, bytes, receipt });
}

function mirrorReservationHash({
  databaseInstanceId,
  canonicalPath,
  receiptHash,
  receiptContentHash,
}) {
  return hashRecord('RuntimeImageReproducibilityMirrorSideEffectReservation', {
    version: 1,
    databaseInstanceId,
    receiptPath: canonicalPath,
    receiptHash,
    receiptContentHash,
  });
}

function parseJson(value, code) {
  try { return JSON.parse(String(value)); }
  catch { throw new Error(code); }
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
      WHERE marker.database_instance_id=?
      ORDER BY marker.database_sequence DESC LIMIT 1`).get(databaseInstanceId);
  } catch {
    throw new Error('runtime_reproducibility_receipt_side_effect_permit_required');
  }
  const reserveRequest = parseJson(
    row?.reserve_request_json,
    'runtime_reproducibility_receipt_side_effect_reservation_invalid',
  );
  const finalization = parseJson(
    row?.finalization_receipt_json,
    'runtime_reproducibility_receipt_side_effect_permit_invalid',
  );
  if (row?.database_role !== RUNTIME_IMAGE_REPRODUCIBILITY_PUBLICATION_DATABASE_ROLE
    || row?.database_instance_id !== databaseInstanceId
    || row?.operation_id !== RUNTIME_IMAGE_REPRODUCIBILITY_PUBLICATION_OPERATION_ID
    || !Array.isArray(reserveRequest.sideEffectReservationHashes)
    || reserveRequest.sideEffectReservationHashes.length !== 1
    || reserveRequest.sideEffectReservationHashes[0] !== expectedReservationHash
    || finalization.reservationId !== row.reservation_id
    || finalization.sideEffectPermitHash !== row.side_effect_permit_hash
    || !SHA256.test(String(row.side_effect_permit_hash || ''))) {
    throw new Error('runtime_reproducibility_receipt_side_effect_permit_invalid');
  }
  return row.side_effect_permit_hash;
}

function authorizedMirrorPermit(database, {
  authority,
  canonicalPath,
  databaseInstanceId,
  requirePermit,
  ephemeralPermit = null,
} = {}) {
  if (!requirePermit) return null;
  const expectedReservationHash = mirrorReservationHash({
    databaseInstanceId,
    canonicalPath,
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

function reconcileMirrorWithDatabase(database, canonicalPath, {
  databaseInstanceId,
  requirePermit,
  ephemeralPermit = null,
  onlyIfNeeded = false,
} = {}) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const authority = validatedAuthority(database);
    if (!authority) return null;
    if (onlyIfNeeded) {
      try {
        const mirror = safeReadMirror(canonicalPath);
        if (hashBytes(mirror.bytes) === authority.row.receipt_content_hash
          && JSON.stringify(mirror.receipt) === JSON.stringify(authority.receipt)) {
          return Object.freeze({
            receiptHash: authority.row.receipt_hash,
            receiptContentHash: authority.row.receipt_content_hash,
            publicationGeneration: Number(authority.row.publication_generation),
            sideEffectPermitHash: null,
          });
        }
      } catch { /* a missing or invalid mirror must be repaired from SQLite authority */ }
    }
    const sideEffectPermitHash = authorizedMirrorPermit(database, {
      authority,
      canonicalPath,
      databaseInstanceId,
      requirePermit,
      ephemeralPermit,
    });
    writeDurableJsonSync(canonicalPath, authority.receipt, { mode: 0o400 });
    const mirror = safeReadMirror(canonicalPath);
    const current = validatedAuthority(database);
    const authorityRemainedCurrent = current
      && current.row.receipt_hash === authority.row.receipt_hash
      && current.row.receipt_content_hash === authority.row.receipt_content_hash
      && Number(current.row.publication_generation)
        === Number(authority.row.publication_generation);
    if (!authorityRemainedCurrent) continue;
    if (hashBytes(mirror.bytes) !== authority.row.receipt_content_hash
      || JSON.stringify(mirror.receipt) !== JSON.stringify(authority.receipt)) {
      throw new Error('runtime_reproducibility_receipt_mirror_reconciliation_failed');
    }
    return Object.freeze({
      receiptHash: authority.row.receipt_hash,
      receiptContentHash: authority.row.receipt_content_hash,
      publicationGeneration: Number(authority.row.publication_generation),
      sideEffectPermitHash,
    });
  }
  throw new Error('runtime_reproducibility_receipt_mirror_reconciliation_raced');
}

function monotonicSuccessor(current, receipt) {
  if (!current) return true;
  const currentIssuedAt = Date.parse(current.issued_at);
  const currentExpiresAt = Date.parse(current.expires_at);
  const nextIssuedAt = Date.parse(receipt.issuedAt);
  const nextExpiresAt = Date.parse(receipt.expiresAt);
  if (nextIssuedAt === currentIssuedAt
    && receipt.runtimeImageReproducibilityReceiptHash === current.receipt_hash) return true;
  return Number.isFinite(currentIssuedAt) && Number.isFinite(currentExpiresAt)
    && Number.isFinite(nextIssuedAt) && Number.isFinite(nextExpiresAt)
    && nextIssuedAt > currentIssuedAt && nextExpiresAt > currentExpiresAt;
}

export function runtimeImageReproducibilityReceiptPath({ runtimeRoot } = {}) {
  if (!runtimeRoot) throw new Error('runtime_reproducibility_runtime_root_required');
  return path.join(
    path.resolve(runtimeRoot),
    'autonomous-research',
    'runtime-image-reproducibility',
    'receipt.json',
  );
}

export function createRuntimeImageReproducibilityReceiptRepository({
  runtimeRoot,
  receiptPath = null,
  receiptVerifier = null,
  busyTimeoutMs = 10_000,
  offlineProvision = true,
  mutationCoordinator = null,
  databaseInstanceId = RUNTIME_IMAGE_REPRODUCIBILITY_PUBLICATION_DATABASE_INSTANCE_ID,
  schemaContractId = RUNTIME_IMAGE_REPRODUCIBILITY_PUBLICATION_SCHEMA_CONTRACT_ID,
  writerId = RUNTIME_IMAGE_REPRODUCIBILITY_PUBLICATION_WRITER_ID,
  requireExternallyFencedMutations = false,
} = {}) {
  const boundedBusyTimeoutMs = Number(busyTimeoutMs);
  if (!Number.isSafeInteger(boundedBusyTimeoutMs)
    || boundedBusyTimeoutMs < 1 || boundedBusyTimeoutMs > 60_000
    || typeof offlineProvision !== 'boolean'
    || typeof requireExternallyFencedMutations !== 'boolean'
    || !SAFE_ID.test(String(databaseInstanceId || ''))
    || !SAFE_ID.test(String(schemaContractId || ''))
    || !SAFE_ID.test(String(writerId || ''))) {
    throw new Error('runtime_reproducibility_receipt_busy_timeout_invalid');
  }
  let coordinator = validateExternallyFencedSqliteMutationCoordinatorConfiguration({
    mutationCoordinator,
    requireExternallyFencedMutations,
    offlineProvision,
    databaseRole: RUNTIME_IMAGE_REPRODUCIBILITY_PUBLICATION_DATABASE_ROLE,
    requiredErrorCode:
      'runtime_reproducibility_publication_external_mutation_coordinator_required',
  });
  coordinator ||= createOfflineRuntimeImageReproducibilityPublicationMutationCoordinator({
    databaseInstanceId,
    schemaContractId,
    writerId,
  });
  const canonicalPath = receiptPath
    ? path.resolve(receiptPath) : runtimeImageReproducibilityReceiptPath({ runtimeRoot });
  const databasePath = `${canonicalPath}.publication.sqlite`;
  let lastFinalizedPublicationPermit = null;

  function provisionDatabase() {
    if (!offlineProvision) {
      throw new Error('runtime_reproducibility_publication_offline_provisioning_required');
    }
    fs.mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
    ensurePublicationDatabaseFile(databasePath);
    const database = new DatabaseSync(databasePath);
    try {
      database.exec(`PRAGMA busy_timeout=${boundedBusyTimeoutMs};`);
      ensureSchema(database);
      fs.chmodSync(databasePath, 0o600);
    } finally { database.close(); }
    return databasePath;
  }

  function openWritableDatabase() {
    if (offlineProvision) provisionDatabase();
    else if (!fs.existsSync(databasePath)) {
      throw new Error('runtime_reproducibility_publication_offline_provisioning_required');
    }
    safeFile(databasePath, { maximumBytes: 256 * 1024 * 1024 });
    const database = new DatabaseSync(databasePath);
    database.exec(`PRAGMA busy_timeout=${boundedBusyTimeoutMs};`);
    return database;
  }

  function committedMirrorPending(error, mutationReceipt) {
    const wrapped = new Error(
      'runtime_reproducibility_receipt_committed_mirror_pending',
      { cause: error },
    );
    wrapped.committed = true;
    wrapped.retryableSideEffectOnly = true;
    wrapped.reservationId = mutationReceipt?.reservationId || null;
    wrapped.sideEffectPermitHash = mutationReceipt?.sideEffectPermitHash || null;
    return wrapped;
  }

  function validatedRecoveryReceipt(receipt) {
    if (receipt?.version !== 1
      || receipt.kind !== 'ExternallyFencedSqliteMutationRecoveryReceipt'
      || receipt.status !== 'externally_fenced_sqlite_mutation_recovery_complete'
      || !Array.isArray(receipt.recoveredReservationIds)) {
      throw new Error('runtime_reproducibility_publication_recovery_receipt_invalid');
    }
    return receipt;
  }

  function read() {
    if (!fs.existsSync(databasePath)) return null;
    safeFile(databasePath, { maximumBytes: 256 * 1024 * 1024 });
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const authority = validatedAuthority(database);
      if (!authority) return null;
      let mirror;
      try { mirror = safeReadMirror(canonicalPath); }
      catch { throw new Error('runtime_reproducibility_receipt_mirror_drift'); }
      if (hashBytes(mirror.bytes) !== authority.row.receipt_content_hash
        || JSON.stringify(mirror.receipt) !== JSON.stringify(authority.receipt)) {
        throw new Error('runtime_reproducibility_receipt_mirror_drift');
      }
      return Object.freeze({
        receipt: authority.receipt,
        receiptPath: canonicalPath,
        databasePath,
        contentHash: authority.row.receipt_content_hash,
        publicationGeneration: Number(authority.row.publication_generation),
      });
    } finally { database.close(); }
  }

  return Object.freeze({
    version: 2,
    kind: 'RuntimeImageReproducibilityReceiptRepository',
    receiptPath: canonicalPath,
    databasePath,
    durable: true,
    sqliteAuthorityAtomicPublication: true,
    derivedJsonMirror: true,
    crossResourceAtomicPublicationClaimed: false,
    derivedJsonMirrorCrashRecoverable: true,
    sqliteMonotonicCompareAndSwap: true,
    offlineProvisioningEnabled: offlineProvision,
    externallyFencedMutations: coordinator.implemented === true,
    externallyFencedMutationsRequired: requireExternallyFencedMutations,
    databaseInstanceId,
    schemaContractId,
    writerId,
    read,
    provision: provisionDatabase,
    recoverPendingPublication() {
      if (!requireExternallyFencedMutations) {
        throw new Error(
          'runtime_reproducibility_publication_external_mutation_coordinator_required',
        );
      }
      const database = openWritableDatabase();
      try {
        const recovery = validatedRecoveryReceipt(
          coordinator.recoverPendingMutations({ database }),
        );
        const mirror = reconcileMirrorWithDatabase(database, canonicalPath, {
          databaseInstanceId,
          requirePermit: true,
          onlyIfNeeded: true,
        });
        return Object.freeze({
          version: 1,
          kind: 'RuntimeImageReproducibilityPendingPublicationRecovery',
          status: 'runtime_image_reproducibility_pending_publication_recovered',
          recoveredReservationIds: Object.freeze([
            ...recovery.recoveredReservationIds,
          ]),
          mirror,
        });
      } finally { database.close(); }
    },
    reconcileMirror() {
      if (!fs.existsSync(databasePath)) return null;
      safeFile(databasePath, { maximumBytes: 256 * 1024 * 1024 });
      const database = new DatabaseSync(databasePath, { readOnly: true });
      try {
        return reconcileMirrorWithDatabase(database, canonicalPath, {
          databaseInstanceId,
          requirePermit: requireExternallyFencedMutations,
          ephemeralPermit: lastFinalizedPublicationPermit,
        });
      } finally { database.close(); }
    },
    publish({ receipt, now = new Date() } = {}) {
      const nowMs = now instanceof Date ? now.getTime() : Date.parse(String(now));
      if (typeof receiptVerifier !== 'function') {
        throw new Error('runtime_reproducibility_receipt_verifier_required');
      }
      if (!receiptHashValid(receipt) || !Number.isFinite(nowMs)
        || canonicalTimestamp(receipt.issuedAt) === null
        || canonicalTimestamp(receipt.expiresAt) === null
        || canonicalTimestamp(receipt.expiresAt) <= canonicalTimestamp(receipt.issuedAt)
        || nowMs < canonicalTimestamp(receipt.issuedAt)
        || nowMs >= canonicalTimestamp(receipt.expiresAt)) {
        throw new Error('runtime_reproducibility_verified_receipt_required');
      }
      let inspection;
      try { inspection = receiptVerifier(receipt, now); }
      catch { inspection = null; }
      if (inspection?.ready !== true || inspection?.receiptAccepted !== true
        || inspection?.receiptHash !== receipt.runtimeImageReproducibilityReceiptHash) {
        throw new Error('runtime_reproducibility_verified_receipt_required');
      }
      const bytes = receiptBytes(receipt);
      const contentHash = hashBytes(bytes);
      const database = openWritableDatabase();
      let mutationReceipt;
      try {
        const reservationHash = mirrorReservationHash({
          databaseInstanceId,
          canonicalPath,
          receiptHash: receipt.runtimeImageReproducibilityReceiptHash,
          receiptContentHash: contentHash,
        });
        mutationReceipt = coordinator.executeMutation({
          database,
          databaseRole: 'runtime-reproducibility-publication',
          databaseInstanceId,
          schemaContractId,
          writerId,
          operationId:
            'runtime-reproducibility-publication.receipt-repository.publish.v1',
          authorizationReceiptHashes: [],
          sideEffectReservationHashes: [reservationHash],
          mutate(transaction) {
            const current = transaction.get('runtime-publication.current.get.v1') || null;
            if (!monotonicSuccessor(current, receipt)) {
              throw new Error('runtime_reproducibility_receipt_monotonic_cas_rejected');
            }
            const publicationGeneration = current
              ? Number(current.publication_generation) + 1 : 1;
            transaction.run(
              'runtime-publication.receipt.upsert.v1',
              bytes.toString('utf8'),
              contentHash,
              receipt.runtimeImageReproducibilityReceiptHash,
              receipt.issuedAt,
              receipt.expiresAt,
              publicationGeneration,
              new Date(nowMs).toISOString(),
            );
            return Object.freeze({
              publicationGeneration,
              receiptHash: receipt.runtimeImageReproducibilityReceiptHash,
              receiptContentHash: contentHash,
              reservationHash,
            });
          },
        });
        const value = mutationReceipt?.value;
        if (!value
          || value.receiptHash !== receipt.runtimeImageReproducibilityReceiptHash
          || value.receiptContentHash !== contentHash
          || value.reservationHash !== reservationHash
          || !Number.isSafeInteger(value.publicationGeneration)
          || value.publicationGeneration < 1) {
          throw committedMirrorPending(
            new Error('runtime_reproducibility_publication_mutation_receipt_invalid'),
            mutationReceipt,
          );
        }
        if (requireExternallyFencedMutations
          && (mutationReceipt.status !== 'externally_fenced_sqlite_mutation_finalized'
            || !SHA256.test(String(mutationReceipt.sideEffectPermitHash || '')))) {
          throw committedMirrorPending(
            new Error('runtime_reproducibility_receipt_side_effect_permit_required'),
            mutationReceipt,
          );
        }
        lastFinalizedPublicationPermit = Object.freeze({
          ...value,
          sideEffectPermitHash: mutationReceipt.sideEffectPermitHash,
        });
        let mirrorReconciliation;
        try {
          mirrorReconciliation = reconcileMirrorWithDatabase(database, canonicalPath, {
            databaseInstanceId,
            requirePermit: requireExternallyFencedMutations,
            ephemeralPermit: lastFinalizedPublicationPermit,
          });
        } catch (error) {
          throw committedMirrorPending(error, mutationReceipt);
        }
        const payload = Object.freeze({
          version: 2,
          kind: 'RuntimeImageReproducibilityReceiptPublication',
          status: 'runtime_image_reproducibility_receipt_published',
          receiptPath: canonicalPath,
          publicationDatabasePath: databasePath,
          publicationGeneration: value.publicationGeneration,
          receiptHash: receipt.runtimeImageReproducibilityReceiptHash,
          receiptContentHash: contentHash,
          issuedAt: receipt.issuedAt,
          expiresAt: receipt.expiresAt,
          sqliteAuthorityAtomicPublication: true,
          sqliteAuthorityDurablePublication: true,
          sqliteMonotonicCompareAndSwap: true,
          derivedJsonMirror: true,
          derivedJsonMirrorCrashRecoverable: true,
          crossResourceAtomicPublicationClaimed: false,
          mirrorSideEffectPermitHash:
            mirrorReconciliation?.sideEffectPermitHash || null,
          mirrorReconciledToReceiptHash: mirrorReconciliation?.receiptHash || null,
          receiptRemainedCurrentAtMirrorReconciliation:
            mirrorReconciliation?.receiptHash === receipt.runtimeImageReproducibilityReceiptHash,
          currentCodeReleaseAndInputClosureDriftMustRevalidate: true,
          externalActionPerformed: false,
        });
        return Object.freeze({
          ...payload,
          runtimeImageReproducibilityReceiptPublicationHash: hashRecord(
            'RuntimeImageReproducibilityReceiptPublication',
            payload,
          ),
        });
      } finally { database.close(); }
    },
  });
}
