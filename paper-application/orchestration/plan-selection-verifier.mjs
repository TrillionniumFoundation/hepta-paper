import { hashRecord, stableStringify } from '../../workflow-kernel/record-hash.mjs';
import { createActionCandidate } from './candidate-router.mjs';

const HASH = /^sha256:[0-9a-f]{64}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const RESOURCE_FIELDS = Object.freeze([
  'cpuMilliunits', 'gpuMilliunits', 'memoryMiB', 'storageBytes',
  'tokenCount', 'maximumCostMicrousd',
]);
const CANDIDATE_FIELDS = Object.freeze([
  'schemaVersion', 'kind', 'candidateId', 'planningRequestId',
  'stateSnapshotHash', 'moduleId', 'moduleVersion', 'capabilityId',
  'resourceVector', 'duration', 'cost', 'value', 'risk', 'preconditions',
  'dependencyEffects', 'sideEffectClass', 'irreversibleBoundary',
  'rollbackClass', 'expiresAt', 'inputSchema', 'outputSchema',
  'singletonReason', 'candidatePayloadHash',
]);
const FRONTIER_FIELDS = Object.freeze([
  'schemaVersion', 'kind', 'status', 'planningRequestId', 'planningRequestHash',
  'stateSnapshotHash', 'capabilityId', 'hardConstraintSetHash', 'objectiveVersion',
  'resourcePriceSnapshotHash', 'moduleBindingSetHash', 'candidateCount',
  'duplicateCount', 'candidates', 'emptyReason', 'expiresAt',
  'dominanceReductionApplied', 'authority', 'candidateSetHash',
]);
const REQUEST_FIELDS = Object.freeze([
  'schemaVersion', 'kind', 'selectionRequestId', 'planningRequestHash',
  'stateSnapshotHash', 'candidateSetHash', 'hardConstraintSetHash',
  'objectiveVersion', 'resourcePriceSnapshotHash', 'deadline',
  'expansionBudget', 'maximumSelectedCandidates', 'resourceLimits',
  'requiredCandidateIds', 'evaluations',
]);
const EVALUATION_FIELDS = Object.freeze([
  'candidateId', 'candidatePayloadHash', 'utilityMicrounits',
  'dependencies', 'mutexGroup',
]);
const SELECTION_FIELDS = Object.freeze([
  'schemaVersion', 'kind', 'status', 'selectionRequestId', 'selectionRequestHash',
  'planningRequestHash', 'stateSnapshotHash', 'candidateSetHash',
  'hardConstraintSetHash', 'objectiveVersion', 'resourcePriceSnapshotHash',
  'selectedCandidateIds', 'selectedCandidatePayloadHashes', 'resourceUsage',
  'objectiveLowerBoundMicrounits', 'objectiveUpperBoundMicrounits',
  'optimalityGapMicrounits', 'expandedNodes', 'expansionBudget',
  'frontierExhausted', 'proof', 'authority', 'planSelectionHash',
]);
const FRONTIER_AUTHORITY = Object.freeze([
  'productionAuthorized', 'providerAuthorized',
  'writerAuthorityGranted', 'externalAuthorityClaimed',
]);
const SELECTION_AUTHORITY = Object.freeze([
  'productionAuthorized', 'writerAuthorityGranted',
  'executionAuthorized', 'externalAuthorityClaimed',
]);
const PROOF_FIELDS = Object.freeze([
  'feasibleIncumbent', 'hardConstraintsSatisfied', 'infeasibilityProven',
  'optimalSelectionProven', 'dominanceReductionAssumed',
]);

function failure(code) {
  return Object.assign(new Error(code), { code, retryable: false });
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function record(value, allowed, required, code) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw failure(code);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key !== 'string' || !allowed.includes(key))) throw failure(code);
  const output = Object.create(null);
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw failure(code);
    output[key] = descriptor.value;
  }
  if (required.some((key) => !Object.hasOwn(output, key))) throw failure(code);
  return output;
}

function arrayValues(value, maximum, code) {
  if (!Array.isArray(value) || value.length > maximum) throw failure(code);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key !== 'string')
    || keys.length !== value.length + 1 || !Object.hasOwn(descriptors, 'length')) throw failure(code);
  const output = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw failure(code);
    output.push(descriptor.value);
  }
  return output;
}

