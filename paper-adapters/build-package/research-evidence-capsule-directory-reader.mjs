import fs from 'node:fs';
import path from 'node:path';
import { isPathWithin } from '../../workflow-kernel/runtime/path-utils.mjs';
import { readScopedFileSync } from '../../workflow-kernel/runtime/scoped-file-identity.mjs';

const SAFE_RELATIVE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9_.\/-]{1,512}$/;

export function readResearchEvidenceCapsuleFile(root, relative, maximumBytes) {
  const candidate = path.resolve(root, relative);
  if (!SAFE_RELATIVE_PATH.test(relative) || !isPathWithin(root, candidate)) {
    return { blockers: ['path_unsafe'], content: null };
  }
  const read = readScopedFileSync({ scopeRoot: root, candidate, maximumBytes });
  return read.status === 'scoped_file_read_verified'
    ? { blockers: [], content: read.content, hash: read.hash, bytes: read.bytes }
    : { blockers: read.blockers || ['file_unreadable'], content: null };
}

export function parseResearchEvidenceCapsuleJson(content) {
  try { return JSON.parse(content.toString('utf8')); } catch { return null; }
}

export function readResearchEvidenceCapsuleSha256Sums(packageDir) {
  try {
    return new Map(fs.readFileSync(path.join(packageDir, 'SHA256SUMS.txt'), 'utf8')
      .split(/\r?\n/).filter(Boolean).map((line) => {
        const match = /^([a-f0-9]{64})\s+\*?(.+)$/i.exec(line);
        return match ? [match[2], `sha256:${match[1].toLowerCase()}`] : [line, null];
      }));
  } catch { return new Map(); }
}

export function listResearchEvidenceCapsuleFiles(packageDir) {
  const evidenceRoot = path.join(packageDir, 'evidence');
  const files = [];
  const visit = (directory) => {
    let entries = [];
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const candidate = path.join(directory, entry.name);
      const relative = path.relative(packageDir, candidate).replace(/\\/g, '/');
      if (entry.isSymbolicLink()) files.push(`unsafe:${relative}`);
      else if (entry.isDirectory()) visit(candidate);
      else if (entry.isFile()) files.push(relative);
      else files.push(`unsafe:${relative}`);
    }
  };
  visit(evidenceRoot);
  return files.sort();
}
