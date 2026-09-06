import { hashRecord, stableStringify } from '../../workflow-kernel/record-hash.mjs';

const HASH = /^sha256:[0-9a-f]{64}$/u;
const MODULE_ID = /^module\.[a-z0-9][a-z0-9-]{0,95}$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,191}$/u;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,127}$/u;
const QUALIFICATION_STATES = new Set([
  'source_qualified', 'target_host_qualified', 'external_authority_qualified',
]);
const READ_AUTHORITIES = new Set(['pure', 'read_only']);
const LIMITS = Object.freeze({
  projections: 2048,
  projectionBytes: 2 * 1024 * 1024,
  totalProjectionBytes: 32 * 1024 * 1024,
  valueNodes: 65536,
  valueDepth: 32,
  stringLength: 65536,
});

const REQUEST_FIELDS = Object.freeze([
  'schemaVersion', 'kind', 'snapshotId', 'moduleRegistryHash', 'policySetHash',
  'resourcePriceSnapshotHash', 'objectiveVersion', 'qualifiedProjectionSetHash',
  'issuedAt', 'builtAt', 'deadline', 'maximumProjectionBytes',
  'maximumTotalProjectionBytes',
]);
const SOURCE_FIELDS = Object.freeze([
  'projectionId', 'projectionVersion', 'moduleId', 'moduleVersion',
  'authorityClass', 'qualificationStatus', 'qualificationIdentity',
  'maximumAgeMilliseconds',
]);
const PROJECTION_FIELDS = Object.freeze([
  'schemaVersion', 'kind', 'projectionId', 'projectionVersion', 'moduleId',
  'moduleVersion', 'sourceGeneration', 'observedAt', 'validUntil', 'payload',
  'payloadHash',
]);
const SNAPSHOT_PROJECTION_FIELDS = Object.freeze([
  'schemaVersion', 'kind', 'projectionId', 'projectionVersion', 'moduleId',
  'moduleVersion', 'authorityClass', 'qualificationStatus',
  'qualificationIdentity', 'maximumAgeMilliseconds', 'sourceGeneration',
  'observedAt', 'validUntil', 'payload', 'payloadHash',
]);
const SNAPSHOT_FIELDS = Object.freeze([
  'schemaVersion', 'kind', 'status', 'snapshotId', 'moduleRegistryHash',
  'policySetHash', 'resourcePriceSnapshotHash', 'objectiveVersion',
  'qualifiedProjectionSetHash', 'buildRequestHash', 'issuedAt', 'builtAt',
  'deadline', 'expiresAt', 'maximumProjectionBytes',
  'maximumTotalProjectionBytes', 'projectionCount', 'projectionSetHash',
  'projections', 'consumerMustRevalidateBeforePlanning', 'authority',
  'stateSnapshotHash',
]);
const AUTHORITY_FIELDS = Object.freeze([
  'centralWriteAuthorized', 'executionAuthorized', 'providerAuthorized',
  'releaseAuthorized', 'externalAuthorityClaimed',
]);

function fail(code) {
  throw Object.assign(new Error(code), { code, retryable: false });
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function record(value, allowed, code) {
  if (!value || typeof value !== 'object'
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(code);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(value);
  if (keys.length > LIMITS.valueNodes || keys.some((key) => typeof key !== 'string'
    || (allowed && !allowed.includes(key)))) fail(code);
  const output = Object.create(null);
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail(code);
    output[key] = descriptor.value;
  }
  return output;
}

function exactRecord(value, fields, code) {
  const output = record(value, fields, code);
  if (Object.keys(output).length !== fields.length
    || fields.some((field) => !Object.hasOwn(output, field))) fail(code);
  return output;
}

function dense(value, maximum, code, minimum = 0) {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) fail(code);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).length !== value.length + 1) fail(code);
  const output = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[index];
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail(code);
    output.push(descriptor.value);
  }
  return output;
}

function text(value, pattern, code) {
  if (typeof value !== 'string' || !pattern.test(value) || value.includes('\0')) fail(code);
  return value;
}

function hash(value, code) {
  return text(value, HASH, code);
}

