import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MAXIMUM_LOCK_OWNER_BYTES = 16 * 1024;
const MINIMUM_REMOTE_ABANDONED_MARGIN_MS = 60 * 1000;
const MAXIMUM_TIMER_DELAY_MS = 2_147_483_647;
const INVALID_STAGING_ABANDONED_AFTER_MS = 24 * 60 * 60 * 1000;

function identity(stat) {
  return Object.freeze({ dev: String(stat.dev), ino: String(stat.ino) });
}

function sameIdentity(left, right) {
  return left?.dev === String(right?.dev) && left?.ino === String(right?.ino);
}

function ownedByProcess(stat) {
  return typeof process.getuid !== 'function' || Number(stat.uid) === process.getuid();
}

function secureLockEntry(stat, allowedLinks = [1, 2]) {
  return stat.isFile() && !stat.isSymbolicLink()
    && allowedLinks.includes(Number(stat.nlink)) && ownedByProcess(stat)
    && (stat.mode & 0o7777) === 0o600 && stat.size <= MAXIMUM_LOCK_OWNER_BYTES;
}

function fsyncDirectorySync(candidate) {
  const descriptor = fs.openSync(
    candidate,
    fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0),
  );
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}

function processStartIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return null;
  try {
    const source = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const commandEnd = source.lastIndexOf(')');
    if (commandEnd < 0) return null;
    const fields = source.slice(commandEnd + 1).trim().split(/\s+/);
    return fields[19] ? `linux-proc-start:${fields[19]}` : null;
  } catch { return null; }
}

function currentBootIdentity() {
  try {
    const value = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    return value ? `linux-boot:${value}` : null;
  } catch { return null; }
}

function processOwnerState(owner) {
  if (owner?.hostname !== os.hostname()) return 'unknown';
  const currentBoot = currentBootIdentity();
  if (owner.bootIdentity && currentBoot && owner.bootIdentity !== currentBoot) return 'dead';
  const pid = Number(owner?.pid);
  if (!Number.isSafeInteger(pid) || pid < 1) return 'unknown';
  const observedStart = processStartIdentity(pid);
  if (observedStart) {
    if (owner.processStartIdentity === observedStart) return 'alive';
    return owner.processStartIdentity ? 'dead' : 'unknown';
  }
  try {
    process.kill(pid, 0);
    return 'unknown';
  } catch (error) {
    return error?.code === 'ESRCH' ? 'dead' : 'unknown';
  }
}

function validOwnerRecord(owner, { requestHash, cacheRootIdentity } = {}) {
  return owner?.version === 1 && owner?.kind === 'AgentProductionCacheRequestLockOwner'
    && owner.requestHash === requestHash && typeof owner.ownerToken === 'string'
    && owner.ownerToken.length >= 16 && Number.isSafeInteger(Number(owner.pid))
    && Number(owner.pid) > 0 && typeof owner.hostname === 'string' && owner.hostname
    && (!owner.bootIdentity || typeof owner.bootIdentity === 'string')
    && (!owner.processStartIdentity || typeof owner.processStartIdentity === 'string')
    && typeof owner.stagingName === 'string' && path.basename(owner.stagingName) === owner.stagingName
    && owner.stagingName.startsWith(`.pending-${requestHash.slice('sha256:'.length)}-`)
    && Number.isSafeInteger(owner.staleAfterMs) && owner.staleAfterMs > 0
    && Number.isSafeInteger(owner.abandonedAfterMs)
    && owner.abandonedAfterMs >= owner.staleAfterMs + MINIMUM_REMOTE_ABANDONED_MARGIN_MS
    && Number.isSafeInteger(owner.heartbeatIntervalMs) && owner.heartbeatIntervalMs > 0
    && owner.heartbeatIntervalMs <= MAXIMUM_TIMER_DELAY_MS
    && owner.heartbeatIntervalMs <= Math.floor(owner.abandonedAfterMs / 3)
    && Number.isFinite(Date.parse(owner.acquiredAt))
    && owner.cacheRootIdentity?.dev === cacheRootIdentity.dev
    && owner.cacheRootIdentity?.ino === cacheRootIdentity.ino;
}

export function currentAgentProductionCacheLockOwnerProcessIdentity() {
  return Object.freeze({
    pid: process.pid,
    hostname: os.hostname(),
    bootIdentity: currentBootIdentity(),
    processStartIdentity: processStartIdentity(process.pid),
  });
}

export function readAgentProductionCacheLockOwner(
  candidate,
  expectedIdentity = null,
  allowPublishingLink = false,
) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const before = fs.lstatSync(candidate);
    if (!secureLockEntry(before, allowPublishingLink ? [1, 2] : [1])
      || fs.realpathSync(candidate) !== path.resolve(candidate)
      || (expectedIdentity && !sameIdentity(expectedIdentity, before))) {
      throw new Error('agent_production_cache_request_lock_owner_invalid');
    }
    const descriptor = fs.openSync(
      candidate,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
    );
    try {
      const opened = fs.fstatSync(descriptor);
      if (!secureLockEntry(opened, allowPublishingLink ? [1, 2] : [1])
        || !sameIdentity(identity(before), opened)) {
        throw new Error('agent_production_cache_request_lock_owner_invalid');
      }
      const source = fs.readFileSync(descriptor, 'utf8');
      const after = fs.lstatSync(candidate);
      if (!secureLockEntry(after, allowPublishingLink ? [1, 2] : [1])
        || !sameIdentity(identity(before), after)
        || String(after.size) !== String(before.size)) {
        throw new Error('agent_production_cache_request_lock_owner_drifted');
      }
      if (String(after.mtimeMs) !== String(before.mtimeMs)) {
        if (attempt === 0) continue;
        throw new Error('agent_production_cache_request_lock_owner_drifted');
      }
      return Object.freeze({ value: JSON.parse(source), identity: identity(before), stat: before });
    } finally { fs.closeSync(descriptor); }
  }
  throw new Error('agent_production_cache_request_lock_owner_drifted');
}

