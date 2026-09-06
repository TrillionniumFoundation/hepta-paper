import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildPlanningStateSnapshot,
  createPlanningSnapshotComponent,
} from '../../paper-application/orchestration/snapshot-builder.mjs';
import { createActionCandidate } from '../../paper-application/orchestration/candidate-router.mjs';
import { runBoundedPlanningPipeline } from '../../paper-application/orchestration/bounded-planning-pipeline.mjs';

const H = (character) => `sha256:${character.repeat(64)}`;
const NOW = Date.parse('2026-09-06T00:00:00Z');

function fixture(specifications = [
  { id: 'a', utility: 7, cpuUnits: 1 },
  { id: 'b', utility: 5, cpuUnits: 1 },
], options = {}) {
  const snapshotRequest = {
    schemaVersion: 1,
    kind: 'PlanningStateSnapshotRequestV1',
    snapshotRequestId: 'snapshot-1',
    readTransactionHash: options.readTransactionHash || H('a'),
    consistencyEpoch: options.consistencyEpoch || 1,
    deadline: options.snapshotDeadline || '2026-09-07T00:00:00Z',
    requiredComponents: [{
      componentId: 'campaign',
      componentKind: 'campaign-state',
      minimumRevision: options.minimumRevision || 1,
      maximumAgeMs: 60 * 60 * 1000,
      maximumPayloadBytes: 64 * 1024,
    }],
  };
  const snapshotBinding = {
    moduleId: 'module.readonly-control',
    moduleVersion: '1.0.0',
    projectionKinds: ['campaign-state'],
    qualificationSubjectHash: H('b'),
    validUntil: '2026-09-08T00:00:00Z',
  };
  const component = createPlanningSnapshotComponent({
    schemaVersion: 1,
    kind: 'PlanningSnapshotComponentV1',
    componentId: 'campaign',
    componentKind: 'campaign-state',
    sourceModuleId: snapshotBinding.moduleId,
    sourceModuleVersion: snapshotBinding.moduleVersion,
    sourceQualificationHash: snapshotBinding.qualificationSubjectHash,
    readTransactionHash: snapshotRequest.readTransactionHash,
    consistencyEpoch: snapshotRequest.consistencyEpoch,
    revision: options.revision || 1,
    generation: options.generation || 1,
    capturedAt: '2026-09-05T23:59:00Z',
    expiresAt: options.snapshotExpiry || '2026-09-07T00:00:00Z',
    payload: options.payload || { status: 'running', revision: options.revision || 1 },
  });
  const preview = buildPlanningStateSnapshot({
    request: snapshotRequest,
    moduleBindings: [snapshotBinding],
    components: [component],
    nowEpochMs: NOW,
  });
  const candidateRequest = {
    schemaVersion: 1,
    kind: 'PlanningRequestV1',
    planningRequestId: 'plan-1',
    capabilityId: 'CAP-MOD-CANDIDATES',
    hardConstraintSetHash: options.hardConstraintSetHash || H('c'),
    objectiveVersion: options.objectiveVersion || 'objective-v1',
    resourcePriceSnapshotHash: options.resourcePriceSnapshotHash || H('d'),
    candidateLimit: Math.max(1, specifications.length),
    deadline: options.candidateDeadline || '2026-09-07T00:00:00Z',
    allowedSideEffectClasses: ['none'],
    inputArtifactHashes: [],
  };
  const candidateBinding = {
    moduleId: 'module.alpha',
    moduleVersion: '1.0.0',
    capabilityIds: ['CAP-MOD-CANDIDATES'],
    qualificationSubjectHash: H('e'),
    validUntil: '2026-09-07T00:00:00Z',
  };
  const candidates = specifications.map((specification) => createActionCandidate({
    schemaVersion: 1,
    kind: 'ActionCandidateV1',
    candidateId: specification.id,
    planningRequestId: candidateRequest.planningRequestId,
    stateSnapshotHash: preview.stateSnapshotHash,
    moduleId: candidateBinding.moduleId,
    moduleVersion: candidateBinding.moduleVersion,
    capabilityId: candidateRequest.capabilityId,
    resourceVector: {
      cpuUnits: specification.cpuUnits || 0,
      gpuUnits: 0,
      memoryMiB: 0,
      storageBytes: 0,
      tokenCount: 0,
      maximumCostMicrousd: 0,
    },
    duration: { upperMs: 100 },
    cost: { upperMicrousd: 0 },
    value: { advisory: specification.utility },
    risk: { failureProbability: 0 },
    preconditions: [],
    dependencyEffects: [],
    sideEffectClass: 'none',
    irreversibleBoundary: null,
    rollbackClass: 'no_effect',
    expiresAt: '2026-09-06T18:00:00Z',
    inputSchema: null,
    outputSchema: null,
    singletonReason: specifications.length === 1 ? 'only_feasible_candidate' : null,
  }));
  const byId = new Map(candidates.map((candidate) => [candidate.candidateId, candidate]));
  const selectionRequest = {
    schemaVersion: 1,
    kind: 'GlobalPlanSelectionRequestV1',
    selectionRequestId: 'selection-1',
    deadline: options.selectionDeadline || '2026-09-06T12:00:00Z',
    expansionBudget: options.expansionBudget || 1000,
    maximumSelectedCandidates: options.maximumSelectedCandidates ?? specifications.length,
    resourceLimits: {
      cpuMilliunits: options.cpuMilliunits ?? 1000,
      gpuMilliunits: 0,
      memoryMiB: 0,
      storageBytes: 0,
      tokenCount: 0,
      maximumCostMicrousd: 0,
    },
    requiredCandidateIds: options.requiredCandidateIds || [],
    evaluations: specifications.map((specification) => ({
      candidateId: specification.id,
      candidatePayloadHash: byId.get(specification.id).candidatePayloadHash,
      utilityMicrounits: specification.utility,
      dependencies: specification.dependencies || [],
      mutexGroup: specification.mutexGroup || null,
    })),
  };
  return {
    preview,
    input: {
      snapshot: {
        request: snapshotRequest,
        moduleBindings: [snapshotBinding],
        components: [component],
      },
      candidate: {
        request: candidateRequest,
        moduleBindings: [candidateBinding],
        candidates,
        ...(specifications.length === 0 ? { emptyReason: 'no_candidates' } : {}),
      },
      selection: { request: selectionRequest },
      nowEpochMs: NOW,
    },
  };
}

