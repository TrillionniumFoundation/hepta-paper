// Development-only: factory bodies copied exactly from original runner tests.
// No generated key leaves process memory. No fixture grants installed authority.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inspectWorkspaceExecutionSnapshot } from '../../../paper-adapters/runtime/os-sandboxed-worker-runner.mjs';
import { ADVANCED_NUMERICAL_GPU_DEVICE_ISOLATION_SCOPE, ADVANCED_NUMERICAL_GPU_MEMORY_LIMIT_SCOPE, compileAdvancedNumericalPluginDescriptor } from '../../../paper-domain/research/advanced-numerical-plugin-contract.mjs';
import { ADVANCED_NUMERICAL_PLUGIN_QUALIFICATION_ROLES, buildAdvancedNumericalPluginQualificationStatement } from '../../../paper-domain/research/advanced-numerical-plugin-qualification-contract.mjs';
import { buildAdvancedNumericalOracleQualificationReceipt,buildAdvancedNumericalPluginQualificationEvidenceBundle,buildAdvancedNumericalQualificationExecutionReceipt,buildAdvancedNumericalScientificReviewQualificationReceipt,buildAdvancedNumericalUncertaintyQualificationReceipt } from '../../../paper-domain/research/advanced-numerical-plugin-qualification-evidence-contract.mjs';
import { signAuthorityDocument } from '../../../paper-adapters/authority/authority-signatures.mjs';
import { hashBytes,hashRecord } from '../../../workflow-kernel/record-hash.mjs';
import { immutableAuthoritySigningPayload } from '../../../workflow-kernel/runtime/immutable-signed-json-bundle.mjs';
const GPU_UUID = 'GPU-a33875b7-7eb7-679e-df08-19227d3decee';
const GPU_IMAGE = 'hepta/python-gpu:0.15.0';
const GPU_IMAGE_DIGEST = `sha256:${'d'.repeat(64)}`;
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


export { signedPluginFixture, productionQualification };
