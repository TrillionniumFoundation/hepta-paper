// Fixture aggregate authority is below the original six-hour/3600-second
// defaults. Per-worker limits are not enlarged; 3*80 + 120 = 360 CPU seconds.
export function hostBatchFixtureBudget(now) {
  if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(now + 120000)) {
    throw new Error('host_batch_fixture_clock_invalid');
  }
  return Object.freeze({ timeoutMs: 120000, absoluteDeadlineEpochMs: now + 120000,
    cpuSeconds: 360, memoryBytes: 1024 * 1024 * 1024, maximumProcesses: 128 });
}
