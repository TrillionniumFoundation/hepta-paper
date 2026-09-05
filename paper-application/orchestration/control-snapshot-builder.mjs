import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';

const HASH = /^sha256:[0-9a-f]{64}$/u;
const TOKEN = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/u;
const TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/u;
const DEFAULT_BOUNDS = Object.freeze({
  maximumProjections: 128,
  maximumSnapshotBytes: 4 * 1024 * 1024,
  maximumPayloadBytes: 1024 * 1024,
  maximumDepth: 24,
  maximumNodes: 100_000,
  maximumCollectionEntries: 10_000,
  maximumStringBytes: 64 * 1024,
});

function failure(code) {
  return Object.assign(new Error(code), { code, retryable: false });
}

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function plainRecord(value, allowed, code) {
  if (!value || typeof value !== 'object'
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw failure(code);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key !== 'string' || (allowed && !allowed.includes(key)))) {
    throw failure(code);
  }
  const result = Object.create(null);
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw failure(code);
    result[key] = descriptor.value;
  }
  return result;
}

function denseArray(value, code) {
  if (!Array.isArray(value)) throw failure(code);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== value.length + 1) throw failure(code);
  const result = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[index];
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw failure(code);
    result.push(descriptor.value);
  }
  return result;
}

function token(value, code) {
  if (typeof value !== 'string' || !TOKEN.test(value)) throw failure(code);
  return value;
}

function hash(value, code = 'control_snapshot_hash_invalid') {
  if (typeof value !== 'string' || !HASH.test(value)) throw failure(code);
  return value;
}

function safeInteger(value, minimum, maximum, code) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw failure(code);
  return value;
}

function timestamp(value, code) {
  if (typeof value !== 'string') throw failure(code);
  const match = TIMESTAMP.exec(value);
  if (!match) throw failure(code);
  const [, year, month, day, hour, minute, second, fraction = ''] = match;
  if (second === '60') throw failure(code);
  const milliseconds = Date.UTC(Number(year), Number(month) - 1, Number(day),
    Number(hour), Number(minute), Number(second));
  const date = new Date(milliseconds);
  if (date.getUTCFullYear() !== Number(year) || date.getUTCMonth() !== Number(month) - 1
    || date.getUTCDate() !== Number(day) || date.getUTCHours() !== Number(hour)
    || date.getUTCMinutes() !== Number(minute) || date.getUTCSeconds() !== Number(second)) {
    throw failure(code);
  }
  return Object.freeze({ text: value, seconds: BigInt(Math.trunc(milliseconds / 1000)),
    nanoseconds: BigInt((fraction + '000000000').slice(0, 9)) });
}

function compareTimestamp(left, right) {
  if (left.seconds !== right.seconds) return left.seconds < right.seconds ? -1 : 1;
  if (left.nanoseconds === right.nanoseconds) return 0;
  return left.nanoseconds < right.nanoseconds ? -1 : 1;
}

function normalizeBounds(value = {}) {
  const input = plainRecord(value, Object.keys(DEFAULT_BOUNDS), 'control_snapshot_bounds_invalid');
  const bounds = { ...DEFAULT_BOUNDS };
  for (const key of Object.keys(input)) bounds[key] = input[key];
  safeInteger(bounds.maximumProjections, 1, 4096, 'control_snapshot_bounds_invalid');
  safeInteger(bounds.maximumSnapshotBytes, 1024, 64 * 1024 * 1024, 'control_snapshot_bounds_invalid');
  safeInteger(bounds.maximumPayloadBytes, 1, 16 * 1024 * 1024, 'control_snapshot_bounds_invalid');
  safeInteger(bounds.maximumDepth, 1, 64, 'control_snapshot_bounds_invalid');
  safeInteger(bounds.maximumNodes, 1, 1_000_000, 'control_snapshot_bounds_invalid');
  safeInteger(bounds.maximumCollectionEntries, 1, 100_000, 'control_snapshot_bounds_invalid');
  safeInteger(bounds.maximumStringBytes, 1, 1024 * 1024, 'control_snapshot_bounds_invalid');
  return Object.freeze(bounds);
}