test('pipeline constructs one exact snapshot frontier and optimal selection chain', () => {
  const { preview, input } = fixture();
  const decision = runBoundedPlanningPipeline(input);
  assert.equal(decision.stateSnapshotHash, preview.stateSnapshotHash);
  assert.equal(decision.frontier.stateSnapshotHash, decision.stateSnapshotHash);
  assert.equal(decision.selection.candidateSetHash, decision.candidateSetHash);
  assert.equal(decision.selection.status, 'optimal');
  assert.deepEqual(decision.selectedCandidateIds, ['a']);
  assert.equal(decision.selection.objectiveLowerBoundMicrounits, 7);
  assert.match(decision.planningDecisionHash, /^sha256:[0-9a-f]{64}$/u);
});

test('derived identity fields cannot be injected through stage templates', () => {
  const { input } = fixture();
  assert.throws(() => runBoundedPlanningPipeline({
    ...input,
    candidate: { ...input.candidate,
      request: { ...input.candidate.request, stateSnapshotHash: H('9') } },
  }), { code: 'planning_pipeline_candidate_request_invalid' });
  assert.throws(() => runBoundedPlanningPipeline({
    ...input,
    selection: { request: { ...input.selection.request, candidateSetHash: H('9') } },
  }), { code: 'planning_pipeline_selection_request_invalid' });
});

test('old candidates are rejected after a snapshot revision changes', () => {
  const { input } = fixture();
  const changed = fixture(undefined, { revision: 2, minimumRevision: 2, payload: { revision: 2 } });
  assert.throws(() => runBoundedPlanningPipeline({
    ...input,
    snapshot: changed.input.snapshot,
  }), { code: 'candidate_snapshot_binding_mismatch' });
});

