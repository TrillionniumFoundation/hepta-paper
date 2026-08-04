import { stableStringify } from '../../workflow-kernel/record-hash.mjs';
import { deepFreezeJsonValue } from '../../workflow-kernel/deep-freeze-json-value.mjs';

function invalid(code) {
  throw new Error(code);
}

export function assertAutonomousResearchOneShotJsonShape(value, code, depth = 0) {
  if (depth > 64) invalid(code);
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) {
      invalid(code);
    }
    return;
  }
  if (!value || typeof value !== 'object') invalid(code);
  const prototype = Object.getPrototypeOf(value);
  if ((Array.isArray(value) && prototype !== Array.prototype)
    || (!Array.isArray(value) && prototype !== Object.prototype)) invalid(code);
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key !== 'string')) invalid(code);
  const descriptors = ownKeys
    .filter((key) => !(Array.isArray(value) && key === 'length'))
    .map((key) => Object.getOwnPropertyDescriptor(value, key));
  if (descriptors.some((descriptor) => (
    !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true
  ))) invalid(code);
  if (Array.isArray(value)) {
    if (Object.keys(value).length !== value.length) invalid(code);
    value.forEach((child) => assertAutonomousResearchOneShotJsonShape(
      child,
      code,
      depth + 1,
    ));
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (!key || key.length > 256 || child === undefined) invalid(code);
    assertAutonomousResearchOneShotJsonShape(child, code, depth + 1);
  }
}

export function canonicalAutonomousResearchOneShotSnapshot(value, {
  code,
  maximumBytes,
  allowNull = false,
} = {}) {
  if (value === null && allowNull) return null;
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) invalid(code);
  assertAutonomousResearchOneShotJsonShape(value, code);
  const source = stableStringify(value);
  if (Buffer.byteLength(source) > maximumBytes) invalid(code);
  return deepFreezeJsonValue(JSON.parse(source));
}
