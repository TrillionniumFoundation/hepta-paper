import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildControlSnapshot,
  controlProjectionPayloadHash,
} from '../../paper-application/orchestration/control-snapshot-builder.mjs';
import { optimizeBoundedPlan } from '../../paper-application/orchestration/bounded-global-optimizer.mjs';
import {
  boundedPlanAcceptancePolicyHash,
} from '../../paper-application/orchestration/bounded-plan-verifier.mjs';
import { verifyPlanningCycle } from '../../paper-application/orchestration/verified-planning-cycle.mjs';

const H = (c) => `sha256:${c.repeat(64)}`;
const dimensions = ['cpuUnits', 'gpuUnits', 'memoryMiB', 'storageBytes',
  'tokenCount', 'maximumCostMicrousd'];
const resources = (values = {}) => Object.fromEntries(dimensions.map((key) => [key, values[key] ?? 0]));

function snapshot() {
  const subjectHash = H('a');
  const projection = { version: 1, kind: 'ControlProjectionV1', projectionKind: 'state',
    projectionId: 'state-1', producerModuleId: 'module.readonly-control', producerVersion: '1',
    subjectHash, revision: 1, observedAt: '2026-09-05T23:59:59.999999999Z',
    expiresAt: '2026-09-06T01:00:00Z', payload: { revision: 1 } };
  projection.payloadHash = controlProjectionPayloadHash(projection);
  return buildControlSnapshot({ observedAt: '2026-09-06T00:00:00Z',
    request: { version: 1, kind: 'ControlSnapshotRequestV1', requestId: 'snapshot-1',
      subjectHash, bindings: [{ projectionKind: 'state', moduleId: 'module.readonly-control',
        moduleVersion: '1', minimumRevision: 1 }], expiresAt: '2026-09-06T01:00:00Z' },
    projections: [projection] });
}

function modelCandidate(id, utility, payloadHash) {
  return { candidateId: id, candidatePayloadHash: payloadHash,
    utilityMicrounits: utility, resourceVector: resources({ cpuUnits: 1 }),
    dependencies: [], conflicts: [], decisionGroup: null, providesCapabilities: [] };
}

function fixture() {
  const controlSnapshot = snapshot();
  const planningRequestHash = H('1');
  const candidateSetHash = H('2');
  const candidates = [
    { candidateId: 'a', candidatePayloadHash: H('b') },
    { candidateId: 'b', candidatePayloadHash: H('c') },
  ];
  const candidateFrontier = { version: 1, kind: 'CandidateFrontierV1',
    planningRequestHash, stateSnapshotHash: controlSnapshot.controlSnapshotHash,
    candidateSetHash, candidateFrontierHash: H('d'), candidates,
    dominanceReductionApplied: false,
    authority: { productionAuthorized: false, writerAuthorized: false,
      providerAuthorized: false, externalAuthorityClaimed: false },
    externalActionPerformed: false };
  const optimizationRequest = { version: 1, kind: 'BoundedPlanOptimizationRequestV1',
    requestId: 'optimization-1', planningRequestHash,
    stateSnapshotHash: controlSnapshot.controlSnapshotHash, candidateSetHash,
    objectiveVersion: 'objective-v1', resourceLimits: resources({ cpuUnits: 1 }),
    requiredCandidateIds: [], requiredCapabilities: [],
    candidates: [modelCandidate('a', 2, H('b')), modelCandidate('b', 3, H('c'))],
    maximumExpansions: 1000 };
  const optimizationResult = optimizeBoundedPlan(optimizationRequest);
  const policyBody = { version: 1, kind: 'BoundedPlanAcceptancePolicyV1',
    policyId: 'acceptance-v1', allowedStatuses: ['optimal'],
    maximumAcceptedGapMicrounits: '0', requireObjectiveOptimal: true,
    requireCompleteTieBreak: true };
  const acceptancePolicy = { ...policyBody,
    policyHash: boundedPlanAcceptancePolicyHash(policyBody) };
  return { controlSnapshot, candidateFrontier, optimizationRequest,
    optimizationResult, acceptancePolicy };
}

test('binds snapshot, frontier, exact model and independently verified selected plan', () => {
  const result = verifyPlanningCycle(fixture());
  assert.equal(result.status, 'verified_nonactivating');
  assert.deepEqual(result.selectedPlan.selectedCandidateIds, ['b']);
  assert.ok(Object.values(result.authority).every((flag) => flag === false));
  assert.equal(result.externalActionPerformed, false);
  assert.match(result.verifiedPlanningDecisionHash, /^sha256:/u);
});

test('snapshot binding mismatch fails before plan acceptance', () => {
  const value = fixture(); value.candidateFrontier.stateSnapshotHash = H('e');
  assert.throws(() => verifyPlanningCycle(value), { code: 'planning_cycle_snapshot_binding_mismatch' });
});

