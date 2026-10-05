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

// Reuse the caller's already-established absolute lifecycle deadline. A signal
// request is not terminal evidence; never wait for the combined pipe/group close.
export async function waitForRequestedParentTermination(termination, deadline, {
  readPin, now = Date.now, pause = ms => new Promise(resolve => setTimeout(resolve, ms)),
}) {
  assert.equal(termination?.requested, true);
  assert.ok(['SIGTERM', 'SIGKILL'].includes(termination.signal));
  assert.ok(Number.isSafeInteger(deadline));
  const clock = () => {
    const value = now(); assert.ok(Number.isSafeInteger(value));
    assert.ok(value < deadline, 'original native parent lifecycle deadline exhausted');
    return value;
  };
  for (;;) {
    clock();
    const current = readPin(termination.pin.pid);
    assert.notEqual(current, undefined, 'parent observation must be explicit');
    if (current !== null) {
      sameIdentity(termination.pin, current);
      assert.equal(current.parent, termination.pin.parent);
    }
    clock();
    if (current === null || TERMINAL.has(current.state)) return current;
    const before = clock();
    await pause(Math.min(5, deadline - before));
    assert.ok(now() > before, 'native parent lifecycle clock did not advance');
  }
}
