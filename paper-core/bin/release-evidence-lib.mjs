import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { currentCodeProvenance } from '../src/code-provenance.mjs';
import { assertWorkspaceLayoutPhysicallyDecoupled, defaultPaperAssetRoot } from '../src/workspace-layout.mjs';
import {
  coldVolumeCasStatus,
  verifyColdVolumeContract,
  verifyOffhostWormTarget,
} from '../../paper-composition/bootstrap/operator-release-composition.mjs';
import { verifyLegacyDifferentialReference } from '../../migration/legacy-reference-fixture.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { sha256FileSync } from '../../workflow-kernel/runtime/file-utils.mjs';
import {
  buildSqliteLogicalIntegrityReport,
  createReadOnlyPaperStore,
} from '../../paper-composition/bootstrap/operator-persistence-composition.mjs';
import { immutableLegacyMatrixReferenceStatus, resolveImmutableLegacyMatrixArchive } from '../../migration/legacy-matrix-reference.mjs';
import { loadCapabilityConformanceProofs, loadCapabilityOperationalProofs } from '../../paper-composition/bootstrap/operator-governance-composition.mjs';
import { validateCapabilityOperationalEvidence } from '../../migration/capability-operational-evidence.mjs';
import { CAPABILITY_CATALOG } from '../../paper-domain/governance/capability-catalog.mjs';
import { buildReleaseTrustLayerGate } from '../../paper-domain/governance/release-trust-layer-gate.mjs';
import { releaseIntegrityEvidence } from './release-integrity-evidence.mjs';
import { assertWorkspaceReleaseReady } from '../src/release-state-repository.mjs';
import {
  releaseStateSnapshotsMatch,
  selectCurrentReleaseVerificationReceipt,
} from './release-verification-receipt-selection.mjs';
import { selectCurrentCapabilityVerificationManifest } from './release-capability-manifest-selection.mjs';

const DELETION_DRILL_FILE_PATTERN = /^LEGACY_DELETION_DRILL_(\d{13})(?:_([a-f0-9]{64}))?\.json$/;
const IMMUTABLE_SNAPSHOT_FILE_PATTERN = /^IMMUTABLE_SNAPSHOT_RECEIPT_(\d{13})_([a-f0-9]{64})\.json$/;
const LEGACY_IMMUTABLE_SNAPSHOT_FILE_PATTERN = /^IMMUTABLE_SNAPSHOT_RECEIPT_[a-f0-9]{64}\.json$/;
const defaultWorkspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DELETION_DRILL_MAXIMUM_AGE_MS = 24 * 60 * 60 * 1000;
const DELETION_DRILL_MAXIMUM_FUTURE_SKEW_MS = 5 * 60 * 1000;
const IMMUTABLE_SNAPSHOT_MAXIMUM_FUTURE_SKEW_MS = 5 * 60 * 1000;
const DELETION_DRILL_RECEIPT_KEYS = Object.freeze([
  'archiveHash', 'archiveImmutable', 'archivePath', 'blockers', 'checks', 'codeProvenance',
  'createdAt', 'destructiveDeletionPerformed', 'kind', 'legacyPhysicalDeletionAndRestoreDrillReceiptHash',
  'liveLegacyRootPresent', 'minimalDifferentialFixture', 'operationalProofRequired',
  'operationallyProven', 'ownerAcceptanceRequired', 'ownerAccepted', 'physicalDeletionAllowed',
  'policyChecks', 'releaseStateSnapshot', 'releaseStateSnapshotHash',
  'restoredFromReferenceArchive', 'sqliteQuickCheck', 'status', 'version',
]);
const LEGACY_DELETION_DRILL_COMMAND_RESULT_KEYS = Object.freeze([
  'args', 'errorCode', 'executable', 'exitCode', 'kind', 'signal',
  'stderrHash', 'stdoutHash', 'timedOut', 'version',
]);
const LEGACY_DELETION_DRILL_CHECK_COMMANDS = Object.freeze([
  Object.freeze(['migration/tests/p0-production-core-differential.mjs']),
  Object.freeze(['migration/tests/p1-referee-revision-differential.mjs']),
]);
const LEGACY_DELETION_DRILL_POLICY_COMMANDS = Object.freeze([
  Object.freeze(['migration/tests/matrix-integrity.mjs']),
]);
const IMMUTABLE_SNAPSHOT_RECEIPT_KEYS = Object.freeze([
  'archiveDevice', 'archiveHash', 'archiveImmutable', 'archiveInode', 'archiveMode',
  'archivePath', 'archiveSize', 'codeProvenance', 'createdAt',
  'destructiveDeletionPerformed', 'filesystemMechanism', 'fullFilesystemWormClaimed',
  'immutableContentObjectClaimed', 'immutableSnapshotReceiptHash', 'kind',
  'referenceVersion', 'releaseStateSnapshot', 'releaseStateSnapshotHash', 'status', 'version',
]);
const RELEASE_EVIDENCE_INPUT_SNAPSHOT_KEYS = Object.freeze([
  'authorityTrustStore', 'capabilityCatalogHash', 'capabilityCount',
  'capabilityManifestEvidence', 'codeProvenance', 'coldVolumeCas', 'coldVolumeContract',
  'coldVolumeStatus', 'conformanceProofSet', 'deletionDrillEvidence',
  'implementationProofSet', 'immutableMatrixReference', 'immutableSnapshotEvidence',
  'inputs', 'kind', 'minimalDifferentialFixture', 'offhostWormContract',
  'offhostWormStatus', 'operationalProofSet', 'productionStoreLogicalIntegrity',
  'releaseEvidenceInputSnapshotHash', 'releaseStateSnapshot', 'runtimeHygieneExport',
  'trustLayerGate', 'verificationReceiptEvidence', 'version',
]);
const {
  SHA256_PATTERN,
  assertExactCleanCodeProvenance,
  ensurePrivateDirectoryWithinRuntime,
  existingDirectoryWithinRuntime,
  exactCleanCodeProvenanceBlockers,
  exactCodeProvenanceMatches,
  exactKeys,
  isPlainObject,
  loadExistingReleaseSigningKey,
  pathWithin,
  publishJsonArtifactSet,
  readRegularFileNoFollow,
  removeExactPublishedFile,
  sha256Bytes,
  signReleasePayload,
  unique,
  verifyReleaseIntegritySignature,
  writeNoClobberJsonFile,
} = releaseIntegrityEvidence;

export {
  assertExactCleanCodeProvenance,
  ensurePrivateDirectoryWithinRuntime,
  exactCleanCodeProvenanceBlockers,
  publishJsonArtifactSet,
  removeExactPublishedFile,
  selectCurrentCapabilityVerificationManifest,
  selectCurrentReleaseVerificationReceipt,
  signReleasePayload,
  verifyReleaseIntegritySignature,
  writeNoClobberJsonFile,
};

export function sha256File(file) {
  return sha256FileSync(file);
}

export function contentTreeManifest(root, relativeRoots) {
  const rows = [];
  function walk(absolute, relative) {
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) {
      rows.push({ path: relative, kind: 'symlink', target: fs.readlinkSync(absolute) });
      return;
    }
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(absolute).sort()) walk(path.join(absolute, name), path.join(relative, name));
      return;
    }
    if (stat.isFile()) rows.push({ path: relative.replace(/\\/g, '/'), kind: 'file', bytes: stat.size, sha256: sha256File(absolute) });
  }
  for (const relative of [...relativeRoots].sort()) {
    const absolute = path.join(root, relative);
    if (fs.existsSync(absolute)) walk(absolute, relative);
  }
  const payload = rows.map((row) => JSON.stringify(row)).join('\n');
  return {
    version: 1,
    kind: 'ContentTreeManifest',
    root,
    relativeRoots: [...relativeRoots],
    fileCount: rows.filter((row) => row.kind === 'file').length,
    symlinkCount: rows.filter((row) => row.kind === 'symlink').length,
    totalBytes: rows.reduce((sum, row) => sum + Number(row.bytes || 0), 0),
    rows,
    treeHash: `sha256:${crypto.createHash('sha256').update(payload).digest('hex')}`,
  };
}

function snapshotImmutableArchiveDirectoryChain(directory, fileSystem) {
  const absolute = path.resolve(directory);
  const parsed = path.parse(absolute);
  let current = parsed.root;
  const snapshots = [];
  for (const component of [null, ...absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)]) {
    if (component !== null) current = path.join(current, component);
    const stat = fileSystem.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error('legacy_immutable_snapshot_archive_parent_unsafe');
    }
    snapshots.push(Object.freeze({
      path: current,
      dev: stat.dev,
      ino: stat.ino,
    }));
  }
  return Object.freeze(snapshots);
}

function immutableArchiveDirectoryChainUnchanged(snapshot, fileSystem) {
  return snapshot.every((expected) => {
    try {
      const actual = fileSystem.lstatSync(expected.path);
      return actual.isDirectory() && !actual.isSymbolicLink()
        && actual.dev === expected.dev && actual.ino === expected.ino;
    } catch { return false; }
  });
}

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

function selectedDirectorySnapshot(directory, fileSystem = fs) {
  const stat = fileSystem.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('legacy_immutable_snapshot_root_unsafe');
  }
  return Object.freeze({
    dev: stat.dev,
    ino: stat.ino,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
  });
}

