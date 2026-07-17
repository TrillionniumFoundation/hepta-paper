import {
  buildAutonomousResearchProviderCanaryAttemptJournal,
  buildAutonomousResearchProviderCanarySideEffectInspection,
  verifyAutonomousResearchProviderCanarySideEffectInspection,
} from '../../paper-domain/automation/autonomous-research-provider-canary-side-effect-inspection.mjs';
import {
  begin,
  leaseIdentity,
  observedDate,
  parseGeneration,
  rollback,
} from './autonomous-research-topic-producer-repository-support.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;
const INTERRUPTED_CANARY_RETRY_AFTER_MS = 15 * 60 * 1000;

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
  assertClock,
  activeLease,
  producerProfile,
  providerCanaryPairMaximumCostUsd,
  readGeneration,
} = {}) {
  const providerConfigurationHash = producerProfile?.providerConfigurationHash;

  function parsedGeneration(row) {
    return parseGeneration(row, {
      providerCanaryPairMaximumCostUsd,
      providerConfigurationHash,
    });
  }

  function beginProviderCanaryAction({
    lease,
    generationSequence,
    reservation,
    role,
    failurePhase,
    now = new Date(),
  } = {}) {
    const database = requireDatabase({ writable: true });
    const identity = leaseIdentity(lease);
    const observedAt = observedDate(now);
    if (!Number.isSafeInteger(generationSequence) || generationSequence < 1
      || !['research_author', 'formal_reviewer'].includes(role)
      || failurePhase !== `${role}_canary`) {
      throw new Error('autonomous_research_topic_producer_provider_canary_journal_invalid');
    }
    try {
      begin(database);
      assertClock(database, observedAt, { update: true });
      if (!activeLease(database, identity, observedAt)) {
        throw new Error('autonomous_research_topic_producer_lease_fence_conflict');
      }
      const row = database.prepare(`SELECT * FROM autonomous_research_topic_producer_generation
        WHERE generation_sequence=? AND status='planned' AND lease_generation=?`).get(
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
      const result = database.prepare(`UPDATE autonomous_research_topic_producer_generation SET
        provider_canary_attempt_started=1,provider_canary_attempt_journal_json=?,updated_at=?
        WHERE generation_sequence=? AND status='planned' AND lease_generation=?`).run(
        JSON.stringify(journal),
        observedAt.toISOString(),
        generationSequence,
        identity.leaseGeneration,
      );
      if (Number(result.changes) !== 1) {
        throw new Error('autonomous_research_topic_producer_generation_fence_conflict');
      }
      database.exec('COMMIT;');
      return journal;
    } catch (error) { rollback(database); throw error; }
  }

  function finishProviderCanaryAction({
    lease,
    generationSequence,
    reservation,
    action,
    failurePhase,
    now = new Date(),
  } = {}) {
    const database = requireDatabase({ writable: true });
    const identity = leaseIdentity(lease);
    const observedAt = observedDate(now);
    if (!Number.isSafeInteger(generationSequence) || generationSequence < 1
      || !['research_author', 'formal_reviewer'].includes(action?.role)
      || failurePhase !== `${action?.role}_canary`) {
      throw new Error('autonomous_research_topic_producer_provider_canary_journal_invalid');
    }
    try {
      begin(database);
      assertClock(database, observedAt, { update: true });
      if (!activeLease(database, identity, observedAt)) {
        throw new Error('autonomous_research_topic_producer_lease_fence_conflict');
      }
      const row = database.prepare(`SELECT * FROM autonomous_research_topic_producer_generation
        WHERE generation_sequence=? AND status='planned' AND lease_generation=?`).get(
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
      const result = database.prepare(`UPDATE autonomous_research_topic_producer_generation SET
        provider_canary_attempt_journal_json=?,updated_at=?
        WHERE generation_sequence=? AND status='planned' AND lease_generation=?
        AND provider_canary_attempt_started=1`).run(
        JSON.stringify(journal),
        observedAt.toISOString(),
        generationSequence,
        identity.leaseGeneration,
      );
      if (Number(result.changes) !== 1) {
        throw new Error('autonomous_research_topic_producer_generation_fence_conflict');
      }
      database.exec('COMMIT;');
      return journal;
    } catch (error) { rollback(database); throw error; }
  }

  function recoverInterruptedProviderCanary({ database, row, observedAt } = {}) {
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
    database.prepare(`UPDATE autonomous_research_topic_producer_generation SET
      status='failed',error=?,provider_canary_attempt_started=1,
      provider_canary_side_effect_inspection_json=?,updated_at=?
      WHERE generation_sequence=? AND status IN ('planned','authorized')`).run(
      inspection.failureCode,
      JSON.stringify(inspection),
      timestamp,
      generation.generationSequence,
    );
    const nextAttemptAt = new Date(
      observedAt.getTime() + INTERRUPTED_CANARY_RETRY_AFTER_MS,
    ).toISOString();
    database.prepare(`UPDATE autonomous_research_topic_producer_metadata SET next_attempt_at=?
      WHERE singleton=1`).run(nextAttemptAt);
    return Object.freeze({ generation, inspection, nextAttemptAt });
  }

  function failGeneration({ lease, generationSequence, error, retryAfterMs, now } = {}) {
    const database = requireDatabase({ writable: true });
    const identity = leaseIdentity(lease);
    const observedAt = observedDate(now);
    if (!Number.isSafeInteger(retryAfterMs) || retryAfterMs < 60_000
      || retryAfterMs > DAY_MS) {
      throw new Error('autonomous_research_topic_producer_retry_delay_invalid');
    }
    const attachedInspection =
      error?.autonomousResearchProviderCanarySideEffectInspection || null;
    try {
      begin(database);
      assertClock(database, observedAt, { update: true });
      if (!activeLease(database, identity, observedAt)) {
        throw new Error('autonomous_research_topic_producer_lease_fence_conflict');
      }
      const row = database.prepare(`SELECT * FROM autonomous_research_topic_producer_generation
        WHERE generation_sequence=? AND status IN ('planned','authorized')
        AND lease_generation=?`).get(generationSequence, identity.leaseGeneration);
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
      const result = database.prepare(`UPDATE autonomous_research_topic_producer_generation SET
        status='failed',error=?,provider_canary_attempt_started=?,
        provider_canary_side_effect_inspection_json=?,updated_at=?
        WHERE generation_sequence=?
        AND status IN ('planned','authorized') AND lease_generation=?`).run(
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
      database.prepare(`UPDATE autonomous_research_topic_producer_metadata SET next_attempt_at=?
        WHERE singleton=1`).run(
        new Date(observedAt.getTime() + retryAfterMs).toISOString(),
      );
      database.exec('COMMIT;');
      return readGeneration(generationSequence);
    } catch (caught) { rollback(database); throw caught; }
  }

  return Object.freeze({
    beginProviderCanaryAction,
    finishProviderCanaryAction,
    recoverInterruptedProviderCanary,
    failGeneration,
  });
}
