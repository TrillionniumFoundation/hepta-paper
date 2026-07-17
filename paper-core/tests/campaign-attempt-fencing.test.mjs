import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createDefaultPaperStore } from '../../paper-adapters/persistence/store-provider.mjs';
import { createSqliteCampaignStore } from '../../paper-adapters/persistence/sqlite-campaign-store.mjs';
import { runPaperCampaign as executePaperCampaign } from '../../paper-application/automation/campaign-engine.mjs';
import { createCampaignEmpiricalCellRunner } from '../../paper-application/automation/campaign-empirical-cell-budget.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { createSystemScheduler } from '../../paper-adapters/runtime/system-scheduler.mjs';
import { createRandomIdGenerator } from '../../paper-adapters/runtime/random-id-generator.mjs';

const campaignClocks = new WeakMap();
const scheduler = createSystemScheduler();
const idGenerator = createRandomIdGenerator();

function runPaperCampaign(input) {
  return executePaperCampaign({ ...input, clock: campaignClocks.get(input.campaignStore), scheduler, idGenerator });
}

function fixture(t, name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `hepta-${name}-`));
  let milliseconds = Date.parse('2026-07-13T00:00:00.000Z');
  const clock = {
    now: () => new Date(milliseconds),
    nowIso: () => new Date(milliseconds += 1).toISOString(),
    advance: (delta) => { milliseconds += delta; },
  };
  const store = createDefaultPaperStore({ root, runtimeRoot: root });
  t.after(() => { store.close?.(); fs.rmSync(root, { recursive: true, force: true }); });
  const campaigns = createSqliteCampaignStore({ store, clock });
  campaignClocks.set(campaigns, clock);
  return { root, clock, store, campaigns };
}

function plan(campaignId, nodes = [{ nodeId: `${campaignId}:writer`, kind: 'writer', dependencies: [] }]) {
  return {
    version: 2,
    kind: 'PaperCampaignPlan',
    campaignId,
    paperId: `${campaignId}:paper`,
    sourceWorkspace: '/tmp',
    maxRounds: 1,
    nodes: nodes.map((node, index) => ({ roundIndex: 0, priority: 10 + index, maxAttempts: 3, ...node })),
  };
}

function claimAndStart(campaigns, campaignId, workerId, leaseSeconds = 60) {
  const [claimed] = campaigns.claimReady({ campaignId, workerId, leaseSeconds });
  assert.ok(claimed?.attemptId);
  return campaigns.startNode({
    nodeId: claimed.nodeId,
    workerId,
    attemptId: claimed.attemptId,
    leaseGeneration: claimed.leaseGeneration,
  });
}

function integrationResult(integrationKey) {
  return { status: 'prepared', workspaceAttemptIntegration: { workspaceAttemptIntegrationDescriptorHash: integrationKey } };
}

function integrationReceipt(integrationKey) {
  const payload = {
    version: 1,
    kind: 'WorkspaceAttemptIntegrationReceipt',
    descriptorHash: integrationKey,
    changedPaths: [],
    alreadyIntegratedPaths: [],
    status: 'workspace_attempt_integrated',
    externalActionPerformed: false,
  };
  return { ...payload, workspaceAttemptIntegrationReceiptHash: hashRecord('WorkspaceAttemptIntegrationReceipt', payload) };
}

test('campaign creation rolls back campaign, DAG and event together on injected node failure', (t) => {
  const { store, campaigns } = fixture(t, 'campaign-create-crash');
  assert.equal(store.execute(`CREATE TRIGGER inject_campaign_node_failure BEFORE INSERT ON campaign_nodes WHEN NEW.kind='explode' BEGIN SELECT RAISE(ABORT,'injected_campaign_node_failure'); END;`).ok, true);

  assert.throws(() => campaigns.createCampaign(plan('atomic-create', [
    { nodeId: 'atomic-create:writer', kind: 'writer', dependencies: [] },
    { nodeId: 'atomic-create:explode', kind: 'explode', dependencies: ['atomic-create:writer'] },
  ])), /injected_campaign_node_failure|campaign_create_failed/);

  assert.equal(store.query("SELECT count(*) AS count FROM paper_campaigns WHERE campaign_id='atomic-create';").rows[0].count, 0);
  assert.equal(store.query("SELECT count(*) AS count FROM campaign_nodes WHERE campaign_id='atomic-create';").rows[0].count, 0);
  assert.equal(store.query("SELECT count(*) AS count FROM campaign_events WHERE campaign_id='atomic-create';").rows[0].count, 0);
});

