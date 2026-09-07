import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SNAPSHOT_BUILDER_INPUT_BOUNDARY,
  verifyPlanningStateSnapshotCurrentV1,
  hash,
  moduleMetadata,
  requirement,
  request,
  component,
  build,
  currentContext,
} from './planning-snapshot-fixtures.mjs';

test('snapshot expiry cannot be renewed by a valid outer hash', () => {
  const snapshot = build();
  assert.equal(snapshot.expiresAt, '2026-09-06T00:20:00.000Z');
  assert.throws(() => verifyPlanningStateSnapshotCurrentV1({
    inputBoundary: SNAPSHOT_BUILDER_INPUT_BOUNDARY,
    snapshot, observedAt: '2026-09-06T00:20:00.001Z',
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


test('component maximum age bounds snapshot currentness after construction', () => {
  const metadata = [moduleMetadata()];
  const snapshot = build({
    moduleQualificationMetadata: metadata,
    request: request(metadata, {
      deadline: '2026-09-06T00:45:00Z',
      requiredComponents: [
        requirement('campaign', { maximumAgeMilliseconds: 1_000 }),
        requirement('resources', { maximumAgeMilliseconds: 60_000 }),
      ],
    }),
    components: [
      component('campaign', {
        observedAt: '2026-09-06T00:10:00Z',
        validUntil: '2026-09-06T00:35:00Z',
      }),
      component('resources', {
        observedAt: '2026-09-06T00:10:00Z',
        validUntil: '2026-09-06T00:35:00Z',
      }),
    ],
    observedAt: '2026-09-06T00:10:00.500Z',
  });

  assert.equal(snapshot.expiresAt, '2026-09-06T00:10:01.000Z');
  assert.doesNotThrow(() => verifyPlanningStateSnapshotCurrentV1({
    inputBoundary: SNAPSHOT_BUILDER_INPUT_BOUNDARY,
    snapshot,
    observedAt: '2026-09-06T00:10:00.999Z',
    currentContext: currentContext(snapshot),
  }));
  assert.throws(() => verifyPlanningStateSnapshotCurrentV1({
    inputBoundary: SNAPSHOT_BUILDER_INPUT_BOUNDARY,
    snapshot,
    observedAt: '2026-09-06T00:10:01.001Z',
    currentContext: currentContext(snapshot),
  }), { code: 'snapshot_not_current' });
});

test('maximum-age expiry arithmetic is range-safe near the Date ceiling', () => {
  const metadata = [moduleMetadata({
    qualificationObservedAt: '9999-12-31T23:58:00Z',
    qualificationExpiresAt: '9999-12-31T23:59:59Z',
  })];
  const nearCeiling = '9999-12-31T23:59:00Z';
  const deadline = '9999-12-31T23:59:59Z';
  const snapshot = build({
    moduleQualificationMetadata: metadata,
    request: request(metadata, {
      issuedAt: '9999-12-31T23:58:00Z',
      deadline,
      requiredComponents: [
        requirement('campaign', { maximumAgeMilliseconds: Number.MAX_SAFE_INTEGER }),
        requirement('resources', { maximumAgeMilliseconds: Number.MAX_SAFE_INTEGER }),
      ],
    }),
    components: [
      component('campaign', {
        observedAt: nearCeiling, validUntil: deadline,
        sourceQualificationMetadataHash: metadata[0].qualificationMetadataHash,
      }),
      component('resources', {
        observedAt: nearCeiling, validUntil: deadline,
        sourceQualificationMetadataHash: metadata[0].qualificationMetadataHash,
      }),
    ],
    observedAt: nearCeiling,
  });

  assert.equal(snapshot.expiresAt, '9999-12-31T23:59:59.000Z');
});
