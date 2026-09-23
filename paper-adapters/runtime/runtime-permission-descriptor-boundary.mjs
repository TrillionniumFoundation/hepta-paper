import fs from 'node:fs';
import path from 'node:path';

import { isPathWithin } from '../../workflow-kernel/runtime/path-utils.mjs';
import { identityOf, typeOf } from './runtime-permission-entry-policy.mjs';

export const NO_FOLLOW = fs.constants.O_NOFOLLOW || 0;
export const DIRECTORY_ONLY = fs.constants.O_DIRECTORY || 0;

export function sameObject(left, right) {
  return String(left.dev) === String(right.dev)
    && String(left.ino) === String(right.ino)
    && typeOf(left) === typeOf(right);
}

export function descriptorAccessPath(descriptor, { directory = false } = {}) {
  const expected = fs.fstatSync(descriptor, { bigint: true });
  for (const base of ['/proc/self/fd', '/dev/fd']) {
    const candidate = path.join(base, String(descriptor));
    let probe;
    try {
      probe = fs.openSync(
        directory ? path.join(candidate, '.') : candidate,
        fs.constants.O_RDONLY | (directory ? DIRECTORY_ONLY : 0),
      );
      if (sameObject(expected, fs.fstatSync(probe, { bigint: true }))) return candidate;
    } catch {
      // A descriptor namespace is used only after its identity is proven.
    } finally {
      if (probe !== undefined) fs.closeSync(probe);
    }
  }
  throw new Error('descriptor_relative_runtime_permission_io_unsupported');
}

export function descriptorEntryPath(descriptor, name) {
  if (!name || name === '.' || name === '..' || name.includes('/')
    || name.includes('\\') || name.includes('\0')) {
    throw new Error('runtime_permission_entry_name_invalid');
  }
  return path.join(descriptorAccessPath(descriptor, { directory: true }), name);
}

export function openRoot(runtimeRoot) {
  const resolved = path.resolve(runtimeRoot);
  const observed = fs.lstatSync(resolved, { bigint: true });
  if (observed.isSymbolicLink()) {
    throw new Error('runtime_permission_root_symbolic_link_forbidden');
  }
  if (!observed.isDirectory()) throw new Error('runtime_permission_root_not_directory');
  const descriptor = fs.openSync(
    resolved,
    fs.constants.O_RDONLY | DIRECTORY_ONLY | NO_FOLLOW,
  );
  try {
    const pinned = fs.fstatSync(descriptor, { bigint: true });
    if (!sameObject(observed, pinned) || !pinned.isDirectory()) {
      throw new Error('runtime_permission_root_identity_changed');
    }
    const realPath = fs.realpathSync.native(
      descriptorAccessPath(descriptor, { directory: true }),
    );
    if (realPath !== resolved) throw new Error('runtime_permission_root_noncanonical');
    return { descriptor, resolved, realPath, identity: identityOf(pinned) };
  } catch (error) {
    fs.closeSync(descriptor);
    throw error;
  }
}

export function entryStillInsideRoot(root, descriptor, { directory = false } = {}) {
  const realPath = fs.realpathSync.native(descriptorAccessPath(descriptor, { directory }));
  return isPathWithin(root.realPath, realPath);
}
