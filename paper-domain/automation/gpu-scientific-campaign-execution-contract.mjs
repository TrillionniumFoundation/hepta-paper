import { deepFreezeJsonValue } from '../../workflow-kernel/deep-freeze-json-value.mjs';
import { hasExactObjectKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  DETERMINISTIC_SUPERVISED_CLASSIFICATION_GPU_PROFILE,
  verifyDeterministicSupervisedClassificationGpuProfile,
} from '../research/deep-learning-gpu-profile-contract.mjs';
import {
  buildDeterministicSupervisedClassificationModelIr,
  verifyDeterministicSupervisedClassificationModelIr,
} from '../research/deep-learning-model-ir-contract.mjs';
import {
  verifyDeepLearningInlineTrainingDataset,
} from '../research/deep-learning-training-dataset-contract.mjs';
import {
  buildCanonicalParityDeepLearningTrainingDataset,
  buildCanonicalSyntheticDeepLearningDatasetAuthority,
  verifyCanonicalSyntheticDeepLearningDatasetAuthority,
} from '../research/deep-learning-training-dataset-authority-contract.mjs';
import {
  verifyGpuScientificDeepLearningTaskReceipt,
  verifyGpuScientificPdeTaskReceipt,
} from './gpu-scientific-campaign-evidence-verifier.mjs';
import {
  GPU_SELECTOR_EXECUTION_LEASE_SCOPE,
  verifyGpuSelectorExecutionLeaseReceipt,
  verifyGpuSelectorExecutionLeaseWorkerBinding,
} from './gpu-selector-execution-lease-contract.mjs';

const GPU_UUID = /^GPU-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,511}$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;

export const GPU_SCIENTIFIC_CAMPAIGN_NODE_KIND = 'gpu-scientific-execution';
export const GPU_SCIENTIFIC_CAMPAIGN_TASK_TYPES = Object.freeze([
  'pde-poisson-2d-gpu-v1',
  'deep-learning-cupy-mlp-v1',
]);
export const GPU_SCIENTIFIC_CAMPAIGN_NON_PROMOTION_BLOCKERS = Object.freeze([
  'gpu_scientific_external_production_qualification_authority_required',
  'gpu_scientific_release_manifest_authority_required',
  'gpu_scientific_independent_same_device_replay_authority_required',
]);

const GPU_SCIENTIFIC_RESOURCE_BUDGET_PAYLOAD = Object.freeze({
  version: 1,
  kind: 'GpuScientificCampaignResourceBudget',
  nodeReservation: Object.freeze({ agent: 0, cpu: 1, gpu: 1, memoryMiB: 8192 }),
  pdePoisson2d: Object.freeze({
    timeoutMs: 15 * 60 * 1_000,
    memoryBytes: 2 * 1024 ** 3,
    cpuSeconds: 900,
    maximumProcesses: 16,
    maximumOutputBytes: 8 * 1024 ** 2,
  }),
  deepLearning: Object.freeze({
    timeoutMs: 60 * 60 * 1_000,
    memoryBytes: 8 * 1024 ** 3,
    cpuSeconds: 3_600,
    maximumProcesses: 32,
    maximumOutputBytes: 2 * 1024 ** 3,
  }),
  schedulingSemantics: 'sequential-workers-reserve-maximum-memory-v1',
});
export const GPU_SCIENTIFIC_CAMPAIGN_RESOURCE_BUDGET = Object.freeze({
  ...GPU_SCIENTIFIC_RESOURCE_BUDGET_PAYLOAD,
  gpuScientificCampaignResourceBudgetHash: hashRecord(
    'GpuScientificCampaignResourceBudget',
    GPU_SCIENTIFIC_RESOURCE_BUDGET_PAYLOAD,
  ),
});

