import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildNvidiaGpuDeviceCapacityObservation,
  verifyNvidiaGpuDeviceCapacityObservation,
} from '../../paper-domain/automation/nvidia-gpu-device-capacity-contract.mjs';
import {
  buildCanonicalCupyDeepLearningGpuDispatchMemoryAdmission,
  buildCanonicalCupyDeepLearningGpuMemoryCapacityPlan,
  CANONICAL_CUPY_DEEP_LEARNING_GPU_MEMORY_CAPACITY_POLICY,
  verifyCanonicalCupyDeepLearningGpuMemoryCapacityPlan,
} from '../../paper-domain/research/deep-learning-gpu-memory-capacity-contract.mjs';
import {
  DETERMINISTIC_SUPERVISED_CLASSIFICATION_GPU_PROFILE,
} from '../../paper-domain/research/deep-learning-gpu-profile-contract.mjs';
import {
  buildDeterministicSupervisedClassificationModelIr,
} from '../../paper-domain/research/deep-learning-model-ir-contract.mjs';
import {
  buildDeepLearningInlineTrainingDataset,
} from '../../paper-domain/research/deep-learning-training-dataset-contract.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const GPU_UUID = 'GPU-a33875b7-7eb7-679e-df08-19227d3decee';

function training(overrides = {}) {
  return {
    optimizer: 'adamw-v1',
    loss: 'sparse-cross-entropy-with-logits-v1',
    initialization: 'stateless-sha256-box-muller-v1',
    batchOrder: 'seeded-fisher-yates-v1',
    earlyStoppingEnabled: false,
    epochs: 2,
    batchSize: 2,
    learningRate: 0.01,
    weightDecay: 0,
    beta1: 0.9,
    beta2: 0.999,
    epsilon: 1e-8,
    gradientClipNorm: 10,
    ...overrides,
  };
}

function smallFixture() {
  const modelIr = buildDeterministicSupervisedClassificationModelIr({
    modelId: 'capacity-small-model',
    profileHash:
      DETERMINISTIC_SUPERVISED_CLASSIFICATION_GPU_PROFILE.deepLearningGpuProfileHash,
    inputFeatureCount: 2,
    classCount: 2,
    layers: [
      {
        layerId: 'dense1', type: 'dense', inputUnits: 2, outputUnits: 8,
        activation: 'relu', useBias: true,
      },
      {
        layerId: 'logits', type: 'dense', inputUnits: 8, outputUnits: 2,
        activation: 'identity', useBias: true,
      },
    ],
    training: training(),
    seed: 17,
  });
  const trainingDataset = buildDeepLearningInlineTrainingDataset({
    datasetId: 'capacity-small-dataset',
    classCount: 2,
    features: [[0, 0], [0, 1], [1, 0], [1, 1]],
    labels: [0, 1, 1, 0],
  });
  const gpuCapacityObservation = buildNvidiaGpuDeviceCapacityObservation({
    gpuDeviceSelector: GPU_UUID,
    reportedTotalMemoryMiB: 8_188,
    reportedFreeMemoryMiB: 5_924,
  });
  return { modelIr, trainingDataset, gpuCapacityObservation };
}

test('trusted GPU capacity and conservative DL working-set policy are exact and honest', () => {
  const fixture = smallFixture();
  assert.equal(verifyNvidiaGpuDeviceCapacityObservation(
    fixture.gpuCapacityObservation,
  ), true);
  const plan = buildCanonicalCupyDeepLearningGpuMemoryCapacityPlan(fixture);
  assert.equal(verifyCanonicalCupyDeepLearningGpuMemoryCapacityPlan(plan, fixture), true);
  assert.equal(plan.capacitySatisfied, true);
  assert.equal(plan.gpuMemoryIsolationClaimed, false);
  assert.equal(plan.multiTenantExclusivityClaimed, false);
  const admission = buildCanonicalCupyDeepLearningGpuDispatchMemoryAdmission(plan);
  assert.equal(admission.planningCapacityObservationHash,
    plan.gpuCapacityObservationHash);
  assert.equal(admission.planningFreeMemoryBytes,
    plan.observedGpuFreeMemoryBytes);
  assert.equal(admission.minimumRequiredFreeMemoryBytes,
    plan.estimatedPeakVramBytes + plan.minimumObservedFreeHeadroomBytes);
  assert.equal(admission.gpuMemoryIsolationClaimed, false);
  assert.equal(admission.multiTenantExclusivityClaimed, false);
  assert.equal(plan.maximumCapacityFractionNumerator, 3);
  assert.equal(plan.maximumCapacityFractionDenominator, 4);
  assert.equal(plan.minimumUnallocatedHeadroomBytes, 1024 ** 3);
  assert.equal(plan.minimumObservedFreeHeadroomBytes, 512 * 1024 ** 2);
  assert.equal(plan.maximumQualifiedWorkingSetBytes,
    Math.min(
      Math.floor(plan.observedGpuTotalMemoryBytes * 3 / 4),
      plan.observedGpuTotalMemoryBytes - 1024 ** 3,
      plan.observedGpuFreeMemoryBytes - 512 * 1024 ** 2,
    ));
  assert.deepEqual(
    CANONICAL_CUPY_DEEP_LEARNING_GPU_MEMORY_CAPACITY_POLICY,
    {
      estimatorId: 'conservative-cupy-fp32-mlp-peak-vram-v1',
      capacityPolicyId: 'bounded-shared-gpu-total-and-free-capacity-headroom-v2',
      cudaRuntimeReserveBytes: 512 * 1024 ** 2,
      minimumUnallocatedHeadroomBytes: 1024 ** 3,
      minimumObservedFreeHeadroomBytes: 512 * 1024 ** 2,
      maximumCapacityFractionNumerator: 3,
      maximumCapacityFractionDenominator: 4,
      gpuMemoryIsolationClaimed: false,
      multiTenantExclusivityClaimed: false,
    },
  );

  const forged = structuredClone(plan);
  forged.estimatedPeakVramBytes = 1;
  const payload = { ...forged };
  delete payload.gpuMemoryCapacityPlanHash;
  forged.gpuMemoryCapacityPlanHash = hashRecord(
    'CanonicalCupyDeepLearningGpuMemoryCapacityPlan', payload,
  );
  assert.equal(verifyCanonicalCupyDeepLearningGpuMemoryCapacityPlan(
    forged, fixture,
  ), false);
});

