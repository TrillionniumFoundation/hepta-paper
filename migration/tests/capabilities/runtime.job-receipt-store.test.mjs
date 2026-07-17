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
