#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';

function canonical(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const keys = Object.keys(value).sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}

function u64(value) {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(value));
  return buffer;
}

export function encodeLegacyStableJsonV1(value) {
  return Buffer.from(canonical(value), 'utf8');
}

export function hashLegacyStableJsonV1(value) {
  const domain = Buffer.from('HeptaLegacyStableJsonV1', 'utf8');
  const bytes = encodeLegacyStableJsonV1(value);
  const hash = crypto.createHash('sha256')
    .update(u64(domain.length))
    .update(domain)
    .update(u64(bytes.length))
    .update(bytes)
    .digest('hex');
  return `sha256:${hash}`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const input = fs.readFileSync(0, 'utf8');
  if (!input || Buffer.byteLength(input) >= 8 * 1024 * 1024) throw new Error('bounded input required');
  const value = JSON.parse(input);
  process.stdout.write(`${encodeLegacyStableJsonV1(value).toString('utf8')}\n${hashLegacyStableJsonV1(value)}\n`);
}
