import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildPlanningSnapshot,
  hashPlanningProjectionV1,
} from '../../paper-application/orchestration/planning-snapshot-builder.mjs';
import {
  hashActionCandidateV1,
  routeActionCandidates,
} from '../../paper-application/orchestration/candidate-router.mjs';

const H = (character) => `sha256:${character.repeat(64)}`;
const NOW = '2026-09-06T00:00:00.123456789Z';

function transaction(overrides = {}) {
  return {
    schemaVersion: 1,
    kind: 'ReadSnapshotTransactionV1',
    repositorySubjectHash: H('a'),
    revision: 41,
    writerGeneration: 7,
    readEpoch: 11,
    capturedAt: '2026-09-05T23:59:00Z',
    expiresAt: '2026-09-07T00:00:00Z',
    ...overrides,
  };
}

function policy(overrides = {}) {
  return {
    hardConstraintSetHash: H('b'),
    objectiveVersion: 'objective-v1',
    resourcePriceSnapshotHash: H('c'),
    allowedSideEffectClasses: ['none', 'workspace_prepared'],
    ...overrides,
  };
}

function moduleBindings(overrides = {}) {
  return [{
    moduleId: 'module.alpha',
    moduleVersion: '1.2.3',
    capabilityIds: ['CAP-MOD-CANDIDATES'],
    qualificationSubjectHash: H('d'),
    ...overrides,
  }];
}

function projectionBody(overrides = {}) {
  return {
    schemaVersion: 1,
    kind: 'PlanningProjectionV1',
    projectionId: 'campaigns',
    sourceModuleId: 'module.readonly-control',
    schemaRef: 'schema:campaign-projection-v1',
    revision: 41,
    writerGeneration: 7,
    readEpoch: 11,
    payload: { campaigns: [{ id: 'campaign-1', status: 'running' }] },
    ...overrides,
  };
}

function signedProjection(overrides = {}) {
  const body = projectionBody(overrides);
  return { ...body, projectionHash: hashPlanningProjectionV1(body) };
}

function build(projections, overrides = {}) {
  return buildPlanningSnapshot({
    transaction: transaction(),
    projections,
    moduleBindings: moduleBindings(),
    policy: policy(),
    now: NOW,
    ...overrides,
  });
}

const rejectCode = (operation, code) => assert.throws(operation, { code });

test('snapshot is deterministic under projection module and policy set ordering', () => {
  const firstRows = [
    signedProjection(),
    signedProjection({ projectionId: 'nodes', schemaRef: 'schema:node-projection-v1',
      payload: { nodes: [{ id: 'node-1', status: 'ready' }] } }),
  ];
  const secondRows = firstRows.map((row) => structuredClone(row)).reverse();
  const first = build(firstRows, {
    moduleBindings: [
      ...moduleBindings(),
      { moduleId: 'module.beta', moduleVersion: '2.0.0',
        capabilityIds: ['CAP-OTHER'], qualificationSubjectHash: H('e') },
    ],
  });
  const second = build(secondRows, {
    policy: policy({ allowedSideEffectClasses: ['workspace_prepared', 'none'] }),
    moduleBindings: [
      { moduleId: 'module.beta', moduleVersion: '2.0.0',
        capabilityIds: ['CAP-OTHER'], qualificationSubjectHash: H('e') },
      ...moduleBindings(),
    ],
  });
  assert.equal(first.stateSnapshotHash, second.stateSnapshotHash);
  assert.deepEqual(first.projections, second.projections);
  assert.deepEqual(first.moduleBindings, second.moduleBindings);
});

test('projection hash is recomputed from captured metadata and payload', () => {
  const row = signedProjection();
  row.payload.campaigns[0].status = 'completed';
  rejectCode(() => build([row]), 'planning_projection_hash_invalid');
});

test('every projection must share the transaction revision generation and epoch', () => {
  for (const mutation of [
    { revision: 42 },
    { writerGeneration: 8 },
    { readEpoch: 12 },
  ]) rejectCode(() => build([signedProjection(mutation)]),
    'planning_projection_transaction_mismatch');
});

