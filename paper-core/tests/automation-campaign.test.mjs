import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createDefaultPaperStore } from '../../paper-adapters/persistence/store-provider.mjs';
import { createSqliteCampaignStore } from '../../paper-adapters/persistence/sqlite-campaign-store.mjs';
import { buildPaperCampaignPlan } from '../../paper-domain/automation/campaign-plan.mjs';
import { evaluateRefereeConvergence, requiredRevalidationForChanges } from '../../paper-domain/automation/referee-convergence.mjs';
import { runPaperCampaign as executePaperCampaign } from '../../paper-application/automation/campaign-engine.mjs';
import { createResourceGovernor } from '../../paper-application/automation/resource-governor.mjs';
import { createSystemScheduler } from '../../paper-adapters/runtime/system-scheduler.mjs';
import { createRandomIdGenerator } from '../../paper-adapters/runtime/random-id-generator.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const campaignClocks = new WeakMap();
const scheduler = createSystemScheduler();
const idGenerator = createRandomIdGenerator();

function runPaperCampaign(input) {
  return executePaperCampaign({
    ...input,
    clock: campaignClocks.get(input.campaignStore),
    scheduler,
    idGenerator,
  });
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-campaign-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let milliseconds = Date.parse('2026-07-11T00:00:00.000Z');
  const clock = { now: () => new Date(milliseconds), nowIso: () => new Date(milliseconds += 1).toISOString(), advance: (ms) => { milliseconds += ms; } };
  const store = createDefaultPaperStore({ root, runtimeRoot: root });
  const campaignStore = createSqliteCampaignStore({ store, clock });
  campaignClocks.set(campaignStore, clock);
  return { root, clock, campaignStore };
}

function reviewEvidence(reviewerId, detail = {}) {
  return {
    reviewerId,
    childSessionId: `session:${reviewerId}`,
    reviewHash: `sha256:review:${reviewerId}`,
    ...detail,
  };
}

function bindReleaseAuthority(plan) {
  const bound = {
    ...plan,
    researchVerificationRequired: true,
    paperQualityRequirements: {
      ...(plan.paperQualityRequirements || {}),
      researchVerificationRequired: true,
    },
  };
  return { ...bound, campaignPlanHash: hashRecord('PaperCampaignPlan', bound) };
}

test('referee consensus requires score, ratio, variance and no critical findings', () => {
  const accepted = evaluateRefereeConvergence({ paperId: 'p', roundIndex: 1, expectedManuscriptHash: 'sha256:revised', reviews: [
    reviewEvidence('a', { verdict: 'accept', score: 0.9, manuscriptHash: 'sha256:revised' }),
    reviewEvidence('b', { verdict: 'accept', score: 0.86, manuscriptHash: 'sha256:revised' }),
    reviewEvidence('c', { verdict: 'accept', score: 0.88, manuscriptHash: 'sha256:revised' }),
  ] });
  assert.equal(accepted.accepted, true);
  assert.equal(evaluateRefereeConvergence({ paperId: 'p', roundIndex: 1, minimumRoundIndex: 2, expectedManuscriptHash: 'sha256:revised', reviews: [
    reviewEvidence('a', { verdict: 'accept', score: 0.9, manuscriptHash: 'sha256:revised' }),
    reviewEvidence('b', { verdict: 'accept', score: 0.9, manuscriptHash: 'sha256:revised' }),
    reviewEvidence('c', { verdict: 'accept', score: 0.9, manuscriptHash: 'sha256:revised' }),
  ] }).accepted, false);
  assert.equal(evaluateRefereeConvergence({ paperId: 'p', roundIndex: 1, expectedManuscriptHash: 'sha256:new', reviews: [
    reviewEvidence('a', { verdict: 'accept', score: 0.9, manuscriptHash: 'sha256:old' }),
    reviewEvidence('b', { verdict: 'accept', score: 0.9, manuscriptHash: 'sha256:old' }),
    reviewEvidence('c', { verdict: 'accept', score: 0.9, manuscriptHash: 'sha256:old' }),
  ] }).accepted, false);
  assert.equal(evaluateRefereeConvergence({ paperId: 'p', roundIndex: 1, reviews: [
    reviewEvidence('a', { verdict: 'accept', score: 0.95 }),
    reviewEvidence('b', { verdict: 'revise', score: 0.3, criticalFindingCount: 1 }),
    reviewEvidence('c', { verdict: 'accept', score: 0.9 }),
  ] }).accepted, false);
  assert.equal(evaluateRefereeConvergence({ paperId: 'p', roundIndex: 1, expectedManuscriptHash: 'sha256:revised', reviews: [
    reviewEvidence('a', { verdict: 'accept', score: 0.9, manuscriptHash: 'sha256:revised' }),
    reviewEvidence('b', { verdict: 'accept', score: 0.9, manuscriptHash: 'sha256:revised', childSessionId: 'session:a' }),
    reviewEvidence('c', { verdict: 'accept', score: 0.9, manuscriptHash: 'sha256:revised' }),
  ] }).accepted, false);
  assert.deepEqual(requiredRevalidationForChanges(['experiments/run.py', 'main.tex']).required, ['revalidate-code', 'revalidate-empirical', 'revalidate-compile', 'revalidate-citations', 'revalidate-artifacts']);
});

