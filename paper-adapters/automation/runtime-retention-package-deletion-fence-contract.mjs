import path from 'node:path';

import { hasExactPlainObjectKeys }
  from '../../workflow-kernel/exact-object-keys.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const SHA256 = /^sha256:[a-f0-9]{64}$/;
const OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{1,191}$/;

export const PACKAGE_DELETION_FENCE_STATUSES = Object.freeze([
  'prepared',
  'deleting',
  'deleted',
  'aborted',
]);

const STATUS = new Set(PACKAGE_DELETION_FENCE_STATUSES);
const RECORD_KEYS = Object.freeze([
  'abortReasonHash',
  'abortedAt',
  'authoritySnapshotHash',
  'deletedAt',
  'deletingAt',
  'deletionIntentHash',
  'fenceTokenHash',
  'generation',
  'kind',
  'operationId',
  'packageContentHash',
  'packageLifecycleReceiptHash',
  'packagePath',
  'preparedAt',
  'previousFenceHash',
  'recoveryBindingHash',
  'revision',
  'runtimeRetentionPackageDeletionFenceHash',
  'runtimeRoot',
  'status',
  'transitionId',
  'updatedAt',
  'version',
]);

function validHash(value) {
  return typeof value === 'string' && SHA256.test(value);
}

function canonicalTime(value) {
  return typeof value === 'string'
    && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString() === value;
}

function canonicalPackageBinding(runtimeRoot, packagePath) {
  if (![runtimeRoot, packagePath].every((value) => typeof value === 'string'
    && value.length > 0 && path.isAbsolute(value))) return false;
  const root = path.resolve(runtimeRoot);
  const candidate = path.resolve(packagePath);
  return root === runtimeRoot
    && candidate === packagePath
    && path.dirname(candidate) === path.join(root, 'packages');
}

function nullOrHash(value) {
  return value === null || validHash(value);
}

function nullOrTime(value) {
  return value === null || canonicalTime(value);
}

function stateShape(record) {
  const prepared = canonicalTime(record.preparedAt);
  const deleting = nullOrTime(record.deletingAt);
  const deleted = nullOrTime(record.deletedAt);
  const aborted = nullOrTime(record.abortedAt);
  if (!prepared || !deleting || !deleted || !aborted) return false;
  const preparedMs = Date.parse(record.preparedAt);
  const ordered = [record.deletingAt, record.deletedAt, record.abortedAt]
    .filter(Boolean).every((value) => Date.parse(value) >= preparedMs);
  if (!ordered || Date.parse(record.updatedAt) < preparedMs) return false;
  if (record.status === 'prepared') {
    return record.deletingAt === null && record.deletedAt === null
      && record.abortedAt === null && record.abortReasonHash === null;
  }
  if (record.status === 'deleting') {
    return record.deletingAt !== null && record.deletedAt === null
      && record.abortedAt === null && record.abortReasonHash === null
      && record.updatedAt === record.deletingAt;
  }
  if (record.status === 'deleted') {
    return record.deletingAt !== null && record.deletedAt !== null
      && record.abortedAt === null && record.abortReasonHash === null
      && Date.parse(record.deletedAt) >= Date.parse(record.deletingAt)
      && record.updatedAt === record.deletedAt;
  }
  return record.status === 'aborted'
    && record.deletedAt === null && record.abortedAt !== null
    && validHash(record.abortReasonHash)
    && (record.deletingAt === null
      || Date.parse(record.abortedAt) >= Date.parse(record.deletingAt))
    && record.updatedAt === record.abortedAt;
}

export function packageDeletionFenceTokenHash(token) {
  if (typeof token !== 'string' || token.length < 32 || token.length > 512) {
    throw new Error('runtime_retention_package_deletion_fence_token_invalid');
  }
  return hashRecord('RuntimeRetentionPackageDeletionFenceToken', { token });
}

