import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CANDIDATE_ROUTER_INPUT_BOUNDARY,
  capturePlanningModuleQualificationMetadataSetV1,
  routeActionCandidatesV1,
  sealActionCandidateV1,
  SNAPSHOT_BUILDER_INPUT_BOUNDARY,
  buildPlanningStateSnapshotV1,
  sealPlanningSnapshotComponentV1,
  verifyPlanningStateSnapshotCurrentV1,
  hash,
  observedAt,
  moduleMetadata,
  requirement,
  request,
  component,
  build,
  currentContext,
  resealComponent,
} from './planning-snapshot-fixtures.mjs';

test('__proto__ remains an own hash-visible key while lone surrogates are rejected', () => {
  const value = Object.create(null);
  Object.defineProperty(value, '__proto__', { value: { safe: true }, enumerable: true });
  Object.defineProperty(value, 'constructor', { value: 1, enumerable: true });
  const special = component('campaign', { payload: value });
  const snapshot = build({ components: [special, component('resources')] });
  assert.equal(Object.getPrototypeOf(snapshot.components[0].payload), null);
  assert.equal(snapshot.components[0].payload.__proto__.safe, true);
  assert.equal(Object.getPrototypeOf(snapshot.components[0].payload.__proto__), null);

  const bad = Object.create(null);
  Object.defineProperty(bad, '\uD800', { value: 1, enumerable: true });
  assert.throws(() => component('campaign', { payload: bad }),
    /snapshot_value_(record|key)_invalid/u);
  assert.throws(() => component('campaign', { payload: { value: '\uDC00' } }),
    { code: 'snapshot_value_string_invalid' });
});

test('accessors are rejected without execution and revoked proxies fail typed', () => {
  let calls = 0;
  const payload = Object.defineProperty({}, 'secret', {
    enumerable: true, get() { calls += 1; return 1; },
  });
  assert.throws(() => component('campaign', { payload }),
    { code: 'snapshot_value_record_invalid' });
  assert.equal(calls, 0);
  const { proxy, revoke } = Proxy.revocable({}, {}); revoke();
  assert.throws(() => buildPlanningStateSnapshotV1(proxy),
    { code: 'snapshot_builder_input_invalid' });
});

test('currentness receipt independently rechecks context metadata and generations', () => {
  const snapshot = build();
  const receipt = verifyPlanningStateSnapshotCurrentV1({
    inputBoundary: SNAPSHOT_BUILDER_INPUT_BOUNDARY,
    snapshot,
    observedAt: '2026-09-06T00:20:00Z',
    currentContext: currentContext(snapshot),
  });
  assert.equal(receipt.stateSnapshotHash, snapshot.stateSnapshotHash);
  assert.equal(receipt.status, 'planning_state_snapshot_current_against_supplied_context');
  assert.equal(receipt.externalCurrentnessGateRequired, true);
  assert.ok(Object.values(receipt.authority).every((entry) => entry === false));
  assert.equal(Object.isFrozen(receipt), true);
});

test('context generation and qualification drift invalidate currentness', () => {
  const snapshot = build();
  for (const current of [
    currentContext(snapshot, { moduleRegistryHash: hash('0') }),
    currentContext(snapshot, { componentVersions: snapshot.components.map((entry, index) => ({
      componentId: entry.componentId, sourceModuleId: entry.sourceModuleId,
      sourceModuleVersion: entry.sourceModuleVersion, revision: entry.revision,
      sourceGeneration: entry.sourceGeneration + (index === 0 ? 1 : 0),
    })) }),
    currentContext(snapshot, { moduleQualificationMetadata: [moduleMetadata({
      qualificationGeneration: 5,
    })] }),
  ]) {
    assert.throws(() => verifyPlanningStateSnapshotCurrentV1({
      inputBoundary: SNAPSHOT_BUILDER_INPUT_BOUNDARY,
      snapshot, observedAt: '2026-09-06T00:20:00Z', currentContext: current,
    }));
  }
});
