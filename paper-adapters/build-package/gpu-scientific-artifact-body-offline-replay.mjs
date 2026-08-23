import { deepFreezeJsonValue } from '../../workflow-kernel/deep-freeze-json-value.mjs';
import { hasExactObjectKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  verifyDeepLearningInlineTrainingDataset,
} from '../../paper-domain/research/deep-learning-training-dataset-contract.mjs';
import {
  verifyDeterministicSupervisedClassificationGpuProfile,
} from '../../paper-domain/research/deep-learning-gpu-profile-contract.mjs';
import {
  verifyDeterministicSupervisedClassificationModelIr,
} from '../../paper-domain/research/deep-learning-model-ir-contract.mjs';
import {
  PDE_POISSON_2D_GPU_ARTIFACT_ENCODING,
  verifyPdePoisson2dGpuProducerSpecification,
} from '../../paper-domain/research/pde-poisson-2d-gpu-capability-contract.mjs';
import {
  recomputePdePoisson2dMetricsFromArtifactBytes,
} from '../research-verify/pde-poisson-2d-independent-cpu-oracle-algorithm.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const GPU_UUID = /^GPU-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,511}$/;
const PDE_REPLAY_INPUT_KEYS = Object.freeze([
  'artifactManifestHash', 'artifacts', 'kind',
  'pdePoisson2dOfflineReplayInputHash', 'producerSpecification',
  'producerSpecificationHash', 'requestHash', 'version',
]);
const PDE_ARTIFACT_KEYS = Object.freeze([
  'bytes', 'elements', 'encoding', 'gridSize', 'relativePath', 'sha256',
]);
const PDE_DIAGNOSTIC_KEYS = Object.freeze([
  'kind', 'observations', 'requestHash', 'scientificAuthority',
  'version', 'visibleGpuUuid',
]);
const PDE_DIAGNOSTIC_OBSERVATION_KEYS = Object.freeze([
  'gridSize', 'iterations', 'relativeContinuousL2Error',
  'relativeDiscreteResidual',
]);
const MODEL_SPECIFICATION_KEYS = Object.freeze([
  'kind', 'modelIr', 'profile', 'version',
]);
const SUMMARY_KEYS = Object.freeze([
  'completedEpoch', 'externalActionPerformed', 'finalMetrics',
  'gpuMemoryCapacityPlanHash', 'hiddenEvaluationPerformed', 'kind',
  'modelIrHash', 'networkActionPerformed', 'profileHash', 'runtime', 'seed',
  'tensorBundleArtifactBytes', 'tensors', 'trainingDatasetManifestHash',
  'trainingPredictionCount', 'trainingRunId', 'trainingStepCount', 'version',
]);
const SUMMARY_RUNTIME_KEYS = Object.freeze([
  'cudaDriverVersion', 'cudaRuntimeVersion', 'framework', 'frameworkVersion',
  'gpuComputeCapability', 'gpuDeviceSelector', 'gpuModel',
  'trainingComputeDevice',
]);
const FINAL_METRIC_KEYS = Object.freeze([
  'accuracy', 'crossEntropy', 'gradientNorm', 'initialCrossEntropy',
]);
const TENSOR_DESCRIPTOR_KEYS = Object.freeze([
  'byteLength', 'dtype', 'name', 'sha256', 'shape',
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
const PDE_GRID_SIZES = Object.freeze([31, 63, 127]);
const MAXIMUM_CPU_REPLAY_MULTIPLY_ACCUMULATES = 100_000_000;

function canonicalPdeArtifacts(value) {
  if (!Array.isArray(value) || value.length !== PDE_GRID_SIZES.length) {
    throw new Error('gpu_scientific_offline_replay_pde_artifact_set_invalid');
  }
  return PDE_GRID_SIZES.map((gridSize, index) => {
    const artifact = value[index];
    const relativePath = `solutions/n${gridSize}.f64le`;
    const elements = gridSize * gridSize;
    const bytes = elements * Float64Array.BYTES_PER_ELEMENT;
    if (!hasExactObjectKeys(artifact, PDE_ARTIFACT_KEYS)
      || artifact.gridSize !== gridSize
      || artifact.relativePath !== relativePath
      || artifact.encoding !== PDE_POISSON_2D_GPU_ARTIFACT_ENCODING
      || artifact.elements !== elements
      || artifact.bytes !== bytes
      || !SHA256.test(String(artifact.sha256 || ''))) {
      throw new Error('gpu_scientific_offline_replay_pde_artifact_set_invalid');
    }
    return {
      gridSize,
      relativePath,
      encoding: PDE_POISSON_2D_GPU_ARTIFACT_ENCODING,
      elements,
      bytes,
      sha256: artifact.sha256,
    };
  });
}

export function buildPdePoisson2dOfflineReplayInput({
  producerSpecification,
  artifactManifest,
} = {}) {
  if (!verifyPdePoisson2dGpuProducerSpecification(producerSpecification)
    || !SHA256.test(String(artifactManifest?.requestHash || ''))
    || !SHA256.test(String(
      artifactManifest?.pdePoisson2dGpuArtifactManifestHash || '',
    ))
    || artifactManifest?.producerSpecificationHash
      !== producerSpecification.pdePoisson2dGpuProducerSpecificationHash) {
    throw new Error('gpu_scientific_offline_replay_pde_input_invalid');
  }
  const payload = {
    version: 1,
    kind: 'PdePoisson2dOfflineReplayInput',
    requestHash: artifactManifest.requestHash,
    producerSpecificationHash:
      producerSpecification.pdePoisson2dGpuProducerSpecificationHash,
    artifactManifestHash:
      artifactManifest.pdePoisson2dGpuArtifactManifestHash,
    producerSpecification,
    artifacts: canonicalPdeArtifacts(artifactManifest.artifacts),
  };
  return deepFreezeJsonValue({
    ...payload,
    pdePoisson2dOfflineReplayInputHash:
      hashRecord('PdePoisson2dOfflineReplayInput', payload),
  });
}

function verifyPdeReplayInput(value) {
  if (!hasExactObjectKeys(value, PDE_REPLAY_INPUT_KEYS)) return false;
  try {
    return JSON.stringify(buildPdePoisson2dOfflineReplayInput({
      producerSpecification: value.producerSpecification,
      artifactManifest: {
        requestHash: value.requestHash,
        producerSpecificationHash: value.producerSpecificationHash,
        pdePoisson2dGpuArtifactManifestHash: value.artifactManifestHash,
        artifacts: value.artifacts,
      },
    })) === JSON.stringify(value);
  } catch {
    return false;
  }
}

function parseJsonBody(bodyByRole, role, blocker) {
  const bytes = bodyByRole.get(role);
  if (!Buffer.isBuffer(bytes)) throw new Error(blocker);
  try { return JSON.parse(bytes.toString('utf8')); }
  catch { throw new Error(blocker); }
}

function finiteMetric(value, minimum = 0, maximum = Number.MAX_VALUE) {
  return typeof value === 'number' && Number.isFinite(value)
    && value >= minimum && value <= maximum;
}

function validatePdeDiagnostics(value, replayInput, gpuDeviceSelector) {
  if (!hasExactObjectKeys(value, PDE_DIAGNOSTIC_KEYS)
    || value.version !== 1
    || value.kind !== 'CanonicalCupyPoisson2dProducerDiagnostics'
    || value.requestHash !== replayInput.requestHash
    || value.visibleGpuUuid !== gpuDeviceSelector
    || value.scientificAuthority !== 'non-authoritative-self-report-v1'
    || !Array.isArray(value.observations)
    || value.observations.length !== PDE_GRID_SIZES.length
    || value.observations.some((observation, index) => (
      !hasExactObjectKeys(observation, PDE_DIAGNOSTIC_OBSERVATION_KEYS)
      || observation.gridSize !== PDE_GRID_SIZES[index]
      || !Number.isSafeInteger(observation.iterations)
      || observation.iterations < 1 || observation.iterations > 256
      || !finiteMetric(observation.relativeContinuousL2Error)
      || !finiteMetric(observation.relativeDiscreteResidual)
    ))) {
    throw new Error('gpu_scientific_offline_replay_pde_diagnostics_invalid');
  }
}

function pdeAcceptanceBlockers(recomputed, acceptance) {
  const blockers = [];
  if (recomputed.observations.some((row) => ![
    row.relativeDiscreteResidual,
    row.relativeContinuousL2Error,
    row.cpuGpuRelativeL2,
    row.cpuGpuMaximumAbsoluteError,
  ].every((value) => finiteMetric(value)))) {
    blockers.push('gpu_scientific_offline_replay_pde_metrics_nonfinite');
  }
  if (recomputed.observations.some((row) => (
    row.relativeDiscreteResidual > acceptance.maximumRelativeDiscreteResidual
  ))) blockers.push('gpu_scientific_offline_replay_pde_residual_exceeded');
  if (recomputed.observations.at(-1).relativeContinuousL2Error
    > acceptance.maximumRelativeContinuousL2ErrorAtFinestGrid) {
    blockers.push('gpu_scientific_offline_replay_pde_continuous_error_exceeded');
  }
  if (recomputed.convergenceOrders.some((row) => (
    !Number.isFinite(row.observedOrder)
    || row.observedOrder < acceptance.minimumGridConvergenceOrder
  ))) blockers.push('gpu_scientific_offline_replay_pde_convergence_order_insufficient');
  if (recomputed.observations.some((row) => (
    row.cpuGpuRelativeL2 > acceptance.maximumCpuGpuRelativeL2
  ))) blockers.push('gpu_scientific_offline_replay_pde_cpu_relative_error_exceeded');
  if (recomputed.observations.some((row) => (
    row.cpuGpuMaximumAbsoluteError > acceptance.maximumCpuGpuAbsoluteError
  ))) blockers.push('gpu_scientific_offline_replay_pde_cpu_absolute_error_exceeded');
  return blockers;
}

function replayPde({ manifest, bodyByRole, entryByProducerPath }) {
  const replayInput = parseJsonBody(
    bodyByRole,
    'pde_offline_replay_input',
    'gpu_scientific_offline_replay_pde_input_invalid',
  );
  if (!verifyPdeReplayInput(replayInput)
    || replayInput.artifactManifestHash !== manifest.pdeArtifactManifestHash) {
    throw new Error('gpu_scientific_offline_replay_pde_input_invalid');
  }
  validatePdeDiagnostics(
    parseJsonBody(
      bodyByRole,
      'pde_producer_diagnostics',
      'gpu_scientific_offline_replay_pde_diagnostics_invalid',
    ),
    replayInput,
    manifest.gpuDeviceSelector,
  );
  const artifactBytes = replayInput.artifacts.map((artifact) => {
    const entry = entryByProducerPath.get(`pde-poisson-2d-gpu-v1\0${artifact.relativePath}`);
    const body = bodyByRole.get(`pde_solution_n${artifact.gridSize}`);
    if (!entry || !Buffer.isBuffer(body)
      || entry.sha256 !== artifact.sha256
      || entry.bytes !== artifact.bytes
      || hashBytes(body) !== artifact.sha256
      || body.length !== artifact.bytes) {
      throw new Error('gpu_scientific_offline_replay_pde_artifact_binding_invalid');
    }
    return body;
  });
  let recomputed;
  try {
    recomputed = recomputePdePoisson2dMetricsFromArtifactBytes({
      producerSpecification: replayInput.producerSpecification,
      artifactManifest: { artifacts: replayInput.artifacts },
      artifactBytes,
    });
  } catch {
    throw new Error('gpu_scientific_offline_replay_pde_numeric_decode_invalid');
  }
  const blockers = pdeAcceptanceBlockers(
    recomputed,
    replayInput.producerSpecification.acceptance,
  );
  if (blockers.length) {
    const error = new Error(blockers[0]);
    error.blockers = blockers;
    throw error;
  }
  return deepFreezeJsonValue({
    status: 'gpu_scientific_offline_pde_cpu_replay_verified',
    producerDiagnosticsUsedAsScientificAuthority: false,
    observations: recomputed.observations,
    convergenceOrders: recomputed.convergenceOrders,
  });
}

function expectedTensorShapes(modelIr) {
  return modelIr.layers.flatMap((layer) => [
    { name: `${layer.layerId}.weight`, shape: [layer.outputUnits, layer.inputUnits] },
    { name: `${layer.layerId}.bias`, shape: [layer.outputUnits] },
  ]).sort((left, right) => left.name.localeCompare(right.name));
}

function decodeTensorBundle(content, modelIr) {
  if (!Buffer.isBuffer(content)) {
    throw new Error('gpu_scientific_offline_replay_dl_tensor_bundle_invalid');
  }
  const valuesByName = new Map();
  const descriptors = [];
  let offset = 0;
  for (const expected of expectedTensorShapes(modelIr)) {
    const elements = expected.shape.reduce((product, dimension) => product * dimension, 1);
    const byteLength = elements * Float32Array.BYTES_PER_ELEMENT;
    if (offset + byteLength > content.length) {
      throw new Error('gpu_scientific_offline_replay_dl_tensor_offset_invalid');
    }
    const bytes = content.subarray(offset, offset + byteLength);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const values = new Float32Array(elements);
    for (let index = 0; index < elements; index += 1) {
      const value = view.getFloat32(index * Float32Array.BYTES_PER_ELEMENT, true);
      if (!Number.isFinite(value)) {
        throw new Error('gpu_scientific_offline_replay_dl_tensor_nonfinite');
      }
      values[index] = value;
    }
    descriptors.push({
      name: expected.name,
      dtype: 'float32',
      shape: expected.shape,
      byteLength,
      sha256: hashBytes(bytes),
    });
    valuesByName.set(expected.name, values);
    offset += byteLength;
  }
  if (offset !== content.length) {
    throw new Error('gpu_scientific_offline_replay_dl_tensor_offset_invalid');
  }
  return { descriptors, valuesByName };
}

function validateModelSpecification(value, dataset) {
  if (!hasExactObjectKeys(value, MODEL_SPECIFICATION_KEYS)
    || value.version !== 1
    || value.kind !== 'DeepLearningModelSpecification'
    || !verifyDeterministicSupervisedClassificationGpuProfile(value.profile)
    || !verifyDeterministicSupervisedClassificationModelIr(value.modelIr)
    || value.modelIr.profileHash !== value.profile.deepLearningGpuProfileHash
    || value.modelIr.inputFeatureCount !== dataset.featureCount
    || value.modelIr.classCount !== dataset.classCount) {
    throw new Error('gpu_scientific_offline_replay_dl_model_spec_invalid');
  }
  return value.modelIr;
}

function validateSummary(summary, {
  manifest,
  modelIr,
  dataset,
  descriptors,
  tensorBytes,
}) {
  const runtime = summary?.runtime;
  const finalMetrics = summary?.finalMetrics;
  if (!hasExactObjectKeys(summary, SUMMARY_KEYS)
    || summary.version !== 1
    || summary.kind !== 'CanonicalCupyMlpTrainingSummary'
    || !SAFE_ID.test(String(summary.trainingRunId || ''))
    || summary.profileHash !== modelIr.profileHash
    || summary.modelIrHash !== modelIr.deepLearningModelIrHash
    || summary.trainingDatasetManifestHash
      !== dataset.deepLearningTrainingDatasetManifestHash
    || !SHA256.test(String(summary.gpuMemoryCapacityPlanHash || ''))
    || summary.seed !== modelIr.seed
    || summary.completedEpoch !== modelIr.training.epochs
    || summary.trainingStepCount
      !== Math.ceil(dataset.sampleCount / modelIr.training.batchSize)
        * modelIr.training.epochs
    || summary.tensorBundleArtifactBytes !== tensorBytes
    || !Array.isArray(summary.tensors)
    || summary.tensors.some((descriptor) => (
      !hasExactObjectKeys(descriptor, TENSOR_DESCRIPTOR_KEYS)
    ))
    || JSON.stringify(summary.tensors) !== JSON.stringify(descriptors)
    || summary.trainingPredictionCount !== dataset.sampleCount
    || summary.networkActionPerformed !== false
    || summary.externalActionPerformed !== false
    || summary.hiddenEvaluationPerformed !== false
    || !hasExactObjectKeys(runtime, SUMMARY_RUNTIME_KEYS)
    || runtime.framework !== 'cupy'
    || runtime.trainingComputeDevice !== 'cuda:0-single-visible-device-v1'
    || runtime.gpuDeviceSelector !== manifest.gpuDeviceSelector
    || !GPU_UUID.test(runtime.gpuDeviceSelector)
    || typeof runtime.gpuModel !== 'string' || runtime.gpuModel.length < 1
    || !/^\d{1,4}(?:\.\d{1,4}){1,3}$/.test(runtime.frameworkVersion)
    || !/^\d{1,4}(?:\.\d{1,4}){1,3}$/.test(runtime.cudaDriverVersion)
    || !/^\d{1,4}(?:\.\d{1,4}){1,3}$/.test(runtime.cudaRuntimeVersion)
    || !/^\d{1,2}\.\d{1,2}$/.test(runtime.gpuComputeCapability)
    || !hasExactObjectKeys(finalMetrics, FINAL_METRIC_KEYS)
    || !finiteMetric(finalMetrics.accuracy, 0, 1)
    || !finiteMetric(finalMetrics.crossEntropy)
    || !finiteMetric(finalMetrics.gradientNorm)
    || !finiteMetric(finalMetrics.initialCrossEntropy)) {
    throw new Error('gpu_scientific_offline_replay_dl_summary_invalid');
  }
}

function validateTrace(trace, { summary, modelIr, dataset }) {
  if (!hasExactObjectKeys(trace, TRACE_KEYS)
    || trace.version !== 1
    || trace.kind !== 'DeepLearningTrainingMetricTrace'
    || trace.trainingRunId !== summary.trainingRunId
    || trace.modelIrHash !== modelIr.deepLearningModelIrHash
    || trace.trainingDatasetManifestHash
      !== dataset.deepLearningTrainingDatasetManifestHash
    || !Array.isArray(trace.records)
    || trace.records.length !== modelIr.training.epochs
    || trace.records.some((record, index) => (
      !hasExactObjectKeys(record, TRACE_RECORD_KEYS)
      || record.epoch !== index + 1
      || !finiteMetric(record.accuracy, 0, 1)
      || !finiteMetric(record.crossEntropy)
      || !finiteMetric(record.gradientNorm)
    ))) {
    throw new Error('gpu_scientific_offline_replay_dl_trace_invalid');
  }
  const final = trace.records.at(-1);
  if (final.accuracy !== summary.finalMetrics.accuracy
    || final.crossEntropy !== summary.finalMetrics.crossEntropy
    || final.gradientNorm !== summary.finalMetrics.gradientNorm) {
    throw new Error('gpu_scientific_offline_replay_dl_trace_summary_mismatch');
  }
}

function validatePredictions(predictions, { summary, modelIr, dataset }) {
  if (!hasExactObjectKeys(predictions, PREDICTION_KEYS)
    || predictions.version !== 1
    || predictions.kind !== 'DeepLearningTrainingPredictions'
    || predictions.scope !== 'training-dataset-only-not-hidden-evaluation-v1'
    || predictions.trainingRunId !== summary.trainingRunId
    || predictions.modelIrHash !== modelIr.deepLearningModelIrHash
    || predictions.trainingDatasetManifestHash
      !== dataset.deepLearningTrainingDatasetManifestHash
    || !Array.isArray(predictions.predictedClass)
    || predictions.predictedClass.length !== dataset.sampleCount
    || predictions.predictedClass.some((label) => (
      !Number.isSafeInteger(label) || label < 0 || label >= modelIr.classCount
    ))) {
    throw new Error('gpu_scientific_offline_replay_dl_predictions_invalid');
  }
}

function forwardCpu(modelIr, valuesByName, features) {
  let current = features.map((value) => Math.fround(value));
  for (const layer of modelIr.layers) {
    const weights = valuesByName.get(`${layer.layerId}.weight`);
    const biases = valuesByName.get(`${layer.layerId}.bias`);
    const output = new Array(layer.outputUnits);
    for (let row = 0; row < layer.outputUnits; row += 1) {
      let total = Math.fround(biases[row]);
      for (let column = 0; column < layer.inputUnits; column += 1) {
        const product = Math.fround(
          current[column] * weights[row * layer.inputUnits + column],
        );
        total = Math.fround(total + product);
      }
      output[row] = layer.activation === 'relu'
        ? Math.max(total, 0) : total;
    }
    current = output;
  }
  return current;
}

function cpuPredictionMetrics(modelIr, dataset, valuesByName) {
  const operationsPerSample = modelIr.layers.reduce(
    (total, layer) => total + layer.inputUnits * layer.outputUnits,
    0,
  );
  if (!Number.isSafeInteger(operationsPerSample)
    || !Number.isSafeInteger(operationsPerSample * dataset.sampleCount)
    || operationsPerSample * dataset.sampleCount
      > MAXIMUM_CPU_REPLAY_MULTIPLY_ACCUMULATES) {
    throw new Error('gpu_scientific_offline_replay_dl_compute_budget_exceeded');
  }
  const predictedClass = [];
  let correct = 0;
  let crossEntropy = 0;
  for (let index = 0; index < dataset.sampleCount; index += 1) {
    const logits = forwardCpu(modelIr, valuesByName, dataset.features[index]);
    if (!logits.every(Number.isFinite)) {
      throw new Error('gpu_scientific_offline_replay_dl_inference_nonfinite');
    }
    let predicted = 0;
    for (let candidate = 1; candidate < logits.length; candidate += 1) {
      if (logits[candidate] > logits[predicted]) predicted = candidate;
    }
    predictedClass.push(predicted);
    correct += Number(predicted === dataset.labels[index]);
    const maximum = Math.max(...logits);
    const normalization = logits.reduce(
      (total, value) => total + Math.exp(value - maximum),
      0,
    );
    const loss = Math.log(normalization) + maximum - logits[dataset.labels[index]];
    if (!Number.isFinite(loss)) {
      throw new Error('gpu_scientific_offline_replay_dl_inference_nonfinite');
    }
    crossEntropy += loss;
  }
  return {
    predictedClass,
    accuracy: correct / dataset.sampleCount,
    crossEntropy: crossEntropy / dataset.sampleCount,
  };
}

function metricClose(left, right) {
  return Number.isFinite(left) && Number.isFinite(right)
    && Math.abs(left - right) <= Math.max(1e-5, Math.abs(right) * 1e-4);
}

function replayDeepLearning({ manifest, bodyByRole }) {
  const dataset = parseJsonBody(
    bodyByRole,
    'deep_learning_training_dataset',
    'gpu_scientific_offline_replay_dl_dataset_invalid',
  );
  if (!verifyDeepLearningInlineTrainingDataset(dataset)) {
    throw new Error('gpu_scientific_offline_replay_dl_dataset_invalid');
  }
  const modelSpecification = parseJsonBody(
    bodyByRole,
    'deep_learning_model_specification',
    'gpu_scientific_offline_replay_dl_model_spec_invalid',
  );
  const modelIr = validateModelSpecification(modelSpecification, dataset);
  const tensorBundle = bodyByRole.get('deep_learning_tensor_bundle');
  const decoded = decodeTensorBundle(tensorBundle, modelIr);
  const summary = parseJsonBody(
    bodyByRole,
    'deep_learning_training_summary',
    'gpu_scientific_offline_replay_dl_summary_invalid',
  );
  validateSummary(summary, {
    manifest,
    modelIr,
    dataset,
    descriptors: decoded.descriptors,
    tensorBytes: tensorBundle.length,
  });
  const trace = parseJsonBody(
    bodyByRole,
    'deep_learning_training_trace',
    'gpu_scientific_offline_replay_dl_trace_invalid',
  );
  validateTrace(trace, { summary, modelIr, dataset });
  const predictions = parseJsonBody(
    bodyByRole,
    'deep_learning_training_predictions',
    'gpu_scientific_offline_replay_dl_predictions_invalid',
  );
  validatePredictions(predictions, { summary, modelIr, dataset });
  const recomputed = cpuPredictionMetrics(modelIr, dataset, decoded.valuesByName);
  if (JSON.stringify(recomputed.predictedClass)
      !== JSON.stringify(predictions.predictedClass)
    || !metricClose(recomputed.accuracy, summary.finalMetrics.accuracy)
    || !metricClose(recomputed.crossEntropy, summary.finalMetrics.crossEntropy)) {
    throw new Error('gpu_scientific_offline_replay_dl_cpu_inference_mismatch');
  }
  return deepFreezeJsonValue({
    status: 'gpu_scientific_offline_deep_learning_cpu_inference_verified',
    predictionCount: recomputed.predictedClass.length,
    recomputedMetrics: {
      accuracy: recomputed.accuracy,
      crossEntropy: recomputed.crossEntropy,
    },
    sameDeviceGpuRetrainingPerformed: false,
  });
}

export function verifyGpuScientificArtifactBodyArchiveSemanticReplay({
  manifest,
  bodyByRole,
} = {}) {
  const blockers = [];
  let pde = null;
  let deepLearning = null;
  const entryByProducerPath = new Map((manifest?.entries || []).map((entry) => [
    `${entry.taskType}\0${entry.producerRelativePath}`,
    entry,
  ]));
  try {
    pde = replayPde({ manifest, bodyByRole, entryByProducerPath });
  } catch (error) {
    blockers.push(...(error?.blockers || [
      error?.message || 'gpu_scientific_offline_replay_pde_invalid',
    ]));
  }
  try {
    deepLearning = replayDeepLearning({ manifest, bodyByRole });
  } catch (error) {
    blockers.push(error?.message || 'gpu_scientific_offline_replay_dl_invalid');
  }
  return Object.freeze({
    valid: blockers.length === 0,
    blockers: Object.freeze([...new Set(blockers)]),
    status: blockers.length
      ? 'gpu_scientific_artifact_body_archive_semantic_replay_blocked'
      : 'gpu_scientific_artifact_body_archive_semantic_replay_verified',
    pde,
    deepLearning,
    productionPromotionEligible: false,
    externalAuthorityBlockers: Object.freeze([
      'deep_learning_same_device_gpu_retraining_external_authority_required',
      'pde_independent_cpu_process_qualification_external_authority_required',
    ]),
  });
}
