import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

export const SNAPSHOT_LIMITS = Object.freeze({
  projections: 2048,
  projectionBytes: 2 * 1024 * 1024,
  totalProjectionBytes: 32 * 1024 * 1024,
  valueNodes: 65536,
  valueDepth: 32,
  stringLength: 65536,
});

export const SNAPSHOT_REQUEST_FIELDS = Object.freeze([
  'schemaVersion', 'kind', 'snapshotId', 'moduleRegistryHash', 'policySetHash',
  'resourcePriceSnapshotHash', 'objectiveVersion', 'qualifiedProjectionSetHash',
  'issuedAt', 'builtAt', 'deadline', 'maximumProjectionBytes',
  'maximumTotalProjectionBytes',
]);
export const SNAPSHOT_FIELDS = Object.freeze([
  'schemaVersion', 'kind', 'status', 'snapshotId', 'moduleRegistryHash',
  'policySetHash', 'resourcePriceSnapshotHash', 'objectiveVersion',
  'qualifiedProjectionSetHash', 'buildRequestHash', 'issuedAt', 'builtAt',
  'deadline', 'expiresAt', 'maximumProjectionBytes',
  'maximumTotalProjectionBytes', 'projectionCount', 'projectionSetHash',
  'projections', 'consumerMustRevalidateBeforePlanning', 'authority',
  'stateSnapshotHash',
]);
export const SNAPSHOT_AUTHORITY_FIELDS = Object.freeze([
  'centralWriteAuthorized', 'executionAuthorized', 'providerAuthorized',
  'releaseAuthorized', 'externalAuthorityClaimed',
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
const HASH = /^sha256:[0-9a-f]{64}$/u;
const MODULE_ID = /^module\.[a-z0-9][a-z0-9-]{0,95}$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,191}$/u;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,127}$/u;
const QUALIFICATION_STATES = new Set([
  'source_qualified', 'target_host_qualified', 'external_authority_qualified',
]);
const READ_AUTHORITIES = new Set(['pure', 'read_only']);

export function snapshotFailure(code) {
  return Object.assign(new Error(code), { code, retryable: false });
}

export function failSnapshot(code) {
  throw snapshotFailure(code);
}

export function compareSnapshotText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function snapshotRecord(value, allowed, code) {
  if (!value || typeof value !== 'object'
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) failSnapshot(code);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(value);
  if (keys.length > SNAPSHOT_LIMITS.valueNodes
    || keys.some((key) => typeof key !== 'string'
      || (allowed && !allowed.includes(key)))) failSnapshot(code);
  const output = Object.create(null);
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) failSnapshot(code);
    output[key] = descriptor.value;
  }
  return output;
}

export function exactSnapshotRecord(value, fields, code) {
  const output = snapshotRecord(value, fields, code);
  if (Object.keys(output).length !== fields.length
    || fields.some((field) => !Object.hasOwn(output, field))) failSnapshot(code);
  return output;
}

export function denseSnapshotArray(value, maximum, code, minimum = 0) {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    failSnapshot(code);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).length !== value.length + 1) failSnapshot(code);
  const output = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[index];
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) failSnapshot(code);
    output.push(descriptor.value);
  }
  return output;
}

export function snapshotText(value, pattern, code) {
  if (typeof value !== 'string' || !pattern.test(value) || value.includes('\0')) {
    failSnapshot(code);
  }
  return value;
}

export function snapshotHash(value, code) {
  return snapshotText(value, HASH, code);
}

export function snapshotIdentifier(value, code) {
  return snapshotText(value, IDENTIFIER, code);
}

export function snapshotToken(value, code) {
  return snapshotText(value, TOKEN, code);
}

export function snapshotModuleId(value, code) {
  return snapshotText(value, MODULE_ID, code);
}

export function snapshotInteger(value, minimum, maximum, code) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    failSnapshot(code);
  }
  return value;
}

export function snapshotTimestamp(value, code) {
  if (typeof value !== 'string' || value.length > 40) failSnapshot(code);
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) failSnapshot(code);
  const canonical = new Date(milliseconds).toISOString();
  if (value !== canonical && value !== canonical.replace('.000Z', 'Z')) failSnapshot(code);
  return canonical;
}

