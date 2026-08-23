import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const DIRECTORY_ONLY = fs.constants.O_DIRECTORY || 0;
const NO_FOLLOW = fs.constants.O_NOFOLLOW || 0;
const LOCK_DESCRIPTOR_IN_CHILD = 3;
const LOCK_DIRECTORY_NAME = '.hepta-package-retention-recovery-locks';
const FLOCK_CANDIDATES = Object.freeze(['/usr/bin/flock', '/bin/flock']);
const SHA256 = /^sha256:[a-f0-9]{64}$/;
export const PACKAGE_RETENTION_RECOVERY_READINESS_PROBE_HASH =
  'sha256:0000000000000000000000000000000000000000000000000000000000000001';

function lockError(code, cause = null) {
  const error = new Error(code, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function currentUserId() {
  return typeof process.geteuid === 'function' ? process.geteuid() : null;
}

function sameNode(left, right) {
  return Boolean(left && right)
    && left.dev === right.dev
    && left.ino === right.ino
    && left.isFile() === right.isFile()
    && left.isDirectory() === right.isDirectory();
}

function trustedFlockBackend() {
  for (const candidate of FLOCK_CANDIDATES) {
    try {
      const resolved = fs.realpathSync.native(candidate);
      const stat = fs.lstatSync(resolved, { bigint: true });
      fs.accessSync(resolved, fs.constants.X_OK);
      if (stat.isFile() && !stat.isSymbolicLink()
        && stat.uid === 0n && stat.gid === 0n && stat.nlink === 1n
        && (stat.mode & 0o022n) === 0n) return resolved;
    } catch { /* try the next trusted system location */ }
  }
  throw lockError('package_retention_recovery_lock_backend_unavailable');
}

function assertRuntimeRootCurrent(scope) {
  let opened;
  let selected;
  try {
    opened = fs.fstatSync(scope.runtimeDescriptor, { bigint: true });
    selected = fs.lstatSync(scope.runtimeRoot, { bigint: true });
  } catch (error) {
    throw lockError('package_retention_recovery_lock_scope_changed', error);
  }
  if (!opened.isDirectory() || !selected.isDirectory()
    || selected.isSymbolicLink() || !sameNode(opened, selected)) {
    throw lockError('package_retention_recovery_lock_scope_changed');
  }
}

function openRuntimeScope(runtimeRoot) {
  const selectedRoot = path.resolve(String(runtimeRoot || ''));
  if (!runtimeRoot || selectedRoot === path.parse(selectedRoot).root) {
    throw lockError('package_retention_recovery_lock_runtime_root_invalid');
  }
  let runtimeDescriptor;
  try {
    const before = fs.lstatSync(selectedRoot, { bigint: true });
    if (!before.isDirectory() || before.isSymbolicLink()
      || fs.realpathSync.native(selectedRoot) !== selectedRoot) {
      throw lockError('package_retention_recovery_lock_runtime_root_invalid');
    }
    runtimeDescriptor = fs.openSync(
      selectedRoot,
      fs.constants.O_RDONLY | DIRECTORY_ONLY | NO_FOLLOW,
    );
    const opened = fs.fstatSync(runtimeDescriptor, { bigint: true });
    const owner = currentUserId();
    if (!opened.isDirectory() || !sameNode(opened, before)
      || (owner !== null && Number(opened.uid) !== owner)) {
      throw lockError('package_retention_recovery_lock_runtime_root_invalid');
    }
    return Object.freeze({
      runtimeRoot: selectedRoot,
      runtimeDescriptor,
      runtimeDescriptorPath: `/proc/self/fd/${runtimeDescriptor}`,
    });
  } catch (error) {
    if (runtimeDescriptor !== undefined) fs.closeSync(runtimeDescriptor);
    if (error?.code === 'package_retention_recovery_lock_runtime_root_invalid') {
      throw error;
    }
    throw lockError('package_retention_recovery_lock_runtime_root_invalid', error);
  }
}

function openLockDirectory(scope, { create = true } = {}) {
  const candidate = path.join(scope.runtimeDescriptorPath, LOCK_DIRECTORY_NAME);
  let created = false;
  if (create) {
    try {
      fs.mkdirSync(candidate, { mode: 0o700 });
      created = true;
    } catch (error) {
      if (error?.code !== 'EEXIST') {
        throw lockError('package_retention_recovery_lock_directory_invalid', error);
      }
    }
  }
  let descriptor;
  try {
    const selected = fs.lstatSync(candidate, { bigint: true });
    descriptor = fs.openSync(
      candidate,
      fs.constants.O_RDONLY | DIRECTORY_ONLY | NO_FOLLOW,
    );
    const opened = fs.fstatSync(descriptor, { bigint: true });
    const owner = currentUserId();
    if (!selected.isDirectory() || selected.isSymbolicLink()
      || !opened.isDirectory() || !sameNode(opened, selected)
      || Number(opened.mode & 0o7777n) !== 0o700
      || (owner !== null && Number(opened.uid) !== owner)) {
      throw lockError('package_retention_recovery_lock_directory_invalid');
    }
    if (created) fs.fsyncSync(scope.runtimeDescriptor);
    assertRuntimeRootCurrent(scope);
    return Object.freeze({
      descriptor,
      descriptorPath: `/proc/self/fd/${descriptor}`,
      path: path.join(scope.runtimeRoot, LOCK_DIRECTORY_NAME),
      stat: opened,
    });
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (error?.code === 'package_retention_recovery_lock_directory_invalid'
      || error?.code === 'package_retention_recovery_lock_scope_changed') throw error;
    throw lockError('package_retention_recovery_lock_directory_invalid', error);
  }
}

function assertLockScopeCurrent(scope, directory) {
  assertRuntimeRootCurrent(scope);
  let opened;
  let selected;
  try {
    opened = fs.fstatSync(directory.descriptor, { bigint: true });
    selected = fs.lstatSync(directory.path, { bigint: true });
  } catch (error) {
    throw lockError('package_retention_recovery_lock_scope_changed', error);
  }
  if (!opened.isDirectory() || !selected.isDirectory()
    || selected.isSymbolicLink() || !sameNode(opened, directory.stat)
    || !sameNode(selected, directory.stat)
    || Number(opened.mode & 0o7777n) !== 0o700) {
    throw lockError('package_retention_recovery_lock_scope_changed');
  }
}

function openLockFile(
  scope,
  directory,
  packageLifecycleReceiptHash,
  { create = true } = {},
) {
  const lockName = `${packageLifecycleReceiptHash.slice('sha256:'.length)}.lock`;
  const candidate = path.join(directory.descriptorPath, lockName);
  let existed = true;
  try { fs.lstatSync(candidate); } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    if (!create) throw lockError('package_retention_recovery_lock_file_invalid', error);
    existed = false;
  }
  let descriptor;
  try {
    descriptor = fs.openSync(
      candidate,
      fs.constants.O_RDWR | (create ? fs.constants.O_CREAT : 0) | NO_FOLLOW,
      0o600,
    );
    const opened = fs.fstatSync(descriptor, { bigint: true });
    const selected = fs.lstatSync(candidate, { bigint: true });
    const owner = currentUserId();
    if (!opened.isFile() || !selected.isFile() || selected.isSymbolicLink()
      || !sameNode(opened, selected) || opened.nlink !== 1n
      || Number(opened.mode & 0o7777n) !== 0o600 || opened.size !== 0n
      || (owner !== null && Number(opened.uid) !== owner)) {
      throw lockError('package_retention_recovery_lock_file_invalid');
    }
    if (!existed) fs.fsyncSync(directory.descriptor);
    assertLockScopeCurrent(scope, directory);
    return Object.freeze({
      descriptor,
      path: path.join(directory.path, lockName),
      stat: opened,
    });
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (String(error?.code || '').startsWith('package_retention_recovery_lock_')) {
      throw error;
    }
    throw lockError('package_retention_recovery_lock_file_invalid', error);
  }
}

function acquireFlock(backend, descriptor) {
  const acquired = spawnSync(backend, [
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
    throw lockError('package_retention_recovery_lock_unavailable');
  }
  if (acquired.error || acquired.signal || acquired.status !== 0
    || acquired.stdout || acquired.stderr) {
    throw lockError('package_retention_recovery_lock_acquisition_failed');
  }
}

function withOpenedLock(scope, directory, opened, backend, operation) {
  acquireFlock(backend, opened.descriptor);
  const assertHeld = () => {
    assertLockScopeCurrent(scope, directory);
    let held;
    let selected;
    try {
      held = fs.fstatSync(opened.descriptor, { bigint: true });
      selected = fs.lstatSync(opened.path, { bigint: true });
    } catch (error) {
      throw lockError('package_retention_recovery_lock_identity_changed', error);
    }
    if (!sameNode(held, opened.stat) || !sameNode(selected, opened.stat)
      || held.mode !== opened.stat.mode || selected.mode !== opened.stat.mode
      || held.uid !== opened.stat.uid || selected.uid !== opened.stat.uid
      || selected.nlink !== 1n || selected.size !== 0n) {
      throw lockError('package_retention_recovery_lock_identity_changed');
    }
    return true;
  };
  assertHeld();
  const value = operation(Object.freeze({
    packageLifecycleReceiptHash: opened.packageLifecycleReceiptHash,
    lockPath: opened.path,
    assertHeld,
  }));
  if (value?.then) {
    throw lockError('package_retention_recovery_lock_async_operation_unsupported');
  }
  assertHeld();
  return value;
}

export function createPackageRetentionRecoveryLockRepository({ runtimeRoot } = {}) {
  if (typeof runtimeRoot !== 'string' || !runtimeRoot.trim()) {
    throw lockError('package_retention_recovery_lock_runtime_root_invalid');
  }
  const selectedRuntimeRoot = path.resolve(String(runtimeRoot || ''));
  const backend = trustedFlockBackend();
  return Object.freeze({
    version: 1,
    kind: 'PackageRetentionRecoveryLockRepository',
    inspectReadiness() {
      let scope;
      let directory;
      let opened;
      try {
        scope = openRuntimeScope(selectedRuntimeRoot);
        directory = openLockDirectory(scope, { create: false });
        opened = openLockFile(
          scope,
          directory,
          PACKAGE_RETENTION_RECOVERY_READINESS_PROBE_HASH,
          { create: false },
        );
        return withOpenedLock(scope, directory, Object.freeze({
          ...opened,
          packageLifecycleReceiptHash:
            PACKAGE_RETENTION_RECOVERY_READINESS_PROBE_HASH,
        }), backend, () => true) === true;
      } catch {
        return false;
      } finally {
        if (opened) fs.closeSync(opened.descriptor);
        if (directory) fs.closeSync(directory.descriptor);
        if (scope) fs.closeSync(scope.runtimeDescriptor);
      }
    },
    withLifecycleLock(packageLifecycleReceiptHash, operation) {
      if (typeof packageLifecycleReceiptHash !== 'string'
        || !SHA256.test(packageLifecycleReceiptHash)
        || typeof operation !== 'function') {
        throw lockError('package_retention_recovery_lock_request_invalid');
      }
      const scope = openRuntimeScope(selectedRuntimeRoot);
      let directory;
      let opened;
      try {
        directory = openLockDirectory(scope);
        opened = openLockFile(
          scope,
          directory,
          packageLifecycleReceiptHash,
        );
        return withOpenedLock(scope, directory, Object.freeze({
          ...opened,
          packageLifecycleReceiptHash,
        }), backend, operation);
      } finally {
        if (opened) fs.closeSync(opened.descriptor);
        if (directory) fs.closeSync(directory.descriptor);
        fs.closeSync(scope.runtimeDescriptor);
      }
    },
  });
}