const PDE_TASK_KEYS = Object.freeze([
  'gpuScientificCampaignTaskHash', 'kind', 'runId', 'taskType', 'version',
]);
const DEEP_LEARNING_TASK_KEYS = Object.freeze([
  'gpuScientificCampaignTaskHash', 'kind', 'modelIr', 'modelIrHash',
  'profile', 'profileHash', 'taskType', 'trainingDataset',
  'trainingDatasetAuthority', 'trainingDatasetAuthorityHash',
  'trainingDatasetManifestHash', 'trainingRunId', 'version',
]);
const PLAN_KEYS = Object.freeze([
  'absoluteExecutionDeadlineEpochMs', 'campaignId', 'gpuDeviceSelector',
  'gpuScientificCampaignExecutionPlanHash', 'kind', 'nodeId', 'nodeKind',
  'paperId', 'promotionPolicy', 'resourceBudgetHash', 'sourceMutationPolicy',
  'status', 'taskSetHash', 'tasks', 'version',
]);
const TASK_RESULT_KEYS = Object.freeze([
  'blockers', 'kind', 'receipt', 'receiptHash', 'status', 'taskHash',
  'taskType', 'version',
]);
const RESULT_KEYS = Object.freeze([
  'absoluteExecutionDeadlineEpochMs', 'attemptId', 'blockers', 'campaignId',
  'campaignPlanHash', 'effectiveExecutionDeadlineEpochMs', 'executionCompletedAtEpochMs',
  'executionPlanHash', 'executionStartedAtEpochMs', 'externalActionPerformed',
  'gpuScientificCampaignAttemptAuthorityHash',
  'gpuScientificCampaignExecutionResultHash', 'kind', 'leaseGeneration',
  'networkActionPerformed', 'nodeId', 'nodeKind', 'paperId',
  'productionQualified', 'promotionEligible', 'status', 'taskResultHashes',
  'taskResults', 'taskSetHash', 'version',
]);

function requiredId(value, error) {
  const selected = String(value || '').trim();
  if (!SAFE_ID.test(selected)) throw new Error(error);
  return selected;
}

function frozenClone(value, error) {
  try { return deepFreezeJsonValue(structuredClone(value)); }
  catch { throw new Error(error); }
}

export function gpuScientificCampaignNodeId(campaignId) {
  return `${requiredId(campaignId, 'gpu_scientific_campaign_id_invalid')}:0:${GPU_SCIENTIFIC_CAMPAIGN_NODE_KIND}`;
}

export function gpuScientificCampaignNodeBinding(node = {}) {
  const persisted = node?.spec && typeof node.spec === 'object'
    && !Array.isArray(node.spec) ? node.spec : {};
  return Object.freeze({
    executionPlanHash:
      node?.gpuScientificExecutionPlanHash
      ?? persisted.gpuScientificExecutionPlanHash
      ?? null,
    resourceBudgetHash:
      node?.gpuScientificResourceBudgetHash
      ?? persisted.gpuScientificResourceBudgetHash
      ?? null,
  });
}

export function buildGpuScientificCampaignAttemptAuthority({
  campaign,
  node,
  plan,
} = {}) {
  const nodeBinding = gpuScientificCampaignNodeBinding(node);
  if (!verifyGpuScientificCampaignExecutionPlan(plan, {
    campaignId: campaign?.campaignId,
    paperId: campaign?.paperId,
    nodeId: node?.nodeId,
  })
    || node?.kind !== GPU_SCIENTIFIC_CAMPAIGN_NODE_KIND
    || nodeBinding.executionPlanHash
      !== plan.gpuScientificCampaignExecutionPlanHash
    || nodeBinding.resourceBudgetHash
      !== GPU_SCIENTIFIC_CAMPAIGN_RESOURCE_BUDGET
        .gpuScientificCampaignResourceBudgetHash
    || !SAFE_ID.test(String(node?.attemptId || ''))
    || !Number.isSafeInteger(node?.leaseGeneration)
    || node.leaseGeneration < 1
    || !SHA256.test(String(campaign?.spec?.campaignPlanHash || ''))) {
    throw new Error('gpu_scientific_campaign_attempt_authority_invalid');
  }
  const payload = {
    version: 1,
    kind: 'GpuScientificCampaignAttemptAuthority',
    campaignId: campaign.campaignId,
    paperId: campaign.paperId,
    campaignPlanHash: campaign.spec.campaignPlanHash,
    nodeId: node.nodeId,
    nodeKind: node.kind,
    attemptId: node.attemptId,
    leaseGeneration: node.leaseGeneration,
    executionPlanHash: plan.gpuScientificCampaignExecutionPlanHash,
    taskSetHash: plan.taskSetHash,
    gpuDeviceSelector: plan.gpuDeviceSelector,
    absoluteExecutionDeadlineEpochMs: plan.absoluteExecutionDeadlineEpochMs,
  };
  return Object.freeze({
    ...payload,
    gpuScientificCampaignAttemptAuthorityHash:
      hashRecord('GpuScientificCampaignAttemptAuthority', payload),
  });
}

