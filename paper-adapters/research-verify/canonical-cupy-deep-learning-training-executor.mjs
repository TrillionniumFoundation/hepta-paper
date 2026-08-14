import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AUTOMATION_RUNTIME_IMAGES,
} from '../automation/runtime-image-registry.mjs';
import {
  inspectWorkspaceExecutionSnapshot,
} from '../runtime/execution-snapshot.mjs';
import { readTrustedWallClockEpochMs } from '../runtime/trusted-wall-clock.mjs';
import {
  verifyProductionOsSandboxWorkerReceipt,
} from '../../paper-domain/automation/os-sandbox-worker-receipt-contract.mjs';
import {
  deepFreezeJsonValue,
} from '../../workflow-kernel/deep-freeze-json-value.mjs';
import {
  hashBytes,
  hashRecord,
} from '../../workflow-kernel/record-hash.mjs';
import {
  inspectScopedPathSync,
} from '../../workflow-kernel/runtime/scoped-file-identity.mjs';
import { isPathWithin } from '../../workflow-kernel/runtime/path-utils.mjs';
import {
  exactPlainObject,
  jsonEqual,
  requiredDeepLearningHash,
  requiredDeepLearningId,
} from '../../paper-domain/research/deep-learning-contract-primitives.mjs';
import {
  DETERMINISTIC_SUPERVISED_CLASSIFICATION_GPU_PROFILE,
  verifyDeterministicSupervisedClassificationGpuProfile,
} from '../../paper-domain/research/deep-learning-gpu-profile-contract.mjs';
import {
  verifyDeterministicSupervisedClassificationModelIr,
} from '../../paper-domain/research/deep-learning-model-ir-contract.mjs';
import {
  verifyDeepLearningInlineTrainingDataset,
} from '../../paper-domain/research/deep-learning-training-dataset-contract.mjs';
import {
  verifyCanonicalSyntheticDeepLearningDatasetAuthority,
} from '../../paper-domain/research/deep-learning-training-dataset-authority-contract.mjs';
import {
  verifyDeepLearningTrainingExecutionReceipt,
} from '../../paper-domain/research/deep-learning-training-execution-contract.mjs';
import {
  buildCanonicalCupyDeepLearningGpuDispatchMemoryAdmission,
  buildCanonicalCupyDeepLearningGpuMemoryCapacityPlan,
  verifyCanonicalCupyDeepLearningGpuMemoryCapacityPlanBinding,
} from '../../paper-domain/research/deep-learning-gpu-memory-capacity-contract.mjs';
import {
  assertDeepLearningGpuTrainingExecutorPort,
} from '../../paper-ports/deep-learning-gpu-training-ports.mjs';
import {
  createCanonicalCupyDeepLearningSandboxRunner,
} from './canonical-cupy-deep-learning-sandbox-runner-factory.mjs';
import {
  canonicalDeepLearningArtifactByPath,
  CANONICAL_CUPY_DEEP_LEARNING_OUTPUT_PATHS,
  inspectCanonicalCupyDeepLearningArtifacts,
} from './canonical-cupy-deep-learning-artifact-verifier.mjs';
import {
  buildBlockedCanonicalCupyDeepLearningExecution as blockedExecution,
  removeOwnedCanonicalCupyDeepLearningOutput as removeOwnedOutputDirectory,
} from './canonical-cupy-deep-learning-execution-support.mjs';

const GPU_UUID = /^GPU-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const RECEIPT_KEYS = Object.freeze([
  'absoluteDeadlineEpochMs', 'artifacts', 'blockers',
  'canonicalCupyDeepLearningTrainingReceiptHash',
  'environmentBomHash', 'executionAuthorityHash', 'externalActionPerformed',
  'finiteTensorScanReceipt',
  'finiteTensorScanReceiptHash', 'gpuCapacityObservationHash',
  'gpuDeviceSelectorHash', 'gpuMemoryCapacityPlan', 'gpuMemoryCapacityPlanHash',
  'hiddenEvaluatorAuthorityBound',
  'kind', 'modelIrHash', 'modelSpecificationArtifactHash', 'networkActionPerformed',
  'estimatedPeakVramBytes', 'maximumQualifiedGpuWorkingSetBytes',
  'observedGpuTotalMemoryBytes',
  'predictorAuthorityBound', 'productionPromotionEligible', 'profileHash',
  'runtimeBomHash', 'status', 'trainerImplementationMerkleHash',
  'trainerImplementationWorkspaceManifestHash', 'trainingDatasetAuthority',
  'trainingDatasetAuthorityHash', 'trainingDatasetManifestHash',
  'trainingRequestHash', 'trainingRequestStandardInputByteLength',
  'trainingRequestStandardInputHash',
  'trainingExecutionReceipt', 'trainingExecutionReceiptHash',
  'trainingPredictionsArtifactHash', 'trainingRunId', 'trainingSummaryArtifactHash',
  'version', 'workerArtifactManifestHash', 'workerReceipt', 'workerReceiptHash',
  'workerResourceLimits',
]);
const FINITE_SCAN_KEYS = Object.freeze([
  'checkpointArtifactHash', 'deepLearningFiniteTensorScanReceiptHash', 'kind',
  'status', 'tensorSetHash', 'tensors', 'version',
]);
const WORKER_RESOURCE_LIMIT_KEYS = Object.freeze([
  'cpuSeconds', 'maximumOutputBytes', 'maximumProcesses', 'memoryBytes',
  'timeoutMs',
]);
const MAXIMUM_PARAMETER_COUNT = 2_000_000;
const MAXIMUM_TRAINING_STEPS = 1_000_000;
const MAXIMUM_INPUT_BYTES = 64 * 1024 * 1024;
export const CANONICAL_CUPY_DEEP_LEARNING_NON_PROMOTION_BLOCKERS = Object.freeze([
  'deep_learning_trainer_release_manifest_authority_unavailable',
  'deep_learning_gpu_runtime_qualification_authority_unavailable',
  'deep_learning_independent_finite_tensor_authority_unavailable',
  'deep_learning_predictor_authority_unavailable',
  'deep_learning_hidden_evaluator_authority_unavailable',
  'deep_learning_independent_same_device_replay_authority_unavailable',
]);
const EXECUTOR_OPTION_KEYS = new Set([
  'cpuSeconds', 'maximumOutputBytes', 'maximumProcesses', 'memoryBytes',
  'outputRoot', 'timeoutMs',
]);