test('campaign plans and execution preserve explicit zero budgets', async (t) => {
  const { root, campaignStore } = fixture(t);
  const plan = buildPaperCampaignPlan({
    paperId: 'zero-budget-paper',
    sourceWorkspace: root,
    campaignId: 'zero-budget-campaign',
    maxRounds: 1,
    budgets: { maxAgentCalls: 0, maxCpuJobs: 0, maxGpuJobs: 0, maxTokenCount: 0, maxCostUsd: 0 },
  });
  assert.deepEqual(plan.budgets, {
    maxWallTimeMs: 6 * 60 * 60 * 1000,
    maxAgentCalls: 0,
    maxCpuJobs: 0,
    maxGpuJobs: 0,
    maxTokenCount: 0,
    maxCostUsd: 0,
    maxMemoryMiB: 8192,
  });
  campaignStore.createCampaign(plan);
  let executionCount = 0;
  const result = await runPaperCampaign({
    campaignId: plan.campaignId,
    campaignStore,
    concurrency: 1,
    pollMs: 1,
    executor: { execute: async () => { executionCount += 1; return { status: 'unexpected' }; } },
  });
  assert.equal(executionCount, 0);
  assert.equal(result.campaign.status, 'stopped');
  assert.equal(result.campaign.stopReason, 'campaign_agent_call_budget_exhausted');
});

