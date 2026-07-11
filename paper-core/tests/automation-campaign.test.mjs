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
import { createResourceGovernor } from '../../paper-application/automation/resource-governor.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-campaign-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let milliseconds = Date.parse('2026-07-11T00:00:00.000Z');
  const clock = { now: () => new Date(milliseconds), nowIso: () => new Date(milliseconds += 1).toISOString(), advance: (ms) => { milliseconds += ms; } };
  const store = createDefaultPaperStore({ root, runtimeRoot: root });
  return { root, clock, campaignStore: createSqliteCampaignStore({ store, clock }) };
}

test('referee consensus requires score, ratio, variance and no critical findings', () => {
  const accepted = evaluateRefereeConvergence({ paperId: 'p', roundIndex: 1, expectedManuscriptHash: 'sha256:revised', reviews: [
    { reviewerId: 'a', verdict: 'accept', score: 0.9, manuscriptHash: 'sha256:revised' },
    { reviewerId: 'b', verdict: 'accept', score: 0.86, manuscriptHash: 'sha256:revised' },
    { reviewerId: 'c', verdict: 'accept', score: 0.88, manuscriptHash: 'sha256:revised' },
  ] });
  assert.equal(accepted.accepted, true);
  assert.equal(evaluateRefereeConvergence({ paperId: 'p', roundIndex: 1, minimumRoundIndex: 2, expectedManuscriptHash: 'sha256:revised', reviews: [
    { reviewerId: 'a', verdict: 'accept', score: 0.9, manuscriptHash: 'sha256:revised' },
    { reviewerId: 'b', verdict: 'accept', score: 0.9, manuscriptHash: 'sha256:revised' },
    { reviewerId: 'c', verdict: 'accept', score: 0.9, manuscriptHash: 'sha256:revised' },
  ] }).accepted, false);
  assert.equal(evaluateRefereeConvergence({ paperId: 'p', roundIndex: 1, expectedManuscriptHash: 'sha256:new', reviews: [
    { reviewerId: 'a', verdict: 'accept', score: 0.9, manuscriptHash: 'sha256:old' },
    { reviewerId: 'b', verdict: 'accept', score: 0.9, manuscriptHash: 'sha256:old' },
    { reviewerId: 'c', verdict: 'accept', score: 0.9, manuscriptHash: 'sha256:old' },
  ] }).accepted, false);
  assert.equal(evaluateRefereeConvergence({ paperId: 'p', roundIndex: 1, reviews: [
    { reviewerId: 'a', verdict: 'accept', score: 0.95 },
    { reviewerId: 'b', verdict: 'revise', score: 0.3, criticalFindingCount: 1 },
    { reviewerId: 'c', verdict: 'accept', score: 0.9 },
  ] }).accepted, false);
  assert.deepEqual(requiredRevalidationForChanges(['experiments/run.py', 'main.tex']).required, ['revalidate-code', 'revalidate-empirical', 'revalidate-compile', 'revalidate-citations', 'revalidate-artifacts']);
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
      if (/^(?:revision-)?referee-\d+$/.test(node.kind)) return { reviewerId: node.kind, verdict: 'accept', score: 0.9, criticalFindingCount: 0, reviewHash: `hash-${node.node_id}`, manuscriptHash: 'sha256:revised' };
      return { status: 'completed', nodeKind: node.kind };
    },
  };
  const governor = createResourceGovernor({ agent: 3, cpu: 2, gpu: 1, memoryMiB: 8192 });
  const results = await Promise.all(plans.map((plan) => runPaperCampaign({ campaignId: plan.campaignId, campaignStore, executor, concurrency: 4, pollMs: 1, resourceGovernor: governor })));
  assert.equal(results.length, 10);
  assert.ok(results.every((result) => result.campaign.status === 'completed'));
  assert.equal(governor.snapshot().peak.agent, 3);
  assert.ok(governor.snapshot().peak.cpu <= 2);
  assert.ok(governor.snapshot().peak.memoryMiB <= 8192);
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
    executor: { execute: async ({ node }) => /^(?:revision-)?referee-\d+$/.test(node.kind) ? { reviewerId: node.kind, verdict: 'accept', score: 0.9, manuscriptHash: 'sha256:revised' } : { status: 'completed' } },
    concurrency: 3,
    pollMs: 1,
  });
  assert.equal(result.campaign.status, 'completed');
  assert.ok(result.nodes.some((node) => node.failure_class === null && node.attemptCount >= 2));
});

