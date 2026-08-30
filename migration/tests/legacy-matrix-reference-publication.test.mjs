import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const verifier = path.join(
  workspaceRoot,
  'migration',
  'bin',
  'verify-legacy-matrix-reference-publication.mjs',
);
const pointer = path.join(
  workspaceRoot,
  'migration',
  'fixtures',
  'legacy-matrix-reference-publication-v1.json',
);

test('legacy matrix publication locator is metadata-verifiable offline', () => {
  assert.equal(fs.existsSync(pointer), true);
  const result = spawnSync(process.execPath, [verifier, '--metadata-only'], {
    cwd: workspaceRoot,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.status, 'legacy_matrix_reference_publication_metadata_verified');
  assert.equal(report.sourceFileCount, 263);
  assert.equal(report.matrixSha256,
    'sha256:59446f5e96cc5f086b27266f0fb0604d4f7f0e5bf1f62cb1a90933208a0f162a');
  assert.equal(report.companionCommit,
    'e275812d279007a87be536df6af3d5d6e9d84955');
});
