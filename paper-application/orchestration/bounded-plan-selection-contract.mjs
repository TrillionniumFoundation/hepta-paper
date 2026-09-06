import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const HASH = /^sha256:[0-9a-f]{64}$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,191}$/u;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,127}$/u;
const DIMENSION = /^[a-z][A-Za-z0-9]{0,63}$/u;
const MAX_CANDIDATES = 64;
const MAX_DIMENSIONS = 32;
const MAX_GROUPS = 128;
const MAX_NODE_EXPANSIONS = 1_000_000;
const MAX_MAGNITUDE = 1_000_000_000_000;
const MAX_VALUE_NODES = 131_072;
const MAX_VALUE_DEPTH = 32;

const PROBLEM_FIELDS = Object.freeze([
  'schemaVersion', 'kind', 'planId', 'candidateCollectionResultHash',
  'snapshotCurrentnessReceiptHash', 'hardConstraintSetHash',
  'objectiveVersion', 'resourcePriceSnapshotHash', 'evaluationPolicyHash',
  'selectedAt', 'capacities', 'evaluations', 'requiredCandidateIds',
  'forbiddenCandidateIds', 'exactlyOneGroups', 'atMostOneGroups',
  'conflicts', 'minimumSelected', 'maximumSelected',
  'maximumNodeExpansions', 'optimizationProblemHash',
]);
const EVALUATION_FIELDS = Object.freeze([
  'candidateId', 'candidatePayloadHash', 'utilityMicrounits', 'resources',
  'dependsOnCandidateIds',
]);

export function plannerFailure(code) {
  return Object.assign(new Error(code), { code, retryable: false });
}

export function failPlanner(code) {
  throw plannerFailure(code);
}

export function comparePlannerText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function plannerRecord(value, allowed, code) {
  if (!value || typeof value !== 'object'
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    failPlanner(code);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(value);
  if (keys.length > MAX_VALUE_NODES
    || keys.some((key) => typeof key !== 'string'
      || (allowed && !allowed.includes(key)))) failPlanner(code);
  const output = Object.create(null);
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
      failPlanner(code);
    }
    output[key] = descriptor.value;
  }
  return output;
}

export function exactPlannerRecord(value, fields, code) {
  const output = plannerRecord(value, fields, code);
  if (Object.keys(output).length !== fields.length
    || fields.some((field) => !Object.hasOwn(output, field))) failPlanner(code);
  return output;
}

export function plannerDenseArray(value, maximum, code, minimum = 0) {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    failPlanner(code);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).length !== value.length + 1) failPlanner(code);
  const output = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[index];
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
      failPlanner(code);
    }
    output.push(descriptor.value);
  }
  return output;
}

export function plannerText(value, pattern, code) {
  if (typeof value !== 'string' || !pattern.test(value) || value.includes('\0')) {
    failPlanner(code);
  }
  return value;
}

export function plannerHash(value, code) {
  return plannerText(value, HASH, code);
}

export function plannerIdentifier(value, code) {
  return plannerText(value, IDENTIFIER, code);
}

export function plannerToken(value, code) {
  return plannerText(value, TOKEN, code);
}

export function plannerInteger(value, minimum, maximum, code) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    failPlanner(code);
  }
  return value;
}

export function plannerTimestamp(value, code) {
  if (typeof value !== 'string' || value.length > 40) failPlanner(code);
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) failPlanner(code);
  const canonical = new Date(milliseconds).toISOString();
  if (value !== canonical && value !== canonical.replace('.000Z', 'Z')) {
    failPlanner(code);
  }
  return canonical;
}

export function capturePlannerJson(value, state = {
  nodes: 0,
  stack: new WeakSet(),
}, depth = 0) {
  state.nodes += 1;
  if (state.nodes > MAX_VALUE_NODES || depth > MAX_VALUE_DEPTH) {
    failPlanner('planner_value_structure_limit');
  }
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (value.length > 65_536 || value.includes('\0')) {
      failPlanner('planner_value_string_invalid');
    }
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) failPlanner('planner_value_number_invalid');
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== 'object') failPlanner('planner_value_type_invalid');
  if (state.stack.has(value)) failPlanner('planner_value_cycle');
  state.stack.add(value);
  try {
    if (Array.isArray(value)) {
      return Object.freeze(plannerDenseArray(
        value, MAX_VALUE_NODES, 'planner_value_array_invalid',
      ).map((entry) => capturePlannerJson(entry, state, depth + 1)));
    }
    const data = plannerRecord(value, null, 'planner_value_record_invalid');
    const output = {};
    for (const key of Object.keys(data).sort(comparePlannerText)) {
      if (!key.length || key.length > 256 || key.includes('\0')) {
        failPlanner('planner_value_key_invalid');
      }
      output[key] = capturePlannerJson(data[key], state, depth + 1);
    }
    return Object.freeze(output);
  } finally {
    state.stack.delete(value);
  }
}

