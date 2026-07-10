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
  const drill = drillOffhostWormRestore({ manifestPath: snapshot.manifestPath, immutableOverride: true });
  assert.equal(drill.status, 'offhost_worm_restore_drill_passed');
  assert.equal(drill.verifiedObjectCount, 1);
  const mutableDrill = drillOffhostWormRestore({ manifestPath: snapshot.manifestPath, immutableOverride: false });
  assert.equal(mutableDrill.status, 'offhost_worm_restore_drill_blocked');
  assert.equal(mutableDrill.verifiedObjectCount, 0);
  assert.deepEqual(mutableDrill.blockers, ['offhost_worm_object_not_immutable:fixture']);
});

test('offhost WORM snapshot detects a corrupt pre-existing content-addressed object', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-offhost-worm-corrupt-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspaceRoot = path.join(root, 'workspace');
  const targetMountRoot = path.join(root, 'target');
  fs.mkdirSync(workspaceRoot, { recursive: true });
  fs.mkdirSync(targetMountRoot, { recursive: true });
  const source = path.join(workspaceRoot, 'source.json');
  fs.writeFileSync(source, '{"ok":true}\n');
  const contract = {
    version: 1,
    kind: 'OffhostWormSnapshotContract',
    contractId: 'test-worm-corrupt-v1',
    targetMountRoot,
    requireDistinctFilesystemDevice: true,
    requireFilesystemImmutableObjects: true,
  };
  const first = createOffhostWormSnapshot({
    workspaceRoot,
    contract,
    sources: [{ role: 'subject', path: source }],
    execute: true,
    mountAvailableOverride: true,
    distinctDeviceOverride: true,
    immutableOverride: true,
  });
  const manifest = JSON.parse(fs.readFileSync(first.manifestPath, 'utf8'));
  const objectPath = manifest.objects[0].objectPath;
  fs.chmodSync(objectPath, 0o644);
  fs.writeFileSync(objectPath, '{"corrupt":true}\n');
  const second = createOffhostWormSnapshot({
    workspaceRoot,
    contract,
    sources: [{ role: 'subject', path: source }],
    execute: true,
    mountAvailableOverride: true,
    distinctDeviceOverride: true,
    immutableOverride: true,
  });
  assert.equal(second.status, 'offhost_worm_snapshot_blocked');
  assert.deepEqual(second.blockers, ['offhost_worm_object_hash_mismatch:subject']);
});
