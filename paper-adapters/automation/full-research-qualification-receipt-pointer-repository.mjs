import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { validateExternallyFencedSqliteMutationCoordinatorConfiguration } from './externally-fenced-sqlite-mutation-coordinator-configuration.mjs';
import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  fullResearchQualificationCommittedMirrorPending,
  fullResearchQualificationMirrorReservationHash,
  reconcileFullResearchQualificationMirror,
} from './full-research-qualification-publication-mirror.mjs';
import {
  FULL_RESEARCH_QUALIFICATION_PUBLICATION_DATABASE_INSTANCE_ID,
  FULL_RESEARCH_QUALIFICATION_PUBLICATION_DATABASE_ROLE,
  FULL_RESEARCH_QUALIFICATION_PUBLICATION_SCHEMA_CONTRACT_ID,
  FULL_RESEARCH_QUALIFICATION_PUBLICATION_WRITER_ID,
  createOfflineFullResearchQualificationPublicationMutationCoordinator,
} from './full-research-qualification-publication-mutation-plan.mjs';
import {
  MAXIMUM_AGE_MS,
  SAFE_ID,
  SHA256,
  ensureDatabaseFile,
  ensureSchema,
  fencedLease,
  leaseIdentity,
  monotonicSuccessor,
  receiptBytes,
  receiptHashValid,
  receiptTimeWindowValid,
  safeFile,
  safeReadMirror,
  validatedAuthority,
} from './full-research-qualification-receipt-pointer-repository-support.mjs';

const POINTER_FILE = 'qualification-receipt.json';

export function fullResearchQualificationReceiptPointerPath({ runtimeRoot } = {}) {
  if (!runtimeRoot) throw new Error('full_research_qualification_pointer_runtime_root_required');
  return path.join(
    path.resolve(runtimeRoot),
    'autonomous-research',
    'qualification',
    POINTER_FILE,
  );
}

