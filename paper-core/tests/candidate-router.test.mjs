import assert from 'node:assert/strict';
import test from 'node:test';
import {
  captureQualifiedPlanningModuleSetV1,
  routeActionCandidatesV1,
  sealActionCandidateV1,
} from '../../paper-application/orchestration/candidate-router.mjs';

const hash = (character) => `sha256:${character.repeat(64)}`;
const observedAt = '2026-09-06T00:00:00Z';
const modules = [Object.freeze({
  moduleId: 'module.author-node',
  moduleVersion: '1.0.0',
  capabilityIds: Object.freeze(['CAP-AUTHOR']),
  qualificationStatus: 'source_qualified',
  qualificationIdentity: hash('a'),
})];
const moduleSetHash = captureQualifiedPlanningModuleSetV1(modules).qualifiedModuleSetHash;

function planningRequest(overrides = {}) {
  return {
    schemaVersion: 1,
    kind: 'PlanningRequestV1',
    planningRequestId: 'request:alpha',
    stateSnapshotHash: hash('b'),
    capabilityId: 'CAP-AUTHOR',
    hardConstraintSetHash: hash('c'),
    objectiveVersion: 'objective-v1',
    resourcePriceSnapshotHash: hash('d'),
    qualifiedModuleSetHash: moduleSetHash,
    candidateLimit: 16,
    maximumCandidateBytes: 16 * 1024,
    maximumTotalCandidateBytes: 64 * 1024,
    deadline: '2026-09-06T01:00:00Z',
    allowedSideEffectClasses: ['none'],
    inputArtifacts: [hash('e')],
    ...overrides,
  };
}

function candidatePayload(overrides = {}) {
  return {
    schemaVersion: 1,
    kind: 'ActionCandidateV1',
    candidateId: 'candidate:alpha',
    planningRequestId: 'request:alpha',
    stateSnapshotHash: hash('b'),
    moduleId: 'module.author-node',
    moduleVersion: '1.0.0',
    capabilityId: 'CAP-AUTHOR',
    resourceVector: {
      cpuUnits: 1,
      gpuUnits: 0,
      memoryMiB: 512,
      storageBytes: 1024,
      tokenCount: 100,
      maximumCostMicrousd: 50,
    },
    duration: { maximumMilliseconds: 1000 },
    cost: { maximumMicrousd: 50 },
    value: { evidenceGain: 3, scientificValue: 5 },
    risk: { failureProbabilityPpm: 1000 },
    preconditions: ['snapshot-current'],
    dependencyEffects: [],
    sideEffectClass: 'none',
    irreversibleBoundary: null,
    rollbackClass: 'discard-prepared-result',
    expiresAt: '2026-09-06T00:30:00Z',
    inputSchema: 'schema:author-input-v1',
    outputSchema: 'schema:author-output-v1',
    singletonReason: null,
    ...overrides,
  };
}

const candidate = (overrides = {}) => sealActionCandidateV1(candidatePayload(overrides));
function reseal(value, overrides = {}) {
  const { candidatePayloadHash: ignored, ...payload } = value;
  return sealActionCandidateV1({ ...payload, ...overrides });
}
function route(candidates, overrides = {}) {
  return routeActionCandidatesV1({
    planningRequest: planningRequest(overrides.planningRequest),
    qualifiedModules: overrides.qualifiedModules || modules,
    candidates,
    observedAt: overrides.observedAt || observedAt,
  });
}

test('candidate order cannot change the canonical frontier', () => {
  const left = candidate({ candidateId: 'candidate:a' });
  const right = candidate({ candidateId: 'candidate:b', dependencyEffects: ['artifact:beta', 'artifact:alpha'] });
  const a = route([right, left]);
  const b = route([left, right]);
  assert.deepEqual(a, b);
  assert.deepEqual(a.candidates.map((entry) => entry.candidateId), ['candidate:a', 'candidate:b']);
});

test('dependency-distinct locally dominated candidates are retained', () => {
  const preferred = candidate({ candidateId: 'candidate:local', value: { score: 10 },
    cost: { units: 1 }, dependencyEffects: ['requires:expensive-global-dependency'] });
  const feasible = candidate({ candidateId: 'candidate:global', value: { score: 9 },
    cost: { units: 2 }, dependencyEffects: [] });
  const result = route([preferred, feasible]);
  assert.equal(result.candidateCount, 2);
  assert.equal(result.dominanceReductionApplied, false);
  assert.equal(result.dominancePolicy, 'none_without_context_safe_replacement_proof');
});

