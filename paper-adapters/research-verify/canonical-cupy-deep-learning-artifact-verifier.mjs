import path from 'node:path';

import { deepFreezeJsonValue } from '../../workflow-kernel/deep-freeze-json-value.mjs';
import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { readScopedFileSync } from '../../workflow-kernel/runtime/scoped-file-identity.mjs';
import {
  exactPlainObject,
  requiredDeepLearningHash,
} from '../../paper-domain/research/deep-learning-contract-primitives.mjs';
import {
  buildDeepLearningCheckpointManifest,
  buildDeepLearningGpuRuntimeBom,
  buildDeepLearningTrainingExecutionReceipt,
} from '../../paper-domain/research/deep-learning-training-execution-contract.mjs';
import {
  verifyCanonicalCupyDeepLearningGpuMemoryCapacityPlan,
} from '../../paper-domain/research/deep-learning-gpu-memory-capacity-contract.mjs';

const GPU_UUID = /^GPU-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAXIMUM_JSON_ARTIFACT_BYTES = 64 * 1024 * 1024;
const MAXIMUM_TRAINING_STEPS = 1_000_000;
const SUMMARY_KEYS = Object.freeze([
  'completedEpoch', 'externalActionPerformed', 'finalMetrics',
  'gpuMemoryCapacityPlanHash', 'hiddenEvaluationPerformed', 'kind',
  'modelIrHash', 'networkActionPerformed',
  'profileHash', 'runtime', 'seed', 'tensorBundleArtifactBytes', 'tensors',
  'trainingDatasetManifestHash', 'trainingPredictionCount', 'trainingRunId',
  'trainingStepCount', 'version',
]);
const RUNTIME_KEYS = Object.freeze([
  'cudaDriverVersion', 'cudaRuntimeVersion', 'framework', 'frameworkVersion',
  'gpuComputeCapability', 'gpuDeviceSelector', 'gpuModel', 'trainingComputeDevice',
]);
const TRACE_KEYS = Object.freeze([
  'kind', 'modelIrHash', 'records', 'trainingDatasetManifestHash',
  'trainingRunId', 'version',
]);
const TRACE_RECORD_KEYS = Object.freeze([
  'accuracy', 'crossEntropy', 'epoch', 'gradientNorm',
]);
const PREDICTION_KEYS = Object.freeze([
  'kind', 'modelIrHash', 'predictedClass', 'scope',
  'trainingDatasetManifestHash', 'trainingRunId', 'version',
]);
const MODEL_SPEC_KEYS = Object.freeze(['kind', 'modelIr', 'profile', 'version']);

export const CANONICAL_CUPY_DEEP_LEARNING_OUTPUT_PATHS = Object.freeze([
  'model-spec.json',
  'tensor-bundle.bin',
  'training-predictions.json',
  'training-summary.json',
  'training-trace.json',
]);

export function canonicalDeepLearningArtifactByPath(workerReceipt, selectedPath) {
  return workerReceipt.artifacts.find((artifact) => artifact.path === selectedPath) || null;
}

function safeParse(readReceipt) {
  if (readReceipt?.status !== 'scoped_file_read_verified') return null;
  try { return JSON.parse(readReceipt.content.toString('utf8')); } catch { return null; }
}

function readArtifact(outputDirectory, workerReceipt, selectedPath, maximumBytes) {
  const read = readScopedFileSync({
    scopeRoot: outputDirectory,
    candidate: path.join(outputDirectory, selectedPath),
    maximumBytes,
  });
  const declared = canonicalDeepLearningArtifactByPath(workerReceipt, selectedPath);
  if (read.status !== 'scoped_file_read_verified'
    || !declared
    || read.hash !== declared.sha256
    || read.bytes !== declared.bytes) {
    throw new Error(`deep_learning_training_artifact_invalid:${selectedPath}`);
  }
  return read;
}

function expectedTensorShapes(modelIr) {
  return modelIr.layers.flatMap((layer) => [
    Object.freeze({
      name: `${layer.layerId}.weight`,
      shape: Object.freeze([layer.outputUnits, layer.inputUnits]),
    }),
    Object.freeze({
      name: `${layer.layerId}.bias`,
      shape: Object.freeze([layer.outputUnits]),
    }),
  ]).sort((left, right) => (left.name < right.name ? -1 : Number(left.name > right.name)));
}