test('campaign creation idempotency binds the complete campaign and DAG definition', (t) => {
  const { store, campaigns } = fixture(t, 'campaign-definition-idempotency');
  const definition = plan('definition-idempotency', [
    { nodeId: 'definition-idempotency:writer', kind: 'writer', dependencies: [], role: 'writer', language: 'latex' },
    { nodeId: 'definition-idempotency:compile', kind: 'compile', dependencies: ['definition-idempotency:writer'], role: 'compiler', language: 'latex' },
  ]);
  const created = campaigns.createCampaign(definition);
  const createdEvent = campaigns.listEvents(definition.campaignId).find((event) => event.kind === 'campaign_created');
  assert.match(createdEvent.event.detail.campaignDefinitionHash, /^sha256:/);
  const replay = campaigns.createCampaign({ ...definition, nodes: [...definition.nodes].reverse() });
  assert.equal(replay.createdAt, created.createdAt);
  assert.equal(campaigns.listNodes(definition.campaignId).length, 2);
  assert.equal(campaigns.listEvents(definition.campaignId).filter((event) => event.kind === 'campaign_created').length, 1);

  const mutations = [
    (value) => ({ ...value, paperId: 'different-paper' }),
    (value) => ({ ...value, sourceWorkspace: '/different-source' }),
    (value) => ({ ...value, maxRounds: 2 }),
    (value) => ({ ...value, parentCampaignId: 'different-parent' }),
    (value) => ({ ...value, campaignPlanHash: `sha256:${'f'.repeat(64)}` }),
    (value) => ({ ...value, nodes: value.nodes.map((node, index) => index ? node : { ...node, kind: 'different-kind' }) }),
    (value) => ({ ...value, nodes: value.nodes.map((node, index) => index ? { ...node, dependencies: [] } : node) }),
    (value) => ({ ...value, nodes: value.nodes.map((node, index) => index ? node : { ...node, priority: node.priority + 1 }) }),
    (value) => ({ ...value, nodes: value.nodes.map((node, index) => index ? node : { ...node, roundIndex: 1 }) }),
    (value) => ({ ...value, nodes: value.nodes.map((node, index) => index ? node : { ...node, maxAttempts: 9 }) }),
    (value) => ({ ...value, nodes: value.nodes.map((node, index) => index ? node : { ...node, role: 'different-role' }) }),
    (value) => ({ ...value, nodes: value.nodes.map((node, index) => index ? node : { ...node, language: 'python' }) }),
  ];
  const beforeCampaign = store.query("SELECT paper_id,max_rounds,spec_json FROM paper_campaigns WHERE campaign_id='definition-idempotency';").rows[0];
  const beforeNodes = store.query("SELECT node_id,kind,round_index,priority,dependencies_json,spec_json,max_attempts,role FROM campaign_nodes WHERE campaign_id='definition-idempotency' ORDER BY node_id;").rows;
  for (const mutate of mutations) {
    assert.throws(() => campaigns.createCampaign(mutate(definition)), /campaign_definition_conflict/);
    assert.deepEqual(store.query("SELECT paper_id,max_rounds,spec_json FROM paper_campaigns WHERE campaign_id='definition-idempotency';").rows[0], beforeCampaign);
    assert.deepEqual(store.query("SELECT node_id,kind,round_index,priority,dependencies_json,spec_json,max_attempts,role FROM campaign_nodes WHERE campaign_id='definition-idempotency' ORDER BY node_id;").rows, beforeNodes);
  }
  assert.equal(campaigns.listEvents(definition.campaignId).filter((event) => event.kind === 'campaign_created').length, 1);
});

