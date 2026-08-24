import crypto from 'node:crypto';

import { deepFreezeJsonValue } from '../../workflow-kernel/deep-freeze-json-value.mjs';
import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  exactPlainObject,
  jsonEqual,
} from '../../paper-domain/research/deep-learning-contract-primitives.mjs';
import {
  verifyDeepLearningInlineTrainingDataset,
} from '../../paper-domain/research/deep-learning-training-dataset-contract.mjs';
import {
  verifyDeepLearningTrainingExecutionReceipt,
} from '../../paper-domain/research/deep-learning-training-execution-contract.mjs';

// This module is intentionally a small, dependency-free CPU oracle.  It does
// not import CuPy/PyTorch and never consumes producer-reported metrics.  Its
// purpose is to make a local replay useful while keeping the production gate
// closed until an independently operated authority signs the replay.

const SHA256 = /^sha256:[0-9a-f]{64}$/u;

export const DEEP_LEARNING_REPLAY_SCOPES = Object.freeze({
  independentCpuOracle: 'independent-cpu-oracle-v1',
  sameDeviceGpu: 'same-device-gpu-v1',
  independentSecondGpu: 'independent-second-gpu-v1',
});

export const DEEP_LEARNING_REPLAY_ERROR_BUDGET = Object.freeze({
  version: 1,
  kind: 'DeepLearningReplayErrorBudget',
  // CPU arithmetic is deliberately independent from the CuPy producer.  A
  // bounded tolerance is therefore required for cross-runtime loss values;
  // class predictions remain an exact invariant.
  maximumAbsoluteCrossEntropy: 1e-4,
  maximumRelativeCrossEntropy: 1e-4,
  maximumAbsoluteInitialCrossEntropy: 1e-4,
  maximumRelativeInitialCrossEntropy: 1e-4,
  gradientNormComparison: 'not-derivable-from-final-checkpoint-v1',
  maximumAccuracyDifference: 0,
  requirePredictionEquality: true,
});

const REPLAY_RECEIPT_KEYS = Object.freeze([
  'blockers', 'checkpointArtifactHash', 'checkpointManifestHash',
  'deepLearningIndependentReplayReceiptHash', 'errorBudget',
  'expectedMetrics', 'expectedPredictionHash', 'executionReceiptHash',
  'kind', 'observedMetrics', 'observedPredictionHash', 'verifiedSurface',
  'productionBlockers', 'productionPromotionEligible', 'replayRuntimeIdentityHash',
  'replayScope', 'scientificChecksPassed', 'status', 'tensorBundleHash',
  'version',
]);

const PLAN_KEYS = Object.freeze([
  'deepLearningReplayPlanHash', 'errorBudget', 'kind',
  'originalExecutionReceiptHash', 'productionAuthorityRequired',
  'replayDeviceIdentityHash', 'replayRuntimeIdentityHash', 'replayScope',
  'status', 'version',
]);

const PRODUCTION_BLOCKERS = Object.freeze([
  'deep_learning_independent_replay_authority_required',
]);

const VERIFIED_SURFACE = 'checkpoint-inference-and-initial-loss-v1';

function isHash(value) {
  return SHA256.test(String(value || ''));
}