test('operator cancellation aborts an active agent node and leaves campaign cancelled', async (t) => {
  const { root, campaignStore } = fixture(t);
  const plan = buildPaperCampaignPlan({ paperId: 'cancel-paper', sourceWorkspace: root, campaignId: 'cancel-campaign', maxRounds: 1 });
  campaignStore.createCampaign(plan);
  const running = runPaperCampaign({
    campaignId: plan.campaignId,
    campaignStore,
    concurrency: 1,
    pollMs: 1,
    executor: {
      execute: ({ executionSignal }) => new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve({ status: 'late-completion' }), 10000);
        executionSignal.addEventListener('abort', () => { clearTimeout(timer); const error = new Error('operator_cancelled'); error.retryable = false; reject(error); }, { once: true });
      }),
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  campaignStore.cancelCampaign(plan.campaignId);
  const result = await running;
  assert.equal(result.campaign.status, 'cancelled');
  assert.ok(result.nodes.every((node) => ['skipped', 'failed_terminal'].includes(node.status)));
});

test('cancelling while another node waits for a global slot releases every semaphore', async (t) => {
  const { root, campaignStore } = fixture(t);
  const plan = {
    version: 2,
    kind: 'PaperCampaignPlan',
    campaignId: 'queued-cancel-campaign',
    paperId: 'queued-cancel-paper',
    sourceWorkspace: root,
    maxRounds: 1,
    budgets: { maxWallTimeMs: 60000, maxAgentCalls: 4, maxCpuJobs: 1, maxGpuJobs: 1, maxMemoryMiB: 4096 },
    nodes: [
      { nodeId: 'queued-cancel-campaign:0:writer', kind: 'writer', roundIndex: 0, dependencies: [], priority: 10, maxAttempts: 1 },
      { nodeId: 'queued-cancel-campaign:0:coder', kind: 'coder', roundIndex: 0, dependencies: [], priority: 10, maxAttempts: 1 },
    ],
  };
  campaignStore.createCampaign(plan);
  const governor = createResourceGovernor({ agent: 1, cpu: 1, gpu: 1, memoryMiB: 4096 });
  const running = runPaperCampaign({
    campaignId: plan.campaignId,
    campaignStore,
    concurrency: 2,
    pollMs: 1,
    resourceGovernor: governor,
    executor: { execute: ({ executionSignal }) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve({ status: 'late-completion' }), 10000);
      executionSignal.addEventListener('abort', () => { clearTimeout(timer); const error = new Error('operator_cancelled'); error.retryable = false; reject(error); }, { once: true });
    }) },
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(governor.snapshot().used.agent, 1);
  assert.equal(governor.snapshot().waiting, 1);
  campaignStore.cancelCampaign(plan.campaignId);
  const result = await running;
  assert.equal(result.campaign.status, 'cancelled');
  assert.deepEqual(governor.snapshot().used, { agent: 0, cpu: 0, gpu: 0, memoryMiB: 0 });
  assert.equal(governor.snapshot().waiting, 0);
});

test('single-node cancellation aborts active work and skips its dependency subtree', async (t) => {
  const { root, campaignStore } = fixture(t);
  const plan = {
    version: 2,
    kind: 'PaperCampaignPlan',
    campaignId: 'node-cancel-campaign',
    paperId: 'node-cancel-paper',
    sourceWorkspace: root,
    maxRounds: 1,
    budgets: { maxWallTimeMs: 60000, maxAgentCalls: 4, maxCpuJobs: 1, maxGpuJobs: 1, maxMemoryMiB: 4096 },
    nodes: [
      { nodeId: 'node-cancel-campaign:0:writer', kind: 'writer', roundIndex: 0, dependencies: [], priority: 10, maxAttempts: 1 },
      { nodeId: 'node-cancel-campaign:0:coder', kind: 'coder', roundIndex: 0, dependencies: ['node-cancel-campaign:0:writer'], priority: 20, maxAttempts: 1 },
      { nodeId: 'node-cancel-campaign:1:package', kind: 'package', roundIndex: 1, dependencies: ['node-cancel-campaign:0:coder'], priority: 30, maxAttempts: 1 },
    ],
  };
  campaignStore.createCampaign(plan);
  const running = runPaperCampaign({
    campaignId: plan.campaignId,
    campaignStore,
    concurrency: 1,
    pollMs: 1,
    executor: { execute: ({ executionSignal }) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve({ status: 'late-completion' }), 10000);
      executionSignal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('node_cancelled')); }, { once: true });
    }) },
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(campaignStore.cancelNode('node-cancel-campaign:0:writer').status, 'skipped');
  const result = await running;
  assert.equal(result.campaign.status, 'stopped');
  assert.equal(result.campaign.stop_reason, 'operator_node_cancelled_required_path');
  assert.ok(result.nodes.every((node) => node.status === 'skipped'));
  assert.ok(result.nodes.every((node) => node.failure_class === 'operator_node_cancelled'));
});

