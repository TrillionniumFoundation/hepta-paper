import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  createPackageRecoveryTreeInventory,
  verifyPackageRecoveryTreeInventory,
} from '../../paper-domain/automation/package-recovery-tree-inventory-contract.mjs';
import { hashBytes } from '../../workflow-kernel/record-hash.mjs';
import {
  anchorIdentity,
  assertDisjointBoundaries,
  assertPinnedDirectoryCurrent,
  assertPinnedStorageCurrent,
  canonicalAbsolutePath,
  descriptorPath,
  openPinnedDirectory,
  openPinnedStorageObject,
  sameIdentity,
} from './package-recovery-exact-restore-boundary.mjs';
import { inspectPinnedPackageRecoveryTreeInventorySync }
  from './package-recovery-tree-inventory-repository.mjs';

const NO_FOLLOW = fs.constants.O_NOFOLLOW || 0;
const DIRECTORY_ONLY = fs.constants.O_DIRECTORY || 0;
const TARGET_RANDOM_BYTES = 16;

function createdIdentity(stat) {
  return Object.freeze({
    dev: String(stat.dev),
    ino: String(stat.ino),
    kind: stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'unsafe',
  });
}

function cleanupIdentity(stat) {
  return Object.freeze({
    ...createdIdentity(stat),
    mode: String(stat.mode), nlink: String(stat.nlink), size: String(stat.size),
    uid: String(stat.uid), gid: String(stat.gid), mtimeNs: String(stat.mtimeNs),
    ctimeNs: String(stat.ctimeNs), birthtimeNs: String(stat.birthtimeNs),
  });
}


function safeNames(descriptor) {
  return fs.readdirSync(descriptorPath(descriptor), { encoding: 'buffer' })
    .sort((left, right) => Buffer.compare(left, right))
    .map((raw) => {
      const name = raw.toString('utf8');
      if (!Buffer.from(name, 'utf8').equals(raw) || !name
        || name === '.' || name === '..' || name.includes('/') || name.includes('\0')) {
        throw new Error('package_recovery_restore_target_entry_unsafe');
      }
      return name;
    });
}

function relativeParent(value) {
  const boundary = value.lastIndexOf('/');
  return boundary < 0 ? '.' : value.slice(0, boundary);
}

function relativeName(value) {
  const boundary = value.lastIndexOf('/');
  return boundary < 0 ? value : value.slice(boundary + 1);
}

function openRelativeDirectory(rootDescriptor, relative) {
  if (relative === '.') return { descriptor: rootDescriptor, close: false };
  let current = rootDescriptor;
  let closeCurrent = false;
  try {
    for (const component of relative.split('/')) {
      const selectedPath = path.join(descriptorPath(current), component);
      const selected = fs.lstatSync(selectedPath, { bigint: true });
      if (!selected.isDirectory() || selected.isSymbolicLink()) {
        throw new Error('package_recovery_restore_parent_unsafe');
      }
      const next = fs.openSync(
        selectedPath,
        fs.constants.O_RDONLY | DIRECTORY_ONLY | NO_FOLLOW,
      );
      const opened = fs.fstatSync(next, { bigint: true });
      if (!opened.isDirectory()
        || !sameIdentity(anchorIdentity(selected), anchorIdentity(opened))) {
        fs.closeSync(next);
        throw new Error('package_recovery_restore_parent_changed');
      }
      if (closeCurrent) fs.closeSync(current);
      current = next;
      closeCurrent = true;
    }
    return { descriptor: current, close: closeCurrent };
  } catch (error) {
    if (closeCurrent) fs.closeSync(current);
    throw error;
  }
}

function writeAll(descriptor, bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    offset += fs.writeSync(descriptor, bytes, offset, bytes.length - offset);
  }
}

function applyOwnership(descriptor, entry) {
  let stat = fs.fstatSync(descriptor, { bigint: true });
  if (stat.uid !== BigInt(entry.uid) || stat.gid !== BigInt(entry.gid)) {
    fs.fchownSync(descriptor, entry.uid, entry.gid);
    stat = fs.fstatSync(descriptor, { bigint: true });
  }
  if (stat.uid !== BigInt(entry.uid) || stat.gid !== BigInt(entry.gid)) {
    throw new Error('package_recovery_restore_ownership_mismatch');
  }
}

