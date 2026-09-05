import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getEventListeners } from 'node:events';
import test from 'node:test';
import { createDefaultPaperStore } from '../../paper-adapters/persistence/store-provider.mjs';
import { createSqliteCampaignStore } from '../../paper-adapters/persistence/sqlite-campaign-store.mjs';
import { createSystemScheduler } from '../../paper-adapters/runtime/system-scheduler.mjs';
import { runPaperCampaign } from '../../paper-application/automation/campaign-engine.mjs';
import { createResourceGovernor } from '../../paper-application/automation/resource-governor.mjs';
import { captureCampaignResourceEnvelopePolicy, createCampaignNestedExecutionScope } from '../../paper-application/automation/campaign-resource-envelope.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const tick = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const code = (value) => ({ code: value });
const v = (agent = 0, cpu = 0, memoryMiB = 0) => ({ agent, cpu, gpu: 0, memoryMiB });
const policy = (mapping = { compile: 1 }, extra = {}) => ({ version: 1,
  kind: 'CampaignResourceEnvelopePolicyV1', nestedAgentSlotsByKind: mapping, ...extra });
function receipt() {
  const body = { version: 1, kind: 'AgentExecutionReceipt', executorId: 'local-campaign-envelope-control',
    status: 'agent_execution_completed', externalModelInvocationPerformed: false, externalActionPerformed: false };
  return { ...body, agentExecutionReceiptHash: hashRecord('AgentExecutionReceipt', body) };
}
function fixture(t, { config = policy(), kinds = ['compile'], concurrency = 1,
  globalLimits = v(1, 1, 16), globalPolicy = { maximumConflictingBypasses: 0 } } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-campaign-envelope-'));
  const store = createDefaultPaperStore({ root, runtimeRoot: root });
  t.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  let time = Date.parse('2026-09-05T00:00:00Z');
  const clock = { now: () => new Date(time), nowIso: () => new Date(time += 1).toISOString() };
  const campaigns = createSqliteCampaignStore({ store, clock });
  const captured = config === null ? null : captureCampaignResourceEnvelopePolicy(config);
  const plan = { version: 2, kind: 'PaperCampaignPlan', campaignId: 'envelope-campaign',
    paperId: 'envelope-control', sourceWorkspace: root, maxRounds: 1,
    workerMemoryBytes: 16 * 1024 * 1024,
    budgets: { maxMemoryMiB: 64, maxCpuJobs: 1000, maxGpuJobs: 0, maxAgentCalls: 1000, maxTokenCount: 10000 },
    ...(captured ? { resourceEnvelopePolicyHash: captured.policyHash } : {}),
    nodes: kinds.map((kind, index) => ({ nodeId: `node-${index}`, kind, dependencies: [],
      roundIndex: 0, priority: index + 1, maxAttempts: 1 })) };
  campaigns.createCampaign(plan);
  const governor = createResourceGovernor(globalLimits, globalPolicy);
  const input = { campaignId: plan.campaignId, campaignStore: campaigns, resourceGovernor: governor,
    resourceEnvelopePolicy: config, concurrency, clock, scheduler: createSystemScheduler(),
    idGenerator: { next: () => 'local-id' }, pollMs: 1, maximumIdlePolls: 2 };
  return { store, campaigns, governor, input, captured,
    run: (execute, overrides = {}) => runPaperCampaign({ ...input, executor: { execute }, ...overrides }) };
}