export function buildCanonicalGpuScientificCampaignExecutionPlan({
  campaignId,
  paperId,
  gpuDeviceSelector,
  absoluteExecutionDeadlineEpochMs,
} = {}) {
  const identity = hashRecord('CanonicalGpuScientificCampaignTaskIdentity', {
    campaignId,
    paperId,
  }).slice('sha256:'.length, 'sha256:'.length + 24);
  const datasetId = `gpu-campaign-${identity}-parity`;
  const trainingDataset = buildCanonicalParityDeepLearningTrainingDataset({
    datasetId,
    featureCount: 2,
  });
  const modelIr = buildDeterministicSupervisedClassificationModelIr({
    modelId: `gpu-campaign-${identity}-mlp`,
    profileHash:
      DETERMINISTIC_SUPERVISED_CLASSIFICATION_GPU_PROFILE.deepLearningGpuProfileHash,
    inputFeatureCount: 2,
    classCount: 2,
    layers: [
      Object.freeze({
        layerId: 'hidden', type: 'dense', inputUnits: 2, outputUnits: 4,
        activation: 'relu', useBias: true,
      }),
      Object.freeze({
        layerId: 'logits', type: 'dense', inputUnits: 4, outputUnits: 2,
        activation: 'identity', useBias: true,
      }),
    ],
    training: Object.freeze({
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
    }),
    seed: 1701,
  });
  return buildGpuScientificCampaignExecutionPlan({
    campaignId,
    paperId,
    gpuDeviceSelector,
    absoluteExecutionDeadlineEpochMs,
    pde: { runId: `gpu-campaign-${identity}-poisson` },
    deepLearning: {
      trainingRunId: `gpu-campaign-${identity}-training`,
      profile: DETERMINISTIC_SUPERVISED_CLASSIFICATION_GPU_PROFILE,
      modelIr,
      trainingDataset,
      trainingDatasetAuthority: buildCanonicalSyntheticDeepLearningDatasetAuthority({
        trainingDataset,
        generatorSpec: { datasetId, featureCount: 2 },
      }),
    },
  });
}

export function buildPdePoisson2dGpuCampaignTask({ runId } = {}) {
  const payload = {
    version: 1,
    kind: 'GpuScientificCampaignTask',
    taskType: GPU_SCIENTIFIC_CAMPAIGN_TASK_TYPES[0],
    runId: requiredId(runId, 'gpu_scientific_pde_run_id_invalid'),
  };
  return Object.freeze({
    ...payload,
    gpuScientificCampaignTaskHash: hashRecord('GpuScientificCampaignTask', payload),
  });
}

