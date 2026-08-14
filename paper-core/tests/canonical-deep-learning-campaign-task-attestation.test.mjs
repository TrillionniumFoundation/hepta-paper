import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildCanonicalDeepLearningCampaignTaskAttestation,
  verifyCanonicalDeepLearningCampaignTaskAttestation,
} from '../../paper-adapters/automation/canonical-deep-learning-campaign-task-attestation.mjs';
import {
  buildDeepLearningCupyMlpCampaignTask,
} from '../../paper-domain/automation/gpu-scientific-campaign-execution-contract.mjs';
import {
  DETERMINISTIC_SUPERVISED_CLASSIFICATION_GPU_PROFILE,
} from '../../paper-domain/research/deep-learning-gpu-profile-contract.mjs';
import {
  buildDeterministicSupervisedClassificationModelIr,
} from '../../paper-domain/research/deep-learning-model-ir-contract.mjs';
import {
  buildCanonicalParityDeepLearningTrainingDataset,
  buildCanonicalSyntheticDeepLearningDatasetAuthority,
} from '../../paper-domain/research/deep-learning-training-dataset-authority-contract.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const GPU = 'GPU-a33875b7-7eb7-679e-df08-19227d3decee';
const DEADLINE = 2_000_000_000_000;

function rehashAttestation(value) {
  const payload = { ...value };
  delete payload.canonicalDeepLearningCampaignTaskAttestationHash;
  value.canonicalDeepLearningCampaignTaskAttestationHash = hashRecord(
    'CanonicalDeepLearningCampaignTaskAttestation', payload,
  );
}

test('DL campaign attestation is adapter-only and rejects generic receipt repackaging', () => {
  const trainingDataset = buildCanonicalParityDeepLearningTrainingDataset({
    datasetId: 'strict-attestation-dataset', featureCount: 2,
  });
  const modelIr = buildDeterministicSupervisedClassificationModelIr({
    modelId: 'strict-attestation-model',
    profileHash:
      DETERMINISTIC_SUPERVISED_CLASSIFICATION_GPU_PROFILE.deepLearningGpuProfileHash,
    inputFeatureCount: 2, classCount: 2,
    layers: [
      { layerId: 'hidden', type: 'dense', inputUnits: 2, outputUnits: 3,
        activation: 'relu', useBias: true },
      { layerId: 'logits', type: 'dense', inputUnits: 3, outputUnits: 2,
        activation: 'identity', useBias: true },
    ],
    training: {
      optimizer: 'adamw-v1', loss: 'sparse-cross-entropy-with-logits-v1',
      initialization: 'stateless-sha256-box-muller-v1',
      batchOrder: 'seeded-fisher-yates-v1', earlyStoppingEnabled: false,
      epochs: 1, batchSize: 2, learningRate: 0.01, weightDecay: 0,
      beta1: 0.9, beta2: 0.999, epsilon: 1e-8, gradientClipNorm: 10,
    },
    seed: 23,
  });
  const task = buildDeepLearningCupyMlpCampaignTask({
    trainingRunId: 'strict-attestation-test',
    profile: DETERMINISTIC_SUPERVISED_CLASSIFICATION_GPU_PROFILE,
    modelIr,
    trainingDataset,
    trainingDatasetAuthority: buildCanonicalSyntheticDeepLearningDatasetAuthority({
      trainingDataset,
      generatorSpec: { datasetId: trainingDataset.datasetId, featureCount: 2 },
    }),
  });
  assert.throws(() => buildCanonicalDeepLearningCampaignTaskAttestation({
    task,
    canonicalTrainingReceipt: {
      version: 5,
      kind: 'OsSandboxWorkerReceipt',
      status: 'os_sandbox_worker_passed',
      productionPromotionEligible: false,
    },
    gpuDeviceSelector: GPU,
    absoluteDeadlineEpochMs: DEADLINE,
  }), /canonical_deep_learning_campaign_task_attestation_invalid/);
  assert.equal(verifyCanonicalDeepLearningCampaignTaskAttestation({}), false);

  const forged = {
    version: 1,
    kind: 'CanonicalDeepLearningCampaignTaskAttestation',
    status: 'canonical_deep_learning_campaign_task_attested_non_promotable',
    taskHash: 'sha256:'.padEnd(71, '0'),
  };
  rehashAttestation(forged);
  assert.equal(verifyCanonicalDeepLearningCampaignTaskAttestation(forged, {
    task, gpuDeviceSelector: GPU, absoluteDeadlineEpochMs: DEADLINE,
  }), false);
});
