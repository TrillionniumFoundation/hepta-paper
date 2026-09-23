import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildDeepLearningCheckpointManifest,
  buildDeepLearningGpuRuntimeBom,
  buildDeepLearningHiddenEvaluationPlan,
  buildDeepLearningHiddenEvaluationReceipt,
  buildDeepLearningSameDeviceReplayReceipt,
  buildDeepLearningTrainingExecutionReceipt,
  buildDeterministicSupervisedClassificationModelIr,
  createDeepLearningGpuProductionEvidenceContract,
  DETERMINISTIC_SUPERVISED_CLASSIFICATION_GPU_PROFILE,
  verifyDeepLearningCheckpointManifest,
  verifyDeepLearningGpuRuntimeBom,
  verifyDeepLearningHiddenEvaluationPlan,
  verifyDeepLearningHiddenEvaluationReceipt,
  verifyDeepLearningSameDeviceReplayReceipt,
  verifyDeepLearningTrainingExecutionReceipt,
  verifyDeterministicSupervisedClassificationGpuProfile,
  verifyDeterministicSupervisedClassificationModelIr,
} from '../../paper-domain/research/deep-learning-gpu-production-contract.mjs';
import {
  DETERMINISTIC_SUPERVISED_CLASSIFICATION_GPU_PROFILE as REGISTRY_EXPORTED_PROFILE,
} from '../../paper-domain/automation/autonomous-empirical-family-plugin-registry.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

function H(label) {
  return hashRecord('DeepLearningGpuContractFixture', { label });
}

function modelInput(overrides = {}) {
  return {
    modelId: 'deterministic-classifier-v1',
    profileHash:
      DETERMINISTIC_SUPERVISED_CLASSIFICATION_GPU_PROFILE.deepLearningGpuProfileHash,
    inputFeatureCount: 8,
    classCount: 3,
    layers: [
      {
        layerId: 'dense1', type: 'dense', inputUnits: 8, outputUnits: 16,
        activation: 'relu', useBias: true,
      },
      {
        layerId: 'dense2', type: 'dense', inputUnits: 16, outputUnits: 8,
        activation: 'relu', useBias: true,
      },
      {
        layerId: 'logits', type: 'dense', inputUnits: 8, outputUnits: 3,
        activation: 'identity', useBias: true,
      },
    ],
    training: {
      optimizer: 'adamw-v1',
      loss: 'sparse-cross-entropy-with-logits-v1',
      initialization: 'stateless-sha256-box-muller-v1',
      batchOrder: 'seeded-fisher-yates-v1',
      earlyStoppingEnabled: false,
      epochs: 20,
      batchSize: 32,
      learningRate: 0.001,
      weightDecay: 0.0001,
      beta1: 0.9,
      beta2: 0.999,
      epsilon: 1e-8,
      gradientClipNorm: 10,
    },
    seed: 42,
    ...overrides,
  };
}

function runtimeBomInput(overrides = {}) {
  return {
    runtimeImageDigest: H('python-gpu-image'),
    packageClosureHash: H('python-gpu-packages'),
    framework: 'cupy',
    frameworkVersion: '13.3.0',
    cudaDriverVersion: '580.173.02',
    cudaRuntimeVersion: '12.6',
    gpuComputeCapability: '8.9',
    gpuDeviceUuidHash: H('gpu-device-uuid'),
    gpuModelHash: H('gpu-model'),
    ...overrides,
  };
}

function tensorsFor(modelIr) {
  return modelIr.layers.flatMap((layer) => [
    {
      name: `${layer.layerId}.weight`,
      dtype: 'float32',
      shape: [layer.outputUnits, layer.inputUnits],
      byteLength: layer.outputUnits * layer.inputUnits * 4,
      sha256: H(`${layer.layerId}-weight`),
    },
    {
      name: `${layer.layerId}.bias`,
      dtype: 'float32',
      shape: [layer.outputUnits],
      byteLength: layer.outputUnits * 4,
      sha256: H(`${layer.layerId}-bias`),
    },
  ]).sort((left, right) => (left.name < right.name ? -1 : Number(left.name > right.name)));
}