test('duplicate projection identities are rejected even for identical records', () => {
  const row = signedProjection();
  rejectCode(() => build([row, structuredClone(row)]), 'planning_projection_duplicate');
});

test('read transaction must be current at the explicit clock', () => {
  rejectCode(() => build([signedProjection()], { now: '2026-09-07T00:00:00Z' }),
    'planning_snapshot_not_current');
  rejectCode(() => build([signedProjection()], {
    transaction: transaction({ capturedAt: '2026-09-06T01:00:00Z' }),
  }), 'planning_snapshot_not_current');
});

test('strict timestamps reject normalized-invalid calendar values', () => {
  for (const expiresAt of ['2026-02-30T00:00:00Z', '2026-09-06T24:00:00Z',
    '2026-09-06T00:00:00+00:60', '2026-09-06T00:00:00']) {
    assert.throws(() => build([signedProjection()], {
      transaction: transaction({ expiresAt }),
    }));
  }
});

test('nanosecond currentness is preserved', () => {
  const expiry = '2026-09-06T00:00:00.123456790Z';
  assert.ok(build([signedProjection()], { transaction: transaction({ expiresAt: expiry }) }));
  rejectCode(() => build([signedProjection()], {
    transaction: transaction({ expiresAt: NOW }),
  }), 'planning_snapshot_not_current');
});

test('revision generation and epoch reject negative unsafe and coerced values', () => {
  for (const field of ['revision', 'writerGeneration', 'readEpoch']) {
    for (const value of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, '1', true, NaN]) {
      assert.throws(() => build([signedProjection()], {
        transaction: transaction({ [field]: value }),
      }));
    }
  }
});

test('top-level projection and payload accessors are rejected without invocation', () => {
  let calls = 0;
  const top = signedProjection();
  Object.defineProperty(top, 'projectionId', { enumerable: true,
    get() { calls += 1; return 'campaigns'; } });
  assert.throws(() => build([top]));
  const nested = signedProjection();
  Object.defineProperty(nested.payload, 'campaigns', { enumerable: true,
    get() { calls += 1; return []; } });
  assert.throws(() => build([nested]));
  assert.equal(calls, 0);
});

test('cyclic payloads are rejected before hash comparison', () => {
  const row = signedProjection();
  const cycle = {};
  cycle.self = cycle;
  row.payload = cycle;
  rejectCode(() => build([row]), 'planning_projection_cycle');
});

test('projection and module collections reject sparse and symbolic members', () => {
  const sparse = [];
  sparse.length = 2;
  sparse[1] = signedProjection();
  assert.throws(() => build(sparse));
  const symbolic = [signedProjection()];
  symbolic[Symbol('extra')] = true;
  assert.throws(() => build(symbolic));
  const modules = moduleBindings();
  modules[Symbol('extra')] = true;
  assert.throws(() => build([signedProjection()], { moduleBindings: modules }));
});

test('projection and module counts are hard bounded', () => {
  const rows = [signedProjection(), signedProjection({ projectionId: 'nodes' })];
  assert.throws(() => build(rows, { limits: { maximumProjections: 1 } }));
  assert.throws(() => build([signedProjection()], {
    moduleBindings: [
      ...moduleBindings(),
      { moduleId: 'module.beta', moduleVersion: '1', capabilityIds: ['CAP-X'],
        qualificationSubjectHash: H('e') },
    ],
    limits: { maximumModules: 1 },
  }));
});

test('per-projection and aggregate bytes are bounded', () => {
  assert.throws(() => build([signedProjection({ payload: { text: 'x'.repeat(4096) } })], {
    limits: { maximumProjectionBytes: 512, maximumTotalBytes: 4096 },
  }));
  const rows = [
    signedProjection({ projectionId: 'one', payload: { text: 'x'.repeat(900) } }),
    signedProjection({ projectionId: 'two', payload: { text: 'y'.repeat(900) } }),
  ];
  assert.throws(() => build(rows, {
    limits: { maximumProjectionBytes: 2048, maximumTotalBytes: 2048 },
  }));
});

