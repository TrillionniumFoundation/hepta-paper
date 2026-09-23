#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const matrixPath = path.join(workspaceRoot, 'migration', 'legacy-semantic-migration-matrix.json');
const referenceManifestPath = path.join(workspaceRoot, 'migration', 'fixtures', 'legacy-matrix-reference-v1.json');
const execute = process.argv.includes('--execute');

function sha256(candidate) {
  return crypto.createHash('sha256').update(fs.readFileSync(candidate)).digest('hex');
}

function workspacePath(value) {
  const relative = String(value || '').replace(/^hepta-paper-workspace\//, '');
  const candidate = path.resolve(workspaceRoot, relative);
  if (candidate !== workspaceRoot && !candidate.startsWith(`${workspaceRoot}${path.sep}`)) {
    throw new Error(`matrix_path_outside_workspace:${value}`);
  }
  return candidate;
}

const matrix = JSON.parse(fs.readFileSync(matrixPath, 'utf8'));
const changes = [];
for (const entry of matrix.entries || []) {
  const target = workspacePath(entry.target?.path);
  if (fs.existsSync(target) && fs.statSync(target).isFile()) {
    const hash = sha256(target);
    if (entry.target.sha256 !== hash) {
      changes.push({ id: entry.id, field: 'target.sha256', before: entry.target.sha256, after: hash });
      entry.target.sha256 = hash;
    }
  }
  for (const behaviorTest of entry.behaviorTests || []) {
    const candidate = workspacePath(behaviorTest.path);
    if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) continue;
    const hash = sha256(candidate);
    if (behaviorTest.sha256 !== hash) {
      changes.push({ id: entry.id, field: `behaviorTests.${behaviorTest.id}.sha256`, before: behaviorTest.sha256, after: hash });
      behaviorTest.sha256 = hash;
    }
  }
}
if (execute && changes.length) {
  const temporary = `${matrixPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(matrix, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, matrixPath);
}
const referenceManifest = JSON.parse(fs.readFileSync(referenceManifestPath, 'utf8'));
const currentMatrixHash = `sha256:${sha256(matrixPath)}`;
const referenceManifestChanged = referenceManifest.matrixSha256 !== currentMatrixHash;
if (execute && referenceManifestChanged) {
  referenceManifest.matrixSha256 = currentMatrixHash;
  const manifestTemporary = `${referenceManifestPath}.${process.pid}.tmp`;
  fs.writeFileSync(manifestTemporary, `${JSON.stringify(referenceManifest, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(manifestTemporary, referenceManifestPath);
}
process.stdout.write(`${JSON.stringify({
  version: 1,
  kind: 'SemanticMigrationHashRefreshPlan',
  status: execute ? 'semantic_migration_hashes_refreshed' : 'semantic_migration_hash_refresh_planned',
  changeCount: changes.length,
  referenceManifestChanged,
  changes,
  semanticFieldsModified: false,
}, null, 2)}\n`);
