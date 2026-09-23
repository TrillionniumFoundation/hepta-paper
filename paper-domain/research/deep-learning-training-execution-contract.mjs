import { deepFreezeJsonValue } from '../../workflow-kernel/deep-freeze-json-value.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  densePlainArray,
  exactPlainObject,
  finiteNumberInRange,
  jsonEqual,
  requiredDeepLearningHash,
  requiredDeepLearningId,
  requiredRuntimeVersion,
  safeIntegerInRange,
} from './deep-learning-contract-primitives.mjs';
import {
  DETERMINISTIC_SUPERVISED_CLASSIFICATION_GPU_PROFILE,
} from './deep-learning-gpu-profile-contract.mjs';
import {
  verifyDeterministicSupervisedClassificationModelIr,
} from './deep-learning-model-ir-contract.mjs';

const RUNTIME_INPUT_KEYS = Object.freeze([
  'cudaDriverVersion', 'cudaRuntimeVersion', 'framework', 'frameworkVersion',
  'gpuComputeCapability', 'gpuDeviceUuidHash', 'gpuModelHash',
  'packageClosureHash', 'runtimeImageDigest',
]);
const RUNTIME_KEYS = Object.freeze([
  'automaticMixedPrecisionEnabled', 'cudaDriverVersion', 'cudaRuntimeVersion',
  'dataLoaderWorkers', 'deepLearningGpuRuntimeBomHash', 'deterministicAlgorithmsConfigured',
  'deviceCount', 'deviceSelection', 'framework', 'frameworkVersion',
  'gpuComputeCapability', 'gpuDeviceUuidHash', 'gpuModelHash', 'kind',
  'packageClosureHash', 'precision', 'runtimeImageDigest', 'runtimeProfile',
  'tensorFloat32Enabled', 'version',
]);
const CHECKPOINT_INPUT_KEYS = Object.freeze([
  'checkpointArtifactHash', 'completedEpoch', 'finiteTensorScanReceiptHash',
  'modelIr', 'runtimeBom', 'tensorBundleArtifactBytes', 'tensors',
  'trainingDatasetManifestHash', 'trainingRunId', 'trainingStepCount',
]);
const CHECKPOINT_KEYS = Object.freeze([
  'byteOrder', 'checkpointArtifactHash', 'deepLearningCheckpointManifestHash',
  'executablePayloadAllowed', 'finiteTensorScanReceiptHash', 'finiteTensorScanStatus',
  'format', 'kind', 'modelIrHash', 'pickleAllowed', 'profileHash', 'runtimeBomHash',
  'tensorBundleArtifactBytes', 'tensorSetHash', 'tensors',
  'trainingDatasetManifestHash', 'trainingProgress', 'trainingRunId', 'version',
]);
const TENSOR_KEYS = Object.freeze(['byteLength', 'dtype', 'name', 'sha256', 'shape']);
const EXECUTION_INPUT_KEYS = Object.freeze([
  'checkpointManifest', 'finalMetrics', 'metricTraceArtifactHash', 'modelIr',
  'runtimeBom', 'trainingDatasetManifestHash', 'trainingRunId',
]);
const EXECUTION_KEYS = Object.freeze([
  'checkpointManifest', 'checkpointManifestHash', 'deepLearningTrainingExecutionReceiptHash',
  'determinismScope', 'externalActionPerformed', 'finalMetrics', 'kind',
  'metricTraceArtifactHash', 'modelIr', 'modelIrHash', 'networkActionPerformed',
  'profileHash', 'runtimeBom', 'runtimeBomHash', 'selfAuthorizesProductionPromotion',
  'status', 'trainingDatasetManifestHash', 'trainingRunId', 'version',
]);
const METRIC_KEYS = Object.freeze([
  'accuracy', 'crossEntropy', 'gradientNorm', 'initialCrossEntropy',
]);
const GPU_COMPUTE_CAPABILITY = /^\d{1,2}\.\d{1,2}$/;

