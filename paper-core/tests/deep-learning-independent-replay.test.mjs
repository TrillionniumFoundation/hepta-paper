import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildDeepLearningCheckpointManifest,
  buildDeepLearningGpuRuntimeBom,
  buildDeepLearningTrainingExecutionReceipt,
} from '../../paper-domain/research/deep-learning-training-execution-contract.mjs';
import {
  buildDeepLearningInlineTrainingDataset,
} from '../../paper-domain/research/deep-learning-training-dataset-contract.mjs';
import {
  DETERMINISTIC_SUPERVISED_CLASSIFICATION_GPU_PROFILE,
} from '../../paper-domain/research/deep-learning-gpu-profile-contract.mjs';
import {
  buildDeterministicSupervisedClassificationModelIr,
} from '../../paper-domain/research/deep-learning-model-ir-contract.mjs';
import {
  buildDeepLearningReplayPlan,
  DEEP_LEARNING_REPLAY_SCOPES,
  replayDeepLearningCheckpoint,
  verifyDeepLearningIndependentReplayReceipt,
  verifyDeepLearningReplayExecutionBinding,
  verifyDeepLearningReplayPlan,
} from '../../paper-adapters/research-verify/deep-learning-independent-replay.mjs';
import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';

const H = (label) => hashRecord('DeepLearningReplayTest', { label });

function modelIr() {
  return buildDeterministicSupervisedClassificationModelIr({
    modelId: 'independent-replay-test-model',
    profileHash: DETERMINISTIC_SUPERVISED_CLASSIFICATION_GPU_PROFILE
      .deepLearningGpuProfileHash,
    inputFeatureCount: 2,
    classCount: 2,
    layers: [
      {
        layerId: 'dense1', type: 'dense', inputUnits: 2, outputUnits: 3,
        activation: 'relu', useBias: true,
      },
      {
        layerId: 'logits', type: 'dense', inputUnits: 3, outputUnits: 2,
        activation: 'identity', useBias: true,
      },
    ],
    training: {
      optimizer: 'adamw-v1',
      loss: 'sparse-cross-entropy-with-logits-v1',
      initialization: 'stateless-sha256-box-muller-v1',
      batchOrder: 'seeded-fisher-yates-v1',
      earlyStoppingEnabled: false,
      epochs: 1,
      batchSize: 2,
      learningRate: 0.01,
      weightDecay: 0,
      beta1: 0.9,
      beta2: 0.999,
      epsilon: 1e-8,
      gradientClipNorm: 10,
    },
    seed: 17,
  });
}

function dataset() {
  return buildDeepLearningInlineTrainingDataset({
    datasetId: 'independent-replay-test-dataset',
    classCount: 2,
    features: [[0, 0], [0, 1], [1, 0], [1, 1]],
    labels: [0, 1, 1, 0],
  });
}

function runtimeBom() {
  return buildDeepLearningGpuRuntimeBom({
    framework: 'cupy',
    frameworkVersion: '13.3.0',
    cudaDriverVersion: '580.173.02',
    cudaRuntimeVersion: '12.6',
    gpuComputeCapability: '8.9',
    gpuDeviceUuidHash: H('gpu-a'),
    gpuModelHash: H('rtx-4060'),
    packageClosureHash: H('cupy-lock'),
    runtimeImageDigest: H('python-gpu-image'),
  });
}

function tensorBundle(model) {
  const descriptors = model.layers.flatMap((layer) => [
    { name: `${layer.layerId}.weight`, shape: [layer.outputUnits, layer.inputUnits] },
    { name: `${layer.layerId}.bias`, shape: [layer.outputUnits] },
  ]).sort((left, right) => (left.name < right.name ? -1 : Number(left.name > right.name)));
  const chunks = [];
  const tensors = descriptors.map((descriptor) => {
    const elements = descriptor.shape.reduce((product, value) => product * value, 1);
    const bytes = Buffer.alloc(elements * 4);
    chunks.push(bytes);
    return {
      ...descriptor,
      dtype: 'float32',
      byteLength: bytes.length,
      sha256: hashBytes(bytes),
    };
  });
  return { tensors, bytes: Buffer.concat(chunks) };
}

