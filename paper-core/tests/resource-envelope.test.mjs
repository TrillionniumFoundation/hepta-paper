import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import test from 'node:test';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { createResourceGovernor } from '../../paper-application/automation/resource-governor.mjs';
import { createCampaignNestedAgentRunner } from '../../paper-application/automation/campaign-nested-agent-runner.mjs';

const v = (agent = 0, memoryMiB = 0, cpu = 0, gpu = 0) => ({ agent, cpu, gpu, memoryMiB });
const tick = () => new Promise((resolve) => queueMicrotask(resolve));
const definition = (retained = { memoryMiB: 2 }, childCapacity = { agent: 1 }) => ({ retained, childCapacity });
const create = (capacity = v(2, 4), policy = {}) => createResourceGovernor(capacity, policy);
const empty = (g) => { assert.deepEqual(g.snapshot().used, v()); assert.equal(g.snapshot().waiting, 0); };
const code = (name) => ({ code: name });

test('envelope reserves the sum atomically; child pool never inherits missing defaults', async () => {
  const g = create(); const owner = await g.acquireEnvelope(definition());
  assert.deepEqual(g.snapshot().used, v(1, 2));
  assert.deepEqual(owner.childGovernor.limits, v(1));
  const release = await owner.childGovernor.acquire({ agent: 1 });
  assert.deepEqual(g.snapshot().used, v(1, 2));
  assert.deepEqual(owner.snapshot().children.used, v(1));
  release(); owner.close(); empty(g);
});

test('malformed envelope definitions are rejected without invoking getters', async () => {
  const g = create(); let calls = 0;
  for (const value of [null, [], {}, { retained: {} }, { ...definition(), other: 1 },
    definition(null), definition({ cpu: '1' }), definition({}, { gpu: NaN })]) {
    await assert.rejects(g.acquireEnvelope(value)); empty(g);
  }
  const getter = Object.defineProperty(definition(), 'retained', {
    enumerable: true, get() { calls += 1; return {}; },
  });
  await assert.rejects(g.acquireEnvelope(getter), code('resource_envelope_definition_invalid'));
  assert.equal(calls, 0); empty(g);
});

test('explicit undefined required members and all-zero envelopes are denied', async () => {
  const g = create();
  for (const value of [{ retained: undefined, childCapacity: {} }, { retained: {}, childCapacity: undefined }]) {
    await assert.rejects(g.acquireEnvelope(value), code('resource_envelope_definition_invalid'));
  }
  await assert.rejects(g.acquireEnvelope(definition({}, {})), code('resource_envelope_empty')); empty(g);
});

test('envelope sum cannot overflow or partially acquire an excessive dimension', async () => {
  const g = create(v(2, Number.MAX_SAFE_INTEGER));
  await assert.rejects(g.acquireEnvelope(definition({ memoryMiB: Number.MAX_SAFE_INTEGER }, { memoryMiB: 1 })),
    code('resource_envelope_overflow:memoryMiB'));
  await assert.rejects(g.acquireEnvelope(definition({ memoryMiB: 1 }, { agent: 3 })),
    code('resource_request_exceeds_limit:agent')); empty(g);
});

test('invalid limits and owner signals fail before root admission', async () => {
  const g = create();
  for (const options of [null, [], { extra: 1 }, { maximumChildren: 0 }, { maximumChildren: 4097 },
    { maximumChildren: '1' }, { maximumWaitingRequests: 0 }, { maximumWaitingRequests: undefined },
    { signal: {} }, { signal: false }]) {
    await assert.rejects(g.acquireEnvelope(definition(), options)); empty(g);
  }
});

test('pre-aborted root request neither allocates nor subscribes', async () => {
  const g = create(); const controller = new AbortController(); controller.abort();
  await assert.rejects(g.acquireEnvelope(definition(), { signal: controller.signal }), code('resource_acquire_aborted'));
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0); empty(g);
});

