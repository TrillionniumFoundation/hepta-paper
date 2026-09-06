import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildControlPlaneSnapshotV1,
  captureQualifiedProjectionSourceSetV1,
  revalidateControlPlaneSnapshotV1,
  sealReadOnlyProjectionV1,
} from '../../paper-application/orchestration/control-plane-snapshot-builder.mjs';
import {
  captureQualifiedPlanningModuleSetV1,
  sealActionCandidateV1,
} from '../../paper-application/orchestration/candidate-router.mjs';
import { collectCandidateBatchesV1 }
  from '../../paper-application/orchestration/candidate-batch-collector.mjs';
import {
  sealBoundedPlanSelectionProblemV1,
} from '../../paper-application/orchestration/bounded-plan-selection-contract.mjs';
import { selectBoundedPlanV1 }
  from '../../paper-application/orchestration/bounded-plan-selector.mjs';

const hash = (character) => `sha256:${character.repeat(64)}`;
const modules = [
  { moduleId: 'module.author-node', moduleVersion: '1.0.0',
    capabilityIds: ['CAP-AUTHOR'], qualificationStatus: 'source_qualified',
    qualificationIdentity: hash('a') },
  { moduleId: 'module.reviewer-node', moduleVersion: '1.0.0',
    capabilityIds: ['CAP-AUTHOR'], qualificationStatus: 'source_qualified',
    qualificationIdentity: hash('b') },
];
const moduleSetHash = captureQualifiedPlanningModuleSetV1(modules)
  .qualifiedModuleSetHash;
const projectionSources = [{
  projectionId: 'control-state', projectionVersion: '1',
  moduleId: 'module.readonly-control', moduleVersion: '1.0.0',
  authorityClass: 'read_only', qualificationStatus: 'source_qualified',
  qualificationIdentity: hash('c'), maximumAgeMilliseconds: 7_200_000,
}];
const projectionSetHash = captureQualifiedProjectionSourceSetV1(projectionSources)
  .qualifiedProjectionSetHash;

function planningRequest(overrides = {}) {
  return {
    schemaVersion: 1, kind: 'PlanningRequestV1', planningRequestId: 'request:plan',
    stateSnapshotHash: overrides.stateSnapshotHash || hash('d'), capabilityId: 'CAP-AUTHOR',
    hardConstraintSetHash: hash('e'), objectiveVersion: 'objective-v1',
    resourcePriceSnapshotHash: hash('f'), qualifiedModuleSetHash: moduleSetHash,
    candidateLimit: 64, maximumCandidateBytes: 64 * 1024,
    maximumTotalCandidateBytes: 2 * 1024 * 1024,
    deadline: '2026-09-06T01:30:00Z', allowedSideEffectClasses: ['none'],
    inputArtifacts: [], ...overrides,
  };
}

function snapshotContext() {
  const projection = sealReadOnlyProjectionV1({
    schemaVersion: 1, kind: 'ReadOnlyProjectionV1', projectionId: 'control-state',
    projectionVersion: '1', moduleId: 'module.readonly-control',
    moduleVersion: '1.0.0', sourceGeneration: 7,
    observedAt: '2026-09-06T00:00:00Z', validUntil: '2026-09-06T02:00:00Z',
    payload: { revision: 42 },
  });
  const snapshot = buildControlPlaneSnapshotV1({
    request: {
      schemaVersion: 1, kind: 'SnapshotBuildRequestV1', snapshotId: 'snapshot:plan',
      moduleRegistryHash: hash('1'), policySetHash: hash('e'),
      resourcePriceSnapshotHash: hash('f'), objectiveVersion: 'objective-v1',
      qualifiedProjectionSetHash: projectionSetHash,
      issuedAt: '2026-09-06T00:00:00Z', builtAt: '2026-09-06T00:00:30Z',
      deadline: '2026-09-06T01:30:00Z', maximumProjectionBytes: 4096,
      maximumTotalProjectionBytes: 4096,
    },
    qualifiedProjectionSources: projectionSources,
    projections: [projection],
  });
  const receipt = revalidateControlPlaneSnapshotV1({
    snapshot, observedAt: '2026-09-06T01:01:00Z',
    moduleRegistryHash: snapshot.moduleRegistryHash,
    policySetHash: snapshot.policySetHash,
    resourcePriceSnapshotHash: snapshot.resourcePriceSnapshotHash,
    objectiveVersion: snapshot.objectiveVersion,
    qualifiedProjectionSetHash: snapshot.qualifiedProjectionSetHash,
    currentProjectionGenerations: [{ projectionId: 'control-state', sourceGeneration: 7 }],
  });
  return { snapshot, receipt };
}

