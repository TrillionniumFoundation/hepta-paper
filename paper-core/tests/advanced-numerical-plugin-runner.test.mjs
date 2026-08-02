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
