import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

import {
  buildDeepLearningCupyMlpCampaignTask,
  buildCanonicalGpuScientificCampaignExecutionPlan,
  buildGpuScientificCampaignAttemptAuthority,
  buildGpuScientificCampaignExecutionPlan,
  buildGpuScientificCampaignExecutionResult,
  buildPdePoisson2dGpuCampaignTask,
  GPU_SCIENTIFIC_CAMPAIGN_RESOURCE_BUDGET,
  verifyGpuScientificCampaignExecutionPlan,
  verifyGpuScientificCampaignExecutionResult,
} from '../../paper-domain/automation/gpu-scientific-campaign-execution-contract.mjs';
import { buildCampaignModeNodes } from '../../paper-domain/automation/campaign-mode-graph.mjs';
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
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { resourcesForCampaignNode } from '../../paper-application/automation/resource-governor.mjs';
import {
  executeCampaignGpuScientificNode,
} from '../../paper-application/automation/campaign-gpu-scientific-node-orchestrator.mjs';
import { executeCampaignPackageNode } from '../../paper-application/automation/campaign-quality-release-orchestrator.mjs';
import {
  AUTOMATION_RUNTIME_IMAGES,
} from '../../paper-adapters/automation/runtime-image-registry.mjs';
import {
  composeCampaignGpuScientificExecution,
} from '../../paper-composition/automation/gpu-scientific-campaign-composition.mjs';
import {
  verifyGpuScientificPdeTaskReceipt,
} from '../../paper-domain/automation/gpu-scientific-campaign-evidence-verifier.mjs';
import { createDefaultPaperStore } from '../../paper-adapters/persistence/store-provider.mjs';
import { createSqliteCampaignStore } from '../../paper-adapters/persistence/sqlite-campaign-store.mjs';
import {
  gpuSelectorExecutionLeaseRootForRuntime,
  gpuSelectorExecutionLockFileName,
} from '../../paper-adapters/runtime/gpu-selector-execution-lease-repository.mjs';

const CAMPAIGN_ID = 'gpu-scientific-campaign';
const PAPER_ID = 'gpu-scientific-paper';
const GPU_UUID = 'GPU-a33875b7-7eb7-679e-df08-19227d3decee';
const H = (label) => hashRecord('GpuScientificCampaignTest', { label });

function modelIr({ modelId = 'campaign-cupy-model', seed = 17 } = {}) {
  return buildDeterministicSupervisedClassificationModelIr({
    modelId,
    profileHash:
      DETERMINISTIC_SUPERVISED_CLASSIFICATION_GPU_PROFILE.deepLearningGpuProfileHash,
    inputFeatureCount: 2,
    classCount: 2,
    layers: [
      {
        layerId: 'dense', type: 'dense', inputUnits: 2, outputUnits: 3,
        activation: 'relu', useBias: true,
      },
      {
        layerId: 'logits', type: 'dense', inputUnits: 3, outputUnits: 2,
        activation: 'identity', useBias: true,
      },
    ],
    training: {
      optimizer: 'adamw-v1', loss: 'sparse-cross-entropy-with-logits-v1',
      initialization: 'stateless-sha256-box-muller-v1',
      batchOrder: 'seeded-fisher-yates-v1', earlyStoppingEnabled: false,
      epochs: 2, batchSize: 2, learningRate: 0.01, weightDecay: 0,
      beta1: 0.9, beta2: 0.999, epsilon: 1e-8, gradientClipNorm: 10,
    },
    seed,
  });
}

function trainingDataset(datasetId = 'campaign-synthetic-xor') {
  return buildCanonicalParityDeepLearningTrainingDataset({
    datasetId, featureCount: 2,
  });
}

function trainingDatasetAuthority(dataset = trainingDataset()) {
  return buildCanonicalSyntheticDeepLearningDatasetAuthority({
    trainingDataset: dataset,
    generatorSpec: { datasetId: dataset.datasetId, featureCount: 2 },
  });
}

function plan({
  deadline = Date.now() + 60_000,
  gpuDeviceSelector = GPU_UUID,
  pdeRunId = 'campaign-poisson',
  selectedModelIr = modelIr(),
  dataset = trainingDataset(),
} = {}) {
  return buildGpuScientificCampaignExecutionPlan({
    campaignId: CAMPAIGN_ID,
    paperId: PAPER_ID,
    gpuDeviceSelector,
    absoluteExecutionDeadlineEpochMs: deadline,
    pde: { runId: pdeRunId },
    deepLearning: {
      trainingRunId: 'campaign-cupy-training',
      profile: DETERMINISTIC_SUPERVISED_CLASSIFICATION_GPU_PROFILE,
      modelIr: selectedModelIr,
      trainingDataset: dataset,
      trainingDatasetAuthority: trainingDatasetAuthority(dataset),
    },
  });
}

