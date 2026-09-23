import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import {
  H,
  buildAutonomousResearchTopicProducerCapabilityReceipt,
  canaryReservationFor,
  createAutonomousResearchMachineIntakeRepository,
  createAutonomousResearchTopicProducer,
  createAutonomousResearchTopicProducerRepository,
  dropTopicProducerCanaryJournalColumns,
  hashRecord,
  inspectAutonomousResearchTopicProducerStatus,
  instrumentedCanaryRunner,
  providerConfigurationFixture,
  reopenProducerRepository,
  setup,
  verifyAutonomousResearchProviderCanarySideEffectInspection,
} from './support/autonomous-research-topic-producer-fixture.mjs';

test('append-before-complete crash is recovered without a second canary or topic charge', async (t) => {
  const fixture = setup(t);
  const lease = fixture.producerRepository.tryAcquireLease({
    ownerId: 'producer:crash', leaseMs: 1000, now: fixture.clock.now(),
  });
  const plan = fixture.producerRepository.prepareGeneration({ lease, now: fixture.clock.now() });
  const live = await fixture.liveMutationAuthority.authorize({
    producerLease: lease,
    assertProducerLease: fixture.producerRepository.assertLease,
    residentLeaseContext: fixture.resident,
    assertAutonomyCurrent: fixture.assertAutonomyCurrent,
    plannedGeneration: plan.plannedGeneration,
    expected: {
      machineIntakeConfigurationHash: fixture.configuration.configurationHash,
      producerProfileHash: fixture.profile.producerProfileHash,
      providerConfigurationHash: fixture.profile.providerConfigurationHash,
      implementationSha256: fixture.profile.implementationSha256,
    },
    beginProviderCanaryAction: fixture.producerRepository.beginProviderCanaryAction,
    finishProviderCanaryAction: fixture.producerRepository.finishProviderCanaryAction,
  });
  const capability = buildAutonomousResearchTopicProducerCapabilityReceipt({
    producerProfile: fixture.profile,
    machineIntakeConfigurationHash: fixture.configuration.configurationHash,
    generationSequence: plan.generationSequence,
    intake: plan.plannedGeneration.intake,
    plannedGeneration: plan.plannedGeneration,
    providerCanaryPairReceipt: live.providerCanaryPairReceipt,
    producerLeaseGeneration: lease.leaseGeneration,
    producerLeaseTokenHash: hashRecord(
      'AutonomousResearchTopicProducerLeaseToken', lease.leaseToken,
    ),
    residentLeaseGeneration: fixture.resident.lease.leaseGeneration,
    residentLeaseTokenHash: hashRecord(
      'AutonomousResearchResidentLeaseToken', fixture.resident.lease.leaseToken,
    ),
    capabilityNonce: live.capabilityNonce,
    now: fixture.clock.now(),
  });
  const opaque = fixture.producerRepository.issueAppendAuthorization({
    lease,
    plannedGeneration: plan.plannedGeneration,
    capability,
    intake: plan.plannedGeneration.intake,
    liveMutationAuthorization: live.authorization,
    now: fixture.clock.now(),
  });
  fixture.machineIntakeRepository.appendMachineIntake({
    intake: plan.plannedGeneration.intake,
    sourceAuthorityHash: fixture.configuration.configurationHash,
    topicProducerCapabilityReceipt: capability,
    topicProducerAppendAuthorization: opaque,
    now: fixture.clock.now(),
  });
  fixture.producerRepository.releaseLease({ lease });
  assert.equal(fixture.canaryCalls(), 1);
  fixture.setNow('2026-07-17T00:00:02.000Z');
  const recovered = await fixture.producer.reconcile({
    residentLeaseContext: fixture.resident,
    assertAutonomyCurrent: fixture.assertAutonomyCurrent,
  });
  assert.equal(recovered.status,
    'autonomous_research_topic_producer_committed_append_recovered');
  assert.equal(recovered.recovered, true);
  assert.equal(fixture.canaryCalls(), 1);
  assert.equal(fixture.producerRepository.readStatus({ now: fixture.clock.now() })
    .producedTopicCount, 1);
});

