import assert from 'node:assert/strict';
import test from 'node:test';
import {
  actionCandidatePayloadHash,
  planningRequestHash,
  qualifiedModuleRegistrySnapshotHash,
  routeActionCandidates,
} from '../../paper-application/orchestration/candidate-router.mjs';

const H = (character) => `sha256:${character.repeat(64)}`;
const nowEpochMs = Date.parse('2026-09-05T00:00:00.000Z');

function moduleBinding(moduleId = 'module.author-node', overrides = {}) {
  return {
    moduleId,
    moduleVersion: '1.0.0',
    protocolMinimum: 1,
    protocolMaximum: 1,
    capabilityIds: ['CAP-AUTHOR'],
    qualificationStatus: 'source_qualified',
    qualificationEvidenceHash: H('a'),
    ...overrides,
  };
}
function registry(modules = [moduleBinding()]) {
  const draft = { version: 1, kind: 'QualifiedModuleRegistrySnapshotV1', modules };
  return { ...draft, snapshotHash: qualifiedModuleRegistrySnapshotHash(draft) };
}
function request(moduleRegistrySnapshotHash, overrides = {}) {
  return {
    schemaVersion: 1,
    kind: 'PlanningRequestV1',
    planningRequestId: 'plan-request-1',
    stateSnapshotHash: H('1'),
    moduleRegistrySnapshotHash,
    capabilityId: 'CAP-AUTHOR',
    hardConstraintSetHash: H('2'),
    objectiveVersion: 'objective-v1',
    resourcePriceSnapshotHash: H('3'),
    candidateLimit: 32,
    candidateBytesLimit: 1024 * 1024,
    deadline: '2026-09-05T02:00:00.000Z',
    allowedSideEffectClasses: ['none'],
    goalRef: 'artifact:goal-v1',
    policyRef: 'artifact:policy-v1',
    inputArtifactHashes: [H('4')],
    ...overrides,
  };
}
function candidate(id, overrides = {}) {
  const draft = {
    schemaVersion: 1,
    kind: 'ActionCandidateV1',
    candidateId: id,
    planningRequestId: 'plan-request-1',
    stateSnapshotHash: H('1'),
    moduleId: 'module.author-node',
    moduleVersion: '1.0.0',
    capabilityId: 'CAP-AUTHOR',
    resourceVector: {
      cpuUnits: 1,
      gpuUnits: 0,
      memoryMiB: 256,
      storageBytes: 1024,
      tokenCount: 100,
      maximumCostMicrousd: 10,
    },
    duration: { lowerMs: 10, expectedMs: 20, upperMs: 30 },
    cost: { expectedMicrousd: 5, upperMicrousd: 10 },
    value: { evidenceGain: 1, scientificValue: 2 },
    risk: { failureProbabilityPpm: 1 },
    preconditions: ['snapshot-current'],
    dependencyEffects: ['artifact:author-draft'],
    sideEffectClass: 'none',
    irreversibleBoundary: null,
    rollbackClass: 'discard_prepared_result',
    expiresAt: '2026-09-05T01:00:00.000Z',
    inputSchema: 'schema:author-input-v1',
    outputSchema: 'schema:author-output-v1',
    singletonReason: null,
    ...overrides,
  };
  const withoutHash = { ...draft };
  delete withoutHash.candidatePayloadHash;
  return { ...draft, candidatePayloadHash: actionCandidatePayloadHash(withoutHash) };
}
function run(candidates, options = {}) {
  const moduleRegistry = options.moduleRegistry || registry();
  const planningRequest = options.planningRequest || request(moduleRegistry.snapshotHash);
  return routeActionCandidates({ planningRequest, moduleRegistry, candidates,
    nowEpochMs: options.nowEpochMs ?? nowEpochMs });
}

test('candidate order and unordered request/module sets do not change the frontier hash', () => {
  const modulesA = [moduleBinding('module.author-node'), moduleBinding('module.alt-author', {
    moduleVersion: '2.0.0', capabilityIds: ['CAP-OTHER', 'CAP-AUTHOR'],
    qualificationEvidenceHash: H('b'),
  })];
  const modulesB = [
    { ...modulesA[1], capabilityIds: ['CAP-AUTHOR', 'CAP-OTHER'] },
    modulesA[0],
  ];
  const registryA = registry(modulesA);
  const registryB = registry(modulesB);
  assert.equal(registryA.snapshotHash, registryB.snapshotHash);
  const planningA = request(registryA.snapshotHash, {
    allowedSideEffectClasses: ['workspace_write', 'none'],
    inputArtifactHashes: [H('5'), H('4')],
  });
  const planningB = request(registryB.snapshotHash, {
    allowedSideEffectClasses: ['none', 'workspace_write'],
    inputArtifactHashes: [H('4'), H('5')],
  });
  const a = candidate('a');
  const b = candidate('b', { dependencyEffects: ['artifact:b'] });
  const left = routeActionCandidates({ planningRequest: planningA, moduleRegistry: registryA,
    candidates: [b, a], nowEpochMs });
  const right = routeActionCandidates({ planningRequest: planningB, moduleRegistry: registryB,
    candidates: [a, b], nowEpochMs });
  assert.equal(left.candidateSetHash, right.candidateSetHash);
  assert.deepEqual(left.candidates.map((item) => item.candidateId), ['a', 'b']);
});