function inspectExistingLock({ lockRoot, lockPath, requestHash, cacheRootIdentity, nowMs }) {
  let lockFile = readAgentProductionCacheLockOwner(lockPath, null, true);
  if (!validOwnerRecord(lockFile.value, { requestHash, cacheRootIdentity })) {
    throw new Error('agent_production_cache_request_lock_owner_invalid');
  }
  if (Number(lockFile.stat.nlink) === 2) {
    const stagingPath = path.join(lockRoot, lockFile.value.stagingName);
    let staging;
    try { staging = fs.lstatSync(stagingPath); } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      lockFile = readAgentProductionCacheLockOwner(lockPath, lockFile.identity);
    }
    if (staging) {
      if (!secureLockEntry(staging) || !sameIdentity(lockFile.identity, staging)
        || fs.realpathSync(stagingPath) !== stagingPath) {
        throw new Error('agent_production_cache_request_lock_owner_invalid');
      }
      try { fs.unlinkSync(stagingPath); } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
      fsyncDirectorySync(lockRoot);
      lockFile = readAgentProductionCacheLockOwner(lockPath, lockFile.identity);
    }
  }
  const ageMs = nowMs - Math.max(
    Date.parse(lockFile.value.acquiredAt), Number(lockFile.stat.mtimeMs),
  );
  return Object.freeze({
    lockFile,
    recoverable: processOwnerState(lockFile.value) === 'dead'
      && ageMs >= lockFile.value.staleAfterMs,
  });
}

export function recoverExistingAgentProductionCacheRequestLock(options) {
  try {
    const inspection = inspectExistingLock(options);
    if (!inspection.recoverable) {
      throw new Error('agent_production_cache_request_lock_contended');
    }
    const rechecked = readAgentProductionCacheLockOwner(
      options.lockPath,
      inspection.lockFile.identity,
    );
    if (String(rechecked.stat.mtimeMs) !== String(inspection.lockFile.stat.mtimeMs)
      || JSON.stringify(rechecked.value) !== JSON.stringify(inspection.lockFile.value)) {
      throw new Error('agent_production_cache_request_lock_contended');
    }
    fs.unlinkSync(options.lockPath);
    fsyncDirectorySync(options.lockRoot);
    return Object.freeze({ recovered: true });
  } catch (error) {
    if (error?.code === 'ENOENT'
      || error?.message === 'agent_production_cache_request_lock_owner_drifted') {
      throw new Error('agent_production_cache_request_lock_contended');
    }
    throw error;
  }
}

export function cleanupAgentProductionCacheRequestLockStaging({
  lockRoot,
  requestHash,
  cacheRootIdentity,
  nowMs,
}) {
  const prefix = `.pending-${requestHash.slice('sha256:'.length)}-`;
  let removed = 0;
  for (const name of fs.readdirSync(lockRoot)) {
    if (!name.startsWith(prefix) || path.basename(name) !== name) continue;
    const candidate = path.join(lockRoot, name);
    let file;
    try { file = readAgentProductionCacheLockOwner(candidate); } catch {
      try {
        const before = fs.lstatSync(candidate);
        if (!secureLockEntry(before, [1])
          || nowMs - Number(before.mtimeMs) < INVALID_STAGING_ABANDONED_AFTER_MS) continue;
        const after = fs.lstatSync(candidate);
        if (!sameIdentity(identity(before), after)
          || String(before.mtimeMs) !== String(after.mtimeMs)
          || !secureLockEntry(after, [1])) continue;
        fs.unlinkSync(candidate);
        removed += 1;
      } catch { /* A live or drifting staging entry remains fail closed. */ }
      continue;
    }
    if (!validOwnerRecord(file.value, { requestHash, cacheRootIdentity })
      || file.value.stagingName !== name) continue;
    const ageMs = nowMs - Math.max(
      Date.parse(file.value.acquiredAt), Number(file.stat.mtimeMs),
    );
    const threshold = processOwnerState(file.value) === 'dead'
      ? file.value.staleAfterMs : file.value.abandonedAfterMs;
    if (ageMs < threshold) continue;
    try {
      const rechecked = readAgentProductionCacheLockOwner(candidate, file.identity);
      if (String(rechecked.stat.mtimeMs) !== String(file.stat.mtimeMs)
        || JSON.stringify(rechecked.value) !== JSON.stringify(file.value)) continue;
      fs.unlinkSync(candidate);
      removed += 1;
    } catch { /* Acquisition won the race; its canonical link remains authoritative. */ }
  }
  if (removed) fsyncDirectorySync(lockRoot);
  return Object.freeze({ removed });
}