test('provider failure, cross-midnight plan, and clock rollback are fail-closed and bounded', async (t) => {
  const unavailable = setup(t, { canaryFailure: 'provider_unavailable' });
  const failed = await unavailable.producer.reconcile({
    residentLeaseContext: unavailable.resident,
    assertAutonomyCurrent: unavailable.assertAutonomyCurrent,
  });
  assert.equal(failed.ready, false);
  assert.equal(failed.error, 'provider_canary_runner_unattributed_failed');
  assert.equal(failed.externalActionPerformed, false);
  assert.equal(failed.externalActionMayHaveOccurred, true);
  assert.equal(unavailable.machineIntakeRepository.readStatus().pendingProductionCount, 0);
  const retrySuppressed = await unavailable.producer.reconcile({
    residentLeaseContext: unavailable.resident,
    assertAutonomyCurrent: unavailable.assertAutonomyCurrent,
  });
  assert.equal(retrySuppressed.externalActionPerformed, false);
  assert.equal(unavailable.canaryCalls(), 1);

  const midnight = setup(t, { initialNow: new Date('2026-07-17T23:59:59.000Z') });
  const oldLease = midnight.producerRepository.tryAcquireLease({
    ownerId: 'producer:midnight-old', leaseMs: 1000, now: midnight.clock.now(),
  });
  const oldPlan = midnight.producerRepository.prepareGeneration({
    lease: oldLease, now: midnight.clock.now(),
  });
  assert.equal(oldPlan.plannedGeneration.budgetEpochStart, '2026-07-17T00:00:00.000Z');
  midnight.producerRepository.releaseLease({ lease: oldLease });
  midnight.setNow('2026-07-18T00:00:01.000Z');
  const current = await midnight.producer.reconcile({
    residentLeaseContext: midnight.resident,
    assertAutonomyCurrent: midnight.assertAutonomyCurrent,
  });
  assert.equal(current.generated, true);
  assert.equal(midnight.canaryCalls(), 1);
  assert.equal(midnight.producerRepository.readGeneration(1).status, 'failed');
  assert.equal(midnight.producerRepository.readGeneration(2).plannedGeneration
    .budgetEpochStart, '2026-07-18T00:00:00.000Z');
  assert.equal(midnight.producerRepository.readStatus({ now: midnight.clock.now() })
    .providerCanaryAttemptCount, 1);

  const rollback = setup(t, { initialNow: new Date('2026-07-17T23:50:00.000Z') });
  const rollbackLease = rollback.producerRepository.tryAcquireLease({
    ownerId: 'producer:rollback', leaseMs: 15 * 60 * 1000, now: rollback.clock.now(),
  });
  rollback.setNow('2026-07-18T00:00:00.000Z');
  rollback.producerRepository.renewLease({
    lease: rollbackLease, leaseMs: 15 * 60 * 1000, now: rollback.clock.now(),
  });
  rollback.setNow('2026-07-17T23:55:00.000Z');
  assert.throws(() => rollback.producerRepository.prepareGeneration({
    lease: rollbackLease, now: rollback.clock.now(),
  }), /clock_rollback_detected/);
});

test('durable author checkpoint survives process loss and forbids same-reservation replay',
  (t) => {
    const fixture = setup(t);
    const lease = fixture.producerRepository.tryAcquireLease({
      ownerId: 'producer:sigkill', leaseMs: 1000, now: fixture.clock.now(),
    });
    const plan = fixture.producerRepository.prepareGeneration({
      lease,
      now: fixture.clock.now(),
    });
    const reservation = canaryReservationFor(plan.plannedGeneration);
    fixture.producerRepository.beginProviderCanaryAction({
      lease,
      generationSequence: plan.generationSequence,
      reservation,
      role: 'research_author',
      failurePhase: 'research_author_canary',
      now: fixture.clock.now(),
    });
    // The external author call may now have succeeded, but SIGKILL prevented its outcome checkpoint.
    assert.equal(fixture.producerRepository.readGeneration(1)
      .providerCanaryAttemptJournal.currentRole, 'research_author');

    // SIGKILL equivalent: the durable author checkpoint exists, but no failure catch ran.
    fixture.producerRepository.close();
    fixture.setNow('2026-07-17T00:00:02.000Z');
    const reopened = createAutonomousResearchTopicProducerRepository({
      runtimeRoot: fixture.runtimeRoot,
      machineIntakeConfigurationHash: fixture.configuration.configurationHash,
      producerProfile: fixture.profile,
      providerCanaryPairMaximumCostUsd: 1,
      liveMutationAuthority: fixture.liveMutationAuthority,
    });
    t.after(() => { try { reopened.close(); } catch { /* already closed */ } });
    const recoveryLease = reopened.tryAcquireLease({
      ownerId: 'producer:restart', leaseMs: 1000, now: fixture.clock.now(),
    });
    assert.ok(recoveryLease);
    assert.equal(reopened.prepareGeneration({
      lease: recoveryLease,
      now: fixture.clock.now(),
    }), null);
    const recovered = reopened.readGeneration(1);
    assert.equal(recovered.status, 'failed');
    assert.equal(recovered.providerCanarySideEffectInspection.actionAccountingComplete, false);
    assert.equal(recovered.providerCanarySideEffectInspection.externalActionMayHaveOccurred, true);
    assert.equal(recovered.providerCanarySideEffectInspection.actions.length, 0);
    const afterRecovery = reopened.readStatus({ now: fixture.clock.now() });
    assert.equal(afterRecovery.providerCanaryAttemptCount, 1);
    assert.equal(afterRecovery.providerCanaryReservedCostUsd, 1);
    assert.equal(afterRecovery.producedTopicCount, 1);
    reopened.releaseLease({ lease: recoveryLease });

    fixture.setNow(afterRecovery.nextAttemptAt);
    const retryLease = reopened.tryAcquireLease({
      ownerId: 'producer:new-reservation', leaseMs: 1000, now: fixture.clock.now(),
    });
    const retry = reopened.prepareGeneration({ lease: retryLease, now: fixture.clock.now() });
    assert.equal(retry.generationSequence, 2);
    assert.notEqual(retry.plannedGeneration.budgetReservationId,
      plan.plannedGeneration.budgetReservationId);
    assert.notEqual(retry.plannedGeneration.producerTopicId,
      plan.plannedGeneration.producerTopicId);
    const afterRetry = reopened.readStatus({ now: fixture.clock.now() });
    assert.equal(afterRetry.providerCanaryAttemptCount, 2);
    assert.equal(afterRetry.providerCanaryReservedCostUsd, 2);
    assert.equal(afterRetry.producedTopicCount, 2);
    reopened.releaseLease({ lease: retryLease });
  });

