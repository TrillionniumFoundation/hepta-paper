import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createOffhostWormSnapshot, drillOffhostWormRestore } from '../src/offhost-worm-repository.mjs';

test('offhost WORM snapshot binds immutable objects and supports restore verification', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-offhost-worm-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source.json');
  const target = path.join(root, 'target');
  fs.mkdirSync(target);
  fs.writeFileSync(source, '{"verified":true}\n');
  const contract = { version: 1, kind: 'OffhostWormSnapshotContract', contractId: 'fixture', targetMountRoot: target, requireDistinctFilesystemDevice: true, requireFilesystemImmutableObjects: true };
  const snapshot = createOffhostWormSnapshot({ workspaceRoot: root, contract, sources: [{ role: 'fixture', path: source }], execute: true, mountAvailableOverride: true, distinctDeviceOverride: true, immutableOverride: true });
  assert.equal(snapshot.status, 'offhost_worm_snapshot_recorded');
  const drill = drillOffhostWormRestore({ manifestPath: snapshot.manifestPath });
  assert.equal(drill.status, 'offhost_worm_restore_drill_passed');
  assert.equal(drill.verifiedObjectCount, 1);
});
