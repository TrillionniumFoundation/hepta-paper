import crypto from 'node:crypto';

const stableImmutableValueCache = new WeakMap();
const immutableRecordHashCache = new WeakMap();

function immutableChild(value) {
  return !value || typeof value !== 'object'
    || stableImmutableValueCache.has(value);
}

function stable(value) {
  if (Array.isArray(value)) {
    const cached = stableImmutableValueCache.get(value);
    if (cached) return cached;
    let cacheable = Object.isFrozen(value);
    const normalized = value.map((item, index) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) cacheable = false;
      const result = stable(item);
      if (!immutableChild(item)) cacheable = false;
      return result;
    });
    if (cacheable) {
      Object.freeze(normalized);
      stableImmutableValueCache.set(value, normalized);
    }
    return normalized;
  }
  if (value && typeof value === 'object') {
    const cached = stableImmutableValueCache.get(value);
    if (cached) return cached;
    const prototype = Object.getPrototypeOf(value);
    let cacheable = Object.isFrozen(value)
      && (prototype === Object.prototype || prototype === null);
    const normalized = Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => {
          const descriptor = Object.getOwnPropertyDescriptor(value, key);
          if (!descriptor || !Object.hasOwn(descriptor, 'value')) cacheable = false;
          const result = stable(item);
          if (!immutableChild(item)) cacheable = false;
          return [key, result];
        }),
    );
    if (cacheable) {
      Object.freeze(normalized);
      stableImmutableValueCache.set(value, normalized);
    }
    return normalized;
  }
  return value;
}

export function digest(value) {
  return `sha256:${crypto.createHash('sha256').update(stableStringify(value)).digest('hex')}`;
}

export function stableStringify(value) {
  return JSON.stringify(stable(value));
}

export function hashRecord(kind, value) {
  const cached = value && typeof value === 'object'
    ? immutableRecordHashCache.get(value)?.get(kind)
    : null;
  if (cached) return cached;
  const recordHash = digest({ kind, value });
  if (value && typeof value === 'object'
    && stableImmutableValueCache.has(value)) {
    const valueCache = immutableRecordHashCache.get(value) || new Map();
    valueCache.set(kind, recordHash);
    immutableRecordHashCache.set(value, valueCache);
  }
  return recordHash;
}

export function hashBytes(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}
