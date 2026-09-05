import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getEventListeners } from 'node:events';
import test from 'node:test';
import { createDefaultPaperStore } from '../../paper-adapters/persistence/store-provider.mjs';
import { createSqliteCampaignStore } from '../../paper-adapters/persistence/sqlite-campaign-store.mjs';
import { createSystemClock } from '../../paper-adapters/runtime/system-clock.mjs';
import { createSystemScheduler } from '../../paper-adapters/runtime/system-scheduler.mjs';
import { createRandomIdGenerator } from '../../paper-adapters/runtime/random-id-generator.mjs';
import { runPaperCampaign } from '../../paper-application/automation/campaign-engine.mjs';
import { createResourceGovernor } from '../../paper-application/automation/resource-governor.mjs';
import { normalizeCampaignResourceEnvelopePolicy } from '../../paper-application/automation/campaign-resource-envelope-scope.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const policy = (extra = {}) => ({ version: 1, nodeKinds: ['formal-verify'], childAgentSlots: 1, ...extra });
const zero = { agent: 0, cpu: 0, gpu: 0, memoryMiB: 0 };
const capacity = { agent: 1, cpu: 1, gpu: 0, memoryMiB: 4096 };
const limits = { timeout: 5000 };
const tick = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const receipt = () => {
  const body = { version: 1, kind: 'AgentExecutionReceipt', executorId: 'local-engine-envelope-test',
    status: 'agent_execution_completed', externalModelInvocationPerformed: false };
  return { ...body, agentExecutionReceiptHash: hashRecord('AgentExecutionReceipt', body) };
};

// Real engine, SQLite campaign store, resource governor and nested runner.
// Only the executor's scientific/provider operation is a local control.
function fixture(t, { kind = 'formal-verify', governor = createResourceGovernor(capacity), spec = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'campaign-envelope-integration-'));
  const native = createDefaultPaperStore({ root, runtimeRoot: root });
  const clock = createSystemClock();
  const campaigns = createSqliteCampaignStore({ store: native, clock });
  const system = createSystemScheduler(); const handles = new Set();
  const scheduler = { ...system,
    setInterval(...args) { const handle = system.setInterval(...args); handles.add(handle); return handle; },
    clearInterval(handle) { handles.delete(handle); system.clearInterval(handle); },
  };
  t.after(() => {
    for (const handle of handles) system.clearInterval(handle);
    native.close(); fs.rmSync(root, { recursive: true, force: true });
  });
  campaigns.createCampaign({ campaignId: 'test-campaign', paperId: 'local-only', sourceWorkspace: root,
    budgets: { maxWallTimeMs: 60000, maxAgentCalls: 100, maxCpuJobs: 100, maxGpuJobs: 0,
      maxTokenCount: 10000, maxMemoryMiB: 4096 },
    nodes: [{ nodeId: 'parent', kind, dependencies: [], maxAttempts: 1 }], ...spec });
  const run = (execute, options = {}) => runPaperCampaign({
    campaignId: 'test-campaign', campaignStore: campaigns, clock, scheduler,
    idGenerator: createRandomIdGenerator(), concurrency: 1, pollMs: 1,
    resourceGovernor: governor, resourceEnvelopePolicy: policy(), executor: { execute }, ...options,
  });
  return { campaigns, governor, run, handles };
}
function idle(f) {
  assert.deepEqual(f.governor.snapshot().used, zero);
  assert.equal(f.governor.snapshot().waiting, 0);
  assert.equal(f.handles.size, 0);
}

test('policy is captured, canonical, bounded and explicitly versioned', () => {
  const input = policy({ nodeKinds: ['writer', 'formal-verify'] });
  const normalized = normalizeCampaignResourceEnvelopePolicy(input);
  const same = normalizeCampaignResourceEnvelopePolicy(policy({ nodeKinds: ['formal-verify', 'writer'] }));
  assert.equal(normalized.policyHash, same.policyHash);
  input.nodeKinds[0] = 'changed'; input.childAgentSlots = 2;
  assert.deepEqual(normalized.nodeKinds, ['formal-verify', 'writer']);
  assert.equal(normalized.childAgentSlots, 1);
  assert.throws(() => normalized.nodeKinds.push('agent'), TypeError);
  assert.equal(normalizeCampaignResourceEnvelopePolicy(), null);
});