async function sigkillBoundGpuSelectorLeaseOwner(t, {
  runtimeRoot,
  gpuDeviceSelector = GPU_UUID,
} = {}) {
  const leaseRoot = gpuSelectorExecutionLeaseRootForRuntime(runtimeRoot);
  const repositoryUrl = pathToFileURL(path.resolve(
    'paper-adapters/runtime/gpu-selector-execution-lease-repository.mjs',
  )).href;
  const recoveryUrl = pathToFileURL(path.resolve(
    'paper-adapters/runtime/docker-worker-container-recovery.mjs',
  )).href;
  const child = spawn(process.execPath, ['--input-type=module', '--eval', `
    import { createGpuSelectorExecutionLeaseRepository } from ${JSON.stringify(repositoryUrl)};
    import { buildDockerWorkerContainerOwnership } from ${JSON.stringify(recoveryUrl)};
    const repository = createGpuSelectorExecutionLeaseRepository({
      root: ${JSON.stringify(leaseRoot)},
    });
    const lease = await repository.acquire({
      gpuDeviceSelector: ${JSON.stringify(gpuDeviceSelector)},
      ownerAuthorityHash: ${JSON.stringify(H('sigkill-stale-owner'))},
      absoluteDeadlineEpochMs: Date.now() + 120_000,
    });
    lease.bindWorkerInvocationAuthority(${JSON.stringify(H('sigkill-stale-worker'))}, {
      dockerWorkerContainerOwnership: buildDockerWorkerContainerOwnership({
        processInvocationId: ${JSON.stringify(H('sigkill-stale-invocation'))},
        containerIdPath: ${JSON.stringify(path.join(runtimeRoot, 'sigkill-worker.cid'))},
        gpuSelectorExecutionLease: lease,
      }),
    });
    process.stdout.write('bound\\n');
    setInterval(() => {}, 1_000);
  `], {
    env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(
      `campaign GPU stale lease owner readiness timed out: ${stderr}`,
    )), 5_000);
    const failBeforeReady = (code, signal) => {
      clearTimeout(timeout);
      reject(new Error(
        `campaign GPU stale lease owner exited before ready: ${code}/${signal}: ${stderr}`,
      ));
    };
    child.once('close', failBeforeReady);
    child.once('error', reject);
    child.stdout.on('data', (chunk) => {
      if (!String(chunk).includes('bound')) return;
      clearTimeout(timeout);
      child.off('close', failBeforeReady);
      resolve();
    });
  });
  const closed = new Promise((resolve) => {
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  assert.equal(child.kill('SIGKILL'), true);
  assert.deepEqual(await closed, { code: null, signal: 'SIGKILL' });
  const lockPath = path.join(
    leaseRoot,
    gpuSelectorExecutionLockFileName(gpuDeviceSelector),
  );
  const persisted = fs.readFileSync(lockPath, 'utf8');
  const state = JSON.parse(persisted.trim().split('\n').at(-1));
  assert.equal(state.ownerProcessIdentity.pid, child.pid);
  assert.equal(state.status, 'held');
  assert.ok(state.workerInvocationAuthorityHash);
  assert.ok(state.dockerWorkerContainerOwnership);
  return { lockPath, persisted, state };
}

function dockerRecoveryFixture(state, { ownershipMismatch = false } = {}) {
  const containerId = 'b'.repeat(64);
  let containerPresent = true;
  let inspectionCount = 0;
  let removalCount = 0;
  return Object.freeze({
    executor(_docker, args) {
      if (args[0] === 'container' && args[1] === 'inspect') {
        inspectionCount += 1;
        if (!containerPresent) {
          return {
            status: 1,
            stdout: '',
            stderr: `Error: No such object: ${args[2]}`,
          };
        }
        const labels = {
          ...state.dockerWorkerContainerOwnership.labels,
          ...(ownershipMismatch ? {
            'io.hepta.worker.ownership-hash': H('wrong-container-owner'),
          } : {}),
        };
        return {
          status: 0,
          stdout: JSON.stringify([{
            Id: containerId,
            Name: `/${state.dockerWorkerContainerOwnership.containerName}`,
            Config: { Labels: labels },
          }]),
          stderr: '',
        };
      }
      if (args[0] === 'rm' && args[1] === '--force') {
        assert.equal(args[2], containerId);
        removalCount += 1;
        containerPresent = false;
        return { status: 0, stdout: `${containerId}\n`, stderr: '' };
      }
      throw new Error(`unexpected campaign GPU recovery command: ${args.join(' ')}`);
    },
    inspectionCount: () => inspectionCount,
    removalCount: () => removalCount,
  });
}

test('GPU scientific plan is typed, exact, hash-bound, and tamper-evident', () => {
  const value = plan();
  assert.equal(verifyGpuScientificCampaignExecutionPlan(value), true);
  assert.deepEqual(value.tasks.map((task) => task.taskType), [
    'pde-poisson-2d-gpu-v1', 'deep-learning-cupy-mlp-v1',
  ]);
  assert.equal(value.tasks[0].gpuScientificCampaignTaskHash,
    buildPdePoisson2dGpuCampaignTask({ runId: 'campaign-poisson' })
      .gpuScientificCampaignTaskHash);
  assert.equal(value.tasks[1].gpuScientificCampaignTaskHash,
    buildDeepLearningCupyMlpCampaignTask({
      trainingRunId: 'campaign-cupy-training',
      profile: DETERMINISTIC_SUPERVISED_CLASSIFICATION_GPU_PROFILE,
      modelIr: modelIr(),
      trainingDataset: trainingDataset(),
      trainingDatasetAuthority: trainingDatasetAuthority(),
    }).gpuScientificCampaignTaskHash);
  for (const mutate of [
    (copy) => { copy.gpuDeviceSelector = 'all'; },
    (copy) => { copy.tasks.reverse(); },
    (copy) => { copy.tasks[1].modelIr.seed += 1; },
    (copy) => { copy.absoluteExecutionDeadlineEpochMs += 1; },
    (copy) => { copy.resourceBudgetHash = H('forged-resource-budget'); },
  ]) {
    const copy = structuredClone(value);
    mutate(copy);
    assert.equal(verifyGpuScientificCampaignExecutionPlan(copy), false);
  }
});

test('canonical GPU scientific plan factory builds deterministic bounded PDE and DL tasks', () => {
  const first = buildCanonicalGpuScientificCampaignExecutionPlan({
    campaignId: CAMPAIGN_ID,
    paperId: PAPER_ID,
    gpuDeviceSelector: GPU_UUID,
    absoluteExecutionDeadlineEpochMs: 2_000_000_000_000,
  });
  const replay = buildCanonicalGpuScientificCampaignExecutionPlan({
    campaignId: CAMPAIGN_ID,
    paperId: PAPER_ID,
    gpuDeviceSelector: GPU_UUID,
    absoluteExecutionDeadlineEpochMs: 2_000_000_000_000,
  });
  assert.deepEqual(first, replay);
  assert.equal(verifyGpuScientificCampaignExecutionPlan(first), true);
  assert.deepEqual(first.tasks.map(({ taskType }) => taskType), [
    'pde-poisson-2d-gpu-v1', 'deep-learning-cupy-mlp-v1',
  ]);
  assert.equal(first.tasks[1].trainingDataset.sampleCount, 4);
  assert.equal(first.tasks[1].trainingDatasetAuthority.originClass,
    'canonical-synthetic-generated-v1');
  assert.equal(first.tasks[1].trainingDatasetAuthority.productionPromotionEligible, false);
});

test('SQLite-hydrated GPU node retains plan/resource bindings through claim and execution', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-gpu-persistence-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = createDefaultPaperStore({ root, runtimeRoot: root });
  t.after(() => store.close?.());
  let now = Date.parse('2026-08-14T00:00:00.000Z');
  const clock = {
    now: () => new Date(now),
    nowIso: () => new Date(now += 1).toISOString(),
  };
  const campaignStore = createSqliteCampaignStore({ store, clock });
  const executionPlan = plan({
    deadline: 2_000_000_000_000,
    gpuDeviceSelector: GPU_UUID,
  });
  const gpuNode = {
    ...buildCampaignModeNodes({
      campaignId: CAMPAIGN_ID,
      mode: 'full-campaign',
      rounds: 1,
      reviewers: 2,
      executionProfiles: [],
      executionIntent: {},
      empiricalRequested: false,
      applyManuscript: false,
      researchVerificationRequired: true,
      gpuScientificExecutionPlan: executionPlan,
    }).find(({ kind }) => kind === 'gpu-scientific-execution'),
    dependencies: [],
  };
  campaignStore.createCampaign({
    campaignId: CAMPAIGN_ID,
    paperId: PAPER_ID,
    sourceWorkspace: root,
    maxRounds: 1,
    campaignPlanHash: H('sqlite-gpu-campaign-plan'),
    gpuScientificExecutionPlan: executionPlan,
    budgets: {
      maxWallTimeMs: 60_000,
      maxAgentCalls: 1,
      maxCpuJobs: 2,
      maxGpuJobs: 2,
      maxTokenCount: 1,
      maxCostUsd: 1,
      maxMemoryMiB: 8192,
    },
    nodes: [gpuNode],
  });
  const [claimed] = campaignStore.claimReady({
    campaignId: CAMPAIGN_ID,
    workerId: 'gpu-persistence-worker',
    leaseSeconds: 120,
  });
  const running = campaignStore.startNode({
    nodeId: claimed.nodeId,
    workerId: 'gpu-persistence-worker',
    attemptId: claimed.attemptId,
    leaseGeneration: claimed.leaseGeneration,
  });
  assert.equal(running.gpuScientificExecutionPlanHash, undefined);
  assert.equal(running.spec.gpuScientificExecutionPlanHash,
    executionPlan.gpuScientificCampaignExecutionPlanHash);
  assert.deepEqual(resourcesForCampaignNode(
    campaignStore.getCampaign(CAMPAIGN_ID), running,
  ), GPU_SCIENTIFIC_CAMPAIGN_RESOURCE_BUDGET.nodeReservation);
  let observed = null;
  const fakeExecution = Object.freeze({
    version: 1,
    kind: 'CampaignGpuScientificExecutionPort',
    capabilities: () => Object.freeze({
      typedHashBoundPlan: true,
      exactPdeAndDeepLearningTaskSet: true,
      canonicalPdeCpuOracleRequired: true,
      canonicalCupyMlpRequired: true,
      singleGpuUuidRequired: true,
      absoluteDeadlineBound: true,
      sourceMutationForbidden: true,
      productionPromotionDisabled: true,
    }),
    async execute(input) {
      observed = input;
      return Object.freeze({ status: 'fixture-gpu-execution' });
    },
  });
  const campaign = campaignStore.getCampaign(CAMPAIGN_ID);
  const outcome = await executeCampaignGpuScientificNode({
    gpuScientificExecution: fakeExecution,
    campaign,
    node: running,
    workspace: { root },
    executionBudget: {},
  });
  assert.equal(outcome.status, 'fixture-gpu-execution');
  assert.equal(observed.plan.gpuScientificCampaignExecutionPlanHash,
    executionPlan.gpuScientificCampaignExecutionPlanHash);
  const blocked = buildGpuScientificCampaignExecutionResult({
    campaign,
    node: running,
    plan: executionPlan,
    pdeScientificReceipt: null,
    deepLearningTrainingReceipt: null,
    effectiveExecutionDeadlineEpochMs: executionPlan.absoluteExecutionDeadlineEpochMs,
    executionStartedAtEpochMs: now,
    executionCompletedAtEpochMs: now + 1,
  });
  assert.equal(blocked.status, 'gpu_scientific_campaign_execution_blocked');
});

