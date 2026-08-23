import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { AUTOMATION_RUNTIME_IMAGES } from '../automation/runtime-image-registry.mjs';
import {
  buildProcessIsolatedDeepLearningCpuOracleAssurance,
  buildProcessIsolatedDeepLearningCpuOracleRequest,
  DEEP_LEARNING_CPU_ORACLE_RESOURCE_LIMITS,
  verifyDeepLearningCpuOracleResourceBudget,
  verifyProcessIsolatedDeepLearningCpuOracleAssurance,
  verifyProcessIsolatedDeepLearningCpuOracleReceipt,
} from '../../paper-domain/research/process-isolated-deep-learning-independent-cpu-oracle-contract.mjs';
import {
  verifyDeepLearningInlineTrainingDataset,
} from '../../paper-domain/research/deep-learning-training-dataset-contract.mjs';
import {
  verifyDeepLearningTrainingExecutionReceipt,
} from '../../paper-domain/research/deep-learning-training-execution-contract.mjs';
import {
  DEEP_LEARNING_REPLAY_ERROR_BUDGET,
} from './deep-learning-independent-replay.mjs';
import {
  verifyProductionOsSandboxWorkerReceipt,
} from '../../paper-domain/automation/os-sandbox-worker-receipt-contract.mjs';
import {
  inspectWorkspaceExecutionSnapshot,
  sourceTreeExcludedNames,
} from '../runtime/execution-snapshot.mjs';
import {
  currentDeepLearningCpuOracleWorkerImplementation,
} from './independent-deep-learning-cpu-oracle-worker.mjs';
import {
  createDeepLearningCpuOracleSandboxRunner,
  DEEP_LEARNING_CPU_ORACLE_DOCKER_IMAGE,
  DEEP_LEARNING_CPU_ORACLE_MAXIMUM_REQUEST_BYTES,
  DEEP_LEARNING_CPU_ORACLE_MAXIMUM_RESPONSE_BYTES,
} from './deep-learning-cpu-oracle-sandbox-runner-factory.mjs';
import { readTrustedWallClockEpochMs } from '../runtime/trusted-wall-clock.mjs';

const WORKER_PATH = fileURLToPath(new URL(
  './independent-deep-learning-cpu-oracle-worker.mjs',
  import.meta.url,
));
const REPOSITORY_ROOT = path.resolve(path.dirname(WORKER_PATH), '..', '..');

export { DEEP_LEARNING_CPU_ORACLE_DOCKER_IMAGE };

function snapshotJsonObject(value) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const snapshot = JSON.parse(JSON.stringify(value));
    return snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot)
      ? snapshot : null;
  } catch { return null; }
}

function parseWorkerReceipt(sandboxReceipt, { request, workerImplementation }) {
  if (!verifyProductionOsSandboxWorkerReceipt(sandboxReceipt)
    || sandboxReceipt.externalActionPerformed !== false
    || sandboxReceipt.isolation?.gpuAccessRequested !== false) return null;
  let receipt = null;
  try { receipt = JSON.parse(String(sandboxReceipt.stdout || '').trim()); }
  catch { return null; }
  if (!verifyProcessIsolatedDeepLearningCpuOracleReceipt(receipt, {
    request,
    workerImplementation,
  }) || (sandboxReceipt.backend === 'docker'
    && (receipt.workerPid !== 1 || receipt.parentPid !== 0))) return null;
  return Object.freeze(receipt);
}

function buildRequest({
  executionReceipt,
  trainingDataset,
  tensorBundleBytes,
  expectedPredictions,
  expectedMetrics,
  replayRuntimeIdentityHash,
  workerImplementation,
  resourceBudget,
}) {
  if (!Buffer.isBuffer(tensorBundleBytes)) {
    throw new Error('deep_learning_cpu_oracle_tensor_bundle_invalid');
  }
  return buildProcessIsolatedDeepLearningCpuOracleRequest({
    executionReceipt,
    trainingDataset,
    tensorBundleBase64: tensorBundleBytes.toString('base64'),
    expectedPredictions,
    expectedMetrics,
    replayRuntimeIdentityHash,
    workerImplementationHash: workerImplementation.workerImplementationHash,
    workerImplementation,
    errorBudget: DEEP_LEARNING_REPLAY_ERROR_BUDGET,
    resourceBudget,
  });
}