function captureValue(value, state, depth = 0) {
  state.nodes += 1;
  if (state.nodes > SNAPSHOT_LIMITS.valueNodes || depth > SNAPSHOT_LIMITS.valueDepth) {
    failSnapshot('snapshot_projection_value_structure_limit');
  }
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (value.length > SNAPSHOT_LIMITS.stringLength || value.includes('\0')) {
      failSnapshot('snapshot_projection_value_string_invalid');
    }
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) failSnapshot('snapshot_projection_value_number_invalid');
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== 'object') failSnapshot('snapshot_projection_value_type_invalid');
  if (state.stack.has(value)) failSnapshot('snapshot_projection_value_cycle');
  state.stack.add(value);
  try {
    if (Array.isArray(value)) {
      return Object.freeze(denseSnapshotArray(
        value, SNAPSHOT_LIMITS.valueNodes, 'snapshot_projection_value_array_invalid',
      ).map((entry) => captureValue(entry, state, depth + 1)));
    }
    const data = snapshotRecord(value, null, 'snapshot_projection_value_record_invalid');
    const output = {};
    for (const key of Object.keys(data).sort(compareSnapshotText)) {
      if (!key.length || key.length > 256 || key.includes('\0')) {
        failSnapshot('snapshot_projection_value_key_invalid');
      }
      output[key] = captureValue(data[key], state, depth + 1);
    }
    return Object.freeze(output);
  } finally {
    state.stack.delete(value);
  }
}

export function captureSnapshotPayload(value) {
  return captureValue(value, { nodes: 0, stack: new WeakSet() });
}

export function normalizeProjectionSource(value) {
  const data = exactSnapshotRecord(value, SOURCE_FIELDS, 'snapshot_projection_source_invalid');
  const qualificationStatus = snapshotToken(
    data.qualificationStatus, 'snapshot_projection_source_qualification_invalid',
  );
  const authorityClass = snapshotToken(
    data.authorityClass, 'snapshot_projection_source_authority_invalid',
  );
  if (!QUALIFICATION_STATES.has(qualificationStatus)) {
    failSnapshot('snapshot_projection_source_qualification_invalid');
  }
  if (!READ_AUTHORITIES.has(authorityClass)) {
    failSnapshot('snapshot_projection_source_authority_invalid');
  }
  return Object.freeze({
    projectionId: snapshotIdentifier(data.projectionId, 'snapshot_projection_id_invalid'),
    projectionVersion: snapshotToken(
      data.projectionVersion, 'snapshot_projection_version_invalid',
    ),
    moduleId: snapshotModuleId(data.moduleId, 'snapshot_projection_module_invalid'),
    moduleVersion: snapshotToken(
      data.moduleVersion, 'snapshot_projection_module_version_invalid',
    ),
    authorityClass,
    qualificationStatus,
    qualificationIdentity: snapshotHash(
      data.qualificationIdentity, 'snapshot_projection_qualification_identity_invalid',
    ),
    maximumAgeMilliseconds: snapshotInteger(
      data.maximumAgeMilliseconds, 0, Number.MAX_SAFE_INTEGER,
      'snapshot_projection_maximum_age_invalid',
    ),
  });
}

export function projectionSourceComparator(left, right) {
  return compareSnapshotText(
    `${left.projectionId}\0${left.moduleId}\0${left.moduleVersion}`,
    `${right.projectionId}\0${right.moduleId}\0${right.moduleVersion}`,
  );
}

export function captureQualifiedProjectionSourceSetV1(value) {
  const sources = denseSnapshotArray(
    value, SNAPSHOT_LIMITS.projections, 'snapshot_projection_source_set_invalid', 1,
  ).map(normalizeProjectionSource).sort(projectionSourceComparator);
  const projectionIds = new Set();
  for (const source of sources) {
    if (projectionIds.has(source.projectionId)) {
      failSnapshot('snapshot_projection_source_duplicate');
    }
    projectionIds.add(source.projectionId);
  }
  const frozen = Object.freeze(sources);
  return Object.freeze({
    sources: frozen,
    qualifiedProjectionSetHash: hashRecord('QualifiedProjectionSourceSetV1', frozen),
  });
}

