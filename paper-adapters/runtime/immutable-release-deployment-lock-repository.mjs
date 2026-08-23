import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const NO_FOLLOW = fs.constants.O_NOFOLLOW || 0;
const LOCK_DESCRIPTOR_IN_CHILD = 3;
const FLOCK = '/usr/bin/flock';

function codedError(code, details = {}) {
  return Object.assign(new Error(code), { code, ...details });
}

function identity(stat) {
  return Object.freeze({
    device: String(stat.dev),
    inode: String(stat.ino),
    mode: String(stat.mode),
    uid: String(stat.uid),
    gid: String(stat.gid),
    links: String(stat.nlink),
    size: String(stat.size),
  });
}

function sameNode(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function assertTrustedFlock() {
  const stat = fs.lstatSync(FLOCK, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== 0n || stat.gid !== 0n
    || stat.nlink !== 1n || (stat.mode & 0o022n) !== 0n || fs.realpathSync(FLOCK) !== FLOCK) {
    throw codedError('immutable_release_deployment_flock_invalid');
  }
}

function validateLockRoot(root, { expectedUid, expectedGid }) {
  const selected = fs.lstatSync(root, { bigint: true });
  if (fs.realpathSync(root) !== root || selected.isSymbolicLink() || !selected.isDirectory()
    || Number(selected.uid) !== expectedUid || Number(selected.gid) !== expectedGid
    || (Number(selected.mode) & 0o7777) !== 0o711) {
    throw codedError('immutable_release_deployment_lock_root_invalid');
  }
  return selected;
}

function validateLockStat(stat, { expectedUid, expectedGid }) {
  return stat.isFile() && !stat.isSymbolicLink()
    && Number(stat.uid) === expectedUid && Number(stat.gid) === expectedGid
    && (Number(stat.mode) & 0o7777) === 0o600 && stat.nlink === 1n && stat.size === 0n;
}

function policyIdentityHash({ lockPath, expectedUid, expectedGid }) {
  return hashRecord('ImmutableReleaseDeploymentLockPolicy', {
    path: lockPath,
    kind: 'regular_file',
    uid: expectedUid,
    gid: expectedGid,
    mode: 0o600,
    links: 1,
    size: 0,
  });
}

export function inspectImmutableReleaseDeploymentLock({
  lockPath,
  expectedUid = 0,
  expectedGid = 0,
} = {}) {
  if (typeof lockPath !== 'string' || !path.isAbsolute(lockPath)
    || path.resolve(lockPath) !== lockPath) {
    throw codedError('immutable_release_deployment_lock_path_invalid');
  }
  const root = path.dirname(lockPath);
  const rootBefore = validateLockRoot(root, { expectedUid, expectedGid });
  const before = fs.lstatSync(lockPath, { bigint: true });
  const rootAfter = validateLockRoot(root, { expectedUid, expectedGid });
  if (!validateLockStat(before, { expectedUid, expectedGid })
    || !sameNode(rootBefore, rootAfter)) {
    throw codedError('immutable_release_deployment_lock_invalid');
  }
  const record = Object.freeze({ path: lockPath, identity: identity(before) });
  return Object.freeze({
    ...record,
    // /run is volatile: tmpfiles legitimately recreates this inode at boot.
    // Durable plans therefore bind the stable, reviewed lock policy. The
    // current inode is still pinned by the opened descriptor for the lifetime
    // of each execution below.
    identityHash: policyIdentityHash({ lockPath, expectedUid, expectedGid }),
  });
}

export function acquireExclusiveImmutableReleaseDeploymentLock({
  lockPath,
  expectedIdentityHash,
  expectedUid = 0,
  expectedGid = 0,
} = {}) {
  assertTrustedFlock();
  const inspected = inspectImmutableReleaseDeploymentLock({
    lockPath, expectedUid, expectedGid,
  });
  if (inspected.identityHash !== expectedIdentityHash) {
    throw codedError('immutable_release_deployment_lock_identity_mismatch');
  }
  let descriptor;
  let released = false;
  try {
    descriptor = fs.openSync(lockPath, fs.constants.O_RDWR | NO_FOLLOW);
    const opened = fs.fstatSync(descriptor, { bigint: true });
    const selected = fs.lstatSync(lockPath, { bigint: true });
    if (!validateLockStat(opened, { expectedUid, expectedGid })
      || !validateLockStat(selected, { expectedUid, expectedGid })
      || !sameNode(opened, selected)
      || policyIdentityHash({ lockPath, expectedUid, expectedGid })
        !== expectedIdentityHash) {
      throw codedError('immutable_release_deployment_lock_identity_mismatch');
    }
    const acquired = spawnSync(FLOCK, [
      '--exclusive', '--nonblock', String(LOCK_DESCRIPTOR_IN_CHILD),
    ], {
      encoding: 'utf8',
      shell: false,
      env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
      stdio: ['ignore', 'pipe', 'pipe', descriptor],
      timeout: 10_000,
      maxBuffer: 16 * 1024,
    });
    if (acquired.status === 1 && !acquired.error && !acquired.signal) {
      throw codedError('immutable_release_deployment_lock_unavailable');
    }
    if (acquired.error || acquired.signal || acquired.status !== 0
      || acquired.stdout || acquired.stderr) {
      throw codedError('immutable_release_deployment_lock_acquisition_failed');
    }
    const assertHeld = () => {
      if (released || descriptor === undefined) {
        throw codedError('immutable_release_deployment_lock_not_held');
      }
      const held = fs.fstatSync(descriptor, { bigint: true });
      const atPath = fs.lstatSync(lockPath, { bigint: true });
      if (!validateLockStat(held, { expectedUid, expectedGid })
        || !validateLockStat(atPath, { expectedUid, expectedGid })
        || !sameNode(held, atPath)
        || policyIdentityHash({ lockPath, expectedUid, expectedGid })
          !== expectedIdentityHash) {
        throw codedError('immutable_release_deployment_lock_identity_changed');
      }
      // A separate open file description must be unable to acquire the same
      // exclusive lock. This detects an accidentally unlocked inherited fd.
      const probe = spawnSync(FLOCK, [
        '--exclusive', '--nonblock', lockPath, '/usr/bin/true',
      ], {
        encoding: 'utf8', shell: false,
        env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
        timeout: 10_000, maxBuffer: 16 * 1024,
      });
      if (probe.status !== 1 || probe.error || probe.signal || probe.stdout || probe.stderr) {
        throw codedError('immutable_release_deployment_lock_not_exclusive');
      }
      return true;
    };
    assertHeld();
    return Object.freeze({
      descriptor,
      identityHash: expectedIdentityHash,
      assertHeld,
      release() {
        if (released) return false;
        fs.closeSync(descriptor);
        descriptor = undefined;
        released = true;
        return true;
      },
    });
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    throw error;
  }
}

export function adoptInheritedExclusiveImmutableReleaseDeploymentLock({
  lockPath,
  expectedIdentityHash,
  descriptor,
  expectedUid = 0,
  expectedGid = 0,
} = {}) {
  assertTrustedFlock();
  if (!Number.isSafeInteger(descriptor) || descriptor < 3) {
    throw codedError('immutable_release_deployment_inherited_lock_descriptor_invalid');
  }
  const inspected = inspectImmutableReleaseDeploymentLock({
    lockPath, expectedUid, expectedGid,
  });
  const opened = fs.fstatSync(descriptor, { bigint: true });
  const selected = fs.lstatSync(lockPath, { bigint: true });
  if (inspected.identityHash !== expectedIdentityHash
    || !validateLockStat(opened, { expectedUid, expectedGid })
    || !sameNode(opened, selected)
    || policyIdentityHash({ lockPath, expectedUid, expectedGid })
      !== expectedIdentityHash) {
    throw codedError('immutable_release_deployment_inherited_lock_identity_mismatch');
  }
  let released = false;
  const assertHeld = () => {
    if (released) throw codedError('immutable_release_deployment_lock_not_held');
    const probe = spawnSync(FLOCK, [
      '--exclusive', '--nonblock', lockPath, '/usr/bin/true',
    ], {
      encoding: 'utf8', shell: false,
      env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
      timeout: 10_000, maxBuffer: 16 * 1024,
    });
    if (probe.status !== 1 || probe.error || probe.signal || probe.stdout || probe.stderr) {
      throw codedError('immutable_release_deployment_inherited_lock_not_exclusive');
    }
    const current = fs.fstatSync(descriptor, { bigint: true });
    const atPath = fs.lstatSync(lockPath, { bigint: true });
    if (!validateLockStat(current, { expectedUid, expectedGid })
      || !validateLockStat(atPath, { expectedUid, expectedGid })
      || !sameNode(current, atPath)
      || policyIdentityHash({ lockPath, expectedUid, expectedGid })
        !== expectedIdentityHash) {
      throw codedError('immutable_release_deployment_lock_identity_changed');
    }
    return true;
  };
  assertHeld();
  return Object.freeze({
    descriptor,
    identityHash: expectedIdentityHash,
    assertHeld,
    release() {
      if (released) return false;
      fs.closeSync(descriptor);
      released = true;
      return true;
    },
  });
}
