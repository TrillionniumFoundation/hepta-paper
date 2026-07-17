import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  currentProcessIdentity,
  processIdentityIsStale,
} from '../../workflow-kernel/runtime/process-identity.mjs';
import { readDescriptorFullySync } from '../../workflow-kernel/runtime/file-descriptor-utils.mjs';

function recordError(code, name) {
  const error = new Error(`${code}:${name}`);
  error.code = code;
  error.relativePath = name;
  error.blockers = [];
  return error;
}

export function materializationIdentityFromStat(stat) {
  return Object.freeze({
    device: String(stat.dev),
    inode: String(stat.ino),
    mode: String(stat.mode),
    size: Number(stat.size),
    mtimeNs: String(stat.mtimeNs),
    linkCount: Number(stat.nlink),
  });
}

export function sameMaterializationIdentity(identity, stat) {
  return identity
    && String(stat.dev) === identity.device
    && String(stat.ino) === identity.inode
    && String(stat.mode) === identity.mode
    && Number(stat.size) === identity.size
    && String(stat.mtimeNs) === identity.mtimeNs
    && Number(stat.nlink) === identity.linkCount;
}

export function sameMaterializationEntryIdentity(left, right) {
  return Boolean(left && right && left.device === right.device && left.inode === right.inode);
}

export function sameStableMaterializationEntryIdentity(left, right) {
  return Boolean(sameMaterializationEntryIdentity(left, right)
    && left.mode === right.mode
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs);
}

function normalizedToken(value) {
  const token = String(value ?? '');
  if (!token || token.includes('\0') || Buffer.byteLength(token) > 4096) {
    throw recordError('scoped_materialization_recovery_intent_binding_invalid', '<operationId>');
  }
  return token;
}

export function normalizeScopedMaterializationOperationId(value) {
  return normalizedToken(value);
}

function normalizedRelative(value) {
  const relative = String(value || '').replace(/\\/g, '/');
  const normalized = path.posix.normalize(relative);
  if (!relative || relative.includes('\0') || path.posix.isAbsolute(relative)
    || normalized === '..' || normalized.startsWith('../') || normalized !== relative) {
    throw recordError('scoped_materialization_recovery_intent_binding_invalid', relative || '<empty>');
  }
  return relative;
}

function intentHash(payload) {
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex')}`;
}

function operationKey(operationId) {
  return crypto.createHash('sha256').update(normalizedToken(operationId)).digest('hex');
}

export function scopedMaterializationOperationKey(operationId) {
  return operationKey(operationId);
}

export function scopedMaterializationOperationDefinitionName(operationId) {
  return `.definition-${operationKey(operationId)}.json`;
}

export function scopedMaterializationOperationRecordName(operationId, status, relative) {
  if (!['prepared', 'completed'].includes(status)) {
    throw recordError('scoped_materialization_operation_status_invalid', String(status || '<empty>'));
  }
  const targetKey = crypto.createHash('sha256').update(normalizedRelative(relative)).digest('hex');
  return `.operation-${operationKey(operationId)}-${targetKey}.${status}.json`;
}

export function scopedMaterializationRecoveryEntryName(relative, operationId, suffix, { local = false } = {}) {
  const normalizedPath = normalizedRelative(relative);
  const normalizedId = normalizedToken(operationId);
  const normalizedSuffix = String(suffix || '');
  if (!['preimage', 'removed'].includes(normalizedSuffix)) {
    throw recordError('scoped_materialization_recovery_intent_binding_invalid', normalizedPath);
  }
  const targetName = path.posix.basename(normalizedPath);
  const key = crypto.createHash('sha256')
    .update(`${normalizedId}\0${normalizedPath}\0${normalizedSuffix}`)
    .digest('hex');
  return `${local ? '.' : ''}${targetName}.hepta-${key}.${normalizedSuffix}`;
}

