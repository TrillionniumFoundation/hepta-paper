import crypto from 'node:crypto';

const HASH = /^sha256:[0-9a-f]{64}$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u;
const API_FIELDS = Object.freeze([
  'transaction', 'projections', 'moduleBindings', 'policy', 'now', 'limits',
]);
const TRANSACTION_FIELDS = Object.freeze([
  'schemaVersion', 'kind', 'repositorySubjectHash', 'revision', 'writerGeneration',
  'readEpoch', 'capturedAt', 'expiresAt',
]);
const PROJECTION_FIELDS = Object.freeze([
  'schemaVersion', 'kind', 'projectionId', 'sourceModuleId', 'schemaRef', 'revision',
  'writerGeneration', 'readEpoch', 'payload', 'projectionHash',
]);
const PROJECTION_BODY_FIELDS = Object.freeze(
  PROJECTION_FIELDS.filter((field) => field !== 'projectionHash'),
);
const MODULE_FIELDS = Object.freeze([
  'moduleId', 'moduleVersion', 'capabilityIds', 'qualificationSubjectHash',
]);
const POLICY_FIELDS = Object.freeze([
  'hardConstraintSetHash', 'objectiveVersion', 'resourcePriceSnapshotHash',
  'allowedSideEffectClasses',
]);
const LIMIT_FIELDS = Object.freeze([
  'maximumProjections', 'maximumModules', 'maximumTotalBytes',
  'maximumProjectionBytes', 'maximumDepth', 'maximumCollectionItems',
  'maximumObjectProperties', 'maximumStringBytes',
]);
const DEFAULT_LIMITS = Object.freeze({
  maximumProjections: 256,
  maximumModules: 1024,
  maximumTotalBytes: 16 * 1024 * 1024,
  maximumProjectionBytes: 2 * 1024 * 1024,
  maximumDepth: 24,
  maximumCollectionItems: 16384,
  maximumObjectProperties: 1024,
  maximumStringBytes: 256 * 1024,
});

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

function boundedString(value, code, maximumBytes) {
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

function nonnegativeSafeInteger(value, code) {
  if (!Number.isSafeInteger(value) || value < 0) fail(code);
  return value;
}

function sortedUniqueStrings(value, code, maximum, { hashes = false, minimum = 0 } = {}) {
  const input = denseArray(value, code);
  if (input.length < minimum || input.length > maximum) fail(code);
  const result = input.map((item) => hashes
    ? exactHash(item, code) : boundedString(item, code, 4096));
  result.sort(compareUtf8);
  if (result.some((item, index) => index > 0 && item === result[index - 1])) fail(code);
  return Object.freeze(result);
}

function captureLimits(value = {}) {
  const input = ownDataRecord(value, LIMIT_FIELDS, [], 'planning_snapshot_limits_invalid');
  const maxima = {
    maximumProjections: 4096,
    maximumModules: 4096,
    maximumTotalBytes: 64 * 1024 * 1024,
    maximumProjectionBytes: 16 * 1024 * 1024,
    maximumDepth: 64,
    maximumCollectionItems: 131072,
    maximumObjectProperties: 8192,
    maximumStringBytes: 2 * 1024 * 1024,
  };
  const result = {};
  for (const field of LIMIT_FIELDS) {
    const selected = Object.hasOwn(input, field) ? input[field] : DEFAULT_LIMITS[field];
    if (!Number.isSafeInteger(selected) || selected < 1 || selected > maxima[field]) {
      fail('planning_snapshot_limits_invalid');
    }
    result[field] = selected;
  }
  if (result.maximumProjectionBytes > result.maximumTotalBytes) {
    fail('planning_snapshot_limits_invalid');
  }
  return Object.freeze(result);
}

function captureJson(value, limits, state, depth = 0) {
  if (depth > limits.maximumDepth) fail('planning_projection_depth_limit');
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (Buffer.byteLength(value, 'utf8') > limits.maximumStringBytes) {
      fail('planning_projection_string_limit');
    }
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) {
      fail('planning_projection_number_invalid');
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== 'object') fail('planning_projection_value_invalid');
  if (state.seen.has(value)) fail('planning_projection_cycle');
  state.seen.add(value);
  try {
    if (Array.isArray(value)) {
      const input = denseArray(value, 'planning_projection_array_invalid');
      state.items += input.length;
      if (state.items > limits.maximumCollectionItems) {
        fail('planning_projection_collection_limit');
      }
      return Object.freeze(input.map((item) => captureJson(item, limits, state, depth + 1)));
    }
    if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
      fail('planning_projection_record_invalid');
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.length > limits.maximumObjectProperties
      || keys.some((key) => typeof key !== 'string')) {
      fail('planning_projection_object_limit');
    }
    const result = {};
    for (const key of keys.sort(compareUtf8)) {
      const descriptor = descriptors[key];
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
        fail('planning_projection_accessor_invalid');
      }
      if (Buffer.byteLength(key, 'utf8') > 1024) fail('planning_projection_key_limit');
      result[key] = captureJson(descriptor.value, limits, state, depth + 1);
    }
    return Object.freeze(result);
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
  const encoded = JSON.stringify(value);
  if (encoded === undefined) fail('planning_snapshot_value_not_json');
  return encoded;
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
  const offsetHour = match[8] === 'Z' ? 0 : Number(match[10]);
  const offsetMinute = match[8] === 'Z' ? 0 : Number(match[11]);
  if (year < 1970 || year > 9999 || month < 1 || month > 12 || hour > 23
    || minute > 59 || second > 59 || offsetHour > 23 || offsetMinute > 59) fail(code);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthDays = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (day < 1 || day > monthDays[month - 1]) fail(code);
  const fraction = (match[7] || '').padEnd(9, '0');
  const milliseconds = Date.UTC(year, month - 1, day, hour, minute, second, 0);
  const offset = match[8] === 'Z' ? 0
    : (match[9] === '+' ? 1 : -1) * (offsetHour * 60 + offsetMinute) * 60 * 1000;
  return BigInt(milliseconds - offset) * 1_000_000n + BigInt(fraction || '0');
}

