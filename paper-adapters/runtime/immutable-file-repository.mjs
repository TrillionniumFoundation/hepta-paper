import fs from 'node:fs';
import path from 'node:path';
import { hashBytes } from '../../workflow-kernel/record-hash.mjs';

export function writeImmutableFileSync(candidate, bytes, { collisionError = 'immutable_file_collision', mode = 0o444 } = {}) {
  fs.mkdirSync(path.dirname(candidate), { recursive: true });
  try {
    fs.writeFileSync(candidate, bytes, { flag: 'wx', mode });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if (hashBytes(fs.readFileSync(candidate)) !== hashBytes(bytes)) throw new Error(`${collisionError}:${candidate}`);
  }
  return candidate;
}
