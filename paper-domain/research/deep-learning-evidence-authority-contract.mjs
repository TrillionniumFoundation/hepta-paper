import { deepFreezeJsonValue } from '../../workflow-kernel/deep-freeze-json-value.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  exactPlainObject,
  finiteNumberInRange,
  jsonEqual,
  requiredDeepLearningHash,
  requiredDeepLearningId,
  safeIntegerInRange,
} from './deep-learning-contract-primitives.mjs';
import {
  verifyDeepLearningTrainingExecutionReceipt,
} from './deep-learning-training-execution-contract.mjs';

const PLAN_INPUT_KEYS = Object.freeze([
  'evaluationPlanId', 'evaluatorImplementationHash', 'hiddenDatasetCommitmentHash',
  'minimumSampleCount',
]);
const PLAN_KEYS = Object.freeze([
  'deepLearningHiddenEvaluationPlanHash', 'evaluationPlanId',
  'evaluatorImplementationHash', 'hiddenDatasetCommitmentHash', 'kind',
  'labelVisibility', 'metricAllowlist', 'minimumSampleCount',
  'modelSelectionAccessAllowed', 'splitPolicy', 'task', 'version',
]);
const HIDDEN_INPUT_KEYS = Object.freeze([
  'evaluationPlan', 'executionReceipt', 'metrics', 'predictionsArtifactHash',
  'sampleCount',
]);
const HIDDEN_KEYS = Object.freeze([
  'checkpointManifestHash', 'deepLearningHiddenEvaluationReceiptHash',
  'evaluationPlan', 'evaluationPlanHash', 'executionReceiptHash',
  'kind', 'metrics', 'modelSelectionUsedHiddenMetrics', 'predictionsArtifactHash',
  'productionAuthorityRequired', 'sampleCount', 'status',
  'trainingWorkerHadHiddenDatasetAccess', 'version',
]);
const METRIC_KEYS = Object.freeze(['accuracy', 'crossEntropy']);
const REPLAY_INPUT_KEYS = Object.freeze([
  'independentExecutionAuthorityHash', 'originalExecutionReceipt',
  'replayExecutionReceipt',
]);
const REPLAY_KEYS = Object.freeze([
  'deepLearningSameDeviceReplayReceiptHash', 'determinismScope',
  'independentExecutionAuthorityHash', 'independentProcessRequired', 'kind',
  'originalExecutionReceipt', 'originalExecutionReceiptHash',
  'productionAuthorityRequired', 'replayExecutionReceipt',
  'replayExecutionReceiptHash', 'status', 'version',
]);
const EVIDENCE_INPUT_KEYS = Object.freeze([
  'hiddenEvaluationReceipt', 'originalExecutionReceipt', 'sameDeviceReplayReceipt',
]);
const EVIDENCE_KEYS = Object.freeze([
  'blockers', 'deepLearningGpuProductionEvidenceReceiptHash',
  'hiddenEvaluationReceipt', 'hiddenEvaluationReceiptHash', 'kind',
  'originalExecutionReceipt', 'originalExecutionReceiptHash',
  'productionPromotionEligible', 'sameDeviceReplayReceipt',
  'sameDeviceReplayReceiptHash', 'status', 'version',
]);
const AUTHORITY_SCOPES = Object.freeze({
  runtime: 'deep-learning-gpu-runtime-qualification-v1',
  finiteTensor: 'deep-learning-finite-tensor-scan-authority-v1',
  hiddenEvaluation: 'deep-learning-hidden-evaluation-authority-v1',
  replay: 'deep-learning-independent-same-device-replay-authority-v1',
});
const PRODUCTION_AUTHORITY_BLOCKERS = Object.freeze([
  'deep_learning_canonical_original_os_receipt_unavailable',
  'deep_learning_canonical_replay_os_receipt_unavailable',
  'deep_learning_gpu_runtime_signed_authority_document_unavailable',
  'deep_learning_finite_tensor_signed_authority_document_unavailable',
  'deep_learning_hidden_evaluation_signed_authority_document_unavailable',
  'deep_learning_independent_replay_signed_authority_document_unavailable',
  'deep_learning_production_authority_trust_root_unavailable',
]);

