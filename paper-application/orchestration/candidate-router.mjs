import {
  boundedString,
  canonicalBytes,
  canonicalHash,
  captureJson,
  charge,
  compareTimestamp,
  compareUtf8,
  createBudget,
  denseArray,
  exactFalseAuthority,
  failure,
  finiteNumber,
  hash,
  identifier,
  ownDataRecord,
  safeInteger,
  sortedUniqueStrings,
  strictTimestamp,
} from './planning-canonical.mjs';

const API_FIELDS = Object.freeze(['planningRequest', 'candidates', 'qualifiedModules', 'now', 'limits']);
const LIMIT_FIELDS = Object.freeze([
  'maximumCandidates', 'maximumInputBytes', 'maximumCandidateBytes', 'maximumDepth',
  'maximumNodes', 'maximumCollectionItems', 'maximumObjectProperties',
  'maximumStringBytes', 'maximumModuleBindings', 'maximumCapabilitiesPerModule',
]);
const DEFAULT_LIMITS = Object.freeze({
  maximumCandidates: 256,
  maximumInputBytes: 8 * 1024 * 1024,
  maximumCandidateBytes: 256 * 1024,
  maximumDepth: 16,
  maximumNodes: 100_000,
  maximumCollectionItems: 65_536,
  maximumObjectProperties: 256,
  maximumStringBytes: 64 * 1024,
  maximumModuleBindings: 256,
  maximumCapabilitiesPerModule: 256,
});
const MAXIMA = Object.freeze({
  maximumCandidates: 1024,
  maximumInputBytes: 64 * 1024 * 1024,
  maximumCandidateBytes: 8 * 1024 * 1024,
  maximumDepth: 64,
  maximumNodes: 1_000_000,
  maximumCollectionItems: 1_000_000,
  maximumObjectProperties: 4096,
  maximumStringBytes: 1024 * 1024,
  maximumModuleBindings: 1024,
  maximumCapabilitiesPerModule: 1024,
});
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
const RESOURCE_FIELDS = Object.freeze([
  'cpuUnits', 'gpuUnits', 'memoryMiB', 'storageBytes', 'tokenCount', 'maximumCostMicrousd',
]);
const REQUIRED_RESOURCE_FIELDS = Object.freeze(['cpuUnits', 'gpuUnits', 'memoryMiB', 'storageBytes']);
const SINGLETON_REASONS = Object.freeze([
  'only_feasible_candidate', 'protocol_does_not_support_alternatives',
]);
const AUTHORITY_FIELDS = Object.freeze([
  'productionAuthorized', 'executionAuthorized', 'writerAuthorized',
  'providerAuthorized', 'releaseAuthorized', 'submissionAuthorized',
]);
const FRONTIER_FIELDS = Object.freeze([
  'schemaVersion', 'kind', 'status', 'observedAt', 'limits', 'planningRequest',
  'qualifiedModules', 'planningRequestHash', 'moduleBindingSetHash',
  'candidateCount', 'candidates', 'candidateSetHash', 'totalCapturedBytes', 'candidateBytes',
  'dominanceReductionApplied', 'dominanceDisposition', 'authority',
  'externalActionPerformed', 'candidateFrontierHash',
]);

function captureLimits(value = {}) {
  const raw = ownDataRecord(value, LIMIT_FIELDS, [], 'candidate_router_limits_invalid');
  const limits = {};
  for (const field of LIMIT_FIELDS) {
    const selected = Object.hasOwn(raw, field) ? raw[field] : DEFAULT_LIMITS[field];
    limits[field] = safeInteger(selected, 1, MAXIMA[field], 'candidate_router_limits_invalid');
  }
  if (limits.maximumCandidateBytes > limits.maximumInputBytes
    || limits.maximumCandidates > limits.maximumCollectionItems
    || limits.maximumModuleBindings > limits.maximumCollectionItems
    || limits.maximumCapabilitiesPerModule > limits.maximumCollectionItems) {
    throw failure('candidate_router_limits_invalid');
  }
  return Object.freeze(limits);
}

