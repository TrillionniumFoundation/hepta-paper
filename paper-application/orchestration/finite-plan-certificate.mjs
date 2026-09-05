import crypto from 'node:crypto';
import { optimizeFinitePlan } from './finite-plan-optimizer-entry.mjs';

const HASH = /^sha256:[0-9a-f]{64}$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u;
const API_FIELDS = Object.freeze([
  'snapshot', 'frontier', 'problem', 'optimizationResult', 'policy',
  'planId', 'createdAt', 'expiresAt', 'now', 'optimizerLimits',
]);
const POLICY_FIELDS = Object.freeze([
  'schemaVersion', 'kind', 'requireOptimality', 'maximumAcceptedGapMicrounits',
  'allowEmptyPlan', 'maximumPlanLifetimeSeconds', 'executionPolicyHash',
  'commitPolicyHash', 'resourcePolicyHash',
]);
const PROBLEM_FIELDS = Object.freeze([
  'schemaVersion', 'kind', 'stateSnapshotHash', 'candidateSetHash',
  'hardConstraintSetHash', 'objectiveVersion', 'calibrationPolicyHash',
  'minimumSelected', 'maximumSelected', 'budgets', 'searchNodeBudget', 'candidates',
]);
const FRONTIER_FIELDS = Object.freeze([
  'schemaVersion', 'kind', 'status', 'planningRequestId', 'stateSnapshotHash',
  'capabilityId', 'planningRequestHash', 'moduleBindingSetHash', 'candidateCount',
  'candidates', 'candidateSetHash', 'totalCapturedBytes', 'dominanceReductionApplied',
  'dominanceDisposition', 'authority',
]);
const CANDIDATE_FIELDS = Object.freeze([
  'schemaVersion', 'kind', 'candidateId', 'planningRequestId', 'stateSnapshotHash',
  'moduleId', 'moduleVersion', 'capabilityId', 'resourceVector', 'duration', 'cost',
  'value', 'risk', 'preconditions', 'dependencyEffects', 'sideEffectClass',
  'irreversibleBoundary', 'rollbackClass', 'expiresAt', 'inputSchema', 'outputSchema',
  'candidatePayloadHash', 'singletonReason',
]);
const SNAPSHOT_FIELDS = Object.freeze([
  'schemaVersion', 'kind', 'status', 'repositorySubjectHash', 'revision',
  'writerGeneration', 'readEpoch', 'capturedAt', 'expiresAt', 'policy',
  'projections', 'moduleBindings', 'totalCapturedBytes', 'authority', 'stateSnapshotHash',
]);
const RESULT_FIELDS = Object.freeze([
  'schemaVersion', 'kind', 'status', 'problemHash', 'stateSnapshotHash',
  'candidateSetHash', 'selectedCandidatePayloadHashes', 'selectedCandidateIds',
  'selectedResourceUsage', 'selectedUtilityMicrounits', 'lowerBoundUtilityMicrounits',
  'upperBoundUtilityMicrounits', 'optimalityGapMicrounits', 'optimalityProven',
  'infeasibilityProven', 'searchNodesExpanded', 'searchNodesRemaining',
  'searchNodesPruned', 'searchTraceHash', 'authority', 'resultHash',
]);

function fail(code) {
  throw Object.assign(new Error(code), { code, retryable: false });
}

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function ownDataRecord(value, allowed, required, code) {
  if (value === null || typeof value !== 'object'
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(code);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key !== 'string' || !allowed.includes(key))) fail(code);
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail(code);
  }
  if (required.some((key) => !Object.hasOwn(descriptors, key))) fail(code);
  return Object.fromEntries(keys.map((key) => [key, descriptors[key].value]));
}

function denseArray(value, code) {
  if (!Array.isArray(value)) fail(code);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== value.length + 1) fail(code);
  const rows = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[index];
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail(code);
    rows.push(descriptor.value);
  }
  return rows;
}