test('abort between root grant and owner handoff returns the entire reservation', async () => {
  const g = create(); const controller = new AbortController();
  const owner = g.acquireEnvelope(definition(), { signal: controller.signal });
  assert.deepEqual(g.snapshot().used, v(1, 2)); controller.abort();
  await assert.rejects(owner, code('resource_acquire_aborted'));
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0); empty(g);
});

test('blocked root cancellation cannot be suppressed and frees the waiting slot', async () => {
  const g = create(v(1, 2), { maximumWaitingRequests: 1 }); const held = await g.acquire(v(1, 2));
  const controller = new AbortController(); const suppress = (event) => event.stopImmediatePropagation();
  controller.signal.addEventListener('abort', suppress);
  const waiting = g.acquireEnvelope(definition(), { signal: controller.signal });
  controller.abort(); await assert.rejects(waiting, code('resource_acquire_aborted'));
  assert.equal(g.snapshot().waiting, 0); assert.deepEqual(getEventListeners(controller.signal, 'abort'), [suppress]);
  held(); empty(g);
});

test('legacy unscoped hold-and-wait is reproduced without enabling envelope routing implicitly', async () => {
  const g = create(v(1, 2), { maximumConflictingBypasses: 0 });
  const parent = await g.acquire({ memoryMiB: 2 });
  const a = new AbortController(); const b = new AbortController();
  let childEntered = false;
  const large = g.acquire(v(1, 2), { signal: a.signal });
  const child = g.acquire(v(1), { signal: b.signal }).then((release) => { childEntered = true; return release; });
  const rejectedLarge = assert.rejects(large, code('resource_acquire_aborted'));
  const rejectedChild = assert.rejects(child, code('resource_acquire_aborted'));
  await tick(); assert.equal(childEntered, false); assert.equal(g.snapshot().waiting, 2);
  // Cancel the child first: removing the large barrier would otherwise grant it.
  b.abort(); a.abort(); await Promise.all([rejectedChild, rejectedLarge]); parent(); empty(g);
});

test('a global conflicting fairness barrier cannot block an admitted parent child-pool', async () => {
  const g = create(v(1, 2), { maximumConflictingBypasses: 0 });
  const owner = await g.acquireEnvelope(definition()); let otherEntered = false;
  const other = g.acquire(v(1, 2)).then((release) => { otherEntered = true; return release; });
  for (let i = 0; i < 64; i += 1) (await owner.childGovernor.acquire({ agent: 1 }))();
  assert.equal(otherEntered, false); assert.equal(g.snapshot().waiting, 1);
  owner.close(); (await other)(); empty(g);
});

test('simultaneous envelopes retain separate pools and cannot spend each others quota', async () => {
  const g = create(); const a = await g.acquireEnvelope(definition()); const b = await g.acquireEnvelope(definition());
  const ar = await a.childGovernor.acquire({ agent: 1 }); const br = await b.childGovernor.acquire({ agent: 1 });
  let entered = false; const next = a.childGovernor.acquire({ agent: 1 }).then((r) => { entered = true; return r; });
  br(); await tick(); assert.equal(entered, false);
  assert.deepEqual(g.snapshot().used, v(2, 4)); ar(); (await next)(); a.close(); b.close(); empty(g);
});

test('children cannot borrow retained parent quota or unused global capacity', async () => {
  const g = create(); const owner = await g.acquireEnvelope(definition());
  for (const value of [{ agent: 2 }, { memoryMiB: 1 }, { cpu: 1 }, { storageBytes: 1 }, { agent: NaN }]) {
    await assert.rejects(owner.childGovernor.acquire(value));
  }
  assert.equal(owner.snapshot().pendingChildren, 0); assert.equal(owner.snapshot().activeChildren, 0);
  owner.close(); empty(g);
});

test('maximumChildren counts pending, in-transit and even zero-resource handles', async () => {
  const g = create(); const owner = await g.acquireEnvelope(definition(), { maximumChildren: 2 });
  const first = owner.childGovernor.acquire({}); const second = owner.childGovernor.acquire({});
  await assert.rejects(owner.childGovernor.acquire({}), code('resource_envelope_child_limit'));
  const a = await first; const b = await second;
  await assert.rejects(owner.childGovernor.acquire({}), code('resource_envelope_child_limit'));
  a(); b(); owner.close(); empty(g);
});

