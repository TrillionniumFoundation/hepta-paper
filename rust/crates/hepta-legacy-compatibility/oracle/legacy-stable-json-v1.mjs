#!/usr/bin/env node
import crypto from 'node:crypto';

function canonical(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('non-finite number');
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  throw new Error('unsupported value');
}

function lengthPrefix(bytes) {
  const length = Buffer.alloc(8);
  length.writeBigUInt64BE(BigInt(bytes.length));
  return Buffer.concat([length, bytes]);
}

const input = process.argv[2];
if (!input) throw new Error('missing JSON argument');
const encoded = Buffer.from(canonical(JSON.parse(input)), 'utf8');
const hash = crypto.createHash('sha256')
  .update(lengthPrefix(Buffer.from('HeptaLegacyStableJsonV1')))
  .update(lengthPrefix(encoded))
  .digest('hex');
process.stdout.write(JSON.stringify({ canonical: encoded.toString('utf8'), hash: `sha256:${hash}` }));
