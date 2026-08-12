import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createOsSandboxedWorkerRunner,
} from '../../paper-adapters/runtime/os-sandboxed-worker-runner.mjs';
import { fileSha256Hash } from '../../paper-adapters/runtime/execution-snapshot.mjs';

test('sandbox excludes an in-workspace dataset from the execution snapshot and mounts only its sealed copy', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-in-workspace-dataset-exclusion-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  const dataset = path.join(source, 'private.csv');
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'run.py'), 'print(1)\n');
  fs.writeFileSync(dataset, 'subject,value\n1,2\n');
  const declaredManifestHash = fileSha256Hash(dataset);
  let executions = 0;
  let inspectedExecutionSnapshot = false;
  const runner = createOsSandboxedWorkerRunner({
    allowedExecutables: ['python3'],
    allowedRoots: [source],
    allowedDatasetRoots: [source],
    probe: { available: true, backend: 'bubblewrap', status: 'os_sandbox_available' },
    executor(_launcher, args, options) {
      executions += 1;
      assert.equal(options.input.toString('utf8'), 'sealed-request\n');
      const workTargetIndex = args.indexOf('/work');
      const datasetTargetIndex = args.indexOf('/datasets/private');
      assert.ok(workTargetIndex > 0);
      assert.ok(datasetTargetIndex > 0);
      const workSnapshotRoot = args[workTargetIndex - 1];
      const datasetSnapshot = args[datasetTargetIndex - 1];
      assert.equal(fs.existsSync(path.join(workSnapshotRoot, 'run.py')), true);
      assert.equal(fs.existsSync(path.join(workSnapshotRoot, 'private.csv')), false);
      assert.notEqual(datasetSnapshot, dataset);
      assert.equal(fs.readFileSync(datasetSnapshot, 'utf8'), 'subject,value\n1,2\n');
      inspectedExecutionSnapshot = true;
      return { status: 0, stdout: '', stderr: '' };
    },
  });
  const receipt = runner.run({
    executable: 'python3',
    args: ['run.py'],
    cwd: source,
    sourceRoot: source,
    datasetMounts: [{
      name: 'private',
      source: dataset,
      readOnly: true,
      manifestHash: declaredManifestHash,
      licenseId: 'MIT',
    }],
    standardInput: 'sealed-request\n',
  });
  assert.equal(receipt.ok, true, JSON.stringify(receipt.blockers));
  assert.equal(executions, 1);
  assert.equal(inspectedExecutionSnapshot, true);
  assert.equal(receipt.datasetMounts[0].target, '/datasets/private');
  assert.equal(receipt.datasetMounts[0].manifestHash, declaredManifestHash);
  assert.equal(receipt.datasetMounts[0].snapshotManifestHash, declaredManifestHash);
});

test('sandbox rejects invalid and oversized standard input before execution', (t) => {
  const source = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-sandbox-stdin-'));
  t.after(() => fs.rmSync(source, { recursive: true, force: true }));
  fs.writeFileSync(path.join(source, 'run.mjs'), 'void 0;\n');
  let executions = 0;
  const runner = createOsSandboxedWorkerRunner({
    allowedExecutables: [process.execPath],
    allowedRoots: [source],
    maximumInputBytes: 4,
    probe: {
      available: true,
      backend: 'bubblewrap',
      status: 'os_sandbox_available',
      processLimit: { available: true, mechanism: 'fixture' },
    },
    executor() {
      executions += 1;
      return { status: 0, stdout: '', stderr: '' };
    },
  });
  const base = {
    executable: process.execPath,
    args: ['run.mjs'],
    cwd: source,
    sourceRoot: source,
  };
  const invalid = runner.run({ ...base, standardInput: { request: true } });
  assert.ok(invalid.blockers.includes('worker_standard_input_type_invalid'));
  const oversized = runner.run({ ...base, standardInput: '12345' });
  assert.ok(oversized.blockers.includes('worker_standard_input_limit_exceeded'));
  assert.equal(executions, 0);
});
