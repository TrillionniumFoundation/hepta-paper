import assert from 'node:assert/strict';
import test from 'node:test';
import {
  captureQualifiedModuleSet,
  createCandidateRouter,
  sealActionCandidate,
} from '../../paper-application/orchestration/candidate-router.mjs';

const H1 = `sha256:${'1'.repeat(64)}`;
const H2 = `sha256:${'2'.repeat(64)}`;
const H3 = `sha256:${'3'.repeat(64)}`;
const H4 = `sha256:${'4'.repeat(64)}`;
const OBSERVED = '2026-09-06T00:00:00.000Z';
const CREATED = '2026-09-05T00:00:00.000Z';
const EXPIRES = '2026-09-07T00:00:00.000Z';

function moduleBinding(overrides = {}) {
  return {
    schemaVersion: 1,
    kind: 'QualifiedPlanningModuleV1',
    moduleId: 'module.author-node',
    moduleVersion: '1.0.0',
    protocolVersion: 1,
    capabilityIds: ['CAP-AUTHOR'],
    runtimeIdentityHash: H1,
    qualificationSubjectHash: H2,
    qualificationStatus: 'source_qualified',
    ...overrides,
  };
}

function qualifiedModules(rows = [moduleBinding()]) {
  return captureQualifiedModuleSet(rows).modules;
}

function requestFor(modules = qualifiedModules(), overrides = {}) {
  const set = captureQualifiedModuleSet(modules);
  return {
    schemaVersion: 1,
    kind: 'PlanningRequestV1',
    protocolVersion: 1,
    planningRequestId: 'request-1',
    createdAt: CREATED,
    expiresAt: EXPIRES,
    stateSnapshotHash: H3,
    capabilityId: 'CAP-AUTHOR',
    hardConstraintSetHash: H1,
    objectiveVersion: 'objective-v1',
    resourcePriceSnapshotHash: H4,
    moduleQualificationSetHash: set.moduleQualificationSetHash,
    candidateLimit: 8,
    allowedSideEffectClasses: ['none'],
    ...overrides,
  };
}

function body(id, overrides = {}) {
  return {
    schemaVersion: 1,
    kind: 'ActionCandidateV1',
    candidateId: id,
    planningRequestId: 'request-1',
    stateSnapshotHash: H3,
    moduleId: 'module.author-node',
    moduleVersion: '1.0.0',
    capabilityId: 'CAP-AUTHOR',
    resourceVector: {
      cpuUnits: 1,
      gpuUnits: 0,
      memoryMiB: 128,
      storageBytes: 0,
      tokenCount: 100,
      maximumCostMicrousd: 0,
    },
    duration: { maximumMs: 1000, minimumMs: 10 },
    cost: { maximumMicrousd: 0 },
    value: { expected: 1 },
    risk: { failureProbability: 0.1 },
    preconditions: [],
    dependencyEffects: [],
    sideEffectClass: 'none',
    irreversibleBoundary: null,
    rollbackClass: 'discard_prepared_result',
    expiresAt: EXPIRES,
    inputSchema: null,
    outputSchema: null,
    singletonReason: null,
    ...overrides,
  };
}

function candidate(id, overrides = {}) {
  return sealActionCandidate(body(id, overrides));
}

function route({
  modules = qualifiedModules(),
  request = requestFor(modules),
  candidates = [candidate('b'), candidate('a')],
  observedAt = OBSERVED,
  limits,
} = {}) {
  return createCandidateRouter(limits).route({
    planningRequest: request,
    qualifiedModules: modules,
    candidates,
    observedAt,
  });
}

test('frontier is byte-stable across candidate and module input order', () => {
  const firstModule = moduleBinding();
  const secondModule = moduleBinding({
    moduleId: 'module.reviewer-node',
    moduleVersion: '2.0.0',
    capabilityIds: ['CAP-REVIEW', 'CAP-AUTHOR'],
    runtimeIdentityHash: H4,
  });
  const leftModules = qualifiedModules([secondModule, firstModule]);
  const rightModules = qualifiedModules([firstModule, secondModule]);
  const left = route({
    modules: leftModules,
    request: requestFor(leftModules),
    candidates: [candidate('z'), candidate('a')],
  });
  const right = route({
    modules: rightModules,
    request: requestFor(rightModules),
    candidates: [candidate('a'), candidate('z')],
  });
  assert.deepEqual(left, right);
  assert.deepEqual(left.candidates.map((row) => row.candidateId), ['a', 'z']);
  assert.match(left.candidateSetHash, /^sha256:[0-9a-f]{64}$/u);
});

test('exact duplicate records are idempotently deduplicated', () => {
  const a = candidate('a');
  const b = candidate('b');
  const frontier = route({ candidates: [a, b, a] });
  assert.equal(frontier.candidateCount, 2);
  assert.equal(frontier.duplicateCount, 1);
});