test('campaign store exposes one canonical camelCase projection', (t) => {
  const { campaigns } = fixture(t, 'campaign-canonical-projection');
  campaigns.createCampaign(plan('canonical-projection'));
  campaigns.recordTelemetry({
    campaignId: 'canonical-projection',
    nodeId: 'canonical-projection:writer',
    phases: { command: 1 },
  });

  const publicRecords = [
    campaigns.getCampaign('canonical-projection'),
    campaigns.listCampaigns()[0],
    campaigns.listNodes('canonical-projection')[0],
    campaigns.listEvents('canonical-projection')[0],
    campaigns.listTelemetry('canonical-projection')[0],
  ];
  for (const record of publicRecords) {
    assert.ok(record);
    assert.deepEqual(Object.keys(record).filter((key) => key.includes('_')), []);
  }
});

test('atomic node start reservation prevents two dispatchers from overspending the last agent slot', (t) => {
  const { campaigns } = fixture(t, 'campaign-atomic-budget-reservation');
  const definition = plan('atomic-budget-reservation', [
    { nodeId: 'atomic-budget-reservation:first', kind: 'writer', dependencies: [] },
    { nodeId: 'atomic-budget-reservation:second', kind: 'writer', dependencies: [] },
  ]);
  definition.budgets = {
    maxWallTimeMs: 60_000,
    maxAgentCalls: 1,
    maxCpuJobs: 10,
    maxGpuJobs: 10,
    maxTokenCount: 10_000,
    maxCostUsd: 100,
    maxMemoryMiB: 1024,
  };
  campaigns.createCampaign(definition);
  const [first, second] = campaigns.claimReady({
    campaignId: definition.campaignId,
    workerId: 'dispatcher-a',
    leaseSeconds: 60,
    limit: 2,
  });
  assert.ok(first && second);
  campaigns.startNode({
    nodeId: first.nodeId,
    workerId: 'dispatcher-a',
    attemptId: first.attemptId,
    leaseGeneration: first.leaseGeneration,
    usageDelta: { agentCalls: 1 },
  });
  assert.throws(() => campaigns.startNode({
    nodeId: second.nodeId,
    workerId: 'dispatcher-a',
    attemptId: second.attemptId,
    leaseGeneration: second.leaseGeneration,
    usageDelta: { agentCalls: 1 },
  }), /campaign_node_budget_reservation_failed/);
  assert.equal(campaigns.getCampaign(definition.campaignId).agentCallCount, 1);
  assert.equal(campaigns.listNodes(definition.campaignId)
    .find((node) => node.nodeId === second.nodeId).status, 'leased');
});

test('atomic empirical-cell reservation prevents concurrent CPU budget overspend', async (t) => {
  const { campaigns } = fixture(t, 'campaign-atomic-empirical-budget');
  const definition = plan('atomic-empirical-budget');
  definition.budgets = {
    maxWallTimeMs: 60_000,
    maxAgentCalls: 10,
    maxCpuJobs: 1,
    maxGpuJobs: 1,
    maxTokenCount: 10_000,
    maxCostUsd: 100,
    maxMemoryMiB: 1024,
  };
  campaigns.createCampaign(definition);
  const controller = new AbortController();
  const runCell = createCampaignEmpiricalCellRunner({
    campaignId: definition.campaignId,
    campaignStore: campaigns,
    controller,
  });
  let releaseFirst;
  const firstBlocked = new Promise((resolve) => { releaseFirst = resolve; });
  const first = runCell(async () => firstBlocked);
  const second = runCell(async () => 'should-not-run');
  releaseFirst('first-completed');
  const results = await Promise.allSettled([first, second]);
  assert.equal(results[0].status, 'fulfilled');
  assert.equal(results[1].status, 'rejected');
  assert.match(results[1].reason.message, /campaign_cpu_job_budget_exhausted/);
  assert.equal(campaigns.getCampaign(definition.campaignId).cpuJobCount, 1);
});

