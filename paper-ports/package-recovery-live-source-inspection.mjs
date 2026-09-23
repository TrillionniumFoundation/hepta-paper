import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { hasExactPlainObjectKeys } from '../workflow-kernel/exact-object-keys.mjs';
import { hashRecord } from '../workflow-kernel/record-hash.mjs';

const SHA256 = /^sha256:[a-f0-9]{64}$/;
const NO_FOLLOW = fs.constants.O_NOFOLLOW || 0;
const READ_BUFFER_BYTES = 4 * 1024 * 1024;
export const PACKAGE_RECOVERY_MINIMUM_LIVE_HORIZON_MS = 30 * 24 * 60 * 60 * 1000;
const LIVE_RECOVERY_KEYS = Object.freeze([
  'authoritySnapshotHash', 'blockers', 'deletionProtected', 'immutable',
  'packageLifecycleReceiptHash',
  'packageRecoveryRetentionPolicyHash', 'packageRecoveryStorageAuthorityProofHash',
  'packageRecoveryTreeInventoryHash', 'retainUntil', 'retentionLockVersion',
  'retentionLockIdentityHash', 'sourceInventoryHash', 'sourcePresent',
  'storageAuthorityId', 'storageClass', 'storageObjectBytesHash', 'storageObjectId',
  'storageObjectVersion',
  'storageObjectIdentityHash', 'storageObjectPath', 'storageObjectRealPath', 'valid',
  'storageIssuerPolicyHash', 'storageLedgerReceiptHash', 'storageLedgerReceiptId',
  'trustStoreHash',
]);

function validHash(value) {
  return typeof value === 'string' && SHA256.test(value);
}

function sameFileIdentity(left, right) {
  return [
    'dev', 'ino', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs',
  ].every((key) => String(left?.[key]) === String(right?.[key]));
}

function pinnedFileHash(candidate) {
  const selected = fs.lstatSync(candidate, { bigint: true });
  const descriptor = fs.openSync(candidate, fs.constants.O_RDONLY | NO_FOLLOW);
  try {
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || !sameFileIdentity(selected, opened)) return null;
    const digest = crypto.createHash('sha256');
    const buffer = Buffer.allocUnsafe(READ_BUFFER_BYTES);
    let offset = 0;
    for (;;) {
      const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, offset);
      if (!bytesRead) break;
      digest.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    const after = fs.fstatSync(descriptor, { bigint: true });
    const atPath = fs.lstatSync(candidate, { bigint: true });
    return sameFileIdentity(opened, after) && sameFileIdentity(after, atPath)
      ? `sha256:${digest.digest('hex')}` : null;
  } finally { fs.closeSync(descriptor); }
}

function outsideRuntimeRoot(runtimeRootRealPath, candidateRealPath) {
  const relative = path.relative(runtimeRootRealPath, candidateRealPath);
  return relative !== '' && [
    relative === '..', relative.startsWith(`..${path.sep}`), path.isAbsolute(relative),
  ].some(Boolean);
}

function inspectPinnedStorageObject(runtimeRoot, candidate) {
  if (![runtimeRoot, candidate].every((value) => typeof value === 'string')
    || ![runtimeRoot, candidate].every(path.isAbsolute)) return null;
  try {
    const runtimeRootRealPath = fs.realpathSync.native(runtimeRoot);
    const before = fs.lstatSync(candidate, { bigint: true });
    if ([!before.isFile(), before.isSymbolicLink(), before.nlink !== 1n,
      (Number(before.mode) & 0o222) !== 0].some(Boolean)) return null;
    const storageObjectRealPath = fs.realpathSync.native(candidate);
    if (!outsideRuntimeRoot(runtimeRootRealPath, storageObjectRealPath)) return null;
    const storageObjectBytesHash = pinnedFileHash(candidate);
    const after = fs.lstatSync(candidate, { bigint: true });
    if (!storageObjectBytesHash || ![
      'dev', 'ino', 'mode', 'size', 'mtimeNs', 'nlink',
    ].every((key) => before[key] === after[key])) return null;
    const identity = Object.freeze({
      dev: String(after.dev), ino: String(after.ino), mode: String(after.mode),
      size: String(after.size), mtimeNs: String(after.mtimeNs),
      nlink: String(after.nlink), realPath: storageObjectRealPath,
    });
    return Object.freeze({
      storageObjectBytesHash,
      storageObjectRealPath,
      storageObjectIdentityHash: hashRecord('PackageRecoveryLiveStorageObjectIdentity', identity),
    });
  } catch { return null; }
}