export function buildDeepLearningGpuRuntimeBom(value = {}) {
  if (!exactPlainObject(value, RUNTIME_INPUT_KEYS)
    || value.framework !== 'cupy'
    || !requiredRuntimeVersion(value.frameworkVersion)
    || !requiredRuntimeVersion(value.cudaDriverVersion)
    || !requiredRuntimeVersion(value.cudaRuntimeVersion)
    || !GPU_COMPUTE_CAPABILITY.test(value.gpuComputeCapability || '')
    || !requiredDeepLearningHash(value.gpuDeviceUuidHash)
    || !requiredDeepLearningHash(value.gpuModelHash)
    || !requiredDeepLearningHash(value.packageClosureHash)
    || !requiredDeepLearningHash(value.runtimeImageDigest)) {
    throw new Error('deep_learning_gpu_runtime_bom_invalid');
  }
  const payload = {
    version: 1,
    kind: 'DeepLearningGpuRuntimeBom',
    runtimeProfile: 'pythonGpu',
    runtimeImageDigest: requiredDeepLearningHash(value.runtimeImageDigest),
    packageClosureHash: requiredDeepLearningHash(value.packageClosureHash),
    framework: 'cupy',
    frameworkVersion: value.frameworkVersion,
    cudaDriverVersion: value.cudaDriverVersion,
    cudaRuntimeVersion: value.cudaRuntimeVersion,
    gpuComputeCapability: value.gpuComputeCapability,
    gpuDeviceUuidHash: requiredDeepLearningHash(value.gpuDeviceUuidHash),
    gpuModelHash: requiredDeepLearningHash(value.gpuModelHash),
    deviceCount: 1,
    deviceSelection: 'uuid-pinned-single-device-v1',
    precision: 'float32',
    automaticMixedPrecisionEnabled: false,
    tensorFloat32Enabled: false,
    deterministicAlgorithmsConfigured: true,
    dataLoaderWorkers: 0,
  };
  return deepFreezeJsonValue({
    ...payload,
    deepLearningGpuRuntimeBomHash: hashRecord('DeepLearningGpuRuntimeBom', payload),
  });
}

function runtimeBomInput(value) {
  return Object.fromEntries(RUNTIME_INPUT_KEYS.map((key) => [key, value?.[key]]));
}

export function verifyDeepLearningGpuRuntimeBom(value) {
  try {
    return exactPlainObject(value, RUNTIME_KEYS)
      && jsonEqual(buildDeepLearningGpuRuntimeBom(runtimeBomInput(value)), value);
  } catch {
    return false;
  }
}

function expectedCheckpointTensors(modelIr) {
  return modelIr.layers.flatMap((layer) => [
    Object.freeze({
      name: `${layer.layerId}.weight`,
      shape: Object.freeze([layer.outputUnits, layer.inputUnits]),
    }),
    ...(layer.useBias ? [Object.freeze({
      name: `${layer.layerId}.bias`,
      shape: Object.freeze([layer.outputUnits]),
    })] : []),
  ]).sort((left, right) => (left.name < right.name ? -1 : Number(left.name > right.name)));
}

function compileCheckpointTensors(value, modelIr) {
  const expected = expectedCheckpointTensors(modelIr);
  if (!densePlainArray(value, expected.length, expected.length)) {
    throw new Error('deep_learning_checkpoint_tensor_set_invalid');
  }
  return Object.freeze(value.map((tensor, index) => {
    const selected = expected[index];
    const expectedBytes = selected.shape.reduce((product, dimension) => (
      product * dimension
    ), 4);
    if (!exactPlainObject(tensor, TENSOR_KEYS)
      || tensor.name !== selected.name
      || tensor.dtype !== 'float32'
      || !densePlainArray(tensor.shape, selected.shape.length, selected.shape.length)
      || !jsonEqual(tensor.shape, selected.shape)
      || tensor.byteLength !== expectedBytes
      || !requiredDeepLearningHash(tensor.sha256)) {
      throw new Error('deep_learning_checkpoint_tensor_invalid');
    }
    return Object.freeze({
      name: tensor.name,
      dtype: 'float32',
      shape: Object.freeze([...tensor.shape]),
      byteLength: tensor.byteLength,
      sha256: requiredDeepLearningHash(tensor.sha256),
    });
  }));
}