test('lost lease fences stale prepare, completion, failure and heartbeat calls', (t) => {
  const { clock, campaigns } = fixture(t, 'campaign-lost-lease');
  campaigns.createCampaign(plan('lost-lease'));
  const stale = claimAndStart(campaigns, 'lost-lease', 'worker-a', 1);
  clock.advance(2000);
  assert.equal(campaigns.recoverExpiredLeases('lost-lease').length, 1);
  const current = claimAndStart(campaigns, 'lost-lease', 'worker-b', 60);
  assert.notEqual(current.attemptId, stale.attemptId);
  assert.ok(current.leaseGeneration > stale.leaseGeneration);

  const staleFence = { nodeId: stale.nodeId, workerId: 'worker-a', attemptId: stale.attemptId, leaseGeneration: stale.leaseGeneration };
  assert.throws(() => campaigns.renewNodeLease({ ...staleFence, leaseSeconds: 60 }), /campaign_node_lease_lost/);
  assert.throws(() => campaigns.prepareNodeResult({ ...staleFence, result: { status: 'stale' } }), /campaign_node_lease_lost/);
  assert.throws(() => campaigns.completeNode({ ...staleFence, result: { status: 'stale' } }), /campaign_node_lease_lost/);
  assert.throws(() => campaigns.failNode({ ...staleFence, failureClass: 'stale_failure' }), /campaign_node_lease_lost/);

  const prepared = campaigns.prepareNodeResult({
    nodeId: current.nodeId,
    workerId: 'worker-b',
    attemptId: current.attemptId,
    leaseGeneration: current.leaseGeneration,
    result: { status: 'current' },
  });
  const completed = campaigns.completeNode({
    nodeId: current.nodeId,
    workerId: 'worker-b',
    attemptId: current.attemptId,
    leaseGeneration: current.leaseGeneration,
    preparedResultHash: prepared.preparedResultHash,
  });
  assert.equal(completed.status, 'completed');
  assert.deepEqual(completed.result, { status: 'current' });
});

test('an unexpired dispatcher lease is reclaimed immediately when its process identity is dead', (t) => {
  const { campaigns } = fixture(t, 'campaign-dead-dispatcher');
  campaigns.createCampaign(plan('dead-dispatcher'));
  const deadPid = 2_147_483_647;
  const workerId = `paper-campaign-worker:dispatcher:dead-fixture:process:${deadPid}:1`;
  const running = claimAndStart(campaigns, 'dead-dispatcher', workerId, 1800);

  const recovered = campaigns.recoverExpiredLeases('dead-dispatcher');
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].nodeId, running.nodeId);
  assert.equal(recovered[0].status, 'queued');
  assert.equal(recovered[0].failureClass, 'lease_expired_recovered');
  const event = campaigns.listEvents('dead-dispatcher').find((item) => item.kind === 'campaign_node_lease_recovered');
  assert.equal(event.event.detail.previousLeaseOwner, workerId);
});

test('a heartbeat racing lease recovery wins the expiry CAS', (t) => {
  const { store, clock, campaigns } = fixture(t, 'campaign-recovery-race');
  campaigns.createCampaign(plan('recovery-race'));
  const running = claimAndStart(campaigns, 'recovery-race', 'worker-a', 1);
  clock.advance(2000);

  let injected = false;
  const racingStore = {
    query: (sql) => store.query(sql),
    execute(sql) {
      if (!injected && String(sql).includes("failure_class='lease_expired_recovered'")) {
        injected = true;
        const future = new Date(clock.now().getTime() + 60_000).toISOString();
        const heartbeat = store.execute(`UPDATE campaign_nodes SET lease_expires_at='${future}' WHERE node_id='${running.nodeId}' AND attempt_id='${running.attemptId}';`);
        assert.equal(heartbeat.ok, true);
      }
      return store.execute(sql);
    },
  };
  const racingCampaigns = createSqliteCampaignStore({ store: racingStore, clock });
  assert.deepEqual(racingCampaigns.recoverExpiredLeases('recovery-race'), []);
  const latest = racingCampaigns.listNodes('recovery-race')[0];
  assert.equal(latest.status, 'running');
  assert.equal(latest.attemptId, running.attemptId);
});

