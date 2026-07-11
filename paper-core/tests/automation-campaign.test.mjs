import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createDefaultPaperStore } from '../../paper-adapters/persistence/store-provider.mjs';
import { createSqliteCampaignStore } from '../../paper-adapters/persistence/sqlite-campaign-store.mjs';
import { buildPaperCampaignPlan } from '../../paper-domain/automation/campaign-plan.mjs';
import { evaluateRefereeConvergence, requiredRevalidationForChanges } from '../../paper-domain/automation/referee-convergence.mjs';
import { runPaperCampaign } from '../../paper-application/automation/campaign-engine.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-campaign-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let milliseconds = Date.parse('2026-07-11T00:00:00.000Z');
  const clock = { now: () => new Date(milliseconds), nowIso: () => new Date(milliseconds += 1).toISOString(), advance: (ms) => { milliseconds += ms; } };
  const store = createDefaultPaperStore({ root, runtimeRoot: root });
  return { root, clock, campaignStore: createSqliteCampaignStore({ store, clock }) };
}

test('referee consensus requires score, ratio, variance and no critical findings', () => {
  const accepted = evaluateRefereeConvergence({ paperId: 'p', roundIndex: 1, reviews: [
    { reviewerId: 'a', verdict: 'accept', score: 0.9 },
    { reviewerId: 'b', verdict: 'accept', score: 0.86 },
    { reviewerId: 'c', verdict: 'accept', score: 0.88 },
  ] });
  assert.equal(accepted.accepted, true);
  assert.equal(evaluateRefereeConvergence({ paperId: 'p', roundIndex: 1, reviews: [
    { reviewerId: 'a', verdict: 'accept', score: 0.95 },
    { reviewerId: 'b', verdict: 'revise', score: 0.3, criticalFindingCount: 1 },
    { reviewerId: 'c', verdict: 'accept', score: 0.9 },
  ] }).accepted, false);
  assert.deepEqual(requiredRevalidationForChanges(['experiments/run.py', 'main.tex']).required, ['revalidate-code', 'revalidate-empirical', 'revalidate-compile']);
});

test('ten campaigns run concurrently, retry, converge, skip later rounds and replay idempotently', async (t) => {
  const { root, campaignStore } = fixture(t);
  const plans = Array.from({ length: 10 }, (_, index) => buildPaperCampaignPlan({ paperId: `paper-${index}`, sourceWorkspace: root, campaignId: `campaign-${index}`, maxRounds: 2, refereeCount: 3 }));
  for (const plan of plans) campaignStore.createCampaign(plan);
  const failedOnce = new Set();
  const executor = {
    async execute({ campaign, node }) {
      await new Promise((resolve) => setTimeout(resolve, 2));
      if (node.kind === 'coder' && Number(campaign.paper_id.split('-')[1]) % 3 === 0 && !failedOnce.has(node.node_id)) {
        failedOnce.add(node.node_id);
        const error = new Error('injected_transient_failure');
        error.retryable = true;
        throw error;
      }
      if (/^referee-\d+$/.test(node.kind)) return { reviewerId: node.kind, verdict: 'accept', score: 0.9, criticalFindingCount: 0, reviewHash: `hash-${node.node_id}` };
      return { status: 'completed', nodeKind: node.kind };
    },
  };
  const results = await Promise.all(plans.map((plan) => runPaperCampaign({ campaignId: plan.campaignId, campaignStore, executor, concurrency: 4, pollMs: 1 })));
  assert.equal(results.length, 10);
  assert.ok(results.every((result) => result.campaign.status === 'completed'));
  assert.ok(results.every((result) => result.maximumObservedConcurrency >= 2));
  assert.equal(results.reduce((sum, result) => sum + result.retryCount, 0), 4);
  assert.ok(results.every((result) => result.nodes.some((node) => node.roundIndex === 2 && node.status === 'skipped')));
  assert.ok(results.every((result) => result.nodes.find((node) => node.kind === 'package').status === 'completed'));
  for (const plan of plans) campaignStore.createCampaign(plan);
  const replay = await runPaperCampaign({ campaignId: plans[0].campaignId, campaignStore, executor, concurrency: 4 });
  assert.equal(replay.executedNodeCount, 0);
});

test('expired running lease is recovered after a simulated crash', async (t) => {
  const { root, clock, campaignStore } = fixture(t);
  const plan = buildPaperCampaignPlan({ paperId: 'crash-paper', sourceWorkspace: root, campaignId: 'crash-campaign', maxRounds: 1 });
  campaignStore.createCampaign(plan);
  const [leased] = campaignStore.claimReady({ campaignId: plan.campaignId, workerId: 'crashed-worker', leaseSeconds: 1 });
  campaignStore.startNode({ nodeId: leased.node_id, workerId: 'crashed-worker' });
  clock.advance(2000);
  const result = await runPaperCampaign({
    campaignId: plan.campaignId,
    campaignStore,
    executor: { execute: async ({ node }) => /^referee-\d+$/.test(node.kind) ? { reviewerId: node.kind, verdict: 'accept', score: 0.9 } : { status: 'completed' } },
    concurrency: 3,
    pollMs: 1,
  });
  assert.equal(result.campaign.status, 'completed');
  assert.ok(result.nodes.some((node) => node.failure_class === null && node.attemptCount >= 2));
});