export function buildDeepLearningCheckpointManifest(value = {}) {
  if (!exactPlainObject(value, CHECKPOINT_INPUT_KEYS)
    || !verifyDeterministicSupervisedClassificationModelIr(value.modelIr)
    || !verifyDeepLearningGpuRuntimeBom(value.runtimeBom)
    || !requiredDeepLearningId(value.trainingRunId)
    || !requiredDeepLearningHash(value.trainingDatasetManifestHash)
    || !requiredDeepLearningHash(value.checkpointArtifactHash)
    || !requiredDeepLearningHash(value.finiteTensorScanReceiptHash)
    || !safeIntegerInRange(value.completedEpoch, 1, value.modelIr?.training?.epochs || 0)
    || !safeIntegerInRange(value.trainingStepCount, 1, Number.MAX_SAFE_INTEGER)
    || !safeIntegerInRange(value.tensorBundleArtifactBytes, 1, 8 * 1024 ** 3)) {
    throw new Error('deep_learning_checkpoint_manifest_invalid');
  }
  const tensors = compileCheckpointTensors(value.tensors, value.modelIr);
  if (tensors.reduce((total, tensor) => total + tensor.byteLength, 0)
    !== value.tensorBundleArtifactBytes) {
    throw new Error('deep_learning_checkpoint_artifact_size_invalid');
  }
  const tensorSet = {
    version: 1,
    kind: 'DeepLearningCheckpointTensorSet',
    format: 'hepta-tensor-bundle-v1',
    tensors,
  };
  const payload = {
    version: 1,
    kind: 'DeepLearningCheckpointManifest',
    trainingRunId: value.trainingRunId,
    profileHash:
      DETERMINISTIC_SUPERVISED_CLASSIFICATION_GPU_PROFILE.deepLearningGpuProfileHash,
    modelIrHash: value.modelIr.deepLearningModelIrHash,
    runtimeBomHash: value.runtimeBom.deepLearningGpuRuntimeBomHash,
    trainingDatasetManifestHash: requiredDeepLearningHash(value.trainingDatasetManifestHash),
    trainingProgress: Object.freeze({
      completedEpoch: value.completedEpoch,
      trainingStepCount: value.trainingStepCount,
    }),
    format: 'hepta-tensor-bundle-v1',
    byteOrder: 'little-endian',
    pickleAllowed: false,
    executablePayloadAllowed: false,
    finiteTensorScanStatus: 'all-finite',
    finiteTensorScanReceiptHash: requiredDeepLearningHash(value.finiteTensorScanReceiptHash),
    tensors,
    tensorSetHash: hashRecord('DeepLearningCheckpointTensorSet', tensorSet),
    tensorBundleArtifactBytes: value.tensorBundleArtifactBytes,
    checkpointArtifactHash: requiredDeepLearningHash(value.checkpointArtifactHash),
  };
  return deepFreezeJsonValue({
    ...payload,
    deepLearningCheckpointManifestHash:
      hashRecord('DeepLearningCheckpointManifest', payload),
  });
}

function checkpointInput(value, modelIr, runtimeBom) {
  return {
    trainingRunId: value.trainingRunId,
    modelIr,
    runtimeBom,
    trainingDatasetManifestHash: value.trainingDatasetManifestHash,
    completedEpoch: value.trainingProgress?.completedEpoch,
    trainingStepCount: value.trainingProgress?.trainingStepCount,
    finiteTensorScanReceiptHash: value.finiteTensorScanReceiptHash,
    tensors: value.tensors,
    tensorBundleArtifactBytes: value.tensorBundleArtifactBytes,
    checkpointArtifactHash: value.checkpointArtifactHash,
  };
}

