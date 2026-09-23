import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { writeDescriptorFullySync } from '../../workflow-kernel/runtime/file-descriptor-utils.mjs';
import {
  assertPublicDirectoryBinding,
  childStat,
  descriptorPath,
  identityRecord,
  matchesIdentityRecord,
  readPinnedJson,
  removeControlledDirectory,
  safeControlName,
  unlinkControlledFile,
} from './workspace-snapshot-staging-repository.mjs';

const NO_FOLLOW = fs.constants.O_NOFOLLOW || 0;

export function publicationIntentName(destinationName) {
  const key = crypto.createHash('sha256').update(destinationName).digest('hex').slice(0, 24);
  return `.hepta-workspace-restore-${key}.intent.json`;
}

function validDirectoryIdentityRecord(value) {
  return Boolean(value
    && typeof value.dev === 'string' && /^\d+$/.test(value.dev)
    && typeof value.ino === 'string' && /^\d+$/.test(value.ino)
    && Number.isSafeInteger(value.mode)
    && (value.mode & 0o170000) === 0o040000);
}

export function readPublicationIntent(parentDescriptor, intentName) {
  const stat = childStat(parentDescriptor, intentName);
  if (!stat) return null;
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('workspace_snapshot_restore_intent_unsafe');
  const candidate = path.join(descriptorPath(parentDescriptor), intentName);
  const intent = readPinnedJson(candidate, 'workspace_snapshot_restore_intent_invalid');
  const { intentHash = null, ...payload } = intent || {};
  if (!intentHash || hashRecord('WorkspaceSnapshotRestorePublicationIntent', payload) !== intentHash
    || payload.version !== 1 || payload.kind !== 'WorkspaceSnapshotRestorePublicationIntent'
    || !/^sha256:[0-9a-f]{64}$/.test(payload.operationHash || '')
    || !safeControlName(payload.destinationName) || !safeControlName(payload.stageName)
    || !safeControlName(payload.backupName)
    || !payload.stageName.startsWith('.workspace-snapshot-restore-')
    || !payload.backupName.startsWith('.hepta-workspace-restore-backup-')
    || !validDirectoryIdentityRecord(payload.stageIdentity)
    || (payload.originalIdentity !== null && !validDirectoryIdentityRecord(payload.originalIdentity))) {
    throw new Error('workspace_snapshot_restore_intent_invalid');
  }
  return intent;
}

function writePublicationIntent(parentDescriptor, intentName, payload) {
  if (readPublicationIntent(parentDescriptor, intentName)) throw new Error('workspace_snapshot_restore_publication_in_progress');
  const intent = { ...payload, intentHash: hashRecord('WorkspaceSnapshotRestorePublicationIntent', payload) };
  const temporaryName = `${intentName}.new`;
  if (childStat(parentDescriptor, temporaryName)) throw new Error('workspace_snapshot_restore_publication_in_progress');
  const temporaryPath = path.join(descriptorPath(parentDescriptor), temporaryName);
  let descriptor = null;
  try {
    descriptor = fs.openSync(temporaryPath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NO_FOLLOW, 0o600);
    writeDescriptorFullySync(descriptor, `${JSON.stringify(intent)}\n`);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    fs.linkSync(temporaryPath, path.join(descriptorPath(parentDescriptor), intentName));
    fs.fsyncSync(parentDescriptor);
    fs.unlinkSync(temporaryPath);
    fs.fsyncSync(parentDescriptor);
    return intent;
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
    try { unlinkControlledFile(parentDescriptor, temporaryName); } catch { /* preserve primary failure */ }
  }
}

function safeDirectoryStat(parentDescriptor, name, errorCode) {
  const stat = childStat(parentDescriptor, name);
  if (!stat) return null;
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(errorCode);
  return stat;
}

function publicationFault(faultInjector, milestone) {
  if (typeof faultInjector === 'function') faultInjector(milestone);
}

