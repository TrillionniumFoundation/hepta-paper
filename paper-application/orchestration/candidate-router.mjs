import crypto from 'node:crypto';

const HASH = /^sha256:[0-9a-f]{64}$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u;
const CANDIDATE_FIELDS = Object.freeze([
  'schemaVersion', 'kind', 'candidateId', 'planningRequestId', 'stateSnapshotHash',
  'moduleId', 'moduleVersion', 'capabilityId', 'resourceVector', 'duration', 'cost',
  'value', 'risk', 'preconditions', 'dependencyEffects', 'sideEffectClass',
  'irreversibleBoundary', 'rollbackClass', 'expiresAt', 'inputSchema', 'outputSchema',
  'candidatePayloadHash', 'singletonReason',
]);
const CANDIDATE_REQUIRED = Object.freeze([
  'schemaVersion', 'kind', 'candidateId', 'planningRequestId', 'stateSnapshotHash',
  'moduleId', 'moduleVersion', 'capabilityId', 'resourceVector', 'duration', 'cost',
  'value', 'risk', 'sideEffectClass', 'rollbackClass', 'expiresAt',
]);
const REQUEST_FIELDS = Object.freeze([
  'schemaVersion', 'kind', 'planningRequestId', 'stateSnapshotHash', 'capabilityId',
  'hardConstraintSetHash', 'objectiveVersion', 'resourcePriceSnapshotHash',
  'candidateLimit', 'createdAt', 'expiresAt', 'allowedSideEffectClasses',
  'inputArtifactHashes',
]);
const REQUEST_REQUIRED = Object.freeze(REQUEST_FIELDS.slice(0, 12));
const MODULE_FIELDS = Object.freeze([
  'moduleId', 'moduleVersion', 'capabilityIds', 'qualificationSubjectHash',
]);
const RESOURCE_FIELDS = Object.freeze([
  'cpuUnits', 'gpuUnits', 'memoryMiB', 'storageBytes', 'tokenCount', 'maximumCostMicrousd',
]);
const REQUIRED_RESOURCE_FIELDS = Object.freeze([
  'cpuUnits', 'gpuUnits', 'memoryMiB', 'storageBytes',
]);
const API_FIELDS = Object.freeze([
  'planningRequest', 'candidates', 'qualifiedModules', 'now', 'limits',
]);
const LIMIT_FIELDS = Object.freeze([
  'maximumCandidates', 'maximumTotalBytes', 'maximumCandidateBytes', 'maximumDepth',
  'maximumCollectionItems', 'maximumObjectProperties', 'maximumStringBytes',
]);
const DEFAULT_LIMITS = Object.freeze({
  maximumCandidates: 1024,
  maximumTotalBytes: 8 * 1024 * 1024,
  maximumCandidateBytes: 256 * 1024,
  maximumDepth: 16,
  maximumCollectionItems: 4096,
  maximumObjectProperties: 256,
  maximumStringBytes: 64 * 1024,
});
const SINGLETON_REASONS = Object.freeze([
  'only_feasible_candidate', 'protocol_does_not_support_alternatives',
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
  const result = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[index];
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail(code);
    result.push(descriptor.value);
  }
  return result;
}

function boundedString(value, code, maximumBytes = DEFAULT_LIMITS.maximumStringBytes) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')
    || Buffer.byteLength(value, 'utf8') > maximumBytes) fail(code);
  return value;
}

function exactIdentifier(value, code) {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) fail(code);
  return value;
}

function exactHash(value, code) {
  if (typeof value !== 'string' || !HASH.test(value)) fail(code);
  return value;
}

function sortedUniqueStrings(value, code, { maximum = 256, minimum = 0, hashes = false } = {}) {
  const input = denseArray(value, code);
  if (input.length < minimum || input.length > maximum) fail(code);
  const result = input.map((item) => hashes
    ? exactHash(item, code) : boundedString(item, code, 4096));
  result.sort(compareUtf8);
  if (result.some((item, index) => index > 0 && item === result[index - 1])) fail(code);
  return Object.freeze(result);
}