test('exact duplicates deduplicate, but candidate ID conflicts fail', () => {
  const only = candidate({ singletonReason: 'only_feasible_candidate' });
  const result = route([only, JSON.parse(JSON.stringify(only))]);
  assert.equal(result.candidateCount, 1);
  assert.equal(result.deduplicatedCount, 1);
  assert.throws(() => route([candidate(), candidate({ value: { score: 99 } })]), {
    code: 'action_candidate_id_conflict',
  });
});

test('payload hashes and singleton reasons are independently enforced', () => {
  const only = candidate({ singletonReason: 'only_feasible_candidate' });
  assert.throws(() => route([{ ...only, value: { score: 999 } }]), {
    code: 'action_candidate_payload_hash_invalid',
  });
  assert.throws(() => route([candidate()]), { code: 'candidate_singleton_reason_required' });
  assert.throws(() => route([
    candidate({ candidateId: 'candidate:a', singletonReason: 'only_feasible_candidate' }),
    candidate({ candidateId: 'candidate:b' }),
  ]), { code: 'candidate_singleton_reason_invalid' });
});

test('request, snapshot, capability and module versions are exact', () => {
  const only = candidate({ singletonReason: 'only_feasible_candidate' });
  for (const changed of [
    reseal(only, { planningRequestId: 'request:other' }),
    reseal(only, { stateSnapshotHash: hash('f') }),
    reseal(only, { capabilityId: 'CAP-REVIEW' }),
  ]) assert.throws(() => route([changed]), /action_candidate_(request|snapshot|capability)_mismatch/u);
  assert.throws(() => route([reseal(only, { moduleVersion: '2.0.0' })]), {
    code: 'action_candidate_module_not_qualified',
  });
});

test('qualified module set identity prevents registry substitution', () => {
  const only = candidate({ singletonReason: 'only_feasible_candidate' });
  const changed = [{ ...modules[0], qualificationIdentity: hash('f') }];
  assert.throws(() => routeActionCandidatesV1({ planningRequest: planningRequest(),
    qualifiedModules: changed, candidates: [only], observedAt }), {
    code: 'planning_request_module_set_mismatch',
  });
  assert.throws(() => captureQualifiedPlanningModuleSetV1([
    { ...modules[0], qualificationStatus: 'design_ready' },
  ]), { code: 'candidate_module_qualification_invalid' });
  assert.throws(() => captureQualifiedPlanningModuleSetV1([modules[0], modules[0]]), {
    code: 'candidate_module_binding_duplicate',
  });
});

test('expiry uses only the explicit observation time', () => {
  const only = candidate({ singletonReason: 'only_feasible_candidate' });
  assert.throws(() => route([only], { observedAt: '2026-09-06T02:00:00Z' }), {
    code: 'planning_request_expired',
  });
  assert.throws(() => route([reseal(only, { expiresAt: '2026-09-05T23:59:59Z' })]), {
    code: 'action_candidate_expired_or_outlives_request',
  });
  assert.throws(() => route([reseal(only, { expiresAt: '2026-09-06T02:00:00Z' })]), {
    code: 'action_candidate_expired_or_outlives_request',
  });
});

test('side-effect classes are allowlisted without granting authority', () => {
  const external = candidate({ singletonReason: 'only_feasible_candidate', sideEffectClass: 'provider-call' });
  assert.throws(() => route([external]), { code: 'action_candidate_side_effect_forbidden' });
  const result = route([external], { planningRequest: { allowedSideEffectClasses: ['provider-call'] } });
  assert.ok(Object.values(result.authority).every((value) => value === false));
});

test('resource vectors reject nonfinite, negative and unsafe values', () => {
  for (const delta of [
    { cpuUnits: NaN }, { gpuUnits: Infinity }, { cpuUnits: -1 },
    { memoryMiB: 0.5 }, { storageBytes: Number.MAX_SAFE_INTEGER + 1 },
    { tokenCount: '1' }, { maximumCostMicrousd: -1 },
  ]) assert.throws(() => candidate({
    resourceVector: { ...candidatePayload().resourceVector, ...delta },
  }), /candidate_resource_value_invalid/u);
});

