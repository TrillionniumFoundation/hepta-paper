import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createActionCandidate,
  routeActionCandidates,
} from '../../paper-application/orchestration/candidate-router.mjs';
import { selectBoundedGlobalPlan } from '../../paper-application/orchestration/bounded-plan-selector.mjs';

const H = (character) => `sha256:${character.repeat(64)}`;
const NOW = Date.parse('2026-09-06T00:00:00Z');
const DEFAULT_LIMITS = Object.freeze({
  cpuMilliunits: 10_000,
  gpuMilliunits: 10_000,
  memoryMiB: 1_000_000,
  storageBytes: 1_000_000,
  tokenCount: 1_000_000,
  maximumCostMicrousd: 1_000_000,
});

function buildProblem(specifications, options = {}) {
  const request = {
    schemaVersion: 1,
    kind: 'PlanningRequestV1',
    planningRequestId: options.planningRequestId || 'selection-plan',
    stateSnapshotHash: options.stateSnapshotHash || H('a'),
    capabilityId: 'CAP-MOD-CANDIDATES',
    hardConstraintSetHash: options.hardConstraintSetHash || H('b'),
    objectiveVersion: options.objectiveVersion || 'objective-v1',
    resourcePriceSnapshotHash: options.resourcePriceSnapshotHash || H('c'),
    candidateLimit: Math.max(1, specifications.length || 1),
    deadline: '2026-12-31T00:00:00Z',
    allowedSideEffectClasses: ['none'],
    inputArtifactHashes: [],
  };
  const moduleBinding = {
    moduleId: 'module.alpha',
    moduleVersion: '1.0.0',
    capabilityIds: ['CAP-MOD-CANDIDATES'],
    qualificationSubjectHash: H('d'),
    validUntil: '2026-12-31T00:00:00Z',
  };
  const candidates = specifications.map((specification) => createActionCandidate({
    schemaVersion: 1,
    kind: 'ActionCandidateV1',
    candidateId: specification.id,
    planningRequestId: request.planningRequestId,
    stateSnapshotHash: request.stateSnapshotHash,
    moduleId: moduleBinding.moduleId,
    moduleVersion: moduleBinding.moduleVersion,
    capabilityId: request.capabilityId,
    resourceVector: {
      cpuUnits: specification.cpuUnits ?? 0,
      gpuUnits: specification.gpuUnits ?? 0,
      memoryMiB: specification.memoryMiB ?? 0,
      storageBytes: specification.storageBytes ?? 0,
      tokenCount: specification.tokenCount ?? 0,
      maximumCostMicrousd: specification.maximumCostMicrousd ?? 0,
    },
    duration: { upperMs: 100 },
    cost: { upperMicrousd: specification.maximumCostMicrousd ?? 0 },
    value: { advisory: specification.utility },
    risk: { failureProbability: 0 },
    preconditions: [],
    dependencyEffects: (specification.dependencies || []).map((item) => `requires:${item}`),
    sideEffectClass: 'none',
    irreversibleBoundary: null,
    rollbackClass: 'no_effect',
    expiresAt: '2026-12-30T00:00:00Z',
    inputSchema: null,
    outputSchema: null,
    singletonReason: specifications.length === 1 ? 'only_feasible_candidate' : null,
  }));
  const frontier = routeActionCandidates({
    request,
    moduleBindings: [moduleBinding],
    candidates,
    ...(specifications.length === 0 ? { emptyReason: 'no_candidates' } : {}),
    nowEpochMs: NOW,
  });
  const byId = new Map(frontier.candidates.map((candidate) => [candidate.candidateId, candidate]));
  const evaluations = specifications.map((specification) => ({
    candidateId: specification.id,
    candidatePayloadHash: byId.get(specification.id).candidatePayloadHash,
    utilityMicrounits: specification.utility,
    dependencies: specification.dependencies || [],
    mutexGroup: specification.mutexGroup ?? null,
  }));
  const selectionRequest = {
    schemaVersion: 1,
    kind: 'GlobalPlanSelectionRequestV1',
    selectionRequestId: options.selectionRequestId || 'selection-1',
    planningRequestHash: frontier.planningRequestHash,
    stateSnapshotHash: frontier.stateSnapshotHash,
    candidateSetHash: frontier.candidateSetHash,
    hardConstraintSetHash: frontier.hardConstraintSetHash,
    objectiveVersion: frontier.objectiveVersion,
    resourcePriceSnapshotHash: frontier.resourcePriceSnapshotHash,
    deadline: options.deadline || '2026-12-29T00:00:00Z',
    expansionBudget: options.expansionBudget ?? 100_000,
    maximumSelectedCandidates: options.maximumSelectedCandidates ?? specifications.length,
    resourceLimits: { ...DEFAULT_LIMITS, ...(options.resourceLimits || {}) },
    requiredCandidateIds: options.requiredCandidateIds || [],
    evaluations,
  };
  return { specifications, frontier, selectionRequest };
}

