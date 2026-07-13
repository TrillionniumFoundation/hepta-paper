import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateEvidenceConsumption } from '../../paper-domain/evidence/evidence-consumption-policy.mjs';

test('evidence consumption binds outputs, claim, locator, result policy and side effects', () => {
  const reference = { kind: 'ExperimentReceipt', status: 'verified', hash: 'sha256:r', createdAt: '2026-07-12T00:00:00Z', claimIds: ['c1'], path: 'results/run.json' };
  const ready = evaluateEvidenceConsumption({ reference, expected: { kind: 'ExperimentReceipt', acceptedStatuses: ['verified'] }, nowMs: Date.parse('2026-07-12T01:00:00Z'), requiredOutputs: ['metrics', 'manifest'], availableOutputs: ['manifest', 'metrics'], claimId: 'c1', sourceLocator: 'results/run.json', resultClass: 'positive', forbiddenSideEffects: ['source_mutation'], observedSideEffects: [] });
  assert.equal(ready.status, 'evidence_consumption_ready');
  const blocked = evaluateEvidenceConsumption({ reference: { ...reference, createdAt: null }, expected: { kind: 'ExperimentReceipt', acceptedStatuses: ['verified'] }, requiredOutputs: ['metrics'], availableOutputs: [], claimId: 'other', sourceLocator: 'other.json', resultClass: 'inconclusive', forbiddenSideEffects: ['source_mutation'], observedSideEffects: ['source_mutation'] });
  assert.ok(blocked.blockers.includes('evidence_created_at_missing_or_invalid'));
  assert.ok(blocked.blockers.includes('evidence_required_output_missing:metrics'));
  assert.ok(blocked.blockers.includes('evidence_claim_binding_mismatch'));
  assert.ok(blocked.blockers.includes('evidence_source_locator_mismatch'));
  assert.ok(blocked.blockers.includes('evidence_result_not_promotable:inconclusive'));
  assert.ok(blocked.blockers.includes('evidence_forbidden_side_effect:source_mutation'));
});
