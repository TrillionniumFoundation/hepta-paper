import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  createAutonomousExternalQualificationState,
  normalizeExternalQualificationRetryPolicy,
  validateAutonomousExternalQualificationState,
} from '../../paper-domain/automation/autonomous-external-qualification-state-contract.mjs';
import {
  classifyExternalQualificationFailureCodes,
} from '../../paper-domain/automation/external-research-qualification-failure-policy.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/i;

function configurationIdentity(client, verifier) {
  const clientDeclaresCost = Object.hasOwn(client || {}, 'maximumQualificationCostUsd')
    || Object.hasOwn(client || {}, 'qualificationCostAuthority');
  const verifierDeclaresCost = Object.hasOwn(verifier || {}, 'maximumQualificationCostUsd')
    || Object.hasOwn(verifier || {}, 'qualificationCostAuthority');
  const maximumQualificationCostUsd = clientDeclaresCost
    ? Number(client.maximumQualificationCostUsd) : null;
  const qualificationCostAuthority = clientDeclaresCost
    ? client.qualificationCostAuthority : null;
  const costAuthorityValid = clientDeclaresCost && verifierDeclaresCost
    && maximumQualificationCostUsd
      === Number(verifier.maximumQualificationCostUsd)
    && qualificationCostAuthority === verifier.qualificationCostAuthority
    && Number.isFinite(maximumQualificationCostUsd)
    && maximumQualificationCostUsd >= 0 && maximumQualificationCostUsd <= 1_000
    && (maximumQualificationCostUsd === 0
      ? qualificationCostAuthority === 'externally_operated_zero_cost'
      : qualificationCostAuthority === 'operator_declared_worst_case_usd');
  const value = Object.freeze({
    configurationIdentityHash: client?.configurationIdentityHash || null,
    trustIdentityHash: client?.trustIdentityHash || null,
    clientServiceIdentityHash: client?.serviceIdentityHash || null,
    verifierServiceIdentityHash: verifier?.serviceIdentityHash || null,
    maximumQualificationCostUsd,
    qualificationCostAuthority,
  });
  if (![value.configurationIdentityHash, value.trustIdentityHash,
    value.clientServiceIdentityHash, value.verifierServiceIdentityHash]
    .every((item) => SHA256.test(String(item || '')))
    || !costAuthorityValid
    || value.configurationIdentityHash !== verifier?.configurationIdentityHash
    || value.trustIdentityHash !== verifier?.trustIdentityHash
    || value.clientServiceIdentityHash === value.verifierServiceIdentityHash) {
    throw new Error('autonomous_research_external_qualification_identity_invalid');
  }
  return Object.freeze({
    ...value,
    recoveryConfigurationIdentityHash: hashRecord(
      'AutonomousExternalQualificationRecoveryConfigurationIdentity',
      value,
    ),
  });
}

function recoveryIdentity(authority, preparation, configuration, retryPolicyIdentityHash) {
  return hashRecord('AutonomousExternalQualificationRecoveryIdentity', {
    campaignId: authority.campaignId,
    paperId: authority.paperId,
    campaignReleaseBundleHash: authority.campaignReleaseBundleHash,
    proposalHash: preparation.proposal.machineProposedScientificClaimSetHash,
    policyAuthorizationHash:
      preparation.policyAuthorization.autonomousResearchPolicyAuthorizationHash,
    seedBindingHash: preparation.seedBinding.autonomousResearchSeedBindingHash,
    recoveryConfigurationIdentityHash: configuration.recoveryConfigurationIdentityHash,
    retryPolicyIdentityHash,
  });
}

function evidence(configuration) {
  if (!configuration) return Object.freeze({
    configurationIdentityHash: null,
    trustIdentityHash: null,
    clientServiceIdentityHash: null,
    verifierServiceIdentityHash: null,
  });
  return Object.freeze({
    configurationIdentityHash: configuration.configurationIdentityHash,
    trustIdentityHash: configuration.trustIdentityHash,
    clientServiceIdentityHash: configuration.clientServiceIdentityHash,
    verifierServiceIdentityHash: configuration.verifierServiceIdentityHash,
  });
}

function outcome(status, inspection = null, identity = null) {
  return Object.freeze({ status, inspection, ...evidence(identity) });
}

function nowMilliseconds(retry) {
  const observed = retry.clock?.now ? retry.clock.now() : new Date();
  const value = observed instanceof Date ? observed.getTime() : Date.parse(String(observed));
  if (!Number.isFinite(value)) throw new Error('external_qualification_clock_invalid');
  return value;
}

async function reportProgress(retry, stage) {
  if (retry.onProgress === null || retry.onProgress === undefined) return;
  if (typeof retry.onProgress !== 'function') {
    throw new Error('autonomous_research_qualification_progress_callback_invalid');
  }
  try { await retry.onProgress(Object.freeze({ stage })); }
  catch (error) {
    throw new Error('autonomous_research_qualification_progress_fence_lost', {
      cause: error,
    });
  }
}

async function boundedDelay(milliseconds, retry) {
  if (milliseconds <= 0) return;
  if (retry.signal?.aborted) throw new Error(String(retry.signal.reason || 'external_qualification_aborted'));
  await reportProgress(retry, 'qualification_recovery_before_retry_delay');
  if (typeof retry.scheduler?.delay === 'function') {
    await retry.scheduler.delay(milliseconds, { signal: retry.signal });
  } else if (typeof retry.scheduler?.sleep === 'function') {
    await retry.scheduler.sleep(milliseconds, { signal: retry.signal });
  } else await new Promise((resolve) => { setTimeout(resolve, milliseconds); });
  await reportProgress(retry, 'qualification_recovery_after_retry_delay');
}

