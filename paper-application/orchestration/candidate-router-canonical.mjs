import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';

export function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort(compareUtf8)
      .map((key) => [key, canonicalValue(value[key])]));
  }
  return value;
}

export function canonicalStringify(value) {
  return JSON.stringify(canonicalValue(value));
}

export function canonicalHashRecord(kind, value) {
  return `sha256:${createHash('sha256').update(canonicalStringify({ kind, value })).digest('hex')}`;
}
