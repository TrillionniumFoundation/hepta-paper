import {
  GPU_SCIENTIFIC_CAMPAIGN_RESOURCE_BUDGET,
  buildGpuScientificCampaignAttemptAuthority,
  buildGpuScientificCampaignExecutionResult,
  gpuScientificCampaignNodeBinding,
  verifyGpuScientificCampaignExecutionPlan,
} from '../../paper-domain/automation/gpu-scientific-campaign-execution-contract.mjs';
import {
  assertCampaignGpuScientificExecutionPort,
} from '../../paper-ports/campaign-gpu-scientific-execution-port.mjs';
import {
  assertDeepLearningGpuTrainingExecutorPort,
} from '../../paper-ports/deep-learning-gpu-training-ports.mjs';
import { readTrustedWallClockEpochMs } from '../runtime/trusted-wall-clock.mjs';
import {
  verifyCanonicalCupyDeepLearningTrainingReceipt,
} from '../research-verify/canonical-cupy-deep-learning-training-executor.mjs';
import {
  buildCanonicalDeepLearningCampaignTaskAttestation,
} from './canonical-deep-learning-campaign-task-attestation.mjs';

function assertPdeScientificExecution(value) {
  if (value?.version !== 1
    || value?.kind !== 'CanonicalPdePoisson2dGpuComposition'
    || typeof value?.executeAndVerify !== 'function') {
    throw new Error('canonical_pde_poisson_2d_gpu_scientific_execution_required');
  }
  return value;
}

const TERMINAL_EXECUTION_BLOCKER_FRAGMENTS = Object.freeze([
  'input_invalid',
  'deadline_exhausted',
  'deadline_exceeded',
  'output_preexists',
  'runtime_identity_invalid',
  'memory_capacity_insufficient',
  'artifact_invalid',
  'artifact_verification_failed',
  'receipt_invalid',
]);

function gpuTaskExecutionError(taskType, receipt, cause = null) {
  const blockers = Array.isArray(receipt?.blockers)
    ? receipt.blockers.map(String) : [];
  const detail = blockers.join(',') || cause?.message || receipt?.status || 'unknown';
  const error = new Error(`gpu_scientific_campaign_${taskType}_execution_blocked:${detail}`);
  error.retryable = cause?.retryable === false ? false
    : !blockers.some((blocker) => TERMINAL_EXECUTION_BLOCKER_FRAGMENTS.some(
      (fragment) => blocker.includes(fragment),
    ));
  error.receipt = receipt || cause?.receipt || null;
  if (cause) error.cause = cause;
  return error;
}

