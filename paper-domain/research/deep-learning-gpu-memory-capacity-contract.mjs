import { deepFreezeJsonValue } from '../../workflow-kernel/deep-freeze-json-value.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  buildGpuDispatchMemoryAdmissionRequirement,
  verifyNvidiaGpuDeviceCapacityObservation,
} from '../automation/nvidia-gpu-device-capacity-contract.mjs';
import {
  exactPlainObject,
  jsonEqual,
  requiredDeepLearningHash,
} from './deep-learning-contract-primitives.mjs';
import {
  verifyDeterministicSupervisedClassificationModelIr,
} from './deep-learning-model-ir-contract.mjs';
import {
  verifyDeepLearningInlineTrainingDataset,
} from './deep-learning-training-dataset-contract.mjs';

const FLOAT32_BYTES = 4;
const INT64_BYTES = 8;
const CUDA_RUNTIME_RESERVE_BYTES = 512 * 1024 ** 2;
const MINIMUM_UNALLOCATED_HEADROOM_BYTES = 1024 ** 3;
const MINIMUM_OBSERVED_FREE_HEADROOM_BYTES = 512 * 1024 ** 2;
const MAXIMUM_CAPACITY_FRACTION_NUMERATOR = 3;
const MAXIMUM_CAPACITY_FRACTION_DENOMINATOR = 4;
const PARAMETER_STATE_MULTIPLIER = 12;
const WORKSPACE_TENSOR_MULTIPLIER = 8;
const ALLOCATOR_RESERVE_NUMERATOR = 1;
const ALLOCATOR_RESERVE_DENOMINATOR = 4;
const PLAN_KEYS = Object.freeze([
  'allocatorSafetyReserveBytes', 'capacityPolicyId', 'capacitySatisfied',
  'cudaRuntimeReserveBytes', 'datasetResidentBytes', 'estimatedPeakVramBytes',
  'estimatorId', 'fullDatasetEvaluationWorkspaceBytes', 'gpuCapacityObservation',
  'gpuCapacityObservationHash', 'gpuDeviceSelector', 'gpuMemoryCapacityPlanHash',
  'gpuMemoryIsolationClaimed', 'kind', 'maximumCapacityFractionDenominator',
  'maximumCapacityFractionNumerator', 'maximumQualifiedWorkingSetBytes',
  'minimumObservedFreeHeadroomBytes', 'minimumUnallocatedHeadroomBytes',
  'modelIrHash', 'multiTenantExclusivityClaimed', 'observedGpuFreeMemoryBytes',
  'observedGpuTotalMemoryBytes',
  'parameterStateBytes', 'trainingBatchWorkspaceBytes',
  'trainingDatasetManifestHash', 'trainingDatasetShape', 'version',
]);
const DATASET_SHAPE_KEYS = Object.freeze(['classCount', 'featureCount', 'sampleCount']);

function safeMultiply(...values) {
  const result = values.reduce((product, value) => product * value, 1);
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new Error('deep_learning_gpu_peak_vram_estimate_overflow');
  }
  return result;
}

function safeAdd(...values) {
  const result = values.reduce((sum, value) => sum + value, 0);
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new Error('deep_learning_gpu_peak_vram_estimate_overflow');
  }
  return result;
}

function ceilFraction(value, numerator, denominator) {
  return Math.ceil((value * numerator) / denominator);
}

function estimateComponents(modelIr, trainingDatasetShape) {
  const layerUnitSum = modelIr.layers.reduce((sum, layer) => (
    safeAdd(sum, layer.outputUnits)
  ), 0);
  const datasetResidentBytes = safeAdd(
    safeMultiply(trainingDatasetShape.sampleCount, trainingDatasetShape.featureCount,
      FLOAT32_BYTES),
    safeMultiply(trainingDatasetShape.sampleCount, INT64_BYTES),
    safeMultiply(trainingDatasetShape.sampleCount, INT64_BYTES),
  );
  const parameterStateBytes = safeMultiply(
    modelIr.parameterCount, FLOAT32_BYTES, PARAMETER_STATE_MULTIPLIER,
  );
  const fullDatasetEvaluationWorkspaceBytes = safeMultiply(
    trainingDatasetShape.sampleCount,
    safeAdd(modelIr.inputFeatureCount,
      safeMultiply(layerUnitSum, WORKSPACE_TENSOR_MULTIPLIER)),
    FLOAT32_BYTES,
  );
  const effectiveBatchSize = Math.min(
    modelIr.training.batchSize, trainingDatasetShape.sampleCount,
  );
  const trainingBatchWorkspaceBytes = safeAdd(
    safeMultiply(
      effectiveBatchSize,
      safeAdd(modelIr.inputFeatureCount,
        safeMultiply(layerUnitSum, WORKSPACE_TENSOR_MULTIPLIER)),
      FLOAT32_BYTES,
    ),
    safeMultiply(effectiveBatchSize, INT64_BYTES, 2),
  );
  const subtotal = safeAdd(
    datasetResidentBytes,
    parameterStateBytes,
    Math.max(fullDatasetEvaluationWorkspaceBytes, trainingBatchWorkspaceBytes),
    CUDA_RUNTIME_RESERVE_BYTES,
  );
  const allocatorSafetyReserveBytes = ceilFraction(
    subtotal, ALLOCATOR_RESERVE_NUMERATOR, ALLOCATOR_RESERVE_DENOMINATOR,
  );
  return Object.freeze({
    datasetResidentBytes,
    parameterStateBytes,
    fullDatasetEvaluationWorkspaceBytes,
    trainingBatchWorkspaceBytes,
    cudaRuntimeReserveBytes: CUDA_RUNTIME_RESERVE_BYTES,
    allocatorSafetyReserveBytes,
    estimatedPeakVramBytes: safeAdd(subtotal, allocatorSafetyReserveBytes),
  });
}