function captureLimits(value = {}) {
  const input = ownDataRecord(value, LIMIT_FIELDS, [], 'candidate_router_limits_invalid');
  const limits = {};
  const maxima = {
    maximumCandidates: 4096,
    maximumTotalBytes: 64 * 1024 * 1024,
    maximumCandidateBytes: 8 * 1024 * 1024,
    maximumDepth: 64,
    maximumCollectionItems: 65536,
    maximumObjectProperties: 4096,
    maximumStringBytes: 1024 * 1024,
  };
  for (const field of LIMIT_FIELDS) {
    const selected = Object.hasOwn(input, field) ? input[field] : DEFAULT_LIMITS[field];
    if (!Number.isSafeInteger(selected) || selected < 1 || selected > maxima[field]) {
      fail('candidate_router_limits_invalid');
    }
    limits[field] = selected;
  }
  if (limits.maximumCandidateBytes > limits.maximumTotalBytes) {
    fail('candidate_router_limits_invalid');
  }
  return Object.freeze(limits);
}

function captureJson(value, limits, state, depth = 0) {
  if (depth > limits.maximumDepth) fail('candidate_value_depth_limit');
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (Buffer.byteLength(value, 'utf8') > limits.maximumStringBytes) {
      fail('candidate_value_string_limit');
    }
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) {
      fail('candidate_value_number_invalid');
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== 'object') fail('candidate_value_type_invalid');
  if (state.seen.has(value)) fail('candidate_value_cycle');
  state.seen.add(value);
  try {
    if (Array.isArray(value)) {
      const input = denseArray(value, 'candidate_value_array_invalid');
      state.items += input.length;
      if (state.items > limits.maximumCollectionItems) fail('candidate_value_collection_limit');
      return Object.freeze(input.map((item) => captureJson(item, limits, state, depth + 1)));
    }
    if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
      fail('candidate_value_record_invalid');
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.length > limits.maximumObjectProperties
      || keys.some((key) => typeof key !== 'string')) fail('candidate_value_object_limit');
    const output = {};
    for (const key of keys.sort(compareUtf8)) {
      const descriptor = descriptors[key];
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
        fail('candidate_value_accessor_invalid');
      }
      if (Buffer.byteLength(key, 'utf8') > 1024) fail('candidate_value_key_limit');
      output[key] = captureJson(descriptor.value, limits, state, depth + 1);
    }
    return Object.freeze(output);
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
  const result = JSON.stringify(value);
  if (result === undefined) fail('candidate_value_not_json');
  return result;
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
  const fraction = (match[7] || '').padEnd(9, '0');
  const offsetHour = match[8] === 'Z' ? 0 : Number(match[10]);
  const offsetMinute = match[8] === 'Z' ? 0 : Number(match[11]);
  if (year < 1970 || year > 9999 || month < 1 || month > 12 || hour > 23
    || minute > 59 || second > 59 || offsetHour > 23 || offsetMinute > 59) fail(code);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthDays = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (day < 1 || day > monthDays[month - 1]) fail(code);
  const milliseconds = Date.UTC(year, month - 1, day, hour, minute, second, 0);
  const offset = match[8] === 'Z' ? 0
    : (match[9] === '+' ? 1 : -1) * (offsetHour * 60 + offsetMinute) * 60 * 1000;
  return BigInt(milliseconds - offset) * 1_000_000n + BigInt(fraction || '0');
}

