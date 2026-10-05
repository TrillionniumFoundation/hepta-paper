import assert from 'node:assert/strict';
import test from 'node:test';
import { assertNativeSignalTargetOwned, recordRequestedNativeTermination, waitForRequestedNativeTermination, nativeTerminationDiagnostic, assertNativeTargetTerminal } from './support/native-process-signal-fixture.mjs';
const parent = { pid: 40, parent: 30, group: 40, session: 40, start: '100', uid: 1000, state: 'S' };
const child = { pid: 41, parent: 40, group: 41, session: 40, start: '101', uid: 1000, state: 'S' };
const orphan = { ...child, parent: 1 };
const requested = recordRequestedNativeTermination(parent, 'SIGKILL', true);
test('ordinary same-parent signals retain every original identity field', () => {
  assert.doesNotThrow(() => assertNativeSignalTargetOwned(child, child, 1000));
  assert.throws(() => assertNativeSignalTargetOwned(child, orphan, 1000));
});
test('recording termination requires an actual successful request, not an intent', () => {
  assert.throws(() => recordRequestedNativeTermination(parent, 'SIGKILL', false));
  assert.throws(() => recordRequestedNativeTermination(parent, 'SIGCONT', true));
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
  const wrongParent = recordRequestedNativeTermination({ ...parent, pid: 50 }, 'SIGKILL', true);
  assert.throws(() => assertNativeSignalTargetOwned(child, orphan, 1000, wrongParent, null));
});

test('requested parent transition waits under the original deadline, then proves identity again', async () => {
  let time = 0, reads = 0; const pauses = [];
  const states = [{ ...parent, state: 'R' }, { ...parent, state: 'S' }, { ...parent, state: 'Z' }];
  const observed = await waitForRequestedNativeTermination(requested, 15, {
    readPin: pid => { assert.equal(pid, parent.pid); return states[reads++]; },
    now: () => time, pause: async ms => { pauses.push(ms); time += ms; },
  });
  assert.equal(observed.state, 'Z'); assert.equal(time, 10); assert.deepEqual(pauses, [5, 5]);
  assert.doesNotThrow(() => assertNativeSignalTargetOwned(child, orphan, 1000, requested, observed));
});
test('vanished parent is explicit terminal evidence without a delay or a new deadline', async () => {
  let pauses = 0;
  const observed = await waitForRequestedNativeTermination(requested, 10, { readPin: () => null, now: () => 9, pause: async () => { pauses += 1; } });
  assert.equal(observed, null); assert.equal(pauses, 0);
});
test('live parent consumes only remaining original time and never becomes accepted by timeout', async () => {
  let time = 7, reads = 0; const pauses = [];
  await assert.rejects(waitForRequestedNativeTermination(requested, 10, {
    readPin: () => { reads += 1; return parent; }, now: () => time,
    pause: async ms => { pauses.push(ms); time += ms; },
  }), /deadline exhausted/);
  assert.equal(time, 10); assert.equal(reads, 1); assert.deepEqual(pauses, [3]);
});
test('PID, start, group, session, uid and ancestry changes refuse during the wait', async () => {
  for (const field of ['pid', 'group', 'session', 'start', 'uid', 'parent']) {
    const changed = { ...parent, state: 'Z', [field]: field === 'start' ? 'reused' : parent[field] + 1 };
    await assert.rejects(waitForRequestedNativeTermination(requested, 10, { readPin: () => changed, now: () => 0, pause: async () => assert.fail('no retry after identity drift') }));
  }
});
test('late terminal observation, missing request and stalled clock fail closed', async () => {
  let time = 0;
  await assert.rejects(waitForRequestedNativeTermination(requested, 10, { readPin: () => { time = 10; return null; }, now: () => time }), /deadline exhausted/);
  await assert.rejects(waitForRequestedNativeTermination(null, 10, { readPin: () => assert.fail('no read without request'), now: () => 0 }));
  await assert.rejects(waitForRequestedNativeTermination(requested, 10, { readPin: () => parent, now: () => 0, pause: async () => {} }), /clock did not advance/);
});

