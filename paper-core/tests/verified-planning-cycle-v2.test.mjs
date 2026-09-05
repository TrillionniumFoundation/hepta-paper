import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildControlSnapshot,
  controlProjectionPayloadHash,
} from '../../paper-application/orchestration/control-snapshot-builder.mjs';
import { optimizeBoundedPlan } from '../../paper-application/orchestration/bounded-global-optimizer.mjs';
import { boundedPlanAcceptancePolicyHash } from '../../paper-application/orchestration/bounded-plan-verifier.mjs';
import {
  buildBoundedOptimizationRequest,
  candidateOptimizationModelSetHash,
} from '../../paper-application/orchestration/candidate-optimization-model.mjs';
import { verifyPlanningCycleV2 } from '../../paper-application/orchestration/verified-planning-cycle-v2.mjs';

const H = (c) => `sha256:${c.repeat(64)}`;
const dimensions = ['cpuUnits', 'gpuUnits', 'memoryMiB', 'storageBytes',
  'tokenCount', 'maximumCostMicrousd'];
const resources = (values = {}) => Object.fromEntries(dimensions.map((key) => [key, values[key] ?? 0]));
function controlSnapshot() {
  const projection = { version: 1, kind: 'ControlProjectionV1', projectionKind: 'state',
    projectionId: 'state-1', producerModuleId: 'module.readonly-control', producerVersion: '1',
    subjectHash: H('a'), revision: 1, observedAt: '2026-09-05T23:59:59.999999999Z',
    expiresAt: '2026-09-06T01:00:00Z', payload: { revision: 1 } };
  projection.payloadHash = controlProjectionPayloadHash(projection);
  return buildControlSnapshot({ observedAt: '2026-09-06T00:00:00Z',
    request: { version: 1, kind: 'ControlSnapshotRequestV1', requestId: 'snapshot-1',
      subjectHash: H('a'), bindings: [{ projectionKind: 'state', moduleId: 'module.readonly-control',
        moduleVersion: '1', minimumRevision: 1 }], expiresAt: '2026-09-06T01:00:00Z' },
    projections: [projection] });
}
function fixture() {
  const snapshot = controlSnapshot();
  const frontier = { version: 1, kind: 'CandidateFrontierV1', planningRequestHash: H('1'),
    stateSnapshotHash: snapshot.controlSnapshotHash, candidateSetHash: H('3'),
    candidateFrontierHash: H('4'), dominanceReductionApplied: false,
    externalActionPerformed: false,
    authority: { productionAuthorized: false, writerAuthorized: false,
      providerAuthorized: false, externalAuthorityClaimed: false },
    candidates: [
      { candidateId: 'a', candidatePayloadHash: H('b'), resourceVector: resources({ cpuUnits: 2 }) },
      { candidateId: 'b', candidatePayloadHash: H('c'), resourceVector: resources({ cpuUnits: 1 }) },
    ] };
  const body = { version: 1, kind: 'CandidateOptimizationModelSetV1', modelSetId: 'model-1',
    planningRequestHash: H('1'), stateSnapshotHash: snapshot.controlSnapshotHash,
    candidateSetHash: H('3'), objectiveVersion: 'objective-v1',
    entries: [
      { candidateId: 'a', candidatePayloadHash: H('b'), utilityMicrounits: 5,
        dependencies: [], conflicts: [], decisionGroup: 'method', providesCapabilities: [] },
      { candidateId: 'b', candidatePayloadHash: H('c'), utilityMicrounits: 4,
        dependencies: [], conflicts: [], decisionGroup: 'method', providesCapabilities: [] },
    ], requiredCandidateIds: [], requiredCapabilities: [], resourceLimits: resources({ cpuUnits: 1 }),
    maximumExpansions: 1000 };
  const modelSet = { ...body, modelSetHash: candidateOptimizationModelSetHash(body) };
  const projected = buildBoundedOptimizationRequest({ candidateFrontier: frontier, modelSet });
  const optimizationResult = optimizeBoundedPlan(projected.optimizationRequest);
  const policyBody = { version: 1, kind: 'BoundedPlanAcceptancePolicyV1', policyId: 'accept-v1',
    allowedStatuses: ['optimal'], maximumAcceptedGapMicrounits: '0',
    requireObjectiveOptimal: true, requireCompleteTieBreak: true };
  return { controlSnapshot: snapshot, candidateFrontier: frontier, modelSet,
    optimizationResult, acceptancePolicy: { ...policyBody,
      policyHash: boundedPlanAcceptancePolicyHash(policyBody) } };
}