function finiteMetric(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function exactMetricObject(value) {
  return exactPlainObject(value, [
    'accuracy', 'crossEntropy', 'gradientNorm', 'initialCrossEntropy',
  ])
    && finiteMetric(value.accuracy) && value.accuracy <= 1
    && finiteMetric(value.crossEntropy)
    && finiteMetric(value.initialCrossEntropy)
    && finiteMetric(value.gradientNorm);
}

function exactErrorBudget(value) {
  return exactPlainObject(value, Object.keys(DEEP_LEARNING_REPLAY_ERROR_BUDGET))
    && jsonEqual(value, DEEP_LEARNING_REPLAY_ERROR_BUDGET);
}

function relativeDifference(observed, expected) {
  return Math.abs(observed - expected) / Math.max(Math.abs(expected), 1e-12);
}

function metricWithinBudget(observed, expected, absolute, relative) {
  return Math.abs(observed - expected) <= absolute
    || relativeDifference(observed, expected) <= relative;
}

function decodeTensorBundle({ tensorBundleBytes, checkpointManifest }) {
  if (!Buffer.isBuffer(tensorBundleBytes)
    || !checkpointManifest
    || tensorBundleBytes.length !== checkpointManifest.tensorBundleArtifactBytes
    || hashBytes(tensorBundleBytes) !== checkpointManifest.checkpointArtifactHash) {
    throw new Error('deep_learning_replay_tensor_bundle_binding_invalid');
  }
  const tensors = new Map();
  let offset = 0;
  for (const descriptor of checkpointManifest.tensors) {
    if (offset + descriptor.byteLength > tensorBundleBytes.length) {
      throw new Error('deep_learning_replay_tensor_bundle_truncated');
    }
    const bytes = tensorBundleBytes.subarray(offset, offset + descriptor.byteLength);
    if (hashBytes(bytes) !== descriptor.sha256) {
      throw new Error(`deep_learning_replay_tensor_hash_mismatch:${descriptor.name}`);
    }
    const values = new Float64Array(descriptor.byteLength / 4);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let index = 0; index < values.length; index += 1) {
      values[index] = view.getFloat32(index * 4, true);
      if (!Number.isFinite(values[index])) {
        throw new Error(`deep_learning_replay_tensor_nonfinite:${descriptor.name}`);
      }
    }
    tensors.set(descriptor.name, Object.freeze({
      descriptor,
      values,
    }));
    offset += descriptor.byteLength;
  }
  if (offset !== tensorBundleBytes.length) {
    throw new Error('deep_learning_replay_tensor_bundle_trailing_bytes');
  }
  return tensors;
}

function digestBytes(value) {
  return crypto.createHash('sha256').update(value).digest();
}

function deterministicUniforms(seed, name, count) {
  const values = new Float64Array(count + (count % 2));
  let cursor = 0;
  let counter = 0;
  const prefix = Buffer.from(`${seed}\0${name}\0`, 'utf8');
  while (cursor < values.length) {
    const digest = digestBytes(Buffer.concat([
      prefix,
      Buffer.from(String(counter), 'ascii'),
    ]));
    for (let index = 0; index < 8 && cursor < values.length; index += 1) {
      const integer = digest.readUInt32BE(index * 4);
      values[cursor] = (integer + 0.5) / 4294967296;
      cursor += 1;
    }
    counter += 1;
  }
  const result = new Float64Array(values.length);
  for (let index = 0; index < values.length; index += 2) {
    const radius = Math.sqrt(-2 * Math.log(values[index]));
    const angle = 2 * Math.PI * values[index + 1];
    result[index] = radius * Math.cos(angle);
    result[index + 1] = radius * Math.sin(angle);
  }
  return result.subarray(0, count);
}

function initialTensorMap(modelIr) {
  const tensors = new Map();
  for (const layer of modelIr.layers) {
    const count = layer.outputUnits * layer.inputUnits;
    const uniforms = deterministicUniforms(modelIr.seed, `${layer.layerId}.weight`, count);
    const values = new Float64Array(count);
    const scale = Math.sqrt(2 / layer.inputUnits);
    for (let index = 0; index < count; index += 1) {
      values[index] = Math.fround(uniforms[index] * scale);
    }
    tensors.set(`${layer.layerId}.weight`, { values });
    tensors.set(`${layer.layerId}.bias`, { values: new Float64Array(layer.outputUnits) });
  }
  return tensors;
}

function forwardWithTrace(modelIr, dataset, tensors, selectedRows = null) {
  let activations = dataset.features.map((row) => row.map((value) => Number(value)));
  const rows = selectedRows || activations.map((_, index) => index);
  activations = rows.map((index) => activations[index]);
  const activationTrace = [activations];
  const preactivationTrace = [];
  for (const layer of modelIr.layers) {
    const weights = tensors.get(`${layer.layerId}.weight`)?.values;
    const bias = tensors.get(`${layer.layerId}.bias`)?.values;
    if (!weights || !bias) throw new Error(`deep_learning_replay_tensor_missing:${layer.layerId}`);
    const next = new Array(activations.length);
    for (let sample = 0; sample < activations.length; sample += 1) {
      const input = activations[sample];
      const output = new Array(layer.outputUnits);
      for (let unit = 0; unit < layer.outputUnits; unit += 1) {
        let sum = bias[unit];
        for (let feature = 0; feature < layer.inputUnits; feature += 1) {
          // fround the product and accumulation to stay conservative with the
          // producer's float32 execution while retaining an independent code
          // path (no GPU/runtime imports).
          sum = Math.fround(sum + Math.fround(input[feature] * weights[
            unit * layer.inputUnits + feature
          ]));
        }
        output[unit] = layer.activation === 'relu' ? Math.max(0, sum) : sum;
      }
      next[sample] = output;
    }
    preactivationTrace.push(next.map((row) => [...row]));
    activations = next;
    activationTrace.push(activations);
  }
  return {
    logits: activations,
    activations: activationTrace,
    preactivations: preactivationTrace,
  };
}

