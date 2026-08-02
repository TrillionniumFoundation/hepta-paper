import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  assertAutonomousResearchDirectLocalRunBudgetWaiverBinding,
} from './autonomous-research-launch-mode-policy.mjs';

export const CAMPAIGN_BUDGET_KEYS = Object.freeze(['maxWallTimeMs', 'maxAgentCalls', 'maxCpuJobs', 'maxGpuJobs', 'maxTokenCount', 'maxCostUsd', 'maxMemoryMiB']);
export const EXHAUSTED_CAMPAIGN_BUDGETS = Object.freeze({
  campaign_wall_time_budget_exhausted: ['maxWallTimeMs', 'accumulatedRunMs'],
  campaign_agent_call_budget_exhausted: ['maxAgentCalls', 'agentCallCount'],
  campaign_cpu_job_budget_exhausted: ['maxCpuJobs', 'cpuJobCount'],
  campaign_gpu_job_budget_exhausted: ['maxGpuJobs', 'gpuJobCount'],
  campaign_token_budget_exhausted: ['maxTokenCount', 'tokenCount'],
  campaign_cost_budget_exhausted: ['maxCostUsd', 'costUsd'],
});
const SUPERVISOR_RECOVERABLE_STOP_REASONS = new Set([
  'supervisor_process_shutdown',
  'supervisor_transient_failure',
  'supervisor_lease_lost',
]);

function normalizedOverrides(previousBudgets, budgetOverrides) {
  const overrides = Object.fromEntries(Object.entries(budgetOverrides || {}).filter(([, value]) => value !== undefined));
  for (const key of Object.keys(overrides)) {
    if (!CAMPAIGN_BUDGET_KEYS.includes(key)) throw new Error(`unsupported_campaign_budget:${key}`);
    const value = overrides[key];
    const integerBudget = key !== 'maxCostUsd';
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0
      || (integerBudget && !Number.isSafeInteger(value))) {
      throw new Error(`invalid_campaign_budget:${key}`);
    }
    if (value < Number(previousBudgets[key] ?? 0)) throw new Error(`campaign_budget_cannot_decrease:${key}`);
    overrides[key] = value;
  }
  return overrides;
}

function executionIntentInvariant(intent = null) {
  if (!intent || typeof intent !== 'object') return intent || null;
  const { requestedMaxRounds: _requested, effectiveMaxRounds: _effective, ...invariant } = intent;
  return invariant;
}

function campaignExtensionInvariant(spec = {}) {
  const {
    campaignPlanHash: _planHash,
    requestedMaxRounds: _requestedMaxRounds,
    maxRounds: _maxRounds,
    budgets: _budgets,
    nodes: _nodes,
    executionIntent,
    ...invariant
  } = spec;
  return { ...invariant, executionIntent: executionIntentInvariant(executionIntent) };
}

function nodeStructure(node = {}) {
  const source = node.spec && typeof node.spec === 'object' ? node.spec : node;
  return {
    nodeId: String(node.nodeId || source.nodeId || ''),
    kind: String(node.kind || source.kind || ''),
    roundIndex: Number(node.roundIndex ?? source.roundIndex ?? 0),
    priority: Number(node.priority ?? source.priority ?? 100),
    dependencies: [...new Set((node.dependencies || source.dependencies || []).map(String))].sort(),
    maxAttempts: Math.max(1, Number(node.maxAttempts ?? source.maxAttempts ?? 3)),
    role: node.role ?? source.role ?? null,
    language: source.language || null,
    requiresGpu: Boolean(source.requiresGpu),
    executionIntent: executionIntentInvariant(source.executionIntent),
  };
}

