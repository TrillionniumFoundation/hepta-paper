import {
  assertAutonomousResearchOnlineAuthorityEvidenceControllerPort,
  assertAutonomousResearchOnlineAuthorityEvidenceRenewalAdapterPort,
} from '../../paper-ports/autonomous-research-online-mutation-port.mjs';

const CLOCK_SKEW_MS = 5_000;

function observedDate(clock) {
  const value = clock?.now?.();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    const error = new Error('autonomous_research_online_authority_evidence_controller_clock_invalid');
    error.authorityEvidenceRenewalFatal = true;
    throw error;
  }
  return date;
}

function safeInteger(value, fallback, minimum = 0) {
  const candidate = value === undefined || value === null ? fallback : Number(value);
  if (!Number.isSafeInteger(candidate) || candidate < minimum) {
    const error = new Error('autonomous_research_online_authority_evidence_policy_invalid');
    error.authorityEvidenceRenewalFatal = true;
    throw error;
  }
  return candidate;
}

export function resolveAutonomousResearchOnlineAuthorityEvidenceRenewalPolicy({
  authorityOperationTimeoutMs = 1_000,
  authorityMaximumObservationAgeMs = 15 * 60 * 1000,
  authorityMaximumReservationLeaseMs = 15 * 60 * 1000,
  residentLeaseMs = 15 * 60 * 1000,
  pollMs = 5_000,
  residentHeartbeatMs = 30_000,
  renewalLeadMs = null,
  baseBackoffMs = null,
  maximumBackoffMs = null,
} = {}) {
  const timeout = safeInteger(authorityOperationTimeoutMs, 1_000, 1_000);
  const maximumObservationAge = safeInteger(
    authorityMaximumObservationAgeMs,
    15 * 60 * 1000,
    1_000,
  );
  const maximumReservationLease = safeInteger(
    authorityMaximumReservationLeaseMs,
    15 * 60 * 1000,
    1_000,
  );
  const residentLease = safeInteger(residentLeaseMs, 15 * 60 * 1000, 1_000);
  const poll = safeInteger(pollMs, 5_000, 1);
  const heartbeat = safeInteger(residentHeartbeatMs, 30_000, 250);
  const attemptUpperBoundMs = 3 * timeout + 30_000;
  const lead = safeInteger(
    renewalLeadMs,
    Math.max(2 * poll, 2 * heartbeat, attemptUpperBoundMs + poll + CLOCK_SKEW_MS),
    1_000,
  );
  const baseBackoff = safeInteger(baseBackoffMs, Math.max(1_000, poll), 1_000);
  const maximumBackoff = safeInteger(
    maximumBackoffMs,
    Math.max(baseBackoff, Math.min(60_000, Math.floor(lead / 4))),
    baseBackoff,
  );
  const minimumSafeLeadMs = attemptUpperBoundMs + poll + CLOCK_SKEW_MS;
  const minimumSafeResidentLeaseMs = attemptUpperBoundMs + 2 * heartbeat;
  if (lead < minimumSafeLeadMs
    || maximumObservationAge <= lead
    || maximumReservationLease <= lead
    || residentLease <= minimumSafeResidentLeaseMs) {
    const error = new Error(
      'autonomous_research_online_authority_evidence_policy_incompatible',
    );
    error.authorityEvidenceRenewalFatal = true;
    throw error;
  }
  return Object.freeze({
    attemptUpperBoundMs,
    minimumSafeLeadMs,
    minimumSafeResidentLeaseMs,
    renewalLeadMs: lead,
    baseBackoffMs: baseBackoff,
    maximumBackoffMs: maximumBackoff,
    authorityMaximumObservationAgeMs: maximumObservationAge,
    authorityMaximumReservationLeaseMs: maximumReservationLease,
    residentLeaseMs: residentLease,
  });
}

function requiredValidity(value, lead) {
  const requested = Number(value || 0);
  if (!Number.isSafeInteger(requested) || requested < 0) {
    const error = new Error('autonomous_research_online_authority_evidence_validity_invalid');
    error.authorityEvidenceRenewalFatal = true;
    throw error;
  }
  return Math.max(lead, requested);
}