function metricsFromLogits(logits, labels, {
  initialCrossEntropy = 0,
  gradientNorm = null,
} = {}) {
  let loss = 0;
  let matches = 0;
  const predictions = [];
  for (let sample = 0; sample < logits.length; sample += 1) {
    const row = logits[sample];
    const maximum = Math.max(...row);
    const exponentials = row.map((value) => Math.exp(value - maximum));
    const normalizer = exponentials.reduce((sum, value) => sum + value, 0);
    const label = labels[sample];
    const probability = exponentials[label] / normalizer;
    loss += -Math.log(Math.max(probability, Number.MIN_VALUE));
    let prediction = 0;
    for (let index = 1; index < row.length; index += 1) {
      if (row[index] > row[prediction]) prediction = index;
    }
    predictions.push(prediction);
    if (prediction === label) matches += 1;
  }
  return Object.freeze({
    accuracy: matches / labels.length,
    crossEntropy: loss / labels.length,
    gradientNorm,
    initialCrossEntropy,
    predictions: Object.freeze(predictions),
  });
}

function blocked(blockers, details = {}) {
  const payload = {
    version: 1,
    kind: 'DeepLearningIndependentReplayReceipt',
    status: 'deep_learning_independent_replay_blocked',
    replayScope: details.replayScope || DEEP_LEARNING_REPLAY_SCOPES.independentCpuOracle,
    replayRuntimeIdentityHash: details.replayRuntimeIdentityHash || null,
    executionReceiptHash: details.executionReceiptHash || null,
    checkpointManifestHash: details.checkpointManifestHash || null,
    checkpointArtifactHash: details.checkpointArtifactHash || null,
    tensorBundleHash: details.tensorBundleHash || null,
    expectedPredictionHash: null,
    observedPredictionHash: null,
    expectedMetrics: null,
    observedMetrics: null,
    verifiedSurface: VERIFIED_SURFACE,
    errorBudget: DEEP_LEARNING_REPLAY_ERROR_BUDGET,
    scientificChecksPassed: false,
    productionPromotionEligible: false,
    productionBlockers: PRODUCTION_BLOCKERS,
    blockers: Object.freeze([...new Set(blockers.map(String))]),
  };
  return deepFreezeJsonValue({
    ...payload,
    deepLearningIndependentReplayReceiptHash:
      hashRecord('DeepLearningIndependentReplayReceipt', payload),
  });
}

function buildVerifiedReceipt({
  executionReceipt,
  replayRuntimeIdentityHash,
  replayScope,
  tensorBundleBytes,
  expectedPredictions,
  expectedMetrics,
  observed,
  blockers,
} = {}) {
  const payload = {
    version: 1,
    kind: 'DeepLearningIndependentReplayReceipt',
    status: blockers.length
      ? 'deep_learning_independent_replay_blocked'
      : 'deep_learning_independent_replay_verified',
    replayScope,
    replayRuntimeIdentityHash,
    executionReceiptHash: executionReceipt.deepLearningTrainingExecutionReceiptHash,
    checkpointManifestHash: executionReceipt.checkpointManifestHash,
    checkpointArtifactHash: executionReceipt.checkpointManifest.checkpointArtifactHash,
    tensorBundleHash: hashBytes(tensorBundleBytes),
    expectedPredictionHash: hashRecord(
      'DeepLearningReplayPredictions', expectedPredictions,
    ),
    observedPredictionHash: hashRecord(
      'DeepLearningReplayPredictions', observed.predictions,
    ),
    expectedMetrics,
    observedMetrics: {
      accuracy: observed.accuracy,
      crossEntropy: observed.crossEntropy,
      gradientNorm: observed.gradientNorm,
      initialCrossEntropy: observed.initialCrossEntropy,
    },
    verifiedSurface: VERIFIED_SURFACE,
    errorBudget: DEEP_LEARNING_REPLAY_ERROR_BUDGET,
    scientificChecksPassed: blockers.length === 0,
    productionPromotionEligible: false,
    productionBlockers: PRODUCTION_BLOCKERS,
    blockers: Object.freeze([...new Set(blockers.map(String))]),
  };
  return deepFreezeJsonValue({
    ...payload,
    deepLearningIndependentReplayReceiptHash:
      hashRecord('DeepLearningIndependentReplayReceipt', payload),
  });
}

