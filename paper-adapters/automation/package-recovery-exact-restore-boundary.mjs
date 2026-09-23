import fs from 'node:fs';
import path from 'node:path';

const NO_FOLLOW = fs.constants.O_NOFOLLOW || 0;
const DIRECTORY_ONLY = fs.constants.O_DIRECTORY || 0;

export function descriptorPath(descriptor) {
  const selected = `/proc/self/fd/${descriptor}`;
  if (!fs.existsSync(selected)) {
    throw new Error('package_recovery_restore_descriptor_root_unavailable');
  }
  return selected;
}

export function anchorIdentity(stat) {
  return Object.freeze({
    dev: String(stat.dev), ino: String(stat.ino), mode: String(stat.mode),
    uid: String(stat.uid), gid: String(stat.gid),
  });
}

function fileIdentity(stat) {
  return Object.freeze({
    ...anchorIdentity(stat), nlink: String(stat.nlink), size: String(stat.size),
    mtimeNs: String(stat.mtimeNs), ctimeNs: String(stat.ctimeNs),
  });
}

export function sameIdentity(left, right) {
  return Boolean(left && right
    && Object.keys(left).every((key) => left[key] === right[key]));
}

export function canonicalAbsolutePath(value) {
  return typeof value === 'string' && path.isAbsolute(value)
    && path.resolve(value) === value && value !== path.parse(value).root;
}

function pathsDisjoint(left, right) {
  const relativeLeft = path.relative(left, right);
  const relativeRight = path.relative(right, left);
  const within = (relative) => relative === ''
    || (!relative.startsWith(`..${path.sep}`) && relative !== '..'
      && !path.isAbsolute(relative));
  return !within(relativeLeft) && !within(relativeRight);
}

export function openPinnedDirectory(candidate, errorCode, { privateRoot = false } = {}) {
  if (!canonicalAbsolutePath(candidate)) throw new Error(errorCode);
  let descriptor;
  try {
    const selected = fs.lstatSync(candidate, { bigint: true });
    const realPath = fs.realpathSync.native(candidate);
    if (!selected.isDirectory() || selected.isSymbolicLink() || realPath !== candidate) {
      throw new Error(errorCode);
    }
    if (privateRoot && ((selected.mode & 0o777n) !== 0o700n
      || (typeof process.getuid === 'function' && selected.uid !== BigInt(process.getuid()))
      || (typeof process.getgid === 'function' && selected.gid !== BigInt(process.getgid())))) {
      throw new Error(errorCode);
    }
    descriptor = fs.openSync(
      candidate,
      fs.constants.O_RDONLY | DIRECTORY_ONLY | NO_FOLLOW,
    );
    const opened = fs.fstatSync(descriptor, { bigint: true });
    const identity = anchorIdentity(opened);
    if (!opened.isDirectory()
      || !sameIdentity(anchorIdentity(selected), identity)) throw new Error(errorCode);
    return { path: candidate, realPath, descriptor, identity };
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    throw error;
  }
}

export function openPinnedStorageObject(candidate) {
  if (!canonicalAbsolutePath(candidate)) {
    throw new Error('package_recovery_storage_object_unsafe');
  }
  let descriptor;
  try {
    const selected = fs.lstatSync(candidate, { bigint: true });
    const realPath = fs.realpathSync.native(candidate);
    if (!selected.isFile() || selected.isSymbolicLink() || selected.nlink !== 1n
      || (selected.mode & 0o222n) !== 0n || realPath !== candidate) {
      throw new Error('package_recovery_storage_object_unsafe');
    }
    descriptor = fs.openSync(candidate, fs.constants.O_RDONLY | NO_FOLLOW);
    const opened = fs.fstatSync(descriptor, { bigint: true });
    const identity = fileIdentity(opened);
    if (!opened.isFile() || opened.nlink !== 1n
      || !sameIdentity(fileIdentity(selected), identity)) {
      throw new Error('package_recovery_storage_object_unsafe');
    }
    return { path: candidate, realPath, descriptor, identity };
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    throw error;
  }
}

export function assertPinnedDirectoryCurrent(pinned, errorCode) {
  const selected = fs.lstatSync(pinned.path, { bigint: true });
  const opened = fs.fstatSync(pinned.descriptor, { bigint: true });
  if (!selected.isDirectory() || selected.isSymbolicLink()
    || fs.realpathSync.native(pinned.path) !== pinned.realPath
    || !sameIdentity(pinned.identity, anchorIdentity(selected))
    || !sameIdentity(pinned.identity, anchorIdentity(opened))) throw new Error(errorCode);
}

export function assertPinnedStorageCurrent(pinned) {
  const selected = fs.lstatSync(pinned.path, { bigint: true });
  const opened = fs.fstatSync(pinned.descriptor, { bigint: true });
  if (!selected.isFile() || selected.isSymbolicLink() || selected.nlink !== 1n
    || fs.realpathSync.native(pinned.path) !== pinned.realPath
    || !sameIdentity(pinned.identity, fileIdentity(selected))
    || !sameIdentity(pinned.identity, fileIdentity(opened))) {
    throw new Error('package_recovery_storage_object_changed');
  }
}

export function assertDisjointBoundaries(restoreRoot, runtimeRoot, storageObject) {
  const paths = [restoreRoot.realPath, runtimeRoot.realPath, storageObject.realPath];
  for (let left = 0; left < paths.length; left += 1) {
    for (let right = left + 1; right < paths.length; right += 1) {
      if (!pathsDisjoint(paths[left], paths[right])) {
        throw new Error('package_recovery_restore_boundary_not_disjoint');
      }
    }
  }
  if (sameIdentity(restoreRoot.identity, runtimeRoot.identity)
    || (restoreRoot.identity.dev === storageObject.identity.dev
      && restoreRoot.identity.ino === storageObject.identity.ino)
    || (runtimeRoot.identity.dev === storageObject.identity.dev
      && runtimeRoot.identity.ino === storageObject.identity.ino)) {
    throw new Error('package_recovery_restore_boundary_not_disjoint');
  }
}