test('full graph places both typed GPU tasks in one source-closure-bound node before compile and research verify', () => {
  const value = plan();
  const nodes = buildCampaignModeNodes({
    campaignId: CAMPAIGN_ID,
    mode: 'full-campaign',
    rounds: 1,
    reviewers: 2,
    executionProfiles: [],
    executionIntent: {},
    empiricalRequested: false,
    applyManuscript: false,
    researchVerificationRequired: true,
    gpuScientificExecutionPlan: value,
  });
  const gpu = nodes.find((node) => node.kind === 'gpu-scientific-execution');
  const finalCompile = nodes.find((node) => node.kind === 'final-compile');
  const researchVerify = nodes.find((node) => node.kind === 'research-verify');
  const packageNode = nodes.find((node) => node.kind === 'package');
  assert.equal(gpu.gpuScientificExecutionPlanHash,
    value.gpuScientificCampaignExecutionPlanHash);
  assert.equal(gpu.sourceClosureTerminal, true);
  assert.equal(gpu.sourceMutationPolicy, 'forbid');
  assert.equal(gpu.requiresGpu, true);
  assert.ok(gpu.dependencies.length > 0);
  assert.ok(gpu.dependencies.every((dependency) => {
    const source = nodes.find((node) => node.nodeId === dependency);
    return source?.sourceClosureTerminal === true
      || source?.kind === 'convergence';
  }));
  assert.ok(finalCompile.dependencies.includes(gpu.nodeId));
  assert.ok(researchVerify.dependencies.includes(gpu.nodeId));
  assert.ok(packageNode.dependencies.includes(researchVerify.nodeId));
  assert.deepEqual(resourcesForCampaignNode({ spec: {} }, gpu), {
    agent: 0, cpu: 1, gpu: 1, memoryMiB: 8192,
  });
  assert.throws(() => resourcesForCampaignNode({ spec: {} }, {
    ...gpu,
    gpuScientificResourceBudgetHash: H('forged-resource-budget'),
  }), /gpu_scientific_campaign_resource_budget_binding_invalid/);
});