function executionFixture(trainingRunId, {
  runtimeBom = buildDeepLearningGpuRuntimeBom(runtimeBomInput()),
  checkpointArtifactHash = H('bitwise-identical-checkpoint'),
  metricTraceArtifactHash = H('bitwise-identical-metric-trace'),
} = {}) {
  const modelIr = buildDeterministicSupervisedClassificationModelIr(modelInput());
  const tensors = tensorsFor(modelIr);
  const trainingDatasetManifestHash = H('training-dataset');
  const checkpointManifest = buildDeepLearningCheckpointManifest({
    trainingRunId,
    modelIr,
    runtimeBom,
    trainingDatasetManifestHash,
    completedEpoch: 20,
    trainingStepCount: 200,
    finiteTensorScanReceiptHash: H(`${trainingRunId}-finite-scan`),
    tensors,
    tensorBundleArtifactBytes:
      tensors.reduce((total, tensor) => total + tensor.byteLength, 0),
    checkpointArtifactHash,
  });
  return buildDeepLearningTrainingExecutionReceipt({
    trainingRunId,
    modelIr,
    runtimeBom,
    trainingDatasetManifestHash,
    checkpointManifest,
    metricTraceArtifactHash,
    finalMetrics: {
      accuracy: 0.95,
      crossEntropy: 0.2,
      initialCrossEntropy: 1.2,
      gradientNorm: 0.08,
    },
  });
}

function evidenceFixture() {
  const originalExecutionReceipt = executionFixture('training-original');
  const replayExecutionReceipt = executionFixture('training-replay');
  const evaluationPlan = buildDeepLearningHiddenEvaluationPlan({
    evaluationPlanId: 'sealed-evaluation-v1',
    hiddenDatasetCommitmentHash: H('hidden-dataset'),
    evaluatorImplementationHash: H('hidden-evaluator'),
    minimumSampleCount: 128,
  });
  const hiddenEvaluationReceipt = buildDeepLearningHiddenEvaluationReceipt({
    evaluationPlan,
    executionReceipt: originalExecutionReceipt,
    sampleCount: 256,
    metrics: { accuracy: 0.91, crossEntropy: 0.27 },
    predictionsArtifactHash: H('hidden-predictions'),
  });
  const sameDeviceReplayReceipt = buildDeepLearningSameDeviceReplayReceipt({
    originalExecutionReceipt,
    replayExecutionReceipt,
    independentExecutionAuthorityHash: H('independent-executor'),
  });
  return {
    originalExecutionReceipt,
    hiddenEvaluationReceipt,
    sameDeviceReplayReceipt,
  };
}

test('GPU profile is a non-self-authorizing single-device FP32 contract', () => {
  const profile = DETERMINISTIC_SUPERVISED_CLASSIFICATION_GPU_PROFILE;
  assert.equal(REGISTRY_EXPORTED_PROFILE, profile);
  assert.equal(verifyDeterministicSupervisedClassificationGpuProfile(profile), true);
  assert.equal(profile.devicePolicy.deviceCount, 1);
  assert.equal(profile.devicePolicy.replayScope, 'same-device-uuid-and-runtime-bom-v1');
  assert.equal(profile.numericPolicy.computeDtype, 'float32');
  assert.equal(profile.numericPolicy.automaticMixedPrecisionEnabled, false);
  assert.equal(profile.numericPolicy.tensorFloat32Enabled, false);
  assert.equal(profile.dataPipelinePolicy.dataLoaderWorkers, 0);
  assert.equal(profile.checkpointPolicy.pickleAllowed, false);
  assert.equal(profile.extensionPolicy.customCodeAllowed, false);
  assert.equal(profile.extensionPolicy.customCudaAllowed, false);
  assert.equal(profile.qualificationPolicy.selfAuthorizesProductionPromotion, false);

  const forged = structuredClone(profile);
  forged.extensionPolicy.customCudaAllowed = true;
  assert.equal(verifyDeterministicSupervisedClassificationGpuProfile(forged), false);
});