export function buildDeepLearningCupyMlpCampaignTask({
  trainingRunId,
  profile,
  modelIr,
  trainingDataset,
  trainingDatasetAuthority,
} = {}) {
  const canonicalProfile = frozenClone(profile, 'gpu_scientific_deep_learning_profile_invalid');
  const canonicalModelIr = frozenClone(modelIr, 'gpu_scientific_deep_learning_model_ir_invalid');
  const canonicalTrainingDataset = frozenClone(
    trainingDataset,
    'gpu_scientific_deep_learning_training_dataset_invalid',
  );
  const canonicalTrainingDatasetAuthority = frozenClone(
    trainingDatasetAuthority,
    'gpu_scientific_deep_learning_training_dataset_authority_invalid',
  );
  if (!verifyDeterministicSupervisedClassificationGpuProfile(canonicalProfile)
    || JSON.stringify(canonicalProfile)
      !== JSON.stringify(DETERMINISTIC_SUPERVISED_CLASSIFICATION_GPU_PROFILE)
    || !verifyDeterministicSupervisedClassificationModelIr(canonicalModelIr)
    || canonicalModelIr.profileHash !== canonicalProfile.deepLearningGpuProfileHash
    || !verifyDeepLearningInlineTrainingDataset(canonicalTrainingDataset)
    || !verifyCanonicalSyntheticDeepLearningDatasetAuthority(
      canonicalTrainingDatasetAuthority,
      { trainingDataset: canonicalTrainingDataset },
    )
    || canonicalTrainingDataset.featureCount !== canonicalModelIr.inputFeatureCount
    || canonicalTrainingDataset.classCount !== canonicalModelIr.classCount) {
    throw new Error('gpu_scientific_deep_learning_task_invalid');
  }
  const payload = {
    version: 1,
    kind: 'GpuScientificCampaignTask',
    taskType: GPU_SCIENTIFIC_CAMPAIGN_TASK_TYPES[1],
    trainingRunId: requiredId(
      trainingRunId,
      'gpu_scientific_deep_learning_training_run_id_invalid',
    ),
    profile: canonicalProfile,
    profileHash: canonicalProfile.deepLearningGpuProfileHash,
    modelIr: canonicalModelIr,
    modelIrHash: canonicalModelIr.deepLearningModelIrHash,
    trainingDataset: canonicalTrainingDataset,
    trainingDatasetAuthority: canonicalTrainingDatasetAuthority,
    trainingDatasetAuthorityHash:
      canonicalTrainingDatasetAuthority.deepLearningTrainingDatasetAuthorityHash,
    trainingDatasetManifestHash:
      canonicalTrainingDataset.deepLearningTrainingDatasetManifestHash,
  };
  return Object.freeze({
    ...payload,
    gpuScientificCampaignTaskHash: hashRecord('GpuScientificCampaignTask', payload),
  });
}

export function verifyGpuScientificCampaignTask(value) {
  try {
    if (value?.taskType === GPU_SCIENTIFIC_CAMPAIGN_TASK_TYPES[0]) {
      return hasExactObjectKeys(value, PDE_TASK_KEYS)
        && JSON.stringify(buildPdePoisson2dGpuCampaignTask(value))
          === JSON.stringify(value);
    }
    if (value?.taskType === GPU_SCIENTIFIC_CAMPAIGN_TASK_TYPES[1]) {
      return hasExactObjectKeys(value, DEEP_LEARNING_TASK_KEYS)
        && JSON.stringify(buildDeepLearningCupyMlpCampaignTask(value))
          === JSON.stringify(value);
    }
  } catch { /* invalid */ }
  return false;
}

function canonicalTasks({ pde, deepLearning, tasks } = {}) {
  const selected = tasks || [
    buildPdePoisson2dGpuCampaignTask(pde),
    buildDeepLearningCupyMlpCampaignTask(deepLearning),
  ];
  if (!Array.isArray(selected) || selected.length !== 2
    || selected.some((task) => !verifyGpuScientificCampaignTask(task))
    || selected.some((task, index) => (
      task.taskType !== GPU_SCIENTIFIC_CAMPAIGN_TASK_TYPES[index]
    ))) {
    throw new Error('gpu_scientific_campaign_task_set_invalid');
  }
  return Object.freeze(selected.map((task) => frozenClone(
    task,
    'gpu_scientific_campaign_task_set_invalid',
  )));
}

function taskSetHash(tasks) {
  return hashRecord('GpuScientificCampaignTaskSet', {
    taskTypes: GPU_SCIENTIFIC_CAMPAIGN_TASK_TYPES,
    taskHashes: tasks.map((task) => task.gpuScientificCampaignTaskHash),
  });
}