function inspectTensorBundle(content, modelIr) {
  const tensors = [];
  let offset = 0;
  for (const expected of expectedTensorShapes(modelIr)) {
    const byteLength = expected.shape.reduce((product, dimension) => (
      product * dimension
    ), 4);
    if (offset + byteLength > content.length) {
      throw new Error('deep_learning_tensor_bundle_truncated');
    }
    const bytes = content.subarray(offset, offset + byteLength);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let cursor = 0; cursor < bytes.byteLength; cursor += 4) {
      if (!Number.isFinite(view.getFloat32(cursor, true))) {
        throw new Error('deep_learning_tensor_bundle_non_finite');
      }
    }
    tensors.push(Object.freeze({
      name: expected.name,
      dtype: 'float32',
      shape: expected.shape,
      byteLength,
      sha256: hashBytes(bytes),
    }));
    offset += byteLength;
  }
  if (offset !== content.length) throw new Error('deep_learning_tensor_bundle_trailing_bytes');
  return Object.freeze(tensors);
}

function finiteTensorScanReceipt(checkpointArtifactHash, tensors) {
  const tensorSet = deepFreezeJsonValue({
    version: 1,
    kind: 'DeepLearningCheckpointTensorSet',
    format: 'hepta-tensor-bundle-v1',
    tensors,
  });
  const payload = {
    version: 1,
    kind: 'DeepLearningFiniteTensorScanReceipt',
    status: 'deep_learning_checkpoint_tensors_all_finite',
    checkpointArtifactHash,
    tensors,
    tensorSetHash: hashRecord('DeepLearningCheckpointTensorSet', tensorSet),
  };
  return deepFreezeJsonValue({
    ...payload,
    deepLearningFiniteTensorScanReceiptHash:
      hashRecord('DeepLearningFiniteTensorScanReceipt', payload),
  });
}

function finiteMetric(value, minimum, maximum) {
  return typeof value === 'number' && Number.isFinite(value)
    && value >= minimum && value <= maximum;
}

function verifySummary(summary, {
  trainingRunId, modelIr, trainingDataset, gpuMemoryCapacityPlan,
  workerReceipt, tensors, tensorBytes,
} = {}) {
  const runtime = summary?.runtime;
  return exactPlainObject(summary, SUMMARY_KEYS)
    && summary.version === 1
    && summary.kind === 'CanonicalCupyMlpTrainingSummary'
    && summary.trainingRunId === trainingRunId
    && summary.profileHash === modelIr.profileHash
    && summary.modelIrHash === modelIr.deepLearningModelIrHash
    && summary.trainingDatasetManifestHash
      === trainingDataset.deepLearningTrainingDatasetManifestHash
    && summary.gpuMemoryCapacityPlanHash
      === gpuMemoryCapacityPlan.gpuMemoryCapacityPlanHash
    && summary.seed === modelIr.seed
    && summary.completedEpoch === modelIr.training.epochs
    && Number.isSafeInteger(summary.trainingStepCount)
    && summary.trainingStepCount
      === Math.ceil(trainingDataset.sampleCount / modelIr.training.batchSize)
        * modelIr.training.epochs
    && summary.trainingStepCount <= MAXIMUM_TRAINING_STEPS
    && summary.tensorBundleArtifactBytes === tensorBytes
    && hashRecord('DeepLearningCheckpointTensorDescriptors', summary.tensors)
      === hashRecord('DeepLearningCheckpointTensorDescriptors', tensors)
    && summary.trainingPredictionCount === trainingDataset.sampleCount
    && summary.networkActionPerformed === false
    && summary.externalActionPerformed === false
    && summary.hiddenEvaluationPerformed === false
    && exactPlainObject(runtime, RUNTIME_KEYS)
    && runtime.framework === 'cupy'
    && runtime.trainingComputeDevice === 'cuda:0-single-visible-device-v1'
    && runtime.gpuDeviceSelector === workerReceipt.gpuDeviceRequest.deviceSelector
    && GPU_UUID.test(runtime.gpuDeviceSelector)
    && typeof runtime.gpuModel === 'string' && runtime.gpuModel.length >= 1
    && /^\d{1,4}(?:\.\d{1,4}){1,3}$/.test(runtime.frameworkVersion)
    && /^\d{1,4}(?:\.\d{1,4}){1,3}$/.test(runtime.cudaDriverVersion)
    && /^\d{1,4}(?:\.\d{1,4}){1,3}$/.test(runtime.cudaRuntimeVersion)
    && /^\d{1,2}\.\d{1,2}$/.test(runtime.gpuComputeCapability)
    && exactPlainObject(summary.finalMetrics, [
      'accuracy', 'crossEntropy', 'gradientNorm', 'initialCrossEntropy',
    ])
    && finiteMetric(summary.finalMetrics.accuracy, 0, 1)
    && finiteMetric(summary.finalMetrics.crossEntropy, 0, Number.MAX_VALUE)
    && finiteMetric(summary.finalMetrics.gradientNorm, 0, Number.MAX_VALUE)
    && finiteMetric(summary.finalMetrics.initialCrossEntropy, 0, Number.MAX_VALUE);
}

