import assert from 'node:assert/strict';
import test from 'node:test';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  buildControlPlaneSnapshotV1,
  captureQualifiedProjectionSourceSetV1,
  revalidateControlPlaneSnapshotV1,
  sealReadOnlyProjectionV1,
} from '../../paper-application/orchestration/control-plane-snapshot-builder.mjs';
import {
  captureQualifiedPlanningModuleSetV1,
  routeActionCandidatesV1,
  sealActionCandidateV1,
} from '../../paper-application/orchestration/candidate-router.mjs';

const hash = (character) => `sha256:${character.repeat(64)}`;
const builtAt = '2026-09-06T01:00:00Z';
const sources = [
  Object.freeze({
    projectionId: 'campaign-state', projectionVersion: '1',
    moduleId: 'module.readonly-control', moduleVersion: '1.0.0',
    authorityClass: 'read_only', qualificationStatus: 'source_qualified',
    qualificationIdentity: hash('a'), maximumAgeMilliseconds: 120_000,
  }),
  Object.freeze({
    projectionId: 'module-registry', projectionVersion: '1',
    moduleId: 'module.module-registry', moduleVersion: '1.0.0',
    authorityClass: 'read_only', qualificationStatus: 'source_qualified',
    qualificationIdentity: hash('b'), maximumAgeMilliseconds: 300_000,
  }),
];
const sourceSetHash = captureQualifiedProjectionSourceSetV1(sources)
  .qualifiedProjectionSetHash;

function request(overrides = {}) {
  return {
    schemaVersion: 1,
    kind: 'SnapshotBuildRequestV1',
    snapshotId: 'snapshot:alpha',
    moduleRegistryHash: hash('c'),
    policySetHash: hash('d'),
    resourcePriceSnapshotHash: hash('e'),
    objectiveVersion: 'objective-v1',
    qualifiedProjectionSetHash: sourceSetHash,
    issuedAt: '2026-09-06T00:59:00Z',
    builtAt,
    deadline: '2026-09-06T01:10:00Z',
    maximumProjectionBytes: 4096,
    maximumTotalProjectionBytes: 8192,
    ...overrides,
  };
}

function projectionPayload(projectionId, overrides = {}) {
  const source = sources.find((entry) => entry.projectionId === projectionId) || sources[0];
  return {
    schemaVersion: 1,
    kind: 'ReadOnlyProjectionV1',
    projectionId,
    projectionVersion: source.projectionVersion,
    moduleId: source.moduleId,
    moduleVersion: source.moduleVersion,
    sourceGeneration: projectionId === 'campaign-state' ? 7 : 11,
    observedAt: projectionId === 'campaign-state'
      ? '2026-09-06T00:59:30Z' : '2026-09-06T00:58:00Z',
    validUntil: projectionId === 'campaign-state'
      ? '2026-09-06T01:04:00Z' : '2026-09-06T01:08:00Z',
    payload: projectionId === 'campaign-state'
      ? { campaignRevision: 42, readyNodeIds: ['node-b', 'node-a'] }
      : { registryGeneration: 9, modules: ['module.author-node'] },
    ...overrides,
  };
}

const projection = (projectionId, overrides = {}) => sealReadOnlyProjectionV1(
  projectionPayload(projectionId, overrides),
);

function build(overrides = {}) {
  return buildControlPlaneSnapshotV1({
    request: request(overrides.request),
    qualifiedProjectionSources: overrides.sources || sources,
    projections: overrides.projections || [
      projection('campaign-state'), projection('module-registry'),
    ],
  });
}

function generations(snapshot) {
  return snapshot.projections.map((entry) => ({
    projectionId: entry.projectionId,
    sourceGeneration: entry.sourceGeneration,
  }));
}

function revalidate(snapshot, overrides = {}) {
  return revalidateControlPlaneSnapshotV1({
    snapshot,
    observedAt: overrides.observedAt ?? '2026-09-06T01:02:00Z',
    moduleRegistryHash: overrides.moduleRegistryHash ?? snapshot.moduleRegistryHash,
    policySetHash: overrides.policySetHash ?? snapshot.policySetHash,
    resourcePriceSnapshotHash: overrides.resourcePriceSnapshotHash
      ?? snapshot.resourcePriceSnapshotHash,
    objectiveVersion: overrides.objectiveVersion ?? snapshot.objectiveVersion,
    qualifiedProjectionSetHash: overrides.qualifiedProjectionSetHash
      ?? snapshot.qualifiedProjectionSetHash,
    currentProjectionGenerations: overrides.currentProjectionGenerations
      ?? generations(snapshot),
  });
}