function solve(problem, requestOverrides = {}) {
  return selectBoundedGlobalPlan({
    frontier: problem.frontier,
    request: { ...problem.selectionRequest, ...requestOverrides },
    nowEpochMs: NOW,
  });
}

function resourceOf(specification) {
  return {
    cpuMilliunits: specification.cpuUnits * 1000,
    gpuMilliunits: specification.gpuUnits * 1000,
    memoryMiB: specification.memoryMiB ?? 0,
    storageBytes: specification.storageBytes ?? 0,
    tokenCount: specification.tokenCount ?? 0,
    maximumCostMicrousd: specification.maximumCostMicrousd ?? 0,
  };
}

function bruteForce(problem) {
  const { specifications, selectionRequest } = problem;
  let best = null;
  const required = new Set(selectionRequest.requiredCandidateIds);
  for (let mask = 0; mask < (1 << specifications.length); mask += 1) {
    const selected = specifications.filter((_, index) => (mask & (1 << index)) !== 0);
    const ids = new Set(selected.map((item) => item.id));
    if (selected.length > selectionRequest.maximumSelectedCandidates
      || [...required].some((id) => !ids.has(id))) continue;
    if (selected.some((item) => (item.dependencies || []).some((id) => !ids.has(id)))) continue;
    const groups = selected.map((item) => item.mutexGroup).filter(Boolean);
    if (new Set(groups).size !== groups.length) continue;
    const resources = Object.fromEntries(Object.keys(DEFAULT_LIMITS).map((field) => [field, 0]));
    let utility = 0;
    let valid = true;
    for (const item of selected) {
      utility += item.utility;
      const vector = resourceOf(item);
      for (const field of Object.keys(resources)) {
        resources[field] += vector[field];
        if (resources[field] > selectionRequest.resourceLimits[field]) valid = false;
      }
    }
    if (!valid) continue;
    const selectedIds = [...ids].sort();
    if (!best || utility > best.utility
      || (utility === best.utility && selectedIds.join('\0') < best.selectedIds.join('\0'))) {
      best = { utility, selectedIds, resources };
    }
  }
  return best;
}

test('complete search returns the exact resource-feasible optimum', () => {
  const problem = buildProblem([
    { id: 'a', utility: 10, cpuUnits: 1 },
    { id: 'b', utility: 8, cpuUnits: 1 },
    { id: 'c', utility: 7, cpuUnits: 1 },
  ], { maximumSelectedCandidates: 2, resourceLimits: { cpuMilliunits: 2000 } });
  const result = solve(problem);
  assert.equal(result.status, 'optimal');
  assert.deepEqual(result.selectedCandidateIds, ['a', 'b']);
  assert.equal(result.objectiveLowerBoundMicrounits, 18);
  assert.equal(result.objectiveUpperBoundMicrounits, 18);
  assert.equal(result.optimalityGapMicrounits, 0);
  assert.equal(result.proof.optimalSelectionProven, true);
});

