import { hasExactPlainObjectKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { verifyPackageLifecycleReceipt } from './package-lifecycle-receipt-contract.mjs';
import {
  packageRecoveryStorageAuthoritySubjectHash,
} from './package-recovery-storage-authority-subject.mjs';

export { packageRecoveryStorageAuthoritySubjectHash };

const SHA256 = /^sha256:[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,255}$/;
const STORAGE_CLASSES = new Set(['worm', 'cas', 'snapshot']);
const LOCK_MODES = new Set(['compliance']);
const SIGNATURE_ROLE = 'package_recovery_storage_authority';

const RETENTION_POLICY_KEYS = Object.freeze([
  'version', 'kind', 'status', 'retentionLockAuthorityId', 'retentionLockId',
  'retentionLockMode', 'retentionLockVersion', 'retentionLockIdentityHash', 'retainUntil',
  'deletionProtected', 'packageRecoveryRetentionPolicyHash',
]);

const SIGNATURE_KEYS = Object.freeze([
  'algorithm', 'keyId', 'role', 'signedSubjectHash', 'value',
]);

const LEDGER_IDENTITY_KEYS = Object.freeze([
  'receiptId', 'receiptHash', 'stream', 'writerId', 'writerKind',
  'issuerPolicyId', 'issuerPolicyHash', 'writerTrusted',
]);

const STORAGE_PROOF_KEYS = Object.freeze([
  'version', 'kind', 'status', 'runtimeRoot', 'paperId', 'packagePath',
  'packageContentHash', 'packageLifecycleReceiptHash', 'packageReleaseIdentityHash',
  'immutableCampaignPackageOutputHash', 'packageRecoveryTreeInventoryHash',
  'lifecycleRecordedAt',
  'archiveSchemaVersion', 'archiveInventoryHash', 'storageAuthorityId',
  'storageClass', 'storageObjectId', 'storageObjectVersion', 'storageObjectPath',
  'storageObjectBytesHash', 'storedPackageContentHash', 'sourceInventoryHash',
  'retentionPolicy',
  'packageRecoveryRetentionPolicyHash', 'signedSubjectHash', 'signatures',
  'trustStoreHash', 'ledgerIdentity', 'issuedAt', 'verifiedAt', 'verificationEpoch', 'blockers',
  'externalActionPerformed', 'packageRecoveryStorageAuthorityProofHash',
]);

const IMMUTABLE_SOURCE_KEYS = Object.freeze([
  'version', 'kind', 'status', 'runtimeRoot', 'paperId', 'packagePath',
  'packageContentHash', 'packageLifecycleReceiptHash', 'packageReleaseIdentityHash',
  'storageAuthorityProof', 'packageRecoveryStorageAuthorityProofHash',
  'storageAuthorityId', 'storageClass', 'storageObjectId', 'storageObjectPath',
  'storageObjectVersion', 'storageObjectBytesHash', 'storedPackageContentHash',
  'packageRecoveryTreeInventoryHash', 'sourceInventoryHash',
  'storageLedgerReceiptId', 'storageLedgerReceiptHash', 'trustStoreHash',
  'retentionPolicy', 'packageRecoveryRetentionPolicyHash',
  'retentionLockVersion', 'retentionLockIdentityHash', 'retainUntil',
  'immutable', 'deletionProtected',
  'verifiedAt', 'externalActionPerformed',
  'packageImmutableRecoverySourceAuthorityHash',
]);

const RESTORE_EXECUTION_PROOF_KEYS = Object.freeze([
  'version', 'kind', 'status', 'packageImmutableRecoverySourceAuthorityHash',
  'packageRecoveryStorageAuthorityProofHash', 'storageAuthorityId',
  'storageObjectId', 'storageObjectVersion', 'storageObjectPath',
  'storageObjectBytesHash', 'storageLedgerReceiptId', 'storageLedgerReceiptHash',
  'trustStoreHash', 'sourceInventoryHash', 'packageRecoveryTreeInventoryHash',
  'retentionLockVersion', 'retentionLockIdentityHash', 'retainUntil',
  'restoreTargetPath', 'restoreTargetIdentityHash', 'expectedPackageContentHash',
  'restoredPackageContentHash', 'productionPackagePath',
  'expectedPackageRecoveryTreeInventoryHash',
  'restoredPackageRecoveryTreeInventoryHash',
  'productionPackageRecoveryTreeInventoryHashBefore',
  'productionPackageRecoveryTreeInventoryHashAfter',
  'productionPackageIdentityHashBefore', 'productionPackageIdentityHashAfter',
  'productionPackageContentHashBefore', 'productionPackageContentHashAfter',
  'startedAt', 'completedAt', 'blockers', 'productionPackageMutated',
  'externalActionPerformed', 'packageExactRestoreExecutionProofHash',
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

function safeId(value) {
  return typeof value === 'string' && SAFE_ID.test(value);
}

function pathWithin(root, candidate) {
  return canonicalAbsolutePath(root) && canonicalAbsolutePath(candidate)
    && (candidate === root || candidate.startsWith(`${root}/`));
}

function pathsDisjoint(left, right) {
  return canonicalAbsolutePath(left) && canonicalAbsolutePath(right)
    && !pathWithin(left, right) && !pathWithin(right, left);
}

function directPackageMember(root, candidate) {
  if (!canonicalAbsolutePath(root) || !canonicalAbsolutePath(candidate)) return false;
  const prefix = `${root}/packages/`;
  return candidate.startsWith(prefix)
    && !candidate.slice(prefix.length).includes('/');
}

function canonicalEd25519Signature(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(value)) return false;
  const decoded = Buffer.from(value, 'base64');
  return decoded.length === 64 && decoded.toString('base64') === value;
}

function validSignatures(signatures, signedSubjectHash) {
  if (!Array.isArray(signatures) || signatures.length < 1 || signatures.length > 4) return false;
  const keyIds = signatures.map((signature) => signature?.keyId);
  return new Set(keyIds).size === keyIds.length
    && JSON.stringify(keyIds) === JSON.stringify([...keyIds].sort())
    && signatures.every((signature) => exactKeys(signature, SIGNATURE_KEYS)
      && signature.algorithm === 'ed25519'
      && safeId(signature.keyId)
      && signature.role === SIGNATURE_ROLE
      && signature.signedSubjectHash === signedSubjectHash
      && canonicalEd25519Signature(signature.value));
}

function trustedProof(verifier, proof, context) {
  if (typeof verifier !== 'function') return false;
  try { return verifier(proof, context) === true; } catch { return false; }
}

function result(blockers) {
  return Object.freeze({
    valid: blockers.length === 0,
    blockers: Object.freeze([...new Set(blockers)]),
  });
}

export function createPackageRecoveryRetentionPolicy({
  retentionLockAuthorityId,
  retentionLockId,
  retentionLockMode,
  retentionLockVersion,
  retentionLockIdentityHash,
  retainUntil,
} = {}) {
  const payload = {
    version: 2,
    kind: 'PackageRecoveryRetentionPolicy',
    status: 'package_recovery_retention_lock_active',
    retentionLockAuthorityId,
    retentionLockId,
    retentionLockMode,
    retentionLockVersion,
    retentionLockIdentityHash,
    retainUntil,
    deletionProtected: true,
  };
  const policy = Object.freeze({
    ...payload,
    packageRecoveryRetentionPolicyHash:
      hashRecord('PackageRecoveryRetentionPolicy', payload),
  });
  if (!verifyPackageRecoveryRetentionPolicy(policy).valid) {
    throw new Error('package_recovery_retention_policy_invalid');
  }
  return policy;
}

export function verifyPackageRecoveryRetentionPolicy(policy, { at = null } = {}) {
  const blockers = [];
  const { packageRecoveryRetentionPolicyHash = null, ...payload } = policy || {};
  if (!exactKeys(policy, RETENTION_POLICY_KEYS)
    || policy?.version !== 2
    || policy.kind !== 'PackageRecoveryRetentionPolicy'
    || policy.status !== 'package_recovery_retention_lock_active'
    || !safeId(policy.retentionLockAuthorityId)
    || !safeId(policy.retentionLockId)
    || !LOCK_MODES.has(policy.retentionLockMode)
    || !safeId(policy.retentionLockVersion)
    || !validHash(policy.retentionLockIdentityHash)
    || !canonicalTime(policy.retainUntil)
    || policy.deletionProtected !== true
    || hashRecord('PackageRecoveryRetentionPolicy', payload)
      !== packageRecoveryRetentionPolicyHash) {
    blockers.push('package_recovery_retention_policy_invalid');
  }
  if (at !== null && (!canonicalTime(at) || !strictlyAfter(policy?.retainUntil, at))) {
    blockers.push('package_recovery_retention_policy_not_current');
  }
  return result(blockers);
}

export function createPackageRecoveryStorageAuthorityProof({
  runtimeRoot,
  paperId,
  packagePath,
  packageContentHash,
  packageLifecycleReceiptHash,
  packageReleaseIdentityHash,
  immutableCampaignPackageOutputHash,
  packageRecoveryTreeInventoryHash,
  lifecycleRecordedAt,
  archiveSchemaVersion,
  archiveInventoryHash,
  storageAuthorityId,
  storageClass,
  storageObjectId,
  storageObjectVersion,
  storageObjectPath,
  storageObjectBytesHash,
  storedPackageContentHash,
  sourceInventoryHash,
  retentionPolicy,
  signatures,
  trustStoreHash,
  ledgerIdentity,
  issuedAt,
  verifiedAt,
  verificationEpoch,
} = {}) {
  const subjectInput = {
    runtimeRoot,
    paperId,
    packagePath,
    packageContentHash,
    packageLifecycleReceiptHash,
    packageReleaseIdentityHash,
    immutableCampaignPackageOutputHash,
    packageRecoveryTreeInventoryHash,
    lifecycleRecordedAt,
    archiveSchemaVersion,
    archiveInventoryHash,
    storageAuthorityId,
    storageClass,
    storageObjectId,
    storageObjectVersion,
    storageObjectPath,
    storageObjectBytesHash,
    storedPackageContentHash,
    sourceInventoryHash,
    retentionPolicy,
    packageRecoveryRetentionPolicyHash:
      retentionPolicy?.packageRecoveryRetentionPolicyHash,
    trustStoreHash,
    ledgerIdentity,
    issuedAt,
    verifiedAt,
    verificationEpoch,
  };
  const signedSubjectHash = packageRecoveryStorageAuthoritySubjectHash(subjectInput);
  const payload = {
    version: 2,
    kind: 'PackageRecoveryStorageAuthorityProof',
    status: 'package_recovery_storage_authority_verified',
    ...subjectInput,
    signedSubjectHash,
    signatures: Object.freeze((Array.isArray(signatures) ? signatures : [])
      .map((signature) => Object.freeze({ ...signature }))),
    ledgerIdentity: Object.freeze({ ...(ledgerIdentity || {}) }),
    blockers: Object.freeze([]),
    externalActionPerformed: false,
  };
  const proof = Object.freeze({
    ...payload,
    packageRecoveryStorageAuthorityProofHash:
      hashRecord('PackageRecoveryStorageAuthorityProof', payload),
  });
  if (!verifyPackageRecoveryStorageAuthorityProof(proof).valid) {
    throw new Error('package_recovery_storage_authority_proof_invalid');
  }
  return proof;
}

export function verifyPackageRecoveryStorageAuthorityProof(proof) {
  const blockers = [];
  const { packageRecoveryStorageAuthorityProofHash = null, ...payload } = proof || {};
  const policy = verifyPackageRecoveryRetentionPolicy(proof?.retentionPolicy || {}, {
    at: proof?.verifiedAt || null,
  });
  const subjectHash = packageRecoveryStorageAuthoritySubjectHash(proof);
  const ledger = proof?.ledgerIdentity;
  if (!exactKeys(proof, STORAGE_PROOF_KEYS)
    || proof?.version !== 2
    || proof.kind !== 'PackageRecoveryStorageAuthorityProof'
    || proof.status !== 'package_recovery_storage_authority_verified'
    || !canonicalAbsolutePath(proof.runtimeRoot)
    || !nonEmpty(proof.paperId)
    || !canonicalAbsolutePath(proof.packagePath)
    || !directPackageMember(proof.runtimeRoot, proof.packagePath)
    || !validHash(proof.packageContentHash)
    || !validHash(proof.packageLifecycleReceiptHash)
    || !validHash(proof.packageReleaseIdentityHash)
    || !validHash(proof.immutableCampaignPackageOutputHash)
    || !validHash(proof.packageRecoveryTreeInventoryHash)
    || !canonicalTime(proof.lifecycleRecordedAt)
    || !Number.isSafeInteger(proof.archiveSchemaVersion)
    || proof.archiveSchemaVersion < 1
    || !validHash(proof.archiveInventoryHash)
    || !safeId(proof.storageAuthorityId)
    || !STORAGE_CLASSES.has(proof.storageClass)
    || !safeId(proof.storageObjectId)
    || !safeId(proof.storageObjectVersion)
    || !canonicalAbsolutePath(proof.storageObjectPath)
    || !validHash(proof.storageObjectBytesHash)
    || !validHash(proof.storedPackageContentHash)
    || !validHash(proof.sourceInventoryHash)
    || proof.storedPackageContentHash !== proof.packageContentHash
    || proof.archiveInventoryHash !== proof.sourceInventoryHash
    || proof.packageRecoveryTreeInventoryHash !== proof.sourceInventoryHash
    || !policy.valid
    || proof.packageRecoveryRetentionPolicyHash
      !== proof.retentionPolicy?.packageRecoveryRetentionPolicyHash
    || proof.signedSubjectHash !== subjectHash
    || !validSignatures(proof.signatures, subjectHash)
    || !validHash(proof.trustStoreHash)
    || !exactKeys(ledger, LEDGER_IDENTITY_KEYS)
    || !nonEmpty(ledger?.receiptId)
    || !validHash(ledger?.receiptHash)
    || ledger?.stream !== 'package-recovery-storage'
    || !safeId(ledger?.writerId)
    || ledger?.writerKind !== 'immutable-package-recovery-storage-authority'
    || !safeId(ledger?.issuerPolicyId)
    || !validHash(ledger?.issuerPolicyHash)
    || ledger?.writerTrusted !== true
    || !canonicalTime(proof.issuedAt)
    || !canonicalTime(proof.verifiedAt)
    || !strictlyAfter(proof.issuedAt, proof.lifecycleRecordedAt)
    || Date.parse(proof.verifiedAt) < Date.parse(proof.issuedAt)
    || !safeId(proof.verificationEpoch)
    || !exactEmptyArray(proof.blockers)
    || proof.externalActionPerformed !== false
    || hashRecord('PackageRecoveryStorageAuthorityProof', payload)
      !== packageRecoveryStorageAuthorityProofHash) {
    blockers.push('package_recovery_storage_authority_proof_invalid', ...policy.blockers);
  }
  return result(blockers);
}

function storageProofBindsLifecycle(proof, lifecycleReceipt) {
  return proof?.runtimeRoot === lifecycleReceipt?.runtimeRoot
    && proof?.paperId === lifecycleReceipt?.releaseIdentity?.paperId
    && proof?.packagePath === lifecycleReceipt?.packagePath
    && proof?.packageContentHash === lifecycleReceipt?.packageContentHash
    && proof?.storedPackageContentHash === lifecycleReceipt?.packageContentHash
    && proof?.packageLifecycleReceiptHash
      === lifecycleReceipt?.packageLifecycleReceiptHash
    && proof?.packageReleaseIdentityHash
      === lifecycleReceipt?.packageReleaseIdentityHash
    && proof?.immutableCampaignPackageOutputHash
      === lifecycleReceipt?.releaseIdentity?.immutableCampaignPackageOutputHash
    && proof?.packageRecoveryTreeInventoryHash
      === lifecycleReceipt?.packageRecoveryTreeInventoryHash
    && proof?.sourceInventoryHash
      === lifecycleReceipt?.packageRecoveryTreeInventoryHash
    && proof?.archiveInventoryHash
      === lifecycleReceipt?.packageRecoveryTreeInventoryHash
    && proof?.lifecycleRecordedAt === lifecycleReceipt?.recordedAt
    && strictlyAfter(proof?.issuedAt, lifecycleReceipt?.recordedAt)
    && strictlyAfter(proof?.verifiedAt, lifecycleReceipt?.recordedAt);
}

export function createPackageImmutableRecoverySourceAuthority({
  lifecycleReceipt,
  storageAuthorityProof,
  trustedStorageAuthorityVerifier,
} = {}) {
  const lifecycle = verifyPackageLifecycleReceipt(lifecycleReceipt);
  const proof = verifyPackageRecoveryStorageAuthorityProof(storageAuthorityProof);
  if (!lifecycle.valid || !proof.valid
    || !storageProofBindsLifecycle(storageAuthorityProof, lifecycleReceipt)
    || !trustedProof(trustedStorageAuthorityVerifier, storageAuthorityProof, {
      lifecycleReceipt,
    })) {
    throw new Error('package_immutable_recovery_source_authority_invalid');
  }
  const policy = storageAuthorityProof.retentionPolicy;
  const payload = {
    version: 2,
    kind: 'PackageImmutableRecoverySourceAuthority',
    status: 'package_exact_predecessor_recovery_source_verified',
    runtimeRoot: lifecycleReceipt.runtimeRoot,
    paperId: lifecycleReceipt.releaseIdentity.paperId,
    packagePath: lifecycleReceipt.packagePath,
    packageContentHash: lifecycleReceipt.packageContentHash,
    packageLifecycleReceiptHash: lifecycleReceipt.packageLifecycleReceiptHash,
    packageReleaseIdentityHash: lifecycleReceipt.packageReleaseIdentityHash,
    storageAuthorityProof,
    packageRecoveryStorageAuthorityProofHash:
      storageAuthorityProof.packageRecoveryStorageAuthorityProofHash,
    storageAuthorityId: storageAuthorityProof.storageAuthorityId,
    storageClass: storageAuthorityProof.storageClass,
    storageObjectId: storageAuthorityProof.storageObjectId,
    storageObjectVersion: storageAuthorityProof.storageObjectVersion,
    storageObjectPath: storageAuthorityProof.storageObjectPath,
    storageObjectBytesHash: storageAuthorityProof.storageObjectBytesHash,
    storedPackageContentHash: storageAuthorityProof.storedPackageContentHash,
    packageRecoveryTreeInventoryHash:
      storageAuthorityProof.packageRecoveryTreeInventoryHash,
    sourceInventoryHash: storageAuthorityProof.sourceInventoryHash,
    storageLedgerReceiptId: storageAuthorityProof.ledgerIdentity.receiptId,
    storageLedgerReceiptHash: storageAuthorityProof.ledgerIdentity.receiptHash,
    trustStoreHash: storageAuthorityProof.trustStoreHash,
    retentionPolicy: policy,
    packageRecoveryRetentionPolicyHash: policy.packageRecoveryRetentionPolicyHash,
    retentionLockVersion: policy.retentionLockVersion,
    retentionLockIdentityHash: policy.retentionLockIdentityHash,
    retainUntil: policy.retainUntil,
    immutable: true,
    deletionProtected: true,
    verifiedAt: storageAuthorityProof.verifiedAt,
    externalActionPerformed: false,
  };
  const authority = Object.freeze({
    ...payload,
    packageImmutableRecoverySourceAuthorityHash:
      hashRecord('PackageImmutableRecoverySourceAuthority', payload),
  });
  if (!verifyPackageImmutableRecoverySourceAuthority(authority, {
    lifecycleReceipt,
    trustedStorageAuthorityVerifier,
  }).valid) {
    throw new Error('package_immutable_recovery_source_authority_invalid');
  }
  return authority;
}

export function verifyPackageImmutableRecoverySourceAuthority(authority, {
  lifecycleReceipt = null,
  trustedStorageAuthorityVerifier = null,
  at = null,
} = {}) {
  const blockers = [];
  const { packageImmutableRecoverySourceAuthorityHash = null, ...payload } = authority || {};
  const proof = verifyPackageRecoveryStorageAuthorityProof(
    authority?.storageAuthorityProof || {},
  );
  const policy = verifyPackageRecoveryRetentionPolicy(authority?.retentionPolicy || {}, {
    at: at || authority?.verifiedAt || null,
  });
  if (!exactKeys(authority, IMMUTABLE_SOURCE_KEYS)
    || authority?.version !== 2
    || authority.kind !== 'PackageImmutableRecoverySourceAuthority'
    || authority.status !== 'package_exact_predecessor_recovery_source_verified'
    || !canonicalAbsolutePath(authority.runtimeRoot)
    || !nonEmpty(authority.paperId)
    || !canonicalAbsolutePath(authority.packagePath)
    || !directPackageMember(authority.runtimeRoot, authority.packagePath)
    || !validHash(authority.packageContentHash)
    || !validHash(authority.packageLifecycleReceiptHash)
    || !validHash(authority.packageReleaseIdentityHash)
    || !proof.valid
    || authority.packageRecoveryStorageAuthorityProofHash
      !== authority.storageAuthorityProof?.packageRecoveryStorageAuthorityProofHash
    || authority.storageAuthorityId !== authority.storageAuthorityProof?.storageAuthorityId
    || authority.storageClass !== authority.storageAuthorityProof?.storageClass
    || authority.storageObjectId !== authority.storageAuthorityProof?.storageObjectId
    || authority.storageObjectVersion
      !== authority.storageAuthorityProof?.storageObjectVersion
    || authority.storageObjectPath !== authority.storageAuthorityProof?.storageObjectPath
    || !pathsDisjoint(authority.runtimeRoot, authority.storageObjectPath)
    || authority.storageObjectBytesHash
      !== authority.storageAuthorityProof?.storageObjectBytesHash
    || authority.storedPackageContentHash
      !== authority.storageAuthorityProof?.storedPackageContentHash
    || authority.packageRecoveryTreeInventoryHash
      !== authority.storageAuthorityProof?.packageRecoveryTreeInventoryHash
    || authority.sourceInventoryHash !== authority.storageAuthorityProof?.sourceInventoryHash
    || authority.sourceInventoryHash !== authority.packageRecoveryTreeInventoryHash
    || authority.storageLedgerReceiptId
      !== authority.storageAuthorityProof?.ledgerIdentity?.receiptId
    || authority.storageLedgerReceiptHash
      !== authority.storageAuthorityProof?.ledgerIdentity?.receiptHash
    || authority.trustStoreHash !== authority.storageAuthorityProof?.trustStoreHash
    || authority.packageContentHash !== authority.storedPackageContentHash
    || !policy.valid
    || authority.packageRecoveryRetentionPolicyHash
      !== authority.retentionPolicy?.packageRecoveryRetentionPolicyHash
    || authority.packageRecoveryRetentionPolicyHash
      !== authority.storageAuthorityProof?.packageRecoveryRetentionPolicyHash
    || authority.retentionLockVersion
      !== authority.retentionPolicy?.retentionLockVersion
    || authority.retentionLockIdentityHash
      !== authority.retentionPolicy?.retentionLockIdentityHash
    || authority.retainUntil !== authority.retentionPolicy?.retainUntil
    || authority.immutable !== true
    || authority.deletionProtected !== true
    || authority.verifiedAt !== authority.storageAuthorityProof?.verifiedAt
    || authority.externalActionPerformed !== false
    || !trustedProof(trustedStorageAuthorityVerifier, authority.storageAuthorityProof, {
      lifecycleReceipt,
      recoverySourceAuthority: authority,
      at,
    })
    || hashRecord('PackageImmutableRecoverySourceAuthority', payload)
      !== packageImmutableRecoverySourceAuthorityHash) {
    blockers.push(
      'package_immutable_recovery_source_authority_invalid',
      ...proof.blockers,
      ...policy.blockers,
    );
  }
  if (!lifecycleReceipt) {
    blockers.push('package_immutable_recovery_source_lifecycle_required');
  } else {
    const lifecycle = verifyPackageLifecycleReceipt(lifecycleReceipt);
    if (!lifecycle.valid
      || !storageProofBindsLifecycle(authority?.storageAuthorityProof, lifecycleReceipt)
      || authority?.runtimeRoot !== lifecycleReceipt.runtimeRoot
      || authority?.paperId !== lifecycleReceipt.releaseIdentity?.paperId
      || authority?.packagePath !== lifecycleReceipt.packagePath
      || authority?.packageContentHash !== lifecycleReceipt.packageContentHash
      || authority?.packageLifecycleReceiptHash
        !== lifecycleReceipt.packageLifecycleReceiptHash
      || authority?.packageReleaseIdentityHash
        !== lifecycleReceipt.packageReleaseIdentityHash
      || !strictlyAfter(authority?.verifiedAt, lifecycleReceipt.recordedAt)) {
      blockers.push('package_immutable_recovery_source_lifecycle_binding_invalid');
    }
  }
  return result(blockers);
}

export function createPackageExactRestoreExecutionProof({
  recoverySourceAuthority,
  restoreTargetPath,
  restoreTargetIdentityHash,
  expectedPackageContentHash,
  restoredPackageContentHash,
  expectedPackageRecoveryTreeInventoryHash,
  restoredPackageRecoveryTreeInventoryHash,
  productionPackagePath,
  productionPackageIdentityHashBefore,
  productionPackageIdentityHashAfter,
  productionPackageContentHashBefore,
  productionPackageContentHashAfter,
  productionPackageRecoveryTreeInventoryHashBefore,
  productionPackageRecoveryTreeInventoryHashAfter,
  startedAt,
  completedAt,
} = {}) {
  const payload = {
    version: 2,
    kind: 'PackageExactRestoreExecutionProof',
    status: 'package_exact_predecessor_restore_executed',
    packageImmutableRecoverySourceAuthorityHash:
      recoverySourceAuthority?.packageImmutableRecoverySourceAuthorityHash,
    packageRecoveryStorageAuthorityProofHash:
      recoverySourceAuthority?.packageRecoveryStorageAuthorityProofHash,
    storageAuthorityId: recoverySourceAuthority?.storageAuthorityId,
    storageObjectId: recoverySourceAuthority?.storageObjectId,
    storageObjectVersion: recoverySourceAuthority?.storageObjectVersion,
    storageObjectPath: recoverySourceAuthority?.storageObjectPath,
    storageObjectBytesHash: recoverySourceAuthority?.storageObjectBytesHash,
    storageLedgerReceiptId: recoverySourceAuthority?.storageLedgerReceiptId,
    storageLedgerReceiptHash: recoverySourceAuthority?.storageLedgerReceiptHash,
    trustStoreHash: recoverySourceAuthority?.trustStoreHash,
    sourceInventoryHash: recoverySourceAuthority?.sourceInventoryHash,
    packageRecoveryTreeInventoryHash:
      recoverySourceAuthority?.packageRecoveryTreeInventoryHash,
    retentionLockVersion: recoverySourceAuthority?.retentionLockVersion,
    retentionLockIdentityHash: recoverySourceAuthority?.retentionLockIdentityHash,
    retainUntil: recoverySourceAuthority?.retainUntil,
    restoreTargetPath,
    restoreTargetIdentityHash,
    expectedPackageContentHash,
    restoredPackageContentHash,
    expectedPackageRecoveryTreeInventoryHash,
    restoredPackageRecoveryTreeInventoryHash,
    productionPackagePath,
    productionPackageIdentityHashBefore,
    productionPackageIdentityHashAfter,
    productionPackageContentHashBefore,
    productionPackageContentHashAfter,
    productionPackageRecoveryTreeInventoryHashBefore,
    productionPackageRecoveryTreeInventoryHashAfter,
    startedAt,
    completedAt,
    blockers: Object.freeze([]),
    productionPackageMutated: false,
    externalActionPerformed: true,
  };
  const proof = Object.freeze({
    ...payload,
    packageExactRestoreExecutionProofHash:
      hashRecord('PackageExactRestoreExecutionProof', payload),
  });
  if (!verifyPackageExactRestoreExecutionProof(proof, { recoverySourceAuthority }).valid) {
    throw new Error('package_exact_restore_execution_proof_invalid');
  }
  return proof;
}

export function verifyPackageExactRestoreExecutionProof(proof, {
  recoverySourceAuthority = null,
} = {}) {
  const blockers = [];
  const { packageExactRestoreExecutionProofHash = null, ...payload } = proof || {};
  if (!exactKeys(proof, RESTORE_EXECUTION_PROOF_KEYS)
    || proof?.version !== 2
    || proof.kind !== 'PackageExactRestoreExecutionProof'
    || proof.status !== 'package_exact_predecessor_restore_executed'
    || !validHash(proof.packageImmutableRecoverySourceAuthorityHash)
    || !validHash(proof.packageRecoveryStorageAuthorityProofHash)
    || !safeId(proof.storageAuthorityId)
    || !safeId(proof.storageObjectId)
    || !safeId(proof.storageObjectVersion)
    || !canonicalAbsolutePath(proof.storageObjectPath)
    || !validHash(proof.storageObjectBytesHash)
    || !nonEmpty(proof.storageLedgerReceiptId)
    || !validHash(proof.storageLedgerReceiptHash)
    || !validHash(proof.trustStoreHash)
    || !validHash(proof.sourceInventoryHash)
    || !validHash(proof.packageRecoveryTreeInventoryHash)
    || proof.sourceInventoryHash !== proof.packageRecoveryTreeInventoryHash
    || !safeId(proof.retentionLockVersion)
    || !validHash(proof.retentionLockIdentityHash)
    || !canonicalTime(proof.retainUntil)
    || !canonicalAbsolutePath(proof.restoreTargetPath)
    || !validHash(proof.restoreTargetIdentityHash)
    || !validHash(proof.expectedPackageContentHash)
    || proof.restoredPackageContentHash !== proof.expectedPackageContentHash
    || !validHash(proof.expectedPackageRecoveryTreeInventoryHash)
    || proof.expectedPackageRecoveryTreeInventoryHash
      !== proof.packageRecoveryTreeInventoryHash
    || proof.restoredPackageRecoveryTreeInventoryHash
      !== proof.expectedPackageRecoveryTreeInventoryHash
    || !canonicalAbsolutePath(proof.productionPackagePath)
    || proof.restoreTargetPath === proof.productionPackagePath
    || !validHash(proof.productionPackageIdentityHashBefore)
    || proof.productionPackageIdentityHashAfter
      !== proof.productionPackageIdentityHashBefore
    || proof.productionPackageContentHashBefore !== proof.expectedPackageContentHash
    || proof.productionPackageContentHashAfter
      !== proof.productionPackageContentHashBefore
    || proof.productionPackageRecoveryTreeInventoryHashBefore
      !== proof.expectedPackageRecoveryTreeInventoryHash
    || proof.productionPackageRecoveryTreeInventoryHashAfter
      !== proof.productionPackageRecoveryTreeInventoryHashBefore
    || !canonicalTime(proof.startedAt)
    || !strictlyAfter(proof.completedAt, proof.startedAt)
    || !strictlyAfter(proof.retainUntil, proof.completedAt)
    || !exactEmptyArray(proof.blockers)
    || proof.productionPackageMutated !== false
    || proof.externalActionPerformed !== true
    || hashRecord('PackageExactRestoreExecutionProof', payload)
      !== packageExactRestoreExecutionProofHash) {
    blockers.push('package_exact_restore_execution_proof_invalid');
  }
  if (!recoverySourceAuthority) {
    blockers.push('package_exact_restore_execution_source_required');
  } else if (proof?.packageImmutableRecoverySourceAuthorityHash
      !== recoverySourceAuthority.packageImmutableRecoverySourceAuthorityHash
    || proof?.packageRecoveryStorageAuthorityProofHash
      !== recoverySourceAuthority.packageRecoveryStorageAuthorityProofHash
    || proof?.storageAuthorityId !== recoverySourceAuthority.storageAuthorityId
    || proof?.storageObjectId !== recoverySourceAuthority.storageObjectId
    || proof?.storageObjectVersion !== recoverySourceAuthority.storageObjectVersion
    || proof?.storageObjectPath !== recoverySourceAuthority.storageObjectPath
    || proof?.storageObjectBytesHash !== recoverySourceAuthority.storageObjectBytesHash
    || proof?.storageLedgerReceiptId
      !== recoverySourceAuthority.storageLedgerReceiptId
    || proof?.storageLedgerReceiptHash
      !== recoverySourceAuthority.storageLedgerReceiptHash
    || proof?.trustStoreHash !== recoverySourceAuthority.trustStoreHash
    || proof?.sourceInventoryHash !== recoverySourceAuthority.sourceInventoryHash
    || proof?.packageRecoveryTreeInventoryHash
      !== recoverySourceAuthority.packageRecoveryTreeInventoryHash
    || proof?.retentionLockVersion !== recoverySourceAuthority.retentionLockVersion
    || proof?.retentionLockIdentityHash
      !== recoverySourceAuthority.retentionLockIdentityHash
    || proof?.retainUntil !== recoverySourceAuthority.retainUntil
    || proof?.expectedPackageContentHash !== recoverySourceAuthority.packageContentHash
    || proof?.productionPackagePath !== recoverySourceAuthority.packagePath
    || !pathsDisjoint(recoverySourceAuthority.runtimeRoot, proof?.restoreTargetPath)
    || !pathsDisjoint(proof?.restoreTargetPath, recoverySourceAuthority.storageObjectPath)
    || !strictlyAfter(proof?.startedAt, recoverySourceAuthority.verifiedAt)) {
    blockers.push('package_exact_restore_execution_source_binding_invalid');
  }
  return result(blockers);
}

export function verifyTrustedPackageRecoveryStorageProof(
  verifier,
  proof,
  context,
) {
  return trustedProof(verifier, proof, context);
}
