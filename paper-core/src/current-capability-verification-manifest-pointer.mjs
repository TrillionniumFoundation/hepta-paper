import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  isolatedVerificationCodeProvenance,
  isolatedVerificationCodeProvenanceMatches,
  isolatedVerificationReleaseStateSnapshotBlockers,
  verifyIsolatedVerificationReceipt,
} from './isolated-verification-receipt-contract.mjs';

const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const MANIFEST_PATH = /^release-evidence\/capability-verification-manifests\/CAPABILITY_VERIFICATION_MANIFEST_([a-f0-9]{64})\.json$/u;
const RECEIPT_PATH = /^release-evidence\/verification-receipts\/ISOLATED_VERIFICATION_RECEIPT_(\d{13})_([a-f0-9]{64})\.json$/u;
const POINTER_KEYS = Object.freeze([
  'capabilityVerificationManifestHash', 'codeProvenance', 'completedAt',
  'currentCapabilityVerificationManifestPointerHash', 'isolatedVerificationReceiptFileHash',
  'isolatedVerificationReceiptHash', 'isolatedVerificationReceiptRelativePath', 'kind',
  'releaseCommit', 'releaseStateSnapshot', 'releaseStateSnapshotHash', 'status',
  'targetFileHash', 'targetRelativePath', 'version',
]);

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype
      || Object.getPrototypeOf(value) === null);
}

