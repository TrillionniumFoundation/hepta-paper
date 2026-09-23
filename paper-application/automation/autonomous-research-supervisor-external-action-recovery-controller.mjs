import {
  assertAutonomousResearchSupervisorExternalActionRecoveryPort,
} from '../../paper-ports/autonomous-research-supervisor-external-action-recovery-port.mjs';

function recoveryError(message, { fatal = false, retryAt = null, cause = null } = {}) {
  const error = new Error(message, cause ? { cause } : undefined);
  if (fatal) error.externalActionRecoveryFatal = true;
  else error.externalActionRecoveryDeferred = true;
  error.retryAt = retryAt;
  return error;
}

function fatalFailure(error) {
  const message = String(error?.message || error);
  return /configuration_rotated|identity_changed|response_invalid|capability_not_current|port_not_ready/
    .test(message);
}

export function createAutonomousResearchSupervisorExternalActionRecoveryController({
  stateRepository,
  recoveryPort,
  clock = { now: () => new Date() },
  maximumActionMs = 60_000,
  retryDelayMs = 5_000,
} = {}) {
  if (!stateRepository
    || typeof stateRepository.reconcileStaleLeases !== 'function'
    || typeof stateRepository.listPendingExternalActionRecoveries !== 'function'
    || typeof stateRepository.resolveExternalActionRecovery !== 'function'
    || typeof clock?.now !== 'function'
    || !Number.isSafeInteger(maximumActionMs) || maximumActionMs < 100
    || maximumActionMs > 5 * 60 * 1000
    || !Number.isSafeInteger(retryDelayMs) || retryDelayMs < 100) {
    throw new Error(
      'autonomous_research_supervisor_external_action_recovery_dependencies_invalid',
    );
  }
  assertAutonomousResearchSupervisorExternalActionRecoveryPort(recoveryPort, {
    now: clock.now(),
  });

  function remainingWindow(residentLeaseContext) {
    const now = clock.now();
    residentLeaseContext?.assertCurrent?.({ now });
    const expiresAt = Date.parse(residentLeaseContext?.lease?.expiresAt || '');
    const remaining = expiresAt - now.getTime() - 5_000;
    if (!Number.isFinite(remaining) || remaining < 200) {
      throw recoveryError(
        'autonomous_research_supervisor_external_action_recovery_lease_window_insufficient',
        { retryAt: new Date(now.getTime() + retryDelayMs).toISOString() },
      );
    }
    return Math.max(100, Math.min(maximumActionMs, Math.floor(remaining / 2)));
  }

  async function recoverAttempt(attempt, residentLeaseContext, signal) {
    const input = Object.freeze({
      attempt,
      signal,
      timeoutMs: remainingWindow(residentLeaseContext),
    });
    let resolution;
    try {
      resolution = await recoveryPort.lookup(input);
      residentLeaseContext?.assertCurrent?.({ now: clock.now() });
      if (['in_progress', 'not_found'].includes(resolution.outcome)) {
        resolution = await recoveryPort.resume(Object.freeze({
          ...input,
          timeoutMs: remainingWindow(residentLeaseContext),
          priorResolutionHash: resolution
            .autonomousResearchSupervisorExternalActionRecoveryResolutionHash,
        }));
        residentLeaseContext?.assertCurrent?.({ now: clock.now() });
      }
    } catch (error) {
      if (error?.externalActionRecoveryDeferred || error?.externalActionRecoveryFatal) {
        throw error;
      }
      throw recoveryError(
        String(error?.message
          || 'autonomous_research_supervisor_external_action_recovery_failed'),
        {
          fatal: fatalFailure(error),
          retryAt: new Date(clock.now().getTime() + retryDelayMs).toISOString(),
          cause: error,
        },
      );
    }
    if (!['completed', 'failed'].includes(resolution.outcome)) {
      throw recoveryError(
        'autonomous_research_supervisor_external_action_recovery_still_pending',
        { retryAt: new Date(clock.now().getTime() + retryDelayMs).toISOString() },
      );
    }
    return stateRepository.resolveExternalActionRecovery({
      resolution,
      now: clock.now(),
    });
  }

  return Object.freeze({
    version: 1,
    kind: 'AutonomousResearchSupervisorExternalActionRecoveryController',
    configurationIdentityHash: recoveryPort.configurationIdentityHash,
    inspectStatus({ now = clock.now() } = {}) {
      const capability = recoveryPort.inspectCapabilities({ now });
      return Object.freeze({
        ready: capability.ready === true,
        configurationIdentityHash: capability.configurationIdentityHash,
        capability,
      });
    },
    async reconcile({ residentLeaseContext, signal = null } = {}) {
      const now = clock.now();
      residentLeaseContext?.assertCurrent?.({ now });
      const stale = stateRepository.reconcileStaleLeases({ now });
      const pending = stateRepository.listPendingExternalActionRecoveries();
      const recovered = [];
      for (const attempt of pending) {
        recovered.push(await recoverAttempt(attempt, residentLeaseContext, signal));
      }
      return Object.freeze({
        ready: true,
        stale,
        inspectedRecoveryCount: pending.length,
        recovered: Object.freeze(recovered),
        reconciledAt: clock.now().toISOString(),
      });
    },
  });
}