test('authorized uncommitted generation is conservatively closed without canary replay',
  async (t) => {
    const fixture = setup(t);
    const lease = fixture.producerRepository.tryAcquireLease({
      ownerId: 'producer:authorized-crash', leaseMs: 1000, now: fixture.clock.now(),
    });
    const plan = fixture.producerRepository.prepareGeneration({
      lease,
      now: fixture.clock.now(),
    });
    const live = await fixture.liveMutationAuthority.authorize({
      producerLease: lease,
      assertProducerLease: fixture.producerRepository.assertLease,
      residentLeaseContext: fixture.resident,
      assertAutonomyCurrent: fixture.assertAutonomyCurrent,
      plannedGeneration: plan.plannedGeneration,
      expected: {
        machineIntakeConfigurationHash: fixture.configuration.configurationHash,
        producerProfileHash: fixture.profile.producerProfileHash,
        providerConfigurationHash: fixture.profile.providerConfigurationHash,
        implementationSha256: fixture.profile.implementationSha256,
      },
      beginProviderCanaryAction: fixture.producerRepository.beginProviderCanaryAction,
      finishProviderCanaryAction: fixture.producerRepository.finishProviderCanaryAction,
    });
    const capability = buildAutonomousResearchTopicProducerCapabilityReceipt({
      producerProfile: fixture.profile,
      machineIntakeConfigurationHash: fixture.configuration.configurationHash,
      generationSequence: plan.generationSequence,
      intake: plan.plannedGeneration.intake,
      plannedGeneration: plan.plannedGeneration,
      providerCanaryPairReceipt: live.providerCanaryPairReceipt,
      producerLeaseGeneration: lease.leaseGeneration,
      producerLeaseTokenHash: hashRecord(
        'AutonomousResearchTopicProducerLeaseToken', lease.leaseToken,
      ),
      residentLeaseGeneration: fixture.resident.lease.leaseGeneration,
      residentLeaseTokenHash: hashRecord(
        'AutonomousResearchResidentLeaseToken', fixture.resident.lease.leaseToken,
      ),
      capabilityNonce: live.capabilityNonce,
      now: fixture.clock.now(),
    });
    fixture.producerRepository.issueAppendAuthorization({
      lease,
      plannedGeneration: plan.plannedGeneration,
      capability,
      intake: plan.plannedGeneration.intake,
      liveMutationAuthorization: live.authorization,
      now: fixture.clock.now(),
    });
    assert.equal(fixture.producerRepository.readGeneration(1).status, 'authorized');
    assert.equal(fixture.canaryCalls(), 1);

    fixture.producerRepository.close();
    fixture.setNow('2026-07-17T00:00:02.000Z');
    const reopened = createAutonomousResearchTopicProducerRepository({
      runtimeRoot: fixture.runtimeRoot,
      machineIntakeConfigurationHash: fixture.configuration.configurationHash,
      producerProfile: fixture.profile,
      providerCanaryPairMaximumCostUsd: 1,
      liveMutationAuthority: fixture.liveMutationAuthority,
    });
    t.after(() => { try { reopened.close(); } catch { /* already closed */ } });
    const recoveryLease = reopened.tryAcquireLease({
      ownerId: 'producer:authorized-restart', leaseMs: 1000, now: fixture.clock.now(),
    });
    assert.equal(reopened.prepareGeneration({
      lease: recoveryLease,
      now: fixture.clock.now(),
    }), null);
    const recovered = reopened.readGeneration(1);
    assert.equal(recovered.status, 'failed');
    assert.equal(recovered.providerCanarySideEffectInspection.actionAccountingComplete, false);
    assert.equal(recovered.providerCanarySideEffectInspection.actions.length, 2);
    assert.equal(reopened.readStatus({ now: fixture.clock.now() }).providerCanaryAttemptCount, 1);
    assert.equal(fixture.canaryCalls(), 1);
    reopened.releaseLease({ lease: recoveryLease });
  });