function capturePlanningRequest(raw, limits, budget, observedAt) {
  const input = ownDataRecord(raw, REQUEST_FIELDS, REQUEST_REQUIRED,
    'planning_request_invalid', budget);
  if (input.schemaVersion !== 1 || input.kind !== 'PlanningRequestV1') {
    throw failure('planning_request_invalid');
  }
  const created = strictTimestamp(input.createdAt, 'planning_request_time_invalid', budget);
  const expires = strictTimestamp(input.expiresAt, 'planning_request_time_invalid', budget);
  if (compareTimestamp(created, observedAt) > 0 || compareTimestamp(observedAt, expires) >= 0) {
    throw failure('planning_request_not_current');
  }
  const candidateLimit = safeInteger(input.candidateLimit, 1, limits.maximumCandidates,
    'planning_request_candidate_limit_invalid', budget);
  return Object.freeze({
    schemaVersion: 1,
    kind: 'PlanningRequestV1',
    planningRequestId: identifier(input.planningRequestId, 'planning_request_id_invalid', budget),
    stateSnapshotHash: hash(input.stateSnapshotHash, 'planning_request_snapshot_invalid', budget),
    capabilityId: identifier(input.capabilityId, 'planning_request_capability_invalid', budget),
    hardConstraintSetHash: hash(input.hardConstraintSetHash,
      'planning_request_constraints_invalid', budget),
    objectiveVersion: identifier(input.objectiveVersion,
      'planning_request_objective_invalid', budget),
    resourcePriceSnapshotHash: hash(input.resourcePriceSnapshotHash,
      'planning_request_prices_invalid', budget),
    candidateLimit,
    createdAt: created.text,
    expiresAt: expires.text,
    allowedSideEffectClasses: sortedUniqueStrings(input.allowedSideEffectClasses, 64,
      'planning_request_side_effects_invalid', budget, { minimum: 1 }),
    ...(Object.hasOwn(input, 'inputArtifactHashes') ? {
      inputArtifactHashes: sortedUniqueStrings(input.inputArtifactHashes, 1024,
        'planning_request_artifacts_invalid', budget, { hashes: true }),
    } : {}),
  });
}

function captureModules(raw, limits, budget) {
  const rows = denseArray(raw, limits.maximumModuleBindings,
    'candidate_module_bindings_invalid', budget);
  if (!rows.length) throw failure('candidate_module_bindings_invalid');
  const byKey = new Map();
  const modules = rows.map((value) => {
    const input = ownDataRecord(value, MODULE_FIELDS, MODULE_FIELDS,
      'candidate_module_binding_invalid', budget);
    if (Object.keys(input).length !== MODULE_FIELDS.length) {
      throw failure('candidate_module_binding_invalid');
    }
    const moduleId = identifier(input.moduleId, 'candidate_module_binding_invalid', budget);
    const moduleVersion = identifier(input.moduleVersion, 'candidate_module_binding_invalid', budget);
    const key = `${moduleId}\0${moduleVersion}`;
    if (byKey.has(key)) throw failure('candidate_module_binding_duplicate');
    const module = Object.freeze({
      moduleId,
      moduleVersion,
      capabilityIds: sortedUniqueStrings(input.capabilityIds,
        limits.maximumCapabilitiesPerModule, 'candidate_module_capabilities_invalid', budget,
        { minimum: 1 }),
      qualificationSubjectHash: hash(input.qualificationSubjectHash,
        'candidate_module_qualification_invalid', budget),
    });
    byKey.set(key, module);
    return module;
  }).sort((left, right) => compareUtf8(left.moduleId, right.moduleId)
    || compareUtf8(left.moduleVersion, right.moduleVersion));
  const list = Object.freeze(modules);
  return Object.freeze({ byKey, list,
    hash: canonicalHash('CandidateRouterModuleBindingSetV1', list) });
}