test('contextually different candidates survive even when one is locally cheaper and higher value', () => {
  const locallyDominant = candidate('dominant', {
    resourceVector: { cpuUnits: 1, gpuUnits: 0, memoryMiB: 64, storageBytes: 1 },
    cost: { expectedMicrousd: 1 }, value: { scientificValue: 10 },
    dependencyEffects: ['requires:unavailable-expensive-dependency'],
  });
  const globallyFeasible = candidate('feasible', {
    resourceVector: { cpuUnits: 2, gpuUnits: 0, memoryMiB: 128, storageBytes: 2 },
    cost: { expectedMicrousd: 2 }, value: { scientificValue: 9 },
    dependencyEffects: [],
  });
  const result = run([locallyDominant, globallyFeasible]);
  assert.equal(result.dominanceReductionApplied, false);
  assert.deepEqual(result.candidates.map((item) => item.candidateId), ['dominant', 'feasible']);
});

test('semantic duplicates choose the lexical candidate id and retain an audit record', () => {
  const a = candidate('a', { singletonReason: 'only_feasible_candidate' });
  const z = candidate('z', { singletonReason: 'only_feasible_candidate' });
  const result = run([z, a]);
  assert.equal(result.canonicalCandidateCount, 1);
  assert.equal(result.candidates[0].candidateId, 'a');
  assert.deepEqual(result.deduplications[0].removedCandidateIds, ['z']);
});

test('exact retransmission is idempotently collapsed', () => {
  const only = candidate('only', { singletonReason: 'only_feasible_candidate' });
  const result = run([only, structuredClone(only)]);
  assert.equal(result.exactDuplicateCount, 1);
  assert.equal(result.canonicalCandidateCount, 1);
});

test('same candidate id with different payload is rejected', () => {
  const left = candidate('same');
  const right = candidate('same', { dependencyEffects: ['different'] });
  assert.throws(() => run([left, right]), { code: 'candidate_id_conflict' });
});

test('candidate payload hash is recomputed from canonical captured content', () => {
  const value = candidate('bad');
  value.candidatePayloadHash = H('f');
  assert.throws(() => run([value]), { code: 'candidate_payload_hash_mismatch' });
});

test('top-level and nested accessors are rejected without executing getters', () => {
  let calls = 0;
  const top = candidate('getter');
  Object.defineProperty(top, 'moduleId', { enumerable: true,
    get() { calls += 1; return 'module.author-node'; } });
  assert.throws(() => run([top]), { code: 'action_candidate_invalid' });
  const nested = candidate('nested');
  nested.value = Object.defineProperty({}, 'scientificValue', { enumerable: true,
    get() { calls += 1; return 2; } });
  assert.throws(() => run([nested]), { code: 'candidate_nested_record_invalid' });
  assert.equal(calls, 0);
});

test('request, snapshot, capability and registry bindings are exact', () => {
  const moduleRegistry = registry();
  for (const changed of [
    { planningRequestId: 'other' },
    { stateSnapshotHash: H('9') },
    { capabilityId: 'CAP-OTHER' },
  ]) {
    const value = candidate('x', changed);
    value.candidatePayloadHash = actionCandidatePayloadHash(
      Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'candidatePayloadHash')),
    );
    assert.throws(() => run([value], { moduleRegistry,
      planningRequest: request(moduleRegistry.snapshotHash) }));
  }
  assert.throws(() => run([candidate('x')], {
    moduleRegistry,
    planningRequest: request(H('9')),
  }), { code: 'planning_registry_snapshot_mismatch' });
});

test('only exact qualified module version and declared capability may produce candidates', () => {
  const value = candidate('x');
  const wrongVersion = candidate('x', { moduleVersion: '2.0.0' });
  assert.throws(() => run([wrongVersion]), { code: 'candidate_module_binding_mismatch' });
  const unqualified = { version: 1, kind: 'QualifiedModuleRegistrySnapshotV1',
    modules: [moduleBinding('module.author-node', { qualificationStatus: 'design_ready' })],
    snapshotHash: H('9') };
  assert.throws(() => routeActionCandidates({ planningRequest: request(unqualified.snapshotHash),
    moduleRegistry: unqualified, candidates: [value], nowEpochMs }),
  { code: 'candidate_module_not_qualified' });
  const wrongCapability = registry([moduleBinding('module.author-node', {
    capabilityIds: ['CAP-OTHER'],
  })]);
  assert.throws(() => routeActionCandidates({ planningRequest: request(wrongCapability.snapshotHash),
    moduleRegistry: wrongCapability, candidates: [value], nowEpochMs }),
  { code: 'candidate_module_capability_mismatch' });
});

