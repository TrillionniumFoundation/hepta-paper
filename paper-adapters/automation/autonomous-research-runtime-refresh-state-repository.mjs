import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  normalizeRuntimeReproducibilityRefreshPolicy,
  runtimeReproducibilityBudgetEpoch,
  runtimeReproducibilityReservation,
} from '../../paper-domain/automation/runtime-reproducibility-refresh-policy.mjs';
import { validateExternallyFencedSqliteMutationCoordinatorConfiguration } from './externally-fenced-sqlite-mutation-coordinator-configuration.mjs';
import {
  AUTONOMOUS_RESEARCH_RUNTIME_REFRESH_DATABASE_INSTANCE_ID,
  AUTONOMOUS_RESEARCH_RUNTIME_REFRESH_SCHEMA_CONTRACT_ID,
  AUTONOMOUS_RESEARCH_RUNTIME_REFRESH_WRITER_ID,
  createOfflineRuntimeRefreshMutationCoordinator,
} from './autonomous-research-runtime-refresh-mutation-plan.mjs';
const SCOPE_ID = 'resident-runtime-image-reproducibility';
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,255}$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/i;
function observedDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new Error('runtime_reproducibility_refresh_clock_invalid');
  }
  return date;
}
function leaseIdentity(value = {}) {
  if (!SAFE_ID.test(String(value.ownerId || ''))
    || !SAFE_ID.test(String(value.leaseToken || ''))
    || !Number.isSafeInteger(Number(value.leaseGeneration))
    || Number(value.leaseGeneration) < 1) {
    throw new Error('runtime_reproducibility_refresh_lease_identity_invalid');
  }
  return Object.freeze({
    ownerId: String(value.ownerId),
    leaseToken: String(value.leaseToken),
    leaseGeneration: Number(value.leaseGeneration),
  });
}
function mapState(row) {
  if (!row) return null;
  return Object.freeze({
    scopeId: row.scope_id,
    status: row.status,
    consecutiveFailures: Number(row.consecutive_failures),
    nextAttemptAt: row.next_attempt_at,
    lastError: row.last_error || null,
    lastConfigurationIdentityHash: row.last_configuration_identity_hash || null,
    lastReceiptHash: row.last_receipt_hash || null,
    lastReceiptContentHash: row.last_receipt_content_hash || null,
    lastIssuedAt: row.last_issued_at || null,
    lastExpiresAt: row.last_expires_at || null,
    recoveredLeaseCount: Number(row.recovered_lease_count),
    leaseOwner: row.lease_owner || null,
    leaseToken: row.lease_token || null,
    leaseGeneration: Number(row.lease_generation),
    leaseExpiresAt: row.lease_expires_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}
function mapEpoch(row) {
  return Object.freeze({
    epochStart: row.epoch_start, epochEnd: row.epoch_end,
    policyHash: row.policy_hash, attemptCount: Number(row.attempt_count),
    reservedCostUsd: Number(row.reserved_cost_usd),
  });
}
function mapAttempt(row) {
  return Object.freeze({
    leaseGeneration: Number(row.lease_generation),
    ownerId: row.owner_id, campaignId: row.campaign_id,
    epochStart: row.epoch_start,
    configurationIdentityHash: row.configuration_identity_hash,
    reservedCostUsd: Number(row.reserved_cost_usd),
    costAuthority: row.cost_authority,
    status: row.status, error: row.error || null,
    receiptHash: row.receipt_hash || null,
    reservedAt: row.reserved_at, completedAt: row.completed_at || null,
  });
}
export function createAutonomousResearchRuntimeRefreshStateRepository({
  runtimeRoot,
  policy: suppliedPolicy,
  busyTimeoutMs = 10_000,
  offlineProvision = true,
  mutationCoordinator = null,
  databaseInstanceId = AUTONOMOUS_RESEARCH_RUNTIME_REFRESH_DATABASE_INSTANCE_ID,
  schemaContractId = AUTONOMOUS_RESEARCH_RUNTIME_REFRESH_SCHEMA_CONTRACT_ID,
  writerId = AUTONOMOUS_RESEARCH_RUNTIME_REFRESH_WRITER_ID,
  requireExternallyFencedMutations = false,
} = {}) {
  if (!runtimeRoot) throw new Error('runtime_reproducibility_refresh_runtime_root_required');
  if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 1 || busyTimeoutMs > 60_000
    || typeof offlineProvision !== 'boolean'
    || typeof requireExternallyFencedMutations !== 'boolean'
    || !SAFE_ID.test(String(databaseInstanceId || ''))
    || !SAFE_ID.test(String(schemaContractId || ''))
    || !SAFE_ID.test(String(writerId || ''))) {
    throw new Error('runtime_reproducibility_refresh_repository_configuration_invalid');
  }
  let coordinator = validateExternallyFencedSqliteMutationCoordinatorConfiguration({
    mutationCoordinator,
    requireExternallyFencedMutations,
    offlineProvision,
    databaseRole: 'runtime-reproducibility-refresh',
    requiredErrorCode: 'runtime_reproducibility_refresh_external_mutation_coordinator_required',
  });
  coordinator ||= createOfflineRuntimeRefreshMutationCoordinator({
    databaseInstanceId,
    schemaContractId,
    writerId,
  });
  const policy = normalizeRuntimeReproducibilityRefreshPolicy(suppliedPolicy);
  const stateRoot = path.join(path.resolve(runtimeRoot), 'autonomous-research', 'supervisor');
  const databasePath = path.join(stateRoot, 'runtime-reproducibility-refresh.sqlite');
  if (offlineProvision) {
    fs.mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
    fs.chmodSync(stateRoot, 0o700);
  } else if (!fs.existsSync(databasePath)) {
    throw new Error('runtime_reproducibility_refresh_offline_provisioning_required');
  }
  const database = new DatabaseSync(databasePath);
  database.exec(`PRAGMA busy_timeout=${busyTimeoutMs};`);
  if (offlineProvision) {
    database.exec('PRAGMA journal_mode=WAL;');
    database.exec('PRAGMA synchronous=FULL;');
    database.exec(`CREATE TABLE IF NOT EXISTS runtime_reproducibility_refresh_state (
    scope_id TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK(consecutive_failures >= 0),
    next_attempt_at TEXT NOT NULL,
    last_error TEXT,
    last_configuration_identity_hash TEXT,
    last_receipt_hash TEXT,
    last_receipt_content_hash TEXT,
    last_issued_at TEXT,
    last_expires_at TEXT,
    recovered_lease_count INTEGER NOT NULL DEFAULT 0 CHECK(recovered_lease_count >= 0),
    lease_owner TEXT,
    lease_token TEXT,
    lease_generation INTEGER NOT NULL DEFAULT 0 CHECK(lease_generation >= 0),
    lease_expires_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS runtime_reproducibility_refresh_budget_epoch (
    epoch_start TEXT PRIMARY KEY,
    epoch_end TEXT NOT NULL,
    policy_json TEXT NOT NULL,
    policy_hash TEXT NOT NULL,
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
    reserved_cost_usd REAL NOT NULL DEFAULT 0 CHECK(reserved_cost_usd >= 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS runtime_reproducibility_refresh_attempt (
    lease_generation INTEGER PRIMARY KEY,
    owner_id TEXT NOT NULL,
    campaign_id TEXT NOT NULL,
    epoch_start TEXT NOT NULL,
    configuration_identity_hash TEXT NOT NULL,
    reserved_cost_usd REAL NOT NULL CHECK(reserved_cost_usd >= 0),
    cost_authority TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('reserved','succeeded','failed','cancelled')),
    error TEXT,
    receipt_hash TEXT,
    reserved_at TEXT NOT NULL,
    completed_at TEXT
  ) STRICT;`);
    const initializedAt = new Date(0).toISOString();
    database.prepare(`INSERT OR IGNORE INTO runtime_reproducibility_refresh_state(
      scope_id,status,next_attempt_at,created_at,updated_at
    ) VALUES(?,?,?,?,?)`).run(
      SCOPE_ID,
      'refresh_unobserved',
      initializedAt,
      initializedAt,
      initializedAt,
    );
    fs.chmodSync(databasePath, 0o600);
  }
  let closed = false;

  function requireOpen() {
    if (closed) throw new Error('runtime_reproducibility_refresh_state_repository_closed');
  }

  function state() {
    requireOpen();
    return mapState(database.prepare(
      'SELECT * FROM runtime_reproducibility_refresh_state WHERE scope_id=?',
    ).get(SCOPE_ID));
  }

  function fencedState(rawLease, now, current = state()) {
    const lease = leaseIdentity(rawLease);
    if (current.leaseOwner !== lease.ownerId
      || current.leaseToken !== lease.leaseToken
      || current.leaseGeneration !== lease.leaseGeneration
      || Date.parse(current.leaseExpiresAt || '') <= now.getTime()) {
      throw new Error('runtime_reproducibility_refresh_lease_lost');
    }
    return Object.freeze({ lease, current });
  }

  function mutationValue(receipt) {
    if (!receipt || !Object.prototype.hasOwnProperty.call(receipt, 'value')) {
      throw new Error('runtime_reproducibility_refresh_mutation_receipt_invalid');
    }
    return receipt.value;
  }

  return Object.freeze({
    version: 1,
    kind: 'AutonomousResearchRuntimeRefreshStateRepository',
    durable: true,
    globalSingletonLease: true,
    fixedBudgetEpoch: true,
    offlineProvisioningPerformed: offlineProvision,
    externallyFencedMutations: coordinator.implemented === true,
    externallyFencedMutationsRequired: requireExternallyFencedMutations,
    databaseInstanceId,
    schemaContractId,
    writerId,
    databasePath,
    policy,
    readState: state,
    listBudgetEpochs() {
      requireOpen();
      return Object.freeze(database.prepare(
        'SELECT * FROM runtime_reproducibility_refresh_budget_epoch ORDER BY epoch_start',
      ).all().map(mapEpoch));
    },
    listAttempts() {
      requireOpen();
      return Object.freeze(database.prepare(
        'SELECT * FROM runtime_reproducibility_refresh_attempt ORDER BY lease_generation',
      ).all().map(mapAttempt));
    },
    reconcileStaleRefreshLease({ now = new Date() } = {}) {
      requireOpen();
      const observedAt = observedDate(now);
      return mutationValue(coordinator.executeMutation({
        database,
        databaseRole: 'runtime-reproducibility-refresh',
        databaseInstanceId,
        schemaContractId,
        writerId,
        operationId:
          'runtime-reproducibility-refresh.runtime-refresh-state-repository.reconcileStaleRefreshLease.v1',
        authorizationReceiptHashes: [],
        sideEffectReservationHashes: [],
        mutate(transaction) {
          const current = mapState(transaction.get(
            'runtime-refresh.reconcile.state-current.get.v1',
            SCOPE_ID,
          ));
          const expired = current.leaseExpiresAt
            && Date.parse(current.leaseExpiresAt) <= observedAt.getTime();
          if (expired) {
            transaction.run(
              'runtime-refresh.reconcile.attempt-expire.apply.v1',
              observedAt.toISOString(),
              current.leaseGeneration,
            );
            transaction.run(
              'runtime-refresh.reconcile.state-recover.apply.v1',
              observedAt.toISOString(),
              observedAt.toISOString(),
              SCOPE_ID,
            );
          }
          return Object.freeze({
            recoveredLeaseCount: expired ? 1 : 0,
            reconciledAt: observedAt.toISOString(),
          });
        },
      }));
    },
    tryAcquireRefreshLease({ ownerId, leaseMs = policy.leaseMs, now = new Date() } = {}) {
      requireOpen();
      if (!SAFE_ID.test(String(ownerId || ''))) {
        throw new Error('runtime_reproducibility_refresh_owner_invalid');
      }
      const observedAt = observedDate(now);
      const duration = Number(leaseMs);
      if (!Number.isSafeInteger(duration) || duration < 1000 || duration > 4 * 60 * 60 * 1000) {
        throw new Error('runtime_reproducibility_refresh_lease_invalid');
      }
      return mutationValue(coordinator.executeMutation({
        database,
        databaseRole: 'runtime-reproducibility-refresh',
        databaseInstanceId,
        schemaContractId,
        writerId,
        operationId:
          'runtime-reproducibility-refresh.runtime-refresh-state-repository.tryAcquireRefreshLease.v1',
        authorizationReceiptHashes: [],
        sideEffectReservationHashes: [],
        mutate(transaction) {
          const current = mapState(transaction.get(
            'runtime-refresh.acquire.state-current.get.v1',
            SCOPE_ID,
          ));
          const activeExpiry = Date.parse(current.leaseExpiresAt || '');
          if (Number.isFinite(activeExpiry) && activeExpiry > observedAt.getTime()) {
            return Object.freeze({
              acquired: false,
              reason: 'runtime_reproducibility_refresh_leased',
              nextAttemptAt: current.leaseExpiresAt,
            });
          }
          if (Date.parse(current.nextAttemptAt) > observedAt.getTime()) {
            return Object.freeze({
              acquired: false,
              reason: 'runtime_reproducibility_refresh_backoff_active',
              nextAttemptAt: current.nextAttemptAt,
            });
          }
          const recovered = Boolean(current.leaseExpiresAt);
          if (recovered) {
            transaction.run(
              'runtime-refresh.acquire.attempt-expire.apply.v1',
              observedAt.toISOString(),
              current.leaseGeneration,
            );
          }
          const lease = Object.freeze({
            ownerId: String(ownerId),
            leaseToken: `refresh:${crypto.randomUUID()}`,
            leaseGeneration: current.leaseGeneration + 1,
            expiresAt: new Date(observedAt.getTime() + duration).toISOString(),
          });
          const update = transaction.run(
            'runtime-refresh.acquire.state-apply.v1',
            lease.ownerId,
            lease.leaseToken,
            lease.leaseGeneration,
            lease.expiresAt,
            recovered ? 1 : 0,
            observedAt.toISOString(),
            SCOPE_ID,
            current.leaseGeneration,
          );
          if (Number(update.changes) !== 1) {
            throw new Error('runtime_reproducibility_refresh_lease_fence_conflict');
          }
          return Object.freeze({ acquired: true, lease });
        },
      }));
    },
    assertRefreshLease({ lease, now = new Date() } = {}) {
      requireOpen();
      fencedState(lease, observedDate(now));
      return true;
    },
    renewRefreshLease({ lease, leaseMs = policy.leaseMs, now = new Date() } = {}) {
      requireOpen();
      const identity = leaseIdentity(lease);
      const observedAt = observedDate(now);
      const expiresAt = new Date(observedAt.getTime() + Number(leaseMs)).toISOString();
      return mutationValue(coordinator.executeMutation({
        database,
        databaseRole: 'runtime-reproducibility-refresh',
        databaseInstanceId,
        schemaContractId,
        writerId,
        operationId:
          'runtime-reproducibility-refresh.runtime-refresh-state-repository.renewRefreshLease.v1',
        authorizationReceiptHashes: [],
        sideEffectReservationHashes: [],
        mutate(transaction) {
          const result = transaction.run(
            'runtime-refresh.renew.state-apply.v1',
            expiresAt,
            observedAt.toISOString(),
            SCOPE_ID,
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
    releaseRefreshLease({ lease, now = new Date() } = {}) {
      requireOpen();
      const identity = leaseIdentity(lease);
      const observedAt = observedDate(now);
      return mutationValue(coordinator.executeMutation({
        database,
        databaseRole: 'runtime-reproducibility-refresh',
        databaseInstanceId,
        schemaContractId,
        writerId,
        operationId:
          'runtime-reproducibility-refresh.runtime-refresh-state-repository.releaseRefreshLease.v1',
        authorizationReceiptHashes: [],
        sideEffectReservationHashes: [],
        mutate(transaction) {
          const result = transaction.run(
            'runtime-refresh.release.state-apply.v1',
            observedAt.toISOString(),
            observedAt.toISOString(),
            SCOPE_ID,
            identity.ownerId,
            identity.leaseToken,
            identity.leaseGeneration,
          );
          return Number(result.changes) === 1;
        },
      }));
    },
    reserveRefreshAttempt({
      lease,
      campaignId,
      configuration,
      now = new Date(),
    } = {}) {
      requireOpen();
      if (!SAFE_ID.test(String(campaignId || ''))) {
        throw new Error('runtime_reproducibility_refresh_campaign_id_invalid');
      }
      const reservation = runtimeReproducibilityReservation(configuration);
      const observedAt = observedDate(now);
      return mutationValue(coordinator.executeMutation({
        database,
        databaseRole: 'runtime-reproducibility-refresh',
        databaseInstanceId,
        schemaContractId,
        writerId,
        operationId:
          'runtime-reproducibility-refresh.runtime-refresh-state-repository.reserveRefreshAttempt.v1',
        authorizationReceiptHashes: [],
        sideEffectReservationHashes: [],
        mutate(transaction) {
          const current = mapState(transaction.get(
            'runtime-refresh.reserve.state-current.get.v1',
            SCOPE_ID,
          ));
          const { lease: identity } = fencedState(lease, observedAt, current);
          const epochIdentity = runtimeReproducibilityBudgetEpoch(
            policy,
            observedAt.getTime(),
          );
          const epochStart = new Date(epochIdentity.epochStartEpochMs).toISOString();
          const epochEnd = new Date(epochIdentity.epochEndEpochMs).toISOString();
          let epoch = transaction.get(
            'runtime-refresh.reserve.epoch-current.get.v1',
            epochStart,
          );
          if (!epoch) {
            transaction.run(
              'runtime-refresh.reserve.epoch-create.apply.v1',
              epochStart,
              epochEnd,
              JSON.stringify(policy),
              policy.runtimeReproducibilityRefreshPolicyHash,
              observedAt.toISOString(),
              observedAt.toISOString(),
            );
            epoch = transaction.get(
              'runtime-refresh.reserve.epoch-current.get.v1',
              epochStart,
            );
          }
          if (epoch.policy_hash !== policy.runtimeReproducibilityRefreshPolicyHash) {
            transaction.run(
              'runtime-refresh.reserve.state-block.apply.v1',
              'refresh_configuration_blocked',
              epoch.epoch_end,
              'runtime_reproducibility_refresh_budget_policy_immutable',
              observedAt.toISOString(),
              SCOPE_ID,
            );
            return Object.freeze({
              authorized: false,
              terminal: true,
              blocker: 'runtime_reproducibility_refresh_budget_policy_immutable',
              deferUntil: epoch.epoch_end,
            });
          }
          const nextAttemptCount = Number(epoch.attempt_count) + 1;
          const nextCostUsd = Number(epoch.reserved_cost_usd)
            + reservation.maximumVerificationCostUsd;
          if (nextAttemptCount > policy.maximumAttemptsPerEpoch
            || nextCostUsd > policy.maximumCostUsdPerEpoch + Number.EPSILON) {
            transaction.run(
              'runtime-refresh.reserve.state-block.apply.v1',
              'refresh_budget_deferred',
              epoch.epoch_end,
              'runtime_reproducibility_refresh_epoch_budget_exhausted',
              observedAt.toISOString(),
              SCOPE_ID,
            );
            return Object.freeze({
              authorized: false,
              terminal: false,
              blocker: 'runtime_reproducibility_refresh_epoch_budget_exhausted',
              deferUntil: epoch.epoch_end,
            });
          }
          transaction.run(
            'runtime-refresh.reserve.attempt-create.apply.v1',
            identity.leaseGeneration,
            identity.ownerId,
            String(campaignId),
            epoch.epoch_start,
            reservation.configurationIdentityHash,
            reservation.maximumVerificationCostUsd,
            reservation.verificationCostAuthority,
            observedAt.toISOString(),
          );
          transaction.run(
            'runtime-refresh.reserve.epoch-reserve.apply.v1',
            nextAttemptCount,
            nextCostUsd,
            observedAt.toISOString(),
            epoch.epoch_start,
          );
          transaction.run(
            'runtime-refresh.reserve.state-progress.apply.v1',
            reservation.configurationIdentityHash,
            observedAt.toISOString(),
            SCOPE_ID,
          );
          return Object.freeze({
            authorized: true,
            leaseGeneration: identity.leaseGeneration,
            epochStart: epoch.epoch_start,
            epochEnd: epoch.epoch_end,
            reservedCostUsd: reservation.maximumVerificationCostUsd,
            epochAttemptCount: nextAttemptCount,
            epochReservedCostUsd: nextCostUsd,
          });
        },
      }));
    },
    completeRefreshAttempt({
      lease,
      receiptHash,
      receiptContentHash,
      issuedAt,
      expiresAt,
      now = new Date(),
    } = {}) {
      requireOpen();
      if (!SHA256.test(String(receiptHash || ''))
        || !SHA256.test(String(receiptContentHash || ''))) {
        throw new Error('runtime_reproducibility_refresh_receipt_identity_invalid');
      }
      const observedAt = observedDate(now);
      const issued = observedDate(issuedAt);
      const expires = observedDate(expiresAt);
      if (expires.getTime() <= issued.getTime()) {
        throw new Error('runtime_reproducibility_refresh_receipt_window_invalid');
      }
      return mutationValue(coordinator.executeMutation({
        database,
        databaseRole: 'runtime-reproducibility-refresh',
        databaseInstanceId,
        schemaContractId,
        writerId,
        operationId:
          'runtime-reproducibility-refresh.runtime-refresh-state-repository.completeRefreshAttempt.v1',
        authorizationReceiptHashes: [],
        sideEffectReservationHashes: [],
        mutate(transaction) {
          const current = mapState(transaction.get(
            'runtime-refresh.complete.state-current.get.v1',
            SCOPE_ID,
          ));
          const { lease: identity } = fencedState(lease, observedAt, current);
          const attempt = transaction.run(
            'runtime-refresh.complete.attempt-apply.v1',
            receiptHash,
            observedAt.toISOString(),
            identity.leaseGeneration,
            identity.ownerId,
          );
          if (Number(attempt.changes) !== 1) {
            throw new Error('runtime_reproducibility_refresh_attempt_fence_conflict');
          }
          transaction.run(
            'runtime-refresh.complete.state-apply.v1',
            observedAt.toISOString(),
            receiptHash,
            receiptContentHash,
            issued.toISOString(),
            expires.toISOString(),
            observedAt.toISOString(),
            SCOPE_ID,
          );
          return mapState(transaction.get(
            'runtime-refresh.complete.state-current.get.v1',
            SCOPE_ID,
          ));
        },
      }));
    },
    failRefreshAttempt({
      lease,
      error,
      cancelled = false,
      nextAttemptAt,
      now = new Date(),
    } = {}) {
      requireOpen();
      const observedAt = observedDate(now);
      const retryAt = observedDate(nextAttemptAt);
      const failure = String(error || 'refresh_failed').slice(0, 1000);
      return mutationValue(coordinator.executeMutation({
        database,
        databaseRole: 'runtime-reproducibility-refresh',
        databaseInstanceId,
        schemaContractId,
        writerId,
        operationId:
          'runtime-reproducibility-refresh.runtime-refresh-state-repository.failRefreshAttempt.v1',
        authorizationReceiptHashes: [],
        sideEffectReservationHashes: [],
        mutate(transaction) {
          const current = mapState(transaction.get(
            'runtime-refresh.fail.state-current.get.v1',
            SCOPE_ID,
          ));
          const { lease: identity } = fencedState(lease, observedAt, current);
          const attempt = transaction.run(
            'runtime-refresh.fail.attempt-apply.v1',
            cancelled ? 'cancelled' : 'failed',
            failure,
            observedAt.toISOString(),
            identity.leaseGeneration,
            identity.ownerId,
          );
          if (Number(attempt.changes) !== 1) {
            throw new Error('runtime_reproducibility_refresh_attempt_fence_conflict');
          }
          transaction.run(
            'runtime-refresh.fail.state-apply.v1',
            retryAt.toISOString(),
            failure,
            observedAt.toISOString(),
            SCOPE_ID,
          );
          return mapState(transaction.get(
            'runtime-refresh.fail.state-current.get.v1',
            SCOPE_ID,
          ));
        },
      }));
    },
    close() {
      if (!closed) database.close();
      closed = true;
    },
  });
}