function safeAdd(left, right, code) {
  const result = left + right;
  if (!Number.isSafeInteger(result)) failPlanner(code);
  return result;
}

function normalizeCapacities(value) {
  const data = plannerRecord(value, null, 'plan_capacity_invalid');
  const dimensions = Object.keys(data).sort(comparePlannerText);
  if (!dimensions.length || dimensions.length > MAX_DIMENSIONS
    || dimensions.some((key) => !DIMENSION.test(key))) {
    failPlanner('plan_capacity_invalid');
  }
  const capacities = {};
  for (const dimension of dimensions) {
    capacities[dimension] = plannerInteger(
      data[dimension], 0, MAX_MAGNITUDE,
      `plan_capacity_value_invalid:${dimension}`,
    );
  }
  return Object.freeze(capacities);
}

function normalizeResources(value, dimensions) {
  const data = plannerRecord(value, dimensions, 'plan_candidate_resources_invalid');
  if (Object.keys(data).length !== dimensions.length
    || dimensions.some((dimension) => !Object.hasOwn(data, dimension))) {
    failPlanner('plan_candidate_resources_invalid');
  }
  return Object.freeze(Object.fromEntries(dimensions.map((dimension) => [
    dimension,
    plannerInteger(data[dimension], 0, MAX_MAGNITUDE,
      `plan_candidate_resource_invalid:${dimension}`),
  ])));
}

function identifierSet(value, code, maximum = MAX_CANDIDATES) {
  const result = plannerDenseArray(value, maximum, code)
    .map((item) => plannerIdentifier(item, code))
    .sort(comparePlannerText);
  if (new Set(result).size !== result.length) failPlanner(code);
  return Object.freeze(result);
}

function normalizeEvaluations(value, dimensions) {
  const raw = plannerDenseArray(value, MAX_CANDIDATES,
    'plan_evaluation_set_invalid');
  const evaluations = raw.map((item) => {
    const data = exactPlannerRecord(item, EVALUATION_FIELDS,
      'plan_candidate_evaluation_invalid');
    return Object.freeze({
      candidateId: plannerIdentifier(data.candidateId,
        'plan_candidate_id_invalid'),
      candidatePayloadHash: plannerHash(data.candidatePayloadHash,
        'plan_candidate_hash_invalid'),
      utilityMicrounits: plannerInteger(
        data.utilityMicrounits, -MAX_MAGNITUDE, MAX_MAGNITUDE,
        'plan_candidate_utility_invalid',
      ),
      resources: normalizeResources(data.resources, dimensions),
      dependsOnCandidateIds: identifierSet(
        data.dependsOnCandidateIds, 'plan_candidate_dependencies_invalid',
      ),
    });
  }).sort((left, right) => comparePlannerText(left.candidateId, right.candidateId));
  const ids = new Set();
  const hashes = new Set();
  let absoluteUtility = 0;
  const resourceSums = Object.fromEntries(dimensions.map((dimension) => [dimension, 0]));
  for (const evaluation of evaluations) {
    if (ids.has(evaluation.candidateId)) failPlanner('plan_candidate_id_duplicate');
    if (hashes.has(evaluation.candidatePayloadHash)) failPlanner('plan_candidate_hash_duplicate');
    ids.add(evaluation.candidateId);
    hashes.add(evaluation.candidatePayloadHash);
    absoluteUtility = safeAdd(absoluteUtility, Math.abs(evaluation.utilityMicrounits),
      'plan_utility_sum_overflow');
    for (const dimension of dimensions) {
      resourceSums[dimension] = safeAdd(
        resourceSums[dimension], evaluation.resources[dimension],
        `plan_resource_sum_overflow:${dimension}`,
      );
    }
  }
  for (const evaluation of evaluations) {
    if (evaluation.dependsOnCandidateIds.some((id) => !ids.has(id))) {
      failPlanner('plan_candidate_dependency_unknown');
    }
  }
  return Object.freeze(evaluations);
}

function normalizeGroups(value, ids, code) {
  const groups = plannerDenseArray(value, MAX_GROUPS, code).map((group) => {
    const members = identifierSet(group, code);
    if (!members.length || members.some((id) => !ids.has(id))) failPlanner(code);
    return members;
  }).sort((left, right) => comparePlannerText(
    JSON.stringify(left), JSON.stringify(right),
  ));
  const encoded = groups.map((group) => JSON.stringify(group));
  if (new Set(encoded).size !== encoded.length) failPlanner(code);
  return Object.freeze(groups);
}

