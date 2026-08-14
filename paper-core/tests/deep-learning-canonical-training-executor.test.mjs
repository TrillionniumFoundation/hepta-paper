import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import {
  importCanonicalCupyDeepLearningTrainingExecutorForTest,
  withCanonicalCupyDeepLearningSandboxRunnerForTest,
} from './support/canonical-cupy-deep-learning-sandbox-test-seam.mjs';
import {
  AUTOMATION_RUNTIME_IMAGES,
} from '../../paper-adapters/automation/runtime-image-registry.mjs';
import {
  createOsSandboxedWorkerRunnerForTest as createOsSandboxedWorkerRunner,
} from './support/os-sandboxed-worker-runner-test-driver.mjs';
import {
  verifyOsSandboxWorkerReceipt,
  verifyProductionOsSandboxWorkerReceipt,
} from '../../paper-domain/automation/os-sandbox-worker-receipt-contract.mjs';
import {
  verifyCanonicalCupyDeepLearningTrainingReceipt as
    verifyProductionCanonicalCupyDeepLearningTrainingReceipt,
} from '../../paper-adapters/research-verify/canonical-cupy-deep-learning-training-executor.mjs';
import {
  composeCanonicalDeepLearningGpuTraining,
} from '../../paper-composition/automation/campaign-worker-empirical-composition.mjs';
import {
  buildDeepLearningInlineTrainingDataset,
  verifyDeepLearningInlineTrainingDataset,
} from '../../paper-domain/research/deep-learning-training-dataset-contract.mjs';
import {
  buildCanonicalParityDeepLearningTrainingDataset,
  buildCanonicalSyntheticDeepLearningDatasetAuthority,
  buildExternalDeepLearningDatasetProvenanceDeclaration,
  verifyCanonicalSyntheticDeepLearningDatasetAuthority,
  verifyDeepLearningTrainingDatasetAuthority,
} from '../../paper-domain/research/deep-learning-training-dataset-authority-contract.mjs';
import {
  DETERMINISTIC_SUPERVISED_CLASSIFICATION_GPU_PROFILE,
} from '../../paper-domain/research/deep-learning-gpu-profile-contract.mjs';
import {
  buildDeterministicSupervisedClassificationModelIr,
} from '../../paper-domain/research/deep-learning-model-ir-contract.mjs';
import {
  assertDeepLearningGpuTrainingExecutorPort,
  assertDeepLearningHiddenEvaluatorAuthorityPort,
  assertDeepLearningPredictorAuthorityPort,
} from '../../paper-ports/deep-learning-gpu-training-ports.mjs';

const {
  CANONICAL_CUPY_DEEP_LEARNING_OUTPUT_PATHS,
  CANONICAL_CUPY_DEEP_LEARNING_TRAINER_PATH,
  CANONICAL_CUPY_DEEP_LEARNING_TRAINER_ROOT,
  createCanonicalCupyDeepLearningTrainingExecutor,
  verifyCanonicalCupyDeepLearningTrainingReceipt,
} = await importCanonicalCupyDeepLearningTrainingExecutorForTest();
const TEST_GPU_UUID = 'GPU-a33875b7-7eb7-679e-df08-19227d3decee';
import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';