test('child wait queue is bounded separately from the root queue', async () => {
  const g = create(); const owner = await g.acquireEnvelope(definition(), { maximumWaitingRequests: 1 });
  const held = await owner.childGovernor.acquire({ agent: 1 }); const controller = new AbortController();
  const waiting = owner.childGovernor.acquire({ agent: 1 }, { signal: controller.signal });
  await assert.rejects(owner.childGovernor.acquire({ agent: 1 }), code('resource_wait_queue_full'));
  assert.equal(g.snapshot().waiting, 0); assert.equal(owner.snapshot().children.waiting, 1);
  controller.abort(); await assert.rejects(waiting, code('resource_acquire_aborted'));
  held(); owner.close(); empty(g);
});

test('suppressed child cancellation removes only its subscription, without refunding root', async () => {
  const g = create(); const owner = await g.acquireEnvelope(definition()); const held = await owner.childGovernor.acquire(v(1));
  const controller = new AbortController(); const suppress = (event) => event.stopImmediatePropagation();
  controller.signal.addEventListener('abort', suppress);
  const waiting = owner.childGovernor.acquire(v(1), { signal: controller.signal });
  controller.abort(); await assert.rejects(waiting, code('resource_acquire_aborted'));
  assert.deepEqual(getEventListeners(controller.signal, 'abort'), [suppress]);
  assert.deepEqual(g.snapshot().used, v(1, 2)); assert.equal(owner.snapshot().pendingChildren, 0);
  held(); owner.close(); empty(g);
});

test('pre-aborted child request is rejected without consuming an outstanding slot', async () => {
  const g = create(); const owner = await g.acquireEnvelope(definition()); const controller = new AbortController(); controller.abort();
  await assert.rejects(owner.childGovernor.acquire(v(1), { signal: controller.signal }), code('resource_acquire_aborted'));
  assert.equal(owner.snapshot().activeChildren + owner.snapshot().pendingChildren, 0);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0); owner.close(); empty(g);
});

test('post-grant child abort cannot release running work', async () => {
  const g = create(); const owner = await g.acquireEnvelope(definition()); const controller = new AbortController();
  const held = await owner.childGovernor.acquire(v(1), { signal: controller.signal });
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0); controller.abort();
  assert.deepEqual(owner.snapshot().children.used, v(1)); owner.close();
  assert.equal(owner.snapshot().phase, 'closing'); assert.deepEqual(g.snapshot().used, v(1, 2));
  held(); empty(g);
});

test('seal stops admission but never declares retained parent work finished', async () => {
  const g = create(); const owner = await g.acquireEnvelope(definition());
  owner.seal(); owner.seal(); assert.equal(owner.snapshot().phase, 'sealed');
  assert.equal(owner.snapshot().ownerFinished, false); assert.deepEqual(g.snapshot().used, v(1, 2));
  await assert.rejects(owner.childGovernor.acquire({}), code('resource_envelope_not_open'));
  owner.close(); assert.equal(owner.snapshot().phase, 'released'); empty(g);
});

test('owner cancellation seals admission but keeps the full charge until explicit close', async () => {
  const g = create(); const controller = new AbortController(); const suppress = (event) => event.stopImmediatePropagation();
  controller.signal.addEventListener('abort', suppress);
  const owner = await g.acquireEnvelope(definition(), { signal: controller.signal });
  controller.abort(); assert.equal(owner.snapshot().phase, 'sealed');
  assert.deepEqual(g.snapshot().used, v(1, 2)); assert.equal(owner.snapshot().ownerFinished, false);
  assert.deepEqual(getEventListeners(controller.signal, 'abort'), [suppress]); owner.close(); empty(g);
});