function capturePlanningRequest(raw, limits, now) {
  const input = ownDataRecord(raw, REQUEST_FIELDS, REQUEST_REQUIRED, 'planning_request_invalid');
  if (input.schemaVersion !== 1 || input.kind !== 'PlanningRequestV1') {
    fail('planning_request_invalid');
  }
  const created = strictTimestamp(input.createdAt, 'planning_request_time_invalid');
  const expires = strictTimestamp(input.expiresAt, 'planning_request_time_invalid');
  const current = strictTimestamp(now, 'candidate_router_now_invalid');
  if (created > current || current >= expires) fail('planning_request_not_current');
  if (!Number.isSafeInteger(input.candidateLimit) || input.candidateLimit < 1
    || input.candidateLimit > limits.maximumCandidates) {
    fail('planning_request_candidate_limit_invalid');
  }
  const request = Object.freeze({
    schemaVersion: 1,
    kind: 'PlanningRequestV1',
    planningRequestId: exactIdentifier(input.planningRequestId, 'planning_request_id_invalid'),
    stateSnapshotHash: exactHash(input.stateSnapshotHash, 'planning_request_snapshot_invalid'),
    capabilityId: exactIdentifier(input.capabilityId, 'planning_request_capability_invalid'),
    hardConstraintSetHash: exactHash(input.hardConstraintSetHash,
      'planning_request_constraints_invalid'),
    objectiveVersion: exactIdentifier(input.objectiveVersion,
      'planning_request_objective_invalid'),
    resourcePriceSnapshotHash: exactHash(input.resourcePriceSnapshotHash,
      'planning_request_prices_invalid'),
    candidateLimit: input.candidateLimit,
    createdAt: input.createdAt,
    expiresAt: input.expiresAt,
    allowedSideEffectClasses: sortedUniqueStrings(input.allowedSideEffectClasses,
      'planning_request_side_effects_invalid', { minimum: 1, maximum: 64 }),
    ...(Object.hasOwn(input, 'inputArtifactHashes')
      ? { inputArtifactHashes: sortedUniqueStrings(input.inputArtifactHashes,
        'planning_request_artifacts_invalid', { maximum: 1024, hashes: true }) } : {}),
  });
  return Object.freeze({
    request,
    current,
    expires,
    requestHash: hashDomain('PlanningRequestV1', request),
  });
}

function captureModuleBindings(raw) {
  const rows = denseArray(raw, 'candidate_module_bindings_invalid');
  if (rows.length < 1 || rows.length > 1024) fail('candidate_module_bindings_invalid');
  const map = new Map();
  const list = [];
  for (const row of rows) {
    const input = ownDataRecord(row, MODULE_FIELDS, MODULE_FIELDS,
      'candidate_module_binding_invalid');
    const moduleId = exactIdentifier(input.moduleId, 'candidate_module_binding_invalid');
    const moduleVersion = exactIdentifier(input.moduleVersion, 'candidate_module_binding_invalid');
    const key = `${moduleId}\0${moduleVersion}`;
    if (map.has(key)) fail('candidate_module_binding_duplicate');
    const binding = Object.freeze({
      moduleId,
      moduleVersion,
      capabilityIds: sortedUniqueStrings(input.capabilityIds,
        'candidate_module_capabilities_invalid', { minimum: 1, maximum: 256 }),
      qualificationSubjectHash: exactHash(input.qualificationSubjectHash,
        'candidate_module_qualification_invalid'),
    });
    map.set(key, binding);
    list.push(binding);
  }
  list.sort((left, right) => compareUtf8(left.moduleId, right.moduleId)
    || compareUtf8(left.moduleVersion, right.moduleVersion));
  const frozen = Object.freeze(list);
  return Object.freeze({
    map,
    list: frozen,
    moduleBindingSetHash: hashDomain('CandidateRouterModuleBindingSetV1', frozen),
  });
}

function captureResourceVector(raw) {
  const input = ownDataRecord(raw, RESOURCE_FIELDS, REQUIRED_RESOURCE_FIELDS,
    'candidate_resource_vector_invalid');
  const vector = {};
  for (const field of RESOURCE_FIELDS) {
    if (!Object.hasOwn(input, field)) continue;
    const value = input[field];
    const requiresInteger = !['cpuUnits', 'gpuUnits'].includes(field);
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0
      || value > Number.MAX_SAFE_INTEGER
      || (requiresInteger && !Number.isSafeInteger(value))) {
      fail(`candidate_resource_value_invalid:${field}`);
    }
    vector[field] = Object.is(value, -0) ? 0 : value;
  }
  return Object.freeze(vector);
}