function normalizedIdentity(value, { required = false } = {}) {
  if (!value) {
    if (required) throw recordError('scoped_materialization_operation_definition_invalid', '<identity>');
    return null;
  }
  const identity = {
    device: String(value.device || ''),
    inode: String(value.inode || ''),
    mode: String(value.mode || ''),
    size: Number(value.size),
    mtimeNs: String(value.mtimeNs || ''),
    linkCount: Number(value.linkCount),
  };
  if (!identity.device || !identity.inode || !identity.mode || !identity.mtimeNs
    || !Number.isSafeInteger(identity.size) || identity.size < 0
    || !Number.isSafeInteger(identity.linkCount) || identity.linkCount < 1) {
    throw recordError('scoped_materialization_operation_definition_invalid', '<identity>');
  }
  return Object.freeze(identity);
}

function normalizedSnapshot(value, { requiredIdentity = false } = {}) {
  const exists = Boolean(value?.exists);
  if (exists && (typeof value?.hash !== 'string' || !Number.isSafeInteger(Number(value?.bytes)))) {
    throw recordError('scoped_materialization_operation_definition_invalid', '<snapshot>');
  }
  if (!exists && value?.hash !== null) {
    throw recordError('scoped_materialization_operation_definition_invalid', '<snapshot>');
  }
  return Object.freeze({
    exists,
    hash: value?.hash ?? null,
    bytes: exists ? Number(value?.bytes) : 0,
    identity: exists ? normalizedIdentity(value?.identity, { required: requiredIdentity }) : null,
  });
}

function scopedMaterializationSemanticDefinition({
  operationId,
  operation,
  relative,
  expectedPreimage,
  postimage,
} = {}) {
  const normalizedId = normalizedToken(operationId);
  const normalizedPath = normalizedRelative(relative);
  if (!['replace', 'remove'].includes(operation)) {
    throw recordError('scoped_materialization_operation_definition_invalid', normalizedPath);
  }
  const expected = normalizedSnapshot(expectedPreimage);
  const persisted = normalizedSnapshot(postimage);
  if (operation === 'replace' && !persisted.exists) {
    throw recordError('scoped_materialization_operation_definition_invalid', normalizedPath);
  }
  if (operation === 'remove' && persisted.exists) {
    throw recordError('scoped_materialization_operation_definition_invalid', normalizedPath);
  }
  return Object.freeze({
    operationId: normalizedId,
    operation,
    relative: normalizedPath,
    expectedPreimage: Object.freeze({
      exists: expected.exists,
      hash: expected.hash,
      bytes: expected.bytes,
    }),
    postimage: Object.freeze({
      exists: persisted.exists,
      hash: persisted.hash,
      bytes: persisted.bytes,
    }),
  });
}

export function buildScopedMaterializationOperationDefinitionRecord(definition = {}) {
  const semanticDefinition = scopedMaterializationSemanticDefinition(definition);
  const payload = {
    version: 1,
    kind: 'ScopedMaterializationOperationDefinition',
    definition: semanticDefinition,
    definitionHash: intentHash(semanticDefinition),
  };
  return Object.freeze({
    ...payload,
    scopedMaterializationOperationDefinitionHash: intentHash(payload),
  });
}

export function verifyScopedMaterializationOperationDefinitionRecord(record, name) {
  const { scopedMaterializationOperationDefinitionHash: claimed, ...payload } = record || {};
  if (!claimed || intentHash(payload) !== claimed
    || payload.version !== 1
    || payload.kind !== 'ScopedMaterializationOperationDefinition') {
    throw recordError('scoped_materialization_operation_definition_unsafe', name);
  }
  const definition = scopedMaterializationSemanticDefinition(payload.definition);
  if (name !== scopedMaterializationOperationDefinitionName(definition.operationId)
    || payload.definitionHash !== intentHash(definition)) {
    throw recordError('scoped_materialization_operation_definition_unsafe', name);
  }
  return Object.freeze({ ...record, definition });
}