test('expired requests, expired candidates and candidates outliving the request are denied', () => {
  const moduleRegistry = registry();
  const planningRequest = request(moduleRegistry.snapshotHash);
  assert.throws(() => routeActionCandidates({ planningRequest, moduleRegistry,
    candidates: [candidate('x')], nowEpochMs: Date.parse(planningRequest.deadline) }),
  { code: 'planning_request_expired' });
  assert.throws(() => run([candidate('x', { expiresAt: '2026-09-04T23:59:59.999Z' })]),
    { code: 'candidate_expired_or_outlives_request' });
  assert.throws(() => run([candidate('x', { expiresAt: '2026-09-05T03:00:00.000Z' })]),
    { code: 'candidate_expired_or_outlives_request' });
});

test('side effects not explicitly allowed by the planning request are denied', () => {
  assert.throws(() => run([candidate('x', { sideEffectClass: 'external_effect' })]),
    { code: 'candidate_side_effect_forbidden' });
});

test('resource and nested numeric values reject NaN, infinity, negative and unsafe integers', () => {
  for (const resourceVector of [
    { cpuUnits: NaN, gpuUnits: 0, memoryMiB: 1, storageBytes: 1 },
    { cpuUnits: Infinity, gpuUnits: 0, memoryMiB: 1, storageBytes: 1 },
    { cpuUnits: -1, gpuUnits: 0, memoryMiB: 1, storageBytes: 1 },
    { cpuUnits: 1, gpuUnits: 0, memoryMiB: 0.5, storageBytes: 1 },
    { cpuUnits: 1, gpuUnits: 0, memoryMiB: 1, storageBytes: Number.MAX_SAFE_INTEGER + 1 },
  ]) assert.throws(() => candidate('x', { resourceVector }));
  assert.throws(() => candidate('x', { value: { score: Infinity } }),
    { code: 'candidate_nested_number_invalid' });
});

test('candidate count and canonical byte budgets are hard limits', () => {
  const moduleRegistry = registry();
  const limited = request(moduleRegistry.snapshotHash, { candidateLimit: 1 });
  assert.throws(() => routeActionCandidates({ planningRequest: limited, moduleRegistry,
    candidates: [candidate('a'), candidate('b')], nowEpochMs }),
  { code: 'candidate_collection_invalid' });
  const byteLimited = request(moduleRegistry.snapshotHash, { candidateBytesLimit: 1 });
  assert.throws(() => routeActionCandidates({ planningRequest: byteLimited, moduleRegistry,
    candidates: [candidate('a', { singletonReason: 'only_feasible_candidate' })], nowEpochMs }),
  { code: 'candidate_collection_byte_limit' });
});

test('one canonical candidate per module requires an explicit singleton reason', () => {
  assert.throws(() => run([candidate('only')]), { code: 'candidate_singleton_reason_required' });
  assert.doesNotThrow(() => run([candidate('only', {
    singletonReason: 'protocol_does_not_support_alternatives',
  })]));
  assert.throws(() => run([
    candidate('a', { singletonReason: 'only_feasible_candidate' }),
    candidate('b', { dependencyEffects: ['different'] }),
  ]), { code: 'candidate_singleton_reason_conflict' });
});

test('planning identity changes when constraints, objective or prices change', () => {
  const moduleRegistry = registry();
  const base = request(moduleRegistry.snapshotHash);
  const original = planningRequestHash(base);
  for (const changed of [
    { hardConstraintSetHash: H('8') },
    { objectiveVersion: 'objective-v2' },
    { resourcePriceSnapshotHash: H('7') },
  ]) assert.notEqual(planningRequestHash({ ...base, ...changed }), original);
});

test('captured frontier is immutable and unaffected by caller mutation', () => {
  const raw = candidate('only', { singletonReason: 'only_feasible_candidate' });
  const result = run([raw]);
  raw.value.scientificValue = 999;
  raw.resourceVector.cpuUnits = 999;
  assert.equal(result.candidates[0].value.scientificValue, 2);
  assert.equal(result.candidates[0].resourceVector.cpuUnits, 1);
  assert.throws(() => { result.candidates[0].value.scientificValue = 3; }, TypeError);
  assert.throws(() => { result.candidates.push(raw); }, TypeError);
});

