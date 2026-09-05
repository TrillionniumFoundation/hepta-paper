import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';

const HASH = /^sha256:[0-9a-f]{64}$/u;
const TOKEN = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/u;
const RESOURCE_DIMENSIONS = Object.freeze([
  'cpuUnits', 'gpuUnits', 'memoryMiB', 'storageBytes',
  'tokenCount', 'maximumCostMicrousd',
]);
const INPUT_FIELDS = Object.freeze([
  'version', 'kind', 'requestId', 'planningRequestHash', 'stateSnapshotHash',
  'candidateSetHash', 'objectiveVersion', 'resourceLimits', 'requiredCandidateIds',
  'requiredCapabilities', 'candidates', 'maximumExpansions',
]);
const CANDIDATE_FIELDS = Object.freeze([
  'candidateId', 'candidatePayloadHash', 'utilityMicrounits', 'resourceVector',
  'dependencies', 'conflicts', 'decisionGroup', 'providesCapabilities',
]);
const MAX_CANDIDATES = 256;
const MAX_EXPANSIONS = 1_000_000;
const MAX_SERIALIZED_BYTES = 8 * 1024 * 1024;

function failure(code) {
  return Object.assign(new Error(code), { code, retryable: false });
}

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function plainRecord(value, allowed, code) {
  if (!value || typeof value !== 'object'
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw failure(code);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key !== 'string' || (allowed && !allowed.includes(key)))) {
    throw failure(code);
  }
  const output = Object.create(null);
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw failure(code);
    output[key] = descriptor.value;
  }
  return output;
}

function denseArray(value, maximum, code) {
  if (!Array.isArray(value) || value.length > maximum) throw failure(code);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== value.length + 1) throw failure(code);
  const output = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[index];
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw failure(code);
    output.push(descriptor.value);
  }
  return output;
}

function token(value, code) {
  if (typeof value !== 'string' || !TOKEN.test(value)) throw failure(code);
  return value;
}

function hash(value, code) {
  if (typeof value !== 'string' || !HASH.test(value)) throw failure(code);
  return value;
}

function safeInteger(value, minimum, maximum, code) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw failure(code);
  return value;
}

function stringSet(value, maximum, code) {
  const rows = denseArray(value, maximum, code).map((entry) => token(entry, code));
  rows.sort(compareUtf8);
  if (new Set(rows).size !== rows.length) throw failure(code);
  return Object.freeze(rows);
}

function resourceVector(value, code) {
  const row = plainRecord(value, RESOURCE_DIMENSIONS, code);
  if (Object.keys(row).length !== RESOURCE_DIMENSIONS.length) throw failure(code);
  const output = Object.create(null);
  for (const dimension of RESOURCE_DIMENSIONS) {
    if (!Object.hasOwn(row, dimension)) throw failure(code);
    output[dimension] = safeInteger(row[dimension], 0, Number.MAX_SAFE_INTEGER, code);
  }
  return Object.freeze(output);
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object') {
    const output = Object.create(null);
    for (const key of Object.keys(value).sort(compareUtf8)) output[key] = canonicalValue(value[key]);
    return output;
  }
  return value;
}

function canonicalBytes(value) {
  return Buffer.from(JSON.stringify(canonicalValue(value)), 'utf8');
}

function canonicalHash(kind, value) {
  return `sha256:${createHash('sha256').update(canonicalBytes({ kind, value })).digest('hex')}`;
}

function decimal(value) {
  return value.toString(10);
}

function compareIdLists(left, right) {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const order = compareUtf8(left[index], right[index]);
    if (order !== 0) return order;
  }
  return left.length - right.length;
}

