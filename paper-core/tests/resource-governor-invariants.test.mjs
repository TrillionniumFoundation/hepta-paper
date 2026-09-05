import assert from 'node:assert/strict';
import test from 'node:test';
import { getEventListeners } from 'node:events';
import { createResourceGovernor, resourcesForCampaignNode } from '../../paper-application/automation/resource-governor.mjs';

const tick = () => Promise.resolve();
const vector = (cpu = 0, gpu = 0) => ({ agent: 0, cpu, gpu, memoryMiB: 0 });

function empty(governor) {
  assert.deepEqual(governor.snapshot().used, vector());
  assert.equal(governor.snapshot().waiting, 0);
}

test('release is idempotent and cannot refund newer reservations', async () => {
  const governor = createResourceGovernor({ cpu: 1 });
  const first = await governor.acquire({ cpu: 1 });
  let secondEntered = false;
  const second = governor.acquire({ cpu: 1 }).then((release) => { secondEntered = true; return release; });
  await tick(); assert.equal(secondEntered, false);
  first(); first(); first();
  const releaseSecond = await second;
  assert.equal(governor.snapshot().used.cpu, 1);
  let thirdEntered = false;
  const third = governor.acquire({ cpu: 1 }).then((release) => { thirdEntered = true; return release; });
  first(); await tick(); assert.equal(thirdEntered, false);
  assert.equal(governor.snapshot().used.cpu, 1);
  releaseSecond(); (await third)(); releaseSecond();
  empty(governor); assert.equal(governor.snapshot().peak.cpu, 1);
});

test('strict resource vectors reject malformed values before allocation or queueing', () => {
  const governor = createResourceGovernor();
  const before = governor.snapshot();
  for (const value of [NaN, Infinity, -Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1,
    '1', '', null, undefined, false, true, [], {}, 1n]) {
    for (const key of ['agent', 'cpu', 'gpu', 'memoryMiB']) {
      assert.throws(() => governor.acquire({ [key]: value }), /resource_value_invalid/);
      assert.throws(() => createResourceGovernor({ [key]: value }), /resource_value_invalid/);
    }
  }
  for (const request of [null, [], 'x', new Date(), { storage: 1 }, { [Symbol('cpu')]: 1 },
    Object.create({ cpu: 1 })]) {
    assert.throws(() => governor.acquire(request), /resource_vector_invalid/);
    assert.throws(() => createResourceGovernor(request), /resource_vector_invalid/);
  }
  let getterCalls = 0;
  const getter = Object.defineProperty({}, 'cpu', { enumerable: true, get() { getterCalls += 1; return 1; } });
  assert.throws(() => governor.acquire(getter), /resource_vector_invalid/);
  assert.throws(() => createResourceGovernor(getter), /resource_vector_invalid/);
  assert.equal(getterCalls, 0);
  assert.deepEqual(governor.snapshot(), before);
});

test('omitted dimensions, zero capacity and null-prototype records remain explicit', async () => {
  const governor = createResourceGovernor({ cpu: 0 });
  assert.equal(governor.limits.agent, 4);
  assert.throws(() => governor.acquire({ cpu: 1 }), /resource_request_exceeds_limit:cpu/);
  const request = Object.assign(Object.create(null), { gpu: 1, cpu: -0 });
  const release = await governor.acquire(request);
  assert.equal(Object.is(governor.snapshot().used.cpu, -0), false);
  release(); (await governor.acquire())(); empty(governor);
});

test('safe-integer maximum admission never overflows or partially admits a vector', async () => {
  const governor = createResourceGovernor({ cpu: Number.MAX_SAFE_INTEGER, gpu: 1 });
  const release = await governor.acquire({ cpu: Number.MAX_SAFE_INTEGER, gpu: 1 });
  const controller = new AbortController();
  const pending = governor.acquire({ cpu: 1, gpu: 1 }, { signal: controller.signal });
  const rejected = assert.rejects(pending, { code: 'resource_acquire_aborted' });
  assert.equal(governor.snapshot().used.cpu, Number.MAX_SAFE_INTEGER);
  assert.equal(governor.snapshot().used.gpu, 1);
  controller.abort(); await rejected; release(); release(); empty(governor);
});