function text(value, code, maximumBytes = 4096, pattern = null) {
  if (typeof value !== 'string' || value.length === 0
    || Buffer.byteLength(value, 'utf8') > maximumBytes || value.includes('\0')
    || (pattern && !pattern.test(value))) throw failure(code);
  return value;
}

function nullableText(value, code, maximumBytes = 4096) {
  if (value === null) return null;
  return text(value, code, maximumBytes);
}

function hash(value, code) {
  return text(value, code, 71, HASH);
}

function timestamp(value, code) {
  text(value, code, 64, DATE_TIME);
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw failure(code);
  return Object.freeze({ source: value, milliseconds });
}

function safeInteger(value, minimum, maximum, code) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw failure(code);
  return value;
}

function signedInteger(value, code) {
  if (!Number.isSafeInteger(value)) throw failure(code);
  return value;
}

function nullableInteger(value, code, { nonnegative = false } = {}) {
  if (value === null) return null;
  return safeInteger(value, nonnegative ? 0 : Number.MIN_SAFE_INTEGER,
    Number.MAX_SAFE_INTEGER, code);
}

function safeAdd(left, right, code) {
  const result = left + right;
  if (!Number.isSafeInteger(result)) throw failure(code);
  return result;
}

function canonicalSet(value, maximum, code) {
  const values = arrayValues(value, maximum, code)
    .map((item) => text(item, code, 256, IDENTIFIER))
    .sort(compareText);
  if (new Set(values).size !== values.length) throw failure(code);
  return Object.freeze(values);
}

function captureFalseAuthority(value, fields, code) {
  const data = record(value, fields, fields, code);
  if (fields.some((field) => data[field] !== false)) throw failure(code);
  return Object.freeze(Object.fromEntries(fields.map((field) => [field, false])));
}

function captureCandidate(value) {
  const data = record(value, CANDIDATE_FIELDS, CANDIDATE_FIELDS,
    'verified_plan_candidate_invalid');
  const payload = Object.create(null);
  for (const field of CANDIDATE_FIELDS) {
    if (field !== 'candidatePayloadHash') payload[field] = data[field];
  }
  const canonical = createActionCandidate(payload);
  if (canonical.candidatePayloadHash !== data.candidatePayloadHash
    || stableStringify(canonical) !== stableStringify(data)) {
    throw failure('verified_plan_candidate_not_canonical');
  }
  return canonical;
}