export function runProcessIsolatedDeepLearningIndependentCpuOracle({
  executionReceipt,
  trainingDataset,
  tensorBundleBytes,
  expectedPredictions,
  expectedMetrics,
  replayRuntimeIdentityHash = null,
  resourceBudget = DEEP_LEARNING_CPU_ORACLE_RESOURCE_LIMITS,
  absoluteDeadlineEpochMs,
} = {}) {
  const blockers = [];
  let workerImplementation = null;
  let runner = null;
  let executionIdentity = null;
  let request = null;
  let sandboxReceipt = null;
  const startedAt = readTrustedWallClockEpochMs();
  let effectiveResourceBudget = resourceBudget;
  if (!Number.isSafeInteger(absoluteDeadlineEpochMs)
    || absoluteDeadlineEpochMs <= startedAt) {
    blockers.push('deep_learning_cpu_oracle_absolute_deadline_invalid');
  } else if (verifyDeepLearningCpuOracleResourceBudget(resourceBudget)) {
    effectiveResourceBudget = Object.freeze({
      ...resourceBudget,
      timeoutMs: Math.min(resourceBudget.timeoutMs, absoluteDeadlineEpochMs - startedAt),
    });
  } else {
    blockers.push('deep_learning_cpu_oracle_resource_budget_invalid');
  }
  if (!verifyDeepLearningTrainingExecutionReceipt(executionReceipt)) {
    blockers.push('deep_learning_cpu_oracle_execution_receipt_invalid');
  }
  if (!verifyDeepLearningInlineTrainingDataset(trainingDataset)
    || trainingDataset?.deepLearningTrainingDatasetManifestHash
      !== executionReceipt?.trainingDatasetManifestHash) {
    blockers.push('deep_learning_cpu_oracle_training_dataset_invalid');
  }
  try {
    workerImplementation = currentDeepLearningCpuOracleWorkerImplementation();
  } catch {
    blockers.push('deep_learning_cpu_oracle_worker_implementation_invalid');
  }
  if (!blockers.length) {
    try {
      runner = createDeepLearningCpuOracleSandboxRunner(effectiveResourceBudget);
      executionIdentity = runner.resolveExecutionRuntimeIdentity({
        executable: process.execPath,
      });
      if (!executionIdentity?.available || !executionIdentity?.allowlisted
        || executionIdentity.digest
          !== AUTOMATION_RUNTIME_IMAGES.python.imageDigest) {
        throw new Error('deep_learning_cpu_oracle_runtime_identity_unavailable');
      }
      request = buildRequest({
        executionReceipt,
        trainingDataset,
        tensorBundleBytes,
        expectedPredictions,
        expectedMetrics,
        replayRuntimeIdentityHash: replayRuntimeIdentityHash
          || executionIdentity.runtimeIdentityHash,
        workerImplementation,
        resourceBudget: effectiveResourceBudget,
      });
    } catch (error) {
      blockers.push(String(error?.message || 'deep_learning_cpu_oracle_request_invalid'));
    }
  }
  let encoded = '';
  if (request) {
    try { encoded = `${JSON.stringify(request)}\n`; }
    catch { blockers.push('deep_learning_cpu_oracle_request_serialization_invalid'); }
    if (Buffer.byteLength(encoded) > DEEP_LEARNING_CPU_ORACLE_MAXIMUM_REQUEST_BYTES) {
      blockers.push('deep_learning_cpu_oracle_request_too_large');
    }
  }
  if (!blockers.length) {
    try {
      const remainingMs = absoluteDeadlineEpochMs - readTrustedWallClockEpochMs();
      if (remainingMs < 1) throw new Error('deep_learning_cpu_oracle_deadline_exhausted');
      const sourceIdentity = inspectWorkspaceExecutionSnapshot(REPOSITORY_ROOT, {
        excludeNames: sourceTreeExcludedNames(REPOSITORY_ROOT),
      });
      if (sourceIdentity.blockers.length) {
        throw new Error('deep_learning_cpu_oracle_source_closure_invalid');
      }
      sandboxReceipt = snapshotJsonObject(runner.run({
        executable: process.execPath,
        args: [WORKER_PATH],
        cwd: REPOSITORY_ROOT,
        sourceRoot: REPOSITORY_ROOT,
        expectedSourceMerkleHash: sourceIdentity.merkleHash,
        expectedSourceWorkspaceManifestHash: sourceIdentity.manifestHash,
        executionIdentity,
        timeoutMs: effectiveResourceBudget.timeoutMs,
        absoluteDeadlineEpochMs,
        env: {
          OMP_NUM_THREADS: '1',
          OPENBLAS_NUM_THREADS: '1',
          MKL_NUM_THREADS: '1',
          NUMEXPR_NUM_THREADS: '1',
          BLIS_NUM_THREADS: '1',
          VECLIB_MAXIMUM_THREADS: '1',
          OMP_DYNAMIC: 'FALSE',
          MKL_DYNAMIC: 'FALSE',
        },
        standardInput: encoded,
        requireImmutableWorkRoot: true,
        language: 'node',
        determinismPolicy: 'explicit_deterministic_cpu',
        deterministicSeed: request.requestHash,
        memoryBytes: effectiveResourceBudget.memoryBytes,
        cpuSeconds: effectiveResourceBudget.cpuSeconds,
        maximumProcesses: effectiveResourceBudget.maximumProcesses,
        requestedMaximumOutputBytes: DEEP_LEARNING_CPU_ORACLE_MAXIMUM_RESPONSE_BYTES,
        runtimePackageClosure: Object.freeze({
          basis: 'container_image_digest',
          identityHash: AUTOMATION_RUNTIME_IMAGES.python.imageDigest,
          manifestHash: null,
          observedPackageCount: 0,
        }),
        runtimeBuildReproducibility: AUTOMATION_RUNTIME_IMAGES.python.buildReproducibility,
      }));
    } catch { sandboxReceipt = null; }
  }
  let sandboxVerified = false;
  try { sandboxVerified = verifyProductionOsSandboxWorkerReceipt(sandboxReceipt); }
  catch { sandboxVerified = false; }
  if (request && !sandboxVerified) {
    blockers.push('deep_learning_cpu_oracle_production_os_sandbox_invalid');
    if (Array.isArray(sandboxReceipt?.blockers)) {
      blockers.push(...sandboxReceipt.blockers.map(
        (blocker) => `deep_learning_cpu_oracle_os_sandbox:${blocker}`,
      ));
    }
  }
  const workerReceipt = request && sandboxVerified
    ? parseWorkerReceipt(sandboxReceipt, { request, workerImplementation }) : null;
  if (request && !workerReceipt) blockers.push('deep_learning_cpu_oracle_worker_receipt_invalid');
  if (readTrustedWallClockEpochMs() >= absoluteDeadlineEpochMs) {
    blockers.push('deep_learning_cpu_oracle_absolute_deadline_exceeded');
  }
  return buildProcessIsolatedDeepLearningCpuOracleAssurance({
    request,
    workerImplementation,
    workerReceipt,
    osSandboxWorkerReceipt: sandboxReceipt,
    absoluteDeadlineEpochMs,
    blockers,
  });
}

