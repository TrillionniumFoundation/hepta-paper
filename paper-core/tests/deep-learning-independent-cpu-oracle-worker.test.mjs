import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  DEEP_LEARNING_REPLAY_ERROR_BUDGET,
  replayDeepLearningCheckpoint,
} from '../../paper-adapters/research-verify/deep-learning-independent-replay.mjs';
import {
  currentDeepLearningCpuOracleWorkerImplementation,
} from '../../paper-adapters/research-verify/independent-deep-learning-cpu-oracle-worker.mjs';
import {
  createDeepLearningCpuOracleSandboxRunner,
} from '../../paper-adapters/research-verify/deep-learning-cpu-oracle-sandbox-runner-factory.mjs';
import {
  runProcessIsolatedDeepLearningIndependentCpuOracle,
} from '../../paper-adapters/research-verify/process-isolated-deep-learning-independent-cpu-oracle.mjs';
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
  buildProcessIsolatedDeepLearningCpuOracleRequest,
  DEEP_LEARNING_CPU_ORACLE_RESOURCE_LIMITS,
  verifyDeepLearningCpuOracleWorkerImplementation,
  verifyProcessIsolatedDeepLearningCpuOracleReceipt,
} from '../../paper-domain/research/process-isolated-deep-learning-independent-cpu-oracle-contract.mjs';
import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';

const WORKER_PATH = fileURLToPath(new URL(
  '../../paper-adapters/research-verify/independent-deep-learning-cpu-oracle-worker.mjs',
  import.meta.url,
));
const H = (label) => hashRecord('DeepLearningCpuOracleWorkerTest', { label });