function durableCasStore(store) {
  return store?.kind === 'AutonomousResearchQualificationStateRepository'
    && store.durable === true && store.compareAndSwap === true
    && store.systemOwnedRuntimeState === true
    && typeof store.readExternalQualificationState === 'function'
    && typeof store.compareAndSwapExternalQualificationState === 'function';
}

function boundToRelease(state, authority) {
  return state?.campaignId === authority?.campaignId
    && state?.paperId === authority?.paperId
    && state?.campaignReleaseBundleHash === authority?.campaignReleaseBundleHash;
}

function locallyCurrentVerifiedInspection(state, authority, nowMs, minimumValidityMs = 0) {
  if (!boundToRelease(state, authority)
    || state?.recovery?.status !== 'qualification_verified'
    || Date.parse(state?.receipt?.expiresAt || '') <= nowMs + minimumValidityMs) return null;
  return state.verifiedInspection;
}

function supportsRecoverableAttemptLease(store) {
  return store?.recoverableAttemptLease === true
    && typeof store.tryAcquireQualificationAttemptLease === 'function'
    && typeof store.renewQualificationAttemptLease === 'function'
    && typeof store.releaseQualificationAttemptLease === 'function';
}

function recurringTimer(retry, callback, milliseconds) {
  const handle = typeof retry.scheduler?.setInterval === 'function'
    ? retry.scheduler.setInterval(callback, milliseconds)
    : setInterval(callback, milliseconds);
  retry.scheduler?.unref?.(handle);
  handle?.unref?.();
  return handle;
}

function clearRecurringTimer(retry, handle) {
  if (!handle) return;
  if (typeof retry.scheduler?.clearInterval === 'function') retry.scheduler.clearInterval(handle);
  else clearInterval(handle);
}

function identityFromState(state) {
  return state?.recovery ? Object.freeze({
    configurationIdentityHash: state.recovery.configurationIdentityHash,
    trustIdentityHash: state.recovery.trustIdentityHash,
    clientServiceIdentityHash: state.recovery.clientServiceIdentityHash,
    verifierServiceIdentityHash: state.recovery.verifierServiceIdentityHash,
  }) : null;
}

function inspectionWithIdentity(inspection, configuration) {
  return Object.freeze({ ...inspection, ...evidence(configuration) });
}

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
  if (prior?.status === 'qualification_attempt_in_progress') {
    const leaseUntil = Math.min(
      Date.parse(prior.nextAttemptAt || ''),
      currentNow() + policy.attemptLeaseMs,
    );
    if (Number.isFinite(leaseUntil) && leaseUntil > currentNow()) {
      return outcome('qualification_external_service_attempt_in_progress', null, configuration);
    }
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
  }, attemptLease = null) => {
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
      now: new Date(currentNow()),
    });
    existing = state;
    expectedStateHash = state.autonomousExternalQualificationStateHash;
    generation = state.generation;
  };

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
        }, attemptLease);
      } catch (error) {
        if (attemptLease) {
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
      const heartbeat = attemptLease ? recurringTimer(retry, () => {
        try {
          const renewed = qualificationStateStore.renewQualificationAttemptLease({
            ...attemptLease,
            leaseMs: policy.attemptLeaseMs,
            now: new Date(currentNow()),
          });
          if (!renewed) attemptLeaseLost = true;
        } catch { attemptLeaseLost = true; }
      }, Math.max(250, Math.floor(policy.attemptLeaseMs / 3))) : null;
      try {
        const remainingQualificationMs = Math.max(1, Math.min(
          deadlineAtMs,
          globalDeadlineAtMs,
        ) - currentNow());
        await reportProgress(retry, 'qualification_recovery_before_external_request');
        receipt = await externalQualificationClient.requestQualification({
          campaignId: campaignReleaseAuthority.campaignId,
          paperId: campaignReleaseAuthority.paperId,
          campaignReleaseBundleHash: campaignReleaseAuthority.campaignReleaseBundleHash,
          proposalHash: preparation.proposal.machineProposedScientificClaimSetHash,
          policyAuthorizationHash:
            preparation.policyAuthorization.autonomousResearchPolicyAuthorizationHash,
          seedBindingHash: preparation.seedBinding.autonomousResearchSeedBindingHash,
          idempotencyKey: hashRecord('AutonomousExternalQualificationEpochIdempotency', {
            recoveryIdentityHash,
            cycle,
            epoch,
          }),
          qualificationCycle: cycle,
          qualificationEpoch: epoch,
          qualificationAttempt: attemptCount,
          qualificationTotalAttempt: totalAttemptCount,
        }, {
          signal: retry.signal || null,
          timeoutMs: remainingQualificationMs,
        });
        await reportProgress(retry, 'qualification_recovery_after_external_request');
        if (retry.signal?.aborted || currentNow() >= deadlineAtMs
          || currentNow() >= globalDeadlineAtMs) {
          throw new Error('external_qualification_deadline_exhausted');
        }
        await reportProgress(retry, 'qualification_recovery_before_external_verification');
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
        if (error?.message === 'autonomous_research_qualification_progress_fence_lost') {
          throw error;
        }
        inspection = null;
      }
      finally { clearRecurringTimer(retry, heartbeat); }
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
      if (eligibility?.fullAutomaticResearchWritingReady) {
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
