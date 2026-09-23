import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  validateAutonomousExternalQualificationState,
} from '../../paper-domain/automation/autonomous-external-qualification-state-contract.mjs';
import {
  validateExternallyFencedSqliteMutationCoordinatorConfiguration,
} from './externally-fenced-sqlite-mutation-coordinator-configuration.mjs';
import {
  createAutonomousResearchQualificationAttemptInfrastructureOperations,
  externalQualificationAttemptIdempotencyKey as attemptIdempotencyKey,
  externalQualificationAttemptLeaseTokenHash as attemptLeaseTokenHash,
  externalQualificationAttemptReservationPrior as attemptReservationPrior,
} from './autonomous-research-qualification-attempt-infrastructure-operations.mjs';
import {
  AUTONOMOUS_RESEARCH_EXTERNAL_QUALIFICATION_DATABASE_INSTANCE_ID,
  AUTONOMOUS_RESEARCH_EXTERNAL_QUALIFICATION_DATABASE_ROLE,
  AUTONOMOUS_RESEARCH_EXTERNAL_QUALIFICATION_SCHEMA_CONTRACT_ID,
  AUTONOMOUS_RESEARCH_EXTERNAL_QUALIFICATION_WRITER_ID,
  createOfflineExternalQualificationMutationCoordinator,
} from './autonomous-research-qualification-state-mutation-plan.mjs';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;
const ONLINE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,191}$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const MAXIMUM_STATE_BYTES = 2 * 1024 * 1024;
const MINIMUM_LEASE_MS = 1000;
const MAXIMUM_LEASE_MS = 10 * 60 * 1000;

function safeNow(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new Error('autonomous_research_qualification_state_clock_invalid');
  }
  return date;
}

function parsePersistedState(row, expectedPaperId) {
  if (!row) return null;
  const serialized = String(row.state_json || '');
  if (Buffer.byteLength(serialized) < 2
    || Buffer.byteLength(serialized) > MAXIMUM_STATE_BYTES) {
    throw new Error('autonomous_research_external_qualification_state_file_invalid');
  }
  let state;
  try { state = JSON.parse(serialized); }
  catch { throw new Error('autonomous_research_external_qualification_state_json_invalid'); }
  validateAutonomousExternalQualificationState(state);
  if (state.paperId !== expectedPaperId
    || Number(row.generation) !== state.generation
    || row.state_hash !== state.autonomousExternalQualificationStateHash) {
    throw new Error('autonomous_research_external_qualification_state_fence_invalid');
  }
  return state;
}

function boundedLeaseMs(value) {
  const candidate = Number(value);
  if (!Number.isSafeInteger(candidate)) {
    throw new Error('autonomous_research_qualification_attempt_lease_duration_invalid');
  }
  return Math.max(MINIMUM_LEASE_MS, Math.min(MAXIMUM_LEASE_MS, candidate));
}

function sideEffectReservationHashes(value) {
  if (!Array.isArray(value)
    || value.some((candidate) => !SHA256.test(String(candidate || '')))
    || new Set(value).size !== value.length
    || value.some((candidate, index) => index > 0 && value[index - 1] >= candidate)) {
    throw new Error(
      'autonomous_research_external_qualification_side_effect_reservation_invalid',
    );
  }
  return Object.freeze([...value]);
}

function leaseIdentity({ ownerId, leaseToken, leaseGeneration } = {}) {
  if (!SAFE_ID.test(String(ownerId || ''))
    || !SAFE_ID.test(String(leaseToken || ''))
    || !Number.isSafeInteger(Number(leaseGeneration))
    || Number(leaseGeneration) < 1) {
    throw new Error('autonomous_research_qualification_attempt_lease_identity_invalid');
  }
  return {
    ownerId: String(ownerId),
    leaseToken: String(leaseToken),
    leaseGeneration: Number(leaseGeneration),
  };
}

function validateDatabaseFile(databasePath) {
  const stat = fs.lstatSync(databasePath);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o022) !== 0) {
    throw new Error('autonomous_research_external_qualification_database_invalid');
  }
}