test('policy rejects coercion, sparse/duplicate kinds, accessors and unknown fields', () => {
  for (const input of [false, [], {}, policy({ version: true }), policy({ extra: 1 }),
    policy({ nodeKinds: [] }), policy({ nodeKinds: ['formal-verify', 'formal-verify'] }),
    policy({ nodeKinds: Array(2) }), policy({ nodeKinds: ['../escape'] }),
    policy({ childAgentSlots: '1' }), policy({ childAgentSlots: 0 }), policy({ childAgentSlots: 65 }),
    policy({ maximumChildren: 4097 }), policy({ maximumWaitingRequests: undefined })]) {
    assert.throws(() => normalizeCampaignResourceEnvelopePolicy(input), { code: 'campaign_resource_envelope_policy_invalid' });
  }
  let accessed = 0;
  const input = Object.defineProperty(policy(), 'childAgentSlots', { get() { accessed += 1; return 1; } });
  const kinds = Object.defineProperty(['formal-verify'], '0', { get() { accessed += 1; return 'writer'; } });
  assert.throws(() => normalizeCampaignResourceEnvelopePolicy(input));
  assert.throws(() => normalizeCampaignResourceEnvelopePolicy(policy({ nodeKinds: kinds })));
  assert.equal(accessed, 0);
});

test('actual engine runs forty nested calls through both pools across a global barrier', limits, async (t) => {
  const f = fixture(t, { governor: createResourceGovernor(capacity, { maximumConflictingBypasses: 0 }) });
  let other; let otherEntered = false; let calls = 0; let binding;
  const result = await f.run(async ({ executionResources, executionBudget }) => {
    binding = executionBudget.resourceEnvelope;
    assert.equal(executionBudget.acquiredResources.agent, 0);
    assert.deepEqual(binding.total, capacity);
    other = f.governor.acquire(capacity).then((release) => { otherEntered = true; release(); });
    for (let index = 0; index < 40; index += 1) {
      await executionResources.runNestedAgent(async () => {
        calls += 1; assert.equal(otherEntered, false);
        assert.deepEqual(f.governor.snapshot().used, capacity); return receipt();
      });
    }
    return { status: 'local-parent-result', externalActionPerformed: false };
  });
  await other;
  assert.equal(calls, 40); assert.equal(result.campaign.agentCallCount, 40);
  assert.equal(result.campaign.status, 'completed');
  assert.equal(result.resourceEnvelopePolicyHash, binding.policyHash);
  assert.equal(Object.isFrozen(binding), true); idle(f);
});

test('unawaited child settlement precedes parent prepare and commit', limits, async (t) => {
  const f = fixture(t); const started = deferred(); const finishChild = deferred();
  t.after(finishChild.resolve); let childFinished = false; let prepared = false;
  const instrumented = { ...f.campaigns, prepareNodeResult(...args) {
    prepared = true; assert.equal(childFinished, true); return f.campaigns.prepareNodeResult(...args);
  } };
  const running = f.run(async ({ executionResources }) => {
    executionResources.runNestedAgent(async () => {
      started.resolve(); await finishChild.promise; childFinished = true; return receipt();
    });
    await started.promise; return { status: 'parent-returned' };
  }, { campaignStore: instrumented });
  await started.promise; await tick();
  assert.equal(prepared, false); assert.deepEqual(f.governor.snapshot().used, capacity);
  assert.equal(f.campaigns.listNodes('test-campaign')[0].status, 'running');
  finishChild.resolve(); const result = await running;
  assert.equal(result.campaign.status, 'completed'); assert.equal(prepared, true); idle(f);
});

test('unawaited child failure remains fatal without an unhandled-rejection escape', limits, async (t) => {
  const f = fixture(t); let prepares = 0;
  const result = await f.run(async ({ executionResources }) => {
    executionResources.runNestedAgent(async () => { throw Object.assign(new Error('local-child-failed'), { code: 'local_child_failed' }); });
    return { status: 'must-not-commit' };
  }, { campaignStore: { ...f.campaigns, prepareNodeResult() { prepares += 1; throw Error('unexpected prepare'); } } });
  assert.equal(result.campaign.status, 'failed'); assert.equal(prepares, 0);
  assert.equal(result.nodes[0].failureClass, 'local_child_failed');
  assert.equal(result.nodes[0].preparedResultHash, null); idle(f);
});

