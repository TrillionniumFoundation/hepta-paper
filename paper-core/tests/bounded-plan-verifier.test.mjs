import assert from 'node:assert/strict';
import test from 'node:test';
import { optimizeBoundedPlan } from '../../paper-application/orchestration/bounded-global-optimizer.mjs';
import {
  boundedPlanAcceptancePolicyHash,
  verifyBoundedPlan,
} from '../../paper-application/orchestration/bounded-plan-verifier.mjs';

const H = (c) => `sha256:${c.repeat(64)}`;
const dimensions = ['cpuUnits', 'gpuUnits', 'memoryMiB', 'storageBytes',
  'tokenCount', 'maximumCostMicrousd'];
const resources = (values = {}) => Object.fromEntries(dimensions.map((key) => [key, values[key] ?? 0]));
const candidate = (id, utility, values = {}) => ({ candidateId: id,
  candidatePayloadHash: H(values.hash || id[0]), utilityMicrounits: utility,
  resourceVector: resources(values.resources), dependencies: values.dependencies || [],
  conflicts: values.conflicts || [], decisionGroup: values.group || null,
  providesCapabilities: values.capabilities || [] });
function request(candidates, values = {}) {
  return { version: 1, kind: 'BoundedPlanOptimizationRequestV1', requestId: 'verify-1',
    planningRequestHash: H('1'), stateSnapshotHash: H('2'), candidateSetHash: H('3'),
    objectiveVersion: 'objective-v1', resourceLimits: resources(values.limits || { cpuUnits: 10 }),
    requiredCandidateIds: values.required || [], requiredCapabilities: values.capabilities || [],
    candidates, maximumExpansions: values.maximumExpansions || 1000 };
}
function policy(values = {}) {
  const body = { version: 1, kind: 'BoundedPlanAcceptancePolicyV1', policyId: 'acceptance-v1',
    allowedStatuses: values.allowedStatuses || ['optimal'],
    maximumAcceptedGapMicrounits: values.maximumAcceptedGapMicrounits || '0',
    requireObjectiveOptimal: values.requireObjectiveOptimal ?? true,
    requireCompleteTieBreak: values.requireCompleteTieBreak ?? true };
  return { ...body, policyHash: boundedPlanAcceptancePolicyHash(body) };
}

const exactRequest = () => request([candidate('a', 2, { resources: { cpuUnits: 1 } }),
  candidate('b', 3, { resources: { cpuUnits: 1 } })]);

test('accepts an exact optimal result and remains explicitly nonactivating', () => {
  const req = exactRequest(); const result = optimizeBoundedPlan(req);
  const verified = verifyBoundedPlan({ request: req, result, policy: policy() });
  assert.equal(verified.status, 'verified_nonactivating');
  assert.equal(verified.optimizationResultHash, result.optimizationResultHash);
  assert.deepEqual(verified.selectedPlan.selectedCandidateIds, ['a', 'b']);
  assert.ok(Object.values(verified.authority).every((flag) => flag === false));
  assert.equal(verified.externalActionPerformed, false);
});

test('any result mutation is rejected even when the old hash field is retained', () => {
  const req = exactRequest(); const result = structuredClone(optimizeBoundedPlan(req));
  result.selectedPlan.objectiveMicrounits = '999';
  assert.throws(() => verifyBoundedPlan({ request: req, result, policy: policy() }),
    { code: 'bounded_plan_result_mismatch' });
});

test('a result from a different frozen request cannot be spliced', () => {
  const left = exactRequest(); const right = { ...exactRequest(), stateSnapshotHash: H('4') };
  const result = optimizeBoundedPlan(left);
  assert.throws(() => verifyBoundedPlan({ request: right, result, policy: policy() }),
    { code: 'bounded_plan_result_mismatch' });
});

test('policy hash binds every acceptance condition', () => {
  const req = exactRequest(); const result = optimizeBoundedPlan(req); const p = policy();
  p.requireCompleteTieBreak = false;
  assert.throws(() => verifyBoundedPlan({ request: req, result, policy: p }),
    { code: 'bounded_plan_policy_hash_mismatch' });
});

test('bounded-gap result is accepted only within its explicit policy', () => {
  const rows = [candidate('a', 10), candidate('b', 9), candidate('c', 8)];
  let chosen = null;
  for (let maximumExpansions = 1; maximumExpansions < 30; maximumExpansions += 1) {
    const req = request(rows, { maximumExpansions }); const result = optimizeBoundedPlan(req);
    if (result.status === 'bounded_gap' && result.selectedPlan
      && BigInt(result.proof.absoluteGapMicrounits) > 0n) { chosen = { req, result }; break; }
  }
  assert.ok(chosen, 'expected a positive-gap incumbent');
  const accepted = verifyBoundedPlan({ request: chosen.req, result: chosen.result,
    policy: policy({ allowedStatuses: ['bounded_gap'],
      maximumAcceptedGapMicrounits: chosen.result.proof.absoluteGapMicrounits,
      requireObjectiveOptimal: false, requireCompleteTieBreak: false }) });
  assert.equal(accepted.proof.complete, false);
  const smaller = (BigInt(chosen.result.proof.absoluteGapMicrounits) - 1n).toString();
  assert.throws(() => verifyBoundedPlan({ request: chosen.req, result: chosen.result,
    policy: policy({ allowedStatuses: ['bounded_gap'], maximumAcceptedGapMicrounits: smaller,
      requireObjectiveOptimal: false, requireCompleteTieBreak: false }) }),
  { code: 'bounded_plan_gap_exceeds_policy' });
});