function canonicalize(value, seen = new WeakSet()) {
  if (Array.isArray(value)) {
    if (seen.has(value)) fail('finite_plan_certificate_cycle');
    seen.add(value);
    try {
      return `[${denseArray(value, 'finite_plan_certificate_array_invalid')
        .map((item) => canonicalize(item, seen)).join(',')}]`;
    } finally { seen.delete(value); }
  }
  if (value && typeof value === 'object') {
    if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
      fail('finite_plan_certificate_record_invalid');
    }
    if (seen.has(value)) fail('finite_plan_certificate_cycle');
    seen.add(value);
    try {
      const descriptors = Object.getOwnPropertyDescriptors(value);
      const keys = Reflect.ownKeys(descriptors);
      if (keys.some((key) => typeof key !== 'string')) {
        fail('finite_plan_certificate_record_invalid');
      }
      return `{${keys.sort(compareUtf8).map((key) => {
        const descriptor = descriptors[key];
        if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
          fail('finite_plan_certificate_accessor_invalid');
        }
        return `${JSON.stringify(key)}:${canonicalize(descriptor.value, seen)}`;
      }).join(',')}}`;
    } finally { seen.delete(value); }
  }
  if (typeof value === 'number' && (!Number.isFinite(value)
    || Math.abs(value) > Number.MAX_SAFE_INTEGER)) {
    fail('finite_plan_certificate_number_invalid');
  }
  const encoded = JSON.stringify(Object.is(value, -0) ? 0 : value);
  if (encoded === undefined) fail('finite_plan_certificate_value_invalid');
  return encoded;
}

function hashDomain(kind, value) {
  return `sha256:${crypto.createHash('sha256')
    .update(Buffer.from(canonicalize({ kind, value }), 'utf8')).digest('hex')}`;
}

function exactHash(value, code) {
  if (typeof value !== 'string' || !HASH.test(value)) fail(code);
  return value;
}

function exactIdentifier(value, code) {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) fail(code);
  return value;
}

function safeInteger(value, code, { minimum = 0, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) fail(code);
  return value;
}

function strictTimestamp(value, code) {
  if (typeof value !== 'string') fail(code);
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|([+-])(\d{2}):(\d{2}))$/u.exec(value);
  if (!match) fail(code);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[8] === 'Z' ? 0 : Number(match[10]);
  const offsetMinute = match[8] === 'Z' ? 0 : Number(match[11]);
  if (year < 1970 || year > 9999 || month < 1 || month > 12 || hour > 23
    || minute > 59 || second > 59 || offsetHour > 23 || offsetMinute > 59) fail(code);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthDays = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (day < 1 || day > monthDays[month - 1]) fail(code);
  const fraction = (match[7] || '').padEnd(9, '0');
  const milliseconds = Date.UTC(year, month - 1, day, hour, minute, second, 0);
  const offset = match[8] === 'Z' ? 0
    : (match[9] === '+' ? 1 : -1) * (offsetHour * 60 + offsetMinute) * 60 * 1000;
  return BigInt(milliseconds - offset) * 1_000_000n + BigInt(fraction || '0');
}

function allFalse(value, code) {
  if (value === null || typeof value !== 'object'
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(code);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (!keys.length || keys.some((key) => typeof key !== 'string')) fail(code);
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')
      || descriptor.value !== false) fail(code);
  }
}

function capturePolicy(raw) {
  const input = ownDataRecord(raw, POLICY_FIELDS, POLICY_FIELDS,
    'finite_plan_acceptance_policy_invalid');
  if (input.schemaVersion !== 1 || input.kind !== 'FinitePlanAcceptancePolicyV1'
    || typeof input.requireOptimality !== 'boolean'
    || typeof input.allowEmptyPlan !== 'boolean') {
    fail('finite_plan_acceptance_policy_invalid');
  }
  const maximumAcceptedGapMicrounits = safeInteger(input.maximumAcceptedGapMicrounits,
    'finite_plan_acceptance_gap_invalid');
  if (input.requireOptimality && maximumAcceptedGapMicrounits !== 0) {
    fail('finite_plan_acceptance_gap_invalid');
  }
  const body = Object.freeze({
    schemaVersion: 1,
    kind: 'FinitePlanAcceptancePolicyV1',
    requireOptimality: input.requireOptimality,
    maximumAcceptedGapMicrounits,
    allowEmptyPlan: input.allowEmptyPlan,
    maximumPlanLifetimeSeconds: safeInteger(input.maximumPlanLifetimeSeconds,
      'finite_plan_lifetime_invalid', { minimum: 1, maximum: 7 * 24 * 60 * 60 }),
    executionPolicyHash: exactHash(input.executionPolicyHash,
      'finite_plan_execution_policy_invalid'),
    commitPolicyHash: exactHash(input.commitPolicyHash,
      'finite_plan_commit_policy_invalid'),
    resourcePolicyHash: exactHash(input.resourcePolicyHash,
      'finite_plan_resource_policy_invalid'),
  });
  return Object.freeze({ body, policyHash: hashDomain('FinitePlanAcceptancePolicyV1', body) });
}

