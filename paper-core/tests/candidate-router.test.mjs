import assert from 'node:assert/strict';
import test from 'node:test';
import {
  hashActionCandidateV1,
  routeActionCandidates,
} from '../../paper-application/orchestration/candidate-router.mjs';

const H = (character) => `sha256:${character.repeat(64)}`;
const NOW = '2026-09-06T00:00:00.123456789Z';
const REQUEST_EXPIRY = '2026-09-07T00:00:00.000000000Z';

function planningRequest(overrides = {}) {
  return {
    schemaVersion: 1,
    kind: 'PlanningRequestV1',
    planningRequestId: 'planning-1',
    stateSnapshotHash: H('a'),
    capabilityId: 'CAP-MOD-CANDIDATES',
    hardConstraintSetHash: H('b'),
    objectiveVersion: 'objective-v1',
    resourcePriceSnapshotHash: H('c'),
    candidateLimit: 32,
    createdAt: '2026-09-05T00:00:00Z',
    expiresAt: REQUEST_EXPIRY,
    allowedSideEffectClasses: ['none', 'workspace_prepared'],
    inputArtifactHashes: [H('d')],
    ...overrides,
  };
}

function moduleBindings(overrides = {}) {
  return [{
    moduleId: 'module.alpha',
    moduleVersion: '1.2.3',
    capabilityIds: ['CAP-MOD-CANDIDATES'],
    qualificationSubjectHash: H('e'),
    ...overrides,
  }];
}

function candidateBody(overrides = {}) {
  return {
    schemaVersion: 1,
    kind: 'ActionCandidateV1',
    candidateId: 'candidate-a',
    planningRequestId: 'planning-1',
    stateSnapshotHash: H('a'),
    moduleId: 'module.alpha',
    moduleVersion: '1.2.3',
    capabilityId: 'CAP-MOD-CANDIDATES',
    resourceVector: { cpuUnits: 1, gpuUnits: 0, memoryMiB: 64, storageBytes: 0 },
    duration: { maximumMilliseconds: 1000 },
    cost: { maximumMicrousd: 10 },
    value: { expected: 5 },
    risk: { failureProbabilityPpm: 100 },
    preconditions: ['precondition-a'],
    dependencyEffects: ['dependency-a'],
    sideEffectClass: 'none',
    irreversibleBoundary: null,
    rollbackClass: 'pure',
    expiresAt: '2026-09-06T12:00:00.000000000Z',
    inputSchema: null,
    outputSchema: 'schema:output',
    singletonReason: 'only_feasible_candidate',
    ...overrides,
  };
}

function signedCandidate(overrides = {}) {
  const body = candidateBody(overrides);
  return { ...body, candidatePayloadHash: hashActionCandidateV1(body) };
}

function route(candidates, overrides = {}) {
  return routeActionCandidates({
    planningRequest: planningRequest(),
    candidates,
    qualifiedModules: moduleBindings(),
    now: NOW,
    ...overrides,
  });
}

function pair() {
  return [
    signedCandidate({ candidateId: 'candidate-left', singletonReason: null }),
    signedCandidate({ candidateId: 'candidate-right', dependencyEffects: ['dependency-z'],
      singletonReason: null }),
  ];
}

const rejectCode = (operation, code) => assert.throws(operation, { code });

test('frontier is deterministic under candidate and set ordering', () => {
  const first = route(pair());
  const second = route(pair().reverse(), {
    planningRequest: planningRequest({ allowedSideEffectClasses: ['workspace_prepared', 'none'] }),
  });
  assert.equal(first.candidateSetHash, second.candidateSetHash);
  assert.deepEqual(first.candidates, second.candidates);
});

test('dependency-distinct locally dominated candidate remains available globally', () => {
  const locallyBetter = signedCandidate({ candidateId: 'local-better', singletonReason: null,
    value: { expected: 10 }, cost: { maximumMicrousd: 1 },
    dependencyEffects: ['expensive-dependency'] });
  const globallyFeasible = signedCandidate({ candidateId: 'global-feasible', singletonReason: null,
    value: { expected: 9 }, cost: { maximumMicrousd: 2 }, dependencyEffects: [] });
  const result = route([locallyBetter, globallyFeasible]);
  assert.equal(result.candidateCount, 2);
  assert.equal(result.dominanceReductionApplied, false);
  assert.equal(result.dominanceDisposition,
    'retained_without_context_safe_replacement_certificate');
});

test('exact duplicate records are idempotently deduplicated', () => {
  const item = signedCandidate();
  assert.equal(route([item, structuredClone(item)]).candidateCount, 1);
});

test('same candidate id with different valid semantics is rejected', () => {
  const first = signedCandidate({ candidateId: 'same', singletonReason: null });
  const second = signedCandidate({ candidateId: 'same', value: { expected: 7 },
    singletonReason: null });
  rejectCode(() => route([first, second]), 'candidate_id_conflict');
});

test('payload hash is recomputed from captured semantics', () => {
  const item = signedCandidate();
  item.value.expected = 7;
  rejectCode(() => route([item]), 'candidate_payload_hash_invalid');
});

