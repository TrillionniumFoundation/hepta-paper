import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import {
  evaluateSelectedPlan,
  optimizeBoundedPlan,
} from '../../paper-application/orchestration/bounded-global-optimizer.mjs';

const H = (character) => `sha256:${character.repeat(64)}`;
const dimensions = ['cpuUnits', 'gpuUnits', 'memoryMiB', 'storageBytes',
  'tokenCount', 'maximumCostMicrousd'];
const resources = (overrides = {}) => Object.fromEntries(dimensions.map((key) =>
  [key, overrides[key] ?? 0]));
function candidate(id, utility, overrides = {}) {
  return {
    candidateId: id,
    candidatePayloadHash: H(id[0] === 'a' ? 'a' : id[0] === 'b' ? 'b' : id[0] === 'c' ? 'c' : 'd'),
    utilityMicrounits: utility,
    resourceVector: resources(),
    dependencies: [],
    conflicts: [],
    decisionGroup: null,
    providesCapabilities: [],
    ...overrides,
  };
}
function request(candidates, overrides = {}) {
  return {
    version: 1,
    kind: 'BoundedPlanOptimizationRequestV1',
    requestId: 'optimization-1',
    planningRequestHash: H('1'),
    stateSnapshotHash: H('2'),
    candidateSetHash: H('3'),
    objectiveVersion: 'objective-v1',
    resourceLimits: resources({ cpuUnits: 10, gpuUnits: 10, memoryMiB: 100,
      storageBytes: 1000, tokenCount: 1000, maximumCostMicrousd: 1000 }),
    requiredCandidateIds: [],
    requiredCapabilities: [],
    candidates,
    maximumExpansions: 100000,
    ...overrides,
  };
}
function selected(result) { return result.selectedPlan?.selectedCandidateIds || []; }

function feasible(req, ids) {
  const set = new Set(ids);
  if (req.requiredCandidateIds.some((id) => !set.has(id))) return false;
  const byId = new Map(req.candidates.map((row) => [row.candidateId, row]));
  const used = resources();
  const groups = new Map();
  const capabilities = new Set();
  for (const id of ids) {
    const row = byId.get(id); if (!row) return false;
    if (row.dependencies.some((dependency) => !set.has(dependency))) return false;
    if (row.conflicts.some((conflict) => set.has(conflict))) return false;
    if (row.decisionGroup !== null) {
      if (groups.has(row.decisionGroup)) return false;
      groups.set(row.decisionGroup, id);
    }
    for (const key of dimensions) {
      used[key] += row.resourceVector[key];
      if (used[key] > req.resourceLimits[key]) return false;
    }
    row.providesCapabilities.forEach((capability) => capabilities.add(capability));
  }
  return req.requiredCapabilities.every((capability) => capabilities.has(capability));
}
function oracle(req) {
  const rows = [...req.candidates].sort((a, b) => Buffer.compare(Buffer.from(a.candidateId), Buffer.from(b.candidateId)));
  let best = null;
  for (let mask = 0; mask < (1 << rows.length); mask += 1) {
    const ids = rows.filter((_, index) => (mask & (1 << index)) !== 0).map((row) => row.candidateId);
    if (!feasible(req, ids)) continue;
    const utility = ids.reduce((sum, id) => sum + BigInt(rows.find((row) => row.candidateId === id).utilityMicrounits), 0n);
    if (best === null || utility > best.utility
      || (utility === best.utility && JSON.stringify(ids) < JSON.stringify(best.ids))) best = { ids, utility };
  }
  return best;
}

