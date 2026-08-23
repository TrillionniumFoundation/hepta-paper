import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { readRegularJsonFileSync }
  from '../runtime/pinned-file-reader.mjs';
import { verifyRuntimeRetentionPackageDeletionFence }
  from './runtime-retention-package-deletion-fence-contract.mjs';

const DIRECTORY_ONLY = fs.constants.O_DIRECTORY || 0;
const NO_FOLLOW = fs.constants.O_NOFOLLOW || 0;
const ROOT_NAME = '.hepta-package-deletion-fences';
const LOCK_NAME = '.repository.lock';
const STATE_NAME = /^([a-f0-9]{64})\.json$/;
const TEMP_NAME = /^\.fence-tmp-[A-Za-z0-9-]+$/;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const FLOCK_CANDIDATES = Object.freeze(['/usr/bin/flock', '/bin/flock']);
const MAX_RECORD_BYTES = 256 * 1024;

function fail(code, cause = null) {
  const error = new Error(code, cause ? { cause } : undefined);
  error.code = code;
  throw error;
}

function currentUserId() {
  return typeof process.geteuid === 'function' ? process.geteuid() : null;
}

function sameNode(left, right) {
  return Boolean(left && right
    && left.dev === right.dev && left.ino === right.ino
    && left.isFile() === right.isFile()
    && left.isDirectory() === right.isDirectory());
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
    } catch { /* try the next trusted system binary */ }
  }
  fail('runtime_retention_package_deletion_fence_lock_backend_unavailable');
}

function openRuntimeRoot(runtimeRoot) {
  const selected = path.resolve(String(runtimeRoot || ''));
  if (!runtimeRoot || selected === path.parse(selected).root) {
    fail('runtime_retention_package_deletion_fence_runtime_root_invalid');
  }
  let descriptor;
  try {
    const before = fs.lstatSync(selected, { bigint: true });
    if (!before.isDirectory() || before.isSymbolicLink()
      || fs.realpathSync.native(selected) !== selected) {
      fail('runtime_retention_package_deletion_fence_runtime_root_invalid');
    }
    descriptor = fs.openSync(
      selected,
      fs.constants.O_RDONLY | DIRECTORY_ONLY | NO_FOLLOW,
    );
    const opened = fs.fstatSync(descriptor, { bigint: true });
    const owner = currentUserId();
    if (!opened.isDirectory() || !sameNode(before, opened)
      || (owner !== null && Number(opened.uid) !== owner)) {
      fail('runtime_retention_package_deletion_fence_runtime_root_invalid');
    }
    return Object.freeze({
      path: selected,
      descriptor,
      descriptorPath: `/proc/self/fd/${descriptor}`,
      stat: opened,
    });
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (String(error?.code || '').startsWith(
      'runtime_retention_package_deletion_fence_',
    )) throw error;
    fail('runtime_retention_package_deletion_fence_runtime_root_invalid', error);
  }
}

function assertRuntimeCurrent(runtime) {
  try {
    const opened = fs.fstatSync(runtime.descriptor, { bigint: true });
    const selected = fs.lstatSync(runtime.path, { bigint: true });
    if (!opened.isDirectory() || !selected.isDirectory()
      || selected.isSymbolicLink() || !sameNode(runtime.stat, opened)
      || !sameNode(runtime.stat, selected)) {
      fail('runtime_retention_package_deletion_fence_scope_changed');
    }
  } catch (error) {
    if (error?.code === 'runtime_retention_package_deletion_fence_scope_changed') {
      throw error;
    }
    fail('runtime_retention_package_deletion_fence_scope_changed', error);
  }
}

function openRepositoryRoot(runtime) {
  const candidate = path.join(runtime.descriptorPath, ROOT_NAME);
  let created = false;
  try {
    fs.mkdirSync(candidate, { mode: 0o700 });
    created = true;
  } catch (error) {
    if (error?.code !== 'EEXIST') {
      fail('runtime_retention_package_deletion_fence_root_invalid', error);
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
      || !opened.isDirectory() || !sameNode(selected, opened)
      || Number(opened.mode & 0o7777n) !== 0o700
      || (owner !== null && Number(opened.uid) !== owner)) {
      fail('runtime_retention_package_deletion_fence_root_invalid');
    }
    if (created) fs.fsyncSync(runtime.descriptor);
    assertRuntimeCurrent(runtime);
    return Object.freeze({
      path: path.join(runtime.path, ROOT_NAME),
      descriptor,
      descriptorPath: `/proc/self/fd/${descriptor}`,
      stat: opened,
    });
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (String(error?.code || '').startsWith(
      'runtime_retention_package_deletion_fence_',
    )) throw error;
    fail('runtime_retention_package_deletion_fence_root_invalid', error);
  }
}