function captureFrontier(value, nowEpochMs) {
  const data = record(value, FRONTIER_FIELDS, FRONTIER_FIELDS,
    'verified_plan_frontier_invalid');
  if (data.schemaVersion !== 1 || data.kind !== 'CandidateFrontierV1'
    || !['complete', 'empty'].includes(data.status)) {
    throw failure('verified_plan_frontier_identity_invalid');
  }
  const candidates = arrayValues(data.candidates, 4096,
    'verified_plan_frontier_candidates_invalid').map(captureCandidate);
  const sorted = [...candidates].sort((left, right) => compareText(left.moduleId, right.moduleId)
    || compareText(left.moduleVersion, right.moduleVersion)
    || compareText(left.candidateId, right.candidateId)
    || compareText(left.candidatePayloadHash, right.candidatePayloadHash));
  if (stableStringify(candidates) !== stableStringify(sorted)) {
    throw failure('verified_plan_frontier_order_invalid');
  }
  const candidateCount = safeInteger(data.candidateCount, 0, 4096,
    'verified_plan_frontier_count_invalid');
  if (candidateCount !== candidates.length
    || new Set(candidates.map((item) => item.candidateId)).size !== candidates.length) {
    throw failure('verified_plan_frontier_count_invalid');
  }
  const emptyReason = nullableText(data.emptyReason,
    'verified_plan_frontier_empty_reason_invalid', 256);
  if ((candidateCount === 0) !== (data.status === 'empty')
    || (candidateCount === 0) !== (emptyReason !== null)) {
    throw failure('verified_plan_frontier_status_invalid');
  }
  if (data.dominanceReductionApplied !== false) {
    throw failure('verified_plan_frontier_dominance_claim_invalid');
  }
  const expiresAt = timestamp(data.expiresAt, 'verified_plan_frontier_expiry_invalid');
  if (expiresAt.milliseconds <= nowEpochMs) throw failure('verified_plan_frontier_expired');
  const body = Object.freeze({
    schemaVersion: 1,
    kind: 'CandidateFrontierV1',
    status: data.status,
    planningRequestId: text(data.planningRequestId,
      'verified_plan_frontier_request_id_invalid', 256, IDENTIFIER),
    planningRequestHash: hash(data.planningRequestHash,
      'verified_plan_frontier_request_hash_invalid'),
    stateSnapshotHash: hash(data.stateSnapshotHash,
      'verified_plan_frontier_snapshot_invalid'),
    capabilityId: text(data.capabilityId,
      'verified_plan_frontier_capability_invalid', 256, IDENTIFIER),
    hardConstraintSetHash: hash(data.hardConstraintSetHash,
      'verified_plan_frontier_constraint_invalid'),
    objectiveVersion: text(data.objectiveVersion,
      'verified_plan_frontier_objective_invalid', 256, IDENTIFIER),
    resourcePriceSnapshotHash: hash(data.resourcePriceSnapshotHash,
      'verified_plan_frontier_prices_invalid'),
    moduleBindingSetHash: hash(data.moduleBindingSetHash,
      'verified_plan_frontier_modules_invalid'),
    candidateCount,
    duplicateCount: safeInteger(data.duplicateCount, 0, 4096,
      'verified_plan_frontier_duplicate_count_invalid'),
    candidates: Object.freeze(candidates),
    emptyReason,
    expiresAt: expiresAt.source,
    dominanceReductionApplied: false,
    authority: captureFalseAuthority(data.authority, FRONTIER_AUTHORITY,
      'verified_plan_frontier_authority_invalid'),
  });
  const claimed = hash(data.candidateSetHash, 'verified_plan_frontier_hash_invalid');
  if (hashRecord('CandidateFrontierV1', body) !== claimed) {
    throw failure('verified_plan_frontier_hash_invalid');
  }
  return Object.freeze({ ...body, candidateSetHash: claimed });
}

function captureResourceVector(value, code) {
  const data = record(value, RESOURCE_FIELDS, RESOURCE_FIELDS, code);
  return Object.freeze(Object.fromEntries(RESOURCE_FIELDS.map((field) => [
    field,
    safeInteger(data[field], 0, Number.MAX_SAFE_INTEGER, `${code}:${field}`),
  ])));
}

function captureEvaluation(value) {
  const data = record(value, EVALUATION_FIELDS, EVALUATION_FIELDS,
    'verified_plan_evaluation_invalid');
  return Object.freeze({
    candidateId: text(data.candidateId, 'verified_plan_evaluation_candidate_invalid', 256, IDENTIFIER),
    candidatePayloadHash: hash(data.candidatePayloadHash,
      'verified_plan_evaluation_hash_invalid'),
    utilityMicrounits: signedInteger(data.utilityMicrounits,
      'verified_plan_evaluation_utility_invalid'),
    dependencies: canonicalSet(data.dependencies, 4096,
      'verified_plan_evaluation_dependencies_invalid'),
    mutexGroup: nullableText(data.mutexGroup, 'verified_plan_evaluation_mutex_invalid', 256),
  });
}

