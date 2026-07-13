import assert from 'node:assert/strict';
import test from 'node:test';
import { presentCampaignStatus, presentNodeLog, summarizeCampaign, summarizeEvent, summarizePlan, summarizeRun } from '../../paper-application/automation/campaign-query-presenter.mjs';

test('campaign query presenter defaults to bounded operational summaries', () => {
  const campaign = {
    campaign_id: 'campaign', paper_id: 'paper', status: 'running', effectiveStatus: 'running',
    currentPhase: 'referee-1', currentReviewRound: 1, maxRounds: 2,
    agentCallCount: 4, cpuJobCount: 2, gpuJobCount: 1, tokenCount: 100,
    costKnown: false, spec: { largeReceipt: true },
  };
  const nodes = [
    { node_id: 'n1', kind: 'referee-1', status: 'running', round_index: 1, attempt_count: 1, max_attempts: 3 },
    { node_id: 'n2', kind: 'referee-2', status: 'queued', round_index: 1, attempt_count: 0, max_attempts: 3 },
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
  const run = summarizeRun({ campaign: { campaign_id: 'c', paper_id: 'p', status: 'completed' }, nodes: [{ status: 'completed', result_json: 'large' }], eventCount: 3 });
  assert.deepEqual(run.nodeCounts, { completed: 1 });
  assert.equal('nodes' in run, false);
  const event = summarizeEvent({ event_id: 'e', campaign_id: 'c', kind: 'started', event: { detail: { attempt: 1 } }, event_sha256: 'sha256:e' });
  assert.deepEqual(event.detail, { attempt: 1 });
  assert.equal(summarizeCampaign({ campaign_id: 'c', status: 'running', costKnown: true, costUsd: 0 }).usage.costUsd, 0);
  const log = presentNodeLog({ node_id: 'n', kind: 'writer', status: 'completed', result_sha256: 'sha256:result', result: { kind: 'AgentReceipt', status: 'completed', finalOutput: 'large secret body' } });
  assert.equal(log.result.receiptHash, 'sha256:result');
  assert.equal('finalOutput' in log.result, false);
});

test('campaign control summaries preserve recovery lineage without returning the full plan', () => {
  const summary = summarizeCampaign({
    campaign_id: 'recovery', paper_id: 'paper', status: 'running', max_rounds: 4,
    parent_campaign_id: 'original', supersedes_campaign_id: 'original', recovery_of_campaign_id: 'original',
    spec: { nodes: Array.from({ length: 100 }, (_, index) => ({ nodeId: `node-${index}` })) },
  });
  assert.deepEqual(summary.lineage, { parent: 'original', supersedes: 'original', recoveryOf: 'original' });
  assert.equal(Object.prototype.hasOwnProperty.call(summary, 'spec'), false);
});
