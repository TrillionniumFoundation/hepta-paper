import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createOsSandboxedWorkerRunner,
  probeOsSandbox,
} from '../../../paper-adapters/runtime/os-sandboxed-worker-runner.mjs';

test('runtime.sandboxed-worker-runner requires kernel namespaces and resource limits', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-sandbox-test-'));
  fs.writeFileSync(path.join(root, 'source.txt'), 'immutable\n');
  let command = [];
  const runner = createOsSandboxedWorkerRunner({ allowedExecutables: ['/usr/bin/true'], allowedRoots: [root], probe: { available: true, status: 'os_sandbox_available', backend: 'docker' }, executor: (_launcher, args) => { command = args; return { status: 0, stdout: '', stderr: '' }; } });
  const receipt = runner.run({ executable: '/usr/bin/true', cwd: root, sourceRoot: root, outputPaths: [] });
  assert.equal(receipt.status, 'os_sandbox_worker_passed');
  assert.equal(receipt.isolation.kernelNetworkIsolationVerified, true);
  assert.equal(receipt.isolation.sourceReadOnlyMount, true);
  assert.equal(receipt.sourceMerkleHashBefore, receipt.sourceMerkleHashAfter);
  assert.equal(command.some((item) => String(item).includes('/etc:/etc')), false);
  assert.equal(runner.run({ executable: '/bin/bash', cwd: root }).status, 'os_sandbox_worker_blocked');
  fs.rmSync(root, { recursive: true, force: true });
});

test('runtime.sandboxed-worker-runner executes through a real kernel sandbox when locally available', () => {
  const probe = probeOsSandbox({ refresh: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-sandbox-real-'));
  fs.writeFileSync(path.join(root, 'source.txt'), 'immutable\n');
  const runner = createOsSandboxedWorkerRunner({
    allowedExecutables: ['/usr/bin/true'],
    allowedRoots: [root],
    probe,
  });
  const receipt = runner.run({ executable: '/usr/bin/true', cwd: root, sourceRoot: root, outputPaths: [] });
  if (receipt.status === 'os_sandbox_worker_blocked') {
    assert.ok(receipt.blockers.includes('os_sandbox_runtime_unavailable'));
    fs.rmSync(root, { recursive: true, force: true });
    return;
  }
  assert.equal(receipt.status, 'os_sandbox_worker_passed');
  assert.equal(receipt.isolation.kernelNetworkIsolationVerified, true);
  assert.equal(receipt.isolation.filesystemNamespaceVerified, true);
  assert.equal(receipt.isolation.resourceLimitsVerified, true);
  assert.equal(receipt.isolation.sourceReadOnlyVerified, true);
  fs.rmSync(root, { recursive: true, force: true });
});
