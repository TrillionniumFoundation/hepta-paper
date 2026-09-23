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
  createAutonomousResearchTopicProducerLeaseOperations,
} from './autonomous-research-topic-producer-lease-operations.mjs';
import {
  createTopicProducerSchema,
  leaseIdentity,
  observedDate,
  parseGeneration,
  topicProducerFailureInspectionSchemaCurrent,
  utcDayStart,
} from './autonomous-research-topic-producer-repository-support.mjs';
import {
  AUTONOMOUS_RESEARCH_TOPIC_PRODUCER_DATABASE_INSTANCE_ID,
  AUTONOMOUS_RESEARCH_TOPIC_PRODUCER_SCHEMA_CONTRACT_ID,
  AUTONOMOUS_RESEARCH_TOPIC_PRODUCER_WRITER_ID,
} from './autonomous-research-topic-producer-mutation-plan.mjs';
import {
  assertTopicProducerMutationClock,
  assertTopicProducerMutationLease,
  resolveTopicProducerMutationCoordinator,
  topicProducerMutationValue,
} from './autonomous-research-topic-producer-online-mutation.mjs';

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
  offlineProvision = create,
  mutationCoordinator = null,
  databaseInstanceId = AUTONOMOUS_RESEARCH_TOPIC_PRODUCER_DATABASE_INSTANCE_ID,
  schemaContractId = AUTONOMOUS_RESEARCH_TOPIC_PRODUCER_SCHEMA_CONTRACT_ID,
  writerId = AUTONOMOUS_RESEARCH_TOPIC_PRODUCER_WRITER_ID,
  requireExternallyFencedMutations = false,
} = {}) {
  if (!runtimeRoot || !SHA256.test(String(machineIntakeConfigurationHash || ''))
    || !verifyAutonomousResearchTopicProducerProfile(producerProfile)
    || typeof providerCanaryPairMaximumCostUsd !== 'number'
    || !Number.isFinite(providerCanaryPairMaximumCostUsd)
    || providerCanaryPairMaximumCostUsd <= 0
    || providerCanaryPairMaximumCostUsd
      > producerProfile.maximumProviderCanaryCostUsdPerUtcDay
    || typeof liveMutationAuthority?.consume !== 'function'
    || !Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 1 || busyTimeoutMs > 60_000
    || typeof create !== 'boolean' || typeof offlineProvision !== 'boolean'
    || typeof requireExternallyFencedMutations !== 'boolean'
    || (offlineProvision && !create)
    || !SAFE_ID.test(String(databaseInstanceId || ''))
    || !SAFE_ID.test(String(schemaContractId || ''))
    || !SAFE_ID.test(String(writerId || ''))) {
    throw new Error('autonomous_research_topic_producer_repository_configuration_invalid');
  }
  const coordinator = resolveTopicProducerMutationCoordinator({
    mutationCoordinator,
    offlineProvision,
    requireExternallyFencedMutations,
    databaseInstanceId,
    schemaContractId,
    writerId,
  });
  const stateRoot = path.join(path.resolve(runtimeRoot), 'autonomous-research', 'topic-producer');
  const databasePath = path.join(stateRoot, 'topic-producer.sqlite');
  if (offlineProvision) {
    fs.mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
    fs.chmodSync(stateRoot, 0o700);
    if (!fs.existsSync(databasePath)) fs.closeSync(fs.openSync(databasePath, 'wx', 0o600));
  }
  if (create && !offlineProvision && !fs.existsSync(databasePath)) {
    throw new Error('autonomous_research_topic_producer_offline_provisioning_required');
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
  if (database && offlineProvision) {
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

  const {
    assertLease,
    releaseLease,
    renewLease,
    tryAcquireLease,
  } = createAutonomousResearchTopicProducerLeaseOperations({
    requireDatabase, coordinator, databaseInstanceId, schemaContractId, writerId,
  });

  const canaryJournalOperations =
    createAutonomousResearchTopicProducerCanaryJournalOperations({
      requireDatabase, coordinator, databaseInstanceId, schemaContractId, writerId,
      producerProfile,
      providerCanaryPairMaximumCostUsd,
      requireExternallyFencedMutations,
    });
  const {
    beginProviderCanaryAction,
    assertProviderCanaryActionPermit,
    failGeneration,
    finishProviderCanaryAction,
    recoverInterruptedProviderCanary,
  } = canaryJournalOperations;

  function reserveCanary(transaction, observedAt) {
    const timestamp = observedAt.toISOString();
    const epochStart = utcDayStart(observedAt);
    transaction.run(
      'topic-producer.prepare.budget-ensure.apply.v1',
      epochStart, 0, 0, 0, timestamp,
    );
    const daily = transaction.get('topic-producer.prepare.budget-current.get.v1', epochStart);
    const attempts = Number(daily.provider_canary_attempt_count) + 1;
    const cost = Number(daily.provider_canary_reserved_cost_usd)
      + providerCanaryPairMaximumCostUsd;
    if (attempts > producerProfile.maximumProviderCanaryAttemptsPerUtcDay
      || cost > producerProfile.maximumProviderCanaryCostUsdPerUtcDay) {
      throw new Error('autonomous_research_topic_producer_provider_canary_budget_exhausted');
    }
    transaction.run(
      'topic-producer.prepare.budget-reserve-canary.apply.v1',
      attempts, cost, timestamp, epochStart,
    );
  }

  function prepareGeneration({ lease, now = new Date() } = {}) {
    const identity = leaseIdentity(lease);
    const observedAt = observedDate(now);
    const timestamp = observedAt.toISOString();
    return topicProducerMutationValue(coordinator.executeMutation({
      database: requireDatabase({ writable: true }),
      databaseRole: 'topic-producer',
      databaseInstanceId,
      schemaContractId,
      writerId,
      operationId: 'topic-producer.topic-producer-repository.prepareGeneration.v1',
      authorizationReceiptHashes: [],
      sideEffectReservationHashes: [],
      mutate(transaction) {
      const clockState = transaction.get(
        'topic-producer.prepare.metadata-clock.get.v1',
      );
      assertTopicProducerMutationClock(clockState, timestamp);
      transaction.run('topic-producer.prepare.metadata-clock.update.v1', timestamp);
      const leaseState = transaction.get('topic-producer.prepare.lease-current.get.v1');
      assertTopicProducerMutationLease(leaseState, identity, timestamp);
      const outstanding = transaction.get(
        'topic-producer.prepare.generation-outstanding.get.v1',
      );
      if (outstanding) {
        if (recoverInterruptedProviderCanary({
          transaction,
          row: outstanding,
          observedAt,
        })) {
          return null;
        }
        if (outstanding.budget_epoch_start !== utcDayStart(observedAt)) {
          transaction.run(
            'topic-producer.prepare.generation-expire.apply.v1',
            'autonomous_research_topic_producer_budget_epoch_expired',
            timestamp,
            outstanding.generation_sequence,
          );
        } else {
        const intakeAge = observedAt.getTime() - Date.parse(
          JSON.parse(outstanding.planned_generation_json).admissionCreatedAt,
        );
        if (intakeAge < 0 || intakeAge > MAXIMUM_ADMISSION_AGE_MS) {
          transaction.run(
            'topic-producer.prepare.generation-expire.apply.v1',
            'autonomous_research_topic_producer_planned_generation_expired',
            timestamp,
            outstanding.generation_sequence,
          );
        } else {
          if (outstanding.status === 'authorized') reserveCanary(transaction, observedAt);
          transaction.run(
            'topic-producer.prepare.generation-reset.apply.v1',
            identity.leaseGeneration,
            timestamp,
            outstanding.generation_sequence,
          );
          return parseGeneration(transaction.get(
            'topic-producer.prepare.generation-result.get.v1',
            Number(outstanding.generation_sequence),
          ), {
            providerCanaryPairMaximumCostUsd,
            providerConfigurationHash: producerProfile.providerConfigurationHash,
          });
        }
        }
      }
      const metadata = transaction.get('topic-producer.prepare.metadata-current.get.v1');
      if (metadata.next_attempt_at && metadata.next_attempt_at > timestamp) {
        return null;
      }
      if (metadata.last_produced_at
        && observedAt.getTime() - Date.parse(metadata.last_produced_at)
          < producerProfile.minimumGenerationIntervalMs) {
        return null;
      }
      const daily = transaction.get(
        'topic-producer.prepare.budget-current.get.v1',
        utcDayStart(observedAt),
      );
      if (Number(daily?.produced_topic_count || 0) >= producerProfile.maximumTopicsPerUtcDay) {
        return null;
      }
      reserveCanary(transaction, observedAt);
      const epochStart = utcDayStart(observedAt);
      const reserved = transaction.run(
        'topic-producer.prepare.budget-reserve-topic.apply.v1',
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
      transaction.run(
        'topic-producer.prepare.generation-insert.apply.v1',
        sequence, 'planned', identity.leaseGeneration, planned.producerTopicId,
        planned.topicFingerprint, planned.canonicalResearchTopicHash,
        reservationId, planned.budgetEpochStart, planned.plannedGenerationHash,
        JSON.stringify(planned), timestamp, timestamp,
      );
      transaction.run('topic-producer.prepare.metadata-high-water.update.v1', sequence);
      return parseGeneration(transaction.get(
        'topic-producer.prepare.generation-result.get.v1',
        sequence,
      ), {
        providerCanaryPairMaximumCostUsd,
        providerConfigurationHash: producerProfile.providerConfigurationHash,
      });
      },
    }));
  }

  function issueAppendAuthorization({
    lease,
    plannedGeneration,
    capability,
    intake,
    liveMutationAuthorization,
    now,
  } = {}) {
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
    topicProducerMutationValue(coordinator.executeMutation({
      database: requireDatabase({ writable: true }),
      databaseRole: 'topic-producer',
      databaseInstanceId,
      schemaContractId,
      writerId,
      operationId:
        'topic-producer.topic-producer-repository.issueAppendAuthorization.v1',
      authorizationReceiptHashes: [
        capability.autonomousResearchTopicProducerCapabilityReceiptHash,
      ],
      sideEffectReservationHashes: [plannedGeneration.plannedGenerationHash],
      mutate(transaction) {
      const timestamp = observedAt.toISOString();
      const clockState = transaction.get(
        'topic-producer.authorize.metadata-clock.get.v1',
      );
      assertTopicProducerMutationClock(clockState, timestamp);
      transaction.run('topic-producer.authorize.metadata-clock.update.v1', timestamp);
      const leaseState = transaction.get('topic-producer.authorize.lease-current.get.v1');
      assertTopicProducerMutationLease(leaseState, identity, timestamp);
      const result = transaction.run(
        'topic-producer.authorize.generation.update.v1',
        capability.autonomousResearchTopicProducerCapabilityReceiptHash,
        capability.capabilityNonce,
        JSON.stringify(capability),
        timestamp,
        capability.generationSequence,
        identity.leaseGeneration,
        plannedGeneration.plannedGenerationHash,
        plannedGeneration.budgetReservationId,
      );
      if (Number(result.changes) !== 1) {
        throw new Error('autonomous_research_topic_producer_generation_fence_conflict');
      }
      return true;
      },
    }));
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
    const identity = leaseIdentity(lease);
    const observedAt = observedDate(now);
    const timestamp = observedAt.toISOString();
    return topicProducerMutationValue(coordinator.executeMutation({
      database: requireDatabase({ writable: true }),
      databaseRole: 'topic-producer',
      databaseInstanceId,
      schemaContractId,
      writerId,
      operationId: 'topic-producer.topic-producer-repository.completeGeneration.v1',
      authorizationReceiptHashes: [
        intakeRecord?.admission?.topicProducerCapabilityReceiptHash,
      ].filter(Boolean),
      sideEffectReservationHashes: [
        intakeRecord?.intakeHash,
        intakeRecord?.admissionHash,
      ].filter(Boolean),
      mutate(transaction) {
      const clockState = transaction.get('topic-producer.complete.metadata-clock.get.v1');
      assertTopicProducerMutationClock(clockState, timestamp);
      transaction.run('topic-producer.complete.metadata-clock.update.v1', timestamp);
      const leaseState = transaction.get('topic-producer.complete.lease-current.get.v1');
      assertTopicProducerMutationLease(leaseState, identity, timestamp);
      const generation = transaction.get(
        'topic-producer.complete.generation-current.get.v1',
        generationSequence,
      );
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
      transaction.run(
        'topic-producer.complete.generation-produced.update.v1',
        intakeRecord.intakeId,
        intakeRecord.intakeHash,
        intakeRecord.admissionHash,
        timestamp,
        generationSequence,
        identity.leaseGeneration,
      );
      transaction.run('topic-producer.complete.metadata-produced.update.v1', timestamp);
      return parseGeneration(transaction.get(
        'topic-producer.complete.generation-result.get.v1',
        generationSequence,
      ), {
        providerCanaryPairMaximumCostUsd,
        providerConfigurationHash: producerProfile.providerConfigurationHash,
      });
      },
    }));
  }

  function recoverCommittedGeneration({ lease, intakeRecord, now = new Date() } = {}) {
    const identity = leaseIdentity(lease);
    const observedAt = observedDate(now);
    const timestamp = observedAt.toISOString();
    return topicProducerMutationValue(coordinator.executeMutation({
      database: requireDatabase({ writable: true }),
      databaseRole: 'topic-producer',
      databaseInstanceId,
      schemaContractId,
      writerId,
      operationId:
        'topic-producer.topic-producer-repository.recoverCommittedGeneration.v1',
      authorizationReceiptHashes: [
        intakeRecord?.admission?.topicProducerCapabilityReceiptHash,
      ].filter(Boolean),
      sideEffectReservationHashes: [
        intakeRecord?.intakeHash,
        intakeRecord?.admissionHash,
      ].filter(Boolean),
      mutate(transaction) {
      const clockState = transaction.get('topic-producer.recover.metadata-clock.get.v1');
      assertTopicProducerMutationClock(clockState, timestamp);
      transaction.run('topic-producer.recover.metadata-clock.update.v1', timestamp);
      const leaseState = transaction.get('topic-producer.recover.lease-current.get.v1');
      assertTopicProducerMutationLease(leaseState, identity, timestamp);
      const row = transaction.get('topic-producer.recover.generation-authorized.get.v1');
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
      const result = transaction.run(
        'topic-producer.recover.generation-produced.update.v1',
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
      transaction.run('topic-producer.recover.metadata-produced.update.v1', timestamp);
      return parseGeneration(transaction.get(
        'topic-producer.recover.generation-result.get.v1',
        Number(row.generation_sequence),
      ), {
        providerCanaryPairMaximumCostUsd,
        providerConfigurationHash: producerProfile.providerConfigurationHash,
      });
      },
    }));
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
    offlineProvisioningPerformed: offlineProvision,
    externallyFencedMutations: coordinator.implemented === true,
    externallyFencedMutationsRequired: requireExternallyFencedMutations,
    databaseInstanceId,
    schemaContractId,
    writerId,
    tryAcquireLease,
    renewLease,
    assertLease,
    prepareGeneration,
    beginProviderCanaryAction,
    assertProviderCanaryActionPermit,
    finishProviderCanaryAction,
    readGeneration,
    latestGeneration,
    issueAppendAuthorization,
    consumeAppendAuthorization,
    completeGeneration,
    recoverCommittedGeneration,
    failGeneration,
    readStatus,
    releaseLease,
    close() { if (!closed) database?.close(); closed = true; },
  });
}