function verifyTrace(trace, { trainingRunId, modelIr, trainingDataset, summary }) {
  if (!exactPlainObject(trace, TRACE_KEYS)
    || trace.version !== 1
    || trace.kind !== 'DeepLearningTrainingMetricTrace'
    || trace.trainingRunId !== trainingRunId
    || trace.modelIrHash !== modelIr.deepLearningModelIrHash
    || trace.trainingDatasetManifestHash
      !== trainingDataset.deepLearningTrainingDatasetManifestHash
    || !Array.isArray(trace.records)
    || trace.records.length !== modelIr.training.epochs) return false;
  const validRecords = trace.records.every((record, index) => (
    exactPlainObject(record, TRACE_RECORD_KEYS)
    && record.epoch === index + 1
    && finiteMetric(record.accuracy, 0, 1)
    && finiteMetric(record.crossEntropy, 0, Number.MAX_VALUE)
    && finiteMetric(record.gradientNorm, 0, Number.MAX_VALUE)
  ));
  const final = trace.records.at(-1);
  return validRecords
    && final.accuracy === summary.finalMetrics.accuracy
    && final.crossEntropy === summary.finalMetrics.crossEntropy
    && final.gradientNorm === summary.finalMetrics.gradientNorm;
}

function verifyPredictions(predictions, {
  trainingRunId, modelIr, trainingDataset, summary,
} = {}) {
  const labels = predictions?.predictedClass;
  const derivedAccuracy = Array.isArray(labels)
    ? labels.reduce((matches, label, index) => (
      matches + Number(label === trainingDataset.labels[index])
    ), 0) / trainingDataset.sampleCount
    : Number.NaN;
  return exactPlainObject(predictions, PREDICTION_KEYS)
    && predictions.version === 1
    && predictions.kind === 'DeepLearningTrainingPredictions'
    && predictions.scope === 'training-dataset-only-not-hidden-evaluation-v1'
    && predictions.trainingRunId === trainingRunId
    && predictions.modelIrHash === modelIr.deepLearningModelIrHash
    && predictions.trainingDatasetManifestHash
      === trainingDataset.deepLearningTrainingDatasetManifestHash
    && Array.isArray(predictions.predictedClass)
    && predictions.predictedClass.length === trainingDataset.sampleCount
    && predictions.predictedClass.every((label) => (
      Number.isSafeInteger(label) && label >= 0 && label < modelIr.classCount
    ))
    && derivedAccuracy === summary.finalMetrics.accuracy;
}

function verifyModelSpecification(value, { modelIr, profile }) {
  return exactPlainObject(value, MODEL_SPEC_KEYS)
    && value.version === 1
    && value.kind === 'DeepLearningModelSpecification'
    && hashRecord('DeepLearningModelSpecificationProfile', value.profile)
      === hashRecord('DeepLearningModelSpecificationProfile', profile)
    && hashRecord('DeepLearningModelSpecificationModelIr', value.modelIr)
      === hashRecord('DeepLearningModelSpecificationModelIr', modelIr);
}

function buildRuntimeBom(summary, workerReceipt) {
  const runtime = summary.runtime;
  const packageClosureHash = workerReceipt.environmentBom?.runtime
    ?.packageClosure?.identityHash;
  if (!requiredDeepLearningHash(packageClosureHash)) {
    throw new Error('deep_learning_worker_package_closure_unbound');
  }
  return buildDeepLearningGpuRuntimeBom({
    runtimeImageDigest: workerReceipt.containerImageDigest,
    packageClosureHash,
    framework: runtime.framework,
    frameworkVersion: runtime.frameworkVersion,
    cudaDriverVersion: runtime.cudaDriverVersion,
    cudaRuntimeVersion: runtime.cudaRuntimeVersion,
    gpuComputeCapability: runtime.gpuComputeCapability,
    gpuDeviceUuidHash: hashRecord('DeepLearningGpuDeviceUuid', {
      gpuDeviceSelector: runtime.gpuDeviceSelector,
    }),
    gpuModelHash: hashRecord('DeepLearningGpuModel', {
      gpuModel: runtime.gpuModel,
    }),
  });
}