function captureProblem(raw) {
  const input = ownDataRecord(raw, PROBLEM_FIELDS, PROBLEM_FIELDS,
    'finite_plan_problem_invalid');
  if (input.schemaVersion !== 1 || input.kind !== 'FiniteOptimizationProblemV1') {
    fail('finite_plan_problem_invalid');
  }
  return Object.freeze({
    stateSnapshotHash: exactHash(input.stateSnapshotHash, 'finite_plan_snapshot_hash_invalid'),
    candidateSetHash: exactHash(input.candidateSetHash, 'finite_plan_candidate_set_invalid'),
    hardConstraintSetHash: exactHash(input.hardConstraintSetHash,
      'finite_plan_constraint_set_invalid'),
    objectiveVersion: exactIdentifier(input.objectiveVersion,
      'finite_plan_objective_invalid'),
    calibrationPolicyHash: exactHash(input.calibrationPolicyHash,
      'finite_plan_calibration_invalid'),
  });
}

function captureSnapshot(raw) {
  const input = ownDataRecord(raw, SNAPSHOT_FIELDS, SNAPSHOT_FIELDS,
    'finite_plan_snapshot_invalid');
  allFalse(input.authority, 'finite_plan_snapshot_authority_invalid');
  return Object.freeze({
    stateSnapshotHash: exactHash(input.stateSnapshotHash, 'finite_plan_snapshot_hash_invalid'),
    repositorySubjectHash: exactHash(input.repositorySubjectHash,
      'finite_plan_repository_subject_invalid'),
    revision: safeInteger(input.revision, 'finite_plan_revision_invalid'),
    writerGeneration: safeInteger(input.writerGeneration,
      'finite_plan_writer_generation_invalid'),
    readEpoch: safeInteger(input.readEpoch, 'finite_plan_read_epoch_invalid'),
    expiresAt: input.expiresAt,
  });
}

function captureFrontier(raw) {
  const input = ownDataRecord(raw, FRONTIER_FIELDS, FRONTIER_FIELDS,
    'finite_plan_frontier_invalid');
  allFalse(input.authority, 'finite_plan_frontier_authority_invalid');
  const candidates = denseArray(input.candidates, 'finite_plan_candidates_invalid');
  const byHash = new Map();
  for (const rawCandidate of candidates) {
    const candidate = ownDataRecord(rawCandidate, CANDIDATE_FIELDS,
      ['candidateId', 'candidatePayloadHash', 'expiresAt'], 'finite_plan_candidate_invalid');
    const candidatePayloadHash = exactHash(candidate.candidatePayloadHash,
      'finite_plan_candidate_hash_invalid');
    if (byHash.has(candidatePayloadHash)) fail('finite_plan_candidate_duplicate');
    byHash.set(candidatePayloadHash, Object.freeze({
      candidateId: exactIdentifier(candidate.candidateId, 'finite_plan_candidate_id_invalid'),
      expiresAt: candidate.expiresAt,
    }));
  }
  return Object.freeze({
    planningRequestHash: exactHash(input.planningRequestHash,
      'finite_plan_planning_request_invalid'),
    moduleBindingSetHash: exactHash(input.moduleBindingSetHash,
      'finite_plan_module_binding_invalid'),
    candidateSetHash: exactHash(input.candidateSetHash,
      'finite_plan_candidate_set_invalid'),
    byHash,
  });
}

function assertAcceptedResult(result, policy) {
  if (result.status === 'optimal_plan_proven') return;
  if (result.status !== 'bounded_plan_search_incomplete') {
    fail('finite_plan_no_acceptable_incumbent');
  }
  if (policy.requireOptimality) fail('finite_plan_optimality_required');
  if (!Number.isSafeInteger(result.optimalityGapMicrounits)
    || result.optimalityGapMicrounits < 0
    || result.optimalityGapMicrounits > policy.maximumAcceptedGapMicrounits) {
    fail('finite_plan_gap_exceeds_policy');
  }
}