function captureRequest(value, frontier, nowEpochMs) {
  const data = record(value, REQUEST_FIELDS, REQUEST_FIELDS,
    'verified_plan_request_invalid');
  if (data.schemaVersion !== 1 || data.kind !== 'GlobalPlanSelectionRequestV1') {
    throw failure('verified_plan_request_identity_invalid');
  }
  const deadline = timestamp(data.deadline, 'verified_plan_request_deadline_invalid');
  if (deadline.milliseconds <= nowEpochMs
    || deadline.milliseconds > Date.parse(frontier.expiresAt)) {
    throw failure('verified_plan_request_expired_or_outlives_frontier');
  }
  const evaluations = arrayValues(data.evaluations, 4096,
    'verified_plan_evaluations_invalid').map(captureEvaluation)
    .sort((left, right) => compareText(left.candidateId, right.candidateId));
  const request = Object.freeze({
    schemaVersion: 1,
    kind: 'GlobalPlanSelectionRequestV1',
    selectionRequestId: text(data.selectionRequestId,
      'verified_plan_request_id_invalid', 256, IDENTIFIER),
    planningRequestHash: hash(data.planningRequestHash,
      'verified_plan_request_planning_invalid'),
    stateSnapshotHash: hash(data.stateSnapshotHash,
      'verified_plan_request_snapshot_invalid'),
    candidateSetHash: hash(data.candidateSetHash,
      'verified_plan_request_candidates_invalid'),
    hardConstraintSetHash: hash(data.hardConstraintSetHash,
      'verified_plan_request_constraints_invalid'),
    objectiveVersion: text(data.objectiveVersion,
      'verified_plan_request_objective_invalid', 256, IDENTIFIER),
    resourcePriceSnapshotHash: hash(data.resourcePriceSnapshotHash,
      'verified_plan_request_prices_invalid'),
    deadline: deadline.source,
    expansionBudget: safeInteger(data.expansionBudget, 1, 1_000_000,
      'verified_plan_request_budget_invalid'),
    maximumSelectedCandidates: safeInteger(data.maximumSelectedCandidates, 0, 4096,
      'verified_plan_request_count_invalid'),
    resourceLimits: captureResourceVector(data.resourceLimits,
      'verified_plan_resource_limits_invalid'),
    requiredCandidateIds: canonicalSet(data.requiredCandidateIds, 4096,
      'verified_plan_required_candidates_invalid'),
    evaluations: Object.freeze(evaluations),
  });
  for (const [field, expected] of [
    ['planningRequestHash', frontier.planningRequestHash],
    ['stateSnapshotHash', frontier.stateSnapshotHash],
    ['candidateSetHash', frontier.candidateSetHash],
    ['hardConstraintSetHash', frontier.hardConstraintSetHash],
    ['objectiveVersion', frontier.objectiveVersion],
    ['resourcePriceSnapshotHash', frontier.resourcePriceSnapshotHash],
  ]) {
    if (request[field] !== expected) throw failure(`verified_plan_request_binding_mismatch:${field}`);
  }
  return request;
}

function captureProof(value) {
  const data = record(value, PROOF_FIELDS, PROOF_FIELDS, 'verified_plan_source_proof_invalid');
  if (PROOF_FIELDS.some((field) => typeof data[field] !== 'boolean')
    || data.dominanceReductionAssumed !== false) {
    throw failure('verified_plan_source_proof_invalid');
  }
  return Object.freeze(Object.fromEntries(PROOF_FIELDS.map((field) => [field, data[field]])));
}