function normalizeRequest(input) {
  const raw = plainRecord(input, INPUT_FIELDS, 'optimizer_request_invalid');
  if (Object.keys(raw).length !== INPUT_FIELDS.length
    || raw.version !== 1 || raw.kind !== 'BoundedPlanOptimizationRequestV1') {
    throw failure('optimizer_request_invalid');
  }
  const maximumExpansions = safeInteger(raw.maximumExpansions, 1, MAX_EXPANSIONS,
    'optimizer_expansion_budget_invalid');
  const requiredCandidateIds = stringSet(raw.requiredCandidateIds, MAX_CANDIDATES,
    'optimizer_required_candidates_invalid');
  const requiredCapabilities = stringSet(raw.requiredCapabilities, MAX_CANDIDATES * 4,
    'optimizer_required_capabilities_invalid');
  const candidatesRaw = denseArray(raw.candidates, MAX_CANDIDATES, 'optimizer_candidates_invalid');
  if (!candidatesRaw.length) throw failure('optimizer_candidates_invalid');
  const candidates = candidatesRaw.map((value) => {
    const row = plainRecord(value, CANDIDATE_FIELDS, 'optimizer_candidate_invalid');
    if (Object.keys(row).length !== CANDIDATE_FIELDS.length) throw failure('optimizer_candidate_invalid');
    const utilityMicrounits = safeInteger(row.utilityMicrounits,
      -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, 'optimizer_candidate_utility_invalid');
    return Object.freeze({
      candidateId: token(row.candidateId, 'optimizer_candidate_id_invalid'),
      candidatePayloadHash: hash(row.candidatePayloadHash, 'optimizer_candidate_hash_invalid'),
      utilityMicrounits,
      resourceVector: resourceVector(row.resourceVector, 'optimizer_candidate_resources_invalid'),
      dependencies: stringSet(row.dependencies, MAX_CANDIDATES, 'optimizer_candidate_dependencies_invalid'),
      conflicts: stringSet(row.conflicts, MAX_CANDIDATES, 'optimizer_candidate_conflicts_invalid'),
      decisionGroup: row.decisionGroup === null ? null
        : token(row.decisionGroup, 'optimizer_candidate_group_invalid'),
      providesCapabilities: stringSet(row.providesCapabilities, MAX_CANDIDATES * 4,
        'optimizer_candidate_capabilities_invalid'),
    });
  }).sort((left, right) => compareUtf8(left.candidateId, right.candidateId));
  if (new Set(candidates.map((row) => row.candidateId)).size !== candidates.length) {
    throw failure('optimizer_candidate_id_duplicate');
  }
  if (new Set(candidates.map((row) => row.candidatePayloadHash)).size !== candidates.length) {
    throw failure('optimizer_candidate_payload_hash_duplicate');
  }
  const byId = new Map(candidates.map((row, index) => [row.candidateId, { row, index }]));
  for (const id of requiredCandidateIds) if (!byId.has(id)) throw failure('optimizer_required_candidate_unknown');
  for (const candidate of candidates) {
    for (const dependency of candidate.dependencies) {
      if (dependency === candidate.candidateId || !byId.has(dependency)) {
        throw failure('optimizer_candidate_dependency_invalid');
      }
    }
    for (const conflict of candidate.conflicts) {
      if (conflict === candidate.candidateId || !byId.has(conflict)) {
        throw failure('optimizer_candidate_conflict_invalid');
      }
      if (!byId.get(conflict).row.conflicts.includes(candidate.candidateId)) {
        throw failure('optimizer_candidate_conflict_asymmetric');
      }
    }
  }
  const visiting = new Set();
  const visited = new Set();
  function visit(id) {
    if (visiting.has(id)) throw failure('optimizer_dependency_cycle');
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id).row.dependencies) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  }
  for (const candidate of candidates) visit(candidate.candidateId);
  const body = Object.freeze({
    version: 1,
    kind: raw.kind,
    requestId: token(raw.requestId, 'optimizer_request_id_invalid'),
    planningRequestHash: hash(raw.planningRequestHash, 'optimizer_planning_request_hash_invalid'),
    stateSnapshotHash: hash(raw.stateSnapshotHash, 'optimizer_snapshot_hash_invalid'),
    candidateSetHash: hash(raw.candidateSetHash, 'optimizer_candidate_set_hash_invalid'),
    objectiveVersion: token(raw.objectiveVersion, 'optimizer_objective_version_invalid'),
    resourceLimits: resourceVector(raw.resourceLimits, 'optimizer_resource_limits_invalid'),
    requiredCandidateIds,
    requiredCapabilities,
    candidates: Object.freeze(candidates),
    maximumExpansions,
  });
  if (canonicalBytes(body).length > MAX_SERIALIZED_BYTES) throw failure('optimizer_request_byte_limit');
  return Object.freeze({ body, byId,
    requestHash: canonicalHash('BoundedPlanOptimizationRequestV1', body) });
}

function zeroResources() {
  return RESOURCE_DIMENSIONS.map(() => 0n);
}

function cloneState(state) {
  return {
    selected: new Set(state.selected),
    excluded: new Set(state.excluded),
    used: state.used.slice(),
    utility: state.utility,
    groups: new Map(state.groups),
    capabilities: new Set(state.capabilities),
  };
}

