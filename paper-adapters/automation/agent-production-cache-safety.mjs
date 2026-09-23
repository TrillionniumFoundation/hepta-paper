import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { writeDescriptorFullySync } from '../../workflow-kernel/runtime/file-descriptor-utils.mjs';
import { isPathWithin } from '../../workflow-kernel/runtime/path-utils.mjs';
import {
  publishAgentProductionCacheEntryNoClobberWithLockContext,
} from './agent-production-cache-no-clobber-publisher.mjs';
import {
  runAgentProductionCacheRequestLockOperation,
} from './agent-production-cache-lock-wait.mjs';
import {
  cleanupAgentProductionCacheRequestLockStaging,
  currentAgentProductionCacheLockOwnerProcessIdentity,
  readAgentProductionCacheLockOwner,
  recoverExistingAgentProductionCacheRequestLock,
} from './agent-production-cache-request-lock-storage.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const LOCK_ROOT_NAME = '.agent-production-cache-locks';
const MAXIMUM_LOCK_OWNER_BYTES = 16 * 1024;
const DEFAULT_STALE_AFTER_MS = 30 * 60 * 1000;
const MINIMUM_REMOTE_ABANDONED_MARGIN_MS = 60 * 1000;
const DEFAULT_CONTENTION_WAIT_MS = DEFAULT_STALE_AFTER_MS
  + MINIMUM_REMOTE_ABANDONED_MARGIN_MS;
const MAXIMUM_TIMER_DELAY_MS = 2_147_483_647;
const LOCK_STATES = new WeakMap();

function identity(stat) {
  return Object.freeze({ dev: String(stat.dev), ino: String(stat.ino) });
}

function sameIdentity(left, right) {
  return left?.dev === String(right?.dev) && left?.ino === String(right?.ino);
}

function ownedByProcess(stat) {
  return typeof process.getuid !== 'function' || Number(stat.uid) === process.getuid();
}

function secureDirectory(stat) {
  return stat.isDirectory() && !stat.isSymbolicLink()
    && ownedByProcess(stat) && (stat.mode & 0o7777) === 0o700;
}

function secureCacheEntry(stat, maximumBytes) {
  return stat.isFile() && !stat.isSymbolicLink() && Number(stat.nlink) === 1
    && ownedByProcess(stat) && (stat.mode & 0o7777) === 0o600
    && stat.size <= maximumBytes;
}

function assertSecureDirectory(candidate, expectedIdentity, errorCode) {
  const resolved = path.resolve(candidate);
  const stat = fs.lstatSync(resolved);
  if (!secureDirectory(stat) || fs.realpathSync(resolved) !== resolved
    || (expectedIdentity && !sameIdentity(expectedIdentity, stat))) throw new Error(errorCode);
  return Object.freeze({ path: resolved, identity: identity(stat), stat });
}

function fsyncDirectorySync(candidate) {
  const descriptor = fs.openSync(
    candidate,
    fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0),
  );
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}