test('requests and limits are captured; snapshots and policy cannot mutate accounting', async () => {
  const limits = { cpu: 1 }; const policy = { maximumWaitingRequests: 2 };
  const governor = createResourceGovernor(limits, policy);
  limits.cpu = 99; policy.maximumWaitingRequests = 99;
  const request = { cpu: 1 }; const release = await governor.acquire(request); request.cpu = 99;
  assert.equal(governor.admissionPolicy.maximumWaitingRequests, 2);
  assert.throws(() => { governor.snapshot().used.cpu = -1; }, TypeError);
  assert.throws(() => { governor.limits.cpu = 99; }, TypeError);
  assert.throws(() => { governor.admissionPolicy.maximumWaitingRequests = 99; }, TypeError);
  release(); empty(governor);
});

test('bounded wait queue rejects saturation without attaching extra abort listeners', async () => {
  const governor = createResourceGovernor({ cpu: 1 }, { maximumWaitingRequests: 2 });
  const release = await governor.acquire({ cpu: 1 });
  const controllers = [new AbortController(), new AbortController()];
  const pending = controllers.map((controller) => governor.acquire({ cpu: 1 }, { signal: controller.signal }));
  const rejected = pending.map((promise) => assert.rejects(promise, { code: 'resource_acquire_aborted' }));
  const extra = new AbortController();
  await assert.rejects(governor.acquire({ cpu: 1 }, { signal: extra.signal }), { code: 'resource_wait_queue_full' });
  assert.equal(governor.snapshot().waiting, 2);
  assert.equal(getEventListeners(extra.signal, 'abort').length, 0);
  controllers.forEach((controller) => controller.abort());
  await Promise.all(rejected);
  for (const controller of controllers) assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  release(); empty(governor);
});

test('invalid policy and abort signal fail before queue changes', () => {
  for (const policy of [null, [], { typo: 1 }, { maximumWaitingRequests: 0 },
    { maximumWaitingRequests: 4097 }, { maximumWaitingRequests: '2' },
    { maximumConflictingBypasses: -1 }, { maximumConflictingBypasses: NaN },
    { maximumConflictingBypasses: 1025 }]) {
    assert.throws(() => createResourceGovernor({}, policy), /resource_admission_policy_invalid/);
  }
  const governor = createResourceGovernor();
  for (const signal of [{}, 0, false, Object.create(AbortSignal.prototype)]) {
    assert.throws(() => governor.acquire({ cpu: 1 }, { signal }), /resource_abort_signal_invalid/);
    empty(governor);
  }
});

test('abort before acquisition is rejected and abort after grant retains the charge', async () => {
  const governor = createResourceGovernor({ cpu: 1 });
  const pre = new AbortController(); pre.abort('pre');
  await assert.rejects(governor.acquire({ cpu: 1 }, { signal: pre.signal }), { code: 'resource_acquire_aborted' });
  const active = new AbortController(); const release = await governor.acquire({ cpu: 1 }, { signal: active.signal });
  assert.equal(getEventListeners(active.signal, 'abort').length, 0);
  active.abort('post'); assert.equal(governor.snapshot().used.cpu, 1);
  release(); empty(governor);
});

test('a large request is overtaken by at most the configured number of conflicting newcomers', async () => {
  const governor = createResourceGovernor({ cpu: 2, gpu: 1 }, { maximumConflictingBypasses: 2 });
  const held = await governor.acquire({ cpu: 1 });
  let largeEntered = false;
  const large = governor.acquire({ cpu: 2 }).then((release) => { largeEntered = true; return release; });
  for (let index = 0; index < 2; index += 1) (await governor.acquire({ cpu: 1 }))();
  let smallEntered = false;
  const small = governor.acquire({ cpu: 1 }).then((release) => { smallEntered = true; return release; });
  await tick(); assert.equal(smallEntered, false); assert.equal(largeEntered, false);
  (await governor.acquire({ gpu: 1 }))(); // Disjoint GPU work need not stall.
  held(); const releaseLarge = await large;
  assert.equal(smallEntered, false); assert.equal(governor.snapshot().used.cpu, 2);
  releaseLarge(); (await small)(); empty(governor);
});

test('removing an aborted fairness barrier immediately drains newly eligible work', async () => {
  const governor = createResourceGovernor({ cpu: 2 }, { maximumConflictingBypasses: 0 });
  const held = await governor.acquire({ cpu: 1 });
  const controller = new AbortController();
  const large = governor.acquire({ cpu: 2 }, { signal: controller.signal });
  const rejected = assert.rejects(large, { code: 'resource_acquire_aborted' });
  let entered = false;
  const small = governor.acquire({ cpu: 1 }).then((release) => { entered = true; return release; });
  await tick(); assert.equal(entered, false);
  controller.abort(); await rejected;
  const releaseSmall = await small; assert.equal(entered, true);
  assert.equal(governor.snapshot().used.cpu, 2);
  held(); releaseSmall(); empty(governor);
});