function resealSnapshot(snapshot, mutate) {
  const { stateSnapshotHash: ignored, ...body } = structuredClone(snapshot);
  mutate(body);
  return Object.freeze({
    ...body,
    stateSnapshotHash: hashRecord('ControlPlaneSnapshotV1', body),
  });
}

function sourceRowsFrom(body) {
  return body.projections.map((entry) => ({
    projectionId: entry.projectionId,
    projectionVersion: entry.projectionVersion,
    moduleId: entry.moduleId,
    moduleVersion: entry.moduleVersion,
    authorityClass: entry.authorityClass,
    qualificationStatus: entry.qualificationStatus,
    qualificationIdentity: entry.qualificationIdentity,
    maximumAgeMilliseconds: entry.maximumAgeMilliseconds,
  }));
}

function resealSourceAndRequest(body) {
  body.qualifiedProjectionSetHash = captureQualifiedProjectionSourceSetV1(
    sourceRowsFrom(body),
  ).qualifiedProjectionSetHash;
  body.buildRequestHash = hashRecord('SnapshotBuildRequestV1', {
    schemaVersion: 1,
    kind: 'SnapshotBuildRequestV1',
    snapshotId: body.snapshotId,
    moduleRegistryHash: body.moduleRegistryHash,
    policySetHash: body.policySetHash,
    resourcePriceSnapshotHash: body.resourcePriceSnapshotHash,
    objectiveVersion: body.objectiveVersion,
    qualifiedProjectionSetHash: body.qualifiedProjectionSetHash,
    issuedAt: body.issuedAt,
    builtAt: body.builtAt,
    deadline: body.deadline,
    maximumProjectionBytes: body.maximumProjectionBytes,
    maximumTotalProjectionBytes: body.maximumTotalProjectionBytes,
  });
  body.projectionSetHash = hashRecord('SnapshotProjectionSetV1', body.projections);
}

test('source and projection declaration order cannot change the snapshot', () => {
  const first = build();
  const second = buildControlPlaneSnapshotV1({
    request: request(),
    qualifiedProjectionSources: [...sources].reverse(),
    projections: [projection('module-registry'), projection('campaign-state')],
  });
  assert.deepEqual(first, second);
  assert.deepEqual(first.projections.map((entry) => entry.projectionId), [
    'campaign-state', 'module-registry',
  ]);
});

test('snapshot expiry is the minimum request and projection boundary', () => {
  const snapshot = build();
  assert.equal(snapshot.expiresAt, '2026-09-06T01:04:00.000Z');
  assert.equal(snapshot.consumerMustRevalidateBeforePlanning, true);
  assert.ok(Object.values(snapshot.authority).every((value) => value === false));
});

test('projection coverage is exact and duplicate identities are rejected', () => {
  assert.throws(() => build({ projections: [projection('campaign-state')] }), {
    code: 'snapshot_projection_collection_invalid',
  });
  assert.throws(() => build({ projections: [
    projection('campaign-state'), projection('campaign-state'),
  ] }), { code: 'snapshot_projection_duplicate' });
  const extra = projection('extra');
  assert.throws(() => build({ projections: [
    projection('campaign-state'), projection('module-registry'), extra,
  ] }), { code: 'snapshot_projection_coverage_invalid' });
});

test('payload and source identities are independently bound', () => {
  const first = projection('campaign-state');
  assert.throws(() => build({ projections: [
    { ...first, payload: { campaignRevision: 99 } }, projection('module-registry'),
  ] }), { code: 'read_only_projection_payload_hash_invalid' });
  assert.throws(() => build({ projections: [
    projection('campaign-state', { moduleVersion: '2.0.0' }),
    projection('module-registry'),
  ] }), { code: 'read_only_projection_source_binding_mismatch' });
});

test('future, expired and over-age projections fail before snapshot creation', () => {
  for (const changed of [
    projection('campaign-state', { observedAt: '2026-09-06T01:00:01Z' }),
    projection('campaign-state', { validUntil: '2026-09-06T00:59:59Z' }),
    projection('campaign-state', { observedAt: '2026-09-06T00:57:59Z' }),
  ]) assert.throws(() => build({ projections: [changed, projection('module-registry')] }), {
    code: 'read_only_projection_stale_or_not_current',
  });
});

test('source set forbids write authorities, unqualified sources and duplicate IDs', () => {
  for (const changed of [
    { ...sources[0], authorityClass: 'central_state_write' },
    { ...sources[0], qualificationStatus: 'design_ready' },
  ]) assert.throws(() => captureQualifiedProjectionSourceSetV1([
    changed, sources[1],
  ]), /snapshot_projection_source_(authority|qualification)_invalid/u);
  assert.throws(() => captureQualifiedProjectionSourceSetV1([
    sources[0], { ...sources[1], projectionId: sources[0].projectionId },
  ]), { code: 'snapshot_projection_source_duplicate' });
});