test('fixture/nonproduction task evidence remains non-promotable and release fails closed', async () => {
  const executionPlan = plan();
  const campaign = Object.freeze({
    campaignId: CAMPAIGN_ID,
    paperId: PAPER_ID,
    spec: Object.freeze({
      campaignPlanHash: H('campaign-plan'),
      gpuScientificExecutionPlan: executionPlan,
    }),
  });
  const node = Object.freeze({
    nodeId: executionPlan.nodeId,
    kind: 'gpu-scientific-execution',
    attemptId: 'gpu-attempt-1',
    leaseGeneration: 1,
    gpuScientificExecutionPlanHash:
      executionPlan.gpuScientificCampaignExecutionPlanHash,
    gpuScientificResourceBudgetHash:
      GPU_SCIENTIFIC_CAMPAIGN_RESOURCE_BUDGET
        .gpuScientificCampaignResourceBudgetHash,
  });
  const result = buildGpuScientificCampaignExecutionResult({
    campaign,
    node,
    plan: executionPlan,
    pdeScientificReceipt: {
      kind: 'CanonicalPdePoisson2dGpuScientificReceipt',
      status: 'canonical_pde_poisson_2d_gpu_scientifically_verified_non_promotable',
      productionPromotionEligible: false,
      blockers: ['fixture'],
      gpuReceipt: null,
      cpuOracleAssurance: null,
    },
    deepLearningTrainingReceipt: {
      kind: 'CanonicalCupyDeepLearningTrainingReceipt',
      status: 'canonical_cupy_deep_learning_training_recorded_non_promotable',
      productionPromotionEligible: false,
      blockers: ['fixture'],
    },
    effectiveExecutionDeadlineEpochMs:
      executionPlan.absoluteExecutionDeadlineEpochMs,
    executionStartedAtEpochMs: Date.now(),
    executionCompletedAtEpochMs: Date.now(),
  });
  assert.equal(result.status, 'gpu_scientific_campaign_execution_blocked');
  assert.equal(result.productionQualified, false);
  assert.equal(result.promotionEligible, false);
  assert.equal(verifyGpuScientificCampaignExecutionResult(result, {
    campaign, node, plan: executionPlan,
  }), true);
  assert.equal(verifyGpuScientificCampaignExecutionResult(result, {
    campaign, node, plan: executionPlan, requirePromotionEligible: true,
  }), false);
  await assert.rejects(() => executeCampaignPackageNode({
    primitives: {},
    campaign,
    node: { kind: 'package' },
    context: { gpuScientificNode: { ...node, result } },
  }), /campaign_release_gpu_scientific_pre_release_qualification_required/);
});

