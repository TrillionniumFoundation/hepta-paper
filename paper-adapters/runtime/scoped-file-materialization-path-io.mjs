import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { writeDescriptorFullySync } from '../../workflow-kernel/runtime/file-descriptor-utils.mjs';
import { inspectScopedPathSync, inspectScopedWriteTargetSync } from '../../workflow-kernel/runtime/scoped-file-identity.mjs';
import { isPathWithin } from '../../workflow-kernel/runtime/path-utils.mjs';
import { fsyncDirectorySync } from './durable-json-repository.mjs';
import {
  materializationIdentityFromStat as identityFromStat,
  readMaterializationJsonRecordSync,
  sameMaterializationIdentity as sameIdentity,
  sameStableMaterializationEntryIdentity as sameStableEntryIdentity,
} from './scoped-file-materialization-recovery-record.mjs';

export const COPY_BUFFER_BYTES = 1024 * 1024;

export const fsyncDirectoryPathSync = fsyncDirectorySync;
export const within = isPathWithin;

export function errorWithBlockers(code, relative, blockers = []) {
  const error = new Error(`${code}:${relative}${blockers.length ? `:${blockers.join(',')}` : ''}`);
  error.code = code;
  error.relativePath = relative;
  error.blockers = blockers;
  return error;
}

export function normalizeScopedRelativePath(value) {
  const relative = String(value || '').replace(/\\/g, '/');
  if (!relative || relative.includes('\0') || path.posix.isAbsolute(relative)) {
    throw errorWithBlockers('scoped_materialization_path_invalid', relative || '<empty>');
  }
  const normalized = path.posix.normalize(relative);
  if (normalized === '..' || normalized.startsWith('../') || normalized !== relative) {
    throw errorWithBlockers('scoped_materialization_path_invalid', relative);
  }
  return relative;
}

export function verifiedRoot(scopeRoot) {
  const root = path.resolve(scopeRoot || '.');
  const identity = inspectScopedPathSync({ scopeRoot: root, candidate: root, expect: 'directory', forbidHardlinks: false });
  if (identity.blockers.length) throw errorWithBlockers('scoped_materialization_root_unsafe', '.', identity.blockers);
  return { root, realRoot: identity.realPath, identity: identity.identity };
}

export function candidateFor(scopeRoot, relative) {
  const normalized = normalizeScopedRelativePath(relative);
  const candidate = path.resolve(scopeRoot, ...normalized.split('/'));
  if (!within(path.resolve(scopeRoot), candidate)) throw errorWithBlockers('scoped_materialization_path_escape', normalized);
  return { relative: normalized, candidate };
}

export function sameFileSnapshot(left, right) {
  return Boolean(left && right
    && left.exists === right.exists
    && left.hash === right.hash
    && left.bytes === right.bytes
    && (left.exists ? left.identity?.device === right.identity?.device
      && left.identity?.inode === right.identity?.inode
      && left.identity?.mode === right.identity?.mode
      && left.identity?.size === right.identity?.size
      && left.identity?.mtimeNs === right.identity?.mtimeNs
      && left.identity?.linkCount === right.identity?.linkCount : true));
}

function sameDescriptorObject(left, right) {
  return String(left.dev) === String(right.dev)
    && String(left.ino) === String(right.ino)
    && String(left.mode) === String(right.mode);
}

function verifiedDescriptorAccessPath(descriptor, { requireDirectory = false } = {}) {
  const expected = fs.fstatSync(descriptor, { bigint: true });
  if (requireDirectory && !expected.isDirectory()) {
    throw new Error('scoped_materialization_descriptor_relative_io_unsupported');
  }
  for (const base of ['/proc/self/fd', '/dev/fd']) {
    const descriptorPath = path.join(base, String(descriptor));
    let probeDescriptor;
    try {
      const probePath = requireDirectory ? path.join(descriptorPath, '.') : descriptorPath;
      probeDescriptor = fs.openSync(
        probePath,
        fs.constants.O_RDONLY
          | (requireDirectory ? (fs.constants.O_DIRECTORY || 0) : 0),
      );
      const observed = fs.fstatSync(probeDescriptor, { bigint: true });
      if (sameDescriptorObject(expected, observed)) return descriptorPath;
    } catch {
      // A descriptor namespace is usable only after proving descriptor-relative semantics.
    } finally {
      if (probeDescriptor !== undefined) fs.closeSync(probeDescriptor);
    }
  }
  throw new Error('scoped_materialization_descriptor_relative_io_unsupported');
}

