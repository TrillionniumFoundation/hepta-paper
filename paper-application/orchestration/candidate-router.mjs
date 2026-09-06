import crypto from 'node:crypto';

const HASH = /^sha256:[0-9a-f]{64}$/u;
const MODULE_ID = /^module\.[a-z0-9][a-z0-9-]{0,95}$/u;
const CAPABILITY_ID = /^CAP-[A-Z0-9][A-Z0-9-]{0,95}$/u;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,127}$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,191}$/u;
export const CANDIDATE_ROUTER_INPUT_BOUNDARY = 'trusted_same_realm_plain_data';

const QUALIFICATION_STATES = new Set([
  'source_qualified',
  'target_host_qualified',
  'external_authority_qualified',
]);
const MAXIMUMS = Object.freeze({
  candidates: 4096,
  candidateBytes: 1024 * 1024,
  totalCandidateBytes: 16 * 1024 * 1024,
  modules: 1024,
  setEntries: 4096,
  valueNodes: 65536,
  valueDepth: 24,
  stringLength: 16384,
});

const REQUEST_FIELDS = Object.freeze([
  'schemaVersion', 'kind', 'planningRequestId', 'stateSnapshotHash',
  'capabilityId', 'goalReference', 'policyReference', 'hardConstraintSetHash',
  'objectiveVersion', 'resourcePriceSnapshotHash', 'moduleQualificationMetadataSetHash',
  'candidateLimit', 'maximumCandidateBytes', 'maximumTotalCandidateBytes',
  'deadline', 'allowedSideEffectClasses', 'inputArtifacts',
]);
const MODULE_PAYLOAD_FIELDS = Object.freeze([
  'schemaVersion', 'kind', 'moduleId', 'moduleVersion', 'capabilityIds',
  'qualificationStatus', 'qualificationIdentity', 'qualificationGeneration',
  'qualificationTrustClass', 'qualificationCurrentnessMode',
  'qualificationObservedAt', 'qualificationExpiresAt',
  'qualificationRevocationSetHash', 'qualificationCurrentnessReceiptHash',
]);
const MODULE_FIELDS = Object.freeze([
  ...MODULE_PAYLOAD_FIELDS, 'qualificationMetadataHash',
]);
const CANDIDATE_FIELDS = Object.freeze([
  'schemaVersion', 'kind', 'candidateId', 'planningRequestId',
  'stateSnapshotHash', 'moduleId', 'moduleVersion', 'capabilityId',
  'resourceVector', 'duration', 'cost', 'value', 'risk', 'preconditions',
  'dependencyEffects', 'sideEffectClass', 'irreversibleBoundary',
  'rollbackClass', 'expiresAt', 'inputSchema', 'outputSchema',
  'singletonReason', 'candidatePayloadHash',
]);
const RESOURCE_FIELDS = Object.freeze([
  'cpuUnits', 'gpuUnits', 'memoryMiB', 'storageBytes', 'tokenCount',
  'maximumCostMicrousd',
]);

