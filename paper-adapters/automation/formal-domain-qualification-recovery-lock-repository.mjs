import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  currentProcessIdentity,
  processIdentityIsStale,
} from '../../workflow-kernel/runtime/process-identity.mjs';
import {
  formalDomainQualificationFileIdentity,
  formalDomainQualificationPrivateDirectory,
  formalDomainQualificationPrivateRegularFile,
  fsyncFormalDomainQualificationDirectory,
  readPinnedFormalDomainQualificationPrivateFile,
} from './formal-domain-qualification-recovery-filesystem-repository.mjs';

function lockOwner(lockPath) {
  let lockStat;
  try { lockStat = fs.lstatSync(lockPath, { bigint: true }); }
  catch {
    throw new Error('formal_domain_qualification_recovery_lock_invalid');
  }
  if (!formalDomainQualificationPrivateDirectory(lockPath, lockStat)) {
    throw new Error('formal_domain_qualification_recovery_lock_invalid');
  }
  const entries = fs.readdirSync(lockPath, { withFileTypes: true });
  if (entries.length !== 1 || !entries[0].isFile()
    || entries[0].isSymbolicLink()) {
    throw new Error('formal_domain_qualification_recovery_lock_invalid');
  }
  const match = entries[0].name.match(/^owner-([0-9a-f-]{36})\.json$/);
  if (!match) {
    throw new Error('formal_domain_qualification_recovery_lock_invalid');
  }
  const ownerPath = path.join(lockPath, entries[0].name);
  const read = readPinnedFormalDomainQualificationPrivateFile({
    candidate: ownerPath,
    maximumBytes: 16 * 1024,
    invalidCode: 'formal_domain_qualification_recovery_lock_invalid',
  });
  let owner;
  try { owner = JSON.parse(read.source); }
  catch {
    throw new Error('formal_domain_qualification_recovery_lock_invalid');
  }
  if (read.source !== `${JSON.stringify(owner)}\n`) {
    throw new Error('formal_domain_qualification_recovery_lock_invalid');
  }
  if (owner?.version !== 1
    || owner?.kind !== 'FormalDomainQualificationRecoveryJournalLock'
    || owner?.token !== match[1]
    || !Number.isSafeInteger(owner?.pid) || owner.pid <= 0
    || (owner.pidStartTime !== null
      && !/^\d+$/.test(String(owner.pidStartTime || '')))) {
    throw new Error('formal_domain_qualification_recovery_lock_invalid');
  }
  let observedLockPath;
  try { observedLockPath = fs.lstatSync(lockPath, { bigint: true }); }
  catch {
    throw new Error('formal_domain_qualification_recovery_lock_invalid');
  }
  if (!formalDomainQualificationPrivateDirectory(
    lockPath,
    observedLockPath,
  ) || JSON.stringify(formalDomainQualificationFileIdentity(lockStat))
    !== JSON.stringify(formalDomainQualificationFileIdentity(
      observedLockPath,
    ))) {
    throw new Error('formal_domain_qualification_recovery_lock_invalid');
  }
  return Object.freeze({
    owner,
    ownerPath,
    ownerIdentity: read.identity,
  });
}

function removeLock(lockPath, ownerPath, expectedIdentity) {
  let observed;
  try {
    observed = fs.lstatSync(ownerPath, { bigint: true });
  } catch {
    throw new Error('formal_domain_qualification_recovery_lock_lost');
  }
  if (!formalDomainQualificationPrivateRegularFile(observed)
    || JSON.stringify(formalDomainQualificationFileIdentity(observed))
      !== JSON.stringify(expectedIdentity)) {
    throw new Error('formal_domain_qualification_recovery_lock_lost');
  }
  fs.unlinkSync(ownerPath);
  fs.rmdirSync(lockPath);
}

function createLockCandidate({
  directory,
  segment,
  identity,
  token,
  temporaryPath,
}) {
  const ownerName = `owner-${token}.json`;
  const temporaryOwnerPath = path.join(temporaryPath, ownerName);
  fs.mkdirSync(temporaryPath, { mode: 0o700 });
  const descriptor = fs.openSync(
    temporaryOwnerPath,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
      | (fs.constants.O_NOFOLLOW || 0),
    0o600,
  );
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify({
      version: 1,
      kind: 'FormalDomainQualificationRecoveryJournalLock',
      token,
      pid: identity.pid,
      pidStartTime: identity.pidStartTime,
      acquiredAt: new Date().toISOString(),
    })}\n`);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fsyncFormalDomainQualificationDirectory(temporaryPath);
  const lockPath = path.join(directory, `${segment}.lock`);
  fs.renameSync(temporaryPath, lockPath);
  fsyncFormalDomainQualificationDirectory(directory);
  return Object.freeze({ lockPath, ownerName });
}

function ownedLock({ directory, lockPath, ownerName, token, identity }) {
  return Object.freeze({
    assertOwned() {
      const current = lockOwner(lockPath);
      if (current.owner.token !== token
        || current.owner.pid !== identity.pid
        || current.owner.pidStartTime !== identity.pidStartTime) {
        throw new Error('formal_domain_qualification_recovery_lock_lost');
      }
    },
    release() {
      const current = lockOwner(lockPath);
      if (current.owner.token !== token
        || current.owner.pid !== identity.pid
        || current.owner.pidStartTime !== identity.pidStartTime) return false;
      removeLock(
        lockPath,
        path.join(lockPath, ownerName),
        current.ownerIdentity,
      );
      fsyncFormalDomainQualificationDirectory(directory);
      return true;
    },
  });
}

export function acquireFormalDomainQualificationRecoveryLock(
  directory,
  segment,
) {
  const lockPath = path.join(directory, `${segment}.lock`);
  const identity = currentProcessIdentity();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const token = crypto.randomUUID();
    const temporaryPath = path.join(directory, `.${segment}.${token}.lock.tmp`);
    try {
      const candidate = createLockCandidate({
        directory,
        segment,
        identity,
        token,
        temporaryPath,
      });
      return ownedLock({
        directory,
        lockPath: candidate.lockPath,
        ownerName: candidate.ownerName,
        token,
        identity,
      });
    } catch (error) {
      try { fs.rmSync(temporaryPath, { recursive: true, force: true }); }
      catch { /* unique staging is harmless */ }
      if (!['EEXIST', 'ENOTEMPTY', 'ENOTDIR', 'EISDIR'].includes(error?.code)) {
        throw error;
      }
      const existing = lockOwner(lockPath);
      if (!processIdentityIsStale(existing.owner)) {
        throw new Error('formal_domain_qualification_recovery_in_progress');
      }
      removeLock(lockPath, existing.ownerPath, existing.ownerIdentity);
      fsyncFormalDomainQualificationDirectory(directory);
    }
  }
  throw new Error('formal_domain_qualification_recovery_in_progress');
}