function integer(value, minimum, maximum, code) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) fail(code);
  return value;
}

function timestamp(value, code) {
  if (typeof value !== 'string' || value.length > 40) fail(code);
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) fail(code);
  const canonical = new Date(milliseconds).toISOString();
  if (value !== canonical && value !== canonical.replace('.000Z', 'Z')) fail(code);
  return canonical;
}

function captureValue(value, state, depth = 0) {
  state.nodes += 1;
  if (state.nodes > LIMITS.valueNodes || depth > LIMITS.valueDepth) {
    fail('snapshot_projection_value_structure_limit');
  }
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (value.length > LIMITS.stringLength || value.includes('\0')) {
      fail('snapshot_projection_value_string_invalid');
    }
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('snapshot_projection_value_number_invalid');
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== 'object') fail('snapshot_projection_value_type_invalid');
  if (state.stack.has(value)) fail('snapshot_projection_value_cycle');
  state.stack.add(value);
  try {
    if (Array.isArray(value)) {
      return Object.freeze(dense(value, LIMITS.valueNodes,
        'snapshot_projection_value_array_invalid')
        .map((entry) => captureValue(entry, state, depth + 1)));
    }
    const data = record(value, null, 'snapshot_projection_value_record_invalid');
    const output = {};
    for (const key of Object.keys(data).sort(compareText)) {
      if (!key.length || key.length > 256 || key.includes('\0')) {
        fail('snapshot_projection_value_key_invalid');
      }
      output[key] = captureValue(data[key], state, depth + 1);
    }
    return Object.freeze(output);
  } finally {
    state.stack.delete(value);
  }
}

function payload(value) {
  return captureValue(value, { nodes: 0, stack: new WeakSet() });
}

function normalizeSource(value) {
  const data = exactRecord(value, SOURCE_FIELDS, 'snapshot_projection_source_invalid');
  const qualificationStatus = text(
    data.qualificationStatus, TOKEN, 'snapshot_projection_source_qualification_invalid',
  );
  const authorityClass = text(
    data.authorityClass, TOKEN, 'snapshot_projection_source_authority_invalid',
  );
  if (!QUALIFICATION_STATES.has(qualificationStatus)) {
    fail('snapshot_projection_source_qualification_invalid');
  }
  if (!READ_AUTHORITIES.has(authorityClass)) {
    fail('snapshot_projection_source_authority_invalid');
  }
  return Object.freeze({
    projectionId: text(data.projectionId, IDENTIFIER, 'snapshot_projection_id_invalid'),
    projectionVersion: text(
      data.projectionVersion, TOKEN, 'snapshot_projection_version_invalid',
    ),
    moduleId: text(data.moduleId, MODULE_ID, 'snapshot_projection_module_invalid'),
    moduleVersion: text(
      data.moduleVersion, TOKEN, 'snapshot_projection_module_version_invalid',
    ),
    authorityClass,
    qualificationStatus,
    qualificationIdentity: hash(
      data.qualificationIdentity, 'snapshot_projection_qualification_identity_invalid',
    ),
    maximumAgeMilliseconds: integer(
      data.maximumAgeMilliseconds, 0, Number.MAX_SAFE_INTEGER,
      'snapshot_projection_maximum_age_invalid',
    ),
  });
}

function sourceComparator(left, right) {
  return compareText(
    `${left.projectionId}\0${left.moduleId}\0${left.moduleVersion}`,
    `${right.projectionId}\0${right.moduleId}\0${right.moduleVersion}`,
  );
}

export function captureQualifiedProjectionSourceSetV1(value) {
  const sources = dense(value, LIMITS.projections, 'snapshot_projection_source_set_invalid', 1)
    .map(normalizeSource).sort(sourceComparator);
  const projectionIds = new Set();
  for (const source of sources) {
    if (projectionIds.has(source.projectionId)) fail('snapshot_projection_source_duplicate');
    projectionIds.add(source.projectionId);
  }
  const frozen = Object.freeze(sources);
  return Object.freeze({
    sources: frozen,
    qualifiedProjectionSetHash: hashRecord('QualifiedProjectionSourceSetV1', frozen),
  });
}

