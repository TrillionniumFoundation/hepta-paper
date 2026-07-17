import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { drillColdVolumeCasRestore, importColdVolumeToCas } from '../../paper-adapters/archives/cold-volume-cas-repository.mjs';

test('cold-volume content imports to content-addressed objects and restores', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-cold-cas-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const assetRoot = path.join(root, 'assets');
  const mountRoot = path.join(root, 'mount');
  const contentRoot = path.join(mountRoot, 'cold', 'NDU_Nature_work');
  const logicalRoot = path.join(assetRoot, 'drafts', 'NDU_Nature_work');
  const casRoot = path.join(root, 'cas');
  fs.mkdirSync(path.join(contentRoot, 'derivatives'), { recursive: true });
  fs.writeFileSync(path.join(contentRoot, 'derivatives', 'result.txt'), 'verified\n');
  fs.mkdirSync(logicalRoot, { recursive: true });
  fs.symlinkSync(path.join(contentRoot, 'derivatives'), path.join(logicalRoot, 'derivatives'));
  const contract = {
    version: 1,
    kind: 'ColdVolumeMountContract',
    contractId: 'cas-fixture-v1',
    mountRoot,
    contentRoot: 'cold/NDU_Nature_work',
    sentinelRelativePath: 'cold/HEPTA_COLD_VOLUME_MANIFEST.json',
    contentManifestRequiredWhenMounted: false,
    entries: ['derivatives'],
  };
  const imported = importColdVolumeToCas({ assetRoot, contract, casRoot, execute: true, mountAvailableOverride: true });
  assert.equal(imported.status, 'cold_volume_cas_imported');
  assert.equal(imported.importedObjectCount, 1);
  const drill = drillColdVolumeCasRestore({ casRoot });
  assert.equal(drill.status, 'cold_volume_cas_restore_drill_passed');
  assert.equal(drill.restoredObjectCount, 1);
});

test('cold-volume CAS release gate fails closed when the manifest is missing', (t) => {
  const casRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-cold-cas-gate-test-'));
  t.after(() => fs.rmSync(casRoot, { recursive: true, force: true }));
  const cwd = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
  const env = { ...process.env, HEPTA_COLD_OBJECT_STORE_ROOT: casRoot };
  const status = spawnSync(process.execPath, ['paper-core/bin/cold-volume-cas.mjs', 'status'], {
    cwd, env, encoding: 'utf8',
  });
  assert.equal(status.status, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).status, 'cold_volume_cas_manifest_missing');

  const releaseGate = spawnSync(process.execPath, [
    'paper-core/bin/cold-volume-cas.mjs', 'status', '--require-ready',
  ], { cwd, env, encoding: 'utf8' });
  assert.equal(releaseGate.status, 1, releaseGate.stderr);
  assert.equal(JSON.parse(releaseGate.stdout).status, 'cold_volume_cas_manifest_missing');

  const manifestRoot = path.join(casRoot, 'manifests');
  fs.mkdirSync(manifestRoot);
  fs.writeFileSync(path.join(manifestRoot, 'invalid.json'), `${JSON.stringify({
    version: 1,
    kind: 'ColdVolumeCasManifest',
    contractId: 'invalid-fixture',
    contractHash: `sha256:${'1'.repeat(64)}`,
    entryCount: 0,
    entries: [],
    manifestHash: `sha256:${'0'.repeat(64)}`,
  })}\n`);
  const invalidGate = spawnSync(process.execPath, [
    'paper-core/bin/cold-volume-cas.mjs', 'status', '--require-ready',
  ], { cwd, env, encoding: 'utf8' });
  assert.equal(invalidGate.status, 1, invalidGate.stderr);
  assert.equal(JSON.parse(invalidGate.stdout).status, 'cold_volume_cas_blocked');
  assert.deepEqual(JSON.parse(invalidGate.stdout).blockers, ['cold_volume_cas_manifest_hash_invalid']);
});
