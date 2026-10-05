import assert from 'node:assert/strict';
import test from 'node:test';
import { assertNativeSignalTargetOwned, recordRequestedParentTermination } from './support/native-process-signal-fixture.mjs';
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
