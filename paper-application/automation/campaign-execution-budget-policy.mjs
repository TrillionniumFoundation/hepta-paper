import { resourcesForCampaignNode } from './resource-governor.mjs';

export function elapsedRunMs(campaign, nowMs) {
  const accumulated = Number(campaign.accumulatedRunMs || 0);
  const live = campaign.lastResumedAt ? Math.max(0, nowMs - Date.parse(campaign.lastResumedAt)) : 0;
  return accumulated + live;
}

export function campaignNodeUsageDelta(campaign, node, result = null) {
  const resources = resourcesForCampaignNode(campaign, node);
  const cellMeteredEmpirical = Boolean(resources.cpu && campaign?.spec?.benchmarkSelector);
  return {
    agentCalls: resources.agent,
    cpuJobs: cellMeteredEmpirical ? 0 : resources.cpu,
    gpuJobs: cellMeteredEmpirical ? 0 : resources.gpu,
    tokens: Number(result?.outputTokenCount || result?.usage?.totalTokens || 0),
    ...(result?.usage && (Object.prototype.hasOwnProperty.call(result.usage, 'costUsd')
      || Object.prototype.hasOwnProperty.call(result.usage, 'cost_usd'))
      ? { costUsd: Number(result.usage.costUsd ?? result.usage.cost_usd), pricedAgentCalls: resources.agent ? 1 : 0 }
      : {}),
  };
}

export function meteredCampaignResultUsage(result, { agentCall = false } = {}) {
  const usage = result?.usage || {};
  const delta = { tokens: Number(result?.outputTokenCount || usage.totalTokens || usage.total_tokens || usage.total || 0) };
  if (Object.prototype.hasOwnProperty.call(usage, 'costUsd')
    || Object.prototype.hasOwnProperty.call(usage, 'cost_usd')) {
    delta.costUsd = Number(usage.costUsd ?? usage.cost_usd);
    delta.pricedAgentCalls = agentCall ? 1 : 0;
  }
  return delta;
}

export function campaignBudgetBlocker(campaign, node, nowMs) {
  const budgets = campaign.spec?.budgets || {};
  const request = resourcesForCampaignNode(campaign, node);
  if (elapsedRunMs(campaign, nowMs) >= Number(budgets.maxWallTimeMs ?? Infinity)) return 'campaign_wall_time_budget_exhausted';
  if (request.agent && campaign.agentCallCount >= Number(budgets.maxAgentCalls ?? Infinity)) return 'campaign_agent_call_budget_exhausted';
  if (request.cpu && campaign.cpuJobCount >= Number(budgets.maxCpuJobs ?? Infinity)) return 'campaign_cpu_job_budget_exhausted';
  if (request.gpu && campaign.gpuJobCount >= Number(budgets.maxGpuJobs ?? Infinity)) return 'campaign_gpu_job_budget_exhausted';
  if (campaign.tokenCount >= Number(budgets.maxTokenCount ?? Infinity)) return 'campaign_token_budget_exhausted';
  if (request.agent && Number(budgets.maxTokenCount ?? Infinity) - campaign.tokenCount < 128) return 'campaign_token_budget_exhausted';
  if (campaign.costKnown && Number(campaign.costUsd || 0) >= Number(budgets.maxCostUsd ?? Infinity)) return 'campaign_cost_budget_exhausted';
  return null;
}

export function postExecutionCampaignBudgetBlocker(campaign) {
  const budgets = campaign.spec?.budgets || {};
  if (campaign.tokenCount > Number(budgets.maxTokenCount ?? Infinity)) return 'campaign_token_budget_exhausted';
  if (campaign.costKnown && Number(campaign.costUsd || 0) > Number(budgets.maxCostUsd ?? Infinity)) return 'campaign_cost_budget_exhausted';
  return null;
}
