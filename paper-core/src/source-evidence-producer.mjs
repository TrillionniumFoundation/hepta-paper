import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fail, trackedBlob, readPinnedSource } from './source-evidence-git-inputs.mjs';

export const SOURCE_EVIDENCE_ENTRYPOINT = 'paper-core/bin/verify-source-implementation-evidence.mjs';
export const SOURCE_EVIDENCE_PRODUCER_PATHS = Object.freeze([
  SOURCE_EVIDENCE_ENTRYPOINT,
  'paper-core/src/source-evidence-git-inputs.mjs',
  'paper-core/src/source-evidence-public-r-inputs.mjs',
  'paper-core/src/source-evidence-rust-symbols.mjs',
  'paper-core/src/source-evidence-strict-json.mjs',
  'paper-core/src/source-evidence-cargo-observations.mjs',
  'paper-core/src/source-evidence-producer.mjs',
]);

export function hashBytes(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

export function producerPin(root) {
  return SOURCE_EVIDENCE_PRODUCER_PATHS.map((relative) => {
    const bound = trackedBlob(root, relative);
    const bytes = readPinnedSource(root, relative, bound);
    const loaded = relative === SOURCE_EVIDENCE_ENTRYPOINT
      ? fileURLToPath(new URL('../bin/verify-source-implementation-evidence.mjs', import.meta.url))
      : fileURLToPath(new URL(path.basename(relative), import.meta.url));
    if (!bytes.equals(fs.readFileSync(loaded))) fail('verification_capture_producer_mismatch', relative);
    return { path: relative, mode: bound.mode, gitBlob: bound.blob, sha256: hashBytes(bytes) };
  });
}

