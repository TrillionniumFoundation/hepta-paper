import crypto from 'node:crypto';
import fs from 'node:fs';
import {
  currentMaterializationLockOwnerIdentity as currentLockOwnerIdentity,
  materializationIdentityFromStat as identityFromStat,
  materializationLockOwnerIsStale as lockOwnerIsStale,
  normalizeScopedMaterializationOperationId,
  readMaterializationTargetLockRecordSync,
  sameMaterializationEntryIdentity as sameEntryIdentity,
  sameStableMaterializationEntryIdentity as sameStableEntryIdentity,
  scopedMaterializationOperationKey,
} from './scoped-file-materialization-recovery-record.mjs';
import {
  descriptorEntryPath,
  errorWithBlockers,
  inspectDescriptorRelativeEntryIdentity,
  targetLockName,
  unlinkOwnedDescriptorEntry,
  writeDescriptorFully,
} from './scoped-file-materialization-path-io.mjs';

const LOCK_RECORD_MAX_BYTES = 4096;
const ACTIVE_TARGET_LOCKS = new Set();

export function ownerRecordIsOrphan(owner, active = false) {
  const current = currentLockOwnerIdentity();
  if (Number(owner?.pid) === current.pid
    && (!owner?.pidStartTime || owner.pidStartTime === current.pidStartTime)) return !active;
  return lockOwnerIsStale(owner || {});
}
function readTargetLockRecord(openedParent, name) {
  return readMaterializationTargetLockRecordSync({
    candidate: descriptorEntryPath(openedParent.descriptor, name),
    name,
    maximumBytes: LOCK_RECORD_MAX_BYTES,
  });
}

function targetLockActiveKey(openedParent, name, token, ownerEntryName = '') {
  return `${openedParent.identity.device}:${openedParent.identity.inode}:${name}:${token}:${ownerEntryName}`;
}

function reclaimStaleTargetLock(openedParent, targetName) {
  const name = targetLockName(targetName);
  const first = readTargetLockRecord(openedParent, name);
  const activeKey = targetLockActiveKey(openedParent, name, first.record.token, first.record.ownerEntryName);
  if (!ownerRecordIsOrphan(first.record.owner, ACTIVE_TARGET_LOCKS.has(activeKey))) {
    return Object.freeze({ reclaimed: false, temporaryRemoved: false });
  }
  const confirmed = readTargetLockRecord(openedParent, name);
  if (!sameStableEntryIdentity(first.identity, confirmed.identity)
    || first.raw !== confirmed.raw
    || !ownerRecordIsOrphan(confirmed.record.owner, ACTIVE_TARGET_LOCKS.has(activeKey))) {
    return Object.freeze({ reclaimed: false, temporaryRemoved: false });
  }
  const ownerEntry = confirmed.record.ownerEntryName
    ? inspectDescriptorRelativeEntryIdentity(openedParent.descriptor, confirmed.record.ownerEntryName)
    : { exists: false, identity: null };
  if (!ownerEntry.exists || !sameEntryIdentity(ownerEntry.identity, confirmed.identity)) {
    return Object.freeze({ reclaimed: false, temporaryRemoved: false });
  }
  const temporaryName = confirmed.record.stageEntryName;
  let temporaryRemoved = false;
  try {
    if (!temporaryName || !confirmed.record.temporaryEntryIdentity) throw new Error('unbound_stage');
    const temporary = inspectDescriptorRelativeEntryIdentity(openedParent.descriptor, temporaryName);
    if (temporary.exists
      && Number(temporary.identity.linkCount) === 1
      && sameEntryIdentity(temporary.identity, confirmed.record.temporaryEntryIdentity)) {
      temporaryRemoved = unlinkOwnedDescriptorEntry(openedParent, temporaryName, temporary.identity, { sync: false });
    }
  } catch {
    // An unsafe or independently replaced temp is never deleted by stale-lock recovery.
  }
  unlinkOwnedDescriptorEntry(openedParent, name, confirmed.identity, { sync: false });
  fs.fsyncSync(openedParent.descriptor);
  unlinkOwnedDescriptorEntry(openedParent, confirmed.record.ownerEntryName, ownerEntry.identity, { sync: false });
  fs.fsyncSync(openedParent.descriptor);
  return Object.freeze({ reclaimed: true, temporaryRemoved });
}