test('selects an exact optimum under dependency, group, conflict and resource constraints', () => {
  const rows = [
    candidate('a', 4, { resourceVector: resources({ cpuUnits: 2 }), providesCapabilities: ['foundation'] }),
    candidate('b', 9, { dependencies: ['a'], resourceVector: resources({ cpuUnits: 5 }), decisionGroup: 'method' }),
    candidate('c', 8, { resourceVector: resources({ cpuUnits: 3 }), decisionGroup: 'method', conflicts: ['d'] }),
    candidate('d', 3, { resourceVector: resources({ cpuUnits: 1 }), conflicts: ['c'] }),
  ];
  const result = optimizeBoundedPlan(request(rows, { resourceLimits: resources({ cpuUnits: 7 }),
    requiredCapabilities: ['foundation'] }));
  assert.equal(result.status, 'optimal');
  assert.deepEqual(selected(result), ['a', 'b']);
  assert.equal(result.selectedPlan.objectiveMicrounits, '13');
  assert.equal(result.proof.lowerBoundMicrounits, '13');
  assert.equal(result.proof.upperBoundMicrounits, '13');
  assert.equal(result.proof.absoluteGapMicrounits, '0');
});

test('required dependency closure can include a negative-utility prerequisite', () => {
  const rows = [candidate('a', -5), candidate('b', 10, { dependencies: ['a'], providesCapabilities: ['x'] })];
  const result = optimizeBoundedPlan(request(rows, { requiredCapabilities: ['x'] }));
  assert.deepEqual(selected(result), ['a', 'b']);
  assert.equal(result.selectedPlan.objectiveMicrounits, '5');
});

test('limited search returns a truthful incumbent lower bound and pending upper bound', () => {
  const rows = [candidate('a', 5), candidate('b', 4), candidate('c', 3)];
  const result = optimizeBoundedPlan(request(rows, { maximumExpansions: 3,
    resourceLimits: resources({ cpuUnits: 0 }) }));
  assert.ok(['bounded_gap', 'no_incumbent', 'optimal'].includes(result.status));
  const exact = oracle(request(rows, { resourceLimits: resources({ cpuUnits: 0 }) }));
  if (result.selectedPlan) assert.ok(BigInt(result.proof.lowerBoundMicrounits) <= exact.utility);
  assert.ok(BigInt(result.proof.upperBoundMicrounits) >= exact.utility);
});

test('no-incumbent is distinct from proven infeasible', () => {
  const rows = [candidate('a', 1), candidate('b', 2, { providesCapabilities: ['needed'] })];
  const limited = optimizeBoundedPlan(request(rows, { requiredCapabilities: ['needed'], maximumExpansions: 1 }));
  assert.equal(limited.status, 'no_incumbent');
  assert.equal(limited.selectedPlan, null);
  const impossible = optimizeBoundedPlan(request(rows, { requiredCapabilities: ['absent'] }));
  assert.equal(impossible.status, 'infeasible');
  assert.equal(impossible.proof.complete, true);
});

test('equal-utility plans use deterministic UTF-8 selected-id tie breaking', () => {
  const rows = [candidate('Z', 4, { decisionGroup: 'one' }), candidate('a', 4, { decisionGroup: 'one',
    candidatePayloadHash: H('e') })];
  const result = optimizeBoundedPlan(request(rows));
  assert.deepEqual(selected(result), ['Z']);
});

test('input candidate order, locale and hash seed do not change the result hash', () => {
  const rows = [candidate('c', 3), candidate('a', 1), candidate('b', 2)];
  const hashes = [rows, [...rows].reverse()].map((candidates) => optimizeBoundedPlan(request(candidates)).optimizationResultHash);
  assert.equal(new Set(hashes).size, 1);
  const moduleUrl = new URL('../../paper-application/orchestration/bounded-global-optimizer.mjs', import.meta.url).href;
  const source = `import {optimizeBoundedPlan as o} from ${JSON.stringify(moduleUrl)};\n`
    + `const h=c=>'sha256:'+c.repeat(64),r={cpuUnits:0,gpuUnits:0,memoryMiB:0,storageBytes:0,tokenCount:0,maximumCostMicrousd:0};`
    + `const c=(id,u,x)=>({candidateId:id,candidatePayloadHash:h(x),utilityMicrounits:u,resourceVector:r,dependencies:[],conflicts:[],decisionGroup:'g',providesCapabilities:[]});`
    + `console.log(o({version:1,kind:'BoundedPlanOptimizationRequestV1',requestId:'x',planningRequestHash:h('1'),stateSnapshotHash:h('2'),candidateSetHash:h('3'),objectiveVersion:'v',resourceLimits:r,requiredCandidateIds:[],requiredCapabilities:[],candidates:[c('a',1,'e'),c('Z',1,'f')],maximumExpansions:100}).optimizationResultHash);`;
  const outputs = [['C', '1'], ['tr_TR.UTF-8', '2'], ['de_DE.UTF-8', '17']].map(([locale, seed]) => {
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
      encoding: 'utf8', env: { ...process.env, LANG: locale, LC_ALL: locale, NODE_HASH_SEED: seed },
    });
    assert.equal(child.status, 0, child.stderr); return child.stdout.trim();
  });
  assert.equal(new Set(outputs).size, 1);
});

