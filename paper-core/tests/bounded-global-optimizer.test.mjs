import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createBoundedGlobalOptimizer,
  sealOptimizationProblem,
} from '../../paper-application/orchestration/bounded-global-optimizer.mjs';

const H1 = `sha256:${'1'.repeat(64)}`;
const resources = (cpuUnits = 0, gpuUnits = 0, memoryMiB = 0, storageBytes = 0, tokenCount = 0) => ({
  cpuUnits, gpuUnits, memoryMiB, storageBytes, tokenCount,
});

function candidate(candidateId, decisionGroup, valueMicrounits, overrides = {}) {
  return {
    candidateId,
    decisionGroup,
    valueMicrounits,
    costMicrousd: 0,
    resourceVector: resources(),
    dependencies: [],
    conflicts: [],
    capabilities: [],
    ...overrides,
  };
}

function problem(candidates, overrides = {}) {
  return sealOptimizationProblem({
    schemaVersion: 1,
    kind: 'GlobalOptimizationProblemV1',
    problemId: 'problem-1',
    objectiveVersion: 'objective-v1',
    candidateSetHash: H1,
    resourceLimits: resources(10, 10, 10, 10, 10),
    maximumCostMicrousd: 10,
    requiredGroups: [],
    requiredCapabilities: [],
    candidates,
    ...overrides,
  });
}

function optimize(value, maximumExpansions = 1_000_000, limits) {
  return createBoundedGlobalOptimizer(limits).optimize(value, { maximumExpansions });
}

function lexicalKey(ids) {
  return [...ids].sort().join('\u0000');
}

function exhaustive(raw) {
  const groups = [...new Set(raw.candidates.map((row) => row.decisionGroup))].sort();
  const byGroup = new Map(groups.map((group) => [
    group,
    raw.candidates.filter((row) => row.decisionGroup === group),
  ]));
  const required = new Set(raw.requiredGroups);
  const byId = new Map(raw.candidates.map((row) => [row.candidateId, row]));
  let best = null;
  function walk(index, selected) {
    if (index === groups.length) {
      const ids = new Set(selected);
      for (const id of ids) {
        const row = byId.get(id);
        if (!row.dependencies.every((dep) => ids.has(dep))) return;
        if (row.conflicts.some((conflict) => ids.has(conflict))) return;
        for (const other of ids) if (byId.get(other).conflicts.includes(id)) return;
      }
      const used = resources();
      let cost = 0;
      let value = 0;
      const capabilities = new Set();
      for (const id of ids) {
        const row = byId.get(id);
        cost += row.costMicrousd;
        value += row.valueMicrounits;
        for (const key of Object.keys(used)) used[key] += row.resourceVector[key];
        for (const capability of row.capabilities) capabilities.add(capability);
      }
      if (cost > raw.maximumCostMicrousd
        || Object.keys(used).some((key) => used[key] > raw.resourceLimits[key])
        || !raw.requiredCapabilities.every((capability) => capabilities.has(capability))) return;
      const record = { value, selected: [...ids].sort(), cost, resources: used };
      if (best === null || record.value > best.value
        || (record.value === best.value
          && lexicalKey(record.selected) < lexicalKey(best.selected))) best = record;
      return;
    }
    const group = groups[index];
    if (!required.has(group)) walk(index + 1, selected);
    for (const row of byGroup.get(group)) walk(index + 1, [...selected, row.candidateId]);
  }
  walk(0, []);
  return best;
}

test('hard resource constraints cannot be offset by arbitrarily high value', () => {
  const value = problem([
    candidate('safe', 'g', 5, { resourceVector: resources(1) }),
    candidate('over', 'g', 1_000_000, { resourceVector: resources(11) }),
  ], { requiredGroups: ['g'] });
  const result = optimize(value);
  assert.equal(result.status, 'optimal');
  assert.deepEqual(result.selectedCandidateIds, ['safe']);
  assert.equal(result.lowerBoundMicrounits, 5);
  assert.equal(result.upperBoundMicrounits, 5);
});

test('dependencies are evaluated globally rather than through local dominance', () => {
  const value = problem([
    candidate('a', 'choice', 10, { dependencies: ['dataset'] }),
    candidate('b', 'choice', 8),
    candidate('dataset', 'support', 0, { costMicrousd: 11 }),
  ], { requiredGroups: ['choice'] });
  const result = optimize(value);
  assert.equal(result.status, 'optimal');
  assert.deepEqual(result.selectedCandidateIds, ['b']);
});

test('required groups, conflicts and capabilities are hard constraints', () => {
  const value = problem([
    candidate('a', 'g1', 5, { conflicts: ['b'], capabilities: ['cap-a'] }),
    candidate('b', 'g2', 6, { capabilities: ['cap-b'] }),
    candidate('c', 'g2', 3, { capabilities: ['cap-c'] }),
  ], {
    requiredGroups: ['g1', 'g2'],
    requiredCapabilities: ['cap-a', 'cap-c'],
  });
  const result = optimize(value);
  assert.equal(result.status, 'optimal');
  assert.deepEqual(result.selectedCandidateIds, ['a', 'c']);
});

