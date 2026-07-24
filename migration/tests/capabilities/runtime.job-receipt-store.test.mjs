import assert from 'node:assert/strict';
import test from 'node:test';
import { createSqliteJobReceiptStore } from '../../../paper-adapters/persistence/sqlite-job-receipt-store.mjs';
import { createSqliteReceiptLedger } from '../../../paper-adapters/persistence/sqlite-receipt-ledger.mjs';
import { hashRecord } from '../../../workflow-kernel/record-hash.mjs';
import { computeReceiptHash } from '../../../paper-domain/evidence/receipt-hash-policy.mjs';
import { fixedClock, temporaryDirectory, temporaryStore } from './test-support.mjs';

function resultReceipt(jobId, attemptId, status = 'completed') {
  const payload = { version: 1, kind: 'OperationalJobResultReceipt', status, jobId, attemptId };
  return { ...payload, jobReceiptHash: hashRecord(payload.kind, payload) };
}

function operationalReceipt(overrides = {}) {
  const payload = {
    version: 1,
    kind: 'OperationalJobResultReceipt',
    status: 'completed',
    ...overrides,
  };
  return { ...payload, jobReceiptHash: hashRecord(payload.kind, payload) };
}

function mutableClock(iso) {
  let value = new Date(iso);
  return {
    now: () => new Date(value),
    nowIso: () => value.toISOString(),
    advance(milliseconds) { value = new Date(value.getTime() + milliseconds); },
  };
}

test('runtime.job-receipt-store requires the active worker and lease generation for attempts and failure', async (t) => {
  const root = await temporaryDirectory(t);
  const store = temporaryStore(root);
  const clock = fixedClock();
  const ledger = createSqliteReceiptLedger({ store, clock });
  const jobs = createSqliteJobReceiptStore({ store, receiptLedger: ledger, clock });
  jobs.createJob({ jobId: 'j', deduplicationKey: 'd', kind: 'research', paperId: 'p' });
  const lease = jobs.acquireLease({ jobId: 'j', workerId: 'w' });
  assert.equal(lease.status, 'leased');
  assert.equal(lease.leaseGeneration, 1);
  assert.throws(() => jobs.recordAttempt({ jobId: 'j', workerId: 'w' }), /job_lease_generation_required/);
  assert.throws(() => jobs.recordAttempt({ jobId: 'j', workerId: 'forged', leaseGeneration: lease.leaseGeneration }), /active_job_lease_fence_required/);
  const attempt = jobs.recordAttempt({ jobId: 'j', workerId: 'w', leaseGeneration: lease.leaseGeneration });
  assert.throws(() => jobs.failJob({ jobId: 'j', attemptId: attempt.attemptId, workerId: 'forged', leaseGeneration: attempt.leaseGeneration, failureClass: 'input_invalid' }), /active_job_attempt_lease_fence_required/);
  assert.equal(jobs.failJob({ jobId: 'j', attemptId: attempt.attemptId, workerId: attempt.workerId, leaseGeneration: attempt.leaseGeneration, failureClass: 'input_invalid', retryable: false }).status, 'failed_terminal');
});