test('evaluateSelectedPlan independently rejects missing dependencies and constraints', () => {
  const req = request([candidate('a', 1), candidate('b', 2, { dependencies: ['a'] })]);
  assert.throws(() => evaluateSelectedPlan(req, ['b']), { code: 'optimizer_selected_dependencies_missing' });
  assert.equal(evaluateSelectedPlan(req, ['a', 'b']).objectiveMicrounits, '3');
});

test('cycles, unknown dependencies and asymmetric conflicts fail closed', () => {
  assert.throws(() => optimizeBoundedPlan(request([
    candidate('a', 1, { dependencies: ['b'] }), candidate('b', 1, { dependencies: ['a'] }),
  ])), { code: 'optimizer_dependency_cycle' });
  assert.throws(() => optimizeBoundedPlan(request([candidate('a', 1, { dependencies: ['missing'] })])),
    { code: 'optimizer_candidate_dependency_invalid' });
  assert.throws(() => optimizeBoundedPlan(request([
    candidate('a', 1, { conflicts: ['b'] }), candidate('b', 1),
  ])), { code: 'optimizer_candidate_conflict_asymmetric' });
});

test('all identity and exact hash bindings are present in the result', () => {
  const req = request([candidate('a', 1)]);
  const result = optimizeBoundedPlan(req);
  assert.equal(result.requestId, req.requestId);
  assert.equal(result.planningRequestHash, req.planningRequestHash);
  assert.equal(result.stateSnapshotHash, req.stateSnapshotHash);
  assert.equal(result.candidateSetHash, req.candidateSetHash);
  assert.equal(result.objectiveVersion, req.objectiveVersion);
  assert.match(result.optimizationRequestHash, /^sha256:/u);
  assert.match(result.optimizationResultHash, /^sha256:/u);
  assert.ok(Object.values(result.authority).every((value) => value === false));
  assert.equal(result.externalActionPerformed, false);
});

test('accessors and malformed arrays are rejected without executing code', () => {
  let calls = 0;
  const row = candidate('a', 1);
  Object.defineProperty(row, 'candidateId', { enumerable: true, get() { calls += 1; return 'a'; } });
  assert.throws(() => optimizeBoundedPlan(request([row])), { code: 'optimizer_candidate_invalid' });
  assert.equal(calls, 0);
  const sparse = new Array(2); sparse[1] = candidate('a', 1);
  assert.throws(() => optimizeBoundedPlan(request(sparse)), { code: 'optimizer_candidates_invalid' });
});

test('nonfinite, fractional and unsafe values fail before search', () => {
  for (const value of [NaN, Infinity, -Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1, '1']) {
    const row = candidate('a', 1); row.resourceVector.cpuUnits = value;
    assert.throws(() => optimizeBoundedPlan(request([row])), { code: 'optimizer_candidate_resources_invalid' });
  }
});

test('candidate IDs and payload hashes are both unique semantic identities', () => {
  assert.throws(() => optimizeBoundedPlan(request([candidate('a', 1), { ...candidate('a', 2), candidatePayloadHash: H('b') }])),
    { code: 'optimizer_candidate_id_duplicate' });
  assert.throws(() => optimizeBoundedPlan(request([candidate('a', 1), { ...candidate('b', 2), candidatePayloadHash: H('a') }])),
    { code: 'optimizer_candidate_payload_hash_duplicate' });
});