function normalizeConflicts(value, ids) {
  const pairs = plannerDenseArray(value, MAX_GROUPS * MAX_CANDIDATES,
    'plan_conflict_set_invalid').map((pair) => {
    const members = identifierSet(pair, 'plan_conflict_pair_invalid', 2);
    if (members.length !== 2 || members.some((id) => !ids.has(id))) {
      failPlanner('plan_conflict_pair_invalid');
    }
    return members;
  }).sort((left, right) => comparePlannerText(
    JSON.stringify(left), JSON.stringify(right),
  ));
  const encoded = pairs.map((pair) => JSON.stringify(pair));
  if (new Set(encoded).size !== encoded.length) failPlanner('plan_conflict_duplicate');
  return Object.freeze(pairs);
}

function normalizeProblem(value, requireHash) {
  const data = plannerRecord(value, PROBLEM_FIELDS, 'plan_selection_problem_invalid');
  const required = PROBLEM_FIELDS.filter((field) => field !== 'optimizationProblemHash');
  if (required.some((field) => !Object.hasOwn(data, field))
    || (requireHash && !Object.hasOwn(data, 'optimizationProblemHash'))
    || (!requireHash && Object.hasOwn(data, 'optimizationProblemHash'))
    || Object.keys(data).length !== required.length + (requireHash ? 1 : 0)) {
    failPlanner('plan_selection_problem_invalid');
  }
  if (data.schemaVersion !== 1 || data.kind !== 'BoundedPlanSelectionProblemV1') {
    failPlanner('plan_selection_problem_identity_invalid');
  }
  const capacities = normalizeCapacities(data.capacities);
  const dimensions = Object.keys(capacities);
  const evaluations = normalizeEvaluations(data.evaluations, dimensions);
  const ids = new Set(evaluations.map((item) => item.candidateId));
  const requiredCandidateIds = identifierSet(data.requiredCandidateIds,
    'plan_required_candidates_invalid');
  const forbiddenCandidateIds = identifierSet(data.forbiddenCandidateIds,
    'plan_forbidden_candidates_invalid');
  if (requiredCandidateIds.some((id) => !ids.has(id))
    || forbiddenCandidateIds.some((id) => !ids.has(id))) {
    failPlanner('plan_required_or_forbidden_candidate_unknown');
  }
  const exactlyOneGroups = normalizeGroups(data.exactlyOneGroups, ids,
    'plan_exactly_one_groups_invalid');
  const atMostOneGroups = normalizeGroups(data.atMostOneGroups, ids,
    'plan_at_most_one_groups_invalid');
  const conflicts = normalizeConflicts(data.conflicts, ids);
  const minimumSelected = plannerInteger(data.minimumSelected, 0,
    evaluations.length, 'plan_minimum_selected_invalid');
  const maximumSelected = plannerInteger(data.maximumSelected, minimumSelected,
    evaluations.length, 'plan_maximum_selected_invalid');
  const body = Object.freeze({
    schemaVersion: 1,
    kind: 'BoundedPlanSelectionProblemV1',
    planId: plannerIdentifier(data.planId, 'plan_id_invalid'),
    candidateCollectionResultHash: plannerHash(
      data.candidateCollectionResultHash, 'plan_candidate_collection_hash_invalid',
    ),
    snapshotCurrentnessReceiptHash: plannerHash(
      data.snapshotCurrentnessReceiptHash, 'plan_snapshot_receipt_hash_invalid',
    ),
    hardConstraintSetHash: plannerHash(data.hardConstraintSetHash,
      'plan_hard_constraints_hash_invalid'),
    objectiveVersion: plannerToken(data.objectiveVersion,
      'plan_objective_version_invalid'),
    resourcePriceSnapshotHash: plannerHash(data.resourcePriceSnapshotHash,
      'plan_resource_price_hash_invalid'),
    evaluationPolicyHash: plannerHash(data.evaluationPolicyHash,
      'plan_evaluation_policy_hash_invalid'),
    selectedAt: plannerTimestamp(data.selectedAt, 'plan_selected_at_invalid'),
    capacities,
    evaluations,
    requiredCandidateIds,
    forbiddenCandidateIds,
    exactlyOneGroups,
    atMostOneGroups,
    conflicts,
    minimumSelected,
    maximumSelected,
    maximumNodeExpansions: plannerInteger(
      data.maximumNodeExpansions, 1, MAX_NODE_EXPANSIONS,
      'plan_node_expansion_limit_invalid',
    ),
  });
  const optimizationProblemHash = hashRecord('BoundedPlanSelectionProblemV1', body);
  if (requireHash && data.optimizationProblemHash !== optimizationProblemHash) {
    failPlanner('plan_selection_problem_hash_invalid');
  }
  return Object.freeze({ ...body, optimizationProblemHash });
}

export function sealBoundedPlanSelectionProblemV1(value) {
  return normalizeProblem(value, false);
}

export function captureBoundedPlanSelectionProblemV1(value) {
  return normalizeProblem(value, true);
}