function sameSelectedDirectorySnapshot(left, right) {
  return left.dev === right.dev && left.ino === right.ino
    && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function selectedDirectoryUnchanged(directory, expected, fileSystem = fs) {
  try {
    const actual = selectedDirectorySnapshot(directory, fileSystem);
    return sameSelectedDirectorySnapshot(actual, expected);
  } catch { return false; }
}

function selectedDirectoryEntrySnapshot(directory, fileSystem = fs) {
  const before = selectedDirectorySnapshot(directory, fileSystem);
  const entries = Object.freeze([...fileSystem.readdirSync(directory)].sort());
  const after = selectedDirectorySnapshot(directory, fileSystem);
  if (!sameSelectedDirectorySnapshot(before, after)) {
    throw new Error('release_evidence_selection_directory_changed_during_scan');
  }
  return Object.freeze({ ...after, entries });
}

function selectedDirectoryEntriesUnchanged(directory, expected, fileSystem = fs) {
  try {
    const actual = selectedDirectoryEntrySnapshot(directory, fileSystem);
    return sameSelectedDirectorySnapshot(actual, expected)
      && sameStringArray(actual.entries, expected.entries);
  } catch { return false; }
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

function deletionDrillPayload(receipt) {
  const payload = { ...receipt };
  delete payload.legacyPhysicalDeletionAndRestoreDrillReceiptHash;
  return payload;
}

function sameStringArray(left, right) {
  return Array.isArray(left) && Array.isArray(right)
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function exactLegacyDeletionDrillCommandResult(result, expectedArgs) {
  if (!exactKeys(result, LEGACY_DELETION_DRILL_COMMAND_RESULT_KEYS)
    || result.version !== 1
    || result.kind !== 'LegacyDeletionDrillCommandResult'
    || result.executable !== process.execPath
    || !sameStringArray(result.args, expectedArgs)
    || !SHA256_PATTERN.test(String(result.stdoutHash || ''))
    || !SHA256_PATTERN.test(String(result.stderrHash || ''))
    || typeof result.timedOut !== 'boolean') return false;
  const exitCodeValid = result.exitCode === null
    || (Number.isSafeInteger(result.exitCode) && result.exitCode >= 0 && result.exitCode <= 255);
  const signalValid = result.signal === null
    || (typeof result.signal === 'string' && /^SIG[A-Z0-9]+$/u.test(result.signal));
  const errorCodeValid = result.errorCode === null
    || (typeof result.errorCode === 'string' && /^[A-Z][A-Z0-9_]*$/u.test(result.errorCode));
  if (!exitCodeValid || !signalValid || !errorCodeValid
    || result.timedOut !== (result.errorCode === 'ETIMEDOUT')) return false;
  if (result.exitCode !== null) {
    return result.signal === null && result.errorCode === null && result.timedOut === false;
  }
  return result.signal !== null || result.errorCode !== null;
}

function exactLegacyDeletionDrillCommandSet(results, expectedCommands) {
  return Array.isArray(results) && results.length === expectedCommands.length
    && results.every((result, index) => exactLegacyDeletionDrillCommandResult(
      result,
      expectedCommands[index],
    ));
}

function legacyDeletionDrillCommandPassed(result) {
  return result.exitCode === 0 && result.signal === null
    && result.errorCode === null && result.timedOut === false;
}

function positiveLegacyDeletionDrillAuthorityCounts(receipt) {
  return Number.isSafeInteger(receipt.ownerAcceptanceRequired)
    && receipt.ownerAcceptanceRequired > 0
    && Number.isSafeInteger(receipt.ownerAccepted)
    && receipt.ownerAccepted >= 0
    && receipt.ownerAccepted <= receipt.ownerAcceptanceRequired
    && Number.isSafeInteger(receipt.operationalProofRequired)
    && receipt.operationalProofRequired > 0
    && Number.isSafeInteger(receipt.operationallyProven)
    && receipt.operationallyProven >= 0
    && receipt.operationallyProven <= receipt.operationalProofRequired;
}

function receiptStatusConsistent(receipt) {
  if (![
    'legacy_reference_restore_drill_passed_deletion_allowed',
    'legacy_reference_restore_drill_passed_deletion_blocked',
    'legacy_reference_restore_drill_blocked',
  ].includes(receipt.status)) return false;
  const commandsValid = exactLegacyDeletionDrillCommandSet(
    receipt.checks,
    LEGACY_DELETION_DRILL_CHECK_COMMANDS,
  ) && exactLegacyDeletionDrillCommandSet(
    receipt.policyChecks,
    LEGACY_DELETION_DRILL_POLICY_COMMANDS,
  );
  const technicalReleaseReady = commandsValid
    && receipt.checks.every(legacyDeletionDrillCommandPassed)
    && receipt.policyChecks.every(legacyDeletionDrillCommandPassed)
    && receipt.sqliteQuickCheck === 'ok'
    && receipt.minimalDifferentialFixture?.status === 'legacy_differential_reference_verified'
    && receipt.archiveImmutable === true;
  const deletionAuthorized = technicalReleaseReady
    && positiveLegacyDeletionDrillAuthorityCounts(receipt)
    && receipt.ownerAccepted === receipt.ownerAcceptanceRequired
    && receipt.operationallyProven === receipt.operationalProofRequired
    && receipt.blockers.length === 0;
  if (receipt.status === 'legacy_reference_restore_drill_passed_deletion_allowed') {
    return deletionAuthorized && receipt.physicalDeletionAllowed === true;
  }
  if (receipt.status === 'legacy_reference_restore_drill_passed_deletion_blocked') {
    return technicalReleaseReady && !deletionAuthorized
      && receipt.physicalDeletionAllowed === false && receipt.blockers.length > 0;
  }
  return !technicalReleaseReady
    && receipt.physicalDeletionAllowed === false && receipt.blockers.length > 0;
}

export function verifyCurrentLegacyDeletionDrillReceipt({
  document,
  expectedCodeProvenance,
  currentArchive,
  expectedReleaseStateSnapshot,
  pinnedPublicKeyPem,
  pinnedPublicKeyFingerprint,
  candidateName,
  now = new Date(),
  maximumAgeMs = DELETION_DRILL_MAXIMUM_AGE_MS,
} = {}) {
  const blockers = [];
  if (!isPlainObject(document)) return Object.freeze({ status: 'legacy_deletion_drill_receipt_invalid', blockers: ['legacy_deletion_drill_json_object_required'], receipt: null });
  const { signature, ...receipt } = document;
  if (!exactKeys(receipt, DELETION_DRILL_RECEIPT_KEYS)) blockers.push('legacy_deletion_drill_receipt_shape_invalid');
  if (receipt.version !== 2) blockers.push('legacy_deletion_drill_receipt_v2_required');
  if (receipt.kind !== 'LegacyPhysicalDeletionAndRestoreDrillReceipt') blockers.push('legacy_deletion_drill_receipt_kind_invalid');
  if (exactCleanCodeProvenanceBlockers(expectedCodeProvenance).length) blockers.push('legacy_deletion_drill_expected_code_provenance_invalid');
  if (!exactCodeProvenanceMatches(receipt.codeProvenance, expectedCodeProvenance)) blockers.push('legacy_deletion_drill_code_provenance_mismatch');
  if (!releaseStateSnapshotsMatch(receipt.releaseStateSnapshot, expectedReleaseStateSnapshot)
    || receipt.releaseStateSnapshotHash
      !== expectedReleaseStateSnapshot?.workspaceReleaseStateSnapshotHash) {
    blockers.push('legacy_deletion_drill_release_state_mismatch');
  }
  if (!isPlainObject(currentArchive)
    || typeof currentArchive.archivePath !== 'string'
    || !path.isAbsolute(currentArchive.archivePath)
    || path.resolve(currentArchive.archivePath) !== currentArchive.archivePath
    || receipt.archivePath !== currentArchive.archivePath) {
    blockers.push('legacy_deletion_drill_archive_path_mismatch');
  }
  if (!SHA256_PATTERN.test(String(currentArchive?.archiveHash || ''))
    || receipt.archiveHash !== currentArchive?.archiveHash) {
    blockers.push('legacy_deletion_drill_archive_hash_mismatch');
  }
  if (currentArchive?.archiveImmutable !== true || receipt.archiveImmutable !== true) {
    blockers.push('legacy_deletion_drill_current_archive_not_immutable');
  }
  const commandResultsValid = exactLegacyDeletionDrillCommandSet(
    receipt.checks,
    LEGACY_DELETION_DRILL_CHECK_COMMANDS,
  ) && exactLegacyDeletionDrillCommandSet(
    receipt.policyChecks,
    LEGACY_DELETION_DRILL_POLICY_COMMANDS,
  );
  if (!commandResultsValid) blockers.push('legacy_deletion_drill_command_results_invalid');
  const authorityCountsValid = positiveLegacyDeletionDrillAuthorityCounts(receipt);
  if (!authorityCountsValid) blockers.push('legacy_deletion_drill_required_counts_invalid');
  if (!Array.isArray(receipt.checks)
    || !Array.isArray(receipt.policyChecks)
    || !Array.isArray(receipt.blockers)
    || receipt.blockers.some((item) => typeof item !== 'string' || item.length < 1)
    || new Set(receipt.blockers).size !== receipt.blockers.length
    || !Number.isSafeInteger(receipt.ownerAccepted)
    || !Number.isSafeInteger(receipt.ownerAcceptanceRequired)
    || !Number.isSafeInteger(receipt.operationallyProven)
    || !Number.isSafeInteger(receipt.operationalProofRequired)
    || receipt.ownerAccepted < 0
    || receipt.ownerAcceptanceRequired < 0
    || receipt.ownerAccepted > receipt.ownerAcceptanceRequired
    || receipt.operationallyProven < 0
    || receipt.operationalProofRequired < 0
    || receipt.operationallyProven > receipt.operationalProofRequired
    || typeof receipt.archiveImmutable !== 'boolean'
    || typeof receipt.destructiveDeletionPerformed !== 'boolean'
    || typeof receipt.liveLegacyRootPresent !== 'boolean'
    || receipt.destructiveDeletionPerformed === receipt.liveLegacyRootPresent
    || receipt.restoredFromReferenceArchive !== true
    || typeof receipt.sqliteQuickCheck !== 'string') blockers.push('legacy_deletion_drill_receipt_fields_invalid');
  if (Array.isArray(receipt.blockers) && !receiptStatusConsistent(receipt)) blockers.push('legacy_deletion_drill_status_inconsistent');
  const createdAtMs = Date.parse(String(receipt.createdAt || ''));
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(String(now || ''));
  if (!Number.isFinite(createdAtMs) || !Number.isFinite(nowMs)
    || new Date(createdAtMs).toISOString() !== receipt.createdAt) blockers.push('legacy_deletion_drill_time_invalid');
  else {
    if (createdAtMs > nowMs + DELETION_DRILL_MAXIMUM_FUTURE_SKEW_MS) blockers.push('legacy_deletion_drill_created_in_future');
    if (!Number.isFinite(maximumAgeMs) || maximumAgeMs < 1 || nowMs - createdAtMs > maximumAgeMs) blockers.push('legacy_deletion_drill_receipt_stale');
  }
  const claimedReceiptHash = receipt.legacyPhysicalDeletionAndRestoreDrillReceiptHash;
  const computedReceiptHash = hashRecord('LegacyPhysicalDeletionAndRestoreDrillReceipt', deletionDrillPayload(receipt));
  if (!SHA256_PATTERN.test(String(claimedReceiptHash || '')) || claimedReceiptHash !== computedReceiptHash) blockers.push('legacy_deletion_drill_self_hash_mismatch');
  const expectedCandidateName = Number.isFinite(createdAtMs) && SHA256_PATTERN.test(String(claimedReceiptHash || ''))
    ? `LEGACY_DELETION_DRILL_${createdAtMs}_${claimedReceiptHash.slice('sha256:'.length)}.json`
    : null;
  if (!candidateName || candidateName !== expectedCandidateName) blockers.push('legacy_deletion_drill_filename_binding_mismatch');
  if (!verifyReleaseIntegritySignature(receipt, signature, { pinnedPublicKeyPem, pinnedPublicKeyFingerprint })) {
    blockers.push('legacy_deletion_drill_signature_invalid');
  }
  const valid = blockers.length === 0;
  return Object.freeze({
    status: valid ? 'legacy_deletion_drill_current_receipt_verified' : 'legacy_deletion_drill_receipt_invalid',
    blockers: unique(blockers),
    receipt: valid ? Object.freeze(receipt) : null,
    claimedReceiptHash: SHA256_PATTERN.test(String(claimedReceiptHash || '')) ? claimedReceiptHash : null,
    receiptHash: valid ? computedReceiptHash : null,
    signaturePublicKeyFingerprint: valid ? signature.publicKeyFingerprint : null,
  });
}

function deletionDrillCandidateOrder(name) {
  const match = DELETION_DRILL_FILE_PATTERN.exec(name);
  return match ? { timestamp: Number(match[1]), name, recognized: true } : { timestamp: Number.POSITIVE_INFINITY, name, recognized: false };
}

function blockedDeletionDrillSelection(blockers, details = {}) {
  return Object.freeze({
    version: 1,
    kind: 'LegacyDeletionDrillEvidenceSelection',
    status: 'legacy_deletion_drill_current_evidence_blocked',
    receipt: null,
    receiptHash: null,
    releaseEvidenceReady: false,
    physicalDeletionAllowed: false,
    blockers: unique(blockers),
    ...details,
  });
}

export function selectCurrentLegacyDeletionDrillReceipt({
  deletionDrillRoot,
  runtimeRoot,
  expectedCodeProvenance,
  expectedReleaseStateSnapshot,
  archivePath,
  now = new Date(),
  maximumAgeMs = DELETION_DRILL_MAXIMUM_AGE_MS,
  fileSystem = fs,
  spawnSyncImpl = spawnSync,
} = {}) {
  const lexicalRoot = pathWithin(runtimeRoot, deletionDrillRoot);
  if (!lexicalRoot) return blockedDeletionDrillSelection(['legacy_deletion_drill_root_outside_runtime']);
  if (!fileSystem.existsSync(deletionDrillRoot)) return blockedDeletionDrillSelection(['legacy_deletion_drill_receipt_missing']);
  let relativeRoot;
  try { relativeRoot = existingDirectoryWithinRuntime(runtimeRoot, deletionDrillRoot); } catch { /* Fail closed below. */ }
  if (!relativeRoot) return blockedDeletionDrillSelection(['legacy_deletion_drill_root_outside_runtime']);
  let rootSnapshot;
  try {
    rootSnapshot = selectedDirectoryEntrySnapshot(deletionDrillRoot, fileSystem);
  } catch {
    return blockedDeletionDrillSelection(['legacy_deletion_drill_root_unreadable']);
  }
  const names = rootSnapshot.entries.filter((name) => name.endsWith('.json'));
  if (!names.length) return blockedDeletionDrillSelection(['legacy_deletion_drill_receipt_missing']);
  names.sort((left, right) => {
    const leftOrder = deletionDrillCandidateOrder(left);
    const rightOrder = deletionDrillCandidateOrder(right);
    return leftOrder.timestamp - rightOrder.timestamp || left.localeCompare(right);
  });
  const candidateName = names.at(-1);
  const candidateOrder = deletionDrillCandidateOrder(candidateName);
  const candidatePath = path.join(deletionDrillRoot, candidateName);
  const candidateRelativePath = pathWithin(runtimeRoot, candidatePath);
  let key;
  try { key = loadExistingReleaseSigningKey(runtimeRoot, { fileSystem }); } catch {
    return blockedDeletionDrillSelection(['legacy_deletion_drill_pinned_public_key_unavailable'], { candidateRelativePath, candidateName });
  }
  const details = { candidateRelativePath, candidateName, pinnedPublicKeyFingerprint: key.publicKeyFingerprint };
  if (!candidateOrder.recognized || !candidateRelativePath) {
    return blockedDeletionDrillSelection(['legacy_deletion_drill_candidate_name_invalid'], details);
  }
  let bytes;
  try {
    bytes = readRegularFileNoFollow(candidatePath, { fileSystem });
  } catch {
    return blockedDeletionDrillSelection(['legacy_deletion_drill_candidate_file_unsafe'], details);
  }
  const candidateFileHash = sha256Bytes(bytes);
  let document;
  try { document = JSON.parse(bytes.toString('utf8')); } catch {
    return blockedDeletionDrillSelection(['legacy_deletion_drill_candidate_json_invalid'], { ...details, candidateFileHash });
  }
  let currentArchive;
  try {
    currentArchive = inspectLegacyReferenceArchive({
      archivePath,
      fileSystem,
      spawnSyncImpl,
    });
  } catch {
    return blockedDeletionDrillSelection(['legacy_deletion_drill_current_archive_unsafe'], { ...details, candidateFileHash });
  }
  if (!selectedDirectoryEntriesUnchanged(deletionDrillRoot, rootSnapshot, fileSystem)) {
    return blockedDeletionDrillSelection(
      ['legacy_deletion_drill_root_changed_during_selection'],
      { ...details, candidateFileHash },
    );
  }
  const verification = verifyCurrentLegacyDeletionDrillReceipt({
    document,
    expectedCodeProvenance,
    expectedReleaseStateSnapshot,
    currentArchive,
    pinnedPublicKeyPem: key.publicKeyPem,
    pinnedPublicKeyFingerprint: key.publicKeyFingerprint,
    candidateName,
    now,
    maximumAgeMs,
  });
  if (!selectedDirectoryEntriesUnchanged(deletionDrillRoot, rootSnapshot, fileSystem)) {
    return blockedDeletionDrillSelection(
      ['legacy_deletion_drill_root_changed_during_selection'],
      { ...details, candidateFileHash, claimedReceiptHash: verification.claimedReceiptHash },
    );
  }
  if (verification.status !== 'legacy_deletion_drill_current_receipt_verified') {
    return blockedDeletionDrillSelection(verification.blockers, {
      ...details,
      candidateFileHash,
      claimedReceiptHash: verification.claimedReceiptHash,
      pinnedPublicKeyFingerprint: key.publicKeyFingerprint,
    });
  }
  const receipt = verification.receipt;
  return Object.freeze({
    version: 1,
    kind: 'LegacyDeletionDrillEvidenceSelection',
    status: 'legacy_deletion_drill_current_evidence_verified',
    receipt,
    receiptHash: verification.receiptHash,
    claimedReceiptHash: verification.claimedReceiptHash,
    candidateFileHash,
    candidateRelativePath,
    candidateName,
    pinnedPublicKeyFingerprint: key.publicKeyFingerprint,
    currentArchive,
    releaseEvidenceReady: [
      'legacy_reference_restore_drill_passed_deletion_allowed',
      'legacy_reference_restore_drill_passed_deletion_blocked',
    ].includes(receipt.status),
    physicalDeletionAllowed: receipt.status === 'legacy_reference_restore_drill_passed_deletion_allowed'
      && receipt.physicalDeletionAllowed === true,
    receiptBlockers: [...receipt.blockers],
    blockers: [],
  });
}

export function releaseAttestationCodeProvenance(provenance) {
  const selected = provenance === undefined
    ? assertExactCleanCodeProvenance(currentCodeProvenance({ allowReleaseCommitEnvironment: false }))
    : provenance;
  return Object.freeze({
    ...selected,
    evidenceEnvironment: 'administrative',
    evidenceClass: 'release_attestation',
  });
}

function canonicalReleaseEvidenceInputValue(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('release_evidence_input_snapshot_number_invalid');
    return value;
  }
  if (typeof value === 'bigint') return String(value);
  if (Buffer.isBuffer(value)) {
    return Object.freeze({ encoding: 'base64', value: value.toString('base64') });
  }
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) throw new Error('release_evidence_input_snapshot_date_invalid');
    return value.toISOString();
  }
  if (value instanceof Map) {
    const entries = [...value.entries()].map(([key, item]) => Object.freeze({
      key: String(key),
      value: canonicalReleaseEvidenceInputValue(item),
    }));
    entries.sort((left, right) => left.key.localeCompare(right.key));
    if (new Set(entries.map((entry) => entry.key)).size !== entries.length) {
      throw new Error('release_evidence_input_snapshot_map_key_collision');
    }
    return Object.freeze(entries);
  }
  if (value instanceof Set) {
    const values = [...value].map(canonicalReleaseEvidenceInputValue);
    values.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
    return Object.freeze(values);
  }
  if (Array.isArray(value)) {
    return Object.freeze(value.map(canonicalReleaseEvidenceInputValue));
  }
  if (!isPlainObject(value)) throw new Error('release_evidence_input_snapshot_value_invalid');
  return Object.freeze(Object.fromEntries(
    Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalReleaseEvidenceInputValue(item)]),
  ));
}

