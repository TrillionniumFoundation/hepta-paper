import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createOsSandboxedWorkerRunnerForTest as createOsSandboxedWorkerRunner,
} from './support/os-sandboxed-worker-runner-test-driver.mjs';
import { buildEmpiricalEnvironmentBom } from '../../paper-domain/automation/environment-bom-contract.mjs';
import { verifyOsSandboxWorkerReceipt } from '../../paper-domain/automation/os-sandbox-worker-receipt-contract.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

function fixture(t, outputBytes, requestedMaximumOutputBytes) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-worker-bom-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  const output = path.join(root, 'output');
  fs.mkdirSync(source);
  fs.mkdirSync(output);
  fs.writeFileSync(path.join(source, 'run.mjs'), 'process.exit(0);\n');
  const runner = createOsSandboxedWorkerRunner({
    allowedExecutables: [process.execPath], allowedRoots: [source], allowedOutputRoots: [output],
    probe: { available: true, backend: 'bubblewrap', status: 'os_sandbox_available',
      processLimit: { available: true, mechanism: 'fixture' } },
    executor(_launcher, command) {
      const outputTarget = command.indexOf('/output');
      fs.writeFileSync(path.join(command[outputTarget - 1], 'results.json'), 'x'.repeat(outputBytes));
      return { status: 0, stdout: '', stderr: '' };
    },
  });
  const receipt = runner.run({
    executable: process.execPath, args: ['run.mjs'], cwd: source, sourceRoot: source,
    outputDirectory: output, outputPaths: ['results.json'], requireSeparateOutputRoot: true,
    requestedMaximumOutputBytes, language: 'node', determinismPolicy: 'unknown',
  });
  return { receipt, output };
}

test('worker receipt binds a verified EnvironmentBOM and rejects a fully rehashed limits substitution', (t) => {
  const { receipt } = fixture(t, 4, 1024);
  assert.equal(receipt.ok, true, JSON.stringify(receipt.blockers));
  assert.equal(verifyOsSandboxWorkerReceipt(receipt), true);
  assert.equal(receipt.environmentBomHash, receipt.environmentBom.environmentBomHash);
  assert.equal(receipt.environmentBom.limits.maximumOutputBytes, 1024);
  assert.equal(receipt.environmentBom.limits.maximumCapturedBytes, 4 * 1024 * 1024);

  const forged = structuredClone(receipt);
  forged.environmentBom = buildEmpiricalEnvironmentBom({
    ...forged.environmentBom,
    limits: { ...forged.environmentBom.limits, memoryBytes: forged.environmentBom.limits.memoryBytes + 1 },
  });
  forged.environmentBomHash = forged.environmentBom.environmentBomHash;
  const { ok: _ok, receiptHash: _receiptHash, blockers: _blockers, ...payload } = forged;
  forged.receiptHash = hashRecord('OsSandboxWorkerReceipt', payload);
  assert.equal(verifyOsSandboxWorkerReceipt(forged), false);
});

test('declared artifact bytes are actually bounded by the receipted output limit', (t) => {
  const { receipt, output } = fixture(t, 32, 8);
  assert.equal(receipt.ok, false);
  assert.ok(receipt.blockers.some((blocker) => blocker.includes('worker_output_bytes_limit_exceeded')), JSON.stringify(receipt.blockers));
  assert.equal(fs.existsSync(path.join(output, 'results.json')), false);
});
