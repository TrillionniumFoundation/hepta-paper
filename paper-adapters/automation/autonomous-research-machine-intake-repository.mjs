import crypto from 'node:crypto';

import {
  verifyAutonomousResearchMachineIntake,
} from '../../paper-domain/automation/autonomous-research-machine-intake-contract.mjs';
import {
  buildAutonomousResearchMachineIntakeAdmission,
} from '../../paper-domain/automation/autonomous-research-machine-intake-admission-contract.mjs';
import {
  assertMachineIntakeAuthorityEvidence,
} from './autonomous-research-machine-intake-authority.mjs';
import {
  SELECT_RECORD,
  canonicalSource,
  identity,
  leaseDuration,
  observedDate,
  parseRow,
  recurringEpochCurrent,
  utcDayStart,
} from './autonomous-research-machine-intake-repository-support.mjs';
import {
  openAutonomousResearchMachineIntakeRepository,
} from './autonomous-research-machine-intake-repository-open.mjs';
import {
  AUTONOMOUS_RESEARCH_MACHINE_INTAKE_DATABASE_INSTANCE_ID,
  AUTONOMOUS_RESEARCH_MACHINE_INTAKE_SCHEMA_CONTRACT_ID,
  AUTONOMOUS_RESEARCH_MACHINE_INTAKE_WRITER_ID,
  createOfflineMachineIntakeMutationCoordinator,
} from './autonomous-research-machine-intake-mutation-plan.mjs';
import {
  assertExternallyFencedSqliteMutationCoordinatorPort,
} from '../../paper-ports/autonomous-research-online-mutation-port.mjs';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,255}$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const MAXIMUM_INTAKE_BYTES = 1024 * 1024;
const MACHINE_ADMISSION_MAXIMUM_AGE_MS = 5 * 60 * 1000;
const MAXIMUM_DEFER_MS = 12 * 60 * 60 * 1000;

export const AUTONOMOUS_RESEARCH_MACHINE_INTAKE_ADMISSION_LIMITS = Object.freeze({
  maximumPendingIntakes: 4096,
  maximumPendingNonRecurringIntakes: 4000,
  maximumMachineAppendsPerUtcDay: 256,
  maximumMachineReservedCostUsdPerUtcDay: 2400,
  maximumMachineReservedAgentCallsPerUtcDay: 1152,
  maximumMachineReservedGpuJobsPerUtcDay: 384,
});

function hasControlCharacters(value) {
  return [...value].some((character) => {
    const point = character.codePointAt(0);
    return point < 32 || point === 127;
  });
}

