import {
  hashOptimizationCandidateV1,
  optimizeFinitePlan as optimizeFinitePlanInternal,
} from './finite-plan-optimizer.mjs';
import { hashActionCandidateV1 } from './candidate-router.mjs';
import { buildPlanningSnapshot } from './planning-snapshot-builder.mjs';

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
const CANDIDATE_OPTIONAL = new Set([
  'preconditions', 'dependencyEffects', 'irreversibleBoundary', 'inputSchema',
  'outputSchema', 'singletonReason',
]);
const HASH = /^sha256:[0-9a-f]{64}$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u;

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

function canonicalize(value, seen = new WeakSet()) {
  if (Array.isArray(value)) {
    if (seen.has(value)) fail('finite_optimizer_entry_cycle');
    seen.add(value);
    try {
      return `[${denseArray(value, 'finite_optimizer_entry_array_invalid')
        .map((item) => canonicalize(item, seen)).join(',')}]`;
    } finally { seen.delete(value); }
  }
  if (value && typeof value === 'object') {
    if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
      fail('finite_optimizer_entry_record_invalid');
    }
    if (seen.has(value)) fail('finite_optimizer_entry_cycle');
    seen.add(value);
    try {
      const descriptors = Object.getOwnPropertyDescriptors(value);
      const keys = Reflect.ownKeys(descriptors);
      if (keys.some((key) => typeof key !== 'string')) fail('finite_optimizer_entry_record_invalid');
      return `{${keys.sort(compareUtf8).map((key) => {
        const descriptor = descriptors[key];
        if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
          fail('finite_optimizer_entry_accessor_invalid');
        }
        return `${JSON.stringify(key)}:${canonicalize(descriptor.value, seen)}`;
      }).join(',')}}`;
    } finally { seen.delete(value); }
  }
  if (typeof value === 'number' && (!Number.isFinite(value)
    || Math.abs(value) > Number.MAX_SAFE_INTEGER)) fail('finite_optimizer_entry_number_invalid');
  const encoded = JSON.stringify(Object.is(value, -0) ? 0 : value);
  if (encoded === undefined) fail('finite_optimizer_entry_value_invalid');
  return encoded;
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

function identifier(value, code) {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) fail(code);
  return value;
}

function hash(value, code) {
  if (typeof value !== 'string' || !HASH.test(value)) fail(code);
  return value;
}

function candidateRouterLimits(rawLimits) {
  if (rawLimits === undefined) return {};
  const allowed = [
    'maximumCandidates', 'maximumSearchNodes', 'maximumInputBytes', 'maximumDepth',
    'maximumCollectionItems', 'maximumObjectProperties', 'maximumStringBytes',
  ];
  const input = ownDataRecord(rawLimits, allowed, [], 'finite_optimizer_entry_limits_invalid');
  return {
    maximumCandidates: input.maximumCandidates ?? 64,
    maximumTotalBytes: input.maximumInputBytes ?? 32 * 1024 * 1024,
    maximumCandidateBytes: input.maximumInputBytes ?? 32 * 1024 * 1024,
    maximumDepth: input.maximumDepth ?? 32,
    maximumCollectionItems: input.maximumCollectionItems ?? 65536,
    maximumObjectProperties: input.maximumObjectProperties ?? 4096,
    maximumStringBytes: input.maximumStringBytes ?? 256 * 1024,
  };
}

function rebuildSnapshot(raw, now, rawLimits) {
  const input = ownDataRecord(raw, SNAPSHOT_FIELDS, SNAPSHOT_FIELDS,
    'finite_optimizer_entry_snapshot_invalid');
  allFalse(input.authority, 'finite_optimizer_entry_snapshot_authority_invalid');
  const limits = candidateRouterLimits(rawLimits);
  const rebuilt = buildPlanningSnapshot({
    transaction: {
      schemaVersion: 1,
      kind: 'ReadSnapshotTransactionV1',
      repositorySubjectHash: input.repositorySubjectHash,
      revision: input.revision,
      writerGeneration: input.writerGeneration,
      readEpoch: input.readEpoch,
      capturedAt: input.capturedAt,
      expiresAt: input.expiresAt,
    },
    projections: input.projections,
    moduleBindings: input.moduleBindings,
    policy: input.policy,
    now,
    limits: {
      maximumProjections: 4096,
      maximumModules: 4096,
      maximumTotalBytes: limits.maximumTotalBytes,
      maximumProjectionBytes: limits.maximumCandidateBytes,
      maximumDepth: limits.maximumDepth,
      maximumCollectionItems: limits.maximumCollectionItems,
      maximumObjectProperties: limits.maximumObjectProperties,
      maximumStringBytes: limits.maximumStringBytes,
    },
  });
  if (canonicalize(input) !== canonicalize(rebuilt)) {
    fail('finite_optimizer_entry_snapshot_invalid');
  }
  return rebuilt;
}