function scopedMaterializationOperationBinding({
  operationId,
  operation,
  relative,
  expectedPreimage,
  postimage,
  parentRelative,
  parentIdentity,
  scopeRoot,
  stagedPostimageIdentity,
} = {}) {
  const normalizedId = normalizedToken(operationId);
  const normalizedPath = normalizedRelative(relative);
  if (!['replace', 'remove'].includes(operation)) {
    throw recordError('scoped_materialization_operation_definition_invalid', normalizedPath);
  }
  const expected = normalizedSnapshot(expectedPreimage, { requiredIdentity: Boolean(expectedPreimage?.exists) });
  const persisted = normalizedSnapshot({
    ...postimage,
    identity: postimage?.exists ? stagedPostimageIdentity : null,
  }, { requiredIdentity: Boolean(postimage?.exists) });
  if (operation === 'remove' && persisted.exists) {
    throw recordError('scoped_materialization_operation_definition_invalid', normalizedPath);
  }
  return Object.freeze({
    operationId: normalizedId,
    operation,
    relative: normalizedPath,
    expectedPreimage: expected,
    postimage: persisted,
    parentRelative: String(parentRelative || ''),
    parentIdentity: Object.freeze({
      device: String(parentIdentity?.device || ''),
      inode: String(parentIdentity?.inode || ''),
      mode: String(parentIdentity?.mode || ''),
    }),
    scopeRoot: Object.freeze({
      realPath: String(scopeRoot?.realPath || ''),
      device: String(scopeRoot?.device || ''),
      inode: String(scopeRoot?.inode || ''),
      mode: String(scopeRoot?.mode || ''),
    }),
  });
}

export function buildScopedMaterializationOperationRecord({ status, ...definition } = {}) {
  if (!['prepared', 'completed'].includes(status)) {
    throw recordError('scoped_materialization_operation_status_invalid', String(status || '<empty>'));
  }
  const binding = scopedMaterializationOperationBinding(definition);
  const payload = {
    version: 2,
    kind: 'ScopedMaterializationOperationRecord',
    status,
    binding,
    bindingHash: intentHash(binding),
    preimage: definition.preimage,
    targetName: definition.targetName,
    token: binding.operationId,
    recoveryEntryName: definition.recoveryEntryName,
    recoveryEntryIdentity: definition.recoveryEntryIdentity ?? null,
    localPreimageName: definition.localPreimageName ?? null,
    localPreimageIdentity: definition.localPreimageIdentity ?? null,
    temporaryName: definition.temporaryName ?? null,
    stagedPostimageIdentity: definition.stagedPostimageIdentity ?? null,
    targetLockName: definition.targetLockName,
    targetLockIdentity: definition.targetLockIdentity,
    owner: definition.owner,
    completedPostimageIdentity: definition.completedPostimageIdentity ?? null,
  };
  return Object.freeze({ ...payload, scopedMaterializationOperationRecordHash: intentHash(payload) });
}

export function verifyScopedMaterializationOperationRecord(record, name, expectedStatus = null) {
  const { scopedMaterializationOperationRecordHash: claimed, ...payload } = record || {};
  if (!claimed || intentHash(payload) !== claimed
    || payload.version !== 2 || payload.kind !== 'ScopedMaterializationOperationRecord'
    || !['prepared', 'completed'].includes(payload.status)
    || (expectedStatus && payload.status !== expectedStatus)) {
    throw recordError('scoped_materialization_operation_record_unsafe', name);
  }
  const binding = scopedMaterializationOperationBinding({
    ...payload.binding,
    stagedPostimageIdentity: payload.binding?.postimage?.identity,
  });
  if (intentHash(binding) !== payload.bindingHash
    || name !== scopedMaterializationOperationRecordName(binding.operationId, payload.status, binding.relative)
    || payload.token !== binding.operationId
    || payload.targetName !== path.posix.basename(binding.relative)
    || (payload.localPreimageName !== null
      && payload.localPreimageName !== scopedMaterializationRecoveryEntryName(
        binding.relative,
        binding.operationId,
        binding.operation === 'remove' ? 'removed' : 'preimage',
        { local: true },
      ))
    || JSON.stringify(normalizedSnapshot(payload.preimage, {
      requiredIdentity: Boolean(binding.expectedPreimage.exists),
    })) !== JSON.stringify(binding.expectedPreimage)
    || JSON.stringify(normalizedIdentity(payload.stagedPostimageIdentity, {
      required: Boolean(binding.postimage.exists),
    })) !== JSON.stringify(binding.postimage.identity)) {
    throw recordError('scoped_materialization_operation_binding_invalid', binding.relative);
  }
  return Object.freeze({ ...record, binding });
}

