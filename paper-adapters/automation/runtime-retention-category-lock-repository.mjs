import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const NO_FOLLOW = fs.constants.O_NOFOLLOW || 0;
const LOCK_DESCRIPTOR_IN_CHILD = 3;
const FLOCK = '/usr/bin/flock';
const CATEGORY = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function lockIdentity(stat) {
  return Object.freeze({
    dev: String(stat.dev),
    ino: String(stat.ino),
    mode: String(stat.mode),
    nlink: String(stat.nlink),
    uid: String(stat.uid),
    gid: String(stat.gid),
    size: String(stat.size),
    type: stat.isFile() ? 'regular_file' : 'other',
  });
}

function sameLockIdentity(left, right) {
  return JSON.stringify(lockIdentity(left)) === JSON.stringify(lockIdentity(right));
}

function currentUserId() {
  return typeof process.geteuid === 'function' ? process.geteuid() : null;
}

function lockName(category) {
  if (!CATEGORY.test(String(category || ''))) {
    throw new Error('runtime_retention_category_lock_category_invalid');
  }
  return `.hepta-runtime-retention-${category}.lock`;
}

export function runtimeRetentionCategoryLockPath(pinned, category) {
  if (!pinned?.runtimeDescriptorPath || pinned.runtimeDescriptor === undefined) {
    throw new Error('runtime_retention_category_lock_pinned_root_required');
  }
  return path.join(pinned.runtimeDescriptorPath, lockName(category));
}

export function withRuntimeRetentionCategoryLock(pinned, category, operation) {
  if (typeof operation !== 'function') {
    throw new Error('runtime_retention_category_lock_operation_required');
  }
  const lockPath = runtimeRetentionCategoryLockPath(pinned, category);
  let existed = true;
  try { fs.lstatSync(lockPath); } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    existed = false;
  }
  const descriptor = fs.openSync(
    lockPath,
    fs.constants.O_RDWR | fs.constants.O_CREAT | NO_FOLLOW,
    0o600,
  );
  try {
    const opened = fs.fstatSync(descriptor, { bigint: true });
    const current = fs.lstatSync(lockPath, { bigint: true });
    const owner = currentUserId();
    if (!opened.isFile()
      || !current.isFile()
      || current.isSymbolicLink()
      || !sameLockIdentity(opened, current)
      || Number(opened.nlink) !== 1
      || Number(opened.mode & 0o7777n) !== 0o600
      || opened.size !== 0n
      || (owner !== null && Number(opened.uid) !== owner)) {
      throw new Error('runtime_retention_category_lock_invalid');
    }
    if (!existed) fs.fsyncSync(pinned.runtimeDescriptor);

    const acquired = spawnSync(FLOCK, [
      '--exclusive',
      '--nonblock',
      String(LOCK_DESCRIPTOR_IN_CHILD),
    ], {
      encoding: 'utf8',
      env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
      stdio: ['ignore', 'pipe', 'pipe', descriptor],
      timeout: 10_000,
      maxBuffer: 16 * 1024,
    });
    if (acquired.status === 1 && !acquired.error && !acquired.signal) {
      throw new Error('runtime_retention_category_lock_unavailable');
    }
    if (acquired.error || acquired.signal || acquired.status !== 0
      || acquired.stdout || acquired.stderr) {
      throw new Error('runtime_retention_category_lock_acquisition_failed');
    }

    const assertHeld = () => {
      const held = fs.fstatSync(descriptor, { bigint: true });
      const atPath = fs.lstatSync(lockPath, { bigint: true });
      if (!sameLockIdentity(opened, held)
        || !sameLockIdentity(opened, atPath)
        || Number(atPath.nlink) !== 1) {
        throw new Error('runtime_retention_category_lock_identity_changed');
      }
      return true;
    };
    assertHeld();
    const value = operation(Object.freeze({
      category,
      lockPath,
      identity: lockIdentity(opened),
      assertHeld,
    }));
    assertHeld();
    return value;
  } finally {
    fs.closeSync(descriptor);
  }
}