function normalizeRequest(value) {
  const data = exactRecord(value, REQUEST_FIELDS, 'snapshot_build_request_invalid');
  if (data.schemaVersion !== 1 || data.kind !== 'SnapshotBuildRequestV1') {
    fail('snapshot_build_request_identity_invalid');
  }
  const issuedAt = timestamp(data.issuedAt, 'snapshot_build_request_issued_at_invalid');
  const builtAt = timestamp(data.builtAt, 'snapshot_build_request_built_at_invalid');
  const deadline = timestamp(data.deadline, 'snapshot_build_request_deadline_invalid');
  if (Date.parse(issuedAt) > Date.parse(builtAt)
    || Date.parse(builtAt) > Date.parse(deadline)) {
    fail('snapshot_build_request_time_order_invalid');
  }
  const maximumProjectionBytes = integer(
    data.maximumProjectionBytes, 256, LIMITS.projectionBytes,
    'snapshot_build_projection_byte_limit_invalid',
  );
  const maximumTotalProjectionBytes = integer(
    data.maximumTotalProjectionBytes, maximumProjectionBytes,
    LIMITS.totalProjectionBytes, 'snapshot_build_total_byte_limit_invalid',
  );
  return Object.freeze({
    schemaVersion: 1,
    kind: 'SnapshotBuildRequestV1',
    snapshotId: text(data.snapshotId, IDENTIFIER, 'snapshot_id_invalid'),
    moduleRegistryHash: hash(data.moduleRegistryHash, 'snapshot_registry_hash_invalid'),
    policySetHash: hash(data.policySetHash, 'snapshot_policy_hash_invalid'),
    resourcePriceSnapshotHash: hash(
      data.resourcePriceSnapshotHash, 'snapshot_resource_price_hash_invalid',
    ),
    objectiveVersion: text(data.objectiveVersion, TOKEN, 'snapshot_objective_version_invalid'),
    qualifiedProjectionSetHash: hash(
      data.qualifiedProjectionSetHash, 'snapshot_projection_set_binding_invalid',
    ),
    issuedAt,
    builtAt,
    deadline,
    maximumProjectionBytes,
    maximumTotalProjectionBytes,
  });
}

function normalizeProjection(value, requireHash = true) {
  const data = record(value, PROJECTION_FIELDS, 'read_only_projection_invalid');
  const required = PROJECTION_FIELDS.filter((field) => field !== 'payloadHash');
  if (required.some((field) => !Object.hasOwn(data, field))
    || (requireHash && !Object.hasOwn(data, 'payloadHash'))
    || (!requireHash && Object.hasOwn(data, 'payloadHash'))
    || Object.keys(data).length !== required.length + (requireHash ? 1 : 0)) {
    fail('read_only_projection_invalid');
  }
  if (data.schemaVersion !== 1 || data.kind !== 'ReadOnlyProjectionV1') {
    fail('read_only_projection_identity_invalid');
  }
  const capturedPayload = payload(data.payload);
  const payloadHash = hashRecord('ReadOnlyProjectionPayloadV1', capturedPayload);
  if (requireHash && data.payloadHash !== payloadHash) fail('read_only_projection_payload_hash_invalid');
  return Object.freeze({
    schemaVersion: 1,
    kind: 'ReadOnlyProjectionV1',
    projectionId: text(data.projectionId, IDENTIFIER, 'read_only_projection_id_invalid'),
    projectionVersion: text(
      data.projectionVersion, TOKEN, 'read_only_projection_version_invalid',
    ),
    moduleId: text(data.moduleId, MODULE_ID, 'read_only_projection_module_invalid'),
    moduleVersion: text(
      data.moduleVersion, TOKEN, 'read_only_projection_module_version_invalid',
    ),
    sourceGeneration: integer(
      data.sourceGeneration, 1, Number.MAX_SAFE_INTEGER,
      'read_only_projection_generation_invalid',
    ),
    observedAt: timestamp(data.observedAt, 'read_only_projection_observed_at_invalid'),
    validUntil: timestamp(data.validUntil, 'read_only_projection_valid_until_invalid'),
    payload: capturedPayload,
    payloadHash,
  });
}