test('runtime.job-receipt-store rejects missing or forged attempts without orphaning ledger receipts', async (t) => {
  const root = await temporaryDirectory(t);
  const store = temporaryStore(root);
  const clock = fixedClock();
  const ledger = createSqliteReceiptLedger({ store, clock });
  const jobs = createSqliteJobReceiptStore({ store, receiptLedger: ledger, clock });
  jobs.createJob({ jobId: 'j', deduplicationKey: 'd', kind: 'research', paperId: 'p' });
  const lease = jobs.acquireLease({ jobId: 'j', workerId: 'w' });
  const attempt = jobs.recordAttempt({ jobId: 'j', workerId: 'w', leaseGeneration: lease.leaseGeneration });
  const forged = resultReceipt('j', 'missing-attempt');
  assert.throws(() => jobs.completeJob({ jobId: 'j', attemptId: 'missing-attempt', workerId: 'w', leaseGeneration: attempt.leaseGeneration, receipt: forged }), /active_job_attempt_lease_fence_required/);
  assert.throws(() => jobs.completeJob({ jobId: 'j', attemptId: attempt.attemptId, workerId: 'w', leaseGeneration: attempt.leaseGeneration + 1, receipt: forged }), /active_job_attempt_lease_fence_required/);
  const invalidHash = {
    ...resultReceipt('j', attempt.attemptId),
    jobReceiptHash: 'sha256:definitely-invalid',
  };
  assert.throws(() => jobs.completeJob({
    jobId: 'j',
    attemptId: attempt.attemptId,
    workerId: attempt.workerId,
    leaseGeneration: attempt.leaseGeneration,
    receipt: invalidHash,
  }), /job_settlement_receipt_hash_invalid/);
  const competingHash = {
    ...resultReceipt('j', attempt.attemptId),
    jobReceiptHash: 'sha256:invalid-job-field',
  };
  competingHash.receiptHash = computeReceiptHash(competingHash, { hashField: 'receiptHash' });
  assert.throws(() => jobs.completeJob({
    jobId: 'j',
    attemptId: attempt.attemptId,
    workerId: attempt.workerId,
    leaseGeneration: attempt.leaseGeneration,
    receipt: competingHash,
  }), /job_settlement_receipt_hash_policy_invalid/);
  const wrongVersionPayload = { version: 2, kind: 'OperationalJobResultReceipt', status: 'completed', jobId: 'j', attemptId: attempt.attemptId };
  const wrongVersion = { ...wrongVersionPayload, jobReceiptHash: hashRecord(wrongVersionPayload.kind, wrongVersionPayload) };
  assert.throws(() => jobs.completeJob({
    jobId: 'j',
    attemptId: attempt.attemptId,
    workerId: attempt.workerId,
    leaseGeneration: attempt.leaseGeneration,
    receipt: wrongVersion,
  }), /job_settlement_receipt_kind_or_version_invalid/);
  const unknownPayload = { version: 1, kind: 'CallerInventedJobReceipt', status: 'completed', jobId: 'j', attemptId: attempt.attemptId };
  const unknownKind = { ...unknownPayload, jobReceiptHash: hashRecord(unknownPayload.kind, unknownPayload) };
  assert.throws(() => jobs.completeJob({
    jobId: 'j',
    attemptId: attempt.attemptId,
    workerId: attempt.workerId,
    leaseGeneration: attempt.leaseGeneration,
    receipt: unknownKind,
  }), /job receipt kind forbidden/);
  assert.equal(ledger.listRawForAudit({ stream: 'jobs' }).length, 0);
  assert.equal(jobs.get('j').status, 'running');
  assert.deepEqual(store.query(`SELECT status,receipt_id,completed_at FROM job_attempts WHERE attempt_id='${attempt.attemptId}';`).rows[0], {
    status: 'running',
    receipt_id: null,
    completed_at: null,
  });
  const receipt = resultReceipt('j', attempt.attemptId);
  const completed = jobs.completeJob({ jobId: 'j', attemptId: attempt.attemptId, workerId: attempt.workerId, leaseGeneration: attempt.leaseGeneration, receipt });
  assert.equal(completed.status, 'completed');
  assert.equal(ledger.listRawForAudit({ stream: 'jobs' }).length, 1);
});

test('runtime.job-receipt-store fences a stale attempt after an expired lease is reacquired', async (t) => {
  const root = await temporaryDirectory(t);
  const store = temporaryStore(root);
  const clock = fixedClock();
  const ledger = createSqliteReceiptLedger({ store, clock });
  const jobs = createSqliteJobReceiptStore({ store, receiptLedger: ledger, clock });
  jobs.createJob({ jobId: 'j', deduplicationKey: 'd', kind: 'research', paperId: 'p' });
  const firstLease = jobs.acquireLease({ jobId: 'j', workerId: 'old-worker' });
  const firstAttempt = jobs.recordAttempt({ jobId: 'j', workerId: 'old-worker', leaseGeneration: firstLease.leaseGeneration });
  assert.equal(store.execute("UPDATE jobs SET lease_expires_at='2000-01-01T00:00:00.000Z' WHERE job_id='j';").ok, true);
  const nextLease = jobs.acquireLease({ jobId: 'j', workerId: 'new-worker' });
  assert.equal(nextLease.leaseGeneration, firstLease.leaseGeneration + 1);
  assert.equal(store.query(`SELECT status FROM job_attempts WHERE attempt_id='${firstAttempt.attemptId}';`).rows[0].status, 'lost_lease');
  const staleReceipt = resultReceipt('j', firstAttempt.attemptId);
  assert.throws(() => jobs.completeJob({ jobId: 'j', attemptId: firstAttempt.attemptId, workerId: firstAttempt.workerId, leaseGeneration: firstAttempt.leaseGeneration, receipt: staleReceipt }), /active_job_attempt_lease_fence_required/);
  assert.equal(ledger.listRawForAudit({ stream: 'jobs' }).length, 0);
  const nextAttempt = jobs.recordAttempt({ jobId: 'j', workerId: 'new-worker', leaseGeneration: nextLease.leaseGeneration });
  const failureReceipt = resultReceipt('j', nextAttempt.attemptId, 'failed');
  const failed = jobs.failJob({ jobId: 'j', attemptId: nextAttempt.attemptId, workerId: nextAttempt.workerId, leaseGeneration: nextAttempt.leaseGeneration, failureClass: 'worker_failed', retryable: true, receipt: failureReceipt });
  assert.equal(failed.status, 'failed_retryable');
  assert.equal(failed.lease_owner, null);
});