export function verifyProcessIsolatedDeepLearningCpuOracleAgainstRequest(
  assurance,
  {
    executionReceipt,
    trainingDataset,
    tensorBundleBytes,
    expectedPredictions,
    expectedMetrics,
  } = {},
) {
  try {
    const workerImplementation = currentDeepLearningCpuOracleWorkerImplementation();
    const request = buildRequest({
      executionReceipt,
      trainingDataset,
      tensorBundleBytes,
      expectedPredictions,
      expectedMetrics,
      replayRuntimeIdentityHash: assurance?.oracleRuntimeIdentityHash,
      workerImplementation,
      resourceBudget: assurance?.resourceBudget,
    });
    const sourceIdentity = inspectWorkspaceExecutionSnapshot(REPOSITORY_ROOT, {
      excludeNames: sourceTreeExcludedNames(REPOSITORY_ROOT),
    });
    return sourceIdentity.blockers.length === 0
      && assurance?.osSandboxWorkerReceipt?.expectedSourceMerkleHash
        === sourceIdentity.merkleHash
      && assurance?.osSandboxWorkerReceipt?.expectedSourceWorkspaceManifestHash
        === sourceIdentity.manifestHash
      && verifyProcessIsolatedDeepLearningCpuOracleAssurance(assurance, {
        request,
        workerImplementation,
      });
  } catch { return false; }
}