function executionFixture(finalMetrics = {
  accuracy: 0,
  crossEntropy: 1,
  initialCrossEntropy: 1,
  gradientNorm: 1,
}) {
  const model = modelIr();
  const trainingDataset = dataset();
  const runtime = runtimeBom();
  const bundle = tensorBundle(model);
  const finiteTensorScanReceiptHash = H('finite-tensor-scan');
  const checkpointManifest = buildDeepLearningCheckpointManifest({
    trainingRunId: 'independent-replay-run',
    modelIr: model,
    runtimeBom: runtime,
    trainingDatasetManifestHash:
      trainingDataset.deepLearningTrainingDatasetManifestHash,
    completedEpoch: 1,
    trainingStepCount: 2,
    finiteTensorScanReceiptHash,
    tensors: bundle.tensors,
    tensorBundleArtifactBytes: bundle.bytes.length,
    checkpointArtifactHash: hashBytes(bundle.bytes),
  });
  const executionReceipt = buildDeepLearningTrainingExecutionReceipt({
    trainingRunId: 'independent-replay-run',
    modelIr: model,
    runtimeBom: runtime,
    trainingDatasetManifestHash:
      trainingDataset.deepLearningTrainingDatasetManifestHash,
    checkpointManifest,
    metricTraceArtifactHash: H('metric-trace'),
    finalMetrics,
  });
  return { model, trainingDataset, bundle, executionReceipt };
}

test('independent CPU replay recomputes deterministic predictions and bounded metrics', () => {
  const initial = executionFixture();
  const expectedPredictions = [0, 0, 0, 0];
  const probe = replayDeepLearningCheckpoint({
    executionReceipt: initial.executionReceipt,
    trainingDataset: initial.trainingDataset,
    tensorBundleBytes: initial.bundle.bytes,
    expectedPredictions,
    expectedMetrics: initial.executionReceipt.finalMetrics,
    replayRuntimeIdentityHash: H('node-cpu-oracle'),
  });
  assert.equal(probe.status, 'deep_learning_independent_replay_blocked');
  assert.ok(probe.observedMetrics);

  const replayMetrics = {
    ...probe.observedMetrics,
    // Gradient norm is producer-trace data and is intentionally not claimed
    // by the final-checkpoint CPU oracle (see verifiedSurface).
    gradientNorm: initial.executionReceipt.finalMetrics.gradientNorm,
  };
  const fixture = executionFixture(replayMetrics);
  const receipt = replayDeepLearningCheckpoint({
    executionReceipt: fixture.executionReceipt,
    trainingDataset: fixture.trainingDataset,
    tensorBundleBytes: fixture.bundle.bytes,
    expectedPredictions,
    expectedMetrics: fixture.executionReceipt.finalMetrics,
    replayRuntimeIdentityHash: H('node-cpu-oracle'),
  });
  assert.equal(receipt.status, 'deep_learning_independent_replay_verified');
  assert.equal(receipt.scientificChecksPassed, true);
  assert.equal(receipt.productionPromotionEligible, false);
  assert.deepEqual(receipt.blockers, []);
  assert.deepEqual(receipt.productionBlockers, [
    'deep_learning_independent_replay_authority_required',
  ]);
  assert.equal(verifyDeepLearningIndependentReplayReceipt(receipt), true);
  assert.ok(receipt.observedMetrics.crossEntropy > 0);
  assert.ok(receipt.observedMetrics.initialCrossEntropy > 0);
  assert.equal(receipt.observedMetrics.gradientNorm, null);
  assert.equal(receipt.verifiedSurface, 'checkpoint-inference-and-initial-loss-v1');
});

test('CPU replay fails closed on tensor, prediction, scope, and budget drift', () => {
  const fixture = executionFixture();
  const expectedMetrics = fixture.executionReceipt.finalMetrics;
  const expectedPredictions = [0, 0, 0, 0];
  const tampered = Buffer.from(fixture.bundle.bytes);
  tampered[0] ^= 0xff;
  const contentTamper = replayDeepLearningCheckpoint({
    executionReceipt: fixture.executionReceipt,
    trainingDataset: fixture.trainingDataset,
    tensorBundleBytes: tampered,
    expectedPredictions,
    expectedMetrics,
    replayRuntimeIdentityHash: H('node-cpu-oracle'),
  });
  assert.equal(contentTamper.scientificChecksPassed, false);
  assert.ok(contentTamper.blockers.some((item) => item.includes('tensor_bundle')));

  const predictionTamper = replayDeepLearningCheckpoint({
    executionReceipt: fixture.executionReceipt,
    trainingDataset: fixture.trainingDataset,
    tensorBundleBytes: fixture.bundle.bytes,
    expectedPredictions: [1, 1, 1, 1],
    expectedMetrics,
    replayRuntimeIdentityHash: H('node-cpu-oracle'),
  });
  assert.ok(predictionTamper.blockers.includes('deep_learning_replay_predictions_mismatch'));

  const replacementClaim = replayDeepLearningCheckpoint({
    executionReceipt: fixture.executionReceipt,
    trainingDataset: fixture.trainingDataset,
    tensorBundleBytes: fixture.bundle.bytes,
    expectedPredictions,
    expectedMetrics: {
      ...expectedMetrics,
      crossEntropy: expectedMetrics.crossEntropy + 1e-8,
    },
    replayRuntimeIdentityHash: H('node-cpu-oracle'),
  });
  assert.deepEqual(replacementClaim.blockers, ['deep_learning_replay_input_invalid']);

  const unsupportedScope = replayDeepLearningCheckpoint({
    executionReceipt: fixture.executionReceipt,
    trainingDataset: fixture.trainingDataset,
    tensorBundleBytes: fixture.bundle.bytes,
    expectedPredictions,
    expectedMetrics,
    replayRuntimeIdentityHash: H('second-gpu'),
    replayScope: DEEP_LEARNING_REPLAY_SCOPES.independentSecondGpu,
  });
  assert.deepEqual(unsupportedScope.blockers, ['deep_learning_replay_input_invalid']);

  const forged = structuredClone(predictionTamper);
  forged.productionPromotionEligible = true;
  assert.equal(verifyDeepLearningIndependentReplayReceipt(forged), false);
});