test('model IR is declarative, bounded, finite, and exact-key only', () => {
  const ir = buildDeterministicSupervisedClassificationModelIr(modelInput());
  assert.equal(verifyDeterministicSupervisedClassificationModelIr(ir), true);
  assert.deepEqual(ir.operatorAllowlist, ['dense', 'relu', 'identity']);
  assert.equal(ir.executableCodeEmbedded, false);
  assert.equal(ir.customOperatorsAllowed, false);
  assert.equal(ir.parameterCount, 307);

  const mixedCase = buildDeterministicSupervisedClassificationModelIr(modelInput({
    layers: [
      {
        layerId: 'a', type: 'dense', inputUnits: 8, outputUnits: 4,
        activation: 'relu', useBias: true,
      },
      {
        layerId: 'B', type: 'dense', inputUnits: 4, outputUnits: 3,
        activation: 'identity', useBias: true,
      },
    ],
  }));
  assert.deepEqual(tensorsFor(mixedCase).map((tensor) => tensor.name), [
    'B.bias', 'B.weight', 'a.bias', 'a.weight',
  ]);

  assert.throws(
    () => buildDeterministicSupervisedClassificationModelIr({
      ...modelInput(), customCode: 'import arbitrary_payload',
    }),
    /input_shape_invalid/,
  );
  assert.throws(() => buildDeterministicSupervisedClassificationModelIr(modelInput({
    training: { ...modelInput().training, learningRate: Number.NaN },
  })), /training_configuration_invalid/);
  assert.throws(() => buildDeterministicSupervisedClassificationModelIr(modelInput({
    training: { ...modelInput().training, gradientClipNorm: Number.POSITIVE_INFINITY },
  })), /training_configuration_invalid/);
  assert.throws(() => buildDeterministicSupervisedClassificationModelIr(modelInput({
    layers: modelInput().layers.map((layer, index) => (
      index === 0 ? { ...layer, type: 'custom-cuda-kernel' } : layer
    )),
  })), /model_layer_invalid/);
  assert.throws(() => buildDeterministicSupervisedClassificationModelIr(modelInput({
    layers: modelInput().layers.map((layer, index) => (
      index === 0 ? { ...layer, source: 'custom.py' } : layer
    )),
  })), /model_layer_invalid/);
});

test('runtime, checkpoint, and training receipts bind safe non-executable tensors', () => {
  const receipt = executionFixture('training-safe');
  assert.equal(verifyDeepLearningGpuRuntimeBom(receipt.runtimeBom), true);
  assert.equal(verifyDeepLearningCheckpointManifest(receipt.checkpointManifest, {
    modelIr: receipt.modelIr,
    runtimeBom: receipt.runtimeBom,
  }), true);
  assert.equal(verifyDeepLearningTrainingExecutionReceipt(receipt), true);
  assert.equal(receipt.runtimeBom.deviceCount, 1);
  assert.equal(receipt.runtimeBom.automaticMixedPrecisionEnabled, false);
  assert.equal(receipt.runtimeBom.tensorFloat32Enabled, false);
  assert.equal(receipt.runtimeBom.dataLoaderWorkers, 0);
  assert.equal(receipt.checkpointManifest.format, 'hepta-tensor-bundle-v1');
  assert.equal(receipt.checkpointManifest.pickleAllowed, false);
  assert.equal(receipt.checkpointManifest.executablePayloadAllowed, false);
  assert.equal(receipt.selfAuthorizesProductionPromotion, false);

  assert.throws(() => buildDeepLearningGpuRuntimeBom({
    ...runtimeBomInput(), customCudaLibraryHash: H('custom-cuda'),
  }), /runtime_bom_invalid/);
  const modelIr = receipt.modelIr;
  const runtimeBom = receipt.runtimeBom;
  const tensors = tensorsFor(modelIr);
  assert.throws(() => buildDeepLearningCheckpointManifest({
    trainingRunId: 'bad-checkpoint',
    modelIr,
    runtimeBom,
    trainingDatasetManifestHash: H('training-dataset'),
    completedEpoch: 20,
    trainingStepCount: 200,
    finiteTensorScanReceiptHash: H('finite-scan'),
    tensors: tensors.map((tensor, index) => (
      index === 0 ? { ...tensor, picklePayload: true } : tensor
    )),
    tensorBundleArtifactBytes:
      tensors.reduce((total, tensor) => total + tensor.byteLength, 0),
    checkpointArtifactHash: H('checkpoint'),
  }), /checkpoint_tensor_invalid/);
  assert.throws(() => buildDeepLearningTrainingExecutionReceipt({
    trainingRunId: receipt.trainingRunId,
    modelIr,
    runtimeBom,
    trainingDatasetManifestHash: receipt.trainingDatasetManifestHash,
    checkpointManifest: receipt.checkpointManifest,
    metricTraceArtifactHash: receipt.metricTraceArtifactHash,
    finalMetrics: { ...receipt.finalMetrics, accuracy: Number.NaN },
  }), /training_metrics_invalid/);

  const hostile = { ...receipt };
  Object.defineProperty(hostile, 'kind', { get() { throw new Error('hostile'); } });
  assert.equal(verifyDeepLearningTrainingExecutionReceipt(hostile), false);
});

