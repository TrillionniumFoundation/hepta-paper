import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { sameStableMaterializationEntryIdentity as sameStableEntryIdentity } from './scoped-file-materialization-recovery-record.mjs';
import {
  assertOpenedParentStillScoped,
  candidateFor,
  descriptorEntryPath,
  errorWithBlockers,
  inspectDescriptorRelativeRegularFile,
  inspectScopedRegularFileSync,
  normalizeScopedRelativePath,
  openVerifiedParentDirectory,
  unlinkOwnedDescriptorEntry,
  verifiedRoot,
  within,
} from './scoped-file-materialization-path-io.mjs';
import {
  acquireTargetLock,
  assertTargetLockOwned,
  releaseTargetLock,
} from './scoped-file-materialization-target-lock.mjs';
import {
  closeRecoveryVault,
  openScopeRecoveryVault,
} from './scoped-file-materialization-recovery-vault.mjs';
import {
  deletePreparedOperationRecord,
  findOperationRecord,
  readOperationRecord,
} from './scoped-file-materialization-operation-journal-repository.mjs';
import {
  closeRecoveryEntryDescriptor,
  restoreDescriptorRelativeBackup,
  restoreRecoveryEntry,
} from './scoped-file-materialization-recovery-entry-repository.mjs';

const RECOVERY_DIRECTORY_NAME = '.hepta-materialization-recovery';
const OPERATION_RECORD_PREFIX = '.operation-';

function operationRecordTargetSuffix(relative, status) {
  const digest = crypto.createHash('sha256').update(normalizeScopedRelativePath(relative)).digest('hex');
  return `-${digest}.${status}.json`;
}

export function exactStableIdentity(left, right) {
  return Boolean(left && right && sameStableEntryIdentity(left, right));
}

export function cleanupRecordedEntry(container, name, recordedIdentity, expected = null) {
  if (!name) return false;
  const current = inspectDescriptorRelativeRegularFile(container.descriptor, name, { allowedLinkCounts: [1, 2] });
  if (!current.exists) return false;
  if ((recordedIdentity && !exactStableIdentity(current.identity, recordedIdentity))
    || (expected && (current.hash !== expected.hash || current.bytes !== expected.bytes))) {
    throw errorWithBlockers('scoped_materialization_recovery_entry_changed', name);
  }
  return unlinkOwnedDescriptorEntry(container, name, current.identity);
}

function recoverCompletedPreparedOperation(vault, openedParent, intent, completion, current) {
  const record = intent.record;
  const binding = record.binding;
  if (completion.record.bindingHash !== record.bindingHash) {
    throw errorWithBlockers('scoped_materialization_operation_definition_conflict', binding.relative);
  }
  const exactPostimage = binding.operation === 'remove'
    ? !current.exists
    : current.exists
      && current.hash === binding.postimage.hash
      && current.bytes === binding.postimage.bytes
      && exactStableIdentity(current.identity, completion.record.completedPostimageIdentity);
  cleanupRecordedEntry(
    openedParent,
    record.localPreimageName,
    record.localPreimageIdentity,
    record.preimage,
  );
  cleanupRecordedEntry(vault, record.recoveryEntryName, record.recoveryEntryIdentity, record.preimage);
  cleanupRecordedEntry(openedParent, record.temporaryName, record.stagedPostimageIdentity, binding.postimage);
  deletePreparedOperationRecord(vault, intent);
  return Object.freeze({
    status: exactPostimage ? 'completed' : 'target_advanced',
    operation: binding.operation,
    operationId: binding.operationId,
    relative: binding.relative,
    preimageHash: binding.expectedPreimage.hash,
    postimageHash: binding.postimage.hash,
  });
}