export function normalizeSnapshotBuildRequest(value) {
  const data = exactSnapshotRecord(value, SNAPSHOT_REQUEST_FIELDS,
    'snapshot_build_request_invalid');
  if (data.schemaVersion !== 1 || data.kind !== 'SnapshotBuildRequestV1') {
    failSnapshot('snapshot_build_request_identity_invalid');
  }
  const issuedAt = snapshotTimestamp(data.issuedAt,
    'snapshot_build_request_issued_at_invalid');
  const builtAt = snapshotTimestamp(data.builtAt,
    'snapshot_build_request_built_at_invalid');
  const deadline = snapshotTimestamp(data.deadline,
    'snapshot_build_request_deadline_invalid');
  if (Date.parse(issuedAt) > Date.parse(builtAt)
    || Date.parse(builtAt) > Date.parse(deadline)) {
    failSnapshot('snapshot_build_request_time_order_invalid');
  }
  const maximumProjectionBytes = snapshotInteger(
    data.maximumProjectionBytes, 256, SNAPSHOT_LIMITS.projectionBytes,
    'snapshot_build_projection_byte_limit_invalid',
  );
  const maximumTotalProjectionBytes = snapshotInteger(
    data.maximumTotalProjectionBytes, maximumProjectionBytes,
    SNAPSHOT_LIMITS.totalProjectionBytes, 'snapshot_build_total_byte_limit_invalid',
  );
  return Object.freeze({
    schemaVersion: 1,
    kind: 'SnapshotBuildRequestV1',
    snapshotId: snapshotIdentifier(data.snapshotId, 'snapshot_id_invalid'),
    moduleRegistryHash: snapshotHash(data.moduleRegistryHash, 'snapshot_registry_hash_invalid'),
    policySetHash: snapshotHash(data.policySetHash, 'snapshot_policy_hash_invalid'),
    resourcePriceSnapshotHash: snapshotHash(
      data.resourcePriceSnapshotHash, 'snapshot_resource_price_hash_invalid',
    ),
    objectiveVersion: snapshotToken(
      data.objectiveVersion, 'snapshot_objective_version_invalid',
    ),
    qualifiedProjectionSetHash: snapshotHash(
      data.qualifiedProjectionSetHash, 'snapshot_projection_set_binding_invalid',
    ),
    issuedAt,
    builtAt,
    deadline,
    maximumProjectionBytes,
    maximumTotalProjectionBytes,
  });
}

export function normalizeReadOnlyProjection(value, requireHash = true) {
  const data = snapshotRecord(value, PROJECTION_FIELDS, 'read_only_projection_invalid');
  const required = PROJECTION_FIELDS.filter((field) => field !== 'payloadHash');
  if (required.some((field) => !Object.hasOwn(data, field))
    || (requireHash && !Object.hasOwn(data, 'payloadHash'))
    || (!requireHash && Object.hasOwn(data, 'payloadHash'))
    || Object.keys(data).length !== required.length + (requireHash ? 1 : 0)) {
    failSnapshot('read_only_projection_invalid');
  }
  if (data.schemaVersion !== 1 || data.kind !== 'ReadOnlyProjectionV1') {
    failSnapshot('read_only_projection_identity_invalid');
  }
  const projectionPayload = captureSnapshotPayload(data.payload);
  const payloadHash = hashRecord('ReadOnlyProjectionPayloadV1', projectionPayload);
  if (requireHash && data.payloadHash !== payloadHash) {
    failSnapshot('read_only_projection_payload_hash_invalid');
  }
  return Object.freeze({
    schemaVersion: 1,
    kind: 'ReadOnlyProjectionV1',
    projectionId: snapshotIdentifier(data.projectionId, 'read_only_projection_id_invalid'),
    projectionVersion: snapshotToken(
      data.projectionVersion, 'read_only_projection_version_invalid',
    ),
    moduleId: snapshotModuleId(data.moduleId, 'read_only_projection_module_invalid'),
    moduleVersion: snapshotToken(
      data.moduleVersion, 'read_only_projection_module_version_invalid',
    ),
    sourceGeneration: snapshotInteger(
      data.sourceGeneration, 1, Number.MAX_SAFE_INTEGER,
      'read_only_projection_generation_invalid',
    ),
    observedAt: snapshotTimestamp(
      data.observedAt, 'read_only_projection_observed_at_invalid',
    ),
    validUntil: snapshotTimestamp(
      data.validUntil, 'read_only_projection_valid_until_invalid',
    ),
    payload: projectionPayload,
    payloadHash,
  });
}