test('prepared results survive recovery and are integrated without a second external attempt', (t) => {
  const { clock, campaigns } = fixture(t, 'campaign-prepared-recovery');
  campaigns.createCampaign(plan('prepared-recovery'));
  const first = claimAndStart(campaigns, 'prepared-recovery', 'worker-a', 1);
  const prepared = campaigns.prepareNodeResult({
    nodeId: first.nodeId,
    workerId: 'worker-a',
    attemptId: first.attemptId,
    leaseGeneration: first.leaseGeneration,
    result: { status: 'prepared', usage: { totalTokens: 7 } },
  });
  clock.advance(2000);
  campaigns.recoverExpiredLeases('prepared-recovery');
  const recovered = claimAndStart(campaigns, 'prepared-recovery', 'worker-b', 60);
  assert.equal(recovered.preparedResultHash, prepared.preparedResultHash);
  assert.equal(recovered.preparedAttemptId, first.attemptId);

  const completed = campaigns.completeNode({
    nodeId: recovered.nodeId,
    workerId: 'worker-b',
    attemptId: recovered.attemptId,
    leaseGeneration: recovered.leaseGeneration,
    preparedResultHash: recovered.preparedResultHash,
    usageDelta: { tokens: 7 },
  });
  assert.equal(completed.status, 'completed');
  assert.deepEqual(completed.result, { status: 'prepared', usage: { totalTokens: 7 } });
  assert.equal(campaigns.getCampaign('prepared-recovery').tokenCount, 7);
});

test('campaign engine integrates a recovered prepared result without invoking the executor again', async (t) => {
  const { clock, campaigns } = fixture(t, 'campaign-engine-prepared-recovery');
  campaigns.createCampaign(plan('engine-prepared-recovery'));
  const first = claimAndStart(campaigns, 'engine-prepared-recovery', 'worker-a', 1);
  campaigns.prepareNodeResult({
    nodeId: first.nodeId,
    workerId: 'worker-a',
    attemptId: first.attemptId,
    leaseGeneration: first.leaseGeneration,
    result: { status: 'prepared-before-crash' },
  });
  clock.advance(2000);
  let executionCount = 0;
  const run = await runPaperCampaign({
    campaignId: 'engine-prepared-recovery',
    campaignStore: campaigns,
    concurrency: 1,
    pollMs: 1,
    executor: { execute: async () => { executionCount += 1; return { status: 'duplicate' }; } },
  });
  assert.equal(executionCount, 0);
  assert.equal(run.campaign.status, 'completed');
  assert.deepEqual(run.nodes[0].result, { status: 'prepared-before-crash' });
});

test('node result, usage, completion event and campaign projection roll back as one unit', (t) => {
  const { store, campaigns } = fixture(t, 'campaign-integrate-crash');
  campaigns.createCampaign(plan('integrate-crash'));
  const running = claimAndStart(campaigns, 'integrate-crash', 'worker-a');
  const prepared = campaigns.prepareNodeResult({
    nodeId: running.nodeId,
    workerId: 'worker-a',
    attemptId: running.attemptId,
    leaseGeneration: running.leaseGeneration,
    result: { status: 'prepared' },
  });
  assert.equal(store.execute(`CREATE TRIGGER inject_completion_event_failure BEFORE INSERT ON campaign_events WHEN NEW.kind='campaign_node_completed' BEGIN SELECT RAISE(ABORT,'injected_completion_event_failure'); END;`).ok, true);

  assert.throws(() => campaigns.completeNode({
    nodeId: running.nodeId,
    workerId: 'worker-a',
    attemptId: running.attemptId,
    leaseGeneration: running.leaseGeneration,
    preparedResultHash: prepared.preparedResultHash,
    usageDelta: { tokens: 11 },
  }), /campaign_node_lease_lost/);

  assert.equal(campaigns.listNodes('integrate-crash')[0].status, 'running');
  assert.equal(campaigns.getCampaign('integrate-crash').status, 'running');
  assert.equal(campaigns.getCampaign('integrate-crash').tokenCount, 0);
  assert.equal(campaigns.listEvents('integrate-crash').filter((item) => item.kind === 'campaign_node_completed').length, 0);
});

test('campaign cancellation invalidates a running attempt before any late result can persist', (t) => {
  const { campaigns } = fixture(t, 'campaign-cancel-fence');
  campaigns.createCampaign(plan('cancel-fence'));
  const running = claimAndStart(campaigns, 'cancel-fence', 'worker-a');
  campaigns.cancelCampaign('cancel-fence');
  const fence = { nodeId: running.nodeId, workerId: 'worker-a', attemptId: running.attemptId, leaseGeneration: running.leaseGeneration };
  assert.throws(() => campaigns.prepareNodeResult({ ...fence, result: { status: 'late' } }), /campaign_node_lease_lost/);
  assert.throws(() => campaigns.failNode({ ...fence, failureClass: 'late_failure' }), /campaign_node_lease_lost/);
  assert.equal(campaigns.getCampaign('cancel-fence').status, 'cancelled');
  assert.equal(campaigns.listNodes('cancel-fence')[0].status, 'skipped');
});

