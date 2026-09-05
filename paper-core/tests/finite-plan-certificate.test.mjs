import assert from 'node:assert/strict';
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
import { buildFinitePlanCertificate }
  from '../../paper-application/orchestration/finite-plan-certificate.mjs';

const H = (character) => `sha256:${character.repeat(64)}`;
const NOW = '2026-09-06T00:00:00.123456789Z';
const SNAPSHOT_EXPIRY = '2026-09-07T00:00:00Z';

function snapshotWith(status = 'running') {
  const projection = {
    schemaVersion: 1, kind: 'PlanningProjectionV1', projectionId: 'campaigns',
    sourceModuleId: 'module.readonly-control', schemaRef: 'schema:campaign-v1',
    revision: 12, writerGeneration: 4, readEpoch: 9,
    payload: { campaigns: [{ id: 'campaign-1', status }] },
  };
  return buildPlanningSnapshot({
    transaction: {
      schemaVersion: 1, kind: 'ReadSnapshotTransactionV1', repositorySubjectHash: H('a'),
      revision: 12, writerGeneration: 4, readEpoch: 9,
      capturedAt: '2026-09-06T00:00:00Z', expiresAt: SNAPSHOT_EXPIRY,
    },
    projections: [{ ...projection, projectionHash: hashPlanningProjectionV1(projection) }],
    moduleBindings: [{
      moduleId: 'module.alpha', moduleVersion: '1.0.0',
      capabilityIds: ['CAP-MOD-CANDIDATES'], qualificationSubjectHash: H('d'),
    }],
    policy: {
      hardConstraintSetHash: H('b'), objectiveVersion: 'objective-v1',
      resourcePriceSnapshotHash: H('c'), allowedSideEffectClasses: ['none'],
    },
    now: NOW,
  });
}

function zeroResources(overrides = {}) {
  return {
    cpuMicrounits: 0, gpuMicrounits: 0, memoryMiB: 0,
    storageBytes: 0, tokenCount: 0, maximumCostMicrousd: 0,
    ...overrides,
  };
}

function stack(specs, problemOverrides = {}, snapshot = snapshotWith()) {
  const planningRequest = {
    schemaVersion: 1, kind: 'PlanningRequestV1', planningRequestId: 'planning-1',
    stateSnapshotHash: snapshot.stateSnapshotHash, capabilityId: 'CAP-MOD-CANDIDATES',
    hardConstraintSetHash: snapshot.policy.hardConstraintSetHash,
    objectiveVersion: snapshot.policy.objectiveVersion,
    resourcePriceSnapshotHash: snapshot.policy.resourcePriceSnapshotHash,
    candidateLimit: specs.length, createdAt: snapshot.capturedAt,
    expiresAt: snapshot.expiresAt,
    allowedSideEffectClasses: snapshot.policy.allowedSideEffectClasses,
  };
  const candidates = specs.map((spec) => {
    const body = {
      schemaVersion: 1, kind: 'ActionCandidateV1', candidateId: spec.id,
      planningRequestId: planningRequest.planningRequestId,
      stateSnapshotHash: snapshot.stateSnapshotHash,
      moduleId: 'module.alpha', moduleVersion: '1.0.0',
      capabilityId: planningRequest.capabilityId,
      resourceVector: { cpuUnits: 0, gpuUnits: 0, memoryMiB: 0, storageBytes: 0,
        tokenCount: 0, maximumCostMicrousd: spec.cost ?? 0 },
      duration: {}, cost: {}, value: {}, risk: {}, preconditions: [],
      dependencyEffects: [], sideEffectClass: 'none', irreversibleBoundary: null,
      rollbackClass: 'pure', expiresAt: spec.expiresAt ?? '2026-09-06T12:00:00Z',
      inputSchema: null, outputSchema: null,
      singletonReason: specs.length === 1 ? 'only_feasible_candidate' : null,
    };
    return { ...body, candidatePayloadHash: hashActionCandidateV1(body) };
  });
  const frontier = routeActionCandidates({ planningRequest, candidates,
    qualifiedModules: snapshot.moduleBindings, now: NOW });
  const byId = new Map(frontier.candidates.map((candidate) => [candidate.candidateId, candidate]));
  const annotations = specs.map((spec) => {
    const body = {
      schemaVersion: 1, kind: 'OptimizationCandidateV1',
      candidatePayloadHash: byId.get(spec.id).candidatePayloadHash,
      estimateSubjectHash: H('e'), utilityMicrounits: spec.utility,
      resources: zeroResources({ maximumCostMicrousd: spec.cost ?? 0 }),
      dependencies: (spec.dependencies ?? []).map((id) => byId.get(id).candidatePayloadHash),
      decisionGroup: spec.group ?? null, required: spec.required ?? false,
    };
    return { ...body, annotationHash: hashOptimizationCandidateV1(body) };
  });
  const problem = {
    schemaVersion: 1, kind: 'FiniteOptimizationProblemV1',
    stateSnapshotHash: snapshot.stateSnapshotHash, candidateSetHash: frontier.candidateSetHash,
    hardConstraintSetHash: snapshot.policy.hardConstraintSetHash,
    objectiveVersion: snapshot.policy.objectiveVersion, calibrationPolicyHash: H('f'),
    minimumSelected: 0, maximumSelected: specs.length,
    budgets: zeroResources({ maximumCostMicrousd: 100 }),
    searchNodeBudget: 1000000, candidates: annotations, ...problemOverrides,
  };
  const optimizationResult = optimizeFinitePlan({ snapshot, frontier, problem, now: NOW });
  return { snapshot, frontier, problem, optimizationResult };
}

