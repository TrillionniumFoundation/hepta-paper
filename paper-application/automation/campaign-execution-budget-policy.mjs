import { resourcesForCampaignNode } from './resource-governor.mjs';
import {
  normalizeAgentExecutionUsage,
  verifyAgentBackendUsageReceipt,
  verifyAgentExecutionReceipt,
  verifyAgentExecutionUsageBinding,
  verifyAgentPostprocessingFailureUsageReceipt,
  verifiedAgentExecutionUsage,
} from '../../paper-domain/evidence/agent-execution-receipt-contract.mjs';

export const AGENT_USAGE_UNKNOWN_TERMINAL = 'agent_usage_unknown_terminal';

function unknownTerminalAgentUsage(result, reason, {
  knownUsageTrusted = false,
} = {}) {
  const knownUsage = knownUsageTrusted
    ? normalizeAgentExecutionUsage(result?.usage) : null;
  return Object.freeze({
    tokens: knownUsage?.totalTokens || 0,
    agentUsageComplete: false,
    agentUsageStatus: AGENT_USAGE_UNKNOWN_TERMINAL,
    agentUsageReason: reason,
    agentUsageReceiptHash: result?.agentBackendUsageReceiptHash
      || result?.agentPostprocessingFailureUsageReceiptHash
      || result?.agentExecutionReceiptHash
      || null,
  });
}

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

export function meteredCampaignResultUsage(result, {
  agentCall = false,
  failureReceipt = false,
} = {}) {
  let usage = result?.usage || {};
  if (agentCall && failureReceipt) {
    if (verifyAgentPostprocessingFailureUsageReceipt(result)) {
      usage = result.usage;
    } else if (result?.kind === 'AgentBackendUsageReceipt') {
      if (!verifyAgentBackendUsageReceipt(result)) {
        return unknownTerminalAgentUsage(
          result,
          'agent_backend_usage_receipt_invalid',
        );
      }
      if (result.usageComplete !== true) {
        return unknownTerminalAgentUsage(
          result,
          'agent_backend_usage_incomplete',
          { knownUsageTrusted: true },
        );
      }
      usage = result.usage || {};
    } else if (verifyAgentExecutionReceipt(result, { requireCompleted: false })) {
      if (result.usageComplete === false) {
        return unknownTerminalAgentUsage(
          result,
          'agent_execution_usage_incomplete',
          { knownUsageTrusted: true },
        );
      }
      const verifiedUsage = verifiedAgentExecutionUsage(
        result,
        { requireCompleted: false },
      );
      if (verifiedUsage) {
        usage = verifiedUsage;
      } else if (result.externalModelInvocationPerformed === false
        && (result.usage === null || result.usage === undefined)) {
        usage = {};
      } else {
        return unknownTerminalAgentUsage(
          result,
          'agent_execution_usage_incomplete',
        );
      }
    } else if (result) {
      return unknownTerminalAgentUsage(
        result,
        'agent_failure_usage_receipt_unverified',
      );
    } else {
      return unknownTerminalAgentUsage(
        null,
        'agent_failure_usage_receipt_missing',
      );
    }
  } else if (agentCall) {
    const verifiedUsage = verifiedAgentExecutionUsage(result);
    if (verifiedUsage) {
      usage = verifiedUsage;
    } else if (verifyAgentExecutionReceipt(result)
      && result.externalModelInvocationPerformed === false
      && (result.usage === null || result.usage === undefined)) {
      usage = {};
    } else {
      const binding = result?.agentExecutionUsageBinding
        || result?.sourceAgentExecutionUsageBinding || null;
      const sourceReceipt = result?.agentExecutionReceipt
        || result?.sourceAgentExecutionReceipt || null;
      const claimedBindingHash = result?.agentExecutionUsageBinding
        ? result?.agentExecutionUsageBindingHash
        : result?.sourceAgentExecutionUsageBindingHash;
      const boundUsage = binding?.usage === null
        ? null : normalizeAgentExecutionUsage(binding?.usage);
      const reportedUsage = result?.usage === null || result?.usage === undefined
        ? null : normalizeAgentExecutionUsage(result.usage);
      if (verifyAgentExecutionUsageBinding(binding, {
        agentExecutionReceipt: sourceReceipt,
      })
        && claimedBindingHash === binding.agentExecutionUsageBindingHash
        && JSON.stringify(reportedUsage) === JSON.stringify(boundUsage)) {
        usage = boundUsage || {};
      } else {
        const error = new Error('agent_execution_usage_binding_invalid');
        error.retryable = false;
        error.receipt = sourceReceipt || result || null;
        throw error;
      }
    }
  }
  const meteredTokens = agentCall
    ? usage.totalTokens || usage.total_tokens || usage.total || 0
    : result?.outputTokenCount || usage.totalTokens || usage.total_tokens || usage.total || 0;
  const delta = { tokens: Number(meteredTokens) };
  if (Object.prototype.hasOwnProperty.call(usage, 'costUsd')
    || Object.prototype.hasOwnProperty.call(usage, 'cost_usd')) {
    delta.costUsd = Number(usage.costUsd ?? usage.cost_usd);
    delta.pricedAgentCalls = agentCall ? 1 : 0;
  }
  return delta;
}

export function meteredCampaignFailureUsage(error, { agentCall = false } = {}) {
  const usageDelta = meteredCampaignResultUsage(error?.receipt, {
    agentCall,
    failureReceipt: true,
  });
  const agentUsageUnknown = usageDelta.agentUsageComplete === false
    || usageDelta.agentUsageStatus === AGENT_USAGE_UNKNOWN_TERMINAL;
  return Object.freeze({
    nodeFailure: Object.freeze({
      failureClass: agentUsageUnknown
        ? AGENT_USAGE_UNKNOWN_TERMINAL
        : error?.code || error?.message || 'campaign_executor_failed',
      retryable: agentUsageUnknown ? false : error?.retryable !== false,
      usageDelta,
    }),
    usageMetering: agentUsageUnknown ? Object.freeze({
      status: AGENT_USAGE_UNKNOWN_TERMINAL,
      reason: usageDelta.agentUsageReason || 'agent_usage_incomplete',
      knownTokenCount: Number(usageDelta.tokens || 0),
      receiptHash: usageDelta.agentUsageReceiptHash || null,
    }) : null,
  });
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
