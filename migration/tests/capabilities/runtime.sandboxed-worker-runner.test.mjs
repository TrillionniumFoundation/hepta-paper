import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createOsSandboxedWorkerRunner,
  probeOsSandbox,
} from '../../../paper-adapters/runtime/os-sandboxed-worker-runner.mjs';

test('runtime.sandboxed-worker-runner requires kernel namespaces and resource limits', () => {
  const runner = createOsSandboxedWorkerRunner({ allowedExecutables: ['/usr/bin/true'], allowedRoots: ['/tmp'], probe: { available: true, status: 'os_sandbox_available' }, executor: () => ({ status: 0, stdout: '', stderr: '' }) });
  const receipt = runner.run({ executable: '/usr/bin/true', cwd: '/tmp', outputPaths: [] });
  assert.equal(receipt.status, 'os_sandbox_worker_passed');
  assert.equal(receipt.isolation.kernelNetworkIsolationVerified, true);
  assert.equal(runner.run({ executable: '/bin/bash', cwd: '/tmp' }).status, 'os_sandbox_worker_blocked');
});

test('runtime.sandboxed-worker-runner executes through a real kernel sandbox when locally available', () => {
  const probe = probeOsSandbox({ refresh: true });
  const runner = createOsSandboxedWorkerRunner({
    allowedExecutables: ['/usr/bin/true'],
    allowedRoots: ['/tmp'],
    probe,
  });
  const receipt = runner.run({ executable: '/usr/bin/true', cwd: '/tmp', outputPaths: [] });
  if (!probe.available) {
    assert.equal(receipt.status, 'os_sandbox_worker_blocked');
    assert.ok(receipt.blockers.includes('os_sandbox_runtime_unavailable'));
    return;
  }
  assert.equal(receipt.status, 'os_sandbox_worker_passed');
  assert.equal(receipt.isolation.kernelNetworkIsolationVerified, true);
  assert.equal(receipt.isolation.filesystemNamespaceVerified, true);
  assert.equal(receipt.isolation.resourceLimitsVerified, true);
});
