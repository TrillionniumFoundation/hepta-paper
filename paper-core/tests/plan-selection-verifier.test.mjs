import assert from 'node:assert/strict';
import test from 'node:test';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  createActionCandidate,
  routeActionCandidates,
} from '../../paper-application/orchestration/candidate-router.mjs';
import { selectBoundedGlobalPlan } from '../../paper-application/orchestration/bounded-plan-selector.mjs';
import { verifyFeasiblePlanSelection } from '../../paper-application/orchestration/plan-selection-verifier.mjs';

const H = (character) => `sha256:${character.repeat(64)}`;
const NOW = Date.parse('2026-09-06T00:00:00Z');
const LIMITS = Object.freeze({
  cpuMilliunits: 1000,
  gpuMilliunits: 0,
  memoryMiB: 100,
  storageBytes: 100,
  tokenCount: 100,
  maximumCostMicrousd: 100,
});

function problem(specifications = [
  { id: 'a', utility: 7, cpuUnits: 1 },
  { id: 'b', utility: 5, cpuUnits: 1 },
], options = {}) {
  const planningRequest = {
    schemaVersion: 1,
    kind: 'PlanningRequestV1',
    planningRequestId: 'verify-plan',
    stateSnapshotHash: H('a'),
    capabilityId: 'CAP-MOD-CANDIDATES',
    hardConstraintSetHash: H('b'),
    objectiveVersion: 'objective-v1',
    resourcePriceSnapshotHash: H('c'),
    candidateLimit: Math.max(1, specifications.length),
    deadline: '2027-01-01T00:00:00Z',
    allowedSideEffectClasses: ['none'],
    inputArtifactHashes: [],
  };
  const binding = {
    moduleId: 'module.alpha',
    moduleVersion: '1.0.0',
    capabilityIds: ['CAP-MOD-CANDIDATES'],
    qualificationSubjectHash: H('d'),
    validUntil: '2027-01-01T00:00:00Z',
  };
  const candidates = specifications.map((specification) => createActionCandidate({
    schemaVersion: 1,
    kind: 'ActionCandidateV1',
    candidateId: specification.id,
    planningRequestId: planningRequest.planningRequestId,
    stateSnapshotHash: planningRequest.stateSnapshotHash,
    moduleId: binding.moduleId,
    moduleVersion: binding.moduleVersion,
    capabilityId: planningRequest.capabilityId,
    resourceVector: {
      cpuUnits: specification.cpuUnits || 0,
      gpuUnits: 0,
      memoryMiB: specification.memoryMiB || 0,
      storageBytes: 0,
      tokenCount: 0,
      maximumCostMicrousd: 0,
    },
    duration: {},
    cost: {},
    value: { advisory: specification.utility },
    risk: {},
    preconditions: [],
    dependencyEffects: [],
    sideEffectClass: 'none',
    irreversibleBoundary: null,
    rollbackClass: 'no_effect',
    expiresAt: '2026-12-31T00:00:00Z',
    inputSchema: null,
    outputSchema: null,
    singletonReason: specifications.length === 1 ? 'only_feasible_candidate' : null,
  }));
  const frontier = routeActionCandidates({
    request: planningRequest,
    moduleBindings: [binding],
    candidates,
    ...(specifications.length === 0 ? { emptyReason: 'no_candidates' } : {}),
    nowEpochMs: NOW,
  });
  const byId = new Map(candidates.map((candidate) => [candidate.candidateId, candidate]));
  const request = {
    schemaVersion: 1,
    kind: 'GlobalPlanSelectionRequestV1',
    selectionRequestId: 'verify-selection',
    planningRequestHash: frontier.planningRequestHash,
    stateSnapshotHash: frontier.stateSnapshotHash,
    candidateSetHash: frontier.candidateSetHash,
    hardConstraintSetHash: frontier.hardConstraintSetHash,
    objectiveVersion: frontier.objectiveVersion,
    resourcePriceSnapshotHash: frontier.resourcePriceSnapshotHash,
    deadline: '2026-12-30T00:00:00Z',
    expansionBudget: options.expansionBudget ?? 100_000,
    maximumSelectedCandidates: options.maximumSelectedCandidates ?? specifications.length,
    resourceLimits: { ...LIMITS, ...(options.resourceLimits || {}) },
    requiredCandidateIds: options.requiredCandidateIds || [],
    evaluations: specifications.map((specification) => ({
      candidateId: specification.id,
      candidatePayloadHash: byId.get(specification.id).candidatePayloadHash,
      utilityMicrounits: specification.utility,
      dependencies: specification.dependencies || [],
      mutexGroup: specification.mutexGroup || null,
    })),
  };
  const selection = selectBoundedGlobalPlan({ frontier, request, nowEpochMs: NOW });
  return { specifications, frontier, request, selection };
}

