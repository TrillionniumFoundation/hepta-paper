import assert from 'node:assert/strict';
import test from 'node:test';
import { buildResearchGapPlan } from '../../paper-domain/research/gap-planner.mjs';

test('revision requests become typed bounded research job contracts', () => {
  const plan = buildResearchGapPlan({
    paperTask: { paperId: 'p' }, claimRegistry: { claims: [] }, evidenceQualityGate: { coveredClaimIds: [] },
    revisionRequests: [
      { request_id: 1, request_key: 'theorem:open', risk_class: 'theorem_readiness', status: 'requested', verification: 'lake build' },
      { request_id: 2, request_key: 'experiment:threshold', risk_class: 'experiment', status: 'requested' },
    ],
  });
  assert.deepEqual(plan.jobs.map((job) => job.gapKind).sort(), ['experiment', 'proof']);
  const proof = plan.jobs.find((job) => job.gapKind === 'proof');
  assert.equal(proof.action, 'verify_or_complete_formal_proof');
  assert.ok(proof.requiredOutputs.includes('formal_verification_receipt'));
  assert.ok(proof.forbiddenActions.includes('direct_source_mutation'));
  assert.equal(proof.source, 'referee_revision_requests');
});
