import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  createAutonomousExternalQualificationState,
  normalizeExternalQualificationRetryPolicy,
  validateAutonomousExternalQualificationState,
} from '../../paper-domain/automation/autonomous-external-qualification-state-contract.mjs';
import {
  classifyExternalQualificationFailureCodes,
} from '../../paper-domain/automation/external-research-qualification-failure-policy.mjs';
import {
  boundedExternalQualificationDelay as boundedDelay,
  clearExternalQualificationRecurringTimer as clearRecurringTimer,
  durableExternalQualificationCasStore as durableCasStore,
  externalQualificationBoundToRelease as boundToRelease,
  externalQualificationConfigurationIdentity as configurationIdentity,
  externalQualificationEvidence as evidence,
  externalQualificationEpochIdempotencyKey,
  externalQualificationIdentityFromState as identityFromState,
  externalQualificationInfrastructureControlFlow as isInfrastructureFenceControlFlow,
  externalQualificationInspectionWithIdentity as inspectionWithIdentity,
  externalQualificationNowMilliseconds as nowMilliseconds,
  externalQualificationOutcome as outcome,
  externalQualificationRecoveryIdentity as recoveryIdentity,
  locallyCurrentExternalQualificationInspection as locallyCurrentVerifiedInspection,
  markExternalQualificationSideEffectStarted as markExternalSideEffectStarted,
  reportExternalQualificationProgress as reportProgress,
  reportExternalQualificationSynchronousProgress as reportSynchronousProgress,
  startExternalQualificationRecurringTimer as recurringTimer,
  supportsRecoverableExternalQualificationAttemptLease as supportsRecoverableAttemptLease,
  supportsRecoverableExternalQualificationInfrastructureReservation
    as supportsRecoverableInfrastructureReservation,
} from './external-qualification-recovery-support.mjs';
import {
  recoverStaleExternalQualificationAttempt,
} from './external-qualification-stale-attempt-recovery.mjs';

