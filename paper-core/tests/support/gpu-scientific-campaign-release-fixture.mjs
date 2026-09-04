import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { signAuthorityDocument } from '../../../paper-adapters/authority/authority-signatures.mjs';
import { createFilesystemArtifactRepository } from '../../../paper-adapters/artifacts/filesystem-artifact-repository.mjs';
import {
  AUTOMATION_RUNTIME_IMAGES,
} from '../../../paper-adapters/automation/runtime-image-registry.mjs';
import {
  createCampaignReleasePackager,
} from '../../../paper-adapters/automation/campaign-release-packager.mjs';
import {
  createGpuScientificCampaignPromotionAuthorityVerifier,
  verifyGpuScientificCampaignQualificationEvidenceAuthority,
} from '../../../paper-adapters/automation/gpu-scientific-campaign-promotion-authority-verifier.mjs';
import {
  inspectGpuScientificArtifactBodyArchiveSourceSync,
} from '../../../paper-adapters/build-package/gpu-scientific-artifact-body-archive.mjs';
import { runPackageAdapter } from '../../../paper-adapters/build-package/index.mjs';
import {
  safeRetentionNodeKey,
} from '../../../paper-adapters/automation/runtime-retention-scope-repository.mjs';
import {
  buildCampaignResearchGpuScientificEvidence,
} from '../../../paper-domain/automation/campaign-research-gpu-scientific-evidence-contract.mjs';
import {
  buildCampaignResearchSourceSnapshot,
} from '../../../paper-domain/automation/campaign-research-contract.mjs';
import {
  verifyGpuScientificArtifactBodyArchiveManifest,
} from '../../../paper-domain/automation/gpu-scientific-artifact-body-archive-contract.mjs';
import {
  GPU_SCIENTIFIC_CAMPAIGN_RESOURCE_BUDGET,
  buildCanonicalGpuScientificCampaignExecutionPlan,
  buildGpuScientificCampaignAttemptAuthority,
  buildGpuScientificCampaignExecutionResult,
  verifyGpuScientificCampaignExecutionResult,
} from '../../../paper-domain/automation/gpu-scientific-campaign-execution-contract.mjs';
import {
  GPU_SCIENTIFIC_PRODUCTION_QUALIFICATION_AUTHORITY_ROLE,
  GPU_SCIENTIFIC_SAME_DEVICE_REPLAY_AUTHORITY_ROLE,
  buildGpuScientificCampaignProductionQualificationAuthority,
  buildGpuScientificCampaignQualificationEvidence,
  buildGpuScientificCampaignQualificationRequest,
  buildGpuScientificCampaignSameDeviceReplayReceipt,
  verifyGpuScientificCampaignQualificationEvidence,
  verifyGpuScientificCampaignQualificationRequest,
} from '../../../paper-domain/automation/gpu-scientific-campaign-promotion-contract.mjs';
import {
  buildNvidiaGpuDeviceCapacityObservation,
} from '../../../paper-domain/automation/nvidia-gpu-device-capacity-contract.mjs';
import {
  buildCampaignReleaseExecutionAttestationUnsignedPayload,
  campaignReleaseExecutionAttestationSigningPayloadHash,
  finalizeCampaignReleaseExecutionAttestation,
  verifyCampaignReleaseExecutionAttestationStructure,
} from '../../../paper-domain/automation/campaign-release-execution-attestation-contract.mjs';
import { hashPaperRecord } from '../../../paper-domain/contracts/primitives.mjs';
import { buildExperimentRegistry } from '../../../paper-domain/research/experiment-registry.mjs';
import {
  inspectWorkspaceExecutionSnapshot,
  sourceTreeExcludedNames,
} from '../../../paper-adapters/runtime/execution-snapshot.mjs';
import { hashBytes, hashRecord } from '../../../workflow-kernel/record-hash.mjs';
import {
  importCanonicalCupyDeepLearningTrainingExecutorForTest,
  withCanonicalCupyDeepLearningSandboxRunnerForTest,
} from './canonical-cupy-deep-learning-sandbox-test-seam.mjs';
import {
  importCanonicalCupyPdePoisson2dExecutorForTest,
  withCanonicalCupyPdePoisson2dSandboxRunnerForTest,
} from './canonical-cupy-pde-poisson-2d-sandbox-test-seam.mjs';
import {
  createOsSandboxedWorkerRunnerForTest,
  withGpuSelectorExecutionLeaseForTest,
} from './os-sandboxed-worker-runner-test-driver.mjs';
import {
  importProcessIsolatedPdePoisson2dIndependentCpuOracleForTest,
  withPdePoisson2dCpuOracleSandboxRunnerForTest,
} from './process-isolated-pde-poisson-2d-independent-cpu-oracle-test-seam.mjs';
import {
  createPdePoisson2dCpuOracleFixtureRunner,
} from './pde-poisson-2d-cpu-oracle-fixture-runner.mjs';
import {
  buildDeterministicPdfFixture,
  createTrustedIndependentPdfRebuildVerifierFixture,
} from '../fixtures/trusted-independent-pdf-rebuild-verifier.mjs';

const canonicalPdeExecutorModule =
  await importCanonicalCupyPdePoisson2dExecutorForTest();
const processIsolatedPdeCpuOracleModule =
  await importProcessIsolatedPdePoisson2dIndependentCpuOracleForTest();
const canonicalDeepLearningExecutorModule =
  await importCanonicalCupyDeepLearningTrainingExecutorForTest();

export const GPU_RELEASE_TIME = '2026-08-15T00:00:00.000Z';
export const GPU_AUTHORITY_EXPIRED_TIME = '2026-08-21T00:00:00.000Z';
const GPU_UUID = 'GPU-a33875b7-7eb7-679e-df08-19227d3decee';
const H = (label) => hashRecord('GpuScientificCampaignReleaseFixture', { label });

function removeFixtureTree(root) {
  function restoreOwnerWrite(candidate) {
    let entry;
    try { entry = fs.lstatSync(candidate); }
    catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    if (entry.isSymbolicLink()) return;
    fs.chmodSync(candidate, entry.isDirectory() ? 0o700 : 0o600);
    if (entry.isDirectory()) {
      for (const name of fs.readdirSync(candidate)) {
        restoreOwnerWrite(path.join(candidate, name));
      }
    }
  }
  restoreOwnerWrite(root);
  fs.rmSync(root, { recursive: true, force: true });
}

