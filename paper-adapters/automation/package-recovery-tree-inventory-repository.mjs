import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { createPackageRecoveryTreeInventory }
  from '../../paper-domain/automation/package-recovery-tree-inventory-contract.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const NO_FOLLOW = fs.constants.O_NOFOLLOW || 0;
const DIRECTORY_ONLY = fs.constants.O_DIRECTORY || 0;
const READ_BUFFER_BYTES = 4 * 1024 * 1024;

function nodeIdentity(stat) {
  return Object.freeze({
    dev: String(stat.dev),
    ino: String(stat.ino),
    mode: String(stat.mode),
    nlink: String(stat.nlink),
    size: String(stat.size),
    uid: String(stat.uid),
    gid: String(stat.gid),
    mtimeNs: String(stat.mtimeNs),
    ctimeNs: String(stat.ctimeNs),
  });
}

function sameIdentity(left, right) {
  return Boolean(left && right
    && Object.keys(left).every((key) => left[key] === right[key]));
}

function safeInteger(value, errorCode) {
  const selected = Number(value);
  if (!Number.isSafeInteger(selected) || BigInt(selected) !== value) {
    throw new Error(errorCode);
  }
  return selected;
}

function posixMode(stat) {
  return Number(stat.mode & 0o777n);
}

function descriptorPath(descriptor) {
  const selected = `/proc/self/fd/${descriptor}`;
  if (!fs.existsSync(selected)) {
    throw new Error('package_recovery_tree_descriptor_root_unavailable');
  }
  return selected;
}

function safeDirectoryNames(descriptor) {
  return fs.readdirSync(descriptorPath(descriptor), { encoding: 'buffer' })
    .sort((left, right) => Buffer.compare(left, right))
    .map((raw) => {
      const name = raw.toString('utf8');
      if (!Buffer.from(name, 'utf8').equals(raw)
        || !name || name === '.' || name === '..'
        || name.includes('/') || name.includes('\0')) {
        throw new Error('package_recovery_tree_entry_name_invalid');
      }
      return name;
    });
}

function hashPinnedFile(descriptor, expectedSize) {
  const digest = crypto.createHash('sha256');
  const buffer = Buffer.allocUnsafe(READ_BUFFER_BYTES);
  let offset = 0;
  for (;;) {
    const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, offset);
    if (!bytesRead) break;
    digest.update(buffer.subarray(0, bytesRead));
    offset += bytesRead;
  }
  if (offset !== expectedSize) throw new Error('package_recovery_tree_file_size_changed');
  return `sha256:${digest.digest('hex')}`;
}

function directoryEntry(relative, stat) {
  return Object.freeze({
    path: relative || '.',
    kind: 'directory',
    posixMode: posixMode(stat),
    uid: safeInteger(stat.uid, 'package_recovery_tree_owner_invalid'),
    gid: safeInteger(stat.gid, 'package_recovery_tree_group_invalid'),
  });
}

function fileEntry(relative, stat, bytesHash) {
  return Object.freeze({
    path: relative,
    kind: 'file',
    posixMode: posixMode(stat),
    uid: safeInteger(stat.uid, 'package_recovery_tree_owner_invalid'),
    gid: safeInteger(stat.gid, 'package_recovery_tree_group_invalid'),
    bytes: safeInteger(stat.size, 'package_recovery_tree_file_size_invalid'),
    bytesHash,
  });
}

function openChildDirectory(parentDescriptor, name, selected) {
  const childPath = path.join(descriptorPath(parentDescriptor), name);
  const descriptor = fs.openSync(
    childPath,
    fs.constants.O_RDONLY | DIRECTORY_ONLY | NO_FOLLOW,
  );
  try {
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (!opened.isDirectory()
      || !sameIdentity(nodeIdentity(selected), nodeIdentity(opened))) {
      throw new Error('package_recovery_tree_entry_identity_changed');
    }
    return descriptor;
  } catch (error) {
    fs.closeSync(descriptor);
    throw error;
  }
}