export function createAutonomousResearchQualificationStateRepository({
  runtimeRoot,
  paperId,
  create = true,
  busyTimeoutMs = 10_000,
  offlineProvision = create,
  mutationCoordinator = null,
  schemaContractId = AUTONOMOUS_RESEARCH_EXTERNAL_QUALIFICATION_SCHEMA_CONTRACT_ID,
  writerId = AUTONOMOUS_RESEARCH_EXTERNAL_QUALIFICATION_WRITER_ID,
  requireExternallyFencedMutations = false,
} = {}) {
  if (!runtimeRoot || !SAFE_ID.test(String(paperId || ''))) {
    throw new Error('autonomous_research_qualification_state_repository_scope_invalid');
  }
  const effectiveDatabaseInstanceId =
    AUTONOMOUS_RESEARCH_EXTERNAL_QUALIFICATION_DATABASE_INSTANCE_ID;
  if (typeof create !== 'boolean'
    || typeof offlineProvision !== 'boolean'
    || typeof requireExternallyFencedMutations !== 'boolean'
    || (offlineProvision && !create)
    || !Number.isSafeInteger(busyTimeoutMs)
    || busyTimeoutMs < 1
    || busyTimeoutMs > 60_000
    || !ONLINE_ID.test(String(effectiveDatabaseInstanceId || ''))
    || !ONLINE_ID.test(String(schemaContractId || ''))
    || !ONLINE_ID.test(String(writerId || ''))) {
    throw new Error('autonomous_research_qualification_state_repository_configuration_invalid');
  }
  let coordinator = validateExternallyFencedSqliteMutationCoordinatorConfiguration({
    mutationCoordinator,
    requireExternallyFencedMutations,
    offlineProvision,
    databaseRole: AUTONOMOUS_RESEARCH_EXTERNAL_QUALIFICATION_DATABASE_ROLE,
    requiredErrorCode:
      'autonomous_research_external_qualification_external_mutation_coordinator_required',
  });
  coordinator ||= createOfflineExternalQualificationMutationCoordinator({
    databaseInstanceId: effectiveDatabaseInstanceId,
    schemaContractId,
    writerId,
  });
  const stateRoot = path.join(
    path.resolve(runtimeRoot),
    'autonomous-research',
    'qualification',
  );
  const statePath = path.join(stateRoot, 'external-qualification-state.sqlite');
  const legacyStatePath = path.join(
    path.resolve(runtimeRoot),
    'autonomous-research',
    paperId,
    'system-state',
    'external-qualification-state.json',
  );
  const scope = `paper:${paperId}`;
  if (offlineProvision) {
    fs.mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
    fs.chmodSync(stateRoot, 0o700);
    if (!fs.existsSync(statePath)) {
      fs.closeSync(fs.openSync(statePath, 'wx', 0o600));
    }
  }
  if (create && !offlineProvision && !fs.existsSync(statePath)) {
    throw new Error('autonomous_research_qualification_state_offline_provisioning_required');
  }
  if (fs.existsSync(statePath)) validateDatabaseFile(statePath);

  let database = null;
  if (create || fs.existsSync(statePath)) {
    database = new DatabaseSync(statePath, { readOnly: !create });
    database.exec(`PRAGMA busy_timeout=${busyTimeoutMs};`);
    if (offlineProvision) {
      try {
        database.exec('PRAGMA journal_mode=DELETE;');
        database.exec('PRAGMA synchronous=FULL;');
        database.exec(`CREATE TABLE IF NOT EXISTS autonomous_external_qualification_state (
          scope TEXT PRIMARY KEY,
          generation INTEGER NOT NULL CHECK(generation >= 1),
          state_hash TEXT NOT NULL,
          state_json TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;
        CREATE TABLE IF NOT EXISTS autonomous_external_qualification_attempt_lease (
          scope TEXT PRIMARY KEY,
          owner_id TEXT NOT NULL,
          lease_token TEXT NOT NULL,
          lease_generation INTEGER NOT NULL CHECK(lease_generation >= 1),
          acquired_at TEXT NOT NULL,
          renewed_at TEXT NOT NULL,
          expires_at TEXT NOT NULL
        ) STRICT;
        CREATE TABLE IF NOT EXISTS autonomous_external_qualification_attempt_reservation (
          scope TEXT NOT NULL,
          state_generation INTEGER NOT NULL CHECK(state_generation >= 1),
          state_hash TEXT NOT NULL,
          recovery_identity_hash TEXT NOT NULL,
          cycle INTEGER NOT NULL CHECK(cycle >= 1),
          epoch INTEGER NOT NULL CHECK(epoch >= 1),
          attempt_count INTEGER NOT NULL CHECK(attempt_count >= 1),
          total_attempt_count INTEGER NOT NULL CHECK(total_attempt_count >= 1),
          reserved_cost_usd REAL NOT NULL CHECK(reserved_cost_usd >= 0),
          prior_attempt_count INTEGER NOT NULL CHECK(prior_attempt_count >= 0),
          prior_total_attempt_count INTEGER NOT NULL CHECK(prior_total_attempt_count >= 0),
          prior_reserved_cost_usd REAL NOT NULL CHECK(prior_reserved_cost_usd >= 0),
          attempt_reservation_cost_usd REAL NOT NULL CHECK(attempt_reservation_cost_usd > 0),
          idempotency_key TEXT NOT NULL,
          lease_owner_id TEXT NOT NULL,
          lease_token_hash TEXT NOT NULL,
          lease_generation INTEGER NOT NULL CHECK(lease_generation >= 1),
          created_at TEXT NOT NULL,
          external_action_may_have_started INTEGER NOT NULL DEFAULT 0
            CHECK(external_action_may_have_started IN (0,1)),
          started_actions_json TEXT NOT NULL DEFAULT '[]',
          first_started_at TEXT,
          last_started_at TEXT,
          side_effect_permit_hash TEXT,
          recovery_takeover_count INTEGER NOT NULL DEFAULT 0
            CHECK(recovery_takeover_count >= 0),
          last_recovery_takeover_at TEXT,
          cancelled_at TEXT,
          cancelled_state_generation INTEGER,
          cancelled_state_hash TEXT,
          PRIMARY KEY(scope,state_generation)
        ) STRICT;`);
        fs.chmodSync(statePath, 0o600);
      } catch (error) {
        database.close();
        throw error;
      }
    }
  }

  let closed = false;
  function requireOpen({ writable = false } = {}) {
    if (closed) throw new Error('autonomous_research_qualification_state_repository_closed');
    if (!database) {
      if (writable) throw new Error('autonomous_research_qualification_state_repository_read_only');
      return null;
    }
    if (writable && !create) {
      throw new Error('autonomous_research_qualification_state_repository_read_only');
    }
    return database;
  }

  function readState() {
    const db = requireOpen();
    if (!db) return null;
    return parsePersistedState(db.prepare(
      'SELECT generation,state_hash,state_json FROM autonomous_external_qualification_state WHERE scope=?',
    ).get(scope), paperId);
  }

  function mutationValue(receipt) {
    if (!receipt || !Object.prototype.hasOwnProperty.call(receipt, 'value')) {
      throw new Error('autonomous_research_external_qualification_mutation_receipt_invalid');
    }
    return receipt.value;
  }

  const attemptSideEffectPermits = new Map();

  const attemptInfrastructureOperations =
    createAutonomousResearchQualificationAttemptInfrastructureOperations({
      requireWritableDatabase: () => requireOpen({ writable: true }),
      coordinator,
      databaseInstanceId: effectiveDatabaseInstanceId,
      schemaContractId,
      writerId,
      scope,
      paperId,
      safeNow,
      leaseIdentity,
      parsePersistedState,
      mutationValue,
      boundedLeaseMs,
      requireFinalizedSideEffectPermit: requireExternallyFencedMutations,
      sideEffectPermitForState: (stateHash) => (
        attemptSideEffectPermits.get(stateHash) || null
      ),
    });

  return Object.freeze({
    version: 2,
    kind: 'AutonomousResearchQualificationStateRepository',
    durable: true,
    compareAndSwap: true,
    sqliteCompareAndSwap: true,
    lifecycleBudgetFencing: true,
    recoverableAttemptLease: true,
    recoverableInfrastructureReservation: true,
    systemOwnedRuntimeState: true,
    readOnly: !create,
    offlineProvisioningPerformed: offlineProvision,
    externallyFencedMutations: coordinator.implemented === true,
    externallyFencedMutationsRequired: requireExternallyFencedMutations,
    databaseInstanceId: effectiveDatabaseInstanceId,
    schemaContractId,
    writerId,
    statePath,
    legacyStatePath,
    readExternalQualificationState: readState,
    compareAndSwapExternalQualificationState({
      expectedStateHash = null,
      state,
      attemptLease = null,
      sideEffectReservationHashes: requestedSideEffectReservationHashes = [],
      now = new Date(),
    } = {}) {
      const db = requireOpen({ writable: true });
      validateAutonomousExternalQualificationState(state);
      if (state.paperId !== paperId) {
        throw new Error('autonomous_research_external_qualification_state_scope_invalid');
      }
      const serialized = JSON.stringify(state);
      if (Buffer.byteLength(serialized) > MAXIMUM_STATE_BYTES) {
        throw new Error('autonomous_research_external_qualification_state_file_invalid');
      }
      const identity = attemptLease ? leaseIdentity(attemptLease) : null;
      const reservedSideEffects = sideEffectReservationHashes(
        requestedSideEffectReservationHashes,
      );
      const observedAt = identity ? safeNow(now) : null;
      if (reservedSideEffects.length > 0
        && (!identity || reservedSideEffects.length !== 1)) {
        throw new Error(
          'autonomous_research_external_qualification_attempt_reservation_invalid',
        );
      }
      const updatedAt = new Date().toISOString();
      const mutationReceipt = coordinator.executeMutation({
        database: db,
        databaseRole: 'external-qualification',
        databaseInstanceId: effectiveDatabaseInstanceId,
        schemaContractId,
        writerId,
        operationId:
          'external-qualification.qualification-state-repository.compareAndSwapExternalQualificationState.v1',
        authorizationReceiptHashes: [],
        sideEffectReservationHashes: reservedSideEffects,
        mutate(transaction) {
          if (identity) {
            const persistedLease = transaction.get(
              'external-qualification.cas.lease-current.get.v1',
              scope,
            );
            if (!persistedLease
              || persistedLease.owner_id !== identity.ownerId
              || persistedLease.lease_token !== identity.leaseToken
              || Number(persistedLease.lease_generation) !== identity.leaseGeneration
              || Date.parse(persistedLease.expires_at) <= observedAt.getTime()) {
              throw new Error('autonomous_research_qualification_attempt_lease_fence_conflict');
            }
          }
          const current = parsePersistedState(transaction.get(
            'external-qualification.cas.state-current.get.v1',
            scope,
          ), paperId);
          const currentHash = current?.autonomousExternalQualificationStateHash || null;
          if (currentHash !== expectedStateHash
            || state.generation !== Number(current?.generation || 0) + 1) {
            throw new Error('autonomous_research_qualification_state_fence_conflict');
          }
          const reservationPrior = reservedSideEffects.length > 0
            ? attemptReservationPrior(current, state) : null;
          if (reservedSideEffects.length > 0
            && reservedSideEffects[0] !== attemptIdempotencyKey(state)) {
            throw new Error(
              'autonomous_research_external_qualification_attempt_idempotency_invalid',
            );
          }
          if (current) {
            const result = transaction.run(
              'external-qualification.cas.state-update.apply.v1',
              state.generation,
              state.autonomousExternalQualificationStateHash,
              serialized,
              updatedAt,
              scope,
              current.generation,
              currentHash,
            );
            if (Number(result.changes) !== 1) {
              throw new Error('autonomous_research_qualification_state_fence_conflict');
            }
          } else {
            transaction.run(
              'external-qualification.cas.state-insert.apply.v1',
              scope,
              state.generation,
              state.autonomousExternalQualificationStateHash,
              serialized,
              updatedAt,
            );
          }
          if (reservationPrior) {
            transaction.run(
              'external-qualification.cas.attempt-reservation-insert.apply.v1',
              scope,
              state.generation,
              state.autonomousExternalQualificationStateHash,
              state.recovery.recoveryIdentityHash,
              state.recovery.cycle,
              state.recovery.epoch,
              state.recovery.attemptCount,
              state.recovery.totalAttemptCount,
              state.recovery.reservedCostUsd,
              reservationPrior.attemptCount,
              reservationPrior.totalAttemptCount,
              reservationPrior.reservedCostUsd,
              state.recovery.attemptReservationCostUsd,
              reservedSideEffects[0],
              identity.ownerId,
              attemptLeaseTokenHash(scope, identity),
              identity.leaseGeneration,
              observedAt.toISOString(),
            );
          }
          return state;
        },
      });
      const value = mutationValue(mutationReceipt);
      if (requireExternallyFencedMutations && reservedSideEffects.length > 0
        && (mutationReceipt.status !== 'externally_fenced_sqlite_mutation_finalized'
          || !SHA256.test(String(mutationReceipt.sideEffectPermitHash || '')))) {
        const error = new Error(
          'autonomous_research_external_qualification_side_effect_permit_required',
        );
        error.committed = true;
        error.reservationId = mutationReceipt?.reservationId || null;
        error.sideEffectPermitHash = mutationReceipt?.sideEffectPermitHash || null;
        throw error;
      }
      if (reservedSideEffects.length > 0
        && SHA256.test(String(mutationReceipt.sideEffectPermitHash || ''))) {
        attemptSideEffectPermits.set(
          state.autonomousExternalQualificationStateHash,
          mutationReceipt.sideEffectPermitHash,
        );
      }
      return value;
    },
    ...attemptInfrastructureOperations,
    tryAcquireQualificationAttemptLease({ ownerId, leaseMs, now = new Date() } = {}) {
      const db = requireOpen({ writable: true });
      if (!SAFE_ID.test(String(ownerId || ''))) {
        throw new Error('autonomous_research_qualification_attempt_lease_owner_invalid');
      }
      const observedAt = safeNow(now);
      const duration = boundedLeaseMs(leaseMs);
      const leaseToken = `lease:${crypto.randomUUID()}`;
      const expiresAt = new Date(observedAt.getTime() + duration).toISOString();
      return mutationValue(coordinator.executeMutation({
        database: db,
        databaseRole: 'external-qualification',
        databaseInstanceId: effectiveDatabaseInstanceId,
        schemaContractId,
        writerId,
        operationId:
          'external-qualification.qualification-state-repository.tryAcquireQualificationAttemptLease.v1',
        authorizationReceiptHashes: [],
        sideEffectReservationHashes: [],
        mutate(transaction) {
          const current = transaction.get(
            'external-qualification.acquire.lease-current.get.v1',
            scope,
          );
          if (current && Date.parse(current.expires_at) > observedAt.getTime()) {
            return null;
          }
          const leaseGeneration = Number(current?.lease_generation || 0) + 1;
          transaction.run(
            'external-qualification.acquire.lease-upsert.apply.v1',
            scope,
            String(ownerId),
            leaseToken,
            leaseGeneration,
            observedAt.toISOString(),
            observedAt.toISOString(),
            expiresAt,
          );
          return Object.freeze({
            ownerId: String(ownerId),
            leaseToken,
            leaseGeneration,
            expiresAt,
          });
        },
      }));
    },
    renewQualificationAttemptLease({ ownerId, leaseToken, leaseGeneration, leaseMs, now = new Date() } = {}) {
      const db = requireOpen({ writable: true });
      const identity = leaseIdentity({ ownerId, leaseToken, leaseGeneration });
      const observedAt = safeNow(now);
      const expiresAt = new Date(observedAt.getTime() + boundedLeaseMs(leaseMs)).toISOString();
      return mutationValue(coordinator.executeMutation({
        database: db,
        databaseRole: 'external-qualification',
        databaseInstanceId: effectiveDatabaseInstanceId,
        schemaContractId,
        writerId,
        operationId:
          'external-qualification.qualification-state-repository.renewQualificationAttemptLease.v1',
        authorizationReceiptHashes: [],
        sideEffectReservationHashes: [],
        mutate(transaction) {
          const result = transaction.run(
            'external-qualification.renew.lease-update.apply.v1',
            observedAt.toISOString(),
            expiresAt,
            scope,
            identity.ownerId,
            identity.leaseToken,
            identity.leaseGeneration,
            observedAt.toISOString(),
          );
          return Number(result.changes) === 1
            ? Object.freeze({ ...identity, expiresAt }) : null;
        },
      }));
    },
    releaseQualificationAttemptLease({ ownerId, leaseToken, leaseGeneration } = {}) {
      const db = requireOpen({ writable: true });
      const identity = leaseIdentity({ ownerId, leaseToken, leaseGeneration });
      return mutationValue(coordinator.executeMutation({
        database: db,
        databaseRole: 'external-qualification',
        databaseInstanceId: effectiveDatabaseInstanceId,
        schemaContractId,
        writerId,
        operationId:
          'external-qualification.qualification-state-repository.releaseQualificationAttemptLease.v1',
        authorizationReceiptHashes: [],
        sideEffectReservationHashes: [],
        mutate(transaction) {
          const result = transaction.run(
            'external-qualification.release.lease-delete.apply.v1',
            scope,
            identity.ownerId,
            identity.leaseToken,
            identity.leaseGeneration,
          );
          return Number(result.changes) === 1;
        },
      }));
    },
    reconcileStaleQualificationAttemptLease({ now = new Date() } = {}) {
      const db = requireOpen({ writable: true });
      const observedAt = safeNow(now).toISOString();
      return mutationValue(coordinator.executeMutation({
        database: db,
        databaseRole: 'external-qualification',
        databaseInstanceId: effectiveDatabaseInstanceId,
        schemaContractId,
        writerId,
        operationId:
          'external-qualification.qualification-state-repository.reconcileStaleQualificationAttemptLease.v1',
        authorizationReceiptHashes: [],
        sideEffectReservationHashes: [],
        mutate(transaction) {
          const result = transaction.run(
            'external-qualification.reconcile.lease-delete.apply.v1',
            scope,
            observedAt,
          );
          return Object.freeze({
            recoveredLeaseCount: Number(result.changes),
            reconciledAt: observedAt,
          });
        },
      }));
    },
    close() {
      if (!closed) database?.close();
      closed = true;
    },
  });
}