export function buildReleaseEvidenceProofSetSnapshot(kind, proofs) {
  if (typeof kind !== 'string' || !kind.trim() || !(proofs instanceof Map)) {
    throw new Error('release_evidence_proof_set_inputs_invalid');
  }
  const entries = canonicalReleaseEvidenceInputValue(proofs);
  const payload = Object.freeze({
    version: 1,
    kind: 'ReleaseEvidenceProofSetSnapshot',
    proofKind: kind,
    count: entries.length,
    entries,
  });
  return Object.freeze({
    ...payload,
    releaseEvidenceProofSetSnapshotHash: hashRecord('ReleaseEvidenceProofSetSnapshot', payload),
  });
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mode === right.mode && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

export function captureReleaseEvidenceRegularFile(file, {
  required = false,
  maximumBytes = null,
  fileSystem = fs,
  afterOpen = () => {},
} = {}) {
  const absolute = path.resolve(file);
  let initialPath;
  try { initialPath = fileSystem.lstatSync(absolute); } catch (error) {
    if (!required && error?.code === 'ENOENT') {
      return Object.freeze({ present: false, path: absolute, fileHash: null });
    }
    throw error;
  }
  if (!initialPath.isFile() || initialPath.isSymbolicLink()
    || Number(initialPath.nlink) !== 1) {
    throw new Error('release_evidence_input_file_unsafe');
  }
  const parentChain = snapshotImmutableArchiveDirectoryChain(
    path.dirname(absolute),
    fileSystem,
  );
  let descriptor;
  try {
    descriptor = fileSystem.openSync(
      absolute,
      fileSystem.constants.O_RDONLY | (fileSystem.constants.O_NOFOLLOW || 0),
    );
    const before = fileSystem.fstatSync(descriptor);
    if (!before.isFile() || Number(before.nlink) !== 1
      || before.dev !== initialPath.dev || before.ino !== initialPath.ino) {
      throw new Error('release_evidence_input_file_path_identity_mismatch');
    }
    if (maximumBytes !== null
      && (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1
        || before.size < 1 || before.size > maximumBytes)) {
      throw new Error('release_evidence_input_file_size_invalid');
    }
    afterOpen({ descriptor, identity: Object.freeze({ dev: before.dev, ino: before.ino }) });
    let bytes = null;
    const hash = crypto.createHash('sha256');
    if (maximumBytes !== null) {
      bytes = fileSystem.readFileSync(descriptor);
      if (bytes.length !== before.size) throw new Error('release_evidence_input_file_short_read');
      hash.update(bytes);
    } else {
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
        if (read < 1) throw new Error('release_evidence_input_file_short_read');
        hash.update(buffer.subarray(0, read));
        position += read;
      }
    }
    const after = fileSystem.fstatSync(descriptor);
    const finalPath = fileSystem.lstatSync(absolute);
    if (!after.isFile() || Number(after.nlink) !== 1
      || !finalPath.isFile() || finalPath.isSymbolicLink() || Number(finalPath.nlink) !== 1
      || !sameFileIdentity(before, after)
      || finalPath.dev !== before.dev || finalPath.ino !== before.ino
      || !immutableArchiveDirectoryChainUnchanged(parentChain, fileSystem)) {
      throw new Error('release_evidence_input_file_changed');
    }
    return Object.freeze({
      present: true,
      path: absolute,
      fileHash: `sha256:${hash.digest('hex')}`,
      device: String(before.dev),
      inode: String(before.ino),
      size: before.size,
      mode: before.mode & 0o7777,
      mtimeMs: before.mtimeMs,
      ctimeMs: before.ctimeMs,
      ...(bytes === null ? {} : { bytes }),
    });
  } finally {
    if (descriptor !== undefined) fileSystem.closeSync(descriptor);
  }
}

function sameBigIntFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mode === right.mode && left.nlink === right.nlink
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function hashPinnedDescriptor(descriptor, size, fileSystem = fs) {
  if (typeof size !== 'bigint' || size < 0n || size > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('release_evidence_production_database_size_invalid');
  }
  const hash = crypto.createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let position = 0n;
  while (position < size) {
    const remaining = size - position;
    const requested = Number(remaining > BigInt(buffer.length) ? BigInt(buffer.length) : remaining);
    const read = fileSystem.readSync(
      descriptor,
      buffer,
      0,
      requested,
      Number(position),
    );
    if (read < 1) throw new Error('release_evidence_production_database_short_read');
    hash.update(buffer.subarray(0, read));
    position += BigInt(read);
  }
  return `sha256:${hash.digest('hex')}`;
}

const SQLITE_LOGICAL_DEPENDENCY_SUFFIXES = Object.freeze([
  '',
  '-journal',
  '-shm',
  '-wal',
]);

function capturePinnedSqliteDependency({
  pinnedRootPath,
  databaseName,
  suffix,
  fileSystem,
}) {
  const name = `${databaseName}${suffix}`;
  const dependencyPath = path.join(pinnedRootPath, name);
  let pathIdentity;
  try { pathIdentity = fileSystem.lstatSync(dependencyPath, { bigint: true }); }
  catch (error) {
    if (error?.code === 'ENOENT' && suffix !== '') {
      return Object.freeze({
        name,
        path: dependencyPath,
        present: false,
        descriptor: null,
        identity: null,
        fileHash: null,
      });
    }
    throw error;
  }
  if (!pathIdentity.isFile() || pathIdentity.isSymbolicLink()
    || pathIdentity.nlink !== 1n) {
    throw new Error('release_evidence_production_database_dependency_unsafe');
  }
  const descriptor = fileSystem.openSync(
    dependencyPath,
    fileSystem.constants.O_RDONLY | (fileSystem.constants.O_NOFOLLOW || 0),
  );
  try {
    const identity = fileSystem.fstatSync(descriptor, { bigint: true });
    if (!identity.isFile() || identity.nlink !== 1n
      || !sameBigIntFileIdentity(identity, pathIdentity)) {
      throw new Error('release_evidence_production_database_dependency_identity_mismatch');
    }
    return Object.freeze({
      name,
      path: dependencyPath,
      present: true,
      descriptor,
      identity,
      fileHash: hashPinnedDescriptor(descriptor, identity.size, fileSystem),
    });
  } catch (error) {
    fileSystem.closeSync(descriptor);
    throw error;
  }
}