function captureSelection(value, request) {
  const data = record(value, SELECTION_FIELDS, SELECTION_FIELDS,
    'verified_plan_selection_invalid');
  if (data.schemaVersion !== 1 || data.kind !== 'BoundedGlobalPlanSelectionV1'
    || !['optimal', 'infeasible', 'bounded_feasible', 'bounded_no_incumbent'].includes(data.status)) {
    throw failure('verified_plan_selection_identity_invalid');
  }
  const selectedCandidateIds = data.selectedCandidateIds === null ? null
    : canonicalSet(data.selectedCandidateIds, 4096, 'verified_plan_selected_ids_invalid');
  const selectedCandidatePayloadHashes = data.selectedCandidatePayloadHashes === null ? null
    : Object.freeze(arrayValues(data.selectedCandidatePayloadHashes, 4096,
      'verified_plan_selected_hashes_invalid').map((item) => hash(item,
      'verified_plan_selected_hash_invalid')));
  const resourceUsage = data.resourceUsage === null ? null
    : captureResourceVector(data.resourceUsage, 'verified_plan_resource_usage_invalid');
  const body = Object.freeze({
    schemaVersion: 1,
    kind: 'BoundedGlobalPlanSelectionV1',
    status: data.status,
    selectionRequestId: text(data.selectionRequestId,
      'verified_plan_selection_request_id_invalid', 256, IDENTIFIER),
    selectionRequestHash: hash(data.selectionRequestHash,
      'verified_plan_selection_request_hash_invalid'),
    planningRequestHash: hash(data.planningRequestHash,
      'verified_plan_selection_planning_invalid'),
    stateSnapshotHash: hash(data.stateSnapshotHash,
      'verified_plan_selection_snapshot_invalid'),
    candidateSetHash: hash(data.candidateSetHash,
      'verified_plan_selection_candidates_invalid'),
    hardConstraintSetHash: hash(data.hardConstraintSetHash,
      'verified_plan_selection_constraints_invalid'),
    objectiveVersion: text(data.objectiveVersion,
      'verified_plan_selection_objective_invalid', 256, IDENTIFIER),
    resourcePriceSnapshotHash: hash(data.resourcePriceSnapshotHash,
      'verified_plan_selection_prices_invalid'),
    selectedCandidateIds,
    selectedCandidatePayloadHashes,
    resourceUsage,
    objectiveLowerBoundMicrounits: nullableInteger(data.objectiveLowerBoundMicrounits,
      'verified_plan_selection_lower_invalid'),
    objectiveUpperBoundMicrounits: nullableInteger(data.objectiveUpperBoundMicrounits,
      'verified_plan_selection_upper_invalid'),
    optimalityGapMicrounits: nullableInteger(data.optimalityGapMicrounits,
      'verified_plan_selection_gap_invalid', { nonnegative: true }),
    expandedNodes: safeInteger(data.expandedNodes, 0, 1_000_000,
      'verified_plan_selection_expanded_invalid'),
    expansionBudget: safeInteger(data.expansionBudget, 1, 1_000_000,
      'verified_plan_selection_budget_invalid'),
    frontierExhausted: data.frontierExhausted,
    proof: captureProof(data.proof),
    authority: captureFalseAuthority(data.authority, SELECTION_AUTHORITY,
      'verified_plan_selection_authority_invalid'),
  });
  if (typeof body.frontierExhausted !== 'boolean') {
    throw failure('verified_plan_selection_frontier_state_invalid');
  }
  for (const [field, expected] of [
    ['selectionRequestId', request.selectionRequestId],
    ['selectionRequestHash', hashRecord('GlobalPlanSelectionRequestV1', request)],
    ['planningRequestHash', request.planningRequestHash],
    ['stateSnapshotHash', request.stateSnapshotHash],
    ['candidateSetHash', request.candidateSetHash],
    ['hardConstraintSetHash', request.hardConstraintSetHash],
    ['objectiveVersion', request.objectiveVersion],
    ['resourcePriceSnapshotHash', request.resourcePriceSnapshotHash],
    ['expansionBudget', request.expansionBudget],
  ]) {
    if (body[field] !== expected) throw failure(`verified_plan_selection_binding_mismatch:${field}`);
  }
  const claimed = hash(data.planSelectionHash, 'verified_plan_selection_hash_invalid');
  if (hashRecord('BoundedGlobalPlanSelectionV1', body) !== claimed) {
    throw failure('verified_plan_selection_hash_invalid');
  }
  return Object.freeze({ ...body, planSelectionHash: claimed });
}

function candidateResources(candidate) {
  const scaled = (value, code) => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0
      || !Number.isSafeInteger(value * 1000)) throw failure(code);
    return value * 1000;
  };
  return Object.freeze({
    cpuMilliunits: scaled(candidate.resourceVector.cpuUnits,
      'verified_plan_candidate_cpu_invalid'),
    gpuMilliunits: scaled(candidate.resourceVector.gpuUnits,
      'verified_plan_candidate_gpu_invalid'),
    memoryMiB: candidate.resourceVector.memoryMiB,
    storageBytes: candidate.resourceVector.storageBytes,
    tokenCount: candidate.resourceVector.tokenCount ?? 0,
    maximumCostMicrousd: candidate.resourceVector.maximumCostMicrousd ?? 0,
  });
}

function zeroResources() {
  return Object.fromEntries(RESOURCE_FIELDS.map((field) => [field, 0]));
}

