import crypto from 'node:crypto';
import { hashActionCandidateV1 } from './candidate-router.mjs';

const HASH = /^sha256:[0-9a-f]{64}$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u;
const API_FIELDS = Object.freeze(['snapshot', 'frontier', 'problem', 'now', 'limits']);
const SNAPSHOT_FIELDS = Object.freeze([
  'schemaVersion', 'kind', 'status', 'repositorySubjectHash', 'revision',
  'writerGeneration', 'readEpoch', 'capturedAt', 'expiresAt', 'policy',
  'projections', 'moduleBindings', 'totalCapturedBytes', 'authority', 'stateSnapshotHash',
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
const PROBLEM_FIELDS = Object.freeze([
  'schemaVersion', 'kind', 'stateSnapshotHash', 'candidateSetHash',
  'hardConstraintSetHash', 'objectiveVersion', 'calibrationPolicyHash',
  'minimumSelected', 'maximumSelected', 'budgets', 'searchNodeBudget', 'candidates',
]);
const ANNOTATION_FIELDS = Object.freeze([
  'schemaVersion', 'kind', 'candidatePayloadHash', 'estimateSubjectHash',
  'utilityMicrounits', 'resources', 'dependencies', 'decisionGroup', 'required',
  'annotationHash',
]);
const ANNOTATION_BODY_FIELDS = Object.freeze(
  ANNOTATION_FIELDS.filter((field) => field !== 'annotationHash'),
);
const RESOURCE_FIELDS = Object.freeze([
  'cpuMicrounits', 'gpuMicrounits', 'memoryMiB', 'storageBytes', 'tokenCount',
  'maximumCostMicrousd',
]);
const LIMIT_FIELDS = Object.freeze([
  'maximumCandidates', 'maximumSearchNodes', 'maximumInputBytes', 'maximumDepth',
  'maximumCollectionItems', 'maximumObjectProperties', 'maximumStringBytes',
]);
const DEFAULT_LIMITS = Object.freeze({
  maximumCandidates: 64,
  maximumSearchNodes: 1_000_000,
  maximumInputBytes: 32 * 1024 * 1024,
  maximumDepth: 32,
  maximumCollectionItems: 65536,
  maximumObjectProperties: 4096,
  maximumStringBytes: 256 * 1024,
});

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
  const result = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[index];
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail(code);
    result.push(descriptor.value);
  }
  return result;
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

function boundedString(value, code, maximumBytes = 4096) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')
    || Buffer.byteLength(value, 'utf8') > maximumBytes) fail(code);
  return value;
}

function sortedUniqueHashes(value, code, maximum) {
  const rows = denseArray(value, code);
  if (rows.length > maximum) fail(code);
  const result = rows.map((row) => exactHash(row, code)).sort(compareUtf8);
  if (result.some((row, index) => index > 0 && row === result[index - 1])) fail(code);
  return Object.freeze(result);
}

function captureLimits(value = {}) {
  const input = ownDataRecord(value, LIMIT_FIELDS, [], 'finite_optimizer_limits_invalid');
  const maxima = {
    maximumCandidates: 256,
    maximumSearchNodes: 10_000_000,
    maximumInputBytes: 128 * 1024 * 1024,
    maximumDepth: 64,
    maximumCollectionItems: 262144,
    maximumObjectProperties: 16384,
    maximumStringBytes: 2 * 1024 * 1024,
  };
  const result = {};
  for (const field of LIMIT_FIELDS) {
    const selected = Object.hasOwn(input, field) ? input[field] : DEFAULT_LIMITS[field];
    if (!Number.isSafeInteger(selected) || selected < 1 || selected > maxima[field]) {
      fail('finite_optimizer_limits_invalid');
    }
    result[field] = selected;
  }
  return Object.freeze(result);
}

function captureJson(value, limits, state, depth = 0) {
  if (depth > limits.maximumDepth) fail('finite_optimizer_depth_limit');
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (Buffer.byteLength(value, 'utf8') > limits.maximumStringBytes) {
      fail('finite_optimizer_string_limit');
    }
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) {
      fail('finite_optimizer_number_invalid');
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== 'object') fail('finite_optimizer_value_invalid');
  if (state.seen.has(value)) fail('finite_optimizer_cycle');
  state.seen.add(value);
  try {
    if (Array.isArray(value)) {
      const rows = denseArray(value, 'finite_optimizer_array_invalid');
      state.items += rows.length;
      if (state.items > limits.maximumCollectionItems) {
        fail('finite_optimizer_collection_limit');
      }
      return Object.freeze(rows.map((row) => captureJson(row, limits, state, depth + 1)));
    }
    if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
      fail('finite_optimizer_record_invalid');
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.length > limits.maximumObjectProperties
      || keys.some((key) => typeof key !== 'string')) fail('finite_optimizer_object_limit');
    const result = {};
    for (const key of keys.sort(compareUtf8)) {
      const descriptor = descriptors[key];
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
        fail('finite_optimizer_accessor_invalid');
      }
      result[key] = captureJson(descriptor.value, limits, state, depth + 1);
    }
    return Object.freeze(result);
  } finally {
    state.seen.delete(value);
  }
}

