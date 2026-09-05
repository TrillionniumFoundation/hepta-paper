import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import {
  buildPlanningSnapshot,
  hashPlanningProjectionV1,
} from '../../paper-application/orchestration/planning-snapshot-builder.mjs';
import {
  hashActionCandidateV1,
  routeActionCandidates,
} from '../../paper-application/orchestration/candidate-router.mjs';
import {
  hashOptimizationCandidateV1,
  optimizeFinitePlan,
} from '../../paper-application/orchestration/finite-plan-optimizer-entry.mjs';

const H = (character) => `sha256:${character.repeat(64)}`;
const NOW = '2026-09-06T00:00:00.123456789Z';
const EXPIRY = '2026-09-07T00:00:00.000000000Z';
const RESOURCE_FIELDS = [
  'cpuMicrounits', 'gpuMicrounits', 'memoryMiB', 'storageBytes',
  'tokenCount', 'maximumCostMicrousd',
];

function canonicalize(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
      .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function hashDomain(kind, value) {
  return `sha256:${crypto.createHash('sha256')
    .update(Buffer.from(canonicalize({ kind, value }), 'utf8')).digest('hex')}`;
}

function projectionBody(overrides = {}) {
  return {
    schemaVersion: 1,
    kind: 'PlanningProjectionV1',
    projectionId: 'campaigns',
    sourceModuleId: 'module.readonly-control',
    schemaRef: 'schema:campaign-projection-v1',
    revision: 41,
    writerGeneration: 7,
    readEpoch: 11,
    payload: { campaigns: [{ id: 'campaign-1', status: 'running' }] },
    ...overrides,
  };
}

function signedProjection(overrides = {}) {
  const body = projectionBody(overrides);
  return { ...body, projectionHash: hashPlanningProjectionV1(body) };
}

function makeSnapshot(overrides = {}) {
  return buildPlanningSnapshot({
    transaction: {
      schemaVersion: 1,
      kind: 'ReadSnapshotTransactionV1',
      repositorySubjectHash: H('a'),
      revision: 41,
      writerGeneration: 7,
      readEpoch: 11,
      capturedAt: '2026-09-05T23:59:00Z',
      expiresAt: EXPIRY,
    },
    projections: [signedProjection()],
    moduleBindings: [{
      moduleId: 'module.alpha',
      moduleVersion: '1.2.3',
      capabilityIds: ['CAP-MOD-CANDIDATES'],
      qualificationSubjectHash: H('d'),
    }],
    policy: {
      hardConstraintSetHash: H('b'),
      objectiveVersion: 'objective-v1',
      resourcePriceSnapshotHash: H('c'),
      allowedSideEffectClasses: ['none'],
    },
    now: NOW,
    ...overrides,
  });
}

function candidateBody(snapshot, spec, count) {
  return {
    schemaVersion: 1,
    kind: 'ActionCandidateV1',
    candidateId: spec.id,
    planningRequestId: 'planning-1',
    stateSnapshotHash: snapshot.stateSnapshotHash,
    moduleId: 'module.alpha',
    moduleVersion: '1.2.3',
    capabilityId: 'CAP-MOD-CANDIDATES',
    resourceVector: {
      cpuUnits: spec.cpu ?? 0,
      gpuUnits: spec.gpu ?? 0,
      memoryMiB: spec.memory ?? 0,
      storageBytes: spec.storage ?? 0,
      tokenCount: spec.tokens ?? 0,
      maximumCostMicrousd: spec.cost ?? 0,
    },
    duration: { maximumMilliseconds: 1000 },
    cost: { maximumMicrousd: spec.cost ?? 0 },
    value: { expectedMicrounits: spec.utility },
    risk: { failureProbabilityPpm: 0 },
    preconditions: [],
    dependencyEffects: spec.effects ?? [],
    sideEffectClass: 'none',
    irreversibleBoundary: null,
    rollbackClass: 'pure',
    expiresAt: '2026-09-06T12:00:00Z',
    inputSchema: null,
    outputSchema: null,
    singletonReason: count === 1 ? 'only_feasible_candidate' : null,
  };
}

function zeroResources(overrides = {}) {
  return {
    cpuMicrounits: 0,
    gpuMicrounits: 0,
    memoryMiB: 0,
    storageBytes: 0,
    tokenCount: 0,
    maximumCostMicrousd: 0,
    ...overrides,
  };
}

function buildStack(specs, problemOverrides = {}, options = {}) {
  const snapshot = options.snapshot ?? makeSnapshot();
  const planningRequest = {
    schemaVersion: 1,
    kind: 'PlanningRequestV1',
    planningRequestId: 'planning-1',
    stateSnapshotHash: snapshot.stateSnapshotHash,
    capabilityId: 'CAP-MOD-CANDIDATES',
    hardConstraintSetHash: snapshot.policy.hardConstraintSetHash,
    objectiveVersion: snapshot.policy.objectiveVersion,
    resourcePriceSnapshotHash: snapshot.policy.resourcePriceSnapshotHash,
    candidateLimit: Math.max(1, specs.length),
    createdAt: snapshot.capturedAt,
    expiresAt: snapshot.expiresAt,
    allowedSideEffectClasses: snapshot.policy.allowedSideEffectClasses,
  };
  const candidates = specs.map((spec) => {
    const body = candidateBody(snapshot, spec, specs.length);
    return { ...body, candidatePayloadHash: hashActionCandidateV1(body) };
  });
  const frontier = routeActionCandidates({
    planningRequest,
    candidates,
    qualifiedModules: snapshot.moduleBindings,
    now: NOW,
  });
  const byId = new Map(frontier.candidates.map((candidate) => [candidate.candidateId, candidate]));
  const annotations = specs.map((spec) => {
    const candidate = byId.get(spec.id);
    const body = {
      schemaVersion: 1,
      kind: 'OptimizationCandidateV1',
      candidatePayloadHash: candidate.candidatePayloadHash,
      estimateSubjectHash: spec.estimateSubjectHash ?? H('e'),
      utilityMicrounits: spec.utility,
      resources: zeroResources({
        cpuMicrounits: Math.ceil((spec.annotationCpu ?? spec.cpu ?? 0) * 1_000_000),
        gpuMicrounits: Math.ceil((spec.annotationGpu ?? spec.gpu ?? 0) * 1_000_000),
        memoryMiB: spec.annotationMemory ?? spec.memory ?? 0,
        storageBytes: spec.annotationStorage ?? spec.storage ?? 0,
        tokenCount: spec.annotationTokens ?? spec.tokens ?? 0,
        maximumCostMicrousd: spec.annotationCost ?? spec.cost ?? 0,
      }),
      dependencies: (spec.dependencies ?? []).map((id) => byId.get(id).candidatePayloadHash),
      decisionGroup: spec.group ?? null,
      required: spec.required ?? false,
    };
    return { ...body, annotationHash: hashOptimizationCandidateV1(body) };
  });
  const problem = {
    schemaVersion: 1,
    kind: 'FiniteOptimizationProblemV1',
    stateSnapshotHash: snapshot.stateSnapshotHash,
    candidateSetHash: frontier.candidateSetHash,
    hardConstraintSetHash: snapshot.policy.hardConstraintSetHash,
    objectiveVersion: snapshot.policy.objectiveVersion,
    calibrationPolicyHash: H('f'),
    minimumSelected: 0,
    maximumSelected: specs.length,
    budgets: zeroResources({
      cpuMicrounits: 10_000_000,
      gpuMicrounits: 10_000_000,
      memoryMiB: 1_000_000,
      storageBytes: 1_000_000,
      tokenCount: 1_000_000,
      maximumCostMicrousd: 1_000_000,
    }),
    searchNodeBudget: 1_000_000,
    candidates: annotations,
    ...problemOverrides,
  };
  return { snapshot, frontier, problem, byId };
}

function optimize(stack, overrides = {}) {
  return optimizeFinitePlan({
    snapshot: stack.snapshot,
    frontier: stack.frontier,
    problem: stack.problem,
    now: NOW,
    ...overrides,
  });
}

function exhaustiveOracle(specs, problem, byId) {
  let best = null;
  for (let mask = 0; mask < (1 << specs.length); mask += 1) {
    const selected = specs.filter((_, index) => mask & (1 << index));
    if (selected.length < problem.minimumSelected || selected.length > problem.maximumSelected) continue;
    const ids = new Set(selected.map((spec) => spec.id));
    if (specs.some((spec) => spec.required && !ids.has(spec.id))) continue;
    if (selected.some((spec) => (spec.dependencies ?? []).some((dependency) => !ids.has(dependency)))) continue;
    const groups = new Set();
    let conflict = false;
    for (const spec of selected) {
      if (spec.group !== undefined && spec.group !== null) {
        if (groups.has(spec.group)) { conflict = true; break; }
        groups.add(spec.group);
      }
    }
    if (conflict) continue;
    const resources = zeroResources();
    let utility = 0;
    let exceeds = false;
    for (const spec of selected) {
      utility += spec.utility;
      const values = zeroResources({
        cpuMicrounits: Math.ceil((spec.annotationCpu ?? spec.cpu ?? 0) * 1_000_000),
        gpuMicrounits: Math.ceil((spec.annotationGpu ?? spec.gpu ?? 0) * 1_000_000),
        memoryMiB: spec.annotationMemory ?? spec.memory ?? 0,
        storageBytes: spec.annotationStorage ?? spec.storage ?? 0,
        tokenCount: spec.annotationTokens ?? spec.tokens ?? 0,
        maximumCostMicrousd: spec.annotationCost ?? spec.cost ?? 0,
      });
      for (const field of RESOURCE_FIELDS) {
        resources[field] += values[field];
        if (resources[field] > problem.budgets[field]) exceeds = true;
      }
    }
    if (exceeds) continue;
    const hashes = selected.map((spec) => byId.get(spec.id).candidatePayloadHash).sort();
    if (!best || utility > best.utility
      || (utility === best.utility && hashes.join('\0') < best.hashes.join('\0'))) {
      best = { utility, hashes };
    }
  }
  return best;
}

function resealFrontier(frontier, problem) {
  frontier.candidateSetHash = hashDomain('CandidateFrontierV1', {
    planningRequestHash: frontier.planningRequestHash,
    moduleBindingSetHash: frontier.moduleBindingSetHash,
    candidatePayloadHashes: frontier.candidates.map((candidate) => candidate.candidatePayloadHash),
  });
  problem.candidateSetHash = frontier.candidateSetHash;
}

const rejectCode = (operation, code) => assert.throws(operation, { code });

test('exhaustive search returns exact optimum and zero gap', () => {
  const result = optimize(buildStack([
    { id: 'a', utility: 8, cost: 4 },
    { id: 'b', utility: 7, cost: 3 },
    { id: 'c', utility: 12, cost: 8 },
  ], { maximumSelected: 2, budgets: zeroResources({ maximumCostMicrousd: 7 }) }));
  assert.equal(result.status, 'optimal_plan_proven');
  assert.equal(result.selectedUtilityMicrounits, 15);
  assert.equal(result.lowerBoundUtilityMicrounits, 15);
  assert.equal(result.upperBoundUtilityMicrounits, 15);
  assert.equal(result.optimalityGapMicrounits, 0);
  assert.deepEqual(new Set(result.selectedCandidateIds), new Set(['a', 'b']));
});

test('limited search reports a sound lower and upper bound', () => {
  const specs = [{ id: 'a', utility: 10 }, { id: 'b', utility: 9 }, { id: 'c', utility: 8 }];
  const optimum = optimize(buildStack(specs, { maximumSelected: 2 })).selectedUtilityMicrounits;
  const result = optimize(buildStack(specs, { maximumSelected: 2, searchNodeBudget: 1 }));
  assert.equal(result.status, 'bounded_plan_search_incomplete');
  assert.ok(result.lowerBoundUtilityMicrounits <= optimum);
  assert.ok(optimum <= result.upperBoundUtilityMicrounits);
  assert.equal(result.optimalityProven, false);
});

test('no incumbent is distinct from proven infeasibility', () => {
  const pending = optimize(buildStack([{ id: 'a', utility: 1 }], {
    minimumSelected: 1, searchNodeBudget: 1,
  }));
  assert.equal(pending.status, 'no_feasible_incumbent_yet');
  assert.equal(pending.infeasibilityProven, false);
  const denied = optimize(buildStack([{ id: 'a', utility: 1, required: true, cost: 2 }], {
    minimumSelected: 1, budgets: zeroResources({ maximumCostMicrousd: 1 }),
  }));
  assert.equal(denied.status, 'infeasible_plan_proven');
  assert.equal(denied.infeasibilityProven, true);
});

test('dependencies are hard constraints rather than utility penalties', () => {
  const result = optimize(buildStack([
    { id: 'dependency', utility: 1, cost: 4 },
    { id: 'dependent', utility: 100, cost: 1, dependencies: ['dependency'] },
    { id: 'standalone', utility: 20, cost: 3 },
  ], { maximumSelected: 2, budgets: zeroResources({ maximumCostMicrousd: 3 }) }));
  assert.deepEqual(result.selectedCandidateIds, ['standalone']);
});

test('required candidate transitively requires dependencies', () => {
  const result = optimize(buildStack([
    { id: 'base', utility: 2, cost: 1 },
    { id: 'middle', utility: 3, cost: 1, dependencies: ['base'] },
    { id: 'required', utility: 4, cost: 1, dependencies: ['middle'], required: true },
  ], { minimumSelected: 3, maximumSelected: 3,
    budgets: zeroResources({ maximumCostMicrousd: 3 }) }));
  assert.deepEqual(new Set(result.selectedCandidateIds), new Set(['base', 'middle', 'required']));
});

test('decision groups allow at most one selected candidate', () => {
  const result = optimize(buildStack([
    { id: 'fast', utility: 9, group: 'implementation' },
    { id: 'safe', utility: 8, group: 'implementation' },
    { id: 'other', utility: 2 },
  ], { maximumSelected: 3 }));
  assert.deepEqual(new Set(result.selectedCandidateIds), new Set(['fast', 'other']));
});

test('all resource and cost dimensions are hard budgets', () => {
  for (const [specField, budgetField] of [
    ['cpu', 'cpuMicrounits'], ['gpu', 'gpuMicrounits'], ['memory', 'memoryMiB'],
    ['storage', 'storageBytes'], ['tokens', 'tokenCount'], ['cost', 'maximumCostMicrousd'],
  ]) {
    const budgets = zeroResources({
      [budgetField]: budgetField.endsWith('Microunits') ? 1_000_000 : 1,
    });
    assert.equal(optimize(buildStack([{ id: 'x', utility: 10, [specField]: 2 }], {
      minimumSelected: 1, budgets,
    })).status, 'infeasible_plan_proven');
  }
});

test('minimum and maximum selection counts are exact constraints', () => {
  const result = optimize(buildStack([
    { id: 'a', utility: 5 }, { id: 'b', utility: 4 }, { id: 'c', utility: 3 },
  ], { minimumSelected: 2, maximumSelected: 2 }));
  assert.equal(result.selectedCandidateIds.length, 2);
  assert.equal(result.selectedUtilityMicrounits, 9);
});

test('annotations cannot underdeclare candidate resource reservations', () => {
  rejectCode(() => optimize(buildStack([
    { id: 'a', utility: 1, cpu: 2, annotationCpu: 1 },
  ])), 'finite_optimizer_resource_underdeclared:cpuMicrounits');
});

test('annotation hashes and exact coverage are validated', () => {
  const tampered = buildStack([{ id: 'a', utility: 1 }]);
  tampered.problem.candidates[0].utilityMicrounits = 999;
  rejectCode(() => optimize(tampered), 'finite_optimizer_annotation_hash_invalid');
  const missing = buildStack([{ id: 'a', utility: 1 }, { id: 'b', utility: 2 }]);
  missing.problem.candidates.pop();
  rejectCode(() => optimize(missing), 'finite_optimizer_annotation_coverage_invalid');
});

test('self dependencies and dependency cycles are rejected', () => {
  const self = buildStack([{ id: 'a', utility: 1 }]);
  self.problem.candidates[0].dependencies = [self.problem.candidates[0].candidatePayloadHash];
  self.problem.candidates[0].annotationHash = hashOptimizationCandidateV1(
    (({ annotationHash, ...body }) => body)(self.problem.candidates[0]));
  rejectCode(() => optimize(self), 'finite_optimizer_dependency_invalid');
  rejectCode(() => optimize(buildStack([
    { id: 'a', utility: 1, dependencies: ['b'] },
    { id: 'b', utility: 1, dependencies: ['a'] },
  ])), 'finite_optimizer_dependency_cycle');
});

test('snapshot frontier and problem require the same exact subject', () => {
  const stack = buildStack([{ id: 'a', utility: 1 }]);
  const changed = makeSnapshot({ projections: [signedProjection({
    payload: { campaigns: [{ id: 'campaign-1', status: 'paused' }] },
  })] });
  assert.throws(() => optimize(stack, { snapshot: changed }));
  stack.problem.hardConstraintSetHash = H('9');
  rejectCode(() => optimize(stack), 'finite_optimizer_problem_binding_invalid');
});

test('frontier candidate cannot be spliced across planning requests', () => {
  const stack = buildStack([{ id: 'a', utility: 1 }]);
  const frontier = structuredClone(stack.frontier);
  const problem = structuredClone(stack.problem);
  const candidate = frontier.candidates[0];
  candidate.planningRequestId = 'other';
  candidate.candidatePayloadHash = hashActionCandidateV1(
    (({ candidatePayloadHash, ...body }) => body)(candidate));
  problem.candidates[0].candidatePayloadHash = candidate.candidatePayloadHash;
  problem.candidates[0].annotationHash = hashOptimizationCandidateV1(
    (({ annotationHash, ...body }) => body)(problem.candidates[0]));
  resealFrontier(frontier, problem);
  rejectCode(() => optimize({ ...stack, frontier, problem }),
    'finite_optimizer_entry_candidate_binding_mismatch');
});

test('stale snapshot and stale candidate are rejected', () => {
  const stack = buildStack([{ id: 'a', utility: 1 }]);
  assert.throws(() => optimize(stack, { now: EXPIRY }));
  const frontier = structuredClone(stack.frontier);
  const problem = structuredClone(stack.problem);
  frontier.candidates[0].expiresAt = NOW;
  frontier.candidates[0].candidatePayloadHash = hashActionCandidateV1(
    (({ candidatePayloadHash, ...body }) => body)(frontier.candidates[0]));
  problem.candidates[0].candidatePayloadHash = frontier.candidates[0].candidatePayloadHash;
  problem.candidates[0].annotationHash = hashOptimizationCandidateV1(
    (({ annotationHash, ...body }) => body)(problem.candidates[0]));
  resealFrontier(frontier, problem);
  assert.throws(() => optimize({ ...stack, frontier, problem }));
});

test('numeric coercion nonfinite negative and unsafe annotations fail closed', () => {
  for (const field of ['utilityMicrounits', ...RESOURCE_FIELDS]) {
    for (const value of ['1', true, NaN, Infinity, -1, Number.MAX_SAFE_INTEGER + 1]) {
      const stack = buildStack([{ id: 'a', utility: 1 }]);
      if (field === 'utilityMicrounits') stack.problem.candidates[0][field] = value;
      else stack.problem.candidates[0].resources[field] = value;
      assert.throws(() => optimize(stack));
    }
  }
});

test('accessors sparse arrays unknown fields and cycles fail closed', () => {
  let calls = 0;
  const accessor = buildStack([{ id: 'a', utility: 1 }]);
  Object.defineProperty(accessor.problem, 'objectiveVersion', { enumerable: true,
    get() { calls += 1; return 'objective-v1'; } });
  assert.throws(() => optimize(accessor));
  assert.equal(calls, 0);
  const sparse = buildStack([{ id: 'a', utility: 1 }, { id: 'b', utility: 2 }]);
  delete sparse.problem.candidates[0];
  assert.throws(() => optimize(sparse));
  const unknown = buildStack([{ id: 'a', utility: 1 }]);
  unknown.problem.unknown = true;
  assert.throws(() => optimize(unknown));
  const cycle = buildStack([{ id: 'a', utility: 1 }]);
  const snapshot = structuredClone(cycle.snapshot);
  snapshot.policy.self = snapshot.policy;
  assert.throws(() => optimize(cycle, { snapshot }));
});

test('annotation ordering does not alter result identity', () => {
  const specs = [{ id: 'a', utility: 5 }, { id: 'b', utility: 5 }, { id: 'c', utility: 1 }];
  const first = buildStack(specs, { maximumSelected: 1 });
  const second = buildStack(specs, { maximumSelected: 1 });
  second.problem.candidates.reverse();
  assert.equal(optimize(first).resultHash, optimize(second).resultHash);
});

test('local dominance cannot remove the only globally feasible choice', () => {
  const result = optimize(buildStack([
    { id: 'local-better', utility: 10, cost: 1, dependencies: ['expensive-dependency'] },
    { id: 'expensive-dependency', utility: 0, cost: 100 },
    { id: 'global-feasible', utility: 9, cost: 2 },
  ], { maximumSelected: 2, budgets: zeroResources({ maximumCostMicrousd: 5 }) }));
  assert.deepEqual(result.selectedCandidateIds, ['global-feasible']);
});

test('random small DAGs match an independent exhaustive oracle', () => {
  let seed = 912367;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed;
  };
  for (let caseIndex = 0; caseIndex < 80; caseIndex += 1) {
    const count = 3 + (random() % 5);
    const specs = [];
    for (let index = 0; index < count; index += 1) {
      const dependencies = [];
      for (let prior = 0; prior < index; prior += 1) {
        if ((random() % 7) === 0) dependencies.push(`c-${prior}`);
      }
      specs.push({
        id: `c-${index}`,
        utility: random() % 20,
        cost: random() % 8,
        memory: random() % 5,
        group: (random() % 5) === 0 ? `g-${random() % 2}` : null,
        required: index > 0 && (random() % 13) === 0,
        dependencies,
      });
    }
    const maximumSelected = 1 + (random() % count);
    const problemOverrides = {
      minimumSelected: random() % (maximumSelected + 1),
      maximumSelected,
      budgets: zeroResources({
        maximumCostMicrousd: 3 + (random() % 15),
        memoryMiB: 2 + (random() % 10),
      }),
    };
    const stack = buildStack(specs, problemOverrides);
    const expected = exhaustiveOracle(specs, stack.problem, stack.byId);
    const actual = optimize(stack);
    if (expected === null) {
      assert.equal(actual.status, 'infeasible_plan_proven', `case ${caseIndex}`);
    } else {
      assert.equal(actual.status, 'optimal_plan_proven', `case ${caseIndex}`);
      assert.equal(actual.selectedUtilityMicrounits, expected.utility, `case ${caseIndex}`);
      assert.deepEqual(actual.selectedCandidatePayloadHashes, expected.hashes,
        `case ${caseIndex}`);
    }
  }
});