export const CANONICAL_CUPY_DEEP_LEARNING_TRAINER_ROOT = fileURLToPath(
  new URL('./deep-learning-training-worker/', import.meta.url),
);
export const CANONICAL_CUPY_DEEP_LEARNING_TRAINER_PATH = fileURLToPath(
  new URL('./deep-learning-training-worker/canonical_cupy_mlp_trainer.py', import.meta.url),
);
const TRAINER_SOURCE_IDENTITY = inspectWorkspaceExecutionSnapshot(
  CANONICAL_CUPY_DEEP_LEARNING_TRAINER_ROOT,
);
if (TRAINER_SOURCE_IDENTITY.blockers.length) {
  throw new Error('canonical_cupy_deep_learning_trainer_source_invalid');
}

export const CANONICAL_CUPY_DEEP_LEARNING_TRAINER_IDENTITY = Object.freeze({
  merkleHash: TRAINER_SOURCE_IDENTITY.merkleHash,
  workspaceManifestHash: TRAINER_SOURCE_IDENTITY.manifestHash,
});
const CANONICAL_TRAINER_SANDBOX_PATH = `/work/${path.relative(
  CANONICAL_CUPY_DEEP_LEARNING_TRAINER_ROOT,
  CANONICAL_CUPY_DEEP_LEARNING_TRAINER_PATH,
).split(path.sep).join('/')}`;
const CANONICAL_TRAINER_ARGUMENTS = Object.freeze([
  CANONICAL_TRAINER_SANDBOX_PATH, '--output', '/output',
]);