test('integration intent is the point of no return and fences campaign control until completion', (t) => {
  const { campaigns } = fixture(t, 'campaign-integration-intent');
  campaigns.createCampaign(plan('integration-intent'));
  const running = claimAndStart(campaigns, 'integration-intent', 'worker-a');
  const integrationKey = 'sha256:integration-intent';
  campaigns.prepareNodeResult({
    nodeId: running.nodeId,
    workerId: 'worker-a',
    attemptId: running.attemptId,
    leaseGeneration: running.leaseGeneration,
    result: integrationResult(integrationKey),
    requiresIntegration: true,
    integrationKey,
  });
  const integrating = campaigns.beginNodeResultIntegration({
    nodeId: running.nodeId,
    workerId: 'worker-a',
    attemptId: running.attemptId,
    leaseGeneration: running.leaseGeneration,
    integrationKey,
  });
  assert.equal(integrating.preparedIntegrationStatus, 'integrating');
  assert.throws(() => campaigns.cancelCampaign('integration-intent'), /campaign_cancel_failed/);
  assert.throws(() => campaigns.pauseCampaign('integration-intent'), /campaign_pause_failed/);
  assert.throws(() => campaigns.stopCampaign('integration-intent'), /campaign_stop_failed/);
  assert.throws(() => campaigns.cancelNode(running.nodeId), /campaign_node_cancel_failed/);

  const receipt = integrationReceipt(integrationKey);
  const integrated = campaigns.markNodeResultIntegrated({
    nodeId: running.nodeId,
    workerId: 'worker-a',
    attemptId: running.attemptId,
    leaseGeneration: running.leaseGeneration,
    integrationKey,
    integrationReceipt: receipt,
  });
  assert.equal(integrated.preparedIntegrationStatus, 'integrated');
  assert.equal(integrated.preparedIntegrationReceiptHash, receipt.workspaceAttemptIntegrationReceiptHash);
  assert.throws(() => campaigns.cancelCampaign('integration-intent'), /campaign_cancel_failed/);
  const completed = campaigns.completeNode({
    nodeId: running.nodeId,
    workerId: 'worker-a',
    attemptId: running.attemptId,
    leaseGeneration: running.leaseGeneration,
    preparedResultHash: integrated.preparedResultHash,
  });
  assert.equal(completed.status, 'completed');
});

test('idempotent integration replay requires the original live attempt and running campaign', (t) => {
  const { store, clock, campaigns } = fixture(t, 'campaign-integration-replay-fence');
  campaigns.createCampaign(plan('integration-replay-fence'));
  const running = claimAndStart(campaigns, 'integration-replay-fence', 'worker-a', 60);
  const integrationKey = 'sha256:integration-replay-fence';
  campaigns.prepareNodeResult({
    nodeId: running.nodeId,
    workerId: 'worker-a',
    attemptId: running.attemptId,
    leaseGeneration: running.leaseGeneration,
    result: integrationResult(integrationKey),
    requiresIntegration: true,
    integrationKey,
  });
  const fence = {
    nodeId: running.nodeId,
    workerId: 'worker-a',
    attemptId: running.attemptId,
    leaseGeneration: running.leaseGeneration,
    integrationKey,
    integrationLeaseSeconds: 30,
  };
  assert.equal(campaigns.beginNodeResultIntegration(fence).preparedIntegrationStatus, 'integrating');
  assert.equal(campaigns.beginNodeResultIntegration(fence).preparedIntegrationStatus, 'integrating');

  clock.advance(60_001);
  assert.throws(() => campaigns.beginNodeResultIntegration(fence), /campaign_node_lease_lost/);

  for (const status of ['paused', 'cancelled']) {
    const campaignId = `integration-replay-${status}`;
    campaigns.createCampaign(plan(campaignId));
    const active = claimAndStart(campaigns, campaignId, `worker-${status}`);
    const key = `sha256:${status}-integration-replay`;
    campaigns.prepareNodeResult({
      nodeId: active.nodeId,
      workerId: `worker-${status}`,
      attemptId: active.attemptId,
      leaseGeneration: active.leaseGeneration,
      result: integrationResult(key),
      requiresIntegration: true,
      integrationKey: key,
    });
    const replay = {
      nodeId: active.nodeId,
      workerId: `worker-${status}`,
      attemptId: active.attemptId,
      leaseGeneration: active.leaseGeneration,
      integrationKey: key,
    };
    campaigns.beginNodeResultIntegration(replay);
    assert.equal(store.execute(`UPDATE paper_campaigns SET status='${status}' WHERE campaign_id='${campaignId}';`).ok, true);
    assert.throws(() => campaigns.beginNodeResultIntegration(replay), /campaign_node_lease_lost/);
  }
});