/**
 * Recompute predictions and loss from an immutable checkpoint using the
 * independent JavaScript CPU oracle.  This is intentionally not a training
 * implementation: it verifies that the published checkpoint has the claimed
 * model/dataset binding and reproduces the observable evaluation surface.
 */
export function replayDeepLearningCheckpoint({
  executionReceipt,
  trainingDataset,
  tensorBundleBytes,
  expectedPredictions,
  expectedMetrics,
  replayRuntimeIdentityHash,
  replayScope = DEEP_LEARNING_REPLAY_SCOPES.independentCpuOracle,
} = {}) {
  const context = {
    replayScope,
    replayRuntimeIdentityHash,
    executionReceiptHash: executionReceipt?.deepLearningTrainingExecutionReceiptHash,
    checkpointManifestHash: executionReceipt?.checkpointManifestHash,
    checkpointArtifactHash: executionReceipt?.checkpointManifest?.checkpointArtifactHash,
    tensorBundleHash: Buffer.isBuffer(tensorBundleBytes)
      ? hashBytes(tensorBundleBytes) : null,
  };
  try {
    if (!isHash(replayRuntimeIdentityHash)
      || replayScope !== DEEP_LEARNING_REPLAY_SCOPES.independentCpuOracle
      || !verifyDeepLearningTrainingExecutionReceipt(executionReceipt)
      || !verifyDeepLearningInlineTrainingDataset(trainingDataset)
      || trainingDataset.deepLearningTrainingDatasetManifestHash
        !== executionReceipt.trainingDatasetManifestHash
      || !Array.isArray(expectedPredictions)
      || expectedPredictions.length !== trainingDataset.sampleCount
      || !expectedPredictions.every((value) => Number.isSafeInteger(value)
        && value >= 0 && value < executionReceipt.modelIr.classCount)
      || !exactMetricObject(expectedMetrics)
      // The expected metrics are the producer's hash-bound claim.  Tolerance
      // applies only to the independently recomputed values below; accepting
      // a caller-supplied replacement claim would make the replay self-fulfilling.
      || !jsonEqual(expectedMetrics, executionReceipt.finalMetrics)) {
      return blocked(['deep_learning_replay_input_invalid'], context);
    }
    const tensors = decodeTensorBundle({
      tensorBundleBytes,
      checkpointManifest: executionReceipt.checkpointManifest,
    });
    const modelIr = executionReceipt.modelIr;
    const initialTensors = initialTensorMap(modelIr);
    const initialForward = forwardWithTrace(modelIr, trainingDataset, initialTensors);
    const initialMetrics = metricsFromLogits(
      initialForward.logits,
      trainingDataset.labels,
    );
    const observed = metricsFromLogits(
      forwardWithTrace(modelIr, trainingDataset, tensors).logits,
      trainingDataset.labels,
      {
        initialCrossEntropy: initialMetrics.crossEntropy,
      },
    );
    const blockers = [];
    if (DEEP_LEARNING_REPLAY_ERROR_BUDGET.requirePredictionEquality
      && !jsonEqual(observed.predictions, expectedPredictions)) {
      blockers.push('deep_learning_replay_predictions_mismatch');
    }
    if (Math.abs(observed.accuracy - expectedMetrics.accuracy)
      > DEEP_LEARNING_REPLAY_ERROR_BUDGET.maximumAccuracyDifference) {
      blockers.push('deep_learning_replay_accuracy_outside_budget');
    }
    if (!metricWithinBudget(
      observed.crossEntropy, expectedMetrics.crossEntropy,
      DEEP_LEARNING_REPLAY_ERROR_BUDGET.maximumAbsoluteCrossEntropy,
      DEEP_LEARNING_REPLAY_ERROR_BUDGET.maximumRelativeCrossEntropy,
    )) blockers.push('deep_learning_replay_cross_entropy_outside_budget');
    if (!metricWithinBudget(
      observed.initialCrossEntropy, expectedMetrics.initialCrossEntropy,
      DEEP_LEARNING_REPLAY_ERROR_BUDGET.maximumAbsoluteInitialCrossEntropy,
      DEEP_LEARNING_REPLAY_ERROR_BUDGET.maximumRelativeInitialCrossEntropy,
    )) blockers.push('deep_learning_replay_initial_cross_entropy_outside_budget');
    return buildVerifiedReceipt({
      executionReceipt,
      replayRuntimeIdentityHash,
      replayScope,
      tensorBundleBytes,
      expectedPredictions,
      expectedMetrics,
      observed,
      blockers,
    });
  } catch (error) {
    return blocked([
      `deep_learning_replay_failed:${error?.message || 'unknown'}`,
    ], context);
  }
}