test('qualified source substitution is detected by the build request', () => {
  assert.throws(() => build({ sources: [
    { ...sources[0], qualificationIdentity: hash('f') }, sources[1],
  ] }), { code: 'snapshot_projection_set_binding_mismatch' });
});

test('getters, sparse arrays, cycles and nonfinite payloads fail closed', () => {
  let calls = 0;
  const withGetter = { campaignRevision: 1 };
  Object.defineProperty(withGetter, 'secret', { enumerable: true,
    get() { calls += 1; return 'not-read'; } });
  assert.throws(() => projection('campaign-state', { payload: withGetter }), {
    code: 'snapshot_projection_value_record_invalid',
  });
  assert.equal(calls, 0);
  assert.throws(() => buildControlPlaneSnapshotV1({ request: request(),
    qualifiedProjectionSources: sources, projections: new Array(2) }), {
    code: 'snapshot_projection_collection_invalid',
  });
  const cyclic = {}; cyclic.self = cyclic;
  assert.throws(() => projection('campaign-state', { payload: cyclic }), {
    code: 'snapshot_projection_value_cycle',
  });
  assert.throws(() => projection('campaign-state', { payload: { value: NaN } }), {
    code: 'snapshot_projection_value_number_invalid',
  });
});

test('per-projection and aggregate byte budgets are hard limits', () => {
  const large = projection('campaign-state', { payload: { text: 'x'.repeat(1000) } });
  assert.throws(() => build({ request: {
    maximumProjectionBytes: 256, maximumTotalProjectionBytes: 512,
  }, projections: [large, projection('module-registry')] }), {
    code: 'snapshot_projection_byte_limit',
  });
  const first = projection('campaign-state', { payload: { text: 'x'.repeat(800) } });
  const second = projection('module-registry', { payload: { text: 'y'.repeat(800) } });
  assert.throws(() => build({ request: {
    maximumProjectionBytes: 2048, maximumTotalProjectionBytes: 1200,
  }, projections: [first, second] }), { code: 'snapshot_total_byte_limit' });
});

test('currentness accepts reordered exact generations and remains non-authorizing', () => {
  const snapshot = build();
  const receipt = revalidate(snapshot, {
    currentProjectionGenerations: generations(snapshot).reverse(),
  });
  assert.equal(receipt.status, 'control_plane_snapshot_current');
  assert.equal(receipt.stateSnapshotHash, snapshot.stateSnapshotHash);
  assert.ok(Object.values(receipt.authority).every((value) => value === false));
});

test('generation drift, missing rows and duplicates invalidate currentness', () => {
  const snapshot = build();
  const current = generations(snapshot);
  assert.throws(() => revalidate(snapshot, {
    currentProjectionGenerations: [
      { ...current[0], sourceGeneration: current[0].sourceGeneration + 1 }, current[1],
    ],
  }), { code: 'control_plane_snapshot_generation_changed' });
  assert.throws(() => revalidate(snapshot, {
    currentProjectionGenerations: current.slice(0, 1),
  }), { code: 'snapshot_generation_set_invalid' });
  assert.throws(() => revalidate(snapshot, {
    currentProjectionGenerations: [current[0], current[0]],
  }), { code: 'snapshot_generation_coverage_invalid' });
});

test('registry, policy, price, objective and source-set changes invalidate use', () => {
  const snapshot = build();
  for (const override of [
    { moduleRegistryHash: hash('f') },
    { policySetHash: hash('f') },
    { resourcePriceSnapshotHash: hash('f') },
    { objectiveVersion: 'objective-v2' },
    { qualifiedProjectionSetHash: hash('f') },
  ]) assert.throws(() => revalidate(snapshot, override), {
    code: 'control_plane_snapshot_context_changed',
  });
});

test('revalidation time is bounded by build and exact expiry', () => {
  const snapshot = build();
  assert.throws(() => revalidate(snapshot, {
    observedAt: '2026-09-06T00:59:59Z',
  }), { code: 'control_plane_snapshot_expired_or_time_invalid' });
  assert.throws(() => revalidate(snapshot, {
    observedAt: '2026-09-06T01:04:00.001Z',
  }), { code: 'control_plane_snapshot_expired_or_time_invalid' });
  assert.equal(revalidate(snapshot, {
    observedAt: '2026-09-06T01:04:00Z',
  }).status, 'control_plane_snapshot_current');
});

test('rehashing cannot extend expiry beyond a projection validity boundary', () => {
  const snapshot = build();
  const forged = resealSnapshot(snapshot, (body) => {
    body.expiresAt = '2026-09-06T01:09:00.000Z';
  });
  assert.throws(() => revalidate(forged), {
    code: 'control_plane_snapshot_expiry_invalid',
  });
});