test('sparse arrays, duplicate set values and unknown fields fail closed', () => {
  const sparse = [];
  sparse.length = 1;
  assert.throws(() => run(sparse), { code: 'candidate_collection_invalid' });
  const duplicateSet = candidate('x');
  delete duplicateSet.candidatePayloadHash;
  duplicateSet.preconditions = ['same', 'same'];
  assert.throws(() => actionCandidatePayloadHash(duplicateSet),
    { code: 'candidate_preconditions_invalid' });
  const unknown = candidate('x');
  unknown.credential = 'must-not-be-accepted';
  assert.throws(() => run([unknown]), { code: 'action_candidate_invalid' });
});

test('empty frontiers and non-explicit clocks fail closed', () => {
  assert.throws(() => run([]), { code: 'candidate_frontier_empty' });
  const moduleRegistry = registry();
  assert.throws(() => routeActionCandidates({ planningRequest: request(moduleRegistry.snapshotHash),
    moduleRegistry, candidates: [candidate('x', { singletonReason: 'only_feasible_candidate' })],
    nowEpochMs: Date.now() + 0.5 }), { code: 'candidate_router_clock_invalid' });
});

test('router input accessors are rejected before executing getters', () => {
  const moduleRegistry = registry();
  let calls = 0;
  const input = {
    planningRequest: request(moduleRegistry.snapshotHash),
    moduleRegistry,
    candidates: [candidate('only', { singletonReason: 'only_feasible_candidate' })],
    nowEpochMs,
  };
  Object.defineProperty(input, 'candidates', { enumerable: true,
    get() { calls += 1; return []; } });
  assert.throws(() => routeActionCandidates(input), { code: 'candidate_router_input_invalid' });
  assert.equal(calls, 0);
});

test('semantic duplicate metadata conflicts fail instead of choosing an arbitrary reason', () => {
  const a = candidate('a', { singletonReason: 'only_feasible_candidate' });
  const b = candidate('b', { singletonReason: 'protocol_does_not_support_alternatives' });
  assert.throws(() => run([a, b]), { code: 'candidate_semantic_metadata_conflict' });
});

test('frontier exposes the exact qualified module binding set and a no-dominance reason', () => {
  const result = run([candidate('only', { singletonReason: 'only_feasible_candidate' })]);
  assert.equal(result.moduleBindings.length, 1);
  assert.equal(result.moduleBindings[0].moduleId, 'module.author-node');
  assert.equal(result.moduleBindings[0].qualificationEvidenceHash, H('a'));
  assert.equal(result.dominanceReductionApplied, false);
  assert.equal(result.dominanceReductionReason, 'context_substitutability_not_proven');
});

test('planning request must explicitly permit at least one side-effect class', () => {
  const moduleRegistry = registry();
  assert.throws(() => routeActionCandidates({
    planningRequest: request(moduleRegistry.snapshotHash, { allowedSideEffectClasses: [] }),
    moduleRegistry,
    candidates: [candidate('only', { singletonReason: 'only_feasible_candidate' })],
    nowEpochMs,
  }), { code: 'planning_side_effect_classes_invalid' });
});


test('frontier hash binds exact module qualification evidence', () => {
  const firstRegistry = registry([moduleBinding()]);
  const secondRegistry = registry([moduleBinding('module.author-node', {
    qualificationEvidenceHash: H('b'),
  })]);
  const first = routeActionCandidates({
    planningRequest: request(firstRegistry.snapshotHash),
    moduleRegistry: firstRegistry,
    candidates: [candidate('only', { singletonReason: 'only_feasible_candidate' })],
    nowEpochMs,
  });
  const second = routeActionCandidates({
    planningRequest: request(secondRegistry.snapshotHash),
    moduleRegistry: secondRegistry,
    candidates: [candidate('only', { singletonReason: 'only_feasible_candidate' })],
    nowEpochMs,
  });
  assert.notEqual(first.moduleBindingSetHash, second.moduleBindingSetHash);
  assert.notEqual(first.candidateSetHash, second.candidateSetHash);
});

test('one hundred deterministic input permutations produce one frontier identity', () => {
  const source = [
    candidate('a', { dependencyEffects: ['a'] }),
    candidate('b', { dependencyEffects: ['b'] }),
    candidate('c', { dependencyEffects: ['c'] }),
    candidate('d', { dependencyEffects: ['d'] }),
  ];
  let seed = 914_207;
  const random = () => {
    seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
    return seed;
  };
  const hashes = new Set();
  for (let iteration = 0; iteration < 100; iteration += 1) {
    const shuffled = source.map((item) => structuredClone(item));
    for (let index = shuffled.length - 1; index > 0; index -= 1) {
      const target = random() % (index + 1);
      [shuffled[index], shuffled[target]] = [shuffled[target], shuffled[index]];
    }
    hashes.add(run(shuffled).candidateSetHash);
  }
  assert.equal(hashes.size, 1);
});
