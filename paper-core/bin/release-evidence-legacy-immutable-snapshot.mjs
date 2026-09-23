import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { releaseIntegrityEvidence } from './release-integrity-evidence.mjs';
import { releaseStateSnapshotsMatch } from './release-verification-receipt-selection.mjs';
import {
  immutableArchiveDirectoryChainUnchanged,
  selectedDirectorySnapshot,
  selectedDirectoryUnchanged,
  snapshotImmutableArchiveDirectoryChain,
} from './release-evidence-filesystem-identity.mjs';

const IMMUTABLE_SNAPSHOT_FILE_PATTERN =
  /^IMMUTABLE_SNAPSHOT_RECEIPT_(\d{13})_([a-f0-9]{64})\.json$/;
const LEGACY_IMMUTABLE_SNAPSHOT_FILE_PATTERN =
  /^IMMUTABLE_SNAPSHOT_RECEIPT_[a-f0-9]{64}\.json$/;
const IMMUTABLE_SNAPSHOT_MAXIMUM_FUTURE_SKEW_MS = 5 * 60 * 1000;
const IMMUTABLE_SNAPSHOT_RECEIPT_KEYS = Object.freeze([
  'archiveDevice', 'archiveHash', 'archiveImmutable', 'archiveInode', 'archiveMode',
  'archivePath', 'archiveSize', 'codeProvenance', 'createdAt',
  'destructiveDeletionPerformed', 'filesystemMechanism', 'fullFilesystemWormClaimed',
  'immutableContentObjectClaimed', 'immutableSnapshotReceiptHash', 'kind',
  'referenceVersion', 'releaseStateSnapshot', 'releaseStateSnapshotHash', 'status', 'version',
]);
const {
  SHA256_PATTERN,
  exactCleanCodeProvenanceBlockers,
  exactCodeProvenanceMatches,
  exactKeys,
  isPlainObject,
  loadExistingReleaseSigningKey,
  readRegularFileNoFollow,
  sha256Bytes,
  unique,
  verifyReleaseIntegritySignature,
} = releaseIntegrityEvidence;

export function inspectLegacyReferenceArchive({
  archivePath,
  fileSystem = fs,
  spawnSyncImpl = spawnSync,
} = {}) {
  if (typeof archivePath !== 'string' || !path.isAbsolute(archivePath)
    || path.resolve(archivePath) !== archivePath) {
    throw new Error('legacy_immutable_snapshot_archive_path_invalid');
  }
  const parent = path.dirname(archivePath);
  const parentChain = snapshotImmutableArchiveDirectoryChain(parent, fileSystem);
  const canonicalParent = fileSystem.realpathSync(parent);
  if (path.resolve(canonicalParent) !== parent) {
    throw new Error('legacy_immutable_snapshot_archive_parent_unsafe');
  }
  const parentBefore = fileSystem.lstatSync(parent);
  if (!parentBefore.isDirectory() || parentBefore.isSymbolicLink()) {
    throw new Error('legacy_immutable_snapshot_archive_parent_unsafe');
  }
  let descriptor;
  try {
    descriptor = fileSystem.openSync(
      archivePath,
      fileSystem.constants.O_RDONLY | (fileSystem.constants.O_NOFOLLOW || 0),
    );
    const before = fileSystem.fstatSync(descriptor);
    const selected = fileSystem.lstatSync(archivePath);
    if (!before.isFile() || Number(before.nlink) !== 1
      || !selected.isFile() || selected.isSymbolicLink()
      || selected.dev !== before.dev || selected.ino !== before.ino
      || !Number.isSafeInteger(before.size) || before.size < 1) {
      throw new Error('legacy_immutable_snapshot_archive_unsafe');
    }
    const hash = crypto.createHash('sha256');
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    while (position < before.size) {
      const read = fileSystem.readSync(
        descriptor,
        buffer,
        0,
        Math.min(buffer.length, before.size - position),
        position,
      );
      if (read < 1) throw new Error('legacy_immutable_snapshot_archive_short_read');
      hash.update(buffer.subarray(0, read));
      position += read;
    }
    let immutableResult;
    try {
      immutableResult = spawnSyncImpl('lsattr', ['-d', '--', archivePath], {
        encoding: 'utf8',
        maxBuffer: 1024 * 1024,
      });
    } catch {
      immutableResult = { status: null, stdout: '' };
    }
    const attributes = String(immutableResult?.stdout || '').trim().split(/\s+/u)[0] || '';
    const archiveImmutable = immutableResult?.status === 0 && attributes.includes('i');
    const after = fileSystem.fstatSync(descriptor);
    const finalPath = fileSystem.lstatSync(archivePath);
    const parentAfter = fileSystem.lstatSync(parent);
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size
      || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs
      || !finalPath.isFile() || finalPath.isSymbolicLink()
      || finalPath.dev !== before.dev || finalPath.ino !== before.ino
      || parentAfter.dev !== parentBefore.dev || parentAfter.ino !== parentBefore.ino
      || parentAfter.mtimeMs !== parentBefore.mtimeMs
      || parentAfter.ctimeMs !== parentBefore.ctimeMs
      || path.resolve(fileSystem.realpathSync(parent)) !== parent
      || !immutableArchiveDirectoryChainUnchanged(parentChain, fileSystem)) {
      throw new Error('legacy_immutable_snapshot_archive_changed_during_inspection');
    }
    return Object.freeze({
      archivePath,
      archiveHash: `sha256:${hash.digest('hex')}`,
      archiveDevice: String(before.dev),
      archiveInode: String(before.ino),
      archiveSize: before.size,
      archiveMode: before.mode & 0o7777,
      archiveImmutable,
    });
  } finally {
    if (descriptor !== undefined) fileSystem.closeSync(descriptor);
  }
}

