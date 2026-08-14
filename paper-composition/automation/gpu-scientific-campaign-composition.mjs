import fs from 'node:fs';
import path from 'node:path';

import {
  createCampaignGpuScientificExecutionAdapter,
} from '../../paper-adapters/automation/campaign-gpu-scientific-execution-adapter.mjs';
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

function createGpuSelectorExecutionLock() {
  const queues = new Map();
  return Object.freeze({
    acquire(selector, { signal = null, deadlineEpochMs = null } = {}) {
      const deadline = Number(deadlineEpochMs);
      const failure = (code, retryable) => {
        const error = new Error(code);
        error.retryable = retryable;
        return error;
      };
      if (signal?.aborted) {
        return Promise.reject(failure(
          'gpu_scientific_selector_lease_acquire_aborted',
          true,
        ));
      }
      if (Number.isSafeInteger(deadline) && deadline <= Date.now()) {
        return Promise.reject(failure(
          'gpu_scientific_selector_lease_deadline_exhausted',
          false,
        ));
      }
      return new Promise((resolve, reject) => {
        const queue = queues.get(selector) || [];
        const entry = {
          active: false,
          abort: null,
          timeout: null,
          grant: null,
        };
        const cleanupWait = () => {
          signal?.removeEventListener('abort', entry.abort);
          if (entry.timeout !== null) clearTimeout(entry.timeout);
          entry.timeout = null;
        };
        const removeWaiting = (error) => {
          if (entry.active) return;
          const active = queues.get(selector);
          const index = active?.indexOf(entry) ?? -1;
          if (index < 0) return;
          active.splice(index, 1);
          cleanupWait();
          if (!active.length) queues.delete(selector);
          else if (index === 0) active[0].grant();
          reject(error);
        };
        entry.abort = () => removeWaiting(failure(
          'gpu_scientific_selector_lease_acquire_aborted',
          true,
        ));
        entry.grant = () => {
          if (entry.active) return;
          entry.active = true;
          cleanupWait();
          let released = false;
          resolve(() => {
            if (released) return;
            released = true;
            const active = queues.get(selector);
            if (!active || active[0] !== entry) return;
            active.shift();
            if (!active.length) queues.delete(selector);
            else active[0].grant();
          });
        };
        signal?.addEventListener('abort', entry.abort, { once: true });
        if (Number.isSafeInteger(deadline)) {
          const waitMs = Math.max(1, deadline - Date.now());
          if (waitMs <= 2_147_483_647) {
            entry.timeout = setTimeout(() => removeWaiting(failure(
              'gpu_scientific_selector_lease_deadline_exhausted',
              false,
            )), waitMs);
          }
        }
        queue.push(entry);
        queues.set(selector, queue);
        if (queue.length === 1) entry.grant();
      });
    },
  });
}

const PROCESS_GPU_SELECTOR_EXECUTION_LOCK = createGpuSelectorExecutionLock();

export function composeCampaignGpuScientificExecution({
  outputRoot,
  plans = [],
} = {}) {
  if (!Array.isArray(plans) || !plans.length
    || plans.some((plan) => !verifyGpuScientificCampaignExecutionPlan(plan))) {
    throw new Error('gpu_scientific_campaign_verified_plans_required');
  }
  const root = preparePrivateDirectory(outputRoot);
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
        ...GPU_SCIENTIFIC_CAMPAIGN_RESOURCE_BUDGET.pdePoisson2d,
      });
      const deepLearning = composeCanonicalDeepLearningGpuTraining({
        outputRoot: preparePrivateDirectory(
          path.join(attemptRoot, 'deep-learning-cupy-mlp'),
        ),
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
      const selector = String(input?.plan?.gpuDeviceSelector || 'invalid');
      const deadlineEpochMs = Math.min(
        Number(input?.plan?.absoluteExecutionDeadlineEpochMs) || Number.MAX_SAFE_INTEGER,
        Number(input?.executionBudget?.absoluteDeadlineEpochMs) || Number.MAX_SAFE_INTEGER,
      );
      const release = await PROCESS_GPU_SELECTOR_EXECUTION_LOCK.acquire(selector, {
        signal: input.executionSignal || null,
        deadlineEpochMs,
      });
      try { return await baseExecution.execute(input); }
      finally { release(); }
    },
  });
  return Object.freeze({
    version: 1,
    kind: 'CampaignGpuScientificExecutionComposition',
    execution,
    productionPromotionEligible: false,
  });
}
