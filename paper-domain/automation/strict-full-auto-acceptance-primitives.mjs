import crypto from 'node:crypto';

export function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
}

export function canonicalTimestamp(value) {
  const parsed = Date.parse(value);
  return typeof value === 'string' && Number.isFinite(parsed)
    && new Date(parsed).toISOString() === value;
}

export function canonicalAcceptanceJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalAcceptanceJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalAcceptanceJson(value[key])}`
    )).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function normalizeStrictFullAutoAcceptanceAssertionValue(value) {
  if (value === null
    || typeof value === 'string'
    || typeof value === 'boolean'
    || (typeof value === 'number' && Number.isFinite(value))) {
    return value;
  }
  if (Array.isArray(value)
    && value.length > 0
    && value.every((item) => typeof item === 'string' && item.length > 0)) {
    return Object.freeze([...value]);
  }
  throw new Error('strict_full_auto_acceptance_assertion_value_invalid');
}

export function strictFullAutoAcceptanceJsonEqual(left, right) {
  return canonicalAcceptanceJson(left) === canonicalAcceptanceJson(right);
}

export function strictFullAutoAcceptanceHash(value) {
  return `sha256:${crypto.createHash('sha256').update(canonicalAcceptanceJson(value)).digest('hex')}`;
}