function assertRepositoryCurrent(runtime, repository) {
  assertRuntimeCurrent(runtime);
  try {
    const opened = fs.fstatSync(repository.descriptor, { bigint: true });
    const selected = fs.lstatSync(repository.path, { bigint: true });
    if (!opened.isDirectory() || !selected.isDirectory()
      || selected.isSymbolicLink() || !sameNode(repository.stat, opened)
      || !sameNode(repository.stat, selected)
      || Number(opened.mode & 0o7777n) !== 0o700) {
      fail('runtime_retention_package_deletion_fence_scope_changed');
    }
  } catch (error) {
    if (error?.code === 'runtime_retention_package_deletion_fence_scope_changed') {
      throw error;
    }
    fail('runtime_retention_package_deletion_fence_scope_changed', error);
  }
}

function openLock(runtime, repository) {
  const candidate = path.join(repository.descriptorPath, LOCK_NAME);
  let existed = true;
  try { fs.lstatSync(candidate); } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    existed = false;
  }
  let descriptor;
  try {
    descriptor = fs.openSync(
      candidate,
      fs.constants.O_RDWR | fs.constants.O_CREAT | NO_FOLLOW,
      0o600,
    );
    const opened = fs.fstatSync(descriptor, { bigint: true });
    const selected = fs.lstatSync(candidate, { bigint: true });
    const owner = currentUserId();
    if (!opened.isFile() || !selected.isFile() || selected.isSymbolicLink()
      || !sameNode(opened, selected) || opened.nlink !== 1n
      || Number(opened.mode & 0o7777n) !== 0o600 || opened.size !== 0n
      || (owner !== null && Number(opened.uid) !== owner)) {
      fail('runtime_retention_package_deletion_fence_lock_invalid');
    }
    if (!existed) fs.fsyncSync(repository.descriptor);
    assertRepositoryCurrent(runtime, repository);
    return Object.freeze({
      descriptor,
      stat: opened,
      path: path.join(repository.path, LOCK_NAME),
    });
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (String(error?.code || '').startsWith(
      'runtime_retention_package_deletion_fence_',
    )) throw error;
    fail('runtime_retention_package_deletion_fence_lock_invalid', error);
  }
}

function acquireFlock(backend, descriptor) {
  const acquired = spawnSync(backend, [
    '--exclusive', '--nonblock', '3',
  ], {
    encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
    stdio: ['ignore', 'pipe', 'pipe', descriptor],
    timeout: 10_000,
    maxBuffer: 16 * 1024,
  });
  if (acquired.status === 1 && !acquired.error && !acquired.signal) {
    fail('runtime_retention_package_deletion_fence_lock_unavailable');
  }
  if (acquired.error || acquired.signal || acquired.status !== 0
    || acquired.stdout || acquired.stderr) {
    fail('runtime_retention_package_deletion_fence_lock_acquisition_failed');
  }
}

function assertLockCurrent(runtime, repository, lock) {
  assertRepositoryCurrent(runtime, repository);
  try {
    const held = fs.fstatSync(lock.descriptor, { bigint: true });
    const selected = fs.lstatSync(lock.path, { bigint: true });
    if (!sameNode(lock.stat, held) || !sameNode(lock.stat, selected)
      || held.mode !== lock.stat.mode || selected.mode !== lock.stat.mode
      || held.uid !== lock.stat.uid || selected.uid !== lock.stat.uid
      || selected.nlink !== 1n || selected.size !== 0n) {
      fail('runtime_retention_package_deletion_fence_lock_identity_changed');
    }
  } catch (error) {
    if (error?.code
      === 'runtime_retention_package_deletion_fence_lock_identity_changed') {
      throw error;
    }
    fail('runtime_retention_package_deletion_fence_lock_identity_changed', error);
  }
}

function closeScope(scope) {
  const failures = [];
  for (const descriptor of [
    scope.lock?.descriptor,
    scope.repository?.descriptor,
    scope.runtime?.descriptor,
  ]) {
    if (descriptor === undefined) continue;
    try { fs.closeSync(descriptor); } catch (error) { failures.push(error); }
  }
  if (failures.length) {
    throw new AggregateError(
      failures,
      'runtime_retention_package_deletion_fence_scope_close_failed',
    );
  }
}