export function currentMaterializationLockOwnerIdentity() {
  return currentProcessIdentity();
}

export function materializationLockOwnerIsStale(owner = {}) {
  return processIdentityIsStale(owner);
}

export function readMaterializationJsonRecordSync({ candidate, name, maximumBytes, unsafeCode, allowedLinkCounts = [1] } = {}) {
  let descriptor;
  try {
    descriptor = fs.openSync(candidate, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const before = fs.fstatSync(descriptor, { bigint: true });
    if (!before.isFile() || !allowedLinkCounts.includes(Number(before.nlink)) || Number(before.size) > maximumBytes) {
      throw recordError(unsafeCode, name);
    }
    const { buffer, bytesRead } = readDescriptorFullySync(descriptor, Number(before.size));
    const after = fs.fstatSync(descriptor, { bigint: true });
    if (bytesRead !== buffer.length || !sameMaterializationIdentity(materializationIdentityFromStat(before), after)) throw recordError(unsafeCode, name);
    let record;
    try { record = JSON.parse(buffer.toString('utf8')); }
    catch { throw recordError(unsafeCode, name); }
    return Object.freeze({ record, identity: materializationIdentityFromStat(before) });
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

export function readMaterializationTargetLockRecordSync({ candidate, name, maximumBytes } = {}) {
  let descriptor;
  try {
    descriptor = fs.openSync(candidate, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const before = fs.fstatSync(descriptor, { bigint: true });
    if (!before.isFile() || Number(before.nlink) < 1 || Number(before.nlink) > 2 || Number(before.size) > maximumBytes) {
      throw recordError('scoped_materialization_destination_lock_unsafe', name);
    }
    const { buffer, bytesRead } = readDescriptorFullySync(descriptor, Number(before.size));
    const after = fs.fstatSync(descriptor, { bigint: true });
    if (bytesRead !== buffer.length || !sameMaterializationIdentity(materializationIdentityFromStat(before), after)) {
      throw recordError('scoped_materialization_destination_lock_changed', name);
    }
    let record;
    try { record = JSON.parse(buffer.toString('utf8')); }
    catch { throw recordError('scoped_materialization_destination_lock_unsafe', name); }
    const token = typeof record?.token === 'string' ? record.token : '';
    if (!token || token !== String(token).replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 180)) {
      throw recordError('scoped_materialization_destination_lock_unsafe', name);
    }
    return Object.freeze({
      identity: materializationIdentityFromStat(before),
      raw: buffer.toString('utf8'),
      record: Object.freeze({
        version: Number(record.version),
        token,
        owner: Object.freeze({
          pid: Number(record?.owner?.pid ?? record?.pid),
          pidStartTime: record?.owner?.pidStartTime ?? null,
        }),
        temporaryIdentity: record?.temporaryIdentity && typeof record.temporaryIdentity === 'object'
          ? normalizedIdentity(record.temporaryIdentity)
          : null,
        temporaryEntryIdentity: record?.temporaryEntryIdentity && typeof record.temporaryEntryIdentity === 'object'
          ? normalizedIdentity(record.temporaryEntryIdentity)
          : null,
        ownerEntryName: typeof record?.ownerEntryName === 'string' && !record.ownerEntryName.includes('/') && !record.ownerEntryName.includes('\\')
          ? record.ownerEntryName
          : null,
        stageEntryName: typeof record?.stageEntryName === 'string' && !record.stageEntryName.includes('/') && !record.stageEntryName.includes('\\')
          ? record.stageEntryName
          : null,
        operationId: typeof record?.operationId === 'string' ? record.operationId : null,
      }),
    });
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}
