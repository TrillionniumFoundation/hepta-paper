import {
  ADVANCED_NUMERICAL_CAMPAIGN_NODE_KIND,
  verifyAdvancedNumericalCampaignExecutionPlan,
} from '../../paper-domain/automation/advanced-numerical-campaign-execution-contract.mjs';
import {
  assertCampaignAdvancedNumericalExecutionPort,
} from '../../paper-ports/campaign-advanced-numerical-execution-port.mjs';

export async function executeCampaignAdvancedNumericalNode({
  advancedNumericalExecution,
  campaign,
  node,
  workspace,
} = {}) {
  if (node?.kind !== ADVANCED_NUMERICAL_CAMPAIGN_NODE_KIND) {
    throw new Error(`campaign_advanced_numerical_node_kind_invalid:${node?.kind || 'missing'}`);
  }
  const plan = campaign?.spec?.advancedNumericalExecutionPlan || null;
  if (!verifyAdvancedNumericalCampaignExecutionPlan(plan, {
    campaignId: campaign?.campaignId,
    paperId: campaign?.paperId,
    nodeId: node?.nodeId,
  }) || node?.advancedNumericalExecutionPlanHash
      !== plan.advancedNumericalCampaignExecutionPlanHash) {
    const error = new Error('campaign_advanced_numerical_verified_plan_required');
    error.retryable = false;
    throw error;
  }
  if (!advancedNumericalExecution) {
    const error = new Error('campaign_advanced_numerical_execution_port_required');
    error.retryable = false;
    throw error;
  }
  return assertCampaignAdvancedNumericalExecutionPort(
    advancedNumericalExecution,
  ).execute({ campaign, node, plan, workspace });
}
