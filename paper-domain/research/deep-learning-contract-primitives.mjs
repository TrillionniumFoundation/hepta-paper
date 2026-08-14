import { hasExactPlainObjectKeys } from '../../workflow-kernel/exact-object-keys.mjs';

const HASH = /^sha256:[0-9a-f]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,191}$/;
const VERSION = /^\d{1,4}(?:\.\d{1,4}){1,3}(?:[-+][A-Za-z0-9.-]{1,64})?$/;

export function exactPlainObject(value, keys) {
  return hasExactPlainObjectKeys(value, [...keys].sort());
}

export function requiredDeepLearningHash(value) {
  const selected = typeof value === 'string' ? value.toLowerCase() : '';
  return HASH.test(selected) ? selected : null;
}

export function requiredDeepLearningId(value) {
  const selected = typeof value === 'string' ? value.trim() : '';
  return ID.test(selected) ? selected : null;
}

export function requiredRuntimeVersion(value) {
  const selected = typeof value === 'string' ? value.trim() : '';
  return VERSION.test(selected) ? selected : null;
}

export function densePlainArray(value, minimum = 1, maximum = 256) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
    || value.length < minimum || value.length > maximum) return false;
  return JSON.stringify(Object.keys(value))
    === JSON.stringify(Array.from({ length: value.length }, (_, index) => String(index)));
}

export function safeIntegerInRange(value, minimum, maximum) {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

export function finiteNumberInRange(value, minimum, maximum, {
  minimumExclusive = false,
  maximumExclusive = false,
} = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return false;
  if (minimumExclusive ? value <= minimum : value < minimum) return false;
  if (maximumExclusive ? value >= maximum : value > maximum) return false;
  return true;
}

export function jsonEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}