function captureTransaction(raw, now) {
  const input = ownDataRecord(raw, TRANSACTION_FIELDS, TRANSACTION_FIELDS,
    'planning_snapshot_transaction_invalid');
  if (input.schemaVersion !== 1 || input.kind !== 'ReadSnapshotTransactionV1') {
    fail('planning_snapshot_transaction_invalid');
  }
  const captured = strictTimestamp(input.capturedAt, 'planning_snapshot_time_invalid');
  const expires = strictTimestamp(input.expiresAt, 'planning_snapshot_time_invalid');
  const current = strictTimestamp(now, 'planning_snapshot_now_invalid');
  if (captured > current || current >= expires) fail('planning_snapshot_not_current');
  return Object.freeze({
    transaction: Object.freeze({
      schemaVersion: 1,
      kind: 'ReadSnapshotTransactionV1',
      repositorySubjectHash: exactHash(input.repositorySubjectHash,
        'planning_snapshot_repository_subject_invalid'),
      revision: nonnegativeSafeInteger(input.revision, 'planning_snapshot_revision_invalid'),
      writerGeneration: nonnegativeSafeInteger(input.writerGeneration,
        'planning_snapshot_writer_generation_invalid'),
      readEpoch: nonnegativeSafeInteger(input.readEpoch, 'planning_snapshot_read_epoch_invalid'),
      capturedAt: input.capturedAt,
      expiresAt: input.expiresAt,
    }),
    current,
    expires,
  });
}

function capturePolicy(raw) {
  const input = ownDataRecord(raw, POLICY_FIELDS, POLICY_FIELDS,
    'planning_snapshot_policy_invalid');
  return Object.freeze({
    hardConstraintSetHash: exactHash(input.hardConstraintSetHash,
      'planning_snapshot_constraint_hash_invalid'),
    objectiveVersion: exactIdentifier(input.objectiveVersion,
      'planning_snapshot_objective_invalid'),
    resourcePriceSnapshotHash: exactHash(input.resourcePriceSnapshotHash,
      'planning_snapshot_resource_price_invalid'),
    allowedSideEffectClasses: sortedUniqueStrings(input.allowedSideEffectClasses,
      'planning_snapshot_side_effects_invalid', 64, { minimum: 1 }),
  });
}

function normalizeProjectionBody(raw, limits) {
  const input = ownDataRecord(raw, PROJECTION_BODY_FIELDS, PROJECTION_BODY_FIELDS,
    'planning_projection_invalid');
  if (input.schemaVersion !== 1 || input.kind !== 'PlanningProjectionV1') {
    fail('planning_projection_invalid');
  }
  return Object.freeze({
    schemaVersion: 1,
    kind: 'PlanningProjectionV1',
    projectionId: exactIdentifier(input.projectionId, 'planning_projection_id_invalid'),
    sourceModuleId: exactIdentifier(input.sourceModuleId,
      'planning_projection_source_module_invalid'),
    schemaRef: boundedString(input.schemaRef, 'planning_projection_schema_ref_invalid', 4096),
    revision: nonnegativeSafeInteger(input.revision, 'planning_projection_revision_invalid'),
    writerGeneration: nonnegativeSafeInteger(input.writerGeneration,
      'planning_projection_writer_generation_invalid'),
    readEpoch: nonnegativeSafeInteger(input.readEpoch, 'planning_projection_read_epoch_invalid'),
    payload: captureJson(input.payload, limits, { seen: new WeakSet(), items: 0 }),
  });
}

