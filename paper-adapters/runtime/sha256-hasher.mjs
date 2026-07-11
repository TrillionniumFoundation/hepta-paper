import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { assertHasherPort } from '../../paper-ports/hasher-port.mjs';

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}

function digest(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

export function createSha256Hasher() {
  return assertHasherPort(Object.freeze({
    version: 1,
    kind: 'Sha256HasherAdapter',
    hashText: (value) => digest(String(value ?? '')),
    hashFile: async (file) => digest(await fs.readFile(file)),
    hashRecord: (kind, payload) => digest(JSON.stringify(stable({ version: 1, kind, payload }))),
  }));
}
