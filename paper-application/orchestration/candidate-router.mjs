import { hashRecord, stableStringify } from '../../workflow-kernel/record-hash.mjs';

const HASH = /^sha256:[0-9a-f]{64}$/u;
const CANONICAL_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const MAX_DEPTH = 16;
const MAX_NODES = 8192;
const MAX_STRING_BYTES = 16 * 1024;
const MAX_MODULES = 256;
const MAX_CANDIDATES = 4096;
const MAX_CANDIDATE_BYTES = 4 * 1024 * 1024;
const MAX_SET_ITEMS = 1024;
const QUALIFICATION_STATES = new Set([
  'source_qualified',
  'target_host_qualified',
  'external_authority_qualified',
]);

const REQUEST_FIELDS = Object.freeze([
  'schemaVersion',
  'kind',
  'planningRequestId',
  'stateSnapshotHash',
  'moduleRegistrySnapshotHash',
  'capabilityId',
  'hardConstraintSetHash',
  'objectiveVersion',
  'resourcePriceSnapshotHash',
  'candidateLimit',
  'candidateBytesLimit',
  'deadline',
  'allowedSideEffectClasses',
  'goalRef',
  'policyRef',
  'inputArtifactHashes',
]);
const REQUEST_REQUIRED = Object.freeze([
  'schemaVersion',
  'kind',
  'planningRequestId',
  'stateSnapshotHash',
  'moduleRegistrySnapshotHash',
  'capabilityId',
  'hardConstraintSetHash',
  'objectiveVersion',
  'resourcePriceSnapshotHash',
  'candidateLimit',
  'candidateBytesLimit',
  'deadline',
  'allowedSideEffectClasses',
]);
const REGISTRY_FIELDS = Object.freeze(['version', 'kind', 'modules', 'snapshotHash']);
const ROUTE_FIELDS = Object.freeze([
  'planningRequest',
  'moduleRegistry',
  'candidates',
  'nowEpochMs',
]);
const MODULE_FIELDS = Object.freeze([
  'moduleId',
  'moduleVersion',
  'protocolMinimum',
  'protocolMaximum',
  'capabilityIds',
  'qualificationStatus',
  'qualificationEvidenceHash',
]);
const CANDIDATE_FIELDS = Object.freeze([
  'schemaVersion',
  'kind',
  'candidateId',
  'planningRequestId',
  'stateSnapshotHash',
  'moduleId',
  'moduleVersion',
  'capabilityId',
  'resourceVector',
  'duration',
  'cost',
  'value',
  'risk',
  'preconditions',
  'dependencyEffects',
  'sideEffectClass',
  'irreversibleBoundary',
  'rollbackClass',
  'expiresAt',
  'inputSchema',
  'outputSchema',
  'candidatePayloadHash',
  'singletonReason',
]);
const CANDIDATE_REQUIRED = Object.freeze([
  'schemaVersion',
  'kind',
  'candidateId',
  'planningRequestId',
  'stateSnapshotHash',
  'moduleId',
  'moduleVersion',
  'capabilityId',
  'resourceVector',
  'duration',
  'cost',
  'value',
  'risk',
  'sideEffectClass',
  'rollbackClass',
  'expiresAt',
  'candidatePayloadHash',
]);
const RESOURCE_FIELDS = Object.freeze([
  'cpuUnits',
  'gpuUnits',
  'memoryMiB',
  'storageBytes',
  'tokenCount',
  'maximumCostMicrousd',
]);
const RESOURCE_REQUIRED = Object.freeze([
  'cpuUnits',
  'gpuUnits',
  'memoryMiB',
  'storageBytes',
]);

