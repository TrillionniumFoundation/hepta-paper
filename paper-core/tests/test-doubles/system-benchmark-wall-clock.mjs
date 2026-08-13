import { AsyncLocalStorage } from 'node:async_hooks';

const clockContext = new AsyncLocalStorage();

export function systemBenchmarkNowEpochMs() {
  const nowEpochMs = clockContext.getStore();
  return typeof nowEpochMs === 'function' ? nowEpochMs() : Number.MAX_SAFE_INTEGER;
}

export function withSystemBenchmarkWallClockForTest(nowEpochMs, operation) {
  return clockContext.run(nowEpochMs, operation);
}