function action(id, moduleId, snapshotHash, overrides = {}) {
  return sealActionCandidateV1({
    schemaVersion: 1, kind: 'ActionCandidateV1', candidateId: id,
    planningRequestId: 'request:plan', stateSnapshotHash: snapshotHash,
    moduleId, moduleVersion: '1.0.0', capabilityId: 'CAP-AUTHOR',
    resourceVector: { cpuUnits: 1, gpuUnits: 0, memoryMiB: 1, storageBytes: 0 },
    duration: { maximumMilliseconds: 1 }, cost: {}, value: {}, risk: {},
    preconditions: [], dependencyEffects: [], sideEffectClass: 'none',
    irreversibleBoundary: null, rollbackClass: 'discard',
    expiresAt: '2026-09-06T01:20:00Z', inputSchema: null, outputSchema: null,
    singletonReason: null, ...overrides,
  });
}

function disposition(moduleId, candidates) {
  return {
    schemaVersion: 1, kind: 'CandidateProducerDispositionV1', moduleId,
    moduleVersion: '1.0.0', planningRequestId: 'request:plan',
    stateSnapshotHash: candidates[0]?.stateSnapshotHash || hash('d'),
    capabilityId: 'CAP-AUTHOR', status: 'candidate_batch_complete',
    completedAt: '2026-09-06T01:00:00Z', candidates, errorCode: null,
  };
}

function fixture(specs, problemOverrides = {}, contextOverrides = {}) {
  const { snapshot, receipt } = snapshotContext();
  const request = planningRequest({ stateSnapshotHash: snapshot.stateSnapshotHash,
    ...(contextOverrides.request || {}) });
  const actions = specs.map((spec, index) => action(
    spec.id, spec.moduleId || modules[index % modules.length].moduleId,
    snapshot.stateSnapshotHash,
    { singletonReason: specs.length === 1 ? 'only_feasible_candidate' : null },
  ));
  const byModule = new Map(modules.map((module) => [module.moduleId, []]));
  actions.forEach((candidate) => byModule.get(candidate.moduleId).push(candidate));
  const collection = collectCandidateBatchesV1({
    planningRequest: request,
    qualifiedModules: modules,
    producerDispositions: modules.map((module) =>
      disposition(module.moduleId, byModule.get(module.moduleId))),
    observedAt: '2026-09-06T01:00:00Z',
  });
  const problem = sealBoundedPlanSelectionProblemV1({
    schemaVersion: 1, kind: 'BoundedPlanSelectionProblemV1', planId: 'plan:alpha',
    candidateCollectionResultHash: collection.candidateCollectionResultHash,
    snapshotCurrentnessReceiptHash: receipt.currentnessReceiptHash,
    hardConstraintSetHash: request.hardConstraintSetHash,
    objectiveVersion: request.objectiveVersion,
    resourcePriceSnapshotHash: request.resourcePriceSnapshotHash,
    evaluationPolicyHash: hash('9'), selectedAt: '2026-09-06T01:02:00Z',
    capacities: { units: 10 },
    evaluations: specs.map((spec, index) => ({
      candidateId: spec.id,
      candidatePayloadHash: actions[index].candidatePayloadHash,
      utilityMicrounits: spec.utility,
      resources: { units: spec.units },
      dependsOnCandidateIds: spec.dependencies || [],
    })),
    requiredCandidateIds: [], forbiddenCandidateIds: [], exactlyOneGroups: [],
    atMostOneGroups: [], conflicts: [], minimumSelected: 0,
    maximumSelected: specs.length, maximumNodeExpansions: 1_000_000,
    ...problemOverrides,
  });
  return { snapshot, receipt, request, actions, collection, problem };
}

