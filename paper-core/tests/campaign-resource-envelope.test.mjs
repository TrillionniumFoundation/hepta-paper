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
import { captureCampaignResourceEnvelopePolicy, prepareCampaignResourceEnvelopes,
  createCampaignNestedExecutionScope } from '../../paper-application/automation/campaign-resource-envelope.mjs';
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
function unused(f) {
  assert.deepEqual(f.governor.snapshot().used, v());
  assert.equal(f.governor.snapshot().waiting, 0);
  assert.ok(f.campaigns.listNodes('envelope-campaign').every((node) => node.status === 'queued'));
}

test('policy captures sorted immutable values with a stable explicit versioned hash', () => {
  const a = captureCampaignResourceEnvelopePolicy(policy({ compile: 1, 'formal-verify': 2 }));
  const b = captureCampaignResourceEnvelopePolicy(policy({ 'formal-verify': 2, compile: 1 },
    { maximumChildren: 1024, maximumWaitingRequests: 1024 }));
  assert.deepEqual(a, b); assert.equal(a.policyHash, hashRecord('CampaignResourceEnvelopePolicyV1', a.policy));
  assert.throws(() => { a.policy.nestedAgentSlotsByKind.compile = 2; }, TypeError);
});

test('invalid policy records, unknown kinds, coercions and accessors are rejected', () => {
  let calls = 0;
  const accessor = Object.defineProperty(policy(), 'nestedAgentSlotsByKind', { enumerable: true,
    get() { calls += 1; return { compile: 1 }; } });
  for (const input of [null, [], {}, policy({}, {}), policy({ unknown: 1 }), policy({ compile: '1' }),
    policy({ compile: 0 }), policy({ compile: 65 }), policy({ compile: Infinity }), accessor,
    policy({ compile: 1 }, { maximumChildren: undefined }), policy({ compile: 1 }, { maximumWaitingRequests: -1 }),
    { ...policy(), credential: 'not-accepted' }, { ...policy(), version: true },
    policy({ [Symbol('compile')]: 1 }), policy(Object.create({ compile: 1 }))]) {
    assert.throws(() => captureCampaignResourceEnvelopePolicy(input));
  }
  assert.equal(calls, 0);
});

test('actual SQLite campaign completes forty nested operations using both reserved pools', { timeout: 10000 }, async (t) => {
  const f = fixture(t); let calls = 0; let otherEntered = false; let other;
  const result = await f.run(async ({ executionResources, executionBudget }) => {
    assert.equal(executionBudget.resourceEnvelope.policyHash, f.captured.policyHash);
    assert.deepEqual(executionBudget.resourceEnvelope.totalReservation, v(1, 1, 16));
    assert.deepEqual(executionBudget.acquiredResources, v(0, 1, 16));
    other = f.governor.acquire(v(1, 1, 16)).then((release) => { otherEntered = true; release(); });
    for (let i = 0; i < 40; i += 1) await executionResources.runNestedAgent(async () => {
      calls += 1; assert.equal(otherEntered, false); assert.deepEqual(f.governor.snapshot().used, v(1, 1, 16)); return receipt();
    });
    return { kind: 'LocalCompileControl', status: 'completed', externalActionPerformed: false };
  });
  await other;
  assert.equal(calls, 40); assert.equal(result.campaign.status, 'completed');
  assert.equal(result.campaign.agentCallCount, 40);
  assert.equal(result.resourceEnvelopePolicyHash, f.captured.policyHash);
  assert.equal(result.nodes[0].status, 'completed'); assert.ok(result.nodes[0].preparedResultHash);
  assert.deepEqual(f.governor.snapshot().used, v());
});

test('missing, mismatched or removed declared policy fails before claiming a node', async (t) => {
  const f = fixture(t);
  await assert.rejects(f.run(async () => { throw new Error('must not run'); },
    { resourceEnvelopePolicy: null }), code('campaign_envelope_policy_required')); unused(f);
  await assert.rejects(f.run(async () => {}, { resourceEnvelopePolicy: policy({ compile: 2 }) }),
    code('campaign_envelope_policy_binding_mismatch')); unused(f);
  const g = fixture(t, { config: null });
  await assert.rejects(g.run(async () => {}, { resourceEnvelopePolicy: policy() }),
    code('campaign_envelope_policy_binding_mismatch')); unused(g);
});

