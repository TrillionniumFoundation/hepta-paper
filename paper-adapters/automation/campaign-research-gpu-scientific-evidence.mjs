import {
  verifyGpuScientificCampaignExecutionResult,
} from '../../paper-domain/automation/gpu-scientific-campaign-execution-contract.mjs';
import { assertCompletedNodeResult } from './campaign-research-verifier-evidence-helpers.mjs';

export function requireCampaignResearchGpuScientificEvidence({
  campaign,
  authoritativeNodes,
  directDependencies,
} = {}) {
  const plan = campaign.spec.gpuScientificExecutionPlan || null;
  const dependencyNodes = authoritativeNodes.filter((candidate) => (
    directDependencies.has(candidate.nodeId)
      && candidate.kind === 'gpu-scientific-execution'
  ));
  if (!plan) {
    if (dependencyNodes.length) {
      throw new Error('campaign_research_unplanned_gpu_scientific_dependency');
    }
    return null;
  }
  if (dependencyNodes.length !== 1) {
    throw new Error('campaign_research_gpu_scientific_dependency_required');
  }
  const node = assertCompletedNodeResult(dependencyNodes[0], 'gpu_scientific_node');
  if (!verifyGpuScientificCampaignExecutionResult(node.result, {
    campaign,
    node,
    plan,
  })) throw new Error('campaign_research_gpu_scientific_evidence_invalid');
  if (node.result.promotionEligible !== true) {
    const error = new Error(
      'campaign_research_gpu_scientific_external_authorities_required',
    );
    error.retryable = false;
    error.receipt = node.result;
    throw error;
  }
  return node.result;
}