test('rehashing cannot erase source age constraints', () => {
  const snapshot = build();
  const tooOld = resealSnapshot(snapshot, (body) => {
    body.projections[0].maximumAgeMilliseconds = 1;
    resealSourceAndRequest(body);
  });
  assert.throws(() => revalidate(tooOld, {
    qualifiedProjectionSetHash: tooOld.qualifiedProjectionSetHash,
  }), { code: 'control_plane_snapshot_projection_time_invalid' });
});

test('authority and payload mutations are rejected before currentness', () => {
  const snapshot = build();
  assert.throws(() => revalidate({
    ...snapshot,
    authority: { ...snapshot.authority, executionAuthorized: true },
  }), { code: 'control_plane_snapshot_authority_invalid' });
  assert.throws(() => revalidate({
    ...snapshot,
    projections: snapshot.projections.map((entry, index) => index
      ? entry : { ...entry, payload: { campaignRevision: 99 } }),
  }), { code: 'snapshot_projection_payload_hash_invalid' });
});

test('caller mutation cannot change captured snapshot or receipt', () => {
  const mutableSources = structuredClone(sources);
  const mutableProjections = structuredClone([
    projection('campaign-state'), projection('module-registry'),
  ]);
  const snapshot = buildControlPlaneSnapshotV1({ request: request(),
    qualifiedProjectionSources: mutableSources, projections: mutableProjections });
  const identity = snapshot.stateSnapshotHash;
  mutableSources[0].moduleVersion = '9.9.9';
  mutableProjections[0].payload.campaignRevision = 999;
  assert.equal(snapshot.stateSnapshotHash, identity);
  assert.equal(snapshot.projections[0].payload.campaignRevision, 42);
  assert.throws(() => { snapshot.projections[0].payload.campaignRevision = 0; }, TypeError);
  const receipt = revalidate(snapshot);
  assert.throws(() => { receipt.currentProjectionGenerations[0].sourceGeneration = 0; }, TypeError);
});

test('candidate routing binds the snapshot hash and a generation change invalidates it', () => {
  const snapshot = build();
  const planningModules = [{
    moduleId: 'module.author-node', moduleVersion: '1.0.0',
    capabilityIds: ['CAP-AUTHOR'], qualificationStatus: 'source_qualified',
    qualificationIdentity: hash('9'),
  }];
  const qualifiedModuleSetHash = captureQualifiedPlanningModuleSetV1(planningModules)
    .qualifiedModuleSetHash;
  const planningRequest = {
    schemaVersion: 1, kind: 'PlanningRequestV1', planningRequestId: 'plan:from-snapshot',
    stateSnapshotHash: snapshot.stateSnapshotHash, capabilityId: 'CAP-AUTHOR',
    hardConstraintSetHash: snapshot.policySetHash, objectiveVersion: snapshot.objectiveVersion,
    resourcePriceSnapshotHash: snapshot.resourcePriceSnapshotHash,
    qualifiedModuleSetHash, candidateLimit: 4, maximumCandidateBytes: 4096,
    maximumTotalCandidateBytes: 8192, deadline: snapshot.expiresAt,
    allowedSideEffectClasses: ['none'], inputArtifacts: [],
  };
  const action = sealActionCandidateV1({
    schemaVersion: 1, kind: 'ActionCandidateV1', candidateId: 'candidate:snapshot-bound',
    planningRequestId: planningRequest.planningRequestId,
    stateSnapshotHash: snapshot.stateSnapshotHash,
    moduleId: 'module.author-node', moduleVersion: '1.0.0', capabilityId: 'CAP-AUTHOR',
    resourceVector: { cpuUnits: 1, gpuUnits: 0, memoryMiB: 512, storageBytes: 0 },
    duration: { maximumMilliseconds: 1000 }, cost: {}, value: {}, risk: {},
    preconditions: [], dependencyEffects: [], sideEffectClass: 'none',
    irreversibleBoundary: null, rollbackClass: 'discard', expiresAt: snapshot.expiresAt,
    inputSchema: null, outputSchema: null, singletonReason: 'only_feasible_candidate',
  });
  const frontier = routeActionCandidatesV1({ planningRequest, qualifiedModules: planningModules,
    candidates: [action], observedAt: '2026-09-06T01:02:00Z' });
  assert.equal(frontier.stateSnapshotHash, snapshot.stateSnapshotHash);
  const changed = generations(snapshot);
  changed[0].sourceGeneration += 1;
  assert.throws(() => revalidate(snapshot, { currentProjectionGenerations: changed }), {
    code: 'control_plane_snapshot_generation_changed',
  });
});