// These controls execute the real engine and SQLite store with local callbacks.
// They never stand in for real provider, OS containment, or host qualification.
for (const envelopes of [false, true]) {
  for (const parentFails of [false, true]) {
    test(`empirical child settlement precedes parent ${parentFails ? 'failure' : 'return'}; envelopes=${envelopes}`,
      { timeout: 10000 }, async (t) => {
        const f = fixture(t, { config: envelopes ? policy() : null });
        const started = deferred(); const finish = deferred(); let child; let returned = false;
        let childSignal;
        const running = f.run(async ({ executionResources }) => {
          child = executionResources.runEmpiricalCell(async ({ signal }) => {
            childSignal = signal; started.resolve(); await finish.promise; return receipt();
          });
          await started.promise;
          if (parentFails) throw Object.assign(new Error('local_empirical_parent_failed'), { retryable: false });
          return receipt();
        }).then((result) => { returned = true; return result; });
        await started.promise; await tick();
        assert.equal(returned, false); assert.equal(childSignal.aborted, true);
        const node = f.campaigns.listNodes('envelope-campaign')[0];
        assert.equal(node.status, 'running'); assert.equal(node.preparedResultHash, null);
        assert.deepEqual(f.governor.snapshot().used, v(envelopes ? 1 : 0, 1, 16));
        finish.resolve(); const result = await running; await assert.rejects(child);
        assert.equal(result.campaign.status, 'failed'); assert.equal(result.nodes[0].preparedResultHash, null);
        assert.equal(result.nodes[0].failureClass, parentFails ? 'local_empirical_parent_failed' : 'campaign_nested_work_unsettled');
        assert.deepEqual(f.governor.snapshot().used, v());
      });
  }
  test(`supervisor cancellation keeps empirical work charged until settlement; envelopes=${envelopes}`,
    { timeout: 10000 }, async (t) => {
      const f = fixture(t, { config: envelopes ? policy() : null });
      const started = deferred(); const finish = deferred(); const supervisor = new AbortController();
      let returned = false; let childSignal;
      const running = f.run(async ({ executionResources }) => {
        await executionResources.runEmpiricalCell(async ({ signal }) => {
          childSignal = signal; started.resolve(); await finish.promise; return receipt();
        }); return receipt();
      }, { signal: supervisor.signal }).then((result) => { returned = true; return result; });
      await started.promise; supervisor.abort('local_cancel'); await tick();
      assert.equal(returned, false); assert.equal(childSignal.aborted, true);
      assert.deepEqual(f.governor.snapshot().used, v(envelopes ? 1 : 0, 1, 16));
      finish.resolve(); const result = await running;
      assert.equal(result.campaign.status, 'paused'); assert.equal(result.nodes[0].preparedResultHash, null);
      assert.deepEqual(f.governor.snapshot().used, v());
    });
}

test('both child kinds share one bounded lifetime and cannot race parent preparation', { timeout: 10000 }, async (t) => {
  const f = fixture(t); const agentStarted = deferred(); const cellStarted = deferred();
  const agentFinish = deferred(); const cellFinish = deferred(); let returned = false; let agent; let cell;
  const running = f.run(async ({ executionResources }) => {
    agent = executionResources.runNestedAgent(async () => { agentStarted.resolve(); await agentFinish.promise; return receipt(); });
    cell = executionResources.runEmpiricalCell(async () => { cellStarted.resolve(); await cellFinish.promise; return receipt(); });
    await Promise.all([agentStarted.promise, cellStarted.promise]); return receipt();
  }).then((result) => { returned = true; return result; });
  await Promise.all([agentStarted.promise, cellStarted.promise]); await tick();
  agentFinish.resolve(); await assert.rejects(agent); await tick();
  assert.equal(returned, false); assert.deepEqual(f.governor.snapshot().used, v(1, 1, 16));
  assert.equal(f.campaigns.listNodes('envelope-campaign')[0].preparedResultHash, null);
  cellFinish.resolve(); await assert.rejects(cell); const result = await running;
  assert.equal(result.campaign.status, 'failed'); assert.deepEqual(f.governor.snapshot().used, v());
});

test('late retained empirical capability is sealed before budget, gate, or callback', async (t) => {
  const f = fixture(t); let retained; let calls = 0;
  const result = await f.run(async ({ executionResources }) => { retained = executionResources.runEmpiricalCell; return receipt(); });
  const before = f.campaigns.getCampaign('envelope-campaign').cpuJobCount;
  await assert.rejects(retained(async () => { calls += 1; return receipt(); }), code('campaign_nested_scope_closed'));
  assert.equal(calls, 0); assert.equal(result.campaign.status, 'completed');
  assert.equal(f.campaigns.getCampaign('envelope-campaign').cpuJobCount, before);
});

test('awaited empirical operations and handled failures preserve metering and parent recovery', async (t) => {
  const f = fixture(t);
  const result = await f.run(async ({ executionResources }) => {
    await assert.rejects(executionResources.runEmpiricalCell(async () => { throw new Error('local_cell_rejected'); }), /local_cell_rejected/);
    for (let index = 0; index < 4; index += 1) {
      assert.deepEqual(await executionResources.runEmpiricalCell(async () => receipt()), receipt());
    }
    return receipt();
  });
  assert.equal(result.campaign.status, 'completed');
  assert.equal(result.campaign.cpuJobCount, 6); // Parent plus five actual cell attempts.
  assert.deepEqual(f.governor.snapshot().used, v());
});

