import { campaignGraphNode } from './campaign-source-closure-graph.mjs';
import {
  GPU_SCIENTIFIC_CAMPAIGN_NODE_KIND,
  GPU_SCIENTIFIC_CAMPAIGN_RESOURCE_BUDGET,
  gpuScientificCampaignNodeId,
  verifyGpuScientificCampaignExecutionPlan,
} from './gpu-scientific-campaign-execution-contract.mjs';

export function requireGpuScientificCampaignGraphPlan(plan, campaignId) {
  if (plan && !verifyGpuScientificCampaignExecutionPlan(plan, {
    campaignId,
    paperId: plan.paperId,
    nodeId: gpuScientificCampaignNodeId(campaignId),
  })) throw new Error('campaign_gpu_scientific_execution_plan_invalid');
  return plan || null;
}

export function buildGpuScientificCampaignGraphNode({
  campaignId,
  dependencies,
  executionIntent,
  plan,
} = {}) {
  if (!plan) return null;
  return campaignGraphNode(
    campaignId,
    GPU_SCIENTIFIC_CAMPAIGN_NODE_KIND,
    dependencies,
    {
      priority: 99,
      executionIntent,
      requiresGpu: true,
      sourceClosureTerminal: true,
      sourceMutationPolicy: 'forbid',
      gpuScientificExecutionPlanHash:
        plan.gpuScientificCampaignExecutionPlanHash,
      gpuScientificResourceBudgetHash:
        GPU_SCIENTIFIC_CAMPAIGN_RESOURCE_BUDGET
          .gpuScientificCampaignResourceBudgetHash,
    },
  );
}