function acceptance(overrides = {}) {
  return {
    schemaVersion: 1, kind: 'FinitePlanAcceptancePolicyV1', requireOptimality: true,
    maximumAcceptedGapMicrounits: 0, allowEmptyPlan: false,
    maximumPlanLifetimeSeconds: 3600, executionPolicyHash: H('1'),
    commitPolicyHash: H('2'), resourcePolicyHash: H('3'), ...overrides,
  };
}

function certify(value, overrides = {}) {
  return buildFinitePlanCertificate({
    ...value, policy: acceptance(), planId: 'plan-1', createdAt: NOW,
    expiresAt: '2026-09-06T00:30:00Z', now: NOW, ...overrides,
  });
}

const rejectCode = (operation, code) => assert.throws(operation, { code });

test('optimal result produces an immutable nonactivating certificate', () => {
  const result = certify(stack([{ id: 'a', utility: 5 }, { id: 'b', utility: 4 }]));
  assert.equal(result.status, 'plan_candidate_certificate_ready_nonactivating');
  assert.equal(result.optimalityProven, true);
  assert.equal(result.optimalityGapMicrounits, 0);
  assert.ok(Object.values(result.authority).every((value) => value === false));
  assert.throws(() => result.selectedCandidateIds.push('x'), TypeError);
  assert.throws(() => { result.selectedResourceUsage.memoryMiB = 9; }, TypeError);
});

test('supplied optimization result is recomputed and byte-compared', () => {
  const value = stack([{ id: 'a', utility: 5 }]);
  const tampered = structuredClone(value.optimizationResult);
  tampered.selectedCandidateIds = ['forged'];
  rejectCode(() => certify({ ...value, optimizationResult: tampered }),
    'finite_plan_result_mismatch');
  const hashTamper = structuredClone(value.optimizationResult);
  hashTamper.resultHash = H('9');
  rejectCode(() => certify({ ...value, optimizationResult: hashTamper }),
    'finite_plan_result_mismatch');
});

test('bounded incomplete result requires explicit gap policy', () => {
  const value = stack([{ id: 'a', utility: 10 }, { id: 'b', utility: 9 }], {
    maximumSelected: 1, searchNodeBudget: 1,
  });
  assert.equal(value.optimizationResult.status, 'bounded_plan_search_incomplete');
  rejectCode(() => certify(value), 'finite_plan_optimality_required');
  const accepted = certify(value, { policy: acceptance({ requireOptimality: false,
    maximumAcceptedGapMicrounits: value.optimizationResult.optimalityGapMicrounits }) });
  assert.equal(accepted.optimalityProven, false);
});

test('bounded result exceeding accepted gap is rejected', () => {
  const value = stack([{ id: 'a', utility: 10 }, { id: 'b', utility: 9 }], {
    maximumSelected: 1, searchNodeBudget: 1,
  });
  const gap = value.optimizationResult.optimalityGapMicrounits;
  rejectCode(() => certify(value, { policy: acceptance({ requireOptimality: false,
    maximumAcceptedGapMicrounits: Math.max(0, gap - 1) }) }),
  'finite_plan_gap_exceeds_policy');
});

test('no-incumbent and proven-infeasible results never produce a plan', () => {
  const noIncumbent = stack([{ id: 'a', utility: 1 }], {
    minimumSelected: 1, searchNodeBudget: 1,
  });
  rejectCode(() => certify(noIncumbent, { policy: acceptance({ requireOptimality: false,
    maximumAcceptedGapMicrounits: 100 }) }), 'finite_plan_no_acceptable_incumbent');
  const infeasible = stack([{ id: 'a', utility: 1, cost: 2, required: true }], {
    minimumSelected: 1, budgets: zeroResources({ maximumCostMicrousd: 1 }),
  });
  rejectCode(() => certify(infeasible), 'finite_plan_no_acceptable_incumbent');
});

test('empty optimal plan needs an explicit acceptance policy', () => {
  const value = stack([{ id: 'a', utility: 0 }]);
  assert.deepEqual(value.optimizationResult.selectedCandidateIds, []);
  rejectCode(() => certify(value), 'finite_plan_empty_not_allowed');
  assert.deepEqual(certify(value, { policy: acceptance({ allowEmptyPlan: true }) })
    .selectedCandidateIds, []);
});