test('mixed child types cannot evade the common outstanding-request limit', async (t) => {
  const f = fixture(t, { config: policy({ compile: 1 }, { maximumChildren: 1 }) });
  const finish = deferred(); const started = deferred(); let rejectedCalls = 0;
  const result = await f.run(async ({ executionResources }) => {
    const cell = executionResources.runEmpiricalCell(async () => { started.resolve(); await finish.promise; return receipt(); });
    await started.promise;
    await assert.rejects(executionResources.runNestedAgent(async () => { rejectedCalls += 1; return receipt(); }), code('campaign_nested_outstanding_limit'));
    finish.resolve(); await cell; return receipt();
  });
  assert.equal(rejectedCalls, 0); assert.equal(result.campaign.agentCallCount, 0);
  assert.equal(result.campaign.status, 'completed'); assert.deepEqual(f.governor.snapshot().used, v());
});

test('empirical execution retains the existing external gate before invocation and usage', async (t) => {
  const f = fixture(t); let calls = 0;
  const result = await f.run(async ({ executionResources }) => {
    await executionResources.runEmpiricalCell(async () => { calls += 1; return receipt(); }); return receipt();
  }, { assertExternalSideEffectReady: async ({ action }) => {
    if (action.startsWith('campaign_empirical_cell_execute:')) {
      throw Object.assign(new Error('local_cell_gate_denied'), { retryable: false });
    }
  } });
  assert.equal(calls, 0); assert.equal(result.campaign.status, 'failed');
  assert.equal(result.nodes[0].failureClass, 'local_cell_gate_denied');
  assert.equal(result.campaign.cpuJobCount, 1); // Only the parent reservation.
  assert.deepEqual(f.governor.snapshot().used, v());
});

for (const resource of ['runNestedAgent', 'runEmpiricalCell']) {
  test(`cancellation during the final external gate cannot dispatch ${resource}`, async (t) => {
    const f = fixture(t); const supervisor = new AbortController(); let callbacks = 0;
    const actionPrefix = resource === 'runNestedAgent' ? 'campaign_nested_agent_execute:' : 'campaign_empirical_cell_execute:';
    const running = f.run(async ({ executionResources }) => {
      await executionResources[resource](async () => { callbacks += 1; return receipt(); }); return receipt();
    }, { signal: supervisor.signal, assertExternalSideEffectReady: async ({ action }) => {
      if (action.startsWith(actionPrefix)) supervisor.abort('local_cancel_at_gate');
    } });
    const result = await running;
    assert.equal(callbacks, 0); assert.equal(result.campaign.status, 'paused');
    assert.equal(result.nodes[0].preparedResultHash, null); assert.deepEqual(f.governor.snapshot().used, v());
  });
}

for (const point of ['create', 'unref']) {
  test(`heartbeat ${point} failure releases both resource reservations and the control subscription`, async (t) => {
    const f = fixture(t); const supervisor = new AbortController(); let index = 0; let unrefs = 0; let called = false;
    const intervals = new Set();
    const scheduler = { ...f.input.scheduler,
      setInterval(callback, delay) {
        index += 1;
        if (point === 'create' && index === 2) throw new Error('local_heartbeat_setup_failed');
        const handle = f.input.scheduler.setInterval(callback, delay); intervals.add(handle); return handle;
      },
      unref(handle) { unrefs += 1; if (point === 'unref' && unrefs === 2) throw new Error('local_heartbeat_unref_failed'); f.input.scheduler.unref(handle); },
      clearInterval(handle) { intervals.delete(handle); f.input.scheduler.clearInterval(handle); },
    };
    t.after(() => { for (const handle of intervals) f.input.scheduler.clearInterval(handle); });
    const result = await f.run(async () => { called = true; return receipt(); }, { scheduler, signal: supervisor.signal });
    assert.equal(called, false); assert.equal(result.campaign.status, 'failed');
    assert.equal(result.nodes[0].preparedResultHash, null); assert.equal(intervals.size, 0);
    assert.deepEqual(getEventListeners(supervisor.signal, 'abort'), []);
    assert.deepEqual(f.governor.snapshot().used, v());
  });
}