function immutableSnapshotPayload(receipt) {
  const payload = { ...receipt };
  delete payload.immutableSnapshotReceiptHash;
  return payload;
}

function blockedImmutableSnapshotSelection(blockers, details = {}) {
  return Object.freeze({
    version: 1,
    kind: 'LegacyImmutableSnapshotEvidenceSelection',
    status: 'legacy_immutable_snapshot_current_evidence_blocked',
    receipt: null,
    receiptHash: null,
    releaseEvidenceReady: false,
    blockers: unique(blockers),
    ...details,
  });
}

export function verifyCurrentLegacyImmutableSnapshotReceipt({
  receipt,
  signature,
  expectedCodeProvenance,
  expectedReleaseStateSnapshot,
  expectedArchivePath,
  currentArchive,
  pinnedPublicKeyPem,
  pinnedPublicKeyFingerprint,
  candidateName,
  signatureCandidateName,
  now = new Date(),
} = {}) {
  const blockers = [];
  if (!isPlainObject(receipt)) {
    return Object.freeze({
      status: 'legacy_immutable_snapshot_receipt_invalid',
      blockers: ['legacy_immutable_snapshot_json_object_required'],
      receipt: null,
      receiptHash: null,
    });
  }
  if (!exactKeys(receipt, IMMUTABLE_SNAPSHOT_RECEIPT_KEYS)) {
    blockers.push('legacy_immutable_snapshot_receipt_shape_invalid');
  }
  if (receipt.version !== 2) blockers.push('legacy_immutable_snapshot_receipt_v2_required');
  if (receipt.kind !== 'LegacyReferenceImmutableSnapshotReceipt') {
    blockers.push('legacy_immutable_snapshot_receipt_kind_invalid');
  }
  if (receipt.status !== 'legacy_reference_ext4_inode_immutable'
    || receipt.archiveImmutable !== true
    || receipt.immutableContentObjectClaimed !== true
    || receipt.fullFilesystemWormClaimed !== false
    || receipt.destructiveDeletionPerformed !== false
    || receipt.filesystemMechanism !== 'ext4_inode_immutable_flag') {
    blockers.push('legacy_immutable_snapshot_receipt_status_invalid');
  }
  if (exactCleanCodeProvenanceBlockers(expectedCodeProvenance).length
    || !exactCodeProvenanceMatches(receipt.codeProvenance, expectedCodeProvenance)) {
    blockers.push('legacy_immutable_snapshot_code_provenance_mismatch');
  }
  if (!releaseStateSnapshotsMatch(receipt.releaseStateSnapshot, expectedReleaseStateSnapshot)
    || receipt.releaseStateSnapshotHash
      !== expectedReleaseStateSnapshot?.workspaceReleaseStateSnapshotHash) {
    blockers.push('legacy_immutable_snapshot_release_state_mismatch');
  }
  if (receipt.referenceVersion !== expectedCodeProvenance?.packageVersion) {
    blockers.push('legacy_immutable_snapshot_reference_version_mismatch');
  }
  if (typeof expectedArchivePath !== 'string' || !path.isAbsolute(expectedArchivePath)
    || path.resolve(expectedArchivePath) !== expectedArchivePath
    || receipt.archivePath !== expectedArchivePath
    || currentArchive?.archivePath !== expectedArchivePath) {
    blockers.push('legacy_immutable_snapshot_archive_path_mismatch');
  }
  if (!SHA256_PATTERN.test(String(receipt.archiveHash || ''))
    || receipt.archiveHash !== currentArchive?.archiveHash) {
    blockers.push('legacy_immutable_snapshot_archive_hash_mismatch');
  }
  if (receipt.archiveDevice !== currentArchive?.archiveDevice
    || receipt.archiveInode !== currentArchive?.archiveInode
    || receipt.archiveSize !== currentArchive?.archiveSize
    || receipt.archiveMode !== currentArchive?.archiveMode
    || currentArchive?.archiveImmutable !== true) {
    blockers.push('legacy_immutable_snapshot_archive_identity_or_immutable_state_mismatch');
  }
  const createdAtMs = Date.parse(String(receipt.createdAt || ''));
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(String(now || ''));
  if (!Number.isFinite(createdAtMs) || !Number.isFinite(nowMs)
    || new Date(createdAtMs).toISOString() !== receipt.createdAt) {
    blockers.push('legacy_immutable_snapshot_time_invalid');
  } else if (createdAtMs > nowMs + IMMUTABLE_SNAPSHOT_MAXIMUM_FUTURE_SKEW_MS) {
    blockers.push('legacy_immutable_snapshot_created_in_future');
  }
  const claimedReceiptHash = receipt.immutableSnapshotReceiptHash;
  const computedReceiptHash = hashRecord(
    'LegacyReferenceImmutableSnapshotReceipt',
    immutableSnapshotPayload(receipt),
  );
  if (!SHA256_PATTERN.test(String(claimedReceiptHash || ''))
    || claimedReceiptHash !== computedReceiptHash) {
    blockers.push('legacy_immutable_snapshot_self_hash_mismatch');
  }
  const token = SHA256_PATTERN.test(String(claimedReceiptHash || ''))
    ? claimedReceiptHash.slice('sha256:'.length)
    : null;
  const expectedCandidateName = Number.isFinite(createdAtMs) && token
    ? `IMMUTABLE_SNAPSHOT_RECEIPT_${createdAtMs}_${token}.json`
    : null;
  const expectedSignatureName = Number.isFinite(createdAtMs) && token
    ? `IMMUTABLE_SNAPSHOT_SIGNATURE_${createdAtMs}_${token}.json`
    : null;
  if (candidateName !== expectedCandidateName) {
    blockers.push('legacy_immutable_snapshot_filename_binding_mismatch');
  }
  if (signatureCandidateName !== expectedSignatureName) {
    blockers.push('legacy_immutable_snapshot_signature_filename_binding_mismatch');
  }
  if (!verifyReleaseIntegritySignature(receipt, signature, {
    pinnedPublicKeyPem,
    pinnedPublicKeyFingerprint,
  })) blockers.push('legacy_immutable_snapshot_signature_invalid');
  const valid = blockers.length === 0;
  return Object.freeze({
    status: valid
      ? 'legacy_immutable_snapshot_current_receipt_verified'
      : 'legacy_immutable_snapshot_receipt_invalid',
    blockers: unique(blockers),
    receipt: valid ? Object.freeze(receipt) : null,
    claimedReceiptHash: SHA256_PATTERN.test(String(claimedReceiptHash || ''))
      ? claimedReceiptHash : null,
    receiptHash: valid ? computedReceiptHash : null,
  });
}