test('GPU execution validates resource authority before creating an attempt output tree', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-gpu-resource-fence-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const executionPlan = plan({ deadline: 2_000_000_000_000 });
  const campaign = Object.freeze({
    campaignId: CAMPAIGN_ID,
    paperId: PAPER_ID,
    spec: Object.freeze({
      campaignPlanHash: H('resource-fence-campaign-plan'),
      gpuScientificExecutionPlan: executionPlan,
    }),
  });
  const node = Object.freeze({
    nodeId: executionPlan.nodeId,
    kind: 'gpu-scientific-execution',
    attemptId: 'gpu-resource-fence-attempt',
    leaseGeneration: 1,
    gpuScientificExecutionPlanHash:
      executionPlan.gpuScientificCampaignExecutionPlanHash,
    gpuScientificResourceBudgetHash:
      GPU_SCIENTIFIC_CAMPAIGN_RESOURCE_BUDGET
        .gpuScientificCampaignResourceBudgetHash,
  });
  const outputRoot = path.join(root, 'automation-artifacts');
  const composition = composeCampaignGpuScientificExecution({
    outputRoot,
    runtimeRoot: root,
    plans: [executionPlan],
  });
  await assert.rejects(() => composition.execution.execute({
    campaign,
    node,
    plan: executionPlan,
    executionBudget: {
      absoluteDeadlineEpochMs: executionPlan.absoluteExecutionDeadlineEpochMs,
      acquiredResources: { agent: 0, cpu: 1, gpu: 0, memoryMiB: 8192 },
    },
  }), /gpu_scientific_campaign_resource_authority_required/);
  assert.deepEqual(fs.readdirSync(outputRoot), []);
});

