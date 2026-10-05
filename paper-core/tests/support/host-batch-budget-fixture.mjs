import fs from 'node:fs';
import path from 'node:path';

// Fixture aggregate authority is below the original six-hour/3600-second
// defaults. Per-worker limits are not enlarged; 3*80 + 120 = 360 CPU seconds.
export function hostBatchFixtureBudget(now) {
  if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(now + 120000)) {
    throw new Error('host_batch_fixture_clock_invalid');
  }
  return Object.freeze({ timeoutMs: 120000, absoluteDeadlineEpochMs: now + 120000,
    cpuSeconds: 360, memoryBytes: 1024 * 1024 * 1024, maximumProcesses: 128 });
}

// Both directories belong to the caller's new fixture; outputs never mutate
// the source namespace that the real runner is required to keep hash-bound.
export function hostBatchFixtureWorkspace(ownedRoot) {
  const sourceRoot = path.join(ownedRoot, 'source');
  const outputDirectory = path.join(ownedRoot, 'output');
  fs.mkdirSync(sourceRoot, { mode: 0o700 });
  fs.mkdirSync(outputDirectory, { mode: 0o700 });
  return Object.freeze({ sourceRoot, outputDirectory });
}