test('author success and reviewer failure persist a restart-auditable bounded side-effect receipt',
  async (t) => {
    const providerConfiguration = providerConfigurationFixture();
    const probeRoles = [];
    const secretBearingError = new Error('reviewer failed token=do-not-persist');
    const fixture = setup(t, {
      providerConfigurationHash:
        providerConfiguration.autonomousResearchProviderConfigurationHash,
      providerCanaryRunner: instrumentedCanaryRunner(providerConfiguration, {
        probeRoles,
        reviewerError: secretBearingError,
      }),
    });

    const failed = await fixture.producer.reconcile({
      residentLeaseContext: fixture.resident,
      assertAutonomyCurrent: fixture.assertAutonomyCurrent,
    });
    assert.equal(failed.ready, false);
    assert.deepEqual(probeRoles, ['author', 'reviewer']);
    const generation = fixture.producerRepository.readGeneration(1);
    const inspection = generation.providerCanarySideEffectInspection;
    assert.equal(generation.status, 'failed');
    assert.equal(generation.error, 'formal_reviewer_canary_failed');
    assert.equal(inspection.actionAccountingComplete, true);
    assert.equal(inspection.providerCanaryActionCount, 2);
    assert.equal(inspection.successfulProviderCanaryActionCount, 1);
    assert.equal(inspection.failedProviderCanaryActionCount, 1);
    assert.equal(inspection.researchAuthorCanaryAttemptCount, 1);
    assert.equal(inspection.formalReviewerCanaryAttemptCount, 1);
    assert.equal(inspection.actions[0].status, 'succeeded');
    assert.equal(inspection.actions[1].status, 'failed');
    assert.equal(inspection.reservation.providerCanaryReservedAttemptCount, 1);
    assert.equal(inspection.reservation.providerCanaryReservedCostUsd, 1);
    assert.equal(inspection.reservation.budgetReservationId,
      generation.plannedGeneration.budgetReservationId);
    assert.equal(verifyAutonomousResearchProviderCanarySideEffectInspection(inspection, {
      providerConfigurationHash: fixture.profile.providerConfigurationHash,
      reservation: inspection.reservation,
    }), true);
    assert.equal(JSON.stringify(inspection).includes('do-not-persist'), false);
    const status = fixture.producerRepository.readStatus({ now: fixture.clock.now() });
    assert.equal(status.providerCanaryAttemptCount, 1);
    assert.equal(status.providerCanaryReservedCostUsd, 1);
    const retryDeferred = await fixture.producer.reconcile({
      residentLeaseContext: fixture.resident,
      assertAutonomyCurrent: fixture.assertAutonomyCurrent,
    });
    assert.equal(retryDeferred.externalActionPerformed, false);
    assert.deepEqual(probeRoles, ['author', 'reviewer']);

    const databasePath = fixture.producerRepository.databasePath;
    fixture.producerRepository.close();
    const reopened = createAutonomousResearchTopicProducerRepository({
      runtimeRoot: fixture.runtimeRoot,
      machineIntakeConfigurationHash: fixture.configuration.configurationHash,
      producerProfile: fixture.profile,
      providerCanaryPairMaximumCostUsd: 1,
      liveMutationAuthority: fixture.liveMutationAuthority,
      create: false,
    });
    assert.equal(reopened.readGeneration(1)
      .providerCanarySideEffectInspection
      .autonomousResearchProviderCanarySideEffectInspectionHash,
    inspection.autonomousResearchProviderCanarySideEffectInspectionHash);
    reopened.close();

    const database = new DatabaseSync(databasePath);
    const stored = database.prepare(`SELECT provider_canary_side_effect_inspection_json
      FROM autonomous_research_topic_producer_generation
      WHERE generation_sequence=1`).get();
    const corrupted = JSON.parse(stored.provider_canary_side_effect_inspection_json);
    corrupted.successfulProviderCanaryActionCount = 2;
    database.prepare(`UPDATE autonomous_research_topic_producer_generation
      SET provider_canary_side_effect_inspection_json=?
      WHERE generation_sequence=1`).run(JSON.stringify(corrupted));
    database.close();
    const corruptedRepository = createAutonomousResearchTopicProducerRepository({
      runtimeRoot: fixture.runtimeRoot,
      machineIntakeConfigurationHash: fixture.configuration.configurationHash,
      producerProfile: fixture.profile,
      providerCanaryPairMaximumCostUsd: 1,
      liveMutationAuthority: fixture.liveMutationAuthority,
      create: false,
    });
    assert.throws(() => corruptedRepository.readGeneration(1),
      /autonomous_research_topic_producer_state_invalid/);
    corruptedRepository.close();
  });

