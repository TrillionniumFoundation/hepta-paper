import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  buildAutonomousResearchTopicProducerCapabilityReceipt,
} from '../../paper-domain/automation/autonomous-research-topic-producer-contract.mjs';
import {
  attachAutonomousResearchProviderCanarySideEffectInspection,
  providerCanaryAction,
  verifyAutonomousResearchProviderCanarySideEffectInspection,
} from '../../paper-domain/automation/autonomous-research-provider-canary-side-effect-inspection.mjs';

function nowDate(clock) {
  const value = clock?.now ? clock.now() : new Date();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new Error('autonomous_research_topic_producer_clock_invalid');
  }
  return date;
}

function assertTopicProducerAutonomyCurrent({
  assertAutonomyCurrent,
  residentLeaseContext,
  clock,
  action,
} = {}) {
  if (!residentLeaseContext?.lease
    || typeof residentLeaseContext.assertCurrent !== 'function'
    || typeof assertAutonomyCurrent !== 'function') {
    throw new Error('autonomous_research_topic_producer_autonomy_fence_required');
  }
  const now = nowDate(clock);
  residentLeaseContext.assertCurrent({ now });
  const inspection = assertAutonomyCurrent({
    residentLeaseContext,
    requireFullOperationMode: true,
    action,
  });
  if (typeof inspection?.then === 'function' || inspection?.ready !== true
    || !['full', 'unrestricted'].includes(inspection.operationMode)) {
    throw new Error('autonomous_research_topic_producer_autonomy_fence_invalid');
  }
  return inspection;
}

function attachCompletedCanaryFailure(error, live, providerConfigurationHash) {
  if (!live?.providerCanaryPairReceipt || !live?.providerCanaryReservation) return error;
  const existing = error?.autonomousResearchProviderCanarySideEffectInspection;
  if (verifyAutonomousResearchProviderCanarySideEffectInspection(existing, {
    providerConfigurationHash,
    reservation: live.providerCanaryReservation,
  })) return error;
  let actions = [];
  let actionAccountingComplete = false;
  try {
    actions = [
      providerCanaryAction({
        role: 'research_author',
        receipt: live.providerCanaryPairReceipt.researchAuthorProviderCanaryReceipt,
      }),
      providerCanaryAction({
        role: 'formal_reviewer',
        receipt: live.providerCanaryPairReceipt.formalReviewerProviderCanaryReceipt,
      }),
    ];
    actionAccountingComplete = true;
  } catch { /* malformed successful runner output remains conservatively unattributed */ }
  return attachAutonomousResearchProviderCanarySideEffectInspection(error, {
    providerConfigurationHash,
    reservation: live.providerCanaryReservation,
    actions,
    actionAccountingComplete,
    failurePhase: 'post_canary_generation_fence',
  });
}