test('caller mutation cannot alter an already returned plan', () => {
  const rows = [candidate('a', 1)]; const req = request(rows); const result = optimizeBoundedPlan(req);
  rows[0].utilityMicrounits = 999; rows[0].resourceVector.cpuUnits = 999;
  assert.equal(result.selectedPlan.objectiveMicrounits, '1');
  assert.deepEqual(result.selectedPlan.selectedCandidateIds, ['a']);
  assert.throws(() => { result.selectedPlan.selectedCandidateIds.push('b'); }, TypeError);
});

test('BigInt accounting prevents aggregate overflow while input stays safe-integer quantized', () => {
  const max = Number.MAX_SAFE_INTEGER;
  const rows = [candidate('a', max, { resourceVector: resources({ storageBytes: max }) }),
    candidate('b', max, { resourceVector: resources({ storageBytes: max }), candidatePayloadHash: H('b') })];
  const result = optimizeBoundedPlan(request(rows, { resourceLimits: resources({ storageBytes: max }) }));
  assert.equal(result.status, 'optimal');
  assert.equal(result.selectedPlan.objectiveMicrounits, String(max));
  assert.equal(result.selectedPlan.usedResources.storageBytes, String(max));
});

test('dependency-context counterexample is not pruned by local value/cost dominance', () => {
  const rows = [
    candidate('a', 5, { dependencies: ['expensive'], decisionGroup: 'method' }),
    candidate('b', 4, { resourceVector: resources({ maximumCostMicrousd: 3 }), decisionGroup: 'method',
      candidatePayloadHash: H('b') }),
    candidate('expensive', 0, { resourceVector: resources({ maximumCostMicrousd: 100 }),
      candidatePayloadHash: H('e') }),
  ];
  const result = optimizeBoundedPlan(request(rows, { resourceLimits: resources({ maximumCostMicrousd: 5 }) }));
  assert.deepEqual(selected(result), ['b']);
  assert.equal(result.status, 'optimal');
});

test('full search and limited-search bounds agree with an independent exhaustive oracle', () => {
  let seed = 0x51f15e;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
  for (let sample = 0; sample < 80; sample += 1) {
    const count = 1 + (random() % 9);
    const rows = [];
    for (let index = 0; index < count; index += 1) {
      const id = String.fromCharCode(97 + index);
      const dependencies = index > 0 && random() % 4 === 0
        ? [String.fromCharCode(97 + (random() % index))] : [];
      rows.push(candidate(id, Number(random() % 21) - 5, {
        candidatePayloadHash: `sha256:${(index + 10).toString(16).padStart(64, '0')}`,
        resourceVector: resources({ cpuUnits: random() % 4, memoryMiB: random() % 6,
          maximumCostMicrousd: random() % 8 }),
        dependencies,
        decisionGroup: random() % 5 === 0 ? `g${random() % 2}` : null,
        providesCapabilities: random() % 6 === 0 ? ['cap'] : [],
      }));
    }
    const req = request(rows, { resourceLimits: resources({ cpuUnits: 6, memoryMiB: 10,
      maximumCostMicrousd: 12 }), requiredCapabilities: rows.some((row) => row.providesCapabilities.length)
      && random() % 3 === 0 ? ['cap'] : [] });
    const exact = oracle(req);
    const full = optimizeBoundedPlan(req);
    assert.equal(full.status, exact === null ? 'infeasible' : 'optimal');
    if (exact) {
      assert.equal(BigInt(full.selectedPlan.objectiveMicrounits), exact.utility);
      assert.deepEqual(full.selectedPlan.selectedCandidateIds, exact.ids);
    }
    for (const budget of [1, 2, 5, 10]) {
      const limited = optimizeBoundedPlan({ ...req, maximumExpansions: budget });
      if (exact === null) {
        if (limited.status === 'infeasible') assert.equal(limited.proof.complete, true);
      } else {
        if (limited.selectedPlan) assert.ok(BigInt(limited.proof.lowerBoundMicrounits) <= exact.utility);
        assert.ok(BigInt(limited.proof.upperBoundMicrounits) >= exact.utility);
        if (limited.status === 'optimal') assert.equal(BigInt(limited.selectedPlan.objectiveMicrounits), exact.utility);
      }
    }
  }
});