function exactKeys(value, expected) {
  return plainObject(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

function strictIso(value) {
  const timestamp = Date.parse(String(value || ''));
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value
    ? timestamp
    : null;
}

function pointerBlockers(pointer) {
  const blockers = [];
  if (!exactKeys(pointer, POINTER_KEYS)
    || pointer.version !== 1
    || pointer.kind !== 'CurrentCapabilityVerificationManifestPointer'
    || pointer.status !== 'current_capability_verification_manifest_pointer_bound') {
    return ['current_capability_verification_manifest_pointer_shape_invalid'];
  }
  let provenance;
  try { provenance = isolatedVerificationCodeProvenance(pointer.codeProvenance, { requireClean: true }); }
  catch { blockers.push('current_capability_verification_manifest_pointer_provenance_invalid'); }
  if (provenance && (provenance.evidenceEnvironment !== 'verification'
    || provenance.evidenceClass !== 'technical_conformance'
    || pointer.releaseCommit !== provenance.commit)) {
    blockers.push('current_capability_verification_manifest_pointer_provenance_invalid');
  }
  if (isolatedVerificationReleaseStateSnapshotBlockers(
    pointer.releaseStateSnapshot,
    'current_capability_verification_manifest_pointer_release_state',
    {
      expectedCommit: pointer.releaseCommit,
      expectedPackageVersion: provenance?.packageVersion || null,
    },
  ).length
    || pointer.releaseStateSnapshotHash
      !== pointer.releaseStateSnapshot?.workspaceReleaseStateSnapshotHash
    || pointer.releaseStateSnapshot?.headCommit !== pointer.releaseCommit) {
    blockers.push('current_capability_verification_manifest_pointer_release_state_invalid');
  }
  const manifestMatch = MANIFEST_PATH.exec(String(pointer.targetRelativePath || ''));
  if (!manifestMatch || pointer.targetFileHash !== `sha256:${manifestMatch?.[1] || ''}`) {
    blockers.push('current_capability_verification_manifest_pointer_target_invalid');
  }
  const receiptMatch = RECEIPT_PATH.exec(String(pointer.isolatedVerificationReceiptRelativePath || ''));
  const completedAtMs = strictIso(pointer.completedAt);
  if (!receiptMatch || completedAtMs === null
    || Number(receiptMatch?.[1]) !== completedAtMs
    || pointer.isolatedVerificationReceiptHash !== `sha256:${receiptMatch?.[2] || ''}`
    || !SHA256.test(String(pointer.isolatedVerificationReceiptFileHash || ''))) {
    blockers.push('current_capability_verification_manifest_pointer_receipt_invalid');
  }
  if (!SHA256.test(String(pointer.capabilityVerificationManifestHash || ''))) {
    blockers.push('current_capability_verification_manifest_pointer_manifest_hash_invalid');
  }
  const {
    currentCapabilityVerificationManifestPointerHash: claimedHash,
    ...payload
  } = pointer;
  if (!SHA256.test(String(claimedHash || ''))
    || claimedHash !== hashRecord('CurrentCapabilityVerificationManifestPointer', payload)) {
    blockers.push('current_capability_verification_manifest_pointer_self_hash_mismatch');
  }
  return [...new Set(blockers)];
}

export function buildCurrentCapabilityVerificationManifestPointer({
  receipt,
  receiptRelativePath,
  receiptFileHash,
  targetRelativePath,
  targetFileHash,
  capabilityVerificationManifestHash,
} = {}) {
  const verification = verifyIsolatedVerificationReceipt({
    receipt,
    expectedMode: 'release',
  });
  if (verification.status !== 'isolated_verification_receipt_verified'
    || receipt.status !== 'isolated_verification_passed'
    || receipt.blockers.length) {
    throw new Error('current_capability_verification_manifest_pointer_receipt_not_passed');
  }
  const payload = {
    version: 1,
    kind: 'CurrentCapabilityVerificationManifestPointer',
    status: 'current_capability_verification_manifest_pointer_bound',
    targetRelativePath,
    targetFileHash,
    capabilityVerificationManifestHash,
    isolatedVerificationReceiptRelativePath: receiptRelativePath,
    isolatedVerificationReceiptHash: receipt.isolatedVerificationReceiptHash,
    isolatedVerificationReceiptFileHash: receiptFileHash,
    releaseCommit: receipt.codeProvenance.commit,
    codeProvenance: receipt.codeProvenance,
    releaseStateSnapshot: receipt.releaseStateSnapshot,
    releaseStateSnapshotHash:
      receipt.releaseStateSnapshot.workspaceReleaseStateSnapshotHash,
    completedAt: receipt.completedAt,
  };
  const pointer = Object.freeze({
    ...payload,
    currentCapabilityVerificationManifestPointerHash: hashRecord(
      'CurrentCapabilityVerificationManifestPointer',
      payload,
    ),
  });
  const blockers = pointerBlockers(pointer);
  if (blockers.length) throw new Error(blockers.join(','));
  return pointer;
}

export function verifyCurrentCapabilityVerificationManifestPointer({
  pointer,
  expectedReceipt = null,
} = {}) {
  const blockers = pointerBlockers(pointer);
  if (expectedReceipt !== null) {
    const verification = verifyIsolatedVerificationReceipt({
      receipt: expectedReceipt,
      expectedMode: 'release',
    });
    if (verification.status !== 'isolated_verification_receipt_verified'
      || expectedReceipt.status !== 'isolated_verification_passed'
      || !isolatedVerificationCodeProvenanceMatches(
        pointer?.codeProvenance,
        expectedReceipt.codeProvenance,
      )
      || pointer?.releaseStateSnapshotHash
        !== expectedReceipt.releaseStateSnapshot?.workspaceReleaseStateSnapshotHash
      || pointer?.isolatedVerificationReceiptHash
        !== expectedReceipt.isolatedVerificationReceiptHash
      || pointer?.completedAt !== expectedReceipt.completedAt) {
      blockers.push('current_capability_verification_manifest_pointer_receipt_mismatch');
    }
  }
  return Object.freeze({
    status: blockers.length
      ? 'current_capability_verification_manifest_pointer_invalid'
      : 'current_capability_verification_manifest_pointer_verified',
    blockers: Object.freeze([...new Set(blockers)]),
    pointer: blockers.length ? null : pointer,
  });
}

export const CURRENT_CAPABILITY_VERIFICATION_MANIFEST_POINTER_KEYS = POINTER_KEYS;