test('an integrated-result replay is rejected after its attempt lease expires', (t) => {
  const { clock, campaigns } = fixture(t, 'campaign-integrated-replay-expiry');
  campaigns.createCampaign(plan('integrated-replay-expiry'));
  const running = claimAndStart(campaigns, 'integrated-replay-expiry', 'worker-a');
  const integrationKey = 'sha256:integrated-replay-expiry';
  campaigns.prepareNodeResult({
    nodeId: running.nodeId,
    workerId: 'worker-a',
    attemptId: running.attemptId,
    leaseGeneration: running.leaseGeneration,
    result: integrationResult(integrationKey),
    requiresIntegration: true,
    integrationKey,
  });
  const fence = {
    nodeId: running.nodeId,
    workerId: 'worker-a',
    attemptId: running.attemptId,
    leaseGeneration: running.leaseGeneration,
    integrationKey,
  };
  campaigns.beginNodeResultIntegration({ ...fence, integrationLeaseSeconds: 30 });
  const receipt = integrationReceipt(integrationKey);
  assert.equal(campaigns.markNodeResultIntegrated({ ...fence, integrationReceipt: receipt }).preparedIntegrationStatus, 'integrated');
  assert.equal(campaigns.markNodeResultIntegrated({ ...fence, integrationReceipt: receipt }).preparedIntegrationStatus, 'integrated');
  clock.advance(60_001);
  assert.throws(() => campaigns.markNodeResultIntegrated({ ...fence, integrationReceipt: receipt }), /campaign_node_lease_lost/);
});

test('recovery between an integrating read and idempotent return loses the atomic fence', (t) => {
  const { store, campaigns } = fixture(t, 'campaign-integration-recovery-race');
  campaigns.createCampaign(plan('integration-recovery-race'));
  const running = claimAndStart(campaigns, 'integration-recovery-race', 'worker-a');
  const integrationKey = 'sha256:integration-recovery-race';
  campaigns.prepareNodeResult({
    nodeId: running.nodeId,
    workerId: 'worker-a',
    attemptId: running.attemptId,
    leaseGeneration: running.leaseGeneration,
    result: integrationResult(integrationKey),
    requiresIntegration: true,
    integrationKey,
  });
  campaigns.beginNodeResultIntegration({
    nodeId: running.nodeId,
    workerId: 'worker-a',
    attemptId: running.attemptId,
    leaseGeneration: running.leaseGeneration,
    integrationKey,
  });

  let injected = false;
  const racingStore = {
    execute: (sql) => store.execute(sql),
    query(sql) {
      const result = store.query(sql);
      if (!injected && String(sql).includes(`WHERE node_id='${running.nodeId}' LIMIT 1`)) {
        injected = true;
        const recovered = store.execute(`UPDATE campaign_nodes SET status='queued',lease_owner=NULL,lease_expires_at=NULL,attempt_id=NULL,lease_generation=lease_generation+1,node_revision=node_revision+1,prepared_integration_status='pending',prepared_integration_started_at=NULL WHERE node_id='${running.nodeId}';`);
        assert.equal(recovered.ok, true);
      }
      return result;
    },
  };
  const racingCampaigns = createSqliteCampaignStore({ store: racingStore, clock: { now: () => new Date('2026-07-13T00:00:01.000Z'), nowIso: () => '2026-07-13T00:00:01.000Z' } });
  assert.throws(() => racingCampaigns.beginNodeResultIntegration({
    nodeId: running.nodeId,
    workerId: 'worker-a',
    attemptId: running.attemptId,
    leaseGeneration: running.leaseGeneration,
    integrationKey,
  }), /campaign_node_lease_lost/);
});

