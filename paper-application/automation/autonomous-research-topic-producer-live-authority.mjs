import crypto from 'node:crypto';
import {
  attachAutonomousResearchProviderCanarySideEffectInspection,
  providerCanaryAction,
  verifyAutonomousResearchProviderCanarySideEffectInspection,
} from '../../paper-domain/automation/autonomous-research-provider-canary-side-effect-inspection.mjs';

const authorizations = new WeakMap();

function hashBinding(hashRecord, kind, value) {
  return hashRecord(kind, value);
}

function assertSynchronousAutonomyCurrent({
  assertAutonomyCurrent,
  residentLeaseContext,
  now,
  action,
} = {}) {
  if (!residentLeaseContext?.lease
    || typeof residentLeaseContext.assertCurrent !== 'function'
    || typeof assertAutonomyCurrent !== 'function') {
    throw new Error('autonomous_research_topic_producer_autonomy_fence_required');
  }
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

export function createAutonomousResearchTopicProducerLiveAuthority({
  runProviderCanary,
  remeasureAuthorities,
  clock,
  hashRecord,
  providerCanaryPairMaximumCostUsd,
} = {}) {
  if (typeof runProviderCanary !== 'function'
    || typeof remeasureAuthorities !== 'function'
    || typeof clock?.now !== 'function'
    || typeof hashRecord !== 'function'
    || typeof providerCanaryPairMaximumCostUsd !== 'number'
    || !Number.isFinite(providerCanaryPairMaximumCostUsd)
    || providerCanaryPairMaximumCostUsd <= 0
    || providerCanaryPairMaximumCostUsd > 100) {
    throw new Error('autonomous_research_topic_producer_live_authority_dependencies_invalid');
  }

  async function authorize({
    producerLease,
    assertProducerLease,
    residentLeaseContext,
    assertAutonomyCurrent,
    plannedGeneration,
    expected,
    reconcileStateRecoverability = null,
    assertStateRecoverabilityCurrent = null,
    beginProviderCanaryAction,
    assertProviderCanaryActionPermit = null,
    finishProviderCanaryAction,
    signal = null,
  } = {}) {
    if (typeof beginProviderCanaryAction !== 'function'
      || typeof finishProviderCanaryAction !== 'function'
      || (assertProviderCanaryActionPermit !== null
        && typeof assertProviderCanaryActionPermit !== 'function')) {
      throw new Error('autonomous_research_topic_producer_provider_canary_journal_required');
    }
    const before = remeasureAuthorities(expected);
    if (before?.ready !== true) {
      throw new Error(before?.blocker || 'autonomous_research_topic_producer_authority_not_current');
    }
    const beforeNow = clock.now();
    assertProducerLease({ lease: producerLease, now: beforeNow });
    assertSynchronousAutonomyCurrent({
      assertAutonomyCurrent,
      residentLeaseContext,
      now: beforeNow,
      action: 'topic_producer_provider_canary',
    });
    if (signal?.aborted) throw new Error('autonomous_research_topic_producer_aborted');
    const providerCanaryReservation = Object.freeze({
      generationSequence: plannedGeneration.generationSequence,
      plannedGenerationHash: plannedGeneration.plannedGenerationHash,
      budgetReservationId: plannedGeneration.budgetReservationId,
      budgetEpochStart: plannedGeneration.budgetEpochStart,
      providerCanaryReservedAttemptCount: 1,
      providerCanaryReservedCostUsd: providerCanaryPairMaximumCostUsd,
    });
    let providerCanaryPairReceipt = null;
    let after = null;
    let afterNow = null;
    let failurePhase = 'provider_canary_runner_unattributed';
    const durableActionJournalTransitions = [];
    const durableActions = [];
    const pendingCanaryCallbacks = [];
    const trackedCallback = (callback) => (...args) => {
      const completion = Promise.resolve().then(() => callback(...args));
      // Injectable runners written before the callbacks became async may not
      // await them. Track every invocation so reconciliation and journal errors
      // are still joined here rather than escaping as unhandled rejections.
      pendingCanaryCallbacks.push(completion);
      completion.catch(() => {});
      return completion;
    };
    try {
      providerCanaryPairReceipt = await runProviderCanary({
        expectedProviderConfigurationHash: expected.providerConfigurationHash,
        providerCanaryReservation,
        signal,
        beforePreflightAction: trackedCallback(async ({ role = 'unspecified' } = {}) => {
          await reconcileStateRecoverability?.({
            residentLeaseContext,
            action: `topic_producer_provider_canary_${role}`,
          });
          assertStateRecoverabilityCurrent?.(
            `topic_producer_provider_canary_${role}_side_effect`,
          );
        }),
        beforeCanaryAction: trackedCallback(async ({
          role,
          failurePhase: actionFailurePhase,
        }) => {
          const actionNow = clock.now();
          assertProducerLease({ lease: producerLease, now: actionNow });
          assertSynchronousAutonomyCurrent({
            assertAutonomyCurrent,
            residentLeaseContext,
            now: actionNow,
            action: `topic_producer_provider_canary_${role}_side_effect_permit`,
          });
          const journal = beginProviderCanaryAction({
            lease: producerLease,
            generationSequence: plannedGeneration.generationSequence,
            reservation: providerCanaryReservation,
            role,
            failurePhase: actionFailurePhase,
            now: actionNow,
          });
          durableActionJournalTransitions.push(`begin:${role}`);
          await reconcileStateRecoverability?.({
            residentLeaseContext,
            action: `topic_producer_provider_canary_${role}_journal`,
          });
          assertStateRecoverabilityCurrent?.(
            `topic_producer_provider_canary_${role}_side_effect`,
          );
          if (assertProviderCanaryActionPermit) {
            const permitted = assertProviderCanaryActionPermit({
              journal,
              lease: producerLease,
              generationSequence: plannedGeneration.generationSequence,
              reservation: providerCanaryReservation,
              role,
              failurePhase: actionFailurePhase,
            });
            if (typeof permitted?.then === 'function' || permitted !== true) {
              throw new Error(
                'autonomous_research_topic_producer_provider_canary_side_effect_permit_invalid',
              );
            }
          }
        }),
        afterCanaryAction: trackedCallback(async ({
          action,
          failurePhase: actionFailurePhase,
        }) => {
          finishProviderCanaryAction({
            lease: producerLease,
            generationSequence: plannedGeneration.generationSequence,
            reservation: providerCanaryReservation,
            action,
            failurePhase: actionFailurePhase,
            now: clock.now(),
          });
          durableActionJournalTransitions.push(`finish:${action.role}`);
          durableActions.push(action);
        }),
        betweenCanaryChecks: trackedCallback(async () => {
          const betweenNow = clock.now();
          assertProducerLease({ lease: producerLease, now: betweenNow });
          assertSynchronousAutonomyCurrent({
            assertAutonomyCurrent,
            residentLeaseContext,
            now: betweenNow,
            action: 'topic_producer_provider_canary_between_roles',
          });
          await reconcileStateRecoverability?.({
            residentLeaseContext,
            action: 'topic_producer_provider_canary_between_roles',
          });
          assertStateRecoverabilityCurrent?.(
            'topic_producer_provider_canary_between_roles',
          );
        }),
      });
      await Promise.all(pendingCanaryCallbacks);
      if (durableActionJournalTransitions.join(',')
        !== 'begin:research_author,finish:research_author,'
          + 'begin:formal_reviewer,finish:formal_reviewer'
        || durableActions.length !== 2
        || durableActions.some((action) => action.status !== 'succeeded')
        || durableActions[0].providerCanaryReceiptHash
          !== providerCanaryPairReceipt?.researchAuthorProviderCanaryReceiptHash
        || durableActions[1].providerCanaryReceiptHash
          !== providerCanaryPairReceipt?.formalReviewerProviderCanaryReceiptHash) {
        throw new Error(
          'autonomous_research_topic_producer_provider_canary_journal_incomplete',
        );
      }
      failurePhase = 'post_canary_authority_fence';
      afterNow = clock.now();
      after = remeasureAuthorities(expected);
      assertProducerLease({ lease: producerLease, now: afterNow });
      assertSynchronousAutonomyCurrent({
        assertAutonomyCurrent,
        residentLeaseContext,
        now: afterNow,
        action: 'topic_producer_provider_canary_commit',
      });
      if (after?.ready !== true
        || after.authorityMeasurementHash !== before.authorityMeasurementHash) {
        throw new Error('autonomous_research_topic_producer_authority_changed_during_canary');
      }
    } catch (error) {
      const existing = error?.autonomousResearchProviderCanarySideEffectInspection;
      if (verifyAutonomousResearchProviderCanarySideEffectInspection(existing, {
        providerConfigurationHash: expected.providerConfigurationHash,
        reservation: providerCanaryReservation,
      })) throw error;
      let actions = [];
      let actionAccountingComplete = false;
      if (providerCanaryPairReceipt) {
        try {
          actions = [
            providerCanaryAction({
              role: 'research_author',
              receipt: providerCanaryPairReceipt.researchAuthorProviderCanaryReceipt,
            }),
            providerCanaryAction({
              role: 'formal_reviewer',
              receipt: providerCanaryPairReceipt.formalReviewerProviderCanaryReceipt,
            }),
          ];
          actionAccountingComplete = true;
        } catch { /* malformed runner result is conservatively unattributed */ }
      }
      throw attachAutonomousResearchProviderCanarySideEffectInspection(error, {
        providerConfigurationHash: expected.providerConfigurationHash,
        reservation: providerCanaryReservation,
        actions,
        actionAccountingComplete,
        failurePhase,
      });
    }
    const capabilityNonce = `producer-nonce:${crypto.randomBytes(16).toString('hex')}`;
    const producerLeaseTokenHash = hashBinding(
      hashRecord,
      'AutonomousResearchTopicProducerLeaseToken',
      producerLease.leaseToken,
    );
    const residentLeaseTokenHash = hashBinding(
      hashRecord,
      'AutonomousResearchResidentLeaseToken',
      residentLeaseContext.lease.leaseToken,
    );
    const authorization = Object.freeze({
      kind: 'AutonomousResearchTopicProducerLiveMutationAuthorization',
      capabilityNonce,
      plannedGenerationHash: plannedGeneration.plannedGenerationHash,
      producerLeaseGeneration: producerLease.leaseGeneration,
      producerLeaseTokenHash,
      residentLeaseGeneration: residentLeaseContext.lease.leaseGeneration,
      residentLeaseTokenHash,
      authorityMeasurementHash: after.authorityMeasurementHash,
      providerCanaryPairReceiptHash: providerCanaryPairReceipt.providerCanaryPairReceiptHash,
    });
    authorizations.set(authorization, Object.freeze({
      producerLease,
      residentLeaseContext,
      assertAutonomyCurrent,
      plannedGenerationHash: plannedGeneration.plannedGenerationHash,
      expected,
      authorityMeasurementHash: after.authorityMeasurementHash,
      providerCanaryPairReceipt,
      capabilityNonce,
      producerLeaseTokenHash,
      residentLeaseTokenHash,
      issuedAt: afterNow.toISOString(),
    }));
    return Object.freeze({
      authorization,
      providerCanaryPairReceipt,
      providerCanaryReservation,
      capabilityNonce,
    });
  }

  function consume({ authorization, binding, assertProducerLease } = {}) {
    const issued = authorizations.get(authorization);
    authorizations.delete(authorization);
    const now = clock.now();
    if (!issued || issued.providerCanaryPairReceipt !== binding?.providerCanaryPairReceipt
      || issued.capabilityNonce !== binding?.capabilityNonce
      || issued.plannedGenerationHash !== binding?.plannedGenerationHash
      || issued.producerLease.leaseGeneration !== binding?.producerLeaseGeneration
      || issued.producerLeaseTokenHash !== binding?.producerLeaseTokenHash
      || issued.residentLeaseContext.lease.leaseGeneration !== binding?.residentLeaseGeneration
      || issued.residentLeaseTokenHash !== binding?.residentLeaseTokenHash
      || Date.parse(issued.issuedAt) > now.getTime()
      || now.getTime() - Date.parse(issued.issuedAt) >= 15 * 60 * 1000) {
      throw new Error('autonomous_research_topic_producer_live_authorization_invalid_or_replayed');
    }
    const current = remeasureAuthorities(issued.expected);
    assertProducerLease({ lease: issued.producerLease, now });
    assertSynchronousAutonomyCurrent({
      assertAutonomyCurrent: issued.assertAutonomyCurrent,
      residentLeaseContext: issued.residentLeaseContext,
      now,
      action: 'topic_producer_generation_authorization',
    });
    if (current?.ready !== true
      || current.authorityMeasurementHash !== issued.authorityMeasurementHash
      || authorization.authorityMeasurementHash !== issued.authorityMeasurementHash
      || hashBinding(hashRecord, 'AutonomousResearchTopicProducerLiveBinding', {
        plannedGenerationHash: issued.plannedGenerationHash,
        capabilityNonce: issued.capabilityNonce,
        producerLeaseGeneration: issued.producerLease.leaseGeneration,
        producerLeaseTokenHash: issued.producerLeaseTokenHash,
        residentLeaseGeneration: issued.residentLeaseContext.lease.leaseGeneration,
        residentLeaseTokenHash: issued.residentLeaseTokenHash,
        providerCanaryPairReceiptHash:
          issued.providerCanaryPairReceipt.providerCanaryPairReceiptHash,
      }) !== binding.liveBindingHash) {
      throw new Error('autonomous_research_topic_producer_live_authority_not_current');
    }
    return true;
  }

  return Object.freeze({ authorize, consume });
}
