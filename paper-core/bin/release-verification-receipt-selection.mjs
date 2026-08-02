import fs from 'node:fs';
import path from 'node:path';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  ISOLATED_VERIFICATION_RECEIPT_KEYS,
  verifyIsolatedVerificationReceipt,
} from '../src/isolated-verification-receipt-contract.mjs';
import { releaseIntegrityEvidence } from './release-integrity-evidence.mjs';

const RECEIPT_FILE_PATTERN = /^ISOLATED_VERIFICATION_RECEIPT_(\d{13})_([a-f0-9]{64})\.json$/;
const MAXIMUM_AGE_MS = 24 * 60 * 60 * 1000;
const MAXIMUM_FUTURE_SKEW_MS = 5 * 60 * 1000;
const MAXIMUM_RECEIPT_BYTES = 2 * 1024 * 1024;
const NO_FOLLOW = fs.constants.O_NOFOLLOW || 0;
const {
  SHA256_PATTERN,
  exactKeys,
  existingDirectoryWithinRuntime,
  loadExistingReleaseSigningKey,
  pathWithin,
  sha256Bytes,
  unique,
  verifyReleaseIntegritySignature,
} = releaseIntegrityEvidence;

function directoryState(stat) {
  return Object.freeze({
    dev: String(stat.dev),
    ino: String(stat.ino),
    mtimeNs: String(stat.mtimeNs),
    ctimeNs: String(stat.ctimeNs),
  });
}

function fileState(stat) {
  return Object.freeze({
    dev: String(stat.dev),
    ino: String(stat.ino),
    mode: String(stat.mode),
    nlink: String(stat.nlink),
    size: String(stat.size),
    uid: String(stat.uid),
    mtimeNs: String(stat.mtimeNs),
    ctimeNs: String(stat.ctimeNs),
  });
}

function statesMatch(left, right) {
  return Boolean(left && right
    && Object.keys(left).every((key) => left[key] === right[key]));
}

function pinnedDirectoryPath(descriptor) {
  return path.join('/proc/self/fd', String(descriptor));
}

function readPinnedDirectoryEntries(descriptor) {
  return fs.readdirSync(pinnedDirectoryPath(descriptor)).sort();
}

function openVerificationDirectorySnapshot(verificationRoot) {
  let descriptor;
  try {
    const before = fs.lstatSync(verificationRoot, { bigint: true });
    if (!before.isDirectory() || before.isSymbolicLink()) {
      throw new Error('release_verification_receipt_root_unsafe');
    }
    descriptor = fs.openSync(
      verificationRoot,
      fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0) | NO_FOLLOW,
    );
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (!opened.isDirectory()
      || !statesMatch(directoryState(before), directoryState(opened))) {
      throw new Error('release_verification_receipt_root_changed');
    }
    const entryNames = readPinnedDirectoryEntries(descriptor);
    const afterRead = fs.fstatSync(descriptor, { bigint: true });
    const pathAfterRead = fs.lstatSync(verificationRoot, { bigint: true });
    const state = directoryState(opened);
    if (!afterRead.isDirectory() || !pathAfterRead.isDirectory()
      || pathAfterRead.isSymbolicLink()
      || !statesMatch(state, directoryState(afterRead))
      || !statesMatch(state, directoryState(pathAfterRead))) {
      throw new Error('release_verification_receipt_root_changed');
    }
    return Object.freeze({
      descriptor,
      path: verificationRoot,
      state,
      entryNames: Object.freeze(entryNames),
    });
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    throw error;
  }
}