export function openedDescriptorRealPath(descriptor) {
  try {
    return fs.realpathSync.native(verifiedDescriptorAccessPath(descriptor, {
      requireDirectory: fs.fstatSync(descriptor).isDirectory(),
    }));
  } catch {
    return null;
  }
}

export function descriptorEntryPath(descriptor, name) {
  if (!name || name.includes('/') || name.includes('\\')) throw new Error('scoped_materialization_descriptor_name_invalid');
  return path.join(verifiedDescriptorAccessPath(descriptor, { requireDirectory: true }), name);
}

export function stableDirectoryIdentity(identity, stat) {
  return identity
    && String(stat.dev) === identity.device
    && String(stat.ino) === identity.inode
    && String(stat.mode) === identity.mode;
}

export function openScopedDirectoryChain(scope, relativeDirectory, { create = false } = {}) {
  const normalized = relativeDirectory === '' ? '' : normalizeScopedRelativePath(relativeDirectory);
  const components = normalized ? normalized.split('/') : [];
  let descriptor;
  let currentPath = scope.root;
  try {
    descriptor = fs.openSync(
      scope.root,
      fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0) | (fs.constants.O_NOFOLLOW || 0),
    );
    for (const component of components) {
      const entry = descriptorEntryPath(descriptor, component);
      let childDescriptor;
      try {
        childDescriptor = fs.openSync(
          entry,
          fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0) | (fs.constants.O_NOFOLLOW || 0),
        );
      } catch (error) {
        if (!create || error?.code !== 'ENOENT') throw error;
        try {
          fs.mkdirSync(entry, { mode: 0o700 });
          fs.fsyncSync(descriptor);
        } catch (mkdirError) {
          if (mkdirError?.code !== 'EEXIST') throw mkdirError;
        }
        childDescriptor = fs.openSync(
          entry,
          fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0) | (fs.constants.O_NOFOLLOW || 0),
        );
      }
      const stat = fs.fstatSync(childDescriptor, { bigint: true });
      const realPath = openedDescriptorRealPath(childDescriptor);
      if (!stat.isDirectory() || !realPath || !within(scope.realRoot, realPath)) {
        fs.closeSync(childDescriptor);
        throw errorWithBlockers('scoped_materialization_destination_parent_escape', normalized || '.');
      }
      fs.closeSync(descriptor);
      descriptor = childDescriptor;
      currentPath = path.join(currentPath, component);
    }
    const stat = fs.fstatSync(descriptor, { bigint: true });
    const realPath = openedDescriptorRealPath(descriptor);
    if (!stat.isDirectory() || !realPath || !within(scope.realRoot, realPath)) {
      throw errorWithBlockers('scoped_materialization_destination_parent_escape', normalized || '.');
    }
    return {
      descriptor,
      parentPath: currentPath,
      parentRelative: normalized,
      identity: identityFromStat(stat),
      scope,
    };
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (error?.code === 'ELOOP' || error?.code === 'ENOTDIR') {
      throw errorWithBlockers('scoped_materialization_destination_parent_unsafe', normalized || '.', [error.code]);
    }
    throw error;
  }
}

export function openVerifiedParentDirectory(scopeRoot, candidate) {
  const scope = verifiedRoot(scopeRoot);
  const parentPath = path.dirname(candidate);
  const relativeParent = path.relative(scope.root, parentPath).replace(/\\/g, '/');
  if (relativeParent === '..' || relativeParent.startsWith('../') || path.isAbsolute(relativeParent)) {
    throw errorWithBlockers('scoped_materialization_destination_parent_escape', relativeParent);
  }
  return openScopedDirectoryChain(scope, relativeParent, { create: false });
}

