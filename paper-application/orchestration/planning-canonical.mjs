import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { types } from 'node:util';

export const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/u;
export const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u;

export function failure(code) {
  return Object.assign(new Error(code), { code, retryable: false });
}

export function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

export function createBudget({
  maximumInputBytes = 8 * 1024 * 1024,
  maximumNodes = 100_000,
  maximumCollectionItems = 65_536,
} = {}, code = 'planning_input_limit') {
  for (const [value, maximum] of [
    [maximumInputBytes, 64 * 1024 * 1024],
    [maximumNodes, 1_000_000],
    [maximumCollectionItems, 1_000_000],
  ]) {
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw failure(code);
  }
  return { bytes: 0, nodes: 0, items: 0,
    maximumInputBytes, maximumNodes, maximumCollectionItems, code };
}

export function charge(budget, { bytes = 0, nodes = 0, items = 0 } = {}) {
  if (!budget) return;
  budget.bytes += bytes;
  budget.nodes += nodes;
  budget.items += items;
  if (budget.bytes > budget.maximumInputBytes
    || budget.nodes > budget.maximumNodes
    || budget.items > budget.maximumCollectionItems) {
    throw failure(budget.code);
  }
}

function rejectProxy(value, code) {
  if (value && typeof value === 'object' && types.isProxy(value)) throw failure(code);
}

export function ownDataRecord(value, allowed, required, code, budget = null) {
  rejectProxy(value, code);
  if (value === null || typeof value !== 'object'
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw failure(code);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  charge(budget, { nodes: 1, items: keys.length });
  const output = Object.create(null);
  for (const key of keys) {
    if (typeof key !== 'string' || (allowed && !allowed.includes(key))) throw failure(code);
    const descriptor = descriptors[key];
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw failure(code);
    charge(budget, { bytes: Buffer.byteLength(key, 'utf8') });
    output[key] = descriptor.value;
  }
  for (const key of required || []) if (!Object.hasOwn(descriptors, key)) throw failure(code);
  return output;
}

export function denseArray(value, maximum, code, budget = null) {
  rejectProxy(value, code);
  if (!Array.isArray(value) || value.length > maximum) throw failure(code);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== value.length + 1) throw failure(code);
  charge(budget, { nodes: 1, items: value.length });
  const output = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw failure(code);
    }
    output.push(descriptor.value);
  }
  return output;
}

export function boundedString(value, code, maximumBytes, budget = null, { allowEmpty = false } = {}) {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0) || value.includes('\0')) {
    throw failure(code);
  }
  const bytes = Buffer.byteLength(value, 'utf8');
  if (bytes > maximumBytes) throw failure(code);
  charge(budget, { bytes, nodes: 1 });
  return value;
}

export function identifier(value, code, budget = null) {
  const text = boundedString(value, code, 256, budget);
  if (!IDENTIFIER_PATTERN.test(text)) throw failure(code);
  return text;
}

export function hash(value, code, budget = null) {
  const text = boundedString(value, code, 71, budget);
  if (!HASH_PATTERN.test(text)) throw failure(code);
  return text;
}

export function safeInteger(value, minimum, maximum, code, budget = null) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw failure(code);
  charge(budget, { bytes: 8, nodes: 1 });
  return Object.is(value, -0) ? 0 : value;
}

export function finiteNumber(value, minimum, maximum, code, budget = null) {
  if (typeof value !== 'number' || !Number.isFinite(value)
    || value < minimum || value > maximum) throw failure(code);
  charge(budget, { bytes: 8, nodes: 1 });
  return Object.is(value, -0) ? 0 : value;
}

export function sortedUniqueStrings(value, maximum, code, budget = null,
  { minimum = 0, hashes = false } = {}) {
  const rows = denseArray(value, maximum, code, budget);
  if (rows.length < minimum) throw failure(code);
  const captured = rows.map((row) => hashes ? hash(row, code, budget)
    : boundedString(row, code, 4096, budget));
  captured.sort(compareUtf8);
  if (captured.some((row, index) => index > 0 && row === captured[index - 1])) {
    throw failure(code);
  }
  return Object.freeze(captured);
}

