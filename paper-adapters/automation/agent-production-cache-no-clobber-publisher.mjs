import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { writeDescriptorFullySync } from '../../workflow-kernel/runtime/file-descriptor-utils.mjs';
import { isPathWithin } from '../../workflow-kernel/runtime/path-utils.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const UUID_SOURCE = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const UUID = new RegExp(`^${UUID_SOURCE}$`);
const PUBLISHING_SUFFIX = new RegExp(`^${UUID_SOURCE}-[1-9][0-9]*-${UUID_SOURCE}$`);

function identity(stat) {
  return Object.freeze({ dev: String(stat.dev), ino: String(stat.ino) });
}

function sameIdentity(left, right) {
  return left?.dev === String(right?.dev) && left?.ino === String(right?.ino);
}

function secureCacheEntry(stat, maximumBytes) {
  return stat.isFile() && !stat.isSymbolicLink() && Number(stat.nlink) === 1
    && (typeof process.getuid !== 'function' || Number(stat.uid) === process.getuid())
    && (stat.mode & 0o7777) === 0o600 && stat.size <= maximumBytes;
}

function securePublishingEntry(stat, maximumBytes) {
  return stat.isFile() && !stat.isSymbolicLink() && Number(stat.nlink) === 2
    && (typeof process.getuid !== 'function' || Number(stat.uid) === process.getuid())
    && (stat.mode & 0o7777) === 0o600 && stat.size <= maximumBytes;
}

function fsyncDirectorySync(candidate) {
  const descriptor = fs.openSync(
    candidate,
    fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0),
  );
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}

function publishingStagePrefix(target, requestHash) {
  return `.${path.basename(target)}.publish-${requestHash.slice('sha256:'.length)}-`;
}

function assertCompletePublishingEntry(candidate, expectedIdentity, maximumBytes, requestHash) {
  const descriptor = fs.openSync(
    candidate,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
  );
  try {
    const opened = fs.fstatSync(descriptor);
    if (!securePublishingEntry(opened, maximumBytes)
      || !sameIdentity(expectedIdentity, opened)) {
      throw new Error('agent_production_cache_publish_existing_invalid');
    }
    const parsed = JSON.parse(fs.readFileSync(descriptor, 'utf8'));
    if (parsed?.request?.requestHash !== requestHash) {
      throw new Error('agent_production_cache_publish_existing_invalid');
    }
  } finally { fs.closeSync(descriptor); }
}

function inspectOrRepairExistingTarget({
  target,
  cacheRoot,
  requestHash,
  maximumBytes,
  assertLock,
}) {
  let targetStat = fs.lstatSync(target);
  if (secureCacheEntry(targetStat, maximumBytes)
    && fs.realpathSync(target) === target) return targetStat;
  if (!securePublishingEntry(targetStat, maximumBytes)
    || fs.realpathSync(target) !== target) {
    throw new Error('agent_production_cache_publish_existing_invalid');
  }
  const targetIdentity = identity(targetStat);
  const prefix = publishingStagePrefix(target, requestHash);
  const aliases = fs.readdirSync(cacheRoot)
    .filter((name) => name.startsWith(prefix)
      && PUBLISHING_SUFFIX.test(name.slice(prefix.length)))
    .map((name) => path.join(cacheRoot, name))
    .filter((candidate) => {
      try {
        const stat = fs.lstatSync(candidate);
        return securePublishingEntry(stat, maximumBytes)
          && sameIdentity(targetIdentity, stat)
          && fs.realpathSync(candidate) === candidate;
      } catch { return false; }
    });
  if (aliases.length !== 1) {
    targetStat = fs.lstatSync(target);
    if (secureCacheEntry(targetStat, maximumBytes)
      && sameIdentity(targetIdentity, targetStat)
      && fs.realpathSync(target) === target) return targetStat;
    throw new Error('agent_production_cache_publish_existing_invalid');
  }
  assertCompletePublishingEntry(target, targetIdentity, maximumBytes, requestHash);
  assertLock();
  const aliasStat = fs.lstatSync(aliases[0]);
  targetStat = fs.lstatSync(target);
  if (!securePublishingEntry(aliasStat, maximumBytes)
    || !securePublishingEntry(targetStat, maximumBytes)
    || !sameIdentity(targetIdentity, aliasStat)
    || !sameIdentity(targetIdentity, targetStat)) {
    throw new Error('agent_production_cache_publish_existing_invalid');
  }
  try { fs.unlinkSync(aliases[0]); } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  fsyncDirectorySync(cacheRoot);
  targetStat = fs.lstatSync(target);
  if (!secureCacheEntry(targetStat, maximumBytes)
    || !sameIdentity(targetIdentity, targetStat)
    || fs.realpathSync(target) !== target) {
    throw new Error('agent_production_cache_publish_existing_invalid');
  }
  assertLock();
  return targetStat;
}

export function publishAgentProductionCacheEntryNoClobberWithLockContext({
  assertLock,
  cacheRoot,
  requestHash,
  ownerToken,
  candidate,
  value,
  maximumBytes,
} = {}) {
  if (typeof assertLock !== 'function') {
    throw new Error('agent_production_cache_request_lock_capability_required');
  }
  assertLock();
  if (!SHA256.test(String(requestHash || '')) || !UUID.test(String(ownerToken || ''))) {
    throw new Error('agent_production_cache_publish_context_invalid');
  }
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    throw new Error('agent_production_cache_publish_limit_invalid');
  }
  const target = path.resolve(candidate || '');
  const expectedTarget = path.join(
    cacheRoot,
    `${requestHash.slice('sha256:'.length)}.json`,
  );
  if (target !== expectedTarget || !isPathWithin(cacheRoot, target)) {
    throw new Error('agent_production_cache_publish_target_invalid');
  }
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  const bytes = Buffer.byteLength(serialized);
  if (bytes > maximumBytes) throw new Error('agent_production_cache_publish_too_large');
  try {
    inspectOrRepairExistingTarget({
      target, cacheRoot, requestHash, maximumBytes, assertLock,
    });
    return Object.freeze({ published: false, existing: true });
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const temporary = path.join(
    cacheRoot,
    `${publishingStagePrefix(target, requestHash)}${ownerToken}-${process.pid}-${randomUUID()}`,
  );
  let descriptor;
  let temporaryIdentity = null;
  let linked = false;
  try {
    descriptor = fs.openSync(
      temporary,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
        | (fs.constants.O_NOFOLLOW || 0),
      0o600,
    );
    writeDescriptorFullySync(descriptor, serialized);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    const temporaryStat = fs.lstatSync(temporary);
    if (!secureCacheEntry(temporaryStat, maximumBytes)
      || fs.realpathSync(temporary) !== temporary) {
      throw new Error('agent_production_cache_publish_temporary_invalid');
    }
    temporaryIdentity = identity(temporaryStat);
    assertLock();
    try {
      fs.linkSync(temporary, target);
      linked = true;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      inspectOrRepairExistingTarget({
        target, cacheRoot, requestHash, maximumBytes, assertLock,
      });
      return Object.freeze({ published: false, existing: true });
    }
    fsyncDirectorySync(cacheRoot);
    fs.unlinkSync(temporary);
    const published = fs.lstatSync(target);
    if (!secureCacheEntry(published, maximumBytes)
      || !sameIdentity(temporaryIdentity, published)
      || fs.realpathSync(target) !== target) {
      throw new Error('agent_production_cache_publish_target_drifted');
    }
    fsyncDirectorySync(cacheRoot);
    assertLock();
    return Object.freeze({
      published: true,
      existing: false,
      bytes,
      identity: identity(published),
    });
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (!linked && fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}