function modelIr() {
  return buildDeterministicSupervisedClassificationModelIr({
    modelId: 'canonical-cupy-test-model',
    profileHash:
      DETERMINISTIC_SUPERVISED_CLASSIFICATION_GPU_PROFILE.deepLearningGpuProfileHash,
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
      epochs: 2,
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

function trainingDataset() {
  return buildCanonicalParityDeepLearningTrainingDataset({
    datasetId: 'canonical-cupy-test-dataset',
    featureCount: 2,
  });
}

function trainingDatasetAuthority(dataset = trainingDataset()) {
  return buildCanonicalSyntheticDeepLearningDatasetAuthority({
    trainingDataset: dataset,
    generatorSpec: {
      datasetId: dataset.datasetId,
      featureCount: dataset.featureCount,
    },
  });
}

function tensorsFor(model) {
  let value = 0.03125;
  const chunks = [];
  const tensors = model.layers.flatMap((layer) => [
    { name: `${layer.layerId}.weight`, shape: [layer.outputUnits, layer.inputUnits] },
    { name: `${layer.layerId}.bias`, shape: [layer.outputUnits] },
  ]).sort((left, right) => (
    left.name < right.name ? -1 : Number(left.name > right.name)
  )).map((tensor) => {
    const count = tensor.shape.reduce((product, item) => product * item, 1);
    const bytes = Buffer.alloc(count * 4);
    for (let index = 0; index < count; index += 1) {
      bytes.writeFloatLE(value, index * 4);
      value += 0.03125;
    }
    chunks.push(bytes);
    return {
      name: tensor.name,
      dtype: 'float32',
      shape: tensor.shape,
      byteLength: bytes.length,
      sha256: hashBytes(bytes),
    };
  });
  return { tensors, bundle: Buffer.concat(chunks) };
}

function writeFixtureOutputs({ outputDirectory, request, gpuDeviceSelector }) {
  const { modelIr: model, trainingDataset: dataset, profile, trainingRunId } = request;
  const { tensors, bundle } = tensorsFor(model);
  const finalMetrics = {
    accuracy: 1,
    crossEntropy: 0.2,
    initialCrossEntropy: 0.7,
    gradientNorm: 0.05,
  };
  const modelSpecification = {
    version: 1,
    kind: 'DeepLearningModelSpecification',
    profile,
    modelIr: model,
  };
  const trace = {
    version: 1,
    kind: 'DeepLearningTrainingMetricTrace',
    trainingRunId,
    modelIrHash: model.deepLearningModelIrHash,
    trainingDatasetManifestHash: dataset.deepLearningTrainingDatasetManifestHash,
    records: [
      { epoch: 1, accuracy: 0.75, crossEntropy: 0.4, gradientNorm: 0.2 },
      { epoch: 2, accuracy: 1, crossEntropy: 0.2, gradientNorm: 0.05 },
    ],
  };
  const summary = {
    version: 1,
    kind: 'CanonicalCupyMlpTrainingSummary',
    trainingRunId,
    profileHash: model.profileHash,
    modelIrHash: model.deepLearningModelIrHash,
    trainingDatasetManifestHash: dataset.deepLearningTrainingDatasetManifestHash,
    seed: model.seed,
    completedEpoch: model.training.epochs,
    trainingStepCount: 4,
    tensorBundleArtifactBytes: bundle.length,
    tensors,
    finalMetrics,
    trainingPredictionCount: dataset.sampleCount,
    runtime: {
      framework: 'cupy',
      frameworkVersion: '13.3.0',
      cudaDriverVersion: '580.173.02',
      cudaRuntimeVersion: '12.6',
      gpuComputeCapability: '8.9',
      gpuDeviceSelector,
      gpuModel: 'Fixture NVIDIA GPU',
      trainingComputeDevice: 'cuda:0-single-visible-device-v1',
    },
    networkActionPerformed: false,
    externalActionPerformed: false,
    hiddenEvaluationPerformed: false,
    gpuMemoryCapacityPlanHash: request.gpuMemoryCapacityPlan.gpuMemoryCapacityPlanHash,
  };
  const predictions = {
    version: 1,
    kind: 'DeepLearningTrainingPredictions',
    trainingRunId,
    modelIrHash: model.deepLearningModelIrHash,
    trainingDatasetManifestHash: dataset.deepLearningTrainingDatasetManifestHash,
    scope: 'training-dataset-only-not-hidden-evaluation-v1',
    predictedClass: [0, 1, 1, 0],
  };
  const documents = {
    'model-spec.json': modelSpecification,
    'training-predictions.json': predictions,
    'training-summary.json': summary,
    'training-trace.json': trace,
  };
  for (const [name, value] of Object.entries(documents)) {
    fs.writeFileSync(path.join(outputDirectory, name), `${JSON.stringify(value)}\n`, {
      flag: 'wx', mode: 0o600,
    });
  }
  fs.writeFileSync(path.join(outputDirectory, 'tensor-bundle.bin'), bundle, {
    flag: 'wx', mode: 0o600,
  });
}

function gpuSelector() {
  const result = spawnSync('/usr/bin/nvidia-smi', [
    '--query-gpu=uuid', '--format=csv,noheader',
  ], { encoding: 'utf8', timeout: 5000 });
  const selected = String(result.stdout || '').trim().split(/\r?\n/)[0];
  return result.status === 0 ? selected : null;
}

function rehashWorkerAndCanonicalReceiptsAfterLimitMutation(receipt) {
  const worker = receipt.workerReceipt;
  const resourceLimitPayload = { ...worker.environmentBom.limits };
  delete resourceLimitPayload.resourceLimitsHash;
  worker.environmentBom.limits.resourceLimitsHash = hashRecord(
    'EmpiricalEnvironmentResourceLimits', resourceLimitPayload,
  );
  const environmentBomPayload = { ...worker.environmentBom };
  delete environmentBomPayload.environmentBomHash;
  worker.environmentBom.environmentBomHash = hashRecord(
    'EmpiricalEnvironmentBOM', environmentBomPayload,
  );
  worker.environmentBomHash = worker.environmentBom.environmentBomHash;
  const workerPayload = { ...worker };
  delete workerPayload.ok;
  delete workerPayload.receiptHash;
  delete workerPayload.blockers;
  worker.receiptHash = hashRecord('OsSandboxWorkerReceipt', workerPayload);
  receipt.workerReceiptHash = worker.receiptHash;
  receipt.environmentBomHash = worker.environmentBomHash;
  const canonicalPayload = { ...receipt };
  delete canonicalPayload.canonicalCupyDeepLearningTrainingReceiptHash;
  receipt.canonicalCupyDeepLearningTrainingReceiptHash = hashRecord(
    'CanonicalCupyDeepLearningTrainingReceipt', canonicalPayload,
  );
}

function fixtureWorkerRunner(outputRoot, selectedGpu) {
  return createOsSandboxedWorkerRunner({
    allowedExecutables: [AUTOMATION_RUNTIME_IMAGES.pythonGpu.executable],
    allowedRoots: [CANONICAL_CUPY_DEEP_LEARNING_TRAINER_ROOT],
    allowedOutputRoots: [outputRoot],
    allowedContainerImages: [AUTOMATION_RUNTIME_IMAGES.pythonGpu.image],
    dockerImage: AUTOMATION_RUNTIME_IMAGES.pythonGpu.image,
    allowGpu: true,
    maximumTimeoutMs: 60_000,
    maximumMemoryBytes: 128 * 1024 * 1024,
    maximumCpuSeconds: 60,
    maximumPids: 16,
    maximumOutputBytes: 16 * 1024 * 1024,
    maximumInputBytes: 4 * 1024 * 1024,
    probe: {
      available: true,
      backend: 'docker',
      status: 'os_sandbox_available',
      image: AUTOMATION_RUNTIME_IMAGES.pythonGpu.image,
    },
    imageDigestResolver: (image) => image === AUTOMATION_RUNTIME_IMAGES.pythonGpu.image
      ? AUTOMATION_RUNTIME_IMAGES.pythonGpu.imageDigest : null,
    executor(_launcher, args, options) {
      const outputVolume = args.find((value) => String(value).endsWith(':/output:rw'));
      const outputDirectory = String(outputVolume || '').slice(0, -':/output:rw'.length);
      const request = JSON.parse(Buffer.from(options.input).toString('utf8'));
      const visibleDevice = String(args.find((value) => (
        String(value).startsWith('NVIDIA_VISIBLE_DEVICES=')
      )) || '').slice('NVIDIA_VISIBLE_DEVICES='.length);
      assert.equal(visibleDevice, selectedGpu);
      writeFixtureOutputs({ outputDirectory, request, gpuDeviceSelector: visibleDevice });
      return { status: 0, stdout: '', stderr: '' };
    },
  });
}

test('training dataset and authority ports are exact and separately scoped', () => {
  assert.equal(typeof composeCanonicalDeepLearningGpuTraining, 'function');
  assert.throws(
    () => composeCanonicalDeepLearningGpuTraining(),
    /output_root_absolute_required/,
  );
  const dataset = trainingDataset();
  assert.equal(verifyDeepLearningInlineTrainingDataset(dataset), true);
  const authority = trainingDatasetAuthority(dataset);
  assert.equal(verifyCanonicalSyntheticDeepLearningDatasetAuthority(
    authority,
    { trainingDataset: dataset },
  ), true);
  assert.equal(authority.datasetProductionUseAuthorized, true);
  assert.equal(authority.productionPromotionEligible, false);
  assert.throws(() => buildDeepLearningInlineTrainingDataset({
    datasetId: 'nan-dataset', classCount: 2, features: [[0], [Number.NaN]], labels: [0, 1],
  }), /feature_invalid/);
  assert.throws(() => assertDeepLearningPredictorAuthorityPort({
    version: 1,
    kind: 'DeepLearningHiddenEvaluatorAuthorityPort',
    authorityScope: 'sealed-hidden-holdout-evaluation-only-v1',
    evaluateHiddenHoldout() {},
  }), /PredictorAuthorityPort/);
  const predictor = assertDeepLearningPredictorAuthorityPort({
    version: 1,
    kind: 'DeepLearningPredictorAuthorityPort',
    authorityScope: 'checkpoint-bound-prediction-only-v1',
    predict() {},
  });
  const evaluator = assertDeepLearningHiddenEvaluatorAuthorityPort({
    version: 1,
    kind: 'DeepLearningHiddenEvaluatorAuthorityPort',
    authorityScope: 'sealed-hidden-holdout-evaluation-only-v1',
    evaluateHiddenHoldout() {},
  });
  assert.notEqual(predictor.authorityScope, evaluator.authorityScope);
});

test('dataset provenance binds generation, rights, consent, and split lineage without self-authorization', () => {
  const arbitrary = buildDeepLearningInlineTrainingDataset({
    datasetId: 'external-training-subset', classCount: 2,
    features: [[0, 0], [0, 1], [1, 0], [1, 1]], labels: [0, 0, 1, 1],
  });
  assert.throws(() => buildCanonicalSyntheticDeepLearningDatasetAuthority({
    trainingDataset: arbitrary,
    generatorSpec: { datasetId: arbitrary.datasetId, featureCount: 2 },
  }), /synthetic_dataset_authority_invalid/);
  const H = (label) => hashRecord('DeepLearningDatasetAuthorityTest', { label });
  const external = buildExternalDeepLearningDatasetProvenanceDeclaration({
    trainingDataset: arbitrary,
    source: {
      sourceLocatorHash: H('source-locator'),
      acquisitionReceiptHash: H('acquisition'),
      publisherId: 'external-publisher',
      datasetVersion: 'dataset-v1',
    },
    license: {
      spdxLicenseId: 'CC-BY-4.0',
      licenseTermsDocumentHash: H('license-terms'),
      modelTrainingAllowed: true,
      redistributionAllowed: false,
    },
    consent: {
      humanSubjectsPresent: true,
      personalDataPresent: true,
      consentRequired: true,
      consentAuthorityDocumentHash: H('consent-authority'),
    },
    splitLineage: {
      parentDatasetManifestHash: H('parent-manifest'),
      splitAlgorithmId: 'publisher-stratified-split-v1',
      splitSeedHash: H('split-seed'),
      trainingIndexManifestHash: H('training-index'),
      validationIndexManifestHash: H('validation-index'),
      hiddenTestIndexManifestHash: H('hidden-index'),
      leakageReviewDocumentHash: H('leakage-review'),
    },
    externalAuthority: {
      authorityDocumentHash: H('authority-document'),
      signatureVerificationReceiptHash: H('signature-verification'),
    },
  });
  assert.equal(verifyDeepLearningTrainingDatasetAuthority(
    external,
    { trainingDataset: arbitrary },
  ), true);
  assert.equal(external.datasetProductionUseAuthorized, false);
  assert.equal(external.productionPromotionEligible, false);
  assert.equal(external.externalAuthority.cryptographicVerificationPerformedHere, false);
  assert.equal(verifyCanonicalSyntheticDeepLearningDatasetAuthority(
    external,
    { trainingDataset: arbitrary },
  ), false);
  const forged = structuredClone(external);
  forged.datasetProductionUseAuthorized = true;
  forged.productionPromotionEligible = true;
  const payload = { ...forged };
  delete payload.deepLearningTrainingDatasetAuthorityHash;
  forged.deepLearningTrainingDatasetAuthorityHash = hashRecord(
    'DeepLearningTrainingDatasetAuthorityBinding', payload,
  );
  assert.equal(verifyDeepLearningTrainingDatasetAuthority(
    forged,
    { trainingDataset: arbitrary },
  ), false);
  assert.throws(() => buildExternalDeepLearningDatasetProvenanceDeclaration({
    trainingDataset: arbitrary,
    source: {
      sourceLocatorHash: external.source.sourceLocatorHash,
      acquisitionReceiptHash: external.source.acquisitionReceiptHash,
      publisherId: external.source.publisherId,
      datasetVersion: external.source.datasetVersion,
    },
    license: {
      spdxLicenseId: external.license.spdxLicenseId,
      licenseTermsDocumentHash: external.license.licenseTermsDocumentHash,
      modelTrainingAllowed: external.license.modelTrainingAllowed,
      redistributionAllowed: external.license.redistributionAllowed,
    },
    consent: {
      humanSubjectsPresent: true, personalDataPresent: true,
      consentRequired: true, consentAuthorityDocumentHash: null,
    },
    splitLineage: {
      parentDatasetManifestHash: external.splitLineage.parentDatasetManifestHash,
      splitAlgorithmId: external.splitLineage.splitAlgorithmId,
      splitSeedHash: external.splitLineage.splitSeedHash,
      trainingIndexManifestHash: external.splitLineage.trainingIndexManifestHash,
      validationIndexManifestHash: external.splitLineage.validationIndexManifestHash,
      hiddenTestIndexManifestHash: external.splitLineage.hiddenTestIndexManifestHash,
      leakageReviewDocumentHash: external.splitLineage.leakageReviewDocumentHash,
    },
    externalAuthority: {
      authorityDocumentHash: external.externalAuthority.authorityDocumentHash,
      signatureVerificationReceiptHash:
        external.externalAuthority.signatureVerificationReceiptHash,
    },
  }), /consent_invalid/);
});

test('canonical trainer source has no user-code, pickle, or custom CUDA execution surface', () => {
  const source = fs.readFileSync(CANONICAL_CUPY_DEEP_LEARNING_TRAINER_PATH, 'utf8');
  assert.match(source, /import cupy as cp/);
  assert.match(source, /os\.O_EXCL/);
  assert.match(source, /gpuDeviceSelector/);
  assert.match(source, /--query-gpu=uuid,driver_version/);
  assert.doesNotMatch(source, /\b(?:eval|exec)\s*\(/);
  assert.doesNotMatch(source, /\bimport\s+(?:pickle|cloudpickle|dill|ctypes)\b/);
  assert.doesNotMatch(source, /\b(?:pickle|cloudpickle|dill)\.(?:load|loads)\s*\(/);
  assert.doesNotMatch(source, /\b(?:RawKernel|RawModule)\s*\(/);
  assert.deepEqual(CANONICAL_CUPY_DEEP_LEARNING_OUTPUT_PATHS, [
    'model-spec.json', 'tensor-bundle.bin', 'training-predictions.json',
    'training-summary.json', 'training-trace.json',
  ]);
});

test('canonical executor binds fixed image, one GPU, safe artifacts, and remains non-promotable', async (t) => {
  const selectedGpu = gpuSelector();
  if (!selectedGpu || !fs.existsSync('/dev/nvidia0')) {
    t.skip('NVIDIA GPU UUID unavailable');
    return;
  }
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-dl-executor-'));
  t.after(() => fs.rmSync(outputRoot, { recursive: true, force: true }));
  const runner = fixtureWorkerRunner(outputRoot, selectedGpu);
  const absoluteDeadlineEpochMs = Date.now() + 60_000;
  const executor = await withCanonicalCupyDeepLearningSandboxRunnerForTest(
    runner,
    async () => {
      const scopedExecutor = createCanonicalCupyDeepLearningTrainingExecutor({
      outputRoot,
      timeoutMs: 60_000,
      memoryBytes: 128 * 1024 * 1024,
      cpuSeconds: 60,
      maximumProcesses: 16,
      maximumOutputBytes: 16 * 1024 * 1024,
      });
      const firstReceipt = await scopedExecutor.execute({
        trainingRunId: 'canonical-cupy-training-fixture',
        profile: DETERMINISTIC_SUPERVISED_CLASSIFICATION_GPU_PROFILE,
        modelIr: modelIr(),
        trainingDataset: trainingDataset(),
        trainingDatasetAuthority: trainingDatasetAuthority(),
        gpuDeviceSelector: selectedGpu,
        absoluteDeadlineEpochMs,
      });
      return { scopedExecutor, firstReceipt };
    },
  );
  const { scopedExecutor, firstReceipt: receipt } = executor;
  assert.equal(assertDeepLearningGpuTrainingExecutorPort(scopedExecutor), scopedExecutor);
  assert.equal(
    receipt.status,
    'canonical_cupy_deep_learning_training_recorded_non_promotable',
    JSON.stringify({
      blockers: receipt.blockers,
      worker: receipt.workerReceipt && {
        blockers: receipt.workerReceipt.blockers,
        datasetMounts: receipt.workerReceipt.datasetMounts,
        datasetAccessReceipt: receipt.workerReceipt.datasetAccessReceipt,
        sourceMerkleHashBefore: receipt.workerReceipt.sourceMerkleHashBefore,
        expectedSourceMerkleHash: receipt.workerReceipt.expectedSourceMerkleHash,
        sourceWorkspaceManifestHashBefore:
          receipt.workerReceipt.sourceWorkspaceManifestHashBefore,
        expectedSourceWorkspaceManifestHash:
          receipt.workerReceipt.expectedSourceWorkspaceManifestHash,
      },
    }),
  );
  assert.equal(receipt.productionPromotionEligible, false);
  assert.equal(receipt.absoluteDeadlineEpochMs, absoluteDeadlineEpochMs);
  assert.equal(receipt.predictorAuthorityBound, false);
  assert.equal(receipt.hiddenEvaluatorAuthorityBound, false);
  assert.deepEqual(receipt.blockers, [
    'deep_learning_trainer_release_manifest_authority_unavailable',
    'deep_learning_gpu_runtime_qualification_authority_unavailable',
    'deep_learning_independent_finite_tensor_authority_unavailable',
    'deep_learning_predictor_authority_unavailable',
    'deep_learning_hidden_evaluator_authority_unavailable',
    'deep_learning_independent_same_device_replay_authority_unavailable',
  ]);
  assert.equal(receipt.workerReceipt.containerImageDigest,
    AUTOMATION_RUNTIME_IMAGES.pythonGpu.imageDigest);
  assert.equal(receipt.workerReceipt.gpuDeviceRequest.deviceSelector, selectedGpu);
  assert.equal(receipt.workerReceipt.gpuDeviceRequest.version, 3);
  assert.equal(receipt.workerReceipt.gpuDeviceRequest
    .dispatchMemoryAdmissionEvaluation.admissionSatisfied, true);
  assert.equal(receipt.workerReceipt.version, 5);
  assert.deepEqual(receipt.workerReceipt.executionProcessInvocation.arguments, [
    '/work/canonical_cupy_mlp_trainer.py', '--output', '/output',
  ]);
  assert.equal(receipt.workerReceipt.executionProcessInvocation.workingDirectory, '/work');
  assert.equal(receipt.workerReceipt.executionProcessInvocation.standardInput.sha256,
    receipt.trainingRequestStandardInputHash);
  assert.equal(receipt.workerReceipt.executionProcessInvocation.standardInput.byteLength,
    receipt.trainingRequestStandardInputByteLength);
  assert.equal(receipt.workerReceipt.evidenceClass, 'verification-fixture-v1');
  assert.deepEqual(receipt.workerResourceLimits, {
    timeoutMs: receipt.workerReceipt.limits.timeoutMs,
    memoryBytes: 128 * 1024 * 1024,
    cpuSeconds: 60,
    maximumProcesses: 16,
    maximumOutputBytes: 16 * 1024 * 1024,
  });
  assert.ok(receipt.workerResourceLimits.timeoutMs > 0
    && receipt.workerResourceLimits.timeoutMs <= 60_000);
  assert.equal(verifyProductionOsSandboxWorkerReceipt(receipt.workerReceipt), false);
  assert.equal(receipt.trainingExecutionReceipt.modelIr.seed, 17);
  assert.equal(receipt.trainingExecutionReceipt.checkpointManifest.pickleAllowed, false);
  assert.equal(receipt.trainingExecutionReceipt.checkpointManifest.executablePayloadAllowed, false);
  assert.equal(receipt.finiteTensorScanReceipt.status,
    'deep_learning_checkpoint_tensors_all_finite');
  assert.equal(verifyCanonicalCupyDeepLearningTrainingReceipt(receipt), true);
  assert.equal(verifyProductionCanonicalCupyDeepLearningTrainingReceipt(receipt), false);

  const forged = structuredClone(receipt);
  forged.productionPromotionEligible = true;
  assert.equal(verifyCanonicalCupyDeepLearningTrainingReceipt(forged), false);
  const forgedInvocation = structuredClone(receipt);
  forgedInvocation.workerReceipt.executionProcessInvocation.arguments[0] =
    '/work/substitute_trainer.py';
  forgedInvocation.workerReceipt.executionProcessInvocationHash = hashRecord(
    'OsSandboxWorkerProcessInvocationBinding',
    forgedInvocation.workerReceipt.executionProcessInvocation,
  );
  const workerPayload = { ...forgedInvocation.workerReceipt };
  delete workerPayload.ok;
  delete workerPayload.receiptHash;
  delete workerPayload.blockers;
  forgedInvocation.workerReceipt.receiptHash = hashRecord(
    'OsSandboxWorkerReceipt', workerPayload,
  );
  forgedInvocation.workerReceiptHash = forgedInvocation.workerReceipt.receiptHash;
  const canonicalPayload = { ...forgedInvocation };
  delete canonicalPayload.canonicalCupyDeepLearningTrainingReceiptHash;
  forgedInvocation.canonicalCupyDeepLearningTrainingReceiptHash = hashRecord(
    'CanonicalCupyDeepLearningTrainingReceipt', canonicalPayload,
  );
  assert.equal(verifyCanonicalCupyDeepLearningTrainingReceipt(forgedInvocation), false);
  for (const nestedLimit of [
    'timeoutMs', 'memoryBytes', 'cpuSeconds', 'maximumPids', 'maximumOutputBytes',
  ]) {
    const forgedLimits = structuredClone(receipt);
    forgedLimits.workerReceipt.limits[nestedLimit] += 1;
    forgedLimits.workerReceipt.environmentBom.limits[nestedLimit] += 1;
    rehashWorkerAndCanonicalReceiptsAfterLimitMutation(forgedLimits);
    assert.equal(verifyOsSandboxWorkerReceipt(forgedLimits.workerReceipt), true);
    assert.equal(verifyCanonicalCupyDeepLearningTrainingReceipt(forgedLimits), false);
  }
  const rerun = await scopedExecutor.execute({
      trainingRunId: 'canonical-cupy-training-fixture',
      profile: DETERMINISTIC_SUPERVISED_CLASSIFICATION_GPU_PROFILE,
      modelIr: modelIr(),
      trainingDataset: trainingDataset(),
      trainingDatasetAuthority: trainingDatasetAuthority(),
      gpuDeviceSelector: selectedGpu,
      absoluteDeadlineEpochMs: Date.now() + 60_000,
    });
  assert.equal(rerun.status, 'canonical_cupy_deep_learning_training_blocked');
  assert.deepEqual(rerun.blockers, ['deep_learning_gpu_training_output_preexists']);
});

test('canonical executor rejects extra model code and broad GPU selection before dispatch', async () => {
  const profile = DETERMINISTIC_SUPERVISED_CLASSIFICATION_GPU_PROFILE;
  const model = structuredClone(modelIr());
  model.userCode = 'custom.py';
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-dl-reject-'));
  try {
    assert.throws(
      () => createCanonicalCupyDeepLearningTrainingExecutor({ outputRoot: '/' }),
      /output_root_invalid/,
    );
    assert.throws(() => createCanonicalCupyDeepLearningTrainingExecutor({
      workerRunner: {}, outputRoot: root,
    }), /executor_options_invalid/);
    const executor = withCanonicalCupyDeepLearningSandboxRunnerForTest(
      fixtureWorkerRunner(root, TEST_GPU_UUID),
      () => createCanonicalCupyDeepLearningTrainingExecutor({ outputRoot: root }),
    );
    const rejectedModel = await executor.execute({
      trainingRunId: 'reject-model', profile, modelIr: model,
      trainingDataset: trainingDataset(),
      trainingDatasetAuthority: trainingDatasetAuthority(), gpuDeviceSelector: 'all',
    });
    assert.deepEqual(rejectedModel.blockers, ['deep_learning_gpu_training_input_invalid']);
    const expired = await executor.execute({
      trainingRunId: 'reject-expired-deadline', profile,
      modelIr: modelIr(), trainingDataset: trainingDataset(),
      trainingDatasetAuthority: trainingDatasetAuthority(),
      gpuDeviceSelector: TEST_GPU_UUID, absoluteDeadlineEpochMs: 1,
    });
    assert.deepEqual(expired.blockers, ['deep_learning_gpu_training_input_invalid']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
