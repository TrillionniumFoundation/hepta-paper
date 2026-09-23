import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createMultiLanguageEmpiricalExecutor } from '../../paper-adapters/automation/multi-language-empirical-executor.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { createWorkerEnvironmentBomPreparer } from '../../paper-adapters/runtime/worker-environment-bom-binding.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-cache-policy-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'run.py'), 'print(1)\n');
  const image = 'fixture/scientific:locked';
  const digest = `sha256:${'7'.repeat(64)}`;
  const identityPayload = {
    version: 1, kind: 'WorkerExecutionRuntimeIdentity', runtimeType: 'container', runnerId: 'fixture-runner',
    backend: 'docker', requestedImage: image, digest, containerExecutable: 'python3', available: true,
    allowlisted: true, cacheable: true,
  };
  const identity = Object.freeze({ ...identityPayload, runtimeIdentityHash: hashRecord('WorkerExecutionRuntimeIdentity', identityPayload) });
  const prepareEnvironmentBom = createWorkerEnvironmentBomPreparer({
    maximumTimeoutMs: 120_000, maximumMemoryBytes: 1024 * 1024 * 1024, maximumCpuSeconds: 120,
    maximumPids: 128, maximumOutputBytes: 256 * 1024 * 1024, maximumCapturedBytes: 4 * 1024 * 1024,
  });
  let cacheGets = 0; let cachePuts = 0; let runs = 0;
  const executor = createMultiLanguageEmpiricalExecutor({
    workerRunner: {
      availability: { available: true },
      resolveExecutionRuntimeIdentity() { return identity; },
      prepareEnvironmentBom,
      run(spec) {
        runs += 1;
        const bom = prepareEnvironmentBom({ ...spec, executionIdentity: identity, executable: 'python3' });
        return {
          ok: true, status: 'os_sandbox_worker_passed', receiptHash: `sha256:${String(runs).repeat(64)}`,
          runtimeIdentityHash: identity.runtimeIdentityHash, containerImage: image, containerImageDigest: digest,
          workSourceMerkleHash: null, workWorkspaceManifestHash: null, datasetMounts: [], artifacts: [],
          isolation: { kernelNetworkIsolationVerified: true }, exitCode: 0, blockers: [],
          environmentBom: bom.environmentBom, environmentBomHash: bom.environmentBomHash,
        };
      },
    },
    runtimeImages: { python: { image, executable: 'python3' } },
    cache: { get() { cacheGets += 1; return null; }, put() { cachePuts += 1; } },
  });
  const spec = { language: 'python', entrypoint: 'run.py', cwd: root, sourceRoot: root, outputDirectory: path.join(root, 'output') };
  return { executor, spec, counts: () => ({ cacheGets, cachePuts, runs }) };
}

test('explicit nondeterministic empirical executions never read or write cache', (t) => {
  const f = fixture(t);
  const first = f.executor.execute({ ...f.spec, nonDeterministic: true });
  const second = f.executor.execute({ ...f.spec, deterministic: false });
  assert.equal(first.status, 'empirical_execution_completed');
  assert.equal(second.status, 'empirical_execution_completed');
  assert.equal(first.cacheBypassReason, 'nondeterministic_execution');
  assert.deepEqual(f.counts(), { cacheGets: 0, cachePuts: 0, runs: 2 });
});

test('GPU execution cannot reuse an empirical cache entry', (t) => {
  const f = fixture(t);
  const receipt = f.executor.execute({ ...f.spec, requiresGpu: true });
  assert.equal(f.counts().cacheGets, 0);
  assert.equal(f.counts().cachePuts, 0);
  if (receipt.status === 'empirical_execution_completed') assert.equal(receipt.cacheBypassReason, 'gpu_execution_nondeterministic');
  else assert.equal(receipt.status, 'empirical_gpu_unavailable');
});