export function buildGpuScientificCampaignExecutionPlan({
  campaignId,
  paperId,
  nodeId = null,
  gpuDeviceSelector,
  absoluteExecutionDeadlineEpochMs,
  pde,
  deepLearning,
  tasks = null,
} = {}) {
  const selectedCampaignId = requiredId(campaignId, 'gpu_scientific_campaign_id_invalid');
  const selectedPaperId = requiredId(paperId, 'gpu_scientific_paper_id_invalid');
  const expectedNodeId = gpuScientificCampaignNodeId(selectedCampaignId);
  const selectedNodeId = requiredId(nodeId || expectedNodeId, 'gpu_scientific_node_id_invalid');
  const selectedDeadline = Number(absoluteExecutionDeadlineEpochMs);
  if (selectedNodeId !== expectedNodeId
    || !GPU_UUID.test(String(gpuDeviceSelector || ''))
    || !Number.isSafeInteger(selectedDeadline) || selectedDeadline < 1) {
    throw new Error('gpu_scientific_campaign_execution_plan_invalid');
  }
  const canonicalTaskSet = canonicalTasks({ pde, deepLearning, tasks });
  const payload = {
    version: 1,
    kind: 'GpuScientificCampaignExecutionPlan',
    status: 'gpu_scientific_campaign_execution_planned_non_promotable',
    campaignId: selectedCampaignId,
    paperId: selectedPaperId,
    nodeId: selectedNodeId,
    nodeKind: GPU_SCIENTIFIC_CAMPAIGN_NODE_KIND,
    gpuDeviceSelector,
    absoluteExecutionDeadlineEpochMs: selectedDeadline,
    tasks: canonicalTaskSet,
    taskSetHash: taskSetHash(canonicalTaskSet),
    resourceBudgetHash:
      GPU_SCIENTIFIC_CAMPAIGN_RESOURCE_BUDGET.gpuScientificCampaignResourceBudgetHash,
    sourceMutationPolicy: 'forbid',
    promotionPolicy: 'external-authorities-required-before-release-v1',
  };
  return Object.freeze({
    ...payload,
    gpuScientificCampaignExecutionPlanHash:
      hashRecord('GpuScientificCampaignExecutionPlan', payload),
  });
}

export function verifyGpuScientificCampaignExecutionPlan(value, expected = {}) {
  if (!hasExactObjectKeys(value, PLAN_KEYS)) return false;
  try {
    const rebuilt = buildGpuScientificCampaignExecutionPlan({
      ...value,
      tasks: value.tasks,
      nodeId: value.nodeId,
    });
    return JSON.stringify(rebuilt) === JSON.stringify(value)
      && (!expected.campaignId || value.campaignId === expected.campaignId)
      && (!expected.paperId || value.paperId === expected.paperId)
      && (!expected.nodeId || value.nodeId === expected.nodeId);
  } catch { return false; }
}

export function requireGpuScientificCampaignExecutionPlan(value, {
  campaignId,
  paperId,
  mode,
} = {}) {
  if (value === null || value === undefined) return null;
  if (mode !== 'full-campaign'
    || !verifyGpuScientificCampaignExecutionPlan(value, {
      campaignId,
      paperId,
      nodeId: gpuScientificCampaignNodeId(campaignId),
    })) {
    throw new Error('campaign_gpu_scientific_execution_plan_invalid');
  }
  return value;
}

function buildTaskResult(task, receipt, binding) {
  const valid = task.taskType === GPU_SCIENTIFIC_CAMPAIGN_TASK_TYPES[0]
    ? verifyGpuScientificPdeTaskReceipt(receipt, { task, ...binding })
    : verifyGpuScientificDeepLearningTaskReceipt(receipt, { task, ...binding });
  const receiptHash = task.taskType === GPU_SCIENTIFIC_CAMPAIGN_TASK_TYPES[0]
    ? receipt?.canonicalPdePoisson2dGpuScientificReceiptHash || null
    : receipt?.canonicalCupyDeepLearningTrainingReceiptHash || null;
  const payload = {
    version: 1,
    kind: 'GpuScientificCampaignTaskResult',
    taskType: task.taskType,
    taskHash: task.gpuScientificCampaignTaskHash,
    status: valid
      ? 'gpu_scientific_campaign_task_completed_non_promotable'
      : 'gpu_scientific_campaign_task_blocked',
    receiptHash,
    receipt: receipt || null,
    blockers: Object.freeze(valid
      ? [...new Set(receipt.blockers.map(String))]
      : [`gpu_scientific_${task.taskType}_receipt_invalid`]),
  };
  return Object.freeze({
    ...payload,
    gpuScientificCampaignTaskResultHash:
      hashRecord('GpuScientificCampaignTaskResult', payload),
  });
}