test('receipt persistence failure is explicit, non-retryable, and recovered without replay',
  async (t) => {
    const providerConfiguration = providerConfigurationFixture();
    const probeRoles = [];
    const fixture = setup(t, {
      providerConfigurationHash:
        providerConfiguration.autonomousResearchProviderConfigurationHash,
      providerCanaryRunner: instrumentedCanaryRunner(providerConfiguration, {
        probeRoles,
        reviewerError: new Error('reviewer_failed'),
      }),
      failGenerationError: new Error('injected_sqlite_ioerr'),
    });
    const failed = await fixture.producer.reconcile({
      residentLeaseContext: fixture.resident,
      assertAutonomyCurrent: fixture.assertAutonomyCurrent,
    });
    assert.equal(failed.ready, false);
    assert.equal(failed.status,
      'autonomous_research_topic_producer_failure_persistence_failed');
    assert.equal(failed.persistenceVerified, false);
    assert.equal(failed.retryable, false);
    assert.equal(failed.externalActionPerformed, true);
    assert.equal(failed.externalActionMayHaveOccurred, true);
    assert.equal(failed.error,
      'autonomous_research_topic_producer_failure_persistence_failed');
    assert.deepEqual(probeRoles, ['author', 'reviewer']);
    const unfinalized = fixture.producerRepository.readGeneration(1);
    assert.equal(unfinalized.status, 'planned');
    assert.equal(unfinalized.providerCanaryAttemptStarted, true);
    assert.equal(unfinalized.providerCanaryAttemptJournal.actions.length, 2);
    assert.equal(unfinalized.providerCanarySideEffectInspection, null);

    const recovered = await fixture.producer.reconcile({
      residentLeaseContext: fixture.resident,
      assertAutonomyCurrent: fixture.assertAutonomyCurrent,
    });
    assert.equal(recovered.status,
      'autonomous_research_topic_producer_interrupted_canary_recovered');
    assert.equal(recovered.persistenceVerified, true);
    assert.equal(recovered.externalActionPerformed, false);
    assert.equal(recovered.externalActionMayHaveOccurred, true);
    assert.equal(recovered.generation.providerCanarySideEffectInspection
      .actionAccountingComplete, false);
    assert.equal(recovered.generation.providerCanarySideEffectInspection
      .externalActionMayHaveOccurred, true);
    assert.deepEqual(probeRoles, ['author', 'reviewer']);
    const budget = fixture.producerRepository.readStatus({ now: fixture.clock.now() });
    assert.equal(budget.providerCanaryAttemptCount, 1);
    assert.equal(budget.providerCanaryReservedCostUsd, 1);
  });

test('failed provider-attempt receipt deletion is rejected while pre-provider failures remain readable',
  async (t) => {
    const providerConfiguration = providerConfigurationFixture();
    const fixture = setup(t, {
      providerConfigurationHash:
        providerConfiguration.autonomousResearchProviderConfigurationHash,
      providerCanaryRunner: instrumentedCanaryRunner(providerConfiguration, {
        reviewerError: new Error('reviewer_failed'),
      }),
    });
    await fixture.producer.reconcile({
      residentLeaseContext: fixture.resident,
      assertAutonomyCurrent: fixture.assertAutonomyCurrent,
    });
    const databasePath = fixture.producerRepository.databasePath;
    fixture.producerRepository.close();
    const database = new DatabaseSync(databasePath);
    database.prepare(`UPDATE autonomous_research_topic_producer_generation
      SET provider_canary_side_effect_inspection_json=NULL
      WHERE generation_sequence=1`).run();
    database.close();
    const tampered = createAutonomousResearchTopicProducerRepository({
      runtimeRoot: fixture.runtimeRoot,
      machineIntakeConfigurationHash: fixture.configuration.configurationHash,
      producerProfile: fixture.profile,
      providerCanaryPairMaximumCostUsd: 1,
      liveMutationAuthority: fixture.liveMutationAuthority,
      create: false,
    });
    assert.throws(() => tampered.readGeneration(1),
      /autonomous_research_topic_producer_state_invalid/);
    tampered.close();
    assert.equal(inspectAutonomousResearchTopicProducerStatus({
      runtimeRoot: fixture.runtimeRoot,
      machineIntakeConfigurationHash: fixture.configuration.configurationHash,
      producerProfile: fixture.profile,
      implementationSha256: fixture.profile.implementationSha256,
      now: fixture.clock.now(),
    }).blocker, 'autonomous_research_topic_producer_state_invalid');

    const clean = setup(t);
    const lease = clean.producerRepository.tryAcquireLease({
      ownerId: 'producer:pre-provider-failure',
      leaseMs: 1000,
      now: clean.clock.now(),
    });
    const plan = clean.producerRepository.prepareGeneration({
      lease,
      now: clean.clock.now(),
    });
    clean.producerRepository.failGeneration({
      lease,
      generationSequence: plan.generationSequence,
      error: new Error('autonomy_changed_before_provider_action'),
      retryAfterMs: 60_000,
      now: clean.clock.now(),
    });
    const preProvider = clean.producerRepository.readGeneration(1);
    assert.equal(preProvider.status, 'failed');
    assert.equal(preProvider.providerCanaryAttemptStarted, false);
    assert.equal(preProvider.providerCanaryAttemptJournal, null);
    assert.equal(preProvider.providerCanarySideEffectInspection, null);
    clean.producerRepository.close();
    const cleanReopened = createAutonomousResearchTopicProducerRepository({
      runtimeRoot: clean.runtimeRoot,
      machineIntakeConfigurationHash: clean.configuration.configurationHash,
      producerProfile: clean.profile,
      providerCanaryPairMaximumCostUsd: 1,
      liveMutationAuthority: clean.liveMutationAuthority,
      create: false,
    });
    assert.equal(cleanReopened.readGeneration(1).error,
      'autonomy_changed_before_provider_action');
    cleanReopened.close();
  });