test('a caught failed child is not silently promoted by the opt-in parent', limits, async (t) => {
  const f = fixture(t);
  const result = await f.run(async ({ executionResources }) => {
    await assert.rejects(executionResources.runNestedAgent(async () => { throw Error('caught-child-denial'); }));
    return { status: 'must-not-commit' };
  });
  assert.equal(result.campaign.status, 'failed'); assert.equal(result.nodes[0].failureClass, 'caught-child-denial');
  assert.equal(result.nodes[0].preparedResultHash, null); idle(f);
});

test('parent failure cancels and joins active children before releasing either pool', limits, async (t) => {
  const f = fixture(t); const started = deferred(); let childSettled = false;
  const result = await f.run(async ({ executionResources }) => {
    executionResources.runNestedAgent(({ signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => { childSettled = true; reject(Error('child-cancelled')); }, { once: true });
      started.resolve();
    }));
    await started.promise; throw Object.assign(Error('original-parent-error'), { code: 'original_parent_error' });
  });
  assert.equal(childSettled, true); assert.equal(result.nodes[0].failureClass, 'original_parent_error');
  assert.equal(result.nodes[0].preparedResultHash, null); idle(f);
});

test('supervisor cancellation retains charges while a child has not settled', limits, async (t) => {
  const f = fixture(t); const controller = new AbortController();
  const started = deferred(); const finishChild = deferred(); t.after(finishChild.resolve);
  const suppress = (event) => event.stopImmediatePropagation();
  controller.signal.addEventListener('abort', suppress);
  const running = f.run(async ({ executionResources }) => {
    executionResources.runNestedAgent(async () => { started.resolve(); await finishChild.promise; return receipt(); });
    await started.promise; return { status: 'not-yet-eligible' };
  }, { signal: controller.signal });
  await started.promise; controller.abort('local-supervisor-stop'); await tick();
  assert.deepEqual(f.governor.snapshot().used, capacity);
  assert.equal(f.campaigns.listNodes('test-campaign')[0].preparedResultHash, null);
  finishChild.resolve(); const result = await running;
  assert.equal(result.campaign.status, 'paused');
  assert.deepEqual(getEventListeners(controller.signal, 'abort'), [suppress]); idle(f);
});

test('cancellation during root admission frees monitor, subscription and waiting slot', limits, async (t) => {
  const f = fixture(t); const held = await f.governor.acquire(capacity); t.after(held);
  const controller = new AbortController(); let calls = 0;
  const running = f.run(async () => { calls += 1; }, { signal: controller.signal });
  await tick(); assert.equal(f.governor.snapshot().waiting, 1);
  controller.abort(); const result = await running;
  assert.equal(result.campaign.status, 'paused'); assert.equal(calls, 0);
  assert.equal(f.governor.snapshot().waiting, 0); assert.deepEqual(f.governor.snapshot().used, capacity);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  held(); idle(f);
});

test('local pool rejection releases the already acquired global envelope', limits, async (t) => {
  const f = fixture(t, { kind: 'writer', governor: createResourceGovernor({ ...capacity, agent: 2 }) });
  const controller = new AbortController(); let calls = 0;
  await assert.rejects(f.run(async () => { calls += 1; }, { signal: controller.signal,
    resourceEnvelopePolicy: policy({ nodeKinds: ['writer'] }) }), { code: 'resource_request_exceeds_limit:agent' });
  assert.equal(calls, 0); assert.equal(getEventListeners(controller.signal, 'abort').length, 0); idle(f);
});

test('status-read failure after admission cannot leak either reservation', limits, async (t) => {
  const f = fixture(t); let acquired = false; const controller = new AbortController();
  const governor = { ...f.governor, async acquireEnvelope(...args) {
    const owner = await f.governor.acquireEnvelope(...args); acquired = true; return owner;
  } };
  const store = { ...f.campaigns, getCampaign(...args) {
    if (acquired) throw Error('injected-status-read-failure'); return f.campaigns.getCampaign(...args);
  } };
  await assert.rejects(f.run(async () => { throw Error('must-not-execute'); }, {
    campaignStore: store, resourceGovernor: governor, signal: controller.signal,
  }), /injected-status-read-failure/);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0); idle(f);
});

