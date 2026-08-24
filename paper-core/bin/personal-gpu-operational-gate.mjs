#!/usr/bin/env node

/*
 * Personal single-host GPU operational gate.
 *
 * This is intentionally a different profile from the release gate.  It runs
 * the real local CuPy PDE and DL jobs, the process-isolated CPU oracle, a
 * same-device deterministic replay, and a sealed holdout evaluator.  A green
 * result means "ready for this private host" only; the receipt is explicitly
 * non-promotable and does not mint second-hardware or external-authority
 * evidence.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  composeCanonicalDeepLearningGpuTraining,
} from '../../paper-composition/automation/deep-learning-gpu-training-composition.mjs';
import {
  composeCanonicalPdePoisson2dGpuSolver,
} from '../../paper-composition/automation/pde-poisson-2d-gpu-composition.mjs';
import {
  AUTOMATION_RUNTIME_IMAGES,
} from '../../paper-adapters/automation/runtime-image-registry.mjs';
import {
  runProcessIsolatedDeepLearningIndependentCpuOracle,
} from '../../paper-adapters/research-verify/process-isolated-deep-learning-independent-cpu-oracle.mjs';
import {
  buildDeepLearningReplayPlan,
  DEEP_LEARNING_REPLAY_ERROR_BUDGET,
  DEEP_LEARNING_REPLAY_SCOPES,
  evaluateDeepLearningCheckpointDataset,
  verifyDeepLearningReplayExecutionBinding,
} from '../../paper-adapters/research-verify/deep-learning-independent-replay.mjs';
import {
  buildDeepLearningHiddenEvaluationPlan,
  buildDeepLearningHiddenEvaluationReceipt,
  verifyDeepLearningHiddenEvaluationReceipt,
} from '../../paper-domain/research/deep-learning-evidence-authority-contract.mjs';
import {
  buildCanonicalParityDeepLearningTrainingDataset,
  buildCanonicalSyntheticDeepLearningDatasetAuthority,
} from '../../paper-domain/research/deep-learning-training-dataset-authority-contract.mjs';
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
  verifyProcessIsolatedDeepLearningCpuOracleAssurance,
} from '../../paper-domain/research/process-isolated-deep-learning-independent-cpu-oracle-contract.mjs';
import {
  buildPersonalGpuOperationalReceipt,
  verifyPersonalGpuOperationalReceipt,
} from '../../paper-domain/research/personal-gpu-operational-gate-contract.mjs';
import { currentCodeProvenance } from '../../paper-adapters/runtime/code-provenance.mjs';
import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { readScopedFileSync } from '../../workflow-kernel/runtime/scoped-file-identity.mjs';
import { parseStrictCliArguments } from '../src/strict-cli-arguments.mjs';
import { defaultPaperRuntimeRoot } from '../src/workspace-layout.mjs';

const WORKSPACE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const GPU_QUERY = [
  '--query-gpu=uuid,name,compute_cap,driver_version,memory.total',
  '--format=csv,noheader,nounits',
];
const GPU_UUID = /^GPU-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const DEFAULT_DEADLINE_MS = 30 * 60 * 1_000;
const MAX_DEADLINE_MS = 6 * 60 * 60 * 1_000;

function safeToken(value) {
  return String(value || 'error').replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 180);
}

function invoke(command, args, { timeout = 10_000 } = {}) {
  try {
    const result = spawnSync(command, args, {
      encoding: 'utf8',
      timeout,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
    });
    return result;
  } catch (error) {
    return { status: null, stdout: '', stderr: String(error?.message || error), error };
  }
}

function observeGpu() {
  const result = invoke('/usr/bin/nvidia-smi', GPU_QUERY, { timeout: 5_000 });
  if (result.status !== 0 || result.error) {
    throw new Error('personal_gpu_nvidia_smi_unavailable');
  }
  const rows = String(result.stdout || '').trim().split(/\r?\n/u)
    .map((line) => line.trim()).filter(Boolean);
  if (rows.length !== 1) throw new Error('personal_gpu_requires_exactly_one_device');
  const columns = rows[0].split(',').map((item) => item.trim());
  if (columns.length !== 5 || !GPU_UUID.test(columns[0]) || !columns[1]
    || !/^\d{1,2}\.\d{1,2}$/u.test(columns[2])
    || !/^\d+(?:\.\d+){1,3}$/u.test(columns[3])
    || !/^\d+$/u.test(columns[4])) {
    throw new Error('personal_gpu_observation_invalid');
  }
  return Object.freeze({
    gpuUuid: columns[0], gpuModel: columns[1], computeCapability: columns[2],
    driverVersion: columns[3], memoryMiB: Number(columns[4]),
  });
}

function loadedImageDigest() {
  const image = AUTOMATION_RUNTIME_IMAGES.pythonGpu.image;
  const digest = AUTOMATION_RUNTIME_IMAGES.pythonGpu.imageDigest;
  const result = invoke('docker', [
    'image', 'inspect', `${image}@${digest}`, '--format', '{{json .RepoDigests}}',
  ], { timeout: 10_000 });
  if (result.status !== 0 || result.error) {
    throw new Error('personal_gpu_pinned_image_not_loaded');
  }
  let repoDigests;
  try {
    repoDigests = JSON.parse(String(result.stdout || '').trim());
    // Node's spawn receives the Go-template JSON string as a JSON-encoded
    // string on some Docker versions; normalize both representations.
    if (typeof repoDigests === 'string') repoDigests = JSON.parse(repoDigests);
  } catch {
    repoDigests = null;
  }
  // Docker's RepoDigests intentionally drops the tag (`repo@sha256:...`),
  // while the immutable inspect reference above includes it.  Bind the
  // repository and digest, never the mutable tag, when checking the cache.
  const repository = image.replace(/:[^/:]+$/u, '');
  const expectedRepoDigest = `${repository}@${digest}`;
  if (!Array.isArray(repoDigests)
    || !repoDigests.includes(expectedRepoDigest)) {
    throw new Error('personal_gpu_pinned_image_digest_not_bound');
  }
  return Object.freeze({ image, imageDigest: digest });
}

function ensurePrivateDirectory(candidate) {
  const selected = path.resolve(candidate);
  if (selected === path.parse(selected).root) {
    throw new Error('personal_gpu_output_root_unsafe');
  }
  if (!fs.existsSync(selected)) {
    const parent = path.dirname(selected);
    const parentStat = fs.lstatSync(parent);
    if (!parentStat.isDirectory() || parentStat.isSymbolicLink()
      || fs.realpathSync.native(parent) !== parent) {
      throw new Error('personal_gpu_output_parent_unsafe');
    }
    fs.mkdirSync(selected, { mode: 0o700 });
  }
  const stat = fs.lstatSync(selected);
  if (!stat.isDirectory() || stat.isSymbolicLink()
    || fs.realpathSync.native(selected) !== selected
    || (typeof process.geteuid === 'function' && stat.uid !== process.geteuid())
    || (stat.mode & 0o077) !== 0) {
    throw new Error('personal_gpu_output_root_unsafe');
  }
  return selected;
}

function writePrivateJson(target, value) {
  const selected = path.resolve(target);
  const parent = ensurePrivateDirectory(path.dirname(selected));
  if (!selected.startsWith(`${parent}${path.sep}`)) {
    throw new Error('personal_gpu_receipt_path_invalid');
  }
  const temporary = path.join(parent, `.${path.basename(selected)}.${process.pid}.tmp`);
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
  const descriptor = fs.openSync(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o400);
  try {
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
  } finally { fs.closeSync(descriptor); }
  fs.chmodSync(temporary, 0o400);
  fs.renameSync(temporary, selected);
  return selected;
}

function readBoundArtifact(outputDirectory, artifactPath) {
  const candidate = path.join(outputDirectory, artifactPath);
  const read = readScopedFileSync({
    scopeRoot: outputDirectory,
    candidate,
    maximumBytes: 64 * 1024 * 1024,
  });
  if (read.status !== 'scoped_file_read_verified') {
    throw new Error(`personal_gpu_artifact_read_failed:${artifactPath}`);
  }
  return read;
}

function modelFixture() {
  const trainingDataset = buildCanonicalParityDeepLearningTrainingDataset({
    datasetId: 'personal-gpu-operational-dataset-v1', featureCount: 2,
  });
  const modelIr = buildDeterministicSupervisedClassificationModelIr({
    modelId: 'personal-gpu-operational-model-v1',
    profileHash: DETERMINISTIC_SUPERVISED_CLASSIFICATION_GPU_PROFILE.deepLearningGpuProfileHash,
    inputFeatureCount: 2,
    classCount: 2,
    layers: [
      { layerId: 'hidden', type: 'dense', inputUnits: 2, outputUnits: 4, activation: 'relu', useBias: true },
      { layerId: 'logits', type: 'dense', inputUnits: 4, outputUnits: 2, activation: 'identity', useBias: true },
    ],
    training: {
      optimizer: 'adamw-v1', loss: 'sparse-cross-entropy-with-logits-v1',
      initialization: 'stateless-sha256-box-muller-v1', batchOrder: 'seeded-fisher-yates-v1',
      earlyStoppingEnabled: false, epochs: 2, batchSize: 4, learningRate: 0.01,
      weightDecay: 0, beta1: 0.9, beta2: 0.999, epsilon: 1e-8, gradientClipNorm: 10,
    },
    seed: 42,
  });
  const trainingDatasetAuthority = buildCanonicalSyntheticDeepLearningDatasetAuthority({
    trainingDataset,
    generatorSpec: { datasetId: trainingDataset.datasetId, featureCount: 2 },
  });
  // This holdout is generated independently of the training manifest.  Its
  // values stay in the local evaluator, not in the training request.
  const hiddenDataset = buildDeepLearningInlineTrainingDataset({
    datasetId: 'personal-gpu-sealed-holdout-v1',
    classCount: 2,
    features: [[0.05, 0.15], [0.85, 0.10], [0.15, 0.90], [0.90, 0.80]],
    labels: [0, 1, 1, 0],
  });
  return Object.freeze({ trainingDataset, trainingDatasetAuthority, modelIr, hiddenDataset });
}

function trainingOutputDirectory(outputRoot, trainingRunId) {
  return path.join(outputRoot, `training-${hashRecord('DeepLearningTrainingRunDirectory', {
    trainingRunId,
  }).slice('sha256:'.length)}`);
}

function readTrainingArtifacts(receipt, outputDirectory) {
  if (typeof outputDirectory !== 'string' || !fs.existsSync(outputDirectory)) {
    throw new Error('personal_gpu_dl_output_missing');
  }
  const tensor = readBoundArtifact(outputDirectory, 'tensor-bundle.bin');
  const predictions = readBoundArtifact(outputDirectory, 'training-predictions.json');
  const summary = readBoundArtifact(outputDirectory, 'training-summary.json');
  const predictionDoc = JSON.parse(predictions.content.toString('utf8'));
  const summaryDoc = JSON.parse(summary.content.toString('utf8'));
  if (predictions.hash !== receipt.trainingPredictionsArtifactHash
    || summary.hash !== receipt.trainingSummaryArtifactHash
    || tensor.hash !== receipt.trainingExecutionReceipt.checkpointManifest.checkpointArtifactHash) {
    throw new Error('personal_gpu_dl_artifact_hash_binding_invalid');
  }
  return Object.freeze({
    tensorBytes: tensor.content,
    expectedPredictions: predictionDoc.predictedClass,
    expectedMetrics: summaryDoc.finalMetrics,
  });
}

function buildHiddenEvaluation({ receipt, hiddenDataset, tensorBytes }) {
  const evaluatorImplementationHash = hashRecord(
    'PersonalGpuHiddenEvaluatorImplementation', {
      version: 1,
      algorithm: 'independent-fp32-checkpoint-forward-v1',
      source: 'paper-adapters/research-verify/deep-learning-independent-replay.mjs',
    },
  );
  const evaluationPlan = buildDeepLearningHiddenEvaluationPlan({
    evaluationPlanId: 'personal-gpu-sealed-holdout-v1',
    hiddenDatasetCommitmentHash: hashRecord('PersonalGpuHiddenDatasetCommitment', {
      datasetManifestHash: hiddenDataset.deepLearningTrainingDatasetManifestHash,
      datasetContentHash: hiddenDataset.datasetContentHash,
    }),
    evaluatorImplementationHash,
    minimumSampleCount: hiddenDataset.sampleCount,
  });
  const metrics = evaluateDeepLearningCheckpointDataset({
    executionReceipt: receipt.trainingExecutionReceipt,
    evaluationDataset: hiddenDataset,
    tensorBundleBytes: tensorBytes,
  });
  const predictionsArtifactHash = hashRecord('PersonalGpuHiddenPredictions', {
    evaluationPlanHash: evaluationPlan.deepLearningHiddenEvaluationPlanHash,
    predictions: metrics.predictions,
  });
  const hiddenEvaluationReceipt = buildDeepLearningHiddenEvaluationReceipt({
    evaluationPlan,
    executionReceipt: receipt.trainingExecutionReceipt,
    sampleCount: hiddenDataset.sampleCount,
    metrics: { accuracy: metrics.accuracy, crossEntropy: metrics.crossEntropy },
    predictionsArtifactHash,
  });
  if (!verifyDeepLearningHiddenEvaluationReceipt(hiddenEvaluationReceipt, {
    executionReceipt: receipt.trainingExecutionReceipt,
  })) throw new Error('personal_gpu_hidden_evaluation_receipt_invalid');
  return Object.freeze({ hiddenEvaluationReceipt, metrics, evaluatorImplementationHash });
}

async function executeGate({ workspaceRoot, runtimeRoot, outputRoot, runId, deadlineMs }) {
  const provenance = currentCodeProvenance({
    workspaceRoot,
    allowReleaseCommitEnvironment: false,
  });
  if (provenance.treeDirty || provenance.indexStateHash !== 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855') {
    throw new Error('personal_gpu_requires_clean_exact_commit');
  }
  const gpu = observeGpu();
  const image = loadedImageDigest();
  const fixture = modelFixture();
  const deadline = Date.now() + deadlineMs;
  const pdeRoot = ensurePrivateDirectory(path.join(outputRoot, 'pde'));
  const dlOriginalRoot = ensurePrivateDirectory(path.join(outputRoot, 'dl-original'));
  const dlReplayRoot = ensurePrivateDirectory(path.join(outputRoot, 'dl-replay'));
  const pde = await composeCanonicalPdePoisson2dGpuSolver({
    outputRoot: pdeRoot,
    runtimeRoot,
    timeoutMs: Math.min(180_000, deadline - Date.now()),
    memoryBytes: 2 * 1024 ** 3,
    cpuSeconds: 180,
    maximumProcesses: 32,
    maximumOutputBytes: 16 * 1024 ** 2,
  }).executeAndVerify({
    runId: `${runId}-pde`,
    gpuDeviceSelector: gpu.gpuUuid,
    absoluteDeadlineEpochMs: deadline,
  });
  if (pde.status !== 'canonical_pde_poisson_2d_gpu_scientifically_verified_non_promotable'
    || pde.cpuOracleAssurance?.status
      !== 'process_isolated_pde_poisson_2d_cpu_oracle_verified') {
    throw new Error(`personal_gpu_pde_not_verified:${safeToken(pde.status)}`);
  }
  const trainingOptions = {
    profile: DETERMINISTIC_SUPERVISED_CLASSIFICATION_GPU_PROFILE,
    modelIr: fixture.modelIr,
    trainingDataset: fixture.trainingDataset,
    trainingDatasetAuthority: fixture.trainingDatasetAuthority,
    gpuDeviceSelector: gpu.gpuUuid,
    absoluteDeadlineEpochMs: deadline,
  };
  const original = await composeCanonicalDeepLearningGpuTraining({
    outputRoot: dlOriginalRoot,
    runtimeRoot,
    timeoutMs: Math.min(180_000, deadline - Date.now()),
    memoryBytes: 2 * 1024 ** 3,
    cpuSeconds: 180,
    maximumProcesses: 32,
    maximumOutputBytes: 128 * 1024 ** 2,
  }).trainingExecutor.execute({
    ...trainingOptions,
    trainingRunId: `${runId}-original`,
  });
  if (original.status !== 'canonical_cupy_deep_learning_training_recorded_non_promotable') {
    throw new Error(`personal_gpu_dl_original_not_recorded:${safeToken(original.status)}`);
  }
  const replay = await composeCanonicalDeepLearningGpuTraining({
    outputRoot: dlReplayRoot,
    runtimeRoot,
    timeoutMs: Math.min(180_000, deadline - Date.now()),
    memoryBytes: 2 * 1024 ** 3,
    cpuSeconds: 180,
    maximumProcesses: 32,
    maximumOutputBytes: 128 * 1024 ** 2,
  }).trainingExecutor.execute({
    ...trainingOptions,
    trainingRunId: `${runId}-replay`,
  });
  if (replay.status !== 'canonical_cupy_deep_learning_training_recorded_non_promotable') {
    throw new Error(`personal_gpu_dl_replay_not_recorded:${safeToken(replay.status)}`);
  }
  const originalArtifacts = readTrainingArtifacts(
    original,
    trainingOutputDirectory(dlOriginalRoot, `${runId}-original`),
  );
  const replayArtifacts = readTrainingArtifacts(
    replay,
    trainingOutputDirectory(dlReplayRoot, `${runId}-replay`),
  );
  const runtimeIdentityHash = hashRecord('PersonalGpuRuntimeIdentity', {
    image: image.image,
    imageDigest: image.imageDigest,
    gpuUuid: gpu.gpuUuid,
  });
  const replayPlan = buildDeepLearningReplayPlan({
    originalExecutionReceipt: original.trainingExecutionReceipt,
    replayScope: DEEP_LEARNING_REPLAY_SCOPES.sameDeviceGpu,
    replayDeviceIdentityHash: original.trainingExecutionReceipt.runtimeBom.gpuDeviceUuidHash,
    replayRuntimeIdentityHash: runtimeIdentityHash,
    errorBudget: DEEP_LEARNING_REPLAY_ERROR_BUDGET,
  });
  const deterministicBinding = verifyDeepLearningReplayExecutionBinding({
    plan: replayPlan,
    originalExecutionReceipt: original.trainingExecutionReceipt,
    replayExecutionReceipt: replay.trainingExecutionReceipt,
  });
  if (!deterministicBinding) throw new Error('personal_gpu_same_device_replay_mismatch');
  // The canonical authority receipt requires the metric-trace artifact hash
  // to be byte-identical.  That trace intentionally contains each run's
  // runId, so two real executions have different trace *metadata* even when
  // their checkpoint/prediction surfaces are bit-identical.  Record the
  // local observation separately instead of weakening the release contract.
  const originalExecution = original.trainingExecutionReceipt;
  const replayExecution = replay.trainingExecutionReceipt;
  const sameDeviceSurfaceEqual = originalExecution.runtimeBomHash
    === replayExecution.runtimeBomHash
    && originalExecution.runtimeBom.gpuDeviceUuidHash
      === replayExecution.runtimeBom.gpuDeviceUuidHash
    && originalExecution.checkpointManifest.checkpointArtifactHash
      === replayExecution.checkpointManifest.checkpointArtifactHash
    && originalExecution.checkpointManifest.tensorSetHash
      === replayExecution.checkpointManifest.tensorSetHash
    && JSON.stringify(originalExecution.finalMetrics)
      === JSON.stringify(replayExecution.finalMetrics)
    && originalArtifacts.expectedPredictions.length
      === replayArtifacts.expectedPredictions.length
    && JSON.stringify(originalArtifacts.expectedPredictions)
      === JSON.stringify(replayArtifacts.expectedPredictions)
    && hashBytes(originalArtifacts.tensorBytes) === hashBytes(replayArtifacts.tensorBytes);
  if (!sameDeviceSurfaceEqual) throw new Error('personal_gpu_same_device_replay_surface_mismatch');
  const sameDeviceReplay = {
    version: 1,
    kind: 'PersonalSameDeviceReplayObservation',
    status: 'personal_same_device_replay_verified',
    originalExecutionReceiptHash: originalExecution.deepLearningTrainingExecutionReceiptHash,
    replayExecutionReceiptHash: replayExecution.deepLearningTrainingExecutionReceiptHash,
    replayPlanHash: replayPlan.deepLearningReplayPlanHash,
    deviceIdentityHash: originalExecution.runtimeBom.gpuDeviceUuidHash,
    runtimeBomHash: originalExecution.runtimeBomHash,
    checkpointArtifactHash: originalExecution.checkpointManifest.checkpointArtifactHash,
    tensorSetHash: originalExecution.checkpointManifest.tensorSetHash,
    metricTraceMetadataDiffersOnlyByRunId:
      originalExecution.metricTraceArtifactHash !== replayExecution.metricTraceArtifactHash,
    productionPromotionEligible: false,
  };
  sameDeviceReplay.personalSameDeviceReplayObservationHash = hashRecord(
    'PersonalSameDeviceReplayObservation', sameDeviceReplay,
  );
  const cpuOracle = runProcessIsolatedDeepLearningIndependentCpuOracle({
    executionReceipt: original.trainingExecutionReceipt,
    trainingDataset: fixture.trainingDataset,
    tensorBundleBytes: originalArtifacts.tensorBytes,
    expectedPredictions: originalArtifacts.expectedPredictions,
    expectedMetrics: originalArtifacts.expectedMetrics,
    replayRuntimeIdentityHash: runtimeIdentityHash,
    absoluteDeadlineEpochMs: deadline,
  });
  if (!verifyProcessIsolatedDeepLearningCpuOracleAssurance(cpuOracle)
    || cpuOracle.status !== 'process_isolated_deep_learning_cpu_oracle_verified') {
    throw new Error(`personal_gpu_dl_cpu_oracle_not_verified:${safeToken(cpuOracle.status)}`);
  }
  const hidden = buildHiddenEvaluation({
    receipt: original,
    hiddenDataset: fixture.hiddenDataset,
    tensorBytes: originalArtifacts.tensorBytes,
  });
  const releaseRoot = path.relative(runtimeRoot, outputRoot).split(path.sep).join('/');
  const pdeReceipt = pde;
  const pdeCpu = pde.cpuOracleAssurance;
  const deepLearning = {
    status: 'personal_deep_learning_gpu_verified_non_promotable',
    originalReceiptHash: original.canonicalCupyDeepLearningTrainingReceiptHash,
    replayReceiptHash: replay.canonicalCupyDeepLearningTrainingReceiptHash,
    sameDeviceReplayHash: sameDeviceReplay.personalSameDeviceReplayObservationHash,
    cpuOracleHash: cpuOracle.deepLearningIndependentCpuOracleAssuranceHash,
    cpuOracleStatus: cpuOracle.status,
    hiddenEvaluationHash: hidden.hiddenEvaluationReceipt.deepLearningHiddenEvaluationReceiptHash,
    hiddenEvaluationStatus: hidden.hiddenEvaluationReceipt.status,
    modelIrHash: originalExecution.modelIrHash,
    datasetManifestHash: originalExecution.trainingDatasetManifestHash,
    checkpointManifestHash: originalExecution.checkpointManifestHash,
    deterministicReplay: deterministicBinding,
    errorBudgetHash: hashRecord('PersonalGpuReplayErrorBudget', DEEP_LEARNING_REPLAY_ERROR_BUDGET),
  };
  const ir = {
    modelHash: originalExecution.modelIrHash,
    datasetHash: originalExecution.trainingDatasetManifestHash,
    checkpointHash: originalExecution.checkpointManifestHash,
    modelExecutableCodeEmbedded: originalExecution.modelIr.executableCodeEmbedded,
    checkpointExecutablePayloadAllowed: originalExecution.checkpointManifest.executablePayloadAllowed,
    pickleAllowed: originalExecution.checkpointManifest.pickleAllowed,
  };
  const receipt = buildPersonalGpuOperationalReceipt({
    createdAtEpochMs: Date.now(),
    workspaceCommit: provenance.commit,
    gpu,
    runtime: {
      image: image.image,
      imageDigest: image.imageDigest,
      dockerDigestBound: true,
      networkDisabled: true,
      singleDevicePinned: true,
    },
    pde: {
      status: pdeReceipt.status,
      receiptHash: pdeReceipt.canonicalPdePoisson2dGpuScientificReceiptHash,
      cpuOracleStatus: pdeCpu.status,
      cpuOracleHash: pdeCpu.pdePoisson2dProcessIsolatedCpuOracleAssuranceHash,
      scientificChecksPassed: pde.status
        === 'canonical_pde_poisson_2d_gpu_scientifically_verified_non_promotable',
    },
    deepLearning,
    ir,
    externalActionPerformed: false,
    networkActionPerformed: false,
  });
  return Object.freeze({
    receipt,
    provenance,
    runId,
    artifactRoot: releaseRoot,
    raw: {
      pde: pdeReceipt,
      original,
      replay,
      cpuOracle,
      hidden: hidden.hiddenEvaluationReceipt,
      replayPlan,
      originalArtifacts,
      replayArtifacts,
    },
  });
}

function loadExistingReceipt(receiptPath) {
  const read = readBoundArtifact(path.dirname(receiptPath), path.basename(receiptPath));
  const value = JSON.parse(read.content.toString('utf8'));
  if (!verifyPersonalGpuOperationalReceipt(value)) {
    throw new Error('personal_gpu_existing_receipt_invalid');
  }
  return value;
}

function usage() {
  return [
    'personal-gpu-operational-gate [--write] [--check] [--root PATH] [--runtime-root PATH]',
    '  Runs the local single-host GPU/PDE/DL gate. Green is personal-only and non-promotable.',
  ].join('\n');
}

export { executeGate, loadExistingReceipt };

if (path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  let args;
  try {
    args = parseStrictCliArguments(process.argv.slice(2), {
      booleanFlags: ['check', 'help', 'write'],
      valueFlags: ['root', 'runtime-root', 'output-root', 'receipt', 'run-id', 'deadline-ms'],
      positional: false,
    });
  } catch (error) {
    process.stderr.write(`${error?.message || error}\n${usage()}\n`);
    process.exitCode = 2;
  }
  if (args) {
    if (args.help) process.stdout.write(`${usage()}\n`);
    else {
      const workspaceRoot = path.resolve(args.root || WORKSPACE_ROOT);
      const runtimeRoot = path.resolve(args['runtime-root'] || process.env.HEPTA_PAPER_RUNTIME_ROOT || defaultPaperRuntimeRoot());
      const receiptPath = path.resolve(args.receipt || path.join(runtimeRoot, 'gpu-personal', 'personal-gpu-operational-receipt.json'));
      try {
        if (args.check) {
          const existing = loadExistingReceipt(receiptPath);
          process.stdout.write(`${JSON.stringify(existing, null, 2)}\n`);
          process.exitCode = existing.personalProductionReady ? 0 : 2;
        } else {
          const runId = String(args['run-id'] || `personal-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`);
          if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,120}$/u.test(runId)) throw new Error('personal_gpu_run_id_invalid');
          const deadlineMs = Math.min(MAX_DEADLINE_MS, Math.max(60_000, Number(args['deadline-ms'] || DEFAULT_DEADLINE_MS)));
          if (!Number.isSafeInteger(deadlineMs)) throw new Error('personal_gpu_deadline_invalid');
          const outputRoot = ensurePrivateDirectory(args['output-root'] || path.join(runtimeRoot, 'gpu-personal', 'runs', runId));
          const result = await executeGate({ workspaceRoot, runtimeRoot, outputRoot, runId, deadlineMs });
          if (args.write) writePrivateJson(receiptPath, result.receipt);
          process.stdout.write(`${JSON.stringify({
            ...result.receipt,
            artifactRoot: result.artifactRoot,
            receiptPath: args.write ? receiptPath : null,
          }, null, 2)}\n`);
          process.exitCode = result.receipt.personalProductionReady ? 0 : 2;
        }
      } catch (error) {
        const blockers = [`personal_gpu_gate_failed:${safeToken(error?.message || error)}`];
        let fallback;
        try {
          const provenance = currentCodeProvenance({ workspaceRoot, allowReleaseCommitEnvironment: false });
          fallback = buildPersonalGpuOperationalReceipt({
            workspaceCommit: provenance.commit,
            blockers,
          });
        } catch {
          fallback = buildPersonalGpuOperationalReceipt({ blockers });
        }
        if (args.write) {
          try { writePrivateJson(receiptPath, fallback); } catch { /* report below */ }
        }
        process.stdout.write(`${JSON.stringify(fallback, null, 2)}\n`);
        process.exitCode = 2;
      }
    }
  }
}