test('between-role fence failure records the completed author action without reviewer execution',
  async (t) => {
    const providerConfiguration = providerConfigurationFixture();
    const probeRoles = [];
    const fixture = setup(t, {
      providerConfigurationHash:
        providerConfiguration.autonomousResearchProviderConfigurationHash,
      providerCanaryRunner: instrumentedCanaryRunner(providerConfiguration, { probeRoles }),
    });
    const failed = await fixture.producer.reconcile({
      residentLeaseContext: fixture.resident,
      assertAutonomyCurrent({ action }) {
        return Object.freeze({
          ready: true,
          operationMode: action === 'topic_producer_provider_canary_between_roles'
            ? 'bootstrap-only' : 'full',
        });
      },
    });
    assert.equal(failed.ready, false);
    assert.deepEqual(probeRoles, ['author']);
    const inspection = fixture.producerRepository.readGeneration(1)
      .providerCanarySideEffectInspection;
    assert.equal(inspection.failurePhase, 'between_role_fence');
    assert.equal(inspection.providerCanaryActionCount, 1);
    assert.equal(inspection.successfulProviderCanaryActionCount, 1);
    assert.equal(inspection.failedProviderCanaryActionCount, 0);
    assert.equal(inspection.formalReviewerCanaryAttemptCount, 0);
    assert.equal(fixture.producerRepository.readStatus({ now: fixture.clock.now() })
      .providerCanaryReservedCostUsd, 1);
  });

test('post-canary authority fence failure preserves both successful external actions', async (t) => {
  const providerConfiguration = providerConfigurationFixture();
  const probeRoles = [];
  let measurements = 0;
  const fixture = setup(t, {
    providerConfigurationHash:
      providerConfiguration.autonomousResearchProviderConfigurationHash,
    providerCanaryRunner: instrumentedCanaryRunner(providerConfiguration, { probeRoles }),
    authorityRemeasure() {
      measurements += 1;
      return Object.freeze({
        ready: true,
        authorityMeasurementHash: H(measurements === 1 ? 'current-authority' : 'rotated-authority'),
      });
    },
  });
  const failed = await fixture.producer.reconcile({
    residentLeaseContext: fixture.resident,
    assertAutonomyCurrent: fixture.assertAutonomyCurrent,
  });
  assert.equal(failed.ready, false);
  assert.deepEqual(probeRoles, ['author', 'reviewer']);
  const inspection = fixture.producerRepository.readGeneration(1)
    .providerCanarySideEffectInspection;
  assert.equal(inspection.failurePhase, 'post_canary_authority_fence');
  assert.equal(inspection.providerCanaryActionCount, 2);
  assert.equal(inspection.successfulProviderCanaryActionCount, 2);
  assert.equal(inspection.failedProviderCanaryActionCount, 0);
  assert.equal(inspection.reservation.providerCanaryReservedCostUsd, 1);
  const status = fixture.producerRepository.readStatus({ now: fixture.clock.now() });
  assert.equal(status.providerCanaryAttemptCount, 1);
  assert.equal(status.providerCanaryReservedCostUsd, 1);
});

