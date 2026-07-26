import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createOutOfProcessAdvancedNumericalPluginRunner,
  verifyAdvancedNumericalPluginSignedBundle,
} from '../../paper-adapters/automation/out-of-process-advanced-numerical-plugin-runner.mjs';
import {
  ADVANCED_NUMERICAL_PLUGIN_ANALYSIS_FAMILIES,
  compileAdvancedNumericalPluginDescriptor,
} from '../../paper-domain/research/advanced-numerical-plugin-contract.mjs';
import { buildExecutorCapabilities } from '../../paper-ports/executor-capabilities.mjs';
import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  immutableAuthoritySigningPayload,
} from '../../workflow-kernel/runtime/immutable-signed-json-bundle.mjs';

function signedPluginFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-advanced-numeric-'));
  const pluginRoot = path.join(root, 'plugin');
  const outputRoot = path.join(root, 'output');
  fs.mkdirSync(pluginRoot);
  fs.mkdirSync(outputRoot);
  const entrypoint = Buffer.from('print(\"fixture\")\n', 'utf8');
  fs.writeFileSync(path.join(pluginRoot, 'plugin.py'), entrypoint);
  const descriptor = compileAdvancedNumericalPluginDescriptor({
    pluginId: 'organization.causal-estimator',
    pluginVersion: '1.2.0',
    analysisFamily: 'causal-inference',
    runtime: {
      language: 'python',
      executable: 'python3',
      executableHash: `sha256:${'1'.repeat(64)}`,
      packageClosureHash: `sha256:${'2'.repeat(64)}`,
    },
    entrypoint: {
      relativePath: 'plugin.py',
      sha256: hashBytes(entrypoint),
    },
    sourceIdentity: {
      merkleHash: `sha256:${'3'.repeat(64)}`,
      workspaceManifestHash: `sha256:${'4'.repeat(64)}`,
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
      oracle: {
        kind: 'independent-numeric-oracle-v1',
        contractHash: `sha256:${'5'.repeat(64)}`,
      },
      replay: {
        kind: 'deterministic-process-replay-v1',
        contractHash: `sha256:${'6'.repeat(64)}`,
      },
      uncertainty: {
        kind: 'typed-uncertainty-report-v1',
        contractHash: `sha256:${'7'.repeat(64)}`,
      },
    },
  });
  const keys = crypto.generateKeyPairSync('ed25519');
  const now = new Date('2026-07-26T01:00:00.000Z');
  const unsignedAuthority = {
    version: 1,
    kind: 'AdvancedNumericalPluginAuthority',
    pluginId: descriptor.pluginId,
    pluginVersion: descriptor.pluginVersion,
    descriptorHash: descriptor.advancedNumericalPluginDescriptorHash,
    signedAt: new Date(now.getTime() - 60_000).toISOString(),
    expiresAt: new Date(now.getTime() + 60_000).toISOString(),
  };
  const authority = {
    ...unsignedAuthority,
    signatures: [{
      keyId: 'advanced-numerical-plugin-key',
      role: 'advanced_numerical_plugin_authority',
      algorithm: 'ed25519',
      value: crypto.sign(
        null,
        immutableAuthoritySigningPayload(unsignedAuthority),
        keys.privateKey,
      ).toString('base64'),
    }],
  };
  return {
    root,
    pluginRoot,
    outputRoot,
    descriptor,
    now,
    bundle: {
      version: 1,
      kind: 'AdvancedNumericalPluginSignedBundle',
      descriptor,
      authority,
    },
    trustStore: {
      version: 1,
      kind: 'AuthorityTrustStore',
      keys: [{
        keyId: 'advanced-numerical-plugin-key',
        subjectId: 'advanced-numerical-plugin-authority',
        algorithm: 'ed25519',
        publicKeyPem: keys.publicKey.export({ type: 'spki', format: 'pem' }),
        roles: ['advanced_numerical_plugin_authority'],
        status: 'active',
      }],
    },
  };
}