function finishPublishedState({ parentDescriptor, parentPath, intentName, intent, faultInjector = null }) {
  assertPublicDirectoryBinding(parentPath, parentDescriptor, 'workspace_snapshot_restore_parent_identity_changed');
  const targetStat = safeDirectoryStat(parentDescriptor, intent.destinationName, 'workspace_snapshot_restore_target_unsafe');
  const stageStat = safeDirectoryStat(parentDescriptor, intent.stageName, 'workspace_snapshot_restore_stage_unsafe');
  const backupStat = safeDirectoryStat(parentDescriptor, intent.backupName, 'workspace_snapshot_restore_backup_unsafe');
  if (stageStat && !matchesIdentityRecord(stageStat, intent.stageIdentity)) throw new Error('workspace_snapshot_restore_stage_identity_conflict');
  if (backupStat && (!intent.originalIdentity || !matchesIdentityRecord(backupStat, intent.originalIdentity))) {
    throw new Error('workspace_snapshot_restore_backup_identity_conflict');
  }
  const target = targetStat && matchesIdentityRecord(targetStat, intent.stageIdentity);
  const originalAtTarget = targetStat && intent.originalIdentity && matchesIdentityRecord(targetStat, intent.originalIdentity);
  if (targetStat && !target && !originalAtTarget) throw new Error('workspace_snapshot_restore_publication_identity_conflict');

  if (target) {
    if (stageStat) throw new Error('workspace_snapshot_restore_duplicate_staging_identity');
  } else if (originalAtTarget) {
    if (!stageStat) {
      unlinkControlledFile(parentDescriptor, intentName);
      return false;
    }
    if (backupStat) throw new Error('workspace_snapshot_restore_duplicate_original_identity');
    assertPublicDirectoryBinding(parentPath, parentDescriptor, 'workspace_snapshot_restore_parent_identity_changed');
    fs.renameSync(
      path.join(descriptorPath(parentDescriptor), intent.destinationName),
      path.join(descriptorPath(parentDescriptor), intent.backupName),
    );
    publicationFault(faultInjector, 'after_original_rename');
    fs.fsyncSync(parentDescriptor);
    publicationFault(faultInjector, 'after_original_directory_sync');
    assertPublicDirectoryBinding(parentPath, parentDescriptor, 'workspace_snapshot_restore_parent_identity_changed');
    fs.renameSync(
      path.join(descriptorPath(parentDescriptor), intent.stageName),
      path.join(descriptorPath(parentDescriptor), intent.destinationName),
    );
    publicationFault(faultInjector, 'after_staging_rename');
    fs.fsyncSync(parentDescriptor);
    publicationFault(faultInjector, 'after_staging_directory_sync');
    assertPublicDirectoryBinding(parentPath, parentDescriptor, 'workspace_snapshot_restore_parent_identity_changed');
  } else if (!targetStat) {
    if (!stageStat) {
      if (backupStat) {
        assertPublicDirectoryBinding(parentPath, parentDescriptor, 'workspace_snapshot_restore_parent_identity_changed');
        fs.renameSync(
          path.join(descriptorPath(parentDescriptor), intent.backupName),
          path.join(descriptorPath(parentDescriptor), intent.destinationName),
        );
        fs.fsyncSync(parentDescriptor);
      }
      unlinkControlledFile(parentDescriptor, intentName);
      return false;
    }
    assertPublicDirectoryBinding(parentPath, parentDescriptor, 'workspace_snapshot_restore_parent_identity_changed');
    fs.renameSync(
      path.join(descriptorPath(parentDescriptor), intent.stageName),
      path.join(descriptorPath(parentDescriptor), intent.destinationName),
    );
    publicationFault(faultInjector, 'after_staging_rename');
    fs.fsyncSync(parentDescriptor);
    publicationFault(faultInjector, 'after_staging_directory_sync');
    assertPublicDirectoryBinding(parentPath, parentDescriptor, 'workspace_snapshot_restore_parent_identity_changed');
  } else {
    throw new Error('workspace_snapshot_restore_publication_identity_conflict');
  }

  const installed = safeDirectoryStat(parentDescriptor, intent.destinationName, 'workspace_snapshot_restore_target_unsafe');
  if (!installed || !matchesIdentityRecord(installed, intent.stageIdentity)) throw new Error('workspace_snapshot_restore_publication_not_installed');
  assertPublicDirectoryBinding(parentPath, parentDescriptor, 'workspace_snapshot_restore_parent_identity_changed');
  if (intent.originalIdentity) removeControlledDirectory(parentDescriptor, intent.backupName, intent.originalIdentity);
  publicationFault(faultInjector, 'after_backup_cleanup_directory_sync');
  unlinkControlledFile(parentDescriptor, intentName);
  publicationFault(faultInjector, 'after_intent_cleanup_directory_sync');
  assertPublicDirectoryBinding(parentPath, parentDescriptor, 'workspace_snapshot_restore_parent_identity_changed');
  return true;
}

