import assert from 'node:assert/strict';
import test from 'node:test';
import { assertNativeSignalTargetOwned, recordRequestedParentTermination, waitForRequestedParentTermination } from './support/native-process-signal-fixture.mjs';
const parent = { pid: 40, parent: 30, group: 40, session: 40, start: '100', uid: 1000, state: 'S' };
const child = { pid: 41, parent: 40, group: 41, session: 40, start: '101', uid: 1000, state: 'S' };
const orphan = { ...child, parent: 1 };
const requested = recordRequestedParentTermination(parent, 'SIGKILL', true);
test('ordinary same-parent signals retain every original identity field', () => {
  assert.doesNotThrow(() => assertNativeSignalTargetOwned(child, child, 1000));
  assert.throws(() => assertNativeSignalTargetOwned(child, orphan, 1000));
});
test('recording termination requires an actual successful request, not an intent', () => {
  assert.throws(() => recordRequestedParentTermination(parent, 'SIGKILL', false));
  assert.throws(() => recordRequestedParentTermination(parent, 'SIGCONT', true));
});
test('orphan cleanup needs both the request and a fresh vanished or same-identity terminal parent', () => {
  for (const observation of [null, { ...parent, state: 'Z' }, { ...parent, state: 'X' }]) {
    assert.doesNotThrow(() => assertNativeSignalTargetOwned(child, orphan, 1000, requested, observation));
  }
  for (const observation of [undefined, parent, { ...parent, state: 'R' }, { ...parent, state: 'Z', start: 'reused' }]) {
    assert.throws(() => assertNativeSignalTargetOwned(child, orphan, 1000, requested, observation));
  }
  assert.throws(() => assertNativeSignalTargetOwned(child, orphan, 1000, null, null));
  assert.throws(() => assertNativeSignalTargetOwned(child, { ...orphan, parent: 2 }, 1000, requested, null));
});
test('PID, starttime, group, session and uid drift always refuse, including orphan cleanup', () => {
  for (const field of ['pid', 'group', 'session', 'start', 'uid']) {
    const changed = { ...orphan, [field]: field === 'start' ? 'reused' : child[field] + 1 };
    assert.throws(() => assertNativeSignalTargetOwned(child, changed, 1000, requested, null));
    assert.throws(() => assertNativeSignalTargetOwned(child, { ...changed, parent: child.parent }, 1000));
  }
  assert.throws(() => assertNativeSignalTargetOwned(child, orphan, 1001, requested, null));
});
test('parent reuse, ancestry drift, and unrequested adoption are never lifecycle proof', () => {
  for (const field of ['pid', 'group', 'session', 'start', 'uid', 'parent']) {
    const changed = { ...parent, state: 'Z', [field]: field === 'start' ? 'reused' : parent[field] + 1 };
    assert.throws(() => assertNativeSignalTargetOwned(child, orphan, 1000, requested, changed));
  }
  const wrongParent = recordRequestedParentTermination({ ...parent, pid: 50 }, 'SIGKILL', true);
  assert.throws(() => assertNativeSignalTargetOwned(child, orphan, 1000, wrongParent, null));
});

test('requested parent transition waits under the original deadline, then proves identity again', async () => {
  let time = 0, reads = 0; const pauses = [];
  const states = [{ ...parent, state: 'R' }, { ...parent, state: 'S' }, { ...parent, state: 'Z' }];
  const observed = await waitForRequestedParentTermination(requested, 15, {
    readPin: pid => { assert.equal(pid, parent.pid); return states[reads++]; },
    now: () => time, pause: async ms => { pauses.push(ms); time += ms; },
  });
  assert.equal(observed.state, 'Z'); assert.equal(time, 10); assert.deepEqual(pauses, [5, 5]);
  assert.doesNotThrow(() => assertNativeSignalTargetOwned(child, orphan, 1000, requested, observed));
});
test('vanished parent is explicit terminal evidence without a delay or a new deadline', async () => {
  let pauses = 0;
  const observed = await waitForRequestedParentTermination(requested, 10, { readPin: () => null, now: () => 9, pause: async () => { pauses += 1; } });
  assert.equal(observed, null); assert.equal(pauses, 0);
});
test('live parent consumes only remaining original time and never becomes accepted by timeout', async () => {
  let time = 7, reads = 0; const pauses = [];
  await assert.rejects(waitForRequestedParentTermination(requested, 10, {
    readPin: () => { reads += 1; return parent; }, now: () => time,
    pause: async ms => { pauses.push(ms); time += ms; },
  }), /deadline exhausted/);
  assert.equal(time, 10); assert.equal(reads, 1); assert.deepEqual(pauses, [3]);
});
test('PID, start, group, session, uid and ancestry changes refuse during the wait', async () => {
  for (const field of ['pid', 'group', 'session', 'start', 'uid', 'parent']) {
    const changed = { ...parent, state: 'Z', [field]: field === 'start' ? 'reused' : parent[field] + 1 };
    await assert.rejects(waitForRequestedParentTermination(requested, 10, { readPin: () => changed, now: () => 0, pause: async () => assert.fail('no retry after identity drift') }));
  }
});
test('late terminal observation, missing request and stalled clock fail closed', async () => {
  let time = 0;
  await assert.rejects(waitForRequestedParentTermination(requested, 10, { readPin: () => { time = 10; return null; }, now: () => time }), /deadline exhausted/);
  await assert.rejects(waitForRequestedParentTermination(null, 10, { readPin: () => assert.fail('no read without request'), now: () => 0 }));
  await assert.rejects(waitForRequestedParentTermination(requested, 10, { readPin: () => parent, now: () => 0, pause: async () => {} }), /clock did not advance/);
});
