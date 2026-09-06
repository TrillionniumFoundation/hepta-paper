import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildPlanningStateSnapshot,
  createPlanningSnapshotComponent,
} from '../../paper-application/orchestration/snapshot-builder.mjs';
import {
  createActionCandidate,
  routeActionCandidates,
} from '../../paper-application/orchestration/candidate-router.mjs';

const H = (character) => `sha256:${character.repeat(64)}`;
const NOW = Date.parse('2026-09-06T00:00:00Z');

function requirement(componentId = 'campaign', componentKind = 'campaign-state', overrides = {}) {
  return {
    componentId,
    componentKind,
    minimumRevision: 4,
    maximumAgeMs: 60 * 60 * 1000,
    maximumPayloadBytes: 64 * 1024,
    ...overrides,
  };
}

function request(requiredComponents = [requirement()], overrides = {}) {
  return {
    schemaVersion: 1,
    kind: 'PlanningStateSnapshotRequestV1',
    snapshotRequestId: 'snapshot-request-1',
    readTransactionHash: H('a'),
    consistencyEpoch: 7,
    deadline: '2026-09-08T00:00:00Z',
    requiredComponents,
    ...overrides,
  };
}

function binding(moduleId = 'module.readonly-control', moduleVersion = '1.0.0', overrides = {}) {
  return {
    moduleId,
    moduleVersion,
    projectionKinds: ['campaign-state', 'module-registry'],
    qualificationSubjectHash: H('b'),
    validUntil: '2026-09-09T00:00:00Z',
    ...overrides,
  };
}

function component(componentId = 'campaign', componentKind = 'campaign-state', overrides = {}) {
  return createPlanningSnapshotComponent({
    schemaVersion: 1,
    kind: 'PlanningSnapshotComponentV1',
    componentId,
    componentKind,
    sourceModuleId: 'module.readonly-control',
    sourceModuleVersion: '1.0.0',
    sourceQualificationHash: H('b'),
    readTransactionHash: H('a'),
    consistencyEpoch: 7,
    revision: 4,
    generation: 2,
    capturedAt: '2026-09-05T23:59:00Z',
    expiresAt: '2026-09-07T00:00:00Z',
    payload: { status: 'running', revision: 4 },
    ...overrides,
  });
}

function build(components, overrides = {}) {
  return buildPlanningStateSnapshot({
    request: request(),
    moduleBindings: [binding()],
    components,
    nowEpochMs: NOW,
    ...overrides,
  });
}

test('component helper and snapshot builder verify exact component hash', () => {
  const item = component();
  const snapshot = build([item]);
  assert.equal(snapshot.components[0].payloadHash, item.payloadHash);
  assert.match(snapshot.stateSnapshotHash, /^sha256:[0-9a-f]{64}$/u);
});

test('component and requirement order do not change snapshot identity', () => {
  const campaign = component();
  const registry = component('registry', 'module-registry', {
    revision: 9,
    payload: { modules: ['module.a', 'module.b'] },
  });
  const campaignRequirement = requirement();
  const registryRequirement = requirement('registry', 'module-registry', { minimumRevision: 9 });
  const left = buildPlanningStateSnapshot({
    request: request([registryRequirement, campaignRequirement]),
    moduleBindings: [binding()],
    components: [campaign, registry],
    nowEpochMs: NOW,
  });
  const right = buildPlanningStateSnapshot({
    request: request([campaignRequirement, registryRequirement]),
    moduleBindings: [binding(undefined, undefined, {
      projectionKinds: ['module-registry', 'campaign-state'],
    })],
    components: [registry, campaign],
    nowEpochMs: NOW,
  });
  assert.equal(left.stateSnapshotHash, right.stateSnapshotHash);
  assert.deepEqual(left.components.map((item) => item.componentId), ['campaign', 'registry']);
});

test('missing, extra and duplicate components are rejected', () => {
  assert.throws(() => build([]), { code: 'snapshot_component_set_mismatch' });
  assert.throws(() => build([component(), component('extra', 'campaign-state')]),
    { code: 'snapshot_component_set_mismatch' });
  assert.throws(() => buildPlanningStateSnapshot({
    request: request([requirement(), requirement('registry', 'module-registry')]),
    moduleBindings: [binding()],
    components: [component(), component()],
    nowEpochMs: NOW,
  }), { code: 'snapshot_component_duplicate' });
});

test('component kind and requirement identity must match exactly', () => {
  assert.throws(() => build([component('campaign', 'module-registry')]),
    { code: 'snapshot_component_set_mismatch' });
  assert.throws(() => build([component('other')]), { code: 'snapshot_component_set_mismatch' });
});