test('payload depth and aggregate collection cardinality are bounded', () => {
  let payload = 0;
  for (let index = 0; index < 8; index += 1) payload = { payload };
  assert.throws(() => build([signedProjection({ payload })], {
    limits: { maximumDepth: 4 },
  }));
  assert.throws(() => build([signedProjection({ payload: Array(20).fill(0) })], {
    limits: { maximumCollectionItems: 8 },
  }));
});

test('unknown API transaction projection module policy and limit fields fail closed', () => {
  assert.throws(() => buildPlanningSnapshot({
    transaction: transaction(), projections: [signedProjection()],
    moduleBindings: moduleBindings(), policy: policy(), now: NOW, unknown: true,
  }));
  assert.throws(() => build([signedProjection()], {
    transaction: { ...transaction(), unknown: true },
  }));
  assert.throws(() => build([{ ...signedProjection(), unknown: true }]));
  assert.throws(() => build([signedProjection()], {
    moduleBindings: [{ ...moduleBindings()[0], unknown: true }],
  }));
  assert.throws(() => build([signedProjection()], { policy: { ...policy(), unknown: true } }));
  assert.throws(() => build([signedProjection()], { limits: { unknown: 1 } }));
});

test('module bindings reject duplicates and empty capability sets', () => {
  assert.throws(() => build([signedProjection()], {
    moduleBindings: [...moduleBindings(), ...moduleBindings()],
  }));
  assert.throws(() => build([signedProjection()], {
    moduleBindings: moduleBindings({ capabilityIds: [] }),
  }));
});

test('policy side-effect classes are nonempty unique bounded values', () => {
  assert.throws(() => build([signedProjection()], {
    policy: policy({ allowedSideEffectClasses: [] }),
  }));
  assert.throws(() => build([signedProjection()], {
    policy: policy({ allowedSideEffectClasses: ['none', 'none'] }),
  }));
});

test('qualification subject changes snapshot identity', () => {
  const first = build([signedProjection()]);
  const second = build([signedProjection()], {
    moduleBindings: moduleBindings({ qualificationSubjectHash: H('e') }),
  });
  assert.notEqual(first.stateSnapshotHash, second.stateSnapshotHash);
});

test('policy objective constraints and resource prices change snapshot identity', () => {
  const first = build([signedProjection()]);
  for (const changed of [
    { objectiveVersion: 'objective-v2' },
    { hardConstraintSetHash: H('e') },
    { resourcePriceSnapshotHash: H('f') },
  ]) assert.notEqual(first.stateSnapshotHash,
    build([signedProjection()], { policy: policy(changed) }).stateSnapshotHash);
});

test('projection payload changes snapshot identity after valid resealing', () => {
  const first = build([signedProjection()]);
  const second = build([signedProjection({
    payload: { campaigns: [{ id: 'campaign-1', status: 'paused' }] },
  })]);
  assert.notEqual(first.stateSnapshotHash, second.stateSnapshotHash);
});

test('captured snapshot is deeply immutable and detached from caller mutation', () => {
  const row = signedProjection();
  const result = build([row]);
  const priorHash = result.stateSnapshotHash;
  row.payload.campaigns[0].status = 'failed';
  assert.equal(result.projections[0].payload.campaigns[0].status, 'running');
  assert.equal(result.stateSnapshotHash, priorHash);
  assert.throws(() => { result.projections[0].payload.campaigns[0].status = 'x'; }, TypeError);
  assert.throws(() => { result.projections.push(row); }, TypeError);
});

test('authority output is explicitly nonactivating', () => {
  const result = build([signedProjection()]);
  assert.equal(result.status, 'complete_exact_read_snapshot');
  assert.ok(Object.values(result.authority).every((value) => value === false));
});