test('resource limits are hard constraints rather than objective penalties', () => {
  const problem = buildProblem([
    { id: 'a', utility: 100, cpuUnits: 2 },
    { id: 'b', utility: 60, cpuUnits: 1 },
    { id: 'c', utility: 59, cpuUnits: 1 },
  ], { maximumSelectedCandidates: 2, resourceLimits: { cpuMilliunits: 2000 } });
  const result = solve(problem);
  assert.deepEqual(result.selectedCandidateIds, ['b', 'c']);
  assert.equal(result.objectiveLowerBoundMicrounits, 119);
  assert.equal(result.resourceUsage.cpuMilliunits, 2000);
});

test('dependency closure can require a negative-utility candidate', () => {
  const problem = buildProblem([
    { id: 'a', utility: 10, dependencies: ['b'] },
    { id: 'b', utility: -4 },
    { id: 'c', utility: 5 },
  ]);
  const result = solve(problem);
  assert.deepEqual(result.selectedCandidateIds, ['a', 'b', 'c']);
  assert.equal(result.objectiveLowerBoundMicrounits, 11);
});

test('mutual exclusion is enforced independently of utility', () => {
  const problem = buildProblem([
    { id: 'a', utility: 10, mutexGroup: 'choice' },
    { id: 'b', utility: 9, mutexGroup: 'choice' },
    { id: 'c', utility: 2 },
  ]);
  assert.deepEqual(solve(problem).selectedCandidateIds, ['a', 'c']);
});

test('required candidates may make the optimum negative without being dropped', () => {
  const problem = buildProblem([
    { id: 'a', utility: -5 },
    { id: 'b', utility: 2 },
  ], { requiredCandidateIds: ['a'] });
  const result = solve(problem);
  assert.equal(result.status, 'optimal');
  assert.deepEqual(result.selectedCandidateIds, ['a', 'b']);
  assert.equal(result.objectiveLowerBoundMicrounits, -3);
});

test('exhaustive failure is distinguished from a budget-limited missing incumbent', () => {
  const problem = buildProblem([
    { id: 'a', utility: 5, cpuUnits: 2 },
  ], { requiredCandidateIds: ['a'], resourceLimits: { cpuMilliunits: 1000 } });
  const bounded = solve(problem, { expansionBudget: 1 });
  assert.equal(bounded.status, 'bounded_no_incumbent');
  assert.equal(bounded.objectiveLowerBoundMicrounits, null);
  assert.equal(bounded.proof.infeasibilityProven, false);

  const complete = solve(problem, { expansionBudget: 100 });
  assert.equal(complete.status, 'infeasible');
  assert.equal(complete.selectedCandidateIds, null);
  assert.equal(complete.proof.infeasibilityProven, true);
});

test('limited search with the empty feasible incumbent reports honest bounds', () => {
  const problem = buildProblem([
    { id: 'a', utility: 10 },
    { id: 'b', utility: 4 },
  ]);
  const result = solve(problem, { expansionBudget: 1 });
  assert.equal(result.status, 'bounded_feasible');
  assert.equal(result.objectiveLowerBoundMicrounits, 0);
  assert.equal(result.objectiveUpperBoundMicrounits, 14);
  assert.equal(result.optimalityGapMicrounits, 14);
  assert.equal(result.frontierExhausted, false);
});

test('negative optional candidates are excluded in the optimal empty plan', () => {
  const problem = buildProblem([
    { id: 'a', utility: -1 },
    { id: 'b', utility: -2 },
  ]);
  const result = solve(problem);
  assert.equal(result.status, 'optimal');
  assert.deepEqual(result.selectedCandidateIds, []);
  assert.equal(result.objectiveLowerBoundMicrounits, 0);
});