test('local total-capacity infeasibility is rejected before any claim or executor call', async (t) => {
  const f = fixture(t, { config: policy({ compile: 2 }), globalLimits: v(4, 2, 64) });
  await assert.rejects(f.run(async () => {}), code('campaign_envelope_capacity_exceeded:agent')); unused(f);
});

test('global total-capacity infeasibility is rejected before any claim', async (t) => {
  const f = fixture(t, { globalLimits: v(0, 1, 16) });
  await assert.rejects(f.run(async () => {}), code('campaign_envelope_capacity_exceeded:agent')); unused(f);
});

test('unsupported distributed governor cannot silently degrade to local reservations', async (t) => {
  const f = fixture(t); let acquired = false;
  const resourceGovernor = { kind: 'PersistentGovernor', limits: v(1, 1, 16),
    acquire() { acquired = true; throw new Error('must not call'); }, snapshot: () => ({}) };
  await assert.rejects(f.run(async () => {}, { resourceGovernor }), code('campaign_envelope_governor_unsupported'));
  assert.equal(acquired, false); unused(f);
});

test('persisted policy identity is covered by existing campaign-definition replay checks', (t) => {
  const f = fixture(t); const before = f.campaigns.getCampaign('envelope-campaign').spec;
  assert.throws(() => f.campaigns.createCampaign({ ...before,
    resourceEnvelopePolicyHash: `sha256:${'1'.repeat(64)}` }), /campaign_definition_conflict/);
  assert.equal(f.campaigns.getCampaign('envelope-campaign').spec.resourceEnvelopePolicyHash, f.captured.policyHash);
});

test('mutation of caller configuration during execution cannot enlarge the captured child pool', async (t) => {
  const config = policy(); const f = fixture(t, { config });
  const result = await f.run(async ({ executionResources, executionBudget }) => {
    config.nestedAgentSlotsByKind.compile = 64;
    assert.equal(executionBudget.resourceEnvelope.childCapacity.agent, 1);
    await executionResources.runNestedAgent(async () => receipt()); return receipt();
  });
  assert.equal(result.resourceEnvelopePolicyHash, f.captured.policyHash);
  assert.equal(result.campaign.status, 'completed'); assert.deepEqual(f.governor.snapshot().used, v());
});

test('unconfigured node kind cannot request unreserved nested work under an active policy', async (t) => {
  const f = fixture(t, { config: policy({ 'formal-verify': 1 }) }); let operations = 0;
  const result = await f.run(async ({ executionResources }) => {
    await executionResources.runNestedAgent(async () => { operations += 1; return receipt(); }); return receipt();
  });
  assert.equal(operations, 0); assert.equal(result.campaign.status, 'failed');
  assert.equal(result.nodes[0].failureClass, 'campaign_nested_kind_undeclared');
  assert.equal(result.campaign.agentCallCount, 0); assert.deepEqual(f.governor.snapshot().used, v());
});

for (const parentFails of [false, true]) {
  test(`parent ${parentFails ? 'failure' : 'return'} drains an escaped live child before state publication or refund`,
    { timeout: 10000 }, async (t) => {
      const f = fixture(t); const started = deferred(); const finish = deferred(); let child;
      let settled = false; let executionSignal;
      const run = f.run(async ({ executionResources, executionSignal: signal }) => {
        executionSignal = signal;
        child = executionResources.runNestedAgent(async () => { started.resolve(); await finish.promise; return receipt(); });
        await started.promise;
        if (parentFails) throw Object.assign(new Error('local_parent_failure'), { retryable: false });
        return receipt();
      }).then((result) => { settled = true; return result; });
      await started.promise; await tick();
      assert.equal(executionSignal.aborted, true); assert.equal(settled, false);
      assert.deepEqual(f.governor.snapshot().used, v(1, 1, 16));
      const pendingNode = f.campaigns.listNodes('envelope-campaign')[0];
      assert.equal(pendingNode.status, 'running'); assert.equal(pendingNode.preparedResultHash, null);
      finish.resolve(); const result = await run; await assert.rejects(child);
      assert.equal(result.campaign.status, 'failed'); assert.equal(result.nodes[0].preparedResultHash, null);
      assert.equal(result.nodes[0].failureClass, parentFails ? 'local_parent_failure' : 'campaign_nested_work_unsettled');
      assert.deepEqual(f.governor.snapshot().used, v());
    });
}

