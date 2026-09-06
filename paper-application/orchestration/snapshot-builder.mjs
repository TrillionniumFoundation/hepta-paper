import { hashRecord, stableStringify } from '../../workflow-kernel/record-hash.mjs';

const HASH = /^sha256:[0-9a-f]{64}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const DEFAULT_LIMITS = Object.freeze({
  maximumComponents: 128,
  maximumComponentBytes: 4 * 1024 * 1024,
  maximumTotalBytes: 16 * 1024 * 1024,
  maximumJsonDepth: 16,
  maximumJsonNodes: 8192,
  maximumCollectionItems: 4096,
  maximumStringBytes: 64 * 1024,
});
const HARD_LIMITS = Object.freeze({
  maximumComponents: 4096,
  maximumComponentBytes: 16 * 1024 * 1024,
  maximumTotalBytes: 64 * 1024 * 1024,
  maximumJsonDepth: 64,
  maximumJsonNodes: 100_000,
  maximumCollectionItems: 16_384,
  maximumStringBytes: 1024 * 1024,
});
const REQUEST_FIELDS = Object.freeze([
  'schemaVersion', 'kind', 'snapshotRequestId', 'readTransactionHash',
  'consistencyEpoch', 'deadline', 'requiredComponents',
]);
const REQUIREMENT_FIELDS = Object.freeze([
  'componentId', 'componentKind', 'minimumRevision',
  'maximumAgeMs', 'maximumPayloadBytes',
]);
const BINDING_FIELDS = Object.freeze([
  'moduleId', 'moduleVersion', 'projectionKinds',
  'qualificationSubjectHash', 'validUntil',
]);
const COMPONENT_FIELDS = Object.freeze([
  'schemaVersion', 'kind', 'componentId', 'componentKind',
  'sourceModuleId', 'sourceModuleVersion', 'sourceQualificationHash',
  'readTransactionHash', 'consistencyEpoch', 'revision', 'generation',
  'capturedAt', 'expiresAt', 'payload', 'payloadHash',
]);
const COMPONENT_REQUIRED = COMPONENT_FIELDS;
const COMPONENT_PAYLOAD_FIELDS = Object.freeze(
  COMPONENT_FIELDS.filter((field) => field !== 'payloadHash'),
);
const COMPONENT_PAYLOAD_REQUIRED = COMPONENT_PAYLOAD_FIELDS;

function failure(code) {
  return Object.assign(new Error(code), { code, retryable: false });
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function record(value, allowed, required, code) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw failure(code);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key !== 'string' || !allowed.includes(key))) throw failure(code);
  const output = Object.create(null);
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw failure(code);
    output[key] = descriptor.value;
  }
  if (required.some((key) => !Object.hasOwn(output, key))) throw failure(code);
  return output;
}

function arrayValues(value, maximum, code) {
  if (!Array.isArray(value) || value.length > maximum) throw failure(code);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key !== 'string')
    || keys.length !== value.length + 1 || !Object.hasOwn(descriptors, 'length')) throw failure(code);
  const result = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw failure(code);
    result.push(descriptor.value);
  }
  return result;
}

function safeInteger(value, minimum, maximum, code) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw failure(code);
  return value;
}

function text(value, code, maximumBytes = 4096, pattern = null) {
  if (typeof value !== 'string' || value.length === 0
    || Buffer.byteLength(value, 'utf8') > maximumBytes || value.includes('\0')
    || (pattern && !pattern.test(value))) throw failure(code);
  return value;
}

function hash(value, code) {
  return text(value, code, 71, HASH);
}

function dateTime(value, code) {
  text(value, code, 64, DATE_TIME);
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw failure(code);
  return Object.freeze({ source: value, milliseconds });
}

function canonicalSet(value, limits, code, pattern = null, { allowEmpty = false } = {}) {
  const values = arrayValues(value, limits.maximumCollectionItems, code)
    .map((item) => text(item, code, limits.maximumStringBytes, pattern))
    .sort(compareText);
  if ((!allowEmpty && values.length === 0) || new Set(values).size !== values.length) throw failure(code);
  return Object.freeze(values);
}

