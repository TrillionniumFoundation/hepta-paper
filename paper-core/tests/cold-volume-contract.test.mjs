import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { verifyColdVolumeContract } from '../src/cold-volume-contract.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

test('cold-volume contract verifies logical links and fails closed until mounted content is manifested', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-cold-volume-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const assetRoot = path.join(root, 'assets');
  const mountRoot = path.join(root, 'mount');
  const logicalRoot = path.join(assetRoot, 'drafts', 'NDU_Nature_work');
  fs.mkdirSync(logicalRoot, { recursive: true });
  const contract = {
    version: 1,
    kind: 'ColdVolumeMountContract',
    contractId: 'fixture-v1',
    mountRoot,
    contentRoot: 'cold/NDU_Nature_work',
    sentinelRelativePath: 'cold/HEPTA_COLD_VOLUME_MANIFEST.json',
    contentManifestRequiredWhenMounted: true,
    entries: ['derivatives'],
  };
  fs.symlinkSync(path.join(mountRoot, contract.contentRoot, 'derivatives'), path.join(logicalRoot, 'derivatives'));
  const unavailable = verifyColdVolumeContract({ assetRoot, contract, mountAvailableOverride: false });
  assert.equal(unavailable.contractValid, true);
  assert.equal(unavailable.operationalReplayReady, false);
  fs.mkdirSync(path.join(mountRoot, contract.contentRoot, 'derivatives'), { recursive: true });
  const sentinelPayload = { version: 1, kind: 'ColdVolumeContentManifest', contractId: contract.contractId, entries: [] };
  const sentinel = { ...sentinelPayload, manifestHash: hashRecord('ColdVolumeContentManifest', sentinelPayload) };
  const sentinelPath = path.join(mountRoot, contract.sentinelRelativePath);
  fs.mkdirSync(path.dirname(sentinelPath), { recursive: true });
  fs.writeFileSync(sentinelPath, `${JSON.stringify(sentinel)}\n`);
  const ready = verifyColdVolumeContract({ assetRoot, contract, mountAvailableOverride: true });
  assert.equal(ready.status, 'cold_volume_mounted_and_content_verified');
  assert.equal(ready.operationalReplayReady, true);
});