export function createAutonomousResearchMachineIntakeRepository({
  runtimeRoot,
  create = true,
  busyTimeoutMs = 10_000,
  authorizedSourceAuthorityHash = null,
  authorizedMachineProducerProfileHash = null,
  machineProducerAppendAuthority = null,
  migrationHooks = {},
  offlineProvision = create,
  mutationCoordinator = null,
  databaseInstanceId = AUTONOMOUS_RESEARCH_MACHINE_INTAKE_DATABASE_INSTANCE_ID,
  schemaContractId = AUTONOMOUS_RESEARCH_MACHINE_INTAKE_SCHEMA_CONTRACT_ID,
  writerId = AUTONOMOUS_RESEARCH_MACHINE_INTAKE_WRITER_ID,
  requireExternallyFencedMutations = false,
} = {}) {
  if (typeof offlineProvision !== 'boolean'
    || typeof requireExternallyFencedMutations !== 'boolean'
    || !SAFE_ID.test(String(databaseInstanceId || ''))
    || !SAFE_ID.test(String(schemaContractId || ''))
    || !SAFE_ID.test(String(writerId || ''))) {
    throw new Error('autonomous_research_machine_intake_repository_configuration_invalid');
  }
  let coordinator = mutationCoordinator;
  if (coordinator !== null) assertExternallyFencedSqliteMutationCoordinatorPort(coordinator);
  if (requireExternallyFencedMutations) {
    const status = coordinator?.inspectStatus();
    if (!create || offlineProvision || coordinator?.implemented !== true
      || status?.implemented !== true
      || status.status !== 'externally_fenced_sqlite_mutation_coordinator_ready'
      || !Array.isArray(status.blockers) || status.blockers.length !== 0
      || !coordinator.coveredDatabaseRoles?.includes('machine-intake')
      || !status.coveredDatabaseRoles?.includes('machine-intake')) {
      throw new Error('autonomous_research_machine_intake_external_mutation_coordinator_required');
    }
  }
  coordinator ||= createOfflineMachineIntakeMutationCoordinator({
    databaseInstanceId,
    schemaContractId,
    writerId,
  });
  const {
    database,
    databasePath,
    schemaMigration,
    configuredSourceAuthorityHash,
    configuredMachineProducerProfileHash,
    configuredAuthorityGeneration,
    offlineProvisioningPerformed,
  } = openAutonomousResearchMachineIntakeRepository({
    runtimeRoot,
    create,
    busyTimeoutMs,
    authorizedSourceAuthorityHash,
    authorizedMachineProducerProfileHash,
    machineProducerAppendAuthority,
    migrationHooks,
    offlineProvision,
  });
  let closed = false;

  function requireDatabase({ writable = false } = {}) {
    if (closed) throw new Error('autonomous_research_machine_intake_repository_closed');
    if (!database) {
      if (writable) throw new Error('autonomous_research_machine_intake_repository_read_only');
      return null;
    }
    if (writable && !create) {
      throw new Error('autonomous_research_machine_intake_repository_read_only');
    }
    return database;
  }

  function assertCurrentTransactionAuthority(transaction) {
    const metadata = transaction.get('authority.metadata.current.get.v1');
    const persisted = assertMachineIntakeAuthorityEvidence({
      configuredSourceAuthorityHash: metadata?.configured_source_authority_hash,
      authorizedMachineProducerProfileHash:
        metadata?.authorized_machine_producer_profile_hash ?? null,
      authorityGeneration: Number(metadata?.authority_generation),
      lastAuthorityRotationReceiptHash:
        metadata?.last_authority_rotation_receipt_hash ?? null,
      journal: transaction.all('authority.rotation.all.v1'),
      genesis: transaction.all('authority.genesis.all.v1'),
    });
    if (persisted.configuredSourceAuthorityHash !== configuredSourceAuthorityHash
      || persisted.authorizedMachineProducerProfileHash
        !== configuredMachineProducerProfileHash
      || persisted.authorityGeneration !== configuredAuthorityGeneration) {
      throw new Error('autonomous_research_machine_intake_repository_authority_stale');
    }
    return persisted;
  }

  function mutationValue(receipt) {
    if (!receipt || !Object.prototype.hasOwnProperty.call(receipt, 'value')) {
      throw new Error('autonomous_research_machine_intake_mutation_receipt_invalid');
    }
    return receipt.value;
  }

  function mutationInput(mutate, authorizationReceiptHashes = []) {
    return {
      database,
      databaseInstanceId,
      schemaContractId,
      writerId,
      authorizationReceiptHashes,
      sideEffectReservationHashes: [],
      mutate(transaction) {
        assertCurrentTransactionAuthority(transaction);
        return mutate(transaction);
      },
    };
  }

  function supersedePriorRecurringEpochs(transaction, intake, timestamp) {
    const templatePrefix = `${intake.recurringGoldenProvenance.templateId}@`;
    transaction.run('append.recurring-supersede.apply.v1',
      timestamp, templatePrefix.length, templatePrefix, intake.intakeId, timestamp,
    );
    transaction.run('append.recurring-lease-retire.apply.v1');
  }

  function readIntake(intakeId) {
    if (!SAFE_ID.test(String(intakeId || ''))) {
      throw new Error('autonomous_research_machine_intake_id_invalid');
    }
    const db = requireDatabase();
    if (!db) return null;
    return parseRow(db.prepare(`${SELECT_RECORD} WHERE i.intake_id=?`).get(intakeId));
  }

  function listPendingIntakes({ limit = 100, now = new Date() } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) {
      throw new Error('autonomous_research_machine_intake_list_limit_invalid');
    }
    const db = requireDatabase();
    if (!db) return Object.freeze([]);
    const timestamp = observedDate(now).toISOString();
    return Object.freeze(db.prepare(`${SELECT_RECORD}
      WHERE i.disposition='pending' AND i.next_attempt_at<=?
      ORDER BY CASE i.source_kind WHEN 'recurring-golden' THEN 0 ELSE 1 END,
      CASE WHEN i.source_kind='recurring-golden' THEN i.created_at END DESC,
      i.next_attempt_at,i.created_at,i.intake_id LIMIT ?`)
      .all(timestamp, limit).map(parseRow));
  }

  function listEnqueuedIntakes({ limit = 100 } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) {
      throw new Error('autonomous_research_machine_intake_list_limit_invalid');
    }
    const db = requireDatabase();
    if (!db) return Object.freeze([]);
    return Object.freeze(db.prepare(`${SELECT_RECORD}
      WHERE i.disposition='enqueued' ORDER BY i.enqueued_at,i.intake_id LIMIT ?`)
      .all(limit).map(parseRow));
  }

  function appendIntake({
    intake,
    sourceKind,
    sourceRef = '',
    sourceAuthorityHash,
    sourceTemplate = null,
    topicProducerCapabilityReceipt = null,
    topicProducerAppendAuthorization = null,
    now = new Date(),
  } = {}) {
    requireDatabase({ writable: true });
    if (!verifyAutonomousResearchMachineIntake(intake)) {
      throw new Error('autonomous_research_machine_intake_invalid');
    }
    const source = canonicalSource({
      intake,
      sourceKind,
      sourceRef,
      sourceAuthorityHash,
      authorizedSourceAuthorityHash,
      sourceTemplate,
    });
    const serialized = JSON.stringify(intake);
    const admission = buildAutonomousResearchMachineIntakeAdmission({
      intake,
      sourceKind: source.sourceKind,
      sourceAuthorityHash: source.sourceAuthorityHash,
      topicProducerCapabilityReceipt,
    });
    const serializedAdmission = JSON.stringify(admission);
    if (Buffer.byteLength(serialized) > MAXIMUM_INTAKE_BYTES) {
      throw new Error('autonomous_research_machine_intake_too_large');
    }
    const observedAt = observedDate(now);
    const timestamp = observedAt.toISOString();
    const admittedAtMs = Date.parse(intake.admissionCreatedAt);
    if (sourceKind === 'machine' && (admittedAtMs > observedAt.getTime()
      || observedAt.getTime() - admittedAtMs > MACHINE_ADMISSION_MAXIMUM_AGE_MS)) {
      throw new Error('autonomous_research_machine_intake_admission_time_invalid');
    }
    if (sourceKind === 'machine' && configuredMachineProducerProfileHash) {
      if (admission.version !== 2
        || topicProducerCapabilityReceipt?.producerProfileHash
          !== configuredMachineProducerProfileHash) {
        throw new Error('autonomous_research_machine_intake_producer_capability_required');
      }
      machineProducerAppendAuthority.consumeAppendAuthorization({
        authorization: topicProducerAppendAuthorization,
        intake,
        capability: topicProducerCapabilityReceipt,
        now: observedAt,
      });
    }
    if (sourceKind === 'recurring-golden') {
      const epochStartMs = Date.parse(intake.recurringGoldenProvenance.epochStart);
      if (observedAt.getTime() < epochStartMs
        || observedAt.getTime() >= epochStartMs + intake.recurringGoldenProvenance.epochDurationMs) {
        throw new Error('autonomous_research_recurring_golden_epoch_not_current');
      }
    }
    return mutationValue(coordinator.executeMutation({
      databaseRole: 'machine-intake', operationId: 'machine-intake.machine-intake-repository.appendIntake.v1',
      ...mutationInput((transaction) => {
        if (sourceKind === 'recurring-golden') {
          // A replay of the current epoch retires any older epoch once its lease expires.
          supersedePriorRecurringEpochs(transaction, intake, timestamp);
        }
        const byIdentity = transaction.all(
          'append.identity.all.v1', intake.intakeId, intake.campaignId, intake.intakeHash,
        );
      if (byIdentity.length) {
        const idempotent = byIdentity.length === 1
          && byIdentity[0].intake_id === intake.intakeId
          && byIdentity[0].campaign_id === intake.campaignId
          && byIdentity[0].intake_hash === intake.intakeHash
          && byIdentity[0].source_kind === source.sourceKind
          && byIdentity[0].source_ref === source.sourceRef
          && byIdentity[0].source_authority_hash === source.sourceAuthorityHash
          && byIdentity[0].admission_hash
            === admission.autonomousResearchMachineIntakeAdmissionHash;
        if (!idempotent) {
          throw new Error('autonomous_research_machine_intake_identity_conflict');
        }
          return Object.freeze({
            inserted: false,
            idempotent: true,
            record: parseRow(transaction.get('append.record-current.get.v1', intake.intakeId)),
          });
      }
        const pendingCount = Number(transaction.get('append.pending-count.get.v1').count);
        const pendingNonRecurringCount = Number(
          transaction.get('append.pending-non-recurring-count.get.v1').count,
        );
      const limits = AUTONOMOUS_RESEARCH_MACHINE_INTAKE_ADMISSION_LIMITS;
      if (pendingCount >= limits.maximumPendingIntakes
        || (sourceKind !== 'recurring-golden'
          && pendingNonRecurringCount >= limits.maximumPendingNonRecurringIntakes)) {
        throw new Error('autonomous_research_machine_intake_pending_queue_limit_exhausted');
      }
      if (sourceKind === 'machine') {
        const epochStart = utcDayStart(observedAt);
          transaction.run(
            'append.daily-create.apply.v1', epochStart, 0, 0, 0, 0, timestamp,
          );
          const daily = transaction.get('append.daily-current.get.v1', epochStart);
        const next = Object.freeze({
          count: Number(daily.machine_append_count) + 1,
          cost: Number(daily.reserved_cost_usd) + intake.budgets.maxCostUsd,
          calls: Number(daily.reserved_agent_calls) + intake.budgets.maxAgentCalls,
          gpu: Number(daily.reserved_gpu_jobs) + intake.budgets.maxGpuJobs,
        });
        if (next.count > limits.maximumMachineAppendsPerUtcDay
          || next.cost > limits.maximumMachineReservedCostUsdPerUtcDay
          || next.calls > limits.maximumMachineReservedAgentCallsPerUtcDay
          || next.gpu > limits.maximumMachineReservedGpuJobsPerUtcDay) {
          throw new Error('autonomous_research_machine_intake_daily_admission_budget_exhausted');
        }
          transaction.run(
            'append.daily-update.apply.v1',
            next.count, next.cost, next.calls, next.gpu, timestamp, epochStart,
          );
      }
        transaction.run(
          'append.intake-create.apply.v1',
          intake.intakeId, intake.intakeHash, intake.paperId, intake.campaignId, serialized,
          serializedAdmission, admission.autonomousResearchMachineIntakeAdmissionHash,
          source.sourceKind, source.sourceRef, source.sourceAuthorityHash, 'pending', 0, 0,
          timestamp, timestamp, timestamp,
        );
        return Object.freeze({
          inserted: true,
          idempotent: false,
          record: parseRow(transaction.get('append.record-current.get.v1', intake.intakeId)),
        });
      },
      sourceKind === 'machine' && topicProducerAppendAuthorization?.capabilityHash
        ? [topicProducerAppendAuthorization.capabilityHash] : [],
      ),
    }));
  }

  return Object.freeze({
    version: 1,
    kind: 'AutonomousResearchMachineIntakeRepository',
    databasePath,
    authorizedSourceAuthorityHash,
    configuredSourceAuthorityHash,
    configuredMachineProducerProfileHash,
    configuredAuthorityGeneration,
    schemaMigration,
    offlineProvisioningPerformed,
    externallyFencedMutations: coordinator.implemented === true,
    externallyFencedMutationsRequired: requireExternallyFencedMutations,
    databaseInstanceId,
    schemaContractId,
    writerId,
    durable: true,
    sqliteCompareAndSwap: true,
    leaseFencing: true,
    readIntake,
    listPendingIntakes,
    listEnqueuedIntakes,
    readStatus({ limit = 100, now = new Date() } = {}) {
      const db = requireDatabase();
      if (!db) return Object.freeze({
        configuredSourceAuthorityHash: null,
        configuredMachineProducerProfileHash: null,
        configuredAuthorityGeneration: null,
        pendingCount: 0,
        pendingProductionCount: 0,
        enqueuedCount: 0,
        invalidCount: 0,
        supersededCount: 0,
        pending: Object.freeze([]),
      });
      const counts = Object.fromEntries(db.prepare(`SELECT disposition,COUNT(*) AS count
        FROM autonomous_research_machine_intake GROUP BY disposition`).all()
        .map((row) => [row.disposition, Number(row.count)]));
      const pendingProductionCount = Number(db.prepare(`SELECT COUNT(*) AS count FROM
        autonomous_research_machine_intake WHERE disposition='pending'
        AND source_kind IN ('machine','static-file')`).get().count);
      return Object.freeze({
        configuredSourceAuthorityHash,
        configuredMachineProducerProfileHash,
        configuredAuthorityGeneration,
        pendingCount: counts.pending || 0,
        pendingProductionCount,
        enqueuedCount: counts.enqueued || 0,
        invalidCount: counts.invalid || 0,
        supersededCount: counts.superseded || 0,
        pending: listPendingIntakes({ limit, now }),
      });
    },
    appendIntake,
    appendMachineIntake({
      intake,
      sourceAuthorityHash,
      topicProducerCapabilityReceipt = null,
      topicProducerAppendAuthorization = null,
      now = new Date(),
    } = {}) {
      return appendIntake({
        intake,
        sourceKind: 'machine',
        sourceRef: 'machine-api',
        sourceAuthorityHash,
        topicProducerCapabilityReceipt,
        topicProducerAppendAuthorization,
        now,
      });
    },
    tryAcquireIntakeLease({ intakeId, ownerId, leaseMs, now = new Date() } = {}) {
      requireDatabase({ writable: true });
      if (![intakeId, ownerId].every((value) => SAFE_ID.test(String(value || '')))) {
        throw new Error('autonomous_research_machine_intake_lease_owner_invalid');
      }
      const observedAt = observedDate(now);
      const duration = leaseDuration(leaseMs);
      return mutationValue(coordinator.executeMutation({
        databaseRole: 'machine-intake', operationId: 'machine-intake.machine-intake-repository.tryAcquireIntakeLease.v1',
        ...mutationInput((transaction) => {
          const intakeRow = transaction.get('acquire.intake-current.get.v1', intakeId);
        if (!intakeRow || intakeRow.disposition !== 'pending'
          || intakeRow.next_attempt_at > observedAt.toISOString()) {
          return null;
        }
        if (!recurringEpochCurrent(intakeRow, observedAt)) {
            transaction.run(
              'acquire.intake-supersede.apply.v1', observedAt.toISOString(), intakeId,
            );
            transaction.run('acquire.lease-delete.apply.v1', intakeId);
          return null;
        }
          const current = transaction.get('acquire.lease-current.get.v1', intakeId);
        if (current && Date.parse(current.expires_at) > observedAt.getTime()) {
          return null;
        }
        const leaseGeneration = Number(intakeRow.lease_generation) + 1;
        const leaseToken = `intake-lease:${crypto.randomUUID()}`;
        const expiresAt = new Date(observedAt.getTime() + duration).toISOString();
          const updated = transaction.run(
            'acquire.intake-generation-update.apply.v1',
            leaseGeneration, observedAt.toISOString(), intakeId,
          );
          if (Number(updated.changes) !== 1) {
            throw new Error('autonomous_research_machine_intake_lease_fence_conflict');
          }
          transaction.run('acquire.lease-upsert.apply.v1',
          intakeId, ownerId, leaseToken, leaseGeneration, observedAt.toISOString(),
          observedAt.toISOString(), expiresAt,
        );
        return Object.freeze({ ownerId, leaseToken, leaseGeneration, expiresAt });
        }),
      }));
    },
    renewIntakeLease({ intakeId, ownerId, leaseToken, leaseGeneration, leaseMs, now = new Date() } = {}) {
      requireDatabase({ writable: true });
      const lease = identity({ intakeId, ownerId, leaseToken, leaseGeneration });
      const observedAt = observedDate(now);
      const duration = leaseDuration(leaseMs);
      const expiresAt = new Date(observedAt.getTime() + duration).toISOString();
      return mutationValue(coordinator.executeMutation({
        databaseRole: 'machine-intake', operationId: 'machine-intake.machine-intake-repository.renewIntakeLease.v1',
        ...mutationInput((transaction) => {
          const intakeRow = transaction.get('renew.intake-current.get.v1', lease.intakeId);
          if (!intakeRow || !recurringEpochCurrent(intakeRow, observedAt)) return null;
          const result = transaction.run('renew.lease-update.apply.v1',
          observedAt.toISOString(), expiresAt, lease.intakeId, lease.ownerId, lease.leaseToken,
          lease.leaseGeneration, observedAt.toISOString(),
        );
        return Number(result.changes) === 1 ? Object.freeze({ ...lease, expiresAt }) : null;
        }),
      }));
    },
    assertIntakeLease({ intakeId, ownerId, leaseToken, leaseGeneration, now = new Date() } = {}) {
      const db = requireDatabase();
      const lease = identity({ intakeId, ownerId, leaseToken, leaseGeneration });
      const timestamp = observedDate(now).toISOString();
      const active = db.prepare(`SELECT i.disposition,i.lease_generation,i.source_kind,i.intake_json,
        l.owner_id,l.lease_token,l.lease_generation AS active_lease_generation,l.expires_at
        FROM autonomous_research_machine_intake i
        JOIN autonomous_research_machine_intake_lease l ON l.intake_id=i.intake_id
        WHERE i.intake_id=?`).get(lease.intakeId);
      if (!active || active.disposition !== 'pending'
        || Number(active.lease_generation) !== lease.leaseGeneration
        || active.owner_id !== lease.ownerId || active.lease_token !== lease.leaseToken
        || Number(active.active_lease_generation) !== lease.leaseGeneration
        || active.expires_at <= timestamp || !recurringEpochCurrent(active, observedDate(now))) {
        throw new Error('autonomous_research_machine_intake_lease_fence_conflict');
      }
      return Object.freeze({ ...lease, expiresAt: active.expires_at });
    },
    releaseIntakeLease(leaseValue = {}) {
      requireDatabase({ writable: true });
      const lease = identity(leaseValue);
      return mutationValue(coordinator.executeMutation({
        databaseRole: 'machine-intake', operationId: 'machine-intake.machine-intake-repository.releaseIntakeLease.v1',
        ...mutationInput((transaction) => {
          const result = transaction.run('release.lease-delete.apply.v1',
          lease.intakeId, lease.ownerId, lease.leaseToken, lease.leaseGeneration,
        );
        return Number(result.changes) === 1;
        }),
      }));
    },
    deferIntake({
      intakeId,
      ownerId,
      leaseToken,
      leaseGeneration,
      error,
      retryAfterMs,
      now = new Date(),
    } = {}) {
      requireDatabase({ writable: true });
      const lease = identity({ intakeId, ownerId, leaseToken, leaseGeneration });
      if (!Number.isSafeInteger(retryAfterMs) || retryAfterMs < 1000
        || retryAfterMs > MAXIMUM_DEFER_MS) {
        throw new Error('autonomous_research_machine_intake_retry_delay_invalid');
      }
      const errorText = String(error?.message || error || 'machine_intake_deferred').slice(0, 1024);
      if (!errorText || hasControlCharacters(errorText)) {
        throw new Error('autonomous_research_machine_intake_retry_error_invalid');
      }
      const observedAt = observedDate(now);
      const timestamp = observedAt.toISOString();
      const nextAttemptAt = new Date(observedAt.getTime() + retryAfterMs).toISOString();
      return mutationValue(coordinator.executeMutation({
        databaseRole: 'machine-intake', operationId: 'machine-intake.machine-intake-repository.deferIntake.v1',
        ...mutationInput((transaction) => {
          const active = transaction.get('defer.active.get.v1', lease.intakeId);
        if (!active || active.disposition !== 'pending'
          || Number(active.lease_generation) !== lease.leaseGeneration
          || active.owner_id !== lease.ownerId || active.lease_token !== lease.leaseToken
          || Number(active.active_lease_generation) !== lease.leaseGeneration
          || active.expires_at <= timestamp) {
          throw new Error('autonomous_research_machine_intake_lease_fence_conflict');
        }
          const updated = transaction.run('defer.intake-update.apply.v1',
          nextAttemptAt, errorText, timestamp, lease.intakeId, lease.leaseGeneration,
        );
        if (Number(updated.changes) !== 1) {
          throw new Error('autonomous_research_machine_intake_lease_fence_conflict');
        }
          transaction.run('defer.lease-delete.apply.v1',
          lease.intakeId, lease.ownerId, lease.leaseToken, lease.leaseGeneration,
        );
          return parseRow(transaction.get('defer.record-current.get.v1', lease.intakeId));
        }),
      }));
    },
    markIntakeEnqueued({
      intakeId,
      ownerId,
      leaseToken,
      leaseGeneration,
      autonomousResearchMachineIntakeAdmissionHash,
      campaignPlanHash,
      autonomousResearchLoopPreparationReportHash,
      now = new Date(),
    } = {}) {
      requireDatabase({ writable: true });
      const lease = identity({ intakeId, ownerId, leaseToken, leaseGeneration });
      if (![
        autonomousResearchMachineIntakeAdmissionHash,
        campaignPlanHash,
        autonomousResearchLoopPreparationReportHash,
      ].every((value) => SHA256.test(String(value || '')))) {
        throw new Error('autonomous_research_machine_intake_enqueue_binding_invalid');
      }
      const timestamp = observedDate(now).toISOString();
      return mutationValue(coordinator.executeMutation({
        databaseRole: 'machine-intake', operationId: 'machine-intake.machine-intake-repository.markIntakeEnqueued.v1',
        ...mutationInput((transaction) => {
          const active = transaction.get('enqueue.active.get.v1', lease.intakeId);
        if (!active || active.owner_id !== lease.ownerId || active.lease_token !== lease.leaseToken
          || Number(active.lease_generation) !== lease.leaseGeneration
          || active.admission_hash !== autonomousResearchMachineIntakeAdmissionHash
          || active.expires_at <= timestamp
          || !recurringEpochCurrent(active, observedDate(now))) {
          throw new Error('autonomous_research_machine_intake_lease_fence_conflict');
        }
          const result = transaction.run('enqueue.intake-update.apply.v1',
          campaignPlanHash, autonomousResearchLoopPreparationReportHash, timestamp, timestamp,
          lease.intakeId, lease.leaseGeneration, autonomousResearchMachineIntakeAdmissionHash,
        );
        if (Number(result.changes) !== 1) {
          throw new Error('autonomous_research_machine_intake_lease_fence_conflict');
        }
          transaction.run('enqueue.lease-delete.apply.v1',
          lease.intakeId, lease.ownerId, lease.leaseToken, lease.leaseGeneration,
        );
          return parseRow(transaction.get('enqueue.record-current.get.v1', lease.intakeId));
        },
        [
          autonomousResearchMachineIntakeAdmissionHash,
          campaignPlanHash,
          autonomousResearchLoopPreparationReportHash,
        ],
        ),
      }));
    },
    markEnqueuedIntakeInvalid({
      intakeId,
      autonomousResearchMachineIntakeAdmissionHash,
      reason,
      now = new Date(),
    } = {}) {
      requireDatabase({ writable: true });
      if (!SAFE_ID.test(String(intakeId || ''))
        || !SHA256.test(String(autonomousResearchMachineIntakeAdmissionHash || ''))) {
        throw new Error('autonomous_research_machine_intake_invalid_transition_identity_invalid');
      }
      const reasonText = String(reason || '').slice(0, 1024);
      if (!reasonText || hasControlCharacters(reasonText)) {
        throw new Error('autonomous_research_machine_intake_invalid_transition_reason_invalid');
      }
      const timestamp = observedDate(now).toISOString();
      return mutationValue(coordinator.executeMutation({
        databaseRole: 'machine-intake', operationId: 'machine-intake.machine-intake-repository.markEnqueuedIntakeInvalid.v1',
        ...mutationInput((transaction) => {
          const result = transaction.run('invalid.intake-update.apply.v1',
          reasonText,
          timestamp,
          intakeId,
          autonomousResearchMachineIntakeAdmissionHash,
        );
        if (Number(result.changes) === 1) {
            return parseRow(transaction.get('invalid.record-current.get.v1', intakeId));
        }
          const current = parseRow(transaction.get('invalid.record-current.get.v1', intakeId));
        if (current?.disposition === 'invalid'
          && current.admissionHash === autonomousResearchMachineIntakeAdmissionHash
          && current.invalidReason === reasonText) {
          return current;
        }
        throw new Error('autonomous_research_machine_intake_invalid_transition_conflict');
        },
        [autonomousResearchMachineIntakeAdmissionHash],
        ),
      }));
    },
    reconcileExpiredIntakeLeases({ now = new Date() } = {}) {
      requireDatabase({ writable: true });
      const reconciledAt = observedDate(now).toISOString();
      return mutationValue(coordinator.executeMutation({
        databaseRole: 'machine-intake', operationId: 'machine-intake.machine-intake-repository.reconcileExpiredIntakeLeases.v1',
        ...mutationInput((transaction) => {
          const result = transaction.run('reconcile.lease-delete.apply.v1', reconciledAt);
          return Object.freeze({ recoveredLeaseCount: Number(result.changes), reconciledAt });
        }),
      }));
    },
    close() {
      if (!closed) database?.close();
      closed = true;
    },
  });
}