export async function requestExternalResearchQualification({
  externalQualificationClient,
  externalQualificationVerifier,
  campaignReleaseAuthority,
  preparation,
  qualificationStateStore = null,
  allowRequest = false,
  retry = {},
  evaluateEligibility,
} = {}) {
  if (!campaignReleaseAuthority) return outcome('qualification_release_not_ready');
  const currentNow = () => nowMilliseconds(retry);
  let existing = null;
  try {
    existing = qualificationStateStore?.readExternalQualificationState?.() || null;
    if (existing) validateAutonomousExternalQualificationState(existing);
  } catch {
    return outcome('qualification_external_state_invalid');
  }
  const requestedPolicy = normalizeExternalQualificationRetryPolicy(retry);
  const localInspection = locallyCurrentVerifiedInspection(
    existing,
    campaignReleaseAuthority,
    currentNow(),
    allowRequest ? requestedPolicy.renewalLeadMs : 0,
  );
  if (localInspection) {
    return outcome(
      'qualification_cached_verified_locally',
      localInspection,
      identityFromState(existing),
    );
  }
  if (!allowRequest) {
    return outcome(
      existing?.recovery?.status === 'qualification_verified'
        ? 'qualification_cached_verification_expired_resume_required'
        : 'qualification_pending_explicit_resume',
      null,
      identityFromState(existing),
    );
  }
  if (externalQualificationClient?.kind !== 'ExternalResearchQualificationClient'
    || typeof externalQualificationClient?.requestQualification !== 'function'
    || externalQualificationVerifier?.kind !== 'IndependentExternalResearchQualificationVerifier'
    || typeof externalQualificationVerifier?.verify !== 'function') {
    return outcome('qualification_pending_external_service', null, identityFromState(existing));
  }
  if (!durableCasStore(qualificationStateStore)) {
    return outcome('qualification_durable_state_store_required');
  }
  const configuration = configurationIdentity(
    externalQualificationClient,
    externalQualificationVerifier,
  );
  const lifecyclePrior = boundToRelease(existing, campaignReleaseAuthority)
    ? existing?.recovery || null : null;
  if (lifecyclePrior && qualificationStateStore.lifecycleBudgetFencing === true
    && !Object.hasOwn(lifecyclePrior, 'maximumTotalCostUsd')) {
    return outcome(
      'qualification_external_service_legacy_cost_state_unpriced',
      null,
      configuration,
    );
  }
  if (configuration.maximumQualificationCostUsd !== null
    && configuration.maximumQualificationCostUsd > requestedPolicy.maximumTotalCostUsd) {
    throw new Error('autonomous_research_qualification_cost_envelope_insufficient');
  }
  const policy = configuration.maximumQualificationCostUsd === null
    ? requestedPolicy
    : normalizeExternalQualificationRetryPolicy({
      ...retry,
      attemptReservationCostUsd: Math.max(
        requestedPolicy.attemptReservationCostUsd,
        configuration.maximumQualificationCostUsd,
      ),
    });
  const recoveryIdentityHash = recoveryIdentity(
    campaignReleaseAuthority,
    preparation,
    configuration,
    policy.retryPolicyIdentityHash,
  );
  const configuredTerminal = existing?.recovery?.status === 'qualification_terminal_blocked'
    && existing.recovery.recoveryConfigurationIdentityHash
      === configuration.recoveryConfigurationIdentityHash;
  if (configuredTerminal) {
    return outcome('qualification_external_service_terminal_blocked', null, configuration);
  }
  let prior = lifecyclePrior?.recoveryIdentityHash === recoveryIdentityHash
    ? existing.recovery : null;
  const exhaustedUntil = prior?.status === 'qualification_recovery_budget_exhausted'
    ? Date.parse(prior.nextAttemptAt || '') : Number.NaN;
  if (Number.isFinite(exhaustedUntil) && exhaustedUntil > currentNow()) {
    return outcome('qualification_external_service_recovery_cooldown', null, configuration);
  }
  const startingNewCycle = Boolean(lifecyclePrior
    && (lifecyclePrior.status === 'qualification_recovery_budget_exhausted'
      || lifecyclePrior.status === 'qualification_verified'
      || lifecyclePrior.recoveryIdentityHash !== recoveryIdentityHash));
  const cycle = startingNewCycle
    ? Number(lifecyclePrior.cycle || 0) + 1 : Number(prior?.cycle || 1);
  if (startingNewCycle) prior = null;
  let staleAttemptExpired = false;
  if (prior?.status === 'qualification_attempt_in_progress') {
    const leaseUntil = Math.min(
      Date.parse(prior.nextAttemptAt || ''),
      currentNow() + policy.attemptLeaseMs,
    );
    if (Number.isFinite(leaseUntil) && leaseUntil > currentNow()) {
      return outcome('qualification_external_service_attempt_in_progress', null, configuration);
    }
    staleAttemptExpired = true;
  }

  let expectedStateHash = existing?.autonomousExternalQualificationStateHash || null;
  let generation = Number(existing?.generation || 0);
  let epoch = Number(prior?.epoch || 1);
  let attemptCount = Number(prior?.attemptCount || 0);
  let totalAttemptCount = Number(lifecyclePrior?.totalAttemptCount || 0);
  const lifecycleBudgetFencing = qualificationStateStore?.lifecycleBudgetFencing === true;
  const maximumTotalAttempts = lifecyclePrior && lifecycleBudgetFencing
    ? Math.min(policy.maximumTotalAttempts, Number(lifecyclePrior.maximumTotalAttempts))
    : policy.maximumTotalAttempts;
  const extendedLifecycleState = lifecyclePrior
    && Object.hasOwn(lifecyclePrior, 'maximumTotalCostUsd');
  const maximumTotalCostUsd = extendedLifecycleState && lifecycleBudgetFencing
    ? Math.min(policy.maximumTotalCostUsd, Number(lifecyclePrior.maximumTotalCostUsd))
    : policy.maximumTotalCostUsd;
  const attemptReservationCostUsd = extendedLifecycleState && lifecycleBudgetFencing
    ? Math.max(policy.attemptReservationCostUsd,
      Number(lifecyclePrior.attemptReservationCostUsd))
    : policy.attemptReservationCostUsd;
  let reservedCostUsd = extendedLifecycleState
    ? Number(lifecyclePrior.reservedCostUsd || 0) : 0;
  let globalFirstAttemptAtMs = lifecyclePrior
    ? Date.parse(lifecyclePrior.globalFirstAttemptAt) : currentNow();
  let globalDeadlineAtMs = lifecyclePrior
    ? Math.min(
      Date.parse(lifecyclePrior.globalDeadlineAt),
      globalFirstAttemptAtMs + policy.globalDeadlineMs,
    )
    : globalFirstAttemptAtMs + policy.globalDeadlineMs;
  let firstAttemptAtMs = prior ? Date.parse(prior.firstAttemptAt) : currentNow();
  let deadlineAtMs = prior
    ? Math.min(Date.parse(prior.deadlineAt), firstAttemptAtMs + policy.deadlineMs,
      globalDeadlineAtMs)
    : Math.min(globalDeadlineAtMs, firstAttemptAtMs + policy.deadlineMs);

  const writeState = ({
    status,
    receipt = null,
    verifiedInspection = null,
    nextAttemptAtMs = null,
    terminalFailure = null,
  }, attemptLease = null, sideEffectReservationHashes = []) => {
    const state = createAutonomousExternalQualificationState(Object.freeze({
      version: 4,
      kind: 'AutonomousExternalQualificationState',
      generation: generation + 1,
      campaignId: campaignReleaseAuthority.campaignId,
      paperId: campaignReleaseAuthority.paperId,
      campaignReleaseBundleHash: campaignReleaseAuthority.campaignReleaseBundleHash,
      receipt,
      verifiedInspection,
      recovery: Object.freeze({
        status,
        recoveryIdentityHash,
        recoveryConfigurationIdentityHash:
          configuration.recoveryConfigurationIdentityHash,
        retryPolicyIdentityHash: policy.retryPolicyIdentityHash,
        ...evidence(configuration),
        terminalFailure,
        cycle,
        epoch,
        maximumEpochs: policy.maximumEpochs,
        attemptCount,
        maximumAttempts: policy.maximumAttempts,
        totalAttemptCount,
        maximumTotalAttempts,
        maximumTotalCostUsd,
        reservedCostUsd,
        attemptReservationCostUsd,
        firstAttemptAt: new Date(firstAttemptAtMs).toISOString(),
        nextAttemptAt: nextAttemptAtMs === null
          ? null : new Date(nextAttemptAtMs).toISOString(),
        deadlineAt: new Date(deadlineAtMs).toISOString(),
        globalFirstAttemptAt: new Date(globalFirstAttemptAtMs).toISOString(),
        globalDeadlineAt: new Date(globalDeadlineAtMs).toISOString(),
      }),
    }));
    qualificationStateStore.compareAndSwapExternalQualificationState({
      expectedStateHash,
      state,
      attemptLease,
      sideEffectReservationHashes,
      now: new Date(currentNow()),
    });
    existing = state;
    expectedStateHash = state.autonomousExternalQualificationStateHash;
    generation = state.generation;
  };

  if (staleAttemptExpired
    && supportsRecoverableInfrastructureReservation(qualificationStateStore)) {
    const recovered = await recoverStaleExternalQualificationAttempt({
      staleAttemptExpired,
      qualificationStateStore,
      externalQualificationClient,
      externalQualificationVerifier,
      campaignReleaseAuthority,
      preparation,
      configuration,
      policy,
      retry,
      currentNow,
      writeState,
      evaluateEligibility,
    });
    if (recovered.handled) return recovered.result;
  }

  let lastInspection = null;
  if (prior?.status === 'qualification_epoch_cooldown') {
    const persisted = Date.parse(prior.nextAttemptAt || '');
    const waitUntil = Math.min(
      Number.isFinite(persisted) ? persisted : currentNow(),
      currentNow() + policy.epochCooldownMs,
      globalDeadlineAtMs,
    );
    await boundedDelay(Math.max(0, waitUntil - currentNow()), retry);
    epoch += 1;
    attemptCount = 0;
    firstAttemptAtMs = currentNow();
    deadlineAtMs = Math.min(globalDeadlineAtMs, firstAttemptAtMs + policy.deadlineMs);
  } else if (prior?.status === 'qualification_retry_scheduled') {
    const persisted = Date.parse(prior.nextAttemptAt || '');
    const waitUntil = Math.min(
      Number.isFinite(persisted) ? persisted : currentNow(),
      currentNow() + policy.maximumBackoffMs,
      deadlineAtMs,
      globalDeadlineAtMs,
    );
    await boundedDelay(Math.max(0, waitUntil - currentNow()), retry);
  }

  while (epoch <= policy.maximumEpochs
    && totalAttemptCount < maximumTotalAttempts
    && reservedCostUsd + attemptReservationCostUsd <= maximumTotalCostUsd
    && currentNow() < globalDeadlineAtMs) {
    while (attemptCount < policy.maximumAttempts
      && totalAttemptCount < maximumTotalAttempts
      && reservedCostUsd + attemptReservationCostUsd <= maximumTotalCostUsd
      && currentNow() < deadlineAtMs && currentNow() < globalDeadlineAtMs) {
      const attemptOwnerId = `qualification:${process.pid}:${Math.random().toString(16).slice(2)}`;
      const attemptLease = supportsRecoverableAttemptLease(qualificationStateStore)
        ? qualificationStateStore.tryAcquireQualificationAttemptLease({
          ownerId: attemptOwnerId,
          leaseMs: policy.attemptLeaseMs,
          now: new Date(currentNow()),
        }) : null;
      if (supportsRecoverableAttemptLease(qualificationStateStore) && !attemptLease) {
        return outcome('qualification_external_service_attempt_in_progress', null, configuration);
      }
      attemptCount += 1;
      totalAttemptCount += 1;
      const externalRequestIdempotencyKey = externalQualificationEpochIdempotencyKey({
        recoveryIdentityHash,
        cycle,
        epoch,
      });
      reservedCostUsd = Math.min(
        maximumTotalCostUsd,
        reservedCostUsd + attemptReservationCostUsd,
      );
      try {
        writeState({
          status: 'qualification_attempt_in_progress',
          nextAttemptAtMs: Math.min(
            deadlineAtMs,
            globalDeadlineAtMs,
            currentNow() + policy.attemptLeaseMs,
          ),
        }, attemptLease, [externalRequestIdempotencyKey]);
      } catch (error) {
        if (attemptLease && error?.committed !== true) {
          qualificationStateStore.releaseQualificationAttemptLease(attemptLease);
        }
        if (error?.message === 'autonomous_research_qualification_state_fence_conflict') {
          return outcome('qualification_external_service_attempt_in_progress', null, configuration);
        }
        if (error?.message
          === 'autonomous_research_qualification_attempt_lease_fence_conflict') {
          return outcome('qualification_external_service_attempt_lease_lost', null, configuration);
        }
        throw error;
      }
      const recoverableInfrastructureReservation =
        supportsRecoverableInfrastructureReservation(qualificationStateStore);
      let durableExternalActionMayHaveStarted = false;
      let externalSideEffectPermitHash = null;
      const cancelInfrastructureReservation = (originalError) => {
        if (durableExternalActionMayHaveStarted
          || !supportsRecoverableInfrastructureReservation(qualificationStateStore)
          || originalError?.qualificationInfrastructureReservationCancelled === true) {
          return false;
        }
        let cancellation;
        try {
          cancellation = qualificationStateStore
            .cancelQualificationAttemptInfrastructureDeferred({
              expectedStateHash,
              expectedGeneration: generation,
              idempotencyKey: externalRequestIdempotencyKey,
              attemptLease,
              now: new Date(currentNow()),
            });
        } catch (cancelError) {
          const fatal = new Error(
            'autonomous_research_qualification_infrastructure_reservation_cancel_failed',
            { cause: cancelError },
          );
          fatal.stateRecoverabilityFatal = true;
          fatal.originalInfrastructureControlError = originalError;
          throw fatal;
        }
        if (cancellation?.cancelled !== true
          || cancellation?.releasedLease !== true) {
          const fatal = new Error(
            'autonomous_research_qualification_infrastructure_reservation_cancel_failed',
          );
          fatal.stateRecoverabilityFatal = true;
          fatal.originalInfrastructureControlError = originalError;
          throw fatal;
        }
        originalError.qualificationInfrastructureReservationCancelled = true;
        return true;
      };
      const persistExternalActionMarker = (action) => {
        if (!recoverableInfrastructureReservation) {
          durableExternalActionMayHaveStarted = true;
          return;
        }
        try {
          const marker = qualificationStateStore
            .markQualificationAttemptExternalActionStarted({
            expectedStateHash,
            expectedGeneration: generation,
            idempotencyKey: externalRequestIdempotencyKey,
            attemptLease,
            action,
            now: new Date(currentNow()),
          });
          externalSideEffectPermitHash = marker?.sideEffectPermitHash || null;
          durableExternalActionMayHaveStarted = true;
          return marker;
        } catch (error) {
          if (error?.committed === true) durableExternalActionMayHaveStarted = true;
          throw error;
        }
      };
      let receipt = null;
      let inspection = null;
      let attemptLeaseLost = false;
      const renewAttemptLeaseAtProgress = attemptLease ? () => {
        let renewed = null;
        try {
          renewed = qualificationStateStore.renewQualificationAttemptLease({
            ...attemptLease,
            leaseMs: policy.attemptLeaseMs,
            now: new Date(currentNow()),
          });
        } catch { renewed = null; }
        if (!renewed) {
          attemptLeaseLost = true;
          throw new Error('autonomous_research_qualification_attempt_lease_lost');
        }
      } : null;
      const renewAttemptLeaseInBackground = attemptLease ? () => {
        try {
          const renewed = qualificationStateStore.renewQualificationAttemptLease({
            ...attemptLease,
            leaseMs: policy.attemptLeaseMs,
            now: new Date(currentNow()),
          });
          if (!renewed) attemptLeaseLost = true;
        } catch { attemptLeaseLost = true; }
      } : null;
      let heartbeat = null;
      const stopHeartbeat = () => {
        clearRecurringTimer(retry, heartbeat);
        heartbeat = null;
      };
      const startHeartbeat = () => {
        if (!renewAttemptLeaseInBackground || heartbeat) return;
        heartbeat = recurringTimer(
          retry,
          renewAttemptLeaseInBackground,
          Math.max(250, Math.floor(policy.attemptLeaseMs / 3)),
        );
      };
      try {
        const remainingQualificationMs = Math.max(1, Math.min(
          deadlineAtMs,
          globalDeadlineAtMs,
        ) - currentNow());
        renewAttemptLeaseAtProgress?.();
        await reportProgress(retry, 'qualification_recovery_before_external_request');
        reportSynchronousProgress(
          retry,
          'qualification_recovery_external_request',
        );
        const releaseBinding = campaignReleaseAuthority.releaseBundle
          ?.autonomousResearchReleaseBinding || null;
        persistExternalActionMarker('external_qualification_request');
        markExternalSideEffectStarted(retry, 'external_qualification_request');
        await reportProgress(
          retry,
          'qualification_recovery_after_external_request_marker',
        );
        reportSynchronousProgress(
          retry,
          'qualification_recovery_external_request_final_fence',
        );
        const qualificationRequest = externalQualificationClient.requestQualification({
          campaignId: campaignReleaseAuthority.campaignId,
          paperId: campaignReleaseAuthority.paperId,
          campaignReleaseBundleHash: campaignReleaseAuthority.campaignReleaseBundleHash,
          proposalHash: preparation.proposal.machineProposedScientificClaimSetHash,
          policyAuthorizationHash:
            preparation.policyAuthorization.autonomousResearchPolicyAuthorizationHash,
          seedBindingHash: preparation.seedBinding.autonomousResearchSeedBindingHash,
          qualificationScope: releaseBinding?.qualificationScope || null,
          genericContentCanaryVerified:
            releaseBinding?.genericContentCanaryVerified === true,
          trustedAutonomousManuscriptRenderReceiptHash:
            releaseBinding?.trustedAutonomousManuscriptRenderReceiptHash || null,
          evidenceBoundManuscriptIrHash:
            releaseBinding?.evidenceBoundManuscriptIrHash || null,
          manuscriptIrFileHash: releaseBinding?.manuscriptIrFileHash || null,
          renderedManuscriptHash: releaseBinding?.renderedManuscriptHash || null,
          agentExecutionReceiptHash: releaseBinding?.agentExecutionReceiptHash || null,
          isolatedAgentMergeReceiptHash:
            releaseBinding?.isolatedAgentMergeReceiptHash || null,
          agentAuthoredSourceDraftHash:
            releaseBinding?.agentAuthoredSourceDraftHash || null,
          agentAuthoredSourceDraftFileHash:
            releaseBinding?.agentAuthoredSourceDraftFileHash || null,
          agentWorkspacePostimageBindingHash:
            releaseBinding?.agentWorkspacePostimageBindingHash || null,
          venueProfileSelectionHash: releaseBinding?.venueProfileSelectionHash || null,
          submissionMetadataReceiptHash:
            releaseBinding?.submissionMetadataReceiptHash || null,
          idempotencyKey: externalRequestIdempotencyKey,
          qualificationCycle: cycle,
          qualificationEpoch: epoch,
          qualificationAttempt: attemptCount,
          qualificationTotalAttempt: totalAttemptCount,
          sideEffectPermitHash: externalSideEffectPermitHash,
        }, {
          signal: retry.signal || null,
          timeoutMs: remainingQualificationMs,
        });
        startHeartbeat();
        receipt = await qualificationRequest;
        stopHeartbeat();
        await reportProgress(retry, 'qualification_recovery_after_external_request');
        if (retry.signal?.aborted || currentNow() >= deadlineAtMs
          || currentNow() >= globalDeadlineAtMs) {
          throw new Error('external_qualification_deadline_exhausted');
        }
        renewAttemptLeaseAtProgress?.();
        await reportProgress(retry, 'qualification_recovery_before_external_verification');
        reportSynchronousProgress(
          retry,
          'qualification_recovery_external_verification',
        );
        persistExternalActionMarker('external_qualification_verification');
        markExternalSideEffectStarted(retry, 'external_qualification_verification');
        await reportProgress(
          retry,
          'qualification_recovery_after_external_verification_marker',
        );
        reportSynchronousProgress(
          retry,
          'qualification_recovery_external_verification_final_fence',
        );
        inspection = inspectionWithIdentity(await externalQualificationVerifier.verify({
          receipt,
          campaignReleaseAuthority,
          preparation,
        }, {
          signal: retry.signal || null,
          timeoutMs: Math.max(1, Math.min(deadlineAtMs, globalDeadlineAtMs) - currentNow()),
          onSynchronousProgress: renewAttemptLeaseAtProgress,
        }), configuration);
        await reportProgress(retry, 'qualification_recovery_after_external_verification');
        if (retry.signal?.aborted || currentNow() >= deadlineAtMs
          || currentNow() >= globalDeadlineAtMs) inspection = null;
      } catch (error) {
        if (isInfrastructureFenceControlFlow(error)) {
          cancelInfrastructureReservation(error);
          throw error;
        }
        if (String(error?.message || '').startsWith(
          'autonomous_research_qualification_attempt_external_action_',
        )) {
          cancelInfrastructureReservation(error);
          throw error;
        }
        if (error?.message === 'autonomous_research_qualification_progress_fence_lost') {
          cancelInfrastructureReservation(error);
          throw error;
        }
        if (error?.message
          === 'autonomous_research_qualification_side_effect_marker_failed') {
          throw error;
        }
        inspection = null;
      }
      finally { stopHeartbeat(); }
      if (attemptLeaseLost) {
        if (attemptLease) {
          try { qualificationStateStore.releaseQualificationAttemptLease(attemptLease); }
          catch { /* the lost fence must not be treated as success */ }
        }
        return outcome('qualification_external_service_attempt_lease_lost', null, configuration);
      }
      const persistAttemptState = (value) => {
        try {
          writeState(value, attemptLease);
          return true;
        } catch (error) {
          if (error?.message
            === 'autonomous_research_qualification_attempt_lease_fence_conflict') return false;
          throw error;
        }
      };
      lastInspection = inspection;
      const eligibility = inspection?.kind === 'FullResearchQualificationInspection'
        ? evaluateEligibility(inspection) : null;
      if (eligibility?.fullAutomaticResearchWritingReady
        || eligibility?.boundedGoldenCapabilityQualificationVerified) {
        if (!persistAttemptState({
          status: 'qualification_verified',
          receipt,
          verifiedInspection: inspection,
        })) {
          return outcome('qualification_external_service_attempt_lease_lost', null, configuration);
        }
        if (attemptLease) qualificationStateStore.releaseQualificationAttemptLease(attemptLease);
        return outcome('qualification_external_service_verified', inspection, configuration);
      }
      const classification = inspection
        ? classifyExternalQualificationFailureCodes(inspection.failureCodes) : null;
      if (classification?.terminalForConfiguration) {
        if (!persistAttemptState({
          status: 'qualification_terminal_blocked',
          terminalFailure: Object.freeze({
            failureCodes: classification.failureCodes,
            rejectedReceiptHash: receipt
              ? hashRecord('AutonomousExternalQualificationRejectedReceipt', receipt) : null,
            recoveryConfigurationIdentityHash:
              configuration.recoveryConfigurationIdentityHash,
          }),
        })) {
          return outcome('qualification_external_service_attempt_lease_lost', null, configuration);
        }
        if (attemptLease) qualificationStateStore.releaseQualificationAttemptLease(attemptLease);
        return outcome('qualification_external_service_blocked', inspection, configuration);
      }
      const backoffMs = Math.min(
        policy.maximumBackoffMs,
        policy.initialBackoffMs * (2 ** (attemptCount - 1)),
      );
      const nextAttemptAtMs = Math.min(
        deadlineAtMs,
        globalDeadlineAtMs,
        currentNow() + backoffMs,
      );
      if (!persistAttemptState({ status: 'qualification_retry_scheduled', nextAttemptAtMs })) {
        return outcome('qualification_external_service_attempt_lease_lost', null, configuration);
      }
      if (attemptLease) qualificationStateStore.releaseQualificationAttemptLease(attemptLease);
      if (attemptCount < policy.maximumAttempts && nextAttemptAtMs > currentNow()) {
        await boundedDelay(nextAttemptAtMs - currentNow(), retry);
      }
    }
    if (epoch >= policy.maximumEpochs
      || totalAttemptCount >= maximumTotalAttempts
      || reservedCostUsd + attemptReservationCostUsd > maximumTotalCostUsd
      || currentNow() >= globalDeadlineAtMs) break;
    const nextEpochAtMs = Math.min(
      globalDeadlineAtMs,
      currentNow() + policy.epochCooldownMs,
    );
    writeState({ status: 'qualification_epoch_cooldown', nextAttemptAtMs: nextEpochAtMs });
    await boundedDelay(Math.max(0, nextEpochAtMs - currentNow()), retry);
    epoch += 1;
    attemptCount = 0;
    firstAttemptAtMs = currentNow();
    deadlineAtMs = Math.min(globalDeadlineAtMs, firstAttemptAtMs + policy.deadlineMs);
  }
  writeState({
    status: 'qualification_recovery_budget_exhausted',
    nextAttemptAtMs: currentNow() + policy.exhaustedCooldownMs,
  });
  return outcome(
    'qualification_external_service_recovery_budget_exhausted',
    lastInspection,
    configuration,
  );
}