function cleanupOrphanTargetLockOwners(openedParent, targetName) {
  let temporaryRemoved = false;
  const prefix = `.${targetName}.hepta-lock-owner-`;
  for (const name of fs.readdirSync(descriptorEntryPath(openedParent.descriptor, '.')).filter((entry) => entry.startsWith(prefix))) {
    let owner;
    try { owner = readTargetLockRecord(openedParent, name); }
    catch { continue; }
    const activeKey = targetLockActiveKey(
      openedParent,
      targetLockName(targetName),
      owner.record.token,
      owner.record.ownerEntryName,
    );
    if (!ownerRecordIsOrphan(owner.record.owner, ACTIVE_TARGET_LOCKS.has(activeKey))) continue;
    const canonical = inspectDescriptorRelativeEntryIdentity(openedParent.descriptor, targetLockName(targetName));
    if (canonical.exists && sameEntryIdentity(canonical.identity, owner.identity)) continue;
    if (owner.record.stageEntryName && owner.record.temporaryEntryIdentity) {
      const staged = inspectDescriptorRelativeEntryIdentity(openedParent.descriptor, owner.record.stageEntryName);
      if (staged.exists && Number(staged.identity.linkCount) === 1
        && sameEntryIdentity(staged.identity, owner.record.temporaryEntryIdentity)) {
        temporaryRemoved = unlinkOwnedDescriptorEntry(
          openedParent,
          owner.record.stageEntryName,
          staged.identity,
          { sync: false },
        ) || temporaryRemoved;
      }
    }
    unlinkOwnedDescriptorEntry(openedParent, name, owner.identity, { sync: false });
  }
  const publishPrefix = `.${targetName}.hepta-lock-publish-`;
  for (const name of fs.readdirSync(descriptorEntryPath(openedParent.descriptor, '.'))
    .filter((entry) => entry.startsWith(publishPrefix))) {
    let pending;
    try { pending = readTargetLockRecord(openedParent, name); }
    catch { continue; }
    const activeKey = targetLockActiveKey(
      openedParent,
      targetLockName(targetName),
      pending.record.token,
      pending.record.ownerEntryName,
    );
    if (!ownerRecordIsOrphan(pending.record.owner, ACTIVE_TARGET_LOCKS.has(activeKey))) continue;
    unlinkOwnedDescriptorEntry(openedParent, name, pending.identity, { sync: false });
  }
  fs.fsyncSync(openedParent.descriptor);
  return temporaryRemoved;
}

export function acquireTargetLock(openedParent, targetName, operationId = crypto.randomUUID()) {
  const name = targetLockName(targetName);
  const rawOperationId = normalizeScopedMaterializationOperationId(operationId);
  const token = scopedMaterializationOperationKey(rawOperationId);
  let recoveredStaleTemporary = cleanupOrphanTargetLockOwners(openedParent, targetName);
  for (let acquisitionAttempt = 0; acquisitionAttempt < 2; acquisitionAttempt += 1) {
    let descriptor;
    let identity;
    let lockLinked = false;
    let activeKey;
    const owner = currentLockOwnerIdentity();
    const ownerStart = String(owner.pidStartTime || 'unknown').replace(/[^A-Za-z0-9_.-]/g, '_');
    const ownerEntryName = `.${targetName}.hepta-lock-owner-${owner.pid}-${ownerStart}-${token}-${crypto.randomUUID()}.json`;
    const stageEntryName = `.${targetName}.hepta-${token}.tmp`;
    try {
      descriptor = fs.openSync(
        descriptorEntryPath(openedParent.descriptor, ownerEntryName),
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0),
        0o600,
      );
      const stat = fs.fstatSync(descriptor, { bigint: true });
      if (!stat.isFile() || Number(stat.nlink) !== 1) throw new Error('scoped_materialization_lock_not_regular');
      identity = identityFromStat(stat);
      const payload = Buffer.from(`${JSON.stringify({
        version: 4,
        token,
        operationId: rawOperationId,
        owner,
        ownerEntryName,
        stageEntryName,
        temporaryEntryIdentity: null,
        temporaryIdentity: null,
      })}\n`);
      writeDescriptorFully(descriptor, payload, payload.length);
      fs.fsyncSync(descriptor);
      identity = identityFromStat(fs.fstatSync(descriptor, { bigint: true }));
      activeKey = targetLockActiveKey(openedParent, name, token, ownerEntryName);
      ACTIVE_TARGET_LOCKS.add(activeKey);
      fs.linkSync(
        descriptorEntryPath(openedParent.descriptor, ownerEntryName),
        descriptorEntryPath(openedParent.descriptor, name),
      );
      lockLinked = true;
      fs.fsyncSync(openedParent.descriptor);
      identity = identityFromStat(fs.fstatSync(descriptor, { bigint: true }));
      fs.fsyncSync(openedParent.descriptor);
      return {
        name,
        token,
        operationId: rawOperationId,
        descriptor,
        identity,
        owner,
        ownerEntryName,
        stageEntryName,
        temporaryEntryIdentity: null,
        temporaryIdentity: null,
        activeKey,
        closed: false,
        recoveredStaleTemporary,
      };
    } catch (error) {
      if (activeKey) ACTIVE_TARGET_LOCKS.delete(activeKey);
      if (identity) {
        try { if (lockLinked) unlinkOwnedDescriptorEntry(openedParent, name, identity, { sync: false }); } catch {}
        try { unlinkOwnedDescriptorEntry(openedParent, ownerEntryName, identity); } catch {}
      }
      if (descriptor !== undefined) {
        try { fs.closeSync(descriptor); } catch {}
      }
      if (error?.code !== 'EEXIST') throw error;
      let recovery;
      try {
        recovery = reclaimStaleTargetLock(openedParent, targetName);
      } catch {
        throw errorWithBlockers('scoped_materialization_destination_locked', targetName);
      }
      if (!recovery.reclaimed) throw errorWithBlockers('scoped_materialization_destination_locked', targetName);
      recoveredStaleTemporary ||= recovery.temporaryRemoved;
    }
  }
  throw errorWithBlockers('scoped_materialization_destination_locked', targetName);
}