function stateKey(state, candidates) {
  const selected = candidates.filter((candidate) => state.selected.has(candidate.candidateId))
    .map((candidate) => candidate.candidateId);
  const excluded = candidates.filter((candidate) => state.excluded.has(candidate.candidateId))
    .map((candidate) => candidate.candidateId);
  return `S:${selected.join(',')}|X:${excluded.join(',')}`;
}

function upperBound(state, candidates) {
  let result = state.utility;
  for (const candidate of candidates) {
    if (!state.selected.has(candidate.candidateId)
      && !state.excluded.has(candidate.candidateId)
      && candidate.utilityMicrounits > 0) {
      result += BigInt(candidate.utilityMicrounits);
    }
  }
  return result;
}

function includeCandidate(state, id, normalized, stack = new Set()) {
  if (state.selected.has(id)) return true;
  if (state.excluded.has(id) || stack.has(id)) return false;
  stack.add(id);
  const { row: candidate } = normalized.byId.get(id);
  for (const dependency of candidate.dependencies) {
    if (!includeCandidate(state, dependency, normalized, stack)) return false;
  }
  for (const conflict of candidate.conflicts) if (state.selected.has(conflict)) return false;
  if (candidate.decisionGroup !== null) {
    const existing = state.groups.get(candidate.decisionGroup);
    if (existing !== undefined && existing !== id) return false;
  }
  for (let index = 0; index < RESOURCE_DIMENSIONS.length; index += 1) {
    const dimension = RESOURCE_DIMENSIONS[index];
    const next = state.used[index] + BigInt(candidate.resourceVector[dimension]);
    if (next > BigInt(normalized.body.resourceLimits[dimension])) return false;
  }
  state.selected.add(id);
  state.utility += BigInt(candidate.utilityMicrounits);
  if (candidate.decisionGroup !== null) state.groups.set(candidate.decisionGroup, id);
  for (let index = 0; index < RESOURCE_DIMENSIONS.length; index += 1) {
    state.used[index] += BigInt(candidate.resourceVector[RESOURCE_DIMENSIONS[index]]);
  }
  for (const capability of candidate.providesCapabilities) state.capabilities.add(capability);
  stack.delete(id);
  return true;
}

function coversRequired(state, request) {
  return request.requiredCapabilities.every((capability) => state.capabilities.has(capability));
}

function planFromState(state, normalized) {
  const selectedCandidateIds = [...state.selected].sort(compareUtf8);
  const usedResources = Object.freeze(Object.fromEntries(RESOURCE_DIMENSIONS.map(
    (dimension, index) => [dimension, decimal(state.used[index])],
  )));
  return Object.freeze({ selectedCandidateIds: Object.freeze(selectedCandidateIds),
    objectiveMicrounits: decimal(state.utility), usedResources });
}

function betterPlan(candidate, incumbent) {
  if (incumbent === null) return true;
  const left = BigInt(candidate.objectiveMicrounits);
  const right = BigInt(incumbent.objectiveMicrounits);
  if (left !== right) return left > right;
  return compareIdLists(candidate.selectedCandidateIds, incumbent.selectedCandidateIds) < 0;
}

function queueOrder(left, right) {
  if (left.upper !== right.upper) return left.upper > right.upper ? -1 : 1;
  return compareUtf8(left.key, right.key);
}

export function evaluateSelectedPlan(input, selectedCandidateIds) {
  const normalized = normalizeRequest(input);
  const ids = stringSet(selectedCandidateIds, MAX_CANDIDATES, 'optimizer_selected_candidates_invalid');
  const state = { selected: new Set(), excluded: new Set(), used: zeroResources(), utility: 0n,
    groups: new Map(), capabilities: new Set() };
  for (const id of ids) {
    if (!normalized.byId.has(id)) throw failure('optimizer_selected_candidate_unknown');
  }
  for (const id of ids) {
    const candidate = normalized.byId.get(id).row;
    if (candidate.dependencies.some((dependency) => !ids.includes(dependency))) {
      throw failure('optimizer_selected_dependencies_missing');
    }
  }
  for (const id of ids) if (!includeCandidate(state, id, normalized)) {
    throw failure('optimizer_selected_plan_infeasible');
  }
  if (normalized.body.requiredCandidateIds.some((id) => !state.selected.has(id))
    || !coversRequired(state, normalized.body)) {
    throw failure('optimizer_selected_requirements_missing');
  }
  return Object.freeze({ feasible: true, ...planFromState(state, normalized),
    authority: Object.freeze({ productionAuthorized: false, writerAuthorized: false,
      providerAuthorized: false, externalAuthorityClaimed: false }),
    externalActionPerformed: false });
}