test('same candidate ID with different sealed content fails closed', () => {
  assert.throws(() => route({
    candidates: [
      candidate('same', { value: { expected: 1 } }),
      candidate('same', { value: { expected: 2 } }),
    ],
  }), { code: 'candidate_id_conflict' });
});

test('a producer supplied payload hash is recomputed, not trusted', () => {
  const sealed = candidate('a', { singletonReason: 'only_feasible_candidate' });
  assert.throws(() => route({
    candidates: [{ ...sealed, candidatePayloadHash: H1 }],
  }), { code: 'candidate_payload_hash_invalid' });
});

test('request, snapshot and capability identities must be exact', () => {
  for (const changed of [
    { planningRequestId: 'other' },
    { stateSnapshotHash: H4 },
    { capabilityId: 'CAP-REVIEW' },
  ]) {
    const sealed = sealActionCandidate(body('only', {
      singletonReason: 'only_feasible_candidate',
      ...changed,
    }));
    assert.throws(() => route({ candidates: [sealed] }));
  }
});

test('only an exact qualified module version with the capability is eligible', () => {
  const modules = qualifiedModules();
  for (const changed of [
    { moduleId: 'module.unknown' },
    { moduleVersion: '2.0.0' },
  ]) {
    assert.throws(() => route({
      modules,
      request: requestFor(modules),
      candidates: [sealActionCandidate(body('only', {
        singletonReason: 'only_feasible_candidate',
        ...changed,
      }))],
    }), { code: 'candidate_module_not_qualified' });
  }
  const incapable = qualifiedModules([moduleBinding({ capabilityIds: ['CAP-REVIEW'] })]);
  assert.throws(() => route({
    modules: incapable,
    request: requestFor(incapable),
    candidates: [candidate('only', { singletonReason: 'only_feasible_candidate' })],
  }), { code: 'candidate_module_capability_mismatch' });
});

test('the planning request is bound to the exact qualification set', () => {
  const modules = qualifiedModules();
  assert.throws(() => route({
    modules,
    request: requestFor(modules, { moduleQualificationSetHash: H1 }),
  }), { code: 'planning_request_module_set_mismatch' });
});

test('request and candidate expiry are evaluated against an explicit clock', () => {
  const modules = qualifiedModules();
  assert.throws(() => route({
    modules,
    request: requestFor(modules, { expiresAt: OBSERVED }),
  }), { code: 'planning_request_expired_or_not_current' });
  assert.throws(() => route({
    candidates: [candidate('only', {
      singletonReason: 'only_feasible_candidate',
      expiresAt: '2026-09-05T23:59:59.000Z',
    })],
  }), { code: 'candidate_expired_or_outlives_request' });
  assert.throws(() => route({
    request: requestFor(modules, { expiresAt: '2026-09-06T12:00:00.000Z' }),
    candidates: [candidate('only', {
      singletonReason: 'only_feasible_candidate',
      expiresAt: EXPIRES,
    })],
  }), { code: 'candidate_expired_or_outlives_request' });
});

test('side effects outside the request allowlist are rejected', () => {
  assert.throws(() => route({
    candidates: [candidate('only', {
      singletonReason: 'only_feasible_candidate',
      sideEffectClass: 'provider_call',
    })],
  }), { code: 'candidate_side_effect_not_allowed' });
});

test('resource vectors reject coercion, nonfinite and unsafe values', () => {
  for (const [field, value] of [
    ['cpuUnits', NaN],
    ['gpuUnits', Infinity],
    ['memoryMiB', 0.5],
    ['storageBytes', -1],
    ['tokenCount', Number.MAX_SAFE_INTEGER + 1],
    ['maximumCostMicrousd', '0'],
  ]) {
    assert.throws(() => sealActionCandidate(body('bad', {
      resourceVector: {
        cpuUnits: 1,
        gpuUnits: 0,
        memoryMiB: 1,
        storageBytes: 0,
        tokenCount: 1,
        maximumCostMicrousd: 0,
        [field]: value,
      },
    })));
  }
});

test('accessor properties are rejected without executing getters', () => {
  let calls = 0;
  const hostile = Object.defineProperty(body('hostile'), 'candidateId', {
    enumerable: true,
    get() {
      calls += 1;
      return 'hostile';
    },
  });
  assert.throws(() => sealActionCandidate(hostile), { code: 'action_candidate_invalid' });
  assert.equal(calls, 0);
});