function canonicalize(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort(compareUtf8)
      .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) fail('finite_optimizer_value_not_json');
  return encoded;
}

function hashDomain(kind, value) {
  return `sha256:${crypto.createHash('sha256')
    .update(Buffer.from(canonicalize({ kind, value }), 'utf8')).digest('hex')}`;
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
  if (!value || typeof value !== 'object'
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(code);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (!keys.length || keys.some((key) => typeof key !== 'string')) fail(code);
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')
      || descriptor.value !== false) fail(code);
  }
  return Object.freeze(Object.fromEntries(keys.sort(compareUtf8).map((key) => [key, false])));
}

function captureSnapshot(raw, limits, now) {
  const input = ownDataRecord(raw, SNAPSHOT_FIELDS, SNAPSHOT_FIELDS,
    'finite_optimizer_snapshot_invalid');
  const { stateSnapshotHash, ...bodyInput } = input;
  const body = captureJson(bodyInput, limits, { seen: new WeakSet(), items: 0 });
  if (body.schemaVersion !== 1 || body.kind !== 'PlanningSnapshotV1'
    || body.status !== 'complete_exact_read_snapshot') fail('finite_optimizer_snapshot_invalid');
  if (stateSnapshotHash !== hashDomain('PlanningSnapshotV1', body)) {
    fail('finite_optimizer_snapshot_hash_invalid');
  }
  const current = strictTimestamp(now, 'finite_optimizer_now_invalid');
  if (current >= strictTimestamp(body.expiresAt, 'finite_optimizer_snapshot_time_invalid')) {
    fail('finite_optimizer_snapshot_stale');
  }
  return Object.freeze({ snapshot: Object.freeze({ ...body, stateSnapshotHash }), current });
}

function captureFrontierCandidate(raw, limits, current) {
  const input = ownDataRecord(raw, CANDIDATE_FIELDS,
    [...CANDIDATE_FIELDS.filter((field) => field !== 'candidatePayloadHash')
      .filter((field) => !['preconditions', 'dependencyEffects', 'irreversibleBoundary',
        'inputSchema', 'outputSchema', 'singletonReason'].includes(field)),
    'candidatePayloadHash'], 'finite_optimizer_frontier_candidate_invalid');
  const { candidatePayloadHash, ...body } = input;
  if (hashActionCandidateV1(body, { limits: {
    maximumCandidates: limits.maximumCandidates,
    maximumTotalBytes: limits.maximumInputBytes,
    maximumCandidateBytes: limits.maximumInputBytes,
    maximumDepth: limits.maximumDepth,
    maximumCollectionItems: limits.maximumCollectionItems,
    maximumObjectProperties: limits.maximumObjectProperties,
    maximumStringBytes: limits.maximumStringBytes,
  } }) !== candidatePayloadHash) fail('finite_optimizer_candidate_hash_invalid');
  if (strictTimestamp(body.expiresAt, 'finite_optimizer_candidate_time_invalid') <= current) {
    fail('finite_optimizer_candidate_stale');
  }
  return Object.freeze({
    candidateId: exactIdentifier(body.candidateId, 'finite_optimizer_candidate_id_invalid'),
    candidatePayloadHash: exactHash(candidatePayloadHash,
      'finite_optimizer_candidate_hash_invalid'),
    resourceVector: captureJson(body.resourceVector, limits, { seen: new WeakSet(), items: 0 }),
  });
}

