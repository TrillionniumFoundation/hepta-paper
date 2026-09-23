import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildAdvancedNumericalPluginRequest,
  compileAdvancedNumericalPluginDescriptor,
  verifyAdvancedNumericalPluginResult,
} from '../../paper-domain/research/advanced-numerical-plugin-contract.mjs';
import { hashBytes } from '../../workflow-kernel/record-hash.mjs';

const workspaceRoot = path.resolve(import.meta.dirname, '..', '..');
const pluginRoot = path.join(workspaceRoot, 'numerical-plugins', 'reference-candidates');
const entrypointPath = path.join(pluginRoot, 'worker.py');
const entrypoint = fs.readFileSync(entrypointPath);
const H = (character) => `sha256:${character.repeat(64)}`;

function descriptor(analysisFamily) {
  return compileAdvancedNumericalPluginDescriptor({
    pluginId: `hepta.reference.${analysisFamily}`,
    pluginVersion: '1.0.0',
    analysisFamily,
    runtime: {
      language: 'python',
      executable: 'python3',
      executableHash: H('1'),
      packageClosureHash: H('2'),
    },
    entrypoint: {
      relativePath: 'worker.py',
      sha256: hashBytes(entrypoint),
    },
    sourceIdentity: {
      merkleHash: H('3'),
      workspaceManifestHash: H('4'),
    },
    limits: {
      timeoutMs: 30_000,
      cpuSeconds: 10,
      memoryBytes: 256 * 1024 * 1024,
      maximumProcesses: 8,
      maximumOutputBytes: 1024 * 1024,
      maximumCapturedBytes: 128 * 1024,
    },
    networkPolicy: 'none',
    assuranceContracts: {
      oracle: { kind: 'independent-numeric-oracle-v1', contractHash: H('5') },
      replay: { kind: 'deterministic-process-replay-v1', contractHash: H('6') },
      uncertainty: { kind: 'typed-uncertainty-report-v1', contractHash: H('7') },
    },
  });
}

function runCandidate(analysisFamily, input, seed = 17) {
  const selectedDescriptor = descriptor(analysisFamily);
  const request = buildAdvancedNumericalPluginRequest({
    descriptor: selectedDescriptor,
    runId: `${analysisFamily}-reference-run`,
    input,
    seed,
  });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-reference-numeric-'));
  const outputPath = path.join(root, 'result.json');
  try {
    execFileSync('python3', [
      entrypointPath,
      '--hepta-request-base64',
      Buffer.from(JSON.stringify(request), 'utf8').toString('base64'),
      '--hepta-output',
      outputPath,
    ]);
    const result = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
    assert.equal(verifyAdvancedNumericalPluginResult(result, {
      descriptor: selectedDescriptor,
      request,
    }), true);
    assert.equal(result.qualificationStatus, 'reference_candidate_unqualified');
    assert.equal(result.oracle.accepted, true);
    return result;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('linear algebra reference candidate solves and certifies a residual bound', () => {
  const result = runCandidate('linear-algebra', {
    matrix: [[4, 1], [2, 3]],
    vector: [1, 2],
    residualTolerance: 1e-10,
  });
  assert.ok(result.uncertainty.residualInfinityNorm <= 1e-10);
});

test('Monte Carlo reference candidate is seeded, finite, and deterministic', () => {
  const input = { integrand: 'unit-circle', sampleCount: 5000 };
  const first = runCandidate('monte-carlo', input, 41);
  const second = runCandidate('monte-carlo', input, 41);
  assert.equal(first.estimateArtifactHash, second.estimateArtifactHash);
  assert.ok(first.estimate.value > 2.5 && first.estimate.value < 3.8);
});

test('optimization reference candidate satisfies a first-order residual oracle', () => {
  const result = runCandidate('optimization', {
    quadratic: [[2, 0], [0, 4]],
    linear: [-2, -8],
    iterations: 2000,
    stepSize: 0.05,
    gradientTolerance: 1e-7,
  });
  assert.ok(result.uncertainty.gradientNorm <= 1e-7);
});
