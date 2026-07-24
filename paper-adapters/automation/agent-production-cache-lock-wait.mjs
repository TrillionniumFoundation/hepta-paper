import { performance } from 'node:perf_hooks';

const MAXIMUM_TIMER_DELAY_MS = 2_147_483_647;

function waitForLockRetry(delayMs, signal) {
  if (signal?.aborted) {
    return Promise.reject(new Error('agent_production_cache_request_lock_wait_aborted'));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (operation) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      operation();
    };
    const abort = () => finish(() => reject(
      new Error('agent_production_cache_request_lock_wait_aborted'),
    ));
    const timer = setTimeout(() => finish(resolve), delayMs);
    signal?.addEventListener('abort', abort, { once: true });
  });
}

export async function runAgentProductionCacheRequestLockOperation({
  options,
  operation,
  acquireLock,
  assertLock,
  releaseLock,
  defaultContentionWaitMs,
} = {}) {
  if (typeof operation !== 'function') {
    throw new Error('agent_production_cache_request_lock_operation_required');
  }
  const {
    contentionWaitMs = defaultContentionWaitMs,
    contentionPollMs = 100,
    signal = null,
  } = options || {};
  if (!Number.isSafeInteger(contentionWaitMs) || contentionWaitMs < 0
    || !Number.isSafeInteger(contentionPollMs) || contentionPollMs < 1
    || contentionPollMs > MAXIMUM_TIMER_DELAY_MS
    || (signal && (typeof signal.addEventListener !== 'function'
      || typeof signal.removeEventListener !== 'function'))) {
    throw new Error('agent_production_cache_request_lock_wait_policy_invalid');
  }
  const deadline = performance.now() + contentionWaitMs;
  if (!Number.isFinite(deadline)) {
    throw new Error('agent_production_cache_request_lock_wait_policy_invalid');
  }
  let lock;
  while (!lock) {
    if (signal?.aborted) {
      throw new Error('agent_production_cache_request_lock_wait_aborted');
    }
    try {
      lock = acquireLock(options);
    } catch (error) {
      if (error?.message !== 'agent_production_cache_request_lock_contended') throw error;
      const remainingMs = deadline - performance.now();
      if (remainingMs <= 0) {
        throw new Error('agent_production_cache_request_lock_wait_timeout');
      }
      await waitForLockRetry(Math.min(contentionPollMs, remainingMs), signal);
    }
  }
  if (signal?.aborted) {
    releaseLock(lock);
    throw new Error('agent_production_cache_request_lock_wait_aborted');
  }
  try {
    const result = await operation(lock);
    assertLock(lock);
    return result;
  } finally {
    releaseLock(lock);
  }
}
