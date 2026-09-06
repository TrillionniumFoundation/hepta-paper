import { hashRecord, stableStringify } from '../../workflow-kernel/record-hash.mjs';

const HASH = /^sha256:[0-9a-f]{64}$/u;
const MODULE_ID = /^module\.[a-z0-9][a-z0-9-]{0,95}$/u;
const CAPABILITY_ID = /^CAP-[A-Z0-9][A-Z0-9-]{0,95}$/u;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,127}$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,191}$/u;
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
  'objectiveVersion', 'resourcePriceSnapshotHash', 'qualifiedModuleSetHash',
  'candidateLimit', 'maximumCandidateBytes', 'maximumTotalCandidateBytes',
  'deadline', 'allowedSideEffectClasses', 'inputArtifacts',
]);
const MODULE_FIELDS = Object.freeze([
  'moduleId', 'moduleVersion', 'capabilityIds', 'qualificationStatus',
  'qualificationIdentity',
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

function dataValues(value, allowed, code) {
  if (!value || typeof value !== 'object'
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw failure(code);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(value);
  if (keys.length > MAXIMUMS.valueNodes || keys.some((key) => typeof key !== 'string'
    || (allowed && !allowed.includes(key)))) throw failure(code);
  const output = Object.create(null);
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw failure(code);
    }
    output[key] = descriptor.value;
  }
  return output;
}

function denseArrayValues(value, code, maximum = MAXIMUMS.setEntries) {
  if (!Array.isArray(value) || value.length > maximum) throw failure(code);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1 || !keys.includes('length')) {
    throw failure(code);
  }
  const output = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[index];
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw failure(code);
    }
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
    if (value.length > MAXIMUMS.stringLength || value.includes('\0')) {
      throw failure('candidate_value_string_invalid');
    }
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw failure('candidate_value_number_invalid');
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== 'object') throw failure('candidate_value_type_invalid');
  if (state.stack.has(value)) throw failure('candidate_value_cycle');
  state.stack.add(value);
  try {
    if (Array.isArray(value)) {
      return Object.freeze(denseArrayValues(value, 'candidate_value_array_invalid')
        .map((entry) => captureJson(entry, state, depth + 1)));
    }
    const values = dataValues(value, null, 'candidate_value_record_invalid');
    const result = {};
    for (const key of Object.keys(values).sort()) {
      if (!key.length || key.length > 256 || key.includes('\0')) {
        throw failure('candidate_value_key_invalid');
      }
      result[key] = captureJson(values[key], state, depth + 1);
    }
    return Object.freeze(result);
  } finally {
    state.stack.delete(value);
  }
}

function opaqueRecord(value, code) {
  const captured = captureJson(value, { nodes: 0, stack: new WeakSet() });
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
  return Object.freeze(entries.sort());
}

function hashSet(value, code) {
  return stringSet(value, HASH, code);
}

function normalizeQualifiedModules(value) {
  const raw = denseArrayValues(value, 'candidate_module_set_invalid', MAXIMUMS.modules);
  const normalized = raw.map((entry) => {
    const data = dataValues(entry, MODULE_FIELDS, 'candidate_module_binding_invalid');
    if (Object.keys(data).length !== MODULE_FIELDS.length) {
      throw failure('candidate_module_binding_invalid');
    }
    const qualificationStatus = boundedString(
      data.qualificationStatus, TOKEN, 'candidate_module_qualification_invalid',
    );
    if (!QUALIFICATION_STATES.has(qualificationStatus)) {
      throw failure('candidate_module_qualification_invalid');
    }
    return Object.freeze({
      moduleId: boundedString(data.moduleId, MODULE_ID, 'candidate_module_id_invalid'),
      moduleVersion: boundedString(
        data.moduleVersion, TOKEN, 'candidate_module_version_invalid',
      ),
      capabilityIds: stringSet(
        data.capabilityIds, CAPABILITY_ID, 'candidate_module_capabilities_invalid', 256,
      ),
      qualificationStatus,
      qualificationIdentity: hashValue(
        data.qualificationIdentity, 'candidate_module_qualification_identity_invalid',
      ),
    });
  }).sort((left, right) => {
    const a = stableStringify(left);
    const b = stableStringify(right);
    return a < b ? -1 : a > b ? 1 : 0;
  });
  const identities = new Set();
  for (const binding of normalized) {
    const identity = `${binding.moduleId}\0${binding.moduleVersion}`;
    if (identities.has(identity)) throw failure('candidate_module_binding_duplicate');
    identities.add(identity);
  }
  return Object.freeze(normalized);
}

export function captureQualifiedPlanningModuleSetV1(value) {
  const modules = normalizeQualifiedModules(value);
  return Object.freeze({
    modules,
    qualifiedModuleSetHash: hashRecord('QualifiedPlanningModuleSetV1', modules),
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
    qualifiedModuleSetHash: hashValue(
      data.qualifiedModuleSetHash, 'planning_request_module_set_invalid',
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

function normalizeCandidate(value, { requireHash }) {
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
    duration: opaqueRecord(data.duration, 'action_candidate_duration_invalid'),
    cost: opaqueRecord(data.cost, 'action_candidate_cost_invalid'),
    value: opaqueRecord(data.value, 'action_candidate_value_invalid'),
    risk: opaqueRecord(data.risk, 'action_candidate_risk_invalid'),
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
  return normalizeCandidate(value, { requireHash: false });
}

export function routeActionCandidatesV1(value) {
  const input = dataValues(
    value, ['planningRequest', 'qualifiedModules', 'candidates', 'observedAt'],
    'candidate_routing_input_invalid',
  );
  if (Object.keys(input).length !== 4) throw failure('candidate_routing_input_invalid');
  const qualified = captureQualifiedPlanningModuleSetV1(input.qualifiedModules);
  const request = normalizePlanningRequest(input.planningRequest);
  if (request.qualifiedModuleSetHash !== qualified.qualifiedModuleSetHash) {
    throw failure('planning_request_module_set_mismatch');
  }
  const observedAt = canonicalTimestamp(input.observedAt, 'candidate_routing_observed_at_invalid');
  const observedMs = Date.parse(observedAt);
  const deadlineMs = Date.parse(request.deadline);
  if (observedMs > deadlineMs) throw failure('planning_request_expired');
  const rawCandidates = denseArrayValues(
    input.candidates, 'candidate_collection_invalid', request.candidateLimit,
  );
  const modules = new Map(qualified.modules.map((binding) => [
    `${binding.moduleId}\0${binding.moduleVersion}`, binding,
  ]));
  const byId = new Map();
  const byHash = new Map();
  const exact = new Map();
  let totalBytes = 0;
  for (const raw of rawCandidates) {
    const candidate = normalizeCandidate(raw, { requireHash: true });
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
    const encoded = stableStringify(candidate);
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
    status: candidates.length ? 'candidate_frontier_complete' : 'candidate_frontier_empty',
    planningRequestId: request.planningRequestId,
    planningRequestHash: hashRecord('PlanningRequestV1', request),
    stateSnapshotHash: request.stateSnapshotHash,
    capabilityId: request.capabilityId,
    qualifiedModuleSetHash: qualified.qualifiedModuleSetHash,
    observedAt,
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