test('ten campaigns run concurrently, retry, converge, skip later rounds and replay idempotently', async (t) => {
  const { root, campaignStore } = fixture(t);
  const plans = Array.from({ length: 10 }, (_, index) => buildPaperCampaignPlan({
    paperId: `paper-${index}`,
    sourceWorkspace: root,
    campaignId: `campaign-${index}`,
    mode: 'local-review-loop',
    languages: ['python', 'latex'],
    benchmarkId: 'ml_algorithm_benchmark',
    maxRounds: 2,
    refereeCount: 3,
  }));
  for (const plan of plans) campaignStore.createCampaign(plan);
  const failedOnce = new Set();
  const executor = {
    async execute({ campaign, node }) {
      await new Promise((resolve) => setTimeout(resolve, 2));
      if (node.kind === 'coder' && Number(campaign.paperId.split('-')[1]) % 3 === 0 && !failedOnce.has(node.nodeId)) {
        failedOnce.add(node.nodeId);
        const error = new Error('injected_transient_failure');
        error.retryable = true;
        throw error;
      }
      if (/^(?:revision-)?referee-\d+$/.test(node.kind)) return reviewEvidence(node.kind, { verdict: 'accept', score: 0.9, criticalFindingCount: 0, reviewHash: `hash-${node.nodeId}`, childSessionId: `session-${node.nodeId}`, manuscriptHash: 'sha256:revised' });
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
  assert.ok(results.every((result) => !result.nodes.some((node) => node.kind === 'package')));
  for (const plan of plans) campaignStore.createCampaign(plan);
  const replay = await runPaperCampaign({ campaignId: plans[0].campaignId, campaignStore, executor, concurrency: 4 });
  assert.equal(replay.executedNodeCount, 0);
});

test('expired running lease is recovered after a simulated crash', async (t) => {
  const { root, clock, campaignStore } = fixture(t);
  const plan = buildPaperCampaignPlan({ paperId: 'crash-paper', sourceWorkspace: root, campaignId: 'crash-campaign', maxRounds: 1 });
  campaignStore.createCampaign(plan);
  const [leased] = campaignStore.claimReady({ campaignId: plan.campaignId, workerId: 'crashed-worker', leaseSeconds: 1 });
  campaignStore.startNode({ nodeId: leased.nodeId, workerId: 'crashed-worker', attemptId: leased.attemptId, leaseGeneration: leased.leaseGeneration });
  clock.advance(2000);
  const result = await runPaperCampaign({
    campaignId: plan.campaignId,
    campaignStore,
    executor: { execute: async ({ node }) => /^(?:revision-)?referee-\d+$/.test(node.kind) ? reviewEvidence(node.kind, { verdict: 'accept', score: 0.9, reviewHash: `hash-${node.nodeId}`, childSessionId: `session-${node.nodeId}`, manuscriptHash: 'sha256:revised' }) : { status: 'completed' } },
    concurrency: 3,
    pollMs: 1,
  });
  assert.equal(result.campaign.status, 'completed');
  assert.ok(result.nodes.some((node) => node.failureClass === null && node.attemptCount >= 2));
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

test('losing a global resource lease aborts the node before accepting its result', async (t) => {
  const { root, campaignStore } = fixture(t);
  const plan = {
    version: 2,
    kind: 'PaperCampaignPlan',
    campaignId: 'resource-fence-campaign',
    paperId: 'resource-fence-paper',
    sourceWorkspace: root,
    maxRounds: 1,
    budgets: { maxWallTimeMs: 60000, maxAgentCalls: 1, maxCpuJobs: 1, maxGpuJobs: 1, maxMemoryMiB: 4096 },
    nodes: [{ nodeId: 'resource-fence-campaign:0:writer', kind: 'writer', roundIndex: 0, dependencies: [], priority: 10, maxAttempts: 1 }],
  };
  campaignStore.createCampaign(plan);
  const lost = new AbortController();
  let released = 0;
  const release = () => { released += 1; return !lost.signal.aborted; };
  release.lostSignal = lost.signal;
  release.telemetry = Object.freeze({ requestedAt: new Date().toISOString(), acquiredAt: new Date().toISOString(), lockWaitMs: 0, queueContentionCount: 0 });
  const governor = {
    snapshot: () => ({ limits: {}, used: {}, peak: {}, waiting: 0 }),
    acquire: async () => release,
  };
  let executionAborted = false;
  await assert.rejects(
    () => runPaperCampaign({
      campaignId: plan.campaignId,
      campaignStore,
      concurrency: 1,
      pollMs: 1,
      resourceGovernor: governor,
      executor: {
        execute: ({ executionSignal }) => new Promise((resolve, reject) => {
          const timer = setTimeout(() => resolve({ status: 'must-not-be-accepted' }), 5000);
          executionSignal.addEventListener('abort', () => {
            executionAborted = true;
            clearTimeout(timer);
            const error = new Error('resource_lease_lost');
            error.retryable = false;
            reject(error);
          }, { once: true });
          setTimeout(() => lost.abort('resource_lease_lost'), 20);
        }),
      },
    }),
    /resource_lease_lost/,
  );
  assert.equal(executionAborted, true);
  assert.equal(released, 1);
  assert.equal(campaignStore.listNodes(plan.campaignId)[0].status, 'failed_terminal');
  assert.equal(campaignStore.listNodes(plan.campaignId)[0].preparedResultHash, null);
});

test('top-level global release=false surfaces the fencing failure ahead of telemetry cleanup errors', async (t) => {
  const { root, campaignStore } = fixture(t);
  const plan = {
    version: 2,
    kind: 'PaperCampaignPlan',
    campaignId: 'resource-release-fence-campaign',
    paperId: 'resource-release-fence-paper',
    sourceWorkspace: root,
    maxRounds: 1,
    budgets: { maxWallTimeMs: 60000, maxAgentCalls: 1, maxCpuJobs: 1, maxGpuJobs: 1, maxMemoryMiB: 4096 },
    nodes: [{ nodeId: 'resource-release-fence-campaign:0:writer', kind: 'writer', roundIndex: 0, dependencies: [], priority: 10, maxAttempts: 1 }],
  };
  campaignStore.createCampaign(plan);
  let released = 0;
  const release = () => { released += 1; return false; };
  release.lostSignal = new AbortController().signal;
  release.telemetry = Object.freeze({ requestedAt: new Date().toISOString(), acquiredAt: new Date().toISOString(), lockWaitMs: 0, queueContentionCount: 0 });
  const governor = {
    snapshot: () => ({ limits: {}, used: {}, peak: {}, waiting: 0 }),
    acquire: async () => release,
  };
  let dispatcherId = null;
  const telemetryFailureStore = new Proxy(campaignStore, {
    get(target, property) {
      if (property === 'recordTelemetry') return () => { throw new Error('telemetry_cleanup_failed'); };
      if (property === 'claimReady') return (options) => {
        dispatcherId = options.workerId;
        return target.claimReady(options);
      };
      return Reflect.get(target, property);
    },
  });
  campaignClocks.set(telemetryFailureStore, campaignClocks.get(campaignStore));

  await assert.rejects(
    () => runPaperCampaign({
      campaignId: plan.campaignId,
      campaignStore: telemetryFailureStore,
      concurrency: 1,
      pollMs: 1,
      resourceGovernor: governor,
      executor: { execute: async () => ({ status: 'completed-before-release' }) },
    }),
    /resource_lease_release_fence_lost/,
  );
  assert.equal(released, 1);
  assert.match(dispatcherId, /^paper-campaign-worker:dispatcher:[^:]+:process:\d+:(?:\d+|unknown)$/);
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
  const plan = bindReleaseAuthority({
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
      { nodeId: 'node-cancel-campaign:1:final-compile', kind: 'final-compile', roundIndex: 1, dependencies: ['node-cancel-campaign:0:coder'], priority: 30, maxAttempts: 1 },
      { nodeId: 'node-cancel-campaign:2:research-verify', kind: 'research-verify', roundIndex: 2, dependencies: ['node-cancel-campaign:1:final-compile'], priority: 40, maxAttempts: 1 },
      { nodeId: 'node-cancel-campaign:2:package', kind: 'package', roundIndex: 2, dependencies: ['node-cancel-campaign:1:final-compile', 'node-cancel-campaign:2:research-verify'], priority: 50, maxAttempts: 1 },
    ],
  });
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
  assert.equal(result.campaign.stopReason, 'operator_node_cancelled_required_path');
  assert.ok(result.nodes.every((node) => node.status === 'skipped'));
  assert.ok(result.nodes.every((node) => node.failureClass === 'operator_node_cancelled'));
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
      ? reviewEvidence(node.kind, { verdict: 'revise', score: 0.4, criticalFindingCount: 1, reviewHash: `hash-${node.nodeId}`, childSessionId: `session-${node.nodeId}`, manuscriptHash: 'sha256:revised' })
      : { status: 'completed' } },
  });
  assert.equal(result.campaign.status, 'stopped');
  assert.equal(result.campaign.stopReason, 'referee_convergence_not_reached_within_budget');
  assert.equal(result.nodes.find((node) => node.kind === 'package').status, 'skipped');
});