function failure(code) {
  return Object.assign(new Error(code), { code, retryable: false });
}

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function canonicalStringify(value) {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw failure('candidate_canonical_number_invalid');
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalStringify(entry)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort(compareUtf8)
      .map((key) => `${JSON.stringify(key)}:${canonicalStringify(value[key])}`).join(',')}}`;
  }
  throw failure('candidate_canonical_value_invalid');
}

function hashRecord(kind, value) {
  const record = Object.create(null);
  Object.defineProperties(record, {
    kind: { value: kind, enumerable: true },
    value: { value, enumerable: true },
  });
  return `sha256:${crypto.createHash('sha256')
    .update(canonicalStringify(record), 'utf8').digest('hex')}`;
}

function dataValues(value, allowed, code) {
  if (!value || typeof value !== 'object') throw failure(code);
  let prototype;
  let descriptors;
  let keys;
  try {
    prototype = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
    keys = Reflect.ownKeys(value);
  } catch {
    throw failure(code);
  }
  if (![Object.prototype, null].includes(prototype)) throw failure(code);
  const descriptorKeys = Reflect.ownKeys(descriptors);
  if (keys.length !== descriptorKeys.length
    || keys.some((key) => !descriptorKeys.includes(key))
    || keys.length > MAXIMUMS.valueNodes
    || keys.some((key) => typeof key !== 'string' || (allowed && !allowed.includes(key)))) {
    throw failure(code);
  }
  const output = Object.create(null);
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw failure(code);
    Object.defineProperty(output, key, {
      value: descriptor.value, enumerable: true, writable: false, configurable: false,
    });
  }
  return output;
}

function denseArrayValues(value, code, maximum = MAXIMUMS.setEntries) {
  let array;
  let descriptors;
  let keys;
  try {
    array = Array.isArray(value);
    descriptors = array ? Object.getOwnPropertyDescriptors(value) : null;
    keys = array ? Reflect.ownKeys(value) : null;
  } catch {
    throw failure(code);
  }
  if (!array) throw failure(code);
  const lengthDescriptor = descriptors.length;
  const length = lengthDescriptor?.value;
  if (!Object.hasOwn(lengthDescriptor || {}, 'value')
    || !Number.isSafeInteger(length) || length < 0 || length > maximum
    || keys.length !== length + 1 || !keys.includes('length')) {
    throw failure(code);
  }
  const output = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[index];
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw failure(code);
    output.push(descriptor.value);
  }
  return output;
}

function captureJson(value, state, depth = 0) {
  state.nodes += 1;
  if (state.nodes > MAXIMUMS.valueNodes || depth > MAXIMUMS.valueDepth) {
    throw failure('candidate_value_structure_limit');
  }
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (Buffer.byteLength(value, 'utf8') > MAXIMUMS.stringLength || value.includes('\0')) {
      throw failure('candidate_value_string_invalid');
    }
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw failure('candidate_value_number_invalid');
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== 'object') throw failure('candidate_value_type_invalid');
  let array;
  try {
    array = Array.isArray(value);
  } catch {
    throw failure('candidate_value_record_invalid');
  }
  if (state.stack.has(value)) throw failure('candidate_value_cycle');
  state.stack.add(value);
  try {
    if (array) {
      return Object.freeze(denseArrayValues(value, 'candidate_value_array_invalid')
        .map((entry) => captureJson(entry, state, depth + 1)));
    }
    const values = dataValues(value, null, 'candidate_value_record_invalid');
    const result = Object.create(null);
    for (const key of Object.keys(values).sort(compareUtf8)) {
      if (!key.length || Buffer.byteLength(key, 'utf8') > 256 || key.includes('\0')) {
        throw failure('candidate_value_key_invalid');
      }
      Object.defineProperty(result, key, {
        value: captureJson(values[key], state, depth + 1),
        enumerable: true, writable: false, configurable: false,
      });
    }
    return Object.freeze(result);
  } finally {
    state.stack.delete(value);
  }
}

function opaqueRecord(value, code, state) {
  const captured = captureJson(value, state);
  if (!captured || Array.isArray(captured) || typeof captured !== 'object') {
    throw failure(code);
  }
  return captured;
}

function boundedString(value, pattern, code, nullable = false) {
  if (nullable && value === null) return null;
  if (typeof value !== 'string' || !pattern.test(value) || value.includes('\0')) {
    throw failure(code);
  }
  return value;
}

function hashValue(value, code) {
  return boundedString(value, HASH, code);
}

function canonicalTimestamp(value, code) {
  if (typeof value !== 'string' || value.length > 40) throw failure(code);
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw failure(code);
  const canonical = new Date(milliseconds).toISOString();
  if (value !== canonical && value !== canonical.replace('.000Z', 'Z')) {
    throw failure(code);
  }
  return canonical;
}

function boundedInteger(value, minimum, maximum, code) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw failure(code);
  }
  return value;
}

function stringSet(value, pattern, code, maximum = MAXIMUMS.setEntries) {
  const entries = denseArrayValues(value, code, maximum)
    .map((entry) => boundedString(entry, pattern, code));
  if (new Set(entries).size !== entries.length) throw failure(code);
  return Object.freeze(entries.sort(compareUtf8));
}

function hashSet(value, code) {
  return stringSet(value, HASH, code);
}

function normalizePlanningModuleQualificationMetadata(value, { requireHash }) {
  const allowed = requireHash ? MODULE_FIELDS : MODULE_PAYLOAD_FIELDS;
  const data = dataValues(value, allowed, 'candidate_module_metadata_invalid');
  if (Object.keys(data).length !== allowed.length) throw failure('candidate_module_metadata_invalid');
  if (data.schemaVersion !== 1) throw failure('candidate_module_metadata_version_invalid');
  if (data.kind !== 'PlanningModuleQualificationMetadataV1') {
    throw failure('candidate_module_metadata_kind_invalid');
  }
  const moduleId = boundedString(data.moduleId, MODULE_ID, 'candidate_module_id_invalid');
  const moduleVersion = boundedString(
    data.moduleVersion, TOKEN, 'candidate_module_version_invalid',
  );
  const capabilityIds = stringSet(
    data.capabilityIds, CAPABILITY_ID, 'candidate_module_capabilities_invalid', 256,
  );
  const qualificationStatus = boundedString(
    data.qualificationStatus, TOKEN, 'candidate_module_qualification_invalid',
  );
  if (!QUALIFICATION_STATES.has(qualificationStatus)) {
    throw failure('candidate_module_qualification_invalid');
  }
  if (data.qualificationTrustClass !== 'caller_supplied_unverified') {
    throw failure('candidate_module_trust_class_invalid');
  }
  if (data.qualificationCurrentnessMode !== 'external_live_revalidation_required') {
    throw failure('candidate_module_currentness_mode_invalid');
  }
  const qualificationIdentity = hashValue(
    data.qualificationIdentity, 'candidate_module_qualification_identity_invalid',
  );
  const qualificationGeneration = boundedInteger(
    data.qualificationGeneration, 1, Number.MAX_SAFE_INTEGER,
    'candidate_module_qualification_generation_invalid',
  );
  const qualificationObservedAt = canonicalTimestamp(
    data.qualificationObservedAt, 'candidate_module_observed_at_invalid',
  );
  const qualificationExpiresAt = canonicalTimestamp(
    data.qualificationExpiresAt, 'candidate_module_expiry_invalid',
  );
  if (Date.parse(qualificationObservedAt) > Date.parse(qualificationExpiresAt)) {
    throw failure('candidate_module_currentness_interval_invalid');
  }
  const qualificationRevocationSetHash = hashValue(
    data.qualificationRevocationSetHash, 'candidate_module_revocation_set_invalid',
  );
  const qualificationCurrentnessReceiptHash = hashValue(
    data.qualificationCurrentnessReceiptHash,
    'candidate_module_currentness_receipt_invalid',
  );
  const payload = Object.freeze({
    schemaVersion: 1,
    kind: 'PlanningModuleQualificationMetadataV1',
    moduleId,
    moduleVersion,
    capabilityIds,
    qualificationStatus,
    qualificationIdentity,
    qualificationGeneration,
    qualificationTrustClass: 'caller_supplied_unverified',
    qualificationCurrentnessMode: 'external_live_revalidation_required',
    qualificationObservedAt,
    qualificationExpiresAt,
    qualificationRevocationSetHash,
    qualificationCurrentnessReceiptHash,
  });
  const qualificationMetadataHash = hashRecord(
    'PlanningModuleQualificationMetadataV1', payload,
  );
  if (requireHash && data.qualificationMetadataHash !== qualificationMetadataHash) {
    throw failure('candidate_module_metadata_hash_invalid');
  }
  return Object.freeze({ ...payload, qualificationMetadataHash });
}

export function sealPlanningModuleQualificationMetadataV1(value) {
  return normalizePlanningModuleQualificationMetadata(value, { requireHash: false });
}

function normalizePlanningModuleQualificationMetadataSet(value) {
  const raw = denseArrayValues(value, 'candidate_module_metadata_set_invalid', MAXIMUMS.modules);
  const normalized = raw
    .map((entry) => normalizePlanningModuleQualificationMetadata(entry, { requireHash: true }))
    .sort((left, right) => compareUtf8(canonicalStringify(left), canonicalStringify(right)));
  const identities = new Set();
  for (const metadata of normalized) {
    const identity = `${metadata.moduleId}\0${metadata.moduleVersion}`;
    if (identities.has(identity)) throw failure('candidate_module_metadata_duplicate');
    identities.add(identity);
  }
  return Object.freeze(normalized);
}

export function capturePlanningModuleQualificationMetadataSetV1(value) {
  const moduleQualificationMetadata = normalizePlanningModuleQualificationMetadataSet(value);
  return Object.freeze({
    moduleQualificationMetadata,
    qualificationTrustClass: 'caller_supplied_unverified',
    externalCurrentnessGateRequired: true,
    moduleQualificationMetadataSetHash: hashRecord(
      'PlanningModuleQualificationMetadataSetV1', moduleQualificationMetadata,
    ),
  });
}

function normalizePlanningRequest(value) {
  const data = dataValues(value, REQUEST_FIELDS, 'planning_request_invalid');
  const required = REQUEST_FIELDS.filter((field) => ![
    'goalReference', 'policyReference', 'inputArtifacts',
  ].includes(field));
  if (required.some((field) => !Object.hasOwn(data, field))) {
    throw failure('planning_request_invalid');
  }
  const maximumCandidateBytes = boundedInteger(
    data.maximumCandidateBytes, 256, MAXIMUMS.candidateBytes,
    'planning_request_candidate_byte_limit_invalid',
  );
  const maximumTotalCandidateBytes = boundedInteger(
    data.maximumTotalCandidateBytes, maximumCandidateBytes,
    MAXIMUMS.totalCandidateBytes, 'planning_request_total_byte_limit_invalid',
  );
  if (data.schemaVersion !== 1) throw failure('planning_request_version_invalid');
  if (data.kind !== 'PlanningRequestV1') throw failure('planning_request_kind_invalid');
  return Object.freeze({
    schemaVersion: 1,
    kind: 'PlanningRequestV1',
    planningRequestId: boundedString(
      data.planningRequestId, IDENTIFIER, 'planning_request_id_invalid',
    ),
    stateSnapshotHash: hashValue(data.stateSnapshotHash, 'planning_request_snapshot_invalid'),
    capabilityId: boundedString(
      data.capabilityId, CAPABILITY_ID, 'planning_request_capability_invalid',
    ),
    goalReference: Object.hasOwn(data, 'goalReference')
      ? hashValue(data.goalReference, 'planning_request_goal_invalid') : null,
    policyReference: Object.hasOwn(data, 'policyReference')
      ? hashValue(data.policyReference, 'planning_request_policy_invalid') : null,
    hardConstraintSetHash: hashValue(
      data.hardConstraintSetHash, 'planning_request_constraints_invalid',
    ),
    objectiveVersion: boundedString(
      data.objectiveVersion, TOKEN, 'planning_request_objective_invalid',
    ),
    resourcePriceSnapshotHash: hashValue(
      data.resourcePriceSnapshotHash, 'planning_request_resource_prices_invalid',
    ),
    moduleQualificationMetadataSetHash: hashValue(
      data.moduleQualificationMetadataSetHash,
      'planning_request_module_metadata_set_invalid',
    ),
    candidateLimit: boundedInteger(
      data.candidateLimit, 1, MAXIMUMS.candidates, 'planning_request_candidate_limit_invalid',
    ),
    maximumCandidateBytes,
    maximumTotalCandidateBytes,
    deadline: canonicalTimestamp(data.deadline, 'planning_request_deadline_invalid'),
    allowedSideEffectClasses: stringSet(
      data.allowedSideEffectClasses, TOKEN, 'planning_request_side_effects_invalid', 256,
    ),
    inputArtifacts: Object.hasOwn(data, 'inputArtifacts')
      ? hashSet(data.inputArtifacts, 'planning_request_artifacts_invalid') : Object.freeze([]),
  });
}

function normalizeResourceVector(value) {
  const data = dataValues(value, RESOURCE_FIELDS, 'candidate_resource_vector_invalid');
  for (const required of ['cpuUnits', 'gpuUnits', 'memoryMiB', 'storageBytes']) {
    if (!Object.hasOwn(data, required)) throw failure('candidate_resource_vector_invalid');
  }
  const finiteResource = (name) => {
    const number = data[name];
    if (typeof number !== 'number' || !Number.isFinite(number) || number < 0
      || number > Number.MAX_SAFE_INTEGER) {
      throw failure(`candidate_resource_value_invalid:${name}`);
    }
    return Object.is(number, -0) ? 0 : number;
  };
  const integerResource = (name, fallback = null) => {
    if (!Object.hasOwn(data, name)) return fallback;
    return boundedInteger(
      data[name], 0, Number.MAX_SAFE_INTEGER, `candidate_resource_value_invalid:${name}`,
    );
  };
  return Object.freeze({
    cpuUnits: finiteResource('cpuUnits'),
    gpuUnits: finiteResource('gpuUnits'),
    memoryMiB: integerResource('memoryMiB'),
    storageBytes: integerResource('storageBytes'),
    tokenCount: integerResource('tokenCount', 0),
    maximumCostMicrousd: integerResource('maximumCostMicrousd', 0),
  });
}

function normalizeCandidate(value, { requireHash, captureState }) {
  const data = dataValues(value, CANDIDATE_FIELDS, 'action_candidate_invalid');
  const required = CANDIDATE_FIELDS.filter((field) => ![
    'preconditions', 'dependencyEffects', 'irreversibleBoundary', 'inputSchema',
    'outputSchema', 'singletonReason', 'candidatePayloadHash',
  ].includes(field));
  if (required.some((field) => !Object.hasOwn(data, field))
    || (requireHash && !Object.hasOwn(data, 'candidatePayloadHash'))
    || (!requireHash && Object.hasOwn(data, 'candidatePayloadHash'))) {
    throw failure('action_candidate_invalid');
  }
  if (data.schemaVersion !== 1) throw failure('action_candidate_version_invalid');
  if (data.kind !== 'ActionCandidateV1') throw failure('action_candidate_kind_invalid');
  const payload = Object.freeze({
    schemaVersion: 1,
    kind: 'ActionCandidateV1',
    candidateId: boundedString(data.candidateId, IDENTIFIER, 'action_candidate_id_invalid'),
    planningRequestId: boundedString(
      data.planningRequestId, IDENTIFIER, 'action_candidate_request_invalid',
    ),
    stateSnapshotHash: hashValue(data.stateSnapshotHash, 'action_candidate_snapshot_invalid'),
    moduleId: boundedString(data.moduleId, MODULE_ID, 'action_candidate_module_invalid'),
    moduleVersion: boundedString(
      data.moduleVersion, TOKEN, 'action_candidate_module_version_invalid',
    ),
    capabilityId: boundedString(
      data.capabilityId, CAPABILITY_ID, 'action_candidate_capability_invalid',
    ),
    resourceVector: normalizeResourceVector(data.resourceVector),
    duration: opaqueRecord(data.duration, 'action_candidate_duration_invalid', captureState),
    cost: opaqueRecord(data.cost, 'action_candidate_cost_invalid', captureState),
    value: opaqueRecord(data.value, 'action_candidate_value_invalid', captureState),
    risk: opaqueRecord(data.risk, 'action_candidate_risk_invalid', captureState),
    preconditions: Object.hasOwn(data, 'preconditions')
      ? stringSet(data.preconditions, IDENTIFIER, 'action_candidate_preconditions_invalid')
      : Object.freeze([]),
    dependencyEffects: Object.hasOwn(data, 'dependencyEffects')
      ? stringSet(data.dependencyEffects, IDENTIFIER, 'action_candidate_dependencies_invalid')
      : Object.freeze([]),
    sideEffectClass: boundedString(
      data.sideEffectClass, TOKEN, 'action_candidate_side_effect_invalid',
    ),
    irreversibleBoundary: Object.hasOwn(data, 'irreversibleBoundary')
      ? boundedString(
        data.irreversibleBoundary, IDENTIFIER,
        'action_candidate_irreversible_boundary_invalid', true,
      ) : null,
    rollbackClass: boundedString(
      data.rollbackClass, TOKEN, 'action_candidate_rollback_invalid',
    ),
    expiresAt: canonicalTimestamp(data.expiresAt, 'action_candidate_expiry_invalid'),
    inputSchema: Object.hasOwn(data, 'inputSchema')
      ? boundedString(data.inputSchema, IDENTIFIER, 'action_candidate_input_schema_invalid', true)
      : null,
    outputSchema: Object.hasOwn(data, 'outputSchema')
      ? boundedString(data.outputSchema, IDENTIFIER, 'action_candidate_output_schema_invalid', true)
      : null,
    singletonReason: Object.hasOwn(data, 'singletonReason')
      ? boundedString(
        data.singletonReason, IDENTIFIER, 'action_candidate_singleton_reason_invalid', true,
      ) : null,
  });
  const candidatePayloadHash = hashRecord('ActionCandidateV1', payload);
  if (requireHash && data.candidatePayloadHash !== candidatePayloadHash) {
    throw failure('action_candidate_payload_hash_invalid');
  }
  return Object.freeze({ ...payload, candidatePayloadHash });
}

export function sealActionCandidateV1(value) {
  return normalizeCandidate(value, {
    requireHash: false, captureState: { nodes: 0, stack: new WeakSet() },
  });
}

export function routeActionCandidatesV1(value) {
  const input = dataValues(
    value, ['inputBoundary', 'planningRequest', 'moduleQualificationMetadata', 'candidates', 'observedAt'],
    'candidate_routing_input_invalid',
  );
  if (Object.keys(input).length !== 5) throw failure('candidate_routing_input_invalid');
  if (input.inputBoundary !== CANDIDATE_ROUTER_INPUT_BOUNDARY) {
    throw failure('candidate_input_boundary_invalid');
  }
  const moduleMetadata = capturePlanningModuleQualificationMetadataSetV1(
    input.moduleQualificationMetadata,
  );
  const request = normalizePlanningRequest(input.planningRequest);
  if (request.moduleQualificationMetadataSetHash
    !== moduleMetadata.moduleQualificationMetadataSetHash) {
    throw failure('planning_request_module_metadata_set_mismatch');
  }
  const observedAt = canonicalTimestamp(input.observedAt, 'candidate_routing_observed_at_invalid');
  const observedMs = Date.parse(observedAt);
  const deadlineMs = Date.parse(request.deadline);
  if (observedMs > deadlineMs) throw failure('planning_request_expired');
  const rawCandidates = denseArrayValues(
    input.candidates, 'candidate_collection_invalid', request.candidateLimit,
  );
  for (const binding of moduleMetadata.moduleQualificationMetadata) {
    const qualificationObservedMs = Date.parse(binding.qualificationObservedAt);
    const qualificationExpiresMs = Date.parse(binding.qualificationExpiresAt);
    if (qualificationObservedMs > observedMs || observedMs > qualificationExpiresMs) {
      throw failure('candidate_module_qualification_not_current');
    }
  }
  const modules = new Map(moduleMetadata.moduleQualificationMetadata.map((binding) => [
    `${binding.moduleId}\0${binding.moduleVersion}`, binding,
  ]));
  const byId = new Map();
  const byHash = new Map();
  const exact = new Map();
  let totalBytes = 0;
  const captureState = { nodes: 0, stack: new WeakSet() };
  let frontierExpiryMs = deadlineMs;
  for (const binding of moduleMetadata.moduleQualificationMetadata) {
    frontierExpiryMs = Math.min(frontierExpiryMs, Date.parse(binding.qualificationExpiresAt));
  }
  for (const raw of rawCandidates) {
    const candidate = normalizeCandidate(raw, { requireHash: true, captureState });
    if (candidate.planningRequestId !== request.planningRequestId) {
      throw failure('action_candidate_request_mismatch');
    }
    if (candidate.stateSnapshotHash !== request.stateSnapshotHash) {
      throw failure('action_candidate_snapshot_mismatch');
    }
    if (candidate.capabilityId !== request.capabilityId) {
      throw failure('action_candidate_capability_mismatch');
    }
    if (!request.allowedSideEffectClasses.includes(candidate.sideEffectClass)) {
      throw failure('action_candidate_side_effect_forbidden');
    }
    const expiryMs = Date.parse(candidate.expiresAt);
    if (expiryMs < observedMs || expiryMs > deadlineMs) {
      throw failure('action_candidate_expired_or_outlives_request');
    }
    const module = modules.get(`${candidate.moduleId}\0${candidate.moduleVersion}`);
    if (!module || !module.capabilityIds.includes(candidate.capabilityId)) {
      throw failure('action_candidate_module_not_qualified');
    }
    frontierExpiryMs = Math.min(frontierExpiryMs, expiryMs);
    const encoded = canonicalStringify(candidate);
    const bytes = Buffer.byteLength(encoded, 'utf8');
    if (bytes > request.maximumCandidateBytes) {
      throw failure('action_candidate_byte_limit');
    }
    totalBytes += bytes;
    if (totalBytes > request.maximumTotalCandidateBytes) {
      throw failure('candidate_collection_byte_limit');
    }
    if (byId.has(candidate.candidateId) && byId.get(candidate.candidateId) !== encoded) {
      throw failure('action_candidate_id_conflict');
    }
    if (byHash.has(candidate.candidatePayloadHash)
      && byHash.get(candidate.candidatePayloadHash) !== encoded) {
      throw failure('action_candidate_hash_conflict');
    }
    byId.set(candidate.candidateId, encoded);
    byHash.set(candidate.candidatePayloadHash, encoded);
    exact.set(encoded, candidate);
  }
  const candidates = Object.freeze([...exact.values()].sort((left, right) => {
    const l = `${left.moduleId}\0${left.moduleVersion}\0${left.candidateId}\0${left.candidatePayloadHash}`;
    const r = `${right.moduleId}\0${right.moduleVersion}\0${right.candidateId}\0${right.candidatePayloadHash}`;
    return l < r ? -1 : l > r ? 1 : 0;
  }));
  if (candidates.length === 1 && candidates[0].singletonReason === null) {
    throw failure('candidate_singleton_reason_required');
  }
  if (candidates.length !== 1 && candidates.some((candidate) => candidate.singletonReason !== null)) {
    throw failure('candidate_singleton_reason_invalid');
  }
  const candidateSetHash = hashRecord('ActionCandidateSetV1', candidates);
  const body = Object.freeze({
    schemaVersion: 1,
    kind: 'CandidateFrontierV1',
    inputBoundary: CANDIDATE_ROUTER_INPUT_BOUNDARY,
    status: candidates.length ? 'candidate_frontier_complete' : 'candidate_frontier_empty',
    planningRequestId: request.planningRequestId,
    planningRequestHash: hashRecord('PlanningRequestV1', request),
    stateSnapshotHash: request.stateSnapshotHash,
    capabilityId: request.capabilityId,
    moduleQualificationMetadataSetHash: moduleMetadata.moduleQualificationMetadataSetHash,
    qualificationTrustClass: 'caller_supplied_unverified',
    externalCurrentnessGateRequired: true,
    observedAt,
    expiresAt: new Date(frontierExpiryMs).toISOString(),
    candidateCount: candidates.length,
    deduplicatedCount: rawCandidates.length - candidates.length,
    candidateSetHash,
    candidates,
    dominanceReductionApplied: false,
    dominancePolicy: 'none_without_context_safe_replacement_proof',
    rejections: Object.freeze([]),
    authority: Object.freeze({
      executionAuthorized: false,
      writerAuthorized: false,
      providerAuthorized: false,
      releaseAuthorized: false,
      externalAuthorityClaimed: false,
    }),
  });
  return Object.freeze({
    ...body,
    candidateFrontierHash: hashRecord('CandidateFrontierV1', body),
  });
}