function captureData(value, bounds) {
  const seen = new Set();
  let nodes = 0;
  function visit(current, depth) {
    if (++nodes > bounds.maximumNodes || depth > bounds.maximumDepth) {
      throw failure('control_snapshot_payload_structure_limit');
    }
    if (current === null || typeof current === 'boolean') return current;
    if (typeof current === 'string') {
      if (Buffer.byteLength(current, 'utf8') > bounds.maximumStringBytes) {
        throw failure('control_snapshot_payload_string_limit');
      }
      return current;
    }
    if (typeof current === 'number') {
      if (!Number.isFinite(current) || Math.abs(current) > Number.MAX_SAFE_INTEGER) {
        throw failure('control_snapshot_payload_number_invalid');
      }
      return Object.is(current, -0) ? 0 : current;
    }
    if (typeof current !== 'object') throw failure('control_snapshot_payload_value_invalid');
    if (seen.has(current)) throw failure('control_snapshot_payload_cycle');
    seen.add(current);
    try {
      if (Array.isArray(current)) {
        const items = denseArray(current, 'control_snapshot_payload_array_invalid');
        if (items.length > bounds.maximumCollectionEntries) {
          throw failure('control_snapshot_payload_collection_limit');
        }
        return Object.freeze(items.map((item) => visit(item, depth + 1)));
      }
      const record = plainRecord(current, null, 'control_snapshot_payload_record_invalid');
      const keys = Object.keys(record).sort(compareUtf8);
      if (keys.length > bounds.maximumCollectionEntries) {
        throw failure('control_snapshot_payload_collection_limit');
      }
      const output = Object.create(null);
      for (const key of keys) {
        if (!key || Buffer.byteLength(key, 'utf8') > 1024) {
          throw failure('control_snapshot_payload_key_invalid');
        }
        output[key] = visit(record[key], depth + 1);
      }
      return Object.freeze(output);
    } finally {
      seen.delete(current);
    }
  }
  return visit(value, 0);
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object') {
    const output = Object.create(null);
    for (const key of Object.keys(value).sort(compareUtf8)) output[key] = canonicalValue(value[key]);
    return output;
  }
  return value;
}

function canonicalBytes(value) {
  return Buffer.from(JSON.stringify(canonicalValue(value)), 'utf8');
}

function canonicalHash(kind, value) {
  return `sha256:${createHash('sha256').update(canonicalBytes({ kind, value })).digest('hex')}`;
}

function bindingRows(value, bounds) {
  const rows = denseArray(value, 'control_snapshot_bindings_invalid');
  if (!rows.length || rows.length > bounds.maximumProjections) throw failure('control_snapshot_bindings_invalid');
  const output = rows.map((raw) => {
    const row = plainRecord(raw, ['projectionKind', 'moduleId', 'moduleVersion', 'minimumRevision'],
      'control_snapshot_binding_invalid');
    if (!Object.hasOwn(row, 'projectionKind') || !Object.hasOwn(row, 'moduleId')
      || !Object.hasOwn(row, 'moduleVersion') || !Object.hasOwn(row, 'minimumRevision')) {
      throw failure('control_snapshot_binding_invalid');
    }
    return Object.freeze({ projectionKind: token(row.projectionKind, 'control_snapshot_binding_invalid'),
      moduleId: token(row.moduleId, 'control_snapshot_binding_invalid'),
      moduleVersion: token(row.moduleVersion, 'control_snapshot_binding_invalid'),
      minimumRevision: safeInteger(row.minimumRevision, 0, Number.MAX_SAFE_INTEGER,
        'control_snapshot_binding_invalid') });
  }).sort((left, right) => compareUtf8(left.projectionKind, right.projectionKind));
  if (new Set(output.map((row) => row.projectionKind)).size !== output.length) {
    throw failure('control_snapshot_binding_duplicate');
  }
  return Object.freeze(output);
}

function captureRequest(value, bounds, observed) {
  const raw = plainRecord(value, ['version', 'kind', 'requestId', 'subjectHash', 'bindings', 'expiresAt'],
    'control_snapshot_request_invalid');
  if (raw.version !== 1 || raw.kind !== 'ControlSnapshotRequestV1') {
    throw failure('control_snapshot_request_invalid');
  }
  const expiry = timestamp(raw.expiresAt, 'control_snapshot_request_expiry_invalid');
  if (compareTimestamp(observed, expiry) >= 0) throw failure('control_snapshot_request_expired');
  const body = Object.freeze({ version: 1, kind: raw.kind,
    requestId: token(raw.requestId, 'control_snapshot_request_invalid'),
    subjectHash: hash(raw.subjectHash, 'control_snapshot_subject_hash_invalid'),
    bindings: bindingRows(raw.bindings, bounds), expiresAt: expiry.text });
  return Object.freeze({ body, expiry, requestHash: canonicalHash('ControlSnapshotRequestV1', body) });
}

