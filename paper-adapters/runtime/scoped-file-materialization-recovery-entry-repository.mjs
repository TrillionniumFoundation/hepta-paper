import crypto from 'node:crypto';
import fs from 'node:fs';
import {
  materializationIdentityFromStat as identityFromStat,
  sameStableMaterializationEntryIdentity as sameStableEntryIdentity,
  scopedMaterializationRecoveryEntryName,
} from './scoped-file-materialization-recovery-record.mjs';
import {
  COPY_BUFFER_BYTES,
  descriptorEntryPath,
  errorWithBlockers,
  inspectDescriptorRelativeEntryIdentity,
  inspectDescriptorRelativeRegularFile,
  unlinkOwnedDescriptorEntry,
  writeDescriptorFully,
} from './scoped-file-materialization-path-io.mjs';
import { assertRecoveryVaultStillScoped } from './scoped-file-materialization-recovery-vault.mjs';

export function restoreDescriptorRelativeBackup(openedParent, {
  targetName,
  backupName,
  backupIdentity,
  stagedIdentity = null,
} = {}) {
  let target = inspectDescriptorRelativeEntryIdentity(openedParent.descriptor, targetName);
  if (target.exists && stagedIdentity && sameStableEntryIdentity(target.identity, stagedIdentity)) {
    unlinkOwnedDescriptorEntry(openedParent, targetName, target.identity, { sync: false });
    target = inspectDescriptorRelativeEntryIdentity(openedParent.descriptor, targetName);
  }
  if (target.exists) return false;
  const backup = inspectDescriptorRelativeEntryIdentity(openedParent.descriptor, backupName);
  if (!backup.exists || !sameStableEntryIdentity(backup.identity, backupIdentity)) return false;
  fs.linkSync(
    descriptorEntryPath(openedParent.descriptor, backupName),
    descriptorEntryPath(openedParent.descriptor, targetName),
  );
  unlinkOwnedDescriptorEntry(openedParent, backupName, backup.identity, { sync: false });
  fs.fsyncSync(openedParent.descriptor);
  return true;
}

export function recoveryEntryName(targetName, operationId, suffix, relative = targetName) {
  return scopedMaterializationRecoveryEntryName(relative, operationId, suffix);
}

export function moveDescriptorEntryToRecovery(openedParent, vault, {
  sourceName,
  targetName,
  operationId,
  relative,
  suffix,
  expectedSnapshot,
} = {}) {
  assertRecoveryVaultStillScoped(vault);
  const name = recoveryEntryName(targetName, operationId, suffix, relative);
  const existing = inspectDescriptorRelativeRegularFile(vault.descriptor, name);
  if (existing.exists) {
    if (existing.hash !== expectedSnapshot.hash || existing.bytes !== expectedSnapshot.bytes) {
      throw errorWithBlockers('scoped_materialization_recovery_entry_conflict', relative);
    }
    return {
      name,
      identity: existing.identity,
      snapshot: existing,
      descriptor: undefined,
      deleted: false,
      restored: false,
    };
  }
  const sourcePath = descriptorEntryPath(openedParent.descriptor, sourceName);
  const destinationPath = descriptorEntryPath(vault.descriptor, name);
  let sourceDescriptor;
  let outputDescriptor;
  let outputIdentity;
  const digest = crypto.createHash('sha256');
  const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
  let bytes = 0;
  try {
    sourceDescriptor = fs.openSync(sourcePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const sourceBefore = fs.fstatSync(sourceDescriptor, { bigint: true });
    if (!sourceBefore.isFile() || !sameStableEntryIdentity(expectedSnapshot.identity, identityFromStat(sourceBefore))) {
      throw errorWithBlockers('scoped_materialization_preimage_conflict', relative);
    }
    outputDescriptor = fs.openSync(
      destinationPath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0),
      Number(sourceBefore.mode & 0o777n),
    );
    outputIdentity = identityFromStat(fs.fstatSync(outputDescriptor, { bigint: true }));
    let count;
    do {
      count = fs.readSync(sourceDescriptor, buffer, 0, buffer.length, bytes);
      if (count) {
        writeDescriptorFully(outputDescriptor, buffer, count);
        digest.update(buffer.subarray(0, count));
        bytes += count;
      }
    } while (count);
    fs.fchmodSync(outputDescriptor, Number(sourceBefore.mode & 0o777n));
    fs.fsyncSync(outputDescriptor);
    outputIdentity = identityFromStat(fs.fstatSync(outputDescriptor, { bigint: true }));
    const sourceAfter = fs.fstatSync(sourceDescriptor, { bigint: true });
    if (!sameStableEntryIdentity(expectedSnapshot.identity, identityFromStat(sourceAfter))
      || `sha256:${digest.digest('hex')}` !== expectedSnapshot.hash
      || bytes !== expectedSnapshot.bytes) {
      throw errorWithBlockers('scoped_materialization_recovery_entry_mismatch', relative);
    }
    fs.fsyncSync(vault.descriptor);
  } catch (error) {
    try { if (outputIdentity) unlinkOwnedDescriptorEntry(vault, name, outputIdentity); } catch {}
    throw error;
  } finally {
    if (sourceDescriptor !== undefined) fs.closeSync(sourceDescriptor);
    if (outputDescriptor !== undefined) fs.closeSync(outputDescriptor);
  }
  const snapshot = inspectDescriptorRelativeRegularFile(vault.descriptor, name);
  if (snapshot.hash !== expectedSnapshot.hash || snapshot.bytes !== expectedSnapshot.bytes) {
    throw errorWithBlockers('scoped_materialization_recovery_entry_mismatch', relative);
  }
  const entry = {
    name,
    identity: snapshot.identity,
    snapshot,
    descriptor: undefined,
    deleted: false,
    restored: false,
  };
  assertRecoveryVaultStillScoped(vault);
  return entry;
}