function verify(value, options = {}) {
  return verifyFeasiblePlanSelection({
    frontier: value.frontier,
    request: value.request,
    selection: value.selection,
    nowEpochMs: NOW,
    ...options,
  });
}

function reseal(selection, changes) {
  const body = { ...selection, ...changes };
  delete body.planSelectionHash;
  return Object.freeze({
    ...body,
    planSelectionHash: hashRecord('BoundedGlobalPlanSelectionV1', body),
  });
}

test('exact optimum is independently enumerated and accepted', () => {
  const value = problem();
  const receipt = verify(value);
  assert.equal(value.selection.status, 'optimal');
  assert.equal(receipt.status, 'exact_optimum_verified_non_authorizing');
  assert.equal(receipt.exactEnumerationPerformed, true);
  assert.equal(receipt.exactOptimalityVerified, true);
  assert.equal(receipt.sourceOptimalityClaimAccepted, true);
  assert.deepEqual(receipt.selectedCandidateIds, ['a']);
  assert.equal(receipt.independentObjectiveUpperBoundMicrounits, 7);
});

test('bounded feasible incumbent gets an independently computed exact gap', () => {
  const value = problem(undefined, { expansionBudget: 1 });
  assert.equal(value.selection.status, 'bounded_feasible');
  const receipt = verify(value);
  assert.equal(receipt.status, 'feasible_selection_verified_with_independent_bound');
  assert.equal(receipt.independentlyComputedUtilityMicrounits, 0);
  assert.equal(receipt.independentObjectiveUpperBoundMicrounits, 7);
  assert.equal(receipt.independentOptimalityGapMicrounits, 7);
  assert.equal(receipt.sourceUpperBoundVerified, undefined);
  assert.equal(receipt.proof.sourceUpperBoundVerified, true);
});

test('large frontier is feasibility-verified but source optimality is not self-accepted', () => {
  const value = problem([
    { id: 'a', utility: 7, cpuUnits: 1 },
    { id: 'b', utility: 5, cpuUnits: 1 },
    { id: 'c', utility: 4, cpuUnits: 1 },
  ]);
  const receipt = verify(value, { exactEnumerationLimit: 2 });
  assert.equal(value.selection.status, 'optimal');
  assert.equal(receipt.exactEnumerationPerformed, false);
  assert.equal(receipt.exactOptimalityVerified, false);
  assert.equal(receipt.sourceOptimalityClaimAccepted, false);
  assert.equal(receipt.independentObjectiveUpperBoundMicrounits, 16);
});

test('self-consistent resource-overcommitted selection is rejected', () => {
  const value = problem();
  const hashes = value.frontier.candidates.map((candidate) => candidate.candidatePayloadHash);
  const forged = reseal(value.selection, {
    selectedCandidateIds: ['a', 'b'],
    selectedCandidatePayloadHashes: hashes,
    resourceUsage: { ...LIMITS, cpuMilliunits: 2000 },
    objectiveLowerBoundMicrounits: 12,
    objectiveUpperBoundMicrounits: 12,
    optimalityGapMicrounits: 0,
  });
  assert.throws(() => verify({ ...value, selection: forged }),
    { code: 'verified_plan_hard_constraint_violation' });
});

test('self-consistent suboptimal result labeled optimal is rejected by the oracle', () => {
  const value = problem();
  const selected = value.frontier.candidates.find((candidate) => candidate.candidateId === 'b');
  const forged = reseal(value.selection, {
    selectedCandidateIds: ['b'],
    selectedCandidatePayloadHashes: [selected.candidatePayloadHash],
    resourceUsage: { ...LIMITS, cpuMilliunits: 1000 },
    objectiveLowerBoundMicrounits: 5,
    objectiveUpperBoundMicrounits: 5,
    optimalityGapMicrounits: 0,
  });
  assert.throws(() => verify({ ...value, selection: forged }),
    { code: 'verified_plan_optimality_claim_invalid' });
});

test('a recomputed bounded result with an upper bound below the exact optimum is rejected', () => {
  const value = problem(undefined, { expansionBudget: 1 });
  const forged = reseal(value.selection, {
    objectiveUpperBoundMicrounits: 6,
    optimalityGapMicrounits: 6,
  });
  assert.throws(() => verify({ ...value, selection: forged }),
    { code: 'verified_plan_source_upper_bound_invalid' });
});