export function createAutonomousResearchTopicProducer({
  configuration,
  producerProfile,
  producerRepository,
  machineIntakeRepository,
  liveMutationAuthority,
  clock,
  ownerId,
  leaseMs = 15 * 60 * 1000,
  retryAfterMs = 15 * 60 * 1000,
} = {}) {
  if (configuration?.version !== 2
    || configuration.machineAppendEnabled !== true
    || configuration.machineProducerProfileHash !== producerProfile?.producerProfileHash
    || typeof producerRepository?.tryAcquireLease !== 'function'
    || typeof producerRepository?.beginProviderCanaryAction !== 'function'
    || typeof producerRepository?.finishProviderCanaryAction !== 'function'
    || typeof machineIntakeRepository?.appendMachineIntake !== 'function'
    || typeof liveMutationAuthority?.authorize !== 'function'
    || typeof clock?.now !== 'function'
    || typeof ownerId !== 'string' || !ownerId) {
    throw new Error('autonomous_research_topic_producer_dependencies_invalid');
  }

  async function reconcile({
    residentLeaseContext,
    assertAutonomyCurrent,
    signal = null,
  } = {}) {
    if (!residentLeaseContext?.lease || typeof residentLeaseContext.assertCurrent !== 'function'
      || typeof assertAutonomyCurrent !== 'function') {
      return Object.freeze({
        ready: false,
        status: 'autonomous_research_topic_producer_autonomy_fence_required',
        generated: false,
        externalActionPerformed: false,
      });
    }
    const lease = producerRepository.tryAcquireLease({ ownerId, leaseMs, now: nowDate(clock) });
    if (!lease) return Object.freeze({
      ready: true,
      status: 'autonomous_research_topic_producer_single_writer_active',
      generated: false,
      externalActionPerformed: false,
    });
    let plan = null;
    let appended = false;
    let live = null;
    try {
      assertTopicProducerAutonomyCurrent({
        assertAutonomyCurrent,
        residentLeaseContext,
        clock,
        action: 'topic_producer_reconciliation',
      });
      const outstanding = producerRepository.latestGeneration();
      if (outstanding?.status === 'authorized') {
        const committed = machineIntakeRepository.readIntake(
          outstanding.plannedGeneration.intake.intakeId,
        );
        if (committed) {
          assertTopicProducerAutonomyCurrent({
            assertAutonomyCurrent,
            residentLeaseContext,
            clock,
            action: 'topic_producer_committed_generation_recovery',
          });
          const recovered = producerRepository.recoverCommittedGeneration({
            lease,
            intakeRecord: committed,
            now: nowDate(clock),
          });
          return Object.freeze({
            ready: true,
            status: 'autonomous_research_topic_producer_committed_append_recovered',
            generated: true,
            recovered: true,
            externalActionPerformed: false,
            generation: recovered,
          });
        }
      }
      const fencedIntakeStatus = machineIntakeRepository.readStatus({ now: nowDate(clock) });
      if (fencedIntakeStatus.pendingProductionCount > 0) {
        return Object.freeze({
          ready: true,
          status: 'autonomous_research_topic_producer_suppressed_by_pending_production',
          generated: false,
          externalActionPerformed: false,
          pendingProductionCount: fencedIntakeStatus.pendingProductionCount,
        });
      }
      assertTopicProducerAutonomyCurrent({
        assertAutonomyCurrent,
        residentLeaseContext,
        clock,
        action: 'topic_producer_generation_prepare',
      });
      plan = producerRepository.prepareGeneration({ lease, now: nowDate(clock) });
      if (!plan) {
        const state = producerRepository.readStatus({ now: nowDate(clock) });
        const recoveredInspection = state.latestGeneration
          ?.providerCanarySideEffectInspection;
        if (state.latestGeneration?.status === 'failed'
          && recoveredInspection?.failurePhase === 'provider_canary_restart_recovery') {
          return Object.freeze({
            ready: false,
            status: 'autonomous_research_topic_producer_interrupted_canary_recovered',
            generated: false,
            externalActionPerformed: false,
            externalActionMayHaveOccurred:
              recoveredInspection.externalActionMayHaveOccurred === true,
            persistenceVerified: true,
            retryable: true,
            generation: state.latestGeneration,
            state,
          });
        }
        return Object.freeze({
          ready: state.clockMonotonic
            && (state.canaryBudgetAvailable || state.nextAttemptAt !== null)
            && state.topicBudgetAvailable,
          status: state.currentlyProducible
            ? 'autonomous_research_topic_producer_generation_not_due'
            : 'autonomous_research_topic_producer_budget_or_rate_deferred',
          generated: false,
          externalActionPerformed: false,
          state,
        });
      }
      const expected = Object.freeze({
        machineIntakeConfigurationHash: configuration.configurationHash,
        producerProfileHash: producerProfile.producerProfileHash,
        providerConfigurationHash: producerProfile.providerConfigurationHash,
        implementationSha256: producerProfile.implementationSha256,
      });
      live = await liveMutationAuthority.authorize({
        producerLease: lease,
        assertProducerLease: producerRepository.assertLease,
        residentLeaseContext,
        assertAutonomyCurrent,
        plannedGeneration: plan.plannedGeneration,
        expected,
        beginProviderCanaryAction: producerRepository.beginProviderCanaryAction,
        finishProviderCanaryAction: producerRepository.finishProviderCanaryAction,
        signal,
      });
      const capability = buildAutonomousResearchTopicProducerCapabilityReceipt({
        producerProfile,
        machineIntakeConfigurationHash: configuration.configurationHash,
        generationSequence: plan.generationSequence,
        intake: plan.plannedGeneration.intake,
        plannedGeneration: plan.plannedGeneration,
        providerCanaryPairReceipt: live.providerCanaryPairReceipt,
        producerLeaseGeneration: lease.leaseGeneration,
        producerLeaseTokenHash: hashRecord(
          'AutonomousResearchTopicProducerLeaseToken',
          lease.leaseToken,
        ),
        residentLeaseGeneration: residentLeaseContext.lease.leaseGeneration,
        residentLeaseTokenHash: hashRecord(
          'AutonomousResearchResidentLeaseToken',
          residentLeaseContext.lease.leaseToken,
        ),
        capabilityNonce: live.capabilityNonce,
        now: nowDate(clock),
      });
      const appendAuthorization = producerRepository.issueAppendAuthorization({
        lease,
        plannedGeneration: plan.plannedGeneration,
        capability,
        intake: plan.plannedGeneration.intake,
        liveMutationAuthorization: live.authorization,
        now: nowDate(clock),
      });
      assertTopicProducerAutonomyCurrent({
        assertAutonomyCurrent,
        residentLeaseContext,
        clock,
        action: 'topic_producer_machine_intake_append',
      });
      const append = machineIntakeRepository.appendMachineIntake({
        intake: plan.plannedGeneration.intake,
        sourceAuthorityHash: configuration.configurationHash,
        topicProducerCapabilityReceipt: capability,
        topicProducerAppendAuthorization: appendAuthorization,
        now: nowDate(clock),
      });
      appended = true;
      const generation = producerRepository.completeGeneration({
        lease,
        generationSequence: plan.generationSequence,
        intakeRecord: append.record,
        now: nowDate(clock),
      });
      return Object.freeze({
        ready: true,
        status: append.idempotent
          ? 'autonomous_research_topic_producer_intake_reconciled'
          : 'autonomous_research_topic_producer_intake_generated',
        generated: true,
        recovered: append.idempotent,
        externalActionPerformed: true,
        providerCanaryPairReceiptHash: capability.providerCanaryPairReceiptHash,
        capabilityReceiptHash:
          capability.autonomousResearchTopicProducerCapabilityReceiptHash,
        intakeId: append.record.intakeId,
        intakeHash: append.record.intakeHash,
        admissionHash: append.record.admissionHash,
        generation,
      });
    } catch (error) {
      const recordedError = attachCompletedCanaryFailure(
        error,
        live,
        producerProfile.providerConfigurationHash,
      );
      const sideEffectInspection =
        recordedError?.autonomousResearchProviderCanarySideEffectInspection || null;
      const externalActionPerformed =
        sideEffectInspection?.externalActionPerformed === true;
      let persistenceFailure = null;
      if (plan && !appended) {
        try {
          producerRepository.failGeneration({
            lease,
            generationSequence: plan.generationSequence,
            error: recordedError,
            retryAfterMs,
            now: nowDate(clock),
          });
        } catch (caught) {
          persistenceFailure = caught;
        }
      }
      if (persistenceFailure) {
        return Object.freeze({
          ready: false,
          status: 'autonomous_research_topic_producer_failure_persistence_failed',
          generated: false,
          externalActionPerformed,
          externalActionMayHaveOccurred: sideEffectInspection
            ? sideEffectInspection.externalActionMayHaveOccurred === true
            : Boolean(plan),
          persistenceVerified: false,
          retryable: false,
          error: 'autonomous_research_topic_producer_failure_persistence_failed',
        });
      }
      return Object.freeze({
        ready: false,
        status: 'autonomous_research_topic_producer_generation_failed',
        generated: false,
        externalActionPerformed,
        externalActionMayHaveOccurred:
          sideEffectInspection?.externalActionMayHaveOccurred === true,
        persistenceVerified: true,
        retryable: true,
        error: recordedError?.autonomousResearchProviderCanarySideEffectInspection
          ?.failureCode || String(recordedError?.message || recordedError),
      });
    } finally {
      try { producerRepository.releaseLease({ lease }); } catch { /* replacement owner wins */ }
    }
  }

  return Object.freeze({
    version: 1,
    kind: 'AutonomousResearchTopicProducer',
    reconcile,
  });
}