function writeExclusiveJsonFile(candidate, value) {
  let descriptor;
  try {
    descriptor = fs.openSync(
      candidate,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
        | (fs.constants.O_NOFOLLOW || 0),
      0o600,
    );
    writeDescriptorFullySync(descriptor, `${JSON.stringify(value)}\n`);
    fs.fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
  const stat = fs.lstatSync(candidate);
  if (!secureCacheEntry(stat, MAXIMUM_LOCK_OWNER_BYTES)
    || fs.realpathSync(candidate) !== path.resolve(candidate))
    throw new Error('agent_production_cache_request_lock_owner_invalid');
  return identity(stat);
}

function lockPathFor(lockRoot, requestHash) {
  if (!SHA256.test(String(requestHash || '')))
    throw new Error('agent_production_cache_request_hash_invalid');
  return path.join(lockRoot, `${requestHash.slice('sha256:'.length)}.lock`);
}

function ensureLockRoot(cacheRoot, cacheRootIdentity) {
  assertAgentProductionCacheRoot(cacheRoot, cacheRootIdentity);
  const lockRoot = path.join(cacheRoot, LOCK_ROOT_NAME);
  try {
    fs.mkdirSync(lockRoot, { mode: 0o700 });
    fsyncDirectorySync(cacheRoot);
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
  const inspected = assertSecureDirectory(
    lockRoot,
    null,
    'agent_production_cache_lock_root_invalid',
  );
  assertAgentProductionCacheRoot(cacheRoot, cacheRootIdentity);
  return inspected;
}

function lockTimingPolicy({ staleAfterMs, abandonedAfterMs, heartbeatIntervalMs }) {
  const defaultAbandonedAfterMs = Math.max(
    staleAfterMs * 2,
    staleAfterMs + MINIMUM_REMOTE_ABANDONED_MARGIN_MS,
  );
  const policy = Object.freeze({
    staleAfterMs,
    abandonedAfterMs: abandonedAfterMs ?? defaultAbandonedAfterMs,
    heartbeatIntervalMs: heartbeatIntervalMs
      ?? Math.max(1_000, Math.min(60_000, Math.floor(staleAfterMs / 3))),
  });
  if (!Number.isSafeInteger(policy.staleAfterMs) || policy.staleAfterMs < 1
    || !Number.isSafeInteger(policy.abandonedAfterMs)
    || policy.abandonedAfterMs < policy.staleAfterMs + MINIMUM_REMOTE_ABANDONED_MARGIN_MS
    || !Number.isSafeInteger(policy.heartbeatIntervalMs)
    || policy.heartbeatIntervalMs < 1
    || policy.heartbeatIntervalMs > MAXIMUM_TIMER_DELAY_MS
    || policy.heartbeatIntervalMs > Math.floor(policy.abandonedAfterMs / 3)) {
    throw new Error('agent_production_cache_request_lock_policy_invalid');
  }
  return policy;
}

function removeOwnedFile(candidate, expectedIdentity, allowPublishingLink = false) {
  try {
    readAgentProductionCacheLockOwner(candidate, expectedIdentity, allowPublishingLink);
    fs.unlinkSync(candidate);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function startLockHeartbeat(lock, state) {
  state.heartbeatTimer = setInterval(() => {
    try {
      refreshAgentProductionCacheRequestLock(lock);
    } catch (error) {
      state.heartbeatError = error;
      clearInterval(state.heartbeatTimer);
      state.heartbeatTimer = null;
    }
  }, state.ownerRecord.heartbeatIntervalMs);
  state.heartbeatTimer.unref?.();
}

export function assertAgentProductionCacheRoot(cacheRoot, expectedIdentity = null) {
  const root = path.resolve(cacheRoot || '');
  const stat = fs.lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()
    || fs.realpathSync(root) !== root
    || !ownedByProcess(stat) || (stat.mode & 0o7777) !== 0o700
    || (expectedIdentity && !sameIdentity(expectedIdentity, stat))) {
    throw new Error('agent_production_cache_root_invalid');
  }
  return identity(stat);
}

export function prepareAgentProductionCacheRoot(cacheRoot) {
  const root = path.resolve(cacheRoot || '');
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  return Object.freeze({ root, identity: assertAgentProductionCacheRoot(root) });
}

export function readAgentProductionCache({
  cacheRoot,
  cacheRootIdentity,
  candidate,
  maximumBytes,
} = {}) {
  try {
    const root = path.resolve(cacheRoot);
    assertAgentProductionCacheRoot(root, cacheRootIdentity);
    const target = path.resolve(candidate);
    const before = fs.lstatSync(target);
    if (!isPathWithin(root, target) || !secureCacheEntry(before, maximumBytes)
      || fs.realpathSync(target) !== target) return null;
    const descriptor = fs.openSync(
      target,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
    );
    try {
      const opened = fs.fstatSync(descriptor);
      if (!secureCacheEntry(opened, maximumBytes)
        || !sameIdentity(identity(before), opened)) return null;
      const source = fs.readFileSync(descriptor, 'utf8');
      const after = fs.lstatSync(target);
      if (!secureCacheEntry(after, maximumBytes)
        || !sameIdentity(identity(before), after)
        || String(after.size) !== String(before.size)
        || String(after.mtimeMs) !== String(before.mtimeMs)) return null;
      const parsed = JSON.parse(source);
      assertAgentProductionCacheRoot(root, cacheRootIdentity);
      return parsed;
    } finally {
      fs.closeSync(descriptor);
    }
  } catch { return null; }
}

export function acquireAgentProductionCacheRequestLock({
  cacheRoot,
  cacheRootIdentity: expectedCacheRootIdentity = null,
  requestHash,
  staleAfterMs = DEFAULT_STALE_AFTER_MS,
  abandonedAfterMs,
  heartbeatIntervalMs,
  clock = Object.freeze({ now: () => new Date() }),
} = {}) {
  if (typeof clock?.now !== 'function') {
    throw new Error('agent_production_cache_request_lock_policy_invalid');
  }
  const timing = lockTimingPolicy({ staleAfterMs, abandonedAfterMs, heartbeatIntervalMs });
  const root = path.resolve(cacheRoot || '');
  const cacheRootIdentity = assertAgentProductionCacheRoot(
    root,
    expectedCacheRootIdentity,
  );
  const lockRoot = ensureLockRoot(root, cacheRootIdentity);
  const lockPath = lockPathFor(lockRoot.path, requestHash);
  const observedNow = clock.now();
  const now = observedNow instanceof Date ? observedNow : new Date(observedNow);
  if (!Number.isFinite(now.getTime())) {
    throw new Error('agent_production_cache_request_lock_clock_invalid');
  }
  cleanupAgentProductionCacheRequestLockStaging({
    lockRoot: lockRoot.path,
    requestHash,
    cacheRootIdentity,
    nowMs: now.getTime(),
  });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const stagingName = `.pending-${requestHash.slice('sha256:'.length)}-${process.pid}-${randomUUID()}`;
    const stagingPath = path.join(lockRoot.path, stagingName);
    const ownerRecord = Object.freeze({
      version: 1,
      kind: 'AgentProductionCacheRequestLockOwner',
      requestHash,
      ownerToken: randomUUID(),
      ...currentAgentProductionCacheLockOwnerProcessIdentity(),
      stagingName,
      ...timing,
      acquiredAt: now.toISOString(),
      cacheRootIdentity,
    });
    let stagingIdentity = null;
    let canonicalLinked = false;
    let descriptor;
    try {
      stagingIdentity = writeExclusiveJsonFile(stagingPath, ownerRecord);
      try {
        fs.linkSync(stagingPath, lockPath);
        canonicalLinked = true;
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        removeOwnedFile(stagingPath, stagingIdentity);
        fsyncDirectorySync(lockRoot.path);
        stagingIdentity = null;
        recoverExistingAgentProductionCacheRequestLock({
          lockRoot: lockRoot.path,
          lockPath,
          requestHash,
          cacheRootIdentity,
          nowMs: now.getTime(),
        });
        assertAgentProductionCacheRoot(root, cacheRootIdentity);
        assertSecureDirectory(
          lockRoot.path,
          lockRoot.identity,
          'agent_production_cache_lock_root_drifted',
        );
        continue;
      }
      const publishingOwner = readAgentProductionCacheLockOwner(
        lockPath,
        stagingIdentity,
        true,
      );
      if (JSON.stringify(publishingOwner.value) !== JSON.stringify(ownerRecord)) {
        throw new Error('agent_production_cache_request_lock_owner_drifted');
      }
      fsyncDirectorySync(lockRoot.path);
      removeOwnedFile(stagingPath, stagingIdentity, true);
      fsyncDirectorySync(lockRoot.path);
      const persistedOwner = readAgentProductionCacheLockOwner(lockPath, stagingIdentity);
      if (JSON.stringify(persistedOwner.value) !== JSON.stringify(ownerRecord)) {
        throw new Error('agent_production_cache_request_lock_owner_drifted');
      }
      descriptor = fs.openSync(
        lockPath,
        fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW || 0),
      );
      const opened = fs.fstatSync(descriptor);
      if (!secureCacheEntry(opened, MAXIMUM_LOCK_OWNER_BYTES)
        || !sameIdentity(stagingIdentity, opened)) {
        throw new Error('agent_production_cache_request_lock_owner_invalid');
      }
      assertAgentProductionCacheRoot(root, cacheRootIdentity);
      assertSecureDirectory(
        lockRoot.path,
        lockRoot.identity,
        'agent_production_cache_lock_root_drifted',
      );
      const lock = Object.freeze({
        version: 1,
        kind: 'AgentProductionCacheRequestLock',
        requestHash,
        cacheRoot: root,
        lockPath,
        acquiredAt: ownerRecord.acquiredAt,
      });
      const state = {
        released: false,
        heartbeatError: null,
        heartbeatTimer: null,
        descriptor,
        cacheRoot: root,
        cacheRootIdentity,
        lockRoot: lockRoot.path,
        lockRootIdentity: lockRoot.identity,
        lockPath,
        lockIdentity: stagingIdentity,
        ownerRecord,
      };
      descriptor = undefined;
      LOCK_STATES.set(lock, state);
      startLockHeartbeat(lock, state);
      return lock;
    } catch (error) {
      if (descriptor !== undefined) fs.closeSync(descriptor);
      try {
        if (canonicalLinked && stagingIdentity)
          removeOwnedFile(lockPath, stagingIdentity, true);
        if (stagingIdentity) removeOwnedFile(stagingPath, stagingIdentity, true);
        if (canonicalLinked || stagingIdentity) fsyncDirectorySync(lockRoot.path);
      } catch {
        // Unknown ownership is never removed as part of failed acquisition cleanup.
      }
      throw error;
    }
  }
  throw new Error('agent_production_cache_request_lock_contended');
}

function validateRequestLock(lock, expected = {}, enforceHeartbeat = true) {
  const state = LOCK_STATES.get(lock);
  if (!state || lock?.version !== 1 || lock?.kind !== 'AgentProductionCacheRequestLock') {
    throw new Error('agent_production_cache_request_lock_capability_required');
  }
  if (state.released) throw new Error('agent_production_cache_request_lock_not_held');
  if (enforceHeartbeat && state.heartbeatError) {
    throw new Error('agent_production_cache_request_lock_heartbeat_failed');
  }
  if (expected.cacheRoot && path.resolve(expected.cacheRoot) !== state.cacheRoot) {
    throw new Error('agent_production_cache_request_lock_root_mismatch');
  }
  if (expected.requestHash && expected.requestHash !== lock.requestHash) {
    throw new Error('agent_production_cache_request_lock_request_mismatch');
  }
  assertAgentProductionCacheRoot(state.cacheRoot, state.cacheRootIdentity);
  assertSecureDirectory(
    state.lockRoot,
    state.lockRootIdentity,
    'agent_production_cache_lock_root_drifted',
  );
  const owner = readAgentProductionCacheLockOwner(state.lockPath, state.lockIdentity);
  if (JSON.stringify(owner.value) !== JSON.stringify(state.ownerRecord)) {
    throw new Error('agent_production_cache_request_lock_owner_drifted');
  }
  const opened = fs.fstatSync(state.descriptor);
  if (!secureCacheEntry(opened, MAXIMUM_LOCK_OWNER_BYTES)
    || !sameIdentity(state.lockIdentity, opened)) {
    throw new Error('agent_production_cache_request_lock_owner_invalid');
  }
  return lock;
}

export function assertAgentProductionCacheRequestLock(lock, expected = {}) {
  return validateRequestLock(lock, expected, true);
}

export function refreshAgentProductionCacheRequestLock(
  lock,
  { clock = Object.freeze({ now: () => new Date() }) } = {},
) {
  if (typeof clock?.now !== 'function') {
    throw new Error('agent_production_cache_request_lock_clock_invalid');
  }
  validateRequestLock(lock, {}, false);
  const observedNow = clock.now();
  const now = observedNow instanceof Date ? observedNow : new Date(observedNow);
  if (!Number.isFinite(now.getTime())) {
    throw new Error('agent_production_cache_request_lock_clock_invalid');
  }
  const state = LOCK_STATES.get(lock);
  fs.futimesSync(state.descriptor, now, now);
  fs.fsyncSync(state.descriptor);
  validateRequestLock(lock, {}, false);
  return Object.freeze({ refreshed: true, heartbeatAt: now.toISOString() });
}

export function releaseAgentProductionCacheRequestLock(lock) {
  const state = LOCK_STATES.get(lock);
  if (!state) {
    throw new Error('agent_production_cache_request_lock_capability_required');
  }
  if (state.released) {
    return Object.freeze({ released: false, alreadyReleased: true });
  }
  validateRequestLock(lock, {}, false);
  clearInterval(state.heartbeatTimer);
  state.heartbeatTimer = null;
  try {
    fs.unlinkSync(state.lockPath);
  } catch (error) {
    startLockHeartbeat(lock, state);
    throw error;
  }
  state.released = true;
  fs.closeSync(state.descriptor);
  state.descriptor = null;
  fsyncDirectorySync(state.lockRoot);
  assertAgentProductionCacheRoot(state.cacheRoot, state.cacheRootIdentity);
  return Object.freeze({ released: true, alreadyReleased: false });
}

export async function withAgentProductionCacheRequestLock(options, operation) {
  return runAgentProductionCacheRequestLockOperation({
    options,
    operation,
    acquireLock: acquireAgentProductionCacheRequestLock,
    assertLock: assertAgentProductionCacheRequestLock,
    releaseLock: releaseAgentProductionCacheRequestLock,
    defaultContentionWaitMs: DEFAULT_CONTENTION_WAIT_MS,
  });
}

export function publishAgentProductionCacheEntryNoClobber({
  lock,
  candidate,
  value,
  maximumBytes,
} = {}) {
  assertAgentProductionCacheRequestLock(lock);
  const state = LOCK_STATES.get(lock);
  return publishAgentProductionCacheEntryNoClobberWithLockContext({
    assertLock: () => assertAgentProductionCacheRequestLock(lock),
    cacheRoot: state.cacheRoot,
    requestHash: lock.requestHash,
    ownerToken: state.ownerRecord.ownerToken,
    candidate,
    value,
    maximumBytes,
  });
}
