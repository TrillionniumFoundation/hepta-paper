import fs from 'node:fs';
import path from 'node:path';

import {
  ADVANCED_NUMERICAL_PLUGIN_ANALYSIS_FAMILIES,
  buildAdvancedNumericalGpuRuntimeAuthority,
  buildAdvancedNumericalPluginRequest,
  verifyAdvancedNumericalPluginDescriptor,
  verifyAdvancedNumericalPluginResult,
} from '../../paper-domain/research/advanced-numerical-plugin-contract.mjs';
import {
  verifyProductionOsSandboxWorkerReceipt,
} from '../../paper-domain/automation/os-sandbox-worker-receipt-contract.mjs';
import {
  assertAdvancedNumericalPluginRunnerPort,
} from '../../paper-ports/advanced-numerical-plugin-runner-port.mjs';
import { assertWorkerRunnerPort } from '../../paper-ports/worker-runner-port.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  verifyImmutableEd25519AuthorityDocument,
} from '../../workflow-kernel/runtime/immutable-signed-json-bundle.mjs';
import { isPathWithin } from '../../workflow-kernel/runtime/path-utils.mjs';
import {
  inspectScopedPathSync,
  readScopedFileSync,
} from '../../workflow-kernel/runtime/scoped-file-identity.mjs';
import {
  verifyAdvancedNumericalPluginProductionQualification,
} from './advanced-numerical-plugin-production-qualification.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const AUTHORITY_ROLE = 'advanced_numerical_plugin_authority';

function blocked(blockers, details = {}) {
  return Object.freeze({
    version: 1,
    kind: 'AdvancedNumericalPluginExecutionReceipt',
    status: 'advanced_numerical_plugin_execution_blocked',
    productionQualified: false,
    blockers: Object.freeze([...new Set(blockers)]),
    ...details,
  });
}

function observedExecutableHash(identity) {
  return identity?.executableHash || identity?.hostExecutableHash || null;
}

function gpuRuntimeWorkerReceiptValid(receipt, descriptor) {
  const runtime = descriptor.runtime;
  return verifyProductionOsSandboxWorkerReceipt(receipt)
    && receipt.runtimeIdentityType === 'container'
    && receipt.containerImage === runtime.containerImage
    && receipt.containerImageDigest === runtime.containerImageDigest
    && receipt.gpuDeviceRequest?.required === true
    && receipt.gpuDeviceRequest?.deviceSelector === runtime.gpuDeviceSelector
    && receipt.gpuDeviceRequest?.requestedDeviceCount === 1
    && receipt.limits?.timeoutMs === descriptor.limits.timeoutMs
    && receipt.limits?.memoryBytes === descriptor.limits.memoryBytes
    && receipt.limits?.cpuSeconds === descriptor.limits.cpuSeconds
    && receipt.limits?.maximumPids === descriptor.limits.maximumProcesses
    && receipt.limits?.maximumOutputBytes === descriptor.limits.maximumOutputBytes
    && receipt.isolation?.gpuDeviceIsolationScope === runtime.gpuDeviceIsolationScope
    && receipt.isolation?.gpuMemoryIsolationVerified === false
    && runtime.gpuMemoryLimitBytes === null
    && runtime.gpuMemoryLimitEnforced === false;
}

export function verifyAdvancedNumericalPluginSignedBundle(bundle, {
  trustStore,
  now = new Date(),
} = {}) {
  const descriptor = bundle?.descriptor;
  const authority = bundle?.authority;
  if (bundle?.version !== 1
    || bundle?.kind !== 'AdvancedNumericalPluginSignedBundle'
    || !verifyAdvancedNumericalPluginDescriptor(descriptor)
    || authority?.version !== 1
    || authority?.kind !== 'AdvancedNumericalPluginAuthority'
    || authority?.pluginId !== descriptor.pluginId
    || authority?.pluginVersion !== descriptor.pluginVersion
    || authority?.descriptorHash !== descriptor.advancedNumericalPluginDescriptorHash) {
    throw new Error('advanced_numerical_plugin_signed_bundle_invalid');
  }
  const signatureVerification = verifyImmutableEd25519AuthorityDocument({
    document: authority,
    trustStore,
    requiredRole: AUTHORITY_ROLE,
    now,
    maximumLifetimeMs: 366 * 24 * 60 * 60 * 1_000,
  });
  return Object.freeze({
    descriptor,
    authority,
    signatureVerification,
    signedBundleHash: hashRecord('AdvancedNumericalPluginSignedBundle', bundle),
  });
}

