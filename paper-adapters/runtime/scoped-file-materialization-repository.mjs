import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  materializationIdentityFromStat as identityFromStat,
  normalizeScopedMaterializationOperationId,
  sameStableMaterializationEntryIdentity as sameStableEntryIdentity,
  scopedMaterializationRecoveryEntryName,
} from './scoped-file-materialization-recovery-record.mjs';
import {
  COPY_BUFFER_BYTES,
  assertOpenedParentStillScoped,
  candidateFor,
  descriptorEntryPath,
  ensureSafeParent,
  ensureScopedDirectorySync,
  errorWithBlockers,
  fsyncDirectoryPathSync,
  inspectDescriptorRelativeEntryIdentity,
  inspectDescriptorRelativeRegularFile,
  inspectScopedRegularFileSync,
  normalizeScopedRelativePath,
  openVerifiedParentDirectory,
  openVerifiedRegularFile,
  sameFileSnapshot,
  verifyOpenedSourceUnchanged,
  writeDescriptorFully,
} from './scoped-file-materialization-path-io.mjs';
import {
  acquireTargetLock,
  assertTargetLockOwned,
  bindTargetLockTemporary,
  cleanupTargetLockOwnedTemporary,
  releaseTargetLock,
} from './scoped-file-materialization-target-lock.mjs';
import {
  closeRecoveryVault,
  openScopeRecoveryVault,
} from './scoped-file-materialization-recovery-vault.mjs';
import {
  assertPartialOperationDefinition,
  createOperationIntent,
  deletePreparedOperationRecord,
  operationRecordForInvocation,
  operationSemanticDefinition,
  publishImmutableOperationDefinition,
  publishOperationCompletion,
  readOperationDefinition,
} from './scoped-file-materialization-operation-journal-repository.mjs';
import {
  installDescriptorRelativeWithoutOverwrite,
  moveDescriptorEntryToRecovery,
  recoveryEntryName,
  restoreDescriptorRelativeBackup,
} from './scoped-file-materialization-recovery-entry-repository.mjs';
import {
  cleanupRecordedEntry,
  completedReplaceAllowsExpectedPreimage,
  exactStableIdentity,
  inspectScopedRegularFileWithRecoverySync,
  recoverPreparedOperationUnderHeldLock,
  recoverScopedMaterializationIntentsSync,
  recoverTargetOperationsUnderHeldLock,
} from './scoped-file-materialization-prepared-recovery-repository.mjs';

export {
  ensureScopedDirectorySync,
  inspectScopedRegularFileSync,
  inspectScopedRegularFileWithRecoverySync,
  normalizeScopedRelativePath,
  recoverScopedMaterializationIntentsSync,
};