export function verifyRuntimeRetentionPackageDeletionFence(record) {
  const blockers = [];
  const { runtimeRetentionPackageDeletionFenceHash = null, ...payload } = record || {};
  if (!hasExactPlainObjectKeys(record, RECORD_KEYS)
    || record?.version !== 1
    || record.kind !== 'RuntimeRetentionPackageDeletionFence'
    || !STATUS.has(record.status)
    || !canonicalPackageBinding(record.runtimeRoot, record.packagePath)
    || !validHash(record.packageLifecycleReceiptHash)
    || !validHash(record.packageContentHash)
    || !validHash(record.deletionIntentHash)
    || !validHash(record.recoveryBindingHash)
    || !validHash(record.authoritySnapshotHash)
    || !OPERATION_ID.test(String(record.operationId || ''))
    || !Number.isSafeInteger(record.generation) || record.generation < 1
    || !Number.isSafeInteger(record.revision) || record.revision < 1
    || !validHash(record.fenceTokenHash)
    || !validHash(record.transitionId)
    || !nullOrHash(record.previousFenceHash)
    || !canonicalTime(record.updatedAt)
    || !stateShape(record)
    || !validHash(runtimeRetentionPackageDeletionFenceHash)
    || hashRecord('RuntimeRetentionPackageDeletionFence', payload)
      !== runtimeRetentionPackageDeletionFenceHash) {
    blockers.push('runtime_retention_package_deletion_fence_invalid');
  }
  return Object.freeze({
    valid: blockers.length === 0,
    blockers: Object.freeze(blockers),
  });
}

function assertValid(record) {
  if (!verifyRuntimeRetentionPackageDeletionFence(record).valid) {
    throw new Error('runtime_retention_package_deletion_fence_invalid');
  }
  return record;
}

function seal(payload) {
  const record = Object.freeze({
    ...payload,
    runtimeRetentionPackageDeletionFenceHash: hashRecord(
      'RuntimeRetentionPackageDeletionFence',
      payload,
    ),
  });
  return assertValid(record);
}

export function createPreparedPackageDeletionFence({
  runtimeRoot,
  packageLifecycleReceiptHash,
  packagePath,
  packageContentHash,
  deletionIntentHash,
  recoveryBindingHash,
  authoritySnapshotHash,
  operationId,
  generation,
  fenceTokenHash,
  transitionId,
  previousFenceHash = null,
  preparedAt,
} = {}) {
  return seal({
    version: 1,
    kind: 'RuntimeRetentionPackageDeletionFence',
    status: 'prepared',
    runtimeRoot: path.resolve(String(runtimeRoot || '')),
    packageLifecycleReceiptHash,
    packagePath: path.resolve(String(packagePath || '')),
    packageContentHash,
    deletionIntentHash,
    recoveryBindingHash,
    authoritySnapshotHash,
    operationId,
    generation: Number(generation),
    revision: 1,
    fenceTokenHash,
    transitionId,
    previousFenceHash,
    preparedAt,
    deletingAt: null,
    deletedAt: null,
    abortedAt: null,
    abortReasonHash: null,
    updatedAt: preparedAt,
  });
}

function transitionAllowed(from, to) {
  return (from === 'prepared' && ['deleting', 'aborted'].includes(to))
    || (from === 'deleting' && ['deleted', 'aborted'].includes(to));
}

export function transitionPackageDeletionFence(record, {
  status,
  transitionedAt,
  transitionId,
  abortReasonHash = null,
} = {}) {
  assertValid(record);
  if (!transitionAllowed(record.status, status)
    || !validHash(transitionId)
    || !canonicalTime(transitionedAt)
    || Date.parse(transitionedAt) < Date.parse(record.updatedAt)
    || (status === 'aborted' ? !validHash(abortReasonHash) : abortReasonHash !== null)) {
    throw new Error('runtime_retention_package_deletion_fence_transition_invalid');
  }
  return seal({
    ...record,
    status,
    revision: record.revision + 1,
    transitionId,
    previousFenceHash: record.runtimeRetentionPackageDeletionFenceHash,
    deletingAt: status === 'deleting' ? transitionedAt : record.deletingAt,
    deletedAt: status === 'deleted' ? transitionedAt : null,
    abortedAt: status === 'aborted' ? transitionedAt : null,
    abortReasonHash: status === 'aborted' ? abortReasonHash : null,
    updatedAt: transitionedAt,
    runtimeRetentionPackageDeletionFenceHash: undefined,
  });
}

export function samePackageDeletionFenceBinding(left, right) {
  return Boolean(left && right && [
    'runtimeRoot',
    'packageLifecycleReceiptHash',
    'packagePath',
    'packageContentHash',
    'deletionIntentHash',
    'recoveryBindingHash',
    'authoritySnapshotHash',
    'operationId',
  ].every((field) => left[field] === right[field]));
}
