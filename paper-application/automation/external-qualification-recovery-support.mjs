import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  isResidentReactivationRequired,
} from './autonomous-research-resident-reactivation-required.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/i;

export function externalQualificationConfigurationIdentity(client, verifier) {
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

export function externalQualificationRecoveryIdentity(
  authority,
  preparation,
  configuration,
  retryPolicyIdentityHash,
) {
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

export function externalQualificationEpochIdempotencyKey({
  recoveryIdentityHash,
  cycle,
  epoch,
}) {
  return hashRecord('AutonomousExternalQualificationEpochIdempotency', {
    recoveryIdentityHash,
    cycle,
    epoch,
  });
}

export function externalQualificationEvidence(configuration) {
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

export function externalQualificationOutcome(status, inspection = null, identity = null) {
  return Object.freeze({
    status,
    inspection,
    ...externalQualificationEvidence(identity),
  });
}

export function externalQualificationNowMilliseconds(retry) {
  const observed = retry.clock?.now ? retry.clock.now() : new Date();
  const value = observed instanceof Date ? observed.getTime() : Date.parse(String(observed));
  if (!Number.isFinite(value)) throw new Error('external_qualification_clock_invalid');
  return value;
}

export function externalQualificationInfrastructureControlFlow(error) {
  return error?.committed === true
    || error?.stateRecoverabilityFatal === true
    || error?.stateRecoverabilityDeferred === true
    || error?.authorityEvidenceRenewalFatal === true
    || error?.authorityEvidenceRenewalDeferred === true
    || isResidentReactivationRequired(error);
}

export async function reportExternalQualificationProgress(retry, stage) {
  if (retry.onProgress === null || retry.onProgress === undefined) return;
  if (typeof retry.onProgress !== 'function') {
    throw new Error('autonomous_research_qualification_progress_callback_invalid');
  }
  try { await retry.onProgress(Object.freeze({ stage })); }
  catch (error) {
    if (externalQualificationInfrastructureControlFlow(error)) throw error;
    const fenceError = new Error('autonomous_research_qualification_progress_fence_lost', {
      cause: error,
    });
    if (error?.authorityEvidenceRenewalFatal === true) {
      fenceError.authorityEvidenceRenewalFatal = true;
    }
    if (error?.authorityEvidenceRenewalDeferred === true) {
      fenceError.authorityEvidenceRenewalDeferred = true;
      fenceError.retryAt = error.retryAt || null;
    }
    throw fenceError;
  }
}

export function reportExternalQualificationSynchronousProgress(retry, stage) {
  if (retry.onSynchronousProgress === null
    || retry.onSynchronousProgress === undefined) return;
  if (typeof retry.onSynchronousProgress !== 'function') {
    throw new Error('autonomous_research_qualification_progress_callback_invalid');
  }
  let result;
  try { result = retry.onSynchronousProgress(Object.freeze({ stage })); }
  catch (error) {
    if (externalQualificationInfrastructureControlFlow(error)) throw error;
    throw new Error('autonomous_research_qualification_progress_fence_lost', {
      cause: error,
    });
  }
  if (result && typeof result.then === 'function') {
    throw new Error(
      'autonomous_research_qualification_synchronous_progress_callback_required',
    );
  }
}

export function markExternalQualificationSideEffectStarted(retry, action) {
  if (retry.onExternalSideEffectStarted === null
    || retry.onExternalSideEffectStarted === undefined) return;
  if (typeof retry.onExternalSideEffectStarted !== 'function') {
    throw new Error('autonomous_research_qualification_side_effect_marker_invalid');
  }
  let result;
  try { result = retry.onExternalSideEffectStarted(Object.freeze({ action })); }
  catch (error) {
    if (externalQualificationInfrastructureControlFlow(error)) throw error;
    throw new Error('autonomous_research_qualification_side_effect_marker_failed', {
      cause: error,
    });
  }
  if (result && typeof result.then === 'function') {
    throw new Error(
      'autonomous_research_qualification_side_effect_marker_must_be_synchronous',
    );
  }
}

export async function boundedExternalQualificationDelay(milliseconds, retry) {
  if (milliseconds <= 0) return;
  if (retry.signal?.aborted) {
    throw new Error(String(retry.signal.reason || 'external_qualification_aborted'));
  }
  await reportExternalQualificationProgress(
    retry,
    'qualification_recovery_before_retry_delay',
  );
  if (typeof retry.scheduler?.delay === 'function') {
    await retry.scheduler.delay(milliseconds, { signal: retry.signal });
  } else if (typeof retry.scheduler?.sleep === 'function') {
    await retry.scheduler.sleep(milliseconds, { signal: retry.signal });
  } else await new Promise((resolve) => { setTimeout(resolve, milliseconds); });
  await reportExternalQualificationProgress(
    retry,
    'qualification_recovery_after_retry_delay',
  );
}

export function durableExternalQualificationCasStore(store) {
  return store?.kind === 'AutonomousResearchQualificationStateRepository'
    && store.durable === true && store.compareAndSwap === true
    && store.systemOwnedRuntimeState === true
    && typeof store.readExternalQualificationState === 'function'
    && typeof store.compareAndSwapExternalQualificationState === 'function';
}

export function externalQualificationBoundToRelease(state, authority) {
  return state?.campaignId === authority?.campaignId
    && state?.paperId === authority?.paperId
    && state?.campaignReleaseBundleHash === authority?.campaignReleaseBundleHash;
}

export function locallyCurrentExternalQualificationInspection(
  state,
  authority,
  nowMs,
  minimumValidityMs = 0,
) {
  if (!externalQualificationBoundToRelease(state, authority)
    || state?.recovery?.status !== 'qualification_verified'
    || Date.parse(state?.receipt?.expiresAt || '') <= nowMs + minimumValidityMs) return null;
  return state.verifiedInspection;
}

export function supportsRecoverableExternalQualificationAttemptLease(store) {
  return store?.recoverableAttemptLease === true
    && typeof store.tryAcquireQualificationAttemptLease === 'function'
    && typeof store.renewQualificationAttemptLease === 'function'
    && typeof store.releaseQualificationAttemptLease === 'function';
}

export function supportsRecoverableExternalQualificationInfrastructureReservation(store) {
  return store?.recoverableInfrastructureReservation === true
    && typeof store.markQualificationAttemptExternalActionStarted === 'function'
    && typeof store.cancelQualificationAttemptInfrastructureDeferred === 'function'
    && typeof store.reconcileStaleQualificationAttemptReservation === 'function';
}

export function startExternalQualificationRecurringTimer(retry, callback, milliseconds) {
  const handle = typeof retry.scheduler?.setInterval === 'function'
    ? retry.scheduler.setInterval(callback, milliseconds)
    : setInterval(callback, milliseconds);
  retry.scheduler?.unref?.(handle);
  handle?.unref?.();
  return handle;
}

export function clearExternalQualificationRecurringTimer(retry, handle) {
  if (!handle) return;
  if (typeof retry.scheduler?.clearInterval === 'function') {
    retry.scheduler.clearInterval(handle);
  } else clearInterval(handle);
}

export function externalQualificationIdentityFromState(state) {
  return state?.recovery ? Object.freeze({
    configurationIdentityHash: state.recovery.configurationIdentityHash,
    trustIdentityHash: state.recovery.trustIdentityHash,
    clientServiceIdentityHash: state.recovery.clientServiceIdentityHash,
    verifierServiceIdentityHash: state.recovery.verifierServiceIdentityHash,
  }) : null;
}

export function externalQualificationInspectionWithIdentity(inspection, configuration) {
  return Object.freeze({
    ...inspection,
    ...externalQualificationEvidence(configuration),
  });
}
