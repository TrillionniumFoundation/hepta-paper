import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  createOutOfProcessAdvancedNumericalPluginRunner,
  inspectAdvancedNumericalPluginRunnerStatus,
  verifyAdvancedNumericalPluginSignedBundle,
} from '../../paper-adapters/automation/out-of-process-advanced-numerical-plugin-runner.mjs';
import {
  readAdvancedNumericalPluginRuntimeConfiguration,
} from '../../paper-adapters/automation/advanced-numerical-plugin-runtime-configuration.mjs';
import {
  inspectWorkspaceExecutionSnapshot,
} from '../../paper-adapters/runtime/os-sandboxed-worker-runner.mjs';
import {
  createOsSandboxedWorkerRunnerForTest as createOsSandboxedWorkerRunner,
} from './support/os-sandboxed-worker-runner-test-driver.mjs';
import {
  verifyProductionOsSandboxWorkerReceipt,
} from '../../paper-domain/automation/os-sandbox-worker-receipt-contract.mjs';
import {
  ADVANCED_NUMERICAL_GPU_DEVICE_ISOLATION_SCOPE,
  ADVANCED_NUMERICAL_GPU_MEMORY_LIMIT_SCOPE,
  ADVANCED_NUMERICAL_PLUGIN_ANALYSIS_FAMILIES,
  compileAdvancedNumericalPluginDescriptor,
} from '../../paper-domain/research/advanced-numerical-plugin-contract.mjs';
import {
  ADVANCED_NUMERICAL_PLUGIN_QUALIFICATION_ROLES,
  buildAdvancedNumericalPluginQualificationStatement,
} from '../../paper-domain/research/advanced-numerical-plugin-qualification-contract.mjs';
import {
  buildAdvancedNumericalOracleQualificationReceipt,
  buildAdvancedNumericalPluginQualificationEvidenceBundle,
  buildAdvancedNumericalQualificationExecutionReceipt,
  buildAdvancedNumericalScientificReviewQualificationReceipt,
  buildAdvancedNumericalUncertaintyQualificationReceipt,
} from '../../paper-domain/research/advanced-numerical-plugin-qualification-evidence-contract.mjs';
import { signAuthorityDocument } from '../../paper-adapters/authority/authority-signatures.mjs';
import { buildExecutorCapabilities } from '../../paper-ports/executor-capabilities.mjs';
import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  immutableAuthoritySigningPayload,
} from '../../workflow-kernel/runtime/immutable-signed-json-bundle.mjs';

const GPU_UUID = 'GPU-a33875b7-7eb7-679e-df08-19227d3decee';
const GPU_IMAGE = 'hepta/python-gpu:0.15.0';
const GPU_IMAGE_DIGEST = `sha256:${'d'.repeat(64)}`;
const WORKSPACE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);

function signedPluginFixture({ gpu = false, observedSourceIdentity = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-advanced-numeric-'));
  const pluginRoot = path.join(root, 'plugin');
  const outputRoot = path.join(root, 'output');
  fs.mkdirSync(pluginRoot);
  fs.mkdirSync(outputRoot);
  const entrypoint = Buffer.from('print(\"fixture\")\n', 'utf8');
  fs.writeFileSync(path.join(pluginRoot, 'plugin.py'), entrypoint);
  const descriptor = compileAdvancedNumericalPluginDescriptor({
    version: gpu ? 2 : 1,
    pluginId: 'organization.causal-estimator',
    pluginVersion: '1.2.0',
    analysisFamily: 'causal-inference',
    runtime: gpu ? {
      language: 'python',
      executable: 'python',
      executableHash: `sha256:${'1'.repeat(64)}`,
      packageClosureHash: GPU_IMAGE_DIGEST,
      runtimeProfile: 'pythonGpu',
      requiresGpu: true,
      containerImage: GPU_IMAGE,
      containerImageDigest: GPU_IMAGE_DIGEST,
      containerExecutable: 'python',
      gpuDeviceSelector: GPU_UUID,
      cpuFallbackPolicy: 'forbidden',
      gpuDeviceIsolationScope: ADVANCED_NUMERICAL_GPU_DEVICE_ISOLATION_SCOPE,
      gpuMemoryLimitBytes: null,
      gpuMemoryLimitEnforced: false,
      gpuMemoryLimitScope: ADVANCED_NUMERICAL_GPU_MEMORY_LIMIT_SCOPE,
    } : {
      language: 'python',
      executable: 'python3',
      executableHash: `sha256:${'1'.repeat(64)}`,
      packageClosureHash: `sha256:${'2'.repeat(64)}`,
    },
    entrypoint: {
      relativePath: 'plugin.py',
      sha256: hashBytes(entrypoint),
    },
    sourceIdentity: observedSourceIdentity
      ? (() => {
        const snapshot = inspectWorkspaceExecutionSnapshot(pluginRoot);
        return {
          merkleHash: snapshot.merkleHash,
          workspaceManifestHash: snapshot.manifestHash,
        };
      })()
      : {
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
    pluginPrivateKey: keys.privateKey,
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
        organization: 'advanced-numerical-plugin-organization',
        algorithm: 'ed25519',
        publicKeyPem: keys.publicKey.export({ type: 'spki', format: 'pem' }),
        roles: ['advanced_numerical_plugin_authority'],
        status: 'active',
      }],
    },
  };
}

