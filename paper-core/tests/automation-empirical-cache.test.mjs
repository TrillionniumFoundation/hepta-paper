import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createMultiLanguageEmpiricalExecutor } from '../../paper-adapters/automation/multi-language-empirical-executor.mjs';
import { createFilesystemEmpiricalCacheRepository } from '../../paper-adapters/automation/empirical-cache-repository.mjs';
import { createOsSandboxedWorkerRunner } from '../../paper-adapters/runtime/os-sandboxed-worker-runner.mjs';
import { fileSha256Hash } from '../../paper-adapters/runtime/execution-snapshot.mjs';
import { evaluateEmpiricalCacheReproducibility } from '../../paper-domain/automation/empirical-cache-reproducibility-policy.mjs';
import {
  deterministicCacheSpec,
  fixtureContainerExecutionIdentity,
  fixtureEnvironmentBomPreparer,
  withFixtureEnvironmentBom,
} from './empirical-environment-test-support.mjs';

test('empirical cache is source-bound and verifies artifact hashes before replay', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-empirical-cache-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  const output = path.join(root, 'output');
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'run.py'), 'print("fixture")\n');
  const image = 'fixture/cache:locked';
  const digest = `sha256:${'9'.repeat(64)}`;
  let runs = 0;
  const workerRunner = withFixtureEnvironmentBom({
    availability: { available: true },
    resolveExecutionRuntimeIdentity() { return fixtureContainerExecutionIdentity({ image, digest }); },
    run(spec) {
      runs += 1;
      fs.mkdirSync(spec.outputDirectory, { recursive: true });
      const content = '{"metric":1}\n';
      fs.writeFileSync(path.join(spec.outputDirectory, 'results.json'), content);
      return { ok: true, receiptHash: 'sha256:runner', runtimeIdentityHash: spec.executionIdentity.runtimeIdentityHash, containerImage: image, containerImageDigest: digest, workSourceMerkleHash: spec.expectedSourceMerkleHash, workWorkspaceManifestHash: spec.expectedSourceWorkspaceManifestHash, artifacts: [{ path: 'results.json', sha256: `sha256:${crypto.createHash('sha256').update(content).digest('hex')}`, bytes: Buffer.byteLength(content) }], isolation: { kernelNetworkIsolationVerified: true }, datasetMounts: [], exitCode: 0 };
    },
  });
  const executor = createMultiLanguageEmpiricalExecutor({ workerRunner, runtimeImages: { python: { image, executable: 'python3' } }, cache: createFilesystemEmpiricalCacheRepository({ root: path.join(root, 'cache') }) });
  const spec = deterministicCacheSpec({ language: 'python', entrypoint: 'run.py', cwd: source, sourceRoot: source, outputDirectory: output, outputPaths: ['results.json'] });
  assert.equal(executor.execute(spec).cacheHit, false);
  fs.rmSync(output, { recursive: true, force: true });
  const replay = executor.execute(spec);
  assert.equal(replay.cacheHit, true);
  assert.equal(runs, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(output, 'results.json'), 'utf8')).metric, 1);
  const cacheArtifact = fs.readdirSync(path.join(root, 'cache')).map((entry) => path.join(root, 'cache', entry, 'artifacts', 'results.json')).find((candidate) => fs.existsSync(candidate));
  fs.writeFileSync(cacheArtifact, '{"metric":999}\n');
  fs.rmSync(output, { recursive: true, force: true });
  assert.equal(executor.execute(spec).cacheHit, false);
  assert.equal(runs, 2);
});

