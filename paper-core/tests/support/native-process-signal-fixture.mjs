import assert from 'node:assert/strict';
const IDENTITY = ['pid', 'group', 'session', 'start', 'uid'];
const TERMINAL = new Set(['Z', 'X']);
function sameIdentity(expected, actual) {
  for (const name of IDENTITY) assert.equal(actual[name], expected[name], `native signal identity ${name}`);
}
export function recordRequestedNativeTermination(pin, signal, delivered) {
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
  assertRequestedParentTerminal(pin, termination, parentNow);
}
function assertRequestedParentTerminal(pin, termination, parentNow) {
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

// A no-op signal result is not a successful request. It can be accepted only
// through fresh terminal evidence, under the same deadline and ownership checks.
export function assertNativeTargetTerminal(pin, current, currentUid, parentTermination, parentNow, deadline, now = Date.now) {
  try {
    const clock = () => {
      const value = now(); assert.ok(Number.isSafeInteger(deadline) && Number.isSafeInteger(value));
      assert.ok(value < deadline, 'original native lifecycle deadline exhausted');
    };
    clock();
    assert.equal(pin.uid, currentUid);
    assert.notEqual(current, undefined, 'native termination observation must be explicit');
    assertRequestedParentTerminal(pin, parentTermination, parentNow);
    if (current !== null) assertNativeSignalTargetOwned(pin, current, currentUid, parentTermination, parentNow);
    assert.ok(current === null || TERMINAL.has(current.state), 'unsuccessful signal requires a freshly proven terminal target');
    clock();
  } catch (error) {
    if (error instanceof Error) error.message = `${error.message.split('\n', 1)[0].slice(0, 256)}: ${nativeTerminationDiagnostic({ requested: false, pin }, current, parentNow, deadline)}`;
    throw error;
  }
}

// Keep failure evidence to bounded process metadata, never environment or payload.
export function nativeTerminationDiagnostic(termination, current, parentNow, deadline) {
  const metadata = value => value == null ? value ?? null : Object.fromEntries(
    ['pid', 'state', 'parent', 'group', 'session', 'start', 'uid'].map(name => [name, String(value[name]).slice(0, 64)]),
  );
  return JSON.stringify({ requested: termination?.requested === true, signal: String(termination?.signal).slice(0, 16),
    target: metadata(termination?.pin), current: metadata(current), parent: metadata(parentNow),
    deadline: String(deadline).slice(0, 32) });
}
// Reuse the caller's already-established absolute lifecycle deadline. A signal
// request is not terminal evidence; never wait for the combined pipe/group close.
export async function waitForRequestedNativeTermination(termination, deadline, {
  readPin, now = Date.now, pause = ms => new Promise(resolve => setTimeout(resolve, ms)),
  parentTermination = null, currentUid = termination?.pin?.uid,
}) {
  let current, parentNow;
  try {
    assert.equal(termination?.requested, true);
    assert.ok(['SIGTERM', 'SIGKILL'].includes(termination.signal));
    assert.ok(Number.isSafeInteger(deadline));
    if (parentTermination !== null) {
      assert.equal(termination.signal, 'SIGKILL', 'only the fixture child SIGKILL has a termination wait');
      assert.equal(parentTermination.requested, true);
      assert.ok(['SIGTERM', 'SIGKILL'].includes(parentTermination.signal));
      assert.equal(parentTermination.pin.pid, termination.pin.parent);
      assert.equal(parentTermination.pin.uid, termination.pin.uid);
    }
    const clock = () => {
      const value = now(); assert.ok(Number.isSafeInteger(value));
      assert.ok(value < deadline, 'original native lifecycle deadline exhausted');
      return value;
    };
    for (;;) {
      clock();
      current = readPin(termination.pin.pid);
      assert.notEqual(current, undefined, 'native termination observation must be explicit');
      if (current !== null) {
        if (parentTermination !== null) {
          parentNow = readPin(parentTermination.pin.pid);
          assertRequestedParentTerminal(termination.pin, parentTermination, parentNow);
          assertNativeSignalTargetOwned(termination.pin, current, currentUid, parentTermination, parentNow);
        } else {
          sameIdentity(termination.pin, current);
          assert.equal(current.parent, termination.pin.parent);
        }
      }
      clock();
      if (current === null || TERMINAL.has(current.state)) return current;
      const before = clock();
      await pause(Math.min(5, deadline - before));
      assert.ok(now() > before, 'native lifecycle clock did not advance');
    }
  } catch (error) {
    if (error instanceof Error) error.message = `${error.message.split('\n', 1)[0].slice(0, 256)}: ${nativeTerminationDiagnostic(termination, current, parentNow, deadline)}`;
    throw error;
  }
}
