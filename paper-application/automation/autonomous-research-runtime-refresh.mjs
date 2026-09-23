import {
  assertRuntimeReproducibilityRefreshLead,
  runtimeReproducibilityRefreshRequired,
  runtimeReproducibilityReservation,
} from '../../paper-domain/automation/runtime-reproducibility-refresh-policy.mjs';
import {
  remainingAutonomousCampaignWallTimeMs,
} from './autonomous-research-supervisor-readiness-policy.mjs';

function observedDate(clock) {
  const value = clock?.now ? clock.now() : new Date();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new Error('runtime_reproducibility_refresh_clock_invalid');
  }
  return date;
}

function backoffMilliseconds(policy, failures, random) {
  const exponent = Math.max(0, Math.min(20, Number(failures || 0)));
  const base = Math.min(policy.maximumBackoffMs, policy.baseBackoffMs * (2 ** exponent));
  const jitter = Math.floor(base * 0.2 * Math.max(0, Math.min(1, Number(random()))));
  return Math.min(policy.maximumBackoffMs, base + jitter);
}

function verifiedPublication(report) {
  const publication = report?.publication;
  if (report?.ready !== true || report?.inspection?.ready !== true
    || !/^sha256:[0-9a-f]{64}$/i.test(String(report.inspection.receiptHash || ''))
    || !/^sha256:[0-9a-f]{64}$/i.test(String(publication?.receiptHash || ''))
    || report.inspection.receiptHash !== publication.receiptHash
    || !/^sha256:[0-9a-f]{64}$/i.test(String(publication?.receiptContentHash || ''))
    || !Number.isFinite(Date.parse(publication?.issuedAt || ''))
    || !Number.isFinite(Date.parse(publication?.expiresAt || ''))
    || Date.parse(publication.expiresAt) <= Date.parse(publication.issuedAt)) {
    throw new Error('runtime_reproducibility_refresh_publication_not_verified');
  }
  return publication;
}

function configurationFromStatus(status, policy) {
  const configuration = status?.configuration;
  if (configuration?.ready !== true) {
    const blocker = status?.blockers?.[0]
      || configuration?.blockers?.[0]
      || 'runtime_reproducibility_refresh_configuration_blocked';
    throw new Error(String(blocker));
  }
  assertRuntimeReproducibilityRefreshLead({ policy, configuration });
  runtimeReproducibilityReservation(configuration);
  return configuration;
}

function deferred(reason, deferUntil, extra = {}) {
  return Object.freeze({
    ready: false,
    status: 'runtime_reproducibility_refresh_deferred',
    reason,
    deferUntil,
    ...extra,
  });
}

function requiredValidityMs(campaign, policy, nowEpochMs) {
  return Math.max(
    policy.renewalLeadMs,
    remainingAutonomousCampaignWallTimeMs(campaign, nowEpochMs)
      + policy.actionSafetyMarginMs,
  );
}

function refreshRequired(status, policy, now, requiredValidity) {
  const receiptExpiresAtEpochMs = Date.parse(status?.inspection?.expiresAt || '');
  return runtimeReproducibilityRefreshRequired({
    receiptReady: status?.ready === true,
    receiptExpiresAtEpochMs: Number.isFinite(receiptExpiresAtEpochMs)
      ? receiptExpiresAtEpochMs : null,
    policy,
    nowEpochMs: now.getTime(),
    requiredValidityMs: requiredValidity,
  });
}