export function createCampaignGpuScientificExecutionAdapter({
  pdeScientificExecution,
  deepLearningTrainingExecutor,
  executionFactory = null,
} = {}) {
  if (executionFactory !== null && typeof executionFactory !== 'function') {
    throw new Error('gpu_scientific_campaign_execution_factory_invalid');
  }
  if (executionFactory !== null
    && (pdeScientificExecution !== undefined
      || deepLearningTrainingExecutor !== undefined)) {
    throw new Error('gpu_scientific_campaign_execution_factory_ambiguous');
  }
  const fixedExecution = executionFactory === null ? Object.freeze({
    pde: assertPdeScientificExecution(pdeScientificExecution),
    deepLearning: assertDeepLearningGpuTrainingExecutorPort(
      deepLearningTrainingExecutor,
    ),
  }) : null;
  function resolveExecution(input) {
    if (fixedExecution) return fixedExecution;
    const selected = executionFactory(input);
    return Object.freeze({
      pde: assertPdeScientificExecution(selected?.pdeScientificExecution),
      deepLearning: assertDeepLearningGpuTrainingExecutorPort(
        selected?.deepLearningTrainingExecutor,
      ),
    });
  }
  const capabilities = Object.freeze({
    version: 1,
    kind: 'CampaignGpuScientificExecutionCapabilities',
    typedHashBoundPlan: true,
    exactPdeAndDeepLearningTaskSet: true,
    canonicalPdeCpuOracleRequired: true,
    canonicalCupyMlpRequired: true,
    singleGpuUuidRequired: true,
    absoluteDeadlineBound: true,
    sourceMutationForbidden: true,
    productionPromotionDisabled: true,
  });
  return assertCampaignGpuScientificExecutionPort(Object.freeze({
    version: 1,
    kind: 'CampaignGpuScientificExecutionPort',
    capabilities: () => capabilities,
    async execute({
      campaign,
      node,
      plan,
      executionBudget,
      executionSignal = null,
      gpuSelectorExecutionLeaseDelegation = null,
    } = {}) {
      const nodeBinding = gpuScientificCampaignNodeBinding(node);
      if (!verifyGpuScientificCampaignExecutionPlan(plan, {
        campaignId: campaign?.campaignId,
        paperId: campaign?.paperId,
        nodeId: node?.nodeId,
      }) || nodeBinding.executionPlanHash
          !== plan.gpuScientificCampaignExecutionPlanHash
        || nodeBinding.resourceBudgetHash
          !== GPU_SCIENTIFIC_CAMPAIGN_RESOURCE_BUDGET
            .gpuScientificCampaignResourceBudgetHash
        || !node?.attemptId || !Number.isSafeInteger(node?.leaseGeneration)
        || node.leaseGeneration < 1) {
        const error = new Error('gpu_scientific_campaign_execution_binding_invalid');
        error.retryable = false;
        throw error;
      }
      const campaignDeadline = Number(executionBudget?.absoluteDeadlineEpochMs);
      if (!Number.isSafeInteger(campaignDeadline) || campaignDeadline < 1
        || JSON.stringify(executionBudget?.acquiredResources)
          !== JSON.stringify(
            GPU_SCIENTIFIC_CAMPAIGN_RESOURCE_BUDGET.nodeReservation,
          )
        || plan.resourceBudgetHash
          !== GPU_SCIENTIFIC_CAMPAIGN_RESOURCE_BUDGET
            .gpuScientificCampaignResourceBudgetHash) {
        const error = new Error('gpu_scientific_campaign_resource_authority_required');
        error.retryable = false;
        throw error;
      }
      const attemptAuthority = buildGpuScientificCampaignAttemptAuthority({
        campaign,
        node,
        plan,
      });
      const { pde, deepLearning } = resolveExecution({ campaign, node, plan });
      const effectiveDeadline = Math.min(
        campaignDeadline,
        plan.absoluteExecutionDeadlineEpochMs,
      );
      const startedAt = readTrustedWallClockEpochMs();
      let pdeScientificReceipt = null;
      let deepLearningTrainingReceipt = null;
      if (startedAt < effectiveDeadline) {
        try {
          pdeScientificReceipt = await pde.executeAndVerify({
            runId: plan.tasks[0].runId,
            gpuDeviceSelector: plan.gpuDeviceSelector,
            absoluteDeadlineEpochMs: effectiveDeadline,
            executionAuthorityHash:
              attemptAuthority.gpuScientificCampaignAttemptAuthorityHash,
            executionSignal,
            gpuSelectorExecutionLeaseDelegation,
          });
        } catch (error) {
          throw gpuTaskExecutionError('pde', null, error);
        }
        if (pdeScientificReceipt?.status
          !== 'canonical_pde_poisson_2d_gpu_scientifically_verified_non_promotable') {
          throw gpuTaskExecutionError('pde', pdeScientificReceipt);
        }
      }
      if (readTrustedWallClockEpochMs() < effectiveDeadline) {
        try {
          const task = plan.tasks[1];
          deepLearningTrainingReceipt = await deepLearning.execute({
            trainingRunId: task.trainingRunId,
            profile: task.profile,
            modelIr: task.modelIr,
            trainingDataset: task.trainingDataset,
            trainingDatasetAuthority: task.trainingDatasetAuthority,
            gpuDeviceSelector: plan.gpuDeviceSelector,
            absoluteDeadlineEpochMs: effectiveDeadline,
            executionAuthorityHash:
              attemptAuthority.gpuScientificCampaignAttemptAuthorityHash,
            executionSignal,
            gpuSelectorExecutionLeaseDelegation,
          });
          if (!verifyCanonicalCupyDeepLearningTrainingReceipt(
            deepLearningTrainingReceipt,
          )) {
            throw gpuTaskExecutionError(
              'deep_learning',
              deepLearningTrainingReceipt,
            );
          }
          buildCanonicalDeepLearningCampaignTaskAttestation({
            task,
            canonicalTrainingReceipt: deepLearningTrainingReceipt,
            gpuDeviceSelector: plan.gpuDeviceSelector,
            absoluteDeadlineEpochMs: effectiveDeadline,
          });
        } catch (error) {
          if (error?.message?.startsWith(
            'gpu_scientific_campaign_deep_learning_execution_blocked:',
          )) throw error;
          throw gpuTaskExecutionError('deep_learning', null, error);
        }
      }
      const result = buildGpuScientificCampaignExecutionResult({
        campaign,
        node,
        plan,
        pdeScientificReceipt,
        deepLearningTrainingReceipt,
        effectiveExecutionDeadlineEpochMs: effectiveDeadline,
        executionStartedAtEpochMs: startedAt,
        executionCompletedAtEpochMs: readTrustedWallClockEpochMs(),
      });
      if (result.status !== 'gpu_scientific_campaign_execution_completed_non_promotable') {
        throw gpuTaskExecutionError('result', result);
      }
      return result;
    },
  }));
}