test('an integrated prepared result completes after lease recovery without another integration', (t) => {
  const { clock, campaigns } = fixture(t, 'campaign-integrated-recovery');
  campaigns.createCampaign(plan('integrated-recovery'));
  const first = claimAndStart(campaigns, 'integrated-recovery', 'worker-a', 1);
  const integrationKey = 'sha256:integrated-recovery';
  const prepared = campaigns.prepareNodeResult({
    nodeId: first.nodeId,
    workerId: 'worker-a',
    attemptId: first.attemptId,
    leaseGeneration: first.leaseGeneration,
    result: integrationResult(integrationKey),
    requiresIntegration: true,
    integrationKey,
  });
  campaigns.beginNodeResultIntegration({
    nodeId: first.nodeId,
    workerId: 'worker-a',
    attemptId: first.attemptId,
    leaseGeneration: first.leaseGeneration,
    integrationKey,
    integrationLeaseSeconds: 30,
  });
  campaigns.markNodeResultIntegrated({
    nodeId: first.nodeId,
    workerId: 'worker-a',
    attemptId: first.attemptId,
    leaseGeneration: first.leaseGeneration,
    integrationKey,
    integrationReceipt: integrationReceipt(integrationKey),
  });
  clock.advance(31_000);
  assert.equal(campaigns.recoverExpiredLeases('integrated-recovery').length, 1);
  const recovered = claimAndStart(campaigns, 'integrated-recovery', 'worker-b');
  assert.equal(recovered.preparedIntegrationStatus, 'integrated');
  const completed = campaigns.completeNode({
    nodeId: recovered.nodeId,
    workerId: 'worker-b',
    attemptId: recovered.attemptId,
    leaseGeneration: recovered.leaseGeneration,
    preparedResultHash: prepared.preparedResultHash,
  });
  assert.equal(completed.status, 'completed');
});

test('prepared result and integration receipt corruption fail closed on read', (t) => {
  const { store, campaigns } = fixture(t, 'campaign-prepared-corruption');
  campaigns.createCampaign(plan('prepared-corruption'));
  const running = claimAndStart(campaigns, 'prepared-corruption', 'worker-a');
  const integrationKey = 'sha256:prepared-corruption';
  campaigns.prepareNodeResult({
    nodeId: running.nodeId,
    workerId: 'worker-a',
    attemptId: running.attemptId,
    leaseGeneration: running.leaseGeneration,
    result: integrationResult(integrationKey),
    requiresIntegration: true,
    integrationKey,
  });
  assert.equal(store.execute(`UPDATE campaign_nodes SET prepared_result_json='{}' WHERE node_id='${running.nodeId}';`).ok, true);
  assert.throws(() => campaigns.listNodes('prepared-corruption'), /campaign_prepared_result_hash_invalid/);
});

test('integration conflicts abandon a poisoned prepared result and re-execute the node', async (t) => {
  const { campaigns } = fixture(t, 'campaign-integration-conflict');
  campaigns.createCampaign(plan('integration-conflict'));
  let executions = 0;
  let integrations = 0;
  const executor = {
    async execute({ node }) {
      executions += 1;
      return integrationResult(`sha256:${node.attemptId}`);
    },
    integratePrepared({ result }) {
      integrations += 1;
      if (integrations === 1) {
        const error = new Error('workspace_attempt_integration_conflict:main.tex');
        error.code = 'workspace_attempt_integration_conflict';
        error.retryable = true;
        error.abandonPreparedResult = true;
        throw error;
      }
      return integrationReceipt(result.workspaceAttemptIntegration.workspaceAttemptIntegrationDescriptorHash);
    },
  };
  const run = await runPaperCampaign({ campaignId: 'integration-conflict', campaignStore: campaigns, executor, concurrency: 1, pollMs: 1 });
  assert.equal(run.campaign.status, 'completed');
  assert.equal(executions, 2);
  assert.equal(integrations, 2);
});