test('runtime.job-receipt-store renews only a still-active fenced attempt', async (t) => {
  const root = await temporaryDirectory(t);
  const store = temporaryStore(root);
  const clock = mutableClock('2026-07-10T08:00:00.000Z');
  const ledger = createSqliteReceiptLedger({ store, clock });
  const jobs = createSqliteJobReceiptStore({ store, receiptLedger: ledger, clock });
  jobs.createJob({ jobId: 'j', deduplicationKey: 'd', kind: 'research', paperId: 'p' });
  const lease = jobs.acquireLease({ jobId: 'j', workerId: 'w', leaseSeconds: 3 });
  const attempt = jobs.recordAttempt({ jobId: 'j', workerId: 'w', leaseGeneration: lease.leaseGeneration });
  clock.advance(2_000);
  const renewed = jobs.renewAttemptLease({ ...attempt, leaseSeconds: 3 });
  assert.equal(renewed.lease_expires_at, '2026-07-10T08:00:05.000Z');
  clock.advance(2_000);
  const completed = jobs.completeJob({
    ...attempt,
    receipt: resultReceipt('j', attempt.attemptId),
  });
  assert.equal(completed.status, 'completed');

  jobs.createJob({ jobId: 'stale', deduplicationKey: 'stale', kind: 'research', paperId: 'p' });
  const staleLease = jobs.acquireLease({ jobId: 'stale', workerId: 'old', leaseSeconds: 1 });
  const staleAttempt = jobs.recordAttempt({ jobId: 'stale', workerId: 'old', leaseGeneration: staleLease.leaseGeneration });
  clock.advance(1_001);
  assert.throws(() => jobs.renewAttemptLease({ ...staleAttempt, leaseSeconds: 3 }), /active_job_attempt_lease_fence_required/);
  assert.throws(() => jobs.renewAttemptLease({ ...staleAttempt, workerId: 'forged', leaseSeconds: 3 }), /active_job_attempt_lease_fence_required/);
});