test('verifies a model-bound planning decision and selects using frontier resources', () => {
  const result = verifyPlanningCycleV2(fixture());
  assert.equal(result.status, 'verified_nonactivating');
  assert.deepEqual(result.selectedPlan.selectedCandidateIds, ['b']);
  assert.equal(result.selectedPlan.usedResources.cpuUnits, '1');
  assert.match(result.candidateOptimizationModelSetHash, /^sha256:/u);
  assert.ok(Object.values(result.authority).every((flag) => flag === false));
});

test('changing utility requires a new model-set hash and changes the bound decision', () => {
  const value = fixture(); value.modelSet.entries[1].utilityMicrounits = 10;
  assert.throws(() => verifyPlanningCycleV2(value), { code: 'candidate_model_set_hash_mismatch' });
  const { modelSetHash: ignored, ...body } = value.modelSet;
  value.modelSet.modelSetHash = candidateOptimizationModelSetHash(body);
  const projected = buildBoundedOptimizationRequest({ candidateFrontier: value.candidateFrontier,
    modelSet: value.modelSet });
  value.optimizationResult = optimizeBoundedPlan(projected.optimizationRequest);
  const result = verifyPlanningCycleV2(value);
  assert.deepEqual(result.selectedPlan.selectedCandidateIds, ['b']);
  assert.equal(result.selectedPlan.objectiveMicrounits, '10');
});

test('resource changes must occur in canonical frontier and invalidate old optimizer result', () => {
  const value = fixture(); value.candidateFrontier.candidates[1].resourceVector.cpuUnits = 2;
  const projected = buildBoundedOptimizationRequest({ candidateFrontier: value.candidateFrontier,
    modelSet: value.modelSet });
  assert.throws(() => verifyPlanningCycleV2(value), { code: 'bounded_plan_result_mismatch' });
  value.optimizationResult = optimizeBoundedPlan(projected.optimizationRequest);
  assert.throws(() => verifyPlanningCycleV2(value),
    { code: 'bounded_plan_status_not_accepted' });
});

test('forged model payload binding is rejected before optimization verification', () => {
  const value = fixture(); value.modelSet.entries[0].candidatePayloadHash = H('e');
  const { modelSetHash: ignored, ...body } = value.modelSet;
  value.modelSet.modelSetHash = candidateOptimizationModelSetHash(body);
  assert.throws(() => verifyPlanningCycleV2(value), { code: 'candidate_model_entry_binding_mismatch' });
});

test('top-level accessors are rejected without executing them', () => {
  const value = fixture(); let calls = 0;
  Object.defineProperty(value, 'modelSet', { enumerable: true,
    get() { calls += 1; return {}; } });
  assert.throws(() => verifyPlanningCycleV2(value), { code: 'planning_cycle_v2_input_invalid' });
  assert.equal(calls, 0);
});

test('same exact inputs produce the same V2 decision hash', () => {
  const left = fixture(); const right = fixture();
  right.candidateFrontier.candidates.reverse(); right.modelSet.entries.reverse();
  const { modelSetHash: ignored, ...body } = right.modelSet;
  right.modelSet.modelSetHash = candidateOptimizationModelSetHash(body);
  const projected = buildBoundedOptimizationRequest({ candidateFrontier: right.candidateFrontier,
    modelSet: right.modelSet });
  right.optimizationResult = optimizeBoundedPlan(projected.optimizationRequest);
  assert.equal(verifyPlanningCycleV2(left).verifiedPlanningDecisionHash,
    verifyPlanningCycleV2(right).verifiedPlanningDecisionHash);
});