function openRecoveryRollbackDescriptor(vault, entry) {
  const candidate = descriptorEntryPath(vault.descriptor, entry.name);
  const descriptor = fs.openSync(candidate, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const stat = fs.fstatSync(descriptor, { bigint: true });
    if (!stat.isFile() || Number(stat.nlink) !== 1 || !sameStableEntryIdentity(entry.identity, identityFromStat(stat))) {
      throw errorWithBlockers('scoped_materialization_recovery_entry_changed', entry.name);
    }
    entry.descriptor = descriptor;
    return descriptor;
  } catch (error) {
    fs.closeSync(descriptor);
    throw error;
  }
}

function restoreDeletedRecoveryDescriptor(openedParent, targetName, entry) {
  if (!entry?.descriptor) return false;
  if (inspectDescriptorRelativeEntryIdentity(openedParent.descriptor, targetName).exists) return false;
  const sourceBefore = fs.fstatSync(entry.descriptor, { bigint: true });
  if (!sourceBefore.isFile() || !sameStableEntryIdentity(entry.identity, identityFromStat(sourceBefore))) return false;
  const targetPath = descriptorEntryPath(openedParent.descriptor, targetName);
  let outputDescriptor;
  let outputIdentity;
  const digest = crypto.createHash('sha256');
  const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
  let bytes = 0;
  try {
    outputDescriptor = fs.openSync(
      targetPath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0),
      Number(sourceBefore.mode & 0o777n),
    );
    outputIdentity = identityFromStat(fs.fstatSync(outputDescriptor, { bigint: true }));
    let count;
    do {
      count = fs.readSync(entry.descriptor, buffer, 0, buffer.length, bytes);
      if (count) {
        writeDescriptorFully(outputDescriptor, buffer, count);
        digest.update(buffer.subarray(0, count));
        bytes += count;
      }
    } while (count);
    fs.fchmodSync(outputDescriptor, Number(sourceBefore.mode & 0o777n));
    fs.fsyncSync(outputDescriptor);
    outputIdentity = identityFromStat(fs.fstatSync(outputDescriptor, { bigint: true }));
    fs.closeSync(outputDescriptor);
    outputDescriptor = undefined;
    const sourceAfter = fs.fstatSync(entry.descriptor, { bigint: true });
    const hash = `sha256:${digest.digest('hex')}`;
    if (!sameStableEntryIdentity(entry.identity, identityFromStat(sourceAfter))
      || hash !== entry.snapshot.hash
      || bytes !== entry.snapshot.bytes) {
      throw errorWithBlockers('scoped_materialization_recovery_restore_mismatch', targetName);
    }
    fs.fsyncSync(openedParent.descriptor);
    const restored = inspectDescriptorRelativeRegularFile(openedParent.descriptor, targetName);
    if (restored.hash !== entry.snapshot.hash || restored.bytes !== entry.snapshot.bytes) {
      throw errorWithBlockers('scoped_materialization_recovery_restore_mismatch', targetName);
    }
    entry.restored = true;
    return true;
  } catch (error) {
    try { if (outputDescriptor !== undefined) fs.closeSync(outputDescriptor); } catch {}
    try { if (outputIdentity) unlinkOwnedDescriptorEntry(openedParent, targetName, outputIdentity); } catch {}
    throw error;
  }
}

export function restoreRecoveryEntry(openedParent, vault, {
  targetName,
  entry,
  stagedIdentity = null,
} = {}) {
  let target = inspectDescriptorRelativeEntryIdentity(openedParent.descriptor, targetName);
  if (target.exists && stagedIdentity && sameStableEntryIdentity(target.identity, stagedIdentity)) {
    unlinkOwnedDescriptorEntry(openedParent, targetName, target.identity, { sync: false });
    target = inspectDescriptorRelativeEntryIdentity(openedParent.descriptor, targetName);
  }
  if (target.exists) return false;
  if (entry.deleted) return restoreDeletedRecoveryDescriptor(openedParent, targetName, entry);
  const recovery = inspectDescriptorRelativeRegularFile(vault.descriptor, entry.name);
  if (recovery.hash !== entry.snapshot.hash || recovery.bytes !== entry.snapshot.bytes) return false;
  openRecoveryRollbackDescriptor(vault, entry);
  const restored = restoreDeletedRecoveryDescriptor(openedParent, targetName, entry);
  if (!restored) return false;
  unlinkOwnedDescriptorEntry(vault, entry.name, entry.identity, { sync: false });
  fs.fsyncSync(vault.descriptor);
  entry.deleted = true;
  entry.restored = true;
  return true;
}

export function closeRecoveryEntryDescriptor(entry) {
  if (!entry?.descriptor) return;
  fs.closeSync(entry.descriptor);
  entry.descriptor = undefined;
}

export function installDescriptorRelativeWithoutOverwrite(openedParent, temporaryName, targetName, temporaryIdentity) {
  try {
    fs.linkSync(
      descriptorEntryPath(openedParent.descriptor, temporaryName),
      descriptorEntryPath(openedParent.descriptor, targetName),
    );
  } catch (error) {
    if (error?.code === 'EEXIST') throw errorWithBlockers('scoped_materialization_preimage_conflict', targetName);
    throw error;
  }
  const installed = inspectDescriptorRelativeEntryIdentity(openedParent.descriptor, targetName);
  if (!installed.exists || !sameStableEntryIdentity(installed.identity, temporaryIdentity)) {
    throw errorWithBlockers('scoped_materialization_postimage_mismatch', targetName);
  }
  return installed.identity;
}