function assertPinnedSqliteDependencyUnchanged(dependency, fileSystem) {
  if (!dependency.present) {
    try {
      fileSystem.lstatSync(dependency.path, { bigint: true });
      throw new Error('release_evidence_production_database_dependency_appeared');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    return;
  }
  const descriptorIdentity = fileSystem.fstatSync(dependency.descriptor, { bigint: true });
  const pathIdentity = fileSystem.lstatSync(dependency.path, { bigint: true });
  if (!descriptorIdentity.isFile() || descriptorIdentity.nlink !== 1n
    || !pathIdentity.isFile() || pathIdentity.isSymbolicLink()
    || pathIdentity.nlink !== 1n
    || !sameBigIntFileIdentity(dependency.identity, descriptorIdentity)
    || !sameBigIntFileIdentity(dependency.identity, pathIdentity)
    || hashPinnedDescriptor(
      dependency.descriptor,
      descriptorIdentity.size,
      fileSystem,
    ) !== dependency.fileHash) {
    throw new Error('release_evidence_production_database_dependency_changed');
  }
}

function publicSqliteDependencyCapture(dependency) {
  if (!dependency.present) {
    return Object.freeze({
      name: dependency.name,
      present: false,
      fileHash: null,
    });
  }
  return Object.freeze({
    name: dependency.name,
    present: true,
    fileHash: dependency.fileHash,
    device: String(dependency.identity.dev),
    inode: String(dependency.identity.ino),
    size: Number(dependency.identity.size),
    mode: Number(dependency.identity.mode & 0o7777n),
    mtimeNs: String(dependency.identity.mtimeNs),
    ctimeNs: String(dependency.identity.ctimeNs),
  });
}

export function captureProductionStoreLogicalIntegrity({
  runtimeRoot,
  databaseName = 'hepta-paper.sqlite',
  fileSystem = fs,
  inspectLogicalIntegrity = null,
} = {}) {
  const lexicalRoot = path.resolve(String(runtimeRoot || ''));
  if (!path.isAbsolute(String(runtimeRoot || ''))
    || databaseName !== 'hepta-paper.sqlite') {
    throw new Error('release_evidence_production_database_scope_invalid');
  }
  const lexicalDatabasePath = path.join(lexicalRoot, databaseName);
  let initialDatabase;
  try { initialDatabase = fileSystem.lstatSync(lexicalDatabasePath, { bigint: true }); }
  catch (error) {
    if (error?.code === 'ENOENT') {
      return Object.freeze({
        database: Object.freeze({
          present: false,
          path: lexicalDatabasePath,
          fileHash: null,
        }),
        report: null,
      });
    }
    throw error;
  }
  const rootChain = snapshotImmutableArchiveDirectoryChain(lexicalRoot, fileSystem);
  let rootDescriptor;
  let dependencies = [];
  try {
    rootDescriptor = fileSystem.openSync(
      lexicalRoot,
      fileSystem.constants.O_RDONLY
        | (fileSystem.constants.O_DIRECTORY || 0)
        | (fileSystem.constants.O_NOFOLLOW || 0),
    );
    const rootBefore = fileSystem.fstatSync(rootDescriptor, { bigint: true });
    const lexicalRootBefore = fileSystem.lstatSync(lexicalRoot, { bigint: true });
    if (!rootBefore.isDirectory() || !lexicalRootBefore.isDirectory()
      || lexicalRootBefore.isSymbolicLink()
      || rootBefore.dev !== lexicalRootBefore.dev || rootBefore.ino !== lexicalRootBefore.ino) {
      throw new Error('release_evidence_production_database_root_unsafe');
    }
    const pinnedRootPath = `/proc/self/fd/${rootDescriptor}`;
    try { fileSystem.realpathSync(pinnedRootPath); } catch {
      throw new Error('release_evidence_production_database_pinned_root_unavailable');
    }
    const pinnedDatabasePath = path.join(pinnedRootPath, databaseName);
    for (const suffix of SQLITE_LOGICAL_DEPENDENCY_SUFFIXES) {
      dependencies.push(capturePinnedSqliteDependency({
        pinnedRootPath,
        databaseName,
        suffix,
        fileSystem,
      }));
    }
    const databaseDependency = dependencies.find((dependency) => dependency.name === databaseName);
    const databaseBefore = databaseDependency?.identity;
    if (!databaseBefore.isFile() || databaseBefore.nlink !== 1n
      || !initialDatabase.isFile() || initialDatabase.isSymbolicLink()
      || initialDatabase.nlink !== 1n
      || databaseBefore.dev !== initialDatabase.dev
      || databaseBefore.ino !== initialDatabase.ino) {
      throw new Error('release_evidence_production_database_unsafe');
    }
    const databaseHash = databaseDependency.fileHash;
    const inspect = inspectLogicalIntegrity || ((dbPath) => {
      const store = createReadOnlyPaperStore({ dbPath });
      try { return buildSqliteLogicalIntegrityReport({ dbPath, store }); }
      finally { store.close?.(); }
    });
    const inspected = inspect(pinnedDatabasePath);
    if (!isPlainObject(inspected)) {
      throw new Error('release_evidence_production_database_logical_report_invalid');
    }
    const lexicalDatabaseAfter = fileSystem.lstatSync(
      lexicalDatabasePath,
      { bigint: true },
    );
    const rootAfter = fileSystem.fstatSync(rootDescriptor, { bigint: true });
    const lexicalRootAfter = fileSystem.lstatSync(lexicalRoot, { bigint: true });
    dependencies.forEach((dependency) => (
      assertPinnedSqliteDependencyUnchanged(dependency, fileSystem)
    ));
    if (!sameBigIntFileIdentity(databaseBefore, lexicalDatabaseAfter)
      || !sameBigIntFileIdentity(rootBefore, rootAfter)
      || !sameBigIntFileIdentity(rootBefore, lexicalRootAfter)
      || !immutableArchiveDirectoryChainUnchanged(rootChain, fileSystem)) {
      throw new Error('release_evidence_production_database_changed_during_snapshot');
    }
    const report = Object.freeze({ ...inspected, dbPath: lexicalDatabasePath });
    return Object.freeze({
      database: Object.freeze({
        present: true,
        path: lexicalDatabasePath,
        fileHash: databaseHash,
        device: String(databaseBefore.dev),
        inode: String(databaseBefore.ino),
        size: Number(databaseBefore.size),
        mode: Number(databaseBefore.mode & 0o7777n),
        mtimeNs: String(databaseBefore.mtimeNs),
        ctimeNs: String(databaseBefore.ctimeNs),
        dependencies: Object.freeze(dependencies.map(publicSqliteDependencyCapture)),
      }),
      report,
    });
  } finally {
    for (const dependency of dependencies) {
      if (dependency.descriptor !== null) fileSystem.closeSync(dependency.descriptor);
    }
    if (rootDescriptor !== undefined) fileSystem.closeSync(rootDescriptor);
  }
}

function capturedJsonFile(file) {
  const capture = captureReleaseEvidenceRegularFile(
    file,
    { required: true, maximumBytes: 2 * 1024 * 1024 },
  );
  let document;
  try { document = JSON.parse(capture.bytes.toString('utf8')); } catch {
    throw new Error('release_evidence_input_json_invalid');
  }
  const { bytes, ...fileCapture } = capture;
  return Object.freeze({
    file: Object.freeze(fileCapture),
    document: canonicalReleaseEvidenceInputValue(document),
  });
}

function capturedDirectory(directory, { required = false } = {}) {
  const absolute = path.resolve(directory);
  let stat;
  try { stat = fs.lstatSync(absolute); } catch (error) {
    if (!required && error?.code === 'ENOENT') {
      return Object.freeze({ present: false, path: absolute });
    }
    throw error;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('release_evidence_input_directory_unsafe');
  }
  return Object.freeze({
    present: true,
    path: absolute,
    device: String(stat.dev),
    inode: String(stat.ino),
    mode: stat.mode & 0o7777,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
  });
}

function projectedContract(value, keys, label) {
  if (value === null) return null;
  if (!isPlainObject(value)) throw new Error(`release_evidence_${label}_invalid`);
  return canonicalReleaseEvidenceInputValue(Object.fromEntries(
    keys.filter((key) => Object.hasOwn(value, key)).map((key) => [key, value[key]]),
  ));
}

const SEMANTIC_CONTRACT_KEYS = Object.freeze({
  coldVolumeStatus: Object.freeze([
    'version', 'kind', 'status', 'contractId', 'contractHash', 'assetRoot', 'mountRoot',
    'mountAvailable', 'mountIdentity', 'sentinelPath', 'sentinelHash', 'entryCount',
    'contractValid', 'operationalReplayReady', 'blockers', 'rows',
  ]),
  minimalDifferentialFixture: Object.freeze([
    'version', 'kind', 'status', 'manifestPath', 'archivePath', 'archiveSha256',
    'fileCount', 'blockers',
  ]),
  immutableMatrixReference: Object.freeze([
    'version', 'kind', 'status', 'manifestPath', 'archivePath', 'archiveSha256',
    'matrixPath', 'matrixSha256', 'sourceFileCount', 'liveLegacyRootRequired',
  ]),
  productionStoreLogicalIntegrity: Object.freeze([
    'version', 'kind', 'status', 'dbPath', 'byteHashBefore', 'byteHashAfter',
    'readonlyCheckMutatedDatabase', 'logicalDatabaseHash', 'schemaHash', 'tableCount',
    'totalRowCount', 'tables', 'quickCheck', 'foreignKeyViolationCount',
    'receiptLedgerRowCount', 'invalidReceiptHashCount', 'invalidReceiptRows', 'blockers',
  ]),
  coldVolumeCas: Object.freeze([
    'version', 'kind', 'status', 'casRoot', 'manifestPath', 'manifestHash', 'contractHash',
    'objectCount', 'blockers',
  ]),
  offhostWormStatus: Object.freeze([
    'version', 'kind', 'status', 'contractId', 'targetMountRoot', 'mountAvailable',
    'mountIdentity', 'distinctDevice', 'currentProtectionLevel',
    'offHostOrOffsiteCustodyQualified', 'custodyStatus', 'custodyBlockers', 'blockers',
  ]),
  trustLayerGate: Object.freeze([
    'version', 'kind', 'status', 'releaseCommit', 'capabilityCount', 'implementation',
    'releaseBoundConformance', 'independentProductionOperational',
    'conformanceCannotQualifyAsOperationalProof',
    'operationalProofCannotSubstituteForReleaseBoundConformance',
    'releaseTrustLayerGateHash',
  ]),
});

export function projectReleaseEvidenceSemanticContract(contract, value) {
  const keys = SEMANTIC_CONTRACT_KEYS[contract];
  if (keys) return projectedContract(value, keys, `${contract}_contract`);
  if ([
    'releaseStateSnapshot',
    'codeProvenance',
    'verificationReceiptEvidence',
    'capabilityManifestEvidence',
    'deletionDrillEvidence',
    'immutableSnapshotEvidence',
    'implementationProofSet',
    'conformanceProofSet',
    'operationalProofSet',
  ].includes(contract)) {
    // These documents are self-hashed/signed or contain self-hashed/signed receipts. Their
    // createdAt/completedAt/executedAt/generatedAt values are freshness and identity inputs,
    // not observation timestamps, and therefore remain in the semantic snapshot.
    return canonicalReleaseEvidenceInputValue(value);
  }
  throw new Error('release_evidence_semantic_contract_unknown');
}

function inputSnapshotPayload(snapshot) {
  const payload = { ...snapshot };
  delete payload.releaseEvidenceInputSnapshotHash;
  return payload;
}

function validProofSetSnapshot(proofSet, expectedKind) {
  if (!exactKeys(proofSet, [
    'count', 'entries', 'kind', 'proofKind', 'releaseEvidenceProofSetSnapshotHash', 'version',
  ])
    || proofSet.version !== 1
    || proofSet.kind !== 'ReleaseEvidenceProofSetSnapshot'
    || proofSet.proofKind !== expectedKind
    || !Array.isArray(proofSet.entries)
    || proofSet.count !== proofSet.entries.length
    || !proofSet.entries.every((entry) => exactKeys(entry, ['key', 'value'])
      && typeof entry.key === 'string')
    || new Set(proofSet.entries.map((entry) => entry.key)).size !== proofSet.entries.length
    || proofSet.entries.some((entry, index) => index > 0
      && proofSet.entries[index - 1].key.localeCompare(entry.key) >= 0)) return false;
  const { releaseEvidenceProofSetSnapshotHash: _hash, ...payload } = proofSet;
  return hashRecord('ReleaseEvidenceProofSetSnapshot', payload)
    === proofSet.releaseEvidenceProofSetSnapshotHash;
}

export function assertValidReleaseEvidenceInputSnapshot(snapshot) {
  if (!exactKeys(snapshot, RELEASE_EVIDENCE_INPUT_SNAPSHOT_KEYS)
    || snapshot.version !== 1
    || snapshot.kind !== 'ReleaseEvidenceInputSnapshot'
    || !SHA256_PATTERN.test(String(snapshot.releaseEvidenceInputSnapshotHash || ''))
    || !validProofSetSnapshot(snapshot.implementationProofSet, 'implementation')
    || !validProofSetSnapshot(snapshot.conformanceProofSet, 'release_bound_conformance')
    || !validProofSetSnapshot(
      snapshot.operationalProofSet,
      'independent_production_operational',
    )
    || hashRecord('ReleaseEvidenceInputSnapshot', inputSnapshotPayload(snapshot))
      !== snapshot.releaseEvidenceInputSnapshotHash) {
    throw new Error('release_evidence_input_snapshot_invalid');
  }
  return snapshot;
}

export function captureReleaseEvidenceInputSnapshot({
  runtimeRoot,
  legacyRoot,
  workspaceRoot = defaultWorkspaceRoot,
  environment = process.env,
  expectedReleaseStateSnapshotHash = null,
  now = new Date(),
} = {}) {
  const releaseStateSnapshot = assertWorkspaceReleaseReady({
    workspaceRoot,
    expectedSnapshotHash: expectedReleaseStateSnapshotHash,
  });
  const codeProvenance = releaseAttestationCodeProvenance(assertExactCleanCodeProvenance(
    currentCodeProvenance({ workspaceRoot, allowReleaseCommitEnvironment: false }),
    { releaseCommitAssertion: environment.HEPTA_RELEASE_COMMIT },
  ));
  if (releaseStateSnapshot.headCommit !== codeProvenance.commit) {
    throw new Error('release_evidence_release_state_commit_mismatch');
  }

  const verificationReceiptEvidence = selectCurrentReleaseVerificationReceipt({
    verificationRoot: path.join(runtimeRoot, 'release-evidence', 'verification-receipts'),
    runtimeRoot,
    codeProvenance,
    expectedReleaseStateSnapshot: releaseStateSnapshot,
  });
  const capabilityManifestEvidence = selectCurrentCapabilityVerificationManifest({
    runtimeRoot,
    expectedReceipt: verificationReceiptEvidence.receipt,
    expectedReceiptRelativePath: verificationReceiptEvidence.candidateRelativePath,
    expectedReceiptFileHash: verificationReceiptEvidence.candidateFileHash,
  });
  const archivePath = resolveImmutableLegacyMatrixArchive();
  const immutableSnapshotEvidence = selectCurrentLegacyImmutableSnapshotReceipt({
    archivePath,
    runtimeRoot,
    expectedCodeProvenance: codeProvenance,
    expectedReleaseStateSnapshot: releaseStateSnapshot,
    now,
  });
  const deletionDrillEvidence = selectCurrentLegacyDeletionDrillReceipt({
    deletionDrillRoot: path.join(runtimeRoot, 'legacy-retirement', 'deletion-drills'),
    runtimeRoot,
    expectedCodeProvenance: codeProvenance,
    expectedReleaseStateSnapshot: releaseStateSnapshot,
    archivePath,
    now,
  });

  const capabilityCount = Object.keys(CAPABILITY_CATALOG).length;
  const implementationProofSet = buildReleaseEvidenceProofSetSnapshot(
    'implementation',
    validateCapabilityOperationalEvidence({
      runtimeRoot,
      evidence: capabilityManifestEvidence.manifest,
      codeProvenance: verificationReceiptEvidence.receipt?.codeProvenance,
    }),
  );
  const conformanceProofSet = buildReleaseEvidenceProofSetSnapshot(
    'release_bound_conformance',
    loadCapabilityConformanceProofs({
      runtimeRoot,
      workspaceRoot,
      capabilityCatalog: CAPABILITY_CATALOG,
      releaseCommit: codeProvenance.commit,
    }),
  );
  const operationalProofSet = buildReleaseEvidenceProofSetSnapshot(
    'independent_production_operational',
    loadCapabilityOperationalProofs({
      runtimeRoot,
      workspaceRoot,
      capabilityCatalog: CAPABILITY_CATALOG,
      releaseCommit: codeProvenance.commit,
    }),
  );
  const trustLayerGate = buildReleaseTrustLayerGate({
    releaseCommit: codeProvenance.commit,
    capabilityCount,
    implementationVerified: implementationProofSet.count,
    releaseBoundConformanceVerified: conformanceProofSet.count,
    independentProductionOperationalVerified: operationalProofSet.count,
  });

  const coldVolumeContractPath = path.join(
    workspaceRoot,
    'paper-core',
    'config',
    'cold-volume-contract.v1.json',
  );
  const coldVolumeContract = capturedJsonFile(coldVolumeContractPath);
  const coldVolumeInspection = verifyColdVolumeContract({
    assetRoot: defaultPaperAssetRoot(),
    contract: coldVolumeContract.document,
  });
  const coldVolumeStatus = Object.freeze({
    ...coldVolumeInspection,
    contractHash: coldVolumeContract.file.fileHash,
  });
  const minimalDifferentialFixture = verifyLegacyDifferentialReference();
  const immutableMatrixReference = immutableLegacyMatrixReferenceStatus();

  const productionStoreCapture = captureProductionStoreLogicalIntegrity({ runtimeRoot });
  const productionDatabase = productionStoreCapture.database;
  const productionStoreLogicalIntegrity = productionStoreCapture.report;

  const coldVolumeCas = coldVolumeCasStatus({
    casRoot: path.resolve(
      environment.HEPTA_COLD_OBJECT_STORE_ROOT
        || '/data/home-data/hepta-paper-cold-object-store',
    ),
  });
  const offhostWormContractPath = path.join(
    workspaceRoot,
    'paper-core',
    'config',
    'offhost-worm-contract.v1.json',
  );
  const offhostWormContract = capturedJsonFile(offhostWormContractPath);
  const offhostWormStatus = verifyOffhostWormTarget({
    workspaceRoot,
    contract: offhostWormContract.document,
  });

  const archiveRoot = path.dirname(archivePath);
  const archiveReadOnlyReceipt = captureReleaseEvidenceRegularFile(
    path.join(archiveRoot, 'LEGACY_ARCHIVE_READ_ONLY_RECEIPT.json'),
  );
  const legacyDatabase = captureReleaseEvidenceRegularFile(
    path.join(legacyRoot, 'paper_factory.sqlite'),
  );
  const migrationMatrix = captureReleaseEvidenceRegularFile(
    path.join(workspaceRoot, 'migration', 'legacy-semantic-migration-matrix.json'),
    { required: true },
  );
  const runtimeHygieneExport = captureReleaseEvidenceRegularFile(path.join(
    runtimeRoot,
    'quarantine',
    'pre-v0.5-runtime-evidence',
    'CONTAMINATED_RECEIPTS.json',
  ));
  const authorityTrustStore = captureReleaseEvidenceRegularFile(
    path.join(runtimeRoot, 'trust', 'AUTHORITY_TRUST_STORE.json'),
  );
  const payload = canonicalReleaseEvidenceInputValue({
    version: 1,
    kind: 'ReleaseEvidenceInputSnapshot',
    releaseStateSnapshot: projectReleaseEvidenceSemanticContract(
      'releaseStateSnapshot',
      releaseStateSnapshot,
    ),
    codeProvenance: projectReleaseEvidenceSemanticContract('codeProvenance', codeProvenance),
    verificationReceiptEvidence: projectReleaseEvidenceSemanticContract(
      'verificationReceiptEvidence',
      verificationReceiptEvidence,
    ),
    capabilityManifestEvidence: projectReleaseEvidenceSemanticContract(
      'capabilityManifestEvidence',
      capabilityManifestEvidence,
    ),
    deletionDrillEvidence: projectReleaseEvidenceSemanticContract(
      'deletionDrillEvidence',
      deletionDrillEvidence,
    ),
    immutableSnapshotEvidence: projectReleaseEvidenceSemanticContract(
      'immutableSnapshotEvidence',
      immutableSnapshotEvidence,
    ),
    capabilityCount,
    capabilityCatalogHash: hashRecord(
      'ReleaseEvidenceCapabilityCatalog',
      canonicalReleaseEvidenceInputValue(CAPABILITY_CATALOG),
    ),
    implementationProofSet: projectReleaseEvidenceSemanticContract(
      'implementationProofSet',
      implementationProofSet,
    ),
    conformanceProofSet: projectReleaseEvidenceSemanticContract(
      'conformanceProofSet',
      conformanceProofSet,
    ),
    operationalProofSet: projectReleaseEvidenceSemanticContract(
      'operationalProofSet',
      operationalProofSet,
    ),
    trustLayerGate: projectReleaseEvidenceSemanticContract('trustLayerGate', trustLayerGate),
    coldVolumeContract: coldVolumeContract.file,
    coldVolumeStatus: projectReleaseEvidenceSemanticContract(
      'coldVolumeStatus',
      coldVolumeStatus,
    ),
    minimalDifferentialFixture: projectReleaseEvidenceSemanticContract(
      'minimalDifferentialFixture',
      minimalDifferentialFixture,
    ),
    immutableMatrixReference: projectReleaseEvidenceSemanticContract(
      'immutableMatrixReference',
      immutableMatrixReference,
    ),
    productionStoreLogicalIntegrity: projectReleaseEvidenceSemanticContract(
      'productionStoreLogicalIntegrity',
      productionStoreLogicalIntegrity,
    ),
    coldVolumeCas: projectReleaseEvidenceSemanticContract('coldVolumeCas', coldVolumeCas),
    offhostWormContract: offhostWormContract.file,
    offhostWormStatus: projectReleaseEvidenceSemanticContract(
      'offhostWormStatus',
      offhostWormStatus,
    ),
    runtimeHygieneExport,
    authorityTrustStore,
    inputs: {
      workspaceRoot: path.resolve(workspaceRoot),
      runtimeRoot: path.resolve(runtimeRoot),
      legacyRoot: capturedDirectory(legacyRoot),
      legacyDatabase,
      archivePath,
      archiveReadOnlyReceipt,
      migrationMatrix,
      productionDatabase,
    },
  });
  return Object.freeze({
    ...payload,
    releaseEvidenceInputSnapshotHash: hashRecord('ReleaseEvidenceInputSnapshot', payload),
  });
}

export function assertReleaseEvidenceInputSnapshotUnchanged({
  expectedSnapshotHash,
  capture = captureReleaseEvidenceInputSnapshot,
  captureOptions,
} = {}) {
  if (!SHA256_PATTERN.test(String(expectedSnapshotHash || ''))
    || typeof capture !== 'function') {
    throw new Error('release_evidence_input_snapshot_boundary_invalid');
  }
  let current;
  try { current = assertValidReleaseEvidenceInputSnapshot(capture(captureOptions)); } catch (error) {
    throw new Error('release_evidence_input_snapshot_changed', { cause: error });
  }
  if (current.releaseEvidenceInputSnapshotHash !== expectedSnapshotHash) {
    throw new Error('release_evidence_input_snapshot_changed');
  }
  return current;
}

export function retirementLifecycleStatus({
  legacyRoot,
  liveLegacyRootPresent: capturedLiveLegacyRootPresent,
  deletionDrill = null,
  deletionDrillEvidence = null,
  immutableReceipt = null,
  immutableSnapshotEvidence = null,
} = {}) {
  const liveLegacyRootPresent = capturedLiveLegacyRootPresent === undefined
    ? Boolean(legacyRoot && fs.existsSync(legacyRoot))
    : capturedLiveLegacyRootPresent === true;
  const immutableReferenceReady = immutableSnapshotEvidence?.status
      === 'legacy_immutable_snapshot_current_evidence_verified'
    && immutableSnapshotEvidence.releaseEvidenceReady === true
    && immutableSnapshotEvidence.receipt === immutableReceipt
    && immutableReceipt?.status === 'legacy_reference_ext4_inode_immutable';
  const physicalDeletionObserved = !liveLegacyRootPresent && immutableReferenceReady;
  const currentAuthorization = deletionDrillEvidence?.status === 'legacy_deletion_drill_current_evidence_verified'
    && Boolean(deletionDrill?.physicalDeletionAllowed);
  return Object.freeze({
    restoreDrillStatus: deletionDrill?.status || deletionDrillEvidence?.status || 'missing',
    restoreDrillEvidenceStatus: deletionDrillEvidence?.status || 'missing',
    restoreDrillEvidenceBlockers: deletionDrillEvidence?.blockers || [],
    currentPhysicalDeletionAuthorization: currentAuthorization,
    physicalDeletionAllowed: currentAuthorization,
    liveLegacyRootPresent,
    physicalDeletionObserved,
    destructiveDeletionPerformed: physicalDeletionObserved,
    deletionLifecycleStatus: physicalDeletionObserved
      ? (currentAuthorization ? 'legacy_root_deleted_with_current_authorization' : 'legacy_root_deleted_under_prior_authorization_current_gate_blocked')
      : liveLegacyRootPresent ? 'legacy_root_present' : 'legacy_root_absence_unverified',
    immutableSnapshotStatus: immutableReceipt?.status || 'missing',
    immutableSnapshotEvidenceStatus: immutableSnapshotEvidence?.status || 'missing',
    immutableSnapshotEvidenceBlockers: immutableSnapshotEvidence?.blockers || [],
    immutableContentObjectClaimed: immutableReceipt?.immutableContentObjectClaimed === true,
  });
}

export function buildReleaseEvidenceBundle({
  runtimeRoot,
  legacyRoot,
  workspaceRoot = defaultWorkspaceRoot,
  environment = process.env,
  expectedReleaseStateSnapshotHash = null,
  inputSnapshot = null,
  now = new Date(),
} = {}) {
  const snapshot = assertValidReleaseEvidenceInputSnapshot(inputSnapshot
    || captureReleaseEvidenceInputSnapshot({
      runtimeRoot,
      legacyRoot,
      workspaceRoot,
      environment,
      expectedReleaseStateSnapshotHash,
      now,
    }));
  if (snapshot.inputs.workspaceRoot !== path.resolve(workspaceRoot)
    || snapshot.inputs.runtimeRoot !== path.resolve(runtimeRoot)
    || snapshot.inputs.legacyRoot.path !== path.resolve(legacyRoot)
    || (expectedReleaseStateSnapshotHash
      && snapshot.releaseStateSnapshot.workspaceReleaseStateSnapshotHash
        !== expectedReleaseStateSnapshotHash)) {
    throw new Error('release_evidence_input_snapshot_scope_mismatch');
  }
  const {
    releaseStateSnapshot,
    codeProvenance,
    verificationReceiptEvidence,
    capabilityManifestEvidence,
    deletionDrillEvidence,
    immutableSnapshotEvidence,
    coldVolumeStatus,
    minimalDifferentialFixture,
    immutableMatrixReference,
    productionStoreLogicalIntegrity,
    coldVolumeCas,
    offhostWormStatus,
    trustLayerGate,
    inputs,
  } = snapshot;
  const verificationReceipt = verificationReceiptEvidence.receipt;
  const deletionDrill = deletionDrillEvidence.receipt;
  const immutableReceipt = immutableSnapshotEvidence.receipt;
  const codeTrustLayersReady = trustLayerGate.status === 'code_release_trust_layers_ready';
  const generatedAt = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  const payload = {
    version: 2,
    kind: 'ReleaseEvidenceBundle',
    status: !codeProvenance.treeDirty
      && verificationReceiptEvidence.releaseEvidenceReady === true
      && capabilityManifestEvidence.releaseEvidenceReady === true
      && Boolean(immutableSnapshotEvidence.currentArchive?.archiveHash)
      && deletionDrillEvidence.releaseEvidenceReady === true
      && immutableSnapshotEvidence.releaseEvidenceReady === true
      && coldVolumeStatus.contractValid
      && minimalDifferentialFixture.status === 'legacy_differential_reference_verified'
      && immutableMatrixReference.status === 'immutable_legacy_matrix_reference_ready'
      && productionStoreLogicalIntegrity?.status === 'sqlite_logical_integrity_verified'
      && codeTrustLayersReady
      ? 'code_release_evidence_ready'
      : 'code_release_evidence_blocked',
    releaseProfile: 'code_release',
    codeProvenance,
    releaseStateSnapshot,
    releaseStateSnapshotHash: releaseStateSnapshot.workspaceReleaseStateSnapshotHash,
    generatedAt,
    verificationReceipt,
    bindings: {
      releaseEvidenceInputSnapshotHash: snapshot.releaseEvidenceInputSnapshotHash,
      capabilityCatalogHash: snapshot.capabilityCatalogHash,
      implementationProofSetHash:
        snapshot.implementationProofSet.releaseEvidenceProofSetSnapshotHash,
      conformanceProofSetHash:
        snapshot.conformanceProofSet.releaseEvidenceProofSetSnapshotHash,
      operationalProofSetHash:
        snapshot.operationalProofSet.releaseEvidenceProofSetSnapshotHash,
      migrationMatrixHash: inputs.migrationMatrix.fileHash,
      legacyDatabaseHash: inputs.legacyDatabase.fileHash,
      capabilityVerificationManifestHash:
        capabilityManifestEvidence.pointer?.capabilityVerificationManifestHash || null,
      capabilityVerificationManifestFileHash:
        capabilityManifestEvidence.targetFileHash || null,
      capabilityVerificationManifestPath:
        capabilityManifestEvidence.targetRelativePath || null,
      capabilityVerificationCurrentPointerHash:
        capabilityManifestEvidence.pointer?.currentCapabilityVerificationManifestPointerHash || null,
      capabilityVerificationCurrentPointerFileHash:
        capabilityManifestEvidence.pointerFileHash || null,
      capabilityVerificationCurrentPointerPath:
        capabilityManifestEvidence.pointerRelativePath || null,
      capabilityVerificationCurrentPointerSigningKeyFingerprint:
        capabilityManifestEvidence.pinnedPublicKeyFingerprint || null,
      legacyReferenceArchiveHash: immutableSnapshotEvidence.currentArchive?.archiveHash || null,
      legacyReadOnlyReceiptHash: inputs.archiveReadOnlyReceipt.fileHash,
      deletionRestoreDrillReceiptHash: deletionDrillEvidence.receiptHash || null,
      deletionRestoreDrillClaimedReceiptHash: deletionDrillEvidence.claimedReceiptHash || null,
      deletionRestoreDrillReceiptFileHash: deletionDrillEvidence.candidateFileHash || null,
      deletionRestoreDrillReceiptPath: deletionDrillEvidence.candidateRelativePath || null,
      deletionRestoreDrillSigningKeyFingerprint: deletionDrillEvidence.pinnedPublicKeyFingerprint || null,
      isolatedVerificationReceiptHash: verificationReceiptEvidence.receiptHash || null,
      isolatedVerificationReceiptFileHash: verificationReceiptEvidence.candidateFileHash || null,
      isolatedVerificationReceiptPath: verificationReceiptEvidence.candidateRelativePath || null,
      isolatedVerificationSigningKeyFingerprint:
        verificationReceiptEvidence.pinnedPublicKeyFingerprint || null,
      legacyImmutableSnapshotReceiptHash: immutableSnapshotEvidence.receiptHash || null,
      legacyImmutableSnapshotReceiptFileHash:
        immutableSnapshotEvidence.candidateFileHash || null,
      legacyImmutableSnapshotReceiptPath: immutableSnapshotEvidence.candidatePath || null,
      legacyImmutableSnapshotSignatureFileHash:
        immutableSnapshotEvidence.signatureFileHash || null,
      legacyImmutableSnapshotSignaturePath: immutableSnapshotEvidence.signaturePath || null,
      legacyImmutableSnapshotSigningKeyFingerprint:
        immutableSnapshotEvidence.pinnedPublicKeyFingerprint || null,
      minimalLegacyDifferentialFixtureHash: minimalDifferentialFixture.archiveSha256,
      coldVolumeContractHash: coldVolumeStatus.contractHash,
      immutableLegacyMatrixReferenceHash: immutableMatrixReference.matrixSha256,
      productionStoreLogicalHash: productionStoreLogicalIntegrity?.logicalDatabaseHash || null,
      coldVolumeCasManifestHash: coldVolumeCas.manifestHash || null,
      offhostWormContractHash: snapshot.offhostWormContract.fileHash,
      runtimeHygieneExportHash: snapshot.runtimeHygieneExport.fileHash,
    },
    authorityStatus: {
      trustStorePresent: snapshot.authorityTrustStore.present,
      requiredRoles: ['academic_evidence_authority', 'independent_referee', 'submission_operator', 'live_executor_authorizer'],
      authorityInferredFromReleaseSignature: false,
    },
    deletionDrillEvidence: {
      status: deletionDrillEvidence.status,
      receiptHash: deletionDrillEvidence.receiptHash || null,
      receiptPath: deletionDrillEvidence.candidateRelativePath || null,
      receiptFileHash: deletionDrillEvidence.candidateFileHash || null,
      publicKeyFingerprint: deletionDrillEvidence.pinnedPublicKeyFingerprint || null,
      claimedReceiptHash: deletionDrillEvidence.claimedReceiptHash || null,
      blockers: deletionDrillEvidence.blockers,
      receiptBlockers: deletionDrillEvidence.receiptBlockers || [],
    },
    verificationReceiptEvidence: {
      status: verificationReceiptEvidence.status,
      receiptHash: verificationReceiptEvidence.receiptHash || null,
      receiptPath: verificationReceiptEvidence.candidateRelativePath || null,
      receiptFileHash: verificationReceiptEvidence.candidateFileHash || null,
      publicKeyFingerprint: verificationReceiptEvidence.pinnedPublicKeyFingerprint || null,
      blockers: verificationReceiptEvidence.blockers,
    },
    capabilityManifestEvidence: {
      status: capabilityManifestEvidence.status,
      semanticManifestHash:
        capabilityManifestEvidence.pointer?.capabilityVerificationManifestHash || null,
      targetPath: capabilityManifestEvidence.targetRelativePath || null,
      targetFileHash: capabilityManifestEvidence.targetFileHash || null,
      pointerPath: capabilityManifestEvidence.pointerRelativePath || null,
      pointerFileHash: capabilityManifestEvidence.pointerFileHash || null,
      pointerHash:
        capabilityManifestEvidence.pointer?.currentCapabilityVerificationManifestPointerHash
          || null,
      publicKeyFingerprint: capabilityManifestEvidence.pinnedPublicKeyFingerprint || null,
      blockers: capabilityManifestEvidence.blockers,
    },
    retirementStatus: retirementLifecycleStatus({
      legacyRoot,
      liveLegacyRootPresent: inputs.legacyRoot.present,
      deletionDrill,
      deletionDrillEvidence,
      immutableReceipt,
      immutableSnapshotEvidence,
    }),
    assetRecoveryStatus: {
      coldVolume: coldVolumeStatus,
      coldVolumeCas,
      offhostWorm: offhostWormStatus,
    },
    disasterRecoveryStatus: coldVolumeCas.status === 'cold_volume_cas_ready'
      && offhostWormStatus.offHostOrOffsiteCustodyQualified === true
      ? 'disaster_recovery_ready'
      : 'disaster_recovery_blocked',
    trustLayers: trustLayerGate,
    minimalDifferentialFixture,
    immutableMatrixReference,
    productionStoreLogicalIntegrity,
    evidenceClasses: {
      technical: 'isolated verification only',
      operational: 'requires production-bound receipts and is not inferred here',
      ownerAcceptance: 'requires an external capability owner signature and is not inferred here',
    },
    externalActionPerformed: false,
  };
  return { ...payload, releaseEvidenceBundleHash: hashRecord('ReleaseEvidenceBundle', payload) };
}

export function writeSignedReleaseEvidence({
  runtimeRoot,
  legacyRoot,
  workspaceRoot = defaultWorkspaceRoot,
  environment = process.env,
  expectedReleaseStateSnapshotHash = null,
} = {}) {
  assertWorkspaceLayoutPhysicallyDecoupled({
    assetRoot: defaultPaperAssetRoot(),
    runtimeRoot,
    legacyRoot,
  });
  const inputSnapshot = captureReleaseEvidenceInputSnapshot({
    runtimeRoot,
    legacyRoot,
    workspaceRoot,
    environment,
    expectedReleaseStateSnapshotHash,
  });
  const bundle = buildReleaseEvidenceBundle({
    runtimeRoot,
    legacyRoot,
    workspaceRoot,
    environment,
    expectedReleaseStateSnapshotHash:
      inputSnapshot.releaseStateSnapshot.workspaceReleaseStateSnapshotHash,
    inputSnapshot,
  });
  if (bundle.status !== 'code_release_evidence_ready') {
    throw new Error('release_evidence_bundle_not_ready');
  }
  const assertStableCandidate = () => {
    assertReleaseEvidenceInputSnapshotUnchanged({
      expectedSnapshotHash: inputSnapshot.releaseEvidenceInputSnapshotHash,
      capture: () => captureReleaseEvidenceInputSnapshot({
        runtimeRoot,
        legacyRoot,
        workspaceRoot,
        environment,
        expectedReleaseStateSnapshotHash:
          inputSnapshot.releaseStateSnapshot.workspaceReleaseStateSnapshotHash,
      }),
    });
  };
  assertStableCandidate();
  const signature = signReleasePayload(bundle, runtimeRoot, { allowKeyCreation: false });
  const key = loadExistingReleaseSigningKey(runtimeRoot);
  const signatureVerified = verifyReleaseIntegritySignature(bundle, signature, {
    pinnedPublicKeyPem: key.publicKeyPem,
    pinnedPublicKeyFingerprint: key.publicKeyFingerprint,
  });
  if (!signatureVerified) throw new Error('release_evidence_signature_verification_failed');
  if (!/^[0-9A-Za-z][0-9A-Za-z._+-]{0,127}$/.test(bundle.codeProvenance.packageVersion)
    || !/^[a-f0-9]{40}$/.test(bundle.codeProvenance.commit)) {
    throw new Error('release_evidence_output_identity_invalid');
  }
  const root = path.join(runtimeRoot, 'release-evidence', bundle.codeProvenance.packageVersion, bundle.codeProvenance.commit || 'unknown');
  assertStableCandidate();
  ensurePrivateDirectoryWithinRuntime(runtimeRoot, root);
  const token = bundle.releaseEvidenceBundleHash.replace(/^sha256:/, '');
  const bundlePath = path.join(root, `RELEASE_EVIDENCE_BUNDLE_${token}.json`);
  const signaturePath = path.join(root, `RELEASE_EVIDENCE_SIGNATURE_${token}.json`);
  const pointerPayload = {
    version: 2,
    kind: 'CurrentReleaseEvidencePointer',
    packageVersion: bundle.codeProvenance.packageVersion,
    commit: bundle.codeProvenance.commit,
    bundlePath,
    bundleHash: bundle.releaseEvidenceBundleHash,
    signaturePath,
    signatureVerified,
    generatedAt: bundle.generatedAt,
    releaseStateSnapshotHash: bundle.releaseStateSnapshotHash,
    releaseEvidenceInputSnapshotHash: bundle.bindings.releaseEvidenceInputSnapshotHash,
  };
  const pointer = Object.freeze({
    ...pointerPayload,
    currentReleaseEvidencePointerHash: hashRecord('CurrentReleaseEvidencePointer', pointerPayload),
  });
  const publication = publishJsonArtifactSet({
    entries: [
      { path: bundlePath, value: bundle },
      { path: signaturePath, value: signature },
    ],
    pointerPath: path.join(root, 'CURRENT_RELEASE_EVIDENCE.json'),
    pointerValue: pointer,
    beforePointer: assertStableCandidate,
    afterPointer: assertStableCandidate,
  });
  return {
    bundle,
    signature,
    signatureVerified,
    bundlePath,
    signaturePath,
    root,
    pointer,
    publication,
  };
}