export function buildDeepLearningHiddenEvaluationPlan(value = {}) {
  if (!exactPlainObject(value, PLAN_INPUT_KEYS)
    || !requiredDeepLearningId(value.evaluationPlanId)
    || !requiredDeepLearningHash(value.evaluatorImplementationHash)
    || !requiredDeepLearningHash(value.hiddenDatasetCommitmentHash)
    || !safeIntegerInRange(value.minimumSampleCount, 2, 100_000_000)) {
    throw new Error('deep_learning_hidden_evaluation_plan_invalid');
  }
  const payload = {
    version: 1,
    kind: 'DeepLearningHiddenEvaluationPlan',
    evaluationPlanId: value.evaluationPlanId,
    task: 'supervised-classification',
    hiddenDatasetCommitmentHash: requiredDeepLearningHash(value.hiddenDatasetCommitmentHash),
    evaluatorImplementationHash: requiredDeepLearningHash(value.evaluatorImplementationHash),
    metricAllowlist: Object.freeze(['accuracy', 'crossEntropy']),
    minimumSampleCount: value.minimumSampleCount,
    splitPolicy: 'sealed-holdout-not-mounted-during-training-v1',
    labelVisibility: 'evaluation-service-only-v1',
    modelSelectionAccessAllowed: false,
  };
  return deepFreezeJsonValue({
    ...payload,
    deepLearningHiddenEvaluationPlanHash:
      hashRecord('DeepLearningHiddenEvaluationPlan', payload),
  });
}

function hiddenEvaluationPlanInput(value) {
  return Object.fromEntries(PLAN_INPUT_KEYS.map((key) => [key, value?.[key]]));
}

export function verifyDeepLearningHiddenEvaluationPlan(value) {
  try {
    return exactPlainObject(value, PLAN_KEYS)
      && jsonEqual(buildDeepLearningHiddenEvaluationPlan(
        hiddenEvaluationPlanInput(value),
      ), value);
  } catch {
    return false;
  }
}

function compileEvaluationMetrics(value) {
  if (!exactPlainObject(value, METRIC_KEYS)
    || !finiteNumberInRange(value.accuracy, 0, 1)
    || !finiteNumberInRange(value.crossEntropy, 0, Number.MAX_VALUE)) {
    throw new Error('deep_learning_hidden_evaluation_metrics_invalid');
  }
  return Object.freeze({ ...value });
}

export function buildDeepLearningHiddenEvaluationReceipt(value = {}) {
  if (!exactPlainObject(value, HIDDEN_INPUT_KEYS)
    || !verifyDeepLearningHiddenEvaluationPlan(value.evaluationPlan)
    || !verifyDeepLearningTrainingExecutionReceipt(value.executionReceipt)
    || !safeIntegerInRange(
      value.sampleCount,
      value.evaluationPlan?.minimumSampleCount || Number.MAX_SAFE_INTEGER,
      100_000_000,
    )
    || !requiredDeepLearningHash(value.predictionsArtifactHash)) {
    throw new Error('deep_learning_hidden_evaluation_receipt_invalid');
  }
  const payload = {
    version: 1,
    kind: 'DeepLearningHiddenEvaluationReceipt',
    status: 'deep_learning_hidden_evaluation_recorded',
    evaluationPlanHash: value.evaluationPlan.deepLearningHiddenEvaluationPlanHash,
    evaluationPlan: value.evaluationPlan,
    executionReceiptHash:
      value.executionReceipt.deepLearningTrainingExecutionReceiptHash,
    checkpointManifestHash: value.executionReceipt.checkpointManifestHash,
    sampleCount: value.sampleCount,
    metrics: compileEvaluationMetrics(value.metrics),
    predictionsArtifactHash: requiredDeepLearningHash(value.predictionsArtifactHash),
    trainingWorkerHadHiddenDatasetAccess: false,
    modelSelectionUsedHiddenMetrics: false,
    productionAuthorityRequired: true,
  };
  return deepFreezeJsonValue({
    ...payload,
    deepLearningHiddenEvaluationReceiptHash:
      hashRecord('DeepLearningHiddenEvaluationReceipt', payload),
  });
}