export function createAutonomousResearchRuntimeRefresh({
  stateRepository,
  readStatus,
  publish,
  recoverPendingPublication = null,
  clock = { now: () => new Date() },
  scheduler,
  random = Math.random,
} = {}) {
  if (!stateRepository?.globalSingletonLease
    || typeof stateRepository.tryAcquireRefreshLease !== 'function'
    || typeof stateRepository.reserveRefreshAttempt !== 'function'
    || typeof readStatus !== 'function'
    || typeof publish !== 'function'
    || (recoverPendingPublication !== null
      && typeof recoverPendingPublication !== 'function')
    || typeof scheduler?.setInterval !== 'function'
    || typeof scheduler?.clearInterval !== 'function') {
    throw new Error('autonomous_research_runtime_refresh_dependencies_invalid');
  }
  const { policy } = stateRepository;

  async function readStatusAfterPublicationRecovery(now) {
    if (recoverPendingPublication !== null) {
      try { await recoverPendingPublication({ now }); }
      catch (error) {
        const wrapped = new Error(
          'runtime_reproducibility_pending_publication_recovery_failed',
          { cause: error },
        );
        wrapped.retryablePublicationRecovery = true;
        throw wrapped;
      }
    }
    return readStatus({ now });
  }

  return Object.freeze({
    version: 1,
    kind: 'AutonomousResearchRuntimeRefresh',
    async ensureReady({
      campaign,
      ownerId,
      signal = null,
    } = {}) {
      const now = observedDate(clock);
      let status;
      try {
        status = await readStatusAfterPublicationRecovery(now);
        const configuration = configurationFromStatus(status, policy);
        const requiredValidity = requiredValidityMs(campaign, policy, now.getTime());
        if (requiredValidity >= configuration.maximumReceiptAgeMs) {
          throw new Error('runtime_reproducibility_refresh_campaign_window_uncoverable');
        }
      } catch (error) {
        return deferred(
          String(error?.message || error),
          new Date(now.getTime() + policy.maximumBackoffMs).toISOString(),
          { terminal: error?.retryablePublicationRecovery !== true },
        );
      }
      const initialRequiredValidity = requiredValidityMs(campaign, policy, now.getTime());
      if (!refreshRequired(status, policy, now, initialRequiredValidity)) {
        return Object.freeze({
          ready: true,
          status: 'runtime_reproducibility_receipt_current',
          refreshed: false,
          receiptHash: status.inspection.receiptHash,
          expiresAt: status.inspection.expiresAt,
          renewAt: new Date(
            Date.parse(status.inspection.expiresAt) - policy.renewalLeadMs,
          ).toISOString(),
        });
      }

      const acquisition = stateRepository.tryAcquireRefreshLease({
        ownerId,
        leaseMs: policy.leaseMs,
        now,
      });
      if (!acquisition.acquired) {
        return deferred(acquisition.reason, acquisition.nextAttemptAt);
      }
      const { lease } = acquisition;
      let attemptReserved = false;
      let leaseLost = false;
      const controller = new AbortController();
      const onAbort = () => controller.abort(signal?.reason || 'supervisor_process_shutdown');
      if (signal?.aborted) onAbort();
      else signal?.addEventListener?.('abort', onAbort, { once: true });
      const heartbeat = scheduler.setInterval(() => {
        try {
          const renewed = stateRepository.renewRefreshLease({
            lease,
            leaseMs: policy.leaseMs,
            now: observedDate(clock),
          });
          if (!renewed) leaseLost = true;
        } catch { leaseLost = true; }
        if (leaseLost && !controller.signal.aborted) {
          controller.abort('runtime_reproducibility_refresh_lease_lost');
        }
      }, Math.max(250, Math.floor(policy.leaseMs / 3)));
      scheduler.unref?.(heartbeat);
      try {
        status = await readStatusAfterPublicationRecovery(observedDate(clock));
        const configuration = configurationFromStatus(status, policy);
        const fencedNow = observedDate(clock);
        const fencedRequiredValidity = requiredValidityMs(
          campaign, policy, fencedNow.getTime(),
        );
        if (fencedRequiredValidity >= configuration.maximumReceiptAgeMs) {
          throw new Error('runtime_reproducibility_refresh_campaign_window_uncoverable');
        }
        if (!refreshRequired(status, policy, fencedNow, fencedRequiredValidity)) {
          stateRepository.releaseRefreshLease({ lease, now: observedDate(clock) });
          return Object.freeze({
            ready: true,
            status: 'runtime_reproducibility_receipt_current_after_fence',
            refreshed: false,
            receiptHash: status.inspection.receiptHash,
            expiresAt: status.inspection.expiresAt,
            renewAt: new Date(
              Date.parse(status.inspection.expiresAt) - policy.renewalLeadMs,
            ).toISOString(),
          });
        }
        const reservation = stateRepository.reserveRefreshAttempt({
          lease,
          campaignId: campaign?.campaignId,
          configuration,
          now: observedDate(clock),
        });
        if (!reservation.authorized) {
          return deferred(reservation.blocker, reservation.deferUntil, {
            terminal: reservation.terminal,
          });
        }
        attemptReserved = true;
        if (controller.signal.aborted) throw new Error(String(controller.signal.reason));
        stateRepository.assertRefreshLease({ lease, now: observedDate(clock) });
        const report = await publish({ signal: controller.signal });
        if (leaseLost) throw new Error('runtime_reproducibility_refresh_lease_lost');
        const publication = verifiedPublication(report);
        if (Date.parse(publication.expiresAt) - observedDate(clock).getTime()
          <= fencedRequiredValidity) {
          throw new Error('runtime_reproducibility_refresh_publication_validity_insufficient');
        }
        const completed = stateRepository.completeRefreshAttempt({
          lease,
          receiptHash: publication.receiptHash,
          receiptContentHash: publication.receiptContentHash,
          issuedAt: publication.issuedAt,
          expiresAt: publication.expiresAt,
          now: observedDate(clock),
        });
        return Object.freeze({
          ready: true,
          status: 'runtime_reproducibility_receipt_refreshed',
          refreshed: true,
          receiptHash: completed.lastReceiptHash,
          expiresAt: completed.lastExpiresAt,
          renewAt: new Date(
            Date.parse(completed.lastExpiresAt) - policy.renewalLeadMs,
          ).toISOString(),
          reservedCostUsd: reservation.reservedCostUsd,
          epochAttemptCount: reservation.epochAttemptCount,
        });
      } catch (error) {
        const failureAt = observedDate(clock);
        const cooldown = backoffMilliseconds(
          policy,
          stateRepository.readState().consecutiveFailures,
          random,
        );
        const nextAttemptAt = new Date(failureAt.getTime() + cooldown).toISOString();
        if (!leaseLost) {
          try {
            if (attemptReserved) {
              stateRepository.failRefreshAttempt({
                lease,
                error: error?.message || error,
                cancelled: controller.signal.aborted,
                nextAttemptAt,
                now: failureAt,
              });
            } else {
              stateRepository.releaseRefreshLease({ lease, now: failureAt });
            }
          } catch { /* a concurrent owner now controls recovery */ }
        }
        if (signal?.aborted) throw error;
        return deferred(String(error?.message || error), nextAttemptAt, { leaseLost });
      } finally {
        scheduler.clearInterval(heartbeat);
        signal?.removeEventListener?.('abort', onAbort);
      }
    },
  });
}