function select(value) {
  return selectBoundedPlanV1({
    planningRequest: value.request, qualifiedModules: modules,
    candidateCollection: value.collection,
    snapshotCurrentnessReceipt: value.receipt, problem: value.problem,
  });
}

function brute(specs, capacity, minimum = 0, maximum = specs.length) {
  let best = null;
  for (let mask = 0; mask < 2 ** specs.length; mask += 1) {
    const selected = specs.filter((_, index) => mask & (1 << index));
    if (selected.length < minimum || selected.length > maximum) continue;
    const ids = new Set(selected.map((item) => item.id));
    if (selected.some((item) => (item.dependencies || []).some((id) => !ids.has(id)))) continue;
    const units = selected.reduce((sum, item) => sum + item.units, 0);
    if (units > capacity) continue;
    const utility = selected.reduce((sum, item) => sum + item.utility, 0);
    if (best === null || utility > best) best = utility;
  }
  return best;
}

test('selector finds the exact finite optimum under a hard capacity', () => {
  const value = fixture([
    { id: 'a', utility: 10, units: 10 },
    { id: 'b', utility: 6, units: 5 },
    { id: 'c', utility: 6, units: 5 },
  ]);
  const result = select(value);
  assert.equal(result.status, 'selection_objective_optimal');
  assert.deepEqual(result.selectedCandidateIds, ['b', 'c']);
  assert.equal(result.achievedUtilityMicrounits, 12);
  assert.equal(result.lowerBoundMicrounits, 12);
  assert.equal(result.upperBoundMicrounits, 12);
  assert.equal(result.optimalityGapMicrounits, 0);
});

test('dependencies are mandatory hard constraints, including cycles', () => {
  const value = fixture([
    { id: 'a', utility: 10, units: 1, dependencies: ['b'] },
    { id: 'b', utility: -3, units: 1, dependencies: ['a'] },
    { id: 'c', utility: 8, units: 1 },
  ], { capacities: { units: 2 } });
  const result = select(value);
  assert.deepEqual(result.selectedCandidateIds, ['c']);
  assert.equal(result.achievedUtilityMicrounits, 8);
});

test('exactly-one, at-most-one, conflict, required and forbidden constraints compose', () => {
  const value = fixture([
    { id: 'a', utility: 7, units: 2 },
    { id: 'b', utility: 6, units: 2 },
    { id: 'c', utility: 5, units: 1 },
  ], {
    exactlyOneGroups: [['a', 'b']], atMostOneGroups: [['b', 'c']],
    conflicts: [['a', 'c']], requiredCandidateIds: ['c'],
  });
  const result = select(value);
  assert.equal(result.status, 'selection_infeasible_proven');
  assert.equal(result.searchComplete, true);
});

test('required candidate conflicting with an explicit prohibition is proven infeasible', () => {
  const value = fixture([{ id: 'a', utility: 1, units: 1 }], {
    requiredCandidateIds: ['a'], forbiddenCandidateIds: ['a'],
  });
  const result = select(value);
  assert.equal(result.status, 'selection_infeasible_proven');
  assert.equal(result.nodeExpansions, 0);
});

test('node budget distinguishes no incumbent from proven infeasibility', () => {
  const value = fixture([
    { id: 'a', utility: 10, units: 10 },
    { id: 'b', utility: 6, units: 5 },
    { id: 'c', utility: 6, units: 5 },
  ], { maximumNodeExpansions: 1 });
  const result = select(value);
  assert.equal(result.status, 'selection_no_incumbent_with_remaining_search');
  assert.equal(result.achievedUtilityMicrounits, null);
  assert.ok(result.upperBoundMicrounits >= 12);
  assert.equal(result.searchComplete, false);
});

