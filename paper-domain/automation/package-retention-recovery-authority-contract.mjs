import { hasExactPlainObjectKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { verifyPackageLifecycleReceipt } from './package-lifecycle-receipt-contract.mjs';
import {
  verifyPackageExactRestoreExecutionProof,
  verifyPackageImmutableRecoverySourceAuthority,
  verifyPackageRecoveryRetentionPolicy,
  verifyTrustedPackageRecoveryStorageProof,
} from './package-retention-recovery-proof-contract.mjs';

export {
  createPackageExactRestoreExecutionProof,
  createPackageImmutableRecoverySourceAuthority,
  createPackageRecoveryRetentionPolicy,
  createPackageRecoveryStorageAuthorityProof,
  packageRecoveryStorageAuthoritySubjectHash,
  verifyPackageExactRestoreExecutionProof,
  verifyPackageImmutableRecoverySourceAuthority,
  verifyPackageRecoveryRetentionPolicy,
  verifyPackageRecoveryStorageAuthorityProof,
} from './package-retention-recovery-proof-contract.mjs';

const SHA256 = /^sha256:[a-f0-9]{64}$/;

const RESTORE_DRILL_KEYS = Object.freeze([
  'version', 'kind', 'status', 'runtimeRoot', 'paperId', 'packagePath',
  'packageContentHash', 'packageLifecycleReceiptHash', 'packageReleaseIdentityHash',
  'packageImmutableRecoverySourceAuthorityHash',
  'packageRecoveryStorageAuthorityProofHash', 'storageAuthorityId',
  'storageObjectId', 'storageObjectVersion', 'storageObjectPath',
  'storageObjectBytesHash', 'storageLedgerReceiptId', 'storageLedgerReceiptHash',
  'trustStoreHash', 'sourceInventoryHash', 'packageRecoveryTreeInventoryHash',
  'retentionLockVersion', 'retentionLockIdentityHash', 'retainUntil',
  'restoreExecutionProof', 'packageExactRestoreExecutionProofHash',
  'restoreTargetPath', 'restoreTargetIdentityHash', 'expectedPackageContentHash',
  'restoredPackageContentHash', 'productionPackageIdentityHashBefore',
  'productionPackageIdentityHashAfter', 'productionPackageContentHashBefore',
  'productionPackageContentHashAfter', 'blockers', 'productionPackageMutated',
  'expectedPackageRecoveryTreeInventoryHash',
  'restoredPackageRecoveryTreeInventoryHash',
  'productionPackageRecoveryTreeInventoryHashBefore',
  'productionPackageRecoveryTreeInventoryHashAfter',
  'performedAt', 'externalActionPerformed', 'packageExactRestoreDrillReceiptHash',
]);

const RETENTION_RECOVERY_KEYS = Object.freeze([
  'version', 'kind', 'status', 'runtimeRoot', 'paperId', 'packagePath',
  'packageContentHash', 'packageLifecycleReceiptHash', 'packageReleaseIdentityHash',
  'recoverySourceAuthority', 'packageImmutableRecoverySourceAuthorityHash',
  'restoreDrillReceipt', 'packageExactRestoreDrillReceiptHash',
  'packageRecoveryStorageAuthorityProofHash', 'storageAuthorityId',
  'storageObjectId', 'storageObjectVersion', 'storageObjectPath',
  'storageObjectBytesHash', 'storageLedgerReceiptId', 'storageLedgerReceiptHash',
  'trustStoreHash', 'sourceInventoryHash', 'packageRecoveryTreeInventoryHash',
  'expectedPackageRecoveryTreeInventoryHash',
  'restoredPackageRecoveryTreeInventoryHash',
  'productionPackageRecoveryTreeInventoryHashBefore',
  'productionPackageRecoveryTreeInventoryHashAfter',
  'retentionPolicy', 'packageRecoveryRetentionPolicyHash',
  'retentionLockVersion', 'retentionLockIdentityHash', 'retainUntil', 'recordedAt',
  'externalActionPerformed', 'packageRetentionRecoveryReceiptHash',
]);

function nonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function validHash(value) {
  return typeof value === 'string' && SHA256.test(value);
}

function canonicalTime(value) {
  const milliseconds = Date.parse(String(value || ''));
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function strictlyAfter(value, lowerBound) {
  return canonicalTime(value) && typeof lowerBound === 'string'
    && Number.isFinite(Date.parse(lowerBound))
    && Date.parse(value) > Date.parse(lowerBound);
}

function canonicalAbsolutePath(value) {
  return nonEmpty(value)
    && value.startsWith('/')
    && value !== '/'
    && !value.includes('\0')
    && !value.includes('//')
    && !value.endsWith('/')
    && !value.split('/').some((component) => component === '.' || component === '..');
}

function exactEmptyArray(value) {
  return Array.isArray(value) && value.length === 0;
}

function exactKeys(value, keys) {
  return hasExactPlainObjectKeys(value, [...keys].sort());
}

function result(blockers, details = {}) {
  return Object.freeze({
    valid: blockers.length === 0,
    ...details,
    blockers: Object.freeze([...new Set(blockers)]),
  });
}

export function createPackageExactRestoreDrillReceipt({
  lifecycleReceipt,
  recoverySourceAuthority,
  restoreExecutionProof,
  trustedStorageAuthorityVerifier,
  trustedRestoreDrillVerifier,
} = {}) {
  const source = verifyPackageImmutableRecoverySourceAuthority(recoverySourceAuthority, {
    lifecycleReceipt,
    trustedStorageAuthorityVerifier,
  });
  const execution = verifyPackageExactRestoreExecutionProof(restoreExecutionProof, {
    recoverySourceAuthority,
  });
  if (!source.valid || !execution.valid
    || !verifyTrustedPackageRecoveryStorageProof(
      trustedRestoreDrillVerifier,
      restoreExecutionProof,
      { lifecycleReceipt, recoverySourceAuthority },
    )) {
    throw new Error('package_exact_restore_drill_receipt_invalid');
  }
  const payload = {
    version: 2,
    kind: 'PackageExactRestoreDrillReceipt',
    status: 'package_exact_predecessor_restore_drill_passed',
    runtimeRoot: lifecycleReceipt.runtimeRoot,
    paperId: lifecycleReceipt.releaseIdentity.paperId,
    packagePath: lifecycleReceipt.packagePath,
    packageContentHash: lifecycleReceipt.packageContentHash,
    packageLifecycleReceiptHash: lifecycleReceipt.packageLifecycleReceiptHash,
    packageReleaseIdentityHash: lifecycleReceipt.packageReleaseIdentityHash,
    packageImmutableRecoverySourceAuthorityHash:
      recoverySourceAuthority.packageImmutableRecoverySourceAuthorityHash,
    packageRecoveryStorageAuthorityProofHash:
      recoverySourceAuthority.packageRecoveryStorageAuthorityProofHash,
    storageAuthorityId: recoverySourceAuthority.storageAuthorityId,
    storageObjectId: recoverySourceAuthority.storageObjectId,
    storageObjectVersion: recoverySourceAuthority.storageObjectVersion,
    storageObjectPath: recoverySourceAuthority.storageObjectPath,
    storageObjectBytesHash: recoverySourceAuthority.storageObjectBytesHash,
    storageLedgerReceiptId: recoverySourceAuthority.storageLedgerReceiptId,
    storageLedgerReceiptHash: recoverySourceAuthority.storageLedgerReceiptHash,
    trustStoreHash: recoverySourceAuthority.trustStoreHash,
    sourceInventoryHash: recoverySourceAuthority.sourceInventoryHash,
    packageRecoveryTreeInventoryHash:
      recoverySourceAuthority.packageRecoveryTreeInventoryHash,
    retentionLockVersion: recoverySourceAuthority.retentionLockVersion,
    retentionLockIdentityHash: recoverySourceAuthority.retentionLockIdentityHash,
    retainUntil: recoverySourceAuthority.retainUntil,
    restoreExecutionProof,
    packageExactRestoreExecutionProofHash:
      restoreExecutionProof.packageExactRestoreExecutionProofHash,
    restoreTargetPath: restoreExecutionProof.restoreTargetPath,
    restoreTargetIdentityHash: restoreExecutionProof.restoreTargetIdentityHash,
    expectedPackageContentHash: restoreExecutionProof.expectedPackageContentHash,
    restoredPackageContentHash: restoreExecutionProof.restoredPackageContentHash,
    expectedPackageRecoveryTreeInventoryHash:
      restoreExecutionProof.expectedPackageRecoveryTreeInventoryHash,
    restoredPackageRecoveryTreeInventoryHash:
      restoreExecutionProof.restoredPackageRecoveryTreeInventoryHash,
    productionPackageIdentityHashBefore:
      restoreExecutionProof.productionPackageIdentityHashBefore,
    productionPackageIdentityHashAfter:
      restoreExecutionProof.productionPackageIdentityHashAfter,
    productionPackageContentHashBefore:
      restoreExecutionProof.productionPackageContentHashBefore,
    productionPackageContentHashAfter:
      restoreExecutionProof.productionPackageContentHashAfter,
    productionPackageRecoveryTreeInventoryHashBefore:
      restoreExecutionProof.productionPackageRecoveryTreeInventoryHashBefore,
    productionPackageRecoveryTreeInventoryHashAfter:
      restoreExecutionProof.productionPackageRecoveryTreeInventoryHashAfter,
    blockers: Object.freeze([]),
    productionPackageMutated: false,
    performedAt: restoreExecutionProof.completedAt,
    externalActionPerformed: true,
  };
  const receipt = Object.freeze({
    ...payload,
    packageExactRestoreDrillReceiptHash:
      hashRecord('PackageExactRestoreDrillReceipt', payload),
  });
  if (!verifyPackageExactRestoreDrillReceipt(receipt, {
    lifecycleReceipt,
    recoverySourceAuthority,
    trustedStorageAuthorityVerifier,
    trustedRestoreDrillVerifier,
  }).valid) {
    throw new Error('package_exact_restore_drill_receipt_invalid');
  }
  return receipt;
}

export function verifyPackageExactRestoreDrillReceipt(receipt, {
  lifecycleReceipt = null,
  recoverySourceAuthority = null,
  trustedStorageAuthorityVerifier = null,
  trustedRestoreDrillVerifier = null,
} = {}) {
  const blockers = [];
  const { packageExactRestoreDrillReceiptHash = null, ...payload } = receipt || {};
  const source = recoverySourceAuthority
    ? verifyPackageImmutableRecoverySourceAuthority(recoverySourceAuthority, {
      lifecycleReceipt,
      trustedStorageAuthorityVerifier,
      at: receipt?.performedAt || null,
    }) : result(['package_exact_restore_drill_source_required']);
  const execution = verifyPackageExactRestoreExecutionProof(
    receipt?.restoreExecutionProof || {},
    { recoverySourceAuthority },
  );
  if (!exactKeys(receipt, RESTORE_DRILL_KEYS)
    || receipt?.version !== 2
    || receipt.kind !== 'PackageExactRestoreDrillReceipt'
    || receipt.status !== 'package_exact_predecessor_restore_drill_passed'
    || !nonEmpty(receipt.runtimeRoot)
    || !nonEmpty(receipt.paperId)
    || !canonicalAbsolutePath(receipt.packagePath)
    || !validHash(receipt.packageContentHash)
    || !validHash(receipt.packageLifecycleReceiptHash)
    || !validHash(receipt.packageReleaseIdentityHash)
    || !source.valid
    || !execution.valid
    || receipt.packageExactRestoreExecutionProofHash
      !== receipt.restoreExecutionProof?.packageExactRestoreExecutionProofHash
    || receipt.packageImmutableRecoverySourceAuthorityHash
      !== recoverySourceAuthority?.packageImmutableRecoverySourceAuthorityHash
    || receipt.packageRecoveryStorageAuthorityProofHash
      !== recoverySourceAuthority?.packageRecoveryStorageAuthorityProofHash
    || receipt.storageAuthorityId !== recoverySourceAuthority?.storageAuthorityId
    || receipt.storageObjectId !== recoverySourceAuthority?.storageObjectId
    || receipt.storageObjectVersion !== recoverySourceAuthority?.storageObjectVersion
    || receipt.storageObjectPath !== recoverySourceAuthority?.storageObjectPath
    || receipt.storageObjectBytesHash !== recoverySourceAuthority?.storageObjectBytesHash
    || receipt.storageLedgerReceiptId
      !== recoverySourceAuthority?.storageLedgerReceiptId
    || receipt.storageLedgerReceiptHash
      !== recoverySourceAuthority?.storageLedgerReceiptHash
    || receipt.trustStoreHash !== recoverySourceAuthority?.trustStoreHash
    || receipt.sourceInventoryHash !== recoverySourceAuthority?.sourceInventoryHash
    || receipt.packageRecoveryTreeInventoryHash
      !== recoverySourceAuthority?.packageRecoveryTreeInventoryHash
    || receipt.sourceInventoryHash !== receipt.packageRecoveryTreeInventoryHash
    || receipt.retentionLockVersion !== recoverySourceAuthority?.retentionLockVersion
    || receipt.retentionLockIdentityHash
      !== recoverySourceAuthority?.retentionLockIdentityHash
    || receipt.retainUntil !== recoverySourceAuthority?.retainUntil
    || receipt.restoreTargetPath !== receipt.restoreExecutionProof?.restoreTargetPath
    || receipt.restoreTargetIdentityHash
      !== receipt.restoreExecutionProof?.restoreTargetIdentityHash
    || receipt.expectedPackageContentHash !== receipt.packageContentHash
    || receipt.expectedPackageContentHash
      !== receipt.restoreExecutionProof?.expectedPackageContentHash
    || receipt.restoredPackageContentHash !== receipt.expectedPackageContentHash
    || !validHash(receipt.expectedPackageRecoveryTreeInventoryHash)
    || receipt.expectedPackageRecoveryTreeInventoryHash
      !== receipt.packageRecoveryTreeInventoryHash
    || receipt.expectedPackageRecoveryTreeInventoryHash
      !== receipt.restoreExecutionProof?.expectedPackageRecoveryTreeInventoryHash
    || receipt.restoredPackageRecoveryTreeInventoryHash
      !== receipt.expectedPackageRecoveryTreeInventoryHash
    || receipt.restoredPackageRecoveryTreeInventoryHash
      !== receipt.restoreExecutionProof?.restoredPackageRecoveryTreeInventoryHash
    || receipt.productionPackageIdentityHashBefore
      !== receipt.restoreExecutionProof?.productionPackageIdentityHashBefore
    || receipt.productionPackageIdentityHashAfter
      !== receipt.productionPackageIdentityHashBefore
    || receipt.productionPackageContentHashBefore !== receipt.packageContentHash
    || receipt.productionPackageContentHashAfter
      !== receipt.productionPackageContentHashBefore
    || receipt.productionPackageRecoveryTreeInventoryHashBefore
      !== receipt.expectedPackageRecoveryTreeInventoryHash
    || receipt.productionPackageRecoveryTreeInventoryHashBefore
      !== receipt.restoreExecutionProof
        ?.productionPackageRecoveryTreeInventoryHashBefore
    || receipt.productionPackageRecoveryTreeInventoryHashAfter
      !== receipt.productionPackageRecoveryTreeInventoryHashBefore
    || receipt.productionPackageRecoveryTreeInventoryHashAfter
      !== receipt.restoreExecutionProof
        ?.productionPackageRecoveryTreeInventoryHashAfter
    || !exactEmptyArray(receipt.blockers)
    || receipt.productionPackageMutated !== false
    || receipt.performedAt !== receipt.restoreExecutionProof?.completedAt
    || !canonicalTime(receipt.performedAt)
    || receipt.externalActionPerformed !== true
    || !verifyTrustedPackageRecoveryStorageProof(
      trustedRestoreDrillVerifier,
      receipt.restoreExecutionProof,
      { lifecycleReceipt, recoverySourceAuthority, restoreDrillReceipt: receipt },
    )
    || hashRecord('PackageExactRestoreDrillReceipt', payload)
      !== packageExactRestoreDrillReceiptHash) {
    blockers.push(
      'package_exact_restore_drill_receipt_invalid',
      ...source.blockers,
      ...execution.blockers,
    );
  }
  if (!lifecycleReceipt) {
    blockers.push('package_exact_restore_drill_lifecycle_required');
  } else {
    const lifecycle = verifyPackageLifecycleReceipt(lifecycleReceipt);
    if (!lifecycle.valid
      || receipt?.runtimeRoot !== lifecycleReceipt.runtimeRoot
      || receipt?.paperId !== lifecycleReceipt.releaseIdentity?.paperId
      || receipt?.packagePath !== lifecycleReceipt.packagePath
      || receipt?.packageContentHash !== lifecycleReceipt.packageContentHash
      || receipt?.packageRecoveryTreeInventoryHash
        !== lifecycleReceipt.packageRecoveryTreeInventoryHash
      || receipt?.packageLifecycleReceiptHash
        !== lifecycleReceipt.packageLifecycleReceiptHash
      || receipt?.packageReleaseIdentityHash
        !== lifecycleReceipt.packageReleaseIdentityHash
      || !strictlyAfter(receipt?.performedAt, lifecycleReceipt.recordedAt)) {
      blockers.push('package_exact_restore_drill_lifecycle_binding_invalid');
    }
  }
  return result(blockers);
}

export function createPackageRetentionRecoveryReceipt({
  lifecycleReceipt,
  recoverySourceAuthority,
  restoreDrillReceipt,
  recordedAt,
  trustedStorageAuthorityVerifier,
  trustedRestoreDrillVerifier,
} = {}) {
  const source = verifyPackageImmutableRecoverySourceAuthority(recoverySourceAuthority, {
    lifecycleReceipt,
    trustedStorageAuthorityVerifier,
    at: recordedAt,
  });
  const drill = verifyPackageExactRestoreDrillReceipt(restoreDrillReceipt, {
    lifecycleReceipt,
    recoverySourceAuthority,
    trustedStorageAuthorityVerifier,
    trustedRestoreDrillVerifier,
  });
  if (!source.valid || !drill.valid
    || !strictlyAfter(recordedAt, restoreDrillReceipt?.performedAt)) {
    throw new Error('package_retention_recovery_receipt_invalid');
  }
  const payload = {
    version: 2,
    kind: 'PackageRetentionRecoveryReceipt',
    status: 'package_exact_predecessor_retention_recovery_verified',
    runtimeRoot: lifecycleReceipt.runtimeRoot,
    paperId: lifecycleReceipt.releaseIdentity.paperId,
    packagePath: lifecycleReceipt.packagePath,
    packageContentHash: lifecycleReceipt.packageContentHash,
    packageLifecycleReceiptHash: lifecycleReceipt.packageLifecycleReceiptHash,
    packageReleaseIdentityHash: lifecycleReceipt.packageReleaseIdentityHash,
    recoverySourceAuthority,
    packageImmutableRecoverySourceAuthorityHash:
      recoverySourceAuthority.packageImmutableRecoverySourceAuthorityHash,
    restoreDrillReceipt,
    packageExactRestoreDrillReceiptHash:
      restoreDrillReceipt.packageExactRestoreDrillReceiptHash,
    packageRecoveryStorageAuthorityProofHash:
      recoverySourceAuthority.packageRecoveryStorageAuthorityProofHash,
    storageAuthorityId: recoverySourceAuthority.storageAuthorityId,
    storageObjectId: recoverySourceAuthority.storageObjectId,
    storageObjectVersion: recoverySourceAuthority.storageObjectVersion,
    storageObjectPath: recoverySourceAuthority.storageObjectPath,
    storageObjectBytesHash: recoverySourceAuthority.storageObjectBytesHash,
    storageLedgerReceiptId: recoverySourceAuthority.storageLedgerReceiptId,
    storageLedgerReceiptHash: recoverySourceAuthority.storageLedgerReceiptHash,
    trustStoreHash: recoverySourceAuthority.trustStoreHash,
    sourceInventoryHash: recoverySourceAuthority.sourceInventoryHash,
    packageRecoveryTreeInventoryHash:
      recoverySourceAuthority.packageRecoveryTreeInventoryHash,
    expectedPackageRecoveryTreeInventoryHash:
      restoreDrillReceipt.expectedPackageRecoveryTreeInventoryHash,
    restoredPackageRecoveryTreeInventoryHash:
      restoreDrillReceipt.restoredPackageRecoveryTreeInventoryHash,
    productionPackageRecoveryTreeInventoryHashBefore:
      restoreDrillReceipt.productionPackageRecoveryTreeInventoryHashBefore,
    productionPackageRecoveryTreeInventoryHashAfter:
      restoreDrillReceipt.productionPackageRecoveryTreeInventoryHashAfter,
    retentionPolicy: recoverySourceAuthority.retentionPolicy,
    packageRecoveryRetentionPolicyHash:
      recoverySourceAuthority.packageRecoveryRetentionPolicyHash,
    retentionLockVersion: recoverySourceAuthority.retentionLockVersion,
    retentionLockIdentityHash: recoverySourceAuthority.retentionLockIdentityHash,
    retainUntil: recoverySourceAuthority.retainUntil,
    recordedAt,
    externalActionPerformed: false,
  };
  const receipt = Object.freeze({
    ...payload,
    packageRetentionRecoveryReceiptHash:
      hashRecord('PackageRetentionRecoveryReceipt', payload),
  });
  if (!verifyPackageRetentionRecoveryReceipt(receipt, {
    lifecycleReceipt,
    trustedStorageAuthorityVerifier,
    trustedRestoreDrillVerifier,
  }).valid) {
    throw new Error('package_retention_recovery_receipt_invalid');
  }
  return receipt;
}

export function verifyPackageRetentionRecoveryReceipt(receipt, {
  lifecycleReceipt = null,
  trustedStorageAuthorityVerifier = null,
  trustedRestoreDrillVerifier = null,
  at = null,
} = {}) {
  const blockers = [];
  const { packageRetentionRecoveryReceiptHash = null, ...payload } = receipt || {};
  const source = verifyPackageImmutableRecoverySourceAuthority(
    receipt?.recoverySourceAuthority || {},
    {
      lifecycleReceipt,
      trustedStorageAuthorityVerifier,
      at: at || receipt?.recordedAt || null,
    },
  );
  const drill = verifyPackageExactRestoreDrillReceipt(receipt?.restoreDrillReceipt || {}, {
    lifecycleReceipt,
    recoverySourceAuthority: receipt?.recoverySourceAuthority || null,
    trustedStorageAuthorityVerifier,
    trustedRestoreDrillVerifier,
  });
  const policy = verifyPackageRecoveryRetentionPolicy(receipt?.retentionPolicy || {}, {
    at: at || receipt?.recordedAt || null,
  });
  if (!exactKeys(receipt, RETENTION_RECOVERY_KEYS)
    || receipt?.version !== 2
    || receipt.kind !== 'PackageRetentionRecoveryReceipt'
    || receipt.status !== 'package_exact_predecessor_retention_recovery_verified'
    || !nonEmpty(receipt.runtimeRoot)
    || !nonEmpty(receipt.paperId)
    || !canonicalAbsolutePath(receipt.packagePath)
    || !validHash(receipt.packageContentHash)
    || !validHash(receipt.packageLifecycleReceiptHash)
    || !validHash(receipt.packageReleaseIdentityHash)
    || !source.valid
    || !drill.valid
    || !policy.valid
    || receipt.packageImmutableRecoverySourceAuthorityHash
      !== receipt.recoverySourceAuthority?.packageImmutableRecoverySourceAuthorityHash
    || receipt.packageExactRestoreDrillReceiptHash
      !== receipt.restoreDrillReceipt?.packageExactRestoreDrillReceiptHash
    || receipt.packageRecoveryStorageAuthorityProofHash
      !== receipt.recoverySourceAuthority?.packageRecoveryStorageAuthorityProofHash
    || receipt.packageRecoveryStorageAuthorityProofHash
      !== receipt.restoreDrillReceipt?.packageRecoveryStorageAuthorityProofHash
    || receipt.storageAuthorityId !== receipt.recoverySourceAuthority?.storageAuthorityId
    || receipt.storageAuthorityId !== receipt.restoreDrillReceipt?.storageAuthorityId
    || receipt.storageObjectId !== receipt.recoverySourceAuthority?.storageObjectId
    || receipt.storageObjectId !== receipt.restoreDrillReceipt?.storageObjectId
    || receipt.storageObjectVersion
      !== receipt.recoverySourceAuthority?.storageObjectVersion
    || receipt.storageObjectVersion
      !== receipt.restoreDrillReceipt?.storageObjectVersion
    || receipt.storageObjectPath !== receipt.recoverySourceAuthority?.storageObjectPath
    || receipt.storageObjectPath !== receipt.restoreDrillReceipt?.storageObjectPath
    || receipt.storageObjectBytesHash
      !== receipt.recoverySourceAuthority?.storageObjectBytesHash
    || receipt.storageObjectBytesHash
      !== receipt.restoreDrillReceipt?.storageObjectBytesHash
    || receipt.storageLedgerReceiptId
      !== receipt.recoverySourceAuthority?.storageLedgerReceiptId
    || receipt.storageLedgerReceiptId
      !== receipt.restoreDrillReceipt?.storageLedgerReceiptId
    || receipt.storageLedgerReceiptHash
      !== receipt.recoverySourceAuthority?.storageLedgerReceiptHash
    || receipt.storageLedgerReceiptHash
      !== receipt.restoreDrillReceipt?.storageLedgerReceiptHash
    || receipt.trustStoreHash !== receipt.recoverySourceAuthority?.trustStoreHash
    || receipt.trustStoreHash !== receipt.restoreDrillReceipt?.trustStoreHash
    || receipt.sourceInventoryHash !== receipt.recoverySourceAuthority?.sourceInventoryHash
    || receipt.sourceInventoryHash !== receipt.restoreDrillReceipt?.sourceInventoryHash
    || receipt.packageRecoveryTreeInventoryHash
      !== receipt.recoverySourceAuthority?.packageRecoveryTreeInventoryHash
    || receipt.packageRecoveryTreeInventoryHash
      !== receipt.restoreDrillReceipt?.packageRecoveryTreeInventoryHash
    || receipt.sourceInventoryHash !== receipt.packageRecoveryTreeInventoryHash
    || receipt.expectedPackageRecoveryTreeInventoryHash
      !== receipt.packageRecoveryTreeInventoryHash
    || receipt.expectedPackageRecoveryTreeInventoryHash
      !== receipt.restoreDrillReceipt?.expectedPackageRecoveryTreeInventoryHash
    || receipt.restoredPackageRecoveryTreeInventoryHash
      !== receipt.expectedPackageRecoveryTreeInventoryHash
    || receipt.restoredPackageRecoveryTreeInventoryHash
      !== receipt.restoreDrillReceipt?.restoredPackageRecoveryTreeInventoryHash
    || receipt.productionPackageRecoveryTreeInventoryHashBefore
      !== receipt.expectedPackageRecoveryTreeInventoryHash
    || receipt.productionPackageRecoveryTreeInventoryHashBefore
      !== receipt.restoreDrillReceipt
        ?.productionPackageRecoveryTreeInventoryHashBefore
    || receipt.productionPackageRecoveryTreeInventoryHashAfter
      !== receipt.productionPackageRecoveryTreeInventoryHashBefore
    || receipt.productionPackageRecoveryTreeInventoryHashAfter
      !== receipt.restoreDrillReceipt
        ?.productionPackageRecoveryTreeInventoryHashAfter
    || receipt.packageRecoveryRetentionPolicyHash
      !== receipt.retentionPolicy?.packageRecoveryRetentionPolicyHash
    || receipt.packageRecoveryRetentionPolicyHash
      !== receipt.recoverySourceAuthority?.packageRecoveryRetentionPolicyHash
    || receipt.retentionLockVersion
      !== receipt.recoverySourceAuthority?.retentionLockVersion
    || receipt.retentionLockVersion
      !== receipt.restoreDrillReceipt?.retentionLockVersion
    || receipt.retentionLockIdentityHash
      !== receipt.recoverySourceAuthority?.retentionLockIdentityHash
    || receipt.retentionLockIdentityHash
      !== receipt.restoreDrillReceipt?.retentionLockIdentityHash
    || receipt.retainUntil !== receipt.recoverySourceAuthority?.retainUntil
    || receipt.retainUntil !== receipt.restoreDrillReceipt?.retainUntil
    || !strictlyAfter(receipt.recordedAt, receipt.restoreDrillReceipt?.performedAt)
    || !strictlyAfter(receipt.retainUntil, receipt.recordedAt)
    || receipt.externalActionPerformed !== false
    || hashRecord('PackageRetentionRecoveryReceipt', payload)
      !== packageRetentionRecoveryReceiptHash) {
    blockers.push(
      'package_retention_recovery_receipt_invalid',
      ...source.blockers,
      ...drill.blockers,
      ...policy.blockers,
    );
  }
  if (!lifecycleReceipt) {
    blockers.push('package_retention_recovery_lifecycle_required');
  } else {
    const lifecycle = verifyPackageLifecycleReceipt(lifecycleReceipt);
    if (!lifecycle.valid
      || receipt?.runtimeRoot !== lifecycleReceipt.runtimeRoot
      || receipt?.paperId !== lifecycleReceipt.releaseIdentity?.paperId
      || receipt?.packagePath !== lifecycleReceipt.packagePath
      || receipt?.packageContentHash !== lifecycleReceipt.packageContentHash
      || receipt?.packageRecoveryTreeInventoryHash
        !== lifecycleReceipt.packageRecoveryTreeInventoryHash
      || receipt?.packageLifecycleReceiptHash
        !== lifecycleReceipt.packageLifecycleReceiptHash
      || receipt?.packageReleaseIdentityHash
        !== lifecycleReceipt.packageReleaseIdentityHash) {
      blockers.push('package_retention_recovery_lifecycle_binding_invalid');
    }
  }
  return result(blockers, {
    version: 2,
    legacy: false,
    recoveryEvidenceValid: blockers.length === 0,
    deletionAuthorized: false,
  });
}