test('early convergence preserves final compile research verification and package lineage', async (t) => {
  const { root, campaignStore } = fixture(t);
  const campaignId = 'early-convergence-release';
  const empirical1 = `${campaignId}:1:revalidate-empirical`;
  const replay1 = `${campaignId}:1:revalidate-empirical-reproduce`;
  const convergence1 = `${campaignId}:1:convergence`;
  const empirical2 = `${campaignId}:2:revalidate-empirical`;
  const replay2 = `${campaignId}:2:revalidate-empirical-reproduce`;
  const convergence2 = `${campaignId}:2:convergence`;
  const empirical3 = `${campaignId}:3:revalidate-empirical`;
  const replay3 = `${campaignId}:3:revalidate-empirical-reproduce`;
  const convergence3 = `${campaignId}:3:convergence`;
  const sourceClosureEmpirical = `${campaignId}:0:revalidate-empirical-source-seal`;
  const sourceClosureReplay = `${campaignId}:0:revalidate-empirical-reproduce-source-seal`;
  const finalCompile = `${campaignId}:3:final-compile`;
  const researchVerify = `${campaignId}:4:research-verify`;
  const packageNode = `${campaignId}:4:package`;
  const reviewNodes = Array.from({ length: 3 }, (_, index) => ({
    nodeId: `${campaignId}:1:revision-referee-${index + 1}`, kind: `revision-referee-${index + 1}`,
    roundIndex: 1, dependencies: [replay1], priority: 20 + index, maxAttempts: 1,
  }));
  const plan = bindReleaseAuthority({
    version: 4, kind: 'PaperCampaignPlan', campaignId, paperId: 'early-paper', sourceWorkspace: root, maxRounds: 3,
    convergenceThresholds: { minimumRoundIndex: 1 },
    budgets: { maxWallTimeMs: 60000, maxAgentCalls: 20, maxCpuJobs: 20, maxGpuJobs: 1, maxTokenCount: 10000, maxCostUsd: 10, maxMemoryMiB: 4096 },
    nodes: [
      { nodeId: empirical1, kind: 'revalidate-empirical', roundIndex: 1, dependencies: [], priority: 10, maxAttempts: 1 },
      { nodeId: replay1, kind: 'revalidate-empirical-reproduce', roundIndex: 1, dependencies: [empirical1], priority: 11, maxAttempts: 1 },
      ...reviewNodes,
      { nodeId: convergence1, kind: 'convergence', roundIndex: 1, dependencies: reviewNodes.map((node) => node.nodeId), priority: 30, maxAttempts: 1 },
      { nodeId: empirical2, kind: 'revalidate-empirical', roundIndex: 2, dependencies: [convergence1], priority: 40, maxAttempts: 1 },
      { nodeId: replay2, kind: 'revalidate-empirical-reproduce', roundIndex: 2, dependencies: [empirical2], priority: 41, maxAttempts: 1 },
      { nodeId: convergence2, kind: 'convergence', roundIndex: 2, dependencies: [replay2], priority: 50, maxAttempts: 1 },
      { nodeId: empirical3, kind: 'revalidate-empirical', roundIndex: 3, dependencies: [convergence2], priority: 60, maxAttempts: 1 },
      { nodeId: replay3, kind: 'revalidate-empirical-reproduce', roundIndex: 3, dependencies: [empirical3], priority: 61, maxAttempts: 1 },
      { nodeId: convergence3, kind: 'convergence', roundIndex: 3, dependencies: [replay3], priority: 70, maxAttempts: 1 },
      { nodeId: sourceClosureEmpirical, kind: 'revalidate-empirical-source-seal', roundIndex: 0, dependencies: [convergence3], priority: 75, maxAttempts: 1, sourceClosureTerminal: true, sourceMutationPolicy: 'forbid' },
      { nodeId: sourceClosureReplay, kind: 'revalidate-empirical-reproduce-source-seal', roundIndex: 0, dependencies: [sourceClosureEmpirical], priority: 76, maxAttempts: 1, sourceClosureTerminal: true, sourceMutationPolicy: 'forbid' },
      { nodeId: finalCompile, kind: 'final-compile', roundIndex: 3, dependencies: [convergence1, convergence2, convergence3, sourceClosureReplay], priority: 80, maxAttempts: 1, sourceClosureTerminal: true, sourceMutationPolicy: 'forbid' },
      { nodeId: researchVerify, kind: 'research-verify', roundIndex: 4, dependencies: [finalCompile, replay1, replay2, replay3, sourceClosureReplay], priority: 90, maxAttempts: 1 },
      { nodeId: packageNode, kind: 'package', roundIndex: 4, dependencies: [finalCompile, researchVerify], priority: 100, maxAttempts: 1 },
    ],
  });
  campaignStore.createCampaign(plan);
  const executed = [];
  const result = await runPaperCampaign({
    campaignId, campaignStore, concurrency: 1, pollMs: 1,
    executor: { async execute({ node }) {
      executed.push(node.kind);
      if (/^revision-referee-/.test(node.kind)) return reviewEvidence(node.kind, { verdict: 'accept', score: 0.9, criticalFindingCount: 0, manuscriptHash: 'sha256:revised' });
      return { status: 'completed', qualityGates: [] };
    } },
  });
  assert.equal(result.campaign.status, 'completed');
  const byKind = new Map(result.nodes.map((node) => [node.kind, node]));
  for (const kind of ['final-compile', 'research-verify', 'package']) assert.equal(byKind.get(kind).status, 'completed');
  assert.equal(result.nodes.find((node) => node.nodeId === replay1).status, 'completed');
  assert.equal(result.nodes.find((node) => node.nodeId === replay2).status, 'skipped');
  assert.equal(result.nodes.find((node) => node.nodeId === replay3).status, 'skipped');
  assert.equal(result.nodes.find((node) => node.nodeId === sourceClosureEmpirical).status, 'completed');
  assert.equal(result.nodes.find((node) => node.nodeId === sourceClosureReplay).status, 'completed');
  assert.deepEqual(byKind.get('final-compile').dependencies, [convergence1, convergence2, convergence3, sourceClosureReplay]);
  assert.deepEqual(byKind.get('research-verify').dependencies, [finalCompile, replay1, replay2, replay3, sourceClosureReplay]);
  assert.ok(['final-compile', 'research-verify', 'package'].every((kind) => executed.includes(kind)));
  assert.equal(campaignStore.createCampaign(plan).campaignId, campaignId);
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
  assert.equal(result.campaign.stopReason, 'campaign_token_budget_exhausted');
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
  assert.equal(result.campaign.stopReason, 'campaign_agent_call_budget_exhausted');
  assert.equal(result.campaign.agentCallCount, 1);
  assert.equal(result.campaign.tokenCount, 7);
  assert.equal(governor.snapshot().peak.agent, 1);
  assert.deepEqual(governor.snapshot().used, { agent: 0, cpu: 0, gpu: 0, memoryMiB: 0 });
});