test('monitor teardown error does not skip other cleanup or conceal a failed shutdown', async (t) => {
  const f = fixture(t); const supervisor = new AbortController(); let clears = 0;
  const scheduler = { ...f.input.scheduler, clearInterval(handle) {
    f.input.scheduler.clearInterval(handle);
    if (++clears === 1) throw new Error('local_monitor_cleanup_failed');
  } };
  await assert.rejects(f.run(async () => receipt(), { scheduler, signal: supervisor.signal }), /local_monitor_cleanup_failed/);
  assert.equal(clears, 2); assert.deepEqual(f.governor.snapshot().used, v());
  assert.deepEqual(getEventListeners(supervisor.signal, 'abort'), []);
});

for (const target of ['parent', 'nested']) {
  test(`earlier listener cannot hide ${target} lease loss or permit a prepared parent result`, { timeout: 10000 }, async (t) => {
    const f = fixture(t, { config: null }); const lost = new AbortController();
    const suppress = (event) => event.stopImmediatePropagation(); lost.signal.addEventListener('abort', suppress);
    const started = deferred(); const finish = deferred(); let observedSignal; let acquisitions = 0;
    const resourceGovernor = { kind: 'LocalLeaseLossControl', snapshot: f.governor.snapshot,
      async acquire(request, options) {
        const release = await f.governor.acquire(request, options); acquisitions += 1;
        if (acquisitions === (target === 'parent' ? 1 : 2)) release.lostSignal = lost.signal;
        return release;
      } };
    const running = f.run(async ({ executionResources, executionSignal }) => {
      observedSignal = executionSignal;
      if (target === 'nested') await executionResources.runNestedAgent(async () => { started.resolve(); await finish.promise; return receipt(); });
      else { started.resolve(); await finish.promise; }
      return receipt();
    }, { resourceGovernor }).then((result) => result, (error) => error);
    await started.promise; lost.abort('local_lease_lost'); await tick();
    assert.equal(observedSignal.aborted, true);
    assert.deepEqual(f.governor.snapshot().used, v(target === 'nested' ? 1 : 0, 1, 16));
    assert.equal(f.campaigns.listNodes('envelope-campaign')[0].preparedResultHash, null);
    finish.resolve(); await running;
    assert.equal(f.campaigns.listNodes('envelope-campaign')[0].preparedResultHash, null);
    assert.notEqual(f.campaigns.listNodes('envelope-campaign')[0].status, 'completed');
    assert.deepEqual(getEventListeners(lost.signal, 'abort'), [suppress]);
    assert.deepEqual(f.governor.snapshot().used, v());
  });
}

test('healthy parent lease watcher is detached after every node without removing other subscribers', async (t) => {
  const f = fixture(t, { config: null }); const lost = new AbortController(); const unrelated = () => {};
  lost.signal.addEventListener('abort', unrelated);
  const resourceGovernor = { kind: 'LocalLeaseControl', snapshot: f.governor.snapshot, async acquire(request, options) {
    const release = await f.governor.acquire(request, options); release.lostSignal = lost.signal; return release;
  } };
  const result = await f.run(async () => receipt(), { resourceGovernor });
  assert.equal(result.campaign.status, 'completed'); assert.deepEqual(f.governor.snapshot().used, v());
  assert.deepEqual(getEventListeners(lost.signal, 'abort'), [unrelated]);
});

test('already-lost reservation returns an error without spinning on an abandoned leased node', { timeout: 10000 }, async (t) => {
  const f = fixture(t, { config: null }); const lost = new AbortController(); lost.abort('local_lost_before_handoff');
  let calls = 0;
  const resourceGovernor = { kind: 'LocalLeaseControl', snapshot: f.governor.snapshot, async acquire(request, options) {
    const release = await f.governor.acquire(request, options); release.lostSignal = lost.signal; return release;
  } };
  await assert.rejects(f.run(async () => { calls += 1; return receipt(); }, { resourceGovernor }), /local_lost_before_handoff/);
  assert.equal(calls, 0); assert.equal(f.campaigns.listNodes('envelope-campaign')[0].preparedResultHash, null);
  assert.deepEqual(f.governor.snapshot().used, v());
});

