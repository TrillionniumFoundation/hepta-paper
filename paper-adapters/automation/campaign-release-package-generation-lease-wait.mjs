import { performance } from 'node:perf_hooks';
import {
  campaignReleasePackageTransactionError,
} from './campaign-release-package-transaction-repository.mjs';

const DEFAULT_MAXIMUM_WAIT_MS = 5 * 60 * 1000;
const INITIAL_RETRY_DELAY_MS = 25;
const MAXIMUM_RETRY_DELAY_MS = 1000;
const MAXIMUM_LOCK_PROBE_MS = 100;

function waitPolicyValue(value, fallback, code) {
  const selected = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(selected) || selected < 1) {
    throw campaignReleasePackageTransactionError(code);
  }
  return selected;
}

function generationLockWaitAborted(signal) {
  return campaignReleasePackageTransactionError(
    'campaign_release_package_generation_lock_wait_aborted',
    {
      retryable: true,
      campaignGenerationLockWaitAborted: true,
      abortReason: String(signal?.reason || 'campaign_execution_aborted').slice(0, 200),
    },
  );
}

function generationLockWaitTimedOut(waitedMs) {
  return campaignReleasePackageTransactionError(
    'campaign_release_package_generation_lock_wait_timeout',
    {
      retryable: true,
      stateRecoverabilityDeferred: true,
      campaignGenerationLockContention: true,
      waitedMs: Math.max(0, Math.floor(waitedMs)),
    },
  );
}

function sleepUntilRetry(delayMs, signal) {
  if (signal?.aborted) return Promise.reject(generationLockWaitAborted(signal));
  return new Promise((resolve, reject) => {
    let timer;
    const finish = (error) => {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      if (error) reject(error); else resolve();
    };
    const onAbort = () => finish(generationLockWaitAborted(signal));
    timer = setTimeout(() => finish(), delayMs);
    signal?.addEventListener?.('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

export async function acquireCampaignReleasePackageGenerationLeaseWithWait({
  acquire,
  signal = null,
  maximumWaitMs,
  initialRetryDelayMs,
  maximumRetryDelayMs,
} = {}) {
  if (typeof acquire !== 'function') {
    throw campaignReleasePackageTransactionError(
      'campaign_release_package_generation_lock_acquirer_required',
    );
  }
  const maximumWait = Math.min(DEFAULT_MAXIMUM_WAIT_MS, waitPolicyValue(
    maximumWaitMs,
    DEFAULT_MAXIMUM_WAIT_MS,
    'campaign_release_package_generation_lock_wait_invalid',
  ));
  let retryDelay = waitPolicyValue(
    initialRetryDelayMs,
    INITIAL_RETRY_DELAY_MS,
    'campaign_release_package_generation_lock_retry_delay_invalid',
  );
  const maximumRetryDelay = Math.min(MAXIMUM_RETRY_DELAY_MS, waitPolicyValue(
    maximumRetryDelayMs,
    MAXIMUM_RETRY_DELAY_MS,
    'campaign_release_package_generation_lock_retry_delay_invalid',
  ));
  retryDelay = Math.min(retryDelay, maximumRetryDelay);
  const startedAt = performance.now();
  while (true) {
    if (signal?.aborted) throw generationLockWaitAborted(signal);
    const waitedBeforeAttemptMs = performance.now() - startedAt;
    if (waitedBeforeAttemptMs >= maximumWait) {
      throw generationLockWaitTimedOut(waitedBeforeAttemptMs);
    }
    try {
      const lease = acquire(Math.max(1, Math.min(
        MAXIMUM_LOCK_PROBE_MS,
        Math.floor(maximumWait - waitedBeforeAttemptMs),
      )));
      if (signal?.aborted) {
        lease.release();
        throw generationLockWaitAborted(signal);
      }
      const waitedAfterAttemptMs = performance.now() - startedAt;
      if (waitedAfterAttemptMs >= maximumWait) {
        lease.release();
        throw generationLockWaitTimedOut(waitedAfterAttemptMs);
      }
      return lease;
    } catch (error) {
      if (![
        'campaign_release_package_generation_lock_unavailable',
        'campaign_release_package_generation_lock_probe_timeout',
      ].includes(error?.code)) {
        throw error;
      }
      const waitedMs = performance.now() - startedAt;
      if (waitedMs >= maximumWait) throw generationLockWaitTimedOut(waitedMs);
      await sleepUntilRetry(
        Math.max(1, Math.min(retryDelay, maximumWait - waitedMs)),
        signal,
      );
      retryDelay = Math.min(maximumRetryDelay, retryDelay * 2);
    }
  }
}