test('equal objectives use deterministic lexical selected-ID tie breaking', () => {
  const value = problem([
    candidate('b', 'g', 5),
    candidate('a', 'g', 5),
  ], { requiredGroups: ['g'] });
  const result = optimize(value);
  assert.deepEqual(result.selectedCandidateIds, ['a']);
});

test('input candidate order does not change the result bytes', () => {
  const rows = [
    candidate('a', 'g1', 5),
    candidate('b', 'g1', 4),
    candidate('c', 'g2', 6),
  ];
  const left = optimize(problem(rows));
  const right = optimize(problem([...rows].reverse()));
  assert.deepEqual(left, right);
});

test('full search agrees with an independent exhaustive oracle', () => {
  let seed = 981723;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed;
  };
  for (let trial = 0; trial < 100; trial += 1) {
    const rows = [];
    for (let group = 0; group < 4; group += 1) {
      for (let option = 0; option < 2; option += 1) {
        const id = `g${group}-${option}`;
        rows.push(candidate(id, `g${group}`, Number(random() % 21) - 5, {
          costMicrousd: random() % 5,
          resourceVector: resources(random() % 4, 0, random() % 4),
          capabilities: (random() % 5 === 0) ? ['special'] : [],
        }));
      }
    }
    if (random() % 2 === 0) rows[0] = { ...rows[0], conflicts: [rows[3].candidateId] };
    if (random() % 3 === 0) rows[5] = { ...rows[5], dependencies: [rows[1].candidateId] };
    const raw = {
      schemaVersion: 1,
      kind: 'GlobalOptimizationProblemV1',
      problemId: `random-${trial}`,
      objectiveVersion: 'objective-v1',
      candidateSetHash: H1,
      resourceLimits: resources(6, 0, 6, 0, 0),
      maximumCostMicrousd: 8,
      requiredGroups: (random() % 2 === 0) ? ['g0'] : [],
      requiredCapabilities: (rows.some((row) => row.capabilities.includes('special'))
        && random() % 4 === 0) ? ['special'] : [],
      candidates: rows,
    };
    const expected = exhaustive(raw);
    const result = optimize(sealOptimizationProblem(raw));
    if (expected === null) {
      assert.equal(result.status, 'infeasible', `trial ${trial}`);
    } else {
      assert.equal(result.status, 'optimal', `trial ${trial}`);
      assert.equal(result.lowerBoundMicrounits, expected.value, `trial ${trial}`);
      assert.deepEqual(result.selectedCandidateIds, expected.selected, `trial ${trial}`);
    }
  }
});

test('limited search reports bounds that contain the exhaustive optimum', () => {
  const raw = {
    schemaVersion: 1,
    kind: 'GlobalOptimizationProblemV1',
    problemId: 'bounded',
    objectiveVersion: 'objective-v1',
    candidateSetHash: H1,
    resourceLimits: resources(5, 0, 5, 0, 0),
    maximumCostMicrousd: 5,
    requiredGroups: ['g0'],
    requiredCapabilities: [],
    candidates: Array.from({ length: 12 }, (_, index) => candidate(
      `c${index}`,
      `g${Math.floor(index / 2)}`,
      (index * 7) % 17,
      { costMicrousd: index % 3, resourceVector: resources(index % 4, 0, index % 2) },
    )),
  };
  const sealed = sealOptimizationProblem(raw);
  const expected = exhaustive(raw);
  assert.ok(expected);
  for (const budget of [1, 2, 3, 5, 10, 20]) {
    const result = optimize(sealed, budget);
    assert.equal(result.searchComplete, false);
    if (result.lowerBoundMicrounits !== null) {
      assert.ok(result.lowerBoundMicrounits <= expected.value);
    }
    assert.ok(result.upperBoundMicrounits >= expected.value);
    if (result.lowerBoundMicrounits !== null) {
      assert.equal(
        result.optimalityGapMicrounits,
        result.upperBoundMicrounits - result.lowerBoundMicrounits,
      );
    }
  }
});

test('no incumbent under a budget is distinct from proven infeasibility', () => {
  const feasible = problem([
    candidate('a', 'g', 1),
  ], { requiredGroups: ['g'] });
  const early = optimize(feasible, 1);
  assert.equal(early.status, 'no_feasible_incumbent');
  assert.equal(early.searchComplete, false);
  assert.equal(early.infeasibilityProven, false);
  assert.ok(early.upperBoundMicrounits >= 1);

  const impossible = problem([
    candidate('a', 'g', 1),
  ], { requiredCapabilities: ['missing'] });
  const complete = optimize(impossible);
  assert.equal(complete.status, 'infeasible');
  assert.equal(complete.searchComplete, true);
  assert.equal(complete.infeasibilityProven, true);
  assert.equal(complete.upperBoundMicrounits, null);
});