function immutableSnapshotCandidateOrder(name) {
  const match = IMMUTABLE_SNAPSHOT_FILE_PATTERN.exec(name);
  if (match) return { timestamp: Number(match[1]), recognized: true };
  if (LEGACY_IMMUTABLE_SNAPSHOT_FILE_PATTERN.test(name)) {
    return { timestamp: 0, recognized: false };
  }
  return { timestamp: Number.POSITIVE_INFINITY, recognized: false };
}


export function selectCurrentLegacyImmutableSnapshotReceipt({
  archivePath,
  runtimeRoot,
  expectedCodeProvenance,
  expectedReleaseStateSnapshot,
  now = new Date(),
  spawnSyncImpl = spawnSync,
} = {}) {
  if (typeof archivePath !== 'string' || !path.isAbsolute(archivePath)
    || path.resolve(archivePath) !== archivePath
    || typeof runtimeRoot !== 'string' || !path.isAbsolute(runtimeRoot)) {
    return blockedImmutableSnapshotSelection(['legacy_immutable_snapshot_inputs_invalid']);
  }
  const archiveRoot = path.dirname(archivePath);
  let rootSnapshot;
  let names;
  try {
    rootSnapshot = selectedDirectorySnapshot(archiveRoot);
    names = fs.readdirSync(archiveRoot)
      .filter((name) => name.startsWith('IMMUTABLE_SNAPSHOT_RECEIPT_')
        && name.endsWith('.json'));
  } catch {
    return blockedImmutableSnapshotSelection(['legacy_immutable_snapshot_root_unreadable']);
  }
  if (!names.length) {
    return blockedImmutableSnapshotSelection(['legacy_immutable_snapshot_receipt_missing']);
  }
  names.sort((left, right) => {
    const leftOrder = immutableSnapshotCandidateOrder(left);
    const rightOrder = immutableSnapshotCandidateOrder(right);
    return leftOrder.timestamp - rightOrder.timestamp || left.localeCompare(right);
  });
  const candidateName = names.at(-1);
  const candidateOrder = immutableSnapshotCandidateOrder(candidateName);
  const candidatePath = path.join(archiveRoot, candidateName);
  let key;
  try { key = loadExistingReleaseSigningKey(runtimeRoot); } catch {
    return blockedImmutableSnapshotSelection(
      ['legacy_immutable_snapshot_pinned_public_key_unavailable'],
      { candidateName, candidatePath },
    );
  }
  const baseDetails = {
    candidateName,
    candidatePath,
    pinnedPublicKeyFingerprint: key.publicKeyFingerprint,
  };
  if (!candidateOrder.recognized) {
    return blockedImmutableSnapshotSelection(
      ['legacy_immutable_snapshot_candidate_name_invalid'],
      baseDetails,
    );
  }
  const match = IMMUTABLE_SNAPSHOT_FILE_PATTERN.exec(candidateName);
  const signatureCandidateName = `IMMUTABLE_SNAPSHOT_SIGNATURE_${match[1]}_${match[2]}.json`;
  const signaturePath = path.join(archiveRoot, signatureCandidateName);
  let receiptBytes;
  let signatureBytes;
  try {
    receiptBytes = readRegularFileNoFollow(candidatePath);
  } catch {
    return blockedImmutableSnapshotSelection(
      ['legacy_immutable_snapshot_candidate_file_unsafe'],
      { ...baseDetails, signatureCandidateName, signaturePath },
    );
  }
  const candidateFileHash = sha256Bytes(receiptBytes);
  try {
    signatureBytes = readRegularFileNoFollow(signaturePath);
  } catch {
    return blockedImmutableSnapshotSelection(
      ['legacy_immutable_snapshot_signature_file_unsafe'],
      { ...baseDetails, signatureCandidateName, signaturePath, candidateFileHash },
    );
  }
  const signatureFileHash = sha256Bytes(signatureBytes);
  let receipt;
  let signature;
  try { receipt = JSON.parse(receiptBytes.toString('utf8')); } catch {
    return blockedImmutableSnapshotSelection(
      ['legacy_immutable_snapshot_candidate_json_invalid'],
      { ...baseDetails, signatureCandidateName, signaturePath, candidateFileHash, signatureFileHash },
    );
  }
  try { signature = JSON.parse(signatureBytes.toString('utf8')); } catch {
    return blockedImmutableSnapshotSelection(
      ['legacy_immutable_snapshot_signature_json_invalid'],
      { ...baseDetails, signatureCandidateName, signaturePath, candidateFileHash, signatureFileHash },
    );
  }
  let currentArchive;
  try {
    currentArchive = inspectLegacyReferenceArchive({ archivePath, spawnSyncImpl });
  } catch {
    return blockedImmutableSnapshotSelection(
      ['legacy_immutable_snapshot_current_archive_unsafe'],
      { ...baseDetails, signatureCandidateName, signaturePath, candidateFileHash, signatureFileHash },
    );
  }
  if (!selectedDirectoryUnchanged(archiveRoot, rootSnapshot)) {
    return blockedImmutableSnapshotSelection(
      ['legacy_immutable_snapshot_root_changed_during_selection'],
      { ...baseDetails, signatureCandidateName, signaturePath, candidateFileHash, signatureFileHash },
    );
  }
  const verification = verifyCurrentLegacyImmutableSnapshotReceipt({
    receipt,
    signature,
    expectedCodeProvenance,
    expectedReleaseStateSnapshot,
    expectedArchivePath: archivePath,
    currentArchive,
    pinnedPublicKeyPem: key.publicKeyPem,
    pinnedPublicKeyFingerprint: key.publicKeyFingerprint,
    candidateName,
    signatureCandidateName,
    now,
  });
  if (verification.status !== 'legacy_immutable_snapshot_current_receipt_verified') {
    return blockedImmutableSnapshotSelection(verification.blockers, {
      ...baseDetails,
      signatureCandidateName,
      signaturePath,
      candidateFileHash,
      signatureFileHash,
      claimedReceiptHash: verification.claimedReceiptHash,
    });
  }
  return Object.freeze({
    version: 1,
    kind: 'LegacyImmutableSnapshotEvidenceSelection',
    status: 'legacy_immutable_snapshot_current_evidence_verified',
    receipt: verification.receipt,
    receiptHash: verification.receiptHash,
    claimedReceiptHash: verification.claimedReceiptHash,
    candidateName,
    candidatePath,
    candidateFileHash,
    signatureCandidateName,
    signaturePath,
    signatureFileHash,
    pinnedPublicKeyFingerprint: key.publicKeyFingerprint,
    currentArchive,
    releaseEvidenceReady: true,
    blockers: [],
  });
}
