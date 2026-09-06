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

test('component and requirement order cannot change the immutable snapshot', () => {
  const metadata = [moduleMetadata()];
  const forwardRequest = request(metadata);
  const reverseRequest = { ...forwardRequest,
    requiredComponents: [...forwardRequest.requiredComponents].reverse() };
  const forward = build({ moduleQualificationMetadata: metadata,
    request: forwardRequest, components: [component('campaign'), component('resources')] });
  const reverse = build({ moduleQualificationMetadata: metadata,
    request: reverseRequest, components: [component('resources'), component('campaign')] });
  assert.deepEqual(forward, reverse);
  assert.deepEqual(forward.components.map((entry) => entry.componentId), ['campaign', 'resources']);
});

test('produced stateSnapshotHash binds directly into the current candidate router', () => {
  const snapshot = build();
  const metadata = snapshot.moduleQualificationMetadata;
  const candidate = sealActionCandidateV1({
    schemaVersion: 1,
    kind: 'ActionCandidateV1',
    candidateId: 'candidate:snapshot-bound',
    planningRequestId: 'planning:snapshot-bound',
    stateSnapshotHash: snapshot.stateSnapshotHash,
    moduleId: 'module.readonly-control',
    moduleVersion: '1.0.0',
    capabilityId: 'CAP-AUTHOR',
    resourceVector: { cpuUnits: 1, gpuUnits: 0, memoryMiB: 1,
      storageBytes: 0, tokenCount: 0, maximumCostMicrousd: 0 },
    duration: {}, cost: {}, value: {}, risk: {}, preconditions: [],
    dependencyEffects: [], sideEffectClass: 'none', irreversibleBoundary: null,
    rollbackClass: 'discard-prepared-result', expiresAt: '2026-09-06T00:30:00Z',
    inputSchema: null, outputSchema: null, singletonReason: 'only_feasible_candidate',
  });
  const metadataSetHash = capturePlanningModuleQualificationMetadataSetV1(
    metadata,
  ).moduleQualificationMetadataSetHash;
  const frontier = routeActionCandidatesV1({
    inputBoundary: CANDIDATE_ROUTER_INPUT_BOUNDARY,
    planningRequest: {
      schemaVersion: 1, kind: 'PlanningRequestV1',
      planningRequestId: 'planning:snapshot-bound',
      stateSnapshotHash: snapshot.stateSnapshotHash, capabilityId: 'CAP-AUTHOR',
      hardConstraintSetHash: hash('f'), objectiveVersion: 'objective-v1',
      resourcePriceSnapshotHash: snapshot.request.resourcePriceSnapshotHash,
      moduleQualificationMetadataSetHash: metadataSetHash,
      candidateLimit: 1, maximumCandidateBytes: 16384,
      maximumTotalCandidateBytes: 16384, deadline: '2026-09-06T00:30:00Z',
      allowedSideEffectClasses: ['none'], inputArtifacts: [],
    },
    moduleQualificationMetadata: metadata,
    candidates: [candidate], observedAt,
  });
  assert.equal(frontier.stateSnapshotHash, snapshot.stateSnapshotHash);
  assert.equal(frontier.candidateCount, 1);
});

test('missing extra and duplicate component identities fail closed', () => {
  assert.throws(() => build({ components: [component('campaign')] }),
    { code: 'snapshot_component_coverage_invalid' });
  assert.throws(() => build({ components: [component('campaign'), component('resources'), component('extra')] }),
    { code: 'snapshot_component_coverage_invalid' });
  assert.throws(() => build({ components: [component('campaign'), component('campaign')] }),
    { code: 'snapshot_component_duplicate' });
});

test('transaction epoch kind source and capability identities are exact', () => {
  const base = component('campaign');
  const cases = [
    resealComponent(base, { readTransactionHash: hash('0') }),
    resealComponent(base, { consistencyEpoch: 8 }),
    resealComponent(base, { componentKind: 'projection:other' }),
    resealComponent(base, { sourceModuleVersion: '2.0.0' }),
    resealComponent(base, { requiredCapabilityId: 'CAP-AUTHOR' }),
  ];
  for (const changed of cases) {
    assert.throws(() => build({ components: [changed, component('resources')] }));
  }
});

test('revision freshness future and expiry checks are independent', () => {
  const base = component('campaign');
  for (const changed of [
    resealComponent(base, { revision: 1 }),
    resealComponent(base, { observedAt: '2026-09-05T23:40:00Z' }),
    resealComponent(base, { observedAt: '2026-09-06T00:11:00Z' }),
    resealComponent(base, { validUntil: '2026-09-06T00:09:59Z' }),
  ]) {
    assert.throws(() => build({ components: [changed, component('resources')] }));
  }
});