/**
 * Evaluate a checkpoint against a separately supplied, sealed holdout
 * dataset.  This is deliberately a pure CPU path: it does not require the
 * training dataset manifest to match the holdout and it never changes the
 * promotability of the producer receipt.  The personal single-host gate uses
 * this helper to exercise a real hidden-evaluator surface while keeping the
 * release/independent-authority boundary intact.
 */
export function evaluateDeepLearningCheckpointDataset({
  executionReceipt,
  evaluationDataset,
  tensorBundleBytes,
} = {}) {
  if (!verifyDeepLearningTrainingExecutionReceipt(executionReceipt)
    || !verifyDeepLearningInlineTrainingDataset(evaluationDataset)
    || evaluationDataset.featureCount !== executionReceipt.modelIr.inputFeatureCount
    || evaluationDataset.classCount !== executionReceipt.modelIr.classCount
    || !Buffer.isBuffer(tensorBundleBytes)) {
    throw new Error('deep_learning_holdout_evaluation_input_invalid');
  }
  const tensors = decodeTensorBundle({
    tensorBundleBytes,
    checkpointManifest: executionReceipt.checkpointManifest,
  });
  const modelIr = executionReceipt.modelIr;
  const initialMetrics = metricsFromLogits(
    forwardWithTrace(modelIr, evaluationDataset, initialTensorMap(modelIr)).logits,
    evaluationDataset.labels,
  );
  const observed = metricsFromLogits(
    forwardWithTrace(modelIr, evaluationDataset, tensors).logits,
    evaluationDataset.labels,
    { initialCrossEntropy: initialMetrics.crossEntropy },
  );
  return Object.freeze({
    accuracy: observed.accuracy,
    crossEntropy: observed.crossEntropy,
    initialCrossEntropy: observed.initialCrossEntropy,
    predictions: observed.predictions,
  });
}

export function buildDeepLearningReplayPlan({
  originalExecutionReceipt,
  replayScope,
  replayDeviceIdentityHash,
  replayRuntimeIdentityHash,
  errorBudget = DEEP_LEARNING_REPLAY_ERROR_BUDGET,
} = {}) {
  if (!verifyDeepLearningTrainingExecutionReceipt(originalExecutionReceipt)
    || !Object.values(DEEP_LEARNING_REPLAY_SCOPES).includes(replayScope)
    || !isHash(replayRuntimeIdentityHash)
    || !isHash(replayDeviceIdentityHash)
    || !exactErrorBudget(errorBudget)) {
    throw new Error('deep_learning_replay_plan_invalid');
  }
  const originalDeviceIdentityHash = originalExecutionReceipt.runtimeBom.gpuDeviceUuidHash;
  if (replayScope === DEEP_LEARNING_REPLAY_SCOPES.sameDeviceGpu
    && replayDeviceIdentityHash !== originalDeviceIdentityHash) {
    throw new Error('deep_learning_same_device_must_match_original');
  }
  if (replayScope === DEEP_LEARNING_REPLAY_SCOPES.independentSecondGpu
    && replayDeviceIdentityHash === originalDeviceIdentityHash) {
    throw new Error('deep_learning_second_gpu_must_be_distinct');
  }
  const payload = {
    version: 1,
    kind: 'DeepLearningReplayPlan',
    status: 'deep_learning_replay_plan_bound_non_promotable',
    replayScope,
    replayRuntimeIdentityHash,
    replayDeviceIdentityHash,
    originalExecutionReceiptHash:
      originalExecutionReceipt.deepLearningTrainingExecutionReceiptHash,
    errorBudget,
    productionAuthorityRequired: true,
  };
  return deepFreezeJsonValue({
    ...payload,
    deepLearningReplayPlanHash: hashRecord('DeepLearningReplayPlan', payload),
  });
}

