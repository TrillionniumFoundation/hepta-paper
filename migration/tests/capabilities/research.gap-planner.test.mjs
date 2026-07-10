import assert from 'node:assert/strict';
import test from 'node:test';
import { buildResearchGapPlan } from '../../../paper-application/research/gap-planner.mjs';

test('research.gap-planner deduplicates bounded prioritized jobs', () => {
  const plan = buildResearchGapPlan({ paperTask: { paperId: 'p' }, claimRegistry: { claims: [{ claimId: 'b', status: 'candidate' }, { claimId: 'a', status: 'candidate' }] }, evidenceQualityGate: { coveredClaimIds: [] }, priorities: { a: 1 } });
  assert.deepEqual(plan.jobs.map((job) => job.claimId), ['a', 'b']);
  assert.ok(plan.jobs.every((job) => job.arbitraryCommandAllowed === false && job.deduplicationKey));
});
