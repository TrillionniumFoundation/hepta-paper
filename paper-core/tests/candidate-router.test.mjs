import assert from 'node:assert/strict';
import test from 'node:test';
import {
  hashActionCandidateV1,
  routeActionCandidates,
  verifyCandidateFrontierV1,
} from '../../paper-application/orchestration/candidate-router.mjs';

const H = (c) => `sha256:${c.repeat(64)}`;
const request = (overrides = {}) => ({
  schemaVersion: 1,
  kind: 'PlanningRequestV1',
  planningRequestId: 'request-1',
  stateSnapshotHash: H('a'),
  capabilityId: 'CAP-TEST',
  hardConstraintSetHash: H('b'),
  objectiveVersion: 'objective.v1',
  resourcePriceSnapshotHash: H('c'),
  candidateLimit: 16,
  createdAt: '2026-09-06T00:00:00Z',
  expiresAt: '2026-09-06T01:00:00Z',
  allowedSideEffectClasses: ['none'],
  inputArtifactHashes: [],
  ...overrides,
});
const moduleBinding = (overrides = {}) => ({
  moduleId: 'module.test',
  moduleVersion: '1.0.0',
  capabilityIds: ['CAP-TEST'],
  qualificationSubjectHash: H('d'),
  ...overrides,
});
function body(id = 'candidate-a', overrides = {}) {
  return {
    schemaVersion: 1,
    kind: 'ActionCandidateV1',
    candidateId: id,
    planningRequestId: 'request-1',
    stateSnapshotHash: H('a'),
    moduleId: 'module.test',
    moduleVersion: '1.0.0',
    capabilityId: 'CAP-TEST',
    resourceVector: { cpuUnits: 1, gpuUnits: 0, memoryMiB: 128, storageBytes: 0 },
    duration: { maximumMs: 1000 },
    cost: { maximumMicrousd: 0 },
    value: { expectedMicrounits: 1 },
    risk: { maximumFailureMicrounits: 0 },
    preconditions: [],
    dependencyEffects: [],
    sideEffectClass: 'none',
    rollbackClass: 'none',
    expiresAt: '2026-09-06T00:30:00Z',
    ...overrides,
  };
}
function candidate(id = 'candidate-a', overrides = {}) {
  const value = body(id, overrides);
  return { ...value, candidatePayloadHash: hashActionCandidateV1({ candidate: value }) };
}
function input(candidates = [candidate()], overrides = {}) {
  return { planningRequest: request(), candidates, qualifiedModules: [moduleBinding()],
    now: '2026-09-06T00:10:00Z', ...overrides };
}

test('frontier is deterministic, self-verifying and deeply captured', () => {
  const a = candidate('a'); const b = candidate('b', { value: { expectedMicrounits: 2 } });
  const left = routeActionCandidates(input([a, b]));
  const right = routeActionCandidates(input([b, a]));
  assert.deepEqual(left, right);
  assert.deepEqual(verifyCandidateFrontierV1(left), left);
  assert.equal(left.dominanceReductionApplied, false);
  assert.ok(Object.isFrozen(left.candidates));
});

test('context-sensitive locally dominated candidates are retained', () => {
  const strong = candidate('strong', { dependencyEffects: ['expensive-dependency'], value: { score: 10 } });
  const weak = candidate('weak', { dependencyEffects: [], value: { score: 9 },
    resourceVector: { cpuUnits: 2, gpuUnits: 0, memoryMiB: 128, storageBytes: 0 } });
  assert.equal(routeActionCandidates(input([strong, weak])).candidateCount, 2);
});

test('exact duplicates are idempotent but identity conflicts are denied', () => {
  const a = candidate('a', { singletonReason: 'only_feasible_candidate' });
  assert.equal(routeActionCandidates(input([a, structuredClone(a)])).candidateCount, 1);
  const changed = candidate('a', { value: { expectedMicrounits: 99 } });
  assert.throws(() => routeActionCandidates(input([a, changed])), /candidate_id_conflict/);
  assert.throws(() => routeActionCandidates(input([a, { ...changed,
    candidateId: 'other', candidatePayloadHash: a.candidatePayloadHash }])), /candidate_payload_hash_invalid|candidate_hash_conflict/);
});

test('singletons require an exact reason and multi-candidate sets forbid it', () => {
  assert.throws(() => routeActionCandidates(input([candidate('a')])), /singleton_reason_required/);
  const only = candidate('a', { singletonReason: 'only_feasible_candidate' });
  assert.equal(routeActionCandidates(input([only])).candidateCount, 1);
  assert.throws(() => routeActionCandidates(input([only, candidate('b')])), /singleton_reason_forbidden/);
});

test('request, snapshot, capability, module and side-effect bindings are exact', () => {
  for (const value of [
    candidate('a', { planningRequestId: 'other' }),
    candidate('a', { stateSnapshotHash: H('9') }),
    candidate('a', { capabilityId: 'CAP-OTHER' }),
    candidate('a', { moduleVersion: '2.0.0' }),
    candidate('a', { sideEffectClass: 'network' }),
  ]) assert.throws(() => routeActionCandidates(input([value])));
});

test('time windows reject future requests, expired requests and candidates', () => {
  assert.throws(() => routeActionCandidates(input([candidate('a', { singletonReason: 'only_feasible_candidate' })],
    { planningRequest: request({ createdAt: '2026-09-06T00:20:00Z' }) })), /not_current/);
  assert.throws(() => routeActionCandidates(input([candidate('a', { singletonReason: 'only_feasible_candidate' })],
    { now: '2026-09-06T01:00:00Z' })), /not_current/);
  assert.throws(() => routeActionCandidates(input([candidate('a', { expiresAt: '2026-09-06T00:05:00Z',
    singletonReason: 'only_feasible_candidate' })])), /candidate_not_current/);
  assert.throws(() => routeActionCandidates(input([candidate('a', { singletonReason: 'only_feasible_candidate' })],
    { now: '1969-12-31T23:59:59Z' })), /now_invalid/);
});

