import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { releaseIntegrityEvidence } from './release-integrity-evidence.mjs';
import { releaseStateSnapshotsMatch } from './release-verification-receipt-selection.mjs';
import { inspectLegacyReferenceArchive } from './release-evidence-legacy-immutable-snapshot.mjs';
import {
  sameStringArray,
  selectedDirectoryEntriesUnchanged,
  selectedDirectoryEntrySnapshot,
} from './release-evidence-filesystem-identity.mjs';

const DELETION_DRILL_FILE_PATTERN =
  /^LEGACY_DELETION_DRILL_(\d{13})(?:_([a-f0-9]{64}))?\.json$/;
const DELETION_DRILL_MAXIMUM_AGE_MS = 24 * 60 * 60 * 1000;
const DELETION_DRILL_MAXIMUM_FUTURE_SKEW_MS = 5 * 60 * 1000;
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
const {
  SHA256_PATTERN,
  exactCleanCodeProvenanceBlockers,
  exactCodeProvenanceMatches,
  exactKeys,
  existingDirectoryWithinRuntime,
  isPlainObject,
  loadExistingReleaseSigningKey,
  pathWithin,
  readRegularFileNoFollow,
  sha256Bytes,
  unique,
  verifyReleaseIntegritySignature,
} = releaseIntegrityEvidence;

function deletionDrillPayload(receipt) {
  const payload = { ...receipt };
  delete payload.legacyPhysicalDeletionAndRestoreDrillReceiptHash;
  return payload;
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
