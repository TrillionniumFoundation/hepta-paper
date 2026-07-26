import fs from 'node:fs';
import path from 'node:path';

import {
  ADVANCED_NUMERICAL_PLUGIN_ANALYSIS_FAMILIES,
  buildAdvancedNumericalPluginRequest,
  verifyAdvancedNumericalPluginDescriptor,
  verifyAdvancedNumericalPluginResult,
} from '../../paper-domain/research/advanced-numerical-plugin-contract.mjs';
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
  const sandbox = assertWorkerRunnerPort(workerRunner);
  const sandboxCapabilities = sandbox.capabilities();
  if (!sandboxCapabilities.sandboxModes?.includes('kernel-isolated')
    || sandboxCapabilities.networkPolicy !== 'none'
    || sandboxCapabilities.workspaceIsolation !== true
    || sandboxCapabilities.externalActions !== false) {
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
    productionQualified: false,
    qualificationRequirement:
      'independent-oracle-replay-and-uncertainty-authority-required',
  });
  return assertAdvancedNumericalPluginRunnerPort({
    version: 1,
    kind: 'AdvancedNumericalPluginRunner',
    capabilities: () => capabilities,
    async run({ runId, input, seed, outputDirectory } = {}) {
      const selectedOutputDirectory = path.resolve(String(outputDirectory || ''));
      if (!isPathWithin(selectedOutputRoot, selectedOutputDirectory)) {
        return blocked(['advanced_numerical_plugin_output_scope_invalid']);
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
        return blocked(['advanced_numerical_plugin_result_preexists'], {
          requestHash: request.advancedNumericalPluginRequestHash,
        });
      }
      const executionIdentity = sandbox.resolveExecutionRuntimeIdentity({
        executable: descriptor.runtime.executable,
      });
      if (executionIdentity?.available !== true
        || executionIdentity?.allowlisted !== true
        || observedExecutableHash(executionIdentity)
          !== descriptor.runtime.executableHash) {
        return blocked(['advanced_numerical_plugin_runtime_identity_mismatch'], {
          requestHash: request.advancedNumericalPluginRequestHash,
        });
      }
      const requestBase64 = Buffer.from(JSON.stringify(request), 'utf8').toString('base64');
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
        memoryBytes: descriptor.limits.memoryBytes,
        cpuSeconds: descriptor.limits.cpuSeconds,
        maximumProcesses: descriptor.limits.maximumProcesses,
        requestedMaximumOutputBytes: descriptor.limits.maximumOutputBytes,
        requiresGpu: false,
        requireSeparateOutputRoot: true,
        requireImmutableWorkRoot: true,
        language: descriptor.runtime.language,
        determinismPolicy: 'seeded-deterministic',
        deterministicSeed: seed,
        runtimePackageClosure: Object.freeze({
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
        || !SHA256.test(String(workerReceipt?.receiptHash || ''))) {
        return blocked([
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
        return blocked(['advanced_numerical_plugin_result_invalid'], {
          requestHash: request.advancedNumericalPluginRequestHash,
          workerReceipt,
          resultReadReceiptHash: resultRead.scopedFileReadReceiptHash,
        });
      }
      const payload = {
        version: 1,
        kind: 'AdvancedNumericalPluginExecutionReceipt',
        status: 'advanced_numerical_plugin_execution_completed_unqualified',
        pluginId: descriptor.pluginId,
        analysisFamily: descriptor.analysisFamily,
        pluginDescriptorHash: descriptor.advancedNumericalPluginDescriptorHash,
        signedBundleHash: verifiedBundle.signedBundleHash,
        requestHash: request.advancedNumericalPluginRequestHash,
        resultHash: result.advancedNumericalPluginResultHash,
        workerReceiptHash: workerReceipt.receiptHash,
        workerReceipt,
        result,
        productionQualified: false,
        qualificationRequirement:
          'independent-oracle-replay-and-uncertainty-authority-required',
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