test('empirical cache rejects traversal, symlink, and malformed cache identities before materialization', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-empirical-cache-scope-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cacheRoot = path.join(root, 'cache');
  const output = path.join(root, 'staging', 'output');
  const outside = path.join(root, 'payload.txt');
  const cacheKey = `sha256:${'a'.repeat(64)}`;
  const cacheDirectory = path.join(cacheRoot, 'a'.repeat(64));
  fs.mkdirSync(cacheDirectory, { recursive: true });
  fs.writeFileSync(path.join(cacheDirectory, 'payload.txt'), 'payload');
  fs.writeFileSync(path.join(cacheDirectory, 'manifest.json'), `${JSON.stringify({
    version: 2,
    cacheKey,
    artifacts: [{ path: '../../payload.txt', sha256: `sha256:${crypto.createHash('sha256').update('payload').digest('hex')}` }],
  })}\n`);
  const cache = createFilesystemEmpiricalCacheRepository({ root: cacheRoot });
  assert.equal(cache.get(cacheKey, { outputDirectory: output }), null);
  assert.equal(fs.existsSync(outside), false);
  assert.equal(cache.get('../escape', { outputDirectory: output }), null);

  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(root, 'source.json'), '{}\n');
  fs.symlinkSync(path.join(root, 'source.json'), path.join(output, 'results.json'));
  const put = cache.put(cacheKey, {
    outputDirectory: output,
    artifacts: [{ path: 'results.json', sha256: `sha256:${crypto.createHash('sha256').update('{}\n').digest('hex')}` }],
  });
  assert.equal(put.stored, false);
  assert.equal(put.reason, 'cache_environment_identity_invalid');
});

test('runtime image identity binds tag repoints to cache misses and stable digests to cache hits', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-image-cache-identity-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  const output = path.join(root, 'output');
  const cacheRoot = path.join(root, 'cache');
  const image = 'fixture/runtime:moving';
  const digestA = `sha256:${'a'.repeat(64)}`;
  const digestB = `sha256:${'b'.repeat(64)}`;
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'run.py'), 'print(1)\n');
  let resolutions = 0;
  let runs = 0;
  const workerRunner = withFixtureEnvironmentBom({
    availability: { available: true },
    resolveExecutionRuntimeIdentity() {
      resolutions += 1;
      return fixtureContainerExecutionIdentity({ image, digest: resolutions === 1 ? digestA : digestB });
    },
    run(spec) {
      runs += 1;
      fs.mkdirSync(spec.outputDirectory, { recursive: true });
      const content = JSON.stringify({ run: runs, digest: spec.executionIdentity.digest });
      fs.writeFileSync(path.join(spec.outputDirectory, 'results.json'), content);
      return {
        ok: true,
        receiptHash: `sha256:${String(runs).repeat(64)}`,
        artifacts: [{ path: 'results.json', sha256: `sha256:${crypto.createHash('sha256').update(content).digest('hex')}`, bytes: Buffer.byteLength(content) }],
        isolation: { immutableContainerImageVerified: true },
        runtimeIdentityHash: spec.executionIdentity.runtimeIdentityHash,
        containerImage: image,
        containerImageDigest: spec.executionIdentity.digest,
        workSourceMerkleHash: spec.expectedSourceMerkleHash,
        workWorkspaceManifestHash: spec.expectedSourceWorkspaceManifestHash,
        datasetMounts: [],
        exitCode: 0,
      };
    },
  });
  const executor = createMultiLanguageEmpiricalExecutor({
    workerRunner,
    runtimeImages: { python: { image, executable: 'python3' } },
    cache: createFilesystemEmpiricalCacheRepository({ root: cacheRoot }),
  });
  const spec = deterministicCacheSpec({ language: 'python', entrypoint: 'run.py', cwd: source, sourceRoot: source, outputDirectory: output, outputPaths: ['results.json'] });
  const first = executor.execute(spec);
  assert.equal(first.cacheHit, false);
  assert.equal(first.containerImageDigest, digestA);
  fs.rmSync(output, { recursive: true, force: true });
  const repointed = executor.execute(spec);
  assert.equal(repointed.cacheHit, false);
  assert.equal(repointed.containerImageDigest, digestB);
  assert.notEqual(repointed.executionCacheKey, first.executionCacheKey);
  fs.rmSync(output, { recursive: true, force: true });
  const replay = executor.execute(spec);
  assert.equal(replay.cacheHit, true);
  assert.equal(replay.containerImageDigest, digestB);
  assert.equal(replay.executionCacheKey, repointed.executionCacheKey);
  assert.equal(resolutions, 3);
  assert.equal(runs, 2);
});

