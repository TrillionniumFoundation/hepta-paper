import { Buffer } from 'node:buffer';
import { compareUtf8 } from './candidate-router-canonical.mjs';
import {
  DEFAULT_BOUNDS, boundedInteger, denseArray, failure, plainRecord,
} from './candidate-router-primitives.mjs';

export function captureData(value, bounds, state, depth = 0) {
  if (depth > bounds.maximumDepth) throw failure('candidate_data_depth_limit');
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (Buffer.byteLength(value, 'utf8') > bounds.maximumStringBytes || value.includes('\0')) {
      throw failure('candidate_data_string_invalid');
    }
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw failure('candidate_data_number_invalid');
    return value === 0 ? 0 : value;
  }
  if (typeof value !== 'object') throw failure('candidate_data_type_invalid');
  if (state.ancestors.has(value)) throw failure('candidate_data_cycle');
  state.items += 1;
  if (state.items > bounds.maximumCollectionItems) throw failure('candidate_data_item_limit');
  state.ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const rows = denseArray(value, bounds.maximumCollectionItems, 'candidate_data_array_invalid');
      state.items += rows.length;
      if (state.items > bounds.maximumCollectionItems) throw failure('candidate_data_item_limit');
      return Object.freeze(rows.map((item) => captureData(item, bounds, state, depth + 1)));
    }
    let prototype;
    let descriptors;
    let keys;
    try {
      prototype = Object.getPrototypeOf(value);
      descriptors = Object.getOwnPropertyDescriptors(value);
      keys = Reflect.ownKeys(descriptors);
    } catch {
      throw failure('candidate_data_record_invalid');
    }
    if (![Object.prototype, null].includes(prototype)
      || keys.length > bounds.maximumObjectFields
      || keys.some((key) => typeof key !== 'string')) throw failure('candidate_data_record_invalid');
    const result = {};
    for (const key of keys.toSorted(compareUtf8)) {
      if (key.length === 0 || Buffer.byteLength(key, 'utf8') > bounds.maximumStringBytes
        || key.includes('\0')) throw failure('candidate_data_key_invalid');
      const descriptor = descriptors[key];
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
        throw failure('candidate_data_record_invalid');
      }
      result[key] = captureData(descriptor.value, bounds, state, depth + 1);
    }
    return Object.freeze(result);
  } finally {
    state.ancestors.delete(value);
  }
}

export function structuredObject(value, bounds, code) {
  const result = captureData(value, bounds, { ancestors: new WeakSet(), items: 0 });
  if (result === null || typeof result !== 'object' || Array.isArray(result)) throw failure(code);
  return result;
}

export function normalizeBounds(overrides = {}) {
  const values = plainRecord(overrides, Object.keys(DEFAULT_BOUNDS), [], 'candidate_router_bounds_invalid');
  const bounds = { ...DEFAULT_BOUNDS, ...values };
  for (const [key, value] of Object.entries(bounds)) {
    const maximum = key === 'maximumCandidateBytes' ? 64 * 1024 * 1024 : 65536;
    boundedInteger(value, 1, maximum, 'candidate_router_bounds_invalid');
  }
  if (bounds.maximumCandidateLimit > 4096 || bounds.maximumModules > 4096
    || bounds.maximumDepth > 64 || bounds.maximumObjectFields > 1024) {
    throw failure('candidate_router_bounds_invalid');
  }
  return Object.freeze(bounds);
}