function failure(code) {
  return Object.assign(new Error(code), { code, retryable: false });
}
function requireCondition(condition, code) {
  if (!condition) throw failure(code);
}
function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
function byteLength(value) {
  return Buffer.byteLength(value, 'utf8');
}
function stringValue(value, code, maximum = 2048) {
  requireCondition(typeof value === 'string' && value.length > 0
    && !value.includes('\0') && byteLength(value) <= maximum, code);
  return value;
}
function hashValue(value, code) {
  requireCondition(typeof value === 'string' && HASH.test(value), code);
  return value;
}
function integerValue(value, minimum, maximum, code) {
  requireCondition(Number.isSafeInteger(value) && value >= minimum && value <= maximum, code);
  return value;
}
function finiteValue(value, maximum, code) {
  requireCondition(typeof value === 'number' && Number.isFinite(value)
    && value >= 0 && value <= maximum, code);
  return Object.is(value, -0) ? 0 : value;
}
function timestampValue(value, code) {
  requireCondition(typeof value === 'string' && CANONICAL_TIME.test(value), code);
  const milliseconds = Date.parse(value);
  requireCondition(Number.isSafeInteger(milliseconds) && new Date(milliseconds).toISOString() === value, code);
  return Object.freeze({ value, milliseconds });
}
function recordValues(value, allowed, required, code) {
  requireCondition(value !== null && typeof value === 'object'
    && [Object.prototype, null].includes(Object.getPrototypeOf(value)), code);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  requireCondition(keys.length <= allowed.length && keys.every((key) => typeof key === 'string'
    && allowed.includes(key) && descriptors[key].enumerable
    && Object.hasOwn(descriptors[key], 'value')), code);
  requireCondition(required.every((key) => Object.hasOwn(descriptors, key)), code);
  return Object.fromEntries(keys.map((key) => [key, descriptors[key].value]));
}
function denseArray(value, maximum, code) {
  requireCondition(Array.isArray(value) && value.length <= maximum, code);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  requireCondition(keys.length === value.length + 1 && Object.hasOwn(descriptors, 'length'), code);
  const result = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[index];
    requireCondition(descriptor && descriptor.enumerable && Object.hasOwn(descriptor, 'value'), code);
    result.push(descriptor.value);
  }
  return result;
}
function canonicalSet(value, maximum, item, code) {
  const values = denseArray(value, maximum, code).map(item);
  const sorted = values.slice().sort(compareText);
  requireCondition(new Set(sorted).size === sorted.length, code);
  return Object.freeze(sorted);
}
function captureJson(value, state, depth = 0) {
  requireCondition(depth <= MAX_DEPTH, 'candidate_nested_depth_limit');
  state.nodes += 1;
  requireCondition(state.nodes <= MAX_NODES, 'candidate_nested_node_limit');
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    state.stringBytes += byteLength(value);
    requireCondition(state.stringBytes <= MAX_STRING_BYTES, 'candidate_nested_string_limit');
    return value;
  }
  if (typeof value === 'number') {
    requireCondition(Number.isFinite(value), 'candidate_nested_number_invalid');
    return Object.is(value, -0) ? 0 : value;
  }
  requireCondition(typeof value === 'object', 'candidate_nested_value_invalid');
  if (Array.isArray(value)) {
    return Object.freeze(denseArray(value, MAX_SET_ITEMS, 'candidate_nested_array_invalid')
      .map((item) => captureJson(item, state, depth + 1)));
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  requireCondition([Object.prototype, null].includes(Object.getPrototypeOf(value))
    && keys.length <= MAX_SET_ITEMS
    && keys.every((key) => typeof key === 'string' && descriptors[key].enumerable
      && Object.hasOwn(descriptors[key], 'value')), 'candidate_nested_record_invalid');
  const entries = keys.slice().sort(compareText)
    .map((key) => [key, captureJson(descriptors[key].value, state, depth + 1)]);
  return Object.freeze(Object.fromEntries(entries));
}
function structuredRecord(value, code) {
  const captured = captureJson(value, { nodes: 0, stringBytes: 0 });
  requireCondition(captured !== null && typeof captured === 'object'
    && !Array.isArray(captured) && Object.keys(captured).length > 0, code);
  return captured;
}
function optionalString(values, key, code) {
  if (!Object.hasOwn(values, key)) return null;
  if (values[key] === null) return null;
  return stringValue(values[key], code);
}
function normalizedResourceVector(value) {
  const values = recordValues(value, RESOURCE_FIELDS, RESOURCE_REQUIRED,
    'candidate_resource_vector_invalid');
  const result = {
    cpuUnits: finiteValue(values.cpuUnits, 1_000_000_000, 'candidate_cpu_units_invalid'),
    gpuUnits: finiteValue(values.gpuUnits, 1_000_000, 'candidate_gpu_units_invalid'),
    memoryMiB: integerValue(values.memoryMiB, 0, Number.MAX_SAFE_INTEGER,
      'candidate_memory_invalid'),
    storageBytes: integerValue(values.storageBytes, 0, Number.MAX_SAFE_INTEGER,
      'candidate_storage_invalid'),
  };
  for (const key of ['tokenCount', 'maximumCostMicrousd']) {
    if (Object.hasOwn(values, key)) {
      result[key] = integerValue(values[key], 0, Number.MAX_SAFE_INTEGER,
        `candidate_${key}_invalid`);
    }
  }
  return Object.freeze(result);
}
function capturePlanningRequest(value) {
  const values = recordValues(value, REQUEST_FIELDS, REQUEST_REQUIRED,
    'planning_request_invalid');
  requireCondition(values.schemaVersion === 1 && values.kind === 'PlanningRequestV1',
    'planning_request_identity_invalid');
  const result = {
    schemaVersion: 1,
    kind: 'PlanningRequestV1',
    planningRequestId: stringValue(values.planningRequestId, 'planning_request_id_invalid'),
    stateSnapshotHash: hashValue(values.stateSnapshotHash, 'planning_snapshot_hash_invalid'),
    moduleRegistrySnapshotHash: hashValue(values.moduleRegistrySnapshotHash,
      'planning_registry_hash_invalid'),
    capabilityId: stringValue(values.capabilityId, 'planning_capability_invalid'),
    hardConstraintSetHash: hashValue(values.hardConstraintSetHash,
      'planning_constraint_hash_invalid'),
    objectiveVersion: stringValue(values.objectiveVersion, 'planning_objective_invalid'),
    resourcePriceSnapshotHash: hashValue(values.resourcePriceSnapshotHash,
      'planning_price_hash_invalid'),
    candidateLimit: integerValue(values.candidateLimit, 1, MAX_CANDIDATES,
      'planning_candidate_limit_invalid'),
    candidateBytesLimit: integerValue(values.candidateBytesLimit, 1, MAX_CANDIDATE_BYTES,
      'planning_candidate_bytes_limit_invalid'),
    deadline: timestampValue(values.deadline, 'planning_deadline_invalid').value,
    allowedSideEffectClasses: canonicalSet(values.allowedSideEffectClasses, 32,
      (item) => stringValue(item, 'planning_side_effect_class_invalid', 128),
      'planning_side_effect_classes_invalid'),
  };
  requireCondition(result.allowedSideEffectClasses.length > 0,
    'planning_side_effect_classes_invalid');
  for (const key of ['goalRef', 'policyRef']) {
    if (Object.hasOwn(values, key)) result[key] = optionalString(values, key,
      `planning_${key}_invalid`);
  }
  if (Object.hasOwn(values, 'inputArtifactHashes')) {
    result.inputArtifactHashes = canonicalSet(values.inputArtifactHashes, 1024,
      (item) => hashValue(item, 'planning_input_artifact_hash_invalid'),
      'planning_input_artifact_hashes_invalid');
  }
  return Object.freeze(result);
}
function captureModule(value) {
  const values = recordValues(value, MODULE_FIELDS, MODULE_FIELDS,
    'candidate_module_binding_invalid');
  const moduleId = stringValue(values.moduleId, 'candidate_module_id_invalid');
  const moduleVersion = stringValue(values.moduleVersion, 'candidate_module_version_invalid');
  const minimum = integerValue(values.protocolMinimum, 1, 65535,
    'candidate_module_protocol_invalid');
  const maximum = integerValue(values.protocolMaximum, minimum, 65535,
    'candidate_module_protocol_invalid');
  requireCondition(minimum <= 1 && maximum >= 1, 'candidate_module_protocol_unsupported');
  requireCondition(QUALIFICATION_STATES.has(values.qualificationStatus),
    'candidate_module_not_qualified');
  return Object.freeze({
    moduleId,
    moduleVersion,
    protocolMinimum: minimum,
    protocolMaximum: maximum,
    capabilityIds: canonicalSet(values.capabilityIds, 128,
      (item) => stringValue(item, 'candidate_module_capability_invalid'),
      'candidate_module_capabilities_invalid'),
    qualificationStatus: values.qualificationStatus,
    qualificationEvidenceHash: hashValue(values.qualificationEvidenceHash,
      'candidate_module_qualification_hash_invalid'),
  });
}
function registryBody(value) {
  const values = recordValues(value, REGISTRY_FIELDS, REGISTRY_FIELDS,
    'candidate_registry_invalid');
  requireCondition(values.version === 1 && values.kind === 'QualifiedModuleRegistrySnapshotV1',
    'candidate_registry_identity_invalid');
  const modules = denseArray(values.modules, MAX_MODULES, 'candidate_registry_modules_invalid')
    .map(captureModule).sort((left, right) => compareText(left.moduleId, right.moduleId));
  requireCondition(modules.length > 0
    && new Set(modules.map((module) => module.moduleId)).size === modules.length,
  'candidate_registry_module_duplicate');
  const body = Object.freeze({ version: 1, kind: 'QualifiedModuleRegistrySnapshotV1',
    modules: Object.freeze(modules) });
  requireCondition(hashRecord('QualifiedModuleRegistrySnapshotV1', body) === values.snapshotHash,
    'candidate_registry_snapshot_hash_invalid');
  return Object.freeze({ body, snapshotHash: values.snapshotHash });
}
function captureCandidateDraft(value, includeHash) {
  const required = includeHash ? CANDIDATE_REQUIRED
    : CANDIDATE_REQUIRED.filter((key) => key !== 'candidatePayloadHash');
  const values = recordValues(value, CANDIDATE_FIELDS, required, 'action_candidate_invalid');
  requireCondition(values.schemaVersion === 1 && values.kind === 'ActionCandidateV1',
    'action_candidate_identity_invalid');
  const result = {
    schemaVersion: 1,
    kind: 'ActionCandidateV1',
    candidateId: stringValue(values.candidateId, 'candidate_id_invalid'),
    planningRequestId: stringValue(values.planningRequestId, 'candidate_request_id_invalid'),
    stateSnapshotHash: hashValue(values.stateSnapshotHash, 'candidate_snapshot_hash_invalid'),
    moduleId: stringValue(values.moduleId, 'candidate_module_id_invalid'),
    moduleVersion: stringValue(values.moduleVersion, 'candidate_module_version_invalid'),
    capabilityId: stringValue(values.capabilityId, 'candidate_capability_invalid'),
    resourceVector: normalizedResourceVector(values.resourceVector),
    duration: structuredRecord(values.duration, 'candidate_duration_invalid'),
    cost: structuredRecord(values.cost, 'candidate_cost_invalid'),
    value: structuredRecord(values.value, 'candidate_value_invalid'),
    risk: structuredRecord(values.risk, 'candidate_risk_invalid'),
    sideEffectClass: stringValue(values.sideEffectClass, 'candidate_side_effect_class_invalid', 128),
    rollbackClass: stringValue(values.rollbackClass, 'candidate_rollback_class_invalid', 128),
    expiresAt: timestampValue(values.expiresAt, 'candidate_expiry_invalid').value,
  };
  for (const key of ['preconditions', 'dependencyEffects']) {
    if (Object.hasOwn(values, key)) {
      result[key] = canonicalSet(values[key], MAX_SET_ITEMS,
        (item) => stringValue(item, `candidate_${key}_invalid`), `candidate_${key}_invalid`);
    }
  }
  for (const key of ['irreversibleBoundary', 'inputSchema', 'outputSchema', 'singletonReason']) {
    if (Object.hasOwn(values, key)) result[key] = optionalString(values, key,
      `candidate_${key}_invalid`);
  }
  if (includeHash) {
    result.candidatePayloadHash = hashValue(values.candidatePayloadHash,
      'candidate_payload_hash_invalid');
  }
  return Object.freeze(result);
}
function candidateBodyWithoutHash(candidate) {
  const entries = Object.entries(candidate)
    .filter(([key]) => key !== 'candidatePayloadHash');
  return Object.freeze(Object.fromEntries(entries));
}
function semanticBody(candidate) {
  return Object.freeze(Object.fromEntries(Object.entries(candidate)
    .filter(([key]) => !['candidateId', 'candidatePayloadHash', 'singletonReason'].includes(key))));
}

