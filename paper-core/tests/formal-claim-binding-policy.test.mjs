import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { evaluateFormalClaimBindings } from '../../paper-domain/research/formal-claim-binding-policy.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('formal claim binding rejects a buildable theorem that assumes its conclusion', () => {
  const fixture = JSON.parse(fs.readFileSync(path.join(root, 'migration', 'fixtures', 'legacy-lean-adversarial-v1.json'), 'utf8'));
  const blocked = evaluateFormalClaimBindings(fixture);
  assert.equal(blocked.status, 'formal_claim_binding_blocked');
  assert.ok(blocked.blockers.some((item) => item.endsWith('target_conclusion_assumed_as_premise')));
  const verified = evaluateFormalClaimBindings({
    claims: [{ claimId: 'claim-1', theoremName: 'verifiedTheorem', expectedTypeHash: 'sha256:type', sourceStatementHash: 'sha256:statement', proofObligations: ['verifiedTheorem'], unconditional: true }],
    declarations: [{ name: 'verifiedTheorem', typeHash: 'sha256:type', sourceStatementHash: 'sha256:statement', buildVerified: true, conditional: false, verifiedObligations: ['verifiedTheorem'], axioms: [] }],
  });
  assert.equal(verified.status, 'formal_claim_binding_verified');
});

test('formal claim binding requires explicit obligation coverage and rejects vacuous True', () => {
  const report = evaluateFormalClaimBindings({
    claims: [{ claimId: 'claim-coverage', theoremName: 'target', expectedTypeHash: 'sha256:type', proofObligations: ['target', 'supportingLemma'] }],
    declarations: [{ name: 'target', typeHash: 'sha256:type', buildVerified: true, conclusion: 'True', vacuous: true, verifiedObligations: ['target'], axioms: [] }],
  });
  assert.ok(report.blockers.some((item) => item.endsWith('target_theorem_vacuous_true')));
  assert.ok(report.blockers.some((item) => item.endsWith('target_theorem_obligation_coverage_incomplete')));
});