export function createFullResearchQualificationReceiptPointerRepository({
  runtimeRoot,
  busyTimeoutMs = 10_000,
  afterAuthorityCommit = null,
  offlineProvision = true,
  mutationCoordinator = null,
  databaseInstanceId = FULL_RESEARCH_QUALIFICATION_PUBLICATION_DATABASE_INSTANCE_ID,
  schemaContractId = FULL_RESEARCH_QUALIFICATION_PUBLICATION_SCHEMA_CONTRACT_ID,
  writerId = FULL_RESEARCH_QUALIFICATION_PUBLICATION_WRITER_ID,
  requireExternallyFencedMutations = false,
} = {}) {
  const qualificationReceiptPath = fullResearchQualificationReceiptPointerPath({ runtimeRoot });
  const databasePath = `${qualificationReceiptPath}.publication.sqlite`;
  const timeout = Number(busyTimeoutMs);
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 60_000
    || typeof offlineProvision !== 'boolean'
    || typeof requireExternallyFencedMutations !== 'boolean'
    || (afterAuthorityCommit !== null && typeof afterAuthorityCommit !== 'function')
    || !SAFE_ID.test(String(databaseInstanceId || ''))
    || !SAFE_ID.test(String(schemaContractId || ''))
    || !SAFE_ID.test(String(writerId || ''))) {
    throw new Error('full_research_qualification_pointer_busy_timeout_invalid');
  }
  let coordinator = validateExternallyFencedSqliteMutationCoordinatorConfiguration({
    mutationCoordinator,
    requireExternallyFencedMutations,
    offlineProvision,
    databaseRole: FULL_RESEARCH_QUALIFICATION_PUBLICATION_DATABASE_ROLE,
    requiredErrorCode:
      'full_research_qualification_publication_external_mutation_coordinator_required',
  });
  coordinator ||= createOfflineFullResearchQualificationPublicationMutationCoordinator({
    databaseInstanceId,
    schemaContractId,
    writerId,
  });

  function provisionDatabase() {
    if (!offlineProvision) {
      throw new Error('full_research_qualification_publication_offline_provisioning_required');
    }
    ensureDatabaseFile(databasePath);
    const database = new DatabaseSync(databasePath);
    try {
      database.exec(`PRAGMA busy_timeout=${timeout};`);
      ensureSchema(database);
      fs.chmodSync(databasePath, 0o600);
    } finally { database.close(); }
    return databasePath;
  }

  function writableDatabase() {
    if (offlineProvision) provisionDatabase();
    else if (!fs.existsSync(databasePath)) {
      throw new Error('full_research_qualification_publication_offline_provisioning_required');
    }
    safeFile(databasePath, { maximumBytes: 256 * 1024 * 1024 });
    const database = new DatabaseSync(databasePath);
    database.exec(`PRAGMA busy_timeout=${timeout};`);
    return database;
  }

  function mutationValue(receipt) {
    if (!receipt || !Object.prototype.hasOwnProperty.call(receipt, 'value')) {
      throw new Error('full_research_qualification_publication_mutation_receipt_invalid');
    }
    return receipt.value;
  }

  function validatedRecoveryReceipt(receipt) {
    if (receipt?.version !== 1
      || receipt.kind !== 'ExternallyFencedSqliteMutationRecoveryReceipt'
      || receipt.status !== 'externally_fenced_sqlite_mutation_recovery_complete'
      || !Array.isArray(receipt.recoveredReservationIds)) {
      throw new Error('full_research_qualification_publication_recovery_receipt_invalid');
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
      try { mirror = safeReadMirror(qualificationReceiptPath); }
      catch { throw new Error('full_research_qualification_pointer_mirror_drift'); }
      if (hashBytes(mirror.bytes) !== authority.row.receipt_content_hash
        || JSON.stringify(mirror.receipt) !== JSON.stringify(authority.receipt)) {
        throw new Error('full_research_qualification_pointer_mirror_drift');
      }
      return Object.freeze({
        receipt: authority.receipt,
        qualificationReceiptPath,
        databasePath,
        contentHash: authority.row.receipt_content_hash,
        publicationGeneration: Number(authority.row.publication_generation),
        qualificationStateHash: authority.row.qualification_state_hash,
        qualificationStateGeneration: Number(authority.row.qualification_state_generation),
      });
    } finally { database.close(); }
  }

  return Object.freeze({
    version: 2,
    kind: 'FullResearchQualificationReceiptPointerRepository',
    durable: true,
    atomicPublication: true,
    sqliteAuthorityAtomicPublication: true,
    sqliteMonotonicCompareAndSwap: true,
    derivedJsonMirror: true,
    derivedJsonMirrorCrashRecoverable: true,
    statusReadOnly: true,
    crossResourceAtomicPublicationClaimed: false,
    offlineProvisioningEnabled: offlineProvision,
    externallyFencedMutations: coordinator.implemented === true,
    externallyFencedMutationsRequired: requireExternallyFencedMutations,
    databaseInstanceId,
    schemaContractId,
    writerId,
    qualificationReceiptPath,
    databasePath,
    read,
    provision: provisionDatabase,
    recoverPendingPublication() {
      if (!requireExternallyFencedMutations) {
        throw new Error(
          'full_research_qualification_publication_external_mutation_coordinator_required',
        );
      }
      const database = writableDatabase();
      try {
        const recovery = validatedRecoveryReceipt(
          coordinator.recoverPendingMutations({ database }),
        );
        const mirror = reconcileFullResearchQualificationMirror({
          database,
          qualificationReceiptPath,
          databaseInstanceId,
          requirePermit: true,
          onlyIfNeeded: true,
          validatedAuthority,
          safeReadMirror,
        });
        return Object.freeze({
          version: 1,
          kind: 'FullResearchQualificationPendingPublicationRecovery',
          status: 'full_research_qualification_pending_publication_recovered',
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
        return reconcileFullResearchQualificationMirror({
          database,
          qualificationReceiptPath,
          databaseInstanceId,
          requirePermit: requireExternallyFencedMutations,
          validatedAuthority,
          safeReadMirror,
        });
      } finally { database.close(); }
    },
    tryAcquirePublicationLease({ ownerId, leaseMs = 5 * 60 * 1000, now = new Date() } = {}) {
      if (!SAFE_ID.test(String(ownerId || ''))) {
        throw new Error('full_research_qualification_pointer_owner_invalid');
      }
      const nowMs = now instanceof Date ? now.getTime() : Date.parse(String(now));
      const duration = Number(leaseMs);
      if (!Number.isFinite(nowMs) || !Number.isSafeInteger(duration)
        || duration < 1000 || duration > 10 * 60 * 1000) {
        throw new Error('full_research_qualification_pointer_lease_invalid');
      }
      const database = writableDatabase();
      try {
        return mutationValue(coordinator.executeMutation({
          database,
          databaseRole: 'full-research-qualification-publication',
          databaseInstanceId,
          schemaContractId,
          writerId,
          operationId:
            'full-research-qualification-publication.receipt-pointer-repository.tryAcquirePublicationLease.v1',
          authorizationReceiptHashes: [],
          sideEffectReservationHashes: [],
          mutate(transaction) {
            const current = transaction.get(
              'qualification-publication.acquire.lease-current.get.v1',
            );
            if (!current) {
              throw new Error(
                'full_research_qualification_publication_offline_provisioning_required',
              );
            }
            const activeUntil = Date.parse(current.lease_expires_at || '');
            if (Number.isFinite(activeUntil) && activeUntil > nowMs) return null;
            const recovered = Boolean(current.lease_expires_at);
            const nextLease = Object.freeze({
              ownerId: String(ownerId),
              leaseToken: `qualification-pointer:${crypto.randomUUID()}`,
              leaseGeneration: Number(current.lease_generation) + 1,
              expiresAt: new Date(nowMs + duration).toISOString(),
            });
            const updated = transaction.run(
              'qualification-publication.acquire.lease-update.apply.v1',
              nextLease.ownerId,
              nextLease.leaseToken,
              nextLease.leaseGeneration,
              nextLease.expiresAt,
              recovered ? 1 : 0,
              new Date(nowMs).toISOString(),
              current.lease_generation,
            );
            if (Number(updated.changes) !== 1) {
              throw new Error('full_research_qualification_pointer_lease_fence_conflict');
            }
            return nextLease;
          },
        }));
      } finally { database.close(); }
    },
    renewPublicationLease({ lease, leaseMs = 5 * 60 * 1000, now = new Date() } = {}) {
      const identity = leaseIdentity(lease);
      const nowMs = now instanceof Date ? now.getTime() : Date.parse(String(now));
      const duration = Number(leaseMs);
      if (!Number.isFinite(nowMs) || !Number.isSafeInteger(duration)
        || duration < 1000 || duration > 10 * 60 * 1000) {
        throw new Error('full_research_qualification_pointer_lease_invalid');
      }
      const database = writableDatabase();
      try {
        const expiresAt = new Date(nowMs + duration).toISOString();
        return mutationValue(coordinator.executeMutation({
          database,
          databaseRole: 'full-research-qualification-publication',
          databaseInstanceId,
          schemaContractId,
          writerId,
          operationId:
            'full-research-qualification-publication.receipt-pointer-repository.renewPublicationLease.v1',
          authorizationReceiptHashes: [],
          sideEffectReservationHashes: [],
          mutate(transaction) {
            const updated = transaction.run(
              'qualification-publication.renew.lease-update.apply.v1',
              expiresAt,
              new Date(nowMs).toISOString(),
              identity.ownerId,
              identity.leaseToken,
              identity.leaseGeneration,
              new Date(nowMs).toISOString(),
            );
            return Number(updated.changes) === 1
              ? Object.freeze({ ...identity, expiresAt }) : null;
          },
        }));
      } finally { database.close(); }
    },
    releasePublicationLease({ lease, now = new Date() } = {}) {
      const identity = leaseIdentity(lease);
      const nowMs = now instanceof Date ? now.getTime() : Date.parse(String(now));
      if (!Number.isFinite(nowMs)) throw new Error('full_research_qualification_pointer_clock_invalid');
      const database = writableDatabase();
      try {
        return mutationValue(coordinator.executeMutation({
          database,
          databaseRole: 'full-research-qualification-publication',
          databaseInstanceId,
          schemaContractId,
          writerId,
          operationId:
            'full-research-qualification-publication.receipt-pointer-repository.releasePublicationLease.v1',
          authorizationReceiptHashes: [],
          sideEffectReservationHashes: [],
          mutate(transaction) {
            const result = transaction.run(
              'qualification-publication.release.lease-update.apply.v1',
              new Date(nowMs).toISOString(),
              identity.ownerId,
              identity.leaseToken,
              identity.leaseGeneration,
            );
            return Number(result.changes) === 1;
          },
        }));
      } finally { database.close(); }
    },
    publish({
      lease,
      receipt,
      qualificationStateHash,
      qualificationStateGeneration,
      expectedRuntimeReceiptHash,
      publisherFence,
      now = new Date(),
    } = {}) {
      const nowMs = now instanceof Date ? now.getTime() : Date.parse(String(now));
      if (!receiptHashValid(receipt)) {
        throw new Error('full_research_qualification_pointer_receipt_hash_invalid');
      }
      if (!receiptTimeWindowValid(receipt, now)) {
        throw new Error('full_research_qualification_pointer_receipt_expired');
      }
      if (!SHA256.test(String(qualificationStateHash || ''))
        || !Number.isSafeInteger(Number(qualificationStateGeneration))
        || Number(qualificationStateGeneration) < 1
        || !SHA256.test(String(expectedRuntimeReceiptHash || ''))
        || receipt.runtimeImageReproducibilityReceiptHash !== expectedRuntimeReceiptHash
        || !SAFE_ID.test(String(publisherFence?.scope || ''))
        || !SAFE_ID.test(String(publisherFence?.ownerId || ''))
        || !Number.isSafeInteger(Number(publisherFence?.leaseGeneration))
        || Number(publisherFence.leaseGeneration) < 1) {
        throw new Error('full_research_qualification_pointer_verified_binding_required');
      }
      const bytes = receiptBytes(receipt);
      const contentHash = hashBytes(bytes);
      const reservationHash = fullResearchQualificationMirrorReservationHash({
        databaseInstanceId,
        qualificationReceiptPath,
        receiptHash: receipt.fullResearchQualificationReceiptHash,
        receiptContentHash: contentHash,
      });
      const database = writableDatabase();
      try {
        const mutationReceipt = coordinator.executeMutation({
          database,
          databaseRole: 'full-research-qualification-publication',
          databaseInstanceId,
          schemaContractId,
          writerId,
          operationId:
            'full-research-qualification-publication.receipt-pointer-repository.publish.v1',
          authorizationReceiptHashes: [...new Set([
            qualificationStateHash,
            receipt.fullResearchQualificationReceiptHash,
            receipt.runtimeImageReproducibilityReceiptHash,
          ])].sort(),
          sideEffectReservationHashes: [reservationHash],
          mutate(transaction) {
            const identity = fencedLease(transaction.get(
              'qualification-publication.publish.lease-assert.get.v1',
            ), lease, nowMs);
            const current = transaction.get(
              'qualification-publication.publish.authority-current.get.v1',
            ) || null;
            if (!monotonicSuccessor(current, receipt, qualificationStateGeneration)) {
              throw new Error('full_research_qualification_pointer_monotonic_cas_rejected');
            }
            const same = current?.receipt_hash
              === receipt.fullResearchQualificationReceiptHash;
            const generation = same
              ? Number(current.publication_generation)
              : Number(current?.publication_generation || 0) + 1;
            if (same && (current.receipt_content_hash !== contentHash
              || current.runtime_receipt_hash
                !== receipt.runtimeImageReproducibilityReceiptHash
              || current.qualification_state_hash !== qualificationStateHash
              || Number(current.qualification_state_generation)
                !== Number(qualificationStateGeneration))) {
              throw new Error('full_research_qualification_pointer_monotonic_cas_rejected');
            }
            if (!same) {
              transaction.run(
                'qualification-publication.publish.authority-upsert.apply.v1',
                bytes.toString('utf8'),
                contentHash,
                receipt.fullResearchQualificationReceiptHash,
                receipt.runtimeImageReproducibilityReceiptHash,
                qualificationStateHash,
                Number(qualificationStateGeneration),
                publisherFence.scope,
                publisherFence.ownerId,
                Number(publisherFence.leaseGeneration),
                receipt.issuedAt,
                receipt.expiresAt,
                generation,
                new Date(nowMs).toISOString(),
              );
            }
            fencedLease(transaction.get(
              'qualification-publication.publish.lease-assert.get.v1',
            ), identity, nowMs);
            return Object.freeze({
              authorityChanged: !same,
              pointerLeaseGeneration: identity.leaseGeneration,
              publicationGeneration: generation,
              receiptHash: receipt.fullResearchQualificationReceiptHash,
              receiptContentHash: contentHash,
              reservationHash,
            });
          },
        });
        const value = mutationReceipt?.value;
        if (!value
          || value.receiptHash !== receipt.fullResearchQualificationReceiptHash
          || value.receiptContentHash !== contentHash
          || value.reservationHash !== reservationHash
          || typeof value.authorityChanged !== 'boolean'
          || !Number.isSafeInteger(value.pointerLeaseGeneration)
          || value.pointerLeaseGeneration < 1
          || !Number.isSafeInteger(value.publicationGeneration)
          || value.publicationGeneration < 1) {
          throw fullResearchQualificationCommittedMirrorPending(
            new Error('full_research_qualification_publication_mutation_receipt_invalid'),
            mutationReceipt,
          );
        }
        if (requireExternallyFencedMutations && value.authorityChanged
          && (mutationReceipt.status !== 'externally_fenced_sqlite_mutation_finalized'
            || !SHA256.test(String(mutationReceipt.sideEffectPermitHash || '')))) {
          throw fullResearchQualificationCommittedMirrorPending(
            new Error('full_research_qualification_pointer_side_effect_permit_required'),
            mutationReceipt,
          );
        }
        let mirror;
        try {
          afterAuthorityCommit?.({ receipt, generation: value.publicationGeneration });
          mirror = reconcileFullResearchQualificationMirror({
            database,
            qualificationReceiptPath,
            databaseInstanceId,
            requirePermit: requireExternallyFencedMutations,
            ephemeralPermit: mutationReceipt.sideEffectPermitHash ? {
              ...value,
              sideEffectPermitHash: mutationReceipt.sideEffectPermitHash,
            } : null,
            validatedAuthority,
            safeReadMirror,
          });
        } catch (error) {
          throw fullResearchQualificationCommittedMirrorPending(error, mutationReceipt);
        }
        const payload = Object.freeze({
          version: 2,
          kind: 'FullResearchQualificationReceiptPointerPublication',
          status: 'full_research_qualification_receipt_pointer_published',
          environmentVariable: 'HEPTA_FULL_RESEARCH_QUALIFICATION_RECEIPT',
          qualificationReceiptPath,
          publicationDatabasePath: databasePath,
          qualificationReceiptHash: receipt.fullResearchQualificationReceiptHash,
          receiptContentHash: contentHash,
          runtimeImageReproducibilityReceiptHash:
            receipt.runtimeImageReproducibilityReceiptHash,
          qualificationStateHash,
          qualificationStateGeneration: Number(qualificationStateGeneration),
          publisherScope: publisherFence.scope,
          publisherOwnerId: publisherFence.ownerId,
          publisherLeaseGeneration: Number(publisherFence.leaseGeneration),
          pointerLeaseGeneration: value.pointerLeaseGeneration,
          publicationGeneration: value.publicationGeneration,
          issuedAt: receipt.issuedAt,
          expiresAt: receipt.expiresAt,
          maximumReceiptAgeMs: MAXIMUM_AGE_MS,
          atomicPublication: true,
          durablePublication: true,
          sqliteAuthorityAtomicPublication: true,
          sqliteMonotonicCompareAndSwap: true,
          derivedJsonMirror: true,
          derivedJsonMirrorCrashRecoverable: true,
          crossResourceAtomicPublicationClaimed: false,
          mirrorSideEffectPermitHash: mirror?.sideEffectPermitHash || null,
          mirrorReconciledToReceiptHash: mirror?.qualificationReceiptHash || null,
          receiptRemainedCurrentAtMirrorReconciliation:
            mirror?.qualificationReceiptHash === receipt.fullResearchQualificationReceiptHash,
          codeAndReleaseDriftMustRevalidate: true,
          externalActionPerformed: false,
        });
        return Object.freeze({
          ...payload,
          fullResearchQualificationReceiptPointerPublicationHash: hashRecord(
            'FullResearchQualificationReceiptPointerPublication',
            payload,
          ),
        });
      } finally { database.close(); }
    },
  });
}