function validDatasetShape(value, modelIr) {
  return exactPlainObject(value, DATASET_SHAPE_KEYS)
    && Number.isSafeInteger(value.sampleCount) && value.sampleCount >= 2
    && value.sampleCount <= 65_536
    && Number.isSafeInteger(value.featureCount) && value.featureCount >= 1
    && value.featureCount <= 4_096
    && Number.isSafeInteger(value.classCount) && value.classCount >= 2
    && value.classCount <= 100_000
    && value.sampleCount * value.featureCount <= 4_194_304
    && value.featureCount === modelIr.inputFeatureCount
    && value.classCount === modelIr.classCount;
}

function buildPlanFromBinding({
  modelIr,
  trainingDatasetManifestHash,
  trainingDatasetShape,
  gpuCapacityObservation,
}) {
  const components = estimateComponents(modelIr, trainingDatasetShape);
  const observedGpuTotalMemoryBytes = gpuCapacityObservation.totalMemoryBytes;
  const observedGpuFreeMemoryBytes = gpuCapacityObservation.freeMemoryBytes;
  const fractionalLimit = Math.floor(
    observedGpuTotalMemoryBytes * MAXIMUM_CAPACITY_FRACTION_NUMERATOR
      / MAXIMUM_CAPACITY_FRACTION_DENOMINATOR,
  );
  const headroomLimit = Math.max(
    0, observedGpuTotalMemoryBytes - MINIMUM_UNALLOCATED_HEADROOM_BYTES,
  );
  const observedFreeLimit = Math.max(
    0, observedGpuFreeMemoryBytes - MINIMUM_OBSERVED_FREE_HEADROOM_BYTES,
  );
  const maximumQualifiedWorkingSetBytes = Math.min(
    fractionalLimit, headroomLimit, observedFreeLimit,
  );
  const payload = {
    version: 1,
    kind: 'CanonicalCupyDeepLearningGpuMemoryCapacityPlan',
    estimatorId: 'conservative-cupy-fp32-mlp-peak-vram-v1',
    capacityPolicyId: 'bounded-shared-gpu-total-and-free-capacity-headroom-v2',
    modelIrHash: modelIr.deepLearningModelIrHash,
    trainingDatasetManifestHash,
    trainingDatasetShape,
    gpuDeviceSelector: gpuCapacityObservation.gpuDeviceSelector,
    gpuCapacityObservationHash:
      gpuCapacityObservation.nvidiaGpuDeviceCapacityObservationHash,
    gpuCapacityObservation,
    observedGpuTotalMemoryBytes,
    observedGpuFreeMemoryBytes,
    ...components,
    maximumCapacityFractionNumerator: MAXIMUM_CAPACITY_FRACTION_NUMERATOR,
    maximumCapacityFractionDenominator: MAXIMUM_CAPACITY_FRACTION_DENOMINATOR,
    minimumUnallocatedHeadroomBytes: MINIMUM_UNALLOCATED_HEADROOM_BYTES,
    minimumObservedFreeHeadroomBytes: MINIMUM_OBSERVED_FREE_HEADROOM_BYTES,
    maximumQualifiedWorkingSetBytes,
    capacitySatisfied:
      components.estimatedPeakVramBytes <= maximumQualifiedWorkingSetBytes,
    gpuMemoryIsolationClaimed: false,
    multiTenantExclusivityClaimed: false,
  };
  return deepFreezeJsonValue({
    ...payload,
    gpuMemoryCapacityPlanHash:
      hashRecord('CanonicalCupyDeepLearningGpuMemoryCapacityPlan', payload),
  });
}