function materializeInventory({ targetDescriptor, inventory, readFileBytes, created }) {
  for (const entry of inventory.entries.slice(1)) {
    const parent = openRelativeDirectory(targetDescriptor, relativeParent(entry.path));
    try {
      const childPath = path.join(descriptorPath(parent.descriptor), relativeName(entry.path));
      if (entry.kind === 'directory') {
        try { fs.mkdirSync(childPath, { mode: 0o700 }); } catch (error) {
          if (error?.code === 'EEXIST') {
            throw new Error('package_recovery_restore_entry_collision');
          }
          throw error;
        }
        const selected = fs.lstatSync(childPath, { bigint: true });
        if (!selected.isDirectory() || selected.isSymbolicLink()) {
          throw new Error('package_recovery_restore_entry_unsafe');
        }
        created.set(entry.path, createdIdentity(selected));
        const child = fs.openSync(
          childPath,
          fs.constants.O_RDONLY | DIRECTORY_ONLY | NO_FOLLOW,
        );
        try {
          const opened = fs.fstatSync(child, { bigint: true });
          if (!sameIdentity(created.get(entry.path), createdIdentity(opened))) {
            throw new Error('package_recovery_restore_entry_changed');
          }
          applyOwnership(child, entry);
          fs.fsyncSync(child);
        } finally { fs.closeSync(child); }
        fs.fsyncSync(parent.descriptor);
        continue;
      }
      const supplied = readFileBytes(entry.path, Object.freeze({ ...entry }));
      if (!Buffer.isBuffer(supplied) && !(supplied instanceof Uint8Array)) {
        throw new Error('package_recovery_restore_file_bytes_invalid');
      }
      const bytes = Buffer.from(supplied);
      if (bytes.length !== entry.bytes || hashBytes(bytes) !== entry.bytesHash) {
        throw new Error('package_recovery_restore_file_bytes_mismatch');
      }
      let fileDescriptor;
      try {
        fileDescriptor = fs.openSync(
          childPath,
          fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NO_FOLLOW,
          0o600,
        );
      } catch (error) {
        if (error?.code === 'EEXIST') {
          throw new Error('package_recovery_restore_entry_collision');
        }
        throw error;
      }
      try {
        const opened = fs.fstatSync(fileDescriptor, { bigint: true });
        if (!opened.isFile() || opened.nlink !== 1n) {
          throw new Error('package_recovery_restore_entry_unsafe');
        }
        created.set(entry.path, createdIdentity(opened));
        writeAll(fileDescriptor, bytes);
        applyOwnership(fileDescriptor, entry);
        fs.fchmodSync(fileDescriptor, entry.posixMode);
        fs.fsyncSync(fileDescriptor);
        const completed = fs.fstatSync(fileDescriptor, { bigint: true });
        if (!sameIdentity(created.get(entry.path), createdIdentity(completed))
          || completed.nlink !== 1n || Number(completed.size) !== entry.bytes
          || Number(completed.mode & 0o777n) !== entry.posixMode) {
          throw new Error('package_recovery_restore_entry_changed');
        }
      } finally { if (fileDescriptor !== undefined) fs.closeSync(fileDescriptor); }
      fs.fsyncSync(parent.descriptor);
    } finally { if (parent.close) fs.closeSync(parent.descriptor); }
  }
  const directories = inventory.entries.filter((entry) => entry.kind === 'directory')
    .sort((left, right) => {
      const depth = (entry) => entry.path === '.' ? 0 : entry.path.split('/').length;
      return depth(right) - depth(left);
    });
  for (const entry of directories) {
    const selected = openRelativeDirectory(targetDescriptor, entry.path);
    try {
      applyOwnership(selected.descriptor, entry);
      fs.fchmodSync(selected.descriptor, entry.posixMode);
      fs.fsyncSync(selected.descriptor);
      const completed = fs.fstatSync(selected.descriptor, { bigint: true });
      if (Number(completed.mode & 0o777n) !== entry.posixMode) {
        throw new Error('package_recovery_restore_mode_mismatch');
      }
    } finally { if (selected.close) fs.closeSync(selected.descriptor); }
  }
}

function collectCreatedTree(descriptor, relative, observed) {
  const stat = fs.fstatSync(descriptor, { bigint: true });
  observed.set(relative || '.', cleanupIdentity(stat));
  for (const name of safeNames(descriptor)) {
    const childPath = path.join(descriptorPath(descriptor), name);
    const selected = fs.lstatSync(childPath, { bigint: true });
    const childRelative = relative ? `${relative}/${name}` : name;
    if (selected.isSymbolicLink() || (!selected.isDirectory() && !selected.isFile())) {
      throw new Error('package_recovery_restore_cleanup_unsafe');
    }
    if (selected.isDirectory()) {
      const child = fs.openSync(
        childPath,
        fs.constants.O_RDONLY | DIRECTORY_ONLY | NO_FOLLOW,
      );
      try { collectCreatedTree(child, childRelative, observed); }
      finally { fs.closeSync(child); }
    } else observed.set(childRelative, cleanupIdentity(selected));
  }
}