export function actionCandidatePayloadHash(candidateDraft) {
  return hashRecord('ActionCandidateV1', captureCandidateDraft(candidateDraft, false));
}
export function qualifiedModuleRegistrySnapshotHash(registryDraft) {
  const values = recordValues(registryDraft, ['version', 'kind', 'modules'],
    ['version', 'kind', 'modules'], 'candidate_registry_invalid');
  const modules = denseArray(values.modules, MAX_MODULES, 'candidate_registry_modules_invalid')
    .map(captureModule).sort((left, right) => compareText(left.moduleId, right.moduleId));
  requireCondition(values.version === 1 && values.kind === 'QualifiedModuleRegistrySnapshotV1'
    && modules.length > 0
    && new Set(modules.map((module) => module.moduleId)).size === modules.length,
  'candidate_registry_invalid');
  return hashRecord('QualifiedModuleRegistrySnapshotV1', Object.freeze({
    version: 1, kind: 'QualifiedModuleRegistrySnapshotV1', modules: Object.freeze(modules),
  }));
}
export function planningRequestHash(planningRequest) {
  return hashRecord('PlanningRequestV1', capturePlanningRequest(planningRequest));
}

export function routeActionCandidates(input) {
  const values = recordValues(input, ROUTE_FIELDS, ROUTE_FIELDS,
    'candidate_router_input_invalid');
  const { planningRequest, moduleRegistry, candidates, nowEpochMs } = values;
  const request = capturePlanningRequest(planningRequest);
  const requestDeadline = timestampValue(request.deadline, 'planning_deadline_invalid').milliseconds;
  requireCondition(Number.isSafeInteger(nowEpochMs) && nowEpochMs >= 0,
    'candidate_router_clock_invalid');
  requireCondition(nowEpochMs < requestDeadline, 'planning_request_expired');
  const registry = registryBody(moduleRegistry);
  requireCondition(registry.snapshotHash === request.moduleRegistrySnapshotHash,
    'planning_registry_snapshot_mismatch');
  const modules = new Map(registry.body.modules.map((module) => [module.moduleId, module]));
  const submitted = denseArray(candidates, Math.min(request.candidateLimit, MAX_CANDIDATES),
    'candidate_collection_invalid');
  requireCondition(submitted.length > 0, 'candidate_frontier_empty');

  let submittedBytes = 0;
  const captured = submitted.map((raw) => {
    const candidate = captureCandidateDraft(raw, true);
    submittedBytes += byteLength(stableStringify(candidate));
    requireCondition(submittedBytes <= request.candidateBytesLimit,
      'candidate_collection_byte_limit');
    requireCondition(candidate.planningRequestId === request.planningRequestId,
      'candidate_planning_request_mismatch');
    requireCondition(candidate.stateSnapshotHash === request.stateSnapshotHash,
      'candidate_state_snapshot_mismatch');
    requireCondition(candidate.capabilityId === request.capabilityId,
      'candidate_capability_mismatch');
    requireCondition(request.allowedSideEffectClasses.includes(candidate.sideEffectClass),
      'candidate_side_effect_forbidden');
    const expiry = timestampValue(candidate.expiresAt, 'candidate_expiry_invalid').milliseconds;
    requireCondition(expiry > nowEpochMs && expiry <= requestDeadline, 'candidate_expired_or_outlives_request');
    const module = modules.get(candidate.moduleId);
    requireCondition(module && module.moduleVersion === candidate.moduleVersion,
      'candidate_module_binding_mismatch');
    requireCondition(module.capabilityIds.includes(candidate.capabilityId),
      'candidate_module_capability_mismatch');
    const expectedHash = hashRecord('ActionCandidateV1', candidateBodyWithoutHash(candidate));
    requireCondition(candidate.candidatePayloadHash === expectedHash,
      'candidate_payload_hash_mismatch');
    return candidate;
  });

  const byId = new Map();
  const byPayloadHash = new Map();
  let exactDuplicateCount = 0;
  for (const candidate of captured) {
    const bytes = stableStringify(candidate);
    const priorId = byId.get(candidate.candidateId);
    if (priorId) {
      requireCondition(priorId.bytes === bytes, 'candidate_id_conflict');
      exactDuplicateCount += 1;
      continue;
    }
    const priorPayload = byPayloadHash.get(candidate.candidatePayloadHash);
    requireCondition(!priorPayload || priorPayload.bytes === bytes,
      'candidate_payload_hash_conflict');
    byId.set(candidate.candidateId, { candidate, bytes });
    byPayloadHash.set(candidate.candidatePayloadHash, { candidate, bytes });
  }

  const semanticGroups = new Map();
  for (const { candidate } of byId.values()) {
    const body = semanticBody(candidate);
    const bytes = stableStringify(body);
    const semanticHash = hashRecord('ActionCandidateSemanticV1', body);
    const group = semanticGroups.get(semanticHash) || { bytes, candidates: [] };
    requireCondition(group.bytes === bytes, 'candidate_semantic_hash_conflict');
    group.candidates.push(candidate);
    semanticGroups.set(semanticHash, group);
  }
  const frontier = [];
  const deduplications = [];
  for (const [semanticHash, group] of semanticGroups) {
    const singletonReason = group.candidates[0].singletonReason ?? null;
    requireCondition(group.candidates.every((candidate) =>
      (candidate.singletonReason ?? null) === singletonReason),
    'candidate_semantic_metadata_conflict');
    group.candidates.sort((left, right) => compareText(left.candidateId, right.candidateId));
    frontier.push(group.candidates[0]);
    if (group.candidates.length > 1) {
      deduplications.push(Object.freeze({
        reason: 'semantic_duplicate',
        semanticCandidateHash: semanticHash,
        keptCandidateId: group.candidates[0].candidateId,
        removedCandidateIds: Object.freeze(group.candidates.slice(1).map((item) => item.candidateId)),
      }));
    }
  }
  frontier.sort((left, right) => compareText(
    `${left.moduleId}\0${left.moduleVersion}\0${left.candidateId}\0${left.candidatePayloadHash}`,
    `${right.moduleId}\0${right.moduleVersion}\0${right.candidateId}\0${right.candidatePayloadHash}`,
  ));
  deduplications.sort((left, right) => compareText(left.semanticCandidateHash,
    right.semanticCandidateHash));

  const perModule = new Map();
  for (const candidate of frontier) {
    const key = `${candidate.moduleId}\0${candidate.moduleVersion}`;
    perModule.set(key, [...(perModule.get(key) || []), candidate]);
  }
  for (const moduleCandidates of perModule.values()) {
    if (moduleCandidates.length === 1) {
      requireCondition(['only_feasible_candidate', 'protocol_does_not_support_alternatives']
        .includes(moduleCandidates[0].singletonReason), 'candidate_singleton_reason_required');
    } else {
      requireCondition(moduleCandidates.every((candidate) => candidate.singletonReason == null),
        'candidate_singleton_reason_conflict');
    }
  }

  const usedModules = Object.freeze([...new Set(frontier.map((candidate) => candidate.moduleId))]
    .sort(compareText).map((moduleId) => modules.get(moduleId)));
  const planningHash = hashRecord('PlanningRequestV1', request);
  const moduleBindingSetHash = hashRecord('CandidateModuleBindingSetV1', usedModules);
  const body = Object.freeze({
    version: 1,
    kind: 'CandidateFrontierV1',
    status: 'candidate_frontier_complete',
    planningRequestId: request.planningRequestId,
    planningRequestHash: planningHash,
    stateSnapshotHash: request.stateSnapshotHash,
    moduleRegistrySnapshotHash: registry.snapshotHash,
    moduleBindingSetHash,
    moduleBindings: usedModules,
    capabilityId: request.capabilityId,
    candidates: Object.freeze(frontier),
    deduplications: Object.freeze(deduplications),
    submittedCandidateCount: captured.length,
    exactDuplicateCount,
    canonicalCandidateCount: frontier.length,
    submittedCandidateBytes: submittedBytes,
    dominanceReductionApplied: false,
    dominanceReductionReason: 'context_substitutability_not_proven',
    complete: true,
    authority: Object.freeze({
      productionAuthorized: false,
      writerAuthorityGranted: false,
      providerAuthorityGranted: false,
      releaseAuthorityGranted: false,
      externalAuthorityClaimed: false,
    }),
  });
  return Object.freeze({ ...body, candidateSetHash: hashRecord('CandidateFrontierV1', body) });
}