test('candidate router accepts a request bound to the exact snapshot', () => {
  const snapshot = build([signedProjection()]);
  const request = {
    schemaVersion: 1,
    kind: 'PlanningRequestV1',
    planningRequestId: 'planning-1',
    stateSnapshotHash: snapshot.stateSnapshotHash,
    capabilityId: 'CAP-MOD-CANDIDATES',
    hardConstraintSetHash: snapshot.policy.hardConstraintSetHash,
    objectiveVersion: snapshot.policy.objectiveVersion,
    resourcePriceSnapshotHash: snapshot.policy.resourcePriceSnapshotHash,
    candidateLimit: 4,
    createdAt: snapshot.capturedAt,
    expiresAt: snapshot.expiresAt,
    allowedSideEffectClasses: snapshot.policy.allowedSideEffectClasses,
  };
  const body = {
    schemaVersion: 1,
    kind: 'ActionCandidateV1',
    candidateId: 'candidate-1',
    planningRequestId: request.planningRequestId,
    stateSnapshotHash: snapshot.stateSnapshotHash,
    moduleId: 'module.alpha',
    moduleVersion: '1.2.3',
    capabilityId: request.capabilityId,
    resourceVector: { cpuUnits: 1, gpuUnits: 0, memoryMiB: 32, storageBytes: 0 },
    duration: {}, cost: {}, value: {}, risk: {},
    sideEffectClass: 'none',
    rollbackClass: 'pure',
    expiresAt: '2026-09-06T12:00:00Z',
    singletonReason: 'only_feasible_candidate',
  };
  const candidate = { ...body, candidatePayloadHash: hashActionCandidateV1(body) };
  const result = routeActionCandidates({ planningRequest: request, candidates: [candidate],
    qualifiedModules: snapshot.moduleBindings, now: NOW });
  assert.equal(result.stateSnapshotHash, snapshot.stateSnapshotHash);
  assert.equal(result.candidateCount, 1);
});

test('candidate from an older snapshot is rejected after state changes', () => {
  const oldSnapshot = build([signedProjection()]);
  const newSnapshot = build([signedProjection({
    payload: { campaigns: [{ id: 'campaign-1', status: 'paused' }] },
  })]);
  const request = {
    schemaVersion: 1,
    kind: 'PlanningRequestV1',
    planningRequestId: 'planning-1',
    stateSnapshotHash: newSnapshot.stateSnapshotHash,
    capabilityId: 'CAP-MOD-CANDIDATES',
    hardConstraintSetHash: newSnapshot.policy.hardConstraintSetHash,
    objectiveVersion: newSnapshot.policy.objectiveVersion,
    resourcePriceSnapshotHash: newSnapshot.policy.resourcePriceSnapshotHash,
    candidateLimit: 4,
    createdAt: newSnapshot.capturedAt,
    expiresAt: newSnapshot.expiresAt,
    allowedSideEffectClasses: newSnapshot.policy.allowedSideEffectClasses,
  };
  const body = {
    schemaVersion: 1, kind: 'ActionCandidateV1', candidateId: 'stale',
    planningRequestId: 'planning-1', stateSnapshotHash: oldSnapshot.stateSnapshotHash,
    moduleId: 'module.alpha', moduleVersion: '1.2.3',
    capabilityId: 'CAP-MOD-CANDIDATES',
    resourceVector: { cpuUnits: 0, gpuUnits: 0, memoryMiB: 0, storageBytes: 0 },
    duration: {}, cost: {}, value: {}, risk: {}, sideEffectClass: 'none',
    rollbackClass: 'pure', expiresAt: '2026-09-06T12:00:00Z',
    singletonReason: 'only_feasible_candidate',
  };
  const stale = { ...body, candidatePayloadHash: hashActionCandidateV1(body) };
  rejectCode(() => routeActionCandidates({ planningRequest: request, candidates: [stale],
    qualifiedModules: newSnapshot.moduleBindings, now: NOW }),
  'candidate_request_binding_mismatch');
});

test('API and limit accessors fail without invocation', () => {
  let calls = 0;
  const envelope = Object.defineProperty({}, 'transaction', { enumerable: true,
    get() { calls += 1; return transaction(); } });
  assert.throws(() => buildPlanningSnapshot(envelope));
  const limits = Object.defineProperty({}, 'maximumProjections', { enumerable: true,
    get() { calls += 1; return 2; } });
  assert.throws(() => build([signedProjection()], { limits }));
  assert.equal(calls, 0);
});