function sealCleanupIdentities(targetDescriptor, created) {
  const observed = new Map();
  collectCreatedTree(targetDescriptor, '', observed);
  if (observed.size !== created.size
    || [...created].some(([relative, identity]) =>
      !sameIdentity(identity, observed.get(relative)))) {
    throw new Error('package_recovery_restore_entry_changed');
  }
  created.clear();
  for (const [relative, identity] of observed) created.set(relative, identity);
}

function assertCreatedTreeExact(targetDescriptor, created) {
  const observed = new Map();
  collectCreatedTree(targetDescriptor, '', observed);
  if (observed.size !== created.size
    || [...created].some(([relative, identity]) =>
      !sameIdentity(identity, observed.get(relative)))) {
    throw new Error('package_recovery_restore_cleanup_identity_changed');
  }
}

function removeCreatedContents(descriptor, relative, created) {
  fs.fchmodSync(descriptor, 0o700);
  for (const name of safeNames(descriptor)) {
    const childPath = path.join(descriptorPath(descriptor), name);
    const selected = fs.lstatSync(childPath, { bigint: true });
    const childRelative = relative ? `${relative}/${name}` : name;
    if (!sameIdentity(created.get(childRelative), cleanupIdentity(selected))) {
      throw new Error('package_recovery_restore_cleanup_identity_changed');
    }
    if (selected.isDirectory()) {
      const child = fs.openSync(
        childPath,
        fs.constants.O_RDONLY | DIRECTORY_ONLY | NO_FOLLOW,
      );
      try { removeCreatedContents(child, childRelative, created); }
      finally { fs.closeSync(child); }
      fs.rmdirSync(childPath);
    } else if (selected.isFile() && !selected.isSymbolicLink()) {
      fs.unlinkSync(childPath);
    } else throw new Error('package_recovery_restore_cleanup_unsafe');
  }
  fs.fsyncSync(descriptor);
}

function assertTargetAtPath(target) {
  const selected = fs.lstatSync(target.path, { bigint: true });
  const opened = fs.fstatSync(target.descriptor, { bigint: true });
  if (!selected.isDirectory() || selected.isSymbolicLink()
    || fs.realpathSync.native(target.path) !== target.realPath
    || !sameIdentity(target.createdIdentity, createdIdentity(selected))
    || !sameIdentity(target.createdIdentity, createdIdentity(opened))) {
    throw new Error('package_recovery_restore_target_identity_changed');
  }
}

function cleanupTarget(target, restoreRoot, created) {
  assertTargetAtPath(target);
  assertCreatedTreeExact(target.descriptor, created);
  removeCreatedContents(target.descriptor, '', created);
  assertTargetAtPath(target);
  fs.closeSync(target.descriptor);
  target.closed = true;
  const selected = fs.lstatSync(
    path.join(descriptorPath(restoreRoot.descriptor), target.name),
    { bigint: true },
  );
  if (!sameIdentity(target.createdIdentity, createdIdentity(selected))) {
    throw new Error('package_recovery_restore_target_identity_changed');
  }
  fs.rmdirSync(path.join(descriptorPath(restoreRoot.descriptor), target.name));
  fs.fsyncSync(restoreRoot.descriptor);
}

function createTarget(restoreRoot, randomBytes) {
  const entropy = randomBytes(TARGET_RANDOM_BYTES);
  if (!Buffer.isBuffer(entropy) || entropy.length < TARGET_RANDOM_BYTES) {
    throw new Error('package_recovery_restore_target_entropy_invalid');
  }
  const name = `restore-${entropy.subarray(0, TARGET_RANDOM_BYTES).toString('hex')}`;
  const pinnedPath = path.join(descriptorPath(restoreRoot.descriptor), name);
  try { fs.mkdirSync(pinnedPath, { mode: 0o700 }); } catch (error) {
    if (error?.code === 'EEXIST') {
      throw new Error('package_recovery_restore_target_collision');
    }
    throw error;
  }
  const selected = fs.lstatSync(pinnedPath, { bigint: true });
  let descriptor;
  try {
    descriptor = fs.openSync(
      pinnedPath,
      fs.constants.O_RDONLY | DIRECTORY_ONLY | NO_FOLLOW,
    );
    const opened = fs.fstatSync(descriptor, { bigint: true });
    const identity = createdIdentity(opened);
    if (!opened.isDirectory() || selected.isSymbolicLink()
      || !sameIdentity(createdIdentity(selected), identity)
      || safeNames(descriptor).length !== 0) {
      throw new Error('package_recovery_restore_target_unsafe');
    }
    const targetPath = path.join(restoreRoot.path, name);
    const realPath = fs.realpathSync.native(targetPath);
    if (realPath !== targetPath) throw new Error('package_recovery_restore_target_unsafe');
    fs.fsyncSync(restoreRoot.descriptor);
    return {
      name, path: targetPath, realPath, descriptor,
      createdIdentity: identity, closed: false,
    };
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    throw error;
  }
}