export function sealReadOnlyProjectionV1(value) {
  return normalizeProjection(value, false);
}

function snapshotProjection(projection, source, builtAt) {
  if (projection.projectionId !== source.projectionId
    || projection.projectionVersion !== source.projectionVersion
    || projection.moduleId !== source.moduleId
    || projection.moduleVersion !== source.moduleVersion) {
    fail('read_only_projection_source_binding_mismatch');
  }
  const observed = Date.parse(projection.observedAt);
  const built = Date.parse(builtAt);
  const validUntil = Date.parse(projection.validUntil);
  if (observed > built || built > validUntil
    || built - observed > source.maximumAgeMilliseconds) {
    fail('read_only_projection_stale_or_not_current');
  }
  return Object.freeze({
    schemaVersion: 1,
    kind: 'SnapshotProjectionV1',
    projectionId: projection.projectionId,
    projectionVersion: projection.projectionVersion,
    moduleId: projection.moduleId,
    moduleVersion: projection.moduleVersion,
    authorityClass: source.authorityClass,
    qualificationStatus: source.qualificationStatus,
    qualificationIdentity: source.qualificationIdentity,
    maximumAgeMilliseconds: source.maximumAgeMilliseconds,
    sourceGeneration: projection.sourceGeneration,
    observedAt: projection.observedAt,
    validUntil: projection.validUntil,
    payload: projection.payload,
    payloadHash: projection.payloadHash,
  });
}

function falseAuthority(value, code) {
  const data = exactRecord(value, AUTHORITY_FIELDS, code);
  if (AUTHORITY_FIELDS.some((field) => data[field] !== false)) fail(code);
  return Object.freeze(Object.fromEntries(AUTHORITY_FIELDS.map((field) => [field, false])));
}

function authority() {
  return Object.freeze(Object.fromEntries(AUTHORITY_FIELDS.map((field) => [field, false])));
}

export function buildControlPlaneSnapshotV1(value) {
  const input = exactRecord(value,
    ['request', 'qualifiedProjectionSources', 'projections'],
    'snapshot_build_input_invalid');
  const request = normalizeRequest(input.request);
  const qualified = captureQualifiedProjectionSourceSetV1(input.qualifiedProjectionSources);
  if (request.qualifiedProjectionSetHash !== qualified.qualifiedProjectionSetHash) {
    fail('snapshot_projection_set_binding_mismatch');
  }
  const raw = dense(input.projections, LIMITS.projections,
    'snapshot_projection_collection_invalid', qualified.sources.length);
  if (raw.length !== qualified.sources.length) fail('snapshot_projection_coverage_invalid');
  const byId = new Map();
  let totalBytes = 0;
  for (const item of raw) {
    const projection = normalizeProjection(item, true);
    if (byId.has(projection.projectionId)) fail('snapshot_projection_duplicate');
    const bytes = Buffer.byteLength(stableStringify(projection.payload), 'utf8');
    if (bytes > request.maximumProjectionBytes) fail('snapshot_projection_byte_limit');
    totalBytes += bytes;
    if (totalBytes > request.maximumTotalProjectionBytes) fail('snapshot_total_byte_limit');
    byId.set(projection.projectionId, projection);
  }
  const projections = Object.freeze(qualified.sources.map((source) => {
    const projection = byId.get(source.projectionId);
    if (!projection) fail('snapshot_projection_coverage_invalid');
    return snapshotProjection(projection, source, request.builtAt);
  }));
  const expiresAt = new Date(Math.min(
    Date.parse(request.deadline), ...projections.map((item) => Date.parse(item.validUntil)),
  )).toISOString();
  const projectionSetHash = hashRecord('SnapshotProjectionSetV1', projections);
  const buildRequestHash = hashRecord('SnapshotBuildRequestV1', request);
  const body = Object.freeze({
    schemaVersion: 1,
    kind: 'ControlPlaneSnapshotV1',
    status: 'control_plane_snapshot_ready',
    snapshotId: request.snapshotId,
    moduleRegistryHash: request.moduleRegistryHash,
    policySetHash: request.policySetHash,
    resourcePriceSnapshotHash: request.resourcePriceSnapshotHash,
    objectiveVersion: request.objectiveVersion,
    qualifiedProjectionSetHash: qualified.qualifiedProjectionSetHash,
    buildRequestHash,
    issuedAt: request.issuedAt,
    builtAt: request.builtAt,
    deadline: request.deadline,
    expiresAt,
    maximumProjectionBytes: request.maximumProjectionBytes,
    maximumTotalProjectionBytes: request.maximumTotalProjectionBytes,
    projectionCount: projections.length,
    projectionSetHash,
    projections,
    consumerMustRevalidateBeforePlanning: true,
    authority: authority(),
  });
  return Object.freeze({
    ...body,
    stateSnapshotHash: hashRecord('ControlPlaneSnapshotV1', body),
  });
}