function assertVerificationDirectorySnapshot(snapshot) {
  try {
    const openedBefore = fs.fstatSync(snapshot.descriptor, { bigint: true });
    const pathBefore = fs.lstatSync(snapshot.path, { bigint: true });
    if (!openedBefore.isDirectory() || !pathBefore.isDirectory()
      || pathBefore.isSymbolicLink()
      || String(openedBefore.dev) !== snapshot.state.dev
      || String(openedBefore.ino) !== snapshot.state.ino
      || String(pathBefore.dev) !== snapshot.state.dev
      || String(pathBefore.ino) !== snapshot.state.ino) {
      throw new Error('release_verification_receipt_root_changed');
    }
    const currentEntries = readPinnedDirectoryEntries(snapshot.descriptor);
    if (JSON.stringify(currentEntries) !== JSON.stringify(snapshot.entryNames)) {
      throw new Error('release_verification_candidate_set_changed');
    }
    const openedAfter = fs.fstatSync(snapshot.descriptor, { bigint: true });
    const pathAfter = fs.lstatSync(snapshot.path, { bigint: true });
    if (!openedAfter.isDirectory() || !pathAfter.isDirectory()
      || pathAfter.isSymbolicLink()
      || !statesMatch(snapshot.state, directoryState(openedBefore))
      || !statesMatch(snapshot.state, directoryState(openedAfter))
      || !statesMatch(snapshot.state, directoryState(pathBefore))
      || !statesMatch(snapshot.state, directoryState(pathAfter))) {
      throw new Error('release_verification_receipt_root_changed');
    }
  } catch (error) {
    if (error?.message === 'release_verification_candidate_set_changed'
      || error?.message === 'release_verification_receipt_root_changed') throw error;
    throw new Error('release_verification_receipt_root_changed');
  }
}