function verifyExactWorkerReceipt(
  workerReceipt,
  gpuDeviceSelector = workerReceipt?.gpuDeviceRequest?.deviceSelector,
  expectedInput = {},
) {
  const expectedLimits = expectedInput.workerResourceLimits;
  const expectedAdmission = buildCanonicalCupyDeepLearningGpuDispatchMemoryAdmission(
    expectedInput.gpuMemoryCapacityPlan,
  );
  return verifyProductionOsSandboxWorkerReceipt(workerReceipt)
    && workerReceipt.backend === 'docker'
    && workerReceipt.containerImage === AUTOMATION_RUNTIME_IMAGES.pythonGpu.image
    && workerReceipt.containerImageDigest
      === AUTOMATION_RUNTIME_IMAGES.pythonGpu.imageDigest
    && workerReceipt.gpuDeviceRequest?.required === true
    && workerReceipt.gpuDeviceRequest?.requestedDeviceCount === 1
    && workerReceipt.gpuDeviceRequest?.version === 3
    && workerReceipt.gpuDeviceRequest?.deviceSelector === gpuDeviceSelector
    && workerReceipt.gpuDeviceRequest?.observedTotalMemoryBytes
      === expectedInput.gpuMemoryCapacityPlan?.observedGpuTotalMemoryBytes
    && jsonEqual(workerReceipt.gpuDeviceRequest
      ?.dispatchMemoryAdmissionRequirement, expectedAdmission)
    && workerReceipt.gpuDeviceRequest
      ?.dispatchMemoryAdmissionEvaluation?.admissionSatisfied === true
    && workerReceipt.executionProcessInvocation?.executableTarget
      === AUTOMATION_RUNTIME_IMAGES.pythonGpu.executable
    && jsonEqual(
      workerReceipt.executionProcessInvocation?.arguments,
      CANONICAL_TRAINER_ARGUMENTS,
    )
    && workerReceipt.executionProcessInvocation?.workingDirectory === '/work'
    && workerReceipt.executionProcessInvocation?.standardInput?.present === true
    && workerReceipt.executionProcessInvocation?.standardInput?.sha256
      === expectedInput.standardInputHash
    && workerReceipt.executionProcessInvocation?.standardInput?.byteLength
      === expectedInput.standardInputByteLength
    && workerReceipt.limits?.timeoutMs === expectedLimits?.timeoutMs
    && workerReceipt.limits?.memoryBytes === expectedLimits?.memoryBytes
    && workerReceipt.limits?.cpuSeconds === expectedLimits?.cpuSeconds
    && workerReceipt.limits?.maximumPids === expectedLimits?.maximumProcesses
    && workerReceipt.limits?.maximumOutputBytes === expectedLimits?.maximumOutputBytes
    && workerReceipt.expectedSourceMerkleHash
      === CANONICAL_CUPY_DEEP_LEARNING_TRAINER_IDENTITY.merkleHash
    && workerReceipt.expectedSourceWorkspaceManifestHash
      === CANONICAL_CUPY_DEEP_LEARNING_TRAINER_IDENTITY.workspaceManifestHash
    && workerReceipt.sourceMerkleHashBefore
      === CANONICAL_CUPY_DEEP_LEARNING_TRAINER_IDENTITY.merkleHash
    && workerReceipt.sourceMerkleHashAfter
      === CANONICAL_CUPY_DEEP_LEARNING_TRAINER_IDENTITY.merkleHash
    && workerReceipt.workSourceMerkleHash
      === CANONICAL_CUPY_DEEP_LEARNING_TRAINER_IDENTITY.merkleHash
    && workerReceipt.sourceWorkspaceManifestHashBefore
      === CANONICAL_CUPY_DEEP_LEARNING_TRAINER_IDENTITY.workspaceManifestHash
    && workerReceipt.sourceWorkspaceManifestHashAfter
      === CANONICAL_CUPY_DEEP_LEARNING_TRAINER_IDENTITY.workspaceManifestHash
    && workerReceipt.workWorkspaceManifestHash
      === CANONICAL_CUPY_DEEP_LEARNING_TRAINER_IDENTITY.workspaceManifestHash
    && jsonEqual(workerReceipt.datasetMounts, [])
    && workerReceipt.datasetAccessReceipt?.status === 'dataset_runtime_access_not_required'
    && jsonEqual(workerReceipt.datasetAccessReceipt?.datasets, [])
    && workerReceipt.datasetAccessReceipt?.supervisor === null
    && workerReceipt.datasetAccessReceipt?.traceSha256 === null
    && workerReceipt.datasetAccessSupervisorIdentityHash === null
    && workerReceipt.externalActionPerformed === false
    && jsonEqual(workerReceipt.declaredOutputPaths,
      CANONICAL_CUPY_DEEP_LEARNING_OUTPUT_PATHS)
    && workerReceipt.artifacts?.length
      === CANONICAL_CUPY_DEEP_LEARNING_OUTPUT_PATHS.length
    && CANONICAL_CUPY_DEEP_LEARNING_OUTPUT_PATHS.every((selected) => (
      workerReceipt.artifacts.filter((artifact) => artifact.path === selected).length === 1
    ));
}

function buildCanonicalReceipt({
  trainingRunId,
  modelIr,
  trainingDataset,
  trainingDatasetAuthority,
  gpuMemoryCapacityPlan,
  workerReceipt,
  finiteScan,
  requestHash,
  standardInputByteLength,
  standardInputHash,
  trainingExecutionReceipt,
  absoluteDeadlineEpochMs,
  executionAuthorityHash,
  workerResourceLimits,
} = {}) {
  const payload = {
    version: 1,
    kind: 'CanonicalCupyDeepLearningTrainingReceipt',
    status: 'canonical_cupy_deep_learning_training_recorded_non_promotable',
    trainingRunId,
    absoluteDeadlineEpochMs,
    executionAuthorityHash,
    profileHash: modelIr.profileHash,
    modelIrHash: modelIr.deepLearningModelIrHash,
    trainingDatasetManifestHash:
      trainingDataset.deepLearningTrainingDatasetManifestHash,
    trainingDatasetAuthorityHash:
      trainingDatasetAuthority.deepLearningTrainingDatasetAuthorityHash,
    trainingDatasetAuthority,
    trainingRequestHash: requestHash,
    trainingRequestStandardInputHash: standardInputHash,
    trainingRequestStandardInputByteLength: standardInputByteLength,
    gpuDeviceSelectorHash: hashRecord('DeepLearningGpuDeviceUuid', {
      gpuDeviceSelector: workerReceipt.gpuDeviceRequest.deviceSelector,
    }),
    gpuCapacityObservationHash: gpuMemoryCapacityPlan.gpuCapacityObservationHash,
    gpuMemoryCapacityPlanHash: gpuMemoryCapacityPlan.gpuMemoryCapacityPlanHash,
    gpuMemoryCapacityPlan,
    observedGpuTotalMemoryBytes: gpuMemoryCapacityPlan.observedGpuTotalMemoryBytes,
    estimatedPeakVramBytes: gpuMemoryCapacityPlan.estimatedPeakVramBytes,
    maximumQualifiedGpuWorkingSetBytes:
      gpuMemoryCapacityPlan.maximumQualifiedWorkingSetBytes,
    trainerImplementationMerkleHash:
      CANONICAL_CUPY_DEEP_LEARNING_TRAINER_IDENTITY.merkleHash,
    trainerImplementationWorkspaceManifestHash:
      CANONICAL_CUPY_DEEP_LEARNING_TRAINER_IDENTITY.workspaceManifestHash,
    workerReceiptHash: workerReceipt.receiptHash,
    workerReceipt,
    workerResourceLimits,
    environmentBomHash: workerReceipt.environmentBomHash,
    workerArtifactManifestHash: workerReceipt.artifactManifestHash,
    artifacts: workerReceipt.artifacts,
    finiteTensorScanReceiptHash:
      finiteScan.deepLearningFiniteTensorScanReceiptHash,
    finiteTensorScanReceipt: finiteScan,
    runtimeBomHash: trainingExecutionReceipt.runtimeBomHash,
    trainingExecutionReceiptHash:
      trainingExecutionReceipt.deepLearningTrainingExecutionReceiptHash,
    trainingExecutionReceipt,
    modelSpecificationArtifactHash:
      canonicalDeepLearningArtifactByPath(workerReceipt, 'model-spec.json').sha256,
    trainingSummaryArtifactHash:
      canonicalDeepLearningArtifactByPath(workerReceipt, 'training-summary.json').sha256,
    trainingPredictionsArtifactHash:
      canonicalDeepLearningArtifactByPath(workerReceipt, 'training-predictions.json').sha256,
    predictorAuthorityBound: false,
    hiddenEvaluatorAuthorityBound: false,
    productionPromotionEligible: false,
    blockers: CANONICAL_CUPY_DEEP_LEARNING_NON_PROMOTION_BLOCKERS,
    networkActionPerformed: false,
    externalActionPerformed: false,
  };
  return deepFreezeJsonValue({
    ...payload,
    canonicalCupyDeepLearningTrainingReceiptHash:
      hashRecord('CanonicalCupyDeepLearningTrainingReceipt', payload),
  });
}

