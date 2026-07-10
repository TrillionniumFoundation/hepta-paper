import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { drillColdVolumeCasRestore, importColdVolumeToCas } from '../src/cold-volume-cas-repository.mjs';

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