test('planning request and candidate-set identities must match end to end', () => {
  const request = fixture(); request.optimizationRequest.planningRequestHash = H('e');
  assert.throws(() => verifyPlanningCycle(request), { code: 'planning_cycle_request_binding_mismatch' });
  const set = fixture(); set.optimizationRequest.candidateSetHash = H('e');
  assert.throws(() => verifyPlanningCycle(set), { code: 'planning_cycle_candidate_set_binding_mismatch' });
});

test('optimization models must exactly cover frontier IDs and payload hashes', () => {
  const missing = fixture(); missing.optimizationRequest.candidates.pop();
  assert.throws(() => verifyPlanningCycle(missing), { code: 'planning_cycle_candidate_model_coverage_invalid' });
  const drift = fixture(); drift.optimizationRequest.candidates[0].candidatePayloadHash = H('e');
  assert.throws(() => verifyPlanningCycle(drift), { code: 'planning_cycle_candidate_model_binding_invalid' });
});

test('duplicate frontier identity is rejected independently of optimizer validation', () => {
  const ids = fixture(); ids.candidateFrontier.candidates[1].candidateId = 'a';
  assert.throws(() => verifyPlanningCycle(ids), { code: 'planning_cycle_frontier_candidate_id_duplicate' });
  const hashes = fixture(); hashes.candidateFrontier.candidates[1].candidatePayloadHash = H('b');
  assert.throws(() => verifyPlanningCycle(hashes), { code: 'planning_cycle_frontier_candidate_hash_duplicate' });
});

test('forged optimizer results and ineligible policies cannot pass composition', () => {
  const forged = fixture(); forged.optimizationResult = structuredClone(forged.optimizationResult);
  forged.optimizationResult.selectedPlan.objectiveMicrounits = '999';
  assert.throws(() => verifyPlanningCycle(forged), { code: 'bounded_plan_result_mismatch' });
  const denied = fixture(); denied.acceptancePolicy = structuredClone(denied.acceptancePolicy);
  denied.acceptancePolicy.allowedStatuses = ['bounded_gap'];
  const { policyHash: ignored, ...policyBody } = denied.acceptancePolicy;
  denied.acceptancePolicy.policyHash = boundedPlanAcceptancePolicyHash(policyBody);
  assert.throws(() => verifyPlanningCycle(denied), { code: 'bounded_plan_status_not_accepted' });
});

test('upstream authority or external-action claims are never inherited', () => {
  const snapshotClaim = fixture(); snapshotClaim.controlSnapshot = structuredClone(snapshotClaim.controlSnapshot);
  snapshotClaim.controlSnapshot.authority.writerAuthorized = true;
  assert.throws(() => verifyPlanningCycle(snapshotClaim), { code: 'planning_cycle_snapshot_authority_invalid' });
  const frontierClaim = fixture(); frontierClaim.candidateFrontier.authority.providerAuthorized = true;
  assert.throws(() => verifyPlanningCycle(frontierClaim), { code: 'planning_cycle_frontier_authority_invalid' });
  const effect = fixture(); effect.candidateFrontier.externalActionPerformed = true;
  assert.throws(() => verifyPlanningCycle(effect), { code: 'planning_cycle_frontier_invalid' });
});

test('accessors and cycles are rejected without executing a getter', () => {
  const value = fixture(); let calls = 0;
  Object.defineProperty(value.candidateFrontier, 'candidateSetHash', { enumerable: true,
    get() { calls += 1; return H('2'); } });
  assert.throws(() => verifyPlanningCycle(value), { code: 'planning_cycle_record_invalid' });
  assert.equal(calls, 0);
  const cycle = fixture(); cycle.candidateFrontier.self = cycle.candidateFrontier;
  assert.throws(() => verifyPlanningCycle(cycle), { code: 'planning_cycle_cycle' });
});

test('caller mutation cannot alter an already returned verified decision', () => {
  const value = fixture(); const result = verifyPlanningCycle(value);
  value.optimizationRequest.candidates[1].utilityMicrounits = 999;
  value.candidateFrontier.candidates[1].candidateId = 'changed';
  assert.deepEqual(result.selectedPlan.selectedCandidateIds, ['b']);
  assert.equal(result.selectedPlan.objectiveMicrounits, '3');
  assert.throws(() => { result.selectedPlan.selectedCandidateIds.push('x'); }, TypeError);
});

test('candidate input order cannot change the verified planning decision hash', () => {
  const left = fixture(); const right = fixture();
  right.candidateFrontier.candidates.reverse();
  right.optimizationRequest.candidates.reverse();
  right.optimizationResult = optimizeBoundedPlan(right.optimizationRequest);
  assert.equal(verifyPlanningCycle(left).verifiedPlanningDecisionHash,
    verifyPlanningCycle(right).verifiedPlanningDecisionHash);
});