function captureResourceVector(raw, budget) {
  const input = ownDataRecord(raw, RESOURCE_FIELDS, REQUIRED_RESOURCE_FIELDS,
    'candidate_resource_vector_invalid', budget);
  const output = Object.create(null);
  for (const field of RESOURCE_FIELDS) {
    if (!Object.hasOwn(input, field)) continue;
    output[field] = ['cpuUnits', 'gpuUnits'].includes(field)
      ? finiteNumber(input[field], 0, Number.MAX_SAFE_INTEGER,
        `candidate_resource_value_invalid:${field}`, budget)
      : safeInteger(input[field], 0, Number.MAX_SAFE_INTEGER,
        `candidate_resource_value_invalid:${field}`, budget);
  }
  return Object.freeze(output);
}

function captureCandidateBody(raw, limits, budget) {
  const allowed = CANDIDATE_FIELDS.filter((field) => field !== 'candidatePayloadHash');
  const input = ownDataRecord(raw, allowed, CANDIDATE_REQUIRED,
    'action_candidate_invalid', budget);
  if (input.schemaVersion !== 1 || input.kind !== 'ActionCandidateV1') {
    throw failure('action_candidate_invalid');
  }
  return Object.freeze({
    schemaVersion: 1,
    kind: 'ActionCandidateV1',
    candidateId: identifier(input.candidateId, 'candidate_id_invalid', budget),
    planningRequestId: identifier(input.planningRequestId,
      'candidate_planning_request_invalid', budget),
    stateSnapshotHash: hash(input.stateSnapshotHash, 'candidate_snapshot_invalid', budget),
    moduleId: identifier(input.moduleId, 'candidate_module_invalid', budget),
    moduleVersion: identifier(input.moduleVersion, 'candidate_module_invalid', budget),
    capabilityId: identifier(input.capabilityId, 'candidate_capability_invalid', budget),
    resourceVector: captureResourceVector(input.resourceVector, budget),
    duration: captureJson(input.duration, limits, budget),
    cost: captureJson(input.cost, limits, budget),
    value: captureJson(input.value, limits, budget),
    risk: captureJson(input.risk, limits, budget),
    ...(Object.hasOwn(input, 'preconditions') ? {
      preconditions: sortedUniqueStrings(input.preconditions, 1024,
        'candidate_preconditions_invalid', budget),
    } : {}),
    ...(Object.hasOwn(input, 'dependencyEffects') ? {
      dependencyEffects: sortedUniqueStrings(input.dependencyEffects, 1024,
        'candidate_dependency_effects_invalid', budget),
    } : {}),
    sideEffectClass: boundedString(input.sideEffectClass,
      'candidate_side_effect_invalid', 256, budget),
    ...(Object.hasOwn(input, 'irreversibleBoundary') ? {
      irreversibleBoundary: input.irreversibleBoundary === null ? null
        : boundedString(input.irreversibleBoundary,
          'candidate_irreversible_boundary_invalid', limits.maximumStringBytes, budget),
    } : {}),
    rollbackClass: boundedString(input.rollbackClass,
      'candidate_rollback_invalid', 256, budget),
    expiresAt: strictTimestamp(input.expiresAt, 'candidate_expiry_invalid', budget).text,
    ...(Object.hasOwn(input, 'inputSchema') ? {
      inputSchema: input.inputSchema === null ? null
        : boundedString(input.inputSchema, 'candidate_input_schema_invalid',
          limits.maximumStringBytes, budget),
    } : {}),
    ...(Object.hasOwn(input, 'outputSchema') ? {
      outputSchema: input.outputSchema === null ? null
        : boundedString(input.outputSchema, 'candidate_output_schema_invalid',
          limits.maximumStringBytes, budget),
    } : {}),
    ...(Object.hasOwn(input, 'singletonReason') ? {
      singletonReason: input.singletonReason === null ? null
        : boundedString(input.singletonReason, 'candidate_singleton_reason_invalid', 256, budget),
    } : {}),
  });
}

