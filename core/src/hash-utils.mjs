import crypto from 'node:crypto';

export function stableForHash(value) {
  if (Array.isArray(value)) return value.map(stableForHash);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, stableForHash(item)]),
    );
  }
  return value;
}

export function digest(value) {
  return `sha256:${crypto
    .createHash('sha256')
    .update(JSON.stringify(stableForHash(value)))
    .digest('hex')}`;
}