test('generation-authorization fence failure persists the completed canary pair', async (t) => {
  const providerConfiguration = providerConfigurationFixture();
  const probeRoles = [];
  const fixture = setup(t, {
    providerConfigurationHash:
      providerConfiguration.autonomousResearchProviderConfigurationHash,
    providerCanaryRunner: instrumentedCanaryRunner(providerConfiguration, { probeRoles }),
  });
  const failed = await fixture.producer.reconcile({
    residentLeaseContext: fixture.resident,
    assertAutonomyCurrent({ action }) {
      return Object.freeze({
        ready: true,
        operationMode: action === 'topic_producer_generation_authorization'
          ? 'bootstrap-only' : 'full',
      });
    },
  });
  assert.equal(failed.ready, false);
  assert.deepEqual(probeRoles, ['author', 'reviewer']);
  const generation = fixture.producerRepository.readGeneration(1);
  const inspection = generation.providerCanarySideEffectInspection;
  assert.equal(generation.status, 'failed');
  assert.equal(inspection.failurePhase, 'post_canary_generation_fence');
  assert.equal(inspection.actionAccountingComplete, true);
  assert.equal(inspection.providerCanaryActionCount, 2);
  assert.equal(inspection.successfulProviderCanaryActionCount, 2);
  assert.equal(inspection.failedProviderCanaryActionCount, 0);
  assert.equal(fixture.producerRepository.readStatus({ now: fixture.clock.now() })
    .providerCanaryReservedCostUsd, 1);
});