function restorePreparedOperationPreimage(vault, openedParent, intent, current, backup, localBackup) {
  const record = intent.record;
  const binding = record.binding;
  const recoveryValid = backup.exists
    && backup.hash === record.preimage.hash
    && backup.bytes === record.preimage.bytes
    && exactStableIdentity(backup.identity, record.recoveryEntryIdentity);
  const localValid = localBackup.exists
    && localBackup.hash === record.preimage.hash
    && localBackup.bytes === record.preimage.bytes
    && exactStableIdentity(localBackup.identity, record.localPreimageIdentity);
  if (!recoveryValid && !localValid) {
    throw errorWithBlockers('scoped_materialization_recovery_preimage_missing', binding.relative);
  }
  const targetIsOriginal = current.exists
    && current.hash === record.preimage.hash
    && current.bytes === record.preimage.bytes
    && exactStableIdentity(current.identity, record.preimage.identity);
  const targetIsOwnedPost = current.exists
    && current.hash === binding.postimage.hash
    && current.bytes === binding.postimage.bytes
    && exactStableIdentity(current.identity, record.stagedPostimageIdentity);
  if (current.exists && !targetIsOriginal && !targetIsOwnedPost) {
    throw errorWithBlockers('scoped_materialization_recovery_target_conflict', binding.relative);
  }
  if (targetIsOwnedPost) unlinkOwnedDescriptorEntry(openedParent, record.targetName, current.identity);
  if (targetIsOriginal) {
    if (localValid) cleanupRecordedEntry(
      openedParent,
      record.localPreimageName,
      record.localPreimageIdentity,
      record.preimage,
    );
    cleanupRecordedEntry(vault, record.recoveryEntryName, record.recoveryEntryIdentity, record.preimage);
    return;
  }
  if (localValid) {
    const restored = restoreDescriptorRelativeBackup(openedParent, {
      targetName: record.targetName,
      backupName: record.localPreimageName,
      backupIdentity: localBackup.identity,
    });
    if (!restored) throw errorWithBlockers('scoped_materialization_preimage_restore_blocked', binding.relative);
    if (recoveryValid) cleanupRecordedEntry(vault, record.recoveryEntryName, record.recoveryEntryIdentity, record.preimage);
    return;
  }
  const entry = {
    name: record.recoveryEntryName,
    identity: backup.identity,
    snapshot: backup,
    descriptor: undefined,
    deleted: false,
    restored: false,
  };
  try {
    if (!restoreRecoveryEntry(openedParent, vault, { targetName: record.targetName, entry })) {
      throw errorWithBlockers('scoped_materialization_preimage_restore_blocked', binding.relative);
    }
  } finally {
    closeRecoveryEntryDescriptor(entry);
  }
}

export function recoverPreparedOperationUnderHeldLock(vault, openedParent, targetLock, intent) {
  const record = intent.record;
  const binding = record.binding;
  assertTargetLockOwned(openedParent, targetLock, record.targetName);
  const scope = openedParent.scope;
  if (binding.scopeRoot.realPath !== scope.realRoot
    || binding.scopeRoot.device !== scope.identity.device
    || binding.scopeRoot.inode !== scope.identity.inode
    || binding.scopeRoot.mode !== scope.identity.mode) {
    throw errorWithBlockers('scoped_materialization_recovery_root_changed', binding.relative);
  }
  if (openedParent.parentRelative !== binding.parentRelative
    || openedParent.identity.device !== binding.parentIdentity.device
    || openedParent.identity.inode !== binding.parentIdentity.inode
    || openedParent.identity.mode !== binding.parentIdentity.mode) {
    throw errorWithBlockers('scoped_materialization_recovery_parent_changed', binding.relative);
  }
  const current = inspectDescriptorRelativeRegularFile(openedParent.descriptor, record.targetName, { allowedLinkCounts: [1, 2] });
  const completion = findOperationRecord(vault, binding.operationId, 'completed', binding.relative);
  if (completion) return recoverCompletedPreparedOperation(vault, openedParent, intent, completion, current);
  const backup = record.recoveryEntryName
    ? inspectDescriptorRelativeRegularFile(vault.descriptor, record.recoveryEntryName)
    : Object.freeze({ exists: false, hash: null, bytes: 0, identity: null });
  const localBackup = record.localPreimageName
    ? inspectDescriptorRelativeRegularFile(openedParent.descriptor, record.localPreimageName)
    : Object.freeze({ exists: false, hash: null, bytes: 0, identity: null });
  if (binding.expectedPreimage.exists) {
    restorePreparedOperationPreimage(vault, openedParent, intent, current, backup, localBackup);
  } else {
    const targetIsOwnedPost = current.exists
      && current.hash === binding.postimage.hash
      && current.bytes === binding.postimage.bytes
      && exactStableIdentity(current.identity, record.stagedPostimageIdentity);
    if (current.exists && !targetIsOwnedPost) {
      throw errorWithBlockers('scoped_materialization_recovery_target_conflict', binding.relative);
    }
    if (targetIsOwnedPost) unlinkOwnedDescriptorEntry(openedParent, record.targetName, current.identity);
  }
  cleanupRecordedEntry(openedParent, record.temporaryName, record.stagedPostimageIdentity, binding.postimage);
  deletePreparedOperationRecord(vault, intent);
  return Object.freeze({
    status: 'rolled_back',
    operation: binding.operation,
    operationId: binding.operationId,
    relative: binding.relative,
    preimageHash: binding.expectedPreimage.hash,
    postimageHash: binding.postimage.hash,
  });
}

export function recoverTargetOperationsUnderHeldLock(openedParent, targetLock, relative, vault = null) {
  assertTargetLockOwned(openedParent, targetLock, path.basename(relative));
  const ownedVault = vault || openScopeRecoveryVault(openedParent.scope);
  const results = [];
  let failure = null;
  try {
    const suffix = operationRecordTargetSuffix(relative, 'prepared');
    const names = fs.readdirSync(descriptorEntryPath(ownedVault.descriptor, '.'))
      .filter((name) => name.startsWith(OPERATION_RECORD_PREFIX) && name.endsWith(suffix))
      .sort();
    for (const name of names) {
      const intent = readOperationRecord(ownedVault, name, 'prepared');
      results.push(recoverPreparedOperationUnderHeldLock(ownedVault, openedParent, targetLock, intent));
    }
  } catch (error) {
    failure = error;
  } finally {
    if (!vault) {
      try { closeRecoveryVault(ownedVault); } catch (error) { failure ||= error; }
    }
  }
  if (failure) throw failure;
  return Object.freeze(results);
}