test('mixed resource ordering has bounded overtaking and preserves full-vector admission', async () => {
  const governor = createResourceGovernor({ cpu: 2, gpu: 1 }, { maximumConflictingBypasses: 1 });
  const held = await governor.acquire({ gpu: 1 });
  const order = [];
  const first = governor.acquire({ cpu: 2, gpu: 1 }).then((release) => { order.push('first'); return release; });
  (await governor.acquire({ cpu: 1 }))();
  const second = governor.acquire({ cpu: 1 }).then((release) => { order.push('second'); return release; });
  await tick(); assert.deepEqual(order, []);
  assert.deepEqual(governor.snapshot().used, vector(0, 1));
  held(); const release = await first; assert.deepEqual(order, ['first']);
  release(); (await second)(); assert.deepEqual(order, ['first', 'second']); empty(governor);
});

test('deterministic mixed acquire/cancel/duplicate-release workload never creates capacity', async () => {
  async function exercise() {
    const governor = createResourceGovernor({ cpu: 3, gpu: 2 }, { maximumWaitingRequests: 32, maximumConflictingBypasses: 3 });
    const active = new Map(); const pending = new Map(); const trace = []; let seed = 7123;
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
    const assertAccounting = () => {
      const actual = vector();
      for (const record of active.values()) { actual.cpu += record.request.cpu; actual.gpu += record.request.gpu; }
      assert.deepEqual(governor.snapshot().used, actual);
      assert.ok(actual.cpu >= 0 && actual.cpu <= 3 && actual.gpu >= 0 && actual.gpu <= 2);
      assert.ok(governor.snapshot().waiting <= 32);
    };
    for (let id = 0; id < 500; id += 1) {
      if ((random() % 3) === 0 && active.size) {
        const [key, record] = active.entries().next().value; active.delete(key); record.release(); record.release(); trace.push(['release', key]);
      } else if ((random() % 5) === 0 && pending.size) {
        const [key, record] = pending.entries().next().value; record.controller.abort(); trace.push(['cancel', key]);
      } else {
        const request = { cpu: random() % 4, gpu: random() % 3 }; const controller = new AbortController();
        const promise = governor.acquire(request, { signal: controller.signal }).then((release) => {
          pending.delete(id); active.set(id, { request, release }); trace.push(['admit', id]);
        }, (error) => {
          pending.delete(id); assert.ok(['resource_acquire_aborted', 'resource_wait_queue_full'].includes(error.code)); trace.push(['reject', id]);
        });
        pending.set(id, { controller, promise });
      }
      await tick(); assertAccounting();
    }
    for (const record of [...pending.values()]) record.controller.abort();
    await tick();
    for (const record of active.values()) { record.release(); record.release(); }
    active.clear(); await tick(); empty(governor);
    return trace;
  }
  assert.deepEqual(await exercise(), await exercise());
});

test('empirical resource conversion rejects invalid byte declarations instead of coercing them', () => {
  const node = { kind: 'formal-verify' };
  for (const workerMemoryBytes of [NaN, Infinity, -1, 0, null, '1048576', false, 1.5]) {
    assert.throws(() => resourcesForCampaignNode({ spec: { workerMemoryBytes } }, node),
      /resource_worker_memory_bytes_invalid/);
  }
  assert.equal(resourcesForCampaignNode({ spec: { workerMemoryBytes: 1048577 } }, node).memoryMiB, 2);
  assert.equal(resourcesForCampaignNode({}, node).memoryMiB, 4096);
});

test('default first-fit permits a held parent to finish more than 32 nested agent calls', async () => {
  const governor = createResourceGovernor({ agent: 1, memoryMiB: 1 });
  assert.equal(governor.admissionPolicy.maximumConflictingBypasses, null);
  const parent = await governor.acquire({ memoryMiB: 1 });
  let entered = false;
  const waiting = governor.acquire({ agent: 1, memoryMiB: 1 }).then((release) => { entered = true; return release; });
  for (let index = 0; index < 40; index += 1) (await governor.acquire({ agent: 1 }))();
  assert.equal(entered, false);
  parent(); (await waiting)(); empty(governor);
});
