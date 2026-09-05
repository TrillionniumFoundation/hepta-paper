import assert from 'node:assert/strict';
import test from 'node:test';
import { optimizeBoundedPlan } from '../../paper-application/orchestration/bounded-global-optimizer.mjs';
import {
  buildBoundedOptimizationRequest,
  candidateOptimizationModelSetHash,
} from '../../paper-application/orchestration/candidate-optimization-model.mjs';

const H = (c) => `sha256:${c.repeat(64)}`;
const dimensions = ['cpuUnits', 'gpuUnits', 'memoryMiB', 'storageBytes',
  'tokenCount', 'maximumCostMicrousd'];
const resources = (values = {}) => Object.fromEntries(dimensions.map((key) => [key, values[key] ?? 0]));
function frontier() {
  return { version: 1, kind: 'CandidateFrontierV1', planningRequestHash: H('1'),
    stateSnapshotHash: H('2'), candidateSetHash: H('3'), candidateFrontierHash: H('4'),
    dominanceReductionApplied: false, externalActionPerformed: false,
    candidates: [
      { candidateId: 'a', candidatePayloadHash: H('a'), resourceVector: resources({ cpuUnits: 2 }) },
      { candidateId: 'b', candidatePayloadHash: H('b'), resourceVector: resources({ cpuUnits: 1 }) },
    ] };
}
function modelBody(values = {}) {
  return { version: 1, kind: 'CandidateOptimizationModelSetV1', modelSetId: 'model-1',
    planningRequestHash: H('1'), stateSnapshotHash: H('2'), candidateSetHash: H('3'),
    objectiveVersion: 'objective-v1', entries: [
      { candidateId: 'a', candidatePayloadHash: H('a'), utilityMicrounits: 5,
        dependencies: [], conflicts: [], decisionGroup: 'method', providesCapabilities: [] },
      { candidateId: 'b', candidatePayloadHash: H('b'), utilityMicrounits: 4,
        dependencies: [], conflicts: [], decisionGroup: 'method', providesCapabilities: [] },
    ], requiredCandidateIds: [], requiredCapabilities: [],
    resourceLimits: resources({ cpuUnits: 1 }), maximumExpansions: 1000, ...values };
}
function modelSet(values = {}) {
  const body = modelBody(values);
  return { ...body, modelSetHash: candidateOptimizationModelSetHash(body) };
}

test('projects exact frontier resources into a bounded optimization request', () => {
  const projected = buildBoundedOptimizationRequest({ candidateFrontier: frontier(), modelSet: modelSet() });
  assert.equal(projected.status, 'projected_nonactivating');
  assert.deepEqual(projected.optimizationRequest.candidates.map((row) => row.resourceVector.cpuUnits), [2, 1]);
  const result = optimizeBoundedPlan(projected.optimizationRequest);
  assert.deepEqual(result.selectedPlan.selectedCandidateIds, ['b']);
  assert.ok(Object.values(projected.authority).every((flag) => flag === false));
});

test('model entries cannot repeat or override candidate resources', () => {
  const body = modelBody(); body.entries[0].resourceVector = resources({ cpuUnits: 0 });
  assert.throws(() => candidateOptimizationModelSetHash(body), { code: 'candidate_model_entry_invalid' });
});

test('model-set hash binds utility, dependencies, objective and policy limits', () => {
  for (const mutate of [
    (body) => { body.entries[0].utilityMicrounits += 1; },
    (body) => { body.entries[1].dependencies = ['a']; },
    (body) => { body.objectiveVersion = 'objective-v2'; },
    (body) => { body.resourceLimits.cpuUnits = 2; },
    (body) => { body.maximumExpansions = 2; },
  ]) {
    const body = modelBody(); const set = modelSet(); mutate(body);
    set.entries = body.entries; set.objectiveVersion = body.objectiveVersion;
    set.resourceLimits = body.resourceLimits; set.maximumExpansions = body.maximumExpansions;
    assert.throws(() => buildBoundedOptimizationRequest({ candidateFrontier: frontier(), modelSet: set }),
      { code: 'candidate_model_set_hash_mismatch' });
  }
});

