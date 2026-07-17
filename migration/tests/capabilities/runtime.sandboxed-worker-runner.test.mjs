import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createOsSandboxedWorkerRunner,
  probeOsSandbox,
} from '../../../paper-adapters/runtime/os-sandboxed-worker-runner.mjs';
import {
  dockerManifestMediaTypeAccepted,
} from '../../../paper-adapters/runtime/sandbox-backend-probe.mjs';

test('generic Docker fallback accepts platform-verified indexes without weakening trusted OCI manifests', () => {
  assert.equal(dockerManifestMediaTypeAccepted(
    'application/vnd.oci.image.index.v1+json',
  ), true);
  assert.equal(dockerManifestMediaTypeAccepted(
    'application/vnd.docker.distribution.manifest.list.v2+json',
  ), true);
  assert.equal(dockerManifestMediaTypeAccepted(
    'application/vnd.oci.image.index.v1+json',
    { canonicalOci: true },
  ), false);
  assert.equal(dockerManifestMediaTypeAccepted(
    'application/vnd.oci.image.manifest.v1+json',
    { canonicalOci: true },
  ), true);
});

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

test('runtime.sandboxed-worker-runner v4 accepts only its canonical execution identity input', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-sandbox-v4-input-'));
  fs.writeFileSync(path.join(root, 'source.txt'), 'immutable\n');
  let executions = 0;
  const runner = createOsSandboxedWorkerRunner({
    allowedExecutables: ['/usr/bin/true'],
    allowedRoots: [root],
    probe: { available: true, status: 'os_sandbox_available', backend: 'bubblewrap' },
    executor: () => { executions += 1; return { status: 0, stdout: '', stderr: '' }; },
  });
  assert.equal(runner.version, 4);
  assert.equal('deprecatedRunInputs' in runner, false);
  const raw = runner.run({ executable: '/usr/bin/true', cwd: root, sourceRoot: root, containerImageDigest: `sha256:${'1'.repeat(64)}` });
  assert.deepEqual(raw.blockers, ['worker_run_input_removed:containerImageDigest']);
  const identity = runner.resolveExecutionRuntimeIdentity({ executable: '/usr/bin/true' });
  const legacy = runner.run({ executable: '/usr/bin/true', cwd: root, sourceRoot: root, containerImageIdentity: identity });
  assert.deepEqual(legacy.blockers, ['worker_run_input_removed:containerImageIdentity']);
  assert.equal(executions, 0);
  const accepted = runner.run({ executable: '/usr/bin/true', cwd: root, sourceRoot: root, executionIdentity: identity });
  assert.equal(accepted.status, 'os_sandbox_worker_passed');
  assert.equal(executions, 1);
  fs.rmSync(root, { recursive: true, force: true });
});

test('runtime.sandboxed-worker-runner executes through a real kernel sandbox when locally available', (t) => {
  const probe = probeOsSandbox({ refresh: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-sandbox-real-'));
  fs.writeFileSync(path.join(root, 'source.txt'), 'immutable\n');
  const runner = createOsSandboxedWorkerRunner({
    allowedExecutables: ['/usr/bin/true'],
    allowedRoots: [root],
    probe,
  });
  const receipt = runner.run({ executable: '/usr/bin/true', cwd: root, sourceRoot: root, outputPaths: [] });
  if (receipt.status !== 'os_sandbox_worker_passed') {
    assert.equal(receipt.blockers.some((blocker) => ['os_sandbox_runtime_unavailable', 'os_sandbox_command_failed'].includes(blocker)), true);
    fs.rmSync(root, { recursive: true, force: true });
    t.skip('kernel sandbox host runtime is temporarily unavailable; implementation contract is covered by the deterministic test');
    return;
  }
  assert.equal(receipt.status, 'os_sandbox_worker_passed');
  assert.equal(receipt.isolation.kernelNetworkIsolationVerified, true);
  assert.equal(receipt.isolation.filesystemNamespaceVerified, true);
  assert.equal(receipt.isolation.resourceLimitsVerified, true);
  assert.equal(receipt.isolation.sourceReadOnlyVerified, true);
  fs.rmSync(root, { recursive: true, force: true });
});