test('close waits for active children and rejects still-waiting requests', async () => {
  const g = create(); const owner = await g.acquireEnvelope(definition()); const held = await owner.childGovernor.acquire(v(1));
  const waiting = owner.childGovernor.acquire(v(1)); const rejected = assert.rejects(waiting, code('resource_acquire_aborted'));
  owner.close(); await rejected;
  assert.deepEqual(g.snapshot().used, v(1, 2)); assert.equal(owner.snapshot().activeChildren, 1);
  assert.equal(owner.snapshot().pendingChildren, 0); held(); assert.equal(owner.snapshot().phase, 'released'); empty(g);
});

test('close during child handoff rejects the undispatched child before refunding root', async () => {
  const g = create(); const owner = await g.acquireEnvelope(definition());
  const child = owner.childGovernor.acquire(v(1)); owner.close();
  assert.equal(owner.snapshot().phase, 'closing'); assert.deepEqual(g.snapshot().used, v(1, 2));
  await assert.rejects(child, code('resource_envelope_handoff_cancelled'));
  assert.equal(owner.snapshot().phase, 'released'); empty(g);
});

test('duplicate close and old child release cannot refund a newer global owner', async () => {
  const g = create(); const owner = await g.acquireEnvelope(definition()); const child = await owner.childGovernor.acquire(v(1));
  owner.close(); child(); const next = await g.acquire(v(2, 4));
  child(); owner.close(); owner.seal(); assert.deepEqual(g.snapshot().used, v(2, 4)); next(); empty(g);
});

test('child facade does not grant close or new-envelope authority', async () => {
  const g = create(); const owner = await g.acquireEnvelope(definition());
  assert.equal(Object.hasOwn(owner.childGovernor, 'close'), false);
  assert.equal(Object.hasOwn(owner.childGovernor, 'seal'), false);
  assert.equal(Object.hasOwn(owner.childGovernor, 'acquireEnvelope'), false);
  assert.equal(Object.isFrozen(owner.childGovernor), true); owner.close(); empty(g);
});

test('input mutation and returned snapshots cannot expand the reservation', async () => {
  const g = create(); const input = definition(); const pending = g.acquireEnvelope(input);
  input.retained.memoryMiB = 100; input.childCapacity.agent = 100;
  const owner = await pending; assert.deepEqual(owner.snapshot().envelope, v(1, 2));
  for (const target of [owner.snapshot().envelope, owner.snapshot().retained, owner.snapshot().childCapacity,
    owner.snapshot().children.used, owner.childGovernor.limits]) {
    assert.throws(() => { target.agent = 99; }, TypeError);
  }
  owner.close(); empty(g);
});

test('actual campaign nested-runner consumes an envelope pool across a blocked global waiter', async () => {
  const g = create(v(1, 2), { maximumConflictingBypasses: 0 }); const owner = await g.acquireEnvelope(definition());
  const localGovernor = create(v(1)); const controller = new AbortController();
  const observations = []; let operations = 0; let largerEntered = false;
  const larger = g.acquire(v(1, 2)).then((release) => { largerEntered = true; return release; });
  const campaign = { status: 'running', agentCallCount: 0, tokenCount: 0,
    spec: { budgets: { maxAgentCalls: 100, maxTokenCount: 10000 } } };
  // In-memory campaign port only; operations are local callbacks, never provider acceptance.
  const runNested = createCampaignNestedAgentRunner({
    campaignId: 'envelope-control', node: { nodeId: 'parent', attemptId: 'attempt', leaseGeneration: 1 },
    workerId: 'local', controller, governor: owner.childGovernor, localGovernor,
    campaignStore: {
      getCampaign: () => campaign,
      reserveNodeInfrastructureUsage: (value) => { campaign.agentCallCount += 1; observations.push(value); },
      recordUsage: (value) => observations.push(value),
    }, externalActionStarted: () => false,
  });
  for (let i = 0; i < 40; i += 1) {
    await runNested(async () => {
      operations += 1; assert.equal(largerEntered, false);
      assert.deepEqual(g.snapshot().used, v(1, 2));
      const receipt = { version: 1, kind: 'AgentExecutionReceipt', executorId: 'local-envelope-control',
        status: 'agent_execution_completed', externalModelInvocationPerformed: false };
      return { ...receipt, agentExecutionReceiptHash: hashRecord('AgentExecutionReceipt', receipt) };
    });
  }
  assert.equal(operations, 40); assert.equal(campaign.agentCallCount, 40); assert.equal(observations.length, 80);
  empty(localGovernor); assert.equal(owner.snapshot().activeChildren, 0);
  owner.close(); (await larger)(); empty(g);
});

