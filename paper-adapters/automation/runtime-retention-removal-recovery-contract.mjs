import path from 'node:path';

import { hasExactPlainObjectKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  DEFAULT_RETENTION_POLICIES,
  runtimeRetentionCategoryRoot,
} from './runtime-retention-scope-repository.mjs';

const SHA256 = /^sha256:[a-f0-9]{64}$/;
const QUARANTINE_NAME = /^\.hepta-retention-[a-f0-9]{40}\.quarantine$/;
const RETENTION_CATEGORIES = new Set(Object.keys(DEFAULT_RETENTION_POLICIES));
const BINDING_KEYS = Object.freeze([
  'operationId', 'runtimeRoot', 'runtimeRetentionIntentReceiptHash',
  'entryIndex', 'memberIndex', 'category', 'sourcePath', 'quarantineName',
  'contentHash', 'memberIdentityHash', 'memberDevice', 'memberInode',
  'memberMode', 'memberSize', 'memberMtimeNs', 'memberNlink', 'memberEntryKind',
  'memberRealPath',
]);
const JOURNAL_KEYS = Object.freeze([
  'version', 'kind', 'status', 'binding', 'bindingHash', 'rollbackName',
  'stageDevice', 'stageInode',
  'runtimeRetentionRemovalRecoveryJournalHash',
]);
const MUTATION_KEYS = Object.freeze([
  'version', 'kind', 'status', 'bindingHash', 'sourceTreeIdentityHash',
  'runtimeRetentionRemovalMutationMarkerHash',
]);

function exactKeys(value, keys) {
  return hasExactPlainObjectKeys(value, keys);
}

function validHash(value) {
  return typeof value === 'string' && SHA256.test(value);
}

function validIndex(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function within(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative && relative !== '..' && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

function canonicalDecimal(value) {
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]*)$/.test(value)) return false;
  try { return String(BigInt(value)) === value; } catch { return false; }
}

export function verifyRetentionRemovalRecoveryBinding(binding) {
  if (!exactKeys(binding, BINDING_KEYS)
    || typeof binding.operationId !== 'string' || !binding.operationId
    || !validIndex(binding.entryIndex) || !validIndex(binding.memberIndex)
    || !validHash(binding.runtimeRetentionIntentReceiptHash)
    || !validHash(binding.contentHash) || !validHash(binding.memberIdentityHash)
    || !RETENTION_CATEGORIES.has(binding.category)
    || !QUARANTINE_NAME.test(String(binding.quarantineName || ''))
    || !path.isAbsolute(binding.runtimeRoot)
    || path.resolve(binding.runtimeRoot) !== binding.runtimeRoot
    || binding.runtimeRoot === path.parse(binding.runtimeRoot).root
    || !path.isAbsolute(binding.sourcePath)
    || path.resolve(binding.sourcePath) !== binding.sourcePath
    || !within(binding.runtimeRoot, binding.sourcePath)
    || path.dirname(binding.sourcePath)
      !== runtimeRetentionCategoryRoot(binding.runtimeRoot, binding.category)
    || binding.memberRealPath !== binding.sourcePath
    || !canonicalDecimal(binding.memberDevice)
    || !canonicalDecimal(binding.memberInode)
    || !canonicalDecimal(binding.memberMode)
    || !canonicalDecimal(binding.memberSize)
    || !canonicalDecimal(binding.memberMtimeNs)
    || !canonicalDecimal(binding.memberNlink)
    || !['directory', 'file'].includes(binding.memberEntryKind)) {
    throw new Error('runtime_retention_removal_recovery_binding_invalid');
  }
  return binding;
}

export function retentionRemovalRecoveryBindingForIntent(
  intent,
  entry,
  entryIndex,
  member,
  memberIndex,
) {
  if (entry?.authorized !== true || !member?.identity) {
    throw new Error('runtime_retention_removal_recovery_binding_invalid');
  }
  return Object.freeze(verifyRetentionRemovalRecoveryBinding({
    operationId: intent?.operationId,
    runtimeRoot: path.resolve(String(intent?.runtimeRoot || '')),
    runtimeRetentionIntentReceiptHash: intent?.runtimeRetentionIntentReceiptHash,
    entryIndex,
    memberIndex,
    category: entry.category,
    sourcePath: path.resolve(String(member.path || '')),
    quarantineName: member.quarantineName,
    contentHash: member.contentHash,
    memberIdentityHash: hashRecord('RuntimeRetentionMemberIdentity', member.identity),
    memberDevice: String(member.identity.dev || ''),
    memberInode: String(member.identity.ino || ''),
    memberMode: String(member.identity.mode || ''),
    memberSize: String(member.identity.size || ''),
    memberMtimeNs: String(member.identity.mtimeNs || ''),
    memberNlink: String(member.identity.nlink || ''),
    memberEntryKind: member.identity.entryKind,
    memberRealPath: path.resolve(String(member.identity.realPath || '')),
  }));
}