export function buildFinitePlanCertificate(rawInput) {
  const input = ownDataRecord(rawInput, API_FIELDS,
    API_FIELDS.filter((field) => field !== 'optimizerLimits'),
    'finite_plan_certificate_request_invalid');
  const recomputed = optimizeFinitePlan({
    snapshot: input.snapshot,
    frontier: input.frontier,
    problem: input.problem,
    now: input.now,
    ...(Object.hasOwn(input, 'optimizerLimits') ? { limits: input.optimizerLimits } : {}),
  });
  const suppliedResult = ownDataRecord(input.optimizationResult, RESULT_FIELDS,
    RESULT_FIELDS, 'finite_plan_result_invalid');
  if (canonicalize(suppliedResult) !== canonicalize(recomputed)) {
    fail('finite_plan_result_mismatch');
  }
  allFalse(recomputed.authority, 'finite_plan_result_authority_invalid');
  const policy = capturePolicy(input.policy);
  assertAcceptedResult(recomputed, policy.body);
  if (!policy.body.allowEmptyPlan && recomputed.selectedCandidatePayloadHashes.length === 0) {
    fail('finite_plan_empty_not_allowed');
  }

  const snapshot = captureSnapshot(input.snapshot);
  const frontier = captureFrontier(input.frontier);
  const problem = captureProblem(input.problem);
  if (problem.stateSnapshotHash !== snapshot.stateSnapshotHash
    || problem.candidateSetHash !== frontier.candidateSetHash) {
    fail('finite_plan_subject_mismatch');
  }

  const planId = exactIdentifier(input.planId, 'finite_plan_id_invalid');
  if (input.createdAt !== input.now) fail('finite_plan_creation_time_mismatch');
  const created = strictTimestamp(input.createdAt, 'finite_plan_time_invalid');
  const expires = strictTimestamp(input.expiresAt, 'finite_plan_time_invalid');
  if (expires <= created
    || expires - created > BigInt(policy.body.maximumPlanLifetimeSeconds) * 1_000_000_000n
    || expires > strictTimestamp(snapshot.expiresAt, 'finite_plan_snapshot_time_invalid')) {
    fail('finite_plan_expiry_invalid');
  }

  const selectedIds = [];
  for (const candidateHash of recomputed.selectedCandidatePayloadHashes) {
    const candidate = frontier.byHash.get(candidateHash);
    if (!candidate) fail('finite_plan_selected_candidate_missing');
    if (expires > strictTimestamp(candidate.expiresAt, 'finite_plan_candidate_time_invalid')) {
      fail('finite_plan_expiry_invalid');
    }
    selectedIds.push(candidate.candidateId);
  }
  if (canonicalize(selectedIds) !== canonicalize(recomputed.selectedCandidateIds)) {
    fail('finite_plan_selected_identity_mismatch');
  }

  const authority = Object.freeze({
    productionAuthorized: false,
    executionAuthorized: false,
    writerAuthorized: false,
    providerAuthorized: false,
    releaseAuthorized: false,
    submissionAuthorized: false,
  });
  const body = Object.freeze({
    schemaVersion: 1,
    kind: 'FinitePlanCertificateV1',
    status: 'plan_candidate_certificate_ready_nonactivating',
    planId,
    stateSnapshotHash: snapshot.stateSnapshotHash,
    repositorySubjectHash: snapshot.repositorySubjectHash,
    revision: snapshot.revision,
    writerGeneration: snapshot.writerGeneration,
    readEpoch: snapshot.readEpoch,
    planningRequestHash: frontier.planningRequestHash,
    moduleBindingSetHash: frontier.moduleBindingSetHash,
    candidateSetHash: frontier.candidateSetHash,
    optimizationProblemHash: recomputed.problemHash,
    optimizationResultHash: recomputed.resultHash,
    acceptancePolicyHash: policy.policyHash,
    hardConstraintSetHash: problem.hardConstraintSetHash,
    objectiveVersion: problem.objectiveVersion,
    calibrationPolicyHash: problem.calibrationPolicyHash,
    selectedCandidatePayloadHashes: recomputed.selectedCandidatePayloadHashes,
    selectedCandidateIds: Object.freeze(selectedIds),
    selectedResourceUsage: recomputed.selectedResourceUsage,
    selectedUtilityMicrounits: recomputed.selectedUtilityMicrounits,
    lowerBoundUtilityMicrounits: recomputed.lowerBoundUtilityMicrounits,
    upperBoundUtilityMicrounits: recomputed.upperBoundUtilityMicrounits,
    optimalityGapMicrounits: recomputed.optimalityGapMicrounits,
    optimalityProven: recomputed.optimalityProven,
    createdAt: input.createdAt,
    expiresAt: input.expiresAt,
    authority,
  });
  return Object.freeze({
    ...body,
    planCertificateHash: hashDomain('FinitePlanCertificateV1', body),
  });
}