test('malformed numeric resources and non-JSON values fail closed', () => {
  for (const value of [NaN, Infinity, -1, '1', true]) {
    const raw = body('a', { resourceVector: { cpuUnits: value, gpuUnits: 0,
      memoryMiB: 1, storageBytes: 0 }, singletonReason: 'only_feasible_candidate' });
    assert.throws(() => hashActionCandidateV1({ candidate: raw }));
  }
  const cyclic = {}; cyclic.self = cyclic;
  assert.throws(() => hashActionCandidateV1({ candidate: body('a', { value: cyclic }) }), /cycle/);
});

test('top-level and nested accessors and proxies are rejected without execution', () => {
  let calls = 0;
  const top = Object.defineProperty({}, 'planningRequest', { enumerable: true,
    get() { calls += 1; return request(); } });
  assert.throws(() => routeActionCandidates(top));
  const nested = Object.defineProperty(body('a'), 'value', { enumerable: true,
    get() { calls += 1; return {}; } });
  assert.throws(() => hashActionCandidateV1({ candidate: nested }));
  assert.throws(() => routeActionCandidates(new Proxy(input(), {})));
  assert.equal(calls, 0);
});

test('sparse arrays and duplicate sets are rejected', () => {
  const sparse = []; sparse.length = 2; sparse[1] = candidate('a');
  assert.throws(() => routeActionCandidates(input(sparse)));
  assert.throws(() => routeActionCandidates(input([candidate('a', { singletonReason: 'only_feasible_candidate' })],
    { planningRequest: request({ allowedSideEffectClasses: ['none', 'none'] }) })));
});

test('qualified-module capabilities consume the shared whole-input budget', () => {
  const capabilities = Array.from({ length: 64 }, (_, index) => `CAP-${'x'.repeat(100)}-${index}`);
  assert.throws(() => routeActionCandidates(input([
    candidate('a', { singletonReason: 'only_feasible_candidate' }),
  ], { qualifiedModules: [moduleBinding({ capabilityIds: ['CAP-TEST', ...capabilities] })],
    limits: { maximumInputBytes: 1024, maximumCandidateBytes: 512 } })), /candidate_router_input_limit/);
});

test('module count and capabilities per module are bounded before large capture', () => {
  assert.throws(() => routeActionCandidates(input([
    candidate('a', { singletonReason: 'only_feasible_candidate' }),
  ], { qualifiedModules: [moduleBinding({ capabilityIds: ['CAP-TEST', 'CAP-EXTRA'] })], limits: { maximumModuleBindings: 1,
    maximumCapabilitiesPerModule: 1 },
  })), /module_capabilities_invalid/);
  const many = [moduleBinding(), moduleBinding({ moduleId: 'module.other' })];
  assert.throws(() => routeActionCandidates(input([
    candidate('a', { singletonReason: 'only_feasible_candidate' }),
  ], { qualifiedModules: many, limits: { maximumModuleBindings: 1 } })), /module_bindings_invalid/);
});

test('candidate and total output limits are enforced', () => {
  const huge = candidate('a', { singletonReason: 'only_feasible_candidate',
    value: { text: 'x'.repeat(4096) } });
  assert.throws(() => routeActionCandidates(input([huge], {
    limits: { maximumCandidateBytes: 1024, maximumInputBytes: 8192 },
  })), /candidate_byte_limit|input_limit/);
});

test('planning request identity changes with objective, constraints and price snapshot', () => {
  const one = routeActionCandidates(input([candidate('a', { singletonReason: 'only_feasible_candidate' })]));
  for (const planningRequest of [
    request({ objectiveVersion: 'objective.v2' }),
    request({ hardConstraintSetHash: H('e') }),
    request({ resourcePriceSnapshotHash: H('f') }),
  ]) {
    const raw = body('a', { singletonReason: 'only_feasible_candidate' });
    raw.planningRequestId = planningRequest.planningRequestId;
    raw.stateSnapshotHash = planningRequest.stateSnapshotHash;
    const next = routeActionCandidates({ ...input(), planningRequest,
      candidates: [{ ...raw, candidatePayloadHash: hashActionCandidateV1({ candidate: raw }) }] });
    assert.notEqual(next.planningRequestHash, one.planningRequestHash);
  }
});

test('caller mutation after routing cannot change the captured frontier', () => {
  const raw = candidate('a', { singletonReason: 'only_feasible_candidate' });
  const modules = [moduleBinding()]; const requestValue = request();
  const frontier = routeActionCandidates({ planningRequest: requestValue, candidates: [raw],
    qualifiedModules: modules, now: '2026-09-06T00:10:00Z' });
  raw.value.expectedMicrounits = 999; modules[0].capabilityIds.push('CAP-EVIL');
  requestValue.objectiveVersion = 'objective.evil';
  assert.equal(frontier.candidates[0].value.expectedMicrounits, 1);
  assert.equal(frontier.planningRequest.objectiveVersion, 'objective.v1');
  assert.deepEqual(verifyCandidateFrontierV1(frontier), frontier);
});

test('frontier verification rejects any rehashed or direct mutation', () => {
  const frontier = routeActionCandidates(input([
    candidate('a', { singletonReason: 'only_feasible_candidate' }),
  ]));
  assert.throws(() => verifyCandidateFrontierV1({ ...frontier, candidateCount: 2 }), /verification_mismatch/);
  assert.throws(() => verifyCandidateFrontierV1({ ...frontier,
    authority: { ...frontier.authority, arbitrary: false } }), /authority_invalid/);
});
