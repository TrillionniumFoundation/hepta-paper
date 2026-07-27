import assert from 'node:assert/strict';
import test from 'node:test';
import { bindResearchGapPlan, buildResearchGapPlan } from '../../../paper-domain/research/gap-planner.mjs';
import { createSqliteJobReceiptStore } from '../../../paper-adapters/persistence/sqlite-job-receipt-store.mjs';
import { createSqliteReceiptLedger } from '../../../paper-adapters/persistence/sqlite-receipt-ledger.mjs';
import { fixedClock, temporaryDirectory, temporaryStore } from './test-support.mjs';

test('research.gap-planner deduplicates and binds persistent jobs, leases and attempts', async (t) => {
  const plan = buildResearchGapPlan({ paperTask: { paperId: 'p' }, claimRegistry: { claims: [{ claimId: 'b', status: 'candidate' }, { claimId: 'a', status: 'candidate' }] }, evidenceQualityGate: { coveredClaimIds: [] }, priorities: { a: 1 } });
  assert.equal(plan.jobs[0].gapKind, 'claim_evidence');
  assert.ok(plan.jobs[0].requiredOutputs.includes('claim_bound_evidence'));
  assert.equal(plan.jobs[0].arbitraryCommandAllowed, false);
  assert.deepEqual(plan.jobs.map((job) => job.claimId), ['a', 'b']);
  assert.ok(plan.jobs.every((job) => job.arbitraryCommandAllowed === false && job.deduplicationKey));
  const root = await temporaryDirectory(t);
  const store = temporaryStore(root);
  const clock = fixedClock();
  const ledger = createSqliteReceiptLedger({ store, clock });
  const jobs = createSqliteJobReceiptStore({ store, receiptLedger: ledger, clock });
  const binding = bindResearchGapPlan({ plan, jobReceiptStore: jobs, receiptLedger: ledger, clock, workerId: 'planner' });
  assert.equal(binding.status, 'research_gap_plan_bound');
  assert.equal(binding.bindings.length, 2);
  assert.ok(binding.bindings.every((item) => item.persistedStatus === 'completed' && item.attemptId));
});
