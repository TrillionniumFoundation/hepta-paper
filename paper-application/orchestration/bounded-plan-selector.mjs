import { hashRecord, stableStringify } from '../../workflow-kernel/record-hash.mjs';
import { createActionCandidate } from './candidate-router.mjs';

const HASH = /^sha256:[0-9a-f]{64}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const FRONTIER_FIELDS = Object.freeze([
  'schemaVersion', 'kind', 'status', 'planningRequestId', 'planningRequestHash',
  'stateSnapshotHash', 'capabilityId', 'hardConstraintSetHash', 'objectiveVersion',
  'resourcePriceSnapshotHash', 'moduleBindingSetHash', 'candidateCount',
  'duplicateCount', 'candidates', 'emptyReason', 'expiresAt',
  'dominanceReductionApplied', 'authority', 'candidateSetHash',
]);
const CANDIDATE_FIELDS = Object.freeze([
  'schemaVersion', 'kind', 'candidateId', 'planningRequestId',
  'stateSnapshotHash', 'moduleId', 'moduleVersion', 'capabilityId',
  'resourceVector', 'duration', 'cost', 'value', 'risk', 'preconditions',
  'dependencyEffects', 'sideEffectClass', 'irreversibleBoundary',
  'rollbackClass', 'expiresAt', 'inputSchema', 'outputSchema',
  'singletonReason', 'candidatePayloadHash',
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
const RESOURCE_LIMIT_FIELDS = Object.freeze([
  'cpuMilliunits', 'gpuMilliunits', 'memoryMiB', 'storageBytes',
  'tokenCount', 'maximumCostMicrousd',
]);
const AUTHORITY_FIELDS = Object.freeze([
  'productionAuthorized', 'providerAuthorized',
  'writerAuthorityGranted', 'externalAuthorityClaimed',
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
  const result = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw failure(code);
    result.push(descriptor.value);
  }
  return result;
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

function dateTime(value, code) {
  text(value, code, 64, DATE_TIME);
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw failure(code);
  return Object.freeze({ source: value, milliseconds });
}

function safeInteger(value, minimum, maximum, code) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw failure(code);
  return value;
}

function signedSafeInteger(value, code) {
  if (!Number.isSafeInteger(value)) throw failure(code);
  return value;
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

function captureAuthority(value, code) {
  const data = record(value, AUTHORITY_FIELDS, AUTHORITY_FIELDS, code);
  if (AUTHORITY_FIELDS.some((field) => data[field] !== false)) throw failure(code);
  return Object.freeze(Object.fromEntries(AUTHORITY_FIELDS.map((field) => [field, false])));
}

function captureCandidate(value) {
  const data = record(value, CANDIDATE_FIELDS, CANDIDATE_FIELDS, 'plan_candidate_invalid');
  const payload = Object.create(null);
  for (const field of CANDIDATE_FIELDS) {
    if (field !== 'candidatePayloadHash') payload[field] = data[field];
  }
  const canonical = createActionCandidate(payload);
  if (canonical.candidatePayloadHash !== data.candidatePayloadHash
    || stableStringify(canonical) !== stableStringify(data)) {
    throw failure('plan_candidate_not_canonical');
  }
  return canonical;
}

function captureFrontier(value, nowEpochMs) {
  const data = record(value, FRONTIER_FIELDS, FRONTIER_FIELDS, 'candidate_frontier_invalid');
  if (data.schemaVersion !== 1 || data.kind !== 'CandidateFrontierV1'
    || !['complete', 'empty'].includes(data.status)) throw failure('candidate_frontier_identity_invalid');
  const candidates = arrayValues(data.candidates, 4096, 'candidate_frontier_candidates_invalid')
    .map(captureCandidate);
  const expectedOrder = [...candidates].sort((left, right) => compareText(left.moduleId, right.moduleId)
    || compareText(left.moduleVersion, right.moduleVersion)
    || compareText(left.candidateId, right.candidateId)
    || compareText(left.candidatePayloadHash, right.candidatePayloadHash));
  if (stableStringify(candidates) !== stableStringify(expectedOrder)) {
    throw failure('candidate_frontier_order_invalid');
  }
  const candidateCount = safeInteger(data.candidateCount, 0, 4096,
    'candidate_frontier_count_invalid');
  const duplicateCount = safeInteger(data.duplicateCount, 0, 4096,
    'candidate_frontier_duplicate_count_invalid');
  if (candidateCount !== candidates.length) throw failure('candidate_frontier_count_invalid');
  const emptyReason = nullableText(data.emptyReason, 'candidate_frontier_empty_reason_invalid', 256);
  if ((data.status === 'empty') !== (candidateCount === 0)
    || (candidateCount === 0) !== (emptyReason !== null)) {
    throw failure('candidate_frontier_status_invalid');
  }
  if (candidateCount === 1 && candidates[0].singletonReason === null) {
    throw failure('candidate_frontier_singleton_invalid');
  }
  if (data.dominanceReductionApplied !== false) throw failure('candidate_frontier_dominance_claim_invalid');
  const expiresAt = dateTime(data.expiresAt, 'candidate_frontier_expiry_invalid');
  if (expiresAt.milliseconds <= nowEpochMs) throw failure('candidate_frontier_expired');
  const body = Object.freeze({
    schemaVersion: 1,
    kind: 'CandidateFrontierV1',
    status: data.status,
    planningRequestId: text(data.planningRequestId, 'candidate_frontier_request_id_invalid', 256, IDENTIFIER),
    planningRequestHash: hash(data.planningRequestHash, 'candidate_frontier_request_hash_invalid'),
    stateSnapshotHash: hash(data.stateSnapshotHash, 'candidate_frontier_snapshot_invalid'),
    capabilityId: text(data.capabilityId, 'candidate_frontier_capability_invalid', 256, IDENTIFIER),
    hardConstraintSetHash: hash(data.hardConstraintSetHash, 'candidate_frontier_constraints_invalid'),
    objectiveVersion: text(data.objectiveVersion, 'candidate_frontier_objective_invalid', 256, IDENTIFIER),
    resourcePriceSnapshotHash: hash(data.resourcePriceSnapshotHash, 'candidate_frontier_prices_invalid'),
    moduleBindingSetHash: hash(data.moduleBindingSetHash, 'candidate_frontier_modules_invalid'),
    candidateCount,
    duplicateCount,
    candidates: Object.freeze(candidates),
    emptyReason,
    expiresAt: expiresAt.source,
    dominanceReductionApplied: false,
    authority: captureAuthority(data.authority, 'candidate_frontier_authority_invalid'),
  });
  const claimed = hash(data.candidateSetHash, 'candidate_frontier_hash_invalid');
  if (hashRecord('CandidateFrontierV1', body) !== claimed) throw failure('candidate_frontier_hash_invalid');
  return Object.freeze({ ...body, candidateSetHash: claimed });
}

function scaledUnits(value, code) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw failure(code);
  const scaled = value * 1000;
  if (!Number.isSafeInteger(scaled)) throw failure(code);
  return scaled;
}

function captureResourceLimits(value) {
  const data = record(value, RESOURCE_LIMIT_FIELDS, RESOURCE_LIMIT_FIELDS,
    'plan_resource_limits_invalid');
  return Object.freeze(Object.fromEntries(RESOURCE_LIMIT_FIELDS.map((field) => [
    field,
    safeInteger(data[field], 0, Number.MAX_SAFE_INTEGER, `plan_resource_limit_invalid:${field}`),
  ])));
}

function candidateResources(candidate) {
  const source = candidate.resourceVector;
  return Object.freeze({
    cpuMilliunits: scaledUnits(source.cpuUnits, 'plan_candidate_cpu_units_invalid'),
    gpuMilliunits: scaledUnits(source.gpuUnits, 'plan_candidate_gpu_units_invalid'),
    memoryMiB: source.memoryMiB,
    storageBytes: source.storageBytes,
    tokenCount: source.tokenCount ?? 0,
    maximumCostMicrousd: source.maximumCostMicrousd ?? 0,
  });
}

function captureEvaluation(value) {
  const data = record(value, EVALUATION_FIELDS, EVALUATION_FIELDS, 'plan_evaluation_invalid');
  return Object.freeze({
    candidateId: text(data.candidateId, 'plan_evaluation_candidate_invalid', 256, IDENTIFIER),
    candidatePayloadHash: hash(data.candidatePayloadHash, 'plan_evaluation_payload_hash_invalid'),
    utilityMicrounits: signedSafeInteger(data.utilityMicrounits, 'plan_evaluation_utility_invalid'),
    dependencies: canonicalSet(data.dependencies, 4096, 'plan_evaluation_dependencies_invalid'),
    mutexGroup: nullableText(data.mutexGroup, 'plan_evaluation_mutex_invalid', 256),
  });
}

function captureRequest(value, frontier, nowEpochMs) {
  const data = record(value, REQUEST_FIELDS, REQUEST_FIELDS, 'plan_selection_request_invalid');
  if (data.schemaVersion !== 1 || data.kind !== 'GlobalPlanSelectionRequestV1') {
    throw failure('plan_selection_request_identity_invalid');
  }
  const deadline = dateTime(data.deadline, 'plan_selection_deadline_invalid');
  if (deadline.milliseconds <= nowEpochMs) throw failure('plan_selection_request_expired');
  const request = {
    schemaVersion: 1,
    kind: 'GlobalPlanSelectionRequestV1',
    selectionRequestId: text(data.selectionRequestId, 'plan_selection_request_id_invalid', 256, IDENTIFIER),
    planningRequestHash: hash(data.planningRequestHash, 'plan_selection_planning_request_invalid'),
    stateSnapshotHash: hash(data.stateSnapshotHash, 'plan_selection_snapshot_invalid'),
    candidateSetHash: hash(data.candidateSetHash, 'plan_selection_candidate_set_invalid'),
    hardConstraintSetHash: hash(data.hardConstraintSetHash, 'plan_selection_constraints_invalid'),
    objectiveVersion: text(data.objectiveVersion, 'plan_selection_objective_invalid', 256, IDENTIFIER),
    resourcePriceSnapshotHash: hash(data.resourcePriceSnapshotHash, 'plan_selection_prices_invalid'),
    deadline: deadline.source,
    expansionBudget: safeInteger(data.expansionBudget, 1, 1_000_000,
      'plan_selection_expansion_budget_invalid'),
    maximumSelectedCandidates: safeInteger(data.maximumSelectedCandidates, 0, 4096,
      'plan_selection_candidate_limit_invalid'),
    resourceLimits: captureResourceLimits(data.resourceLimits),
    requiredCandidateIds: canonicalSet(data.requiredCandidateIds, 4096,
      'plan_selection_required_candidates_invalid'),
    evaluations: Object.freeze(arrayValues(data.evaluations, 4096, 'plan_evaluations_invalid')
      .map(captureEvaluation).sort((left, right) => compareText(left.candidateId, right.candidateId))),
  };
  const bindings = [
    ['planningRequestHash', frontier.planningRequestHash, 'plan_selection_planning_request_mismatch'],
    ['stateSnapshotHash', frontier.stateSnapshotHash, 'plan_selection_snapshot_mismatch'],
    ['candidateSetHash', frontier.candidateSetHash, 'plan_selection_candidate_set_mismatch'],
    ['hardConstraintSetHash', frontier.hardConstraintSetHash, 'plan_selection_constraints_mismatch'],
    ['objectiveVersion', frontier.objectiveVersion, 'plan_selection_objective_mismatch'],
    ['resourcePriceSnapshotHash', frontier.resourcePriceSnapshotHash, 'plan_selection_prices_mismatch'],
  ];
  for (const [field, expected, code] of bindings) {
    if (request[field] !== expected) throw failure(code);
  }
  if (deadline.milliseconds > Date.parse(frontier.expiresAt)) {
    throw failure('plan_selection_deadline_exceeds_frontier');
  }
  return Object.freeze(request);
}

function zeroResources() {
  return Object.freeze(Object.fromEntries(RESOURCE_LIMIT_FIELDS.map((field) => [field, 0])));
}

function addResources(left, right) {
  return Object.freeze(Object.fromEntries(RESOURCE_LIMIT_FIELDS.map((field) => [
    field,
    safeAdd(left[field], right[field], `plan_resource_sum_overflow:${field}`),
  ])));
}

function resourcesFit(used, limits) {
  return RESOURCE_LIMIT_FIELDS.every((field) => used[field] <= limits[field]);
}

function lexicographicallyBefore(left, right) {
  if (right === null) return true;
  const leftKey = [...left].sort(compareText).join('\0');
  const rightKey = [...right].sort(compareText).join('\0');
  return compareText(leftKey, rightKey) < 0;
}

function selectedDependenciesSatisfied(selected, evaluationById) {
  for (const candidateId of selected) {
    if (evaluationById.get(candidateId).dependencies.some((dependency) => !selected.has(dependency))) {
      return false;
    }
  }
  return true;
}

export function selectBoundedGlobalPlan(input) {
  const root = record(input, ['frontier', 'request', 'nowEpochMs'],
    ['frontier', 'request', 'nowEpochMs'], 'plan_selector_input_invalid');
  const nowEpochMs = safeInteger(root.nowEpochMs, 0, Number.MAX_SAFE_INTEGER,
    'plan_selector_clock_invalid');
  const frontier = captureFrontier(root.frontier, nowEpochMs);
  const request = captureRequest(root.request, frontier, nowEpochMs);
  const candidateById = new Map(frontier.candidates.map((candidate) => [candidate.candidateId, candidate]));
  if (candidateById.size !== frontier.candidates.length) throw failure('plan_candidate_identity_duplicate');
  const evaluationById = new Map();
  for (const evaluation of request.evaluations) {
    const candidate = candidateById.get(evaluation.candidateId);
    if (!candidate || candidate.candidatePayloadHash !== evaluation.candidatePayloadHash) {
      throw failure('plan_evaluation_candidate_binding_mismatch');
    }
    if (evaluationById.has(evaluation.candidateId)) throw failure('plan_evaluation_duplicate');
    evaluationById.set(evaluation.candidateId, evaluation);
  }
  if (evaluationById.size !== frontier.candidates.length) throw failure('plan_evaluation_coverage_invalid');
  for (const evaluation of request.evaluations) {
    if (evaluation.dependencies.includes(evaluation.candidateId)
      || evaluation.dependencies.some((dependency) => !candidateById.has(dependency))) {
      throw failure('plan_evaluation_dependency_invalid');
    }
  }
  if (request.requiredCandidateIds.some((candidateId) => !candidateById.has(candidateId))) {
    throw failure('plan_required_candidate_unknown');
  }
  const candidates = frontier.candidates.map((candidate) => Object.freeze({
    candidate,
    evaluation: evaluationById.get(candidate.candidateId),
    resources: candidateResources(candidate),
  })).sort((left, right) => right.evaluation.utilityMicrounits - left.evaluation.utilityMicrounits
    || compareText(left.candidate.candidateId, right.candidate.candidateId));
  let positiveTotal = 0;
  let negativeTotal = 0;
  for (const item of candidates) {
    if (item.evaluation.utilityMicrounits > 0) {
      positiveTotal = safeAdd(positiveTotal, item.evaluation.utilityMicrounits,
        'plan_objective_bound_overflow');
    } else {
      negativeTotal = safeAdd(negativeTotal, item.evaluation.utilityMicrounits,
        'plan_objective_bound_overflow');
    }
  }
  void negativeTotal;
  const suffixPositive = Array(candidates.length + 1).fill(0);
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    suffixPositive[index] = safeAdd(suffixPositive[index + 1],
      Math.max(0, candidates[index].evaluation.utilityMicrounits), 'plan_objective_bound_overflow');
  }
  const required = new Set(request.requiredCandidateIds);
  let incumbent = required.size === 0
    ? { utility: 0, selected: new Set(), resources: zeroResources() } : null;
  const stack = [{
    index: 0,
    utility: 0,
    bound: positiveTotal,
    selected: new Set(),
    excluded: new Set(),
    groups: new Set(),
    resources: zeroResources(),
  }];
  let expandedNodes = 0;
  while (stack.length && expandedNodes < request.expansionBudget) {
    const node = stack.pop();
    expandedNodes += 1;
    if (incumbent && node.bound < incumbent.utility) continue;
    if (node.index === candidates.length) {
      if ([...required].some((candidateId) => !node.selected.has(candidateId))
        || !selectedDependenciesSatisfied(node.selected, evaluationById)) continue;
      if (!incumbent || node.utility > incumbent.utility
        || (node.utility === incumbent.utility
          && lexicographicallyBefore(node.selected, incumbent.selected))) {
        incumbent = { utility: node.utility, selected: node.selected, resources: node.resources };
      }
      continue;
    }
    const item = candidates[node.index];
    const { candidate, evaluation, resources } = item;
    const nextIndex = node.index + 1;
    const requiredHere = required.has(candidate.candidateId);
    const selectedRequiresHere = [...node.selected]
      .some((selectedId) => evaluationById.get(selectedId).dependencies.includes(candidate.candidateId));
    const canExclude = !requiredHere && !selectedRequiresHere;
    const canInclude = node.selected.size < request.maximumSelectedCandidates
      && (!evaluation.mutexGroup || !node.groups.has(evaluation.mutexGroup))
      && !evaluation.dependencies.some((dependency) => node.excluded.has(dependency));
    const includeResources = canInclude ? addResources(node.resources, resources) : null;
    const includeFits = canInclude && resourcesFit(includeResources, request.resourceLimits);
    const includeUtility = includeFits
      ? safeAdd(node.utility, evaluation.utilityMicrounits, 'plan_objective_sum_overflow') : null;
    const includeNode = includeFits ? {
      index: nextIndex,
      utility: includeUtility,
      bound: safeAdd(includeUtility, suffixPositive[nextIndex], 'plan_objective_bound_overflow'),
      selected: new Set([...node.selected, candidate.candidateId]),
      excluded: new Set(node.excluded),
      groups: new Set(evaluation.mutexGroup ? [...node.groups, evaluation.mutexGroup] : node.groups),
      resources: includeResources,
    } : null;
    const excludeNode = canExclude ? {
      index: nextIndex,
      utility: node.utility,
      bound: safeAdd(node.utility, suffixPositive[nextIndex], 'plan_objective_bound_overflow'),
      selected: new Set(node.selected),
      excluded: new Set([...node.excluded, candidate.candidateId]),
      groups: new Set(node.groups),
      resources: node.resources,
    } : null;
    const includeFirst = requiredHere || evaluation.utilityMicrounits >= 0;
    if (includeFirst) {
      if (excludeNode) stack.push(excludeNode);
      if (includeNode) stack.push(includeNode);
    } else {
      if (includeNode) stack.push(includeNode);
      if (excludeNode) stack.push(excludeNode);
    }
  }
  const exhausted = stack.length === 0;
  let status;
  let upperBound = null;
  if (exhausted) {
    status = incumbent ? 'optimal' : 'infeasible';
    upperBound = incumbent?.utility ?? null;
  } else {
    status = incumbent ? 'bounded_feasible' : 'bounded_no_incumbent';
    upperBound = Math.max(incumbent?.utility ?? Number.MIN_SAFE_INTEGER,
      ...stack.map((node) => node.bound));
  }
  const selectedIds = incumbent ? Object.freeze([...incumbent.selected].sort(compareText)) : null;
  const selectedHashes = selectedIds ? Object.freeze(selectedIds.map((candidateId) =>
    candidateById.get(candidateId).candidatePayloadHash)) : null;
  const lowerBound = incumbent?.utility ?? null;
  const gap = lowerBound === null || upperBound === null
    ? null : safeAdd(upperBound, -lowerBound, 'plan_objective_gap_overflow');
  const body = Object.freeze({
    schemaVersion: 1,
    kind: 'BoundedGlobalPlanSelectionV1',
    status,
    selectionRequestId: request.selectionRequestId,
    selectionRequestHash: hashRecord('GlobalPlanSelectionRequestV1', request),
    planningRequestHash: request.planningRequestHash,
    stateSnapshotHash: request.stateSnapshotHash,
    candidateSetHash: request.candidateSetHash,
    hardConstraintSetHash: request.hardConstraintSetHash,
    objectiveVersion: request.objectiveVersion,
    resourcePriceSnapshotHash: request.resourcePriceSnapshotHash,
    selectedCandidateIds: selectedIds,
    selectedCandidatePayloadHashes: selectedHashes,
    resourceUsage: incumbent?.resources ?? null,
    objectiveLowerBoundMicrounits: lowerBound,
    objectiveUpperBoundMicrounits: upperBound,
    optimalityGapMicrounits: gap,
    expandedNodes,
    expansionBudget: request.expansionBudget,
    frontierExhausted: exhausted,
    proof: Object.freeze({
      feasibleIncumbent: incumbent !== null,
      hardConstraintsSatisfied: incumbent !== null,
      infeasibilityProven: status === 'infeasible',
      optimalSelectionProven: status === 'optimal',
      dominanceReductionAssumed: false,
    }),
    authority: Object.freeze({
      productionAuthorized: false,
      writerAuthorityGranted: false,
      executionAuthorized: false,
      externalAuthorityClaimed: false,
    }),
  });
  return Object.freeze({ ...body, planSelectionHash: hashRecord('BoundedGlobalPlanSelectionV1', body) });
}