export function inspectCanonicalCupyDeepLearningArtifacts({
  outputDirectory,
  workerReceipt,
  trainingRunId,
  profile,
  modelIr,
  trainingDataset,
  gpuMemoryCapacityPlan,
  maximumOutputBytes,
} = {}) {
  const modelSpecRead = readArtifact(
    outputDirectory, workerReceipt, 'model-spec.json', MAXIMUM_JSON_ARTIFACT_BYTES,
  );
  const tensorRead = readArtifact(
    outputDirectory, workerReceipt, 'tensor-bundle.bin', maximumOutputBytes,
  );
  const predictionsRead = readArtifact(
    outputDirectory, workerReceipt, 'training-predictions.json',
    MAXIMUM_JSON_ARTIFACT_BYTES,
  );
  const summaryRead = readArtifact(
    outputDirectory, workerReceipt, 'training-summary.json', MAXIMUM_JSON_ARTIFACT_BYTES,
  );
  const traceRead = readArtifact(
    outputDirectory, workerReceipt, 'training-trace.json', MAXIMUM_JSON_ARTIFACT_BYTES,
  );
  const modelSpecification = safeParse(modelSpecRead);
  const predictions = safeParse(predictionsRead);
  const summary = safeParse(summaryRead);
  const trace = safeParse(traceRead);
  const tensors = inspectTensorBundle(tensorRead.content, modelIr);
  if (!verifyCanonicalCupyDeepLearningGpuMemoryCapacityPlan(
    gpuMemoryCapacityPlan,
    {
      modelIr,
      trainingDataset,
      // The plan is bound to the planning-time observation.  The worker
      // receipt carries a separate dispatch-time observation whose free-memory
      // value is expected to move while the job is admitted and started.
      // That later observation is bound through the dispatch admission
      // requirement/evaluation in the verified worker receipt; substituting it
      // here would reject an otherwise exact plan whenever free VRAM changed.
      gpuCapacityObservation: gpuMemoryCapacityPlan?.gpuCapacityObservation,
    },
  )
    || gpuMemoryCapacityPlan.capacitySatisfied !== true
    || gpuMemoryCapacityPlan.gpuDeviceSelector
      !== workerReceipt?.gpuDeviceRequest?.deviceSelector
    || gpuMemoryCapacityPlan.observedGpuTotalMemoryBytes
      !== workerReceipt?.gpuDeviceRequest?.observedTotalMemoryBytes
    || !verifyModelSpecification(modelSpecification, { modelIr, profile })
    || !verifySummary(summary, {
      trainingRunId, modelIr, trainingDataset, gpuMemoryCapacityPlan, workerReceipt,
      tensors, tensorBytes: tensorRead.bytes,
    })
    || !verifyTrace(trace, {
      trainingRunId, modelIr, trainingDataset, summary,
    })
    || !verifyPredictions(predictions, {
      trainingRunId, modelIr, trainingDataset, summary,
    })) {
    throw new Error('deep_learning_gpu_training_artifact_contract_invalid');
  }
  const finiteScan = finiteTensorScanReceipt(tensorRead.hash, tensors);
  const runtimeBom = buildRuntimeBom(summary, workerReceipt);
  const checkpointManifest = buildDeepLearningCheckpointManifest({
    trainingRunId,
    modelIr,
    runtimeBom,
    trainingDatasetManifestHash:
      trainingDataset.deepLearningTrainingDatasetManifestHash,
    completedEpoch: summary.completedEpoch,
    trainingStepCount: summary.trainingStepCount,
    finiteTensorScanReceiptHash:
      finiteScan.deepLearningFiniteTensorScanReceiptHash,
    tensors,
    tensorBundleArtifactBytes: tensorRead.bytes,
    checkpointArtifactHash: tensorRead.hash,
  });
  const trainingExecutionReceipt = buildDeepLearningTrainingExecutionReceipt({
    trainingRunId,
    modelIr,
    runtimeBom,
    trainingDatasetManifestHash:
      trainingDataset.deepLearningTrainingDatasetManifestHash,
    checkpointManifest,
    metricTraceArtifactHash: traceRead.hash,
    finalMetrics: summary.finalMetrics,
  });
  return Object.freeze({ finiteScan, trainingExecutionReceipt });
}