function gpuScientificTaskWorkerReceipt(taskType, receipt) {
  return taskType === GPU_SCIENTIFIC_CAMPAIGN_TASK_TYPES[0]
    ? receipt?.gpuReceipt?.artifactManifest?.osSandboxWorkerReceipt || null
    : receipt?.workerReceipt || null;
}

function campaignAttemptLeaseReceipt(workerReceipt, {
  gpuDeviceSelector,
  absoluteDeadlineEpochMs,
  ownerAuthorityHash,
} = {}) {
  if (!workerReceipt) {
    throw new Error(
      'gpu_scientific_campaign_execution_lease_binding_invalid',
    );
  }
  const binding = workerReceipt.gpuSelectorExecutionLeaseBinding;
  const acquisitionReceipt = binding?.gpuSelectorExecutionLeaseReceipt;
  if (!verifyGpuSelectorExecutionLeaseWorkerBinding(binding, { workerReceipt })
    || workerReceipt.gpuSelectorExecutionLeaseBindingHash
      !== binding?.gpuSelectorExecutionLeaseBindingHash
    || !verifyGpuSelectorExecutionLeaseReceipt(acquisitionReceipt)
    || binding.gpuSelectorExecutionLeaseReceiptHash
      !== acquisitionReceipt.gpuSelectorExecutionLeaseReceiptHash
    || binding.gpuDeviceSelector !== gpuDeviceSelector
    || acquisitionReceipt.gpuDeviceSelector !== gpuDeviceSelector
    || binding.absoluteDeadlineEpochMs !== absoluteDeadlineEpochMs
    || acquisitionReceipt.absoluteDeadlineEpochMs
      !== absoluteDeadlineEpochMs
    || acquisitionReceipt.scope !== GPU_SELECTOR_EXECUTION_LEASE_SCOPE
    || acquisitionReceipt.ownerAuthorityHash !== ownerAuthorityHash) {
    throw new Error(
      'gpu_scientific_campaign_execution_lease_binding_invalid',
    );
  }
  return acquisitionReceipt;
}

function requireSharedCampaignAttemptLease({
  pdeScientificReceipt,
  deepLearningTrainingReceipt,
  gpuDeviceSelector,
  absoluteDeadlineEpochMs,
  ownerAuthorityHash,
} = {}) {
  const expected = {
    gpuDeviceSelector,
    absoluteDeadlineEpochMs,
    ownerAuthorityHash,
  };
  const pdeAcquisitionReceipt = campaignAttemptLeaseReceipt(
    gpuScientificTaskWorkerReceipt(
      GPU_SCIENTIFIC_CAMPAIGN_TASK_TYPES[0],
      pdeScientificReceipt,
    ),
    expected,
  );
  const deepLearningAcquisitionReceipt = campaignAttemptLeaseReceipt(
    gpuScientificTaskWorkerReceipt(
      GPU_SCIENTIFIC_CAMPAIGN_TASK_TYPES[1],
      deepLearningTrainingReceipt,
    ),
    expected,
  );
  const sharedFields = [
    'gpuDeviceSelector',
    'selectorKeyHash',
    'ownerAuthorityHash',
    'leaseId',
    'fencingToken',
    'lockScopeIdentityHash',
    'lockIdentityHash',
    'mechanism',
    'scope',
    'requestedAtEpochMs',
    'acquiredAtEpochMs',
    'absoluteDeadlineEpochMs',
    'productionExclusivityClaimed',
    'gpuSelectorExecutionLeaseReceiptHash',
  ];
  if (sharedFields.some((field) => (
    pdeAcquisitionReceipt[field] !== deepLearningAcquisitionReceipt[field]
  )) || JSON.stringify(pdeAcquisitionReceipt)
    !== JSON.stringify(deepLearningAcquisitionReceipt)) {
    throw new Error(
      'gpu_scientific_campaign_execution_lease_binding_invalid',
    );
  }
}

