import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  composeCanonicalDeepLearningGpuTraining,
} from '../../paper-composition/automation/deep-learning-gpu-training-composition.mjs';
import {
  composeCanonicalPdePoisson2dGpuSolver,
} from '../../paper-composition/automation/pde-poisson-2d-gpu-composition.mjs';
import {
  verifyCanonicalCupyDeepLearningTrainingReceipt,
} from '../../paper-adapters/research-verify/canonical-cupy-deep-learning-training-executor.mjs';
import {
  currentCodeProvenance,
} from '../../paper-adapters/runtime/code-provenance.mjs';
import {
  readTrustedWallClockEpochMs,
} from '../../paper-adapters/runtime/trusted-wall-clock.mjs';
import {
  verifyProductionOsSandboxWorkerReceipt,
} from '../../paper-domain/automation/os-sandbox-worker-receipt-contract.mjs';
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
import {
  verifyPdePoisson2dGpuArtifactManifest,
} from '../../paper-domain/research/pde-poisson-2d-gpu-capability-contract.mjs';
import {
  verifyProcessIsolatedPdePoisson2dCpuOracleAgainstArtifacts,
} from '../../paper-adapters/research-verify/process-isolated-pde-poisson-2d-independent-cpu-oracle.mjs';
import {
  assertProductionCapabilityRefreshCodeProvenance,
  capabilityVerificationCodeProvenanceHash,
  resolveCurrentCapabilityProductionSubject,
} from '../capability-operational-evidence.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const GPU_UUID = /^GPU-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const REPLAY_WINDOW_MS = 3 * 60 * 60 * 1_000;
const CONFIGURATION_KEYS = Object.freeze([
  'assetRoot', 'codeProvenanceHash', 'paperId', 'productionSubject',
  'releaseCommit', 'workspaceRoot',
]);

function exactConfiguration(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify(CONFIGURATION_KEYS);
}

function selectObservedGpuDevice() {
  const observed = spawnSync('/usr/bin/nvidia-smi', [
    '--query-gpu=uuid', '--format=csv,noheader',
  ], {
    encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin', LC_ALL: 'C', LANG: 'C' },
    timeout: 15_000,
    maxBuffer: 1024 * 1024,
  });
  if (observed.error || observed.status !== 0 || observed.signal) {
    throw new Error('gpu_scientific_replay_nvidia_device_enumeration_failed');
  }
  const devices = [...new Set(String(observed.stdout || '').trim().split(/\r?\n/u)
    .map((value) => value.trim()).filter(Boolean))].sort();
  if (!devices.length || devices.some((value) => !GPU_UUID.test(value))) {
    throw new Error('gpu_scientific_replay_nvidia_device_unavailable');
  }
  const declared = process.env.HEPTA_OPERATIONAL_REPLAY_GPU_DEVICE_UUID || null;
  if (declared !== null && (!GPU_UUID.test(declared) || !devices.includes(declared))) {
    throw new Error('gpu_scientific_replay_declared_device_not_observed');
  }
  if (declared === null && devices.length !== 1) {
    throw new Error('gpu_scientific_replay_device_selection_authority_required');
  }
  const deviceSelector = declared || devices[0];
  return Object.freeze({
    deviceSelector,
    deviceSelectorHash: hashRecord('GpuScientificReplayDeviceSelector', {
      deviceSelector,
    }),
    observedDeviceSetHash: hashRecord('GpuScientificReplayObservedDeviceSet', devices),
    observedDeviceCount: devices.length,
    observationMechanism: 'nvidia-smi-query-gpu-uuid-v1',
  });
}

