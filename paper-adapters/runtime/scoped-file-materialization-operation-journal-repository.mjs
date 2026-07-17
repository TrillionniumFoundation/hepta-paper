import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  buildScopedMaterializationOperationDefinitionRecord,
  buildScopedMaterializationOperationRecord,
  currentMaterializationLockOwnerIdentity as currentLockOwnerIdentity,
  materializationIdentityFromStat as identityFromStat,
  normalizeScopedMaterializationOperationId,
  scopedMaterializationOperationDefinitionName,
  scopedMaterializationOperationRecordName,
  verifyScopedMaterializationOperationDefinitionRecord,
  verifyScopedMaterializationOperationRecord,
} from './scoped-file-materialization-recovery-record.mjs';
import {
  descriptorEntryPath,
  errorWithBlockers,
  normalizeScopedRelativePath,
  readDescriptorJsonRecord,
  unlinkOwnedDescriptorEntry,
  writeDescriptorFully,
} from './scoped-file-materialization-path-io.mjs';
import {
  ACTIVE_OPERATION_RECORD_TEMPS,
  assertRecoveryVaultStillScoped,
} from './scoped-file-materialization-recovery-vault.mjs';

const RECOVERY_INTENT_MAX_BYTES = 64 * 1024;

function semanticSnapshot(snapshot) {
  return Object.freeze({
    exists: Boolean(snapshot?.exists),
    hash: snapshot?.hash ?? null,
    bytes: snapshot?.exists ? Number(snapshot?.bytes || 0) : 0,
  });
}

export function operationSemanticDefinition({ operationId, operation, relative, preimage, postimage } = {}) {
  return Object.freeze({
    operationId: normalizeScopedMaterializationOperationId(operationId),
    operation,
    relative: normalizeScopedRelativePath(relative),
    expectedPreimage: semanticSnapshot(preimage),
    postimage: semanticSnapshot(postimage),
  });
}

