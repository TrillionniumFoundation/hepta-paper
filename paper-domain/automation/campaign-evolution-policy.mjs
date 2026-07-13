import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

export const CAMPAIGN_BUDGET_KEYS = Object.freeze(['maxWallTimeMs', 'maxAgentCalls', 'maxCpuJobs', 'maxGpuJobs', 'maxTokenCount', 'maxCostUsd', 'maxMemoryMiB']);
export const EXHAUSTED_CAMPAIGN_BUDGETS = Object.freeze({
  campaign_wall_time_budget_exhausted: ['maxWallTimeMs', 'accumulatedRunMs'],
  campaign_agent_call_budget_exhausted: ['maxAgentCalls', 'agentCallCount'],
  campaign_cpu_job_budget_exhausted: ['maxCpuJobs', 'cpuJobCount'],
  campaign_gpu_job_budget_exhausted: ['maxGpuJobs', 'gpuJobCount'],
  campaign_token_budget_exhausted: ['maxTokenCount', 'tokenCount'],
  campaign_cost_budget_exhausted: ['maxCostUsd', 'costUsd'],
});

function normalizedOverrides(previousBudgets, budgetOverrides) {
  const overrides = Object.fromEntries(Object.entries(budgetOverrides || {}).filter(([, value]) => value !== undefined));
  for (const key of Object.keys(overrides)) {
    if (!CAMPAIGN_BUDGET_KEYS.includes(key)) throw new Error(`unsupported_campaign_budget:${key}`);
    const value = Number(overrides[key]);
    if (!Number.isFinite(value) || value < 0) throw new Error(`invalid_campaign_budget:${key}`);
    if (value < Number(previousBudgets[key] ?? 0)) throw new Error(`campaign_budget_cannot_decrease:${key}`);
    overrides[key] = value;
  }
  return overrides;
}

export function evolveCampaignForResume({ campaign, budgetOverrides = {} } = {}) {
  if (!campaign || !['paused', 'stopped'].includes(campaign.status)) throw new Error(`campaign_not_resumable:${campaign?.stop_reason || campaign?.status || 'missing'}`);
  const exhausted = campaign.status === 'stopped' ? EXHAUSTED_CAMPAIGN_BUDGETS[campaign.stop_reason] : null;
  if (campaign.status === 'stopped' && !exhausted) throw new Error(`campaign_not_resumable:${campaign.stop_reason || 'stopped'}`);
  const previousBudgets = campaign.spec?.budgets || {};
  const overrides = normalizedOverrides(previousBudgets, budgetOverrides);
  if (exhausted) {
    const [requiredKey, usageKey] = exhausted;
    if (!(requiredKey in overrides) || Number(overrides[requiredKey]) <= Number(campaign[usageKey] || 0)) throw new Error(`campaign_budget_extension_required:${requiredKey}`);
  }
  const { campaignPlanHash: previousCampaignPlanHash = null, ...campaignPayload } = campaign.spec;
  const nextPayload = Object.freeze({ ...campaignPayload, budgets: Object.freeze({ ...previousBudgets, ...overrides }) });
  const nextSpec = Object.freeze({ ...nextPayload, campaignPlanHash: hashRecord('PaperCampaignPlan', nextPayload) });
  return Object.freeze({ nextSpec, overrides, stoppedForBudget: Boolean(exhausted), previousCampaignPlanHash });
}

export function validateCampaignRoundExtension({ campaign, spec, existingNodes = [] } = {}) {
  if (!campaign || campaign.status !== 'stopped' || campaign.stop_reason !== 'referee_convergence_not_reached_within_budget') throw new Error(`campaign_not_extendable:${campaign?.stop_reason || campaign?.status || 'missing'}`);
  if (spec.paperId !== campaign.paper_id) throw new Error('campaign_extension_paper_mismatch');
  if (Number(spec.maxRounds || 0) <= campaign.maxRounds) throw new Error('campaign_extension_requires_additional_round');
  if (!Array.isArray(spec.nodes) || !spec.nodes.length) throw new Error('campaign_extension_nodes_required');
  for (const [specKey, rowKey] of [
    ['parentCampaignId', 'parent_campaign_id'],
    ['supersedesCampaignId', 'supersedes_campaign_id'],
    ['recoveryOfCampaignId', 'recovery_of_campaign_id'],
  ]) {
    const previous = campaign[specKey] || campaign[rowKey] || campaign.spec?.[specKey] || null;
    if (previous && spec[specKey] !== previous) throw new Error(`campaign_extension_lineage_mismatch:${specKey}`);
  }
  for (const key of CAMPAIGN_BUDGET_KEYS) {
    const previous = Number(campaign.spec?.budgets?.[key] ?? 0);
    const next = Number(spec.budgets?.[key] ?? 0);
    if (!Number.isFinite(next) || next < previous) throw new Error(`campaign_budget_cannot_decrease:${key}`);
  }
  const existingById = new Map(existingNodes.map((item) => [item.node_id, item]));
  for (const nodeSpec of spec.nodes) {
    const existing = existingById.get(nodeSpec.nodeId);
    if (existing && (existing.kind !== nodeSpec.kind || existing.roundIndex !== Number(nodeSpec.roundIndex || 0))) throw new Error(`campaign_extension_node_mismatch:${nodeSpec.nodeId}`);
  }
  const additions = spec.nodes.filter((item) => !existingById.has(item.nodeId));
  if (!additions.some((item) => item.kind === 'package') || !additions.some((item) => item.roundIndex > campaign.maxRounds)) throw new Error('campaign_extension_incomplete');
  return Object.freeze({ additions });
}
