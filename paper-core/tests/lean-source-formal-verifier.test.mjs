import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createLakeFormalVerifier } from '../../paper-adapters/research-verify/lake-formal-verifier.mjs';
import { leanSourceDeclarationRecords } from '../../paper-adapters/research-verify/lean-source-contracts.mjs';
import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const fixtureRoot = path.join(repositoryRoot, 'migration', 'fixtures', 'lean-adversarial');

function receipt(relative) {
  return { path: relative, hash: hashBytes(fs.readFileSync(path.join(fixtureRoot, relative))) };
}

test('Lean source parser derives conclusion-as-premise without caller annotations', () => {
  const declarations = leanSourceDeclarationRecords(fs.readFileSync(path.join(fixtureRoot, 'Adversarial.lean'), 'utf8'));
  const adversarial = declarations.find((item) => item.name === 'conclusionFromPremise');
  assert.ok(adversarial);
  assert.equal(adversarial.conclusion, 'P');
  assert.ok(adversarial.premises.includes('P'));
  assert.equal(adversarial.conclusionAssumedAsPremise, true);
  const vacuous = declarations.find((item) => item.name === 'vacuousTrue');
  assert.equal(vacuous.conclusion, 'True');
  assert.equal(vacuous.vacuous, true);
});

test('real Lake build cannot certify a theorem whose source assumes its conclusion', async (t) => {
  const probe = spawnSync('lake', ['--version'], { cwd: fixtureRoot, encoding: 'utf8', env: { ...process.env, ELAN_TOOLCHAIN: 'leanprover/lean4:v4.30.0' } });
  if (probe.status !== 0) { t.skip(`Lake unavailable: ${probe.stderr || probe.stdout}`); return; }
  const commandRunner = {
    run(spec) {
      const execution = spawnSync(spec.executable, spec.args, { cwd: spec.cwd, encoding: 'utf8', timeout: spec.timeoutMs, env: { ...process.env, ...spec.env } });
      const payload = { executable: spec.executable, args: spec.args, status: execution.status, stdout: execution.stdout || '', stderr: execution.stderr || '' };
      return { ...payload, ok: execution.status === 0, receiptHash: hashRecord('LeanFixtureCommandReceipt', payload), blockers: execution.status === 0 ? [] : ['command_failed'] };
    },
  };
  const declaration = leanSourceDeclarationRecords(fs.readFileSync(path.join(fixtureRoot, 'Adversarial.lean'), 'utf8')).find((item) => item.name === 'conclusionFromPremise');
  const verifier = createLakeFormalVerifier({ projectRoot: fixtureRoot, commandRunner });
  const result = await verifier.verify({
    expectedInputs: [receipt('Adversarial.lean'), receipt('Audit.lean')],
    claimBindings: [{
      claimId: 'claim-adversarial',
      theoremName: 'conclusionFromPremise',
      sourceFile: 'Adversarial.lean',
      auditFile: 'Audit.lean',
      expectedTypeHash: declaration.typeHash,
      sourceStatementHash: declaration.statementHash,
      unconditional: true,
      conditional: false,
      conclusionAssumedAsPremise: false,
    }],
  });
  assert.equal(result.status, 'formal_claim_binding_blocked', `${JSON.stringify(result, null, 2)}`);
  assert.ok(result.blockers.some((item) => item.endsWith('target_conclusion_assumed_as_premise')));
  assert.equal(result.claimBindingReport.bindings[0].sourceStatementHash, declaration.statementHash);
});

test('real Lake build cannot promote a vacuous True theorem', async (t) => {
  const probe = spawnSync('lake', ['--version'], { cwd: fixtureRoot, encoding: 'utf8', env: { ...process.env, ELAN_TOOLCHAIN: 'leanprover/lean4:v4.30.0' } });
  if (probe.status !== 0) { t.skip(`Lake unavailable: ${probe.stderr || probe.stdout}`); return; }
  const commandRunner = {
    run(spec) {
      const execution = spawnSync(spec.executable, spec.args, { cwd: spec.cwd, encoding: 'utf8', timeout: spec.timeoutMs, env: { ...process.env, ...spec.env } });
      const payload = { executable: spec.executable, args: spec.args, status: execution.status, stdout: execution.stdout || '', stderr: execution.stderr || '' };
      return { ...payload, ok: execution.status === 0, receiptHash: hashRecord('LeanFixtureCommandReceipt', payload), blockers: execution.status === 0 ? [] : ['command_failed'] };
    },
  };
  const declaration = leanSourceDeclarationRecords(fs.readFileSync(path.join(fixtureRoot, 'Adversarial.lean'), 'utf8')).find((item) => item.name === 'vacuousTrue');
  const verifier = createLakeFormalVerifier({ projectRoot: fixtureRoot, commandRunner });
  const result = await verifier.verify({
    expectedInputs: [receipt('Adversarial.lean'), receipt('Audit.lean')],
    claimBindings: [{
      claimId: 'claim-vacuous',
      theoremName: 'vacuousTrue',
      sourceFile: 'Adversarial.lean',
      auditFile: 'Audit.lean',
      expectedTypeHash: declaration.typeHash,
      sourceStatementHash: declaration.statementHash,
    }],
  });
  assert.equal(result.status, 'formal_claim_binding_blocked', `${JSON.stringify(result, null, 2)}`);
  assert.ok(result.blockers.some((item) => item.endsWith('target_theorem_vacuous_true')));
});
