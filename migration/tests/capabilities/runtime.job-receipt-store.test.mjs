import assert from 'node:assert/strict';
import test from 'node:test';
import { createSqliteJobReceiptStore } from '../../../paper-adapters/persistence/sqlite-job-receipt-store.mjs';
import { createSqliteReceiptLedger } from '../../../paper-adapters/persistence/sqlite-receipt-ledger.mjs';
import { fixedClock, temporaryDirectory, temporaryStore } from './test-support.mjs';

test('runtime.job-receipt-store enforces idempotency lease attempts and failure class', async (t) => {
  const root = await temporaryDirectory(t);
  const store = temporaryStore(root);
  const clock = fixedClock();
  const ledger = createSqliteReceiptLedger({ store, clock });
  const jobs = createSqliteJobReceiptStore({ store, receiptLedger: ledger, clock });
  jobs.createJob({ jobId: 'j', deduplicationKey: 'd', kind: 'research', paperId: 'p' });
  assert.equal(jobs.acquireLease({ jobId: 'j', workerId: 'w' }).status, 'leased');
  const attempt = jobs.recordAttempt({ jobId: 'j', workerId: 'w' });
  assert.equal(jobs.failJob({ jobId: 'j', attemptId: attempt.attemptId, failureClass: 'input_invalid', retryable: false }).status, 'failed_terminal');
});
