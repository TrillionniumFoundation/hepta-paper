import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { sha256FileSync } from '../../workflow-kernel/runtime/file-utils.mjs';

export function sha256File(file) {
  return sha256FileSync(file);
}

export function contentTreeManifest(root, relativeRoots) {
  const rows = [];
  function walk(absolute, relative) {
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) {
      rows.push({ path: relative, kind: 'symlink', target: fs.readlinkSync(absolute) });
      return;
    }
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(absolute).sort()) {
        walk(path.join(absolute, name), path.join(relative, name));
      }
      return;
    }
    if (stat.isFile()) {
      rows.push({
        path: relative.replace(/\\/g, '/'),
        kind: 'file',
        bytes: stat.size,
        sha256: sha256File(absolute),
      });
    }
  }
  for (const relative of [...relativeRoots].sort()) {
    const absolute = path.join(root, relative);
    if (fs.existsSync(absolute)) walk(absolute, relative);
  }
  const payload = rows.map((row) => JSON.stringify(row)).join('\n');
  return {
    version: 1,
    kind: 'ContentTreeManifest',
    root,
    relativeRoots: [...relativeRoots],
    fileCount: rows.filter((row) => row.kind === 'file').length,
    symlinkCount: rows.filter((row) => row.kind === 'symlink').length,
    totalBytes: rows.reduce((sum, row) => sum + Number(row.bytes || 0), 0),
    rows,
    treeHash: `sha256:${crypto.createHash('sha256').update(payload).digest('hex')}`,
  };
}
