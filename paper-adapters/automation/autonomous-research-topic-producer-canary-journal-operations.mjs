import {
  buildAutonomousResearchProviderCanaryAttemptJournal,
  buildAutonomousResearchProviderCanarySideEffectInspection,
  verifyAutonomousResearchProviderCanarySideEffectInspection,
} from '../../paper-domain/automation/autonomous-research-provider-canary-side-effect-inspection.mjs';
import {
  leaseIdentity,
  observedDate,
  parseGeneration,
} from './autonomous-research-topic-producer-repository-support.mjs';
import {
  topicProducerMutationValue,
} from './autonomous-research-topic-producer-online-mutation.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;
const INTERRUPTED_CANARY_RETRY_AFTER_MS = 15 * 60 * 1000;
const SHA256 = /^sha256:[0-9a-f]{64}$/;

function providerCanaryActionReservationHash({
  providerConfigurationHash,
  identity,
  generationSequence,
  reservation,
  role,
  failurePhase,
} = {}) {
  return hashRecord('AutonomousResearchTopicProducerProviderCanaryActionReservation', {
    providerConfigurationHash,
    producerLeaseOwnerId: identity.ownerId,
    producerLeaseGeneration: identity.leaseGeneration,
    producerLeaseTokenHash: hashRecord('AutonomousResearchTopicProducerLeaseToken', {
      leaseToken: identity.leaseToken,
    }),
    generationSequence,
    role,
    failurePhase,
    reservation,
  });
}

function assertFinalizedSideEffectPermit({
  receipt,
  required,
  sideEffectReservationHash,
} = {}) {
  if (!required) return;
  if (receipt?.status === 'externally_fenced_sqlite_mutation_finalized'
    && SHA256.test(String(receipt.sideEffectPermitHash || ''))) return;
  const error = new Error(
    'autonomous_research_topic_producer_provider_canary_side_effect_permit_required',
  );
  error.committed = true;
  error.reservationId = receipt?.reservationId || null;
  error.sideEffectPermitHash = receipt?.sideEffectPermitHash || null;
  error.sideEffectReservationHash = sideEffectReservationHash;
  throw error;
}

function canaryReservation(plannedGeneration, providerCanaryPairMaximumCostUsd) {
  return Object.freeze({
    generationSequence: plannedGeneration.generationSequence,
    plannedGenerationHash: plannedGeneration.plannedGenerationHash,
    budgetReservationId: plannedGeneration.budgetReservationId,
    budgetEpochStart: plannedGeneration.budgetEpochStart,
    providerCanaryReservedAttemptCount: 1,
    providerCanaryReservedCostUsd: providerCanaryPairMaximumCostUsd,
  });
}

function sameCanaryReservation(left, right) {
  return Object.keys(right).every((key) => left?.[key] === right[key]);
}

function inspectionCoversJournal(inspection, journal) {
  if (!journal) return true;
  if (!inspection || !Array.isArray(inspection.actions)) return false;
  if (!journal.actions.every((action, index) =>
    JSON.stringify(action) === JSON.stringify(inspection.actions[index]))) return false;
  if (journal.currentRole !== null && inspection.actions.length === journal.actions.length) {
    return inspection.actionAccountingComplete === false;
  }
  return journal.currentRole !== null
    || inspection.actions.length === journal.actions.length;
}

function interruptedCanaryInspection({
  providerConfigurationHash,
  reservation,
  journal,
  failurePhase = 'provider_canary_restart_recovery',
} = {}) {
  return buildAutonomousResearchProviderCanarySideEffectInspection({
    providerConfigurationHash,
    reservation,
    actions: journal?.actions || [],
    actionAccountingComplete: false,
    failurePhase,
  });
}