function mutableClock(initial) {
  let current = new Date(initial);
  return Object.freeze({
    version: 1,
    kind: 'GpuScientificCampaignReleaseFixtureClock',
    now: () => new Date(current),
    nowIso: () => new Date(current).toISOString(),
    set(value) { current = new Date(value); },
  });
}

function memoryReceiptLedger() {
  let sequence = 0;
  const rows = new Map();
  return Object.freeze({
    record(receipt, { stream = null } = {}) {
      sequence += 1;
      const receiptId = `gpu-release-fixture:${sequence}`;
      rows.set(receiptId, { ...receipt, stream, receipt_id: receiptId });
      return Object.freeze({ receiptId });
    },
    get(receiptId) { return rows.get(receiptId) || null; },
    list() { return [...rows.values()]; },
  });
}

function promoteWorkerReceipt(receipt) {
  const promoted = structuredClone(receipt);
  promoted.evidenceClass = 'production-runtime-observation-v1';
  promoted.productionEvidenceEligible = true;
  const payload = { ...promoted };
  delete payload.ok;
  delete payload.receiptHash;
  delete payload.blockers;
  promoted.receiptHash = hashRecord('OsSandboxWorkerReceipt', payload);
  return promoted;
}

function promotedRunner(runner) {
  return Object.freeze({
    ...runner,
    capabilities: (...args) => runner.capabilities(...args),
    resolveExecutionRuntimeIdentity: (...args) => (
      runner.resolveExecutionRuntimeIdentity(...args)
    ),
    inspectGpuDeviceCapacity: (...args) => (
      runner.inspectGpuDeviceCapacity(...args)
    ),
    prepareEnvironmentBom: (...args) => runner.prepareEnvironmentBom(...args),
    async run(input) {
      return promoteWorkerReceipt(await runner.run(input));
    },
  });
}

function gpuCapacityObservation(gpuDeviceSelector = GPU_UUID) {
  return buildNvidiaGpuDeviceCapacityObservation({
    gpuDeviceSelector,
    reportedTotalMemoryMiB: 24_576,
    reportedFreeMemoryMiB: 20_480,
  });
}

function gpuEnvironmentBomSpawnSync(executable, args = []) {
  if (executable !== 'nvidia-smi') {
    return { status: 1, stdout: '', stderr: 'fixture_command_not_supported' };
  }
  if (args[0] === '--query-gpu=name,compute_cap,driver_version') {
    return {
      status: 0,
      stdout: 'Fixture NVIDIA GPU, 8.9, 580.173.02\n',
      stderr: '',
    };
  }
  return {
    status: 0,
    stdout: 'NVIDIA-SMI fixture CUDA Version: 12.6\n',
    stderr: '',
  };
}

function discreteReferenceBytes(gridSize, modes) {
  const spacing = 1 / (gridSize + 1);
  const buffer = Buffer.alloc(gridSize * gridSize * Float64Array.BYTES_PER_ELEMENT);
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  for (let row = 0; row < gridSize; row += 1) {
    const y = (row + 1) * spacing;
    for (let column = 0; column < gridSize; column += 1) {
      const x = (column + 1) * spacing;
      let solution = 0;
      for (const { amplitude, kx, ky } of modes) {
        const basis = Math.sin(kx * Math.PI * x)
          * Math.sin(ky * Math.PI * y);
        const continuousEigenvalue = Math.PI ** 2 * (kx ** 2 + ky ** 2);
        const discreteEigenvalue = 4 / spacing ** 2 * (
          Math.sin(kx * Math.PI * spacing / 2) ** 2
          + Math.sin(ky * Math.PI * spacing / 2) ** 2
        );
        solution += amplitude * continuousEigenvalue / discreteEigenvalue
          * basis;
      }
      view.setFloat64(
        (row * gridSize + column) * Float64Array.BYTES_PER_ELEMENT,
        solution,
        true,
      );
    }
  }
  return buffer;
}

function pdeFixtureRunner(outputRoot, runtimeRoot) {
  return promotedRunner(createOsSandboxedWorkerRunnerForTest({
    allowedExecutables: [AUTOMATION_RUNTIME_IMAGES.pythonGpu.executable],
    allowedRoots: [
      canonicalPdeExecutorModule.CANONICAL_CUPY_PDE_POISSON_2D_WORKER_ROOT,
    ],
    allowedOutputRoots: [outputRoot],
    allowedContainerImages: [AUTOMATION_RUNTIME_IMAGES.pythonGpu.image],
    dockerImage: AUTOMATION_RUNTIME_IMAGES.pythonGpu.image,
    runtimeRoot,
    allowGpu: true,
    maximumTimeoutMs: 900_000,
    maximumMemoryBytes: 2 * 1024 ** 3,
    maximumCpuSeconds: 900,
    maximumPids: 16,
    maximumOutputBytes: 8 * 1024 ** 2,
    maximumInputBytes: 1024 * 1024,
    probe: {
      available: true,
      backend: 'docker',
      status: 'os_sandbox_available',
      image: AUTOMATION_RUNTIME_IMAGES.pythonGpu.image,
    },
    imageDigestResolver: (image) => (
      image === AUTOMATION_RUNTIME_IMAGES.pythonGpu.image
        ? AUTOMATION_RUNTIME_IMAGES.pythonGpu.imageDigest : null
    ),
    gpuDeviceCapacityObserver: (selector) => gpuCapacityObservation(selector),
    environmentBomSpawnSync: gpuEnvironmentBomSpawnSync,
    executor(_launcher, args, options) {
      const outputVolume = args.find(
        (value) => String(value).endsWith(':/output:rw'),
      );
      const outputDirectory = String(outputVolume || '')
        .slice(0, -':/output:rw'.length);
      const request = JSON.parse(Buffer.from(options.input).toString('utf8'));
      const solutionRoot = path.join(outputDirectory, 'solutions');
      fs.mkdirSync(solutionRoot, { mode: 0o700 });
      for (const gridSize of request.producerSpecification
        .discretization.gridSizes) {
        fs.writeFileSync(
          path.join(solutionRoot, `n${gridSize}.f64le`),
          discreteReferenceBytes(
            gridSize,
            request.producerSpecification.equation.manufacturedModes,
          ),
          { mode: 0o600 },
        );
      }
      fs.writeFileSync(
        path.join(outputDirectory, 'producer-diagnostics.json'),
        `${JSON.stringify({
          version: 1,
          kind: 'CanonicalCupyPoisson2dProducerDiagnostics',
          requestHash: request.requestHash,
          visibleGpuUuid: GPU_UUID,
          observations: request.producerSpecification.discretization.gridSizes
            .map((gridSize) => ({
              gridSize,
              iterations: 1,
              relativeContinuousL2Error: 0,
              relativeDiscreteResidual: 0,
            })),
          scientificAuthority: 'non-authoritative-self-report-v1',
        })}\n`,
        { mode: 0o600 },
      );
      return { status: 0, stdout: '', stderr: '', pid: 41001 };
    },
  }));
}