export function optimizeBoundedPlan(input) {
  const normalized = normalizeRequest(input);
  const root = { selected: new Set(), excluded: new Set(), used: zeroResources(), utility: 0n,
    groups: new Map(), capabilities: new Set() };
  let rootFeasible = true;
  for (const id of normalized.body.requiredCandidateIds) {
    if (!includeCandidate(root, id, normalized)) { rootFeasible = false; break; }
  }
  let incumbent = null;
  let generatedStates = 0;
  let expansions = 0;
  let prunedStates = 0;
  const queue = [];
  if (rootFeasible) {
    queue.push({ state: root, upper: upperBound(root, normalized.body.candidates),
      key: stateKey(root, normalized.body.candidates) });
    generatedStates = 1;
  }
  while (queue.length && expansions < normalized.body.maximumExpansions) {
    queue.sort(queueOrder);
    const current = queue.shift();
    if (incumbent !== null && current.upper < BigInt(incumbent.objectiveMicrounits)) {
      prunedStates += 1;
      continue;
    }
    expansions += 1;
    const undecided = normalized.body.candidates.find((candidate) =>
      !current.state.selected.has(candidate.candidateId)
      && !current.state.excluded.has(candidate.candidateId));
    if (!undecided) {
      if (coversRequired(current.state, normalized.body)) {
        const plan = planFromState(current.state, normalized);
        if (betterPlan(plan, incumbent)) incumbent = plan;
      }
      continue;
    }
    const included = cloneState(current.state);
    if (includeCandidate(included, undecided.candidateId, normalized)) {
      const upper = upperBound(included, normalized.body.candidates);
      if (incumbent === null || upper >= BigInt(incumbent.objectiveMicrounits)) {
        queue.push({ state: included, upper, key: stateKey(included, normalized.body.candidates) });
        generatedStates += 1;
      } else prunedStates += 1;
    } else prunedStates += 1;
    const excluded = cloneState(current.state);
    excluded.excluded.add(undecided.candidateId);
    const upper = upperBound(excluded, normalized.body.candidates);
    if (incumbent === null || upper >= BigInt(incumbent.objectiveMicrounits)) {
      queue.push({ state: excluded, upper, key: stateKey(excluded, normalized.body.candidates) });
      generatedStates += 1;
    } else prunedStates += 1;
  }
  queue.sort(queueOrder);
  const pendingUpper = queue.length ? queue[0].upper : null;
  const lower = incumbent === null ? null : BigInt(incumbent.objectiveMicrounits);
  const upper = pendingUpper === null ? lower
    : lower === null || pendingUpper > lower ? pendingUpper : lower;
  const complete = queue.length === 0;
  let status;
  if (incumbent === null) status = complete ? 'infeasible' : 'no_incumbent';
  else status = complete ? 'optimal' : 'bounded_gap';
  const proof = Object.freeze({
    method: 'deterministic_best_bound_branch_and_bound_v1',
    complete,
    objectiveOptimal: incumbent !== null && upper === lower,
    tieBreakComplete: complete,
    maximumExpansions: normalized.body.maximumExpansions,
    expansions,
    generatedStates,
    prunedStates,
    lowerBoundMicrounits: lower === null ? null : decimal(lower),
    upperBoundMicrounits: upper === null ? null : decimal(upper),
    absoluteGapMicrounits: lower === null || upper === null ? null : decimal(upper - lower),
    upperBoundRule: 'current_utility_plus_all_positive_undecided_utility',
  });
  const body = Object.freeze({ version: 1, kind: 'BoundedPlanOptimizationResultV1', status,
    requestId: normalized.body.requestId, optimizationRequestHash: normalized.requestHash,
    planningRequestHash: normalized.body.planningRequestHash,
    stateSnapshotHash: normalized.body.stateSnapshotHash,
    candidateSetHash: normalized.body.candidateSetHash,
    objectiveVersion: normalized.body.objectiveVersion,
    selectedPlan: incumbent,
    proof,
    authority: Object.freeze({ productionAuthorized: false, writerAuthorized: false,
      providerAuthorized: false, externalAuthorityClaimed: false }),
    externalActionPerformed: false });
  return Object.freeze({ ...body, optimizationResultHash:
    canonicalHash('BoundedPlanOptimizationResultV1', body) });
}