test('actual nested-runner failure releases child charge while root awaits owner reconciliation', async () => {
  const g = create(); const owner = await g.acquireEnvelope(definition()); const localGovernor = create(v(1));
  const runNested = createCampaignNestedAgentRunner({
    campaignId: 'failure-control', node: { nodeId: 'parent' }, workerId: 'local',
    controller: new AbortController(), governor: owner.childGovernor, localGovernor,
    campaignStore: { getCampaign: () => ({ status: 'running', agentCallCount: 0, tokenCount: 0 }),
      reserveNodeInfrastructureUsage() {}, recordUsage() {} }, externalActionStarted: () => false,
  });
  await assert.rejects(runNested(async () => { throw new Error('local-operation-failed'); }), /local-operation-failed/);
  assert.equal(owner.snapshot().activeChildren, 0); empty(localGovernor);
  assert.deepEqual(g.snapshot().used, v(1, 2)); owner.close(); empty(g);
});

test('deterministic mixed scope traces agree with an independent handle ledger', async () => {
  async function trace(seed) {
    const g = create(v(6, 12)); const owners = [];
    for (let i = 0; i < 3; i += 1) owners.push(await g.acquireEnvelope(definition({ memoryMiB: 4 }, { agent: 2 }), { maximumChildren: 16 }));
    const active = new Map(); const pending = new Map(); const events = [];
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
    for (let id = 0; id < 500; id += 1) {
      const choice = random() % 5;
      if (choice === 0 && active.size) {
        const [key, record] = active.entries().next().value; active.delete(key); record.release(); record.release(); events.push(['release', key]);
      } else if (choice === 1 && pending.size) {
        const [key, record] = pending.entries().next().value; record.controller.abort(); events.push(['cancel', key]);
      } else {
        const index = random() % 3; const amount = random() % 3; const controller = new AbortController();
        const promise = owners[index].childGovernor.acquire({ agent: amount }, { signal: controller.signal }).then((release) => {
          pending.delete(id); active.set(id, { index, amount, release }); events.push(['grant', id]);
        }, (error) => { pending.delete(id); assert.ok(['resource_acquire_aborted', 'resource_envelope_child_limit',
          'resource_envelope_handoff_cancelled'].includes(error.code), error.code); events.push(['reject', id]); });
        pending.set(id, { controller, promise });
      }
      await tick(); await tick();
      assert.deepEqual(g.snapshot().used, v(6, 12));
      for (let index = 0; index < 3; index += 1) {
        const held = [...active.values()].filter((record) => record.index === index);
        assert.equal(owners[index].snapshot().activeChildren, held.length);
        assert.equal(owners[index].snapshot().children.used.agent, held.reduce((sum, record) => sum + record.amount, 0));
        assert.ok(owners[index].snapshot().activeChildren + owners[index].snapshot().pendingChildren <= 16);
      }
    }
    const promises = [...pending.values()].map((record) => record.promise);
    owners.forEach((owner) => owner.close()); await Promise.all(promises);
    for (const record of active.values()) { record.release(); record.release(); }
    empty(g); for (const owner of owners) assert.equal(owner.snapshot().phase, 'released'); return events;
  }
  assert.deepEqual(await trace(12993), await trace(12993));
});


test('failed owner subscription after the root grant cannot leak the reservation', async () => {
  const g = create(); const controller = new AbortController();
  const original = controller.signal.addEventListener; let registrations = 0;
  controller.signal.addEventListener = function (...args) {
    registrations += 1;
    if (registrations === 2) throw new Error('local-owner-subscription-failure');
    return original.apply(this, args);
  };
  await assert.rejects(g.acquireEnvelope(definition(), { signal: controller.signal }),
    code('resource_envelope_subscription_failed'));
  assert.equal(registrations, 2); empty(g);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});