function captureFrontier(raw, snapshot, limits, current) {
  const input = ownDataRecord(raw, FRONTIER_FIELDS, FRONTIER_FIELDS,
    'finite_optimizer_frontier_invalid');
  if (input.schemaVersion !== 1 || input.kind !== 'CandidateFrontierV1'
    || input.status !== 'complete_deterministic_frontier'
    || input.stateSnapshotHash !== snapshot.stateSnapshotHash
    || input.dominanceReductionApplied !== false) fail('finite_optimizer_frontier_invalid');
  allFalse(input.authority, 'finite_optimizer_frontier_authority_invalid');
  const rows = denseArray(input.candidates, 'finite_optimizer_frontier_candidates_invalid');
  if (!Number.isSafeInteger(input.candidateCount) || input.candidateCount !== rows.length
    || rows.length < 1 || rows.length > limits.maximumCandidates) {
    fail('finite_optimizer_frontier_count_invalid');
  }
  const candidates = rows.map((row) => captureFrontierCandidate(row, limits, current));
  const sorted = [...candidates].sort((left, right) =>
    compareUtf8(left.candidatePayloadHash, right.candidatePayloadHash)
    || compareUtf8(left.candidateId, right.candidateId));
  if (candidates.some((candidate, index) => candidate !== sorted[index])) {
    fail('finite_optimizer_frontier_order_invalid');
  }
  const hashes = Object.freeze(candidates.map((candidate) => candidate.candidatePayloadHash));
  const expectedSetHash = hashDomain('CandidateFrontierV1', Object.freeze({
    planningRequestHash: exactHash(input.planningRequestHash,
      'finite_optimizer_planning_request_hash_invalid'),
    moduleBindingSetHash: exactHash(input.moduleBindingSetHash,
      'finite_optimizer_module_binding_hash_invalid'),
    candidatePayloadHashes: hashes,
  }));
  if (input.candidateSetHash !== expectedSetHash) fail('finite_optimizer_frontier_hash_invalid');
  const byHash = new Map(candidates.map((candidate) => [candidate.candidatePayloadHash, candidate]));
  return Object.freeze({
    candidateSetHash: input.candidateSetHash,
    stateSnapshotHash: input.stateSnapshotHash,
    candidates: Object.freeze(candidates),
    byHash,
  });
}

function captureResources(raw, code) {
  const input = ownDataRecord(raw, RESOURCE_FIELDS, RESOURCE_FIELDS, code);
  return Object.freeze(Object.fromEntries(RESOURCE_FIELDS.map((field) => [field,
    safeInteger(input[field], `${code}:${field}`)])));
}

function normalizeAnnotationBody(raw) {
  const input = ownDataRecord(raw, ANNOTATION_BODY_FIELDS, ANNOTATION_BODY_FIELDS,
    'finite_optimizer_annotation_invalid');
  if (input.schemaVersion !== 1 || input.kind !== 'OptimizationCandidateV1'
    || typeof input.required !== 'boolean') fail('finite_optimizer_annotation_invalid');
  return Object.freeze({
    schemaVersion: 1,
    kind: 'OptimizationCandidateV1',
    candidatePayloadHash: exactHash(input.candidatePayloadHash,
      'finite_optimizer_annotation_candidate_invalid'),
    estimateSubjectHash: exactHash(input.estimateSubjectHash,
      'finite_optimizer_estimate_subject_invalid'),
    utilityMicrounits: safeInteger(input.utilityMicrounits,
      'finite_optimizer_utility_invalid'),
    resources: captureResources(input.resources, 'finite_optimizer_resource_invalid'),
    dependencies: sortedUniqueHashes(input.dependencies,
      'finite_optimizer_dependencies_invalid', 256),
    decisionGroup: input.decisionGroup === null ? null
      : exactIdentifier(input.decisionGroup, 'finite_optimizer_decision_group_invalid'),
    required: input.required,
  });
}

export function hashOptimizationCandidateV1(rawAnnotation) {
  return hashDomain('OptimizationCandidateV1', normalizeAnnotationBody(rawAnnotation));
}

function minimumResources(candidate) {
  const vector = candidate.resourceVector;
  const scaled = (value, field) => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0
      || value > Number.MAX_SAFE_INTEGER / 1_000_000) {
      fail(`finite_optimizer_candidate_resource_unrepresentable:${field}`);
    }
    return Math.ceil(value * 1_000_000);
  };
  return {
    cpuMicrounits: scaled(vector.cpuUnits, 'cpuUnits'),
    gpuMicrounits: scaled(vector.gpuUnits, 'gpuUnits'),
    memoryMiB: safeInteger(vector.memoryMiB,
      'finite_optimizer_candidate_resource_unrepresentable:memoryMiB'),
    storageBytes: safeInteger(vector.storageBytes,
      'finite_optimizer_candidate_resource_unrepresentable:storageBytes'),
    tokenCount: vector.tokenCount === undefined ? 0 : safeInteger(vector.tokenCount,
      'finite_optimizer_candidate_resource_unrepresentable:tokenCount'),
    maximumCostMicrousd: vector.maximumCostMicrousd === undefined ? 0
      : safeInteger(vector.maximumCostMicrousd,
        'finite_optimizer_candidate_resource_unrepresentable:maximumCostMicrousd'),
  };
}

