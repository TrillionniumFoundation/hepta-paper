import { deepFreezeJsonValue } from '../../workflow-kernel/deep-freeze-json-value.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  exactPlainObject,
  jsonEqual,
  requiredDeepLearningId,
  safeIntegerInRange,
} from './deep-learning-contract-primitives.mjs';

const INPUT_KEYS = Object.freeze(['classCount', 'datasetId', 'features', 'labels']);
const DATASET_KEYS = Object.freeze([
  'classCount', 'deepLearningTrainingDatasetManifestHash', 'datasetContentHash',
  'datasetId', 'featureCount', 'features', 'kind', 'labels', 'sampleCount',
  'version',
]);
const MAXIMUM_SAMPLE_COUNT = 65_536;
const MAXIMUM_FEATURE_COUNT = 4_096;
const MAXIMUM_FEATURE_CELLS = 4_194_304;

function denseArray(value, minimum, maximum) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
    || value.length < minimum || value.length > maximum) return false;
  const keys = Object.keys(value);
  return keys.length === value.length
    && keys.every((key, index) => key === String(index));
}

export function buildDeepLearningInlineTrainingDataset(value = {}) {
  if (!exactPlainObject(value, INPUT_KEYS)
    || !requiredDeepLearningId(value.datasetId)
    || !safeIntegerInRange(value.classCount, 2, 100_000)
    || !denseArray(value.features, 2, MAXIMUM_SAMPLE_COUNT)
    || !denseArray(value.labels, value.features?.length || 0, value.features?.length || 0)) {
    throw new Error('deep_learning_training_dataset_invalid');
  }
  const featureCount = value.features[0]?.length;
  if (!safeIntegerInRange(featureCount, 1, MAXIMUM_FEATURE_COUNT)
    || value.features.length * featureCount > MAXIMUM_FEATURE_CELLS) {
    throw new Error('deep_learning_training_dataset_size_invalid');
  }
  const features = value.features.map((row) => {
    if (!denseArray(row, featureCount, featureCount)
      || row.some((item) => typeof item !== 'number' || !Number.isFinite(item))) {
      throw new Error('deep_learning_training_dataset_feature_invalid');
    }
    return [...row];
  });
  const labels = value.labels.map((label) => {
    if (!safeIntegerInRange(label, 0, value.classCount - 1)) {
      throw new Error('deep_learning_training_dataset_label_invalid');
    }
    return label;
  });
  const content = deepFreezeJsonValue({ features, labels });
  const payload = {
    version: 1,
    kind: 'DeepLearningInlineTrainingDataset',
    datasetId: requiredDeepLearningId(value.datasetId),
    sampleCount: features.length,
    featureCount,
    classCount: value.classCount,
    datasetContentHash: hashRecord('DeepLearningTrainingDatasetContent', content),
    features,
    labels,
  };
  return deepFreezeJsonValue({
    ...payload,
    deepLearningTrainingDatasetManifestHash:
      hashRecord('DeepLearningInlineTrainingDataset', payload),
  });
}

function datasetInput(value) {
  return {
    datasetId: value.datasetId,
    classCount: value.classCount,
    features: value.features,
    labels: value.labels,
  };
}

export function verifyDeepLearningInlineTrainingDataset(value) {
  try {
    return exactPlainObject(value, DATASET_KEYS)
      && jsonEqual(buildDeepLearningInlineTrainingDataset(datasetInput(value)), value);
  } catch {
    return false;
  }
}

export const DEEP_LEARNING_INLINE_TRAINING_DATASET_LIMITS = Object.freeze({
  maximumSampleCount: MAXIMUM_SAMPLE_COUNT,
  maximumFeatureCount: MAXIMUM_FEATURE_COUNT,
  maximumFeatureCells: MAXIMUM_FEATURE_CELLS,
});