function captureLimits(value = {}) {
  const data = record(value, Object.keys(DEFAULT_LIMITS), [], 'snapshot_builder_limits_invalid');
  const result = {};
  for (const [key, fallback] of Object.entries(DEFAULT_LIMITS)) {
    result[key] = safeInteger(Object.hasOwn(data, key) ? data[key] : fallback,
      1, HARD_LIMITS[key], 'snapshot_builder_limits_invalid');
  }
  if (result.maximumComponentBytes > result.maximumTotalBytes) {
    throw failure('snapshot_builder_limits_invalid');
  }
  return Object.freeze(result);
}

function captureJson(value, limits, code, budget = { nodes: 0 }, depth = 0) {
  if (depth > limits.maximumJsonDepth || ++budget.nodes > limits.maximumJsonNodes) throw failure(code);
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (Buffer.byteLength(value, 'utf8') > limits.maximumStringBytes || value.includes('\0')) throw failure(code);
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) throw failure(code);
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) {
    return Object.freeze(arrayValues(value, limits.maximumCollectionItems, code)
      .map((item) => captureJson(item, limits, code, budget, depth + 1)));
  }
  if (typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw failure(code);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length > limits.maximumCollectionItems
    || keys.some((key) => typeof key !== 'string')) throw failure(code);
  const output = {};
  for (const key of keys.sort(compareText)) {
    const descriptor = descriptors[key];
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')
      || Buffer.byteLength(key, 'utf8') > limits.maximumStringBytes || key.includes('\0')) throw failure(code);
    output[key] = captureJson(descriptor.value, limits, code, budget, depth + 1);
  }
  return Object.freeze(output);
}

function captureRequirement(value, limits) {
  const data = record(value, REQUIREMENT_FIELDS, REQUIREMENT_FIELDS,
    'snapshot_component_requirement_invalid');
  return Object.freeze({
    componentId: text(data.componentId, 'snapshot_component_id_invalid', 256, IDENTIFIER),
    componentKind: text(data.componentKind, 'snapshot_component_kind_invalid', 256, IDENTIFIER),
    minimumRevision: safeInteger(data.minimumRevision, 0, Number.MAX_SAFE_INTEGER,
      'snapshot_component_minimum_revision_invalid'),
    maximumAgeMs: safeInteger(data.maximumAgeMs, 0, Number.MAX_SAFE_INTEGER,
      'snapshot_component_maximum_age_invalid'),
    maximumPayloadBytes: safeInteger(data.maximumPayloadBytes, 1, limits.maximumComponentBytes,
      'snapshot_component_payload_limit_invalid'),
  });
}

function captureRequest(value, limits) {
  const data = record(value, REQUEST_FIELDS, REQUEST_FIELDS, 'snapshot_request_invalid');
  if (data.schemaVersion !== 1 || data.kind !== 'PlanningStateSnapshotRequestV1') {
    throw failure('snapshot_request_identity_invalid');
  }
  const requirements = arrayValues(data.requiredComponents, limits.maximumComponents,
    'snapshot_requirement_count_invalid').map((item) => captureRequirement(item, limits));
  if (requirements.length === 0) throw failure('snapshot_requirement_count_invalid');
  requirements.sort((left, right) => compareText(left.componentId, right.componentId));
  if (new Set(requirements.map((item) => item.componentId)).size !== requirements.length) {
    throw failure('snapshot_component_requirement_duplicate');
  }
  return Object.freeze({
    schemaVersion: 1,
    kind: 'PlanningStateSnapshotRequestV1',
    snapshotRequestId: text(data.snapshotRequestId, 'snapshot_request_id_invalid', 256, IDENTIFIER),
    readTransactionHash: hash(data.readTransactionHash, 'snapshot_request_transaction_invalid'),
    consistencyEpoch: safeInteger(data.consistencyEpoch, 1, Number.MAX_SAFE_INTEGER,
      'snapshot_request_epoch_invalid'),
    deadline: dateTime(data.deadline, 'snapshot_request_deadline_invalid').source,
    requiredComponents: Object.freeze(requirements),
  });
}

function captureBinding(value, limits) {
  const data = record(value, BINDING_FIELDS, BINDING_FIELDS, 'snapshot_module_binding_invalid');
  return Object.freeze({
    moduleId: text(data.moduleId, 'snapshot_binding_module_invalid', 256, IDENTIFIER),
    moduleVersion: text(data.moduleVersion, 'snapshot_binding_version_invalid', 256, IDENTIFIER),
    projectionKinds: canonicalSet(data.projectionKinds, limits,
      'snapshot_binding_projection_kinds_invalid', IDENTIFIER),
    qualificationSubjectHash: hash(data.qualificationSubjectHash,
      'snapshot_binding_qualification_invalid'),
    validUntil: dateTime(data.validUntil, 'snapshot_binding_expiry_invalid').source,
  });
}