test('limited search returns a valid lower and upper bound around the true optimum', () => {
  const value = fixture([
    { id: 'a', utility: 10, units: 10 },
    { id: 'b', utility: 6, units: 5 },
    { id: 'c', utility: 6, units: 5 },
  ], { maximumNodeExpansions: 6 });
  const result = select(value);
  assert.equal(result.status, 'selection_feasible_bounded_gap');
  assert.equal(result.lowerBoundMicrounits, 10);
  assert.ok(result.lowerBoundMicrounits <= 12);
  assert.ok(result.upperBoundMicrounits >= 12);
});

test('a bound may prove objective optimality before every tie branch is expanded', () => {
  const value = fixture([
    { id: 'a', utility: 5, units: 1 },
    { id: 'b', utility: 4, units: 1 },
    { id: 'c', utility: 3, units: 1 },
  ], { capacities: { units: 3 }, maximumNodeExpansions: 4 });
  const result = select(value);
  assert.equal(result.status, 'selection_objective_optimal');
  assert.equal(result.achievedUtilityMicrounits, 12);
  assert.equal(result.objectiveOptimal, true);
});

test('negative utility is selected only when hard minimum requires it', () => {
  const optional = select(fixture([
    { id: 'a', utility: -2, units: 1 },
    { id: 'b', utility: -1, units: 1 },
  ]));
  assert.deepEqual(optional.selectedCandidateIds, []);
  const required = select(fixture([
    { id: 'a', utility: -2, units: 1 },
    { id: 'b', utility: -1, units: 1 },
  ], { minimumSelected: 1 }));
  assert.deepEqual(required.selectedCandidateIds, ['b']);
  assert.equal(required.achievedUtilityMicrounits, -1);
});

test('complete empty frontier has an optimal empty plan when minimum is zero', () => {
  const value = fixture([]);
  const result = select(value);
  assert.equal(result.status, 'selection_objective_optimal');
  assert.deepEqual(result.selectedCandidateIds, []);
  assert.equal(result.achievedUtilityMicrounits, 0);
});

test('incomplete candidate collection can never reach the selector', () => {
  const value = fixture([{ id: 'a', utility: 1, units: 1 }]);
  const incomplete = { ...value.collection,
    status: 'candidate_frontier_incomplete', frontier: null };
  assert.throws(() => select({ ...value, collection: incomplete }), {
    code: 'plan_candidate_collection_incomplete',
  });
});

test('collection producer metadata is independently rechecked', () => {
  const value = fixture([
    { id: 'a', utility: 1, units: 1 },
    { id: 'b', utility: 1, units: 1 },
  ]);
  const collection = structuredClone(value.collection);
  collection.producerDispositions[0].acceptedCandidateCount += 1;
  const { candidateCollectionResultHash: ignored, ...body } = collection;
  collection.candidateCollectionResultHash = hashRecord('CandidateCollectionResultV1', body);
  assert.throws(() => select({ ...value, collection }), {
    code: 'plan_candidate_producer_disposition_mismatch',
  });
});

test('stale currentness, context drift and selection time drift fail closed', () => {
  const value = fixture([{ id: 'a', utility: 1, units: 1 }]);
  assert.throws(() => select({ ...value, receipt: {
    ...value.receipt, policySetHash: hash('0'),
  } }), /plan_snapshot_currentness_receipt_hash_invalid|plan_selection_snapshot_or_time_mismatch/u);
  const lateProblem = sealBoundedPlanSelectionProblemV1({
    ...value.problem, optimizationProblemHash: undefined,
    selectedAt: '2026-09-06T01:31:00Z',
  });
  assert.throws(() => select({ ...value, problem: lateProblem }), {
    code: 'plan_selection_snapshot_or_time_mismatch',
  });
});

test('problem identity and evaluation coverage cannot be spliced', () => {
  const value = fixture([{ id: 'a', utility: 1, units: 1 }]);
  assert.throws(() => select({ ...value, problem: {
    ...value.problem, maximumNodeExpansions: 2,
  } }), { code: 'plan_selection_problem_hash_invalid' });
  const wrong = sealBoundedPlanSelectionProblemV1({
    ...value.problem, optimizationProblemHash: undefined,
    evaluations: value.problem.evaluations.map((entry) => ({
      ...entry, candidatePayloadHash: hash('0'),
    })),
  });
  assert.throws(() => select({ ...value, problem: wrong }), {
    code: 'plan_selection_evaluation_coverage_invalid',
  });
});