export function retentionRemovalRecoveryStageName(binding) {
  verifyRetentionRemovalRecoveryBinding(binding);
  return `.hepta-retention-delete-${hashRecord(
    'RuntimeRetentionRemovalRecoveryBinding',
    binding,
  ).slice(7, 47)}`;
}

function createRecoveryJournal(binding, stageIdentity, status, rollbackName) {
  verifyRetentionRemovalRecoveryBinding(binding);
  const stageDevice = String(stageIdentity?.dev ?? '');
  const stageInode = String(stageIdentity?.ino ?? '');
  if (!/^\d+$/.test(stageDevice) || !/^\d+$/.test(stageInode)) {
    throw new Error('runtime_retention_removal_recovery_journal_invalid');
  }
  const payload = {
    version: 1,
    kind: 'RuntimeRetentionRemovalRecoveryJournal',
    status,
    binding,
    bindingHash: hashRecord('RuntimeRetentionRemovalRecoveryBinding', binding),
    rollbackName,
    stageDevice,
    stageInode,
  };
  return Object.freeze({
    ...payload,
    runtimeRetentionRemovalRecoveryJournalHash: hashRecord(
      'RuntimeRetentionRemovalRecoveryJournal',
      payload,
    ),
  });
}

export function createRetentionRemovalPreparingJournal(binding, stageIdentity) {
  return createRecoveryJournal(
    binding,
    stageIdentity,
    'runtime_retention_removal_preparing',
    'rollback.preparing',
  );
}

export function createRetentionRemovalRecoveryJournal(binding, stageIdentity) {
  return createRecoveryJournal(
    binding,
    stageIdentity,
    'runtime_retention_removal_rollback_ready',
    'rollback',
  );
}

export function verifyRetentionRemovalRecoveryJournal(
  journal,
  expectedBinding,
  expectedStageIdentity,
  { expectedStatus = 'runtime_retention_removal_rollback_ready' } = {},
) {
  verifyRetentionRemovalRecoveryBinding(expectedBinding);
  const { runtimeRetentionRemovalRecoveryJournalHash: journalHash, ...payload } = journal || {};
  if (!exactKeys(journal, JOURNAL_KEYS)
    || journal.version !== 1
    || journal.kind !== 'RuntimeRetentionRemovalRecoveryJournal'
    || ![
      'runtime_retention_removal_preparing',
      'runtime_retention_removal_rollback_ready',
    ].includes(journal.status)
    || (expectedStatus !== null && journal.status !== expectedStatus)
    || journal.rollbackName !== (journal.status === 'runtime_retention_removal_preparing'
      ? 'rollback.preparing' : 'rollback')
    || journal.stageDevice !== String(expectedStageIdentity?.dev ?? '')
    || journal.stageInode !== String(expectedStageIdentity?.ino ?? '')
    || !exactKeys(journal.binding, BINDING_KEYS)
    || JSON.stringify(journal.binding) !== JSON.stringify(expectedBinding)
    || journal.bindingHash !== hashRecord(
      'RuntimeRetentionRemovalRecoveryBinding',
      expectedBinding,
    )
    || journalHash !== hashRecord('RuntimeRetentionRemovalRecoveryJournal', payload)) {
    throw new Error('runtime_retention_removal_recovery_journal_invalid');
  }
  return journal;
}

export function createRetentionRemovalMutationMarker(
  binding,
  { sourceTreeIdentityHash = null } = {},
) {
  verifyRetentionRemovalRecoveryBinding(binding);
  if (sourceTreeIdentityHash !== null && !validHash(sourceTreeIdentityHash)) {
    throw new Error('runtime_retention_removal_mutation_marker_invalid');
  }
  const payload = {
    version: 1,
    kind: 'RuntimeRetentionRemovalMutationMarker',
    status: 'runtime_retention_removal_mutation_started',
    bindingHash: hashRecord('RuntimeRetentionRemovalRecoveryBinding', binding),
    sourceTreeIdentityHash,
  };
  return Object.freeze({
    ...payload,
    runtimeRetentionRemovalMutationMarkerHash: hashRecord(
      'RuntimeRetentionRemovalMutationMarker',
      payload,
    ),
  });
}

export function verifyRetentionRemovalMutationMarker(marker, expectedBinding) {
  verifyRetentionRemovalRecoveryBinding(expectedBinding);
  const { runtimeRetentionRemovalMutationMarkerHash: markerHash, ...payload } = marker || {};
  if (!exactKeys(marker, MUTATION_KEYS)
    || marker.version !== 1
    || marker.kind !== 'RuntimeRetentionRemovalMutationMarker'
    || marker.status !== 'runtime_retention_removal_mutation_started'
    || marker.bindingHash !== hashRecord(
      'RuntimeRetentionRemovalRecoveryBinding',
      expectedBinding,
    )
    || (marker.sourceTreeIdentityHash !== null
      && !validHash(marker.sourceTreeIdentityHash))
    || markerHash !== hashRecord('RuntimeRetentionRemovalMutationMarker', payload)) {
    throw new Error('runtime_retention_removal_mutation_marker_invalid');
  }
  return marker;
}