test('getters, sparse arrays, duplicate sets and unknown fields fail closed', () => {
  let calls = 0;
  const top = candidatePayload();
  Object.defineProperty(top, 'moduleId', { enumerable: true,
    get() { calls += 1; return 'module.author-node'; } });
  assert.throws(() => sealActionCandidateV1(top), { code: 'action_candidate_invalid' });
  const nested = {};
  Object.defineProperty(nested, 'score', { enumerable: true, get() { calls += 1; return 1; } });
  assert.throws(() => candidate({ value: nested }), { code: 'candidate_value_record_invalid' });
  assert.equal(calls, 0);
  assert.throws(() => routeActionCandidatesV1({ planningRequest: planningRequest(),
    qualifiedModules: modules, candidates: new Array(1), observedAt }), {
    code: 'candidate_collection_invalid',
  });
  assert.throws(() => candidate({ preconditions: ['a', 'a'] }), {
    code: 'action_candidate_preconditions_invalid',
  });
  assert.throws(() => sealActionCandidateV1({ ...candidatePayload(), unknown: true }), {
    code: 'action_candidate_invalid',
  });
});

test('candidate count and byte budgets are hard limits', () => {
  const a = candidate({ candidateId: 'candidate:a' });
  const b = candidate({ candidateId: 'candidate:b' });
  assert.throws(() => route([a, b], { planningRequest: { candidateLimit: 1 } }), {
    code: 'candidate_collection_invalid',
  });
  assert.throws(() => route([candidate({ singletonReason: 'only_feasible_candidate' })], {
    planningRequest: { maximumCandidateBytes: 256, maximumTotalCandidateBytes: 256 },
  }), { code: 'action_candidate_byte_limit' });
  const largeA = candidate({ candidateId: 'candidate:a', value: { note: 'x'.repeat(3000) } });
  const largeB = candidate({ candidateId: 'candidate:b', value: { note: 'y'.repeat(3000) } });
  assert.throws(() => route([largeA, largeB], {
    planningRequest: { maximumCandidateBytes: 4096, maximumTotalCandidateBytes: 4096 },
  }), { code: 'candidate_collection_byte_limit' });
});

test('objective, constraint and price identities change request/frontier hashes', () => {
  const base = route([]);
  const objective = route([], { planningRequest: { objectiveVersion: 'objective-v2' } });
  const constraints = route([], { planningRequest: { hardConstraintSetHash: hash('f') } });
  const prices = route([], { planningRequest: { resourcePriceSnapshotHash: hash('0') } });
  assert.notEqual(base.planningRequestHash, objective.planningRequestHash);
  assert.notEqual(base.planningRequestHash, constraints.planningRequestHash);
  assert.notEqual(base.planningRequestHash, prices.planningRequestHash);
  assert.notEqual(base.candidateFrontierHash, objective.candidateFrontierHash);
});

test('captured results cannot be changed by caller mutation', () => {
  const mutableModules = JSON.parse(JSON.stringify(modules));
  const mutableCandidate = JSON.parse(JSON.stringify(candidate({ singletonReason: 'only_feasible_candidate' })));
  const mutableRequest = planningRequest();
  const result = routeActionCandidatesV1({ planningRequest: mutableRequest,
    qualifiedModules: mutableModules, candidates: [mutableCandidate], observedAt });
  const identity = result.candidateFrontierHash;
  mutableModules[0].moduleVersion = '9.9.9';
  mutableCandidate.value.scientificValue = -100;
  mutableRequest.objectiveVersion = 'mutated';
  assert.equal(result.candidateFrontierHash, identity);
  assert.equal(result.candidates[0].moduleVersion, '1.0.0');
  assert.throws(() => { result.candidates[0].value.scientificValue = 0; }, TypeError);
});

test('empty frontiers are explicit and cyclic/deep values are rejected', () => {
  const result = route([]);
  assert.equal(result.status, 'candidate_frontier_empty');
  assert.equal(result.candidateCount, 0);
  const cyclic = {}; cyclic.self = cyclic;
  assert.throws(() => candidate({ value: cyclic }), { code: 'candidate_value_cycle' });
  let deep = {};
  for (let index = 0; index < 30; index += 1) deep = { next: deep };
  assert.throws(() => candidate({ value: deep }), { code: 'candidate_value_structure_limit' });
});