test('one candidate requires a supported singleton reason', () => {
  rejectCode(() => route([signedCandidate({ singletonReason: null })]),
    'candidate_singleton_reason_required');
  assert.equal(route([signedCandidate()]).candidateCount, 1);
});

test('multi-candidate frontier rejects singleton-only claims', () => {
  const first = signedCandidate({ candidateId: 'one' });
  const second = signedCandidate({ candidateId: 'two', dependencyEffects: ['other'] });
  rejectCode(() => route([first, second]), 'candidate_singleton_reason_forbidden');
});

test('planning request id snapshot and capability are exact bindings', () => {
  for (const mutation of [
    { planningRequestId: 'other' },
    { stateSnapshotHash: H('f') },
    { capabilityId: 'CAP-OTHER' },
  ]) rejectCode(() => route([signedCandidate(mutation)]), 'candidate_request_binding_mismatch');
});

test('module id version and capability require an exact qualified binding', () => {
  for (const mutation of [
    { moduleId: 'module.other' },
    { moduleVersion: '9.9.9' },
  ]) rejectCode(() => route([signedCandidate(mutation)]), 'candidate_module_binding_mismatch');
});

test('planning request must be current', () => {
  rejectCode(() => route([signedCandidate()], { now: REQUEST_EXPIRY }),
    'planning_request_not_current');
  rejectCode(() => route([signedCandidate()], {
    planningRequest: planningRequest({ createdAt: '2026-09-07T00:00:00Z' }),
  }), 'planning_request_not_current');
});

test('candidate expiry must be after now and within the request horizon', () => {
  rejectCode(() => route([signedCandidate({ expiresAt: NOW })]), 'candidate_not_current');
  rejectCode(() => route([signedCandidate({ expiresAt: '2026-09-08T00:00:00Z' })]),
    'candidate_not_current');
});

test('strict timestamp parsing rejects normalized-invalid calendar values', () => {
  for (const expiresAt of ['2026-02-30T00:00:00Z', '2026-09-06T24:00:00Z',
    '2026-09-06T00:00:00+00:60', '2026-09-06T00:00:00']) {
    assert.throws(() => signedCandidate({ expiresAt }));
  }
});

test('nanosecond ordering is not truncated to milliseconds', () => {
  assert.equal(route([signedCandidate({
    expiresAt: '2026-09-06T00:00:00.123456790Z',
  })]).candidateCount, 1);
  rejectCode(() => route([signedCandidate({ expiresAt: NOW })]), 'candidate_not_current');
});

test('side-effect class is restricted by the planning request', () => {
  rejectCode(() => route([signedCandidate({ sideEffectClass: 'external_effect' })]),
    'candidate_side_effect_forbidden');
});

test('resource values reject coercion nonfinite negatives and unsafe numbers', () => {
  for (const value of ['1', true, null, NaN, Infinity, -1, Number.MAX_SAFE_INTEGER + 1]) {
    const item = signedCandidate();
    item.resourceVector.cpuUnits = value;
    assert.throws(() => route([item]));
  }
  const fractional = signedCandidate();
  fractional.resourceVector.memoryMiB = 1.5;
  assert.throws(() => route([fractional]));
});

test('resource vectors reject unknown and missing dimensions', () => {
  const unknown = signedCandidate();
  unknown.resourceVector.magic = 1;
  assert.throws(() => route([unknown]));
  const missing = signedCandidate();
  delete missing.resourceVector.storageBytes;
  assert.throws(() => route([missing]));
});

test('top-level and nested accessors are rejected without invocation', () => {
  let calls = 0;
  const top = signedCandidate();
  Object.defineProperty(top, 'moduleId', { enumerable: true,
    get() { calls += 1; return 'module.alpha'; } });
  assert.throws(() => route([top]));
  const nested = signedCandidate();
  Object.defineProperty(nested.value, 'expected', { enumerable: true,
    get() { calls += 1; return 5; } });
  assert.throws(() => route([nested]));
  assert.equal(calls, 0);
});

test('cyclic values are rejected by the router before hash comparison', () => {
  const item = signedCandidate();
  const cyclic = {};
  cyclic.self = cyclic;
  item.value = cyclic;
  rejectCode(() => route([item]), 'candidate_value_cycle');
});

test('sparse arrays and duplicate set members fail closed', () => {
  const sparse = signedCandidate();
  sparse.dependencyEffects = [];
  sparse.dependencyEffects.length = 2;
  sparse.dependencyEffects[1] = 'x';
  assert.throws(() => route([sparse]));
  assert.throws(() => signedCandidate({ dependencyEffects: ['x', 'x'] }));
});

test('candidate count obeys both request and router limits', () => {
  const rows = Array.from({ length: 3 }, (_, index) => signedCandidate({
    candidateId: `candidate-${index}`, dependencyEffects: [`dependency-${index}`],
    singletonReason: null,
  }));
  assert.throws(() => route(rows, {
    planningRequest: planningRequest({ candidateLimit: 2 }),
  }));
  assert.throws(() => route(rows, { limits: { maximumCandidates: 2 } }));
});