test('a 122 GiB single-activation MLP is rejected before GPU dispatch', () => {
  const hiddenUnits = 499_999;
  const sampleCount = 65_536;
  const modelIr = buildDeterministicSupervisedClassificationModelIr({
    modelId: 'capacity-activation-bomb-model',
    profileHash:
      DETERMINISTIC_SUPERVISED_CLASSIFICATION_GPU_PROFILE.deepLearningGpuProfileHash,
    inputFeatureCount: 1,
    classCount: 2,
    layers: [
      {
        layerId: 'wide', type: 'dense', inputUnits: 1, outputUnits: hiddenUnits,
        activation: 'relu', useBias: true,
      },
      {
        layerId: 'logits', type: 'dense', inputUnits: hiddenUnits, outputUnits: 2,
        activation: 'identity', useBias: true,
      },
    ],
    training: training({ epochs: 1, batchSize: sampleCount }),
    seed: 19,
  });
  assert.ok(modelIr.parameterCount < 2_000_000);
  const features = Array.from({ length: sampleCount }, (_, index) => [index & 1]);
  const trainingDataset = buildDeepLearningInlineTrainingDataset({
    datasetId: 'capacity-activation-bomb-dataset',
    classCount: 2,
    features,
    labels: features.map(([value]) => value),
  });
  const gpuCapacityObservation = buildNvidiaGpuDeviceCapacityObservation({
    gpuDeviceSelector: GPU_UUID,
    reportedTotalMemoryMiB: 8_188,
    reportedFreeMemoryMiB: 5_924,
  });
  const plan = buildCanonicalCupyDeepLearningGpuMemoryCapacityPlan({
    modelIr, trainingDataset, gpuCapacityObservation,
  });
  const singleActivationBytes = sampleCount * hiddenUnits * 4;
  assert.ok(singleActivationBytes > 122 * 1024 ** 3);
  assert.ok(plan.fullDatasetEvaluationWorkspaceBytes > singleActivationBytes);
  assert.ok(plan.estimatedPeakVramBytes > plan.observedGpuTotalMemoryBytes);
  assert.equal(plan.capacitySatisfied, false);
  assert.equal(verifyCanonicalCupyDeepLearningGpuMemoryCapacityPlan(plan, {
    modelIr, trainingDataset, gpuCapacityObservation,
  }), true);
});

test('free VRAM is explicit and can reject a task that total-memory limits permit', () => {
  const fixture = smallFixture();
  assert.throws(() => buildNvidiaGpuDeviceCapacityObservation({
    gpuDeviceSelector: GPU_UUID,
    reportedTotalMemoryMiB: 8_188,
  }), /observation_invalid/);
  assert.throws(() => buildNvidiaGpuDeviceCapacityObservation({
    gpuDeviceSelector: GPU_UUID,
    reportedTotalMemoryMiB: 8_188,
    reportedFreeMemoryMiB: 8_189,
  }), /observation_invalid/);
  const constrainedObservation = buildNvidiaGpuDeviceCapacityObservation({
    gpuDeviceSelector: GPU_UUID,
    reportedTotalMemoryMiB: 8_188,
    reportedFreeMemoryMiB: 512,
  });
  const plan = buildCanonicalCupyDeepLearningGpuMemoryCapacityPlan({
    ...fixture,
    gpuCapacityObservation: constrainedObservation,
  });
  assert.ok(plan.estimatedPeakVramBytes
    < Math.floor(plan.observedGpuTotalMemoryBytes * 3 / 4));
  assert.equal(plan.observedGpuFreeMemoryBytes, 512 * 1024 ** 2);
  assert.equal(plan.maximumQualifiedWorkingSetBytes, 0);
  assert.equal(plan.capacitySatisfied, false);
  assert.equal(plan.gpuMemoryIsolationClaimed, false);
  assert.equal(plan.multiTenantExclusivityClaimed, false);
  assert.equal(verifyCanonicalCupyDeepLearningGpuMemoryCapacityPlan(plan, {
    ...fixture,
    gpuCapacityObservation: constrainedObservation,
  }), true);
});