function validateFrontier(raw, snapshot, rawLimits) {
  const input = ownDataRecord(raw, FRONTIER_FIELDS, FRONTIER_FIELDS,
    'finite_optimizer_entry_frontier_invalid');
  const planningRequestId = identifier(input.planningRequestId,
    'finite_optimizer_entry_request_invalid');
  const capabilityId = identifier(input.capabilityId,
    'finite_optimizer_entry_capability_invalid');
  if (input.schemaVersion !== 1 || input.kind !== 'CandidateFrontierV1'
    || input.status !== 'complete_deterministic_frontier'
    || input.stateSnapshotHash !== snapshot.stateSnapshotHash
    || input.dominanceReductionApplied !== false
    || input.dominanceDisposition
      !== 'retained_without_context_safe_replacement_certificate') {
    fail('finite_optimizer_entry_frontier_invalid');
  }
  allFalse(input.authority, 'finite_optimizer_entry_frontier_authority_invalid');
  hash(input.planningRequestHash, 'finite_optimizer_entry_request_hash_invalid');
  hash(input.moduleBindingSetHash, 'finite_optimizer_entry_module_hash_invalid');
  hash(input.candidateSetHash, 'finite_optimizer_entry_candidate_set_hash_invalid');
  const rows = denseArray(input.candidates, 'finite_optimizer_entry_candidates_invalid');
  if (!Number.isSafeInteger(input.candidateCount) || input.candidateCount !== rows.length
    || rows.length < 1) fail('finite_optimizer_entry_candidate_count_invalid');
  const hashLimits = candidateRouterLimits(rawLimits);
  let selectedBytes = 0;
  for (const rawCandidate of rows) {
    const required = CANDIDATE_FIELDS.filter((field) => field === 'candidatePayloadHash'
      || !CANDIDATE_OPTIONAL.has(field));
    const candidate = ownDataRecord(rawCandidate, CANDIDATE_FIELDS, required,
      'finite_optimizer_entry_candidate_invalid');
    const { candidatePayloadHash, ...body } = candidate;
    if (hashActionCandidateV1(body, { limits: hashLimits }) !== candidatePayloadHash) {
      fail('finite_optimizer_entry_candidate_hash_invalid');
    }
    if (body.planningRequestId !== planningRequestId
      || body.stateSnapshotHash !== snapshot.stateSnapshotHash
      || body.capabilityId !== capabilityId) {
      fail('finite_optimizer_entry_candidate_binding_mismatch');
    }
    selectedBytes += Buffer.byteLength(canonicalize(candidate), 'utf8');
    if (!Number.isSafeInteger(selectedBytes)) fail('finite_optimizer_entry_byte_count_invalid');
  }
  if (!Number.isSafeInteger(input.totalCapturedBytes)
    || input.totalCapturedBytes < selectedBytes) {
    fail('finite_optimizer_entry_byte_count_invalid');
  }
}

export { hashOptimizationCandidateV1 };

export function optimizeFinitePlan(rawInput) {
  const input = ownDataRecord(rawInput, API_FIELDS,
    ['snapshot', 'frontier', 'problem', 'now'], 'finite_optimizer_entry_request_invalid');
  const snapshot = rebuildSnapshot(input.snapshot, input.now, input.limits);
  validateFrontier(input.frontier, snapshot, input.limits);
  return optimizeFinitePlanInternal({
    snapshot,
    frontier: input.frontier,
    problem: input.problem,
    now: input.now,
    ...(Object.hasOwn(input, 'limits') ? { limits: input.limits } : {}),
  });
}