const childRequested = recordRequestedNativeTermination(child, 'SIGKILL', true);
function childReader(observations, parentNow = { ...parent, state: 'Z' }) {
  let index = 0;
  return pid => pid === parent.pid ? parentNow : observations[Math.min(index++, observations.length - 1)];
}
test('the original successful child SIGKILL waits for same-identity live to terminal with no new budget', async () => {
  let time = 4; const pauses = [];
  const observed = await waitForRequestedNativeTermination(childRequested, 15, {
    readPin: childReader([{ ...orphan, state: 'R' }, { ...orphan, state: 'S' }, { ...orphan, state: 'Z' }]),
    parentTermination: requested, currentUid: 1000, now: () => time,
    pause: async ms => { pauses.push(ms); time += ms; },
  });
  assert.equal(observed.state, 'Z'); assert.equal(time, 14); assert.deepEqual(pauses, [5, 5]);
});
test('a successfully signalled child may explicitly disappear before the original deadline', async () => {
  let time = 0;
  const observed = await waitForRequestedNativeTermination(childRequested, 10, {
    readPin: childReader([orphan, null], null), parentTermination: requested, currentUid: 1000,
    now: () => time, pause: async ms => { time += ms; },
  });
  assert.equal(observed, null); assert.equal(time, 5);
});
test('child PID, start, uid, group, session and unexplained parent drift refuse even terminal observations', async () => {
  for (const field of ['pid', 'start', 'uid', 'group', 'session', 'parent']) {
    const changed = { ...orphan, state: 'Z', [field]: field === 'start' ? 'reused' : orphan[field] + 1 };
    await assert.rejects(waitForRequestedNativeTermination(childRequested, 10, {
      readPin: childReader([changed]), parentTermination: requested, currentUid: 1000, now: () => 0,
      pause: async () => assert.fail('no retry after drift'),
    }));
  }
  await assert.rejects(waitForRequestedNativeTermination(childRequested, 10, {
    readPin: childReader([{ ...orphan, state: 'Z' }]), parentTermination: requested, currentUid: 1001, now: () => 0,
  }));
  for (const parentNow of [parent, { ...parent, state: 'Z', start: 'reused' }]) {
    for (const observed of [{ ...orphan, state: 'Z' }, { ...child, state: 'Z' }]) {
      await assert.rejects(waitForRequestedNativeTermination(childRequested, 10, {
        readPin: childReader([observed], parentNow), parentTermination: requested, currentUid: 1000, now: () => 0,
      }));
    }
  }
});
test('a live or late child never becomes accepted when the existing deadline expires', async () => {
  let time = 7; const pauses = [];
  await assert.rejects(waitForRequestedNativeTermination(childRequested, 10, {
    readPin: childReader([orphan]), parentTermination: requested, currentUid: 1000, now: () => time,
    pause: async ms => { pauses.push(ms); time += ms; },
  }), /deadline exhausted/);
  assert.equal(time, 10); assert.deepEqual(pauses, [3]);
  time = 0;
  await assert.rejects(waitForRequestedNativeTermination(childRequested, 10, {
    readPin: () => { time = 10; return null; }, parentTermination: requested, now: () => time,
  }), /deadline exhausted/);
});
test('failed child requests and child SIGTERM cannot start a terminal wait or inspect processes', async () => {
  assert.throws(() => recordRequestedNativeTermination(child, 'SIGKILL', false), /actually have been requested/);
  for (const record of [null, { ...childRequested, requested: false }, recordRequestedNativeTermination(child, 'SIGTERM', true)]) {
    await assert.rejects(waitForRequestedNativeTermination(record, 10, {
      readPin: () => assert.fail('no process read for an invalid wait'), parentTermination: requested, now: () => 0,
    }));
  }
});
test('failure diagnostics retain only bounded process metadata and the original deadline', async () => {
  const oversized = { ...orphan, start: 'x'.repeat(10000), env: { TOKEN: 'must-not-appear' }, payload: 'private-payload' };
  const diagnostic = nativeTerminationDiagnostic(childRequested, oversized, parent, 15);
  assert.ok(Buffer.byteLength(diagnostic) < 2048); assert.ok(!diagnostic.includes('must-not-appear')); assert.ok(!diagnostic.includes('private-payload'));
  assert.equal(JSON.parse(diagnostic).current.start.length, 64);
  assert.equal(JSON.parse(diagnostic).deadline, '15');
  await assert.rejects(waitForRequestedNativeTermination(childRequested, 15, {
    readPin: childReader([oversized]), parentTermination: requested, currentUid: 1000, now: () => 0,
  }), error => error.message.includes('native signal identity start') && error.message.includes('"requested":true') && error.message.length < 2048);
});

test('a signal no-op accepts only fresh same-identity terminal or gone evidence, without a request record', () => {
  for (const current of [null, { ...orphan, state: 'Z' }, { ...child, state: 'X' }]) {
    assert.doesNotThrow(() => assertNativeTargetTerminal(child, current, 1000, requested, { ...parent, state: 'Z' }, 10, () => 9));
  }
  for (const current of [undefined, child, orphan]) {
    assert.throws(() => assertNativeTargetTerminal(child, current, 1000, requested, null, 10, () => 9));
  }
});
test('terminal no-op evidence retains identity, parent, current uid and deadline refusals', () => {
  for (const field of ['pid', 'start', 'uid', 'group', 'session', 'parent']) {
    const changed = { ...orphan, state: 'Z', [field]: field === 'start' ? 'reused' : orphan[field] + 1 };
    assert.throws(() => assertNativeTargetTerminal(child, changed, 1000, requested, null, 10, () => 9));
  }
  for (const current of [null, { ...orphan, state: 'Z' }]) {
    assert.throws(() => assertNativeTargetTerminal(child, current, 1001, requested, null, 10, () => 9));
    assert.throws(() => assertNativeTargetTerminal(child, current, 1000, requested, parent, 10, () => 9));
    assert.throws(() => assertNativeTargetTerminal(child, current, 1000, requested, { ...parent, state: 'Z', start: 'reused' }, 10, () => 9));
    assert.throws(() => assertNativeTargetTerminal(child, current, 1000, requested, null, 10, () => 10));
    assert.throws(() => assertNativeTargetTerminal(child, current, 1000, null, null, 10, () => 9));
  }
});