function normalizeSnapshotProjection(value) {
  const data = exactRecord(value, SNAPSHOT_PROJECTION_FIELDS, 'snapshot_projection_invalid');
  if (data.schemaVersion !== 1 || data.kind !== 'SnapshotProjectionV1') {
    fail('snapshot_projection_identity_invalid');
  }
  const capturedPayload = payload(data.payload);
  const payloadHash = hashRecord('ReadOnlyProjectionPayloadV1', capturedPayload);
  if (data.payloadHash !== payloadHash) fail('snapshot_projection_payload_hash_invalid');
  const authorityClass = text(data.authorityClass, TOKEN, 'snapshot_projection_authority_invalid');
  const qualificationStatus = text(
    data.qualificationStatus, TOKEN, 'snapshot_projection_qualification_invalid',
  );
  if (!READ_AUTHORITIES.has(authorityClass)) fail('snapshot_projection_authority_invalid');
  if (!QUALIFICATION_STATES.has(qualificationStatus)) fail('snapshot_projection_qualification_invalid');
  return Object.freeze({
    schemaVersion: 1,
    kind: 'SnapshotProjectionV1',
    projectionId: text(data.projectionId, IDENTIFIER, 'snapshot_projection_id_invalid'),
    projectionVersion: text(data.projectionVersion, TOKEN, 'snapshot_projection_version_invalid'),
    moduleId: text(data.moduleId, MODULE_ID, 'snapshot_projection_module_invalid'),
    moduleVersion: text(data.moduleVersion, TOKEN, 'snapshot_projection_module_version_invalid'),
    authorityClass,
    qualificationStatus,
    qualificationIdentity: hash(data.qualificationIdentity, 'snapshot_projection_qualification_identity_invalid'),
    maximumAgeMilliseconds: integer(data.maximumAgeMilliseconds, 0, Number.MAX_SAFE_INTEGER,
      'snapshot_projection_maximum_age_invalid'),
    sourceGeneration: integer(data.sourceGeneration, 1, Number.MAX_SAFE_INTEGER,
      'snapshot_projection_generation_invalid'),
    observedAt: timestamp(data.observedAt, 'snapshot_projection_observed_at_invalid'),
    validUntil: timestamp(data.validUntil, 'snapshot_projection_valid_until_invalid'),
    payload: capturedPayload,
    payloadHash,
  });
}

function sourceFromSnapshotProjection(projection) {
  return Object.freeze({
    projectionId: projection.projectionId,
    projectionVersion: projection.projectionVersion,
    moduleId: projection.moduleId,
    moduleVersion: projection.moduleVersion,
    authorityClass: projection.authorityClass,
    qualificationStatus: projection.qualificationStatus,
    qualificationIdentity: projection.qualificationIdentity,
    maximumAgeMilliseconds: projection.maximumAgeMilliseconds,
  });
}