function evaluateSelection(ids, candidateById, evaluationById, request) {
  const selected = new Set(ids);
  if (selected.size !== ids.length || ids.length > request.maximumSelectedCandidates
    || request.requiredCandidateIds.some((id) => !selected.has(id))) return null;
  const groups = new Set();
  const resources = zeroResources();
  let utility = 0;
  for (const id of ids) {
    const candidate = candidateById.get(id);
    const evaluation = evaluationById.get(id);
    if (!candidate || !evaluation
      || evaluation.dependencies.some((dependency) => !selected.has(dependency))) return null;
    if (evaluation.mutexGroup) {
      if (groups.has(evaluation.mutexGroup)) return null;
      groups.add(evaluation.mutexGroup);
    }
    utility = safeAdd(utility, evaluation.utilityMicrounits,
      'verified_plan_objective_overflow');
    const vector = candidateResources(candidate);
    for (const field of RESOURCE_FIELDS) {
      resources[field] = safeAdd(resources[field], vector[field],
        `verified_plan_resource_overflow:${field}`);
      if (resources[field] > request.resourceLimits[field]) return null;
    }
  }
  return Object.freeze({ utility, resources: Object.freeze(resources) });
}

function lexicographicallyBefore(left, right) {
  if (right === null) return true;
  return compareText(left.join('\0'), right.join('\0')) < 0;
}

function exhaustiveOracle(candidates, candidateById, evaluationById, request) {
  let best = null;
  const combinations = 2 ** candidates.length;
  for (let mask = 0; mask < combinations; mask += 1) {
    const ids = [];
    for (let index = 0; index < candidates.length; index += 1) {
      if ((mask & (2 ** index)) !== 0) ids.push(candidates[index].candidateId);
    }
    ids.sort(compareText);
    const evaluated = evaluateSelection(ids, candidateById, evaluationById, request);
    if (!evaluated) continue;
    if (!best || evaluated.utility > best.utility
      || (evaluated.utility === best.utility
        && lexicographicallyBefore(ids, best.ids))) {
      best = Object.freeze({ ids: Object.freeze(ids), ...evaluated });
    }
  }
  return best;
}