test('retained callback cannot start work after parent result has completed', async (t) => {
  const f = fixture(t); let retained; let calls = 0;
  const result = await f.run(async ({ executionResources }) => { retained = executionResources.runNestedAgent; return receipt(); });
  assert.equal(result.campaign.status, 'completed');
  await assert.rejects(retained(async () => { calls += 1; }), code('campaign_nested_scope_closed'));
  assert.equal(calls, 0); assert.deepEqual(f.governor.snapshot().used, v());
});

test('handled and awaited nested failure does not poison a valid parent recovery', async (t) => {
  const f = fixture(t);
  const result = await f.run(async ({ executionResources }) => {
    await assert.rejects(executionResources.runNestedAgent(async () => { throw new Error('local_retryable_child'); }),
      /local_retryable_child/);
    await executionResources.runNestedAgent(async () => receipt()); return receipt();
  });
  assert.equal(result.campaign.status, 'completed'); assert.deepEqual(f.governor.snapshot().used, v());
});

test('global reservation is returned if cancellation interrupts local envelope acquisition', async () => {
  const governor = createResourceGovernor(v(1, 1, 16)); const localGovernor = createResourceGovernor(v(1, 1, 16));
  const cfg = policy(); const captured = captureCampaignResourceEnvelopePolicy(cfg);
  const prepared = prepareCampaignResourceEnvelopes({ policy: cfg, governor, localGovernor,
    campaign: { spec: { resourceEnvelopePolicyHash: captured.policyHash } }, nodes: [] });
  const held = await localGovernor.acquire(v(1, 1, 16)); const controller = new AbortController();
  const request = prepared.acquire({ kind: 'compile' }, v(0, 1, 16), controller.signal);
  await tick(); assert.deepEqual(governor.snapshot().used, v(1, 1, 16));
  controller.abort(); await assert.rejects(request, code('resource_acquire_aborted'));
  assert.deepEqual(governor.snapshot().used, v()); assert.equal(localGovernor.snapshot().waiting, 0);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0); held();
});