export function createOutOfProcessAdvancedNumericalPluginRunner({
  signedBundle,
  trustStore,
  qualification = null,
  qualificationEvidence = null,
  qualificationTrustStore = null,
  workerRunner,
  pluginRoot,
  outputRoot,
  now = new Date(),
} = {}) {
  const verifiedBundle = verifyAdvancedNumericalPluginSignedBundle(signedBundle, {
    trustStore,
    now,
  });
  const descriptor = verifiedBundle.descriptor;
  const gpuRuntimeAuthority = descriptor.version === 2
    ? buildAdvancedNumericalGpuRuntimeAuthority(descriptor) : null;
  if ([qualification, qualificationEvidence, qualificationTrustStore]
    .filter((value) => value !== null).length !== 0
    && [qualification, qualificationEvidence, qualificationTrustStore]
      .some((value) => value === null)) {
    throw new Error('advanced_numerical_plugin_qualification_configuration_incomplete');
  }
  const productionQualification = qualification === null ? null
    : verifyAdvancedNumericalPluginProductionQualification({
      descriptor,
      signedBundleHash: verifiedBundle.signedBundleHash,
      pluginAuthorityVerification: verifiedBundle.signatureVerification,
      pluginTrustStore: trustStore,
      qualification,
      evidenceBundle: qualificationEvidence,
      trustStore: qualificationTrustStore,
      now,
    });
  const productionQualified = productionQualification?.productionQualified === true
    && (!gpuRuntimeAuthority || (
      productionQualification.version === 3
      && productionQualification.gpuRuntimeAuthorityHash
        === gpuRuntimeAuthority.advancedNumericalGpuRuntimeAuthorityHash
      && JSON.stringify(productionQualification.gpuRuntimeAuthority)
        === JSON.stringify(gpuRuntimeAuthority)
    ));
  const sandbox = assertWorkerRunnerPort(workerRunner);
  const sandboxCapabilities = sandbox.capabilities();
  if (!sandboxCapabilities.sandboxModes?.includes('kernel-isolated')
    || sandboxCapabilities.networkPolicy !== 'none'
    || sandboxCapabilities.workspaceIsolation !== true
    || sandboxCapabilities.externalActions !== false
    || (gpuRuntimeAuthority && sandboxCapabilities.gpu !== true)) {
    throw new Error('advanced_numerical_plugin_worker_capability_invalid');
  }
  const selectedPluginRoot = path.resolve(String(pluginRoot || ''));
  const selectedOutputRoot = path.resolve(String(outputRoot || ''));
  const pluginRootInspection = inspectScopedPathSync({
    scopeRoot: selectedPluginRoot,
    candidate: selectedPluginRoot,
    expect: 'directory',
    forbidHardlinks: false,
  });
  const entrypointPath = path.resolve(
    selectedPluginRoot,
    descriptor.entrypoint.relativePath,
  );
  const entrypointRead = readScopedFileSync({
    scopeRoot: selectedPluginRoot,
    candidate: entrypointPath,
    maximumBytes: 4 * 1024 * 1024,
  });
  const outputRootInspection = inspectScopedPathSync({
    scopeRoot: selectedOutputRoot,
    candidate: selectedOutputRoot,
    expect: 'directory',
    forbidHardlinks: false,
  });
  if (pluginRootInspection.blockers.length
    || outputRootInspection.blockers.length
    || entrypointRead.status !== 'scoped_file_read_verified'
    || entrypointRead.hash !== descriptor.entrypoint.sha256) {
    throw new Error('advanced_numerical_plugin_local_identity_invalid');
  }
  const capabilities = Object.freeze({
    version: 1,
    kind: 'AdvancedNumericalPluginRunnerCapabilities',
    analysisFamilies: ADVANCED_NUMERICAL_PLUGIN_ANALYSIS_FAMILIES,
    outOfProcess: true,
    signedPlugins: true,
    resourceLimits: true,
    networkPolicy: 'none',
    productionQualified,
    runtimeProfile: descriptor.runtime.runtimeProfile || null,
    requiresGpu: descriptor.runtime.requiresGpu === true,
    gpuRuntimeAuthorityHash:
      gpuRuntimeAuthority?.advancedNumericalGpuRuntimeAuthorityHash || null,
    qualifiedAnalysisFamilies: Object.freeze(
      productionQualified ? [descriptor.analysisFamily] : [],
    ),
    qualificationStatementHash:
      productionQualification?.qualificationStatementHash || null,
    qualificationEvidenceBundleHash:
      productionQualification?.qualificationEvidenceBundleHash || null,
    qualificationInspectionHash:
      productionQualification
        ?.advancedNumericalPluginProductionQualificationInspectionHash || null,
    pluginAuthoritySubjectIds:
      productionQualification?.pluginAuthoritySubjectIds || Object.freeze([]),
    pluginAuthorityOrganizations:
      productionQualification?.pluginAuthorityOrganizations || Object.freeze([]),
    pluginAuthorityPublicKeySpkiHashes:
      productionQualification?.pluginAuthorityPublicKeySpkiHashes
      || Object.freeze([]),
    qualificationAuthoritySubjectIds:
      productionQualification?.qualificationAuthoritySubjectIds || Object.freeze([]),
    qualificationAuthorityOrganizations:
      productionQualification?.qualificationAuthorityOrganizations
      || Object.freeze([]),
    qualificationAuthorityPublicKeySpkiHashes:
      productionQualification?.qualificationAuthorityPublicKeySpkiHashes
      || Object.freeze([]),
    qualificationAuthorityRoles:
      productionQualification?.qualificationAuthorityRoles || Object.freeze([]),
    evidenceReceiptHashes: Object.freeze({
      ...(productionQualification?.evidenceReceiptHashes || {}),
    }),
    qualificationExpiresAt: productionQualification?.expiresAt || null,
    referenceExecutionProcessIdentityHash:
      productionQualification?.referenceExecutionProcessIdentityHash || null,
    replayExecutionProcessIdentityHash:
      productionQualification?.replayExecutionProcessIdentityHash || null,
    qualificationResultHash: productionQualification?.resultHash || null,
    qualificationRequirement: productionQualified ? null
      : 'signed-reference-replay-oracle-uncertainty-and-scientific-evidence-required',
  });
  const blockedExecution = (blockers, details = {}) => blocked(blockers, {
    pluginId: descriptor.pluginId,
    analysisFamily: descriptor.analysisFamily,
    productionQualified,
    qualificationStatementHash:
      productionQualification?.qualificationStatementHash || null,
    qualificationEvidenceBundleHash:
      productionQualification?.qualificationEvidenceBundleHash || null,
    ...details,
  });
  return assertAdvancedNumericalPluginRunnerPort({
    version: 1,
    kind: 'AdvancedNumericalPluginRunner',
    capabilities: () => capabilities,
    async run({ runId, input, seed, outputDirectory } = {}) {
      const selectedOutputDirectory = path.resolve(String(outputDirectory || ''));
      if (!isPathWithin(selectedOutputRoot, selectedOutputDirectory)) {
        return blockedExecution(['advanced_numerical_plugin_output_scope_invalid']);
      }
      const request = buildAdvancedNumericalPluginRequest({
        descriptor,
        runId,
        input,
        seed,
      });
      fs.mkdirSync(selectedOutputDirectory, { recursive: true, mode: 0o700 });
      const resultPath = path.join(selectedOutputDirectory, 'result.json');
      if (fs.existsSync(resultPath)) {
        return blockedExecution(['advanced_numerical_plugin_result_preexists'], {
          requestHash: request.advancedNumericalPluginRequestHash,
        });
      }
      const executionIdentity = sandbox.resolveExecutionRuntimeIdentity({
        executable: descriptor.runtime.executable,
        ...(gpuRuntimeAuthority ? {
          containerImage: descriptor.runtime.containerImage,
          containerExecutable: descriptor.runtime.containerExecutable,
        } : {}),
      });
      const runtimeIdentityMatches = gpuRuntimeAuthority
        ? executionIdentity?.runtimeType === 'container'
          && executionIdentity?.executionClass === 'explicit-container'
          && executionIdentity?.backend === 'docker'
          && executionIdentity?.requestedImage === descriptor.runtime.containerImage
          && executionIdentity?.digest === descriptor.runtime.containerImageDigest
          && executionIdentity?.containerExecutable
            === descriptor.runtime.containerExecutable
        : observedExecutableHash(executionIdentity)
          === descriptor.runtime.executableHash;
      if (executionIdentity?.available !== true
        || executionIdentity?.allowlisted !== true
        || !runtimeIdentityMatches) {
        return blockedExecution(['advanced_numerical_plugin_runtime_identity_mismatch'], {
          requestHash: request.advancedNumericalPluginRequestHash,
        });
      }
      const requestBase64 = Buffer.from(JSON.stringify(request), 'utf8').toString('base64');
      const absoluteDeadlineEpochMs = Date.now() + descriptor.limits.timeoutMs;
      const workerReceipt = await sandbox.run({
        executable: descriptor.runtime.executable,
        args: [
          entrypointPath,
          '--hepta-request-base64',
          requestBase64,
          '--hepta-output',
          '/output/result.json',
        ],
        cwd: selectedPluginRoot,
        sourceRoot: selectedPluginRoot,
        outputDirectory: selectedOutputDirectory,
        outputPaths: ['result.json'],
        executionIdentity,
        expectedSourceMerkleHash: descriptor.sourceIdentity.merkleHash,
        expectedSourceWorkspaceManifestHash:
          descriptor.sourceIdentity.workspaceManifestHash,
        timeoutMs: descriptor.limits.timeoutMs,
        absoluteDeadlineEpochMs,
        memoryBytes: descriptor.limits.memoryBytes,
        cpuSeconds: descriptor.limits.cpuSeconds,
        maximumProcesses: descriptor.limits.maximumProcesses,
        requestedMaximumOutputBytes: descriptor.limits.maximumOutputBytes,
        requiresGpu: Boolean(gpuRuntimeAuthority),
        gpuDeviceSelector: gpuRuntimeAuthority
          ? descriptor.runtime.gpuDeviceSelector : null,
        ...(gpuRuntimeAuthority ? {
          containerImage: descriptor.runtime.containerImage,
          containerExecutable: descriptor.runtime.containerExecutable,
        } : {}),
        requireSeparateOutputRoot: true,
        requireImmutableWorkRoot: true,
        language: descriptor.runtime.language,
        determinismPolicy: 'seeded-deterministic',
        deterministicSeed: seed,
        runtimePackageClosure: gpuRuntimeAuthority ? Object.freeze({
          basis: 'container_image_digest',
          identityHash: descriptor.runtime.containerImageDigest,
          manifestHash: null,
          observedPackageCount: 0,
        }) : Object.freeze({
          basis: 'signed-plugin-descriptor',
          identityHash: descriptor.runtime.packageClosureHash,
          manifestHash: descriptor.runtime.packageClosureHash,
          observedPackageCount: 0,
        }),
      });
      const isolation = workerReceipt?.isolation || {};
      if (workerReceipt?.ok !== true
        || workerReceipt?.status !== 'os_sandbox_worker_passed'
        || isolation.kernelNetworkIsolationVerified !== true
        || isolation.sourceReadOnlyVerified !== true
        || isolation.resourceLimitsVerified !== true
        || (gpuRuntimeAuthority
          && !gpuRuntimeWorkerReceiptValid(workerReceipt, descriptor))
        || !SHA256.test(String(workerReceipt?.receiptHash || ''))) {
        return blockedExecution([
          'advanced_numerical_plugin_worker_execution_blocked',
          ...(workerReceipt?.blockers || []),
        ], {
          requestHash: request.advancedNumericalPluginRequestHash,
          workerReceipt: workerReceipt || null,
        });
      }
      const resultRead = readScopedFileSync({
        scopeRoot: selectedOutputDirectory,
        candidate: resultPath,
        maximumBytes: Math.min(descriptor.limits.maximumOutputBytes, 4 * 1024 * 1024),
      });
      let result = null;
      try {
        result = resultRead.status === 'scoped_file_read_verified'
          ? JSON.parse(resultRead.content.toString('utf8')) : null;
      } catch {
        result = null;
      }
      if (!verifyAdvancedNumericalPluginResult(result, { descriptor, request })) {
        return blockedExecution(['advanced_numerical_plugin_result_invalid'], {
          requestHash: request.advancedNumericalPluginRequestHash,
          workerReceipt,
          resultReadReceiptHash: resultRead.scopedFileReadReceiptHash,
        });
      }
      const payload = {
        version: gpuRuntimeAuthority ? 2 : 1,
        kind: 'AdvancedNumericalPluginExecutionReceipt',
        status: productionQualified
          ? 'advanced_numerical_plugin_execution_completed_qualified'
          : 'advanced_numerical_plugin_execution_completed_unqualified',
        pluginId: descriptor.pluginId,
        analysisFamily: descriptor.analysisFamily,
        pluginDescriptorHash: descriptor.advancedNumericalPluginDescriptorHash,
        ...(gpuRuntimeAuthority ? {
          gpuRuntimeAuthorityHash:
            gpuRuntimeAuthority.advancedNumericalGpuRuntimeAuthorityHash,
        } : {}),
        signedBundleHash: verifiedBundle.signedBundleHash,
        requestHash: request.advancedNumericalPluginRequestHash,
        resultHash: result.advancedNumericalPluginResultHash,
        workerReceiptHash: workerReceipt.receiptHash,
        workerReceipt,
        result,
        productionQualified,
        qualificationStatementHash:
          productionQualification?.qualificationStatementHash || null,
        qualificationEvidenceBundleHash:
          productionQualification?.qualificationEvidenceBundleHash || null,
        qualificationInspectionHash:
          productionQualification
            ?.advancedNumericalPluginProductionQualificationInspectionHash || null,
        qualificationRequirement: productionQualified ? null
          : 'signed-reference-replay-oracle-uncertainty-and-scientific-evidence-required',
        blockers: Object.freeze([]),
      };
      return Object.freeze({
        ...payload,
        advancedNumericalPluginExecutionReceiptHash:
          hashRecord('AdvancedNumericalPluginExecutionReceipt', payload),
      });
    },
  });
}