function prepareOutputRoot(root, capabilityId) {
  const selectedRoot = path.resolve(String(root || ''));
  const parent = fs.lstatSync(selectedRoot);
  if (!parent.isDirectory() || parent.isSymbolicLink()
    || fs.realpathSync.native(selectedRoot) !== selectedRoot
    || (typeof process.geteuid === 'function' && parent.uid !== process.geteuid())
    || (parent.mode & 0o077) !== 0) {
    throw new Error('gpu_scientific_replay_work_root_invalid');
  }
  const outputRoot = path.join(selectedRoot, capabilityId.replace(/[^A-Za-z0-9_.-]/gu, '_'));
  fs.mkdirSync(outputRoot, { mode: 0o700 });
  const identity = fs.lstatSync(outputRoot);
  if (!identity.isDirectory() || identity.isSymbolicLink()
    || fs.realpathSync.native(outputRoot) !== outputRoot
    || (identity.mode & 0o077) !== 0) {
    throw new Error('gpu_scientific_replay_output_root_invalid');
  }
  return Object.freeze({ outputRoot, dev: identity.dev, ino: identity.ino });
}

function removeOwnedOutputRoot(owned) {
  const identity = fs.lstatSync(owned.outputRoot);
  if (!identity.isDirectory() || identity.isSymbolicLink()
    || identity.dev !== owned.dev || identity.ino !== owned.ino) {
    throw new Error('gpu_scientific_replay_output_root_identity_changed');
  }
  fs.rmSync(owned.outputRoot, { recursive: true, force: false });
}

function canonicalModelIr() {
  return buildDeterministicSupervisedClassificationModelIr({
    modelId: 'production-capability-replay-cupy-mlp',
    profileHash:
      DETERMINISTIC_SUPERVISED_CLASSIFICATION_GPU_PROFILE.deepLearningGpuProfileHash,
    inputFeatureCount: 2,
    classCount: 2,
    layers: Object.freeze([
      Object.freeze({
        layerId: 'dense1', type: 'dense', inputUnits: 2, outputUnits: 4,
        activation: 'relu', useBias: true,
      }),
      Object.freeze({
        layerId: 'logits', type: 'dense', inputUnits: 4, outputUnits: 2,
        activation: 'identity', useBias: true,
      }),
    ]),
    training: Object.freeze({
      optimizer: 'adamw-v1',
      loss: 'sparse-cross-entropy-with-logits-v1',
      initialization: 'stateless-sha256-box-muller-v1',
      batchOrder: 'seeded-fisher-yates-v1',
      earlyStoppingEnabled: false,
      epochs: 4,
      batchSize: 2,
      learningRate: 0.01,
      weightDecay: 0,
      beta1: 0.9,
      beta2: 0.999,
      epsilon: 1e-8,
      gradientClipNorm: 10,
    }),
    seed: 1701,
  });
}

function canonicalTrainingDataset() {
  return buildCanonicalParityDeepLearningTrainingDataset({
    datasetId: 'production-capability-replay-xor-v1',
    featureCount: 2,
  });
}

function stableReleaseBinding(configuration, gpuSelection, deadline) {
  const payload = {
    version: 1,
    kind: 'GpuScientificCapabilityReplayReleaseBinding',
    releaseCommit: configuration.releaseCommit,
    codeProvenanceHash: configuration.codeProvenanceHash,
    productionSubject: configuration.productionSubject,
    gpuDeviceSelectorHash: gpuSelection.deviceSelectorHash,
    observedGpuDeviceSetHash: gpuSelection.observedDeviceSetHash,
    absoluteDeadlineEpochMs: deadline,
  };
  return Object.freeze({
    ...payload,
    gpuScientificCapabilityReplayReleaseBindingHash: hashRecord(
      'GpuScientificCapabilityReplayReleaseBinding', payload,
    ),
  });
}

