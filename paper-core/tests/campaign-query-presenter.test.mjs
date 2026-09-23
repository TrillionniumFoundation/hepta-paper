import assert from 'node:assert/strict';
import test from 'node:test';
import { presentCampaignStatus, presentNodeLog, summarizeCampaign, summarizeEvent, summarizePlan, summarizeRun } from '../../paper-application/automation/campaign-query-presenter.mjs';

test('campaign query presenter defaults to bounded operational summaries', () => {
  const campaign = {
    campaignId: 'campaign', paperId: 'paper', status: 'running', effectiveStatus: 'running',
    currentPhase: 'referee-1', currentReviewRound: 1, maxRounds: 2,
    agentCallCount: 4, cpuJobCount: 2, gpuJobCount: 1, tokenCount: 100,
    costKnown: false, spec: { largeReceipt: true },
  };
  const nodes = [
    { nodeId: 'n1', kind: 'referee-1', status: 'running', roundIndex: 1, attemptCount: 1, maxAttempts: 3 },
    { nodeId: 'n2', kind: 'referee-2', status: 'queued', roundIndex: 1, attemptCount: 0, maxAttempts: 3 },
  ];
  const view = presentCampaignStatus(campaign, nodes);
  assert.equal(view.campaign.usage.costUsd, 'unknown');
  assert.deepEqual(view.nodeCounts, { queued: 1, running: 1 });
  assert.equal(view.activeNodes.length, 1);
  assert.equal('spec' in view.campaign, false);
  assert.deepEqual(presentCampaignStatus(campaign, nodes, { details: true }), { campaign, nodes });
});

test('plan run and event summaries omit full DAG and receipt payloads', () => {
  const plan = summarizePlan({ campaignId: 'c', paperId: 'p', languages: ['r', 'latex'], datasetMounts: [{}], nodes: [{}, {}], campaignPlanHash: 'sha256:plan' });
  assert.equal(plan.nodeCount, 2);
  assert.equal(plan.datasetCount, 1);
  const run = summarizeRun({ campaign: { campaignId: 'c', paperId: 'p', status: 'completed' }, nodes: [{ status: 'completed', result: { large: true } }], eventCount: 3 });
  assert.deepEqual(run.nodeCounts, { completed: 1 });
  assert.equal('nodes' in run, false);
  const event = summarizeEvent({ eventId: 'e', campaignId: 'c', kind: 'started', event: { detail: { attempt: 1 } }, eventSha256: 'sha256:e' });
  assert.deepEqual(event.detail, { attempt: 1 });
  assert.equal(summarizeCampaign({ campaignId: 'c', status: 'running', costKnown: true, costUsd: 0 }).usage.costUsd, 0);
  const log = presentNodeLog({ nodeId: 'n', kind: 'writer', status: 'completed', resultSha256: 'sha256:result', result: { kind: 'AgentReceipt', status: 'completed', finalOutput: 'large secret body' } });
  assert.equal(log.result.receiptHash, 'sha256:result');
  assert.equal('finalOutput' in log.result, false);
});

test('campaign control summaries preserve recovery lineage without returning the full plan', () => {
  const summary = summarizeCampaign({
    campaignId: 'recovery', paperId: 'paper', status: 'running', maxRounds: 4,
    parentCampaignId: 'original', supersedesCampaignId: 'original', recoveryOfCampaignId: 'original',
    spec: { nodes: Array.from({ length: 100 }, (_, index) => ({ nodeId: `node-${index}` })) },
  });
  assert.deepEqual(summary.lineage, { parent: 'original', supersedes: 'original', recoveryOf: 'original' });
  assert.equal(Object.prototype.hasOwnProperty.call(summary, 'spec'), false);
});
