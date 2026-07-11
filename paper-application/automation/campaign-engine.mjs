import { evaluateRefereeConvergence } from '../../paper-domain/automation/referee-convergence.mjs';
import crypto from 'node:crypto';
import { createResourceGovernor, resourcesForCampaignNode } from './resource-governor.mjs';

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function refereeResults(nodes, roundIndex) {
  return nodes.filter((node) => node.roundIndex === roundIndex && /^revision-referee-\d+$/.test(node.kind))
    .map((node) => node.result).filter(Boolean);
}

function elapsedRunMs(campaign, nowMs = Date.now()) {
  const accumulated = Number(campaign.accumulatedRunMs || 0);
  const live = campaign.last_resumed_at ? Math.max(0, nowMs - Date.parse(campaign.last_resumed_at)) : 0;
  return accumulated + live;
}

function usageDelta(campaign, node, result = null) {
  const resources = resourcesForCampaignNode(campaign, node);
  return {
    agentCalls: resources.agent,
    cpuJobs: resources.cpu,
    gpuJobs: resources.gpu,
    tokens: Number(result?.outputTokenCount || result?.usage?.totalTokens || 0),
    costUsd: Number(result?.usage?.costUsd || 0),
  };
}

function budgetBlocker(campaign, node, nowMs) {
  const budgets = campaign.spec?.budgets || {};
  const request = resourcesForCampaignNode(campaign, node);
  if (elapsedRunMs(campaign, nowMs) >= Number(budgets.maxWallTimeMs ?? Infinity)) return 'campaign_wall_time_budget_exhausted';
  if (request.agent && campaign.agentCallCount >= Number(budgets.maxAgentCalls ?? Infinity)) return 'campaign_agent_call_budget_exhausted';
  if (request.cpu && campaign.cpuJobCount >= Number(budgets.maxCpuJobs ?? Infinity)) return 'campaign_cpu_job_budget_exhausted';
  if (request.gpu && campaign.gpuJobCount >= Number(budgets.maxGpuJobs ?? Infinity)) return 'campaign_gpu_job_budget_exhausted';
  if (campaign.tokenCount >= Number(budgets.maxTokenCount ?? Infinity)) return 'campaign_token_budget_exhausted';
  if (request.agent && Number(budgets.maxTokenCount ?? Infinity) - campaign.tokenCount < 128) return 'campaign_token_budget_exhausted';
  if (campaign.costUsd >= Number(budgets.maxCostUsd ?? Infinity)) return 'campaign_cost_budget_exhausted';
  return null;
}

function postExecutionBudgetBlocker(campaign) {
  const budgets = campaign.spec?.budgets || {};
  if (campaign.tokenCount > Number(budgets.maxTokenCount ?? Infinity)) return 'campaign_token_budget_exhausted';
  if (campaign.costUsd > Number(budgets.maxCostUsd ?? Infinity)) return 'campaign_cost_budget_exhausted';
  return null;
}

function boundedFailureDetail(error) {
  const receipt = error?.receipt || {};
  return Object.freeze({
    message: String(error?.message || 'campaign_executor_failed').slice(0, 1000),
    receiptKind: receipt.kind || null,
    receiptStatus: receipt.status || null,
    receiptHash: receipt.agentExecutionReceiptHash || receipt.multiLanguageEmpiricalReceiptHash || receipt.receiptHash || null,
    blockers: Array.isArray(receipt.blockers) ? receipt.blockers.slice(0, 20) : [],
    exitCode: receipt.exitCode ?? null,
    stderrTail: String(receipt.stderrTail || '').slice(-4000),
    stdoutTail: String(receipt.stdoutTail || '').slice(-4000),
    receiptDetails: receipt.details || null,
    backendFailures: Array.isArray(error?.failures) ? error.failures.slice(0, 10) : [],
  });
}