function captureProblem(raw, snapshot, frontier, limits) {
  const input = ownDataRecord(raw, PROBLEM_FIELDS, PROBLEM_FIELDS,
    'finite_optimizer_problem_invalid');
  if (input.schemaVersion !== 1 || input.kind !== 'FiniteOptimizationProblemV1'
    || input.stateSnapshotHash !== snapshot.stateSnapshotHash
    || input.candidateSetHash !== frontier.candidateSetHash
    || input.hardConstraintSetHash !== snapshot.policy.hardConstraintSetHash
    || input.objectiveVersion !== snapshot.policy.objectiveVersion) {
    fail('finite_optimizer_problem_binding_invalid');
  }
  const minimumSelected = safeInteger(input.minimumSelected,
    'finite_optimizer_selection_bounds_invalid', { maximum: frontier.candidates.length });
  const maximumSelected = safeInteger(input.maximumSelected,
    'finite_optimizer_selection_bounds_invalid', { minimum: 1,
      maximum: frontier.candidates.length });
  if (minimumSelected > maximumSelected) fail('finite_optimizer_selection_bounds_invalid');
  const searchNodeBudget = safeInteger(input.searchNodeBudget,
    'finite_optimizer_search_budget_invalid', { minimum: 1,
      maximum: limits.maximumSearchNodes });
  const budgets = captureResources(input.budgets, 'finite_optimizer_budget_invalid');
  const rows = denseArray(input.candidates, 'finite_optimizer_annotations_invalid');
  if (rows.length !== frontier.candidates.length) fail('finite_optimizer_annotation_coverage_invalid');
  const annotations = new Map();
  for (const rawAnnotation of rows) {
    const annotationInput = ownDataRecord(rawAnnotation, ANNOTATION_FIELDS,
      ANNOTATION_FIELDS, 'finite_optimizer_annotation_invalid');
    const { annotationHash, ...bodyInput } = annotationInput;
    const body = normalizeAnnotationBody(bodyInput);
    if (annotationHash !== hashDomain('OptimizationCandidateV1', body)) {
      fail('finite_optimizer_annotation_hash_invalid');
    }
    const candidate = frontier.byHash.get(body.candidatePayloadHash);
    if (!candidate || annotations.has(body.candidatePayloadHash)) {
      fail('finite_optimizer_annotation_coverage_invalid');
    }
    const minimum = minimumResources(candidate);
    for (const field of RESOURCE_FIELDS) {
      if (body.resources[field] < minimum[field]) {
        fail(`finite_optimizer_resource_underdeclared:${field}`);
      }
    }
    annotations.set(body.candidatePayloadHash, Object.freeze({ ...body,
      annotationHash, candidateId: candidate.candidateId }));
  }
  if (annotations.size !== frontier.candidates.length) {
    fail('finite_optimizer_annotation_coverage_invalid');
  }
  for (const annotation of annotations.values()) {
    for (const dependency of annotation.dependencies) {
      if (dependency === annotation.candidatePayloadHash || !annotations.has(dependency)) {
        fail('finite_optimizer_dependency_invalid');
      }
    }
  }
  const orderedAnnotations = Object.freeze([...annotations.values()].sort((left, right) =>
    compareUtf8(left.candidatePayloadHash, right.candidatePayloadHash)));
  const normalized = Object.freeze({
    schemaVersion: 1,
    kind: 'FiniteOptimizationProblemV1',
    stateSnapshotHash: input.stateSnapshotHash,
    candidateSetHash: input.candidateSetHash,
    hardConstraintSetHash: input.hardConstraintSetHash,
    objectiveVersion: exactIdentifier(input.objectiveVersion,
      'finite_optimizer_objective_invalid'),
    calibrationPolicyHash: exactHash(input.calibrationPolicyHash,
      'finite_optimizer_calibration_invalid'),
    minimumSelected,
    maximumSelected,
    budgets,
    searchNodeBudget,
    candidates: orderedAnnotations,
  });
  if (Buffer.byteLength(canonicalize(normalized), 'utf8') > limits.maximumInputBytes) {
    fail('finite_optimizer_input_byte_limit');
  }
  return Object.freeze({ problem: normalized, annotations });
}