export function verifyDeepLearningReplayPlan(value) {
  try {
    if (!exactPlainObject(value, PLAN_KEYS)
      || value.version !== 1
      || value.kind !== 'DeepLearningReplayPlan'
      || value.status !== 'deep_learning_replay_plan_bound_non_promotable'
      || value.productionAuthorityRequired !== true
      || !Object.values(DEEP_LEARNING_REPLAY_SCOPES).includes(value.replayScope)
      || !isHash(value.replayRuntimeIdentityHash)
      || !isHash(value.replayDeviceIdentityHash)
      || !isHash(value.originalExecutionReceiptHash)
      || !exactErrorBudget(value.errorBudget)) return false;
    const payload = { ...value };
    delete payload.deepLearningReplayPlanHash;
    return value.deepLearningReplayPlanHash
      === hashRecord('DeepLearningReplayPlan', payload);
  } catch {
    return false;
  }
}

// The plan is consumed by a separately provisioned GPU runner.  This binding
// check is intentionally pure: it verifies the returned execution receipt's
// identity and scientific lineage, but it never treats a local receipt as
// production authority.
export function verifyDeepLearningReplayExecutionBinding({
  plan,
  originalExecutionReceipt,
  replayExecutionReceipt,
} = {}) {
  try {
    if (!verifyDeepLearningReplayPlan(plan)
      || !verifyDeepLearningTrainingExecutionReceipt(originalExecutionReceipt)
      || !verifyDeepLearningTrainingExecutionReceipt(replayExecutionReceipt)
      || originalExecutionReceipt.deepLearningTrainingExecutionReceiptHash
        !== plan.originalExecutionReceiptHash
      || replayExecutionReceipt.runtimeBom.gpuDeviceUuidHash
        !== plan.replayDeviceIdentityHash
      || replayExecutionReceipt.profileHash !== originalExecutionReceipt.profileHash
      || replayExecutionReceipt.modelIrHash !== originalExecutionReceipt.modelIrHash
      || replayExecutionReceipt.trainingDatasetManifestHash
        !== originalExecutionReceipt.trainingDatasetManifestHash
      || replayExecutionReceipt.checkpointManifest.tensorSetHash
        !== originalExecutionReceipt.checkpointManifest.tensorSetHash
      || replayExecutionReceipt.checkpointManifest.checkpointArtifactHash
        !== originalExecutionReceipt.checkpointManifest.checkpointArtifactHash
      || !jsonEqual(replayExecutionReceipt.finalMetrics, originalExecutionReceipt.finalMetrics)
      || (plan.replayScope === DEEP_LEARNING_REPLAY_SCOPES.sameDeviceGpu
        && plan.replayDeviceIdentityHash
          !== originalExecutionReceipt.runtimeBom.gpuDeviceUuidHash)
      || (plan.replayScope === DEEP_LEARNING_REPLAY_SCOPES.independentSecondGpu
        && replayExecutionReceipt.runtimeBom.gpuDeviceUuidHash
          === originalExecutionReceipt.runtimeBom.gpuDeviceUuidHash)) return false;
    return true;
  } catch {
    return false;
  }
}

export function verifyDeepLearningIndependentReplayReceipt(value) {
  try {
    if (!exactPlainObject(value, REPLAY_RECEIPT_KEYS)
      || value.version !== 1
      || value.kind !== 'DeepLearningIndependentReplayReceipt'
      || !Object.values(DEEP_LEARNING_REPLAY_SCOPES).includes(value.replayScope)
      || !exactErrorBudget(value.errorBudget)
      || !isHash(value.deepLearningIndependentReplayReceiptHash)
      || value.productionPromotionEligible !== false
      || !jsonEqual(value.productionBlockers, PRODUCTION_BLOCKERS)
      || typeof value.scientificChecksPassed !== 'boolean'
      || !Array.isArray(value.blockers)) return false;
    const payload = { ...value };
    delete payload.deepLearningIndependentReplayReceiptHash;
    return value.deepLearningIndependentReplayReceiptHash
      === hashRecord('DeepLearningIndependentReplayReceipt', payload);
  } catch {
    return false;
  }
}