test('start-node failure also clears acquired resources and lifecycle controls', limits, async (t) => {
  const f = fixture(t); const controller = new AbortController();
  await assert.rejects(f.run(async () => { throw Error('must-not-execute'); }, {
    signal: controller.signal, campaignStore: { ...f.campaigns, startNode() { throw Error('injected-start-failure'); } },
  }), /injected-start-failure/);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0); idle(f);
});

test('unsupported shared governor is rejected before any node claim', limits, async (t) => {
  const f = fixture(t); let claims = 0;
  await assert.rejects(f.run(async () => {}, { resourceGovernor: { acquire() {}, snapshot: () => ({}) },
    campaignStore: { ...f.campaigns, claimReady() { claims += 1; return []; } },
  }), { code: 'campaign_resource_envelope_governor_unsupported' });
  assert.equal(claims, 0); assert.equal(f.campaigns.listNodes('test-campaign')[0].status, 'queued'); idle(f);
});

test('policy cannot be enabled by campaign data or node data', limits, async (t) => {
  const f = fixture(t, { spec: { resourceEnvelopePolicy: policy() } });
  let scopeCalls = 0;
  const result = await f.run(async ({ executionBudget, executionResources }) => {
    assert.equal(executionBudget.resourceEnvelope, undefined);
    await executionResources.runNestedAgent(async () => receipt()); return { status: 'legacy-result' };
  }, { resourceEnvelopePolicy: null, resourceGovernor: { ...f.governor,
    acquireEnvelope() { scopeCalls += 1; throw Error('unexpected-envelope'); },
  } });
  assert.equal(result.campaign.status, 'completed'); assert.equal(scopeCalls, 0);
  assert.equal(result.resourceEnvelopePolicyHash, undefined); idle(f);
});

test('unselected node kinds retain the legacy acquisition path', limits, async (t) => {
  const f = fixture(t); let scopeCalls = 0;
  const result = await f.run(async () => ({ status: 'unselected-local-result' }), {
    resourceEnvelopePolicy: policy({ nodeKinds: ['writer'] }),
    resourceGovernor: { ...f.governor, acquireEnvelope() { scopeCalls += 1; throw Error('unexpected-envelope'); } },
  });
  assert.equal(result.campaign.status, 'completed'); assert.equal(scopeCalls, 0); idle(f);
});

test('retained child port cannot execute or mutate the campaign after scope completion', limits, async (t) => {
  const f = fixture(t); let late; let calls = 0;
  await f.run(async ({ executionResources }) => { late = executionResources.runNestedAgent; return { status: 'local' }; });
  const before = f.campaigns.listNodes('test-campaign')[0];
  await assert.rejects(late(async () => { calls += 1; return receipt(); }), { code: 'campaign_nested_admission_closed' });
  assert.equal(calls, 0); assert.deepEqual(f.campaigns.listNodes('test-campaign')[0], before); idle(f);
});

test('outstanding child limit is enforced before invoking another nested runner', limits, async (t) => {
  const f = fixture(t); let calls = 0;
  const result = await f.run(async ({ executionResources }) => {
    const first = executionResources.runNestedAgent(async () => { calls += 1; return receipt(); });
    await assert.rejects(executionResources.runNestedAgent(async () => { calls += 1; return receipt(); }),
      { code: 'campaign_nested_outstanding_limit' });
    await first; return { status: 'must-not-ignore-overflow' };
  }, { resourceEnvelopePolicy: policy({ maximumChildren: 1 }) });
  assert.equal(calls, 1); assert.equal(result.nodes[0].failureClass, 'campaign_nested_outstanding_limit');
  assert.equal(result.nodes[0].preparedResultHash, null); idle(f);
});