test('equal-utility plans use deterministic lexical tie breaking', () => {
  const problem = buildProblem([
    { id: 'b', utility: 5 },
    { id: 'a', utility: 5 },
  ], { maximumSelectedCandidates: 1 });
  const left = solve(problem);
  const right = solve(problem, { evaluations: [...problem.selectionRequest.evaluations].reverse() });
  assert.deepEqual(left.selectedCandidateIds, ['a']);
  assert.equal(left.planSelectionHash, right.planSelectionHash);
});

test('evaluation coverage and exact candidate hashes are mandatory', () => {
  const problem = buildProblem([{ id: 'a', utility: 1 }, { id: 'b', utility: 2 }]);
  assert.throws(() => solve(problem, {
    evaluations: problem.selectionRequest.evaluations.slice(0, 1),
  }), { code: 'plan_evaluation_coverage_invalid' });
  assert.throws(() => solve(problem, {
    evaluations: [problem.selectionRequest.evaluations[0], problem.selectionRequest.evaluations[0]],
  }), { code: 'plan_evaluation_duplicate' });
  assert.throws(() => solve(problem, {
    evaluations: problem.selectionRequest.evaluations.map((item, index) =>
      index ? item : { ...item, candidatePayloadHash: H('9') }),
  }), { code: 'plan_evaluation_candidate_binding_mismatch' });
});

test('unknown and self dependencies are rejected before search', () => {
  const problem = buildProblem([{ id: 'a', utility: 1 }, { id: 'b', utility: 2 }]);
  for (const dependency of ['missing', 'a']) {
    const evaluations = problem.selectionRequest.evaluations.map((item) =>
      item.candidateId === 'a' ? { ...item, dependencies: [dependency] } : item);
    assert.throws(() => solve(problem, { evaluations }), { code: 'plan_evaluation_dependency_invalid' });
  }
});

test('unknown required identities and impossible cardinality are fail-closed or proven infeasible', () => {
  const problem = buildProblem([{ id: 'a', utility: 1 }]);
  assert.throws(() => solve(problem, { requiredCandidateIds: ['missing'] }),
    { code: 'plan_required_candidate_unknown' });
  const infeasible = solve(problem, {
    requiredCandidateIds: ['a'], maximumSelectedCandidates: 0, expansionBudget: 100,
  });
  assert.equal(infeasible.status, 'infeasible');
});

test('frontier hash, authority and no-dominance assertions are independently checked', () => {
  const problem = buildProblem([{ id: 'a', utility: 1 }]);
  assert.throws(() => selectBoundedGlobalPlan({
    frontier: { ...problem.frontier, candidateSetHash: H('9') },
    request: problem.selectionRequest, nowEpochMs: NOW,
  }), { code: 'candidate_frontier_hash_invalid' });
  assert.throws(() => selectBoundedGlobalPlan({
    frontier: { ...problem.frontier,
      authority: { ...problem.frontier.authority, productionAuthorized: true } },
    request: problem.selectionRequest, nowEpochMs: NOW,
  }), { code: 'candidate_frontier_authority_invalid' });
  assert.throws(() => selectBoundedGlobalPlan({
    frontier: { ...problem.frontier, dominanceReductionApplied: true },
    request: problem.selectionRequest, nowEpochMs: NOW,
  }), { code: 'candidate_frontier_dominance_claim_invalid' });
});

test('selection request must bind every frozen planning identity', () => {
  const problem = buildProblem([{ id: 'a', utility: 1 }]);
  for (const [field, value, code] of [
    ['planningRequestHash', H('1'), 'plan_selection_planning_request_mismatch'],
    ['stateSnapshotHash', H('2'), 'plan_selection_snapshot_mismatch'],
    ['candidateSetHash', H('3'), 'plan_selection_candidate_set_mismatch'],
    ['hardConstraintSetHash', H('4'), 'plan_selection_constraints_mismatch'],
    ['objectiveVersion', 'objective-v2', 'plan_selection_objective_mismatch'],
    ['resourcePriceSnapshotHash', H('5'), 'plan_selection_prices_mismatch'],
  ]) assert.throws(() => solve(problem, { [field]: value }), { code });
});