test('campaign outer GPU lease persists SIGKILL state until exact Docker stale recovery succeeds', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-gpu-campaign-stale-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stale = await sigkillBoundGpuSelectorLeaseOwner(t, {
    runtimeRoot: root,
  });
  const deadline = Date.now() + 60_000;
  const executionPlan = plan({ deadline });
  const campaign = Object.freeze({
    campaignId: CAMPAIGN_ID,
    paperId: PAPER_ID,
    spec: Object.freeze({
      campaignPlanHash: H('stale-recovery-campaign-plan'),
      gpuScientificExecutionPlan: executionPlan,
    }),
  });
  const node = Object.freeze({
    nodeId: executionPlan.nodeId,
    kind: 'gpu-scientific-execution',
    attemptId: 'gpu-stale-recovery-attempt',
    leaseGeneration: 2,
    gpuScientificExecutionPlanHash:
      executionPlan.gpuScientificCampaignExecutionPlanHash,
    gpuScientificResourceBudgetHash:
      GPU_SCIENTIFIC_CAMPAIGN_RESOURCE_BUDGET
        .gpuScientificCampaignResourceBudgetHash,
  });
  const request = {
    campaign,
    node,
    plan: executionPlan,
    executionBudget: {
      absoluteDeadlineEpochMs: deadline,
      acquiredResources: { agent: 0, cpu: 1, gpu: 0, memoryMiB: 8192 },
    },
  };
  const outputRoot = path.join(root, 'execution');
  const mismatchedDocker = dockerRecoveryFixture(stale.state, {
    ownershipMismatch: true,
  });
  const blocked = composeCampaignGpuScientificExecution({
    outputRoot,
    runtimeRoot: root,
    plans: [executionPlan],
    dockerContainerRecoveryExecutor: mismatchedDocker.executor,
    environment: {},
  });
  await assert.rejects(blocked.execution.execute(request), (error) => {
    assert.equal(error.code, 'gpu_selector_execution_lease_recovery_required');
    assert.equal(
      error.recoveryReceipt?.status,
      'docker_worker_container_recovery_blocked',
    );
    assert.deepEqual(error.recoveryReceipt?.blockers, [
      'worker_container_recovery_ownership_mismatch',
    ]);
    return true;
  });
  assert.equal(mismatchedDocker.inspectionCount(), 1);
  assert.equal(mismatchedDocker.removalCount(), 0);
  assert.equal(fs.readFileSync(stale.lockPath, 'utf8'), stale.persisted);
  assert.deepEqual(fs.readdirSync(outputRoot), []);

  const exactDocker = dockerRecoveryFixture(stale.state);
  const recovered = composeCampaignGpuScientificExecution({
    outputRoot,
    runtimeRoot: root,
    plans: [executionPlan],
    dockerContainerRecoveryExecutor: exactDocker.executor,
    environment: {},
  });
  await assert.rejects(
    recovered.execution.execute(request),
    /gpu_scientific_campaign_resource_authority_required/,
  );
  assert.equal(exactDocker.inspectionCount(), 2);
  assert.equal(exactDocker.removalCount(), 1);
  assert.equal(fs.statSync(stale.lockPath).size, 0);
  assert.deepEqual(fs.readdirSync(outputRoot), []);
});