test('campaign stops without packaging when final revised manuscript does not converge', async (t) => {
  const { root, campaignStore } = fixture(t);
  const plan = buildPaperCampaignPlan({ paperId: 'nonconverged-paper', sourceWorkspace: root, campaignId: 'nonconverged-campaign', maxRounds: 1 });
  campaignStore.createCampaign(plan);
  const result = await runPaperCampaign({
    campaignId: plan.campaignId,
    campaignStore,
    concurrency: 3,
    pollMs: 1,
    executor: { execute: async ({ node }) => /^(?:revision-)?referee-\d+$/.test(node.kind)
      ? { reviewerId: node.kind, verdict: 'revise', score: 0.4, criticalFindingCount: 1, manuscriptHash: 'sha256:revised' }
      : { status: 'completed' } },
  });
  assert.equal(result.campaign.status, 'stopped');
  assert.equal(result.campaign.stop_reason, 'referee_convergence_not_reached_within_budget');
  assert.equal(result.nodes.find((node) => node.kind === 'package').status, 'skipped');
});

test('token and CPU budgets stop work before a campaign can overrun downstream nodes', async (t) => {
  const { root, campaignStore } = fixture(t);
  const plan = {
    version: 2,
    kind: 'PaperCampaignPlan',
    campaignId: 'budget-campaign',
    paperId: 'budget-paper',
    sourceWorkspace: root,
    maxRounds: 1,
    budgets: { maxWallTimeMs: 60000, maxAgentCalls: 2, maxCpuJobs: 1, maxGpuJobs: 1, maxTokenCount: 10, maxCostUsd: 1, maxMemoryMiB: 4096 },
    nodes: [
      { nodeId: 'budget-campaign:0:writer', kind: 'writer', roundIndex: 0, dependencies: [], priority: 10, maxAttempts: 1 },
      { nodeId: 'budget-campaign:0:empirical', kind: 'empirical', roundIndex: 0, dependencies: ['budget-campaign:0:writer'], priority: 20, maxAttempts: 1 },
    ],
  };
  campaignStore.createCampaign(plan);
  const result = await runPaperCampaign({
    campaignId: plan.campaignId,
    campaignStore,
    concurrency: 1,
    pollMs: 1,
    executor: { execute: async () => ({ status: 'completed', usage: { total: 11 } }) },
  });
  assert.equal(result.campaign.status, 'stopped');
  assert.equal(result.campaign.stop_reason, 'campaign_token_budget_exhausted');
  assert.equal(result.nodes.find((node) => node.kind === 'empirical').status, 'skipped');
});

test('nested empirical repair agents share the global semaphore and hard agent-call budget', async (t) => {
  const { root, campaignStore } = fixture(t);
  const plan = {
    version: 2,
    kind: 'PaperCampaignPlan',
    campaignId: 'nested-agent-budget-campaign',
    paperId: 'nested-agent-budget-paper',
    sourceWorkspace: root,
    maxRounds: 1,
    budgets: { maxWallTimeMs: 60000, maxAgentCalls: 1, maxCpuJobs: 3, maxGpuJobs: 1, maxTokenCount: 1000, maxCostUsd: 1, maxMemoryMiB: 4096 },
    nodes: [
      { nodeId: 'nested-agent-budget-campaign:0:empirical-a', kind: 'empirical', roundIndex: 0, dependencies: [], priority: 10, maxAttempts: 1 },
      { nodeId: 'nested-agent-budget-campaign:0:empirical-b', kind: 'empirical', roundIndex: 0, dependencies: ['nested-agent-budget-campaign:0:empirical-a'], priority: 20, maxAttempts: 1 },
    ],
  };
  campaignStore.createCampaign(plan);
  const governor = createResourceGovernor({ agent: 1, cpu: 1, gpu: 1, memoryMiB: 4096 });
  const result = await runPaperCampaign({
    campaignId: plan.campaignId,
    campaignStore,
    concurrency: 2,
    pollMs: 1,
    resourceGovernor: governor,
    executor: { execute: async ({ executionResources }) => {
      await executionResources.runNestedAgent(async () => ({ status: 'agent-repair-completed', usage: { total: 7 } }));
      return { status: 'empirical-completed' };
    } },
  });
  assert.equal(result.campaign.status, 'stopped');
  assert.equal(result.campaign.stop_reason, 'campaign_agent_call_budget_exhausted');
  assert.equal(result.campaign.agentCallCount, 1);
  assert.equal(result.campaign.tokenCount, 7);
  assert.equal(governor.snapshot().peak.agent, 1);
  assert.deepEqual(governor.snapshot().used, { agent: 0, cpu: 0, gpu: 0, memoryMiB: 0 });
});