test('scope binding preserves independent runner interfaces but rejects work after draining', async () => {
  const controller = new AbortController(); const gate = deferred(); let calls = 0;
  const scope = createCampaignNestedExecutionScope(async (operation) => operation(), controller, { maximumOutstanding: 1 });
  const runOther = scope.bind(async (operation, options) => { assert.deepEqual(options, { lane: 'cell' }); return operation(); });
  const running = runOther(async () => { calls += 1; await gate.promise; }, { lane: 'cell' });
  await assert.rejects(scope.run(() => {}), code('campaign_nested_outstanding_limit'));
  const drained = scope.drain(); gate.resolve(); await Promise.all([running, drained]);
  await assert.rejects(runOther(() => {}), code('campaign_nested_scope_closed'));
  assert.equal(calls, 1); assert.throws(() => scope.bind(null), code('campaign_child_runner_required'));
});


for (const query of ['getCampaign', 'listNodes']) {
  test(`early ${query} fault after admission cleans resource and monitor ownership`, async (t) => {
    const f = fixture(t, { config: null }); const supervisor = new AbortController();
    let admitted = false; let injected = false; let calls = 0; const intervals = new Set();
    const scheduler = { ...f.input.scheduler,
      setInterval(callback, delay) { const handle = f.input.scheduler.setInterval(callback, delay); intervals.add(handle); return handle; },
      clearInterval(handle) { intervals.delete(handle); f.input.scheduler.clearInterval(handle); },
    };
    t.after(() => { for (const handle of intervals) f.input.scheduler.clearInterval(handle); });
    const resourceGovernor = { kind: 'LocalAdmissionFaultControl', snapshot: f.governor.snapshot,
      async acquire(request, options) { const release = await f.governor.acquire(request, options); admitted = true; return release; } };
    const campaignStore = { ...f.campaigns, [query](...args) {
      if (admitted && !injected) { injected = true; throw new Error('local_admission_query_failed'); }
      return f.campaigns[query](...args);
    } };
    await assert.rejects(f.run(async () => { calls += 1; return receipt(); },
      { resourceGovernor, campaignStore, scheduler, signal: supervisor.signal }), /local_admission_query_failed/);
    assert.equal(injected, true); assert.equal(calls, 0);
    assert.deepEqual(f.governor.snapshot().used, v()); assert.equal(intervals.size, 0);
    assert.deepEqual(getEventListeners(supervisor.signal, 'abort'), []);
    assert.equal(f.campaigns.listNodes('envelope-campaign')[0].preparedResultHash, null);
  });
}

for (const queryFails of [false, true]) {
  test(`early admission release failure still attempts monitor cleanup; queryFault=${queryFails}`, async (t) => {
    const f = fixture(t, { config: null }); const supervisor = new AbortController();
    let admitted = false; let injected = false; let releases = 0; let calls = 0; const intervals = new Set();
    const scheduler = { ...f.input.scheduler,
      setInterval(callback, delay) { const handle = f.input.scheduler.setInterval(callback, delay); intervals.add(handle); return handle; },
      clearInterval(handle) { intervals.delete(handle); f.input.scheduler.clearInterval(handle); },
    };
    t.after(() => { for (const handle of intervals) f.input.scheduler.clearInterval(handle); });
    const resourceGovernor = { kind: 'LocalAdmissionReleaseControl', snapshot: f.governor.snapshot,
      async acquire(request, options) {
        const release = await f.governor.acquire(request, options); admitted = true;
        return () => { releases += 1; release(); throw new Error('local_admission_release_failed'); };
      } };
    const campaignStore = { ...f.campaigns, getCampaign(...args) {
      if (admitted && !injected) {
        injected = true;
        if (queryFails) throw new Error('local_admission_query_failed');
        return { ...f.campaigns.getCampaign(...args), status: 'paused' };
      }
      return f.campaigns.getCampaign(...args);
    } };
    await assert.rejects(f.run(async () => { calls += 1; return receipt(); },
      { resourceGovernor, campaignStore, scheduler, signal: supervisor.signal }), /local_admission_(release|query)_failed/);
    assert.equal(calls, 0); assert.equal(releases, 1); assert.deepEqual(f.governor.snapshot().used, v());
    assert.equal(intervals.size, 0); assert.deepEqual(getEventListeners(supervisor.signal, 'abort'), []);
    assert.equal(f.campaigns.listNodes('envelope-campaign')[0].preparedResultHash, null);
  });
}