export function createGpuScientificCapabilityReplayRunners(configuration = {}) {
  const deadline = readTrustedWallClockEpochMs() + REPLAY_WINDOW_MS;
  let gpuSelection = null;
  let pdeInvocation = 0;
  let deepLearningInvocation = 0;

  function assertAuthority(phase) {
    if (!exactConfiguration(configuration)) {
      throw new Error('gpu_scientific_replay_configuration_invalid');
    }
    const provenance = assertProductionCapabilityRefreshCodeProvenance({
      codeProvenance: currentCodeProvenance({
        workspaceRoot: configuration.workspaceRoot,
        allowReleaseCommitEnvironment: false,
      }),
      declaredReleaseCommit: configuration.releaseCommit,
    });
    if (capabilityVerificationCodeProvenanceHash(provenance)
      !== configuration.codeProvenanceHash) {
      throw new Error(`gpu_scientific_replay_code_provenance_changed:${phase}`);
    }
    const subject = resolveCurrentCapabilityProductionSubject({
      assetRoot: configuration.assetRoot,
      paperId: configuration.paperId,
    });
    if (JSON.stringify(subject) !== JSON.stringify(configuration.productionSubject)) {
      throw new Error(`gpu_scientific_replay_production_subject_changed:${phase}`);
    }
    if (readTrustedWallClockEpochMs() >= deadline) {
      throw new Error(`gpu_scientific_replay_deadline_exhausted:${phase}`);
    }
    gpuSelection ||= selectObservedGpuDevice();
    return stableReleaseBinding(configuration, gpuSelection, deadline);
  }

  async function replayPde(root) {
    const releaseBinding = assertAuthority('pde-preflight');
    const owned = prepareOutputRoot(root, 'pde-output');
    pdeInvocation += 1;
    try {
      const receipt = await composeCanonicalPdePoisson2dGpuSolver({
        outputRoot: owned.outputRoot,
      }).executeAndVerify({
        runId: `production-capability-replay-pde-${pdeInvocation}`,
        gpuDeviceSelector: gpuSelection.deviceSelector,
        absoluteDeadlineEpochMs: deadline,
      });
      const gpuReceipt = receipt?.gpuReceipt;
      const oracle = receipt?.cpuOracleAssurance;
      const verified = receipt?.status
          === 'canonical_pde_poisson_2d_gpu_scientifically_verified_non_promotable'
        && receipt.productionPromotionEligible === false
        && verifyPdePoisson2dGpuArtifactManifest(gpuReceipt?.artifactManifest, {
          producerSpecification: gpuReceipt?.producerSpecification,
        })
        && verifyProductionOsSandboxWorkerReceipt(
          gpuReceipt?.artifactManifest?.osSandboxWorkerReceipt,
        )
        && verifyProcessIsolatedPdePoisson2dCpuOracleAgainstArtifacts(oracle, {
          artifactRoot: gpuReceipt?.outputDirectory,
          artifactManifest: gpuReceipt?.artifactManifest,
          producerSpecification: gpuReceipt?.producerSpecification,
        });
      if (!verified) {
        throw new Error(`gpu_pde_canonical_replay_invalid:${(receipt?.blockers || []).join(',')}`);
      }
      assertAuthority('pde-postflight');
      return Object.freeze({
        version: 1,
        kind: 'GpuPdeProductionSourceBoundReplayResult',
        status: 'canonical_gpu_pde_replay_completed_non_promotable',
        canonicalVerifierPassed: true,
        productionEligible: false,
        releaseBinding,
        gpuSelection,
        producerSpecificationHash:
          gpuReceipt.producerSpecification.pdePoisson2dGpuProducerSpecificationHash,
        producerImplementationMerkleHash:
          gpuReceipt.artifactManifest.producerImplementationMerkleHash,
        producerImplementationWorkspaceManifestHash:
          gpuReceipt.artifactManifest.producerImplementationWorkspaceManifestHash,
        runtimeImageDigest: gpuReceipt.artifactManifest.runtimeImageDigest,
        runtimePackageClosureHash:
          gpuReceipt.artifactManifest.runtimePackageClosureHash,
        solutionArtifacts: gpuReceipt.artifactManifest.artifacts,
        cpuOracle: Object.freeze({
          status: oracle.status,
          assuranceScope: oracle.assuranceScope,
          observations: oracle.oracleReceipt.observations,
          convergenceOrders: oracle.oracleReceipt.convergenceOrders,
          workerImplementationHash: oracle.workerImplementationHash,
          workerSourceManifestHash: oracle.workerSourceManifestHash,
          independentAlgorithmImplementationHash:
            oracle.independentAlgorithmImplementationHash,
          runtimeImageDigest: oracle.runtimeImageDigest,
          runtimePackageClosureHash: oracle.runtimePackageClosureHash,
          scientificAuthority: oracle.scientificAuthority,
        }),
        externalActionPerformed: false,
      });
    } finally {
      removeOwnedOutputRoot(owned);
    }
  }

  async function replayDeepLearning(root) {
    const releaseBinding = assertAuthority('deep-learning-preflight');
    const owned = prepareOutputRoot(root, 'deep-learning-output');
    deepLearningInvocation += 1;
    try {
      const modelIr = canonicalModelIr();
      const trainingDataset = canonicalTrainingDataset();
      const trainingDatasetAuthority =
        buildCanonicalSyntheticDeepLearningDatasetAuthority({
          trainingDataset,
          generatorSpec: {
            datasetId: trainingDataset.datasetId,
            featureCount: trainingDataset.featureCount,
          },
        });
      const composition = composeCanonicalDeepLearningGpuTraining({
        outputRoot: owned.outputRoot,
      });
      const receipt = await composition.trainingExecutor.execute({
        trainingRunId:
          `production-capability-replay-deep-learning-${deepLearningInvocation}`,
        profile: DETERMINISTIC_SUPERVISED_CLASSIFICATION_GPU_PROFILE,
        modelIr,
        trainingDataset,
        trainingDatasetAuthority,
        gpuDeviceSelector: gpuSelection.deviceSelector,
        absoluteDeadlineEpochMs: deadline,
      });
      if (!verifyCanonicalCupyDeepLearningTrainingReceipt(receipt)
        || !verifyProductionOsSandboxWorkerReceipt(receipt?.workerReceipt)
        || receipt.productionPromotionEligible !== false) {
        throw new Error(`gpu_deep_learning_canonical_replay_invalid:${(receipt?.blockers || []).join(',')}`);
      }
      assertAuthority('deep-learning-postflight');
      const execution = receipt.trainingExecutionReceipt;
      return Object.freeze({
        version: 1,
        kind: 'GpuDeepLearningProductionSourceBoundReplayResult',
        status: 'canonical_gpu_deep_learning_replay_completed_non_promotable',
        canonicalVerifierPassed: true,
        productionEligible: false,
        releaseBinding,
        gpuSelection,
        profileHash: receipt.profileHash,
        modelIrHash: receipt.modelIrHash,
        trainingDatasetManifestHash: receipt.trainingDatasetManifestHash,
        trainingDatasetAuthorityHash: receipt.trainingDatasetAuthorityHash,
        trainerImplementationMerkleHash: receipt.trainerImplementationMerkleHash,
        trainerImplementationWorkspaceManifestHash:
          receipt.trainerImplementationWorkspaceManifestHash,
        runtimeBom: execution.runtimeBom,
        finalMetrics: execution.finalMetrics,
        checkpointArtifactHash: execution.checkpointManifest.checkpointArtifactHash,
        tensorSetHash: execution.checkpointManifest.tensorSetHash,
        tensors: execution.checkpointManifest.tensors,
        finiteTensorScanReceiptHash: receipt.finiteTensorScanReceiptHash,
        modelSpecificationArtifactHash: receipt.modelSpecificationArtifactHash,
        determinismScope: execution.determinismScope,
        promotionBlockers: receipt.blockers,
        externalActionPerformed: false,
      });
    } finally {
      removeOwnedOutputRoot(owned);
    }
  }

  return Object.freeze({
    'research.gpu-pde-solver': replayPde,
    'research.gpu-deep-learning-training': replayDeepLearning,
  });
}