test('benchmark cells and replay share one campaign deadline and consume the hard budget per process', async (t) => {
  const { root, campaignStore } = fixture(t);
  const campaignId = 'cell-metered-campaign';
  campaignStore.createCampaign({
    version: 4,
    kind: 'PaperCampaignPlan',
    campaignId,
    paperId: 'cell-metered-paper',
    sourceWorkspace: root,
    maxRounds: 1,
    benchmarkSelector: { campaignBenchmarkSelectorHash: `sha256:${'a'.repeat(64)}` },
    budgets: { maxWallTimeMs: 60_000, maxAgentCalls: 0, maxCpuJobs: 4, maxGpuJobs: 0, maxTokenCount: 100, maxCostUsd: 1, maxMemoryMiB: 4096 },
    nodes: [
      { nodeId: `${campaignId}:0:empirical`, kind: 'empirical', roundIndex: 0, dependencies: [], priority: 10, maxAttempts: 1 },
      { nodeId: `${campaignId}:0:empirical-reproduce`, kind: 'empirical-reproduce', roundIndex: 0, dependencies: [`${campaignId}:0:empirical`], priority: 20, maxAttempts: 1 },
    ],
  });
  const deadlines = [];
  const result = await runPaperCampaign({
    campaignId,
    campaignStore,
    concurrency: 1,
    pollMs: 1,
    executor: { async execute({ executionBudget, executionResources }) {
      deadlines.push(executionBudget.absoluteDeadlineEpochMs);
      await executionResources.runEmpiricalCell(async () => ({ status: 'cell-1' }));
      await executionResources.runEmpiricalCell(async () => ({ status: 'cell-2' }));
      return { status: 'empirical-completed' };
    } },
  });
  assert.equal(result.campaign.status, 'completed', JSON.stringify({ stopReason: result.campaign.stopReason, nodes: result.nodes }));
  assert.equal(result.campaign.cpuJobCount, 4);
  assert.equal(result.campaign.gpuJobCount, 0);
  assert.equal(new Set(deadlines).size, 1);
});