test('read transaction and consistency epoch cannot be spliced', () => {
  assert.throws(() => build([component(undefined, undefined, { readTransactionHash: H('9') })]),
    { code: 'snapshot_component_transaction_mismatch' });
  assert.throws(() => build([component(undefined, undefined, { consistencyEpoch: 8 })]),
    { code: 'snapshot_component_epoch_mismatch' });
});

test('component revision must satisfy the requested floor', () => {
  assert.throws(() => build([component(undefined, undefined, { revision: 3 })]),
    { code: 'snapshot_component_revision_too_old' });
});

test('future, stale, expired and overlong component lifetimes fail closed', () => {
  assert.throws(() => build([component(undefined, undefined, {
    capturedAt: '2026-09-06T00:00:01Z',
  })]), { code: 'snapshot_component_from_future' });
  assert.throws(() => build([component(undefined, undefined, {
    capturedAt: '2026-09-05T00:00:00Z',
  })]), { code: 'snapshot_component_stale' });
  assert.throws(() => build([component(undefined, undefined, {
    expiresAt: '2026-09-05T23:59:59Z',
  })]), { code: 'snapshot_component_expired' });
  assert.throws(() => build([component(undefined, undefined, {
    expiresAt: '2026-09-09T00:00:00Z',
  })]), { code: 'snapshot_component_expiry_exceeds_request' });
});

test('source module version, qualification and projection kind are bound', () => {
  const item = component();
  assert.throws(() => build([item], {
    moduleBindings: [binding(undefined, '2.0.0')],
  }), { code: 'snapshot_component_module_binding_mismatch' });
  assert.throws(() => build([item], {
    moduleBindings: [binding(undefined, undefined, { qualificationSubjectHash: H('9') })],
  }), { code: 'snapshot_component_module_binding_mismatch' });
  assert.throws(() => build([item], {
    moduleBindings: [binding(undefined, undefined, { projectionKinds: ['module-registry'] })],
  }), { code: 'snapshot_component_module_binding_mismatch' });
});

test('expired and duplicate module bindings are rejected', () => {
  const item = component();
  assert.throws(() => build([item], {
    moduleBindings: [binding(undefined, undefined, { validUntil: '2026-09-05T00:00:00Z' })],
  }), { code: 'snapshot_module_binding_expired' });
  assert.throws(() => build([item], { moduleBindings: [binding(), binding()] }),
    { code: 'snapshot_module_binding_duplicate' });
});

test('forged component payload hash is rejected', () => {
  const item = component();
  assert.throws(() => build([{ ...item, payloadHash: H('f') }]),
    { code: 'snapshot_component_payload_hash_invalid' });
});

test('accessors are rejected without executing getters', () => {
  let calls = 0;
  const item = { ...component() };
  Object.defineProperty(item, 'payload', {
    enumerable: true,
    get() { calls += 1; return {}; },
  });
  assert.throws(() => build([item]), { code: 'snapshot_component_invalid' });
  assert.equal(calls, 0);
});

test('sparse collections, unknown fields and malformed payload values are rejected', () => {
  const sparse = new Array(1);
  assert.throws(() => build(sparse), { code: 'snapshot_component_count_invalid' });
  assert.throws(() => build([{ ...component(), credential: 'forbidden' }]),
    { code: 'snapshot_component_invalid' });
  const valid = component();
  assert.throws(() => build([{ ...valid, payload: { value: NaN } }]),
    { code: 'snapshot_component_payload_invalid' });
});

test('payload, component and total byte limits are independent', () => {
  const largePayload = component(undefined, undefined, { payload: { text: 'x'.repeat(2048) } });
  assert.throws(() => build([largePayload], {
    request: request([requirement(undefined, undefined, { maximumPayloadBytes: 128 })]),
  }), { code: 'snapshot_component_payload_byte_limit_exceeded' });

  const recordHeavy = component(undefined, undefined, { payload: { text: 'x'.repeat(700) } });
  assert.throws(() => build([recordHeavy], {
    limits: { maximumComponentBytes: 512, maximumTotalBytes: 1024 },
  }), { code: 'snapshot_component_byte_limit_exceeded' });

  const first = component(undefined, undefined, { payload: { text: 'x'.repeat(700) } });
  const second = component('registry', 'module-registry', {
    revision: 9, payload: { text: 'y'.repeat(700) },
  });
  assert.throws(() => buildPlanningStateSnapshot({
    request: request([
      requirement(undefined, undefined, { maximumPayloadBytes: 1024 }),
      requirement('registry', 'module-registry', { minimumRevision: 9, maximumPayloadBytes: 1024 }),
    ]),
    moduleBindings: [binding()],
    components: [first, second],
    nowEpochMs: NOW,
    limits: { maximumComponentBytes: 1800, maximumTotalBytes: 1800 },
  }), { code: 'snapshot_total_byte_limit_exceeded' });
});