test('selection deadline cannot outlive the candidate frontier', () => {
  const problem = buildProblem([{ id: 'a', utility: 1 }]);
  assert.throws(() => solve(problem, { deadline: '2026-12-31T00:00:00Z' }),
    { code: 'plan_selection_deadline_exceeds_frontier' });
});

test('fractional CPU/GPU values require exact milliunit representation', () => {
  const accepted = buildProblem([{ id: 'a', utility: 1, cpuUnits: 1.5 }]);
  assert.equal(solve(accepted).resourceUsage.cpuMilliunits, 1500);
  const rejected = buildProblem([{ id: 'a', utility: 1, cpuUnits: 0.0005 }]);
  assert.throws(() => solve(rejected), { code: 'plan_candidate_cpu_units_invalid' });
});

test('objective bound overflow is rejected rather than rounded', () => {
  const problem = buildProblem([
    { id: 'a', utility: Number.MAX_SAFE_INTEGER },
    { id: 'b', utility: Number.MAX_SAFE_INTEGER },
  ]);
  assert.throws(() => solve(problem), { code: 'plan_objective_bound_overflow' });
});

test('output is immutable, non-authorizing and binds selected payload identities', () => {
  const problem = buildProblem([{ id: 'a', utility: 1 }]);
  const result = solve(problem);
  assert.deepEqual(result.authority, {
    productionAuthorized: false,
    writerAuthorityGranted: false,
    executionAuthorized: false,
    externalAuthorityClaimed: false,
  });
  assert.equal(result.selectedCandidatePayloadHashes[0], problem.frontier.candidates[0].candidatePayloadHash);
  assert.throws(() => { result.authority.executionAuthorized = true; }, TypeError);
  assert.throws(() => { result.selectedCandidateIds.push('other'); }, TypeError);
});

test('full search agrees with an independent exhaustive oracle on random finite problems', () => {
  let seed = 9137;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
  for (let trial = 0; trial < 80; trial += 1) {
    const specifications = [];
    for (let index = 0; index < 8; index += 1) {
      const previous = Array.from({ length: index }, (_, value) => `c${value}`);
      const dependencies = previous.filter(() => random() % 9 === 0).slice(0, 2);
      specifications.push({
        id: `c${index}`,
        utility: (random() % 18) - 6,
        cpuUnits: random() % 3,
        memoryMiB: random() % 4,
        tokenCount: random() % 5,
        maximumCostMicrousd: random() % 4,
        dependencies,
        mutexGroup: random() % 5 === 0 ? `g${random() % 3}` : null,
      });
    }
    const requiredCandidateIds = specifications.filter(() => random() % 17 === 0)
      .map((item) => item.id).slice(0, 2);
    const problem = buildProblem(specifications, {
      maximumSelectedCandidates: random() % 9,
      requiredCandidateIds,
      resourceLimits: {
        cpuMilliunits: (random() % 9) * 1000,
        memoryMiB: random() % 13,
        tokenCount: random() % 17,
        maximumCostMicrousd: random() % 13,
      },
    });
    const expected = bruteForce(problem);
    const actual = solve(problem, { expansionBudget: 100_000 });
    if (expected === null) {
      assert.equal(actual.status, 'infeasible', `trial=${trial}`);
      assert.equal(actual.proof.infeasibilityProven, true);
    } else {
      assert.equal(actual.status, 'optimal', `trial=${trial}`);
      assert.deepEqual(actual.selectedCandidateIds, expected.selectedIds, `trial=${trial}`);
      assert.equal(actual.objectiveLowerBoundMicrounits, expected.utility, `trial=${trial}`);
      assert.deepEqual(actual.resourceUsage, expected.resources, `trial=${trial}`);
    }
  }
});