export function buildGpuScientificCampaignExecutionResult({
  campaign,
  node,
  plan,
  pdeScientificReceipt,
  deepLearningTrainingReceipt,
  effectiveExecutionDeadlineEpochMs,
  executionStartedAtEpochMs,
  executionCompletedAtEpochMs,
} = {}) {
  const nodeBinding = gpuScientificCampaignNodeBinding(node);
  if (!verifyGpuScientificCampaignExecutionPlan(plan, {
    campaignId: campaign?.campaignId,
    paperId: campaign?.paperId,
    nodeId: node?.nodeId,
  }) || node?.kind !== GPU_SCIENTIFIC_CAMPAIGN_NODE_KIND
    || nodeBinding.executionPlanHash
      !== plan.gpuScientificCampaignExecutionPlanHash
    || nodeBinding.resourceBudgetHash
      !== GPU_SCIENTIFIC_CAMPAIGN_RESOURCE_BUDGET
        .gpuScientificCampaignResourceBudgetHash
    || !SAFE_ID.test(String(node?.attemptId || ''))
    || !Number.isSafeInteger(node?.leaseGeneration) || node.leaseGeneration < 1
    || !SHA256.test(String(campaign?.spec?.campaignPlanHash || ''))) {
    throw new Error('gpu_scientific_campaign_execution_binding_invalid');
  }
  const attemptAuthority = buildGpuScientificCampaignAttemptAuthority({
    campaign,
    node,
    plan,
  });
  const effectiveDeadline = Number(effectiveExecutionDeadlineEpochMs);
  const startedAt = Number(executionStartedAtEpochMs);
  const completedAt = Number(executionCompletedAtEpochMs);
  if (![effectiveDeadline, startedAt, completedAt].every(Number.isSafeInteger)
    || effectiveDeadline < 1 || effectiveDeadline > plan.absoluteExecutionDeadlineEpochMs
    || startedAt < 0 || completedAt < startedAt) {
    throw new Error('gpu_scientific_campaign_execution_timing_invalid');
  }
  const taskResults = Object.freeze([
    buildTaskResult(plan.tasks[0], pdeScientificReceipt, {
      gpuDeviceSelector: plan.gpuDeviceSelector,
      deadline: effectiveDeadline,
      executionAuthorityHash:
        attemptAuthority.gpuScientificCampaignAttemptAuthorityHash,
    }),
    buildTaskResult(plan.tasks[1], deepLearningTrainingReceipt, {
      gpuDeviceSelector: plan.gpuDeviceSelector,
      deadline: effectiveDeadline,
      executionAuthorityHash:
        attemptAuthority.gpuScientificCampaignAttemptAuthorityHash,
    }),
  ]);
  const taskWorkerReceipts = [
    gpuScientificTaskWorkerReceipt(
      GPU_SCIENTIFIC_CAMPAIGN_TASK_TYPES[0],
      pdeScientificReceipt,
    ),
    gpuScientificTaskWorkerReceipt(
      GPU_SCIENTIFIC_CAMPAIGN_TASK_TYPES[1],
      deepLearningTrainingReceipt,
    ),
  ];
  const completedTaskSet = taskResults.every((result) => (
    result.status === 'gpu_scientific_campaign_task_completed_non_promotable'
  ));
  const selectorLeaseEvidencePresent = taskWorkerReceipts.some((workerReceipt) => (
    workerReceipt?.gpuSelectorExecutionLeaseBinding !== undefined
      || workerReceipt?.gpuSelectorExecutionLeaseBindingHash !== undefined
  ));
  if (completedTaskSet || selectorLeaseEvidencePresent) {
    requireSharedCampaignAttemptLease({
      pdeScientificReceipt,
      deepLearningTrainingReceipt,
      gpuDeviceSelector: plan.gpuDeviceSelector,
      absoluteDeadlineEpochMs: effectiveDeadline,
      ownerAuthorityHash:
        attemptAuthority.gpuScientificCampaignAttemptAuthorityHash,
    });
  }
  const taskBlockers = taskResults.flatMap((result) => result.blockers);
  const deadlineExceeded = completedAt >= effectiveDeadline;
  const completed = completedTaskSet && !deadlineExceeded;
  const blockers = Object.freeze([...new Set([
    ...GPU_SCIENTIFIC_CAMPAIGN_NON_PROMOTION_BLOCKERS,
    ...taskBlockers,
    ...(deadlineExceeded ? ['gpu_scientific_absolute_execution_deadline_exceeded'] : []),
  ])]);
  const payload = {
    version: 1,
    kind: 'GpuScientificCampaignExecutionResult',
    status: completed
      ? 'gpu_scientific_campaign_execution_completed_non_promotable'
      : 'gpu_scientific_campaign_execution_blocked',
    campaignId: campaign.campaignId,
    paperId: campaign.paperId,
    campaignPlanHash: campaign.spec.campaignPlanHash,
    nodeId: node.nodeId,
    nodeKind: node.kind,
    attemptId: node.attemptId,
    leaseGeneration: node.leaseGeneration,
    gpuScientificCampaignAttemptAuthorityHash:
      attemptAuthority.gpuScientificCampaignAttemptAuthorityHash,
    executionPlanHash: plan.gpuScientificCampaignExecutionPlanHash,
    taskSetHash: plan.taskSetHash,
    absoluteExecutionDeadlineEpochMs: plan.absoluteExecutionDeadlineEpochMs,
    effectiveExecutionDeadlineEpochMs: effectiveDeadline,
    executionStartedAtEpochMs: startedAt,
    executionCompletedAtEpochMs: completedAt,
    taskResultHashes: Object.freeze(taskResults.map((result) => (
      result.gpuScientificCampaignTaskResultHash
    ))),
    taskResults,
    productionQualified: false,
    promotionEligible: false,
    blockers,
    networkActionPerformed: false,
    externalActionPerformed: false,
  };
  return Object.freeze({
    ...payload,
    gpuScientificCampaignExecutionResultHash:
      hashRecord('GpuScientificCampaignExecutionResult', payload),
  });
}