export function captureJson(value, limits, budget, state = { seen: new WeakSet() }, depth = 0) {
  if (depth > limits.maximumDepth) throw failure('planning_value_depth_limit');
  if (value === null) { charge(budget, { bytes: 4, nodes: 1 }); return null; }
  if (typeof value === 'boolean') { charge(budget, { bytes: value ? 4 : 5, nodes: 1 }); return value; }
  if (typeof value === 'string') return boundedString(value, 'planning_value_string_limit',
    limits.maximumStringBytes, budget, { allowEmpty: true });
  if (typeof value === 'number') return finiteNumber(value, -Number.MAX_SAFE_INTEGER,
    Number.MAX_SAFE_INTEGER, 'planning_value_number_invalid', budget);
  if (typeof value !== 'object') throw failure('planning_value_type_invalid');
  rejectProxy(value, 'planning_value_proxy_invalid');
  if (state.seen.has(value)) throw failure('planning_value_cycle');
  state.seen.add(value);
  try {
    if (Array.isArray(value)) {
      const rows = denseArray(value, limits.maximumCollectionItems,
        'planning_value_array_invalid', budget);
      return Object.freeze(rows.map((row) => captureJson(row, limits, budget, state, depth + 1)));
    }
    const record = ownDataRecord(value, null, [], 'planning_value_record_invalid', budget);
    const keys = Object.keys(record).sort(compareUtf8);
    if (keys.length > limits.maximumObjectProperties) throw failure('planning_value_object_limit');
    const output = Object.create(null);
    for (const key of keys) {
      if (!key || Buffer.byteLength(key, 'utf8') > 1024) throw failure('planning_value_key_limit');
      output[key] = captureJson(record[key], limits, budget, state, depth + 1);
    }
    return Object.freeze(output);
  } finally {
    state.seen.delete(value);
  }
}

export function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object') {
    const output = Object.create(null);
    for (const key of Object.keys(value).sort(compareUtf8)) output[key] = canonicalValue(value[key]);
    return output;
  }
  return value;
}

export function canonicalBytes(value) {
  let encoded;
  try { encoded = JSON.stringify(canonicalValue(value)); }
  catch { throw failure('planning_value_not_json'); }
  if (encoded === undefined) throw failure('planning_value_not_json');
  return Buffer.from(encoded, 'utf8');
}

export function canonicalHash(kind, value) {
  return `sha256:${createHash('sha256').update(canonicalBytes({ kind, value })).digest('hex')}`;
}

export function strictTimestamp(value, code, budget = null) {
  const text = boundedString(value, code, 64, budget);
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/u.exec(text);
  if (!match) throw failure(code);
  const [, ys, ms, ds, hs, mins, ss, fraction = ''] = match;
  const year = Number(ys); const month = Number(ms); const day = Number(ds);
  const hour = Number(hs); const minute = Number(mins); const second = Number(ss);
  // V1 explicitly rejects pre-Unix-epoch timestamps; this avoids ambiguous
  // negative-second/fraction representations and matches runtime support.
  if (year < 1970 || year > 9999 || second > 59) throw failure(code);
  const milliseconds = Date.UTC(year, month - 1, day, hour, minute, second, 0);
  const date = new Date(milliseconds);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day || date.getUTCHours() !== hour
    || date.getUTCMinutes() !== minute || date.getUTCSeconds() !== second) throw failure(code);
  const nanos = BigInt(milliseconds) * 1_000_000n
    + BigInt((fraction + '000000000').slice(0, 9));
  return Object.freeze({ text, nanos });
}

export function compareTimestamp(left, right) {
  return left.nanos === right.nanos ? 0 : left.nanos < right.nanos ? -1 : 1;
}

export function exactFalseAuthority(value, keys, code, budget = null) {
  const record = ownDataRecord(value, keys, keys, code, budget);
  if (Object.keys(record).length !== keys.length
    || keys.some((key) => record[key] !== false)) throw failure(code);
  return Object.freeze(Object.fromEntries(keys.map((key) => [key, false])));
}
