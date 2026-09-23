import fs from 'node:fs';
import path from 'node:path';

import {
  createCampaignGpuScientificExecutionAdapter,
} from '../../paper-adapters/automation/campaign-gpu-scientific-execution-adapter.mjs';
import {
  createGpuSelectorExecutionLeaseRepository,
  gpuSelectorExecutionLeaseRootForRuntime,
} from '../../paper-adapters/runtime/gpu-selector-execution-lease-repository.mjs';
import {
  GPU_SCIENTIFIC_CAMPAIGN_RESOURCE_BUDGET,
  buildGpuScientificCampaignAttemptAuthority,
  verifyGpuScientificCampaignExecutionPlan,
} from '../../paper-domain/automation/gpu-scientific-campaign-execution-contract.mjs';
import {
  composeCanonicalDeepLearningGpuTraining,
} from './deep-learning-gpu-training-composition.mjs';
import {
  composeCanonicalPdePoisson2dGpuSolver,
} from './pde-poisson-2d-gpu-composition.mjs';
import {
  safeRetentionNodeKey,
} from '../../paper-adapters/automation/runtime-retention-scope-repository.mjs';
import {
  createDockerWorkerGpuSelectorLeaseStaleRecovery,
} from '../../paper-adapters/runtime/os-sandbox-worker-gpu-selector-lease.mjs';

function preparePrivateDirectory(selected) {
  if (typeof selected !== 'string' || !path.isAbsolute(selected)) {
    throw new Error('gpu_scientific_campaign_output_root_absolute_required');
  }
  const root = path.normalize(selected);
  if (root === path.parse(root).root) {
    throw new Error('gpu_scientific_campaign_output_root_unsafe');
  }
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const identity = fs.lstatSync(root);
  if (!identity.isDirectory() || identity.isSymbolicLink()
    || fs.realpathSync.native(root) !== root
    || (typeof process.geteuid === 'function' && identity.uid !== process.geteuid())
    || (identity.mode & 0o077) !== 0) {
    throw new Error('gpu_scientific_campaign_output_root_unsafe');
  }
  return root;
}

export function composeCampaignGpuScientificExecution({
  outputRoot,
  runtimeRoot,
  plans = [],
  docker = 'docker',
  dockerContainerRecoveryExecutor = null,
  environment = process.env,
} = {}) {
  if (!Array.isArray(plans) || !plans.length
    || plans.some((plan) => !verifyGpuScientificCampaignExecutionPlan(plan))) {
    throw new Error('gpu_scientific_campaign_verified_plans_required');
  }
  const root = preparePrivateDirectory(outputRoot);
  const selectorExecutionLeases = createGpuSelectorExecutionLeaseRepository({
    root: gpuSelectorExecutionLeaseRootForRuntime(runtimeRoot),
    recoverStaleState: createDockerWorkerGpuSelectorLeaseStaleRecovery({
      docker,
      dockerContainerRecoveryExecutor,
      environment,
    }),
  });
  const allowedPlanHashes = new Set(plans.map(
    (plan) => plan.gpuScientificCampaignExecutionPlanHash,
  ));
  const baseExecution = createCampaignGpuScientificExecutionAdapter({
    executionFactory({ campaign, node, plan }) {
      if (!allowedPlanHashes.has(plan?.gpuScientificCampaignExecutionPlanHash)) {
        throw new Error('gpu_scientific_campaign_runtime_plan_not_configured');
      }
      const attemptAuthority = buildGpuScientificCampaignAttemptAuthority({
        campaign,
        node,
        plan,
      });
      const campaignRoot = preparePrivateDirectory(path.join(
        root,
        safeRetentionNodeKey(campaign.campaignId),
      ));
      const attemptRoot = preparePrivateDirectory(path.join(
        campaignRoot,
        `gpu-scientific-attempt-${attemptAuthority
          .gpuScientificCampaignAttemptAuthorityHash.slice('sha256:'.length)}`,
      ));
      const pde = composeCanonicalPdePoisson2dGpuSolver({
        outputRoot: preparePrivateDirectory(path.join(attemptRoot, 'pde-poisson-2d')),
        runtimeRoot,
        ...GPU_SCIENTIFIC_CAMPAIGN_RESOURCE_BUDGET.pdePoisson2d,
      });
      const deepLearning = composeCanonicalDeepLearningGpuTraining({
        outputRoot: preparePrivateDirectory(
          path.join(attemptRoot, 'deep-learning-cupy-mlp'),
        ),
        runtimeRoot,
        ...GPU_SCIENTIFIC_CAMPAIGN_RESOURCE_BUDGET.deepLearning,
      });
      return Object.freeze({
        pdeScientificExecution: pde,
        deepLearningTrainingExecutor: deepLearning.trainingExecutor,
      });
    },
  });
  const execution = Object.freeze({
    ...baseExecution,
    async execute(input = {}) {
      const attemptAuthority = buildGpuScientificCampaignAttemptAuthority({
        campaign: input.campaign,
        node: input.node,
        plan: input.plan,
      });
      const deadlineEpochMs = Math.min(
        Number(input?.plan?.absoluteExecutionDeadlineEpochMs) || Number.MAX_SAFE_INTEGER,
        Number(input?.executionBudget?.absoluteDeadlineEpochMs) || Number.MAX_SAFE_INTEGER,
      );
      return selectorExecutionLeases.withLease({
        gpuDeviceSelector: input?.plan?.gpuDeviceSelector,
        ownerAuthorityHash:
          attemptAuthority.gpuScientificCampaignAttemptAuthorityHash,
        absoluteDeadlineEpochMs: deadlineEpochMs,
        signal: input.executionSignal || null,
      }, (lease) => baseExecution.execute({
        ...input,
        gpuSelectorExecutionLeaseDelegation: lease.workerDelegation(),
      }));
    },
  });
  return Object.freeze({
    version: 1,
    kind: 'CampaignGpuScientificExecutionComposition',
    execution,
    productionPromotionEligible: false,
  });
}