function deferredError(reason, retryAt = null) {
  const error = new Error(String(reason
    || 'autonomous_research_online_authority_evidence_deferred'));
  error.authorityEvidenceRenewalDeferred = true;
  error.retryAt = retryAt;
  return error;
}

export function createAutonomousResearchOnlineAuthorityEvidenceRenewalController({
  adapter,
  clock = { now: () => new Date() },
  random = Math.random,
  requireResidentFence = true,
  residentLeaseMs = 15 * 60 * 1000,
  pollMs = 5_000,
  residentHeartbeatMs = 30_000,
  renewalLeadMs = null,
  baseBackoffMs = null,
  maximumBackoffMs = null,
} = {}) {
  const checkedAdapter = assertAutonomousResearchOnlineAuthorityEvidenceRenewalAdapterPort(
    adapter,
  );
  if (typeof random !== 'function' || typeof requireResidentFence !== 'boolean') {
    throw new Error('autonomous_research_online_authority_evidence_controller_invalid');
  }
  if (!Number.isSafeInteger(checkedAdapter.authorityTrust?.maximumObservationAgeMs)
    || !Number.isSafeInteger(checkedAdapter.authorityTrust?.maximumReservationLeaseMs)) {
    const error = new Error(
      'autonomous_research_online_authority_evidence_policy_incompatible',
    );
    error.authorityEvidenceRenewalFatal = true;
    throw error;
  }
  const policy = resolveAutonomousResearchOnlineAuthorityEvidenceRenewalPolicy({
    authorityOperationTimeoutMs: checkedAdapter.authorityOperationTimeoutMs,
    authorityMaximumObservationAgeMs:
      checkedAdapter.authorityTrust?.maximumObservationAgeMs,
    authorityMaximumReservationLeaseMs:
      checkedAdapter.authorityTrust?.maximumReservationLeaseMs,
    residentLeaseMs,
    pollMs,
    residentHeartbeatMs,
    renewalLeadMs,
    baseBackoffMs,
    maximumBackoffMs,
  });
  let consecutiveFailures = 0;
  let nextAttemptAtMs = 0;
  let lastReceipt = null;
  let renewing = false;

  function assertResidentFence(residentLeaseContext, now) {
    if (!residentLeaseContext) {
      if (requireResidentFence) {
        const error = new Error(
          'autonomous_research_online_authority_evidence_resident_fence_required',
        );
        error.authorityEvidenceRenewalFatal = true;
        throw error;
      }
      return null;
    }
    if (typeof residentLeaseContext.assertCurrent !== 'function') {
      const error = new Error(
        'autonomous_research_online_authority_evidence_resident_fence_invalid',
      );
      error.authorityEvidenceRenewalFatal = true;
      throw error;
    }
    return residentLeaseContext.assertCurrent({ now });
  }

  function inspect(required) {
    return checkedAdapter.inspectCurrent({
      now: observedDate(clock),
      minimumRemainingValidityMs: required,
    });
  }

  function transientDeferred(error, now) {
    consecutiveFailures += 1;
    const exponent = Math.min(20, Math.max(0, consecutiveFailures - 1));
    const base = Math.min(
      policy.maximumBackoffMs,
      policy.baseBackoffMs * (2 ** exponent),
    );
    const jitter = Math.floor(base * 0.2
      * Math.max(0, Math.min(1, Number(random()))));
    const delay = Math.min(policy.maximumBackoffMs, base + jitter);
    nextAttemptAtMs = now.getTime() + delay;
    lastReceipt = Object.freeze({
      ready: false,
      status: 'autonomous_research_online_authority_evidence_renewal_deferred',
      reason: String(error?.message || error),
      consecutiveFailures,
      retryAt: new Date(nextAttemptAtMs).toISOString(),
      externalActionPerformed: false,
    });
    return lastReceipt;
  }

  function reconcile({ residentLeaseContext = null, requiredValidityMs = 0 } = {}) {
    const now = observedDate(clock);
    const required = requiredValidity(requiredValidityMs, policy.renewalLeadMs);
    assertResidentFence(residentLeaseContext, now);
    let current;
    try { current = inspect(required); }
    catch (error) {
      if (error?.authorityEvidenceRenewalFatal) throw error;
      current = Object.freeze({ ready: false, reason: String(error?.message || error) });
    }
    if (current.ready) {
      consecutiveFailures = 0;
      nextAttemptAtMs = 0;
      lastReceipt = Object.freeze({
        ...current,
        status: 'autonomous_research_online_authority_evidence_current',
        renewed: false,
        consecutiveFailures: 0,
        retryAt: null,
      });
      return lastReceipt;
    }
    if (renewing) {
      return Object.freeze({
        ready: false,
        status: 'autonomous_research_online_authority_evidence_renewal_deferred',
        reason: 'autonomous_research_online_authority_evidence_renewal_in_progress',
        consecutiveFailures,
        retryAt: nextAttemptAtMs > now.getTime()
          ? new Date(nextAttemptAtMs).toISOString() : now.toISOString(),
        externalActionPerformed: false,
      });
    }
    if (nextAttemptAtMs > now.getTime()) {
      return Object.freeze({
        ready: false,
        status: 'autonomous_research_online_authority_evidence_renewal_deferred',
        reason: lastReceipt?.reason || current.reason,
        consecutiveFailures,
        retryAt: new Date(nextAttemptAtMs).toISOString(),
        externalActionPerformed: false,
      });
    }
    renewing = true;
    try {
      const renewed = checkedAdapter.renew({
        now,
        minimumRemainingValidityMs: required,
        assertResidentFence: ({ now: fenceNow }) => (
          assertResidentFence(residentLeaseContext, fenceNow)
        ),
      });
      consecutiveFailures = 0;
      nextAttemptAtMs = 0;
      lastReceipt = Object.freeze({
        ...renewed,
        renewed: true,
        consecutiveFailures: 0,
        retryAt: null,
      });
      return lastReceipt;
    } catch (error) {
      if (error?.authorityEvidenceRenewalFatal === true) throw error;
      try {
        const peer = inspect(required);
        if (peer.ready) {
          consecutiveFailures = 0;
          nextAttemptAtMs = 0;
          lastReceipt = Object.freeze({
            ...peer,
            status: 'autonomous_research_online_authority_evidence_current_after_peer_renewal',
            renewed: false,
            consecutiveFailures: 0,
            retryAt: null,
          });
          return lastReceipt;
        }
      } catch (inspectionError) {
        if (inspectionError?.authorityEvidenceRenewalFatal === true) throw inspectionError;
      }
      return transientDeferred(error, observedDate(clock));
    } finally { renewing = false; }
  }

  function assertCurrent({ requiredValidityMs = 0, action = 'unspecified' } = {}) {
    const required = requiredValidity(requiredValidityMs, 0);
    let current;
    try { current = inspect(required); }
    catch (error) {
      if (error?.authorityEvidenceRenewalFatal) throw error;
      throw deferredError(error?.message || error, lastReceipt?.retryAt || null);
    }
    if (!current.ready) {
      throw deferredError(
        `autonomous_research_online_authority_evidence_not_current:action=${action}`,
        lastReceipt?.retryAt || null,
      );
    }
    return current;
  }

  return assertAutonomousResearchOnlineAuthorityEvidenceControllerPort(Object.freeze({
    version: 1,
    kind: 'AutonomousResearchOnlineAuthorityEvidenceRenewalController',
    policy,
    reconcile,
    assertCurrent,
    inspectStatus() {
      return Object.freeze({
        version: 1,
        kind: 'AutonomousResearchOnlineAuthorityEvidenceRenewalControllerStatus',
        status: lastReceipt?.status || 'autonomous_research_online_authority_evidence_unobserved',
        consecutiveFailures,
        retryAt: nextAttemptAtMs ? new Date(nextAttemptAtMs).toISOString() : null,
        lastReceipt,
      });
    },
  }));
}