export function assertOpenedParentStillScoped(openedParent) {
  const current = inspectScopedPathSync({
    scopeRoot: openedParent.scope.root,
    candidate: openedParent.parentPath,
    expect: 'directory',
    forbidHardlinks: false,
  });
  const stat = fs.fstatSync(openedParent.descriptor, { bigint: true });
  const descriptorPath = openedDescriptorRealPath(openedParent.descriptor);
  if (
    current.blockers.length
    || !stableDirectoryIdentity(openedParent.identity, stat)
    || current.identity?.device !== openedParent.identity.device
    || current.identity?.inode !== openedParent.identity.inode
    || !descriptorPath
    || !within(openedParent.scope.realRoot, descriptorPath)
  ) {
    throw errorWithBlockers(
      'scoped_materialization_destination_parent_changed',
      openedParent.parentRelative || '.',
      current.blockers,
    );
  }
}

export function inspectDescriptorRelativeRegularFile(descriptor, name, { allowedLinkCounts = [1] } = {}) {
  const candidate = descriptorEntryPath(descriptor, name);
  let fileDescriptor;
  try {
    fileDescriptor = fs.openSync(candidate, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  } catch (error) {
    if (error?.code === 'ENOENT') return Object.freeze({ exists: false, hash: null, bytes: 0, identity: null });
    throw errorWithBlockers('scoped_materialization_destination_unsafe', name, [error?.code || 'open_failed']);
  }
  try {
    const before = fs.fstatSync(fileDescriptor, { bigint: true });
    if (!before.isFile() || !allowedLinkCounts.includes(Number(before.nlink))) {
      throw errorWithBlockers('scoped_materialization_destination_unsafe', name, ['regular_single_link_file_required']);
    }
    const digest = crypto.createHash('sha256');
    const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
    let bytes = 0;
    let count;
    do {
      count = fs.readSync(fileDescriptor, buffer, 0, buffer.length, null);
      if (count) {
        digest.update(buffer.subarray(0, count));
        bytes += count;
      }
    } while (count);
    const after = fs.fstatSync(fileDescriptor, { bigint: true });
    if (!sameIdentity({
      device: String(before.dev),
      inode: String(before.ino),
      mode: String(before.mode),
      size: Number(before.size),
      mtimeNs: String(before.mtimeNs),
      linkCount: Number(before.nlink),
    }, after)) throw errorWithBlockers('scoped_materialization_destination_changed', name);
    return Object.freeze({
      exists: true,
      hash: `sha256:${digest.digest('hex')}`,
      bytes,
      identity: identityFromStat(before),
    });
  } finally {
    fs.closeSync(fileDescriptor);
  }
}

export function inspectDescriptorRelativeEntryIdentity(descriptor, name) {
  const candidate = descriptorEntryPath(descriptor, name);
  let fileDescriptor;
  try {
    fileDescriptor = fs.openSync(candidate, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  } catch (error) {
    if (error?.code === 'ENOENT') return Object.freeze({ exists: false, identity: null });
    throw errorWithBlockers('scoped_materialization_destination_unsafe', name, [error?.code || 'open_failed']);
  }
  try {
    const stat = fs.fstatSync(fileDescriptor, { bigint: true });
    if (!stat.isFile()) throw errorWithBlockers('scoped_materialization_destination_unsafe', name, ['regular_file_required']);
    return Object.freeze({ exists: true, identity: identityFromStat(stat) });
  } finally {
    fs.closeSync(fileDescriptor);
  }
}

export function unlinkOwnedDescriptorEntry(openedParent, name, identity, { sync = true } = {}) {
  if (!identity) return false;
  const current = inspectDescriptorRelativeEntryIdentity(openedParent.descriptor, name);
  if (!current.exists) return false;
  if (!sameStableEntryIdentity(current.identity, identity)) {
    throw errorWithBlockers('scoped_materialization_owned_entry_changed', name);
  }
  fs.unlinkSync(descriptorEntryPath(openedParent.descriptor, name));
  if (sync) fs.fsyncSync(openedParent.descriptor);
  return true;
}

export function targetLockName(targetName) {
  return `.${targetName}.hepta-materialization.lock`;
}

export function readDescriptorJsonRecord(descriptor, name, maximumBytes, unsafeCode) {
  return readMaterializationJsonRecordSync({
    candidate: descriptorEntryPath(descriptor, name),
    name,
    maximumBytes,
    unsafeCode,
    allowedLinkCounts: [1, 2],
  });
}

export function openVerifiedRegularFile(scopeRoot, relative) {
  const scope = verifiedRoot(scopeRoot);
  const target = candidateFor(scope.root, relative);
  const before = inspectScopedPathSync({ scopeRoot: scope.root, candidate: target.candidate, expect: 'file', forbidHardlinks: true });
  if (before.blockers.length) throw errorWithBlockers('scoped_materialization_source_unsafe', target.relative, before.blockers);
  let descriptor;
  try {
    descriptor = fs.openSync(target.candidate, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const stat = fs.fstatSync(descriptor, { bigint: true });
    if (!stat.isFile() || !sameIdentity(before.identity, stat)) {
      throw errorWithBlockers('scoped_materialization_source_identity_changed', target.relative);
    }
    const descriptorPath = openedDescriptorRealPath(descriptor);
    if (descriptorPath && !within(scope.realRoot, descriptorPath)) {
      throw errorWithBlockers('scoped_materialization_source_escape', target.relative);
    }
    return { ...target, descriptor, before, scope, mode: Number(stat.mode & 0o777n) };
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (error?.code?.startsWith?.('scoped_materialization_')) throw error;
    throw errorWithBlockers('scoped_materialization_source_open_failed', target.relative, [error?.code || 'open_failed']);
  }
}

export function verifyOpenedSourceUnchanged(opened) {
  const after = inspectScopedPathSync({ scopeRoot: opened.scope.root, candidate: opened.candidate, expect: 'file', forbidHardlinks: true });
  if (after.blockers.length || after.scopedFileIdentityHash !== opened.before.scopedFileIdentityHash) {
    throw errorWithBlockers('scoped_materialization_source_identity_changed', opened.relative, after.blockers);
  }
}

export function ensureSafeParent(scopeRoot, candidate) {
  const scope = verifiedRoot(scopeRoot);
  const relativeParent = path.relative(scope.root, path.dirname(candidate)).replace(/\\/g, '/');
  if (relativeParent === '..' || relativeParent.startsWith('../') || path.isAbsolute(relativeParent)) {
    throw errorWithBlockers('scoped_materialization_destination_escape', path.relative(scope.root, candidate));
  }
  const opened = openScopedDirectoryChain(scope, relativeParent, { create: true });
  fs.closeSync(opened.descriptor);
  return scope;
}

export function ensureScopedDirectorySync({ scopeRoot, relative } = {}) {
  const scope = verifiedRoot(scopeRoot);
  const target = candidateFor(scope.root, relative);
  const opened = openScopedDirectoryChain(scope, target.relative, { create: true });
  fs.closeSync(opened.descriptor);
  return target.candidate;
}

export function writeDescriptorFully(descriptor, buffer, length = buffer.length) {
  return writeDescriptorFullySync(descriptor, Buffer.isBuffer(buffer) ? buffer.subarray(0, length) : Buffer.from(buffer).subarray(0, length));
}

export function inspectScopedRegularFileSync({ scopeRoot, relative } = {}) {
  const target = candidateFor(path.resolve(scopeRoot || '.'), relative);
  try {
    fs.lstatSync(target.candidate);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      const writeTarget = inspectScopedWriteTargetSync({ scopeRoot: path.resolve(scopeRoot || '.'), candidate: target.candidate });
      if (writeTarget.blockers.length) throw errorWithBlockers('scoped_materialization_destination_unsafe', target.relative, writeTarget.blockers);
      return Object.freeze({ exists: false, relative: target.relative, hash: null, bytes: 0, identityHash: null });
    }
    throw error;
  }
  const opened = openVerifiedRegularFile(scopeRoot, target.relative);
  const digest = crypto.createHash('sha256');
  const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
  let bytes = 0;
  try {
    let count;
    do {
      count = fs.readSync(opened.descriptor, buffer, 0, buffer.length, null);
      if (count) {
        digest.update(buffer.subarray(0, count));
        bytes += count;
      }
    } while (count);
    verifyOpenedSourceUnchanged(opened);
  } finally {
    fs.closeSync(opened.descriptor);
  }
  return Object.freeze({ exists: true, relative: target.relative, hash: `sha256:${digest.digest('hex')}`, bytes, identityHash: opened.before.scopedFileIdentityHash });
}