test('hidden evaluation and replay are exact but cannot self-authorize production', () => {
  const fixture = evidenceFixture();
  assert.equal(verifyDeepLearningHiddenEvaluationPlan(
    fixture.hiddenEvaluationReceipt.evaluationPlan,
  ), true);
  assert.equal(verifyDeepLearningHiddenEvaluationReceipt(
    fixture.hiddenEvaluationReceipt,
    { executionReceipt: fixture.originalExecutionReceipt },
  ), true);
  assert.equal(verifyDeepLearningSameDeviceReplayReceipt(
    fixture.sameDeviceReplayReceipt,
  ), true);
  assert.equal(
    fixture.hiddenEvaluationReceipt.trainingWorkerHadHiddenDatasetAccess,
    false,
  );
  assert.equal(fixture.hiddenEvaluationReceipt.modelSelectionUsedHiddenMetrics, false);

  const contract = createDeepLearningGpuProductionEvidenceContract();
  const evidence = contract.buildDeepLearningGpuProductionEvidenceReceipt(fixture);
  assert.equal(evidence.status, 'deep_learning_gpu_production_evidence_blocked');
  assert.equal(evidence.productionPromotionEligible, false);
  assert.deepEqual(evidence.blockers, [
    'deep_learning_canonical_original_os_receipt_unavailable',
    'deep_learning_canonical_replay_os_receipt_unavailable',
    'deep_learning_gpu_runtime_signed_authority_document_unavailable',
    'deep_learning_finite_tensor_signed_authority_document_unavailable',
    'deep_learning_hidden_evaluation_signed_authority_document_unavailable',
    'deep_learning_independent_replay_signed_authority_document_unavailable',
    'deep_learning_production_authority_trust_root_unavailable',
  ]);
  assert.equal(
    contract.verifyDeepLearningGpuProductionEvidenceBlockedReceipt(evidence),
    true,
  );
  assert.equal(contract.verifyDeepLearningGpuProductionEvidenceReceipt(evidence), false);

  let callbackInvocations = 0;
  assert.throws(() => createDeepLearningGpuProductionEvidenceContract({
    verifyRuntimeQualificationAuthority() {
      callbackInvocations += 1;
      return true;
    },
  }), /authority_callback_injection_forbidden/);
  assert.equal(callbackInvocations, 0);

  const forged = structuredClone(evidence);
  forged.status = 'deep_learning_gpu_production_evidence_verified';
  forged.productionPromotionEligible = true;
  assert.equal(contract.verifyDeepLearningGpuProductionEvidenceReceipt(forged), false);
  assert.equal(
    contract.verifyDeepLearningGpuProductionEvidenceBlockedReceipt(forged),
    false,
  );
});

test('cross-device, non-independent, hidden-leak, and non-finite forgeries fail closed', () => {
  const original = executionFixture('original-adversarial');
  const otherDevice = buildDeepLearningGpuRuntimeBom(runtimeBomInput({
    gpuDeviceUuidHash: H('different-gpu-device'),
  }));
  const crossDeviceReplay = executionFixture('replay-other-device', {
    runtimeBom: otherDevice,
  });
  assert.throws(() => buildDeepLearningSameDeviceReplayReceipt({
    originalExecutionReceipt: original,
    replayExecutionReceipt: crossDeviceReplay,
    independentExecutionAuthorityHash: H('independent'),
  }), /same_device_replay_receipt_invalid/);
  assert.throws(() => buildDeepLearningSameDeviceReplayReceipt({
    originalExecutionReceipt: original,
    replayExecutionReceipt: original,
    independentExecutionAuthorityHash: H('independent'),
  }), /same_device_replay_receipt_invalid/);

  const plan = buildDeepLearningHiddenEvaluationPlan({
    evaluationPlanId: 'adversarial-plan',
    hiddenDatasetCommitmentHash: H('hidden'),
    evaluatorImplementationHash: H('evaluator'),
    minimumSampleCount: 16,
  });
  assert.throws(() => buildDeepLearningHiddenEvaluationReceipt({
    evaluationPlan: plan,
    executionReceipt: original,
    sampleCount: 16,
    metrics: { accuracy: 0.9, crossEntropy: Number.POSITIVE_INFINITY },
    predictionsArtifactHash: H('predictions'),
  }), /evaluation_metrics_invalid/);

  const valid = buildDeepLearningHiddenEvaluationReceipt({
    evaluationPlan: plan,
    executionReceipt: original,
    sampleCount: 16,
    metrics: { accuracy: 0.9, crossEntropy: 0.3 },
    predictionsArtifactHash: H('predictions'),
  });
  const forged = structuredClone(valid);
  forged.trainingWorkerHadHiddenDatasetAccess = true;
  const { deepLearningHiddenEvaluationReceiptHash: _old, ...payload } = forged;
  forged.deepLearningHiddenEvaluationReceiptHash =
    hashRecord('DeepLearningHiddenEvaluationReceipt', payload);
  assert.equal(verifyDeepLearningHiddenEvaluationReceipt(forged, {
    executionReceipt: original,
  }), false);
});