export function stageScopedRegularFileCopySync({
  sourceRoot,
  destinationRoot,
  relative,
  destinationRelative = relative,
  stageId = null,
  expectedHash = undefined,
  destinationMode = null,
} = {}) {
  const opened = openVerifiedRegularFile(sourceRoot, relative);
  const destination = candidateFor(path.resolve(destinationRoot || '.'), destinationRelative);
  ensureSafeParent(destinationRoot, destination.candidate);
  let openedParent;
  let targetLock;
  let recoveryVault;
  let operationDefinition;
  let destinationPreimage;
  const targetName = path.basename(destination.candidate);
  const operationId = stageId === null || stageId === undefined || stageId === '' ? crypto.randomUUID() : String(stageId);
  let temporaryName;
  let temporary;
  let temporaryEntryIdentity;
  let temporaryIdentity;
  let outputDescriptor;
  const digest = crypto.createHash('sha256');
  const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
  let bytes = 0;
  try {
    openedParent = openVerifiedParentDirectory(destinationRoot, destination.candidate);
    targetLock = acquireTargetLock(openedParent, targetName, operationId);
    recoveryVault = openScopeRecoveryVault(openedParent.scope);
    operationDefinition = readOperationDefinition(recoveryVault, targetLock.operationId);
    assertPartialOperationDefinition(operationDefinition, {
      operationId: targetLock.operationId,
      operation: 'replace',
      relative: destination.relative,
      expectedHash,
    });
    recoverTargetOperationsUnderHeldLock(openedParent, targetLock, destination.relative, recoveryVault);
    destinationPreimage = inspectDescriptorRelativeRegularFile(openedParent.descriptor, targetName);
    const semanticExpectedHash = expectedHash !== undefined
      ? expectedHash
      : operationDefinition?.record.definition.expectedPreimage.hash;
    const completedReplay = operationDefinition
      && destinationPreimage.hash !== semanticExpectedHash
      && completedReplaceAllowsExpectedPreimage(
        openedParent,
        targetLock,
        destination.relative,
        semanticExpectedHash,
        destinationPreimage,
        recoveryVault,
      );
    if (expectedHash !== undefined && destinationPreimage.hash !== expectedHash && !completedReplay) {
      throw errorWithBlockers('scoped_materialization_preimage_conflict', destination.relative);
    }
    temporaryName = targetLock.stageEntryName;
    temporary = descriptorEntryPath(openedParent.descriptor, temporaryName);
    outputDescriptor = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
    const temporaryStat = fs.fstatSync(outputDescriptor, { bigint: true });
    if (!temporaryStat.isFile() || Number(temporaryStat.nlink) !== 1) throw new Error('scoped_materialization_temporary_not_regular');
    temporaryEntryIdentity = identityFromStat(temporaryStat);
    temporaryIdentity = temporaryEntryIdentity;
    bindTargetLockTemporary(openedParent, targetLock, targetName, temporaryEntryIdentity);
    let count;
    do {
      count = fs.readSync(opened.descriptor, buffer, 0, buffer.length, null);
      if (count) {
        writeDescriptorFully(outputDescriptor, buffer, count);
        digest.update(buffer.subarray(0, count));
        bytes += count;
      }
    } while (count);
    const effectiveMode = destinationMode === null || destinationMode === undefined
      ? opened.mode
      : Number(destinationMode);
    if (!Number.isInteger(effectiveMode) || effectiveMode < 0) {
      throw new Error('scoped_materialization_destination_mode_invalid');
    }
    fs.fchmodSync(outputDescriptor, effectiveMode);
    fs.fsyncSync(outputDescriptor);
    temporaryIdentity = identityFromStat(fs.fstatSync(outputDescriptor, { bigint: true }));
    bindTargetLockTemporary(openedParent, targetLock, targetName, temporaryEntryIdentity, temporaryIdentity);
    operationDefinition = publishImmutableOperationDefinition(recoveryVault, operationSemanticDefinition({
      operationId: targetLock.operationId,
      operation: 'replace',
      relative: destination.relative,
      preimage: operationDefinition?.record.definition.expectedPreimage || destinationPreimage,
      postimage: { exists: true, hash: `sha256:${digest.copy().digest('hex')}`, bytes },
    }));
    verifyOpenedSourceUnchanged(opened);
    assertOpenedParentStillScoped(openedParent);
    fs.closeSync(outputDescriptor);
    outputDescriptor = undefined;
    closeRecoveryVault(recoveryVault);
    recoveryVault = undefined;
  } catch (error) {
    try { if (outputDescriptor !== undefined) fs.closeSync(outputDescriptor); } catch {}
    try {
      if (openedParent && targetLock) cleanupTargetLockOwnedTemporary(openedParent, targetLock, targetName);
    } catch {
    } finally {
      try { if (recoveryVault) closeRecoveryVault(recoveryVault); } catch {}
      try { if (openedParent && targetLock) releaseTargetLock(openedParent, targetLock, targetName); } catch {}
      try { if (openedParent) fs.closeSync(openedParent.descriptor); } catch {}
    }
    throw error;
  } finally {
    fs.closeSync(opened.descriptor);
  }
  return {
    relative: destination.relative,
    target: destination.candidate,
    temporary: path.join(openedParent.parentPath, temporaryName),
    temporaryName,
    targetName,
    openedParent,
    targetLock,
    operationId: targetLock.operationId,
    operationDefinition: operationDefinition?.record.definition || null,
    destinationPreimage,
    temporaryEntryIdentity,
    temporaryIdentity,
    hash: `sha256:${digest.digest('hex')}`,
    bytes,
    committed: false,
  };
}