function scanDirectory(descriptor, relative, rootDevice, entries) {
  const initial = fs.fstatSync(descriptor, { bigint: true });
  if (!initial.isDirectory() || initial.dev !== rootDevice) {
    throw new Error('package_recovery_tree_directory_invalid');
  }
  const initialIdentity = nodeIdentity(initial);
  entries.push(directoryEntry(relative, initial));
  for (const name of safeDirectoryNames(descriptor)) {
    const childPath = path.join(descriptorPath(descriptor), name);
    const selected = fs.lstatSync(childPath, { bigint: true });
    const childRelative = relative ? `${relative}/${name}` : name;
    if (selected.isSymbolicLink() || selected.dev !== rootDevice) {
      throw new Error('package_recovery_tree_entry_unsafe');
    }
    if (selected.isDirectory()) {
      const childDescriptor = openChildDirectory(descriptor, name, selected);
      try {
        scanDirectory(childDescriptor, childRelative, rootDevice, entries);
        const completed = fs.fstatSync(childDescriptor, { bigint: true });
        const atPath = fs.lstatSync(childPath, { bigint: true });
        if (!sameIdentity(nodeIdentity(selected), nodeIdentity(completed))
          || !sameIdentity(nodeIdentity(completed), nodeIdentity(atPath))) {
          throw new Error('package_recovery_tree_entry_identity_changed');
        }
      } finally { fs.closeSync(childDescriptor); }
      continue;
    }
    if (!selected.isFile() || selected.nlink !== 1n) {
      throw new Error('package_recovery_tree_entry_unsafe');
    }
    const fileDescriptor = fs.openSync(
      childPath,
      fs.constants.O_RDONLY | NO_FOLLOW,
    );
    try {
      const opened = fs.fstatSync(fileDescriptor, { bigint: true });
      if (!opened.isFile() || opened.nlink !== 1n
        || !sameIdentity(nodeIdentity(selected), nodeIdentity(opened))) {
        throw new Error('package_recovery_tree_entry_identity_changed');
      }
      const bytes = safeInteger(opened.size, 'package_recovery_tree_file_size_invalid');
      const bytesHash = hashPinnedFile(fileDescriptor, bytes);
      const completed = fs.fstatSync(fileDescriptor, { bigint: true });
      const atPath = fs.lstatSync(childPath, { bigint: true });
      if (!sameIdentity(nodeIdentity(opened), nodeIdentity(completed))
        || !sameIdentity(nodeIdentity(completed), nodeIdentity(atPath))) {
        throw new Error('package_recovery_tree_entry_identity_changed');
      }
      entries.push(fileEntry(childRelative, completed, bytesHash));
    } finally { fs.closeSync(fileDescriptor); }
  }
  const completed = fs.fstatSync(descriptor, { bigint: true });
  if (!sameIdentity(initialIdentity, nodeIdentity(completed))) {
    throw new Error('package_recovery_tree_directory_changed');
  }
}

function compareEntryPath(left, right) {
  if (left.path === '.') return right.path === '.' ? 0 : -1;
  if (right.path === '.') return 1;
  return Buffer.compare(Buffer.from(left.path, 'utf8'), Buffer.from(right.path, 'utf8'));
}

export function inspectPinnedPackageRecoveryTreeInventorySync({
  rootDescriptor,
  expectedRootIdentity = null,
} = {}) {
  if (!Number.isInteger(rootDescriptor) || rootDescriptor < 0) {
    throw new Error('package_recovery_tree_descriptor_required');
  }
  const initial = fs.fstatSync(rootDescriptor, { bigint: true });
  if (!initial.isDirectory()) throw new Error('package_recovery_tree_root_invalid');
  const realPath = fs.realpathSync.native(descriptorPath(rootDescriptor));
  const identity = Object.freeze({ ...nodeIdentity(initial), realPath });
  if (expectedRootIdentity && JSON.stringify(identity) !== JSON.stringify(expectedRootIdentity)) {
    throw new Error('package_recovery_tree_root_identity_changed');
  }
  const entries = [];
  scanDirectory(rootDescriptor, '', initial.dev, entries);
  const completed = fs.fstatSync(rootDescriptor, { bigint: true });
  if (!sameIdentity(nodeIdentity(initial), nodeIdentity(completed))) {
    throw new Error('package_recovery_tree_root_identity_changed');
  }
  const inventory = createPackageRecoveryTreeInventory({
    entries: entries.sort(compareEntryPath),
  });
  return Object.freeze({
    inventory,
    rootIdentity: identity,
    rootIdentityHash: hashRecord('PackageRecoveryTreeRootIdentity', identity),
  });
}

export function inspectPackageRecoveryTreeInventorySync({ packagePath } = {}) {
  if (typeof packagePath !== 'string' || !path.isAbsolute(packagePath)) {
    throw new Error('package_recovery_tree_path_invalid');
  }
  const selected = path.resolve(packagePath);
  let descriptor;
  try {
    const before = fs.lstatSync(selected, { bigint: true });
    if (!before.isDirectory() || before.isSymbolicLink()
      || fs.realpathSync.native(selected) !== selected) {
      throw new Error('package_recovery_tree_root_invalid');
    }
    descriptor = fs.openSync(
      selected,
      fs.constants.O_RDONLY | DIRECTORY_ONLY | NO_FOLLOW,
    );
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (!opened.isDirectory()
      || !sameIdentity(nodeIdentity(before), nodeIdentity(opened))) {
      throw new Error('package_recovery_tree_root_identity_changed');
    }
    const inspected = inspectPinnedPackageRecoveryTreeInventorySync({
      rootDescriptor: descriptor,
      expectedRootIdentity: Object.freeze({
        ...nodeIdentity(opened),
        realPath: selected,
      }),
    });
    const atPath = fs.lstatSync(selected, { bigint: true });
    if (!sameIdentity(nodeIdentity(opened), nodeIdentity(atPath))
      || fs.realpathSync.native(selected) !== selected) {
      throw new Error('package_recovery_tree_root_identity_changed');
    }
    return inspected;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}