export function bindTargetLockTemporary(openedParent, lock, targetName, temporaryEntryIdentity, temporaryIdentity = null) {
  assertTargetLockOwned(openedParent, lock, targetName);
  const temporary = inspectDescriptorRelativeEntryIdentity(openedParent.descriptor, lock.stageEntryName);
  if (!temporary.exists || Number(temporary.identity.linkCount) !== 1
    || !sameEntryIdentity(temporary.identity, temporaryEntryIdentity)
    || (lock.temporaryEntryIdentity && !sameEntryIdentity(lock.temporaryEntryIdentity, temporary.identity))
    || (temporaryIdentity && !sameStableEntryIdentity(temporary.identity, temporaryIdentity))) {
    throw errorWithBlockers('scoped_materialization_staged_file_changed', targetName);
  }
  const oldDescriptor = lock.descriptor;
  const oldIdentity = lock.identity;
  const oldOwnerEntryName = lock.ownerEntryName;
  const ownerStart = String(lock.owner.pidStartTime || 'unknown').replace(/[^A-Za-z0-9_.-]/g, '_');
  const ownerEntryName = `.${targetName}.hepta-lock-owner-${lock.owner.pid}-${ownerStart}-${lock.token}-${crypto.randomUUID()}.json`;
  const pendingName = `.${targetName}.hepta-lock-publish-${lock.token}-${crypto.randomUUID()}`;
  let descriptor;
  let identity;
  let pendingLinked = false;
  let canonicalPublished = false;
  try {
    descriptor = fs.openSync(
      descriptorEntryPath(openedParent.descriptor, ownerEntryName),
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0),
      0o600,
    );
    const payload = Buffer.from(`${JSON.stringify({
      version: temporaryIdentity ? 6 : 5,
      token: lock.token,
      operationId: lock.operationId,
      owner: lock.owner,
      ownerEntryName,
      stageEntryName: lock.stageEntryName,
      temporaryEntryIdentity,
      temporaryIdentity,
    })}\n`);
    writeDescriptorFully(descriptor, payload, payload.length);
    fs.fsyncSync(descriptor);
    identity = identityFromStat(fs.fstatSync(descriptor, { bigint: true }));
    // Persist both the temp directory entry and its immutable inode-owner record
    // before publishing a replacement canonical lock.
    fs.fsyncSync(openedParent.descriptor);
    fs.linkSync(
      descriptorEntryPath(openedParent.descriptor, ownerEntryName),
      descriptorEntryPath(openedParent.descriptor, pendingName),
    );
    pendingLinked = true;
    fs.fsyncSync(openedParent.descriptor);
    // This is the repository-owned atomic publication point for the canonical
    // descriptor-scoped lock; architecture tests bind the exception to these
    // two verified directory entries and forbid any additional direct writes.
    fs.renameSync(
      descriptorEntryPath(openedParent.descriptor, pendingName),
      descriptorEntryPath(openedParent.descriptor, lock.name),
    );
    pendingLinked = false;
    canonicalPublished = true;
    fs.fsyncSync(openedParent.descriptor);
    identity = identityFromStat(fs.fstatSync(descriptor, { bigint: true }));
    const published = readTargetLockRecord(openedParent, lock.name);
    if (!sameEntryIdentity(published.identity, identity)
      || published.record.ownerEntryName !== ownerEntryName
      || !sameEntryIdentity(published.record.temporaryEntryIdentity, temporaryEntryIdentity)
      || (temporaryIdentity && !sameStableEntryIdentity(published.record.temporaryIdentity, temporaryIdentity))) {
      throw errorWithBlockers('scoped_materialization_destination_lock_changed', targetName);
    }
    lock.descriptor = descriptor;
    lock.identity = identity;
    lock.ownerEntryName = ownerEntryName;
    lock.temporaryEntryIdentity = temporaryEntryIdentity;
    lock.temporaryIdentity = temporaryIdentity;
    const oldActiveKey = lock.activeKey;
    lock.activeKey = targetLockActiveKey(openedParent, lock.name, lock.token, ownerEntryName);
    ACTIVE_TARGET_LOCKS.add(lock.activeKey);
    ACTIVE_TARGET_LOCKS.delete(oldActiveKey);
    descriptor = undefined;
    fs.closeSync(oldDescriptor);
    unlinkOwnedDescriptorEntry(openedParent, oldOwnerEntryName, oldIdentity, { sync: false });
    fs.fsyncSync(openedParent.descriptor);
  } catch (error) {
    if (!canonicalPublished && identity) {
      try {
        const canonical = inspectDescriptorRelativeEntryIdentity(openedParent.descriptor, lock.name);
        if (canonical.exists && sameEntryIdentity(canonical.identity, identity)) {
          canonicalPublished = true;
          pendingLinked = false;
        }
      } catch {
        // Preserve both candidates when publication state cannot be proved.
      }
    }
    if (!canonicalPublished) {
      try {
        if (pendingLinked) unlinkOwnedDescriptorEntry(openedParent, pendingName, identity, { sync: false });
        if (identity) unlinkOwnedDescriptorEntry(openedParent, ownerEntryName, identity);
      } catch {}
    }
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch {}
    }
    throw error;
  }
}