function normalizeCandidateBody(raw, limits) {
  const allowed = CANDIDATE_FIELDS.filter((field) => field !== 'candidatePayloadHash');
  const input = ownDataRecord(raw, allowed, CANDIDATE_REQUIRED, 'action_candidate_invalid');
  if (input.schemaVersion !== 1 || input.kind !== 'ActionCandidateV1') {
    fail('action_candidate_invalid');
  }
  const state = { seen: new WeakSet(), items: 0 };
  return Object.freeze({
    schemaVersion: 1,
    kind: 'ActionCandidateV1',
    candidateId: exactIdentifier(input.candidateId, 'candidate_id_invalid'),
    planningRequestId: exactIdentifier(input.planningRequestId,
      'candidate_planning_request_invalid'),
    stateSnapshotHash: exactHash(input.stateSnapshotHash, 'candidate_snapshot_invalid'),
    moduleId: exactIdentifier(input.moduleId, 'candidate_module_invalid'),
    moduleVersion: exactIdentifier(input.moduleVersion, 'candidate_module_invalid'),
    capabilityId: exactIdentifier(input.capabilityId, 'candidate_capability_invalid'),
    resourceVector: captureResourceVector(input.resourceVector),
    duration: captureJson(input.duration, limits, state),
    cost: captureJson(input.cost, limits, state),
    value: captureJson(input.value, limits, state),
    risk: captureJson(input.risk, limits, state),
    ...(Object.hasOwn(input, 'preconditions')
      ? { preconditions: sortedUniqueStrings(input.preconditions,
        'candidate_preconditions_invalid', { maximum: 1024 }) } : {}),
    ...(Object.hasOwn(input, 'dependencyEffects')
      ? { dependencyEffects: sortedUniqueStrings(input.dependencyEffects,
        'candidate_dependency_effects_invalid', { maximum: 1024 }) } : {}),
    sideEffectClass: boundedString(input.sideEffectClass,
      'candidate_side_effect_invalid', 256),
    ...(Object.hasOwn(input, 'irreversibleBoundary')
      ? { irreversibleBoundary: input.irreversibleBoundary === null ? null
        : boundedString(input.irreversibleBoundary,
          'candidate_irreversible_boundary_invalid') } : {}),
    rollbackClass: boundedString(input.rollbackClass, 'candidate_rollback_invalid', 256),
    expiresAt: (() => {
      strictTimestamp(input.expiresAt, 'candidate_expiry_invalid');
      return input.expiresAt;
    })(),
    ...(Object.hasOwn(input, 'inputSchema')
      ? { inputSchema: input.inputSchema === null ? null
        : boundedString(input.inputSchema, 'candidate_input_schema_invalid') } : {}),
    ...(Object.hasOwn(input, 'outputSchema')
      ? { outputSchema: input.outputSchema === null ? null
        : boundedString(input.outputSchema, 'candidate_output_schema_invalid') } : {}),
    ...(Object.hasOwn(input, 'singletonReason')
      ? { singletonReason: input.singletonReason === null ? null
        : boundedString(input.singletonReason, 'candidate_singleton_reason_invalid', 256) } : {}),
  });
}

function captureCandidate(raw, requestState, modules, limits) {
  const input = ownDataRecord(raw, CANDIDATE_FIELDS,
    [...CANDIDATE_REQUIRED, 'candidatePayloadHash'], 'action_candidate_invalid');
  const { candidatePayloadHash, ...bodyInput } = input;
  const body = normalizeCandidateBody(bodyInput, limits);
  const expectedHash = hashDomain('ActionCandidateV1', body);
  if (candidatePayloadHash !== expectedHash) fail('candidate_payload_hash_invalid');
  if (body.planningRequestId !== requestState.request.planningRequestId
    || body.stateSnapshotHash !== requestState.request.stateSnapshotHash
    || body.capabilityId !== requestState.request.capabilityId) {
    fail('candidate_request_binding_mismatch');
  }
  const module = modules.map.get(`${body.moduleId}\0${body.moduleVersion}`);
  if (!module || !module.capabilityIds.includes(body.capabilityId)) {
    fail('candidate_module_binding_mismatch');
  }
  const expires = strictTimestamp(body.expiresAt, 'candidate_expiry_invalid');
  if (expires <= requestState.current || expires > requestState.expires) {
    fail('candidate_not_current');
  }
  if (!requestState.request.allowedSideEffectClasses.includes(body.sideEffectClass)) {
    fail('candidate_side_effect_forbidden');
  }
  const candidate = Object.freeze({ ...body, candidatePayloadHash: expectedHash });
  const canonical = canonicalize(candidate);
  const bytes = Buffer.byteLength(canonical, 'utf8');
  if (bytes > limits.maximumCandidateBytes) fail('candidate_byte_limit');
  return Object.freeze({ candidate, canonical, bytes });
}