function modelIr() {
  return buildDeterministicSupervisedClassificationModelIr({
    modelId: 'process-cpu-oracle-model',
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
    datasetId: 'process-cpu-oracle-dataset',
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
  const checkpointManifest = buildDeepLearningCheckpointManifest({
    trainingRunId: 'process-cpu-oracle-run',
    modelIr: model,
    runtimeBom: runtime,
    trainingDatasetManifestHash:
      trainingDataset.deepLearningTrainingDatasetManifestHash,
    completedEpoch: 1,
    trainingStepCount: 2,
    finiteTensorScanReceiptHash: H('finite-tensor-scan'),
    tensors: bundle.tensors,
    tensorBundleArtifactBytes: bundle.bytes.length,
    checkpointArtifactHash: hashBytes(bundle.bytes),
  });
  const executionReceipt = buildDeepLearningTrainingExecutionReceipt({
    trainingRunId: 'process-cpu-oracle-run',
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

function fixture() {
  const first = executionFixture();
  const probe = replayDeepLearningCheckpoint({
    executionReceipt: first.executionReceipt,
    trainingDataset: first.trainingDataset,
    tensorBundleBytes: first.bundle.bytes,
    expectedPredictions: [0, 0, 0, 0],
    expectedMetrics: first.executionReceipt.finalMetrics,
    replayRuntimeIdentityHash: H('node-cpu-oracle'),
  });
  const metrics = {
    ...probe.observedMetrics,
    gradientNorm: first.executionReceipt.finalMetrics.gradientNorm,
  };
  const selected = executionFixture(metrics);
  const implementation = currentDeepLearningCpuOracleWorkerImplementation();
  const request = buildProcessIsolatedDeepLearningCpuOracleRequest({
    executionReceipt: selected.executionReceipt,
    trainingDataset: selected.trainingDataset,
    tensorBundleBase64: selected.bundle.bytes.toString('base64'),
    expectedPredictions: [0, 0, 0, 0],
    expectedMetrics: selected.executionReceipt.finalMetrics,
    replayRuntimeIdentityHash: H('node-cpu-oracle'),
    workerImplementationHash: implementation.workerImplementationHash,
    workerImplementation: implementation,
    errorBudget: DEEP_LEARNING_REPLAY_ERROR_BUDGET,
    resourceBudget: DEEP_LEARNING_CPU_ORACLE_RESOURCE_LIMITS,
  });
  return { selected, implementation, request };
}

test('process-isolated DL CPU oracle verifies replay and remains non-promotable', () => {
  const { request, implementation } = fixture();
  assert.equal(verifyDeepLearningCpuOracleWorkerImplementation(implementation), true);
  const child = spawnSync(process.execPath, [WORKER_PATH], {
    input: `${JSON.stringify(request)}\n`,
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  assert.equal(child.status, 0, child.stderr);
  const receipt = JSON.parse(child.stdout);
  assert.equal(receipt.status, 'deep_learning_independent_cpu_oracle_verified');
  assert.equal(receipt.processIndependent, true);
  assert.equal(receipt.networkGuardInstalled, true);
  assert.equal(receipt.productionPromotionEligible, false);
  assert.deepEqual(receipt.productionBlockers, [
    'deep_learning_independent_cpu_oracle_external_authority_required',
  ]);
  assert.equal(
    verifyProcessIsolatedDeepLearningCpuOracleReceipt(receipt, {
      request,
      workerImplementation: implementation,
    }),
    true,
  );
});

test('process-isolated DL CPU oracle rejects request and budget drift', () => {
  const { request, implementation } = fixture();
  const forged = structuredClone(request);
  forged.tensorBundleBase64 = `${forged.tensorBundleBase64.slice(0, -4)}AAAA`;
  const child = spawnSync(process.execPath, [WORKER_PATH], {
    input: `${JSON.stringify(forged)}\n`,
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  assert.equal(child.status, 2);
  const receipt = JSON.parse(child.stdout);
  assert.equal(receipt.status, 'deep_learning_independent_cpu_oracle_blocked');
  assert.ok(receipt.blockers.includes('deep_learning_cpu_oracle_request_invalid'));
  assert.equal(receipt.productionPromotionEligible, false);
  assert.equal(
    verifyProcessIsolatedDeepLearningCpuOracleReceipt(receipt, {
      request,
      workerImplementation: implementation,
    }),
    false,
  );
});

test('worker implementation recursively binds every local import in stable order', () => {
  const baseline = currentDeepLearningCpuOracleWorkerImplementation();
  const transitive = baseline.sourceRecords.slice(5);
  assert.ok(transitive.length > 0);
  assert.ok(transitive.every((record) => record.role.startsWith('transitive:')));
  assert.deepEqual(
    transitive.map((record) => record.role),
    transitive.map((record) => record.role).sort(),
  );
  assert.equal(new Set(transitive.map((record) => record.role)).size, transitive.length);
  assert.ok(transitive.some((record) => record.role
    === 'transitive:workflow-kernel/record-hash.mjs'));

  const mutated = currentDeepLearningCpuOracleWorkerImplementation({
    readSource(sourcePath) {
      const bytes = fs.readFileSync(sourcePath);
      return sourcePath.endsWith('/workflow-kernel/record-hash.mjs')
        ? Buffer.concat([bytes, Buffer.from('\n// mutation fixture\n')]) : bytes;
    },
  });
  assert.notEqual(mutated.sourceManifestHash, baseline.sourceManifestHash);
  assert.notEqual(mutated.workerImplementationHash, baseline.workerImplementationHash);
});

test('OS sandbox factory and adapter reject invalid budgets and deadlines before execution', () => {
  assert.throws(() => createDeepLearningCpuOracleSandboxRunner({
    ...DEEP_LEARNING_CPU_ORACLE_RESOURCE_LIMITS,
    maximumProcesses: 0,
  }), /resource_budget_invalid/);

  const { selected } = fixture();
  const blocked = runProcessIsolatedDeepLearningIndependentCpuOracle({
    executionReceipt: selected.executionReceipt,
    trainingDataset: selected.trainingDataset,
    tensorBundleBytes: selected.bundle.bytes,
    expectedPredictions: [0, 0, 0, 0],
    expectedMetrics: selected.executionReceipt.finalMetrics,
    absoluteDeadlineEpochMs: 0,
  });
  assert.equal(blocked.status, 'process_isolated_deep_learning_cpu_oracle_blocked');
  assert.equal(blocked.productionPromotionEligible, false);
  assert.ok(blocked.blockers.includes(
    'deep_learning_cpu_oracle_absolute_deadline_invalid',
  ));
  assert.equal(blocked.osSandboxWorkerReceipt, null);
});