test('per-candidate and aggregate bytes are bounded', () => {
  assert.throws(() => route([signedCandidate({ value: { text: 'x'.repeat(4096) } })], {
    limits: { maximumCandidateBytes: 512, maximumTotalBytes: 4096 },
  }));
  assert.throws(() => route(pair(), {
    limits: { maximumCandidateBytes: 1024, maximumTotalBytes: 1024 },
  }));
});

test('nested depth and aggregate collection cardinality are bounded', () => {
  let nested = 0;
  for (let index = 0; index < 8; index += 1) nested = { nested };
  assert.throws(() => route([signedCandidate({ value: nested })], {
    limits: { maximumDepth: 4 },
  }));
  assert.throws(() => route([signedCandidate({ value: Array(20).fill(0) })], {
    limits: { maximumCollectionItems: 8 },
  }));
});

test('unknown candidate request module and limit fields are rejected', () => {
  assert.throws(() => route([{ ...signedCandidate(), unknown: true }]));
  assert.throws(() => route([signedCandidate()], {
    planningRequest: { ...planningRequest(), unknown: true },
  }));
  assert.throws(() => route([signedCandidate()], {
    qualifiedModules: [{ ...moduleBindings()[0], unknown: true }],
  }));
  assert.throws(() => route([signedCandidate()], { limits: { unknown: 1 } }));
});

test('objective and hard-constraint changes alter request and frontier identity', () => {
  const first = route([signedCandidate()]);
  const objective = route([signedCandidate()], {
    planningRequest: planningRequest({ objectiveVersion: 'objective-v2' }),
  });
  const constraints = route([signedCandidate()], {
    planningRequest: planningRequest({ hardConstraintSetHash: H('f') }),
  });
  assert.notEqual(first.planningRequestHash, objective.planningRequestHash);
  assert.notEqual(first.planningRequestHash, constraints.planningRequestHash);
  assert.notEqual(first.candidateSetHash, objective.candidateSetHash);
});

test('qualification subject participates in frontier identity', () => {
  const first = route([signedCandidate()]);
  const second = route([signedCandidate()], {
    qualifiedModules: moduleBindings({ qualificationSubjectHash: H('f') }),
  });
  assert.notEqual(first.moduleBindingSetHash, second.moduleBindingSetHash);
  assert.notEqual(first.candidateSetHash, second.candidateSetHash);
});

test('captured output is deeply immutable and detached from caller mutation', () => {
  const raw = signedCandidate();
  const result = route([raw]);
  const priorHash = result.candidateSetHash;
  raw.value.expected = 999;
  raw.resourceVector.memoryMiB = 999;
  assert.equal(result.candidates[0].value.expected, 5);
  assert.equal(result.candidates[0].resourceVector.memoryMiB, 64);
  assert.equal(result.candidateSetHash, priorHash);
  assert.throws(() => { result.candidates[0].value.expected = 7; }, TypeError);
  assert.throws(() => { result.candidates.push(raw); }, TypeError);
});

test('UTF-8 byte ordering is stable for non-ASCII candidate content', () => {
  const rows = [
    signedCandidate({ candidateId: 'candidate-z', dependencyEffects: ['ä'], singletonReason: null }),
    signedCandidate({ candidateId: 'candidate-a', dependencyEffects: ['z'], singletonReason: null }),
  ];
  assert.equal(route(rows).candidateSetHash, route(rows.reverse()).candidateSetHash);
});

test('candidate collections reject symbolic members and non-array imitations', () => {
  const symbolic = [signedCandidate()];
  symbolic[Symbol('extra')] = true;
  assert.throws(() => route(symbolic));
  const imitation = Object.create(Array.prototype);
  imitation.length = 1;
  imitation[0] = signedCandidate();
  assert.throws(() => route(imitation));
});

test('module bindings reject duplicates and empty capability sets', () => {
  assert.throws(() => route([signedCandidate()], {
    qualifiedModules: [...moduleBindings(), ...moduleBindings()],
  }));
  assert.throws(() => route([signedCandidate()], {
    qualifiedModules: moduleBindings({ capabilityIds: [] }),
  }));
});

test('authority result is explicitly nonactivating', () => {
  const result = route([signedCandidate()]);
  assert.equal(result.status, 'complete_deterministic_frontier');
  assert.ok(Object.values(result.authority).every((value) => value === false));
});

test('API request and limit accessors are rejected before execution', () => {
  let calls = 0;
  const envelope = Object.defineProperty({}, 'planningRequest', { enumerable: true,
    get() { calls += 1; return planningRequest(); } });
  assert.throws(() => routeActionCandidates(envelope));
  const request = planningRequest();
  Object.defineProperty(request, 'planningRequestId', { enumerable: true,
    get() { calls += 1; return 'planning-1'; } });
  assert.throws(() => route([signedCandidate()], { planningRequest: request }));
  const limits = Object.defineProperty({}, 'maximumCandidates', { enumerable: true,
    get() { calls += 1; return 2; } });
  assert.throws(() => route([signedCandidate()], { limits }));
  assert.equal(calls, 0);
});