test('optimality-required policy must declare zero accepted gap', () => {
  rejectCode(() => certify(stack([{ id: 'a', utility: 1 }]), {
    policy: acceptance({ maximumAcceptedGapMicrounits: 1 }),
  }), 'finite_plan_acceptance_gap_invalid');
});

test('creation time and plan lifetime are explicit and bounded', () => {
  const value = stack([{ id: 'a', utility: 1 }]);
  rejectCode(() => certify(value, { createdAt: '2026-09-06T00:00:00Z' }),
    'finite_plan_creation_time_mismatch');
  rejectCode(() => certify(value, { expiresAt: '2026-09-06T02:00:00Z' }),
    'finite_plan_expiry_invalid');
});

test('plan cannot outlive the snapshot or a selected candidate', () => {
  const candidateLimited = stack([{ id: 'a', utility: 1,
    expiresAt: '2026-09-06T00:10:00Z' }]);
  rejectCode(() => certify(candidateLimited, { expiresAt: '2026-09-06T00:20:00Z' }),
    'finite_plan_expiry_invalid');
  const value = stack([{ id: 'a', utility: 1 }]);
  rejectCode(() => certify(value, { expiresAt: SNAPSHOT_EXPIRY,
    policy: acceptance({ maximumPlanLifetimeSeconds: 7 * 24 * 60 * 60 }) }),
  'finite_plan_expiry_invalid');
});

test('strict timestamps reject invalid dates and preserve nanoseconds', () => {
  const value = stack([{ id: 'a', utility: 1 }]);
  for (const expiresAt of ['2026-02-30T00:00:00Z', '2026-09-06T24:00:00Z',
    '2026-09-06T00:00:00+00:60', '2026-09-06T00:00:00']) {
    assert.throws(() => certify(value, { expiresAt }));
  }
  assert.ok(certify(value, { expiresAt: '2026-09-06T00:00:00.123456790Z' }));
});

test('policy identities alter certificate identity', () => {
  const value = stack([{ id: 'a', utility: 1 }]);
  const first = certify(value);
  const second = certify(value, { policy: acceptance({ executionPolicyHash: H('4') }) });
  assert.notEqual(first.acceptancePolicyHash, second.acceptancePolicyHash);
  assert.notEqual(first.planCertificateHash, second.planCertificateHash);
});

test('problem snapshot and frontier identities remain bound', () => {
  const value = stack([{ id: 'a', utility: 1 }]);
  const problem = structuredClone(value.problem);
  problem.hardConstraintSetHash = H('9');
  assert.throws(() => certify({ ...value, problem }));
  const other = stack([{ id: 'a', utility: 1 }], {}, snapshotWith('paused'));
  assert.throws(() => certify({ ...value, snapshot: other.snapshot }));
});

test('annotation order does not change the certificate', () => {
  const first = stack([{ id: 'a', utility: 5 }, { id: 'b', utility: 4 }]);
  const second = stack([{ id: 'a', utility: 5 }, { id: 'b', utility: 4 }]);
  second.problem.candidates.reverse();
  second.optimizationResult = optimizeFinitePlan({ snapshot: second.snapshot,
    frontier: second.frontier, problem: second.problem, now: NOW });
  assert.equal(certify(first).planCertificateHash, certify(second).planCertificateHash);
});

test('unknown fields accessors sparse arrays and authority escalation fail closed', () => {
  const value = stack([{ id: 'a', utility: 1 }]);
  assert.throws(() => buildFinitePlanCertificate({
    ...value, policy: acceptance(), planId: 'plan-1', createdAt: NOW,
    expiresAt: '2026-09-06T00:30:00Z', now: NOW, unknown: true,
  }));
  let calls = 0;
  const request = Object.defineProperty({}, 'snapshot', { enumerable: true,
    get() { calls += 1; return value.snapshot; } });
  assert.throws(() => buildFinitePlanCertificate(request));
  assert.equal(calls, 0);
  const result = structuredClone(value.optimizationResult);
  result.authority.productionAuthorized = true;
  assert.throws(() => certify({ ...value, optimizationResult: result }));
  const frontier = structuredClone(value.frontier);
  frontier.candidates[Symbol('extra')] = true;
  assert.throws(() => certify({ ...value, frontier }));
});

test('certificate binds revision generation epoch resources and bounds exactly', () => {
  const value = stack([{ id: 'a', utility: 7, cost: 2 }]);
  const result = certify(value);
  assert.equal(result.revision, value.snapshot.revision);
  assert.equal(result.writerGeneration, value.snapshot.writerGeneration);
  assert.equal(result.readEpoch, value.snapshot.readEpoch);
  assert.deepEqual(result.selectedResourceUsage, value.optimizationResult.selectedResourceUsage);
  assert.equal(result.lowerBoundUtilityMicrounits,
    value.optimizationResult.lowerBoundUtilityMicrounits);
  assert.equal(result.upperBoundUtilityMicrounits,
    value.optimizationResult.upperBoundUtilityMicrounits);
});