test('objective-optimal zero-gap result can still fail complete tie-break policy', () => {
  const rows = [candidate('a', 5, { group: 'g' }), candidate('b', 5, { group: 'g' })];
  let chosen = null;
  for (let maximumExpansions = 1; maximumExpansions < 20; maximumExpansions += 1) {
    const req = request(rows, { maximumExpansions }); const result = optimizeBoundedPlan(req);
    if (result.status === 'bounded_gap' && result.selectedPlan
      && result.proof.objectiveOptimal && !result.proof.tieBreakComplete) { chosen = { req, result }; break; }
  }
  assert.ok(chosen, 'expected objective-optimal incomplete tie search');
  verifyBoundedPlan({ request: chosen.req, result: chosen.result,
    policy: policy({ allowedStatuses: ['bounded_gap'], requireCompleteTieBreak: false }) });
  assert.throws(() => verifyBoundedPlan({ request: chosen.req, result: chosen.result,
    policy: policy({ allowedStatuses: ['bounded_gap'], requireCompleteTieBreak: true }) }),
  { code: 'bounded_plan_tiebreak_incomplete' });
});

test('no incumbent and infeasible results cannot become execution selections', () => {
  const rows = [candidate('a', 1)];
  const limited = request(rows, { capabilities: ['missing'], maximumExpansions: 1 });
  assert.throws(() => verifyBoundedPlan({ request: limited, result: optimizeBoundedPlan(limited),
    policy: policy({ allowedStatuses: ['bounded_gap'], requireObjectiveOptimal: false,
      requireCompleteTieBreak: false }) }));
  const impossible = request(rows, { capabilities: ['missing'] });
  assert.throws(() => verifyBoundedPlan({ request: impossible, result: optimizeBoundedPlan(impossible),
    policy: policy() }));
});

test('accessor and cyclic result values fail before getter execution or optimization acceptance', () => {
  const req = exactRequest(); const result = structuredClone(optimizeBoundedPlan(req)); let calls = 0;
  Object.defineProperty(result, 'status', { enumerable: true, get() { calls += 1; return 'optimal'; } });
  assert.throws(() => verifyBoundedPlan({ request: req, result, policy: policy() }),
    { code: 'bounded_plan_result_record_invalid' });
  assert.equal(calls, 0);
  const cyclic = {}; cyclic.self = cyclic;
  assert.throws(() => verifyBoundedPlan({ request: req, result: cyclic, policy: policy() }),
    { code: 'bounded_plan_result_cycle' });
});

test('status allowlist is dense, unique and closed', () => {
  const body = { version: 1, kind: 'BoundedPlanAcceptancePolicyV1', policyId: 'x',
    allowedStatuses: ['optimal', 'optimal'], maximumAcceptedGapMicrounits: '0',
    requireObjectiveOptimal: true, requireCompleteTieBreak: true };
  assert.throws(() => boundedPlanAcceptancePolicyHash(body),
    { code: 'bounded_plan_policy_statuses_invalid' });
  body.allowedStatuses = new Array(1);
  assert.throws(() => boundedPlanAcceptancePolicyHash(body),
    { code: 'bounded_plan_policy_statuses_invalid' });
  body.allowedStatuses = ['infeasible'];
  assert.throws(() => boundedPlanAcceptancePolicyHash(body),
    { code: 'bounded_plan_policy_statuses_invalid' });
});

test('large decimal gap policy uses exact BigInt comparison', () => {
  const rows = [candidate('a', Number.MAX_SAFE_INTEGER), candidate('b', Number.MAX_SAFE_INTEGER,
    { hash: 'b' })];
  const req = request(rows, { maximumExpansions: 4 }); const result = optimizeBoundedPlan(req);
  if (result.status === 'bounded_gap' && result.selectedPlan) {
    verifyBoundedPlan({ request: req, result, policy: policy({ allowedStatuses: ['bounded_gap'],
      maximumAcceptedGapMicrounits: '9'.repeat(100), requireObjectiveOptimal: false,
      requireCompleteTieBreak: false }) });
  }
});

test('same request, result and policy produce the same verification hash', () => {
  const req = exactRequest(); const result = optimizeBoundedPlan(req); const p = policy();
  assert.equal(verifyBoundedPlan({ request: req, result, policy: p }).verifiedBoundedPlanHash,
    verifyBoundedPlan({ request: structuredClone(req), result: structuredClone(result),
      policy: structuredClone(p) }).verifiedBoundedPlanHash);
});