function captureCandidate(raw, request, modules, limits, budget, observedAt) {
  const input = ownDataRecord(raw, CANDIDATE_FIELDS,
    [...CANDIDATE_REQUIRED, 'candidatePayloadHash'], 'action_candidate_invalid', budget);
  const candidatePayloadHash = hash(input.candidatePayloadHash,
    'candidate_payload_hash_invalid', budget);
  const bodyInput = Object.fromEntries(Object.entries(input)
    .filter(([key]) => key !== 'candidatePayloadHash'));
  const body = captureCandidateBody(bodyInput, limits, budget);
  const expectedHash = canonicalHash('ActionCandidateV1', body);
  if (candidatePayloadHash !== expectedHash) throw failure('candidate_payload_hash_invalid');
  if (body.planningRequestId !== request.planningRequestId
    || body.stateSnapshotHash !== request.stateSnapshotHash
    || body.capabilityId !== request.capabilityId) throw failure('candidate_request_binding_mismatch');
  const module = modules.byKey.get(`${body.moduleId}\0${body.moduleVersion}`);
  if (!module || !module.capabilityIds.includes(body.capabilityId)) {
    throw failure('candidate_module_binding_mismatch');
  }
  const expiry = strictTimestamp(body.expiresAt, 'candidate_expiry_invalid');
  const requestExpiry = strictTimestamp(request.expiresAt, 'planning_request_time_invalid');
  if (compareTimestamp(expiry, observedAt) <= 0 || compareTimestamp(expiry, requestExpiry) > 0) {
    throw failure('candidate_not_current');
  }
  if (!request.allowedSideEffectClasses.includes(body.sideEffectClass)) {
    throw failure('candidate_side_effect_forbidden');
  }
  const candidate = Object.freeze({ ...body, candidatePayloadHash: expectedHash });
  const bytes = canonicalBytes(candidate).length;
  if (bytes > limits.maximumCandidateBytes) throw failure('candidate_byte_limit');
  return Object.freeze({ candidate, bytes });
}

export function hashActionCandidateV1(rawInput) {
  const input = ownDataRecord(rawInput, ['candidate', 'limits'], ['candidate'],
    'candidate_hash_request_invalid');
  const limits = captureLimits(Object.hasOwn(input, 'limits') ? input.limits : {});
  const budget = createBudget(limits, 'candidate_router_input_limit');
  const recaptured = ownDataRecord(rawInput, ['candidate', 'limits'], ['candidate'],
    'candidate_hash_request_invalid', budget);
  return canonicalHash('ActionCandidateV1',
    captureCandidateBody(recaptured.candidate, limits, budget));
}