export function hashActionCandidateV1(rawCandidate, options = {}) {
  const optionInput = ownDataRecord(options, ['limits'], [], 'candidate_hash_options_invalid');
  const limits = captureLimits(Object.hasOwn(optionInput, 'limits') ? optionInput.limits : {});
  return hashDomain('ActionCandidateV1', normalizeCandidateBody(rawCandidate, limits));
}

export function routeActionCandidates(rawInput) {
  const input = ownDataRecord(rawInput, API_FIELDS,
    ['planningRequest', 'candidates', 'qualifiedModules', 'now'],
    'candidate_router_request_invalid');
  const limits = captureLimits(Object.hasOwn(input, 'limits') ? input.limits : {});
  const requestState = capturePlanningRequest(input.planningRequest, limits, input.now);
  const modules = captureModuleBindings(input.qualifiedModules);
  const rows = denseArray(input.candidates, 'candidate_collection_invalid');
  if (rows.length < 1 || rows.length > requestState.request.candidateLimit
    || rows.length > limits.maximumCandidates) fail('candidate_count_limit');

  const byId = new Map();
  const byHash = new Map();
  const selected = [];
  let totalBytes = 0;
  for (const rawCandidate of rows) {
    const captured = captureCandidate(rawCandidate, requestState, modules, limits);
    totalBytes += captured.bytes;
    if (totalBytes > limits.maximumTotalBytes) fail('candidate_total_byte_limit');
    const priorId = byId.get(captured.candidate.candidateId);
    if (priorId && priorId.canonical !== captured.canonical) fail('candidate_id_conflict');
    const priorHash = byHash.get(captured.candidate.candidatePayloadHash);
    if (priorHash && priorHash.canonical !== captured.canonical) fail('candidate_hash_conflict');
    if (priorId || priorHash) continue;
    byId.set(captured.candidate.candidateId, captured);
    byHash.set(captured.candidate.candidatePayloadHash, captured);
    selected.push(captured.candidate);
  }

  selected.sort((left, right) => compareUtf8(left.candidatePayloadHash,
    right.candidatePayloadHash) || compareUtf8(left.candidateId, right.candidateId));
  if (selected.length === 1) {
    if (!SINGLETON_REASONS.includes(selected[0].singletonReason)) {
      fail('candidate_singleton_reason_required');
    }
  } else if (selected.some((candidate) => candidate.singletonReason !== undefined
    && candidate.singletonReason !== null)) {
    fail('candidate_singleton_reason_forbidden');
  }

  const candidates = Object.freeze(selected);
  const frontierIdentity = Object.freeze({
    planningRequestHash: requestState.requestHash,
    moduleBindingSetHash: modules.moduleBindingSetHash,
    candidatePayloadHashes: Object.freeze(candidates.map((candidate) =>
      candidate.candidatePayloadHash)),
  });
  return Object.freeze({
    schemaVersion: 1,
    kind: 'CandidateFrontierV1',
    status: 'complete_deterministic_frontier',
    planningRequestId: requestState.request.planningRequestId,
    stateSnapshotHash: requestState.request.stateSnapshotHash,
    capabilityId: requestState.request.capabilityId,
    planningRequestHash: requestState.requestHash,
    moduleBindingSetHash: modules.moduleBindingSetHash,
    candidateCount: candidates.length,
    candidates,
    candidateSetHash: hashDomain('CandidateFrontierV1', frontierIdentity),
    totalCapturedBytes: totalBytes,
    dominanceReductionApplied: false,
    dominanceDisposition: 'retained_without_context_safe_replacement_certificate',
    authority: Object.freeze({
      productionAuthorized: false,
      writerAuthorized: false,
      providerAuthorized: false,
      releaseAuthorized: false,
      submissionAuthorized: false,
    }),
  });
}
