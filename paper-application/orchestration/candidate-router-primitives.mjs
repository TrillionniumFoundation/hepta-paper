import { Buffer } from 'node:buffer';
import { compareUtf8 } from './candidate-router-canonical.mjs';

const HASH = /^sha256:[0-9a-f]{64}$/u;
const UTC_OR_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-](?:0\d|1\d|2[0-3]):[0-5]\d)$/u;

export const DEFAULT_BOUNDS = Object.freeze({
  maximumDepth: 16,
  maximumObjectFields: 128,
  maximumCollectionItems: 4096,
  maximumStringBytes: 4096,
  maximumModules: 512,
  maximumCandidateLimit: 1024,
  maximumCandidateBytes: 16 * 1024 * 1024,
});

export function failure(code) {
  return Object.assign(new Error(code), { code, retryable: false });
}

export function plainRecord(value, allowed, required, code) {
  if (value === null || typeof value !== 'object') throw failure(code);
  let prototype;
  let descriptors;
  let keys;
  try {
    prototype = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
    keys = Reflect.ownKeys(descriptors);
  } catch {
    throw failure(code);
  }
  if (![Object.prototype, null].includes(prototype)
    || keys.some((key) => typeof key !== 'string' || !allowed.includes(key))) {
    throw failure(code);
  }
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw failure(code);
  }
  if (required.some((key) => !Object.hasOwn(descriptors, key))) throw failure(code);
  return Object.fromEntries(keys.map((key) => [key, descriptors[key].value]));
}

export function denseArray(value, maximum, code) {
  if (!Array.isArray(value) || !Number.isSafeInteger(value.length) || value.length > maximum) {
    throw failure(code);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  const expected = new Set(['length', ...Array.from({ length: value.length }, (_, index) => String(index))]);
  if (keys.length !== expected.size || keys.some((key) => typeof key !== 'string' || !expected.has(key))) {
    throw failure(code);
  }
  const length = descriptors.length;
  if (!length || !Object.hasOwn(length, 'value') || length.value !== value.length) throw failure(code);
  const result = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw failure(code);
    result.push(descriptor.value);
  }
  return result;
}

export function boundedInteger(value, minimum, maximum, code) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw failure(code);
  return value;
}

export function boundedNumber(value, maximum, code) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > maximum) {
    throw failure(code);
  }
  return value === 0 ? 0 : value;
}

export function text(value, maximumBytes, code, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')
    || Buffer.byteLength(value, 'utf8') > maximumBytes) throw failure(code);
  return value;
}

export function hash(value, code) {
  if (typeof value !== 'string' || !HASH.test(value)) throw failure(code);
  return value;
}

export function timestamp(value, code) {
  if (typeof value !== 'string' || !UTC_OR_OFFSET.test(value)) throw failure(code);
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/u.exec(value);
  if (!match) throw failure(code);
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, fraction = '', zone] = match;
  const [year, month, day, hour, minute, second] = [yearText, monthText, dayText,
    hourText, minuteText, secondText].map(Number);
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) throw failure(code);
  const calendar = new Date(0);
  calendar.setUTCFullYear(year, month - 1, day);
  calendar.setUTCHours(hour, minute, second, 0);
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1
    || calendar.getUTCDate() !== day || calendar.getUTCHours() !== hour
    || calendar.getUTCMinutes() !== minute || calendar.getUTCSeconds() !== second) {
    throw failure(code);
  }
  let offsetMinutes = 0;
  if (zone !== 'Z') {
    const sign = zone[0] === '+' ? 1 : -1;
    const offsetHours = Number(zone.slice(1, 3));
    const offsetMinutePart = Number(zone.slice(4, 6));
    if (offsetHours > 23 || offsetMinutePart > 59) throw failure(code);
    offsetMinutes = sign * (offsetHours * 60 + offsetMinutePart);
  }
  const epochMilliseconds = calendar.getTime() - offsetMinutes * 60_000;
  const epochNanoseconds = BigInt(epochMilliseconds) * 1_000_000n
    + BigInt(fraction.padEnd(9, '0'));
  return Object.freeze({ value, epoch: epochNanoseconds });
}

export function stringSet(value, maximum, bounds, code, { allowEmpty = true } = {}) {
  const rows = denseArray(value, maximum, code)
    .map((item) => text(item, bounds.maximumStringBytes, code));
  if (!allowEmpty && rows.length === 0) throw failure(code);
  if (new Set(rows).size !== rows.length) throw failure(code);
  return Object.freeze(rows.toSorted(compareUtf8));
}