export function assertTargetLockOwned(openedParent, lock, targetName) {
  if (!lock || lock.closed) throw new Error('scoped_materialization_stage_lock_invalid');
  const descriptorIdentity = identityFromStat(fs.fstatSync(lock.descriptor, { bigint: true }));
  const current = inspectDescriptorRelativeEntryIdentity(openedParent.descriptor, lock.name);
  if (!current.exists || !sameEntryIdentity(lock.identity, descriptorIdentity) || !sameEntryIdentity(lock.identity, current.identity)) {
    throw errorWithBlockers('scoped_materialization_destination_lock_changed', targetName);
  }
}

export function releaseTargetLock(openedParent, lock, targetName) {
  if (!lock || lock.closed) return;
  try {
    assertTargetLockOwned(openedParent, lock, targetName);
    unlinkOwnedDescriptorEntry(openedParent, lock.name, lock.identity, { sync: false });
    fs.fsyncSync(openedParent.descriptor);
    unlinkOwnedDescriptorEntry(openedParent, lock.ownerEntryName, lock.identity, { sync: false });
    fs.fsyncSync(openedParent.descriptor);
  } finally {
    ACTIVE_TARGET_LOCKS.delete(lock.activeKey);
    try {
      fs.closeSync(lock.descriptor);
    } finally {
      lock.closed = true;
    }
  }
}

export function cleanupTargetLockOwnedTemporary(openedParent, lock, targetName) {
  if (!lock?.temporaryEntryIdentity || !lock?.stageEntryName || lock.closed) return false;
  assertTargetLockOwned(openedParent, lock, targetName);
  const current = inspectDescriptorRelativeEntryIdentity(openedParent.descriptor, lock.stageEntryName);
  if (!current.exists) return false;
  if (Number(current.identity.linkCount) !== 1
    || !sameEntryIdentity(current.identity, lock.temporaryEntryIdentity)) {
    throw errorWithBlockers('scoped_materialization_owned_entry_changed', lock.stageEntryName);
  }
  return unlinkOwnedDescriptorEntry(openedParent, lock.stageEntryName, current.identity);
}