function topologicalOrder(annotations) {
  const indegree = new Map();
  const successors = new Map();
  for (const annotation of annotations.values()) {
    indegree.set(annotation.candidatePayloadHash, annotation.dependencies.length);
    successors.set(annotation.candidatePayloadHash, []);
  }
  for (const annotation of annotations.values()) {
    for (const dependency of annotation.dependencies) {
      successors.get(dependency).push(annotation.candidatePayloadHash);
    }
  }
  for (const rows of successors.values()) rows.sort(compareUtf8);
  const ready = [...indegree.entries()].filter(([, count]) => count === 0)
    .map(([hash]) => hash).sort(compareUtf8);
  const result = [];
  while (ready.length) {
    const hash = ready.shift();
    result.push(annotations.get(hash));
    for (const successor of successors.get(hash)) {
      const next = indegree.get(successor) - 1;
      indegree.set(successor, next);
      if (next === 0) {
        ready.push(successor);
        ready.sort(compareUtf8);
      }
    }
  }
  if (result.length !== annotations.size) fail('finite_optimizer_dependency_cycle');
  return Object.freeze(result);
}

function mandatoryClosure(annotations) {
  const mandatory = new Set([...annotations.values()]
    .filter((annotation) => annotation.required)
    .map((annotation) => annotation.candidatePayloadHash));
  const visit = (hash) => {
    for (const dependency of annotations.get(hash).dependencies) {
      if (!mandatory.has(dependency)) {
        mandatory.add(dependency);
        visit(dependency);
      }
    }
  };
  for (const hash of [...mandatory]) visit(hash);
  return mandatory;
}

function emptyResources() {
  return Object.fromEntries(RESOURCE_FIELDS.map((field) => [field, 0]));
}

function addResources(left, right) {
  const result = {};
  for (const field of RESOURCE_FIELDS) {
    if (left[field] > Number.MAX_SAFE_INTEGER - right[field]) return null;
    result[field] = left[field] + right[field];
  }
  return result;
}

function fits(resources, budgets) {
  return RESOURCE_FIELDS.every((field) => resources[field] <= budgets[field]);
}

function lexicographicallyLess(left, right) {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const comparison = compareUtf8(left[index], right[index]);
    if (comparison !== 0) return comparison < 0;
  }
  return left.length < right.length;
}

function optimisticBound(state, ordered, maximumSelected) {
  const slots = maximumSelected - state.selected.length;
  if (slots < 0) return -1;
  const remaining = ordered.slice(state.index).map((annotation) =>
    annotation.utilityMicrounits).sort((left, right) => right - left);
  let bound = state.utility;
  for (const utility of remaining.slice(0, slots)) {
    if (bound > Number.MAX_SAFE_INTEGER - utility) return Number.MAX_SAFE_INTEGER;
    bound += utility;
  }
  return bound;
}