export function packageRecoveryLiveAuthoritySnapshotHash(live) {
  const keys = [
    'packageLifecycleReceiptHash', 'packageRecoveryStorageAuthorityProofHash',
    'packageRecoveryRetentionPolicyHash', 'storageAuthorityId', 'storageClass',
    'storageObjectId', 'storageObjectVersion', 'storageObjectPath', 'storageObjectRealPath',
    'storageObjectIdentityHash', 'storageObjectBytesHash', 'storageIssuerPolicyHash',
    'storageLedgerReceiptHash', 'storageLedgerReceiptId', 'trustStoreHash',
    'sourceInventoryHash', 'packageRecoveryTreeInventoryHash',
    'retentionLockVersion', 'retentionLockIdentityHash', 'retainUntil',
    'sourcePresent', 'immutable', 'deletionProtected',
  ];
  return hashRecord('PackageRecoveryLiveAuthoritySnapshot', Object.fromEntries(
    keys.map((key) => [key, live[key]]),
  ));
}

export function validateTrustedPackageRecoveryLiveSource({
  live, recoveryReceipt, lifecycleReceipt, now,
} = {}) {
  const retentionPolicy = recoveryReceipt?.retentionPolicy
    || recoveryReceipt?.recoverySourceAuthority?.retentionPolicy;
  const recoverySource = recoveryReceipt?.recoverySourceAuthority;
  const storageProof = recoverySource?.storageAuthorityProof;
  const storageObjectPath = recoveryReceipt?.storageObjectPath
    || recoverySource?.storageObjectPath;
  const storageObjectBytesHash = recoveryReceipt?.storageObjectBytesHash
    || recoverySource?.storageObjectBytesHash;
  const inspected = inspectPinnedStorageObject(lifecycleReceipt?.runtimeRoot, live?.storageObjectPath);
  const valid = hasExactPlainObjectKeys(live, LIVE_RECOVERY_KEYS) && inspected && [
    live.valid === true, Array.isArray(live.blockers), live.blockers?.length === 0,
    live.sourcePresent === true, live.immutable === true, live.deletionProtected === true,
    live.packageLifecycleReceiptHash === lifecycleReceipt?.packageLifecycleReceiptHash,
    live.packageRecoveryStorageAuthorityProofHash === recoverySource?.packageRecoveryStorageAuthorityProofHash,
    live.packageRecoveryRetentionPolicyHash === recoverySource?.packageRecoveryRetentionPolicyHash,
    live.storageAuthorityId === recoverySource?.storageAuthorityId,
    live.storageClass === recoverySource?.storageClass,
    live.storageObjectId === recoverySource?.storageObjectId,
    live.storageObjectVersion === recoverySource?.storageObjectVersion,
    live.storageObjectPath === storageObjectPath,
    live.storageObjectBytesHash === storageObjectBytesHash,
    live.storageObjectBytesHash === inspected?.storageObjectBytesHash,
    live.storageObjectRealPath === inspected?.storageObjectRealPath,
    live.storageObjectIdentityHash === inspected?.storageObjectIdentityHash,
    live.storageIssuerPolicyHash === storageProof?.ledgerIdentity?.issuerPolicyHash,
    live.storageLedgerReceiptHash === storageProof?.ledgerIdentity?.receiptHash,
    live.storageLedgerReceiptId === storageProof?.ledgerIdentity?.receiptId,
    live.trustStoreHash === storageProof?.trustStoreHash,
    live.sourceInventoryHash === recoverySource?.sourceInventoryHash,
    live.packageRecoveryTreeInventoryHash
      === recoverySource?.packageRecoveryTreeInventoryHash,
    live.sourceInventoryHash === live.packageRecoveryTreeInventoryHash,
    live.retainUntil === retentionPolicy?.retainUntil,
    live.retentionLockVersion === retentionPolicy?.retentionLockVersion,
    live.retentionLockIdentityHash === retentionPolicy?.retentionLockIdentityHash,
    validHash(live.authoritySnapshotHash),
    live.authoritySnapshotHash === packageRecoveryLiveAuthoritySnapshotHash(live),
    ...['packageRecoveryStorageAuthorityProofHash', 'packageRecoveryRetentionPolicyHash',
      'storageObjectBytesHash', 'sourceInventoryHash', 'retentionLockIdentityHash',
      'packageRecoveryTreeInventoryHash',
      'storageIssuerPolicyHash', 'storageLedgerReceiptHash', 'trustStoreHash']
      .map((key) => validHash(live[key])),
    Number.isFinite(Date.parse(live.retainUntil || '')), Number.isFinite(Date.parse(now || '')),
    Date.parse(live.retainUntil) - Date.parse(now) >= PACKAGE_RECOVERY_MINIMUM_LIVE_HORIZON_MS,
  ].every(Boolean);
  return valid ? Object.freeze({ ...live, blockers: Object.freeze([]) }) : null;
}