export function abortStagedScopedFileSync(staged) {
  if (!staged?.openedParent) {
    if (!staged?.committed && staged?.temporary) {
      const existed = fs.existsSync(staged.temporary);
      fs.rmSync(staged.temporary, { force: true });
      if (existed) fsyncDirectoryPathSync(path.dirname(staged.temporary));
    }
    return;
  }
  if (staged.parentDescriptorClosed) return;
  let cleanupError = null;
  try {
    if (!staged.committed && staged.temporaryName && staged.targetLock) {
      try {
        cleanupTargetLockOwnedTemporary(staged.openedParent, staged.targetLock, staged.targetName);
      } catch (error) {
        cleanupError = error;
      }
    }
  } finally {
    try {
      if (staged.targetLock && !staged.targetLock.closed) {
        releaseTargetLock(staged.openedParent, staged.targetLock, staged.targetName);
      }
    } catch (error) {
      cleanupError ||= error;
    }
    try { fs.closeSync(staged.openedParent.descriptor); } catch (error) { cleanupError ||= error; }
    staged.parentDescriptorClosed = true;
  }
  if (cleanupError) throw cleanupError;
}

export function cleanupStagedScopedFileSync({ destinationRoot, relative, stageId } = {}) {
  const target = candidateFor(path.resolve(destinationRoot || '.'), relative);
  ensureSafeParent(destinationRoot, target.candidate);
  const openedParent = openVerifiedParentDirectory(destinationRoot, target.candidate);
  const targetName = path.basename(target.candidate);
  let targetLock;
  const operationId = stageId === null || stageId === undefined || stageId === ''
    ? `cleanup:${crypto.randomUUID()}`
    : normalizeScopedMaterializationOperationId(stageId);
  try {
    targetLock = acquireTargetLock(openedParent, targetName, `cleanup:${operationId}:${crypto.randomUUID()}`);
    if (targetLock.recoveredStaleTemporary) return true;
    // Without a persisted owner record, a same-named entry may belong to another
    // invocation. Cleanup fails closed instead of authorizing deletion from an
    // identity observed only during this call.
    return false;
  } finally {
    try {
      if (targetLock) releaseTargetLock(openedParent, targetLock, targetName);
    } finally {
      fs.closeSync(openedParent.descriptor);
    }
  }
}

