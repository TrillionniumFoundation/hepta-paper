import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(testDirectory, '..', '..');
const workflowRelativePath = '../../.github/workflows/legacy-matrix-reference-verification.yml';
const verifierRelativePath = '../bin/verify-legacy-matrix-reference-publication.mjs';
const pointerRelativePath = '../fixtures/legacy-matrix-reference-publication-v1.json';
const workflow = path.resolve(testDirectory, workflowRelativePath);
const verifier = path.resolve(testDirectory, verifierRelativePath);
const pointer = path.resolve(testDirectory, pointerRelativePath);

test('legacy matrix publication locator is metadata-verifiable offline', () => {
  assert.equal(fs.existsSync(workflow), true);
  assert.equal(fs.existsSync(verifier), true);
  assert.equal(fs.existsSync(pointer), true);
  const workflowSource = fs.readFileSync(workflow, 'utf8');
  assert.match(workflowSource, /^name: legacy-matrix-reference-verification$/mu);
  assert.match(workflowSource, /^permissions:\n  contents: read$/mu);
  assert.match(workflowSource, /HEPTA_LEGACY_REFERENCE_READ_TOKEN/u);
  assert.doesNotMatch(workflowSource, /\bpull_request_target\s*:/u);
  assert.doesNotMatch(workflowSource, /\bcontents:\s*write\b/u);
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
