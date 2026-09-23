import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { hashRecord } from '../workflow-kernel/record-hash.mjs';

const migrationRoot = path.dirname(fileURLToPath(import.meta.url));
const manifestPath = path.join(migrationRoot, 'fixtures', 'legacy-differential-reference-v1.json');

function sha256File(file) {
  return `sha256:${crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`;
}

export function verifyLegacyDifferentialReference() {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const archivePath = path.join(path.dirname(manifestPath), manifest.archive);
  const blockers = [];
  if (manifest.kind !== 'ImmutableLegacyDifferentialReferenceManifest' || manifest.version !== 1) blockers.push('legacy_fixture_manifest_invalid');
  if (!fs.existsSync(archivePath) || sha256File(archivePath) !== manifest.archiveSha256) blockers.push('legacy_fixture_archive_hash_mismatch');
  const listing = blockers.length ? null : spawnSync('tar', ['-tzf', archivePath], { encoding: 'utf8' });
  const listed = String(listing?.stdout || '').trim().split('\n').filter(Boolean).sort();
  const expected = (manifest.files || []).map((item) => item.path).sort();
  if (listing?.status !== 0 || JSON.stringify(listed) !== JSON.stringify(expected)) blockers.push('legacy_fixture_archive_members_invalid');
  const payload = {
    version: 1,
    kind: 'ImmutableLegacyDifferentialReferenceVerification',
    status: blockers.length ? 'legacy_differential_reference_blocked' : 'legacy_differential_reference_verified',
    manifestPath,
    archivePath,
    archiveSha256: manifest.archiveSha256,
    fileCount: expected.length,
    blockers,
  };
  return Object.freeze({ ...payload, verificationHash: hashRecord('ImmutableLegacyDifferentialReferenceVerification', payload) });
}

export function materializeLegacyDifferentialReference() {
  const verification = verifyLegacyDifferentialReference();
  if (verification.status !== 'legacy_differential_reference_verified') throw new Error(verification.blockers.join(','));
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-legacy-differential-'));
  const extracted = spawnSync('tar', ['-xzf', verification.archivePath, '-C', root], { encoding: 'utf8' });
  if (extracted.status !== 0) {
    fs.rmSync(root, { recursive: true, force: true });
    throw new Error(extracted.stderr || 'legacy_fixture_extract_failed');
  }
  for (const file of manifest.files) {
    const candidate = path.join(root, file.path);
    if (!fs.existsSync(candidate) || fs.statSync(candidate).size !== file.bytes || sha256File(candidate) !== file.sha256) {
      fs.rmSync(root, { recursive: true, force: true });
      throw new Error(`legacy_fixture_file_mismatch:${file.path}`);
    }
    fs.chmodSync(candidate, 0o444);
  }
  return Object.freeze({
    root,
    verification,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  });
}
