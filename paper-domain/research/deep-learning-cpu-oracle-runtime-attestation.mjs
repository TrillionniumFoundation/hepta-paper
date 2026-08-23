import { hasExactObjectKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  SYSTEM_DATASET_ACCESS_RUNTIME_IMAGES,
} from '../automation/dataset-access-supervisor-policy.mjs';
import {
  verifyProductionOsSandboxWorkerReceipt,
} from '../automation/os-sandbox-worker-receipt-contract.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const ATTESTATION_KEYS = Object.freeze([
  'arguments', 'assuranceScope', 'deepLearningCpuOracleRuntimeAttestationHash',
  'executionProcessInvocationHash', 'executionSourceMerkleHash',
  'executionSourceWorkspaceManifestHash', 'executableTarget', 'kind',
  'processInvocationId', 'registeredWorkerImplementationHash',
  'registeredWorkerSourceManifestHash', 'requestHash', 'runtimeExecutableSnapshotHash',
  'runtimeIdentityHash', 'runtimeImageDigest', 'runtimePackageClosureHash',
  'sourceClosurePolicy', 'standardInputByteLength', 'standardInputHash', 'status',
  'version', 'workerReceiptHash', 'workingDirectory',
]);

export const DEEP_LEARNING_CPU_ORACLE_EXECUTABLE_TARGET = '/usr/bin/node';
export const DEEP_LEARNING_CPU_ORACLE_ARGUMENTS = Object.freeze([
  '/work/paper-adapters/research-verify/independent-deep-learning-cpu-oracle-worker.mjs',
]);
export const DEEP_LEARNING_CPU_ORACLE_WORKING_DIRECTORY = '/work';
export const DEEP_LEARNING_CPU_ORACLE_SOURCE_CLOSURE_POLICY =
  'complete-repository-snapshot-plus-registered-worker-import-closure-v1';

function sha(value) {
  return SHA256.test(String(value || ''));
}

function exactExecutionSource(receipt, invocation) {
  const merkle = receipt?.expectedSourceMerkleHash;
  const manifest = receipt?.expectedSourceWorkspaceManifestHash;
  return sha(merkle) && sha(manifest)
    && invocation?.sourceMerkleHash === merkle
    && invocation?.sourceWorkspaceManifestHash === manifest
    && receipt.sourceMerkleHashBefore === merkle
    && receipt.sourceMerkleHashAfter === merkle
    && receipt.workSourceMerkleHash === merkle
    && receipt.sourceWorkspaceManifestHashBefore === manifest
    && receipt.sourceWorkspaceManifestHashAfter === manifest
    && receipt.workWorkspaceManifestHash === manifest;
}

function canonicalInput(request) {
  const bytes = Buffer.from(`${JSON.stringify(request)}\n`, 'utf8');
  return Object.freeze({ byteLength: bytes.length, sha256: hashBytes(bytes) });
}

