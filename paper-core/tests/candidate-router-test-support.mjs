import { actionCandidatePayloadHash } from '../../paper-application/orchestration/candidate-router.mjs';

export const H = (c) => `sha256:${c.repeat(64)}`;
export const observedAt = '2026-09-05T00:00:00Z';
export const requestExpiry = '2026-09-05T01:00:00Z';
export const candidateExpiry = '2026-09-05T00:30:00Z';

export function request(overrides = {}) {
  return {
    schemaVersion: 1,
    kind: 'PlanningRequestV1',
    planningRequestId: 'plan-1',
    stateSnapshotHash: H('a'),
    capabilityId: 'CAP-AUTHOR',
    hardConstraintSetHash: H('b'),
    objectiveVersion: 'objective-v1',
    resourcePriceSnapshotHash: H('c'),
    candidateLimit: 16,
    candidateBytesLimit: 1024 * 1024,
    expiresAt: requestExpiry,
    allowedSideEffectClasses: ['none', 'prepared_result_only'],
    ...overrides,
  };
}

export function binding(overrides = {}) {
  return {
    schemaVersion: 1,
    kind: 'QualifiedCandidateModuleV1',
    moduleId: 'module.author-node',
    moduleVersion: '1.0.0',
    protocolVersion: 1,
    capabilityIds: ['CAP-AUTHOR'],
    sourceIdentityHash: H('d'),
    configurationHash: H('e'),
    qualificationSubjectHash: H('f'),
    qualificationStatus: 'source_qualified',
    expiresAt: requestExpiry,
    ...overrides,
  };
}

export function semantic(overrides = {}) {
  return {
    schemaVersion: 1,
    kind: 'ActionCandidateV1',
    planningRequestId: 'plan-1',
    stateSnapshotHash: H('a'),
    moduleId: 'module.author-node',
    moduleVersion: '1.0.0',
    capabilityId: 'CAP-AUTHOR',
    resourceVector: {
      cpuUnits: 1,
      gpuUnits: 0,
      memoryMiB: 512,
      storageBytes: 4096,
      tokenCount: 100,
      maximumCostMicrousd: 1000,
    },
    duration: { lowerMs: 10, upperMs: 20 },
    cost: { maximumMicrousd: 1000 },
    value: { expectedMicrounits: 100 },
    risk: { failureProbabilityPpm: 1000 },
    preconditions: ['policy-current'],
    dependencyEffects: ['artifact:input'],
    sideEffectClass: 'none',
    irreversibleBoundary: null,
    rollbackClass: 'reversible',
    expiresAt: candidateExpiry,
    inputSchema: null,
    outputSchema: 'schema:author-output-v1',
    ...overrides,
  };
}

export function candidate(candidateId, overrides = {}) {
  const raw = semantic(overrides);
  const body = {
    ...raw,
    ...(raw.preconditions ? { preconditions: [...raw.preconditions].sort() } : {}),
    ...(raw.dependencyEffects ? { dependencyEffects: [...raw.dependencyEffects].sort() } : {}),
  };
  return {
    candidateId,
    ...body,
    candidatePayloadHash: actionCandidatePayloadHash(body),
  };
}

export function input(candidates, overrides = {}) {
  return {
    planningRequest: request(),
    moduleBindings: [binding()],
    candidates,
    observedAt,
    ...overrides,
  };
}

export function singleton(id = 'candidate-a', overrides = {}) {
  return candidate(id, { singletonReason: 'only_feasible_candidate', ...overrides });
}

export const code = (value) => ({ code: value });
