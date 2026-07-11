import { evaluateRefereeConvergence } from '../../paper-domain/automation/referee-convergence.mjs';
import crypto from 'node:crypto';

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function refereeResults(nodes, roundIndex) {
  return nodes.filter((node) => node.roundIndex === roundIndex && /^referee-\d+$/.test(node.kind))
    .map((node) => node.result).filter(Boolean);
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

  while (true) {
    const campaign = campaignStore.getCampaign(campaignId);
    if (!campaign) throw new Error(`campaign not found: ${campaignId}`);
    if (['completed', 'failed', 'cancelled'].includes(campaign.status)) {
      return Object.freeze({
        version: 1,
        kind: 'PaperCampaignRunResult',
        campaign,
        nodes: campaignStore.listNodes(campaignId),
        eventCount: campaignStore.listEvents(campaignId).length,
        executedNodeCount,
        retryCount,
        maximumObservedConcurrency,
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
      const node = campaignStore.startNode({ nodeId: claimedNode.node_id, workerId });
      active += 1;
      maximumObservedConcurrency = Math.max(maximumObservedConcurrency, active);
      try {
        let result = await executor.execute({ campaign, node, allNodes: campaignStore.listNodes(campaignId), workerIndex: index });
        if (node.kind === 'convergence') {
          result = evaluateRefereeConvergence({ paperId: campaign.paper_id, roundIndex: node.roundIndex, reviews: refereeResults(campaignStore.listNodes(campaignId), node.roundIndex), ...(result?.thresholds || {}) });
        }
        campaignStore.completeNode({ nodeId: node.node_id, workerId, result });
        executedNodeCount += 1;
        if (node.kind === 'convergence' && result.accepted) {
          campaignStore.skipFutureRounds({ campaignId, afterRound: node.roundIndex, reason: 'referee_convergence_reached' });
        }
      } catch (error) {
        const failed = campaignStore.failNode({ nodeId: node.node_id, workerId, failureClass: error?.code || error?.message || 'campaign_executor_failed', failureDetail: boundedFailureDetail(error), retryable: error?.retryable !== false });
        if (failed.status === 'queued') retryCount += 1;
      } finally {
        active -= 1;
      }
    }));
  }
}