test('runtime.job-receipt-store binds optional operational receipt context and preserves legacy defaults', async (t) => {
  const root = await temporaryDirectory(t);
  const store = temporaryStore(root);
  const clock = fixedClock();
  const ledger = createSqliteReceiptLedger({ store, clock });
  const jobs = createSqliteJobReceiptStore({ store, receiptLedger: ledger, clock });

  jobs.createJob({
    jobId: 'bound',
    deduplicationKey: 'bound-dedupe',
    kind: 'research',
    paperId: 'paper-bound',
    priority: 7,
    environment: 'fixture',
    evidenceClass: 'fixture_evidence',
  });
  const boundLease = jobs.acquireLease({ jobId: 'bound', workerId: 'worker' });
  const boundAttempt = jobs.recordAttempt({
    jobId: 'bound',
    workerId: 'worker',
    leaseGeneration: boundLease.leaseGeneration,
  });
  const exactContext = {
    jobId: 'bound',
    attemptId: boundAttempt.attemptId,
    paperId: 'paper-bound',
  };
  for (const [overrides, expected] of [
    [{ ...exactContext, jobId: 'other-job' }, /job_settlement_receipt_job_id_mismatch/],
    [{ ...exactContext, attemptId: 'other-attempt' }, /job_settlement_receipt_attempt_id_mismatch/],
    [{ ...exactContext, paperId: 'other-paper' }, /job_settlement_receipt_paper_id_mismatch/],
  ]) {
    assert.throws(() => jobs.completeJob({
      ...boundAttempt,
      receipt: operationalReceipt(overrides),
    }), expected);
  }
  assert.throws(() => jobs.completeJob({
    ...boundAttempt,
    receipt: {},
  }), /job receipt kind forbidden:missing/);
  assert.equal(jobs.completeJob({
    ...boundAttempt,
    receipt: operationalReceipt(exactContext),
  }).status, 'completed');

  jobs.createJob({
    jobId: 'legacy-defaults',
    deduplicationKey: 'legacy-defaults-dedupe',
    kind: 'research',
  });
  assert.equal(store.execute(
    "UPDATE jobs SET spec_json='',environment='',evidence_class='' WHERE job_id='legacy-defaults';",
  ).ok, true);
  assert.deepEqual(jobs.get('legacy-defaults').spec, {});
  const legacyLease = jobs.acquireLease({
    jobId: 'legacy-defaults',
    workerId: 'legacy-worker',
  });
  const legacyAttempt = jobs.recordAttempt({
    jobId: 'legacy-defaults',
    workerId: 'legacy-worker',
    leaseGeneration: legacyLease.leaseGeneration,
  });
  assert.equal(jobs.completeJob({
    ...legacyAttempt,
    receipt: operationalReceipt(),
  }).status, 'completed');
  assert.equal(ledger.listRawForAudit({ stream: 'jobs' }).length, 2);
});

test('runtime.job-receipt-store rolls back begin, commit, and receipt write failures', async (t) => {
  const root = await temporaryDirectory(t);
  const store = temporaryStore(root);
  const clock = fixedClock();
  const ledger = createSqliteReceiptLedger({ store, clock });
  const jobs = createSqliteJobReceiptStore({ store, receiptLedger: ledger, clock });
  const wrappedStore = (execute) => Object.freeze({
    query: (sql, parameters = []) => store.query(sql, parameters),
    execute,
  });

  jobs.createJob({
    jobId: 'transaction-failure',
    deduplicationKey: 'transaction-failure-dedupe',
    kind: 'research',
  });
  const beginFailureJobs = createSqliteJobReceiptStore({
    store: wrappedStore((sql) => (
      sql === 'BEGIN IMMEDIATE;'
        ? { ok: false, error: 'injected_begin_failure' }
        : store.execute(sql)
    )),
    receiptLedger: ledger,
    clock,
  });
  assert.throws(
    () => beginFailureJobs.acquireLease({
      jobId: 'transaction-failure',
      workerId: 'worker',
    }),
    /injected_begin_failure/,
  );

  const commitFailureJobs = createSqliteJobReceiptStore({
    store: wrappedStore((sql) => (
      sql === 'COMMIT;'
        ? { ok: false, stderr: 'injected_commit_failure' }
        : store.execute(sql)
    )),
    receiptLedger: ledger,
    clock,
  });
  assert.throws(
    () => commitFailureJobs.acquireLease({
      jobId: 'transaction-failure',
      workerId: 'worker',
    }),
    /injected_commit_failure/,
  );
  assert.equal(jobs.get('transaction-failure').status, 'queued');

  const lease = jobs.acquireLease({
    jobId: 'transaction-failure',
    workerId: 'worker',
  });
  const attempt = jobs.recordAttempt({
    jobId: 'transaction-failure',
    workerId: 'worker',
    leaseGeneration: lease.leaseGeneration,
  });
  let transactionActive = false;
  const receiptWriteFailureJobs = createSqliteJobReceiptStore({
    store: wrappedStore((sql) => {
      if (sql === 'BEGIN IMMEDIATE;') {
        transactionActive = true;
        return store.execute(sql);
      }
      if (sql === 'ROLLBACK;') {
        transactionActive = false;
        return store.execute(sql);
      }
      if (transactionActive && sql !== 'COMMIT;') return { ok: false };
      return store.execute(sql);
    }),
    receiptLedger: ledger,
    clock,
  });
  assert.throws(
    () => receiptWriteFailureJobs.completeJob({
      ...attempt,
      receipt: operationalReceipt({
        jobId: 'transaction-failure',
        attemptId: attempt.attemptId,
      }),
    }),
    /job_receipt_ledger_write_failed/,
  );
  assert.equal(jobs.get('transaction-failure').status, 'running');
  assert.equal(ledger.listRawForAudit({ stream: 'jobs' }).length, 0);
});