test('supervisor cancellation does not refund running child/parent or publish prepared output', async (t) => {
  const f = fixture(t); const started = deferred(); const finish = deferred(); const controller = new AbortController();
  let returned = false;
  const run = f.run(async ({ executionResources }) => {
    await executionResources.runNestedAgent(async () => { started.resolve(); await finish.promise; return receipt(); }); return receipt();
  }, { signal: controller.signal }).then((result) => { returned = true; return result; });
  await started.promise; controller.abort('local_shutdown'); await tick();
  assert.equal(returned, false); assert.deepEqual(f.governor.snapshot().used, v(1, 1, 16));
  finish.resolve(); const result = await run;
  assert.equal(result.campaign.status, 'paused'); assert.equal(result.nodes[0].preparedResultHash, null);
  assert.deepEqual(f.governor.snapshot().used, v());
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('opted-in dispatcher joins siblings before returning a dispatch failure', async (t) => {
  const f = fixture(t, { kinds: ['compile', 'compile'], concurrency: 2, globalLimits: v(2, 2, 32) });
  const finish = deferred(); const started = deferred(); let returned = false;
  const campaignStore = { ...f.campaigns, startNode(input) {
    if (input.nodeId === 'node-0') throw new Error('local_start_failure');
    return f.campaigns.startNode(input);
  } };
  const run = f.run(async () => { started.resolve(); await finish.promise; return receipt(); }, { campaignStore })
    .then(() => { returned = true; }, (error) => { returned = true; return error; });
  await started.promise; await tick(); assert.equal(returned, false);
  assert.deepEqual(f.governor.snapshot().used, v(1, 1, 16));
  finish.resolve(); const error = await run; assert.match(error.message, /local_start_failure/);
  assert.deepEqual(f.governor.snapshot().used, v());
});

test('legacy unconfigured campaigns keep the existing result shape and dispatch path', async (t) => {
  const f = fixture(t, { config: null });
  const result = await f.run(async ({ executionBudget }) => {
    assert.equal(Object.hasOwn(executionBudget, 'resourceEnvelope'), false); return receipt();
  });
  assert.equal(result.campaign.status, 'completed'); assert.equal(Object.hasOwn(result, 'resourceEnvelopePolicyHash'), false);
  assert.deepEqual(f.governor.snapshot().used, v());
});

test('nested scope bounds undispatched promises before asynchronous resource acquisition', async () => {
  const controller = new AbortController(); const finish = deferred(); let calls = 0;
  const scope = createCampaignNestedExecutionScope(async () => { calls += 1; await finish.promise; }, controller,
    { maximumOutstanding: 2 });
  const a = scope.run(() => {}); const b = scope.run(() => {});
  await assert.rejects(scope.run(() => {}), code('campaign_nested_outstanding_limit'));
  assert.equal(calls, 2); const drain = scope.drain(); assert.equal(controller.signal.aborted, true);
  finish.resolve(); await Promise.all([a, b, drain]);
  await assert.rejects(scope.run(() => {}), code('campaign_nested_scope_closed'));
});


test('recursive child attempts are denied before reacquiring the same reserved pool', async (t) => {
  const f = fixture(t); let invocations = 0;
  const result = await f.run(async ({ executionResources }) => {
    await executionResources.runNestedAgent(async () => {
      await assert.rejects(executionResources.runNestedAgent(async () => { invocations += 1; return receipt(); }),
        code('campaign_nested_recursion_forbidden'));
      return receipt();
    });
    return receipt();
  });
  assert.equal(invocations, 0); assert.equal(result.campaign.status, 'completed');
  assert.equal(result.campaign.agentCallCount, 1); assert.deepEqual(f.governor.snapshot().used, v());
});

test('earlier supervisor listener cannot suppress engine cancellation while the child remains charged', async (t) => {
  const f = fixture(t); const controller = new AbortController();
  const suppress = (event) => event.stopImmediatePropagation();
  controller.signal.addEventListener('abort', suppress);
  const started = deferred(); const finish = deferred(); let childSignal;
  const run = f.run(async ({ executionResources }) => {
    await executionResources.runNestedAgent(async ({ signal }) => {
      childSignal = signal; started.resolve(); await finish.promise; return receipt();
    });
    return receipt();
  }, { signal: controller.signal });
  await started.promise; controller.abort('local_shutdown'); await tick();
  assert.equal(childSignal.aborted, true); assert.deepEqual(f.governor.snapshot().used, v(1, 1, 16));
  finish.resolve(); const result = await run;
  assert.equal(result.campaign.status, 'paused'); assert.equal(result.nodes[0].preparedResultHash, null);
  assert.deepEqual(getEventListeners(controller.signal, 'abort'), [suppress]);
  assert.deepEqual(f.governor.snapshot().used, v());
});

test('existing external-action gate still denies before nested budget reservation or callback', async (t) => {
  const f = fixture(t); let operations = 0; let gates = 0;
  const result = await f.run(async ({ executionResources }) => {
    await executionResources.runNestedAgent(async () => { operations += 1; return receipt(); }); return receipt();
  }, { assertExternalSideEffectReady: async ({ action }) => {
    gates += 1;
    if (action.startsWith('campaign_nested_agent_execute:')) {
      throw Object.assign(new Error('local_external_gate_denied'), { retryable: false });
    }
  } });
  assert.ok(gates >= 2); assert.equal(operations, 0);
  assert.equal(result.campaign.status, 'failed'); assert.equal(result.nodes[0].failureClass, 'local_external_gate_denied');
  assert.equal(result.campaign.agentCallCount, 0); assert.deepEqual(f.governor.snapshot().used, v());
});


test('legacy callers also cannot publish a parent while their nested operation is unfinished', async (t) => {
  const f = fixture(t, { config: null }); const started = deferred(); const finish = deferred(); let child;
  let returned = false;
  const run = f.run(async ({ executionResources }) => {
    child = executionResources.runNestedAgent(async () => { started.resolve(); await finish.promise; return receipt(); });
    await started.promise; return receipt();
  }).then((result) => { returned = true; return result; });
  await started.promise; await tick();
  assert.equal(returned, false); assert.equal(f.campaigns.listNodes('envelope-campaign')[0].preparedResultHash, null);
  assert.deepEqual(f.governor.snapshot().used, v(1, 1, 16));
  finish.resolve(); const result = await run; await assert.rejects(child);
  assert.equal(result.campaign.status, 'failed'); assert.deepEqual(f.governor.snapshot().used, v());
});

test('monitor construction failure disposes supervisor subscription before any resource acquisition', async (t) => {
  const f = fixture(t); const controller = new AbortController();
  const scheduler = { ...f.input.scheduler, setInterval() { throw new Error('local_monitor_failure'); } };
  await assert.rejects(f.run(async () => {}, { scheduler, signal: controller.signal }), /local_monitor_failure/);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  assert.deepEqual(f.governor.snapshot().used, v());
});