export function recoverScopedMaterializationIntentsSync({ scopeRoot } = {}) {
  const scope = verifiedRoot(scopeRoot);
  const recoveryPath = path.join(scope.root, RECOVERY_DIRECTORY_NAME);
  try {
    const stat = fs.lstatSync(recoveryPath);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw errorWithBlockers('scoped_materialization_recovery_unsafe', RECOVERY_DIRECTORY_NAME);
    }
    const real = fs.realpathSync.native(recoveryPath);
    if (!within(scope.realRoot, real)) throw errorWithBlockers('scoped_materialization_recovery_unsafe', RECOVERY_DIRECTORY_NAME);
  } catch (error) {
    if (error?.code === 'ENOENT') return Object.freeze([]);
    throw error;
  }
  const vault = openScopeRecoveryVault(scope);
  const results = [];
  const failures = [];
  try {
    const names = fs.readdirSync(descriptorEntryPath(vault.descriptor, '.'))
      .filter((name) => name.startsWith(OPERATION_RECORD_PREFIX) && name.endsWith('.prepared.json'))
      .sort();
    const relatives = new Set();
    for (const name of names) {
      try { relatives.add(readOperationRecord(vault, name, 'prepared').record.binding.relative); }
      catch (error) { failures.push(error); }
    }
    for (const relative of relatives) {
      const target = candidateFor(scope.root, relative);
      let openedParent;
      let targetLock;
      try {
        openedParent = openVerifiedParentDirectory(scope.root, target.candidate);
        targetLock = acquireTargetLock(openedParent, path.basename(target.candidate), `recovery:${relative}:${crypto.randomUUID()}`);
        results.push(...recoverTargetOperationsUnderHeldLock(openedParent, targetLock, relative, vault));
      } catch (error) {
        if (error?.code === 'scoped_materialization_destination_locked') {
          results.push(Object.freeze({ status: 'active', relative }));
        } else failures.push(error);
      } finally {
        try { if (targetLock) releaseTargetLock(openedParent, targetLock, path.basename(target.candidate)); }
        catch (error) { failures.push(error); }
        try { if (openedParent) fs.closeSync(openedParent.descriptor); }
        catch (error) { failures.push(error); }
      }
    }
  } finally {
    try { closeRecoveryVault(vault); } catch (error) { failures.push(error); }
  }
  if (failures.length) {
    const error = failures[0];
    error.recoveryFailures = failures;
    throw error;
  }
  return Object.freeze(results);
}

export function inspectScopedRegularFileWithRecoverySync({ scopeRoot, relative } = {}) {
  const target = candidateFor(path.resolve(scopeRoot || '.'), relative);
  let openedParent;
  let targetLock;
  try {
    openedParent = openVerifiedParentDirectory(scopeRoot, target.candidate);
  } catch (error) {
    if (error?.code === 'ENOENT') return inspectScopedRegularFileSync({ scopeRoot, relative: target.relative });
    throw error;
  }
  const targetName = path.basename(target.candidate);
  try {
    targetLock = acquireTargetLock(
      openedParent,
      targetName,
      `recover-before-read:${target.relative}:${crypto.randomUUID()}`,
    );
    recoverTargetOperationsUnderHeldLock(openedParent, targetLock, target.relative);
    assertOpenedParentStillScoped(openedParent);
    return inspectScopedRegularFileSync({ scopeRoot, relative: target.relative });
  } finally {
    try { if (targetLock) releaseTargetLock(openedParent, targetLock, targetName); }
    finally { fs.closeSync(openedParent.descriptor); }
  }
}

export function completedReplaceAllowsExpectedPreimage(openedParent, targetLock, relative, expectedHash, current, providedVault = null) {
  const vault = providedVault || openScopeRecoveryVault(openedParent.scope);
  let failure = null;
  try {
    const completion = findOperationRecord(vault, targetLock.operationId, 'completed', relative);
    if (!completion) return false;
    const binding = completion.record.binding;
    if (binding.operation !== 'replace'
      || binding.expectedPreimage.exists !== (expectedHash !== null)
      || binding.expectedPreimage.hash !== expectedHash) {
      throw errorWithBlockers('scoped_materialization_operation_definition_conflict', relative);
    }
    if (!current.exists
      || current.hash !== binding.postimage.hash
      || current.bytes !== binding.postimage.bytes
      || !exactStableIdentity(current.identity, completion.record.completedPostimageIdentity)) {
      throw errorWithBlockers('scoped_materialization_operation_target_advanced', relative);
    }
    return true;
  } catch (error) {
    failure = error;
  } finally {
    if (!providedVault) {
      try { closeRecoveryVault(vault); } catch (error) { failure ||= error; }
    }
  }
  if (failure) throw failure;
  return false;
}