function captureSnapshot(value) {
  const data = exactRecord(value, SNAPSHOT_FIELDS, 'control_plane_snapshot_invalid');
  if (data.schemaVersion !== 1 || data.kind !== 'ControlPlaneSnapshotV1'
    || data.status !== 'control_plane_snapshot_ready'
    || data.consumerMustRevalidateBeforePlanning !== true) {
    fail('control_plane_snapshot_identity_invalid');
  }
  const projections = Object.freeze(dense(data.projections, LIMITS.projections,
    'snapshot_projection_collection_invalid', 1).map(normalizeSnapshotProjection));
  if (data.projectionCount !== projections.length) fail('snapshot_projection_count_invalid');
  const ordered = [...projections].sort((left, right) => compareText(
    left.projectionId, right.projectionId,
  ));
  if (stableStringify(ordered) !== stableStringify(projections)) fail('snapshot_projection_order_invalid');
  if (new Set(projections.map((item) => item.projectionId)).size !== projections.length) {
    fail('snapshot_projection_duplicate');
  }
  const maximumProjectionBytes = integer(data.maximumProjectionBytes, 256,
    LIMITS.projectionBytes, 'snapshot_build_projection_byte_limit_invalid');
  const maximumTotalProjectionBytes = integer(data.maximumTotalProjectionBytes,
    maximumProjectionBytes, LIMITS.totalProjectionBytes,
    'snapshot_build_total_byte_limit_invalid');
  let totalBytes = 0;
  for (const projection of projections) {
    const bytes = Buffer.byteLength(stableStringify(projection.payload), 'utf8');
    if (bytes > maximumProjectionBytes) fail('snapshot_projection_byte_limit');
    totalBytes += bytes;
    if (totalBytes > maximumTotalProjectionBytes) fail('snapshot_total_byte_limit');
  }
  const derivedSources = captureQualifiedProjectionSourceSetV1(
    projections.map(sourceFromSnapshotProjection),
  );
  if (data.qualifiedProjectionSetHash !== derivedSources.qualifiedProjectionSetHash) {
    fail('snapshot_projection_set_binding_mismatch');
  }
  const projectionSetHash = hashRecord('SnapshotProjectionSetV1', projections);
  if (data.projectionSetHash !== projectionSetHash) fail('snapshot_projection_set_hash_invalid');
  const request = normalizeRequest({
    schemaVersion: 1,
    kind: 'SnapshotBuildRequestV1',
    snapshotId: data.snapshotId,
    moduleRegistryHash: data.moduleRegistryHash,
    policySetHash: data.policySetHash,
    resourcePriceSnapshotHash: data.resourcePriceSnapshotHash,
    objectiveVersion: data.objectiveVersion,
    qualifiedProjectionSetHash: data.qualifiedProjectionSetHash,
    issuedAt: data.issuedAt,
    builtAt: data.builtAt,
    deadline: data.deadline,
    maximumProjectionBytes,
    maximumTotalProjectionBytes,
  });
  const buildRequestHash = hashRecord('SnapshotBuildRequestV1', request);
  if (data.buildRequestHash !== buildRequestHash) fail('snapshot_build_request_hash_invalid');
  const snapshotAuthority = falseAuthority(data.authority,
    'control_plane_snapshot_authority_invalid');
  const expiresAt = timestamp(data.expiresAt, 'snapshot_expires_at_invalid');
  const expectedExpiresAt = new Date(Math.min(
    Date.parse(request.deadline), ...projections.map((item) => Date.parse(item.validUntil)),
  )).toISOString();
  if (expiresAt !== expectedExpiresAt) fail('control_plane_snapshot_expiry_invalid');
  const built = Date.parse(request.builtAt);
  for (const projection of projections) {
    const observed = Date.parse(projection.observedAt);
    const validUntil = Date.parse(projection.validUntil);
    if (observed > built || built > validUntil
      || built - observed > projection.maximumAgeMilliseconds) {
      fail('control_plane_snapshot_projection_time_invalid');
    }
  }
  const body = Object.freeze({
    schemaVersion: 1,
    kind: 'ControlPlaneSnapshotV1',
    status: 'control_plane_snapshot_ready',
    snapshotId: request.snapshotId,
    moduleRegistryHash: request.moduleRegistryHash,
    policySetHash: request.policySetHash,
    resourcePriceSnapshotHash: request.resourcePriceSnapshotHash,
    objectiveVersion: request.objectiveVersion,
    qualifiedProjectionSetHash: request.qualifiedProjectionSetHash,
    buildRequestHash,
    issuedAt: request.issuedAt,
    builtAt: request.builtAt,
    deadline: request.deadline,
    expiresAt,
    maximumProjectionBytes,
    maximumTotalProjectionBytes,
    projectionCount: projections.length,
    projectionSetHash,
    projections,
    consumerMustRevalidateBeforePlanning: true,
    authority: snapshotAuthority,
  });
  const stateSnapshotHash = hashRecord('ControlPlaneSnapshotV1', body);
  if (data.stateSnapshotHash !== stateSnapshotHash) fail('control_plane_snapshot_hash_invalid');
  return Object.freeze({ ...body, stateSnapshotHash });
}