test('same-device and second-device replay plans require explicit distinct device identity', () => {
  const fixture = executionFixture();
  const same = buildDeepLearningReplayPlan({
    originalExecutionReceipt: fixture.executionReceipt,
    replayScope: DEEP_LEARNING_REPLAY_SCOPES.sameDeviceGpu,
    replayDeviceIdentityHash: H('gpu-a'),
    replayRuntimeIdentityHash: H('same-device-runtime'),
  });
  assert.equal(verifyDeepLearningReplayPlan(same), true);
  assert.throws(() => buildDeepLearningReplayPlan({
    originalExecutionReceipt: fixture.executionReceipt,
    replayScope: DEEP_LEARNING_REPLAY_SCOPES.sameDeviceGpu,
    replayDeviceIdentityHash: H('gpu-b'),
    replayRuntimeIdentityHash: H('same-device-runtime'),
  }), /same_device_must_match_original/);
  const replayCheckpointManifest = buildDeepLearningCheckpointManifest({
    trainingRunId: 'independent-replay-run-replay',
    modelIr: fixture.model,
    runtimeBom: runtimeBom(),
    trainingDatasetManifestHash:
      fixture.trainingDataset.deepLearningTrainingDatasetManifestHash,
    completedEpoch: 1,
    trainingStepCount: 2,
    finiteTensorScanReceiptHash: H('finite-tensor-scan'),
    tensors: fixture.bundle.tensors,
    tensorBundleArtifactBytes: fixture.bundle.bytes.length,
    checkpointArtifactHash: hashBytes(fixture.bundle.bytes),
  });
  const replayExecutionReceipt = buildDeepLearningTrainingExecutionReceipt({
    trainingRunId: 'independent-replay-run-replay',
    modelIr: fixture.model,
    runtimeBom: runtimeBom(),
    trainingDatasetManifestHash:
      fixture.trainingDataset.deepLearningTrainingDatasetManifestHash,
    checkpointManifest: replayCheckpointManifest,
    metricTraceArtifactHash: H('metric-trace'),
    finalMetrics: fixture.executionReceipt.finalMetrics,
  });
  assert.equal(verifyDeepLearningReplayExecutionBinding({
    plan: same,
    originalExecutionReceipt: fixture.executionReceipt,
    replayExecutionReceipt,
  }), true);
  const forgedSame = {
    ...same,
    replayDeviceIdentityHash: H('gpu-b'),
  };
  forgedSame.deepLearningReplayPlanHash = hashRecord('DeepLearningReplayPlan', {
    ...Object.fromEntries(
      Object.entries(forgedSame).filter(([key]) => key !== 'deepLearningReplayPlanHash'),
    ),
  });
  assert.equal(verifyDeepLearningReplayExecutionBinding({
    plan: forgedSame,
    originalExecutionReceipt: fixture.executionReceipt,
    replayExecutionReceipt,
  }), false);
  const second = buildDeepLearningReplayPlan({
    originalExecutionReceipt: fixture.executionReceipt,
    replayScope: DEEP_LEARNING_REPLAY_SCOPES.independentSecondGpu,
    replayDeviceIdentityHash: H('gpu-b'),
    replayRuntimeIdentityHash: H('second-device-runtime'),
  });
  assert.equal(verifyDeepLearningReplayPlan(second), true);
  assert.throws(() => buildDeepLearningReplayPlan({
    originalExecutionReceipt: fixture.executionReceipt,
    replayScope: DEEP_LEARNING_REPLAY_SCOPES.independentSecondGpu,
    replayDeviceIdentityHash: H('gpu-a'),
    replayRuntimeIdentityHash: H('second-device-runtime'),
  }), /second_gpu_must_be_distinct/);
});
