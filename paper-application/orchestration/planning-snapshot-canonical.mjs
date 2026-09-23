import crypto from 'node:crypto';

export const SNAPSHOT_LIMITS = Object.freeze({
  components: 2048,
  moduleMetadata: 1024,
  componentBytes: 2 * 1024 * 1024,
  totalComponentBytes: 32 * 1024 * 1024,
  valueNodes: 65536,
  valueDepth: 32,
  collectionItems: 16384,
  stringBytes: 64 * 1024,
});

export function snapshotFailure(code) {
  return Object.assign(new Error(code), { code, retryable: false });
}

export function hasUnpairedSurrogate(value) {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xD800 && unit <= 0xDBFF) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xDC00 && next <= 0xDFFF)) return true;
      index += 1;
    } else if (unit >= 0xDC00 && unit <= 0xDFFF) {
      return true;
    }
  }
  return false;
}

export function compareSnapshotUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

export function snapshotCanonicalStringify(value) {
  if (value === null) return 'null';
  if (typeof value === 'string') {
    if (hasUnpairedSurrogate(value)) throw snapshotFailure('snapshot_unicode_scalar_invalid');
    return JSON.stringify(value);
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) {
      throw snapshotFailure('snapshot_canonical_number_invalid');
    }
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => snapshotCanonicalStringify(entry)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const keys = Object.keys(value);
    if (keys.some(hasUnpairedSurrogate)) throw snapshotFailure('snapshot_unicode_scalar_invalid');
    return `{${keys.sort(compareSnapshotUtf8)
      .map((key) => `${JSON.stringify(key)}:${snapshotCanonicalStringify(value[key])}`).join(',')}}`;
  }
  throw snapshotFailure('snapshot_canonical_value_invalid');
}

export function snapshotHashRecord(kind, value) {
  const body = Object.create(null);
  Object.defineProperties(body, {
    kind: { value: kind, enumerable: true },
    value: { value, enumerable: true },
  });
  return `sha256:${crypto.createHash('sha256')
    .update(snapshotCanonicalStringify(body), 'utf8').digest('hex')}`;
}

export function snapshotRecordValues(value, allowed, code, required = allowed || []) {
  if (!value || typeof value !== 'object') throw snapshotFailure(code);
  let isArray;
  let prototype;
  let descriptors;
  let keys;
  try {
    isArray = Array.isArray(value);
    prototype = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
    keys = Reflect.ownKeys(value);
  } catch {
    throw snapshotFailure(code);
  }
  if (isArray || ![Object.prototype, null].includes(prototype)
    || keys.length !== Reflect.ownKeys(descriptors).length
    || (!allowed && keys.length > SNAPSHOT_LIMITS.collectionItems)
    || keys.some((key) => typeof key !== 'string' || (allowed && !allowed.includes(key)))
    || required.some((key) => !Object.hasOwn(descriptors, key))) {
    throw snapshotFailure(code);
  }
  const output = Object.create(null);
  for (const key of keys) {
    if (hasUnpairedSurrogate(key)) {
      throw snapshotFailure(allowed ? code : 'snapshot_value_key_invalid');
    }
    const descriptor = descriptors[key];
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw snapshotFailure(code);
    }
    Object.defineProperty(output, key, {
      value: descriptor.value, enumerable: true, writable: false, configurable: false,
    });
  }
  return output;
}

export function snapshotDenseArray(value, maximum, code, minimum = 0) {
  let isArray;
  let descriptors;
  let keys;
  try {
    isArray = Array.isArray(value);
    descriptors = isArray ? Object.getOwnPropertyDescriptors(value) : null;
    keys = isArray ? Reflect.ownKeys(value) : null;
  } catch {
    throw snapshotFailure(code);
  }
  const length = descriptors?.length?.value;
  if (!isArray || !Number.isSafeInteger(length) || length < minimum || length > maximum
    || keys.length !== length + 1 || !keys.includes('length')) throw snapshotFailure(code);
  const output = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw snapshotFailure(code);
    }
    output.push(descriptor.value);
  }
  return output;
}

export function snapshotText(value, pattern, code, maximumBytes = 4096) {
  if (typeof value !== 'string' || !value.length || hasUnpairedSurrogate(value)
    || value.includes('\0') || Buffer.byteLength(value, 'utf8') > maximumBytes
    || (pattern && !pattern.test(value))) throw snapshotFailure(code);
  return value;
}

export function snapshotHash(value, pattern, code) {
  return snapshotText(value, pattern, code, 71);
}

export function snapshotInteger(value, minimum, maximum, code) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw snapshotFailure(code);
  }
  return value;
}

export function snapshotTimestamp(value, code) {
  if (typeof value !== 'string' || value.length > 40 || hasUnpairedSurrogate(value)) {
    throw snapshotFailure(code);
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw snapshotFailure(code);
  const canonical = new Date(milliseconds).toISOString();
  if (value !== canonical && value !== canonical.replace('.000Z', 'Z')) {
    throw snapshotFailure(code);
  }
  return canonical;
}

export function captureSnapshotJson(value, state, depth = 0) {
  state.nodes += 1;
  if (state.nodes > SNAPSHOT_LIMITS.valueNodes || depth > SNAPSHOT_LIMITS.valueDepth) {
    throw snapshotFailure('snapshot_value_structure_limit');
  }
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (hasUnpairedSurrogate(value) || value.includes('\0')
      || Buffer.byteLength(value, 'utf8') > SNAPSHOT_LIMITS.stringBytes) {
      throw snapshotFailure('snapshot_value_string_invalid');
    }
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) {
      throw snapshotFailure('snapshot_value_number_invalid');
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (!value || typeof value !== 'object') throw snapshotFailure('snapshot_value_type_invalid');
  let isArray;
  try { isArray = Array.isArray(value); } catch {
    throw snapshotFailure('snapshot_value_record_invalid');
  }
  if (state.stack.has(value)) throw snapshotFailure('snapshot_value_cycle');
  state.stack.add(value);
  try {
    if (isArray) {
      return Object.freeze(snapshotDenseArray(value, SNAPSHOT_LIMITS.collectionItems,
        'snapshot_value_array_invalid').map((entry) => (
        captureSnapshotJson(entry, state, depth + 1)
      )));
    }
    const descriptors = snapshotRecordValues(value, null,
      'snapshot_value_record_invalid', []);
    const output = Object.create(null);
    for (const key of Object.keys(descriptors).sort(compareSnapshotUtf8)) {
      if (!key.length || hasUnpairedSurrogate(key) || key.includes('\0')
        || Buffer.byteLength(key, 'utf8') > 256) {
        throw snapshotFailure('snapshot_value_key_invalid');
      }
      Object.defineProperty(output, key, {
        value: captureSnapshotJson(descriptors[key], state, depth + 1),
        enumerable: true, writable: false, configurable: false,
      });
    }
    return Object.freeze(output);
  } finally {
    state.stack.delete(value);
  }
}

export function snapshotAuthority() {
  return Object.freeze({
    productionAuthorized: false,
    writerAuthorityGranted: false,
    providerAuthorized: false,
    releaseAuthorized: false,
    submissionAuthorized: false,
    externalAuthorityClaimed: false,
  });
}