function hiddenEvaluationInput(value, executionReceipt) {
  return {
    evaluationPlan: value.evaluationPlan,
    executionReceipt,
    sampleCount: value.sampleCount,
    metrics: value.metrics,
    predictionsArtifactHash: value.predictionsArtifactHash,
  };
}

export function verifyDeepLearningHiddenEvaluationReceipt(
  value,
  { executionReceipt } = {},
) {
  try {
    return exactPlainObject(value, HIDDEN_KEYS)
      && jsonEqual(buildDeepLearningHiddenEvaluationReceipt(
        hiddenEvaluationInput(value, executionReceipt),
      ), value);
  } catch {
    return false;
  }
}

function executionReplayMatches(original, replay) {
  return original.trainingRunId !== replay.trainingRunId
    && original.deepLearningTrainingExecutionReceiptHash
      !== replay.deepLearningTrainingExecutionReceiptHash
    && original.profileHash === replay.profileHash
    && original.modelIrHash === replay.modelIrHash
    && original.trainingDatasetManifestHash === replay.trainingDatasetManifestHash
    && original.runtimeBomHash === replay.runtimeBomHash
    && original.runtimeBom.gpuDeviceUuidHash === replay.runtimeBom.gpuDeviceUuidHash
    && original.runtimeBom.deviceCount === 1
    && replay.runtimeBom.deviceCount === 1
    && original.checkpointManifest.checkpointArtifactHash
      === replay.checkpointManifest.checkpointArtifactHash
    && original.checkpointManifest.tensorSetHash
      === replay.checkpointManifest.tensorSetHash
    && original.metricTraceArtifactHash === replay.metricTraceArtifactHash
    && jsonEqual(original.finalMetrics, replay.finalMetrics);
}

export function buildDeepLearningSameDeviceReplayReceipt(value = {}) {
  if (!exactPlainObject(value, REPLAY_INPUT_KEYS)
    || !verifyDeepLearningTrainingExecutionReceipt(value.originalExecutionReceipt)
    || !verifyDeepLearningTrainingExecutionReceipt(value.replayExecutionReceipt)
    || !requiredDeepLearningHash(value.independentExecutionAuthorityHash)
    || !executionReplayMatches(
      value.originalExecutionReceipt,
      value.replayExecutionReceipt,
    )) {
    throw new Error('deep_learning_same_device_replay_receipt_invalid');
  }
  const payload = {
    version: 1,
    kind: 'DeepLearningSameDeviceReplayReceipt',
    status: 'deep_learning_same_device_replay_recorded',
    determinismScope: 'same-device-uuid-and-runtime-bom-v1',
    originalExecutionReceiptHash:
      value.originalExecutionReceipt.deepLearningTrainingExecutionReceiptHash,
    originalExecutionReceipt: value.originalExecutionReceipt,
    replayExecutionReceiptHash:
      value.replayExecutionReceipt.deepLearningTrainingExecutionReceiptHash,
    replayExecutionReceipt: value.replayExecutionReceipt,
    independentExecutionAuthorityHash:
      requiredDeepLearningHash(value.independentExecutionAuthorityHash),
    independentProcessRequired: true,
    productionAuthorityRequired: true,
  };
  return deepFreezeJsonValue({
    ...payload,
    deepLearningSameDeviceReplayReceiptHash:
      hashRecord('DeepLearningSameDeviceReplayReceipt', payload),
  });
}

function sameDeviceReplayInput(value) {
  return {
    originalExecutionReceipt: value.originalExecutionReceipt,
    replayExecutionReceipt: value.replayExecutionReceipt,
    independentExecutionAuthorityHash: value.independentExecutionAuthorityHash,
  };
}