export function verifyDeepLearningCheckpointManifest(value, { modelIr, runtimeBom } = {}) {
  try {
    return exactPlainObject(value, CHECKPOINT_KEYS)
      && jsonEqual(buildDeepLearningCheckpointManifest(
        checkpointInput(value, modelIr, runtimeBom),
      ), value);
  } catch {
    return false;
  }
}

function compileFinalMetrics(value) {
  if (!exactPlainObject(value, METRIC_KEYS)
    || !finiteNumberInRange(value.accuracy, 0, 1)
    || !finiteNumberInRange(value.crossEntropy, 0, Number.MAX_VALUE)
    || !finiteNumberInRange(value.initialCrossEntropy, 0, Number.MAX_VALUE)
    || !finiteNumberInRange(value.gradientNorm, 0, Number.MAX_VALUE)) {
    throw new Error('deep_learning_training_metrics_invalid');
  }
  return Object.freeze({ ...value });
}

export function buildDeepLearningTrainingExecutionReceipt(value = {}) {
  if (!exactPlainObject(value, EXECUTION_INPUT_KEYS)
    || !verifyDeterministicSupervisedClassificationModelIr(value.modelIr)
    || !verifyDeepLearningGpuRuntimeBom(value.runtimeBom)
    || !verifyDeepLearningCheckpointManifest(value.checkpointManifest, {
      modelIr: value.modelIr,
      runtimeBom: value.runtimeBom,
    })
    || !requiredDeepLearningId(value.trainingRunId)
    || value.trainingRunId !== value.checkpointManifest?.trainingRunId
    || !requiredDeepLearningHash(value.trainingDatasetManifestHash)
    || value.trainingDatasetManifestHash
      !== value.checkpointManifest?.trainingDatasetManifestHash
    || !requiredDeepLearningHash(value.metricTraceArtifactHash)) {
    throw new Error('deep_learning_training_execution_receipt_invalid');
  }
  const payload = {
    version: 1,
    kind: 'DeepLearningTrainingExecutionReceipt',
    status: 'deep_learning_gpu_training_execution_recorded',
    trainingRunId: value.trainingRunId,
    profileHash: value.modelIr.profileHash,
    modelIrHash: value.modelIr.deepLearningModelIrHash,
    modelIr: value.modelIr,
    runtimeBomHash: value.runtimeBom.deepLearningGpuRuntimeBomHash,
    runtimeBom: value.runtimeBom,
    trainingDatasetManifestHash: requiredDeepLearningHash(value.trainingDatasetManifestHash),
    checkpointManifestHash: value.checkpointManifest.deepLearningCheckpointManifestHash,
    checkpointManifest: value.checkpointManifest,
    metricTraceArtifactHash: requiredDeepLearningHash(value.metricTraceArtifactHash),
    finalMetrics: compileFinalMetrics(value.finalMetrics),
    determinismScope: 'same-device-uuid-and-runtime-bom-v1',
    networkActionPerformed: false,
    externalActionPerformed: false,
    selfAuthorizesProductionPromotion: false,
  };
  return deepFreezeJsonValue({
    ...payload,
    deepLearningTrainingExecutionReceiptHash:
      hashRecord('DeepLearningTrainingExecutionReceipt', payload),
  });
}

function executionInput(value) {
  return {
    trainingRunId: value.trainingRunId,
    modelIr: value.modelIr,
    runtimeBom: value.runtimeBom,
    trainingDatasetManifestHash: value.trainingDatasetManifestHash,
    checkpointManifest: value.checkpointManifest,
    metricTraceArtifactHash: value.metricTraceArtifactHash,
    finalMetrics: value.finalMetrics,
  };
}

export function verifyDeepLearningTrainingExecutionReceipt(value) {
  try {
    return exactPlainObject(value, EXECUTION_KEYS)
      && jsonEqual(buildDeepLearningTrainingExecutionReceipt(executionInput(value)), value);
  } catch {
    return false;
  }
}