export function evolveCampaignForResume({ campaign, budgetOverrides = {} } = {}) {
  if (!campaign || !['paused', 'stopped'].includes(campaign.status)) throw new Error(`campaign_not_resumable:${campaign?.stopReason || campaign?.status || 'missing'}`);
  const exhausted = campaign.status === 'stopped' ? EXHAUSTED_CAMPAIGN_BUDGETS[campaign.stopReason] : null;
  const supervisorRecoverable = campaign.status === 'stopped'
    && SUPERVISOR_RECOVERABLE_STOP_REASONS.has(campaign.stopReason);
  if (campaign.status === 'stopped' && !exhausted && !supervisorRecoverable) {
    throw new Error(`campaign_not_resumable:${campaign.stopReason || 'stopped'}`);
  }
  const previousBudgets = campaign.spec?.budgets || {};
  if (campaign.spec?.localOnly === true || campaign.spec?.directLocalRunBudgetWaiver
    || campaign.spec?.autonomousResearchPreparation) {
    assertAutonomousResearchDirectLocalRunBudgetWaiverBinding({
      launchMode: campaign.spec?.autonomousResearchPreparation?.launchMode || null,
      localOnly: campaign.spec?.localOnly === true,
      budgets: previousBudgets,
      waiver: campaign.spec?.directLocalRunBudgetWaiver || null,
      campaignId: campaign.campaignId || campaign.spec?.campaignId || null,
      paperId: campaign.paperId || campaign.spec?.paperId || null,
      preparation: campaign.spec?.autonomousResearchPreparation || null,
    });
  }
  const overrides = normalizedOverrides(previousBudgets, budgetOverrides);
  if (exhausted) {
    const [requiredKey, usageKey] = exhausted;
    if (!(requiredKey in overrides) || Number(overrides[requiredKey]) <= Number(campaign[usageKey] || 0)) throw new Error(`campaign_budget_extension_required:${requiredKey}`);
  }
  const { campaignPlanHash: previousCampaignPlanHash = null, ...campaignPayload } = campaign.spec;
  const nextPayload = Object.freeze({ ...campaignPayload, budgets: Object.freeze({ ...previousBudgets, ...overrides }) });
  if (nextPayload.localOnly === true || nextPayload.directLocalRunBudgetWaiver
    || nextPayload.autonomousResearchPreparation) {
    assertAutonomousResearchDirectLocalRunBudgetWaiverBinding({
      launchMode: nextPayload.autonomousResearchPreparation?.launchMode || null,
      localOnly: nextPayload.localOnly === true,
      budgets: nextPayload.budgets,
      waiver: nextPayload.directLocalRunBudgetWaiver || null,
      campaignId: campaign.campaignId || nextPayload.campaignId || null,
      paperId: campaign.paperId || nextPayload.paperId || null,
      preparation: nextPayload.autonomousResearchPreparation || null,
    });
  }
  const nextSpec = Object.freeze({ ...nextPayload, campaignPlanHash: hashRecord('PaperCampaignPlan', nextPayload) });
  return Object.freeze({
    nextSpec,
    overrides,
    stoppedForBudget: Boolean(exhausted),
    reopenStoppedNodes: Boolean(exhausted || supervisorRecoverable),
    previousCampaignPlanHash,
  });
}

export function validateCampaignRoundExtension({ campaign, spec, existingNodes = [] } = {}) {
  if (!campaign || campaign.status !== 'stopped' || campaign.stopReason !== 'referee_convergence_not_reached_within_budget') throw new Error(`campaign_not_extendable:${campaign?.stopReason || campaign?.status || 'missing'}`);
  if (spec.paperId !== campaign.paperId) throw new Error('campaign_extension_paper_mismatch');
  if (Number(spec.maxRounds || 0) <= campaign.maxRounds) throw new Error('campaign_extension_requires_additional_round');
  if (!Array.isArray(spec.nodes) || !spec.nodes.length) throw new Error('campaign_extension_nodes_required');
  for (const specKey of ['parentCampaignId', 'supersedesCampaignId', 'recoveryOfCampaignId']) {
    const previous = campaign[specKey] || campaign.spec?.[specKey] || null;
    if (previous && spec[specKey] !== previous) throw new Error(`campaign_extension_lineage_mismatch:${specKey}`);
  }
  if (hashRecord('CampaignExtensionInvariant', campaignExtensionInvariant(spec))
    !== hashRecord('CampaignExtensionInvariant', campaignExtensionInvariant(campaign.spec))) {
    throw new Error('campaign_extension_immutable_definition_mismatch');
  }
  for (const key of CAMPAIGN_BUDGET_KEYS) {
    const previous = Number(campaign.spec?.budgets?.[key] ?? 0);
    const next = Number(spec.budgets?.[key] ?? 0);
    if (!Number.isFinite(next) || next < previous) throw new Error(`campaign_budget_cannot_decrease:${key}`);
  }
  const existingById = new Map(existingNodes.map((item) => [item.nodeId, item]));
  const proposedById = new Map(spec.nodes.map((item) => [item.nodeId, item]));
  const supersededTailKinds = new Set(['final-compile', 'research-verify', 'package', 'release-package']);
  for (const existing of existingNodes) {
    const proposed = proposedById.get(existing.nodeId);
    if (!proposed && !supersededTailKinds.has(existing.kind)) {
      throw new Error(`campaign_extension_existing_node_missing:${existing.nodeId}`);
    }
    if (proposed && hashRecord('CampaignExtensionNodeStructure', nodeStructure(existing))
      !== hashRecord('CampaignExtensionNodeStructure', nodeStructure(proposed))) {
      throw new Error(`campaign_extension_node_mismatch:${existing.nodeId}`);
    }
  }
  for (const nodeSpec of spec.nodes) {
    const existing = existingById.get(nodeSpec.nodeId);
    if (!existing && hashRecord('CampaignExtensionExecutionIntent', executionIntentInvariant(nodeSpec.executionIntent))
      !== hashRecord('CampaignExtensionExecutionIntent', executionIntentInvariant(spec.executionIntent))) {
      throw new Error(`campaign_extension_node_intent_mismatch:${nodeSpec.nodeId}`);
    }
  }
  const additions = spec.nodes.filter((item) => !existingById.has(item.nodeId));
  if (!additions.some((item) => item.kind === 'package') || !additions.some((item) => item.roundIndex > campaign.maxRounds)) throw new Error('campaign_extension_incomplete');
  return Object.freeze({ additions });
}