function sandboxRunner(descriptor, {
  gpu = false,
  invalidResult = false,
  networkPolicy = 'none',
  observeSpec = null,
} = {}) {
  const capabilities = buildExecutorCapabilities({
    executorId: 'fixture-kernel-worker',
    sandboxModes: ['kernel-isolated'],
    networkPolicy,
    workspaceIsolation: true,
    languages: ['python'],
    receiptKinds: ['OsSandboxWorkerReceipt'],
    gpu,
  });
  return {
    version: 4,
    runnerId: 'fixture-kernel-worker',
    capabilities: () => capabilities,
    resolveExecutionRuntimeIdentity() {
      if (descriptor.version === 2) {
        return {
          available: true,
          allowlisted: true,
          runtimeType: 'container',
          executionClass: 'explicit-container',
          backend: 'docker',
          requestedImage: descriptor.runtime.containerImage,
          digest: descriptor.runtime.containerImageDigest,
          containerExecutable: descriptor.runtime.containerExecutable,
        };
      }
      return {
        available: true,
        allowlisted: true,
        executableHash: descriptor.runtime.executableHash,
      };
    },
    async run(spec) {
      observeSpec?.(spec);
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

function productionQualification(fixture) {
  const trustKeys = [];
  const privateKeys = new Map();
  const keyIdsByRole = new Map();
  for (const [index, role] of ADVANCED_NUMERICAL_PLUGIN_QUALIFICATION_ROLES.entries()) {
    const keyPair = crypto.generateKeyPairSync('ed25519');
    const keyId = `advanced-numerical-qualification-${index + 1}`;
    privateKeys.set(keyId, keyPair.privateKey);
    keyIdsByRole.set(role, keyId);
    trustKeys.push({
      keyId,
      subjectId: `independent-qualification-subject-${index + 1}`,
      organization: `independent-qualification-organization-${index + 1}`,
      algorithm: 'ed25519',
      publicKeyPem: keyPair.publicKey.export({ type: 'spki', format: 'pem' }),
      roles: [role],
      status: 'active',
    });
  }
  const signedBundleHash = hashRecord(
    'AdvancedNumericalPluginSignedBundle',
    fixture.bundle,
  );
  const evidenceExpiresAt = new Date(
    fixture.now.getTime() + 55_000,
  ).toISOString();
  const signQualificationEvidence = (document, role) => {
    const keyId = keyIdsByRole.get(role);
    return signAuthorityDocument(document, {
      privateKeyPem: privateKeys.get(keyId),
      keyId,
      role,
    });
  };
  let referenceExecutionReceipt =
    buildAdvancedNumericalQualificationExecutionReceipt({
      descriptor: fixture.descriptor,
      signedBundleHash,
      executionMode: 'reference',
      requestCorpusHash: `sha256:${'c'.repeat(64)}`,
      resultHash: `sha256:${'f'.repeat(64)}`,
      executionProcessIdentityHash: `sha256:${'d'.repeat(64)}`,
      executedAt: new Date(fixture.now.getTime() - 70_000).toISOString(),
      signedAt: new Date(fixture.now.getTime() - 60_000).toISOString(),
      validFrom: new Date(fixture.now.getTime() - 59_000).toISOString(),
      expiresAt: evidenceExpiresAt,
    });
  referenceExecutionReceipt = signAuthorityDocument(
    referenceExecutionReceipt,
    {
      privateKeyPem: fixture.pluginPrivateKey,
      keyId: 'advanced-numerical-plugin-key',
      role: 'advanced_numerical_plugin_authority',
    },
  );
  let replayExecutionReceipt =
    buildAdvancedNumericalQualificationExecutionReceipt({
      descriptor: fixture.descriptor,
      signedBundleHash,
      executionMode: 'independent-replay',
      requestCorpusHash: referenceExecutionReceipt.requestCorpusHash,
      resultHash: referenceExecutionReceipt.resultHash,
      executionProcessIdentityHash: `sha256:${'e'.repeat(64)}`,
      executedAt: new Date(fixture.now.getTime() - 65_000).toISOString(),
      signedAt: new Date(fixture.now.getTime() - 55_000).toISOString(),
      validFrom: new Date(fixture.now.getTime() - 54_000).toISOString(),
      expiresAt: evidenceExpiresAt,
    });
  replayExecutionReceipt = signQualificationEvidence(
    replayExecutionReceipt,
    'advanced_numerical_replay_authority',
  );
  let independentNumericOracleReceipt =
    buildAdvancedNumericalOracleQualificationReceipt({
      descriptor: fixture.descriptor,
      signedBundleHash,
      referenceExecutionReceiptHash:
        referenceExecutionReceipt
          .advancedNumericalQualificationExecutionReceiptHash,
      replayExecutionReceiptHash:
        replayExecutionReceipt
          .advancedNumericalQualificationExecutionReceiptHash,
      resultHash: referenceExecutionReceipt.resultHash,
      independentNumericOracleArtifactHash: `sha256:${'8'.repeat(64)}`,
      signedAt: new Date(fixture.now.getTime() - 50_000).toISOString(),
      validFrom: new Date(fixture.now.getTime() - 49_000).toISOString(),
      expiresAt: evidenceExpiresAt,
    });
  independentNumericOracleReceipt = signQualificationEvidence(
    independentNumericOracleReceipt,
    'advanced_numerical_oracle_authority',
  );
  let typedUncertaintyReviewReceipt =
    buildAdvancedNumericalUncertaintyQualificationReceipt({
      descriptor: fixture.descriptor,
      signedBundleHash,
      referenceExecutionReceiptHash:
        referenceExecutionReceipt
          .advancedNumericalQualificationExecutionReceiptHash,
      replayExecutionReceiptHash:
        replayExecutionReceipt
          .advancedNumericalQualificationExecutionReceiptHash,
      resultHash: referenceExecutionReceipt.resultHash,
      typedUncertaintyArtifactHash: `sha256:${'9'.repeat(64)}`,
      signedAt: new Date(fixture.now.getTime() - 48_000).toISOString(),
      validFrom: new Date(fixture.now.getTime() - 47_000).toISOString(),
      expiresAt: evidenceExpiresAt,
    });
  typedUncertaintyReviewReceipt = signQualificationEvidence(
    typedUncertaintyReviewReceipt,
    'advanced_numerical_uncertainty_reviewer',
  );
  let scientificReviewReceipt =
    buildAdvancedNumericalScientificReviewQualificationReceipt({
      descriptor: fixture.descriptor,
      signedBundleHash,
      referenceExecutionReceiptHash:
        referenceExecutionReceipt
          .advancedNumericalQualificationExecutionReceiptHash,
      replayExecutionReceiptHash:
        replayExecutionReceipt
          .advancedNumericalQualificationExecutionReceiptHash,
      independentNumericOracleReceiptHash:
        independentNumericOracleReceipt
          .advancedNumericalOracleQualificationReceiptHash,
      typedUncertaintyReviewReceiptHash:
        typedUncertaintyReviewReceipt
          .advancedNumericalUncertaintyQualificationReceiptHash,
      resultHash: referenceExecutionReceipt.resultHash,
      scientificReviewArtifactHash: `sha256:${'a'.repeat(64)}`,
      signedAt: new Date(fixture.now.getTime() - 45_000).toISOString(),
      validFrom: new Date(fixture.now.getTime() - 44_000).toISOString(),
      expiresAt: evidenceExpiresAt,
    });
  scientificReviewReceipt = signQualificationEvidence(
    scientificReviewReceipt,
    'advanced_numerical_scientific_reviewer',
  );
  let qualification = buildAdvancedNumericalPluginQualificationStatement({
    descriptor: fixture.descriptor,
    signedBundleHash,
    evidence: {
      independentNumericOracleReceiptHash:
        independentNumericOracleReceipt
          .advancedNumericalOracleQualificationReceiptHash,
      referenceExecutionReceiptHash:
        referenceExecutionReceipt
          .advancedNumericalQualificationExecutionReceiptHash,
      referenceResultHash: referenceExecutionReceipt.resultHash,
      replayExecutionReceiptHash:
        replayExecutionReceipt
          .advancedNumericalQualificationExecutionReceiptHash,
      replayResultHash: replayExecutionReceipt.resultHash,
      scientificReviewReceiptHash:
        scientificReviewReceipt
          .advancedNumericalScientificReviewQualificationReceiptHash,
      typedUncertaintyReviewReceiptHash:
        typedUncertaintyReviewReceipt
          .advancedNumericalUncertaintyQualificationReceiptHash,
    },
    signedAt: new Date(fixture.now.getTime() - 40_000).toISOString(),
    validFrom: new Date(fixture.now.getTime() - 35_000).toISOString(),
    expiresAt: new Date(fixture.now.getTime() + 50_000).toISOString(),
  });
  for (const [index, role] of ADVANCED_NUMERICAL_PLUGIN_QUALIFICATION_ROLES.entries()) {
    const keyId = `advanced-numerical-qualification-${index + 1}`;
    qualification = signAuthorityDocument(qualification, {
      privateKeyPem: privateKeys.get(keyId),
      keyId,
      role,
    });
  }
  const evidence = buildAdvancedNumericalPluginQualificationEvidenceBundle({
    descriptor: fixture.descriptor,
    signedBundleHash,
    qualification,
    referenceExecutionReceipt,
    replayExecutionReceipt,
    independentNumericOracleReceipt,
    typedUncertaintyReviewReceipt,
    scientificReviewReceipt,
  });
  return {
    qualification,
    evidence,
    trustStore: {
      version: 1,
      kind: 'AuthorityTrustStore',
      keys: trustKeys,
    },
  };
}

function writePrivateJson(root, name, value) {
  const target = path.join(root, name);
  const bytes = Buffer.from(JSON.stringify(value), 'utf8');
  fs.writeFileSync(target, bytes);
  fs.chmodSync(target, 0o600);
  return { path: target, hash: hashBytes(bytes) };
}

test('missing numerical plugin status configuration is a typed fail-closed report', () => {
  const missing = path.join(
    os.tmpdir(),
    `hepta-advanced-numerical-missing-${process.pid}-${Date.now()}.json`,
  );
  fs.rmSync(missing, { force: true });
  assert.throws(
    () => readAdvancedNumericalPluginRuntimeConfiguration({
      configurationPath: missing,
    }),
    (error) => error?.code === 'advanced_numerical_plugin_document_missing',
  );
  const result = spawnSync(process.execPath, [
    path.join(WORKSPACE_ROOT, 'paper-core', 'bin', 'advanced-numerical-plugin.mjs'),
    '--action', 'status',
    '--config', missing,
  ], {
    cwd: WORKSPACE_ROOT,
    encoding: 'utf8',
  });
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stderr, '');
  assert.doesNotMatch(result.stdout, /ENOENT/u);
  const report = JSON.parse(result.stdout);
  assert.equal(report.status, 'advanced_numerical_plugin_runner_blocked');
  assert.equal(report.productionQualified, false);
  assert.deepEqual(report.blockers, [
    'advanced_numerical_plugin_runtime_configuration_missing',
  ]);
  assert.equal(report.errorCode, 'advanced_numerical_plugin_document_missing');
});

test('unqualified numerical plugin capability is never reported as ready', () => {
  const fixture = signedPluginFixture();
  try {
    const runner = createOutOfProcessAdvancedNumericalPluginRunner({
      signedBundle: fixture.bundle,
      trustStore: fixture.trustStore,
      workerRunner: sandboxRunner(fixture.descriptor),
      pluginRoot: fixture.pluginRoot,
      outputRoot: fixture.outputRoot,
      now: fixture.now,
    });
    const capabilities = runner.capabilities();
    assert.equal(capabilities.productionQualified, false);
    assert.equal(
      capabilities.qualifiedAnalysisFamilies.length,
      0,
    );
    const status = inspectAdvancedNumericalPluginRunnerStatus({
      available: true,
      productionQualified: capabilities.productionQualified,
    });
    assert.equal(status.status, 'advanced_numerical_plugin_runner_unqualified');
    assert.ok(status.status.includes('unqualified'));
    assert.ok(status.blockers.includes(
      'advanced_numerical_plugin_production_qualification_required',
    ));
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('signed advanced numerical plugins run out of process but remain unqualified', async (context) => {
  const fixture = signedPluginFixture();
  context.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  let observedSpec = null;
  const runner = createOutOfProcessAdvancedNumericalPluginRunner({
    signedBundle: fixture.bundle,
    trustStore: fixture.trustStore,
    workerRunner: sandboxRunner(fixture.descriptor, {
      observeSpec: (spec) => { observedSpec = spec; },
    }),
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
  assert.deepEqual(observedSpec.runtimePackageClosure, {
    basis: 'signed-plugin-descriptor',
    identityHash: fixture.descriptor.runtime.packageClosureHash,
    manifestHash: fixture.descriptor.runtime.packageClosureHash,
    observedPackageCount: 0,
  });
  assert.match(receipt.advancedNumericalPluginExecutionReceiptHash,
    /^sha256:[0-9a-f]{64}$/);
});

test('independently qualified plugins emit production-qualified receipts', async (context) => {
  const fixture = signedPluginFixture();
  context.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const qualified = productionQualification(fixture);
  const runner = createOutOfProcessAdvancedNumericalPluginRunner({
    signedBundle: fixture.bundle,
    trustStore: fixture.trustStore,
    qualification: qualified.qualification,
    qualificationEvidence: qualified.evidence,
    qualificationTrustStore: qualified.trustStore,
    workerRunner: sandboxRunner(fixture.descriptor),
    pluginRoot: fixture.pluginRoot,
    outputRoot: fixture.outputRoot,
    now: fixture.now,
  });
  assert.equal(runner.capabilities().productionQualified, true);
  assert.deepEqual(runner.capabilities().qualifiedAnalysisFamilies, ['causal-inference']);
  assert.match(
    runner.capabilities().qualificationEvidenceBundleHash,
    /^sha256:[0-9a-f]{64}$/,
  );
  assert.equal(
    runner.capabilities().referenceExecutionProcessIdentityHash
      === runner.capabilities().replayExecutionProcessIdentityHash,
    false,
  );
  const receipt = await runner.run({
    runId: 'causal-run-qualified',
    input: { outcome: [1, 2, 3], treatment: [0, 1, 1] },
    seed: 19,
    outputDirectory: path.join(fixture.outputRoot, 'qualified-run'),
  });
  assert.equal(receipt.status,
    'advanced_numerical_plugin_execution_completed_qualified');
  assert.equal(receipt.productionQualified, true);
  assert.match(receipt.qualificationStatementHash, /^sha256:[0-9a-f]{64}$/);
  assert.match(receipt.qualificationInspectionHash, /^sha256:[0-9a-f]{64}$/);
});

test('GPU descriptor v2 forbids fallback and makes non-enforced VRAM semantics explicit', () => {
  const fixture = signedPluginFixture({ gpu: true });
  try {
    assert.equal(fixture.descriptor.version, 2);
    assert.equal(fixture.descriptor.runtime.runtimeProfile, 'pythonGpu');
    assert.equal(fixture.descriptor.runtime.requiresGpu, true);
    assert.equal(fixture.descriptor.runtime.cpuFallbackPolicy, 'forbidden');
    assert.equal(fixture.descriptor.runtime.gpuMemoryLimitBytes, null);
    assert.equal(fixture.descriptor.runtime.gpuMemoryLimitEnforced, false);
    for (const runtime of [
      { ...fixture.descriptor.runtime, gpuDeviceSelector: 'all' },
      { ...fixture.descriptor.runtime, cpuFallbackPolicy: 'allowed' },
      { ...fixture.descriptor.runtime, gpuMemoryLimitEnforced: true },
      { ...fixture.descriptor.runtime, containerImageDigest: `sha256:${'e'.repeat(63)}` },
    ]) {
      assert.throws(() => compileAdvancedNumericalPluginDescriptor({
        ...fixture.descriptor,
        runtime,
        advancedNumericalPluginDescriptorHash: undefined,
      }), /gpu_runtime_invalid/);
    }
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('runtime configuration v2 repeats and pins the signed GPU execution authority', () => {
  const fixture = signedPluginFixture({ gpu: true });
  try {
    const bundle = writePrivateJson(fixture.root, 'bundle.json', fixture.bundle);
    const trustStore = writePrivateJson(fixture.root, 'trust.json', fixture.trustStore);
    const qualification = writePrivateJson(fixture.root, 'qualification.json', {});
    const evidence = writePrivateJson(fixture.root, 'evidence.json', {});
    const qualificationTrust = writePrivateJson(fixture.root, 'qualification-trust.json', {});
    const configuration = {
      version: 2,
      kind: 'AdvancedNumericalPluginRuntimeConfiguration',
      pluginRoot: 'plugin',
      outputRoot: 'output',
      signedBundlePath: 'bundle.json',
      signedBundleFileHash: bundle.hash,
      trustStorePath: 'trust.json',
      trustStoreFileHash: trustStore.hash,
      qualificationPath: 'qualification.json',
      qualificationFileHash: qualification.hash,
      qualificationEvidencePath: 'evidence.json',
      qualificationEvidenceFileHash: evidence.hash,
      qualificationTrustStorePath: 'qualification-trust.json',
      qualificationTrustStoreFileHash: qualificationTrust.hash,
      runtimeProfile: fixture.descriptor.runtime.runtimeProfile,
      requiresGpu: true,
      containerImage: fixture.descriptor.runtime.containerImage,
      containerImageDigest: fixture.descriptor.runtime.containerImageDigest,
      containerExecutable: fixture.descriptor.runtime.containerExecutable,
      gpuDeviceSelector: fixture.descriptor.runtime.gpuDeviceSelector,
      cpuFallbackPolicy: fixture.descriptor.runtime.cpuFallbackPolicy,
      gpuDeviceIsolationScope: fixture.descriptor.runtime.gpuDeviceIsolationScope,
      gpuMemoryLimitBytes: null,
      gpuMemoryLimitEnforced: false,
      gpuMemoryLimitScope: fixture.descriptor.runtime.gpuMemoryLimitScope,
    };
    const config = writePrivateJson(fixture.root, 'runtime.json', configuration);
    const loaded = readAdvancedNumericalPluginRuntimeConfiguration({
      configurationPath: config.path,
      expectedConfigurationHash: config.hash,
    });
    assert.equal(loaded.gpuRuntimeAuthority.containerImageDigest, GPU_IMAGE_DIGEST);
    assert.equal(loaded.gpuRuntimeAuthority.gpuDeviceSelector, GPU_UUID);

    const drifted = { ...configuration, gpuDeviceSelector: `GPU-${'1'.repeat(8)}-${'1'.repeat(4)}-${'1'.repeat(4)}-${'1'.repeat(4)}-${'1'.repeat(12)}` };
    const driftedConfig = writePrivateJson(fixture.root, 'runtime-drifted.json', drifted);
    assert.throws(() => readAdvancedNumericalPluginRuntimeConfiguration({
      configurationPath: driftedConfig.path,
      expectedConfigurationHash: driftedConfig.hash,
    }), /gpu_configuration_binding_invalid/);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('GPU runner calls only the fixed container path and rejects non-production worker evidence', async () => {
  const fixture = signedPluginFixture({ gpu: true });
  try {
    const qualified = productionQualification(fixture);
    let observed = null;
    assert.throws(() => createOutOfProcessAdvancedNumericalPluginRunner({
      signedBundle: fixture.bundle,
      trustStore: fixture.trustStore,
      workerRunner: sandboxRunner(fixture.descriptor),
      pluginRoot: fixture.pluginRoot,
      outputRoot: fixture.outputRoot,
      now: fixture.now,
    }), /worker_capability_invalid/);
    const runner = createOutOfProcessAdvancedNumericalPluginRunner({
      signedBundle: fixture.bundle,
      trustStore: fixture.trustStore,
      qualification: qualified.qualification,
      qualificationEvidence: qualified.evidence,
      qualificationTrustStore: qualified.trustStore,
      workerRunner: sandboxRunner(fixture.descriptor, {
        gpu: true,
        observeSpec: (spec) => { observed = spec; },
      }),
      pluginRoot: fixture.pluginRoot,
      outputRoot: fixture.outputRoot,
      now: fixture.now,
    });
    assert.equal(runner.capabilities().productionQualified, true);
    assert.equal(runner.capabilities().runtimeProfile, 'pythonGpu');
    assert.match(runner.capabilities().gpuRuntimeAuthorityHash, /^sha256:[0-9a-f]{64}$/);
    const receipt = await runner.run({
      runId: 'gpu-runtime-binding',
      input: { system: 'poisson-2d' },
      seed: 23,
      outputDirectory: path.join(fixture.outputRoot, 'gpu-runtime-binding'),
    });
    assert.equal(observed.containerImage, GPU_IMAGE);
    assert.equal(observed.containerExecutable, 'python');
    assert.equal(observed.requiresGpu, true);
    assert.equal(observed.gpuDeviceSelector, GPU_UUID);
    assert.equal(receipt.status, 'advanced_numerical_plugin_execution_blocked');
    assert.ok(receipt.blockers.includes('advanced_numerical_plugin_worker_execution_blocked'));
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('GPU fixture runner cannot promote a fabricated container receipt', async (t) => {
  const observation = spawnSync('/usr/bin/nvidia-smi', [
    '--query-gpu=uuid', '--format=csv,noheader',
  ], { encoding: 'utf8', timeout: 5_000 });
  const selector = String(observation.stdout || '').trim().split(/\r?\n/)[0];
  if (observation.status !== 0 || selector !== GPU_UUID || !fs.existsSync('/dev/nvidia0')) {
    t.skip('fixture GPU UUID unavailable');
    return;
  }
  const fixture = signedPluginFixture({ gpu: true, observedSourceIdentity: true });
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const qualified = productionQualification(fixture);
  const workerRunner = createOsSandboxedWorkerRunner({
    allowedRoots: [fixture.pluginRoot],
    allowedOutputRoots: [fixture.outputRoot],
    allowedContainerImages: [GPU_IMAGE, GPU_IMAGE_DIGEST],
    runtimeRoot: path.join(fixture.root, '.gpu-runtime'),
    allowGpu: true,
    maximumTimeoutMs: fixture.descriptor.limits.timeoutMs,
    maximumMemoryBytes: fixture.descriptor.limits.memoryBytes,
    maximumCpuSeconds: fixture.descriptor.limits.cpuSeconds,
    maximumPids: fixture.descriptor.limits.maximumProcesses,
    maximumOutputBytes: fixture.descriptor.limits.maximumOutputBytes,
    maximumCapturedBytes: fixture.descriptor.limits.maximumCapturedBytes,
    probe: {
      available: true,
      backend: 'docker',
      status: 'os_sandbox_available',
      image: GPU_IMAGE,
    },
    imageDigestResolver: (image) => image === GPU_IMAGE ? GPU_IMAGE_DIGEST : null,
    executor(_launcher, args) {
      const outputMount = args.find((argument) => String(argument).endsWith(':/output:rw'));
      const sandboxOutput = String(outputMount).slice(0, -':/output:rw'.length);
      const requestIndex = args.indexOf('--hepta-request-base64');
      const request = JSON.parse(Buffer.from(args[requestIndex + 1], 'base64').toString('utf8'));
      const resultPayload = {
        version: 1,
        kind: 'AdvancedNumericalPluginResult',
        status: 'advanced_numerical_computation_completed',
        pluginId: fixture.descriptor.pluginId,
        analysisFamily: fixture.descriptor.analysisFamily,
        requestHash: request.advancedNumericalPluginRequestHash,
        oracleContractHash: fixture.descriptor.assuranceContracts.oracle.contractHash,
        replayContractHash: fixture.descriptor.assuranceContracts.replay.contractHash,
        uncertaintyContractHash:
          fixture.descriptor.assuranceContracts.uncertainty.contractHash,
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
      fs.writeFileSync(path.join(sandboxOutput, 'result.json'), JSON.stringify(result));
      fs.chmodSync(path.join(sandboxOutput, 'result.json'), 0o600);
      return { status: 0, stdout: '', stderr: '', pid: process.pid };
    },
  });
  const runner = createOutOfProcessAdvancedNumericalPluginRunner({
    signedBundle: fixture.bundle,
    trustStore: fixture.trustStore,
    qualification: qualified.qualification,
    qualificationEvidence: qualified.evidence,
    qualificationTrustStore: qualified.trustStore,
    workerRunner,
    pluginRoot: fixture.pluginRoot,
    outputRoot: fixture.outputRoot,
    now: fixture.now,
  });
  const receipt = await runner.run({
    runId: 'gpu-strict-production-receipt',
    input: { system: 'poisson-2d' },
    seed: 29,
    outputDirectory: path.join(fixture.outputRoot, 'gpu-strict-production-receipt'),
  });
  assert.equal(receipt.status, 'advanced_numerical_plugin_execution_blocked');
  assert.equal(receipt.productionQualified, true);
  assert.ok(receipt.blockers.includes(
    'advanced_numerical_plugin_worker_execution_blocked',
  ));
  assert.equal(receipt.workerReceipt.evidenceClass, 'verification-fixture-v1');
  assert.equal(verifyProductionOsSandboxWorkerReceipt(receipt.workerReceipt), false);
});

test('qualification tampering and signer collusion fail closed', () => {
  const fixture = signedPluginFixture();
  try {
    const qualified = productionQualification(fixture);
    const colludingTrustStore = structuredClone(qualified.trustStore);
    colludingTrustStore.keys[0].subjectId = 'advanced-numerical-plugin-authority';
    assert.throws(() => createOutOfProcessAdvancedNumericalPluginRunner({
      signedBundle: fixture.bundle,
      trustStore: fixture.trustStore,
      qualification: qualified.qualification,
      qualificationEvidence: qualified.evidence,
      qualificationTrustStore: colludingTrustStore,
      workerRunner: sandboxRunner(fixture.descriptor),
      pluginRoot: fixture.pluginRoot,
      outputRoot: fixture.outputRoot,
      now: fixture.now,
    }), /qualification_subject_independence_required/);

    const sameOrganizationTrustStore = structuredClone(qualified.trustStore);
    sameOrganizationTrustStore.keys[0].organization =
      'advanced-numerical-plugin-organization';
    assert.throws(() => createOutOfProcessAdvancedNumericalPluginRunner({
      signedBundle: fixture.bundle,
      trustStore: fixture.trustStore,
      qualification: qualified.qualification,
      qualificationEvidence: qualified.evidence,
      qualificationTrustStore: sameOrganizationTrustStore,
      workerRunner: sandboxRunner(fixture.descriptor),
      pluginRoot: fixture.pluginRoot,
      outputRoot: fixture.outputRoot,
      now: fixture.now,
    }), /qualification_organization_independence_required/);

    const tampered = structuredClone(qualified.qualification);
    tampered.evidence.replayResultHash = `sha256:${'c'.repeat(64)}`;
    assert.throws(() => createOutOfProcessAdvancedNumericalPluginRunner({
      signedBundle: fixture.bundle,
      trustStore: fixture.trustStore,
      qualification: tampered,
      qualificationEvidence: qualified.evidence,
      qualificationTrustStore: qualified.trustStore,
      workerRunner: sandboxRunner(fixture.descriptor),
      pluginRoot: fixture.pluginRoot,
      outputRoot: fixture.outputRoot,
      now: fixture.now,
    }), /qualification_statement_invalid/);

    const forgedEvidence = structuredClone(qualified.evidence);
    forgedEvidence.replayExecutionReceipt.executionProcessIdentityHash =
      forgedEvidence.referenceExecutionReceipt.executionProcessIdentityHash;
    assert.throws(() => createOutOfProcessAdvancedNumericalPluginRunner({
      signedBundle: fixture.bundle,
      trustStore: fixture.trustStore,
      qualification: qualified.qualification,
      qualificationEvidence: forgedEvidence,
      qualificationTrustStore: qualified.trustStore,
      workerRunner: sandboxRunner(fixture.descriptor),
      pluginRoot: fixture.pluginRoot,
      outputRoot: fixture.outputRoot,
      now: fixture.now,
    }), /qualification_evidence_bundle_invalid/);

    assert.throws(() => createOutOfProcessAdvancedNumericalPluginRunner({
      signedBundle: fixture.bundle,
      trustStore: fixture.trustStore,
      qualification: qualified.qualification,
      qualificationTrustStore: qualified.trustStore,
      workerRunner: sandboxRunner(fixture.descriptor),
      pluginRoot: fixture.pluginRoot,
      outputRoot: fixture.outputRoot,
      now: fixture.now,
    }), /qualification_configuration_incomplete/);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('advanced numerical descriptor onboarding covers the declared cross-domain families', () => {
  const fixture = signedPluginFixture();
  try {
    for (const analysisFamily of ADVANCED_NUMERICAL_PLUGIN_ANALYSIS_FAMILIES) {
      const descriptor = compileAdvancedNumericalPluginDescriptor({
        ...fixture.descriptor,
        analysisFamily,
        advancedNumericalPluginDescriptorHash: undefined,
      });
      assert.equal(descriptor.analysisFamily, analysisFamily);
      assert.match(descriptor.advancedNumericalPluginDescriptorHash, /^sha256:[0-9a-f]{64}$/);
    }
    assert.throws(() => compileAdvancedNumericalPluginDescriptor({
      ...fixture.descriptor,
      analysisFamily: 'arbitrary-unreviewed-analysis',
      advancedNumericalPluginDescriptorHash: undefined,
    }), /descriptor_invalid/);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
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