test('candidate and selection deadlines cannot outlive snapshot validity', () => {
  const { input } = fixture();
  assert.throws(() => runBoundedPlanningPipeline({
    ...input,
    candidate: { ...input.candidate,
      request: { ...input.candidate.request, deadline: '2026-09-08T00:00:00Z' } },
  }), { code: 'planning_pipeline_candidate_deadline_exceeds_snapshot' });
  assert.throws(() => runBoundedPlanningPipeline({
    ...input,
    selection: { request: { ...input.selection.request, deadline: '2026-09-08T00:00:00Z' } },
  }), { code: 'planning_pipeline_selection_deadline_exceeds_snapshot' });
});

test('empty candidate frontier remains an explicit optimal empty decision', () => {
  const { input } = fixture([], { maximumSelectedCandidates: 0 });
  const decision = runBoundedPlanningPipeline(input);
  assert.equal(decision.frontier.status, 'empty');
  assert.equal(decision.selection.status, 'optimal');
  assert.deepEqual(decision.selectedCandidateIds, []);
  assert.equal(decision.selection.objectiveLowerBoundMicrounits, 0);
});

test('selection budget disposition is preserved without promotion', () => {
  const { input } = fixture(undefined, { expansionBudget: 1 });
  const decision = runBoundedPlanningPipeline(input);
  assert.equal(decision.status, 'bounded_feasible');
  assert.equal(decision.selection.frontierExhausted, false);
  assert.equal(decision.selection.proof.optimalSelectionProven, false);
});

test('pipeline expiry is the earliest snapshot frontier or selection deadline', () => {
  const { input } = fixture();
  const decision = runBoundedPlanningPipeline(input);
  assert.equal(decision.expiresAt, '2026-09-06T12:00:00.000Z');
});

test('malformed stage records fail before any authority-bearing output', () => {
  const { input } = fixture();
  assert.throws(() => runBoundedPlanningPipeline({
    ...input, candidate: { ...input.candidate, credential: 'forbidden' },
  }), { code: 'planning_pipeline_candidate_stage_invalid' });
  assert.throws(() => runBoundedPlanningPipeline({
    ...input, selection: { ...input.selection, fallback: true },
  }), { code: 'planning_pipeline_selection_stage_invalid' });
});

test('template accessors are rejected without execution', () => {
  const { input } = fixture();
  let calls = 0;
  const request = { ...input.candidate.request };
  Object.defineProperty(request, 'objectiveVersion', {
    enumerable: true,
    get() { calls += 1; return 'objective-v1'; },
  });
  assert.throws(() => runBoundedPlanningPipeline({
    ...input, candidate: { ...input.candidate, request },
  }), { code: 'planning_pipeline_candidate_request_invalid' });
  assert.equal(calls, 0);
});

test('clock values outside the Date domain return a typed denial', () => {
  const { input } = fixture();
  assert.throws(() => runBoundedPlanningPipeline({
    ...input, nowEpochMs: Number.MAX_SAFE_INTEGER,
  }), { code: 'planning_pipeline_clock_invalid' });
});

test('snapshot, objective and selection changes alter the planning decision identity', () => {
  const base = runBoundedPlanningPipeline(fixture().input);
  const changedSnapshot = runBoundedPlanningPipeline(fixture(undefined, {
    revision: 2, minimumRevision: 2, payload: { revision: 2 },
  }).input);
  const changedObjective = runBoundedPlanningPipeline(fixture(undefined, {
    objectiveVersion: 'objective-v2',
  }).input);
  const changedBudget = runBoundedPlanningPipeline(fixture(undefined, {
    expansionBudget: 1,
  }).input);
  assert.notEqual(base.planningDecisionHash, changedSnapshot.planningDecisionHash);
  assert.notEqual(base.planningDecisionHash, changedObjective.planningDecisionHash);
  assert.notEqual(base.planningDecisionHash, changedBudget.planningDecisionHash);
});

test('returned decision is deeply immutable and non-authorizing', () => {
  const decision = runBoundedPlanningPipeline(fixture().input);
  assert.deepEqual(decision.authority, {
    productionAuthorized: false,
    providerAuthorized: false,
    executionAuthorized: false,
    writerAuthorityGranted: false,
    externalAuthorityClaimed: false,
  });
  assert.throws(() => { decision.authority.executionAuthorized = true; }, TypeError);
  assert.throws(() => { decision.snapshot.components[0].payload.status = 'failed'; }, TypeError);
  assert.throws(() => { decision.frontier.candidates.push({}); }, TypeError);
});