export function verifyCanonicalCupyDeepLearningTrainingReceipt(value) {
  try {
    if (!exactPlainObject(value, RECEIPT_KEYS)
      || value.version !== 1
      || value.kind !== 'CanonicalCupyDeepLearningTrainingReceipt'
      || value.status !== 'canonical_cupy_deep_learning_training_recorded_non_promotable'
      || value.productionPromotionEligible !== false
      || value.predictorAuthorityBound !== false
      || value.hiddenEvaluatorAuthorityBound !== false
      || value.networkActionPerformed !== false
      || value.externalActionPerformed !== false
      || (value.executionAuthorityHash !== null
        && !requiredDeepLearningHash(value.executionAuthorityHash))
      || !jsonEqual(
        value.blockers,
        CANONICAL_CUPY_DEEP_LEARNING_NON_PROMOTION_BLOCKERS,
      )
      || !requiredDeepLearningId(value.trainingRunId)
      || !Number.isSafeInteger(value.absoluteDeadlineEpochMs)
      || value.absoluteDeadlineEpochMs < 1
      || !exactPlainObject(value.workerResourceLimits, WORKER_RESOURCE_LIMIT_KEYS)
      || !Object.values(value.workerResourceLimits).every(
        (item) => Number.isSafeInteger(item) && item > 0,
      )
      || !verifyExactWorkerReceipt(value.workerReceipt, undefined, {
        standardInputHash: value.trainingRequestStandardInputHash,
        standardInputByteLength: value.trainingRequestStandardInputByteLength,
        gpuMemoryCapacityPlan: value.gpuMemoryCapacityPlan,
        workerResourceLimits: value.workerResourceLimits,
      })
      || !requiredDeepLearningHash(value.trainingRequestHash)
      || !requiredDeepLearningHash(value.trainingRequestStandardInputHash)
      || !Number.isSafeInteger(value.trainingRequestStandardInputByteLength)
      || value.trainingRequestStandardInputByteLength < 1
      || value.trainingRequestHash !== hashRecord(
        'CanonicalCupyMlpTrainingRequestInvocation', {
          standardInputHash: value.trainingRequestStandardInputHash,
          standardInputByteLength: value.trainingRequestStandardInputByteLength,
        },
      )
      || value.workerReceiptHash !== value.workerReceipt.receiptHash
      || value.environmentBomHash !== value.workerReceipt.environmentBomHash
      || value.workerArtifactManifestHash !== value.workerReceipt.artifactManifestHash
      || !jsonEqual(value.artifacts, value.workerReceipt.artifacts)
      || value.gpuDeviceSelectorHash !== hashRecord('DeepLearningGpuDeviceUuid', {
        gpuDeviceSelector: value.workerReceipt.gpuDeviceRequest.deviceSelector,
      })
      || !verifyCanonicalCupyDeepLearningGpuMemoryCapacityPlanBinding(
        value.gpuMemoryCapacityPlan,
        {
          modelIr: value.trainingExecutionReceipt?.modelIr,
          trainingDatasetManifestHash: value.trainingDatasetManifestHash,
          gpuCapacityObservation: value.gpuMemoryCapacityPlan.gpuCapacityObservation,
        },
      )
      || value.gpuMemoryCapacityPlan.capacitySatisfied !== true
      || value.gpuMemoryCapacityPlanHash
        !== value.gpuMemoryCapacityPlan.gpuMemoryCapacityPlanHash
      || value.gpuCapacityObservationHash
        !== value.gpuMemoryCapacityPlan.gpuCapacityObservationHash
      || value.observedGpuTotalMemoryBytes
        !== value.gpuMemoryCapacityPlan.observedGpuTotalMemoryBytes
      || value.estimatedPeakVramBytes
        !== value.gpuMemoryCapacityPlan.estimatedPeakVramBytes
      || value.maximumQualifiedGpuWorkingSetBytes
        !== value.gpuMemoryCapacityPlan.maximumQualifiedWorkingSetBytes
      || value.trainerImplementationMerkleHash
        !== CANONICAL_CUPY_DEEP_LEARNING_TRAINER_IDENTITY.merkleHash
      || value.trainerImplementationWorkspaceManifestHash
        !== CANONICAL_CUPY_DEEP_LEARNING_TRAINER_IDENTITY.workspaceManifestHash
      || !verifyDeepLearningTrainingExecutionReceipt(value.trainingExecutionReceipt)
      || value.trainingExecutionReceiptHash
        !== value.trainingExecutionReceipt.deepLearningTrainingExecutionReceiptHash
      || value.runtimeBomHash !== value.trainingExecutionReceipt.runtimeBomHash
      || value.trainingRunId !== value.trainingExecutionReceipt.trainingRunId
      || value.profileHash !== value.trainingExecutionReceipt.profileHash
      || value.modelIrHash !== value.trainingExecutionReceipt.modelIrHash
      || value.trainingDatasetManifestHash
        !== value.trainingExecutionReceipt.trainingDatasetManifestHash
      || !verifyCanonicalSyntheticDeepLearningDatasetAuthority(
        value.trainingDatasetAuthority,
      )
      || value.trainingDatasetAuthorityHash
        !== value.trainingDatasetAuthority.deepLearningTrainingDatasetAuthorityHash
      || value.trainingDatasetAuthority.trainingDatasetManifestHash
        !== value.trainingDatasetManifestHash
      || value.trainingExecutionReceipt.runtimeBom.runtimeImageDigest
        !== value.workerReceipt.containerImageDigest
      || value.trainingExecutionReceipt.runtimeBom.packageClosureHash
        !== value.workerReceipt.environmentBom.runtime.packageClosure.identityHash
      || value.trainingExecutionReceipt.modelIr.seed
        !== Number(value.workerReceipt.executionBindings.HEPTA_SEED)
      || !exactPlainObject(value.finiteTensorScanReceipt, FINITE_SCAN_KEYS)
      || value.finiteTensorScanReceipt.status
        !== 'deep_learning_checkpoint_tensors_all_finite'
      || value.finiteTensorScanReceipt.version !== 1
      || value.finiteTensorScanReceipt.kind !== 'DeepLearningFiniteTensorScanReceipt'
      || value.finiteTensorScanReceiptHash
        !== value.finiteTensorScanReceipt.deepLearningFiniteTensorScanReceiptHash
      || value.finiteTensorScanReceiptHash
        !== value.trainingExecutionReceipt.checkpointManifest.finiteTensorScanReceiptHash
      || value.finiteTensorScanReceipt.checkpointArtifactHash
        !== value.trainingExecutionReceipt.checkpointManifest.checkpointArtifactHash
      || value.finiteTensorScanReceipt.tensorSetHash
        !== value.trainingExecutionReceipt.checkpointManifest.tensorSetHash
      || !jsonEqual(
        value.finiteTensorScanReceipt.tensors,
        value.trainingExecutionReceipt.checkpointManifest.tensors,
      )
      || value.finiteTensorScanReceipt.deepLearningFiniteTensorScanReceiptHash
        !== hashRecord('DeepLearningFiniteTensorScanReceipt', Object.fromEntries(
          Object.entries(value.finiteTensorScanReceipt)
            .filter(([key]) => key !== 'deepLearningFiniteTensorScanReceiptHash'),
        ))
      || value.trainingExecutionReceipt.runtimeBom.gpuDeviceUuidHash
        !== value.gpuDeviceSelectorHash
      || value.modelSpecificationArtifactHash
        !== canonicalDeepLearningArtifactByPath(
          value.workerReceipt, 'model-spec.json',
        )?.sha256
      || value.trainingSummaryArtifactHash
        !== canonicalDeepLearningArtifactByPath(
          value.workerReceipt, 'training-summary.json',
        )?.sha256
      || value.trainingPredictionsArtifactHash
        !== canonicalDeepLearningArtifactByPath(
          value.workerReceipt, 'training-predictions.json',
        )?.sha256) {
      return false;
    }
    const payload = { ...value };
    delete payload.canonicalCupyDeepLearningTrainingReceiptHash;
    return requiredDeepLearningHash(value.canonicalCupyDeepLearningTrainingReceiptHash)
      && hashRecord('CanonicalCupyDeepLearningTrainingReceipt', payload)
        === value.canonicalCupyDeepLearningTrainingReceiptHash;
  } catch {
    return false;
  }
}