for (const migrationCase of [
  Object.freeze({ label: 'planned', authorize: false, committed: false }),
  Object.freeze({ label: 'authorized', authorize: true, committed: false }),
  Object.freeze({ label: 'authorized committed', authorize: true, committed: true }),
]) {
  test(`legacy ${migrationCase.label} in-flight upgrade cannot replay its canary reservation`,
    async (t) => {
      const fixture = setup(t);
      const lease = fixture.producerRepository.tryAcquireLease({
        ownerId: `producer:legacy-${migrationCase.label.replace(' ', '-')}`,
        leaseMs: 1000,
        now: fixture.clock.now(),
      });
      const plan = fixture.producerRepository.prepareGeneration({
        lease,
        now: fixture.clock.now(),
      });
      const live = await fixture.liveMutationAuthority.authorize({
        producerLease: lease,
        assertProducerLease: fixture.producerRepository.assertLease,
        residentLeaseContext: fixture.resident,
        assertAutonomyCurrent: fixture.assertAutonomyCurrent,
        plannedGeneration: plan.plannedGeneration,
        expected: {
          machineIntakeConfigurationHash: fixture.configuration.configurationHash,
          producerProfileHash: fixture.profile.producerProfileHash,
          providerConfigurationHash: fixture.profile.providerConfigurationHash,
          implementationSha256: fixture.profile.implementationSha256,
        },
        beginProviderCanaryAction: fixture.producerRepository.beginProviderCanaryAction,
        finishProviderCanaryAction: fixture.producerRepository.finishProviderCanaryAction,
      });
      if (migrationCase.authorize) {
        const capability = buildAutonomousResearchTopicProducerCapabilityReceipt({
          producerProfile: fixture.profile,
          machineIntakeConfigurationHash: fixture.configuration.configurationHash,
          generationSequence: plan.generationSequence,
          intake: plan.plannedGeneration.intake,
          plannedGeneration: plan.plannedGeneration,
          providerCanaryPairReceipt: live.providerCanaryPairReceipt,
          producerLeaseGeneration: lease.leaseGeneration,
          producerLeaseTokenHash: hashRecord(
            'AutonomousResearchTopicProducerLeaseToken', lease.leaseToken,
          ),
          residentLeaseGeneration: fixture.resident.lease.leaseGeneration,
          residentLeaseTokenHash: hashRecord(
            'AutonomousResearchResidentLeaseToken', fixture.resident.lease.leaseToken,
          ),
          capabilityNonce: live.capabilityNonce,
          now: fixture.clock.now(),
        });
        const appendAuthorization = fixture.producerRepository.issueAppendAuthorization({
          lease,
          plannedGeneration: plan.plannedGeneration,
          capability,
          intake: plan.plannedGeneration.intake,
          liveMutationAuthorization: live.authorization,
          now: fixture.clock.now(),
        });
        if (migrationCase.committed) {
          fixture.machineIntakeRepository.appendMachineIntake({
            intake: plan.plannedGeneration.intake,
            sourceAuthorityHash: fixture.configuration.configurationHash,
            topicProducerCapabilityReceipt: capability,
            topicProducerAppendAuthorization: appendAuthorization,
            now: fixture.clock.now(),
          });
        }
      }
      assert.equal(fixture.canaryCalls(), 1);
      assert.equal(fixture.producerRepository.readGeneration(1).status,
        migrationCase.authorize ? 'authorized' : 'planned');

      const databasePath = fixture.producerRepository.databasePath;
      fixture.machineIntakeRepository.close();
      fixture.producerRepository.close();
      dropTopicProducerCanaryJournalColumns(databasePath);
      fixture.setNow('2026-07-17T00:00:02.000Z');

      const reopened = reopenProducerRepository(fixture);
      t.after(() => { try { reopened.close(); } catch { /* already closed */ } });
      const migrated = reopened.readGeneration(1);
      assert.equal(migrated.status, migrationCase.authorize ? 'authorized' : 'planned');
      assert.equal(migrated.providerCanaryAttemptStarted, true);
      assert.equal(migrated.providerCanaryAttemptJournal.failurePhase,
        'provider_canary_reserved');
      assert.deepEqual(migrated.providerCanaryAttemptJournal.actions, []);
      assert.equal(migrated.providerCanarySideEffectInspection, null);

      const reopenedMachine = createAutonomousResearchMachineIntakeRepository({
        runtimeRoot: fixture.runtimeRoot,
        authorizedSourceAuthorityHash: fixture.configuration.configurationHash,
        authorizedMachineProducerProfileHash: fixture.profile.producerProfileHash,
        machineProducerAppendAuthority: reopened,
      });
      t.after(() => { try { reopenedMachine.close(); } catch { /* already closed */ } });
      const coldProducer = createAutonomousResearchTopicProducer({
        configuration: fixture.configuration,
        producerProfile: fixture.profile,
        producerRepository: reopened,
        machineIntakeRepository: reopenedMachine,
        liveMutationAuthority: fixture.liveMutationAuthority,
        clock: fixture.clock,
        ownerId: `producer:legacy-restart-${migrationCase.label.replace(' ', '-')}`,
      });
      const coldResult = await coldProducer.reconcile({
        residentLeaseContext: fixture.resident,
        assertAutonomyCurrent: fixture.assertAutonomyCurrent,
      });
      assert.equal(fixture.canaryCalls(), 1);

      if (migrationCase.committed) {
        assert.equal(coldResult.status,
          'autonomous_research_topic_producer_committed_append_recovered');
        assert.equal(coldResult.externalActionPerformed, false);
        assert.equal(reopened.readGeneration(1).status, 'produced');
        assert.equal(reopened.readGeneration(1).providerCanarySideEffectInspection, null);
        assert.equal(reopened.readStatus({ now: fixture.clock.now() })
          .providerCanaryAttemptCount, 1);
        return;
      }

      assert.equal(coldResult.status,
        'autonomous_research_topic_producer_interrupted_canary_recovered');
      assert.equal(coldResult.externalActionPerformed, false);
      assert.equal(coldResult.externalActionMayHaveOccurred, true);
      const recovered = reopened.readGeneration(1);
      assert.equal(recovered.status, 'failed');
      assert.equal(recovered.providerCanarySideEffectInspection.actionAccountingComplete, false);
      assert.equal(recovered.providerCanarySideEffectInspection.externalActionPerformed, false);
      assert.equal(recovered.providerCanarySideEffectInspection.externalActionMayHaveOccurred, true);
      assert.deepEqual(recovered.providerCanarySideEffectInspection.actions, []);
      const afterRecovery = reopened.readStatus({ now: fixture.clock.now() });
      assert.equal(afterRecovery.providerCanaryAttemptCount, 1);
      assert.equal(afterRecovery.providerCanaryReservedCostUsd, 1);
      assert.equal(afterRecovery.producedTopicCount, 1);

      fixture.setNow(afterRecovery.nextAttemptAt);
      const retryLease = reopened.tryAcquireLease({
        ownerId: `producer:legacy-retry-${migrationCase.label}`,
        leaseMs: 1000,
        now: fixture.clock.now(),
      });
      const retry = reopened.prepareGeneration({
        lease: retryLease,
        now: fixture.clock.now(),
      });
      assert.equal(retry.generationSequence, 2);
      assert.notEqual(retry.plannedGeneration.budgetReservationId,
        plan.plannedGeneration.budgetReservationId);
      assert.notEqual(retry.plannedGeneration.producerTopicId,
        plan.plannedGeneration.producerTopicId);
      assert.equal(fixture.canaryCalls(), 1);
      const afterRetry = reopened.readStatus({ now: fixture.clock.now() });
      assert.equal(afterRetry.providerCanaryAttemptCount, 2);
      assert.equal(afterRetry.providerCanaryReservedCostUsd, 2);
      assert.equal(afterRetry.producedTopicCount, 2);
      reopened.releaseLease({ lease: retryLease });
    });
}
