import assert from 'node:assert/strict';
const IDENTITY = ['pid', 'group', 'session', 'start', 'uid'];
const TERMINAL = new Set(['Z', 'X']);
function sameIdentity(expected, actual) {
  for (const name of IDENTITY) assert.equal(actual[name], expected[name], `native signal identity ${name}`);
}
export function recordRequestedParentTermination(pin, signal, delivered) {
  assert.equal(delivered, true, 'termination must actually have been requested');
  assert.ok(['SIGTERM', 'SIGKILL'].includes(signal));
  return Object.freeze({ requested: true, signal, pin: Object.freeze({ ...pin }) });
}
// Pure ownership decision. The caller supplies fresh /proc observations before
// its existing signal call. No timeout or PPid=1 alone establishes ownership.
export function assertNativeSignalTargetOwned(pin, now, currentUid, termination = null, parentNow = undefined) {
  sameIdentity(pin, now); assert.equal(now.uid, currentUid);
  if (now.parent === pin.parent) return;
  assert.equal(now.parent, 1, 'only witnessed orphan reparenting is allowed');
  assert.equal(termination?.requested, true);
  assert.ok(['SIGTERM', 'SIGKILL'].includes(termination.signal));
  assert.equal(termination.pin.pid, pin.parent);
  assert.equal(termination.pin.uid, pin.uid);
  assert.notEqual(parentNow, undefined, 'parent must be freshly observed');
  if (parentNow !== null) {
    sameIdentity(termination.pin, parentNow);
    assert.equal(parentNow.parent, termination.pin.parent);
    assert.ok(TERMINAL.has(parentNow.state), 'original parent must be terminal');
  }
}