test('request deadline and malformed clock fail before a snapshot is returned', () => {
  assert.throws(() => build([component()], {
    request: request(undefined, { deadline: '2026-09-05T00:00:00Z' }),
  }), { code: 'snapshot_request_expired' });
  assert.throws(() => buildPlanningStateSnapshot({
    request: request(), moduleBindings: [binding()], components: [component()], nowEpochMs: NaN,
  }), { code: 'snapshot_builder_clock_invalid' });
});

test('request requirement changes alter the snapshot request and state hashes', () => {
  const item = component();
  const left = build([item]);
  const right = build([item], {
    request: request([requirement(undefined, undefined, { minimumRevision: 3 })]),
  });
  assert.notEqual(left.snapshotRequestHash, right.snapshotRequestHash);
  assert.notEqual(left.stateSnapshotHash, right.stateSnapshotHash);
});

test('captured state is immutable and independent of caller mutation', () => {
  const captured = component();
  const raw = { ...captured, payload: { status: 'running', revision: 4 } };
  const rawRequest = request();
  const snapshot = buildPlanningStateSnapshot({
    request: rawRequest,
    moduleBindings: [binding()],
    components: [raw],
    nowEpochMs: NOW,
  });
  raw.payload.status = 'failed';
  rawRequest.consistencyEpoch = 999;
  assert.equal(snapshot.components[0].payload.status, 'running');
  assert.equal(snapshot.consistencyEpoch, 7);
  assert.throws(() => { snapshot.components[0].payload.status = 'mutated'; }, TypeError);
  assert.throws(() => { snapshot.authority.writerAuthorityGranted = true; }, TypeError);
});

test('snapshot hash composes directly with candidate routing and rejects stale candidates', () => {
  const snapshot = build([component()]);
  const planningRequest = {
    schemaVersion: 1,
    kind: 'PlanningRequestV1',
    planningRequestId: 'route-from-snapshot',
    stateSnapshotHash: snapshot.stateSnapshotHash,
    capabilityId: 'CAP-MOD-CANDIDATES',
    hardConstraintSetHash: H('c'),
    objectiveVersion: 'objective-v1',
    resourcePriceSnapshotHash: H('d'),
    candidateLimit: 2,
    deadline: '2026-09-07T00:00:00Z',
    allowedSideEffectClasses: ['none'],
    inputArtifactHashes: [],
  };
  const moduleBinding = {
    moduleId: 'module.alpha', moduleVersion: '1.0.0',
    capabilityIds: ['CAP-MOD-CANDIDATES'], qualificationSubjectHash: H('e'),
    validUntil: '2026-09-07T00:00:00Z',
  };
  const action = createActionCandidate({
    schemaVersion: 1, kind: 'ActionCandidateV1', candidateId: 'candidate-1',
    planningRequestId: planningRequest.planningRequestId,
    stateSnapshotHash: snapshot.stateSnapshotHash,
    moduleId: moduleBinding.moduleId, moduleVersion: moduleBinding.moduleVersion,
    capabilityId: planningRequest.capabilityId,
    resourceVector: { cpuUnits: 1, gpuUnits: 0, memoryMiB: 1, storageBytes: 0 },
    duration: {}, cost: {}, value: {}, risk: {}, sideEffectClass: 'none',
    rollbackClass: 'no_effect', expiresAt: '2026-09-06T12:00:00Z',
    singletonReason: 'only_feasible_candidate',
  });
  const frontier = routeActionCandidates({
    request: planningRequest, moduleBindings: [moduleBinding], candidates: [action], nowEpochMs: NOW,
  });
  assert.equal(frontier.stateSnapshotHash, snapshot.stateSnapshotHash);

  const changed = build([component(undefined, undefined, { revision: 5, payload: { revision: 5 } })], {
    request: request([requirement(undefined, undefined, { minimumRevision: 5 })]),
  });
  assert.throws(() => routeActionCandidates({
    request: { ...planningRequest, stateSnapshotHash: changed.stateSnapshotHash },
    moduleBindings: [moduleBinding], candidates: [action], nowEpochMs: NOW,
  }), { code: 'candidate_snapshot_binding_mismatch' });
});