export function commitStagedScopedFileSync(staged, { destinationRoot, expectedHash = null } = {}) {
  if (!staged || staged.committed) throw new Error('scoped_materialization_stage_invalid');
  const target = candidateFor(path.resolve(destinationRoot || '.'), staged.relative);
  if (target.candidate !== staged.target) throw errorWithBlockers('scoped_materialization_destination_changed', staged.relative);
  if (!staged.openedParent || staged.parentDescriptorClosed) throw new Error('scoped_materialization_stage_descriptor_invalid');
  let recoveryVault;
  let recoveryBackup;
  let intent;
  let completion;
  let persisted;
  let failure = null;
  try {
    assertTargetLockOwned(staged.openedParent, staged.targetLock, staged.targetName);
    assertOpenedParentStillScoped(staged.openedParent);
    const current = inspectDescriptorRelativeRegularFile(staged.openedParent.descriptor, staged.targetName);
    const temporary = inspectDescriptorRelativeRegularFile(staged.openedParent.descriptor, staged.temporaryName);
    if (!temporary.exists || temporary.hash !== staged.hash || temporary.bytes !== staged.bytes
      || !sameStableEntryIdentity(temporary.identity, staged.temporaryIdentity)) {
      throw errorWithBlockers('scoped_materialization_staged_file_changed', staged.relative);
    }
    recoveryVault = openScopeRecoveryVault(staged.openedParent.scope);
    const semanticDefinition = readOperationDefinition(recoveryVault, staged.operationId);
    if (!semanticDefinition) {
      throw errorWithBlockers('scoped_materialization_operation_definition_missing', staged.relative);
    }
    assertPartialOperationDefinition(semanticDefinition, {
      operationId: staged.operationId,
      operation: 'replace',
      relative: staged.relative,
      expectedHash,
      postimageHash: staged.hash,
      postimageBytes: staged.bytes,
    });
    completion = operationRecordForInvocation(recoveryVault, staged.openedParent, {
      operationId: staged.operationId,
      operation: 'replace',
      relative: staged.relative,
      expectedHash,
      postimageHash: staged.hash,
      postimageBytes: staged.bytes,
    });
    if (completion) {
      const replayed = inspectDescriptorRelativeRegularFile(staged.openedParent.descriptor, staged.targetName);
      if (!replayed.exists || replayed.hash !== staged.hash || replayed.bytes !== staged.bytes
        || !exactStableIdentity(replayed.identity, completion.record.completedPostimageIdentity)) {
        throw errorWithBlockers('scoped_materialization_operation_target_advanced', staged.relative);
      }
      cleanupRecordedEntry(staged.openedParent, staged.temporaryName, staged.temporaryIdentity, {
        hash: staged.hash,
        bytes: staged.bytes,
      });
      persisted = replayed;
      staged.committed = true;
    } else {
      if (current.hash !== expectedHash || !sameFileSnapshot(current, staged.destinationPreimage)) {
        throw errorWithBlockers('scoped_materialization_preimage_conflict', staged.relative);
      }
      const recoveryName = current.exists
        ? recoveryEntryName(staged.targetName, staged.operationId, 'preimage', staged.relative)
        : null;
      const localPreimageName = current.exists
        ? scopedMaterializationRecoveryEntryName(staged.relative, staged.operationId, 'preimage', { local: true })
        : null;
      if (current.exists) {
        recoveryBackup = moveDescriptorEntryToRecovery(staged.openedParent, recoveryVault, {
          sourceName: staged.targetName,
          targetName: staged.targetName,
          operationId: staged.operationId,
          relative: staged.relative,
          suffix: 'preimage',
          expectedSnapshot: current,
        });
      }
      intent = createOperationIntent(recoveryVault, staged.openedParent, staged.targetLock, {
        operation: 'replace',
        relative: staged.relative,
        preimage: current,
        postimage: { exists: true, hash: staged.hash, bytes: staged.bytes },
        recoveryEntryName: recoveryName,
        recoveryEntryIdentity: recoveryBackup?.identity || null,
        localPreimageName,
        localPreimageIdentity: current.identity,
        temporaryName: staged.temporaryName,
        stagedPostimageIdentity: staged.temporaryIdentity,
      });
      assertOpenedParentStillScoped(staged.openedParent);
      if (current.exists) {
        fs.renameSync(
          descriptorEntryPath(staged.openedParent.descriptor, staged.targetName),
          descriptorEntryPath(staged.openedParent.descriptor, localPreimageName),
        );
        fs.fsyncSync(staged.openedParent.descriptor);
        const quarantined = inspectDescriptorRelativeRegularFile(
          staged.openedParent.descriptor,
          localPreimageName,
        );
        if (!sameFileSnapshot(quarantined, current)) {
          const restored = restoreDescriptorRelativeBackup(staged.openedParent, {
            targetName: staged.targetName,
            backupName: localPreimageName,
            backupIdentity: quarantined.identity,
          });
          if (!restored) throw errorWithBlockers(
            'scoped_materialization_preimage_restore_blocked',
            staged.relative,
          );
          deletePreparedOperationRecord(recoveryVault, intent);
          intent = null;
          cleanupRecordedEntry(recoveryVault, recoveryBackup.name, recoveryBackup.identity, current);
          recoveryBackup.deleted = true;
          recoveryBackup = null;
          throw errorWithBlockers('scoped_materialization_preimage_conflict', staged.relative);
        }
      }
      installDescriptorRelativeWithoutOverwrite(
        staged.openedParent,
        staged.temporaryName,
        staged.targetName,
        staged.temporaryIdentity,
      );
      assertOpenedParentStillScoped(staged.openedParent);
      fs.fsyncSync(staged.openedParent.descriptor);
      cleanupRecordedEntry(staged.openedParent, staged.temporaryName, staged.temporaryIdentity, {
        hash: staged.hash,
        bytes: staged.bytes,
      });
      persisted = inspectDescriptorRelativeRegularFile(staged.openedParent.descriptor, staged.targetName);
      if (persisted.hash !== staged.hash || persisted.bytes !== staged.bytes) {
        throw errorWithBlockers('scoped_materialization_postimage_mismatch', staged.relative);
      }
      assertOpenedParentStillScoped(staged.openedParent);
      completion = publishOperationCompletion(recoveryVault, intent, persisted.identity);
      staged.committed = true;
      if (localPreimageName) cleanupRecordedEntry(
        staged.openedParent,
        localPreimageName,
        current.identity,
        current,
      );
      if (recoveryBackup) {
        cleanupRecordedEntry(recoveryVault, recoveryBackup.name, recoveryBackup.identity, current);
        recoveryBackup.deleted = true;
      }
      deletePreparedOperationRecord(recoveryVault, intent);
      assertOpenedParentStillScoped(staged.openedParent);
    }
  } catch (error) {
    failure = error;
    if (!completion && intent) {
      try { recoverPreparedOperationUnderHeldLock(recoveryVault, staged.openedParent, staged.targetLock, intent); }
      catch (rollbackError) { failure.rollbackError = rollbackError; }
    } else if (!intent && recoveryBackup) {
      try { cleanupRecordedEntry(recoveryVault, recoveryBackup.name, recoveryBackup.identity, staged.destinationPreimage); }
      catch (rollbackError) { failure.rollbackError = rollbackError; }
    }
    if (!staged.committed) {
      try { cleanupRecordedEntry(staged.openedParent, staged.temporaryName, staged.temporaryIdentity, { hash: staged.hash, bytes: staged.bytes }); }
      catch (rollbackError) { failure.rollbackError ||= rollbackError; }
    }
  } finally {
    try { closeRecoveryVault(recoveryVault); } catch (error) { failure ||= error; }
    try {
      if (staged.targetLock && !staged.targetLock.closed) {
        releaseTargetLock(staged.openedParent, staged.targetLock, staged.targetName);
      }
    } catch (error) { failure ||= error; }
    try { fs.closeSync(staged.openedParent.descriptor); } catch (error) { failure ||= error; }
    staged.parentDescriptorClosed = true;
  }
  if (failure) throw failure;
  return Object.freeze({
    exists: true,
    relative: staged.relative,
    hash: persisted.hash,
    bytes: persisted.bytes,
    identityHash: null,
  });
}