function captureBindings(value, limits, nowEpochMs) {
  const values = arrayValues(value, 4096, 'snapshot_module_bindings_invalid')
    .map((item) => captureBinding(item, limits));
  const identities = new Set();
  for (const binding of values) {
    if (Date.parse(binding.validUntil) <= nowEpochMs) throw failure('snapshot_module_binding_expired');
    const identity = `${binding.moduleId}\0${binding.moduleVersion}`;
    if (identities.has(identity)) throw failure('snapshot_module_binding_duplicate');
    identities.add(identity);
  }
  values.sort((left, right) => compareText(left.moduleId, right.moduleId)
    || compareText(left.moduleVersion, right.moduleVersion));
  return Object.freeze(values);
}

function captureComponentBody(value, limits) {
  const data = record(value, COMPONENT_PAYLOAD_FIELDS, COMPONENT_PAYLOAD_REQUIRED,
    'snapshot_component_invalid');
  if (data.schemaVersion !== 1 || data.kind !== 'PlanningSnapshotComponentV1') {
    throw failure('snapshot_component_identity_invalid');
  }
  return Object.freeze({
    schemaVersion: 1,
    kind: 'PlanningSnapshotComponentV1',
    componentId: text(data.componentId, 'snapshot_component_id_invalid', 256, IDENTIFIER),
    componentKind: text(data.componentKind, 'snapshot_component_kind_invalid', 256, IDENTIFIER),
    sourceModuleId: text(data.sourceModuleId, 'snapshot_component_module_invalid', 256, IDENTIFIER),
    sourceModuleVersion: text(data.sourceModuleVersion, 'snapshot_component_module_version_invalid', 256, IDENTIFIER),
    sourceQualificationHash: hash(data.sourceQualificationHash,
      'snapshot_component_qualification_invalid'),
    readTransactionHash: hash(data.readTransactionHash, 'snapshot_component_transaction_invalid'),
    consistencyEpoch: safeInteger(data.consistencyEpoch, 1, Number.MAX_SAFE_INTEGER,
      'snapshot_component_epoch_invalid'),
    revision: safeInteger(data.revision, 0, Number.MAX_SAFE_INTEGER,
      'snapshot_component_revision_invalid'),
    generation: safeInteger(data.generation, 0, Number.MAX_SAFE_INTEGER,
      'snapshot_component_generation_invalid'),
    capturedAt: dateTime(data.capturedAt, 'snapshot_component_captured_at_invalid').source,
    expiresAt: dateTime(data.expiresAt, 'snapshot_component_expiry_invalid').source,
    payload: captureJson(data.payload, limits, 'snapshot_component_payload_invalid'),
  });
}

export function createPlanningSnapshotComponent(value, limits = {}) {
  const policy = captureLimits(limits);
  const body = captureComponentBody(value, policy);
  return Object.freeze({
    ...body,
    payloadHash: hashRecord('PlanningSnapshotComponentV1', body),
  });
}

function captureComponent(value, limits) {
  const data = record(value, COMPONENT_FIELDS, COMPONENT_REQUIRED, 'snapshot_component_invalid');
  const claimed = hash(data.payloadHash, 'snapshot_component_payload_hash_invalid');
  const payload = Object.create(null);
  for (const field of COMPONENT_PAYLOAD_FIELDS) payload[field] = data[field];
  const body = captureComponentBody(payload, limits);
  const expected = hashRecord('PlanningSnapshotComponentV1', body);
  if (claimed !== expected) throw failure('snapshot_component_payload_hash_invalid');
  return Object.freeze({ ...body, payloadHash: claimed });
}

function encodedBytes(value) {
  return Buffer.byteLength(stableStringify(value), 'utf8');
}