function buildFrontier(rawInput) {
  const bootstrap = ownDataRecord(rawInput, API_FIELDS,
    ['planningRequest', 'candidates', 'qualifiedModules', 'now'],
    'candidate_router_request_invalid');
  const limits = captureLimits(Object.hasOwn(bootstrap, 'limits') ? bootstrap.limits : {});
  const budget = createBudget(limits, 'candidate_router_input_limit');
  const input = ownDataRecord(rawInput, API_FIELDS,
    ['planningRequest', 'candidates', 'qualifiedModules', 'now'],
    'candidate_router_request_invalid', budget);
  const observedAt = strictTimestamp(input.now, 'candidate_router_now_invalid', budget);
  const request = capturePlanningRequest(input.planningRequest, limits, budget, observedAt);
  const modules = captureModules(input.qualifiedModules, limits, budget);
  const rows = denseArray(input.candidates, limits.maximumCandidates,
    'candidate_collection_invalid', budget);
  if (!rows.length || rows.length > request.candidateLimit) throw failure('candidate_count_limit');
  const byId = new Map(); const byHash = new Map(); const selected = [];
  let candidateBytes = 0;
  for (const rawCandidate of rows) {
    const captured = captureCandidate(rawCandidate, request, modules, limits, budget, observedAt);
    candidateBytes += captured.bytes;
    const priorId = byId.get(captured.candidate.candidateId);
    const priorHash = byHash.get(captured.candidate.candidatePayloadHash);
    const canonical = canonicalBytes(captured.candidate).toString('utf8');
    if (priorId && priorId !== canonical) throw failure('candidate_id_conflict');
    if (priorHash && priorHash !== canonical) throw failure('candidate_hash_conflict');
    if (priorId || priorHash) continue;
    byId.set(captured.candidate.candidateId, canonical);
    byHash.set(captured.candidate.candidatePayloadHash, canonical);
    selected.push(captured.candidate);
  }
  selected.sort((left, right) => compareUtf8(left.candidatePayloadHash,
    right.candidatePayloadHash) || compareUtf8(left.candidateId, right.candidateId));
  if (selected.length === 1) {
    if (!SINGLETON_REASONS.includes(selected[0].singletonReason)) {
      throw failure('candidate_singleton_reason_required');
    }
  } else if (selected.some((candidate) => candidate.singletonReason != null)) {
    throw failure('candidate_singleton_reason_forbidden');
  }
  const candidates = Object.freeze(selected);
  const candidateSetHash = canonicalHash('CandidateSetV1', candidates);
  const totalCapturedBytes = canonicalBytes({ planningRequest: request, qualifiedModules: modules.list,
    candidates, now: observedAt.text, limits }).length;
  if (totalCapturedBytes > limits.maximumInputBytes) throw failure('candidate_router_input_limit');
  const body = Object.freeze({
    schemaVersion: 1,
    kind: 'CandidateFrontierV1',
    status: 'complete_deterministic_frontier',
    observedAt: observedAt.text,
    limits,
    planningRequest: request,
    qualifiedModules: modules.list,
    planningRequestHash: canonicalHash('PlanningRequestV1', request),
    moduleBindingSetHash: modules.hash,
    candidateCount: candidates.length,
    candidates,
    candidateSetHash,
    totalCapturedBytes,
    candidateBytes,
    dominanceReductionApplied: false,
    dominanceDisposition: 'retained_without_context_safe_replacement_certificate',
    authority: Object.freeze(Object.fromEntries(AUTHORITY_FIELDS.map((key) => [key, false]))),
    externalActionPerformed: false,
  });
  if (canonicalBytes(body).length > limits.maximumInputBytes) {
    throw failure('candidate_router_output_byte_limit');
  }
  return Object.freeze({ ...body,
    candidateFrontierHash: canonicalHash('CandidateFrontierV1', body) });
}

export function routeActionCandidates(rawInput) {
  return buildFrontier(rawInput);
}

export function verifyCandidateFrontierV1(rawFrontier) {
  const outer = ownDataRecord(rawFrontier, FRONTIER_FIELDS, FRONTIER_FIELDS,
    'candidate_frontier_invalid');
  if (outer.schemaVersion !== 1 || outer.kind !== 'CandidateFrontierV1'
    || outer.externalActionPerformed !== false) throw failure('candidate_frontier_invalid');
  exactFalseAuthority(outer.authority, AUTHORITY_FIELDS, 'candidate_frontier_authority_invalid');
  const rebuilt = buildFrontier({
    planningRequest: outer.planningRequest,
    candidates: outer.candidates,
    qualifiedModules: outer.qualifiedModules,
    now: outer.observedAt,
    limits: outer.limits,
  });
  if (canonicalBytes(rebuilt).compare(canonicalBytes(rawFrontier)) !== 0) {
    throw failure('candidate_frontier_verification_mismatch');
  }
  return rebuilt;
}