test('real canonical PDE and DL evidence completes non-promotably and cannot be replayed across task authorities', async (t) => {
  const observed = spawnSync('/usr/bin/nvidia-smi', [
    '--query-gpu=uuid', '--format=csv,noheader',
  ], { encoding: 'utf8', timeout: 5_000 });
  const selectedGpu = String(observed.stdout || '').trim().split(/\r?\n/)[0];
  const docker = spawnSync('/usr/bin/docker', ['info'], { timeout: 10_000 });
  const requiredImages = [
    AUTOMATION_RUNTIME_IMAGES.python.image,
    AUTOMATION_RUNTIME_IMAGES.pythonGpu.image,
  ].every((image) => spawnSync('/usr/bin/docker', ['image', 'inspect', image], {
    timeout: 10_000,
  }).status === 0);
  if (observed.status !== 0 || docker.status !== 0 || !requiredImages) {
    t.skip('canonical local Docker/GPU runtime unavailable');
    return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-gpu-campaign-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const deadline = Date.now() + 300_000;
  const executionPlan = plan({ deadline, gpuDeviceSelector: selectedGpu });
  const campaign = Object.freeze({
    campaignId: CAMPAIGN_ID,
    paperId: PAPER_ID,
    spec: Object.freeze({
      campaignPlanHash: H('real-campaign-plan'),
      gpuScientificExecutionPlan: executionPlan,
    }),
  });
  const node = Object.freeze({
    nodeId: executionPlan.nodeId,
    kind: 'gpu-scientific-execution',
    attemptId: 'gpu-real-attempt-1',
    leaseGeneration: 1,
    gpuScientificExecutionPlanHash:
      executionPlan.gpuScientificCampaignExecutionPlanHash,
    gpuScientificResourceBudgetHash:
      GPU_SCIENTIFIC_CAMPAIGN_RESOURCE_BUDGET
        .gpuScientificCampaignResourceBudgetHash,
  });
  const composition = composeCampaignGpuScientificExecution({
    outputRoot: path.join(root, 'execution'),
    runtimeRoot: root,
    plans: [executionPlan],
  });
  const firstExecution = composition.execution.execute({
    campaign,
    node,
    plan: executionPlan,
    executionBudget: {
      absoluteDeadlineEpochMs: deadline,
      acquiredResources: GPU_SCIENTIFIC_CAMPAIGN_RESOURCE_BUDGET.nodeReservation,
    },
  });
  const queuedNode = Object.freeze({
    ...node,
    attemptId: 'gpu-real-attempt-2',
    leaseGeneration: 2,
  });
  const queuedOutputRoot = path.join(root, 'queued-execution');
  const queuedComposition = composeCampaignGpuScientificExecution({
    outputRoot: queuedOutputRoot,
    runtimeRoot: root,
    plans: [executionPlan],
  });
  const queuedController = new AbortController();
  const queuedExecution = queuedComposition.execution.execute({
    campaign,
    node: queuedNode,
    plan: executionPlan,
    executionBudget: {
      absoluteDeadlineEpochMs: deadline,
      acquiredResources: GPU_SCIENTIFIC_CAMPAIGN_RESOURCE_BUDGET.nodeReservation,
    },
    executionSignal: queuedController.signal,
  });
  queuedController.abort('test-selector-wait-cancelled');
  await assert.rejects(queuedExecution,
    /gpu_selector_execution_lease_acquire_aborted/);
  assert.deepEqual(fs.readdirSync(queuedOutputRoot), []);
  const result = await firstExecution;
  const attemptAuthority = buildGpuScientificCampaignAttemptAuthority({
    campaign,
    node,
    plan: executionPlan,
  });
  const observedPde = result.taskResults[0].receipt;
  const resourceExhaustion = observedPde?.gpuReceipt?.workerReceipt?.exitCode === 125
    && /pthread_create failed: Resource temporarily unavailable/u.test(
      String(observedPde?.gpuReceipt?.workerReceipt?.stderr || ''),
    );
  if (resourceExhaustion) {
    t.skip('local OCI NVIDIA hook could not allocate a host thread');
    return;
  }
  assert.equal(verifyGpuScientificPdeTaskReceipt(observedPde, {
    task: executionPlan.tasks[0],
    gpuDeviceSelector: selectedGpu,
    deadline,
    executionAuthorityHash:
      attemptAuthority.gpuScientificCampaignAttemptAuthorityHash,
  }), true, JSON.stringify({
    scientificStatus: observedPde?.status,
    scientificBlockers: observedPde?.blockers,
    gpuStatus: observedPde?.gpuReceipt?.status,
    gpuBlockers: observedPde?.gpuReceipt?.blockers,
    gpuWorkerBlockers: observedPde?.gpuReceipt?.workerReceipt?.blockers,
    gpuWorkerStderr: observedPde?.gpuReceipt?.workerReceipt?.stderr,
    gpuWorkerExit: observedPde?.gpuReceipt?.workerReceipt?.exitCode,
    gpuDeadline: observedPde?.gpuReceipt?.absoluteDeadlineEpochMs,
    manifestVersion: observedPde?.gpuReceipt?.artifactManifest?.version,
    assuranceStatus: observedPde?.cpuOracleAssurance?.status,
    assuranceRuntimeImage: observedPde?.cpuOracleAssurance?.runtimeImageDigest,
    assurancePackage: observedPde?.cpuOracleAssurance?.runtimePackageClosureHash,
    assuranceOsImage:
      observedPde?.cpuOracleAssurance?.osSandboxWorkerReceipt?.containerImageDigest,
  }));
  assert.equal(result.status, 'gpu_scientific_campaign_execution_completed_non_promotable',
    JSON.stringify(result.blockers));
  assert.equal(verifyGpuScientificCampaignExecutionResult(result, {
    campaign, node, plan: executionPlan,
  }), true);
  assert.equal(result.promotionEligible, false);
  assert.equal(
    result.gpuScientificCampaignAttemptAuthorityHash,
    attemptAuthority.gpuScientificCampaignAttemptAuthorityHash,
  );
  assert.equal(
    result.taskResults[0].receipt.gpuReceipt.executionAuthorityHash,
    attemptAuthority.gpuScientificCampaignAttemptAuthorityHash,
  );
  assert.equal(
    result.taskResults[1].receipt.executionAuthorityHash,
    attemptAuthority.gpuScientificCampaignAttemptAuthorityHash,
  );
  const pdeLeaseBinding = result.taskResults[0].receipt.gpuReceipt
    .artifactManifest.osSandboxWorkerReceipt.gpuSelectorExecutionLeaseBinding;
  const deepLearningLeaseBinding = result.taskResults[1].receipt.workerReceipt
    .gpuSelectorExecutionLeaseBinding;
  assert.equal(pdeLeaseBinding.gpuSelectorExecutionLeaseReceipt.leaseId,
    deepLearningLeaseBinding.gpuSelectorExecutionLeaseReceipt.leaseId);
  assert.equal(pdeLeaseBinding.gpuSelectorExecutionLeaseReceipt
    .ownerAuthorityHash,
  attemptAuthority.gpuScientificCampaignAttemptAuthorityHash);
  assert.equal(pdeLeaseBinding.productionExclusivityClaimed, false);
  assert.equal(pdeLeaseBinding.multiTenantExclusivityClaimed, false);
  assert.equal(pdeLeaseBinding
    .dockerDeterministicContainerNameCrashRecoveryBackstopVerified, false);

  assert.throws(() => buildGpuScientificCampaignExecutionResult({
    campaign,
    node: queuedNode,
    plan: executionPlan,
    pdeScientificReceipt: result.taskResults[0].receipt,
    deepLearningTrainingReceipt: result.taskResults[1].receipt,
    effectiveExecutionDeadlineEpochMs: result.effectiveExecutionDeadlineEpochMs,
    executionStartedAtEpochMs: result.executionStartedAtEpochMs,
    executionCompletedAtEpochMs: result.executionCompletedAtEpochMs,
  }), /gpu_scientific_campaign_execution_lease_binding_invalid/);

  const pdeReceipt = result.taskResults[0].receipt;
  const dlReceipt = result.taskResults[1].receipt;
  const alternateDataset = trainingDataset('campaign-synthetic-xor-replay');
  const alternateGpuSelector = selectedGpu === GPU_UUID
    ? 'GPU-00000000-0000-0000-0000-000000000001'
    : GPU_UUID;
  const replayPlans = [
    plan({ deadline, gpuDeviceSelector: selectedGpu, pdeRunId: 'other-pde-run' }),
    plan({ deadline, gpuDeviceSelector: selectedGpu,
      selectedModelIr: modelIr({ modelId: 'other-model', seed: 18 }) }),
    plan({ deadline, gpuDeviceSelector: selectedGpu, dataset: alternateDataset }),
    plan({ deadline, gpuDeviceSelector: alternateGpuSelector }),
    plan({ deadline: deadline + 1, gpuDeviceSelector: selectedGpu }),
  ];
  for (const replayPlan of replayPlans) {
    const replayCampaign = Object.freeze({ ...campaign, spec: Object.freeze({
      ...campaign.spec, gpuScientificExecutionPlan: replayPlan,
    }) });
    const replayNode = Object.freeze({ ...node,
      nodeId: replayPlan.nodeId,
      gpuScientificExecutionPlanHash:
        replayPlan.gpuScientificCampaignExecutionPlanHash,
      gpuScientificResourceBudgetHash:
        GPU_SCIENTIFIC_CAMPAIGN_RESOURCE_BUDGET
          .gpuScientificCampaignResourceBudgetHash,
    });
    assert.throws(() => buildGpuScientificCampaignExecutionResult({
      campaign: replayCampaign,
      node: replayNode,
      plan: replayPlan,
      pdeScientificReceipt: pdeReceipt,
      deepLearningTrainingReceipt: dlReceipt,
      effectiveExecutionDeadlineEpochMs: replayPlan.absoluteExecutionDeadlineEpochMs,
      executionStartedAtEpochMs: result.executionStartedAtEpochMs,
      executionCompletedAtEpochMs: result.executionCompletedAtEpochMs,
    }), /gpu_scientific_campaign_execution_lease_binding_invalid/);
  }
});