export function revalidateControlPlaneSnapshotV1(value) {
  const input = exactRecord(value, [
    'snapshot', 'observedAt', 'moduleRegistryHash', 'policySetHash',
    'resourcePriceSnapshotHash', 'objectiveVersion', 'qualifiedProjectionSetHash',
    'currentProjectionGenerations',
  ], 'snapshot_revalidation_input_invalid');
  const snapshot = captureSnapshot(input.snapshot);
  const observedAt = timestamp(input.observedAt, 'snapshot_revalidation_time_invalid');
  if (Date.parse(observedAt) < Date.parse(snapshot.builtAt)
    || Date.parse(observedAt) > Date.parse(snapshot.expiresAt)) {
    fail('control_plane_snapshot_expired_or_time_invalid');
  }
  if (input.moduleRegistryHash !== snapshot.moduleRegistryHash
    || input.policySetHash !== snapshot.policySetHash
    || input.resourcePriceSnapshotHash !== snapshot.resourcePriceSnapshotHash
    || input.objectiveVersion !== snapshot.objectiveVersion
    || input.qualifiedProjectionSetHash !== snapshot.qualifiedProjectionSetHash) {
    fail('control_plane_snapshot_context_changed');
  }
  const generations = dense(input.currentProjectionGenerations, LIMITS.projections,
    'snapshot_generation_set_invalid', snapshot.projections.length).map((item) => {
    const data = exactRecord(item, ['projectionId', 'sourceGeneration'],
      'snapshot_generation_invalid');
    return Object.freeze({
      projectionId: text(data.projectionId, IDENTIFIER, 'snapshot_generation_projection_invalid'),
      sourceGeneration: integer(data.sourceGeneration, 1, Number.MAX_SAFE_INTEGER,
        'snapshot_generation_value_invalid'),
    });
  }).sort((left, right) => compareText(left.projectionId, right.projectionId));
  if (generations.length !== snapshot.projections.length
    || new Set(generations.map((item) => item.projectionId)).size !== generations.length) {
    fail('snapshot_generation_coverage_invalid');
  }
  for (let index = 0; index < snapshot.projections.length; index += 1) {
    const projection = snapshot.projections[index];
    const current = generations[index];
    if (current.projectionId !== projection.projectionId
      || current.sourceGeneration !== projection.sourceGeneration) {
      fail('control_plane_snapshot_generation_changed');
    }
  }
  const frozenGenerations = Object.freeze(generations);
  const body = Object.freeze({
    schemaVersion: 1,
    kind: 'ControlPlaneSnapshotCurrentnessReceiptV1',
    status: 'control_plane_snapshot_current',
    stateSnapshotHash: snapshot.stateSnapshotHash,
    buildRequestHash: snapshot.buildRequestHash,
    observedAt,
    moduleRegistryHash: snapshot.moduleRegistryHash,
    policySetHash: snapshot.policySetHash,
    resourcePriceSnapshotHash: snapshot.resourcePriceSnapshotHash,
    objectiveVersion: snapshot.objectiveVersion,
    qualifiedProjectionSetHash: snapshot.qualifiedProjectionSetHash,
    currentGenerationSetHash: hashRecord('CurrentProjectionGenerationSetV1', frozenGenerations),
    currentProjectionGenerations: frozenGenerations,
    authority: authority(),
  });
  return Object.freeze({
    ...body,
    currentnessReceiptHash: hashRecord('ControlPlaneSnapshotCurrentnessReceiptV1', body),
  });
}