export function buildPlanningStateSnapshot(input) {
  const root = record(input, ['request', 'moduleBindings', 'components', 'nowEpochMs', 'limits'],
    ['request', 'moduleBindings', 'components', 'nowEpochMs'], 'snapshot_builder_input_invalid');
  const limits = captureLimits(Object.hasOwn(root, 'limits') ? root.limits : {});
  const nowEpochMs = safeInteger(root.nowEpochMs, 0, Number.MAX_SAFE_INTEGER,
    'snapshot_builder_clock_invalid');
  const request = captureRequest(root.request, limits);
  const requestDeadline = Date.parse(request.deadline);
  if (requestDeadline <= nowEpochMs) throw failure('snapshot_request_expired');
  const bindings = captureBindings(root.moduleBindings, limits, nowEpochMs);
  const bindingByIdentity = new Map(bindings.map((binding) => [
    `${binding.moduleId}\0${binding.moduleVersion}`, binding,
  ]));
  const rawComponents = arrayValues(root.components, limits.maximumComponents,
    'snapshot_component_count_invalid');
  if (rawComponents.length !== request.requiredComponents.length) {
    throw failure('snapshot_component_set_mismatch');
  }
  const requirementById = new Map(request.requiredComponents.map((item) => [item.componentId, item]));
  const components = [];
  const seen = new Set();
  let totalBytes = 0;
  for (const raw of rawComponents) {
    const component = captureComponent(raw, limits);
    if (seen.has(component.componentId)) throw failure('snapshot_component_duplicate');
    seen.add(component.componentId);
    const requirement = requirementById.get(component.componentId);
    if (!requirement || requirement.componentKind !== component.componentKind) {
      throw failure('snapshot_component_set_mismatch');
    }
    if (component.readTransactionHash !== request.readTransactionHash) {
      throw failure('snapshot_component_transaction_mismatch');
    }
    if (component.consistencyEpoch !== request.consistencyEpoch) {
      throw failure('snapshot_component_epoch_mismatch');
    }
    if (component.revision < requirement.minimumRevision) {
      throw failure('snapshot_component_revision_too_old');
    }
    const capturedAt = Date.parse(component.capturedAt);
    const expiresAt = Date.parse(component.expiresAt);
    if (capturedAt > nowEpochMs) throw failure('snapshot_component_from_future');
    if (nowEpochMs - capturedAt > requirement.maximumAgeMs) {
      throw failure('snapshot_component_stale');
    }
    if (expiresAt <= nowEpochMs || expiresAt < capturedAt) throw failure('snapshot_component_expired');
    if (expiresAt > requestDeadline) throw failure('snapshot_component_expiry_exceeds_request');
    const binding = bindingByIdentity.get(`${component.sourceModuleId}\0${component.sourceModuleVersion}`);
    if (!binding || binding.qualificationSubjectHash !== component.sourceQualificationHash
      || !binding.projectionKinds.includes(component.componentKind)) {
      throw failure('snapshot_component_module_binding_mismatch');
    }
    const componentBytes = encodedBytes(component);
    if (componentBytes > requirement.maximumPayloadBytes
      || componentBytes > limits.maximumComponentBytes) {
      throw failure('snapshot_component_byte_limit_exceeded');
    }
    totalBytes += componentBytes;
    if (totalBytes > limits.maximumTotalBytes) throw failure('snapshot_total_byte_limit_exceeded');
    components.push(component);
  }
  components.sort((left, right) => compareText(left.componentId, right.componentId));
  if (components.some((item, index) => item.componentId !== request.requiredComponents[index].componentId)) {
    throw failure('snapshot_component_set_mismatch');
  }
  const body = Object.freeze({
    schemaVersion: 1,
    kind: 'PlanningStateSnapshotV1',
    snapshotRequestId: request.snapshotRequestId,
    snapshotRequestHash: hashRecord('PlanningStateSnapshotRequestV1', request),
    readTransactionHash: request.readTransactionHash,
    consistencyEpoch: request.consistencyEpoch,
    moduleBindingSetHash: hashRecord('PlanningSnapshotModuleBindingSetV1', bindings),
    componentSetHash: hashRecord('PlanningSnapshotComponentSetV1', components),
    componentCount: components.length,
    components: Object.freeze(components),
    expiresAt: new Date(Math.min(requestDeadline,
      ...components.map((item) => Date.parse(item.expiresAt)),
      ...bindings.map((item) => Date.parse(item.validUntil)))).toISOString(),
    authority: Object.freeze({
      productionAuthorized: false,
      writerAuthorityGranted: false,
      providerAuthorized: false,
      externalAuthorityClaimed: false,
    }),
  });
  if (encodedBytes(body) > limits.maximumTotalBytes) throw failure('snapshot_output_byte_limit_exceeded');
  return Object.freeze({
    ...body,
    stateSnapshotHash: hashRecord('PlanningStateSnapshotV1', body),
  });
}