test('no-incumbent and infeasible source results cannot become feasible receipts', () => {
  const bounded = problem([{ id: 'a', utility: 1, cpuUnits: 1 }], {
    expansionBudget: 1,
    requiredCandidateIds: ['a'],
  });
  assert.equal(bounded.selection.status, 'bounded_no_incumbent');
  assert.throws(() => verify(bounded), { code: 'verified_plan_feasible_incumbent_required' });

  const impossible = problem([{ id: 'a', utility: 1, cpuUnits: 2 }], {
    requiredCandidateIds: ['a'],
    resourceLimits: { cpuMilliunits: 1000 },
  });
  assert.equal(impossible.selection.status, 'infeasible');
  assert.throws(() => verify(impossible), { code: 'verified_plan_feasible_incumbent_required' });
});

test('source proof and status fields cannot be spliced even with a new self-hash', () => {
  const value = problem();
  const forged = reseal(value.selection, {
    proof: { ...value.selection.proof, optimalSelectionProven: false },
  });
  assert.throws(() => verify({ ...value, selection: forged }),
    { code: 'verified_plan_source_proof_inconsistent' });
});

test('selected candidate hashes remain position-bound to sorted IDs', () => {
  const value = problem();
  const forged = reseal(value.selection, {
    selectedCandidatePayloadHashes: [H('9')],
  });
  assert.throws(() => verify({ ...value, selection: forged }),
    { code: 'verified_plan_selected_identity_invalid' });
});

test('evaluation coverage, dependencies and payload identities are rechecked', () => {
  const value = problem();
  assert.throws(() => verify({ ...value,
    request: { ...value.request, evaluations: value.request.evaluations.slice(0, 1) },
  }), /verified_plan_/u);
  assert.throws(() => verify({ ...value,
    request: { ...value.request,
      evaluations: value.request.evaluations.map((item, index) => index ? item
        : { ...item, dependencies: ['missing'] }) },
  }), { code: 'verified_plan_evaluation_binding_invalid' });
});

test('request and frontier identity changes invalidate the source result', () => {
  const value = problem();
  assert.throws(() => verify({ ...value,
    request: { ...value.request, objectiveVersion: 'objective-v2' },
  }), /verified_plan_/u);
  assert.throws(() => verify({ ...value,
    frontier: { ...value.frontier,
      authority: { ...value.frontier.authority, productionAuthorized: true } },
  }), { code: 'verified_plan_frontier_authority_invalid' });
});

test('accessors are rejected without executing getters', () => {
  const value = problem();
  let calls = 0;
  const selection = { ...value.selection };
  Object.defineProperty(selection, 'status', {
    enumerable: true,
    get() { calls += 1; return 'optimal'; },
  });
  assert.throws(() => verify({ ...value, selection }),
    { code: 'verified_plan_selection_invalid' });
  assert.equal(calls, 0);
});

test('receipt is immutable and never grants execution authority', () => {
  const receipt = verify(problem());
  assert.deepEqual(receipt.authority, {
    productionAuthorized: false,
    executionAuthorized: false,
    writerAuthorityGranted: false,
    externalAuthorityClaimed: false,
  });
  assert.throws(() => { receipt.authority.executionAuthorized = true; }, TypeError);
  assert.throws(() => { receipt.selectedCandidateIds.push('other'); }, TypeError);
});

test('exact verifier agrees with selector across deterministic random finite problems', () => {
  let seed = 4819;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
  for (let trial = 0; trial < 50; trial += 1) {
    const specifications = [];
    for (let index = 0; index < 7; index += 1) {
      const dependencies = Array.from({ length: index }, (_, value) => `c${value}`)
        .filter(() => random() % 11 === 0).slice(0, 2);
      specifications.push({
        id: `c${index}`,
        utility: (random() % 15) - 4,
        cpuUnits: random() % 2,
        memoryMiB: random() % 3,
        dependencies,
        mutexGroup: random() % 6 === 0 ? `g${random() % 3}` : null,
      });
    }
    const value = problem(specifications, {
      maximumSelectedCandidates: random() % 8,
      resourceLimits: {
        cpuMilliunits: (random() % 6) * 1000,
        memoryMiB: random() % 10,
      },
    });
    assert.equal(value.selection.status, 'optimal', `trial=${trial}`);
    const receipt = verify(value, { exactEnumerationLimit: 10 });
    assert.equal(receipt.exactOptimalityVerified, true, `trial=${trial}`);
    assert.equal(receipt.sourceOptimalityClaimAccepted, true, `trial=${trial}`);
  }
});