export function buildDeepLearningCpuOracleRuntimeAttestation({
  assuranceScope,
  request,
  workerImplementation,
  workerReceipt,
  osSandboxWorkerReceipt,
} = {}) {
  const receipt = osSandboxWorkerReceipt;
  const invocation = receipt?.executionProcessInvocation;
  const input = canonicalInput(request);
  if (typeof assuranceScope !== 'string' || !assuranceScope
    || !sha(request?.requestHash)
    || !sha(workerImplementation?.workerImplementationHash)
    || !sha(workerImplementation?.sourceManifestHash)
    || !verifyProductionOsSandboxWorkerReceipt(receipt)
    || receipt.backend !== 'docker'
    || receipt.containerImage !== `${SYSTEM_DATASET_ACCESS_RUNTIME_IMAGES.python.image}`
      + `@${SYSTEM_DATASET_ACCESS_RUNTIME_IMAGES.python.imageDigest}`
    || receipt.containerImageDigest
      !== SYSTEM_DATASET_ACCESS_RUNTIME_IMAGES.python.imageDigest
    || receipt.environmentBom?.runtime?.packageClosure?.basis
      !== 'container_image_digest'
    || receipt.environmentBom?.runtime?.packageClosure?.identityHash
      !== SYSTEM_DATASET_ACCESS_RUNTIME_IMAGES.python.imageDigest
    || receipt.runtimeIdentityHash !== request.replayRuntimeIdentityHash
    || !sha(receipt.runtimeExecutableSnapshotHash)
    || workerReceipt?.requestHash !== request.requestHash
    || !sha(workerReceipt?.deepLearningIndependentCpuOracleReceiptHash)
    || workerReceipt.workerPid !== 1 || workerReceipt.parentPid !== 0
    || JSON.stringify(workerReceipt) !== String(receipt.stdout || '').trim()
    || request.resourceBudget?.timeoutMs !== receipt.limits?.timeoutMs
    || request.resourceBudget?.memoryBytes !== receipt.limits?.memoryBytes
    || request.resourceBudget?.cpuSeconds !== receipt.limits?.cpuSeconds
    || request.resourceBudget?.maximumProcesses !== receipt.limits?.maximumPids
    || invocation?.executableTarget !== DEEP_LEARNING_CPU_ORACLE_EXECUTABLE_TARGET
    || JSON.stringify(invocation?.arguments)
      !== JSON.stringify(DEEP_LEARNING_CPU_ORACLE_ARGUMENTS)
    || invocation?.workingDirectory !== DEEP_LEARNING_CPU_ORACLE_WORKING_DIRECTORY
    || invocation?.standardInput?.present !== true
    || invocation.standardInput.sha256 !== input.sha256
    || invocation.standardInput.byteLength !== input.byteLength
    || !sha(receipt.executionProcessInvocationHash)
    || !exactExecutionSource(receipt, invocation)
    || receipt.isolation?.gpuAccessRequested !== false
    || receipt.externalActionPerformed !== false) {
    throw new Error('deep_learning_cpu_oracle_runtime_attestation_invalid');
  }
  const payload = {
    version: 1,
    kind: 'DeepLearningCpuOracleRuntimeAttestation',
    status: 'deep_learning_cpu_oracle_runtime_attested',
    assuranceScope,
    requestHash: request.requestHash,
    workerReceiptHash: workerReceipt.deepLearningIndependentCpuOracleReceiptHash,
    runtimeImageDigest: receipt.containerImageDigest,
    runtimePackageClosureHash:
      receipt.environmentBom.runtime.packageClosure.identityHash,
    runtimeIdentityHash: receipt.runtimeIdentityHash,
    runtimeExecutableSnapshotHash: receipt.runtimeExecutableSnapshotHash,
    processInvocationId: invocation.processInvocationId,
    executionProcessInvocationHash: receipt.executionProcessInvocationHash,
    executableTarget: invocation.executableTarget,
    arguments: DEEP_LEARNING_CPU_ORACLE_ARGUMENTS,
    workingDirectory: invocation.workingDirectory,
    standardInputHash: input.sha256,
    standardInputByteLength: input.byteLength,
    executionSourceMerkleHash: receipt.expectedSourceMerkleHash,
    executionSourceWorkspaceManifestHash: receipt.expectedSourceWorkspaceManifestHash,
    registeredWorkerImplementationHash: workerImplementation.workerImplementationHash,
    registeredWorkerSourceManifestHash: workerImplementation.sourceManifestHash,
    sourceClosurePolicy: DEEP_LEARNING_CPU_ORACLE_SOURCE_CLOSURE_POLICY,
  };
  return Object.freeze({
    ...payload,
    deepLearningCpuOracleRuntimeAttestationHash: hashRecord(
      'DeepLearningCpuOracleRuntimeAttestation', payload,
    ),
  });
}

export function verifyDeepLearningCpuOracleRuntimeAttestation(value, options = {}) {
  if (!hasExactObjectKeys(value, ATTESTATION_KEYS)) return false;
  try {
    return JSON.stringify(buildDeepLearningCpuOracleRuntimeAttestation(options))
      === JSON.stringify(value);
  } catch { return false; }
}