function captureProjection(raw, transaction, limits) {
  const input = ownDataRecord(raw, PROJECTION_FIELDS, PROJECTION_FIELDS,
    'planning_projection_invalid');
  const { projectionHash, ...bodyInput } = input;
  const body = normalizeProjectionBody(bodyInput, limits);
  const expectedHash = hashDomain('PlanningProjectionV1', body);
  if (projectionHash !== expectedHash) fail('planning_projection_hash_invalid');
  if (body.revision !== transaction.revision
    || body.writerGeneration !== transaction.writerGeneration
    || body.readEpoch !== transaction.readEpoch) {
    fail('planning_projection_transaction_mismatch');
  }
  const projection = Object.freeze({ ...body, projectionHash: expectedHash });
  const bytes = Buffer.byteLength(canonicalize(projection), 'utf8');
  if (bytes > limits.maximumProjectionBytes) fail('planning_projection_byte_limit');
  return Object.freeze({ projection, bytes });
}

function captureModuleBindings(raw, limits) {
  const rows = denseArray(raw, 'planning_snapshot_module_bindings_invalid');
  if (rows.length < 1 || rows.length > limits.maximumModules) {
    fail('planning_snapshot_module_count_limit');
  }
  const seen = new Set();
  const result = [];
  for (const row of rows) {
    const input = ownDataRecord(row, MODULE_FIELDS, MODULE_FIELDS,
      'planning_snapshot_module_binding_invalid');
    const moduleId = exactIdentifier(input.moduleId, 'planning_snapshot_module_binding_invalid');
    const moduleVersion = exactIdentifier(input.moduleVersion,
      'planning_snapshot_module_binding_invalid');
    const identity = `${moduleId}\0${moduleVersion}`;
    if (seen.has(identity)) fail('planning_snapshot_module_binding_duplicate');
    seen.add(identity);
    result.push(Object.freeze({
      moduleId,
      moduleVersion,
      capabilityIds: sortedUniqueStrings(input.capabilityIds,
        'planning_snapshot_module_capabilities_invalid', 256, { minimum: 1 }),
      qualificationSubjectHash: exactHash(input.qualificationSubjectHash,
        'planning_snapshot_module_qualification_invalid'),
    }));
  }
  result.sort((left, right) => compareUtf8(left.moduleId, right.moduleId)
    || compareUtf8(left.moduleVersion, right.moduleVersion));
  return Object.freeze(result);
}

export function hashPlanningProjectionV1(rawProjection, options = {}) {
  const optionInput = ownDataRecord(options, ['limits'], [],
    'planning_projection_hash_options_invalid');
  const limits = captureLimits(Object.hasOwn(optionInput, 'limits') ? optionInput.limits : {});
  return hashDomain('PlanningProjectionV1', normalizeProjectionBody(rawProjection, limits));
}

export function buildPlanningSnapshot(rawInput) {
  const input = ownDataRecord(rawInput, API_FIELDS,
    ['transaction', 'projections', 'moduleBindings', 'policy', 'now'],
    'planning_snapshot_request_invalid');
  const limits = captureLimits(Object.hasOwn(input, 'limits') ? input.limits : {});
  const transactionState = captureTransaction(input.transaction, input.now);
  const policy = capturePolicy(input.policy);
  const moduleBindings = captureModuleBindings(input.moduleBindings, limits);
  const rows = denseArray(input.projections, 'planning_snapshot_projection_collection_invalid');
  if (rows.length < 1 || rows.length > limits.maximumProjections) {
    fail('planning_snapshot_projection_count_limit');
  }
  const ids = new Set();
  const projections = [];
  let totalBytes = 0;
  for (const rawProjection of rows) {
    const captured = captureProjection(rawProjection, transactionState.transaction, limits);
    if (ids.has(captured.projection.projectionId)) fail('planning_projection_duplicate');
    ids.add(captured.projection.projectionId);
    totalBytes += captured.bytes;
    if (totalBytes > limits.maximumTotalBytes) fail('planning_snapshot_total_byte_limit');
    projections.push(captured.projection);
  }
  projections.sort((left, right) => compareUtf8(left.projectionId, right.projectionId));
  const frozenProjections = Object.freeze(projections);
  const authority = Object.freeze({
    productionAuthorized: false,
    writerAuthorized: false,
    providerAuthorized: false,
    releaseAuthorized: false,
    submissionAuthorized: false,
  });
  const body = Object.freeze({
    schemaVersion: 1,
    kind: 'PlanningSnapshotV1',
    status: 'complete_exact_read_snapshot',
    repositorySubjectHash: transactionState.transaction.repositorySubjectHash,
    revision: transactionState.transaction.revision,
    writerGeneration: transactionState.transaction.writerGeneration,
    readEpoch: transactionState.transaction.readEpoch,
    capturedAt: transactionState.transaction.capturedAt,
    expiresAt: transactionState.transaction.expiresAt,
    policy,
    projections: frozenProjections,
    moduleBindings,
    totalCapturedBytes: totalBytes,
    authority,
  });
  const encodedBytes = Buffer.byteLength(canonicalize(body), 'utf8');
  if (encodedBytes > limits.maximumTotalBytes) fail('planning_snapshot_total_byte_limit');
  return Object.freeze({
    ...body,
    stateSnapshotHash: hashDomain('PlanningSnapshotV1', body),
  });
}
