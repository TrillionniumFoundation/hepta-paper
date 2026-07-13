import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateEvidenceReferenceValidity } from '../../paper-domain/evidence/evidence-reference-validity.mjs';

test('evidence validity binds kind, hashes, lineage and applies TTL only when declared', () => {
  const reference = {
    kind: 'ExperimentReceipt', status: 'verified', hash: 'sha256:receipt', inputHash: 'sha256:input',
    sourceRevision: 'rev-1', lineageId: 'lineage-1', environment: 'production', releaseCommit: 'abc',
    createdAt: '2020-01-01T00:00:00.000Z',
  };
  const expected = { kind: 'ExperimentReceipt', acceptedStatuses: ['verified'], inputHash: 'sha256:input', sourceRevision: 'rev-1', lineageId: 'lineage-1', environment: 'production', releaseCommit: 'abc' };
  assert.equal(evaluateEvidenceReferenceValidity({ reference, expected, nowMs: Date.parse('2026-01-01T00:00:00Z') }).status, 'evidence_reference_valid');
  const expiring = evaluateEvidenceReferenceValidity({ reference, expected, nowMs: Date.parse('2026-01-01T00:00:00Z'), maximumAgeMs: 1000 });
  assert.ok(expiring.blockers.includes('evidence_ttl_expired'));
  const mismatched = evaluateEvidenceReferenceValidity({ reference, expected: { ...expected, lineageId: 'other' } });
  assert.ok(mismatched.blockers.includes('evidence_lineage_mismatch'));
});