export function createAutonomousResearchTopicProducerCanaryJournalOperations({
  requireDatabase,
  coordinator,
  databaseInstanceId,
  schemaContractId,
  writerId,
  producerProfile,
  providerCanaryPairMaximumCostUsd,
  requireExternallyFencedMutations = false,
} = {}) {
  const providerConfigurationHash = producerProfile?.providerConfigurationHash;
  const providerCanaryActionPermits = new WeakMap();

  function parsedGeneration(row) {
    return parseGeneration(row, {
      providerCanaryPairMaximumCostUsd,
      providerConfigurationHash,
    });
  }

  function assertClock(metadata, observedAt) {
    if (metadata.last_observed_at
      && observedAt.toISOString() < metadata.last_observed_at) {
      throw new Error('autonomous_research_topic_producer_clock_rollback_detected');
    }
  }

  function assertLease(row, lease, observedAt) {
    if (!row || row.owner_id !== lease.ownerId || row.lease_token !== lease.leaseToken
      || Number(row.lease_generation) !== lease.leaseGeneration
      || row.expires_at <= observedAt.toISOString()) {
      throw new Error('autonomous_research_topic_producer_lease_fence_conflict');
    }
  }

  function beginProviderCanaryAction({
    lease,
    generationSequence,
    reservation,
    role,
    failurePhase,
    now = new Date(),
  } = {}) {
    const identity = leaseIdentity(lease);
    const observedAt = observedDate(now);
    if (!Number.isSafeInteger(generationSequence) || generationSequence < 1
      || !['research_author', 'formal_reviewer'].includes(role)
      || failurePhase !== `${role}_canary`) {
      throw new Error('autonomous_research_topic_producer_provider_canary_journal_invalid');
    }
    const database = requireDatabase({ writable: true });
    const sideEffectReservationHash = providerCanaryActionReservationHash({
      providerConfigurationHash,
      identity,
      generationSequence,
      reservation,
      role,
      failurePhase,
    });
    const mutationReceipt = coordinator.executeMutation({
      database,
      databaseRole: 'topic-producer',
      databaseInstanceId,
      schemaContractId,
      writerId,
      operationId:
        'topic-producer.topic-producer-repository.beginProviderCanaryAction.v1',
      authorizationReceiptHashes: [],
      sideEffectReservationHashes: [sideEffectReservationHash],
      mutate(transaction) {
      assertClock(transaction.get(
        'topic-producer.canary-begin.metadata-clock.get.v1',
      ), observedAt);
      transaction.run(
        'topic-producer.canary-begin.metadata-clock.update.v1',
        observedAt.toISOString(),
      );
      assertLease(transaction.get(
        'topic-producer.canary-begin.lease-current.get.v1',
      ), identity, observedAt);
      const row = transaction.get(
        'topic-producer.canary-begin.generation-current.get.v1',
        generationSequence,
        identity.leaseGeneration,
      );
      if (!row) throw new Error('autonomous_research_topic_producer_generation_fence_conflict');
      const generation = parsedGeneration(row);
      const expectedReservation = canaryReservation(
        generation.plannedGeneration,
        providerCanaryPairMaximumCostUsd,
      );
      if (!sameCanaryReservation(reservation, expectedReservation)) {
        throw new Error('autonomous_research_topic_producer_provider_canary_journal_invalid');
      }
      const prior = generation.providerCanaryAttemptJournal;
      const validTransition = role === 'research_author'
        ? !generation.providerCanaryAttemptStarted && prior === null
        : generation.providerCanaryAttemptStarted && prior?.currentRole === null
          && prior.actions.length === 1
          && prior.actions[0].role === 'research_author'
          && prior.actions[0].status === 'succeeded';
      if (!validTransition) {
        throw new Error('autonomous_research_topic_producer_provider_canary_journal_conflict');
      }
      const journal = buildAutonomousResearchProviderCanaryAttemptJournal({
        providerConfigurationHash,
        reservation: expectedReservation,
        actions: prior?.actions || [],
        currentRole: role,
        failurePhase,
      });
      const result = transaction.run(
        'topic-producer.canary-begin.generation-journal.update.v1',
        JSON.stringify(journal),
        observedAt.toISOString(),
        generationSequence,
        identity.leaseGeneration,
      );
      if (Number(result.changes) !== 1) {
        throw new Error('autonomous_research_topic_producer_generation_fence_conflict');
      }
      return journal;
      },
    });
    const journal = topicProducerMutationValue(mutationReceipt);
    assertFinalizedSideEffectPermit({
      receipt: mutationReceipt,
      required: requireExternallyFencedMutations,
      sideEffectReservationHash,
    });
    providerCanaryActionPermits.set(journal, Object.freeze({
      required: requireExternallyFencedMutations,
      sideEffectReservationHash,
      sideEffectPermitHash: mutationReceipt.sideEffectPermitHash || null,
    }));
    return journal;
  }

  function assertProviderCanaryActionPermit({
    journal,
    lease,
    generationSequence,
    reservation,
    role,
    failurePhase,
  } = {}) {
    const identity = leaseIdentity(lease);
    const permit = providerCanaryActionPermits.get(journal);
    providerCanaryActionPermits.delete(journal);
    const expectedReservationHash = providerCanaryActionReservationHash({
      providerConfigurationHash,
      identity,
      generationSequence,
      reservation,
      role,
      failurePhase,
    });
    if (!permit || permit.sideEffectReservationHash !== expectedReservationHash
      || (permit.required && !SHA256.test(String(permit.sideEffectPermitHash || '')))) {
      throw new Error(
        'autonomous_research_topic_producer_provider_canary_side_effect_permit_invalid',
      );
    }
    return true;
  }

  function finishProviderCanaryAction({
    lease,
    generationSequence,
    reservation,
    action,
    failurePhase,
    now = new Date(),
  } = {}) {
    const identity = leaseIdentity(lease);
    const observedAt = observedDate(now);
    if (!Number.isSafeInteger(generationSequence) || generationSequence < 1
      || !['research_author', 'formal_reviewer'].includes(action?.role)
      || failurePhase !== `${action?.role}_canary`) {
      throw new Error('autonomous_research_topic_producer_provider_canary_journal_invalid');
    }
    const database = requireDatabase({ writable: true });
    return topicProducerMutationValue(coordinator.executeMutation({
      database,
      databaseRole: 'topic-producer',
      databaseInstanceId,
      schemaContractId,
      writerId,
      operationId:
        'topic-producer.topic-producer-repository.finishProviderCanaryAction.v1',
      authorizationReceiptHashes: [],
      sideEffectReservationHashes: [],
      mutate(transaction) {
      assertClock(transaction.get(
        'topic-producer.canary-finish.metadata-clock.get.v1',
      ), observedAt);
      transaction.run(
        'topic-producer.canary-finish.metadata-clock.update.v1',
        observedAt.toISOString(),
      );
      assertLease(transaction.get(
        'topic-producer.canary-finish.lease-current.get.v1',
      ), identity, observedAt);
      const row = transaction.get(
        'topic-producer.canary-finish.generation-current.get.v1',
        generationSequence,
        identity.leaseGeneration,
      );
      if (!row) throw new Error('autonomous_research_topic_producer_generation_fence_conflict');
      const generation = parsedGeneration(row);
      const expectedReservation = canaryReservation(
        generation.plannedGeneration,
        providerCanaryPairMaximumCostUsd,
      );
      const prior = generation.providerCanaryAttemptJournal;
      if (!sameCanaryReservation(reservation, expectedReservation)
        || !generation.providerCanaryAttemptStarted
        || prior?.currentRole !== action.role) {
        throw new Error('autonomous_research_topic_producer_provider_canary_journal_conflict');
      }
      const journal = buildAutonomousResearchProviderCanaryAttemptJournal({
        providerConfigurationHash,
        reservation: expectedReservation,
        actions: [...prior.actions, action],
        currentRole: null,
        failurePhase,
      });
      const result = transaction.run(
        'topic-producer.canary-finish.generation-journal.update.v1',
        JSON.stringify(journal),
        observedAt.toISOString(),
        generationSequence,
        identity.leaseGeneration,
      );
      if (Number(result.changes) !== 1) {
        throw new Error('autonomous_research_topic_producer_generation_fence_conflict');
      }
      return journal;
      },
    }));
  }

  function recoverInterruptedProviderCanary({ transaction, row, observedAt } = {}) {
    const generation = parsedGeneration(row);
    const unjournaledAuthorizedAttempt = row.status === 'authorized'
      && !generation.providerCanaryAttemptStarted;
    if (!generation.providerCanaryAttemptStarted && !unjournaledAuthorizedAttempt) return null;
    // Canary attempts and topic slots are non-refundable after the write-ahead marker.
    // An authorized row without a marker is also ambiguous: normal issuance can only
    // authorize after the canary pair. Close either state so a same-reservation replay
    // is impossible; any later retry must reserve a fresh attempt and generation.
    const reservation = canaryReservation(
      generation.plannedGeneration,
      providerCanaryPairMaximumCostUsd,
    );
    const inspection = interruptedCanaryInspection({
      providerConfigurationHash,
      reservation,
      journal: generation.providerCanaryAttemptJournal,
    });
    const timestamp = observedAt.toISOString();
    transaction.run(
      'topic-producer.prepare.generation-interrupted.apply.v1',
      inspection.failureCode,
      JSON.stringify(inspection),
      timestamp,
      generation.generationSequence,
    );
    const nextAttemptAt = new Date(
      observedAt.getTime() + INTERRUPTED_CANARY_RETRY_AFTER_MS,
    ).toISOString();
    transaction.run('topic-producer.prepare.metadata-retry.update.v1', nextAttemptAt);
    return Object.freeze({ generation, inspection, nextAttemptAt });
  }

  function failGeneration({ lease, generationSequence, error, retryAfterMs, now } = {}) {
    const identity = leaseIdentity(lease);
    const observedAt = observedDate(now);
    if (!Number.isSafeInteger(retryAfterMs) || retryAfterMs < 60_000
      || retryAfterMs > DAY_MS) {
      throw new Error('autonomous_research_topic_producer_retry_delay_invalid');
    }
    const attachedInspection =
      error?.autonomousResearchProviderCanarySideEffectInspection || null;
    const database = requireDatabase({ writable: true });
    return topicProducerMutationValue(coordinator.executeMutation({
      database,
      databaseRole: 'topic-producer',
      databaseInstanceId,
      schemaContractId,
      writerId,
      operationId: 'topic-producer.topic-producer-repository.failGeneration.v1',
      authorizationReceiptHashes: [],
      sideEffectReservationHashes: [],
      mutate(transaction) {
      assertClock(transaction.get(
        'topic-producer.fail.metadata-clock.get.v1',
      ), observedAt);
      transaction.run(
        'topic-producer.fail.metadata-clock.update.v1',
        observedAt.toISOString(),
      );
      assertLease(transaction.get(
        'topic-producer.fail.lease-current.get.v1',
      ), identity, observedAt);
      const row = transaction.get(
        'topic-producer.fail.generation-current.get.v1',
        generationSequence,
        identity.leaseGeneration,
      );
      if (!row) throw new Error('autonomous_research_topic_producer_generation_fence_conflict');
      const parsed = parsedGeneration(row);
      const reservation = canaryReservation(
        parsed.plannedGeneration,
        providerCanaryPairMaximumCostUsd,
      );
      if (attachedInspection && !verifyAutonomousResearchProviderCanarySideEffectInspection(
        attachedInspection,
        { providerConfigurationHash, reservation },
      )) throw new Error(
        'autonomous_research_topic_producer_provider_canary_side_effect_inspection_invalid',
      );
      let inspection = attachedInspection;
      if (parsed.providerCanaryAttemptStarted
        && !inspectionCoversJournal(inspection, parsed.providerCanaryAttemptJournal)) {
        inspection = interruptedCanaryInspection({
          providerConfigurationHash,
          reservation,
          journal: parsed.providerCanaryAttemptJournal,
          failurePhase: 'provider_canary_action_journal_recovery',
        });
      }
      if (parsed.providerCanaryAttemptStarted && !inspection) {
        inspection = interruptedCanaryInspection({
          providerConfigurationHash,
          reservation,
          journal: parsed.providerCanaryAttemptJournal,
          failurePhase: 'provider_canary_action_journal_recovery',
        });
      }
      const serializedInspection = inspection ? JSON.stringify(inspection) : null;
      if (serializedInspection && Buffer.byteLength(serializedInspection) > 16 * 1024) {
        throw new Error(
          'autonomous_research_topic_producer_provider_canary_side_effect_inspection_invalid',
        );
      }
      const message = inspection
        ? inspection.failureCode
        : String(error?.message || error || 'topic_producer_failed').slice(0, 1024);
      const result = transaction.run(
        'topic-producer.fail.generation-failed.update.v1',
        message,
        parsed.providerCanaryAttemptStarted || inspection ? 1 : 0,
        serializedInspection,
        observedAt.toISOString(),
        generationSequence,
        identity.leaseGeneration,
      );
      if (Number(result.changes) !== 1) {
        throw new Error('autonomous_research_topic_producer_generation_fence_conflict');
      }
      transaction.run(
        'topic-producer.fail.metadata-retry.update.v1',
        new Date(observedAt.getTime() + retryAfterMs).toISOString(),
      );
      return parsedGeneration(transaction.get(
        'topic-producer.fail.generation-result.get.v1',
        generationSequence,
      ));
      },
    }));
  }

  return Object.freeze({
    beginProviderCanaryAction,
    assertProviderCanaryActionPermit,
    finishProviderCanaryAction,
    recoverInterruptedProviderCanary,
    failGeneration,
  });
}
