import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createPackageRecoveryExactRestoreRepository }
  from '../../paper-adapters/automation/package-recovery-exact-restore-repository.mjs';
import { inspectPackageRecoveryTreeInventorySync }
  from '../../paper-adapters/automation/package-recovery-tree-inventory-repository.mjs';
import {
  createPackageRecoveryTreeInventory,
  verifyPackageRecoveryTreeInventory,
} from '../../paper-domain/automation/package-recovery-tree-inventory-contract.mjs';

function restoreWritable(candidate) {
  let stat;
  try { stat = fs.lstatSync(candidate); } catch { return; }
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    try { fs.chmodSync(candidate, 0o700); } catch { return; }
    for (const name of fs.readdirSync(candidate)) {
      restoreWritable(path.join(candidate, name));
    }
  } else {
    try { fs.chmodSync(candidate, 0o600); } catch { /* best effort */ }
  }
}

function temporaryRoot(t, prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => {
    restoreWritable(root);
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}

function buildSource(root, name = 'source') {
  const source = path.join(root, name);
  fs.mkdirSync(path.join(source, 'nested'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(source, 'PACKAGE_RECORD.json'), 'package-record\n');
  fs.writeFileSync(path.join(source, 'nested', 'runner.sh'), '#!/bin/sh\nexit 0\n');
  fs.chmodSync(path.join(source, 'PACKAGE_RECORD.json'), 0o440);
  fs.chmodSync(path.join(source, 'nested', 'runner.sh'), 0o550);
  fs.chmodSync(path.join(source, 'nested'), 0o550);
  fs.chmodSync(source, 0o500);
  return source;
}

function boundaries(t, name = 'boundary') {
  const root = temporaryRoot(t, `hepta-package-recovery-${name}-`);
  const runtimeRoot = path.join(root, 'runtime');
  const restoreRoot = path.join(root, 'restore');
  const storageRoot = path.join(root, 'storage');
  const storageObjectPath = path.join(storageRoot, 'package.archive');
  fs.mkdirSync(runtimeRoot, { mode: 0o700 });
  fs.mkdirSync(restoreRoot, { mode: 0o700 });
  fs.mkdirSync(storageRoot, { mode: 0o700 });
  fs.writeFileSync(storageObjectPath, 'immutable archive bytes\n');
  fs.chmodSync(storageObjectPath, 0o444);
  return { root, runtimeRoot, restoreRoot, storageObjectPath };
}

function sourceBytes(source, relative) {
  return fs.readFileSync(path.join(source, ...relative.split('/')));
}

function repositoryFor(fixture, options = {}) {
  return createPackageRecoveryExactRestoreRepository({
    restoreRoot: fixture.restoreRoot,
    runtimeRoot: fixture.runtimeRoot,
    storageObjectPath: fixture.storageObjectPath,
    ...options,
  });
}

test('canonical recovery inventory binds exact path, bytes, mode, and ownership', (t) => {
  const root = temporaryRoot(t, 'hepta-package-recovery-inventory-');
  const source = buildSource(root);
  const first = inspectPackageRecoveryTreeInventorySync({ packagePath: source });
  assert.equal(verifyPackageRecoveryTreeInventory(first.inventory).valid, true);
  assert.deepEqual(first.inventory.entries.map((entry) => entry.path), [
    '.', 'PACKAGE_RECORD.json', 'nested', 'nested/runner.sh',
  ]);
  assert.equal(first.inventory.fileCount, 2);
  assert.equal(first.inventory.directoryCount, 2);
  assert.equal(first.inventory.entries.every((entry) =>
    Number.isSafeInteger(entry.uid) && Number.isSafeInteger(entry.gid)), true);
  const ownerChanged = createPackageRecoveryTreeInventory({
    entries: first.inventory.entries.map((entry, index) => ({
      ...entry,
      uid: index === 1 ? entry.uid + 1 : entry.uid,
    })),
  });
  assert.notEqual(
    ownerChanged.packageRecoveryTreeInventoryHash,
    first.inventory.packageRecoveryTreeInventoryHash,
  );

  fs.chmodSync(path.join(source, 'nested', 'runner.sh'), 0o500);
  const modeChanged = inspectPackageRecoveryTreeInventorySync({ packagePath: source });
  assert.notEqual(
    modeChanged.inventory.packageRecoveryTreeInventoryHash,
    first.inventory.packageRecoveryTreeInventoryHash,
  );
  fs.chmodSync(path.join(source, 'nested', 'runner.sh'), 0o700);
  fs.writeFileSync(path.join(source, 'nested', 'runner.sh'), '#!/bin/sh\nexit 1\n');
  fs.chmodSync(path.join(source, 'nested', 'runner.sh'), 0o550);
  const bytesChanged = inspectPackageRecoveryTreeInventorySync({ packagePath: source });
  assert.notEqual(
    bytesChanged.inventory.packageRecoveryTreeInventoryHash,
    first.inventory.packageRecoveryTreeInventoryHash,
  );
});

test('inventory contract rejects traversal, duplicates, missing parents, and unsafe modes', () => {
  const ownership = { uid: 1000, gid: 1000 };
  const directory = (selectedPath, posixMode = 0o500) => ({
    path: selectedPath, kind: 'directory', posixMode, ...ownership,
  });
  const file = (selectedPath) => ({
    path: selectedPath, kind: 'file', posixMode: 0o400, ...ownership,
    bytes: 0, bytesHash: `sha256:${'e'.repeat(64)}`,
  });
  for (const entries of [
    [directory('.'), file('../escape')],
    [directory('.'), file('duplicate'), file('duplicate')],
    [directory('.'), file('missing/parent')],
    [directory('.', 0o400)],
  ]) {
    assert.throws(
      () => createPackageRecoveryTreeInventory({ entries }),
      /package_recovery_tree_inventory_invalid/,
    );
  }
});

test('pinned inventory rejects symlink, hardlink, FIFO, and ancestor symlink roots', (t) => {
  const root = temporaryRoot(t, 'hepta-package-recovery-unsafe-tree-');
  const outside = path.join(root, 'outside');
  fs.writeFileSync(outside, 'outside\n');

  const symlinkTree = path.join(root, 'symlink-tree');
  fs.mkdirSync(symlinkTree);
  fs.symlinkSync(outside, path.join(symlinkTree, 'link'));
  assert.throws(
    () => inspectPackageRecoveryTreeInventorySync({ packagePath: symlinkTree }),
    /package_recovery_tree_entry_unsafe/,
  );

  const hardlinkTree = path.join(root, 'hardlink-tree');
  fs.mkdirSync(hardlinkTree);
  fs.writeFileSync(path.join(hardlinkTree, 'first'), 'same inode\n');
  fs.linkSync(path.join(hardlinkTree, 'first'), path.join(hardlinkTree, 'second'));
  assert.throws(
    () => inspectPackageRecoveryTreeInventorySync({ packagePath: hardlinkTree }),
    /package_recovery_tree_entry_unsafe/,
  );

  const fifoTree = path.join(root, 'fifo-tree');
  fs.mkdirSync(fifoTree);
  const fifo = path.join(fifoTree, 'pipe');
  const created = spawnSync('mkfifo', [fifo], { encoding: 'utf8' });
  assert.equal(created.status, 0, created.stderr);
  assert.throws(
    () => inspectPackageRecoveryTreeInventorySync({ packagePath: fifoTree }),
    /package_recovery_tree_entry_unsafe/,
  );

  const realParent = path.join(root, 'real-parent');
  fs.mkdirSync(realParent);
  buildSource(realParent, 'tree');
  const alias = path.join(root, 'alias');
  fs.symlinkSync(realParent, alias);
  assert.throws(
    () => inspectPackageRecoveryTreeInventorySync({
      packagePath: path.join(alias, 'tree'),
    }),
    /package_recovery_tree_root_invalid/,
  );
});

test('exact restore uses a fresh pinned target and removes it after durable evidence callback', (t) => {
  const fixture = boundaries(t, 'happy');
  const source = buildSource(fixture.runtimeRoot, 'packages/source');
  const expected = inspectPackageRecoveryTreeInventorySync({ packagePath: source }).inventory;
  let restoreTargetPath;
  const evidence = repositoryFor(fixture).withExactRestore({
    expectedInventory: expected,
    readFileBytes: (relative) => sourceBytes(source, relative),
    operation(context) {
      restoreTargetPath = context.restoreTargetPath;
      assert.equal(context.targetInitiallyEmpty, true);
      assert.equal(path.dirname(context.restoreTargetPath), fixture.restoreRoot);
      assert.equal(context.restoreTargetRealPath, context.restoreTargetPath);
      assert.equal(context.restoredInventory.packageRecoveryTreeInventoryHash,
        expected.packageRecoveryTreeInventoryHash);
      assert.equal(context.assertLive().inventory.packageRecoveryTreeInventoryHash,
        expected.packageRecoveryTreeInventoryHash);
      assert.equal(
        fs.lstatSync(path.join(context.restoreTargetPath, 'nested', 'runner.sh')).mode & 0o777,
        0o550,
      );
      return Object.freeze({
        restoreTargetIdentityHash: context.restoreTargetIdentityHash,
        inventoryHash: context.restoredInventory.packageRecoveryTreeInventoryHash,
      });
    },
  });
  assert.match(evidence.restoreTargetIdentityHash, /^sha256:[a-f0-9]{64}$/);
  assert.equal(evidence.inventoryHash, expected.packageRecoveryTreeInventoryHash);
  assert.equal(fs.existsSync(restoreTargetPath), false);
  assert.deepEqual(fs.readdirSync(fixture.restoreRoot), []);
});

test('exact restore rejects preoccupied targets and preserves the collision', (t) => {
  const fixture = boundaries(t, 'collision');
  const source = buildSource(fixture.runtimeRoot, 'packages/source');
  const expected = inspectPackageRecoveryTreeInventorySync({ packagePath: source }).inventory;
  const entropy = Buffer.alloc(16, 7);
  const collision = path.join(fixture.restoreRoot, `restore-${entropy.toString('hex')}`);
  fs.mkdirSync(collision);
  fs.writeFileSync(path.join(collision, 'operator-residue'), 'preserve\n');
  const repository = repositoryFor(fixture, { randomBytes: () => entropy });
  assert.throws(() => repository.withExactRestore({
    expectedInventory: expected,
    readFileBytes: (relative) => sourceBytes(source, relative),
    operation() {},
  }), /package_recovery_restore_target_collision/);
  assert.equal(fs.readFileSync(path.join(collision, 'operator-residue'), 'utf8'), 'preserve\n');
});

test('exact restore rejects symlinked or overlapping boundary roots', (t) => {
  const fixture = boundaries(t, 'boundary-alias');
  const source = buildSource(fixture.runtimeRoot, 'packages/source');
  const expected = inspectPackageRecoveryTreeInventorySync({ packagePath: source }).inventory;
  const aliasedParent = path.join(fixture.root, 'aliased-parent');
  fs.symlinkSync(fixture.root, aliasedParent);
  const aliasedRestore = path.join(aliasedParent, 'restore');
  const request = {
    expectedInventory: expected,
    readFileBytes: (relative) => sourceBytes(source, relative),
    operation() {},
  };
  assert.throws(
    () => createPackageRecoveryExactRestoreRepository({
      restoreRoot: aliasedRestore,
      runtimeRoot: fixture.runtimeRoot,
      storageObjectPath: fixture.storageObjectPath,
    }).withExactRestore(request),
    /package_recovery_restore_root_unsafe/,
  );
  assert.throws(
    () => createPackageRecoveryExactRestoreRepository({
      restoreRoot: fixture.restoreRoot,
      runtimeRoot: fixture.runtimeRoot,
      storageObjectPath: path.join(fixture.runtimeRoot, 'packages', 'source', 'PACKAGE_RECORD.json'),
    }).withExactRestore(request),
    /package_recovery_storage_object_unsafe|package_recovery_restore_boundary_not_disjoint/,
  );
});

test('exact restore rejects wrong archive bytes and cleans its partial target', (t) => {
  const fixture = boundaries(t, 'wrong-bytes');
  const source = buildSource(fixture.runtimeRoot, 'packages/source');
  const expected = inspectPackageRecoveryTreeInventorySync({ packagePath: source }).inventory;
  assert.throws(() => repositoryFor(fixture).withExactRestore({
    expectedInventory: expected,
    readFileBytes(relative) {
      return relative === 'nested/runner.sh'
        ? Buffer.from('substituted\n') : sourceBytes(source, relative);
    },
    operation() {},
  }), /package_recovery_restore_file_bytes_mismatch/);
  assert.deepEqual(fs.readdirSync(fixture.restoreRoot), []);
});

test('cleanup refuses a replaced target and preserves both identities', (t) => {
  const fixture = boundaries(t, 'replacement');
  const source = buildSource(fixture.runtimeRoot, 'packages/source');
  const expected = inspectPackageRecoveryTreeInventorySync({ packagePath: source }).inventory;
  let displaced;
  let replacement;
  assert.throws(() => repositoryFor(fixture).withExactRestore({
    expectedInventory: expected,
    readFileBytes: (relative) => sourceBytes(source, relative),
    operation(context) {
      displaced = `${context.restoreTargetPath}.displaced`;
      replacement = context.restoreTargetPath;
      fs.renameSync(context.restoreTargetPath, displaced);
      fs.mkdirSync(replacement, { mode: 0o700 });
    },
  }), (error) => {
    assert.equal(error instanceof AggregateError, true);
    assert.match(error.message, /package_recovery_restore_and_cleanup_failed/);
    return true;
  });
  assert.equal(fs.lstatSync(displaced).isDirectory(), true);
  assert.equal(fs.lstatSync(replacement).isDirectory(), true);
});

test('cleanup refuses an in-tree inode replacement even when bytes and modes match', (t) => {
  const fixture = boundaries(t, 'child-replacement');
  const source = buildSource(fixture.runtimeRoot, 'packages/source');
  const expected = inspectPackageRecoveryTreeInventorySync({ packagePath: source }).inventory;
  let target;
  assert.throws(() => repositoryFor(fixture).withExactRestore({
    expectedInventory: expected,
    readFileBytes: (relative) => sourceBytes(source, relative),
    operation(context) {
      target = context.restoreTargetPath;
      const selected = path.join(target, 'PACKAGE_RECORD.json');
      fs.chmodSync(target, 0o700);
      fs.unlinkSync(selected);
      fs.writeFileSync(selected, sourceBytes(source, 'PACKAGE_RECORD.json'));
      fs.chmodSync(selected, 0o440);
      fs.chmodSync(target, 0o500);
    },
  }), /package_recovery_restore_cleanup_identity_changed/);
  assert.equal(fs.lstatSync(target).isDirectory(), true);
  assert.equal(fs.readFileSync(path.join(target, 'PACKAGE_RECORD.json'), 'utf8'), 'package-record\n');
});
