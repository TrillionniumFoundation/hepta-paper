import assert from 'node:assert/strict';
import test from 'node:test';

import { NATIVE_RESEARCH_WORKER_JOB_LEASE_SECONDS, withJobAttemptLeaseHeartbeat } from '../../paper-adapters/research-verify/job-attempt-lease-heartbeat.mjs';

function controlledScheduler() {
  let callback = null;
  let cleared = 0;
  return {
    scheduler: {
      setInterval(next) { callback = next; return { id: 'heartbeat' }; },
      clearInterval() { cleared += 1; },
      unref() {},
    },
    heartbeat() { callback(); },
    cleared: () => cleared,
  };
}

test('job attempt heartbeat renews the exact active fence during a long operation', async () => {
  assert.equal(NATIVE_RESEARCH_WORKER_JOB_LEASE_SECONDS, 1800);
  const control = controlledScheduler();
  const renewals = [];
  const store = { renewAttemptLease: (input) => renewals.push(input) };
  const attempt = { jobId: 'job', attemptId: 'attempt', workerId: 'worker', leaseGeneration: 4 };
  const result = await withJobAttemptLeaseHeartbeat(store, attempt, async (signal) => {
    assert.equal(signal.aborted, false);
    control.heartbeat();
    control.heartbeat();
    return 'verified';
  }, { leaseSeconds: 9, scheduler: control.scheduler });
  assert.equal(result, 'verified');
  assert.deepEqual(renewals, [
    { ...attempt, leaseSeconds: 9 },
    { ...attempt, leaseSeconds: 9 },
  ]);
  assert.equal(control.cleared(), 1);
});

test('job attempt heartbeat preserves the stale-worker fence when renewal is lost', async () => {
  const control = controlledScheduler();
  const store = { renewAttemptLease() { throw new Error('active_job_attempt_lease_fence_required'); } };
  const attempt = { jobId: 'job', attemptId: 'attempt', workerId: 'worker', leaseGeneration: 4 };
  await assert.rejects(withJobAttemptLeaseHeartbeat(store, attempt, async (signal) => {
    control.heartbeat();
    assert.equal(signal.aborted, true);
    assert.equal(signal.reason, 'job_attempt_lease_lost');
    return 'must-not-settle';
  }, { leaseSeconds: 9, scheduler: control.scheduler }), /job_attempt_lease_lost/);
  assert.equal(control.cleared(), 2);
});
