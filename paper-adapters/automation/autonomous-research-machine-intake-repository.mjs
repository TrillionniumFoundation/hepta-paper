import crypto from 'node:crypto';

import {
  verifyAutonomousResearchMachineIntake,
} from '../../paper-domain/automation/autonomous-research-machine-intake-contract.mjs';
import {
  buildAutonomousResearchMachineIntakeAdmission,
} from '../../paper-domain/automation/autonomous-research-machine-intake-admission-contract.mjs';
import {
  assertMachineIntakeAuthorityState,
  readAuthorizedMachineProducerProfileHash,
  readConfiguredSourceAuthorityHash,
  readMachineIntakeAuthorityGeneration,
} from './autonomous-research-machine-intake-authority.mjs';
import {
  SELECT_RECORD,
  begin,
  canonicalSource,
  identity,
  leaseDuration,
  observedDate,
  parseRow,
  recurringEpochCurrent,
  rollback,
  utcDayStart,
} from './autonomous-research-machine-intake-repository-support.mjs';
import {
  openAutonomousResearchMachineIntakeRepository,
} from './autonomous-research-machine-intake-repository-open.mjs';

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
} = {}) {
  const {
    database,
    databasePath,
    schemaMigration,
    configuredSourceAuthorityHash,
    configuredMachineProducerProfileHash,
    configuredAuthorityGeneration,
  } = openAutonomousResearchMachineIntakeRepository({
    runtimeRoot,
    create,
    busyTimeoutMs,
    authorizedSourceAuthorityHash,
    authorizedMachineProducerProfileHash,
    machineProducerAppendAuthority,
    migrationHooks,
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

  function assertCurrentRepositoryAuthority(db) {
    assertMachineIntakeAuthorityState(db);
    if (readConfiguredSourceAuthorityHash(db) !== configuredSourceAuthorityHash
      || readAuthorizedMachineProducerProfileHash(db)
        !== configuredMachineProducerProfileHash
      || readMachineIntakeAuthorityGeneration(db) !== configuredAuthorityGeneration) {
      throw new Error('autonomous_research_machine_intake_repository_authority_stale');
    }
  }

  function supersedePriorRecurringEpochs(db, intake, timestamp) {
    const templatePrefix = `${intake.recurringGoldenProvenance.templateId}@`;
    db.prepare(`UPDATE autonomous_research_machine_intake SET
      disposition='superseded',updated_at=?
      WHERE disposition='pending' AND source_kind='recurring-golden'
      AND substr(source_ref,1,?)=? AND intake_id<>?
      AND NOT EXISTS(
        SELECT 1 FROM autonomous_research_machine_intake_lease l
        WHERE l.intake_id=autonomous_research_machine_intake.intake_id AND l.expires_at>?
      )`).run(
      timestamp, templatePrefix.length, templatePrefix, intake.intakeId, timestamp,
    );
    db.prepare(`DELETE FROM autonomous_research_machine_intake_lease
      WHERE intake_id IN (
        SELECT intake_id FROM autonomous_research_machine_intake
        WHERE disposition='superseded'
      )`).run();
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
    const db = requireDatabase({ writable: true });
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
    try {
      begin(db);
      assertCurrentRepositoryAuthority(db);
      if (sourceKind === 'recurring-golden') {
        // Run this before the idempotent early return as well. If a previous epoch was
        // actively leased when the current epoch first appeared, the next current-epoch
        // replay must retire it after that lease expires.
        supersedePriorRecurringEpochs(db, intake, timestamp);
      }
      const byIdentity = db.prepare(`SELECT intake_id,intake_hash,campaign_id,
        source_kind,source_ref,source_authority_hash,admission_hash
        FROM autonomous_research_machine_intake
        WHERE intake_id=? OR campaign_id=? OR intake_hash=?`)
        .all(intake.intakeId, intake.campaignId, intake.intakeHash);
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
        db.exec('COMMIT;');
        return Object.freeze({ inserted: false, idempotent: true, record: readIntake(intake.intakeId) });
      }
      const pendingCount = Number(db.prepare(`SELECT COUNT(*) AS count
        FROM autonomous_research_machine_intake WHERE disposition='pending'`).get().count);
      const pendingNonRecurringCount = Number(db.prepare(`SELECT COUNT(*) AS count
        FROM autonomous_research_machine_intake
        WHERE disposition='pending' AND source_kind<>'recurring-golden'`).get().count);
      const limits = AUTONOMOUS_RESEARCH_MACHINE_INTAKE_ADMISSION_LIMITS;
      if (pendingCount >= limits.maximumPendingIntakes
        || (sourceKind !== 'recurring-golden'
          && pendingNonRecurringCount >= limits.maximumPendingNonRecurringIntakes)) {
        throw new Error('autonomous_research_machine_intake_pending_queue_limit_exhausted');
      }
      if (sourceKind === 'machine') {
        const epochStart = utcDayStart(observedAt);
        db.prepare(`INSERT OR IGNORE INTO autonomous_research_machine_intake_daily_admission(
          epoch_start,machine_append_count,reserved_cost_usd,reserved_agent_calls,
          reserved_gpu_jobs,updated_at
        ) VALUES(?,?,?,?,?,?)`).run(epochStart, 0, 0, 0, 0, timestamp);
        const daily = db.prepare(`SELECT * FROM autonomous_research_machine_intake_daily_admission
          WHERE epoch_start=?`).get(epochStart);
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
        db.prepare(`UPDATE autonomous_research_machine_intake_daily_admission SET
          machine_append_count=?,reserved_cost_usd=?,reserved_agent_calls=?,reserved_gpu_jobs=?,
          updated_at=? WHERE epoch_start=?`).run(
          next.count, next.cost, next.calls, next.gpu, timestamp, epochStart,
        );
      }
      db.prepare(`INSERT INTO autonomous_research_machine_intake(
        intake_id,intake_hash,paper_id,campaign_id,intake_json,admission_json,admission_hash,
        source_kind,source_ref,
        source_authority_hash,disposition,lease_generation,failure_count,next_attempt_at,
        created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        intake.intakeId, intake.intakeHash, intake.paperId, intake.campaignId, serialized,
        serializedAdmission, admission.autonomousResearchMachineIntakeAdmissionHash,
        source.sourceKind, source.sourceRef, source.sourceAuthorityHash, 'pending', 0, 0,
        timestamp, timestamp, timestamp,
      );
      db.exec('COMMIT;');
      return Object.freeze({ inserted: true, idempotent: false, record: readIntake(intake.intakeId) });
    } catch (error) {
      rollback(db);
      throw error;
    }
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
      const db = requireDatabase({ writable: true });
      if (![intakeId, ownerId].every((value) => SAFE_ID.test(String(value || '')))) {
        throw new Error('autonomous_research_machine_intake_lease_owner_invalid');
      }
      const observedAt = observedDate(now);
      const duration = leaseDuration(leaseMs);
      try {
        begin(db);
        assertCurrentRepositoryAuthority(db);
        const intakeRow = db.prepare(`SELECT disposition,lease_generation,next_attempt_at,
          source_kind,intake_json
          FROM autonomous_research_machine_intake WHERE intake_id=?`).get(intakeId);
        if (!intakeRow || intakeRow.disposition !== 'pending'
          || intakeRow.next_attempt_at > observedAt.toISOString()) {
          db.exec('COMMIT;');
          return null;
        }
        if (!recurringEpochCurrent(intakeRow, observedAt)) {
          db.prepare(`UPDATE autonomous_research_machine_intake SET
            disposition='superseded',updated_at=?
            WHERE intake_id=? AND disposition='pending'`).run(observedAt.toISOString(), intakeId);
          db.prepare(`DELETE FROM autonomous_research_machine_intake_lease
            WHERE intake_id=?`).run(intakeId);
          db.exec('COMMIT;');
          return null;
        }
        const current = db.prepare(`SELECT expires_at FROM autonomous_research_machine_intake_lease
          WHERE intake_id=?`).get(intakeId);
        if (current && Date.parse(current.expires_at) > observedAt.getTime()) {
          db.exec('COMMIT;');
          return null;
        }
        const leaseGeneration = Number(intakeRow.lease_generation) + 1;
        const leaseToken = `intake-lease:${crypto.randomUUID()}`;
        const expiresAt = new Date(observedAt.getTime() + duration).toISOString();
        db.prepare(`UPDATE autonomous_research_machine_intake
          SET lease_generation=?,updated_at=? WHERE intake_id=? AND disposition='pending'`)
          .run(leaseGeneration, observedAt.toISOString(), intakeId);
        db.prepare(`INSERT INTO autonomous_research_machine_intake_lease(
          intake_id,owner_id,lease_token,lease_generation,acquired_at,renewed_at,expires_at
        ) VALUES(?,?,?,?,?,?,?) ON CONFLICT(intake_id) DO UPDATE SET
          owner_id=excluded.owner_id,lease_token=excluded.lease_token,
          lease_generation=excluded.lease_generation,acquired_at=excluded.acquired_at,
          renewed_at=excluded.renewed_at,expires_at=excluded.expires_at`).run(
          intakeId, ownerId, leaseToken, leaseGeneration, observedAt.toISOString(),
          observedAt.toISOString(), expiresAt,
        );
        db.exec('COMMIT;');
        return Object.freeze({ ownerId, leaseToken, leaseGeneration, expiresAt });
      } catch (error) {
        rollback(db);
        throw error;
      }
    },
    renewIntakeLease({ intakeId, ownerId, leaseToken, leaseGeneration, leaseMs, now = new Date() } = {}) {
      const db = requireDatabase({ writable: true });
      const lease = identity({ intakeId, ownerId, leaseToken, leaseGeneration });
      const observedAt = observedDate(now);
      const duration = leaseDuration(leaseMs);
      const intakeRow = db.prepare(`SELECT source_kind,intake_json
        FROM autonomous_research_machine_intake WHERE intake_id=?`).get(lease.intakeId);
      if (!intakeRow || !recurringEpochCurrent(intakeRow, observedAt)) return null;
      const expiresAt = new Date(observedAt.getTime() + duration).toISOString();
      try {
        begin(db);
        assertCurrentRepositoryAuthority(db);
        const result = db.prepare(`UPDATE autonomous_research_machine_intake_lease
          SET renewed_at=?,expires_at=? WHERE intake_id=? AND owner_id=? AND lease_token=?
          AND lease_generation=? AND expires_at>?`).run(
          observedAt.toISOString(), expiresAt, lease.intakeId, lease.ownerId, lease.leaseToken,
          lease.leaseGeneration, observedAt.toISOString(),
        );
        db.exec('COMMIT;');
        return Number(result.changes) === 1 ? Object.freeze({ ...lease, expiresAt }) : null;
      } catch (error) {
        rollback(db);
        throw error;
      }
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
      const db = requireDatabase({ writable: true });
      const lease = identity(leaseValue);
      try {
        begin(db);
        assertCurrentRepositoryAuthority(db);
        const result = db.prepare(`DELETE FROM autonomous_research_machine_intake_lease
          WHERE intake_id=? AND owner_id=? AND lease_token=? AND lease_generation=?`).run(
          lease.intakeId, lease.ownerId, lease.leaseToken, lease.leaseGeneration,
        );
        db.exec('COMMIT;');
        return Number(result.changes) === 1;
      } catch (error) {
        rollback(db);
        throw error;
      }
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
      const db = requireDatabase({ writable: true });
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
      try {
        begin(db);
        assertCurrentRepositoryAuthority(db);
        const active = db.prepare(`SELECT i.disposition,i.lease_generation,l.owner_id,
          l.lease_token,l.lease_generation AS active_lease_generation,l.expires_at
          FROM autonomous_research_machine_intake i
          JOIN autonomous_research_machine_intake_lease l ON l.intake_id=i.intake_id
          WHERE i.intake_id=?`).get(lease.intakeId);
        if (!active || active.disposition !== 'pending'
          || Number(active.lease_generation) !== lease.leaseGeneration
          || active.owner_id !== lease.ownerId || active.lease_token !== lease.leaseToken
          || Number(active.active_lease_generation) !== lease.leaseGeneration
          || active.expires_at <= timestamp) {
          throw new Error('autonomous_research_machine_intake_lease_fence_conflict');
        }
        const updated = db.prepare(`UPDATE autonomous_research_machine_intake SET
          failure_count=failure_count+1,next_attempt_at=?,last_error=?,updated_at=?
          WHERE intake_id=? AND disposition='pending' AND lease_generation=?`).run(
          nextAttemptAt, errorText, timestamp, lease.intakeId, lease.leaseGeneration,
        );
        if (Number(updated.changes) !== 1) {
          throw new Error('autonomous_research_machine_intake_lease_fence_conflict');
        }
        db.prepare(`DELETE FROM autonomous_research_machine_intake_lease
          WHERE intake_id=? AND owner_id=? AND lease_token=? AND lease_generation=?`).run(
          lease.intakeId, lease.ownerId, lease.leaseToken, lease.leaseGeneration,
        );
        db.exec('COMMIT;');
        return readIntake(lease.intakeId);
      } catch (caught) {
        rollback(db);
        throw caught;
      }
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
      const db = requireDatabase({ writable: true });
      const lease = identity({ intakeId, ownerId, leaseToken, leaseGeneration });
      if (![
        autonomousResearchMachineIntakeAdmissionHash,
        campaignPlanHash,
        autonomousResearchLoopPreparationReportHash,
      ].every((value) => SHA256.test(String(value || '')))) {
        throw new Error('autonomous_research_machine_intake_enqueue_binding_invalid');
      }
      const timestamp = observedDate(now).toISOString();
      try {
        begin(db);
        assertCurrentRepositoryAuthority(db);
        const active = db.prepare(`SELECT l.owner_id,l.lease_token,l.lease_generation,l.expires_at,
          i.source_kind,i.intake_json,i.admission_hash
          FROM autonomous_research_machine_intake_lease l
          JOIN autonomous_research_machine_intake i ON i.intake_id=l.intake_id
          WHERE l.intake_id=?`).get(lease.intakeId);
        if (!active || active.owner_id !== lease.ownerId || active.lease_token !== lease.leaseToken
          || Number(active.lease_generation) !== lease.leaseGeneration
          || active.admission_hash !== autonomousResearchMachineIntakeAdmissionHash
          || active.expires_at <= timestamp
          || !recurringEpochCurrent(active, observedDate(now))) {
          throw new Error('autonomous_research_machine_intake_lease_fence_conflict');
        }
        const result = db.prepare(`UPDATE autonomous_research_machine_intake SET
          disposition='enqueued',campaign_plan_hash=?,preparation_hash=?,enqueued_at=?,updated_at=?
          WHERE intake_id=? AND disposition='pending' AND lease_generation=?
          AND admission_hash=?`).run(
          campaignPlanHash, autonomousResearchLoopPreparationReportHash, timestamp, timestamp,
          lease.intakeId, lease.leaseGeneration, autonomousResearchMachineIntakeAdmissionHash,
        );
        if (Number(result.changes) !== 1) {
          throw new Error('autonomous_research_machine_intake_lease_fence_conflict');
        }
        db.prepare(`DELETE FROM autonomous_research_machine_intake_lease
          WHERE intake_id=? AND owner_id=? AND lease_token=? AND lease_generation=?`).run(
          lease.intakeId, lease.ownerId, lease.leaseToken, lease.leaseGeneration,
        );
        db.exec('COMMIT;');
        return readIntake(lease.intakeId);
      } catch (error) {
        rollback(db);
        throw error;
      }
    },
    markEnqueuedIntakeInvalid({
      intakeId,
      autonomousResearchMachineIntakeAdmissionHash,
      reason,
      now = new Date(),
    } = {}) {
      const db = requireDatabase({ writable: true });
      if (!SAFE_ID.test(String(intakeId || ''))
        || !SHA256.test(String(autonomousResearchMachineIntakeAdmissionHash || ''))) {
        throw new Error('autonomous_research_machine_intake_invalid_transition_identity_invalid');
      }
      const reasonText = String(reason || '').slice(0, 1024);
      if (!reasonText || hasControlCharacters(reasonText)) {
        throw new Error('autonomous_research_machine_intake_invalid_transition_reason_invalid');
      }
      const timestamp = observedDate(now).toISOString();
      try {
        begin(db);
        assertCurrentRepositoryAuthority(db);
        const result = db.prepare(`UPDATE autonomous_research_machine_intake SET
          disposition='invalid',invalid_reason=?,updated_at=?
          WHERE intake_id=? AND disposition='enqueued' AND admission_hash=?`).run(
          reasonText,
          timestamp,
          intakeId,
          autonomousResearchMachineIntakeAdmissionHash,
        );
        if (Number(result.changes) === 1) {
          db.exec('COMMIT;');
          return readIntake(intakeId);
        }
        const current = readIntake(intakeId);
        if (current?.disposition === 'invalid'
          && current.admissionHash === autonomousResearchMachineIntakeAdmissionHash
          && current.invalidReason === reasonText) {
          db.exec('COMMIT;');
          return current;
        }
        throw new Error('autonomous_research_machine_intake_invalid_transition_conflict');
      } catch (error) {
        rollback(db);
        throw error;
      }
    },
    reconcileExpiredIntakeLeases({ now = new Date() } = {}) {
      const db = requireDatabase({ writable: true });
      const reconciledAt = observedDate(now).toISOString();
      try {
        begin(db);
        assertCurrentRepositoryAuthority(db);
        const result = db.prepare(`DELETE FROM autonomous_research_machine_intake_lease
          WHERE expires_at<=?`).run(reconciledAt);
        db.exec('COMMIT;');
        return Object.freeze({ recoveredLeaseCount: Number(result.changes), reconciledAt });
      } catch (error) {
        rollback(db);
        throw error;
      }
    },
    close() {
      if (!closed) database?.close();
      closed = true;
    },
  });
}