function sandboxRunner(descriptor, { invalidResult = false, networkPolicy = 'none' } = {}) {
  const capabilities = buildExecutorCapabilities({
    executorId: 'fixture-kernel-worker',
    sandboxModes: ['kernel-isolated'],
    networkPolicy,
    workspaceIsolation: true,
    languages: ['python'],
    receiptKinds: ['OsSandboxWorkerReceipt'],
  });
  return {
    version: 4,
    runnerId: 'fixture-kernel-worker',
    capabilities: () => capabilities,
    resolveExecutionRuntimeIdentity() {
      return {
        available: true,
        allowlisted: true,
        executableHash: descriptor.runtime.executableHash,
      };
    },
    async run(spec) {
      assert.equal(spec.expectedSourceMerkleHash, descriptor.sourceIdentity.merkleHash);
      assert.equal(spec.expectedSourceWorkspaceManifestHash,
        descriptor.sourceIdentity.workspaceManifestHash);
      assert.equal(spec.requireImmutableWorkRoot, true);
      assert.equal(spec.requireSeparateOutputRoot, true);
      const request = JSON.parse(Buffer.from(spec.args[2], 'base64').toString('utf8'));
      const resultPayload = {
        version: 1,
        kind: 'AdvancedNumericalPluginResult',
        status: 'advanced_numerical_computation_completed',
        pluginId: descriptor.pluginId,
        analysisFamily: descriptor.analysisFamily,
        requestHash: request.advancedNumericalPluginRequestHash,
        oracleContractHash: descriptor.assuranceContracts.oracle.contractHash,
        replayContractHash: descriptor.assuranceContracts.replay.contractHash,
        uncertaintyContractHash: descriptor.assuranceContracts.uncertainty.contractHash,
        estimateArtifactHash: `sha256:${'8'.repeat(64)}`,
        uncertaintyArtifactHash: `sha256:${'9'.repeat(64)}`,
        oracleReceiptHash: `sha256:${'a'.repeat(64)}`,
        replayReceiptHash: `sha256:${'b'.repeat(64)}`,
        uncertaintyReceiptHash: `sha256:${'c'.repeat(64)}`,
      };
      const result = {
        ...resultPayload,
        advancedNumericalPluginResultHash:
          hashRecord('AdvancedNumericalPluginResult', resultPayload),
      };
      if (invalidResult) result.requestHash = `sha256:${'d'.repeat(64)}`;
      fs.writeFileSync(
        path.join(spec.outputDirectory, 'result.json'),
        `${JSON.stringify(result)}\n`,
      );
      const receiptPayload = {
        status: 'os_sandbox_worker_passed',
        isolation: {
          kernelNetworkIsolationVerified: true,
          sourceReadOnlyVerified: true,
          resourceLimitsVerified: true,
        },
      };
      return {
        ok: true,
        ...receiptPayload,
        receiptHash: hashRecord('OsSandboxWorkerReceipt', receiptPayload),
        blockers: [],
      };
    },
  };
}

test('signed advanced numerical plugins run out of process but remain unqualified', async (context) => {
  const fixture = signedPluginFixture();
  context.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const runner = createOutOfProcessAdvancedNumericalPluginRunner({
    signedBundle: fixture.bundle,
    trustStore: fixture.trustStore,
    workerRunner: sandboxRunner(fixture.descriptor),
    pluginRoot: fixture.pluginRoot,
    outputRoot: fixture.outputRoot,
    now: fixture.now,
  });
  assert.deepEqual(runner.capabilities().analysisFamilies,
    ADVANCED_NUMERICAL_PLUGIN_ANALYSIS_FAMILIES);
  assert.equal(runner.capabilities().productionQualified, false);
  const receipt = await runner.run({
    runId: 'causal-run-1',
    input: { outcome: [1, 2, 3], treatment: [0, 1, 1] },
    seed: 17,
    outputDirectory: path.join(fixture.outputRoot, 'run-1'),
  });
  assert.equal(receipt.status,
    'advanced_numerical_plugin_execution_completed_unqualified');
  assert.equal(receipt.productionQualified, false);
  assert.equal(receipt.blockers.length, 0);
  assert.match(receipt.advancedNumericalPluginExecutionReceiptHash,
    /^sha256:[0-9a-f]{64}$/);
});

test('signature, sandbox capability, runtime and output attacks fail closed', async (context) => {
  const fixture = signedPluginFixture();
  context.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const tampered = structuredClone(fixture.bundle);
  tampered.descriptor.analysisFamily = 'bayesian';
  assert.throws(() => verifyAdvancedNumericalPluginSignedBundle(tampered, {
    trustStore: fixture.trustStore,
    now: fixture.now,
  }), /signed_bundle_invalid/);
  assert.throws(() => createOutOfProcessAdvancedNumericalPluginRunner({
    signedBundle: fixture.bundle,
    trustStore: fixture.trustStore,
    workerRunner: sandboxRunner(fixture.descriptor, {
      networkPolicy: 'provider-controlled',
    }),
    pluginRoot: fixture.pluginRoot,
    outputRoot: fixture.outputRoot,
    now: fixture.now,
  }), /worker_capability_invalid/);

  const invalidResultRunner = createOutOfProcessAdvancedNumericalPluginRunner({
    signedBundle: fixture.bundle,
    trustStore: fixture.trustStore,
    workerRunner: sandboxRunner(fixture.descriptor, { invalidResult: true }),
    pluginRoot: fixture.pluginRoot,
    outputRoot: fixture.outputRoot,
    now: fixture.now,
  });
  const blocked = await invalidResultRunner.run({
    runId: 'causal-run-invalid',
    input: { outcome: [1], treatment: [0] },
    seed: 3,
    outputDirectory: path.join(fixture.outputRoot, 'invalid-result'),
  });
  assert.equal(blocked.status, 'advanced_numerical_plugin_execution_blocked');
  assert.deepEqual(blocked.blockers, ['advanced_numerical_plugin_result_invalid']);
});