function readPinnedVerificationReceipt(snapshot, candidateName) {
  if (typeof candidateName !== 'string' || path.basename(candidateName) !== candidateName
    || candidateName.includes('/') || candidateName.includes('\\')) {
    throw new Error('release_verification_candidate_file_unsafe');
  }
  const candidate = path.join(pinnedDirectoryPath(snapshot.descriptor), candidateName);
  let descriptor;
  try {
    const selected = fs.lstatSync(candidate, { bigint: true });
    if (!selected.isFile() || selected.isSymbolicLink() || selected.nlink !== 1n
      || selected.size < 1n || selected.size > BigInt(MAXIMUM_RECEIPT_BYTES)) {
      throw new Error('release_verification_candidate_file_unsafe');
    }
    descriptor = fs.openSync(candidate, fs.constants.O_RDONLY | NO_FOLLOW);
    const opened = fs.fstatSync(descriptor, { bigint: true });
    const state = fileState(opened);
    if (!opened.isFile() || !statesMatch(fileState(selected), state)) {
      throw new Error('release_verification_candidate_file_unsafe');
    }
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor, { bigint: true });
    const pathAfter = fs.lstatSync(candidate, { bigint: true });
    if (bytes.length !== Number(opened.size)
      || !statesMatch(state, fileState(after))
      || !statesMatch(state, fileState(pathAfter))) {
      throw new Error('release_verification_candidate_file_unsafe');
    }
    return bytes;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function releaseReadySnapshotValid(snapshot) {
  if (!releaseIntegrityEvidence.isPlainObject(snapshot)
    || snapshot.version !== 2
    || snapshot.kind !== 'WorkspaceReleaseStateSnapshot'
    || snapshot.status !== 'workspace_release_state_release_ready'
    || snapshot.releaseState?.ok !== true
    || snapshot.releaseState?.state !== 'release_ready'
    || !SHA256_PATTERN.test(String(snapshot.workspaceReleaseStateSnapshotHash || ''))) return false;
  const { workspaceReleaseStateSnapshotHash, ...payload } = snapshot;
  return workspaceReleaseStateSnapshotHash
    === sha256Bytes(Buffer.from(JSON.stringify(payload), 'utf8'));
}

export function releaseStateSnapshotsMatch(actual, expected) {
  return releaseReadySnapshotValid(actual)
    && releaseReadySnapshotValid(expected)
    && hashRecord('ExactWorkspaceReleaseStateSnapshot', actual)
      === hashRecord('ExactWorkspaceReleaseStateSnapshot', expected);
}

function blockedSelection(blockers, details = {}) {
  return Object.freeze({
    version: 1,
    kind: 'ReleaseVerificationReceiptSelection',
    status: 'release_verification_current_evidence_blocked',
    receipt: null,
    receiptHash: null,
    releaseEvidenceReady: false,
    blockers: unique(blockers),
    ...details,
  });
}

function candidateOrder(name) {
  const match = RECEIPT_FILE_PATTERN.exec(name);
  return match
    ? { timestamp: Number(match[1]), recognized: true }
    : { timestamp: Number.POSITIVE_INFINITY, recognized: false };
}

export function selectCurrentReleaseVerificationReceipt({
  verificationRoot,
  runtimeRoot,
  codeProvenance,
  expectedReleaseStateSnapshot,
  now = new Date(),
  maximumAgeMs = MAXIMUM_AGE_MS,
  faultInjector = null,
} = {}) {
  if (typeof runtimeRoot !== 'string' || typeof verificationRoot !== 'string') {
    return blockedSelection(['release_verification_receipt_root_invalid']);
  }
  if (!pathWithin(runtimeRoot, verificationRoot)) {
    return blockedSelection(['release_verification_receipt_root_outside_runtime']);
  }
  if (!fs.existsSync(verificationRoot)) {
    return blockedSelection(['release_verification_receipt_missing']);
  }
  let relativeRoot;
  try { relativeRoot = existingDirectoryWithinRuntime(runtimeRoot, verificationRoot); } catch { /* Fail closed below. */ }
  if (!relativeRoot) return blockedSelection(['release_verification_receipt_root_unsafe']);
  let rootSnapshot;
  try {
    rootSnapshot = openVerificationDirectorySnapshot(verificationRoot);
  } catch {
    return blockedSelection(['release_verification_receipt_root_unreadable']);
  }
  let candidateName = null;
  let candidateRelativePath = null;
  let finalValidationStarted = false;
  const finish = (result) => {
    try {
      if (!finalValidationStarted) {
        finalValidationStarted = true;
        if (faultInjector !== null) {
          if (typeof faultInjector !== 'function') {
            throw new Error('release_verification_fault_injector_invalid');
          }
          const injected = faultInjector({
            stage: 'before_final_directory_validation',
            candidateName,
            verificationRoot,
          });
          if (injected && typeof injected.then === 'function') {
            throw new Error('release_verification_fault_injector_must_be_synchronous');
          }
        }
      }
      assertVerificationDirectorySnapshot(rootSnapshot);
      return result;
    } catch (error) {
      return blockedSelection([
        error?.message === 'release_verification_candidate_set_changed'
          ? error.message
          : 'release_verification_receipt_root_changed',
      ], { candidateName, candidateRelativePath });
    }
  };
  try {
    const names = rootSnapshot.entryNames.filter((name) => name.endsWith('.json'));
    if (!names.length) return finish(blockedSelection(['release_verification_receipt_missing']));
    names.sort((left, right) => {
      const leftOrder = candidateOrder(left);
      const rightOrder = candidateOrder(right);
      return leftOrder.timestamp - rightOrder.timestamp || left.localeCompare(right);
    });
    candidateName = names.at(-1);
    const selectedOrder = candidateOrder(candidateName);
    const candidatePath = path.join(verificationRoot, candidateName);
    candidateRelativePath = pathWithin(runtimeRoot, candidatePath);
    let key;
    try { key = loadExistingReleaseSigningKey(runtimeRoot); } catch {
      return finish(blockedSelection(
        ['release_verification_pinned_public_key_unavailable'],
        { candidateName, candidateRelativePath },
      ));
    }
    const details = {
      candidateName,
      candidateRelativePath,
      pinnedPublicKeyFingerprint: key.publicKeyFingerprint,
    };
    if (!selectedOrder.recognized || !candidateRelativePath) {
      return finish(blockedSelection(['release_verification_candidate_name_invalid'], details));
    }
    let bytes;
    try { bytes = readPinnedVerificationReceipt(rootSnapshot, candidateName); } catch {
      return finish(blockedSelection(['release_verification_candidate_file_unsafe'], details));
    }
    const candidateFileHash = sha256Bytes(bytes);
    let document;
    try { document = JSON.parse(bytes.toString('utf8')); } catch {
      return finish(blockedSelection(
        ['release_verification_candidate_json_invalid'],
        { ...details, candidateFileHash },
      ));
    }
    if (!exactKeys(document, [...ISOLATED_VERIFICATION_RECEIPT_KEYS, 'signature'])) {
      return finish(blockedSelection(
        ['release_verification_signed_document_shape_invalid'],
        { ...details, candidateFileHash },
      ));
    }
    const { signature, ...receipt } = document;
    const expectedVerificationCodeProvenance = Object.freeze({
      ...codeProvenance,
      evidenceEnvironment: 'verification',
      evidenceClass: 'technical_conformance',
    });
    const blockers = [];
    const verification = verifyIsolatedVerificationReceipt({
      receipt,
      expectedMode: 'release',
      expectedCodeProvenance: expectedVerificationCodeProvenance,
    });
    if (verification.status !== 'isolated_verification_receipt_verified') {
      blockers.push(...verification.blockers);
    }
    if (receipt.status !== 'isolated_verification_passed'
      || !Array.isArray(receipt.blockers)
      || receipt.blockers.length) blockers.push('release_verification_receipt_not_passed');
    if (!releaseStateSnapshotsMatch(receipt.releaseStateSnapshot, expectedReleaseStateSnapshot)
      || !releaseStateSnapshotsMatch(
        receipt.completedReleaseStateSnapshot,
        expectedReleaseStateSnapshot,
      )) blockers.push('release_verification_release_state_mismatch');
    const completedAtMs = Date.parse(String(receipt.completedAt || ''));
    const nowMs = now instanceof Date ? now.getTime() : Date.parse(String(now || ''));
    if (!Number.isFinite(completedAtMs) || !Number.isFinite(nowMs)
      || new Date(completedAtMs).toISOString() !== receipt.completedAt) {
      blockers.push('release_verification_completed_at_invalid');
    } else {
      if (completedAtMs > nowMs + MAXIMUM_FUTURE_SKEW_MS) {
        blockers.push('release_verification_receipt_created_in_future');
      }
      if (!Number.isFinite(maximumAgeMs) || maximumAgeMs < 1
        || nowMs - completedAtMs > maximumAgeMs) {
        blockers.push('release_verification_receipt_stale');
      }
    }
    const claimedHash = receipt.isolatedVerificationReceiptHash;
    const expectedName = Number.isFinite(completedAtMs) && SHA256_PATTERN.test(String(claimedHash || ''))
      ? `ISOLATED_VERIFICATION_RECEIPT_${completedAtMs}_${claimedHash.slice('sha256:'.length)}.json`
      : null;
    if (candidateName !== expectedName) blockers.push('release_verification_filename_binding_mismatch');
    if (!verifyReleaseIntegritySignature(receipt, signature, {
      pinnedPublicKeyPem: key.publicKeyPem,
      pinnedPublicKeyFingerprint: key.publicKeyFingerprint,
    })) blockers.push('release_verification_signature_invalid');
    if (blockers.length) {
      return finish(blockedSelection(blockers, {
        ...details,
        candidateFileHash,
        claimedReceiptHash: SHA256_PATTERN.test(String(claimedHash || '')) ? claimedHash : null,
      }));
    }
    return finish(Object.freeze({
      version: 1,
      kind: 'ReleaseVerificationReceiptSelection',
      status: 'release_verification_current_evidence_verified',
      receipt: Object.freeze(receipt),
      receiptHash: claimedHash,
      claimedReceiptHash: claimedHash,
      candidateFileHash,
      candidateName,
      candidateRelativePath,
      pinnedPublicKeyFingerprint: key.publicKeyFingerprint,
      releaseEvidenceReady: true,
      blockers: [],
    }));
  } finally {
    fs.closeSync(rootSnapshot.descriptor);
  }
}