export function verifyDeepLearningSameDeviceReplayReceipt(value) {
  try {
    return exactPlainObject(value, REPLAY_KEYS)
      && jsonEqual(buildDeepLearningSameDeviceReplayReceipt(
        sameDeviceReplayInput(value),
      ), value);
  } catch {
    return false;
  }
}

export function createDeepLearningGpuProductionEvidenceContract(options = {}) {
  if (!exactPlainObject(options, [])) {
    throw new Error('deep_learning_production_authority_callback_injection_forbidden');
  }

  function buildDeepLearningGpuProductionEvidenceReceipt(value = {}) {
    if (!exactPlainObject(value, EVIDENCE_INPUT_KEYS)
      || !verifyDeepLearningTrainingExecutionReceipt(value.originalExecutionReceipt)
      || !verifyDeepLearningHiddenEvaluationReceipt(value.hiddenEvaluationReceipt, {
        executionReceipt: value.originalExecutionReceipt,
      })
      || !verifyDeepLearningSameDeviceReplayReceipt(value.sameDeviceReplayReceipt)
      || value.sameDeviceReplayReceipt.originalExecutionReceiptHash
        !== value.originalExecutionReceipt.deepLearningTrainingExecutionReceiptHash
      || !jsonEqual(
        value.sameDeviceReplayReceipt.originalExecutionReceipt,
        value.originalExecutionReceipt,
      )) {
      throw new Error('deep_learning_gpu_production_evidence_input_invalid');
    }
    const payload = {
      version: 1,
      kind: 'DeepLearningGpuProductionEvidenceReceipt',
      status: 'deep_learning_gpu_production_evidence_blocked',
      productionPromotionEligible: false,
      originalExecutionReceiptHash:
        value.originalExecutionReceipt.deepLearningTrainingExecutionReceiptHash,
      originalExecutionReceipt: value.originalExecutionReceipt,
      hiddenEvaluationReceiptHash:
        value.hiddenEvaluationReceipt.deepLearningHiddenEvaluationReceiptHash,
      hiddenEvaluationReceipt: value.hiddenEvaluationReceipt,
      sameDeviceReplayReceiptHash:
        value.sameDeviceReplayReceipt.deepLearningSameDeviceReplayReceiptHash,
      sameDeviceReplayReceipt: value.sameDeviceReplayReceipt,
      blockers: PRODUCTION_AUTHORITY_BLOCKERS,
    };
    return deepFreezeJsonValue({
      ...payload,
      deepLearningGpuProductionEvidenceReceiptHash:
        hashRecord('DeepLearningGpuProductionEvidenceReceipt', payload),
    });
  }

  function verifyDeepLearningGpuProductionEvidenceBlockedReceipt(value) {
    try {
      if (!exactPlainObject(value, EVIDENCE_KEYS)
        || value.status !== 'deep_learning_gpu_production_evidence_blocked'
        || value.productionPromotionEligible !== false
        || !jsonEqual(value.blockers, PRODUCTION_AUTHORITY_BLOCKERS)) return false;
      const rebuilt = buildDeepLearningGpuProductionEvidenceReceipt({
        originalExecutionReceipt: value.originalExecutionReceipt,
        hiddenEvaluationReceipt: value.hiddenEvaluationReceipt,
        sameDeviceReplayReceipt: value.sameDeviceReplayReceipt,
      });
      return jsonEqual(rebuilt, value);
    } catch {
      return false;
    }
  }

  function verifyDeepLearningGpuProductionEvidenceReceipt() {
    return false;
  }

  return Object.freeze({
    buildDeepLearningGpuProductionEvidenceReceipt,
    verifyDeepLearningGpuProductionEvidenceBlockedReceipt,
    verifyDeepLearningGpuProductionEvidenceReceipt,
  });
}

export const DEEP_LEARNING_GPU_PRODUCTION_AUTHORITY_SCOPES = AUTHORITY_SCOPES;