function runExactRestore({ boundaries, inventory, readFileBytes, operation, randomBytes }) {
  const { restoreRoot, runtimeRoot, storageObject } = boundaries;
  let target;
  const created = new Map();
  let operationError = null;
  let operationResult;
  try {
    target = createTarget(restoreRoot, randomBytes);
    created.set('.', target.createdIdentity);
    materializeInventory({
      targetDescriptor: target.descriptor,
      inventory,
      readFileBytes,
      created,
    });
    sealCleanupIdentities(target.descriptor, created);
    const inspectLive = () => {
      assertPinnedDirectoryCurrent(restoreRoot, 'package_recovery_restore_root_changed');
      assertPinnedDirectoryCurrent(runtimeRoot, 'package_recovery_runtime_root_changed');
      assertPinnedStorageCurrent(storageObject);
      assertTargetAtPath(target);
      const inspected = inspectPinnedPackageRecoveryTreeInventorySync({
        rootDescriptor: target.descriptor,
      });
      if (inspected.inventory.packageRecoveryTreeInventoryHash
        !== inventory.packageRecoveryTreeInventoryHash) {
        throw new Error('package_recovery_restore_inventory_mismatch');
      }
      return inspected;
    };
    const restored = inspectLive();
    operationResult = operation(Object.freeze({
      restoreTargetPath: target.path,
      restoreTargetRealPath: target.realPath,
      restoreTargetIdentityHash: restored.rootIdentityHash,
      restoredInventory: restored.inventory,
      targetInitiallyEmpty: true,
      assertLive: inspectLive,
    }));
    if (operationResult?.then) {
      throw new Error('package_recovery_restore_async_operation_unsupported');
    }
    inspectLive();
  } catch (error) { operationError = error; }
  let cleanupError = null;
  if (target) {
    try { cleanupTarget(target, restoreRoot, created); }
    catch (error) { cleanupError = error; }
    finally {
      if (!target.closed) {
        try { fs.closeSync(target.descriptor); } catch { /* preserve original error */ }
      }
    }
  }
  if (operationError && cleanupError) {
    throw new AggregateError([operationError, cleanupError], 'package_recovery_restore_and_cleanup_failed');
  }
  if (operationError) throw operationError;
  if (cleanupError) throw cleanupError;
  return operationResult;
}

export function createPackageRecoveryExactRestoreRepository({
  restoreRoot,
  runtimeRoot,
  storageObjectPath,
  randomBytes = crypto.randomBytes,
} = {}) {
  if (![restoreRoot, runtimeRoot, storageObjectPath].every(canonicalAbsolutePath)
    || typeof randomBytes !== 'function') {
    throw new Error('package_recovery_exact_restore_configuration_invalid');
  }
  return Object.freeze({
    version: 1,
    kind: 'PackageRecoveryExactRestoreRepository',
    withExactRestore({ expectedInventory, readFileBytes, operation } = {}) {
      if (!verifyPackageRecoveryTreeInventory(expectedInventory).valid
        || typeof readFileBytes !== 'function' || typeof operation !== 'function') {
        throw new Error('package_recovery_exact_restore_request_invalid');
      }
      const inventory = createPackageRecoveryTreeInventory({
        entries: expectedInventory.entries,
      });
      if (inventory.packageRecoveryTreeInventoryHash
        !== expectedInventory.packageRecoveryTreeInventoryHash) {
        throw new Error('package_recovery_exact_restore_request_invalid');
      }
      const restore = openPinnedDirectory(
        restoreRoot,
        'package_recovery_restore_root_unsafe',
        { privateRoot: true },
      );
      let runtime;
      let storage;
      try {
        runtime = openPinnedDirectory(runtimeRoot, 'package_recovery_runtime_root_unsafe');
        storage = openPinnedStorageObject(storageObjectPath);
        assertDisjointBoundaries(restore, runtime, storage);
        return runExactRestore({
          boundaries: { restoreRoot: restore, runtimeRoot: runtime, storageObject: storage },
          inventory,
          readFileBytes,
          operation,
          randomBytes,
        });
      } finally {
        for (const pinned of [storage, runtime, restore]) {
          if (pinned?.descriptor !== undefined) {
            try { fs.closeSync(pinned.descriptor); } catch { /* operation reports failures */ }
          }
        }
      }
    },
  });
}
