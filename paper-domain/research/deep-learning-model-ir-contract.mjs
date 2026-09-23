import { deepFreezeJsonValue } from '../../workflow-kernel/deep-freeze-json-value.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  densePlainArray,
  exactPlainObject,
  finiteNumberInRange,
  jsonEqual,
  requiredDeepLearningHash,
  requiredDeepLearningId,
  safeIntegerInRange,
} from './deep-learning-contract-primitives.mjs';
import {
  DETERMINISTIC_SUPERVISED_CLASSIFICATION_GPU_PROFILE,
} from './deep-learning-gpu-profile-contract.mjs';

const INPUT_KEYS = Object.freeze([
  'classCount', 'inputFeatureCount', 'layers', 'modelId', 'profileHash', 'seed',
  'training',
]);
const IR_KEYS = Object.freeze([
  'classCount', 'customOperatorsAllowed', 'deepLearningModelIrHash',
  'executableCodeEmbedded', 'inputFeatureCount', 'kind', 'layers', 'modelFamily',
  'modelId', 'operatorAllowlist', 'parameterCount', 'profileHash', 'seed', 'task',
  'training', 'version',
]);
const LAYER_KEYS = Object.freeze([
  'activation', 'inputUnits', 'layerId', 'outputUnits', 'type', 'useBias',
]);
const TRAINING_KEYS = Object.freeze([
  'batchOrder', 'batchSize', 'beta1', 'beta2', 'earlyStoppingEnabled', 'epochs',
  'epsilon', 'gradientClipNorm', 'initialization', 'learningRate', 'loss',
  'optimizer', 'weightDecay',
]);
const MAXIMUM_PARAMETER_COUNT = 20_000_000;

function compileTraining(value) {
  if (!exactPlainObject(value, TRAINING_KEYS)
    || value.optimizer !== 'adamw-v1'
    || value.loss !== 'sparse-cross-entropy-with-logits-v1'
    || value.initialization !== 'stateless-sha256-box-muller-v1'
    || value.batchOrder !== 'seeded-fisher-yates-v1'
    || value.earlyStoppingEnabled !== false
    || !safeIntegerInRange(value.epochs, 1, 100_000)
    || !safeIntegerInRange(value.batchSize, 1, 1_000_000)
    || !finiteNumberInRange(value.learningRate, 0, 1, { minimumExclusive: true })
    || !finiteNumberInRange(value.weightDecay, 0, 1)
    || !finiteNumberInRange(value.beta1, 0, 1, { maximumExclusive: true })
    || !finiteNumberInRange(value.beta2, 0, 1, { maximumExclusive: true })
    || !finiteNumberInRange(value.epsilon, 0, 1, { minimumExclusive: true })
    || !finiteNumberInRange(value.gradientClipNorm, 0, 1_000_000, {
      minimumExclusive: true,
    })) {
    throw new Error('deep_learning_training_configuration_invalid');
  }
  return Object.freeze({ ...value });
}

function compileLayers(value, inputFeatureCount, classCount) {
  if (!densePlainArray(value, 2, 16)) {
    throw new Error('deep_learning_model_layers_invalid');
  }
  let previousUnits = inputFeatureCount;
  let parameterCount = 0;
  const layerIds = new Set();
  const layers = value.map((layer, index) => {
    const layerId = requiredDeepLearningId(layer?.layerId);
    const finalLayer = index === value.length - 1;
    if (!exactPlainObject(layer, LAYER_KEYS)
      || !layerId || layerIds.has(layerId)
      || layer.type !== 'dense'
      || layer.useBias !== true
      || layer.inputUnits !== previousUnits
      || !safeIntegerInRange(layer.inputUnits, 1, 1_000_000)
      || !safeIntegerInRange(layer.outputUnits, 1, 1_000_000)
      || layer.activation !== (finalLayer ? 'identity' : 'relu')
      || (finalLayer && layer.outputUnits !== classCount)) {
      throw new Error('deep_learning_model_layer_invalid');
    }
    layerIds.add(layerId);
    const layerParameters = layer.inputUnits * layer.outputUnits + layer.outputUnits;
    if (!Number.isSafeInteger(layerParameters)
      || parameterCount + layerParameters > MAXIMUM_PARAMETER_COUNT) {
      throw new Error('deep_learning_model_parameter_budget_exceeded');
    }
    parameterCount += layerParameters;
    previousUnits = layer.outputUnits;
    return Object.freeze({
      layerId,
      type: 'dense',
      inputUnits: layer.inputUnits,
      outputUnits: layer.outputUnits,
      activation: layer.activation,
      useBias: true,
    });
  });
  return Object.freeze({ layers: Object.freeze(layers), parameterCount });
}

export function buildDeterministicSupervisedClassificationModelIr(value = {}) {
  if (!exactPlainObject(value, INPUT_KEYS)) {
    throw new Error('deep_learning_model_ir_input_shape_invalid');
  }
  const modelId = requiredDeepLearningId(value.modelId);
  const profileHash = requiredDeepLearningHash(value.profileHash);
  if (!modelId
    || profileHash
      !== DETERMINISTIC_SUPERVISED_CLASSIFICATION_GPU_PROFILE.deepLearningGpuProfileHash
    || !safeIntegerInRange(value.inputFeatureCount, 1, 1_000_000)
    || !safeIntegerInRange(value.classCount, 2, 100_000)
    || !safeIntegerInRange(value.seed, 0, 0xffff_ffff)) {
    throw new Error('deep_learning_model_ir_authority_invalid');
  }
  const compiled = compileLayers(value.layers, value.inputFeatureCount, value.classCount);
  const payload = {
    version: 1,
    kind: 'DeterministicSupervisedClassificationModelIR',
    modelId,
    modelFamily: 'declarative-sequential-mlp-v1',
    task: 'supervised-classification',
    profileHash,
    inputFeatureCount: value.inputFeatureCount,
    classCount: value.classCount,
    layers: compiled.layers,
    operatorAllowlist: Object.freeze(['dense', 'relu', 'identity']),
    training: compileTraining(value.training),
    seed: value.seed,
    parameterCount: compiled.parameterCount,
    executableCodeEmbedded: false,
    customOperatorsAllowed: false,
  };
  return deepFreezeJsonValue({
    ...payload,
    deepLearningModelIrHash:
      hashRecord('DeterministicSupervisedClassificationModelIR', payload),
  });
}

function modelIrInput(value) {
  return {
    modelId: value.modelId,
    profileHash: value.profileHash,
    inputFeatureCount: value.inputFeatureCount,
    classCount: value.classCount,
    layers: value.layers,
    training: value.training,
    seed: value.seed,
  };
}

export function verifyDeterministicSupervisedClassificationModelIr(value) {
  try {
    return exactPlainObject(value, IR_KEYS)
      && jsonEqual(buildDeterministicSupervisedClassificationModelIr(modelIrInput(value)), value);
  } catch {
    return false;
  }
}