test('runtime.job-receipt-store rejects every malformed public command before persistence', async (t) => {
  const root = await temporaryDirectory(t);
  const store = temporaryStore(root);
  const clock = fixedClock();
  const ledger = createSqliteReceiptLedger({ store, clock });

  assert.throws(
    () => createSqliteJobReceiptStore(),
    /Job store requires store, receiptLedger and clock/,
  );
  assert.throws(
    () => createSqliteJobReceiptStore({ store, receiptLedger: ledger }),
    /Job store requires store, receiptLedger and clock/,
  );
  assert.throws(
    () => createSqliteJobReceiptStore({
      store,
      receiptLedger: {},
      clock,
    }),
    /Job store requires atomic receipt ledger prepare/,
  );

  const jobs = createSqliteJobReceiptStore({
    store,
    receiptLedger: ledger,
    clock,
    deniedReceiptKinds: null,
  });
  for (const spec of [
    {},
    { jobId: 'missing-deduplication', kind: 'research' },
    { jobId: 'missing-kind', deduplicationKey: 'dedupe' },
  ]) {
    assert.throws(
      () => jobs.createJob(spec),
      /jobId, deduplicationKey and kind are required/,
    );
  }
  for (const input of [
    {},
    { jobId: 'missing-worker' },
    { workerId: 'missing-job' },
  ]) {
    assert.throws(
      () => jobs.acquireLease(input),
      /jobId and workerId are required/,
    );
  }
  for (const input of [
    {},
    { jobId: 'missing-worker', leaseGeneration: 1 },
    { workerId: 'missing-job', leaseGeneration: 1 },
  ]) {
    assert.throws(
      () => jobs.recordAttempt(input),
      /jobId and workerId are required/,
    );
  }
  assert.throws(
    () => jobs.recordAttempt({
      jobId: 'job',
      workerId: 'worker',
      leaseGeneration: 1,
      status: 'queued',
    }),
    /job_attempt_initial_status_invalid/,
  );
  for (const leaseGeneration of [undefined, 0, -1, 1.5, Number.NaN]) {
    assert.throws(
      () => jobs.recordAttempt({
        jobId: 'job',
        workerId: 'worker',
        leaseGeneration,
      }),
      /job_lease_generation_required/,
    );
  }
  for (const input of [
    {},
    { jobId: 'job', attemptId: 'attempt', leaseGeneration: 1 },
    { jobId: 'job', workerId: 'worker', leaseGeneration: 1 },
    { attemptId: 'attempt', workerId: 'worker', leaseGeneration: 1 },
  ]) {
    assert.throws(
      () => jobs.renewAttemptLease(input),
      /jobId, attemptId and workerId are required/,
    );
  }
  assert.throws(
    () => jobs.renewAttemptLease({
      jobId: 'job',
      attemptId: 'attempt',
      workerId: 'worker',
      leaseGeneration: 0,
    }),
    /job_lease_generation_required/,
  );
  assert.throws(
    () => jobs.completeJob(),
    /job completion receipt is required/,
  );
  assert.throws(
    () => jobs.failJob(),
    /job failure class is required/,
  );
  for (const input of [
    { attemptId: 'attempt', workerId: 'worker', leaseGeneration: 1 },
    { jobId: 'job', workerId: 'worker', leaseGeneration: 1 },
    { jobId: 'job', attemptId: 'attempt', leaseGeneration: 1 },
  ]) {
    assert.throws(
      () => jobs.failJob({ ...input, failureClass: 'fixture_failure' }),
      /jobId, attemptId and workerId are required/,
    );
  }

  assert.deepEqual(jobs.list({ status: 'queued', limit: 0 }), []);
  assert.deepEqual(jobs.list({ deduplicationKey: 'missing', limit: 5000 }), []);
  assert.equal(jobs.get('missing'), null);
});
