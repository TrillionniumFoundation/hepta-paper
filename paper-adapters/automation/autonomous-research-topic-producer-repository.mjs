import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  verifyAutonomousResearchTopicProducerCapabilityReceipt,
  verifyAutonomousResearchTopicProducerProfile,
} from '../../paper-domain/automation/autonomous-research-topic-producer-contract.mjs';
import {
  buildRegisteredAutonomousResearchTopicGeneration,
} from './autonomous-research-topic-producer-implementation.mjs';
import {
  createAutonomousResearchTopicProducerCanaryJournalOperations,
} from './autonomous-research-topic-producer-canary-journal-operations.mjs';
import {
  begin,
  createTopicProducerSchema,
  leaseDuration,
  leaseIdentity,
  observedDate,
  parseGeneration,
  rollback, topicProducerFailureInspectionSchemaCurrent,
  utcDayStart,
} from './autonomous-research-topic-producer-repository-support.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,255}$/;
const MAXIMUM_ADMISSION_AGE_MS = 5 * 60 * 1000;
const authorizations = new WeakMap();

export function createAutonomousResearchTopicProducerRepository({
  runtimeRoot,
  machineIntakeConfigurationHash,
  producerProfile,
  providerCanaryPairMaximumCostUsd,
  liveMutationAuthority,
  create = true,
  busyTimeoutMs = 10_000,
} = {}) {
  if (!runtimeRoot || !SHA256.test(String(machineIntakeConfigurationHash || ''))
    || !verifyAutonomousResearchTopicProducerProfile(producerProfile)
    || typeof providerCanaryPairMaximumCostUsd !== 'number'
    || !Number.isFinite(providerCanaryPairMaximumCostUsd)
    || providerCanaryPairMaximumCostUsd <= 0
    || providerCanaryPairMaximumCostUsd
      > producerProfile.maximumProviderCanaryCostUsdPerUtcDay
    || typeof liveMutationAuthority?.consume !== 'function'
    || !Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 1 || busyTimeoutMs > 60_000) {
    throw new Error('autonomous_research_topic_producer_repository_configuration_invalid');
  }
  const stateRoot = path.join(path.resolve(runtimeRoot), 'autonomous-research', 'topic-producer');
  const databasePath = path.join(stateRoot, 'topic-producer.sqlite');
  if (create) {
    fs.mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
    fs.chmodSync(stateRoot, 0o700);
    if (!fs.existsSync(databasePath)) fs.closeSync(fs.openSync(databasePath, 'wx', 0o600));
  }
  if (fs.existsSync(databasePath)) {
    const stat = fs.lstatSync(databasePath);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o022) !== 0) {
      throw new Error('autonomous_research_topic_producer_database_invalid');
    }
  }
  const database = fs.existsSync(databasePath)
    ? new DatabaseSync(databasePath, { readOnly: !create }) : null;
  if (database) database.exec(`PRAGMA busy_timeout=${busyTimeoutMs};`);
  if (database && create) {
    try {
      database.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;');
      createTopicProducerSchema(database, {
        machineIntakeConfigurationHash,
        producerProfileHash: producerProfile.producerProfileHash,
        providerConfigurationHash: producerProfile.providerConfigurationHash,
        implementationSha256: producerProfile.implementationSha256,
        providerCanaryPairMaximumCostUsd,
      });
      database.prepare(`INSERT OR IGNORE INTO autonomous_research_topic_producer_metadata(
        singleton,machine_intake_configuration_hash,producer_profile_hash,
        provider_configuration_hash,implementation_sha256
      ) VALUES(1,?,?,?,?)`).run(
        machineIntakeConfigurationHash,
        producerProfile.producerProfileHash,
        producerProfile.providerConfigurationHash,
        producerProfile.implementationSha256,
      );
      fs.chmodSync(databasePath, 0o600);
    } catch (error) {
      database.close();
      throw error;
    }
  }
  if (database && !topicProducerFailureInspectionSchemaCurrent(database)) {
    database.close(); throw new Error('autonomous_research_topic_producer_schema_upgrade_required');
  }
  if (database) {
    const metadata = database.prepare(
      'SELECT * FROM autonomous_research_topic_producer_metadata WHERE singleton=1',
    ).get();
    if (!metadata
      || metadata.machine_intake_configuration_hash !== machineIntakeConfigurationHash
      || metadata.producer_profile_hash !== producerProfile.producerProfileHash
      || metadata.provider_configuration_hash !== producerProfile.providerConfigurationHash
      || metadata.implementation_sha256 !== producerProfile.implementationSha256) {
      database.close();
      throw new Error('autonomous_research_topic_producer_authority_mismatch');
    }
  }
  let closed = false;

  function requireDatabase({ writable = false } = {}) {
    if (closed) throw new Error('autonomous_research_topic_producer_repository_closed');
    if (!database || (writable && !create)) {
      throw new Error('autonomous_research_topic_producer_repository_read_only');
    }
    return database;
  }

  function assertClock(db, observedAt, { update = false } = {}) {
    const metadata = db.prepare(`SELECT last_observed_at FROM
      autonomous_research_topic_producer_metadata WHERE singleton=1`).get();
    if (metadata.last_observed_at
      && observedAt.toISOString() < metadata.last_observed_at) {
      throw new Error('autonomous_research_topic_producer_clock_rollback_detected');
    }
    if (update) db.prepare(`UPDATE autonomous_research_topic_producer_metadata
      SET last_observed_at=? WHERE singleton=1`).run(observedAt.toISOString());
  }

  function activeLease(db, lease, observedAt) {
    const row = db.prepare(`SELECT * FROM autonomous_research_topic_producer_lease
      WHERE singleton=1`).get();
    return row && row.owner_id === lease.ownerId && row.lease_token === lease.leaseToken
      && Number(row.lease_generation) === lease.leaseGeneration
      && row.expires_at > observedAt.toISOString();
  }

  function assertLease({ lease, now = new Date() } = {}) {
    const db = requireDatabase();
    const identity = leaseIdentity(lease);
    const observedAt = observedDate(now);
    assertClock(db, observedAt);
    if (!activeLease(db, identity, observedAt)) {
      throw new Error('autonomous_research_topic_producer_lease_fence_conflict');
    }
    return Object.freeze({ ...identity, expiresAt: db.prepare(`SELECT expires_at FROM
      autonomous_research_topic_producer_lease WHERE singleton=1`).get().expires_at });
  }

  function readGeneration(sequence) {
    const db = requireDatabase();
    if (!Number.isSafeInteger(sequence) || sequence < 1) return null;
    return parseGeneration(db.prepare(`SELECT * FROM
      autonomous_research_topic_producer_generation WHERE generation_sequence=?`).get(sequence), {
      providerCanaryPairMaximumCostUsd,
      providerConfigurationHash: producerProfile.providerConfigurationHash,
    });
  }

  function latestGeneration() {
    const db = requireDatabase();
    return parseGeneration(db.prepare(`SELECT * FROM autonomous_research_topic_producer_generation
      ORDER BY generation_sequence DESC LIMIT 1`).get(), {
      providerCanaryPairMaximumCostUsd,
      providerConfigurationHash: producerProfile.providerConfigurationHash,
    });
  }

  const canaryJournalOperations =
    createAutonomousResearchTopicProducerCanaryJournalOperations({
      requireDatabase,
      assertClock,
      activeLease,
      producerProfile,
      providerCanaryPairMaximumCostUsd,
      readGeneration,
    });
  const {
    beginProviderCanaryAction,
    failGeneration,
    finishProviderCanaryAction,
    recoverInterruptedProviderCanary,
  } = canaryJournalOperations;

  function reserveCanary(db, observedAt) {
    const timestamp = observedAt.toISOString();
    const epochStart = utcDayStart(observedAt);
    db.prepare(`INSERT OR IGNORE INTO autonomous_research_topic_producer_daily_budget(
      epoch_start,provider_canary_attempt_count,provider_canary_reserved_cost_usd,
      produced_topic_count,updated_at) VALUES(?,?,?,?,?)`).run(epochStart, 0, 0, 0, timestamp);
    const daily = db.prepare(`SELECT * FROM autonomous_research_topic_producer_daily_budget
      WHERE epoch_start=?`).get(epochStart);
    const attempts = Number(daily.provider_canary_attempt_count) + 1;
    const cost = Number(daily.provider_canary_reserved_cost_usd)
      + providerCanaryPairMaximumCostUsd;
    if (attempts > producerProfile.maximumProviderCanaryAttemptsPerUtcDay
      || cost > producerProfile.maximumProviderCanaryCostUsdPerUtcDay) {
      throw new Error('autonomous_research_topic_producer_provider_canary_budget_exhausted');
    }
    db.prepare(`UPDATE autonomous_research_topic_producer_daily_budget SET
      provider_canary_attempt_count=?,provider_canary_reserved_cost_usd=?,updated_at=?
      WHERE epoch_start=?`).run(attempts, cost, timestamp, epochStart);
  }

  function prepareGeneration({ lease, now = new Date() } = {}) {
    const db = requireDatabase({ writable: true });
    const identity = leaseIdentity(lease);
    const observedAt = observedDate(now);
    const timestamp = observedAt.toISOString();
    try {
      begin(db);
      assertClock(db, observedAt, { update: true });
      if (!activeLease(db, identity, observedAt)) {
        throw new Error('autonomous_research_topic_producer_lease_fence_conflict');
      }
      const outstanding = db.prepare(`SELECT * FROM autonomous_research_topic_producer_generation
        WHERE status IN ('planned','authorized') ORDER BY generation_sequence LIMIT 1`).get();
      if (outstanding) {
        if (recoverInterruptedProviderCanary({
          database: db,
          row: outstanding,
          observedAt,
        })) {
          db.exec('COMMIT;');
          return null;
        }
        if (outstanding.budget_epoch_start !== utcDayStart(observedAt)) {
          db.prepare(`UPDATE autonomous_research_topic_producer_generation
            SET status='failed',error=?,updated_at=? WHERE generation_sequence=?`).run(
            'autonomous_research_topic_producer_budget_epoch_expired',
            timestamp,
            outstanding.generation_sequence,
          );
        } else {
        const intakeAge = observedAt.getTime() - Date.parse(
          JSON.parse(outstanding.planned_generation_json).admissionCreatedAt,
        );
        if (intakeAge < 0 || intakeAge > MAXIMUM_ADMISSION_AGE_MS) {
          db.prepare(`UPDATE autonomous_research_topic_producer_generation
            SET status='failed',error=?,updated_at=? WHERE generation_sequence=?`).run(
            'autonomous_research_topic_producer_planned_generation_expired',
            timestamp,
            outstanding.generation_sequence,
          );
        } else {
          if (outstanding.status === 'authorized') reserveCanary(db, observedAt);
          db.prepare(`UPDATE autonomous_research_topic_producer_generation SET
            status='planned',lease_generation=?,capability_hash=NULL,capability_nonce=NULL,
            capability_json=NULL,updated_at=? WHERE generation_sequence=?`).run(
            identity.leaseGeneration,
            timestamp,
            outstanding.generation_sequence,
          );
          db.exec('COMMIT;');
          return readGeneration(Number(outstanding.generation_sequence));
        }
        }
      }
      const metadata = db.prepare(`SELECT * FROM autonomous_research_topic_producer_metadata
        WHERE singleton=1`).get();
      if (metadata.next_attempt_at && metadata.next_attempt_at > timestamp) {
        db.exec('COMMIT;');
        return null;
      }
      if (metadata.last_produced_at
        && observedAt.getTime() - Date.parse(metadata.last_produced_at)
          < producerProfile.minimumGenerationIntervalMs) {
        db.exec('COMMIT;');
        return null;
      }
      const daily = db.prepare(`SELECT produced_topic_count FROM
        autonomous_research_topic_producer_daily_budget WHERE epoch_start=?`).get(
        utcDayStart(observedAt),
      );
      if (Number(daily?.produced_topic_count || 0) >= producerProfile.maximumTopicsPerUtcDay) {
        db.exec('COMMIT;');
        return null;
      }
      reserveCanary(db, observedAt);
      const epochStart = utcDayStart(observedAt);
      const reserved = db.prepare(`UPDATE autonomous_research_topic_producer_daily_budget SET
        produced_topic_count=produced_topic_count+1,updated_at=? WHERE epoch_start=?
        AND produced_topic_count<?`).run(
        timestamp,
        epochStart,
        producerProfile.maximumTopicsPerUtcDay,
      );
      if (Number(reserved.changes) !== 1) {
        throw new Error('autonomous_research_topic_producer_topic_budget_exhausted');
      }
      const sequence = Number(metadata.generation_high_watermark) + 1;
      const reservationId = `reservation:${crypto.randomUUID()}`;
      const planned = buildRegisteredAutonomousResearchTopicGeneration({
        producerProfile,
        generationSequence: sequence,
        admissionCreatedAt: timestamp,
        budgetReservationId: reservationId,
      });
      db.prepare(`INSERT INTO autonomous_research_topic_producer_generation(
        generation_sequence,status,lease_generation,producer_topic_id,topic_fingerprint,
        canonical_research_topic_hash,
        budget_reservation_id,budget_epoch_start,planned_generation_hash,
        planned_generation_json,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        sequence, 'planned', identity.leaseGeneration, planned.producerTopicId,
        planned.topicFingerprint, planned.canonicalResearchTopicHash,
        reservationId, planned.budgetEpochStart, planned.plannedGenerationHash,
        JSON.stringify(planned), timestamp, timestamp,
      );
      db.prepare(`UPDATE autonomous_research_topic_producer_metadata
        SET generation_high_watermark=? WHERE singleton=1`).run(sequence);
      db.exec('COMMIT;');
      return readGeneration(sequence);
    } catch (error) { rollback(db); throw error; }
  }

  function issueAppendAuthorization({
    lease,
    plannedGeneration,
    capability,
    intake,
    liveMutationAuthorization,
    now,
  } = {}) {
    const db = requireDatabase({ writable: true });
    const identity = leaseIdentity(lease);
    const observedAt = observedDate(now);
    if (!verifyAutonomousResearchTopicProducerCapabilityReceipt(capability, {
      producerProfile,
      machineIntakeConfigurationHash,
      intake,
      now: observedAt,
      requireFresh: true,
    }) || capability.producerLeaseGeneration !== identity.leaseGeneration
      || capability.producerLeaseTokenHash !== hashRecord(
        'AutonomousResearchTopicProducerLeaseToken',
        identity.leaseToken,
      )
      || capability.plannedGenerationHash !== plannedGeneration?.plannedGenerationHash) {
      throw new Error('autonomous_research_topic_producer_append_capability_invalid');
    }
    if (plannedGeneration.budgetEpochStart !== utcDayStart(observedAt)
      || capability.budgetEpochStart !== plannedGeneration.budgetEpochStart) {
      throw new Error('autonomous_research_topic_producer_budget_epoch_expired');
    }
    liveMutationAuthority.consume({
      authorization: liveMutationAuthorization,
      binding: Object.freeze({
        providerCanaryPairReceipt: capability.providerCanaryPairReceipt,
        capabilityNonce: capability.capabilityNonce,
        plannedGenerationHash: capability.plannedGenerationHash,
        producerLeaseGeneration: capability.producerLeaseGeneration,
        producerLeaseTokenHash: capability.producerLeaseTokenHash,
        residentLeaseGeneration: capability.residentLeaseGeneration,
        residentLeaseTokenHash: capability.residentLeaseTokenHash,
        liveBindingHash: hashRecord('AutonomousResearchTopicProducerLiveBinding', {
          plannedGenerationHash: capability.plannedGenerationHash,
          capabilityNonce: capability.capabilityNonce,
          producerLeaseGeneration: capability.producerLeaseGeneration,
          producerLeaseTokenHash: capability.producerLeaseTokenHash,
          residentLeaseGeneration: capability.residentLeaseGeneration,
          residentLeaseTokenHash: capability.residentLeaseTokenHash,
          providerCanaryPairReceiptHash: capability.providerCanaryPairReceiptHash,
        }),
      }),
      assertProducerLease: assertLease,
    });
    try {
      begin(db);
      assertClock(db, observedAt, { update: true });
      if (!activeLease(db, identity, observedAt)) {
        throw new Error('autonomous_research_topic_producer_lease_fence_conflict');
      }
      const result = db.prepare(`UPDATE autonomous_research_topic_producer_generation SET
        status='authorized',capability_hash=?,capability_nonce=?,capability_json=?,updated_at=?
        WHERE generation_sequence=? AND status='planned' AND lease_generation=?
        AND planned_generation_hash=? AND budget_reservation_id=?`).run(
        capability.autonomousResearchTopicProducerCapabilityReceiptHash,
        capability.capabilityNonce,
        JSON.stringify(capability),
        observedAt.toISOString(),
        capability.generationSequence,
        identity.leaseGeneration,
        plannedGeneration.plannedGenerationHash,
        plannedGeneration.budgetReservationId,
      );
      if (Number(result.changes) !== 1) {
        throw new Error('autonomous_research_topic_producer_generation_fence_conflict');
      }
      db.exec('COMMIT;');
    } catch (error) { rollback(db); throw error; }
    const authorization = Object.freeze({
      kind: 'AutonomousResearchTopicProducerAppendAuthorization',
      generationSequence: capability.generationSequence,
      capabilityHash: capability.autonomousResearchTopicProducerCapabilityReceiptHash,
      capabilityNonce: capability.capabilityNonce,
      intakeHash: intake.intakeHash,
      sourceAuthorityHash: machineIntakeConfigurationHash,
    });
    authorizations.set(authorization, Object.freeze({
      lease: identity,
      capability,
      plannedGeneration,
      intakeHash: intake.intakeHash,
    }));
    return authorization;
  }

  function consumeAppendAuthorization({ authorization, intake, capability, now } = {}) {
    const issued = authorizations.get(authorization);
    authorizations.delete(authorization);
    if (!issued || issued.capability !== capability
      || issued.intakeHash !== intake?.intakeHash
      || authorization.capabilityHash
        !== capability?.autonomousResearchTopicProducerCapabilityReceiptHash) {
      throw new Error('autonomous_research_topic_producer_append_authorization_invalid_or_replayed');
    }
    assertLease({ lease: issued.lease, now });
    const current = readGeneration(authorization.generationSequence);
    if (current?.status !== 'authorized'
      || current.leaseGeneration !== issued.lease.leaseGeneration
      || current.capability?.capabilityNonce !== authorization.capabilityNonce) {
      throw new Error('autonomous_research_topic_producer_generation_fence_conflict');
    }
    return true;
  }

  function completeGeneration({ lease, generationSequence, intakeRecord, now } = {}) {
    const db = requireDatabase({ writable: true });
    const identity = leaseIdentity(lease);
    const observedAt = observedDate(now);
    const timestamp = observedAt.toISOString();
    try {
      begin(db);
      assertClock(db, observedAt, { update: true });
      if (!activeLease(db, identity, observedAt)) {
        throw new Error('autonomous_research_topic_producer_lease_fence_conflict');
      }
      const generation = db.prepare(`SELECT * FROM autonomous_research_topic_producer_generation
        WHERE generation_sequence=?`).get(generationSequence);
      if (!generation || generation.status !== 'authorized'
        || Number(generation.lease_generation) !== identity.leaseGeneration
        || generation.capability_hash
          !== intakeRecord?.admission?.topicProducerCapabilityReceiptHash
        || generation.planned_generation_hash
          !== intakeRecord?.admission?.topicProducerCapabilityReceipt?.plannedGenerationHash
        || generation.topic_fingerprint
          !== intakeRecord?.admission?.topicProducerCapabilityReceipt?.topicFingerprint) {
        throw new Error('autonomous_research_topic_producer_completion_fence_conflict');
      }
      db.prepare(`UPDATE autonomous_research_topic_producer_generation SET
        status='produced',intake_id=?,intake_hash=?,admission_hash=?,updated_at=?
        WHERE generation_sequence=? AND status='authorized' AND lease_generation=?`).run(
        intakeRecord.intakeId,
        intakeRecord.intakeHash,
        intakeRecord.admissionHash,
        timestamp,
        generationSequence,
        identity.leaseGeneration,
      );
      db.prepare(`UPDATE autonomous_research_topic_producer_metadata SET
        last_produced_at=?,next_attempt_at=NULL WHERE singleton=1`).run(timestamp);
      db.exec('COMMIT;');
      return readGeneration(generationSequence);
    } catch (error) { rollback(db); throw error; }
  }

  function recoverCommittedGeneration({ lease, intakeRecord, now = new Date() } = {}) {
    const db = requireDatabase({ writable: true });
    const identity = leaseIdentity(lease);
    const observedAt = observedDate(now);
    const timestamp = observedAt.toISOString();
    try {
      begin(db);
      assertClock(db, observedAt, { update: true });
      if (!activeLease(db, identity, observedAt)) {
        throw new Error('autonomous_research_topic_producer_lease_fence_conflict');
      }
      const row = db.prepare(`SELECT * FROM autonomous_research_topic_producer_generation
        WHERE status='authorized' ORDER BY generation_sequence LIMIT 1`).get();
      const capability = intakeRecord?.admission?.topicProducerCapabilityReceipt;
      if (!row || intakeRecord?.sourceKind !== 'machine'
        || intakeRecord.intakeId !== JSON.parse(row.planned_generation_json).intake.intakeId
        || intakeRecord.intakeHash !== JSON.parse(row.planned_generation_json).intake.intakeHash
        || intakeRecord.admission?.version !== 2
        || intakeRecord.admission?.topicProducerCapabilityReceiptHash !== row.capability_hash
        || capability?.capabilityNonce !== row.capability_nonce
        || capability?.plannedGenerationHash !== row.planned_generation_hash
        || capability?.producerProfileHash !== producerProfile.producerProfileHash
        || capability?.machineIntakeConfigurationHash !== machineIntakeConfigurationHash) {
        throw new Error('autonomous_research_topic_producer_crash_recovery_binding_invalid');
      }
      const result = db.prepare(`UPDATE autonomous_research_topic_producer_generation SET
        status='produced',lease_generation=?,intake_id=?,intake_hash=?,admission_hash=?,updated_at=?
        WHERE generation_sequence=? AND status='authorized' AND capability_nonce=?`).run(
        identity.leaseGeneration,
        intakeRecord.intakeId,
        intakeRecord.intakeHash,
        intakeRecord.admissionHash,
        timestamp,
        row.generation_sequence,
        row.capability_nonce,
      );
      if (Number(result.changes) !== 1) {
        throw new Error('autonomous_research_topic_producer_completion_fence_conflict');
      }
      db.prepare(`UPDATE autonomous_research_topic_producer_metadata SET
        last_produced_at=?,next_attempt_at=NULL WHERE singleton=1`).run(timestamp);
      db.exec('COMMIT;');
      return readGeneration(Number(row.generation_sequence));
    } catch (error) { rollback(db); throw error; }
  }

  function readStatus({ now = new Date() } = {}) {
    const db = requireDatabase();
    const observedAt = observedDate(now);
    const metadata = db.prepare(`SELECT * FROM autonomous_research_topic_producer_metadata
      WHERE singleton=1`).get();
    const clockMonotonic = !metadata.last_observed_at
      || observedAt.toISOString() >= metadata.last_observed_at;
    const daily = db.prepare(`SELECT * FROM autonomous_research_topic_producer_daily_budget
      WHERE epoch_start=?`).get(utcDayStart(observedAt));
    const last = latestGeneration();
    const latestCapabilityFresh = Boolean(last?.capability
      && verifyAutonomousResearchTopicProducerCapabilityReceipt(last.capability, {
        producerProfile,
        machineIntakeConfigurationHash,
        intake: last.plannedGeneration.intake,
        now: observedAt,
        requireFresh: true,
      }));
    const canaryBudgetAvailable = Number(daily?.provider_canary_attempt_count || 0)
        < producerProfile.maximumProviderCanaryAttemptsPerUtcDay
      && Number(daily?.provider_canary_reserved_cost_usd || 0)
        + providerCanaryPairMaximumCostUsd
        <= producerProfile.maximumProviderCanaryCostUsdPerUtcDay;
    const topicBudgetAvailable = Number(daily?.produced_topic_count || 0)
      < producerProfile.maximumTopicsPerUtcDay;
    const rateEligible = !metadata.last_produced_at
      || observedAt.getTime() - Date.parse(metadata.last_produced_at)
        >= producerProfile.minimumGenerationIntervalMs;
    const retryEligible = !metadata.next_attempt_at
      || observedAt.toISOString() >= metadata.next_attempt_at;
    return Object.freeze({
      ready: clockMonotonic,
      clockMonotonic,
      machineIntakeConfigurationHash: metadata.machine_intake_configuration_hash,
      producerProfileHash: metadata.producer_profile_hash,
      providerConfigurationHash: metadata.provider_configuration_hash,
      implementationSha256: metadata.implementation_sha256,
      generationHighWatermark: Number(metadata.generation_high_watermark),
      lastObservedAt: metadata.last_observed_at || null,
      lastProducedAt: metadata.last_produced_at || null,
      nextAttemptAt: metadata.next_attempt_at || null,
      providerCanaryAttemptCount: Number(daily?.provider_canary_attempt_count || 0),
      providerCanaryReservedCostUsd: Number(daily?.provider_canary_reserved_cost_usd || 0),
      producedTopicCount: Number(daily?.produced_topic_count || 0),
      canaryBudgetAvailable,
      topicBudgetAvailable,
      rateEligible,
      retryEligible,
      currentlyProducible: clockMonotonic && canaryBudgetAvailable
        && topicBudgetAvailable && rateEligible && retryEligible,
      latestCapabilityFresh,
      latestGeneration: last,
    });
  }

  return Object.freeze({
    version: 1,
    kind: 'AutonomousResearchTopicProducerRepository',
    databasePath,
    durable: true,
    monotonicHighWatermark: true,
    singleWriterLeaseFencing: true,
    tryAcquireLease({ ownerId, leaseMs, now = new Date() } = {}) {
      const db = requireDatabase({ writable: true });
      if (!SAFE_ID.test(String(ownerId || ''))) {
        throw new Error('autonomous_research_topic_producer_lease_owner_invalid');
      }
      const duration = leaseDuration(leaseMs);
      const observedAt = observedDate(now);
      try {
        begin(db);
        assertClock(db, observedAt, { update: true });
        const active = db.prepare(`SELECT * FROM autonomous_research_topic_producer_lease
          WHERE singleton=1`).get();
        if (active && active.expires_at > observedAt.toISOString()) {
          db.exec('COMMIT;');
          return null;
        }
        const metadata = db.prepare(`SELECT lease_generation FROM
          autonomous_research_topic_producer_metadata WHERE singleton=1`).get();
        const leaseGeneration = Number(metadata.lease_generation) + 1;
        const leaseToken = `producer-lease:${crypto.randomUUID()}`;
        const expiresAt = new Date(observedAt.getTime() + duration).toISOString();
        db.prepare(`INSERT INTO autonomous_research_topic_producer_lease(
          singleton,owner_id,lease_token,lease_generation,acquired_at,renewed_at,expires_at
        ) VALUES(1,?,?,?,?,?,?) ON CONFLICT(singleton) DO UPDATE SET
          owner_id=excluded.owner_id,lease_token=excluded.lease_token,
          lease_generation=excluded.lease_generation,acquired_at=excluded.acquired_at,
          renewed_at=excluded.renewed_at,expires_at=excluded.expires_at`).run(
          ownerId, leaseToken, leaseGeneration, observedAt.toISOString(),
          observedAt.toISOString(), expiresAt,
        );
        db.prepare(`UPDATE autonomous_research_topic_producer_metadata
          SET lease_generation=? WHERE singleton=1`).run(leaseGeneration);
        db.exec('COMMIT;');
        return Object.freeze({ ownerId, leaseToken, leaseGeneration, expiresAt });
      } catch (error) { rollback(db); throw error; }
    },
    renewLease({ lease, leaseMs, now = new Date() } = {}) {
      const db = requireDatabase({ writable: true });
      const identity = leaseIdentity(lease);
      const observedAt = observedDate(now);
      const expiresAt = new Date(observedAt.getTime() + leaseDuration(leaseMs)).toISOString();
      try {
        begin(db);
        assertClock(db, observedAt, { update: true });
        const result = db.prepare(`UPDATE autonomous_research_topic_producer_lease SET
          renewed_at=?,expires_at=? WHERE singleton=1 AND owner_id=? AND lease_token=?
          AND lease_generation=? AND expires_at>?`).run(
          observedAt.toISOString(), expiresAt, identity.ownerId, identity.leaseToken,
          identity.leaseGeneration, observedAt.toISOString(),
        );
        db.exec('COMMIT;');
        return Number(result.changes) === 1 ? Object.freeze({ ...identity, expiresAt }) : null;
      } catch (error) { rollback(db); throw error; }
    },
    assertLease,
    prepareGeneration,
    beginProviderCanaryAction,
    finishProviderCanaryAction,
    readGeneration,
    latestGeneration,
    issueAppendAuthorization,
    consumeAppendAuthorization,
    completeGeneration,
    recoverCommittedGeneration,
    failGeneration,
    readStatus,
    releaseLease({ lease } = {}) {
      const db = requireDatabase({ writable: true });
      const identity = leaseIdentity(lease);
      return Number(db.prepare(`DELETE FROM autonomous_research_topic_producer_lease
        WHERE singleton=1 AND owner_id=? AND lease_token=? AND lease_generation=?`).run(
        identity.ownerId, identity.leaseToken, identity.leaseGeneration,
      ).changes) === 1;
    },
    close() { if (!closed) database?.close(); closed = true; },
  });
}
