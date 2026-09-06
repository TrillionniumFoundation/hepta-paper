import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SNAPSHOT_BUILDER_INPUT_BOUNDARY,
  verifyPlanningStateSnapshotCurrentV1,
  hash,
  moduleMetadata,
  request,
  component,
  build,
  currentContext,
} from './planning-snapshot-fixtures.mjs';

test('snapshot expiry cannot be renewed by a valid outer hash', () => {
  const snapshot = build();
  assert.equal(snapshot.expiresAt, '2026-09-06T00:35:00.000Z');
  assert.throws(() => verifyPlanningStateSnapshotCurrentV1({
    inputBoundary: SNAPSHOT_BUILDER_INPUT_BOUNDARY,
    snapshot, observedAt: '2026-09-06T00:35:00.001Z',
    currentContext: currentContext(snapshot),
  }), { code: 'snapshot_not_current' });
});

test('request policy price objective and transaction changes alter snapshot identity', () => {
  const baseline = build();
  for (const override of [
    { policySetHash: hash('1') },
    { resourcePriceSnapshotHash: hash('2') },
    { objectiveVersion: 'objective-v2' },
    { readTransactionHash: hash('3') },
    { consistencyEpoch: 8 },
  ]) {
    const metadata = [moduleMetadata()];
    const changedRequest = request(metadata, override);
    const changedComponents = [component('campaign', override.readTransactionHash
      ? { readTransactionHash: override.readTransactionHash }
      : override.consistencyEpoch ? { consistencyEpoch: override.consistencyEpoch } : {}),
    component('resources', override.readTransactionHash
      ? { readTransactionHash: override.readTransactionHash }
      : override.consistencyEpoch ? { consistencyEpoch: override.consistencyEpoch } : {})];
    const changed = build({ moduleQualificationMetadata: metadata,
      request: changedRequest, components: changedComponents });
    assert.notEqual(changed.stateSnapshotHash, baseline.stateSnapshotHash);
  }
});

test('caller mutation after return cannot alter captured snapshot bytes', () => {
  const rawPayload = { nested: { value: 1 } };
  const first = component('campaign', { payload: rawPayload });
  const snapshot = build({ components: [first, component('resources')] });
  const before = snapshot.stateSnapshotHash;
  rawPayload.nested.value = 99;
  assert.equal(snapshot.components[0].payload.nested.value, 1);
  assert.equal(snapshot.stateSnapshotHash, before);
  assert.throws(() => { snapshot.components[0].payload.nested.value = 3; }, TypeError);
});

test('authority and currentness claims remain explicitly non-authorizing', () => {
  const snapshot = build();
  assert.equal(snapshot.qualificationTrustClass, 'caller_supplied_unverified');
  assert.equal(snapshot.externalCurrentnessGateRequired, true);
  assert.equal(snapshot.consumerMustRevalidateBeforePlanning, true);
  assert.ok(Object.values(snapshot.authority).every((entry) => entry === false));
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.components), true);
});