test('benchmark cell dispatch fails before exceeding its campaign process budget', async (t) => {
  const { root, campaignStore } = fixture(t);
  const campaignId = 'cell-budget-stop-campaign';
  campaignStore.createCampaign({
    version: 4,
    kind: 'PaperCampaignPlan',
    campaignId,
    paperId: 'cell-budget-stop-paper',
    sourceWorkspace: root,
    maxRounds: 1,
    benchmarkSelector: { campaignBenchmarkSelectorHash: `sha256:${'b'.repeat(64)}` },
    budgets: { maxWallTimeMs: 60_000, maxAgentCalls: 0, maxCpuJobs: 1, maxGpuJobs: 0, maxTokenCount: 100, maxCostUsd: 1, maxMemoryMiB: 4096 },
    nodes: [{ nodeId: `${campaignId}:0:empirical`, kind: 'empirical', roundIndex: 0, dependencies: [], priority: 10, maxAttempts: 1 }],
  });
  let dispatched = 0;
  const result = await runPaperCampaign({
    campaignId,
    campaignStore,
    concurrency: 1,
    pollMs: 1,
    executor: { async execute({ executionResources }) {
      await executionResources.runEmpiricalCell(async () => { dispatched += 1; });
      await executionResources.runEmpiricalCell(async () => { dispatched += 1; });
      return { status: 'must-not-complete' };
    } },
  });
  assert.equal(dispatched, 1, JSON.stringify({ stopReason: result.campaign.stopReason, nodes: result.nodes }));
  assert.equal(result.campaign.status, 'stopped');
  assert.equal(result.campaign.stopReason, 'campaign_cpu_job_budget_exhausted');
  assert.equal(result.campaign.cpuJobCount, 1);
});

