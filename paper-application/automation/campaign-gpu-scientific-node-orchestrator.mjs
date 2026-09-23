import {
  GPU_SCIENTIFIC_CAMPAIGN_NODE_KIND,
  GPU_SCIENTIFIC_CAMPAIGN_RESOURCE_BUDGET,
  gpuScientificCampaignNodeBinding,
  verifyGpuScientificCampaignExecutionPlan,
} from '../../paper-domain/automation/gpu-scientific-campaign-execution-contract.mjs';
import {
  assertCampaignGpuScientificExecutionPort,
} from '../../paper-ports/campaign-gpu-scientific-execution-port.mjs';

export async function executeCampaignGpuScientificNode({
  gpuScientificExecution,
  campaign,
  node,
  workspace,
  executionBudget,
  executionSignal = null,
} = {}) {
  if (node?.kind !== GPU_SCIENTIFIC_CAMPAIGN_NODE_KIND) {
    throw new Error(`campaign_gpu_scientific_node_kind_invalid:${node?.kind || 'missing'}`);
  }
  const plan = campaign?.spec?.gpuScientificExecutionPlan || null;
  const nodeBinding = gpuScientificCampaignNodeBinding(node);
  if (!verifyGpuScientificCampaignExecutionPlan(plan, {
    campaignId: campaign?.campaignId,
    paperId: campaign?.paperId,
    nodeId: node?.nodeId,
  }) || nodeBinding.executionPlanHash
      !== plan.gpuScientificCampaignExecutionPlanHash
    || nodeBinding.resourceBudgetHash
      !== GPU_SCIENTIFIC_CAMPAIGN_RESOURCE_BUDGET
        .gpuScientificCampaignResourceBudgetHash) {
    const error = new Error('campaign_gpu_scientific_verified_plan_required');
    error.retryable = false;
    throw error;
  }
  if (!gpuScientificExecution) {
    const error = new Error('campaign_gpu_scientific_execution_port_required');
    error.retryable = false;
    throw error;
  }
  return assertCampaignGpuScientificExecutionPort(gpuScientificExecution).execute({
    campaign,
    node,
    plan,
    workspace,
    executionBudget,
    executionSignal,
  });
}
