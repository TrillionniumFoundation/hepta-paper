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
const policy = path.join(
  workspaceRoot,
  'migration',
  'fixtures',
  'legacy-matrix-reference-verification-policy-v1.json',
);
const receiptSchema = path.join(
  workspaceRoot,
  'migration',
  'fixtures',
  'legacy-matrix-reference-exact-head-receipt-v1.schema.json',
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

test('prepared reference status binds the verified digests without reopening the archive', () => {
  const preparedRoot = fs.mkdtempSync(path.join('/tmp', 'hepta-prepared-reference-test-'));
  try {
    const modulePath = path.join(workspaceRoot, 'migration', 'legacy-matrix-reference.mjs');
    const result = spawnSync(process.execPath, [
      '--input-type=module',
      '-e',
      `import { immutableLegacyMatrixReferenceStatus } from ${JSON.stringify(modulePath)};
        const status = immutableLegacyMatrixReferenceStatus();
        process.stdout.write(JSON.stringify(status));`,
    ], {
      cwd: workspaceRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        HEPTA_LEGACY_REFERENCE_PREPARED: '1',
        PAPER_FACTORY_LEGACY_ROOT: preparedRoot,
        HEPTA_LEGACY_REFERENCE_VERIFIED_ARCHIVE_SHA256:
          'sha256:e431c4c7a51a15d64866b17a07c09dd17c15c32c8dddaccf1a769b1a5942cb9d',
        HEPTA_LEGACY_REFERENCE_VERIFIED_MATRIX_SHA256:
          'sha256:59446f5e96cc5f086b27266f0fb0604d4f7f0e5bf1f62cb1a90933208a0f162a',
      },
    });
    assert.equal(result.status, 0, result.stderr);
    const status = JSON.parse(result.stdout);
    assert.equal(status.status, 'immutable_legacy_matrix_reference_prepared');
    assert.equal(status.archivePath, null);
    assert.equal(status.archiveMaterialized, false);
    assert.equal(status.sourceFileCount, 263);
  } finally {
    fs.rmSync(preparedRoot, { recursive: true, force: true });
  }
});

test('verification policy and receipt schema bind the reviewed candidate snapshot', () => {
  const policyDocument = JSON.parse(fs.readFileSync(policy, 'utf8'));
  assert.equal(policyDocument.kind, 'LegacyMatrixReferenceVerificationPolicy');
  assert.equal(policyDocument.candidate.sha, '37543c9e06113199bc2aa8a6a344203ece6c71e5');
  assert.equal(policyDocument.candidate.tree, 'c490cb85b33637f9882f640ab3718323fb47c7df');
  assert.equal(policyDocument.archive.sourceFileCount, 263);
  assert.equal(policyDocument.workflow.trustMode, 'private-companion-admin-controlled');
  const schemaDocument = JSON.parse(fs.readFileSync(receiptSchema, 'utf8'));
  assert.equal(schemaDocument.properties.schemaVersion.const, 2);
  assert.equal(schemaDocument.properties.externalAuthorityGranted.const, false);
});