function captureProjection(value, binding, request, bounds, observed) {
  const raw = plainRecord(value, ['version', 'kind', 'projectionKind', 'projectionId', 'producerModuleId',
    'producerVersion', 'subjectHash', 'revision', 'observedAt', 'expiresAt', 'payload', 'payloadHash'],
  'control_snapshot_projection_invalid');
  if (raw.version !== 1 || raw.kind !== 'ControlProjectionV1') {
    throw failure('control_snapshot_projection_invalid');
  }
  const projectionKind = token(raw.projectionKind, 'control_snapshot_projection_invalid');
  if (projectionKind !== binding.projectionKind) throw failure('control_snapshot_projection_kind_mismatch');
  if (raw.producerModuleId !== binding.moduleId || raw.producerVersion !== binding.moduleVersion) {
    throw failure('control_snapshot_projection_producer_mismatch');
  }
  if (raw.subjectHash !== request.body.subjectHash) throw failure('control_snapshot_projection_subject_mismatch');
  const revision = safeInteger(raw.revision, 0, Number.MAX_SAFE_INTEGER,
    'control_snapshot_projection_revision_invalid');
  if (revision < binding.minimumRevision) throw failure('control_snapshot_projection_revision_stale');
  const projectionObserved = timestamp(raw.observedAt, 'control_snapshot_projection_observed_at_invalid');
  const expiry = timestamp(raw.expiresAt, 'control_snapshot_projection_expiry_invalid');
  if (compareTimestamp(projectionObserved, observed) > 0) throw failure('control_snapshot_projection_from_future');
  if (compareTimestamp(observed, expiry) >= 0 || compareTimestamp(projectionObserved, expiry) >= 0) {
    throw failure('control_snapshot_projection_expired');
  }
  const payload = captureData(raw.payload, bounds);
  const payloadBytes = canonicalBytes(payload);
  if (payloadBytes.length > bounds.maximumPayloadBytes) throw failure('control_snapshot_payload_byte_limit');
  const expectedPayloadHash = canonicalHash('ControlProjectionPayloadV1', {
    projectionKind, subjectHash: request.body.subjectHash, revision, payload,
  });
  if (raw.payloadHash !== expectedPayloadHash) throw failure('control_snapshot_projection_payload_hash_mismatch');
  const body = Object.freeze({ version: 1, kind: raw.kind, projectionKind,
    projectionId: token(raw.projectionId, 'control_snapshot_projection_invalid'),
    producerModuleId: binding.moduleId, producerVersion: binding.moduleVersion,
    subjectHash: request.body.subjectHash, revision, observedAt: projectionObserved.text,
    expiresAt: expiry.text, payload, payloadHash: expectedPayloadHash });
  return Object.freeze({ body, expiry,
    projectionHash: canonicalHash('ControlProjectionV1', body) });
}

export function controlProjectionPayloadHash({ projectionKind, subjectHash, revision, payload }, bounds = {}) {
  const normalizedBounds = normalizeBounds(bounds);
  const kind = token(projectionKind, 'control_snapshot_projection_invalid');
  const subject = hash(subjectHash, 'control_snapshot_subject_hash_invalid');
  const normalizedRevision = safeInteger(revision, 0, Number.MAX_SAFE_INTEGER,
    'control_snapshot_projection_revision_invalid');
  const captured = captureData(payload, normalizedBounds);
  if (canonicalBytes(captured).length > normalizedBounds.maximumPayloadBytes) {
    throw failure('control_snapshot_payload_byte_limit');
  }
  return canonicalHash('ControlProjectionPayloadV1', {
    projectionKind: kind, subjectHash: subject, revision: normalizedRevision, payload: captured,
  });
}

export function buildControlSnapshot(input) {
  const raw = plainRecord(input, ['request', 'projections', 'observedAt', 'bounds'],
    'control_snapshot_input_invalid');
  const bounds = normalizeBounds(Object.hasOwn(raw, 'bounds') ? raw.bounds : {});
  const observed = timestamp(raw.observedAt, 'control_snapshot_observed_at_invalid');
  const request = captureRequest(raw.request, bounds, observed);
  const rows = denseArray(raw.projections, 'control_snapshot_projections_invalid');
  if (rows.length !== request.body.bindings.length || rows.length > bounds.maximumProjections) {
    throw failure('control_snapshot_projection_coverage_invalid');
  }
  const byKind = new Map();
  for (const row of rows) {
    const shallow = plainRecord(row, null, 'control_snapshot_projection_invalid');
    const kind = token(shallow.projectionKind, 'control_snapshot_projection_invalid');
    if (byKind.has(kind)) throw failure('control_snapshot_projection_duplicate');
    byKind.set(kind, row);
  }
  const projections = request.body.bindings.map((binding) => {
    if (!byKind.has(binding.projectionKind)) throw failure('control_snapshot_projection_coverage_invalid');
    return captureProjection(byKind.get(binding.projectionKind), binding, request, bounds, observed);
  });
  const expiry = [request.expiry, ...projections.map((row) => row.expiry)]
    .reduce((left, right) => compareTimestamp(left, right) <= 0 ? left : right);
  const projectionSet = Object.freeze(projections.map((row) => Object.freeze({
    ...row.body, projectionHash: row.projectionHash,
  })));
  const body = Object.freeze({ version: 1, kind: 'ControlSnapshotV1',
    requestId: request.body.requestId, requestHash: request.requestHash,
    subjectHash: request.body.subjectHash, observedAt: observed.text, expiresAt: expiry.text,
    projectionSet, projectionSetHash: canonicalHash('ControlProjectionSetV1', projectionSet),
    authority: Object.freeze({ productionAuthorized: false, writerAuthorized: false,
      providerAuthorized: false, externalAuthorityClaimed: false }),
    externalActionPerformed: false });
  const snapshot = Object.freeze({ ...body,
    controlSnapshotHash: canonicalHash('ControlSnapshotV1', body) });
  if (canonicalBytes(snapshot).length > bounds.maximumSnapshotBytes) {
    throw failure('control_snapshot_byte_limit');
  }
  return snapshot;
}
