import path from 'node:path';

import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { verifyRuntimeRetentionDeletionEvidence }
  from './runtime-retention-scope-repository.mjs';

const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const BASE_KEYS = Object.freeze([
  'version', 'kind', 'status', 'category', 'path', 'contentHash', 'evidenceKind',
  'active', 'referenced', 'releaseDependent', 'recoveryProtected',
  'sourceEvidenceHashes', 'runtimeRetentionDeletionEvidenceHash',
]);
const PUBLISHED_PACKAGE_KEYS = Object.freeze([
  ...BASE_KEYS,
  'packageLifecycleReceiptHash',
  'packageRetentionRecoveryReceiptHash',
  'packageRecoveryDeletionLeaseBindingHash',
  'packageRecoveryTreeInventoryHash',
  'packageRecoveryAuthoritySnapshotHash',
  'storageAuthorityId',
  'storageObjectId',
  'storageObjectVersion',
  'storageObjectBytesHash',
  'retentionLockVersion',
  'retentionLockIdentityHash',
  'retainUntil',
  'storageLedgerReceiptId',
  'storageLedgerReceiptHash',
  'trustStoreHash',
]);
const PACKAGE_EVIDENCE_KINDS = new Set([
  'package_superseded_recovery_verified',
  'package_fenced_staging_generation_verified',
]);
const PUBLISHED_PACKAGE_HASH_FIELDS = Object.freeze([
  'packageLifecycleReceiptHash',
  'packageRetentionRecoveryReceiptHash',
  'packageRecoveryDeletionLeaseBindingHash',
  'packageRecoveryTreeInventoryHash',
  'packageRecoveryAuthoritySnapshotHash',
  'storageObjectBytesHash',
  'retentionLockIdentityHash',
  'storageLedgerReceiptHash',
  'trustStoreHash',
]);
const PUBLISHED_PACKAGE_ID_FIELDS = Object.freeze([
  'storageAuthorityId',
  'storageObjectId',
  'storageObjectVersion',
  'retentionLockVersion',
  'storageLedgerReceiptId',
]);

function boundedIdentifier(value) {
  return typeof value === 'string'
    && value.trim() === value
    && value.length >= 1
    && value.length <= 512
    && ![...value].some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint <= 31 || codePoint === 127;
    });
}

function canonicalTime(value) {
  return typeof value === 'string'
    && Number.isFinite(Date.parse(value))
    && new Date(Date.parse(value)).toISOString() === value;
}

function exactPlainKeys(value, keys) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Reflect.ownKeys(value).every((key) => typeof key === 'string')
    && JSON.stringify(Reflect.ownKeys(value).sort())
      === JSON.stringify([...keys].sort())
    && Reflect.ownKeys(value).every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor?.enumerable === true && Object.hasOwn(descriptor, 'value');
    }));
}

export function assertPackageDeletionAuthorization(authorization, expectedContentHash) {
  const evidence = authorization?.retentionDeletionEvidence;
  const { runtimeRetentionDeletionEvidenceHash = null, ...payload } = evidence || {};
  const sourceHashes = evidence?.sourceEvidenceHashes;
  const publishedPackage = evidence?.evidenceKind
    === 'package_superseded_recovery_verified';
  if (!exactPlainKeys(evidence, publishedPackage ? PUBLISHED_PACKAGE_KEYS : BASE_KEYS)
    || authorization?.authorized !== true
    || authorization.category !== 'packages'
    || evidence.version !== (publishedPackage ? 2 : 1)
    || evidence.kind !== 'RuntimeRetentionDeletionEvidence'
    || evidence.status !== 'retention_deletion_authorized'
    || evidence.category !== 'packages'
    || path.resolve(String(evidence.path || ''))
      !== path.resolve(String(authorization.sourcePath || ''))
    || evidence.contentHash !== expectedContentHash
    || !PACKAGE_EVIDENCE_KINDS.has(evidence.evidenceKind)
    || evidence.active !== false
    || evidence.referenced !== false
    || evidence.releaseDependent !== false
    || evidence.recoveryProtected !== false
    || !Array.isArray(sourceHashes) || sourceHashes.length < 1
    || sourceHashes.some((value) => typeof value !== 'string'
      || !SHA256_PATTERN.test(value))
    || JSON.stringify(sourceHashes) !== JSON.stringify([...new Set(sourceHashes)].sort())
    || (publishedPackage && (
      PUBLISHED_PACKAGE_HASH_FIELDS.some((field) =>
        !SHA256_PATTERN.test(String(evidence[field])))
      || PUBLISHED_PACKAGE_ID_FIELDS.some((field) =>
        !boundedIdentifier(evidence[field]))
      || !canonicalTime(evidence.retainUntil)))
    || typeof runtimeRetentionDeletionEvidenceHash !== 'string'
    || !SHA256_PATTERN.test(runtimeRetentionDeletionEvidenceHash)
    || hashRecord('RuntimeRetentionDeletionEvidence', payload)
      !== runtimeRetentionDeletionEvidenceHash) {
    throw new Error('runtime_retention_package_removal_authorization_invalid');
  }
}

export function revalidatePackageDeletionAuthorization({
  authorization,
  expectedContentHash,
  revalidateAuthorization,
  stage,
  detachedRetentionEntries = [],
}) {
  const sourcePath = path.resolve(String(authorization?.sourcePath || ''));
  const packageRoot = path.dirname(sourcePath);
  const runtimeRoot = path.dirname(packageRoot);
  if (path.basename(packageRoot) !== 'packages'
    || path.dirname(runtimeRoot) === runtimeRoot) {
    throw new Error('runtime_retention_package_removal_authorization_invalid');
  }
  const manifest = revalidateAuthorization({ stage, detachedRetentionEntries });
  const current = verifyRuntimeRetentionDeletionEvidence({
    runtimeRoot,
    category: 'packages',
    entryPath: sourcePath,
    contentHash: expectedContentHash,
    reachabilityManifest: manifest,
  });
  if (!current.authorized
    || current.evidence?.runtimeRetentionDeletionEvidenceHash
      !== authorization.retentionDeletionEvidence
        .runtimeRetentionDeletionEvidenceHash) {
    throw new Error('runtime_retention_package_removal_live_authority_changed');
  }
}