export async function runPaperCampaign({
  campaignId,
  campaignStore,
  executor,
  concurrency = 4,
  workerPrefix = 'paper-campaign-worker',
  leaseSeconds = 300,
  pollMs = 5,
  maximumIdlePolls = 20,
  resourceGovernor = null,
} = {}) {
  if (!campaignId || !campaignStore || typeof executor?.execute !== 'function') {
    throw new Error('campaignId, CampaignStorePort and executor are required');
  }
  const workerCount = Math.max(1, Math.min(64, Number(concurrency) || 4));
  let idlePolls = 0;
  let maximumObservedConcurrency = 0;
  let active = 0;
  let executedNodeCount = 0;
  let retryCount = 0;
  const dispatcherId = `${workerPrefix}:${crypto.randomUUID()}`;
  const governor = resourceGovernor || createResourceGovernor({ agent: workerCount, cpu: workerCount, gpu: 1, memoryMiB: Math.max(2048, workerCount * 2048) });
  const initialCampaign = campaignStore.getCampaign(campaignId);
  const localGovernor = createResourceGovernor({
    agent: workerCount,
    cpu: Number(initialCampaign?.spec?.budgets?.maxCpuJobs ?? workerCount),
    gpu: Number(initialCampaign?.spec?.budgets?.maxGpuJobs ?? 1),
    memoryMiB: Number(initialCampaign?.spec?.budgets?.maxMemoryMiB ?? Math.max(2048, workerCount * 2048)),
  });

  while (true) {
    const campaign = campaignStore.getCampaign(campaignId);
    if (!campaign) throw new Error(`campaign not found: ${campaignId}`);
    if (['completed', 'failed', 'cancelled', 'paused', 'stopped'].includes(campaign.status)) {
      return Object.freeze({
        version: 1,
        kind: 'PaperCampaignRunResult',
        campaign,
        nodes: campaignStore.listNodes(campaignId),
        eventCount: campaignStore.listEvents(campaignId).length,
        executedNodeCount,
        retryCount,
        maximumObservedConcurrency,
        resourceUsage: governor.snapshot(),
        externalActionPerformed: false,
      });
    }
    const slots = workerCount - active;
    const claimed = slots > 0 ? campaignStore.claimReady({ campaignId, workerId: dispatcherId, leaseSeconds, limit: slots }) : [];
    if (!claimed.length) {
      idlePolls += 1;
      if (idlePolls > maximumIdlePolls) {
        const nodes = campaignStore.listNodes(campaignId);
        if (nodes.some((node) => ['leased', 'running'].includes(node.status))) {
          await sleep(pollMs);
          continue;
        }
        throw new Error('campaign_deadlock_or_unsatisfied_dependencies');
      }
      await sleep(pollMs);
      continue;
    }
    idlePolls = 0;
    await Promise.all(claimed.map(async (claimedNode, index) => {
      const workerId = dispatcherId;
      const currentCampaign = campaignStore.getCampaign(campaignId);
      const nowMs = typeof campaignStore.nowEpochMs === 'function' ? campaignStore.nowEpochMs() : Date.now();
      const blocker = budgetBlocker(currentCampaign, claimedNode, nowMs);
      if (blocker) {
        campaignStore.stopCampaign(campaignId, blocker);
        return;
      }
      const requestedResources = resourcesForCampaignNode(currentCampaign, claimedNode);
      const releaseResources = await governor.acquire(requestedResources);
      let releaseLocalResources;
      try {
        releaseLocalResources = await localGovernor.acquire(requestedResources);
      } catch (error) {
        releaseResources();
        throw error;
      }
      const reservedCampaign = campaignStore.getCampaign(campaignId);
      const reservedNode = campaignStore.listNodes(campaignId).find((item) => item.node_id === claimedNode.node_id);
      if (reservedCampaign?.status !== 'running' || reservedNode?.status !== 'leased' || reservedNode?.lease_owner !== dispatcherId) {
        releaseLocalResources();
        releaseResources();
        return;
      }
      const reservationBlocker = budgetBlocker(reservedCampaign, claimedNode, typeof campaignStore.nowEpochMs === 'function' ? campaignStore.nowEpochMs() : Date.now());
      if (reservationBlocker) {
        campaignStore.stopCampaign(campaignId, reservationBlocker);
        releaseLocalResources();
        releaseResources();
        return;
      }
      campaignStore.recordUsage(campaignId, usageDelta(reservedCampaign, claimedNode));
      let node;
      try {
        node = campaignStore.startNode({ nodeId: claimedNode.node_id, workerId });
      } catch (error) {
        releaseLocalResources();
        releaseResources();
        throw error;
      }
      const heartbeat = typeof campaignStore.renewNodeLease === 'function' ? setInterval(() => {
        try { campaignStore.renewNodeLease({ nodeId: node.node_id, workerId, leaseSeconds }); } catch { /* completion will surface a lost lease */ }
      }, Math.max(1000, Math.floor(leaseSeconds * 1000 / 3))) : null;
      heartbeat?.unref();
      const controller = new AbortController();
      const controlMonitor = setInterval(() => {
        const status = campaignStore.getCampaign(campaignId)?.status;
        if (['paused', 'cancelled', 'failed', 'stopped'].includes(status)) controller.abort(status);
        const latestNode = campaignStore.listNodes(campaignId).find((item) => item.node_id === node.node_id);
        if (latestNode && latestNode.status !== 'running') controller.abort(latestNode.failure_class || latestNode.status);
      }, 500);
      controlMonitor.unref();
      active += 1;
      maximumObservedConcurrency = Math.max(maximumObservedConcurrency, active);
      try {
        const remainingWallTimeMs = Math.max(1, Number(currentCampaign.spec?.budgets?.maxWallTimeMs ?? 6 * 60 * 60 * 1000) - elapsedRunMs(currentCampaign, nowMs));
        const runNestedAgent = async (operation) => {
          const nestedRequest = { agent: 1, cpu: 0, gpu: 0, memoryMiB: 0 };
          const releaseNestedGlobal = await governor.acquire(nestedRequest);
          let releaseNestedLocal;
          try {
            releaseNestedLocal = await localGovernor.acquire(nestedRequest);
            const latest = campaignStore.getCampaign(campaignId);
            if (latest?.status !== 'running') {
              const error = new Error(`campaign_${latest?.status || 'unavailable'}`);
              error.retryable = false;
              throw error;
            }
            if (latest.agentCallCount >= Number(latest.spec?.budgets?.maxAgentCalls ?? Infinity)) {
              campaignStore.stopCampaign(campaignId, 'campaign_agent_call_budget_exhausted');
              const error = new Error('campaign_agent_call_budget_exhausted');
              error.retryable = false;
              throw error;
            }
            if (Number(latest.spec?.budgets?.maxTokenCount ?? Infinity) - latest.tokenCount < 128) {
              campaignStore.stopCampaign(campaignId, 'campaign_token_budget_exhausted');
              const error = new Error('campaign_token_budget_exhausted');
              error.retryable = false;
              throw error;
            }
            campaignStore.recordUsage(campaignId, { agentCalls: 1 });
            const nestedResult = await operation({ remainingTokenCount: Math.max(128, Number(latest.spec?.budgets?.maxTokenCount ?? Infinity) - latest.tokenCount) });
            const nestedUsage = nestedResult?.usage || {};
            campaignStore.recordUsage(campaignId, { tokens: Number(nestedResult?.outputTokenCount || nestedUsage.totalTokens || nestedUsage.total_tokens || nestedUsage.total || 0), costUsd: Number(nestedUsage.costUsd || nestedUsage.cost_usd || 0) });
            return nestedResult;
          } finally {
            releaseNestedLocal?.();
            releaseNestedGlobal();
          }
        };
        const remainingTokenCount = Math.max(0, Number(currentCampaign.spec?.budgets?.maxTokenCount ?? Infinity) - currentCampaign.tokenCount);
        let result = await executor.execute({ campaign: currentCampaign, node, allNodes: campaignStore.listNodes(campaignId), workerIndex: index, executionBudget: { remainingWallTimeMs, remainingTokenCount }, executionSignal: controller.signal, executionResources: { runNestedAgent } });
        if (node.kind === 'convergence') {
          const nodes = campaignStore.listNodes(campaignId);
          const revisedReview = nodes.find((item) => item.roundIndex === node.roundIndex && item.kind === 'revision-referee-1')?.result;
          result = evaluateRefereeConvergence({ paperId: currentCampaign.paper_id, roundIndex: node.roundIndex, expectedManuscriptHash: revisedReview?.manuscriptHash || null, reviews: refereeResults(nodes, node.roundIndex), ...(result?.thresholds || {}) });
        }
        const usage = result?.usage || {};
        campaignStore.recordUsage(campaignId, { tokens: Number(result?.outputTokenCount || usage.totalTokens || usage.total_tokens || usage.total || 0), costUsd: Number(usage.costUsd || usage.cost_usd || 0) });
        const postBlocker = postExecutionBudgetBlocker(campaignStore.getCampaign(campaignId));
        if (postBlocker) campaignStore.stopCampaign(campaignId, postBlocker);
        campaignStore.completeNode({ nodeId: node.node_id, workerId, result });
        executedNodeCount += 1;
        if (!postBlocker && node.kind === 'convergence' && result.accepted) {
          campaignStore.skipFutureRounds({ campaignId, afterRound: node.roundIndex, reason: 'referee_convergence_reached' });
        } else if (node.kind === 'convergence' && !result.accepted && node.roundIndex >= currentCampaign.maxRounds) {
          campaignStore.stopCampaign(campaignId, 'referee_convergence_not_reached_within_budget');
        }
      } catch (error) {
        const latestNode = campaignStore.listNodes(campaignId).find((item) => item.node_id === node.node_id);
        if (latestNode?.status === 'skipped') return;
        campaignStore.recordUsage(campaignId, { tokens: Number(error?.receipt?.outputTokenCount || error?.receipt?.usage?.totalTokens || error?.receipt?.usage?.total_tokens || error?.receipt?.usage?.total || 0), costUsd: Number(error?.receipt?.usage?.costUsd || error?.receipt?.usage?.cost_usd || 0) });
        const campaignStatus = campaignStore.getCampaign(campaignId)?.status;
        const failed = campaignStore.failNode({ nodeId: node.node_id, workerId, failureClass: error?.code || error?.message || 'campaign_executor_failed', failureDetail: boundedFailureDetail(error), retryable: !['cancelled', 'failed', 'stopped'].includes(campaignStatus) && error?.retryable !== false });
        if (failed.status === 'queued') retryCount += 1;
      } finally {
        if (heartbeat) clearInterval(heartbeat);
        clearInterval(controlMonitor);
        active -= 1;
        releaseResources();
        releaseLocalResources();
      }
    }));
  }
}