test('nested lifetime budget enforcement remains mandatory with reserved capacity', limits, async (t) => {
  const f = fixture(t, { spec: { budgets: { maxWallTimeMs: 60000, maxAgentCalls: 0,
    maxCpuJobs: 10, maxGpuJobs: 0, maxTokenCount: 10000, maxMemoryMiB: 4096 } } });
  let calls = 0;
  const result = await f.run(async ({ executionResources }) => {
    await executionResources.runNestedAgent(async () => { calls += 1; return receipt(); });
    return { status: 'must-not-execute' };
  });
  assert.equal(calls, 0); assert.equal(result.campaign.status, 'stopped');
  assert.equal(result.campaign.stopReason, 'campaign_agent_call_budget_exhausted'); idle(f);
});

test('external action gate denial still prevents the nested operation', limits, async (t) => {
  const f = fixture(t); let calls = 0;
  const gate = async ({ action }) => {
    if (action.startsWith('campaign_nested_agent_execute:')) throw Object.assign(Error('local-authority-denial'), { retryable: false });
  };
  gate.assertCurrent = () => true; gate.markStarted = () => true;
  const result = await f.run(async ({ executionResources }) => {
    await executionResources.runNestedAgent(async () => { calls += 1; return receipt(); });
    return { status: 'must-not-execute' };
  }, { assertExternalSideEffectReady: gate });
  assert.equal(calls, 0); assert.equal(result.campaign.status, 'failed');
  assert.equal(result.nodes[0].preparedResultHash, null); idle(f);
});

test('normal completion drains already registered queued children instead of cancelling them', limits, async (t) => {
  const f = fixture(t); const order = [];
  const result = await f.run(async ({ executionResources }) => {
    for (let index = 0; index < 3; index += 1) {
      executionResources.runNestedAgent(async () => { await tick(); order.push(index); return receipt(); });
    }
    return { status: 'local-parent-with-queued-children' };
  });
  assert.deepEqual(order, [0, 1, 2]); assert.equal(result.campaign.agentCallCount, 3);
  assert.equal(result.campaign.status, 'completed'); idle(f);
});

test('batch rejection waits for the other admitted node to settle', limits, async (t) => {
  const governor = createResourceGovernor({ ...capacity, agent: 2, cpu: 2, memoryMiB: 8192 });
  const f = fixture(t, { governor, spec: {
    budgets: { maxWallTimeMs: 60000, maxAgentCalls: 100, maxCpuJobs: 100,
      maxGpuJobs: 0, maxTokenCount: 10000, maxMemoryMiB: 8192 },
    nodes: [{ nodeId: 'a-fail', kind: 'formal-verify', dependencies: [], maxAttempts: 1 },
      { nodeId: 'b-active', kind: 'formal-verify', dependencies: [], maxAttempts: 1 }],
  } });
  const started = deferred(); const proceed = deferred(); t.after(proceed.resolve);
  let outcome = 'pending';
  const running = f.run(async () => { started.resolve(); await proceed.promise; return { status: 'local-peer-result' }; }, {
    concurrency: 2, campaignStore: { ...f.campaigns, startNode(input) {
      if (input.nodeId === 'a-fail') throw Error('local-peer-admission-failure');
      return f.campaigns.startNode(input);
    } },
  });
  const observation = running.then(() => { outcome = 'success'; }, (error) => { outcome = error.message; });
  await started.promise; await tick();
  assert.equal(outcome, 'pending'); assert.deepEqual(governor.snapshot().used, capacity);
  proceed.resolve(); await observation;
  assert.equal(outcome, 'local-peer-admission-failure'); idle(f);
});

test('cancellation at the extracted integration await cannot cross into commit', limits, async (t) => {
  const f = fixture(t); const controller = new AbortController(); let commits = 0;
  const result = await f.run(async () => ({ status: 'prepared-not-committed' }), {
    signal: controller.signal, campaignStore: { ...f.campaigns,
      prepareNodeResult(...args) {
        const prepared = f.campaigns.prepareNodeResult(...args);
        queueMicrotask(() => controller.abort('cancel-at-integration-handoff'));
        return prepared;
      },
      completeNode(...args) { commits += 1; return f.campaigns.completeNode(...args); },
    },
  });
  assert.equal(commits, 0); assert.equal(result.campaign.status, 'paused');
  assert.notEqual(result.nodes[0].status, 'completed'); idle(f);
});