function tensorsFor(model) {
  const chunks = [];
  const tensors = model.layers.flatMap((layer) => [
    {
      name: `${layer.layerId}.weight`,
      shape: [layer.outputUnits, layer.inputUnits],
    },
    { name: `${layer.layerId}.bias`, shape: [layer.outputUnits] },
  ]).sort((left, right) => (
    left.name < right.name ? -1 : Number(left.name > right.name)
  )).map((tensor) => {
    const count = tensor.shape.reduce((product, item) => product * item, 1);
    const bytes = Buffer.alloc(count * 4);
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

function writeDeepLearningFixtureOutputs({ outputDirectory, request }) {
  const {
    modelIr: model,
    trainingDataset: dataset,
    profile,
    trainingRunId,
  } = request;
  const { tensors, bundle } = tensorsFor(model);
  const predictedClass = dataset.labels.map(() => 0);
  const accuracy = predictedClass.reduce((matches, predicted, index) => (
    matches + Number(predicted === dataset.labels[index])
  ), 0) / dataset.sampleCount;
  const crossEntropy = Math.log(model.classCount);
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
    records: Array.from({ length: model.training.epochs }, (_, index) => ({
      epoch: index + 1,
      accuracy,
      crossEntropy,
      gradientNorm: 0,
    })),
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
    trainingStepCount:
      Math.ceil(dataset.sampleCount / model.training.batchSize)
        * model.training.epochs,
    tensorBundleArtifactBytes: bundle.length,
    tensors,
    finalMetrics: {
      accuracy,
      crossEntropy,
      initialCrossEntropy: crossEntropy,
      gradientNorm: 0,
    },
    trainingPredictionCount: dataset.sampleCount,
    runtime: {
      framework: 'cupy',
      frameworkVersion: '13.3.0',
      cudaDriverVersion: '580.173.02',
      cudaRuntimeVersion: '12.6',
      gpuComputeCapability: '8.9',
      gpuDeviceSelector: GPU_UUID,
      gpuModel: 'Fixture NVIDIA GPU',
      trainingComputeDevice: 'cuda:0-single-visible-device-v1',
    },
    networkActionPerformed: false,
    externalActionPerformed: false,
    hiddenEvaluationPerformed: false,
    gpuMemoryCapacityPlanHash:
      request.gpuMemoryCapacityPlan.gpuMemoryCapacityPlanHash,
  };
  const predictions = {
    version: 1,
    kind: 'DeepLearningTrainingPredictions',
    trainingRunId,
    modelIrHash: model.deepLearningModelIrHash,
    trainingDatasetManifestHash: dataset.deepLearningTrainingDatasetManifestHash,
    scope: 'training-dataset-only-not-hidden-evaluation-v1',
    predictedClass,
  };
  for (const [name, value] of Object.entries({
    'model-spec.json': modelSpecification,
    'training-predictions.json': predictions,
    'training-summary.json': summary,
    'training-trace.json': trace,
  })) {
    fs.writeFileSync(path.join(outputDirectory, name), `${JSON.stringify(value)}\n`, {
      flag: 'wx', mode: 0o600,
    });
  }
  fs.writeFileSync(path.join(outputDirectory, 'tensor-bundle.bin'), bundle, {
    flag: 'wx', mode: 0o600,
  });
}

function deepLearningFixtureRunner(outputRoot, runtimeRoot) {
  return createOsSandboxedWorkerRunnerForTest({
    allowedExecutables: [AUTOMATION_RUNTIME_IMAGES.pythonGpu.executable],
    allowedRoots: [
      canonicalDeepLearningExecutorModule
        .CANONICAL_CUPY_DEEP_LEARNING_TRAINER_ROOT,
    ],
    allowedOutputRoots: [outputRoot],
    allowedContainerImages: [AUTOMATION_RUNTIME_IMAGES.pythonGpu.image],
    dockerImage: AUTOMATION_RUNTIME_IMAGES.pythonGpu.image,
    runtimeRoot,
    allowGpu: true,
    maximumTimeoutMs: 3_600_000,
    maximumMemoryBytes: 8 * 1024 ** 3,
    maximumCpuSeconds: 3_600,
    maximumPids: 32,
    maximumOutputBytes: 2 * 1024 ** 3,
    maximumInputBytes: 4 * 1024 * 1024,
    probe: {
      available: true,
      backend: 'docker',
      status: 'os_sandbox_available',
      image: AUTOMATION_RUNTIME_IMAGES.pythonGpu.image,
    },
    imageDigestResolver: (image) => (
      image === AUTOMATION_RUNTIME_IMAGES.pythonGpu.image
        ? AUTOMATION_RUNTIME_IMAGES.pythonGpu.imageDigest : null
    ),
    gpuDeviceCapacityObserver: (selector) => gpuCapacityObservation(selector),
    environmentBomSpawnSync: gpuEnvironmentBomSpawnSync,
    executor(_launcher, args, options) {
      const outputVolume = args.find(
        (value) => String(value).endsWith(':/output:rw'),
      );
      const outputDirectory = String(outputVolume || '')
        .slice(0, -':/output:rw'.length);
      const request = JSON.parse(Buffer.from(options.input).toString('utf8'));
      writeDeepLearningFixtureOutputs({ outputDirectory, request });
      return { status: 0, stdout: '', stderr: '', pid: 41002 };
    },
  });
}

function promoteDeepLearningReceipt(receipt) {
  const promoted = structuredClone(receipt);
  promoted.workerReceipt = promoteWorkerReceipt(promoted.workerReceipt);
  promoted.workerReceiptHash = promoted.workerReceipt.receiptHash;
  promoted.environmentBomHash = promoted.workerReceipt.environmentBomHash;
  const payload = { ...promoted };
  delete payload.canonicalCupyDeepLearningTrainingReceiptHash;
  promoted.canonicalCupyDeepLearningTrainingReceiptHash = hashRecord(
    'CanonicalCupyDeepLearningTrainingReceipt', payload,
  );
  return promoted;
}

async function buildGpuExecution({
  runtimeRoot,
  campaign,
  sealPersistedProductionPlan = false,
}) {
  const executionPlan = buildCanonicalGpuScientificCampaignExecutionPlan({
    campaignId: campaign.campaignId,
    paperId: campaign.paperId,
    gpuDeviceSelector: GPU_UUID,
    absoluteExecutionDeadlineEpochMs: 2_000_000_000_000,
  });
  campaign.spec.gpuScientificExecutionPlan = executionPlan;
  if (sealPersistedProductionPlan) {
    const formalNodeId = `${campaign.campaignId}:1:formal-verify`;
    const finalCompileNodeId = `${campaign.campaignId}:1:final-compile`;
    const researchNodeId = `${campaign.campaignId}:2:research-verify`;
    campaign.spec.nodes = [
      {
        nodeId: formalNodeId,
        kind: 'formal-verify',
        roundIndex: 0,
        dependencies: [],
        sourceClosureTerminal: true,
      },
      {
        nodeId: finalCompileNodeId,
        kind: 'final-compile',
        roundIndex: 1,
        dependencies: [formalNodeId],
        sourceClosureTerminal: true,
        sourceMutationPolicy: 'forbid',
      },
      {
        nodeId: executionPlan.nodeId,
        kind: 'gpu-scientific-execution',
        roundIndex: 0,
        dependencies: [formalNodeId],
        sourceClosureTerminal: true,
        gpuScientificExecutionPlanHash:
          executionPlan.gpuScientificCampaignExecutionPlanHash,
        gpuScientificResourceBudgetHash:
          GPU_SCIENTIFIC_CAMPAIGN_RESOURCE_BUDGET
            .gpuScientificCampaignResourceBudgetHash,
      },
      {
        nodeId: researchNodeId,
        kind: 'research-verify',
        roundIndex: 2,
        dependencies: [finalCompileNodeId, executionPlan.nodeId, formalNodeId],
      },
      {
        nodeId: `${campaign.campaignId}:3:package`,
        kind: 'package',
        roundIndex: 3,
        dependencies: [finalCompileNodeId, researchNodeId],
      },
    ];
    const { campaignPlanHash: _oldPlanHash, ...planPayload } = campaign.spec;
    campaign.spec.campaignPlanHash = hashRecord('PaperCampaignPlan', planPayload);
  }
  const node = {
    nodeId: executionPlan.nodeId,
    kind: 'gpu-scientific-execution',
    attemptId: 'gpu-release-attempt-1',
    leaseGeneration: 3,
    gpuScientificExecutionPlanHash:
      executionPlan.gpuScientificCampaignExecutionPlanHash,
    gpuScientificResourceBudgetHash:
      GPU_SCIENTIFIC_CAMPAIGN_RESOURCE_BUDGET
        .gpuScientificCampaignResourceBudgetHash,
  };
  const attemptAuthority = buildGpuScientificCampaignAttemptAuthority({
    campaign, node, plan: executionPlan,
  });
  const attemptRoot = path.join(
    runtimeRoot,
    'automation-artifacts',
    safeRetentionNodeKey(campaign.campaignId),
    `gpu-scientific-attempt-${attemptAuthority
      .gpuScientificCampaignAttemptAuthorityHash.slice('sha256:'.length)}`,
  );
  const pdeOutputRoot = path.join(attemptRoot, 'pde-poisson-2d');
  const deepLearningOutputRoot = path.join(
    attemptRoot,
    'deep-learning-cupy-mlp',
  );
  fs.mkdirSync(pdeOutputRoot, { recursive: true, mode: 0o700 });
  fs.mkdirSync(deepLearningOutputRoot, { recursive: true, mode: 0o700 });
  const pdeExecutor = await withCanonicalCupyPdePoisson2dSandboxRunnerForTest(
    pdeFixtureRunner(pdeOutputRoot, runtimeRoot),
    () => canonicalPdeExecutorModule.createCanonicalCupyPdePoisson2dExecutor({
      outputRoot: pdeOutputRoot,
      runtimeRoot,
      timeoutMs: 900_000,
      memoryBytes: 2 * 1024 ** 3,
      cpuSeconds: 900,
      maximumProcesses: 16,
      maximumOutputBytes: 8 * 1024 ** 2,
    }),
  );
  const deepLearningExecutor =
    await withCanonicalCupyDeepLearningSandboxRunnerForTest(
      deepLearningFixtureRunner(deepLearningOutputRoot, runtimeRoot),
      () => canonicalDeepLearningExecutorModule
        .createCanonicalCupyDeepLearningTrainingExecutor({
          outputRoot: deepLearningOutputRoot,
          runtimeRoot,
          timeoutMs: 3_600_000,
          memoryBytes: 8 * 1024 ** 3,
          cpuSeconds: 3_600,
          maximumProcesses: 32,
          maximumOutputBytes: 2 * 1024 ** 3,
        }),
    );
  const { pdeScientificReceipt, deepLearningReceipt } =
    await withGpuSelectorExecutionLeaseForTest({
      runtimeRoot,
      gpuDeviceSelector: executionPlan.gpuDeviceSelector,
      ownerAuthorityHash:
        attemptAuthority.gpuScientificCampaignAttemptAuthorityHash,
      absoluteDeadlineEpochMs:
        executionPlan.absoluteExecutionDeadlineEpochMs,
    }, async (campaignLease) => {
      const gpuSelectorExecutionLeaseDelegation =
        campaignLease.workerDelegation();
      const pdeGpuReceipt = await pdeExecutor.execute({
        runId: executionPlan.tasks[0].runId,
        gpuDeviceSelector: executionPlan.gpuDeviceSelector,
        absoluteDeadlineEpochMs:
          executionPlan.absoluteExecutionDeadlineEpochMs,
        executionAuthorityHash:
          attemptAuthority.gpuScientificCampaignAttemptAuthorityHash,
        gpuSelectorExecutionLeaseDelegation,
      });
      if (pdeGpuReceipt.status
          !== 'canonical_cupy_pde_poisson_2d_executed_pending_cpu_oracle') {
        throw new Error(
          `gpu_release_fixture_pde_execution_invalid:${JSON.stringify(pdeGpuReceipt.blockers)}`,
        );
      }
      const cpuOracleAssurance =
        withPdePoisson2dCpuOracleSandboxRunnerForTest(
          createPdePoisson2dCpuOracleFixtureRunner({ runtimeRoot }),
          () => processIsolatedPdeCpuOracleModule
            .runProcessIsolatedPdePoisson2dIndependentCpuOracle({
              artifactRoot: pdeGpuReceipt.outputDirectory,
              artifactManifest: pdeGpuReceipt.artifactManifest,
              producerSpecification: pdeGpuReceipt.producerSpecification,
              absoluteDeadlineEpochMs:
                executionPlan.absoluteExecutionDeadlineEpochMs,
            }),
        );
      const pdeScientificPayload = {
        version: 1,
        kind: 'CanonicalPdePoisson2dGpuScientificReceipt',
        status:
          'canonical_pde_poisson_2d_gpu_scientifically_verified_non_promotable',
        gpuReceipt: pdeGpuReceipt,
        cpuOracleAssurance,
        productionPromotionEligible: false,
        blockers: [
          'pde_poisson_2d_external_operational_and_conformance_authority_required',
        ],
      };
      const selectedPdeScientificReceipt = Object.freeze({
        ...pdeScientificPayload,
        canonicalPdePoisson2dGpuScientificReceiptHash: hashRecord(
          'CanonicalPdePoisson2dGpuScientificReceipt',
          pdeScientificPayload,
        ),
      });
      const selectedDeepLearningReceipt = promoteDeepLearningReceipt(
        await deepLearningExecutor.execute({
          trainingRunId: executionPlan.tasks[1].trainingRunId,
          profile: executionPlan.tasks[1].profile,
          modelIr: executionPlan.tasks[1].modelIr,
          trainingDataset: executionPlan.tasks[1].trainingDataset,
          trainingDatasetAuthority:
            executionPlan.tasks[1].trainingDatasetAuthority,
          gpuDeviceSelector: executionPlan.gpuDeviceSelector,
          absoluteDeadlineEpochMs:
            executionPlan.absoluteExecutionDeadlineEpochMs,
          executionAuthorityHash:
            attemptAuthority.gpuScientificCampaignAttemptAuthorityHash,
          gpuSelectorExecutionLeaseDelegation,
        }),
      );
      if (selectedDeepLearningReceipt.status
          !== 'canonical_cupy_deep_learning_training_recorded_non_promotable') {
        throw new Error(
          `gpu_release_fixture_deep_learning_execution_invalid:${JSON.stringify(selectedDeepLearningReceipt.blockers)}`,
        );
      }
      return {
        pdeScientificReceipt: selectedPdeScientificReceipt,
        deepLearningReceipt: selectedDeepLearningReceipt,
      };
    });
  const executionResult = buildGpuScientificCampaignExecutionResult({
    campaign,
    node,
    plan: executionPlan,
    pdeScientificReceipt,
    deepLearningTrainingReceipt: deepLearningReceipt,
    effectiveExecutionDeadlineEpochMs:
      executionPlan.absoluteExecutionDeadlineEpochMs,
    executionStartedAtEpochMs: Date.parse(GPU_RELEASE_TIME) - 1_000,
    executionCompletedAtEpochMs: Date.parse(GPU_RELEASE_TIME),
  });
  node.result = executionResult;
  node.resultSha256 = hashRecord('PaperCampaignNodeResult', executionResult);
  node.status = 'completed';
  return { executionPlan, executionResult, node };
}

function authorityKey(keyId, role, subjectId, organization, pair) {
  return {
    keyId,
    status: 'active',
    algorithm: 'ed25519',
    roles: [role],
    subjectId,
    organization,
    processIdentityHash: H(`authority-process:${keyId}`),
    publicKeyPem: pair.publicKey.export({ type: 'spki', format: 'pem' }),
    effectiveFrom: '2026-08-01T00:00:00.000Z',
    expiresAt: '2027-08-01T00:00:00.000Z',
    revoked: false,
  };
}

function buildQualification({ campaign, gpu, archiveManifest }) {
  const request = buildGpuScientificCampaignQualificationRequest({
    campaignId: campaign.campaignId,
    paperId: campaign.paperId,
    campaignPlanHash: campaign.spec.campaignPlanHash,
    nodeId: gpu.node.nodeId,
    attemptId: gpu.node.attemptId,
    leaseGeneration: gpu.node.leaseGeneration,
    executionPlanHash: gpu.executionPlan.gpuScientificCampaignExecutionPlanHash,
    taskSetHash: gpu.executionPlan.taskSetHash,
    gpuDeviceSelector: archiveManifest.gpuDeviceSelector,
    gpuScientificCampaignAttemptAuthorityHash:
      archiveManifest.gpuScientificCampaignAttemptAuthorityHash,
    gpuScientificCampaignExecutionResultHash:
      gpu.executionResult.gpuScientificCampaignExecutionResultHash,
    artifactArchiveManifestHash:
      archiveManifest.gpuScientificArtifactBodyArchiveManifestHash,
    scientificOutputCommitmentHash: archiveManifest.scientificOutputCommitmentHash,
    pdeTaskReceiptHash: archiveManifest.pdeScientificReceiptHash,
    deepLearningTaskReceiptHash:
      archiveManifest.deepLearningTrainingReceiptHash,
    runtimeImageDigest: archiveManifest.runtimeImageDigest,
    runtimePackageClosureHash: archiveManifest.runtimePackageClosureHash,
    originalExecutionProcessIdentityHashes:
      archiveManifest.originalExecutionProcessIdentityHashes,
  });
  const replayPair = crypto.generateKeyPairSync('ed25519');
  const productionPair = crypto.generateKeyPairSync('ed25519');
  const replayInput = {
    request,
    replayPdeTaskReceiptHash: H('replay-pde'),
    replayDeepLearningTaskReceiptHash: H('replay-dl'),
    replayExecutionProcessIdentityHashes: {
      pde: H('replay-pde-process'), deepLearning: H('replay-dl-process'),
    },
    replayScientificOutputCommitmentHash:
      archiveManifest.scientificOutputCommitmentHash,
    replayedAt: '2026-08-14T00:00:00.000Z',
    signedAt: '2026-08-14T00:01:00.000Z',
    validFrom: '2026-08-14T00:01:00.000Z',
    expiresAt: '2026-08-20T00:00:00.000Z',
  };
  const unsignedReplay = buildGpuScientificCampaignSameDeviceReplayReceipt(
    replayInput,
  );
  const replaySigned = signAuthorityDocument(unsignedReplay, {
    privateKeyPem: replayPair.privateKey,
    keyId: 'gpu-replay-key',
    role: GPU_SCIENTIFIC_SAME_DEVICE_REPLAY_AUTHORITY_ROLE,
  });
  const replay = buildGpuScientificCampaignSameDeviceReplayReceipt({
    ...replayInput, signatures: replaySigned.signatures,
  });
  const productionInput = {
    request,
    sameDeviceReplayReceipt: replay,
    signedAt: '2026-08-14T00:02:00.000Z',
    validFrom: '2026-08-14T00:02:00.000Z',
    expiresAt: '2026-08-19T00:00:00.000Z',
  };
  const unsignedProduction =
    buildGpuScientificCampaignProductionQualificationAuthority(
      productionInput,
    );
  const productionSigned = signAuthorityDocument(unsignedProduction, {
    privateKeyPem: productionPair.privateKey,
    keyId: 'gpu-production-key',
    role: GPU_SCIENTIFIC_PRODUCTION_QUALIFICATION_AUTHORITY_ROLE,
  });
  const production = buildGpuScientificCampaignProductionQualificationAuthority({
    ...productionInput, signatures: productionSigned.signatures,
  });
  const evidence = buildGpuScientificCampaignQualificationEvidence({
    request,
    sameDeviceReplayReceipt: replay,
    productionQualificationAuthority: production,
  });
  const roots = [
    authorityKey(
      'gpu-replay-key',
      GPU_SCIENTIFIC_SAME_DEVICE_REPLAY_AUTHORITY_ROLE,
      'gpu-replay-subject',
      'Replay Lab',
      replayPair,
    ),
    authorityKey(
      'gpu-production-key',
      GPU_SCIENTIFIC_PRODUCTION_QUALIFICATION_AUTHORITY_ROLE,
      'gpu-production-subject',
      'Qualification Lab',
      productionPair,
    ),
  ];
  return {
    request,
    evidence,
    trustStore: { version: 1, kind: 'AuthorityTrustStore', keys: roots },
  };
}

function readyResearchReport({
  paperId,
  researchNode,
  campaignResearchSourceSnapshot,
}) {
  const researchGapPlanHash = H('research-gap-plan');
  const promotionInputSnapshotHash = H('promotion-input-snapshot');
  const experimentRegistry = Object.freeze(buildExperimentRegistry({
    paperTask: { paperId }, artifacts: [],
  }));
  const payload = {
    version: 1,
    kind: 'PaperResearchVerifyReport',
    paperId,
    taskKey: `${paperId}:campaign`,
    status: 'verified',
    experimentRegistryHash: experimentRegistry.experimentRegistryHash,
    promotionEligibility: { status: 'research_promotion_ready', blockers: [] },
    capabilities: {
      evidenceQualityGate: {
        status: 'evidence_quality_ready',
        blockers: [],
        evidenceQualityGateHash: H('evidence-quality-gate'),
      },
      experimentRegistry,
      researchGapPlan: { jobs: [], researchGapPlanHash },
      promotionInputSnapshot: {
        status: 'promotion_input_snapshot_frozen',
        researchGapPlanHash,
        promotionInputSnapshotHash,
      },
      researchGapClosureReceipt: {
        status: 'research_gap_closure_verified',
        promotionInputSnapshotHash,
        researchGapClosureReceiptHash: H('research-gap-closure'),
      },
    },
    typedContracts: {},
    nativeResearchWorkerExecution: { workerReceipts: [] },
    researchNodeId: researchNode.nodeId,
    researchAttemptId: researchNode.attemptId,
    researchLeaseGeneration: researchNode.leaseGeneration,
    verifiedSourceMerkleHash:
      campaignResearchSourceSnapshot.verifiedSourceMerkleHash,
    verifiedSourceWorkspaceManifestHash:
      campaignResearchSourceSnapshot.verifiedSourceWorkspaceManifestHash,
    campaignResearchSourceSnapshotHash:
      campaignResearchSourceSnapshot.campaignResearchSourceSnapshotHash,
    campaignResearchSourceSnapshot,
  };
  return Object.freeze({
    ...payload,
    researchReportHash: hashPaperRecord('PaperResearchVerifyReport', payload),
  });
}

function trustedReleaseAttestor() {
  const pair = crypto.generateKeyPairSync('ed25519');
  const signer = Object.freeze({
    keyId: 'gpu-release-fixture-key',
    keyVersion: 'v1',
    subjectId: 'gpu-release-fixture-attestor',
    organization: 'GPU Release Fixture Office',
  });
  return Object.freeze({
    version: 1,
    kind: 'ResearchExecutionReleaseAttestorPort',
    inspectConfiguration() {
      return Object.freeze({ ready: true, blockers: Object.freeze([]) });
    },
    verifyDetachedSignature({ signingPayloadHash, signature } = {}) {
      try {
        return crypto.verify(
          null,
          Buffer.from(String(signingPayloadHash || ''), 'utf8'),
          pair.publicKey,
          Buffer.from(String(signature || ''), 'base64'),
        );
      } catch { return false; }
    },
    attestCapsuleManifest({ manifest, manifestFileHash, signedAt } = {}) {
      const unsignedPayload = buildCampaignReleaseExecutionAttestationUnsignedPayload({
        manifest,
        manifestFileHash,
        signer,
        signedAt,
        expiresAt: new Date(Date.parse(signedAt) + 48 * 60 * 60 * 1000),
      });
      return finalizeCampaignReleaseExecutionAttestation({
        unsignedPayload,
        signature: crypto.sign(
          null,
          Buffer.from(
            campaignReleaseExecutionAttestationSigningPayloadHash(
              unsignedPayload,
            ),
            'utf8',
          ),
          pair.privateKey,
        ).toString('base64'),
      });
    },
    verifyAttestation({ attestation, manifest, manifestFileHash } = {}) {
      const structure = verifyCampaignReleaseExecutionAttestationStructure(
        attestation,
        {
          manifest,
          researchEvidenceCapsuleManifestHash:
            manifest?.researchEvidenceCapsuleManifestHash,
          researchEvidenceCapsuleManifestFileHash: manifestFileHash,
        },
      );
      try {
        return structure.valid && crypto.verify(
          null,
          Buffer.from(
            campaignReleaseExecutionAttestationSigningPayloadHash(attestation),
            'utf8',
          ),
          pair.publicKey,
          Buffer.from(attestation.signature, 'base64'),
        );
      } catch { return false; }
    },
  });
}

export function revokedGpuAuthorityTrustStore(trustStore, revokedAt) {
  const revoked = structuredClone(trustStore);
  revoked.keys[0].status = 'revoked';
  revoked.keys[0].revoked = true;
  revoked.keys[0].revokedAt = revokedAt;
  return revoked;
}

export async function createGpuScientificCampaignReleaseFixture(t, {
  campaignId = `gpu-release-${crypto.randomBytes(4).toString('hex')}`,
  persistedProductionPlan = false,
} = {}) {
  const root = fs.mkdtempSync(path.join(
    os.tmpdir(), 'hepta-gpu-release-toctou-',
  ));
  const workspace = path.join(root, 'source');
  const runtimeRoot = path.join(root, 'runtime');
  fs.mkdirSync(path.join(workspace, 'automation-results', 'final'), {
    recursive: true,
  });
  fs.mkdirSync(runtimeRoot, { recursive: true });
  fs.writeFileSync(
    path.join(workspace, 'main.tex'),
    '\\documentclass{article}\\begin{document}GPU release fixture.\\end{document}\n',
  );
  fs.writeFileSync(path.join(workspace, 'SOURCE_PACKAGE_CONTRACT.json'), JSON.stringify({
    version: 1,
    kind: 'SourcePackageContract',
    paperId: 'gpu-release-paper',
    venueTarget: 'Fixture Journal',
    files: [{ path: 'main.tex', role: 'main_tex', required: true }],
  }));
  fs.writeFileSync(
    path.join(workspace, 'automation-results', 'final', 'main.pdf'),
    buildDeterministicPdfFixture({ marker: `gpu-release-${campaignId}` }),
  );
  t.after(() => removeFixtureTree(root));
  const campaign = {
    campaignId,
    paperId: 'gpu-release-paper',
    spec: {
      campaignPlanHash: H(`campaign-plan:${campaignId}`),
      sourceWorkspace: workspace,
      venueTarget: 'Fixture Journal',
      researchVerificationRequired: true,
      paperQualityRequirements: { researchVerificationRequired: true },
      ...(persistedProductionPlan ? {
        version: 4,
        kind: 'PaperCampaignPlan',
        campaignId,
        paperId: 'gpu-release-paper',
        autonomousResearchPreparation: { launchMode: 'production-run' },
      } : {}),
    },
  };
  const gpu = await buildGpuExecution({
    runtimeRoot,
    campaign,
    sealPersistedProductionPlan: persistedProductionPlan,
  });
  const archive = inspectGpuScientificArtifactBodyArchiveSourceSync({
    runtimeRoot,
    campaign,
    node: gpu.node,
    executionPlan: gpu.executionPlan,
    executionResult: gpu.executionResult,
  });
  const qualification = buildQualification({
    campaign,
    gpu,
    archiveManifest: archive.manifest,
  });
  const authorityInspection =
    verifyGpuScientificCampaignQualificationEvidenceAuthority({
      qualificationEvidence: qualification.evidence,
      trustStore: qualification.trustStore,
      now: new Date(GPU_RELEASE_TIME),
    });
  if (!authorityInspection.valid) {
    throw new Error(
      `gpu_release_fixture_authority_invalid:${authorityInspection.blockers.join(',')}`,
    );
  }
  const gpuProjectionChecks = {
    execution: verifyGpuScientificCampaignExecutionResult(gpu.node.result, {
      campaign,
      node: gpu.node,
      plan: gpu.executionPlan,
    }),
    archive: verifyGpuScientificArtifactBodyArchiveManifest(archive.manifest, {
      campaignId: campaign.campaignId,
      paperId: campaign.paperId,
      campaignPlanHash: campaign.spec.campaignPlanHash,
      nodeId: gpu.node.nodeId,
      attemptId: gpu.node.attemptId,
      leaseGeneration: gpu.node.leaseGeneration,
      executionPlanHash:
        gpu.executionPlan.gpuScientificCampaignExecutionPlanHash,
      executionResultHash:
        gpu.node.result.gpuScientificCampaignExecutionResultHash,
    }).valid,
    request: verifyGpuScientificCampaignQualificationRequest(
      qualification.request,
      {
        campaignId: campaign.campaignId,
        paperId: campaign.paperId,
        campaignPlanHash: campaign.spec.campaignPlanHash,
        nodeId: gpu.node.nodeId,
        attemptId: gpu.node.attemptId,
        leaseGeneration: gpu.node.leaseGeneration,
        executionPlanHash:
          gpu.executionPlan.gpuScientificCampaignExecutionPlanHash,
        gpuScientificCampaignExecutionResultHash:
          gpu.node.result.gpuScientificCampaignExecutionResultHash,
        artifactArchiveManifestHash:
          archive.manifest.gpuScientificArtifactBodyArchiveManifestHash,
        scientificOutputCommitmentHash:
          archive.manifest.scientificOutputCommitmentHash,
      },
    ),
    qualification: verifyGpuScientificCampaignQualificationEvidence(
      qualification.evidence,
      {
        campaignId: campaign.campaignId,
        paperId: campaign.paperId,
        gpuScientificCampaignExecutionResultHash:
          gpu.node.result.gpuScientificCampaignExecutionResultHash,
        artifactArchiveManifestHash:
          archive.manifest.gpuScientificArtifactBodyArchiveManifestHash,
        scientificOutputCommitmentHash:
          archive.manifest.scientificOutputCommitmentHash,
      },
    ),
  };
  if (Object.values(gpuProjectionChecks).some((value) => value !== true)) {
    throw new Error(
      `gpu_release_fixture_projection_component_invalid:${JSON.stringify(gpuProjectionChecks)}`,
    );
  }
  const gpuResearchEvidence = buildCampaignResearchGpuScientificEvidence({
    campaign,
    node: gpu.node,
    plan: gpu.executionPlan,
    artifactArchiveManifest: archive.manifest,
    qualificationRequest: qualification.request,
    qualificationEvidence: qualification.evidence,
    authorityInspection,
  });
  const sourceSnapshot = inspectWorkspaceExecutionSnapshot(workspace, {
    excludeNames: sourceTreeExcludedNames(workspace),
  });
  const finalResult = {
    status: 'empirical_execution_completed',
    materializedPaths: ['automation-results/final/main.pdf'],
    multiLanguageEmpiricalReceiptHash: H('final-compile'),
    sourceMerkleHash: sourceSnapshot.merkleHash,
    sourceWorkspaceManifestHash: sourceSnapshot.manifestHash,
  };
  const finalCompileNode = {
    nodeId: `${campaignId}:1:final-compile`,
    kind: 'final-compile',
    status: 'completed',
    result: finalResult,
    resultSha256: hashRecord('PaperCampaignNodeResult', finalResult),
    dependencies: [],
  };
  const researchVerifyNode = {
    nodeId: `${campaignId}:2:research-verify`,
    kind: 'research-verify',
    status: 'completed',
    attemptId: `${campaignId}:research-attempt-1`,
    leaseGeneration: 1,
    dependencies: [
      finalCompileNode.nodeId,
      gpu.node.nodeId,
      `${campaignId}:1:formal-verify`,
    ],
  };
  const campaignResearchSourceSnapshot = buildCampaignResearchSourceSnapshot({
    campaignId: campaign.campaignId,
    paperId: campaign.paperId,
    researchNodeId: researchVerifyNode.nodeId,
    researchAttemptId: researchVerifyNode.attemptId,
    researchLeaseGeneration: researchVerifyNode.leaseGeneration,
    verifiedSourceMerkleHash: sourceSnapshot.merkleHash,
    verifiedSourceWorkspaceManifestHash: sourceSnapshot.manifestHash,
    excludedNames: sourceTreeExcludedNames(workspace),
    fileRecords: sourceSnapshot.fileRecords,
    directoryRecords: sourceSnapshot.directoryRecords,
  });
  const researchReport = readyResearchReport({
    paperId: campaign.paperId,
    researchNode: researchVerifyNode,
    campaignResearchSourceSnapshot,
  });
  const researchResult = {
    version: 1,
    kind: 'CampaignResearchVerificationResult',
    status: 'campaign_research_verification_completed',
    campaignId: campaign.campaignId,
    paperId: campaign.paperId,
    researchReportHash: researchReport.researchReportHash,
    researchPromotionStatus: 'research_promotion_ready',
    researchNodeId: researchVerifyNode.nodeId,
    researchAttemptId: researchVerifyNode.attemptId,
    researchLeaseGeneration: researchVerifyNode.leaseGeneration,
    verifiedSourceMerkleHash: sourceSnapshot.merkleHash,
    verifiedSourceWorkspaceManifestHash: sourceSnapshot.manifestHash,
    campaignResearchSourceSnapshotHash:
      campaignResearchSourceSnapshot.campaignResearchSourceSnapshotHash,
    campaignResearchSourceSnapshot,
    gpuScientificCampaignExecutionResultHash:
      gpu.executionResult.gpuScientificCampaignExecutionResultHash,
    gpuScientificArtifactBodyArchiveManifestHash:
      archive.manifest.gpuScientificArtifactBodyArchiveManifestHash,
    gpuScientificCampaignQualificationEvidenceHash:
      qualification.evidence.gpuScientificCampaignQualificationEvidenceHash,
    gpuScientificQualificationEvidence: gpuResearchEvidence,
    report: researchReport,
  };
  researchVerifyNode.result = researchResult;
  researchVerifyNode.resultSha256 = hashRecord(
    'PaperCampaignNodeResult', researchResult,
  );
  const packageNode = {
    nodeId: `${campaignId}:3:package`,
    kind: 'package',
    status: 'running',
    attemptId: `${campaignId}:package-attempt-1`,
    leaseGeneration: 1,
    dependencies: [finalCompileNode.nodeId, researchVerifyNode.nodeId],
  };
  const clock = mutableClock(GPU_RELEASE_TIME);
  const ledger = memoryReceiptLedger();
  const trustState = {
    current: qualification.trustStore,
    reads: 0,
  };
  const trustStoreProvider = () => {
    trustState.reads += 1;
    return trustState.current;
  };
  const authorityVerifier =
    createGpuScientificCampaignPromotionAuthorityVerifier({
      trustStoreProvider,
      clock,
    });
  const artifactRepositoryFactory = (scopeRoot) => (
    createFilesystemArtifactRepository({
      scopeRoot,
      casRoot: path.join(runtimeRoot, 'artifact-cas'),
      receiptLedger: ledger,
      clock,
    })
  );
  const packageInput = Object.freeze({
    campaign,
    packageNode,
    finalCompileNode,
    researchVerifyNode,
    researchReport,
    sourceWorkspace: workspace,
    gpuScientificExecutionPlan: gpu.executionPlan,
    gpuScientificExecutionEvidence: gpu.executionResult,
    gpuScientificResearchEvidence: gpuResearchEvidence,
    runtimeRoot,
    createdAt: GPU_RELEASE_TIME,
  });
  return Object.freeze({
    root,
    workspace,
    runtimeRoot,
    campaign,
    gpu,
    archive: archive.manifest,
    qualification,
    gpuResearchEvidence,
    clock,
    trustStoreReads: () => trustState.reads,
    setTrustStore(value) { trustState.current = value; },
    packageInput,
    createPackager({ packageAdapter = runPackageAdapter } = {}) {
      return createCampaignReleasePackager({
        artifactRepositoryFactory,
        receiptLedger: ledger,
        runtimeRoot,
        operatorDatasetAuthorityTrustStoreProvider: trustStoreProvider,
        clock,
        gpuScientificPromotionAuthorityVerifier: authorityVerifier,
        researchExecutionReleaseAttestor: trustedReleaseAttestor(),
        independentPdfRebuildVerifier:
          createTrustedIndependentPdfRebuildVerifierFixture({
            fixtureId: campaignId,
          }),
        packageAdapter,
      });
    },
  });
}

export { runPackageAdapter };