export function buildCanonicalCupyDeepLearningGpuMemoryCapacityPlan({
  modelIr,
  trainingDataset,
  gpuCapacityObservation,
} = {}) {
  if (!verifyDeterministicSupervisedClassificationModelIr(modelIr)
    || !verifyDeepLearningInlineTrainingDataset(trainingDataset)
    || !verifyNvidiaGpuDeviceCapacityObservation(gpuCapacityObservation)
    || modelIr.inputFeatureCount !== trainingDataset.featureCount
    || modelIr.classCount !== trainingDataset.classCount) {
    throw new Error('deep_learning_gpu_memory_capacity_plan_input_invalid');
  }
  return buildPlanFromBinding({
    modelIr,
    trainingDatasetManifestHash:
      trainingDataset.deepLearningTrainingDatasetManifestHash,
    trainingDatasetShape: deepFreezeJsonValue({
      sampleCount: trainingDataset.sampleCount,
      featureCount: trainingDataset.featureCount,
      classCount: trainingDataset.classCount,
    }),
    gpuCapacityObservation,
  });
}

export function verifyCanonicalCupyDeepLearningGpuMemoryCapacityPlanBinding(
  value,
  { modelIr, trainingDatasetManifestHash, gpuCapacityObservation } = {},
) {
  try {
    return exactPlainObject(value, PLAN_KEYS)
      && verifyDeterministicSupervisedClassificationModelIr(modelIr)
      && requiredDeepLearningHash(trainingDatasetManifestHash)
      && verifyNvidiaGpuDeviceCapacityObservation(gpuCapacityObservation)
      && validDatasetShape(value.trainingDatasetShape, modelIr)
      && jsonEqual(buildPlanFromBinding({
        modelIr,
        trainingDatasetManifestHash,
        trainingDatasetShape: value.trainingDatasetShape,
        gpuCapacityObservation,
      }), value);
  } catch {
    return false;
  }
}

export function verifyCanonicalCupyDeepLearningGpuMemoryCapacityPlan(
  value,
  { modelIr, trainingDataset, gpuCapacityObservation } = {},
) {
  try {
    return verifyDeepLearningInlineTrainingDataset(trainingDataset)
      && value?.trainingDatasetManifestHash
        === trainingDataset.deepLearningTrainingDatasetManifestHash
      && jsonEqual(value?.trainingDatasetShape, {
        sampleCount: trainingDataset.sampleCount,
        featureCount: trainingDataset.featureCount,
        classCount: trainingDataset.classCount,
      })
      && verifyCanonicalCupyDeepLearningGpuMemoryCapacityPlanBinding(value, {
        modelIr,
        trainingDatasetManifestHash:
          trainingDataset.deepLearningTrainingDatasetManifestHash,
        gpuCapacityObservation,
      });
  } catch {
    return false;
  }
}

export function buildCanonicalCupyDeepLearningGpuDispatchMemoryAdmission(
  gpuMemoryCapacityPlan,
) {
  if (!exactPlainObject(gpuMemoryCapacityPlan, PLAN_KEYS)
    || gpuMemoryCapacityPlan.capacitySatisfied !== true) {
    throw new Error('deep_learning_gpu_dispatch_memory_admission_plan_invalid');
  }
  return buildGpuDispatchMemoryAdmissionRequirement({
    gpuDeviceSelector: gpuMemoryCapacityPlan.gpuDeviceSelector,
    gpuMemoryCapacityPlanHash: gpuMemoryCapacityPlan.gpuMemoryCapacityPlanHash,
    capacityPolicyId: gpuMemoryCapacityPlan.capacityPolicyId,
    planningCapacityObservationHash:
      gpuMemoryCapacityPlan.gpuCapacityObservationHash,
    planningTotalMemoryBytes:
      gpuMemoryCapacityPlan.observedGpuTotalMemoryBytes,
    planningFreeMemoryBytes:
      gpuMemoryCapacityPlan.observedGpuFreeMemoryBytes,
    estimatedPeakVramBytes: gpuMemoryCapacityPlan.estimatedPeakVramBytes,
    minimumFreeMemoryHeadroomBytes:
      gpuMemoryCapacityPlan.minimumObservedFreeHeadroomBytes,
  });
}

export const CANONICAL_CUPY_DEEP_LEARNING_GPU_MEMORY_CAPACITY_POLICY = Object.freeze({
  estimatorId: 'conservative-cupy-fp32-mlp-peak-vram-v1',
  capacityPolicyId: 'bounded-shared-gpu-total-and-free-capacity-headroom-v2',
  cudaRuntimeReserveBytes: CUDA_RUNTIME_RESERVE_BYTES,
  minimumUnallocatedHeadroomBytes: MINIMUM_UNALLOCATED_HEADROOM_BYTES,
  minimumObservedFreeHeadroomBytes: MINIMUM_OBSERVED_FREE_HEADROOM_BYTES,
  maximumCapacityFractionNumerator: MAXIMUM_CAPACITY_FRACTION_NUMERATOR,
  maximumCapacityFractionDenominator: MAXIMUM_CAPACITY_FRACTION_DENOMINATOR,
  gpuMemoryIsolationClaimed: false,
  multiTenantExclusivityClaimed: false,
});