test('configured runtime image identity failure blocks before empirical cache lookup', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-image-resolution-fail-closed-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'run.py'), 'print(1)\n');
  let cacheGets = 0;
  let runs = 0;
  const executor = createMultiLanguageEmpiricalExecutor({
    workerRunner: { availability: { available: true }, resolveExecutionRuntimeIdentity() { return null; }, run() { runs += 1; return { ok: true }; } },
    runtimeImages: { python: { image: 'fixture/missing:latest', executable: 'python3' } },
    cache: { get() { cacheGets += 1; return null; }, put() {} },
  });
  const receipt = executor.execute({ language: 'python', entrypoint: 'run.py', cwd: source, sourceRoot: source, outputDirectory: path.join(root, 'output'), outputPaths: ['results.json'] });
  assert.equal(receipt.status, 'empirical_runtime_image_identity_unavailable');
  assert.equal(cacheGets, 0);
  assert.equal(runs, 0);
});

test('empirical cache miss cannot store execution under a source hash changed after key construction', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-cache-runner-source-race-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  const entrypoint = path.join(source, 'run.py');
  const output = path.join(root, 'output');
  const image = 'fixture/runtime:cache-source-race';
  const digest = `sha256:${'2'.repeat(64)}`;
  fs.mkdirSync(source);
  fs.writeFileSync(entrypoint, 'print("A")\n');
  let executions = 0;
  let cachePuts = 0;
  const runner = createOsSandboxedWorkerRunner({
    allowedExecutables: ['python3'], allowedRoots: [source], allowedOutputRoots: [output], allowedContainerImages: [image],
    probe: { available: true, backend: 'docker', status: 'os_sandbox_available', image },
    imageDigestResolver(candidate) { return candidate === image ? digest : null; },
    executor() { executions += 1; return { status: 0, stdout: '', stderr: '' }; },
  });
  const executor = createMultiLanguageEmpiricalExecutor({
    workerRunner: runner,
    runtimeImages: { python: { image, executable: 'python3' } },
    cache: {
      get() { fs.writeFileSync(entrypoint, 'print("B")\n'); return null; },
      put() { cachePuts += 1; },
    },
  });
  const receipt = executor.execute(deterministicCacheSpec({ language: 'python', entrypoint: 'run.py', cwd: source, sourceRoot: source, outputDirectory: output, outputPaths: ['results.json'] }));
  assert.equal(receipt.status, 'empirical_execution_failed');
  assert.ok(receipt.blockers.includes('worker_expected_source_merkle_hash_mismatch'));
  assert.equal(executions, 0);
  assert.equal(cachePuts, 0);
});

test('empirical cache hit is rejected when cache lookup mutates the source snapshot', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-cache-hit-source-race-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  const entrypoint = path.join(source, 'run.py');
  const output = path.join(root, 'output');
  const image = 'fixture/runtime:cache-hit-source-race';
  const digest = `sha256:${'1'.repeat(64)}`;
  fs.mkdirSync(source);
  fs.writeFileSync(entrypoint, 'print("A")\n');
  let runs = 0;
  let currentEnvironmentBinding = null;
  const identity = fixtureContainerExecutionIdentity({ image, digest });
  const executor = createMultiLanguageEmpiricalExecutor({
    workerRunner: {
      availability: { available: true },
      resolveExecutionRuntimeIdentity() { return identity; },
      prepareEnvironmentBom(input) { currentEnvironmentBinding = fixtureEnvironmentBomPreparer(input); return currentEnvironmentBinding; },
      run() { runs += 1; return { ok: true }; },
    },
    runtimeImages: { python: { image, executable: 'python3' } },
    cache: {
      get(_cacheKey, { outputDirectory }) {
        fs.mkdirSync(outputDirectory, { recursive: true });
        fs.writeFileSync(path.join(outputDirectory, 'results.json'), '{"stale":true}\n');
        fs.writeFileSync(entrypoint, 'print("B")\n');
        return {
          runnerReceiptHash: 'sha256:cached',
          artifacts: [{ path: 'results.json', sha256: fileSha256Hash(path.join(outputDirectory, 'results.json')) }],
          environmentBom: currentEnvironmentBinding.environmentBom,
          cacheReproducibilityDecision: evaluateEmpiricalCacheReproducibility({ environmentBom: currentEnvironmentBinding.environmentBom }),
        };
      },
      put() {},
    },
  });
  const receipt = executor.execute(deterministicCacheSpec({ language: 'python', entrypoint: 'run.py', cwd: source, sourceRoot: source, outputDirectory: output, outputPaths: ['results.json'] }));
  assert.equal(receipt.status, 'empirical_source_changed_during_cache_lookup');
  assert.ok(receipt.blockers.includes('empirical_source_changed_during_cache_lookup'));
  assert.equal(receipt.cacheHit, false);
  assert.equal(runs, 0);
  assert.equal(fs.existsSync(output), false);
});