export function sealReadOnlyProjectionV1(value) {
  return normalizeReadOnlyProjection(value, false);
}

export function normalizeSnapshotProjection(value) {
  const data = exactSnapshotRecord(value, SNAPSHOT_PROJECTION_FIELDS,
    'snapshot_projection_invalid');
  if (data.schemaVersion !== 1 || data.kind !== 'SnapshotProjectionV1') {
    failSnapshot('snapshot_projection_identity_invalid');
  }
  const projectionPayload = captureSnapshotPayload(data.payload);
  const payloadHash = hashRecord('ReadOnlyProjectionPayloadV1', projectionPayload);
  if (data.payloadHash !== payloadHash) failSnapshot('snapshot_projection_payload_hash_invalid');
  const authorityClass = snapshotToken(data.authorityClass,
    'snapshot_projection_authority_invalid');
  const qualificationStatus = snapshotToken(data.qualificationStatus,
    'snapshot_projection_qualification_invalid');
  if (!READ_AUTHORITIES.has(authorityClass)) failSnapshot('snapshot_projection_authority_invalid');
  if (!QUALIFICATION_STATES.has(qualificationStatus)) {
    failSnapshot('snapshot_projection_qualification_invalid');
  }
  return Object.freeze({
    schemaVersion: 1,
    kind: 'SnapshotProjectionV1',
    projectionId: snapshotIdentifier(data.projectionId, 'snapshot_projection_id_invalid'),
    projectionVersion: snapshotToken(data.projectionVersion,
      'snapshot_projection_version_invalid'),
    moduleId: snapshotModuleId(data.moduleId, 'snapshot_projection_module_invalid'),
    moduleVersion: snapshotToken(data.moduleVersion,
      'snapshot_projection_module_version_invalid'),
    authorityClass,
    qualificationStatus,
    qualificationIdentity: snapshotHash(data.qualificationIdentity,
      'snapshot_projection_qualification_identity_invalid'),
    maximumAgeMilliseconds: snapshotInteger(
      data.maximumAgeMilliseconds, 0, Number.MAX_SAFE_INTEGER,
      'snapshot_projection_maximum_age_invalid',
    ),
    sourceGeneration: snapshotInteger(
      data.sourceGeneration, 1, Number.MAX_SAFE_INTEGER,
      'snapshot_projection_generation_invalid',
    ),
    observedAt: snapshotTimestamp(data.observedAt,
      'snapshot_projection_observed_at_invalid'),
    validUntil: snapshotTimestamp(data.validUntil,
      'snapshot_projection_valid_until_invalid'),
    payload: projectionPayload,
    payloadHash,
  });
}

export function sourceFromSnapshotProjection(projection) {
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

export function snapshotAuthority(value = null, code = 'control_plane_snapshot_authority_invalid') {
  if (value === null) {
    return Object.freeze(Object.fromEntries(
      SNAPSHOT_AUTHORITY_FIELDS.map((field) => [field, false]),
    ));
  }
  const data = exactSnapshotRecord(value, SNAPSHOT_AUTHORITY_FIELDS, code);
  if (SNAPSHOT_AUTHORITY_FIELDS.some((field) => data[field] !== false)) failSnapshot(code);
  return Object.freeze(Object.fromEntries(
    SNAPSHOT_AUTHORITY_FIELDS.map((field) => [field, false]),
  ));
}