test('finite-budget bounds enclose exhaustive optima on random DAGs', () => {
  let seed = 12345;
  const random = () => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    return seed;
  };
  for (let caseIndex = 0; caseIndex < 50; caseIndex += 1) {
    const specs = Array.from({ length: 5 }, (_, index) => ({
      id: `r-${index}`,
      utility: random() % 25,
      cost: random() % 7,
      dependencies: index > 0 && (random() % 5) === 0 ? [`r-${random() % index}`] : [],
    }));
    const common = {
      maximumSelected: 3,
      budgets: zeroResources({ maximumCostMicrousd: 10 }),
    };
    const optimum = optimize(buildStack(specs, common));
    const bounded = optimize(buildStack(specs, { ...common, searchNodeBudget: 3 }));
    if (!optimum.infeasibilityProven) {
      if (bounded.lowerBoundUtilityMicrounits !== null) {
        assert.ok(bounded.lowerBoundUtilityMicrounits <= optimum.selectedUtilityMicrounits);
      }
      assert.ok(bounded.upperBoundUtilityMicrounits >= optimum.selectedUtilityMicrounits,
        `case ${caseIndex}`);
    }
  }
});

test('output is deeply immutable and explicitly nonauthorizing', () => {
  const result = optimize(buildStack([{ id: 'a', utility: 1 }]));
  assert.ok(Object.values(result.authority).every((value) => value === false));
  assert.throws(() => result.selectedCandidateIds.push('other'), TypeError);
  assert.throws(() => { result.selectedResourceUsage.memoryMiB = 99; }, TypeError);
});

test('search-node and input limits are enforced', () => {
  const stack = buildStack([{ id: 'a', utility: 1 }]);
  stack.problem.searchNodeBudget = 100;
  assert.throws(() => optimize(stack, { limits: { maximumSearchNodes: 10 } }));
  assert.throws(() => optimize(stack, { limits: { maximumInputBytes: 512 } }));
});

test('API and limit accessors fail without invocation', () => {
  let calls = 0;
  const envelope = Object.defineProperty({}, 'snapshot', { enumerable: true,
    get() { calls += 1; return makeSnapshot(); } });
  assert.throws(() => optimizeFinitePlan(envelope));
  const stack = buildStack([{ id: 'a', utility: 1 }]);
  const limits = Object.defineProperty({}, 'maximumCandidates', { enumerable: true,
    get() { calls += 1; return 2; } });
  assert.throws(() => optimize(stack, { limits }));
  assert.equal(calls, 0);
});