test('implicit Docker fallback is prepared before cache lookup and cannot share cache identity with host execution', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-fallback-runtime-identity-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  const dockerOutput = path.join(root, 'docker-output');
  const hostOutput = path.join(root, 'host-output');
  const image = 'fixture/fallback:locked';
  const digest = `sha256:${'6'.repeat(64)}`;
  fs.mkdirSync(source);
  fs.mkdirSync(dockerOutput);
  fs.mkdirSync(hostOutput);
  fs.writeFileSync(path.join(source, 'run.py'), 'print(1)\n');
  let resolutions = 0;
  let cacheGets = 0;
  let dockerRuns = 0;
  const cache = { get() { cacheGets += 1; return null; }, put() {} };
  const writeSandboxResult = (command, value) => {
    const outputIndex = command.indexOf('/output');
    const dockerMount = command.find((argument) => String(argument).endsWith(':/output:rw'));
    const outputRoot = outputIndex > 0 ? command[outputIndex - 1] : String(dockerMount).slice(0, -':/output:rw'.length);
    fs.writeFileSync(path.join(outputRoot, 'results.json'), JSON.stringify({ value }));
  };
  const dockerRunner = createOsSandboxedWorkerRunner({
    allowedExecutables: ['python3'], allowedRoots: [source], allowedOutputRoots: [dockerOutput], dockerImage: image,
    probe: { available: true, backend: 'docker', status: 'os_sandbox_available', image },
    imageDigestResolver(candidate) { resolutions += 1; return candidate === image ? digest : null; },
    executor(_launcher, command) { dockerRuns += 1; writeSandboxResult(command, 'docker'); return { status: 0, stdout: '', stderr: '' }; },
  });
  const dockerExecutor = createMultiLanguageEmpiricalExecutor({ workerRunner: dockerRunner, cache });
  const dockerReceipt = dockerExecutor.execute({ language: 'python', entrypoint: 'run.py', cwd: source, sourceRoot: source, outputDirectory: dockerOutput, outputPaths: ['results.json'] });
  assert.equal(dockerReceipt.status, 'empirical_execution_completed', JSON.stringify(dockerReceipt.blockers));
  assert.equal(dockerReceipt.runtimeIdentityType, 'container');
  assert.equal(dockerReceipt.containerImage, image);
  assert.equal(dockerReceipt.containerImageDigest, digest);
  assert.equal(dockerReceipt.runtimeIdentityCacheable, false);
  assert.equal(dockerReceipt.cacheBypassReason, 'runtime_identity_not_cacheable');
  assert.equal(cacheGets, 0);
  assert.equal(resolutions, 1);
  assert.equal(dockerRuns, 1);

  const hostRunner = createOsSandboxedWorkerRunner({
    allowedExecutables: ['python3'], allowedRoots: [source], allowedOutputRoots: [hostOutput],
    probe: { available: true, backend: 'bubblewrap', status: 'os_sandbox_available', processLimit: { available: true, mechanism: 'fixture' } },
    executor(_launcher, command) { writeSandboxResult(command, 'host'); return { status: 0, stdout: '', stderr: '' }; },
  });
  const hostReceipt = createMultiLanguageEmpiricalExecutor({ workerRunner: hostRunner, cache }).execute({ language: 'python', entrypoint: 'run.py', cwd: source, sourceRoot: source, outputDirectory: hostOutput, outputPaths: ['results.json'] });
  assert.equal(hostReceipt.status, 'empirical_execution_completed', JSON.stringify(hostReceipt.blockers));
  assert.equal(hostReceipt.runtimeIdentityType, 'host');
  assert.equal(hostReceipt.containerImage, null);
  assert.equal(hostReceipt.runtimeIdentityCacheable, false);
  assert.equal(hostReceipt.cacheBypassReason, 'runtime_identity_not_cacheable');
  assert.notEqual(hostReceipt.runtimeIdentityHash, dockerReceipt.runtimeIdentityHash);
  assert.equal(cacheGets, 0);
});