export function optimizeFinitePlan(rawInput) {
  const input = ownDataRecord(rawInput, API_FIELDS,
    ['snapshot', 'frontier', 'problem', 'now'], 'finite_optimizer_request_invalid');
  const limits = captureLimits(Object.hasOwn(input, 'limits') ? input.limits : {});
  const snapshotState = captureSnapshot(input.snapshot, limits, input.now);
  const frontier = captureFrontier(input.frontier, snapshotState.snapshot, limits,
    snapshotState.current);
  const capturedProblem = captureProblem(input.problem, snapshotState.snapshot,
    frontier, limits);
  const { problem, annotations } = capturedProblem;
  const ordered = topologicalOrder(annotations);
  const mandatory = mandatoryClosure(annotations);
  const trace = crypto.createHash('sha256');
  const root = {
    index: 0,
    selected: [],
    selectedSet: new Set(),
    groups: new Set(),
    resources: emptyResources(),
    utility: 0,
  };
  const stack = [root];
  let incumbent = problem.minimumSelected === 0 && mandatory.size === 0
    ? { utility: 0, selected: [], resources: emptyResources() } : null;
  let expanded = 0;
  let pruned = 0;

  while (stack.length && expanded < problem.searchNodeBudget) {
    const state = stack.pop();
    expanded += 1;
    trace.update(canonicalize({ index: state.index, utility: state.utility,
      selected: [...state.selected].sort(compareUtf8), resources: state.resources }));
    const bound = optimisticBound(state, ordered, problem.maximumSelected);
    if (bound < 0 || state.selected.length + (ordered.length - state.index)
      < problem.minimumSelected || (incumbent && bound < incumbent.utility)) {
      pruned += 1;
      continue;
    }
    if (state.index === ordered.length) {
      if (state.selected.length < problem.minimumSelected) continue;
      const selected = [...state.selected].sort(compareUtf8);
      if (!incumbent || state.utility > incumbent.utility
        || (state.utility === incumbent.utility
          && lexicographicallyLess(selected, incumbent.selected))) {
        incumbent = { utility: state.utility, selected,
          resources: { ...state.resources } };
      }
      continue;
    }

    const annotation = ordered[state.index];
    const forced = mandatory.has(annotation.candidatePayloadHash);
    if (!forced) {
      stack.push({ ...state, index: state.index + 1,
        selected: [...state.selected], selectedSet: new Set(state.selectedSet),
        groups: new Set(state.groups), resources: { ...state.resources } });
    }

    const dependenciesSelected = annotation.dependencies.every((dependency) =>
      state.selectedSet.has(dependency));
    const groupFree = annotation.decisionGroup === null
      || !state.groups.has(annotation.decisionGroup);
    const resources = addResources(state.resources, annotation.resources);
    const utilitySafe = state.utility <= Number.MAX_SAFE_INTEGER
      - annotation.utilityMicrounits;
    if (dependenciesSelected && groupFree && resources && fits(resources, problem.budgets)
      && utilitySafe && state.selected.length < problem.maximumSelected) {
      const selectedSet = new Set(state.selectedSet);
      selectedSet.add(annotation.candidatePayloadHash);
      const groups = new Set(state.groups);
      if (annotation.decisionGroup !== null) groups.add(annotation.decisionGroup);
      stack.push({
        index: state.index + 1,
        selected: [...state.selected, annotation.candidatePayloadHash],
        selectedSet,
        groups,
        resources,
        utility: state.utility + annotation.utilityMicrounits,
      });
    }
  }

  let upperBound = incumbent?.utility ?? null;
  if (stack.length) {
    for (const state of stack) {
      const bound = optimisticBound(state, ordered, problem.maximumSelected);
      if (bound >= 0 && (upperBound === null || bound > upperBound)) upperBound = bound;
    }
  }
  let status;
  let optimalityProven = false;
  let infeasibilityProven = false;
  if (!stack.length && incumbent) {
    status = 'optimal_plan_proven';
    optimalityProven = true;
    upperBound = incumbent.utility;
  } else if (!stack.length) {
    status = 'infeasible_plan_proven';
    optimalityProven = true;
    infeasibilityProven = true;
    upperBound = null;
  } else if (incumbent) {
    status = 'bounded_plan_search_incomplete';
  } else {
    status = 'no_feasible_incumbent_yet';
  }

  const selectedCandidatePayloadHashes = Object.freeze(incumbent?.selected || []);
  const selectedCandidateIds = Object.freeze(selectedCandidatePayloadHashes.map((hash) =>
    frontier.byHash.get(hash).candidateId));
  const lowerBound = incumbent?.utility ?? null;
  const gap = lowerBound === null || upperBound === null ? null : upperBound - lowerBound;
  const resultBody = Object.freeze({
    schemaVersion: 1,
    kind: 'FiniteOptimizationResultV1',
    status,
    problemHash: hashDomain('FiniteOptimizationProblemV1', problem),
    stateSnapshotHash: snapshotState.snapshot.stateSnapshotHash,
    candidateSetHash: frontier.candidateSetHash,
    selectedCandidatePayloadHashes,
    selectedCandidateIds,
    selectedResourceUsage: Object.freeze(incumbent?.resources || emptyResources()),
    selectedUtilityMicrounits: lowerBound,
    lowerBoundUtilityMicrounits: lowerBound,
    upperBoundUtilityMicrounits: upperBound,
    optimalityGapMicrounits: gap,
    optimalityProven,
    infeasibilityProven,
    searchNodesExpanded: expanded,
    searchNodesRemaining: stack.length,
    searchNodesPruned: pruned,
    searchTraceHash: `sha256:${trace.digest('hex')}`,
    authority: Object.freeze({
      productionAuthorized: false,
      writerAuthorized: false,
      providerAuthorized: false,
      releaseAuthorized: false,
      submissionAuthorized: false,
    }),
  });
  return Object.freeze({
    ...resultBody,
    resultHash: hashDomain('FiniteOptimizationResultV1', resultBody),
  });
}