test('problem hashes are recomputed before any search', () => {
  const sealed = problem([candidate('a', 'g', 1)]);
  assert.throws(() => optimize({ ...sealed, problemHash: H1 }), {
    code: 'optimization_problem_hash_invalid',
  });
});

test('invalid dependency and conflict identities are rejected structurally', () => {
  assert.throws(() => problem([
    candidate('a', 'g', 1, { dependencies: ['missing'] }),
  ]), { code: 'optimization_dependency_invalid' });
  assert.throws(() => problem([
    candidate('a', 'g', 1, { conflicts: ['a'] }),
  ]), { code: 'optimization_conflict_invalid' });
});

test('numeric overflow, coercion and negative resource/cost values fail closed', () => {
  for (const rows of [
    [candidate('a', 'g', 1, { costMicrousd: -1 })],
    [candidate('a', 'g', 1, { costMicrousd: '1' })],
    [candidate('a', 'g', 1, { resourceVector: resources(-1) })],
    [candidate('a', 'g', Number.MAX_SAFE_INTEGER), candidate('b', 'h', 1)],
  ]) {
    const sealed = () => problem(rows, { requiredGroups: ['g'] });
    if (rows.length === 2) {
      const value = sealed();
      assert.throws(() => optimize(value), { code: 'optimization_integer_overflow' });
    } else {
      assert.throws(sealed);
    }
  }
});

test('accessor properties and sparse arrays are rejected without getter execution', () => {
  let calls = 0;
  const hostile = Object.defineProperty(candidate('a', 'g', 1), 'candidateId', {
    enumerable: true,
    get() {
      calls += 1;
      return 'a';
    },
  });
  assert.throws(() => problem([hostile]), { code: 'optimization_candidate_invalid' });
  assert.equal(calls, 0);
  const sparse = [];
  sparse.length = 1;
  assert.throws(() => problem(sparse), { code: 'optimization_candidate_set_invalid' });
});

test('result authority is always nonactivating and deeply immutable', () => {
  const result = optimize(problem([candidate('a', 'g', 1)]));
  assert.deepEqual(result.authority, {
    executionAuthorized: false,
    stateMutationAuthorized: false,
    productionActivationAuthorized: false,
  });
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.selectedCandidateIds), true);
  assert.throws(() => {
    result.authority.executionAuthorized = true;
  }, TypeError);
});

test('expansion budgets and optimizer limits are explicit bounded integers', () => {
  const value = problem([candidate('a', 'g', 1)]);
  for (const maximumExpansions of [0, -1, 1.5, '1', 1_000_001]) {
    assert.throws(() => createBoundedGlobalOptimizer().optimize(value, { maximumExpansions }), {
      code: 'optimizer_expansion_limit_invalid',
    });
  }
  for (const limits of [
    null,
    [],
    { maximumCandidates: 0 },
    { maximumGroups: 1025 },
    { unknown: 1 },
  ]) {
    assert.throws(() => createBoundedGlobalOptimizer(limits), {
      code: 'optimizer_limits_invalid',
    });
  }
});

test('an objective tie is not called selection-optimal until the frontier is exhausted', () => {
  const value = problem([
    candidate('a', 'g0', 1),
    candidate('b', 'g0', 1),
    candidate('c', 'g1', 0),
  ]);
  const early = optimize(value, 2);
  assert.equal(early.searchComplete, false);
  assert.equal(early.objectiveOptimalityProven, false);
  const complete = optimize(value);
  assert.equal(complete.status, 'optimal');
  assert.equal(complete.objectiveOptimalityProven, true);
  assert.deepEqual(complete.selectedCandidateIds, ['a']);
});

test('negative objective values remain selectable for required groups only', () => {
  const required = optimize(problem([
    candidate('a', 'g', -5),
    candidate('b', 'g', -3),
  ], { requiredGroups: ['g'] }));
  assert.deepEqual(required.selectedCandidateIds, ['b']);
  assert.equal(required.lowerBoundMicrounits, -3);
  const optional = optimize(problem([
    candidate('a', 'g', -1),
  ]));
  assert.deepEqual(optional.selectedCandidateIds, []);
  assert.equal(optional.lowerBoundMicrounits, 0);
});

test('resource and cost totals in the selected incumbent are exact', () => {
  const result = optimize(problem([
    candidate('a', 'g0', 5, { costMicrousd: 2, resourceVector: resources(1, 2, 3, 4, 5) }),
    candidate('b', 'g1', 6, { costMicrousd: 3, resourceVector: resources(2, 1, 1, 0, 1) }),
  ], {
    resourceLimits: resources(3, 3, 4, 4, 6),
    maximumCostMicrousd: 5,
  }));
  assert.deepEqual(result.selectedCandidateIds, ['a', 'b']);
  assert.equal(result.selectedCostMicrousd, 5);
  assert.deepEqual(result.selectedResourceVector, resources(3, 3, 4, 4, 6));
});