test('nested repair lease loss aborts dataset, LaTeX, empirical, and artifact repair before result integration', async (t) => {
  for (const repairKind of ['dataset', 'latex', 'empirical', 'artifact']) {
    const { root, campaignStore } = fixture(t);
    const campaignId = `nested-${repairKind}-lease-loss-campaign`;
    campaignStore.createCampaign({
      version: 2,
      kind: 'PaperCampaignPlan',
      campaignId,
      paperId: `nested-${repairKind}-lease-loss-paper`,
      sourceWorkspace: root,
      maxRounds: 1,
      budgets: { maxWallTimeMs: 60000, maxAgentCalls: 2, maxCpuJobs: 1, maxGpuJobs: 1, maxTokenCount: 1000, maxCostUsd: 1, maxMemoryMiB: 4096 },
      nodes: [{ nodeId: `${campaignId}:0:empirical`, kind: 'empirical', roundIndex: 0, dependencies: [], priority: 10, maxAttempts: 1 }],
    });

    const nestedLost = new AbortController();
    let lostListenerRemovals = 0;
    const trackedLostSignal = {
      get aborted() { return nestedLost.signal.aborted; },
      get reason() { return nestedLost.signal.reason; },
      addEventListener: (...args) => nestedLost.signal.addEventListener(...args),
      removeEventListener: (...args) => {
        lostListenerRemovals += 1;
        return nestedLost.signal.removeEventListener(...args);
      },
    };
    let outerReleaseCalls = 0;
    let nestedReleaseCalls = 0;
    const outerRelease = () => { outerReleaseCalls += 1; return true; };
    outerRelease.telemetry = Object.freeze({ requestedAt: new Date().toISOString(), acquiredAt: new Date().toISOString(), lockWaitMs: 0, queueContentionCount: 0 });
    const nestedRelease = () => { nestedReleaseCalls += 1; return false; };
    nestedRelease.lostSignal = trackedLostSignal;
    let acquireCalls = 0;
    const governor = {
      snapshot: () => ({ limits: {}, used: {}, peak: {}, waiting: 0 }),
      async acquire(request) {
        acquireCalls += 1;
        return request.agent === 1 ? nestedRelease : outerRelease;
      },
    };
    let operationAbortCount = 0;
    let observedAbortReason = null;
    let continuedAfterRepair = false;
    let integrationCalls = 0;
    const result = await runPaperCampaign({
      campaignId,
      campaignStore,
      concurrency: 1,
      pollMs: 1,
      resourceGovernor: governor,
      executor: {
        async execute({ executionResources }) {
          await executionResources.runNestedAgent(({ signal }) => new Promise((resolve, reject) => {
            assert.equal(signal instanceof AbortSignal, true);
            const timer = setTimeout(() => resolve({ status: 'must-not-complete', usage: { total: 99 } }), 5000);
            signal.addEventListener('abort', () => {
              operationAbortCount += 1;
              observedAbortReason = signal.reason;
              clearTimeout(timer);
              const error = new Error('nested_operation_cancelled');
              error.retryable = false;
              reject(error);
            }, { once: true });
            setTimeout(() => nestedLost.abort(`nested_${repairKind}_resource_lease_lost`), 5);
          }));
          continuedAfterRepair = true;
          return {
            status: 'must-not-be-accepted',
            workspaceAttemptIntegration: { workspaceAttemptIntegrationDescriptorHash: `sha256:${'a'.repeat(64)}` },
          };
        },
        async integratePrepared() {
          integrationCalls += 1;
          return { status: 'workspace_attempt_integrated' };
        },
      },
    });

    assert.equal(result.campaign.status, 'failed', repairKind);
    assert.equal(result.nodes[0].status, 'failed_terminal', repairKind);
    assert.equal(result.nodes[0].failureClass, `nested_${repairKind}_resource_lease_lost`, repairKind);
    assert.equal(result.nodes[0].preparedResultHash, null, repairKind);
    assert.equal(result.campaign.agentCallCount, 1, repairKind);
    assert.equal(result.campaign.tokenCount, 0, repairKind);
    assert.equal(operationAbortCount, 1, repairKind);
    assert.equal(observedAbortReason, `nested_${repairKind}_resource_lease_lost`, repairKind);
    assert.equal(continuedAfterRepair, false, repairKind);
    assert.equal(integrationCalls, 0, repairKind);
    assert.equal(acquireCalls, 2, repairKind);
    assert.equal(nestedReleaseCalls, 1, repairKind);
    assert.equal(outerReleaseCalls, 1, repairKind);
    assert.equal(lostListenerRemovals, 1, repairKind);
  }
});