export function readOperationDefinition(vault, operationId) {
  const name = scopedMaterializationOperationDefinitionName(operationId);
  let loaded;
  try {
    loaded = readDescriptorJsonRecord(
      vault.descriptor,
      name,
      RECOVERY_INTENT_MAX_BYTES,
      'scoped_materialization_operation_definition_unsafe',
    );
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  const record = verifyScopedMaterializationOperationDefinitionRecord(loaded.record, name);
  return { name, identity: loaded.identity, record };
}

export function assertPartialOperationDefinition(existing, {
  operationId,
  operation,
  relative,
  expectedHash = undefined,
  postimageHash = undefined,
  postimageBytes = undefined,
} = {}) {
  if (!existing) return;
  const definition = existing.record.definition;
  const matches = definition.operationId === operationId
    && definition.operation === operation
    && definition.relative === relative
    && (expectedHash === undefined || (
      definition.expectedPreimage.exists === (expectedHash !== null)
      && definition.expectedPreimage.hash === expectedHash
    ))
    && (postimageHash === undefined || definition.postimage.hash === postimageHash)
    && (postimageBytes === undefined || definition.postimage.bytes === postimageBytes);
  if (!matches) throw errorWithBlockers('scoped_materialization_operation_definition_conflict', relative);
}

export function publishImmutableOperationDefinition(vault, definition) {
  assertRecoveryVaultStillScoped(vault);
  const record = buildScopedMaterializationOperationDefinitionRecord(definition);
  const name = scopedMaterializationOperationDefinitionName(record.definition.operationId);
  const existing = readOperationDefinition(vault, record.definition.operationId);
  if (existing) {
    if (existing.record.scopedMaterializationOperationDefinitionHash
      !== record.scopedMaterializationOperationDefinitionHash) {
      throw errorWithBlockers(
        'scoped_materialization_operation_definition_conflict',
        record.definition.relative,
      );
    }
    return existing;
  }
  const owner = currentLockOwnerIdentity();
  const ownerStart = String(owner.pidStartTime || 'unknown').replace(/[^A-Za-z0-9_.-]/g, '_');
  const pendingName = `.pending-definition-${owner.pid}-${ownerStart}-${crypto.randomUUID()}.json`;
  const bytes = Buffer.from(`${JSON.stringify(record)}\n`);
  let descriptor;
  let identity;
  try {
    ACTIVE_OPERATION_RECORD_TEMPS.add(pendingName);
    descriptor = fs.openSync(
      descriptorEntryPath(vault.descriptor, pendingName),
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0),
      0o600,
    );
    writeDescriptorFully(descriptor, bytes, bytes.length);
    fs.fsyncSync(descriptor);
    identity = identityFromStat(fs.fstatSync(descriptor, { bigint: true }));
    try {
      fs.linkSync(
        descriptorEntryPath(vault.descriptor, pendingName),
        descriptorEntryPath(vault.descriptor, name),
      );
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const concurrent = readOperationDefinition(vault, record.definition.operationId);
      if (concurrent.record.scopedMaterializationOperationDefinitionHash
        !== record.scopedMaterializationOperationDefinitionHash) {
        throw errorWithBlockers(
          'scoped_materialization_operation_definition_conflict',
          record.definition.relative,
        );
      }
    }
    fs.fsyncSync(vault.descriptor);
    unlinkOwnedDescriptorEntry(vault, pendingName, identity, { sync: false });
    ACTIVE_OPERATION_RECORD_TEMPS.delete(pendingName);
    fs.fsyncSync(vault.descriptor);
    return readOperationDefinition(vault, record.definition.operationId);
  } catch (error) {
    try { if (identity) unlinkOwnedDescriptorEntry(vault, pendingName, identity); } catch {}
    throw error;
  } finally {
    ACTIVE_OPERATION_RECORD_TEMPS.delete(pendingName);
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function operationRecordDefinition(openedParent, targetLock, {
  operation,
  relative,
  preimage,
  postimage,
  recoveryEntryName: recoveryName,
  recoveryEntryIdentity = null,
  localPreimageName = null,
  localPreimageIdentity = null,
  temporaryName = null,
  stagedPostimageIdentity = null,
  completedPostimageIdentity = null,
} = {}) {
  return {
    operationId: targetLock.operationId,
    operation,
    relative,
    expectedPreimage: {
      exists: Boolean(preimage?.exists),
      hash: preimage?.hash ?? null,
      bytes: preimage?.bytes ?? 0,
      identity: preimage?.identity ?? null,
    },
    postimage: {
      exists: Boolean(postimage?.exists),
      hash: postimage?.hash ?? null,
      bytes: postimage?.bytes ?? 0,
    },
    parentRelative: openedParent.parentRelative,
    parentIdentity: openedParent.identity,
    scopeRoot: {
      realPath: openedParent.scope.realRoot,
      device: openedParent.scope.identity.device,
      inode: openedParent.scope.identity.inode,
      mode: openedParent.scope.identity.mode,
    },
    preimage,
    targetName: path.posix.basename(relative),
    recoveryEntryName: recoveryName,
    recoveryEntryIdentity,
    localPreimageName,
    localPreimageIdentity,
    temporaryName,
    stagedPostimageIdentity,
    targetLockName: targetLock.name,
    targetLockIdentity: targetLock.identity,
    owner: targetLock.owner,
    completedPostimageIdentity,
  };
}

export function readOperationRecord(vault, name, expectedStatus = null) {
  const loaded = readDescriptorJsonRecord(
    vault.descriptor,
    name,
    RECOVERY_INTENT_MAX_BYTES,
    'scoped_materialization_operation_record_unsafe',
  );
  const record = verifyScopedMaterializationOperationRecord(loaded.record, name, expectedStatus);
  return { name, identity: loaded.identity, record, deleted: false };
}

export function findOperationRecord(vault, operationId, status, relative) {
  const name = scopedMaterializationOperationRecordName(operationId, status, relative);
  try { return readOperationRecord(vault, name, status); }
  catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function assertOperationDefinitionAvailable(vault, definition, bindingHash) {
  for (const status of ['prepared', 'completed']) {
    const existing = findOperationRecord(vault, definition.operationId, status, definition.relative);
    if (!existing) continue;
    if (existing.record.bindingHash !== bindingHash) {
      throw errorWithBlockers('scoped_materialization_operation_definition_conflict', definition.relative);
    }
  }
}

function publishImmutableOperationRecord(vault, record) {
  assertRecoveryVaultStillScoped(vault);
  const definition = record.binding;
  const name = scopedMaterializationOperationRecordName(
    definition.operationId,
    record.status,
    definition.relative,
  );
  assertOperationDefinitionAvailable(vault, definition, record.bindingHash);
  const existing = findOperationRecord(vault, definition.operationId, record.status, definition.relative);
  if (existing) {
    if (existing.record.scopedMaterializationOperationRecordHash !== record.scopedMaterializationOperationRecordHash) {
      throw errorWithBlockers('scoped_materialization_operation_definition_conflict', definition.relative);
    }
    return existing;
  }
  const owner = currentLockOwnerIdentity();
  const ownerStart = String(owner.pidStartTime || 'unknown').replace(/[^A-Za-z0-9_.-]/g, '_');
  const pendingName = `.pending-record-${owner.pid}-${ownerStart}-${crypto.randomUUID()}.json`;
  const bytes = Buffer.from(`${JSON.stringify(record)}\n`);
  let descriptor;
  let identity;
  try {
    ACTIVE_OPERATION_RECORD_TEMPS.add(pendingName);
    descriptor = fs.openSync(
      descriptorEntryPath(vault.descriptor, pendingName),
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0),
      0o600,
    );
    writeDescriptorFully(descriptor, bytes, bytes.length);
    fs.fsyncSync(descriptor);
    identity = identityFromStat(fs.fstatSync(descriptor, { bigint: true }));
    try {
      fs.linkSync(
        descriptorEntryPath(vault.descriptor, pendingName),
        descriptorEntryPath(vault.descriptor, name),
      );
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const concurrent = readOperationRecord(vault, name, record.status);
      if (concurrent.record.scopedMaterializationOperationRecordHash !== record.scopedMaterializationOperationRecordHash) {
        throw errorWithBlockers('scoped_materialization_operation_definition_conflict', definition.relative);
      }
    }
    fs.fsyncSync(vault.descriptor);
    unlinkOwnedDescriptorEntry(vault, pendingName, identity, { sync: false });
    ACTIVE_OPERATION_RECORD_TEMPS.delete(pendingName);
    fs.fsyncSync(vault.descriptor);
    return readOperationRecord(vault, name, record.status);
  } catch (error) {
    try { if (identity) unlinkOwnedDescriptorEntry(vault, pendingName, identity); } catch {}
    throw error;
  } finally {
    ACTIVE_OPERATION_RECORD_TEMPS.delete(pendingName);
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

export function createOperationIntent(vault, openedParent, targetLock, definition) {
  const recordDefinition = operationRecordDefinition(openedParent, targetLock, definition);
  const record = buildScopedMaterializationOperationRecord({ status: 'prepared', ...recordDefinition });
  return publishImmutableOperationRecord(vault, record);
}

export function publishOperationCompletion(vault, intent, completedPostimageIdentity = null) {
  const prepared = intent.record;
  const definition = {
    ...prepared.binding,
    preimage: prepared.preimage,
    targetName: prepared.targetName,
    recoveryEntryName: prepared.recoveryEntryName,
    recoveryEntryIdentity: prepared.recoveryEntryIdentity,
    localPreimageName: prepared.localPreimageName,
    localPreimageIdentity: prepared.localPreimageIdentity,
    temporaryName: prepared.temporaryName,
    stagedPostimageIdentity: prepared.stagedPostimageIdentity,
    targetLockName: prepared.targetLockName,
    targetLockIdentity: prepared.targetLockIdentity,
    owner: prepared.owner,
    completedPostimageIdentity,
  };
  const record = buildScopedMaterializationOperationRecord({ status: 'completed', ...definition });
  return publishImmutableOperationRecord(vault, record);
}

export function deletePreparedOperationRecord(vault, intent) {
  if (!intent || intent.deleted) return;
  unlinkOwnedDescriptorEntry(vault, intent.name, intent.identity, { sync: false });
  fs.fsyncSync(vault.descriptor);
  intent.deleted = true;
}

export function operationRecordForInvocation(vault, openedParent, {
  operationId,
  operation,
  relative,
  expectedHash,
  postimageHash,
  postimageBytes,
} = {}) {
  let completion = null;
  for (const status of ['prepared', 'completed']) {
    const existing = findOperationRecord(vault, operationId, status, relative);
    if (!existing) continue;
    const binding = existing.record.binding;
    const matches = binding.operationId === operationId
      && binding.operation === operation
      && binding.relative === relative
      && binding.expectedPreimage.exists === (expectedHash !== null)
      && binding.expectedPreimage.hash === expectedHash
      && binding.postimage.hash === postimageHash
      && binding.postimage.bytes === postimageBytes
      && binding.parentRelative === openedParent.parentRelative
      && binding.parentIdentity.device === openedParent.identity.device
      && binding.parentIdentity.inode === openedParent.identity.inode
      && binding.scopeRoot.realPath === openedParent.scope.realRoot
      && binding.scopeRoot.device === openedParent.scope.identity.device
      && binding.scopeRoot.inode === openedParent.scope.identity.inode;
    if (!matches) throw errorWithBlockers('scoped_materialization_operation_definition_conflict', relative);
    if (existing.record.status === 'completed') completion = existing;
  }
  return completion;
}