test('frontier request, snapshot and candidate-set hashes must match model set', () => {
  for (const key of ['planningRequestHash', 'stateSnapshotHash', 'candidateSetHash']) {
    const set = modelSet(); set[key] = H('e');
    const { modelSetHash: ignored, ...body } = set;
    set.modelSetHash = candidateOptimizationModelSetHash(body);
    assert.throws(() => buildBoundedOptimizationRequest({ candidateFrontier: frontier(), modelSet: set }),
      { code: 'candidate_model_frontier_binding_mismatch' });
  }
});

test('model coverage and candidate payload binding are exact', () => {
  const missing = modelBody(); missing.entries.pop();
  const missingSet = { ...missing, modelSetHash: candidateOptimizationModelSetHash(missing) };
  assert.throws(() => buildBoundedOptimizationRequest({ candidateFrontier: frontier(), modelSet: missingSet }),
    { code: 'candidate_model_coverage_invalid' });
  const drift = modelBody(); drift.entries[0].candidatePayloadHash = H('e');
  const driftSet = { ...drift, modelSetHash: candidateOptimizationModelSetHash(drift) };
  assert.throws(() => buildBoundedOptimizationRequest({ candidateFrontier: frontier(), modelSet: driftSet }),
    { code: 'candidate_model_entry_binding_mismatch' });
});

test('candidate and model order do not affect projection identity', () => {
  const left = buildBoundedOptimizationRequest({ candidateFrontier: frontier(), modelSet: modelSet() });
  const f = frontier(); f.candidates.reverse(); const body = modelBody(); body.entries.reverse();
  const right = buildBoundedOptimizationRequest({ candidateFrontier: f,
    modelSet: { ...body, modelSetHash: candidateOptimizationModelSetHash(body) } });
  assert.equal(left.optimizationRequestProjectionHash, right.optimizationRequestProjectionHash);
});

test('fractional, nonfinite and unsafe frontier resources fail before modeling', () => {
  for (const value of [0.5, NaN, Infinity, -1, Number.MAX_SAFE_INTEGER + 1, '1']) {
    const f = frontier(); f.candidates[0].resourceVector.cpuUnits = value;
    assert.throws(() => buildBoundedOptimizationRequest({ candidateFrontier: f, modelSet: modelSet() }),
      { code: 'candidate_model_candidate_resources_invalid' });
  }
});

test('accessors and sparse arrays are rejected without getter execution', () => {
  let calls = 0; const set = modelSet();
  Object.defineProperty(set.entries[0], 'utilityMicrounits', { enumerable: true,
    get() { calls += 1; return 5; } });
  assert.throws(() => buildBoundedOptimizationRequest({ candidateFrontier: frontier(), modelSet: set }),
    { code: 'candidate_model_entry_invalid' });
  assert.equal(calls, 0);
  const sparse = modelBody(); sparse.entries = new Array(2); sparse.entries[1] = modelBody().entries[1];
  assert.throws(() => candidateOptimizationModelSetHash(sparse), { code: 'candidate_model_entries_invalid' });
});

test('caller mutation cannot change an already projected request', () => {
  const f = frontier(); const set = modelSet();
  const projected = buildBoundedOptimizationRequest({ candidateFrontier: f, modelSet: set });
  f.candidates[1].resourceVector.cpuUnits = 99; set.entries[1].utilityMicrounits = 999;
  assert.equal(projected.optimizationRequest.candidates[1].resourceVector.cpuUnits, 1);
  assert.equal(projected.optimizationRequest.candidates[1].utilityMicrounits, 4);
  assert.throws(() => { projected.optimizationRequest.candidates.push({}); }, TypeError);
});

test('unknown dependencies and asymmetric conflicts remain fail-closed in optimizer validation', () => {
  const body = modelBody(); body.entries[0].dependencies = ['missing'];
  const projected = buildBoundedOptimizationRequest({ candidateFrontier: frontier(),
    modelSet: { ...body, modelSetHash: candidateOptimizationModelSetHash(body) } });
  assert.throws(() => optimizeBoundedPlan(projected.optimizationRequest),
    { code: 'optimizer_candidate_dependency_invalid' });
});