function openLockedScope(runtimeRoot, backend) {
  const scope = { runtime: null, repository: null, lock: null };
  try {
    scope.runtime = openRuntimeRoot(runtimeRoot);
    scope.repository = openRepositoryRoot(scope.runtime);
    scope.lock = openLock(scope.runtime, scope.repository);
    acquireFlock(backend, scope.lock.descriptor);
    assertLockCurrent(scope.runtime, scope.repository, scope.lock);
    return scope;
  } catch (error) {
    try { closeScope(scope); } catch { /* preserve acquisition failure */ }
    throw error;
  }
}

function statePath(scope, lifecycleHash) {
  if (!SHA256.test(String(lifecycleHash || ''))) {
    fail('runtime_retention_package_deletion_fence_lifecycle_hash_invalid');
  }
  return path.join(
    scope.repository.descriptorPath,
    `${lifecycleHash.slice('sha256:'.length)}.json`,
  );
}

function assertSafeRecordFile(candidate) {
  const stat = fs.lstatSync(candidate, { bigint: true });
  const owner = currentUserId();
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n
    || Number(stat.mode & 0o7777n) !== 0o600
    || stat.size < 1n || stat.size > BigInt(MAX_RECORD_BYTES)
    || (owner !== null && Number(stat.uid) !== owner)) {
    fail('runtime_retention_package_deletion_fence_record_invalid');
  }
}

function readRecord(scope, lifecycleHash) {
  const candidate = statePath(scope, lifecycleHash);
  try { assertSafeRecordFile(candidate); } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  const record = readRegularJsonFileSync(candidate);
  if (!verifyRuntimeRetentionPackageDeletionFence(record).valid
    || record.packageLifecycleReceiptHash !== lifecycleHash
    || record.runtimeRoot !== scope.runtime.path) {
    fail('runtime_retention_package_deletion_fence_record_invalid');
  }
  return Object.freeze(record);
}

function removeSafeTemporary(scope, name) {
  const candidate = path.join(scope.repository.descriptorPath, name);
  const stat = fs.lstatSync(candidate, { bigint: true });
  const owner = currentUserId();
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n
    || Number(stat.mode & 0o7777n) !== 0o600
    || (owner !== null && Number(stat.uid) !== owner)) {
    fail('runtime_retention_package_deletion_fence_temporary_invalid');
  }
  fs.unlinkSync(candidate);
  fs.fsyncSync(scope.repository.descriptor);
}

function listRecords(scope) {
  const records = [];
  const names = fs.readdirSync(scope.repository.descriptorPath).sort();
  for (const name of names) {
    if (name === LOCK_NAME) continue;
    if (TEMP_NAME.test(name)) {
      removeSafeTemporary(scope, name);
      continue;
    }
    const match = STATE_NAME.exec(name);
    if (!match) fail('runtime_retention_package_deletion_fence_inventory_invalid');
    records.push(readRecord(scope, `sha256:${match[1]}`));
  }
  return Object.freeze(records);
}

function writeRecord(scope, record) {
  const candidate = statePath(scope, record.packageLifecycleReceiptHash);
  const temporary = path.join(
    scope.repository.descriptorPath,
    `.fence-tmp-${process.pid}-${crypto.randomUUID()}`,
  );
  let descriptor;
  try {
    descriptor = fs.openSync(
      temporary,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NO_FOLLOW,
      0o600,
    );
    fs.writeFileSync(descriptor, `${JSON.stringify(record, null, 2)}\n`);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, candidate);
    fs.fsyncSync(scope.repository.descriptor);
    assertSafeRecordFile(candidate);
    const persisted = readRecord(scope, record.packageLifecycleReceiptHash);
    if (persisted.runtimeRetentionPackageDeletionFenceHash
      !== record.runtimeRetentionPackageDeletionFenceHash) {
      fail('runtime_retention_package_deletion_fence_persist_failed');
    }
    return persisted;
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try { fs.unlinkSync(temporary); } catch { /* residue is checked on the next inventory */ }
    throw error;
  }
}

function runWithScope(runtimeRoot, backend, operation) {
  const scope = openLockedScope(runtimeRoot, backend);
  let value;
  try {
    value = operation(scope);
  } catch (error) {
    closeScope(scope);
    throw error;
  }
  if (value && typeof value.then === 'function') {
    return Promise.resolve(value).finally(() => closeScope(scope));
  }
  closeScope(scope);
  return value;
}

export function createRuntimeRetentionPackageDeletionFenceStorageRepository({
  runtimeRoot,
} = {}) {
  const backend = trustedFlockBackend();
  return Object.freeze({
    assertLocked: (scope) =>
      assertLockCurrent(scope.runtime, scope.repository, scope.lock),
    list: listRecords,
    read: readRecord,
    runLocked: (operation) => runWithScope(runtimeRoot, backend, operation),
    write: writeRecord,
  });
}