export function createCanonicalCupyDeepLearningTrainingExecutor(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)
    || Object.getPrototypeOf(options) !== Object.prototype
    || Object.keys(options).some((key) => !EXECUTOR_OPTION_KEYS.has(key))) {
    throw new Error('deep_learning_gpu_training_executor_options_invalid');
  }
  const {
    outputRoot,
    timeoutMs = 60 * 60 * 1_000,
    memoryBytes = 8 * 1024 ** 3,
    cpuSeconds = 3_600,
    maximumProcesses = 32,
    maximumOutputBytes = 2 * 1024 ** 3,
  } = options;
  if (typeof outputRoot !== 'string' || !path.isAbsolute(outputRoot)) {
    throw new Error('deep_learning_gpu_training_output_root_absolute_required');
  }
  const selectedOutputRoot = path.normalize(outputRoot);
  if (selectedOutputRoot === path.parse(selectedOutputRoot).root) {
    throw new Error('deep_learning_gpu_training_output_root_invalid');
  }
  const outputRootIdentity = inspectScopedPathSync({
    scopeRoot: selectedOutputRoot,
    candidate: selectedOutputRoot,
    expect: 'directory',
    forbidHardlinks: false,
  });
  if (outputRootIdentity.blockers.length) {
    throw new Error('deep_learning_gpu_training_output_root_invalid');
  }
  const outputRootStat = fs.lstatSync(selectedOutputRoot);
  if (!outputRootStat.isDirectory() || outputRootStat.isSymbolicLink()
    || fs.realpathSync.native(selectedOutputRoot) !== selectedOutputRoot
    || (typeof process.geteuid === 'function'
      && outputRootStat.uid !== process.geteuid())
    || (outputRootStat.mode & 0o077) !== 0) {
    throw new Error('deep_learning_gpu_training_output_root_invalid');
  }
  const sandbox = createCanonicalCupyDeepLearningSandboxRunner({
    outputRoot: selectedOutputRoot,
    timeoutMs,
    memoryBytes,
    cpuSeconds,
    maximumProcesses,
    maximumOutputBytes,
  });
  const capabilities = sandbox.capabilities();
  if (!capabilities.sandboxModes?.includes('kernel-isolated')
    || capabilities.networkPolicy !== 'none'
    || capabilities.workspaceIsolation !== true
    || capabilities.externalActions !== false
    || capabilities.gpu !== true
    || typeof sandbox.inspectGpuDeviceCapacity !== 'function') {
    throw new Error('deep_learning_gpu_training_worker_capability_invalid');
  }
  const executorCapabilities = Object.freeze({
    version: 1,
    kind: 'DeepLearningGpuTrainingExecutorCapabilities',
    runtimeProfile: 'pythonGpu',
    framework: 'cupy',
    modelFamily: 'declarative-sequential-mlp-v1',
    customCodeAllowed: false,
    customCudaAllowed: false,
    pickleAllowed: false,
    singleGpuUuidRequired: true,
    trainingDatasetAuthorityRequired: true,
    exactArtifactManifestRequired: true,
    predictorAuthorityProvided: false,
    hiddenEvaluationAuthorityProvided: false,
    selfAuthorizesProductionPromotion: false,
  });
  return assertDeepLearningGpuTrainingExecutorPort(Object.freeze({
    version: 1,
    kind: 'DeepLearningGpuTrainingExecutor',
    capabilities: () => executorCapabilities,
    async execute({
      trainingRunId,
      profile,
      modelIr,
      trainingDataset,
      trainingDatasetAuthority,
      gpuDeviceSelector,
      absoluteDeadlineEpochMs,
      executionAuthorityHash = null,
      executionSignal = null,
    } = {}) {
      const startedAt = readTrustedWallClockEpochMs();
      const selectedRunId = requiredDeepLearningId(trainingRunId);
      if (!selectedRunId
        || !verifyDeterministicSupervisedClassificationGpuProfile(profile)
        || !jsonEqual(profile, DETERMINISTIC_SUPERVISED_CLASSIFICATION_GPU_PROFILE)
        || !verifyDeterministicSupervisedClassificationModelIr(modelIr)
        || modelIr.profileHash !== profile.deepLearningGpuProfileHash
        || modelIr.parameterCount > MAXIMUM_PARAMETER_COUNT
        || !verifyDeepLearningInlineTrainingDataset(trainingDataset)
        || !verifyCanonicalSyntheticDeepLearningDatasetAuthority(
          trainingDatasetAuthority,
          { trainingDataset },
        )
        || trainingDataset.featureCount !== modelIr.inputFeatureCount
        || trainingDataset.classCount !== modelIr.classCount
        || modelIr.training.batchSize > trainingDataset.sampleCount
        || Math.ceil(trainingDataset.sampleCount / modelIr.training.batchSize)
          * modelIr.training.epochs > MAXIMUM_TRAINING_STEPS
        || !GPU_UUID.test(String(gpuDeviceSelector || ''))
        || (executionAuthorityHash !== null
          && !requiredDeepLearningHash(executionAuthorityHash))
        || !Number.isSafeInteger(absoluteDeadlineEpochMs)
        || absoluteDeadlineEpochMs <= startedAt) {
        return blockedExecution(['deep_learning_gpu_training_input_invalid']);
      }
      const gpuCapacityObservation = sandbox.inspectGpuDeviceCapacity(
        gpuDeviceSelector,
      );
      if (!gpuCapacityObservation) {
        return blockedExecution(['deep_learning_gpu_memory_capacity_unavailable']);
      }
      let gpuMemoryCapacityPlan;
      try {
        gpuMemoryCapacityPlan = buildCanonicalCupyDeepLearningGpuMemoryCapacityPlan({
          modelIr,
          trainingDataset,
          gpuCapacityObservation,
        });
      } catch {
        return blockedExecution(['deep_learning_gpu_memory_capacity_plan_invalid']);
      }
      if (gpuMemoryCapacityPlan.capacitySatisfied !== true) {
        return blockedExecution(['deep_learning_gpu_memory_capacity_insufficient']);
      }
      const gpuDispatchMemoryAdmission =
        buildCanonicalCupyDeepLearningGpuDispatchMemoryAdmission(
          gpuMemoryCapacityPlan,
        );
      const directoryName = `training-${hashRecord('DeepLearningTrainingRunDirectory', {
        trainingRunId: selectedRunId,
      }).slice('sha256:'.length)}`;
      const outputDirectory = path.join(selectedOutputRoot, directoryName);
      if (!isPathWithin(selectedOutputRoot, outputDirectory) || fs.existsSync(outputDirectory)) {
        return blockedExecution(['deep_learning_gpu_training_output_preexists']);
      }
      try { fs.mkdirSync(outputDirectory, { mode: 0o700 }); } catch {
        return blockedExecution(['deep_learning_gpu_training_output_create_failed']);
      }
      const outputIdentity = inspectScopedPathSync({
        scopeRoot: selectedOutputRoot,
        candidate: outputDirectory,
        expect: 'directory',
        forbidHardlinks: false,
      });
      if (outputIdentity.blockers.length) {
        removeOwnedOutputDirectory(selectedOutputRoot, outputDirectory);
        return blockedExecution(['deep_learning_gpu_training_output_scope_invalid']);
      }
      const executionIdentity = sandbox.resolveExecutionRuntimeIdentity({
        executable: AUTOMATION_RUNTIME_IMAGES.pythonGpu.executable,
        containerImage: AUTOMATION_RUNTIME_IMAGES.pythonGpu.image,
        containerExecutable: AUTOMATION_RUNTIME_IMAGES.pythonGpu.executable,
      });
      if (executionIdentity?.available !== true
        || executionIdentity?.allowlisted !== true
        || executionIdentity?.digest !== AUTOMATION_RUNTIME_IMAGES.pythonGpu.imageDigest) {
        removeOwnedOutputDirectory(selectedOutputRoot, outputDirectory);
        return blockedExecution(['deep_learning_gpu_runtime_identity_invalid']);
      }
      const request = deepFreezeJsonValue({
        version: 1,
        kind: 'CanonicalCupyMlpTrainingRequest',
        trainingRunId: selectedRunId,
        gpuDeviceSelector,
        absoluteDeadlineEpochMs,
        profile,
        modelIr,
        trainingDataset,
        trainingDatasetAuthority,
        gpuMemoryCapacityPlan,
        ...(executionAuthorityHash ? { executionAuthorityHash } : {}),
      });
      const standardInput = `${JSON.stringify(request)}\n`;
      const standardInputByteLength = Buffer.byteLength(standardInput);
      const standardInputHash = hashBytes(Buffer.from(standardInput, 'utf8'));
      const requestHash = hashRecord('CanonicalCupyMlpTrainingRequestInvocation', {
        standardInputHash,
        standardInputByteLength,
      });
      if (standardInputByteLength > MAXIMUM_INPUT_BYTES) {
        removeOwnedOutputDirectory(selectedOutputRoot, outputDirectory);
        return blockedExecution(['deep_learning_gpu_training_request_too_large']);
      }
      const remainingMs = absoluteDeadlineEpochMs - readTrustedWallClockEpochMs();
      if (remainingMs < 1) {
        removeOwnedOutputDirectory(selectedOutputRoot, outputDirectory);
        return blockedExecution(['deep_learning_gpu_training_deadline_exhausted']);
      }
      const selectedTimeoutMs = Math.min(timeoutMs, remainingMs);
      const workerResourceLimits = Object.freeze({
        timeoutMs: selectedTimeoutMs,
        memoryBytes,
        cpuSeconds,
        maximumProcesses,
        maximumOutputBytes,
      });
      let workerReceipt;
      try { workerReceipt = await sandbox.run({
        executable: AUTOMATION_RUNTIME_IMAGES.pythonGpu.executable,
        args: [CANONICAL_CUPY_DEEP_LEARNING_TRAINER_PATH, '--output', '/output'],
        cwd: CANONICAL_CUPY_DEEP_LEARNING_TRAINER_ROOT,
        sourceRoot: CANONICAL_CUPY_DEEP_LEARNING_TRAINER_ROOT,
        outputDirectory,
        outputPaths: CANONICAL_CUPY_DEEP_LEARNING_OUTPUT_PATHS,
        executionIdentity,
        expectedSourceMerkleHash:
          CANONICAL_CUPY_DEEP_LEARNING_TRAINER_IDENTITY.merkleHash,
        expectedSourceWorkspaceManifestHash:
          CANONICAL_CUPY_DEEP_LEARNING_TRAINER_IDENTITY.workspaceManifestHash,
        containerImage: AUTOMATION_RUNTIME_IMAGES.pythonGpu.image,
        containerExecutable: AUTOMATION_RUNTIME_IMAGES.pythonGpu.executable,
        timeoutMs: selectedTimeoutMs,
        memoryBytes,
        cpuSeconds,
        maximumProcesses,
        requestedMaximumOutputBytes: maximumOutputBytes,
        requiresGpu: true,
        gpuDeviceSelector,
        gpuDispatchMemoryAdmission,
        requireSeparateOutputRoot: true,
        requireImmutableWorkRoot: true,
        language: 'python',
        determinismPolicy: 'same-device-gpu-replay-required-v1',
        deterministicSeed: modelIr.seed,
        runtimePackageClosure: Object.freeze({
          basis: 'container_image_digest',
          identityHash: AUTOMATION_RUNTIME_IMAGES.pythonGpu.imageDigest,
          manifestHash: null,
          observedPackageCount: 0,
        }),
        runtimeBuildReproducibility:
          AUTOMATION_RUNTIME_IMAGES.pythonGpu.buildReproducibility,
        env: {
          HEPTA_SEED: String(modelIr.seed),
          PYTHONHASHSEED: String(modelIr.seed),
          OMP_NUM_THREADS: '1',
          OPENBLAS_NUM_THREADS: '1',
          MKL_NUM_THREADS: '1',
          NUMEXPR_NUM_THREADS: '1',
          BLIS_NUM_THREADS: '1',
          VECLIB_MAXIMUM_THREADS: '1',
          OMP_DYNAMIC: 'false',
          MKL_DYNAMIC: 'false',
        },
        standardInput,
        signal: executionSignal,
      }); } catch (error) {
        removeOwnedOutputDirectory(selectedOutputRoot, outputDirectory);
        return blockedExecution([
          `deep_learning_gpu_training_worker_failed:${error?.message || 'unknown'}`,
        ]);
      }
      if (!verifyExactWorkerReceipt(workerReceipt, gpuDeviceSelector, {
        standardInputHash,
        standardInputByteLength,
        gpuMemoryCapacityPlan,
        workerResourceLimits,
      })) {
        removeOwnedOutputDirectory(selectedOutputRoot, outputDirectory);
        return blockedExecution([
          'deep_learning_gpu_training_worker_invalid',
          ...(Array.isArray(workerReceipt?.blockers) ? workerReceipt.blockers : []),
        ], workerReceipt || null);
      }
      try {
        const { finiteScan, trainingExecutionReceipt } =
          inspectCanonicalCupyDeepLearningArtifacts({
            outputDirectory,
            workerReceipt,
            trainingRunId: selectedRunId,
            profile,
            modelIr,
            trainingDataset,
            gpuMemoryCapacityPlan,
            maximumOutputBytes,
          });
        const receipt = buildCanonicalReceipt({
          trainingRunId: selectedRunId,
          modelIr,
          trainingDataset,
          trainingDatasetAuthority,
          gpuMemoryCapacityPlan,
          workerReceipt,
          finiteScan,
          requestHash,
          standardInputByteLength,
          standardInputHash,
          trainingExecutionReceipt,
          absoluteDeadlineEpochMs,
          executionAuthorityHash,
          workerResourceLimits,
        });
        if (readTrustedWallClockEpochMs() >= absoluteDeadlineEpochMs) {
          removeOwnedOutputDirectory(selectedOutputRoot, outputDirectory);
          return blockedExecution(['deep_learning_gpu_training_deadline_exceeded'], workerReceipt);
        }
        if (verifyCanonicalCupyDeepLearningTrainingReceipt(receipt)) return receipt;
        removeOwnedOutputDirectory(selectedOutputRoot, outputDirectory);
        return blockedExecution(['deep_learning_gpu_training_receipt_invalid'], workerReceipt);
      } catch (error) {
        removeOwnedOutputDirectory(selectedOutputRoot, outputDirectory);
        return blockedExecution([
          `deep_learning_gpu_training_artifact_verification_failed:${error?.message || 'unknown'}`,
        ], workerReceipt);
      }
    },
  }));
}

export { CANONICAL_CUPY_DEEP_LEARNING_OUTPUT_PATHS };