test('valid planning requests may omit optional goal and policy references', () => {
  const value = fixture([{ id: 'a', utility: 1, units: 1 }]);
  assert.equal(Object.hasOwn(value.request, 'goalReference'), false);
  assert.equal(select(value).status, 'selection_objective_optimal');
});

test('malformed numbers, getters, sparse sets and unknown dependencies are rejected', () => {
  const value = fixture([{ id: 'a', utility: 1, units: 1 }]);
  for (const utilityMicrounits of [NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => sealBoundedPlanSelectionProblemV1({
      ...value.problem, optimizationProblemHash: undefined,
      evaluations: [{ ...value.problem.evaluations[0], utilityMicrounits }],
    }));
  }
  let calls = 0;
  const capacity = {};
  Object.defineProperty(capacity, 'units', { enumerable: true,
    get() { calls += 1; return 10; } });
  assert.throws(() => sealBoundedPlanSelectionProblemV1({
    ...value.problem, optimizationProblemHash: undefined, capacities: capacity,
  }), { code: 'plan_capacity_invalid' });
  assert.equal(calls, 0);
  assert.throws(() => sealBoundedPlanSelectionProblemV1({
    ...value.problem, optimizationProblemHash: undefined,
    exactlyOneGroups: new Array(1),
  }), { code: 'plan_exactly_one_groups_invalid' });
  assert.throws(() => sealBoundedPlanSelectionProblemV1({
    ...value.problem, optimizationProblemHash: undefined,
    evaluations: [{ ...value.problem.evaluations[0], dependsOnCandidateIds: ['unknown'] }],
  }), { code: 'plan_candidate_dependency_unknown' });
});

test('results are deterministic immutable and non-authorizing', () => {
  const value = fixture([
    { id: 'a', utility: 4, units: 1 },
    { id: 'b', utility: 4, units: 1 },
  ]);
  const first = select(value);
  const second = select(value);
  assert.deepEqual(first, second);
  assert.ok(Object.values(first.authority).every((entry) => entry === false));
  assert.throws(() => { first.selectedCandidateIds.push('c'); }, TypeError);
  assert.throws(() => { first.resourceUsage.units = 999; }, TypeError);
});

test('exhaustive results match an independent capacity oracle on 80 problems', () => {
  let seed = 918273;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed;
  };
  for (let round = 0; round < 80; round += 1) {
    const specs = Array.from({ length: 8 }, (_, index) => ({
      id: `c${index}`, utility: (random() % 31) - 10, units: 1 + (random() % 8),
    }));
    const capacity = 5 + (random() % 16);
    const optimum = brute(specs, capacity);
    const result = select(fixture(specs, { capacities: { units: capacity } }));
    assert.equal(result.status, 'selection_objective_optimal');
    assert.equal(result.achievedUtilityMicrounits, optimum);
    assert.equal(result.lowerBoundMicrounits, optimum);
    assert.equal(result.upperBoundMicrounits, optimum);
  }
});

test('limited-search bounds contain the independent optimum on 50 problems', () => {
  let seed = 314159;
  const random = () => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    return seed;
  };
  for (let round = 0; round < 50; round += 1) {
    const specs = Array.from({ length: 8 }, (_, index) => ({
      id: `p${index}`, utility: (random() % 21) - 5, units: 1 + (random() % 6),
    }));
    const capacity = 4 + (random() % 12);
    const optimum = brute(specs, capacity);
    const result = select(fixture(specs, {
      capacities: { units: capacity }, maximumNodeExpansions: 12,
    }));
    if (result.lowerBoundMicrounits !== null) {
      assert.ok(result.lowerBoundMicrounits <= optimum);
      assert.ok(result.upperBoundMicrounits >= optimum);
    } else {
      assert.equal(result.status, 'selection_no_incumbent_with_remaining_search');
      assert.ok(result.upperBoundMicrounits >= optimum);
    }
  }
});
