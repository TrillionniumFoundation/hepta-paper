import fs from 'node:fs';
import path from 'node:path';
import { isPathWithin } from '../../workflow-kernel/runtime/path-utils.mjs';
import { writeImmutableFileSync } from '../runtime/immutable-file-repository.mjs';
import { fsyncDirectorySync } from '../runtime/durable-json-repository.mjs';

export function materializeResearchEvidenceCapsuleFilesSync({ packageDir, files = [] } = {}) {
  const root = path.resolve(packageDir || '.');
  const seen = new Set();
  const directories = new Set();
  for (const file of files) {
    const candidate = path.resolve(root, String(file?.path || ''));
    if (!file?.content || !isPathWithin(root, candidate) || candidate === root || seen.has(candidate)) {
      throw new Error(`research_evidence_capsule_output_invalid:${file?.path || 'missing'}`);
    }
    seen.add(candidate);
    for (let directory = path.dirname(candidate); isPathWithin(root, directory) && directory !== root; directory = path.dirname(directory)) {
      directories.add(directory);
    }
    writeImmutableFileSync(candidate, file.content, {
      collisionError: 'research_evidence_capsule_immutable_collision',
      mode: 0o444,
    });
    const descriptor = fs.openSync(candidate, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
  }
  [...directories].sort((left, right) => right.length - left.length).forEach(fsyncDirectorySync);
  return Object.freeze({ materializedFileCount: seen.size });
}