export function recoverPublication({ parentDescriptor, parentPath, destinationName, operationHash }) {
  const intentName = publicationIntentName(destinationName);
  const temporaryName = `${intentName}.new`;
  let intent = readPublicationIntent(parentDescriptor, intentName);
  if (!intent) {
    const temporary = readPublicationIntent(parentDescriptor, temporaryName);
    if (!temporary) return false;
    if (temporary.destinationName !== destinationName || temporary.operationHash !== operationHash) {
      throw new Error('workspace_snapshot_restore_publication_in_progress');
    }
    fs.renameSync(
      path.join(descriptorPath(parentDescriptor), temporaryName),
      path.join(descriptorPath(parentDescriptor), intentName),
    );
    fs.fsyncSync(parentDescriptor);
    intent = temporary;
  } else {
    const temporaryStat = childStat(parentDescriptor, temporaryName);
    if (temporaryStat) {
      const intentStat = childStat(parentDescriptor, intentName);
      if (!temporaryStat.isFile() || temporaryStat.isSymbolicLink()
        || temporaryStat.dev !== intentStat.dev || temporaryStat.ino !== intentStat.ino) {
        throw new Error('workspace_snapshot_restore_intent_temporary_conflict');
      }
      unlinkControlledFile(parentDescriptor, temporaryName);
    }
  }
  if (intent.destinationName !== destinationName || intent.operationHash !== operationHash) {
    throw new Error('workspace_snapshot_restore_publication_in_progress');
  }
  return finishPublishedState({ parentDescriptor, parentPath, intentName, intent });
}

export function publishStage({ parentDescriptor, parentPath, destinationName, stage, operationHash, faultInjector }) {
  assertPublicDirectoryBinding(parentPath, parentDescriptor, 'workspace_snapshot_restore_parent_identity_changed');
  const existing = childStat(parentDescriptor, destinationName);
  if (existing && (!existing.isDirectory() || existing.isSymbolicLink())) throw new Error('workspace_snapshot_restore_destination_unsafe');
  const originalIdentity = existing ? identityRecord(existing) : null;
  const backupName = `.hepta-workspace-restore-backup-${crypto.randomUUID()}`;
  const intentName = publicationIntentName(destinationName);
  const payload = {
    version: 1,
    kind: 'WorkspaceSnapshotRestorePublicationIntent',
    operationHash,
    destinationName,
    stageName: stage.name,
    stageIdentity: stage.identity,
    backupName,
    originalIdentity,
  };
  writePublicationIntent(parentDescriptor, intentName, payload);
  publicationFault(faultInjector, 'after_intent_directory_sync');
  try {
    return finishPublishedState({
      parentDescriptor,
      parentPath,
      intentName,
      intent: payload,
      faultInjector,
    });
  } catch (error) {
    try { finishPublishedState({ parentDescriptor, parentPath, intentName, intent: payload }); } catch { /* durable intent remains */ }
    throw error;
  }
}