test('sparse arrays, extra array properties and duplicate set members are rejected', () => {
  const sparse = [];
  sparse.length = 1;
  assert.throws(() => captureQualifiedModuleSet(sparse), { code: 'candidate_module_set_invalid' });
  const modules = [moduleBinding()];
  modules.extra = true;
  assert.throws(() => captureQualifiedModuleSet(modules), { code: 'candidate_module_set_invalid' });
  assert.throws(() => captureQualifiedModuleSet([
    moduleBinding({ capabilityIds: ['CAP-AUTHOR', 'CAP-AUTHOR'] }),
  ]), { code: 'candidate_module_binding_invalid' });
});

test('candidate count, candidate bytes and total bytes are independently bounded', () => {
  assert.throws(() => route({
    request: requestFor(qualifiedModules(), { candidateLimit: 1 }),
    candidates: [candidate('a'), candidate('b')],
  }), { code: 'candidate_count_limit' });
  assert.throws(() => sealActionCandidate(body('large', {
    value: { text: 'x'.repeat(3000) },
  }), { maximumCandidateBytes: 1024 }), { code: 'action_candidate_byte_limit' });
  assert.throws(() => route({
    candidates: [candidate('a'), candidate('b')],
    limits: { maximumTotalBytes: 1024, maximumCandidateBytes: 1024 },
  }), { code: 'candidate_router_total_byte_limit' });
});

test('a singleton requires an explicit closed reason and multi-candidate sets reject one', () => {
  assert.throws(() => route({ candidates: [candidate('only')] }), {
    code: 'candidate_singleton_reason_required',
  });
  const one = route({
    candidates: [candidate('only', { singletonReason: 'only_feasible_candidate' })],
  });
  assert.equal(one.candidateCount, 1);
  assert.throws(() => route({
    candidates: [
      candidate('a', { singletonReason: 'only_feasible_candidate' }),
      candidate('b'),
    ],
  }), { code: 'candidate_singleton_reason_invalid' });
});

test('context-distinct candidates are retained even when one looks locally dominated', () => {
  const preferredLocally = candidate('a', {
    value: { expected: 5 },
    cost: { maximumMicrousd: 2 },
    dependencyEffects: ['requires-expensive-dataset'],
  });
  const globallyUseful = candidate('b', {
    value: { expected: 4 },
    cost: { maximumMicrousd: 3 },
    dependencyEffects: [],
  });
  const frontier = route({ candidates: [preferredLocally, globallyUseful] });
  assert.equal(frontier.candidateCount, 2);
  assert.equal(frontier.dominanceReductionApplied, false);
  assert.equal(frontier.dominancePolicy, 'context_replacement_proof_required');
});

test('captured output is immutable and unaffected by later caller mutation', () => {
  const rawValue = { expected: 1, nested: { score: 2 } };
  const sealed = sealActionCandidate(body('only', {
    singletonReason: 'only_feasible_candidate',
    value: rawValue,
  }));
  rawValue.nested.score = 99;
  const frontier = route({ candidates: [sealed] });
  assert.equal(frontier.candidates[0].value.nested.score, 2);
  assert.equal(Object.isFrozen(frontier), true);
  assert.equal(Object.isFrozen(frontier.candidates), true);
  assert.equal(Object.isFrozen(frontier.candidates[0].value.nested), true);
  assert.throws(() => {
    frontier.candidates[0].value.nested.score = 3;
  }, TypeError);
});

test('objective or hard-constraint identity changes the request and set hashes', () => {
  const modules = qualifiedModules();
  const first = route({
    modules,
    request: requestFor(modules),
  });
  const second = route({
    modules,
    request: requestFor(modules, { objectiveVersion: 'objective-v2' }),
  });
  const third = route({
    modules,
    request: requestFor(modules, { hardConstraintSetHash: H2 }),
  });
  assert.notEqual(first.planningRequestHash, second.planningRequestHash);
  assert.notEqual(first.candidateSetHash, second.candidateSetHash);
  assert.notEqual(first.planningRequestHash, third.planningRequestHash);
});

test('empty frontiers and malformed limit policies fail closed', () => {
  assert.throws(() => route({ candidates: [] }), { code: 'candidate_count_limit' });
  for (const limits of [
    null,
    [],
    { maximumCandidates: 0 },
    { maximumDepth: 65 },
    { maximumCandidateBytes: 2048, maximumTotalBytes: 1024 },
    { unknown: 1 },
  ]) {
    assert.throws(() => createCandidateRouter(limits), { code: 'candidate_router_limits_invalid' });
  }
});

test('negative zero is normalized before sealing and hashing', () => {
  const sealed = candidate('only', {
    singletonReason: 'only_feasible_candidate',
    resourceVector: {
      cpuUnits: -0,
      gpuUnits: -0,
      memoryMiB: 0,
      storageBytes: 0,
    },
  });
  assert.equal(Object.is(sealed.resourceVector.cpuUnits, -0), false);
  assert.equal(Object.is(sealed.resourceVector.gpuUnits, -0), false);
});
