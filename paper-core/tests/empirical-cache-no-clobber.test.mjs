import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';

import {
  createFilesystemEmpiricalCacheRepository,
} from '../../paper-adapters/automation/empirical-cache-repository.mjs';
import {
  createMultiLanguageEmpiricalExecutor,
} from '../../paper-adapters/automation/multi-language-empirical-executor.mjs';
import {
  deterministicCacheSpec,
  fixtureContainerExecutionIdentity,
  withFixtureEnvironmentBom,
} from './empirical-environment-test-support.mjs';

test('empirical cache publishes one immutable winner under a multiprocess same-key race', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-empirical-cache-race-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  const output = path.join(root, 'seed-output');
  const cacheRoot = path.join(root, 'cache');
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'run.py'), 'print("fixture")\n');
  const image = 'fixture/cache:locked';
  const digest = `sha256:${'8'.repeat(64)}`;
  const workerRunner = withFixtureEnvironmentBom({
    availability: { available: true },
    resolveExecutionRuntimeIdentity() {
      return fixtureContainerExecutionIdentity({ image, digest });
    },
    run(spec) {
      fs.mkdirSync(spec.outputDirectory, { recursive: true });
      const content = '{"winner":"seed"}\n';
      fs.writeFileSync(path.join(spec.outputDirectory, 'results.json'), content);
      return {
        ok: true,
        receiptHash: 'sha256:runner',
        runtimeIdentityHash: spec.executionIdentity.runtimeIdentityHash,
        containerImage: image,
        containerImageDigest: digest,
        workSourceMerkleHash: spec.expectedSourceMerkleHash,
        workWorkspaceManifestHash: spec.expectedSourceWorkspaceManifestHash,
        artifacts: [{
          path: 'results.json',
          sha256: `sha256:${crypto.createHash('sha256').update(content).digest('hex')}`,
          bytes: Buffer.byteLength(content),
        }],
        isolation: { kernelNetworkIsolationVerified: true },
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
  executor.execute(deterministicCacheSpec({
    language: 'python',
    entrypoint: 'run.py',
    cwd: source,
    sourceRoot: source,
    outputDirectory: output,
    outputPaths: ['results.json'],
  }));
  const entryName = fs.readdirSync(cacheRoot)[0];
  const entry = path.join(cacheRoot, entryName);
  const manifest = JSON.parse(fs.readFileSync(path.join(entry, 'manifest.json'), 'utf8'));
  fs.rmSync(entry, { recursive: true, force: true });
  const contenders = ['alpha', 'beta'].map((winner) => {
    const contenderOutput = path.join(root, `output-${winner}`);
    fs.mkdirSync(contenderOutput);
    const content = `${JSON.stringify({ winner })}\n`;
    fs.writeFileSync(path.join(contenderOutput, 'results.json'), content);
    return {
      outputDirectory: contenderOutput,
      artifacts: [{
        path: 'results.json',
        sha256: `sha256:${crypto.createHash('sha256').update(content).digest('hex')}`,
      }],
    };
  });
  const payloadPath = path.join(root, 'race.json');
  fs.writeFileSync(payloadPath, JSON.stringify({ cacheRoot, manifest, contenders }));
  const childSource = `
    import fs from 'node:fs';
    import { createFilesystemEmpiricalCacheRepository } from ${JSON.stringify(
    new URL('../../paper-adapters/automation/empirical-cache-repository.mjs', import.meta.url).href
  )};
    const input = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
    const contender = input.contenders[Number(process.argv[2])];
    const cache = createFilesystemEmpiricalCacheRepository({ root: input.cacheRoot });
    const result = cache.put(input.manifest.cacheKey, {
      ...contender,
      runnerReceiptHash: input.manifest.runnerReceiptHash,
      environmentBom: input.manifest.environmentBom,
      cacheReproducibilityDecision: input.manifest.cacheReproducibilityDecision,
      baseCacheDescriptor: input.manifest.baseCacheDescriptor,
    });
    process.stdout.write(JSON.stringify(result));
  `;
  const run = (index) => new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--input-type=module', '-e', childSource, payloadPath, String(index)],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => code === 0
      ? resolve(JSON.parse(stdout))
      : reject(new Error(stderr || `cache contender exited ${code}`)));
  });
  const results = await Promise.all([run(0), run(1)]);
  assert.equal(results.every((result) => result.stored), true);
  assert.equal(results.filter((result) => result.reusedExisting).length, 1);
  const published = JSON.parse(fs.readFileSync(path.join(
    cacheRoot,
    entryName,
    'artifacts',
    'results.json',
  ), 'utf8'));
  assert.ok(['alpha', 'beta'].includes(published.winner));
});