export function removeScopedRegularFileSync({ scopeRoot, relative, expectedHash, operationId = null } = {}) {
  const target = candidateFor(path.resolve(scopeRoot || '.'), relative);
  ensureSafeParent(scopeRoot, target.candidate);
  const openedParent = openVerifiedParentDirectory(scopeRoot, target.candidate);
  const targetName = path.basename(target.candidate);
  const effectiveOperationId = operationId === null || operationId === undefined || operationId === ''
    ? crypto.randomUUID()
    : normalizeScopedMaterializationOperationId(operationId);
  let targetLock;
  let recoveryVault;
  let recoveryBackup;
  let intent;
  let completion;
  let operationDefinition;
  let removedHash = expectedHash;
  let failure = null;
  try {
    targetLock = acquireTargetLock(openedParent, targetName, effectiveOperationId);
    recoveryVault = openScopeRecoveryVault(openedParent.scope);
    operationDefinition = readOperationDefinition(recoveryVault, effectiveOperationId);
    assertPartialOperationDefinition(operationDefinition, {
      operationId: effectiveOperationId,
      operation: 'remove',
      relative: target.relative,
      expectedHash,
      postimageHash: null,
      postimageBytes: 0,
    });
    recoverTargetOperationsUnderHeldLock(openedParent, targetLock, target.relative, recoveryVault);
    completion = operationRecordForInvocation(recoveryVault, openedParent, {
      operationId: effectiveOperationId,
      operation: 'remove',
      relative: target.relative,
      expectedHash,
      postimageHash: null,
      postimageBytes: 0,
    });
    if (completion) {
      const replayed = inspectDescriptorRelativeRegularFile(openedParent.descriptor, targetName);
      if (replayed.exists) throw errorWithBlockers('scoped_materialization_operation_target_advanced', target.relative);
    } else {
      const current = inspectDescriptorRelativeRegularFile(openedParent.descriptor, targetName);
      if (!current.exists || current.hash !== expectedHash) {
        throw errorWithBlockers('scoped_materialization_preimage_conflict', target.relative);
      }
      operationDefinition = publishImmutableOperationDefinition(recoveryVault, operationSemanticDefinition({
        operationId: effectiveOperationId,
        operation: 'remove',
        relative: target.relative,
        preimage: current,
        postimage: { exists: false, hash: null, bytes: 0 },
      }));
      const recoveryName = recoveryEntryName(targetName, effectiveOperationId, 'removed', target.relative);
      const localPreimageName = scopedMaterializationRecoveryEntryName(
        target.relative,
        effectiveOperationId,
        'removed',
        { local: true },
      );
      recoveryBackup = moveDescriptorEntryToRecovery(openedParent, recoveryVault, {
        sourceName: targetName,
        targetName,
        operationId: effectiveOperationId,
        relative: target.relative,
        suffix: 'removed',
        expectedSnapshot: current,
      });
      intent = createOperationIntent(recoveryVault, openedParent, targetLock, {
        operation: 'remove',
        relative: target.relative,
        preimage: current,
        postimage: { exists: false, hash: null, bytes: 0 },
        recoveryEntryName: recoveryName,
        recoveryEntryIdentity: recoveryBackup.identity,
        localPreimageName,
        localPreimageIdentity: current.identity,
        temporaryName: null,
        stagedPostimageIdentity: null,
      });
      assertOpenedParentStillScoped(openedParent);
      fs.renameSync(
        descriptorEntryPath(openedParent.descriptor, targetName),
        descriptorEntryPath(openedParent.descriptor, localPreimageName),
      );
      fs.fsyncSync(openedParent.descriptor);
      const quarantined = inspectDescriptorRelativeRegularFile(openedParent.descriptor, localPreimageName);
      if (!sameFileSnapshot(quarantined, current)) {
        const restored = restoreDescriptorRelativeBackup(openedParent, {
          targetName,
          backupName: localPreimageName,
          backupIdentity: quarantined.identity,
        });
        if (!restored) throw errorWithBlockers(
          'scoped_materialization_preimage_restore_blocked',
          target.relative,
        );
        deletePreparedOperationRecord(recoveryVault, intent);
        intent = null;
        cleanupRecordedEntry(recoveryVault, recoveryBackup.name, recoveryBackup.identity, current);
        recoveryBackup.deleted = true;
        recoveryBackup = null;
        throw errorWithBlockers('scoped_materialization_preimage_conflict', target.relative);
      }
      assertOpenedParentStillScoped(openedParent);
      if (inspectDescriptorRelativeEntryIdentity(openedParent.descriptor, targetName).exists) {
        throw errorWithBlockers('scoped_materialization_preimage_conflict', target.relative);
      }
      assertOpenedParentStillScoped(openedParent);
      completion = publishOperationCompletion(recoveryVault, intent, null);
      cleanupRecordedEntry(openedParent, localPreimageName, current.identity, current);
      cleanupRecordedEntry(recoveryVault, recoveryBackup.name, recoveryBackup.identity, current);
      recoveryBackup.deleted = true;
      deletePreparedOperationRecord(recoveryVault, intent);
      assertOpenedParentStillScoped(openedParent);
      removedHash = current.hash;
    }
  } catch (error) {
    failure = error;
    if (!completion && intent) {
      try { recoverPreparedOperationUnderHeldLock(recoveryVault, openedParent, targetLock, intent); }
      catch (rollbackError) { failure.rollbackError = rollbackError; }
    } else if (!intent && recoveryBackup) {
      try { cleanupRecordedEntry(recoveryVault, recoveryBackup.name, recoveryBackup.identity); }
      catch (rollbackError) { failure.rollbackError = rollbackError; }
    }
  } finally {
    try { closeRecoveryVault(recoveryVault); } catch (error) { failure ||= error; }
    try { if (targetLock) releaseTargetLock(openedParent, targetLock, targetName); }
    catch (error) { failure ||= error; }
    try { fs.closeSync(openedParent.descriptor); } catch (error) { failure ||= error; }
  }
  if (failure) throw failure;
  return Object.freeze({ relative: target.relative, removedHash });
}