export function verifyFeasiblePlanSelection(input) {
  const root = record(input, ['frontier', 'request', 'selection', 'nowEpochMs', 'exactEnumerationLimit'],
    ['frontier', 'request', 'selection', 'nowEpochMs'], 'verified_plan_input_invalid');
  const nowEpochMs = safeInteger(root.nowEpochMs, 0, Number.MAX_SAFE_INTEGER,
    'verified_plan_clock_invalid');
  const exactEnumerationLimit = Object.hasOwn(root, 'exactEnumerationLimit')
    ? safeInteger(root.exactEnumerationLimit, 0, 20,
      'verified_plan_exact_limit_invalid') : 18;
  const frontier = captureFrontier(root.frontier, nowEpochMs);
  const request = captureRequest(root.request, frontier, nowEpochMs);
  const selection = captureSelection(root.selection, request);
  if (!['optimal', 'bounded_feasible'].includes(selection.status)
    || selection.selectedCandidateIds === null
    || selection.selectedCandidatePayloadHashes === null
    || selection.resourceUsage === null
    || selection.objectiveLowerBoundMicrounits === null
    || selection.objectiveUpperBoundMicrounits === null
    || selection.optimalityGapMicrounits === null) {
    throw failure('verified_plan_feasible_incumbent_required');
  }
  if (!selection.proof.feasibleIncumbent || !selection.proof.hardConstraintsSatisfied
    || selection.proof.infeasibilityProven
    || selection.proof.optimalSelectionProven !== (selection.status === 'optimal')
    || selection.frontierExhausted !== (selection.status === 'optimal')) {
    throw failure('verified_plan_source_proof_inconsistent');
  }
  if (selection.selectedCandidateIds.length !== selection.selectedCandidatePayloadHashes.length) {
    throw failure('verified_plan_selected_identity_count_mismatch');
  }
  const candidateById = new Map(frontier.candidates.map((candidate) => [candidate.candidateId, candidate]));
  const evaluationById = new Map();
  for (const evaluation of request.evaluations) {
    const candidate = candidateById.get(evaluation.candidateId);
    if (!candidate || candidate.candidatePayloadHash !== evaluation.candidatePayloadHash
      || evaluationById.has(evaluation.candidateId)
      || evaluation.dependencies.includes(evaluation.candidateId)
      || evaluation.dependencies.some((dependency) => !candidateById.has(dependency))) {
      throw failure('verified_plan_evaluation_binding_invalid');
    }
    evaluationById.set(evaluation.candidateId, evaluation);
  }
  if (evaluationById.size !== frontier.candidates.length) {
    throw failure('verified_plan_evaluation_coverage_invalid');
  }
  for (let index = 0; index < selection.selectedCandidateIds.length; index += 1) {
    const candidate = candidateById.get(selection.selectedCandidateIds[index]);
    if (!candidate
      || candidate.candidatePayloadHash !== selection.selectedCandidatePayloadHashes[index]) {
      throw failure('verified_plan_selected_identity_invalid');
    }
  }
  const feasible = evaluateSelection(selection.selectedCandidateIds,
    candidateById, evaluationById, request);
  if (!feasible) throw failure('verified_plan_hard_constraint_violation');
  if (feasible.utility !== selection.objectiveLowerBoundMicrounits
    || stableStringify(feasible.resources) !== stableStringify(selection.resourceUsage)) {
    throw failure('verified_plan_incumbent_accounting_invalid');
  }
  if (selection.objectiveUpperBoundMicrounits < feasible.utility
    || selection.optimalityGapMicrounits
      !== selection.objectiveUpperBoundMicrounits - feasible.utility) {
    throw failure('verified_plan_source_bound_invalid');
  }
  let trivialUpper = 0;
  for (const evaluation of request.evaluations) {
    if (evaluation.utilityMicrounits > 0) {
      trivialUpper = safeAdd(trivialUpper, evaluation.utilityMicrounits,
        'verified_plan_independent_bound_overflow');
    }
  }
  let exact = null;
  if (frontier.candidates.length <= exactEnumerationLimit) {
    exact = exhaustiveOracle(frontier.candidates, candidateById, evaluationById, request);
    if (!exact) throw failure('verified_plan_incumbent_conflicts_with_exact_oracle');
    if (selection.objectiveUpperBoundMicrounits < exact.utility) {
      throw failure('verified_plan_source_upper_bound_invalid');
    }
    if (selection.status === 'optimal'
      && (selection.objectiveLowerBoundMicrounits !== exact.utility
        || stableStringify(selection.selectedCandidateIds) !== stableStringify(exact.ids))) {
      throw failure('verified_plan_optimality_claim_invalid');
    }
  }
  const independentUpper = exact?.utility ?? trivialUpper;
  const independentGap = safeAdd(independentUpper, -feasible.utility,
    'verified_plan_independent_gap_overflow');
  const exactOptimalityVerified = Boolean(exact
    && exact.utility === feasible.utility
    && stableStringify(exact.ids) === stableStringify(selection.selectedCandidateIds));
  const body = Object.freeze({
    schemaVersion: 1,
    kind: 'VerifiedFeasiblePlanSelectionV1',
    status: exactOptimalityVerified
      ? 'exact_optimum_verified_non_authorizing'
      : 'feasible_selection_verified_with_independent_bound',
    candidateSetHash: frontier.candidateSetHash,
    selectionRequestHash: selection.selectionRequestHash,
    planSelectionHash: selection.planSelectionHash,
    selectedCandidateIds: selection.selectedCandidateIds,
    selectedCandidatePayloadHashes: selection.selectedCandidatePayloadHashes,
    independentlyComputedResourceUsage: feasible.resources,
    independentlyComputedUtilityMicrounits: feasible.utility,
    independentObjectiveUpperBoundMicrounits: independentUpper,
    independentOptimalityGapMicrounits: independentGap,
    exactEnumerationPerformed: exact !== null,
    exactOptimalityVerified,
    sourceStatus: selection.status,
    sourceOptimalityClaimAccepted: selection.status === 'optimal' && exactOptimalityVerified,
    proof: Object.freeze({
      candidateAndRequestBindingsVerified: true,
      hardConstraintsVerified: true,
      sourceIncumbentAccountingVerified: true,
      sourceUpperBoundVerified: exact !== null,
      dominanceReductionAssumed: false,
    }),
    authority: Object.freeze({
      productionAuthorized: false,
      executionAuthorized: false,
      writerAuthorityGranted: false,
      externalAuthorityClaimed: false,
    }),
  });
  return Object.freeze({
    ...body,
    verifiedPlanSelectionHash: hashRecord('VerifiedFeasiblePlanSelectionV1', body),
  });
}