export function verifyGpuScientificCampaignExecutionResult(value, {
  campaign,
  node,
  plan,
  requirePromotionEligible = false,
} = {}) {
  const { workspaceAttemptIntegration: _integration, ...semantic } = value || {};
  if (!hasExactObjectKeys(semantic, RESULT_KEYS)
    || requirePromotionEligible || semantic.promotionEligible !== false
    || semantic.productionQualified !== false
    || semantic.networkActionPerformed !== false
    || semantic.externalActionPerformed !== false
    || !Array.isArray(semantic.taskResults)
    || semantic.taskResults.length !== 2
    || semantic.taskResults.some((result) => !hasExactObjectKeys(
      result,
      [...TASK_RESULT_KEYS, 'gpuScientificCampaignTaskResultHash'],
    ))) return false;
  try {
    const rebuilt = buildGpuScientificCampaignExecutionResult({
      campaign,
      node,
      plan,
      pdeScientificReceipt: semantic.taskResults[0].receipt,
      deepLearningTrainingReceipt: semantic.taskResults[1].receipt,
      effectiveExecutionDeadlineEpochMs:
        semantic.effectiveExecutionDeadlineEpochMs,
      executionStartedAtEpochMs: semantic.executionStartedAtEpochMs,
      executionCompletedAtEpochMs: semantic.executionCompletedAtEpochMs,
    });
    return JSON.stringify(rebuilt) === JSON.stringify(semantic);
  } catch { return false; }
}
